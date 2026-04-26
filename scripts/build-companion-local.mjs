#!/usr/bin/env node
// Cross-build the Amaso Companion .app for macOS from any host (incl. Windows).
//
// electron-builder refuses to produce Mac targets off macOS because DMG creation
// needs hdiutil. We sidestep that by using @electron/packager (which only needs
// the Electron prebuilts) to assemble the .app bundle, then zip it with archiver
// while preserving symlinks — Electron.app's frameworks are full of them and
// PowerShell's Compress-Archive silently breaks them.
//
// Output: amaso-dashboard/public/downloads/amaso-companion-{arch}.zip
// Mac users unzip → drag .app to /Applications → right-click → Open
// (Gatekeeper bypass — the build is unsigned, same as CI's unsigned path.)

import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, lstat, readdir, readlink, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ELECTRON_DIR = join(REPO_ROOT, 'electron');

// @electron/packager and archiver live in electron/node_modules — resolve
// against that tree so this script doesn't need its own package.json at
// the dashboard root.
const electronRequire = createRequire(join(ELECTRON_DIR, 'package.json'));
const packagerEntry = electronRequire.resolve('@electron/packager');
const archiverEntry = electronRequire.resolve('archiver');
const { packager } = await import(pathToFileURL(packagerEntry).href);
const archiver = (await import(pathToFileURL(archiverEntry).href)).default;
const OUT_STAGING = join(ELECTRON_DIR, 'dist-local');
const OUT_FINAL = join(REPO_ROOT, 'public', 'downloads');

const PRODUCT_NAME = 'Amaso Companion';
const APP_BUNDLE_ID = 'nl.amaso.companion';
const APP_VERSION = '0.1.0';
const ELECTRON_VERSION = '33.4.11';

// @electron/packager v20 has a Windows-host bug where the ElectronAsarIntegrity
// dictionary key in Contents/Info.plist comes out as a Windows absolute path
// (`../C:\Users\...\app.asar`) because `path.posix.relative` is fed mixed
// Win32-style separators. At launch on macOS, Electron looks up the integrity
// entry by `Resources/app.asar` and finds nothing → integrity validation fails
// and the app refuses to start. The hash itself is correct since it's computed
// from file content; we just need to replace the broken key.
async function fixAsarIntegrityKey(appPath) {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  const original = await readFile(plistPath, 'utf8');
  const integrityRe = /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>)([^<]+)(<\/key>)/;
  const match = original.match(integrityRe);
  if (!match) {
    console.warn('  (no ElectronAsarIntegrity entry found — skipping fix)');
    return;
  }
  if (match[2] === 'Resources/app.asar') {
    return; // already correct
  }
  const fixed = original.replace(integrityRe, `$1Resources/app.asar$3`);
  await writeFile(plistPath, fixed, 'utf8');
  console.log(`  patched Info.plist integrity key: "${match[2]}" → "Resources/app.asar"`);
}

async function packageOne(arch) {
  console.log(`\n→ Packaging darwin-${arch}…`);
  const appPaths = await packager({
    dir: ELECTRON_DIR,
    out: OUT_STAGING,
    name: PRODUCT_NAME,
    platform: 'darwin',
    arch,
    electronVersion: ELECTRON_VERSION,
    appVersion: APP_VERSION,
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: 'public.app-category.utilities',
    asar: true,
    overwrite: true,
    prune: true,
    // Squash dotfiles, the existing electron-builder dist/, and our own
    // staging dir if a prior run left it inside electron/.
    ignore: [
      /^\/\.git/,
      /^\/dist($|\/)/,
      /^\/dist-local($|\/)/,
      /^\/node_modules\/\.cache/,
    ],
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription:
        "Amaso Companion listens to your mic locally to detect when you're talking, so it can mute other apps while you speak.",
    },
  });
  const appDir = appPaths[0];
  console.log(`  packaged → ${appDir}`);
  return appDir;
}

// archiver's `directory()` follows symlinks by default, which corrupts
// Electron's framework. Walk the tree ourselves and add symlinks as
// symlinks — archiver supports this via `archive.symlink(name, target)`.
//
// Windows `lstat` reports no executable bits (NTFS doesn't track them), so
// we can't rely on stat.mode the way a Mac/Linux build would. Instead we
// classify by path: anything inside a Mach-O location or with a binary
// extension gets 0o755, the rest gets 0o644.
function isExecutablePath(arcName) {
  // Main app + helper launchers: Contents/MacOS/<binary>
  if (/\/Contents\/MacOS\/[^/]+$/.test(arcName)) return true;
  // Framework binary: <X>.framework/Versions/A/<X> (no extension)
  if (/\.framework\/Versions\/[^/]+\/[^/.]+$/.test(arcName)) return true;
  // crashpad handler and friends sit in Versions/A/Helpers/
  if (/\.framework\/Versions\/[^/]+\/Helpers\/[^/]+$/.test(arcName)) return true;
  // Native libs — dylibs, sos, node addons.
  if (/\.(dylib|so|node)$/.test(arcName)) return true;
  return false;
}

async function addAppToArchive(archive, appPath, arcRoot) {
  async function walk(absPath) {
    const entries = await readdir(absPath, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = join(absPath, entry.name);
      const childRel = relative(appPath, childAbs).split('\\').join('/');
      const arcName = `${arcRoot}/${childRel}`;
      const stat = await lstat(childAbs);
      if (stat.isSymbolicLink()) {
        const target = await readlink(childAbs);
        archive.symlink(arcName, target.split('\\').join('/'), 0o755);
      } else if (stat.isDirectory()) {
        await walk(childAbs);
      } else {
        archive.file(childAbs, {
          name: arcName,
          mode: isExecutablePath(arcName) ? 0o755 : 0o644,
        });
      }
    }
  }
  await walk(appPath);
}

async function zipApp(appPath, outZip) {
  console.log(`→ Zipping ${appPath} → ${outZip}`);
  await mkdir(dirname(outZip), { recursive: true });
  const output = createWriteStream(outZip);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((resolveP, rejectP) => {
    output.on('close', resolveP);
    archive.on('error', rejectP);
    archive.on('warning', (w) => console.warn('  warn:', w.message));
  });
  archive.pipe(output);
  const arcRoot = `${PRODUCT_NAME}.app`;
  await addAppToArchive(archive, appPath, arcRoot);
  await archive.finalize();
  await done;
  console.log(`  zipped → ${outZip} (${archive.pointer()} bytes)`);
}

async function main() {
  await rm(OUT_STAGING, { recursive: true, force: true });
  await mkdir(OUT_FINAL, { recursive: true });

  for (const arch of ['arm64', 'x64']) {
    const outDir = await packageOne(arch);
    const appPath = join(outDir, `${PRODUCT_NAME}.app`);
    await fixAsarIntegrityKey(appPath);
    const zipPath = join(OUT_FINAL, `amaso-companion-${arch}.zip`);
    await zipApp(appPath, zipPath);
  }

  console.log('\nDone. Artifacts:');
  console.log(`  ${join(OUT_FINAL, 'amaso-companion-arm64.zip')}`);
  console.log(`  ${join(OUT_FINAL, 'amaso-companion-x64.zip')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
