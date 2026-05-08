// Re-sign the packed .app with an ad-hoc signature so the bundle's
// outer signature matches its bundle id (nl.amaso.companion) and
// the resource list electron-builder just produced. Without this
// the outer .app keeps the inherited Electron framework signature
// (Identifier=Electron, linker-signed), which Gatekeeper rejects
// as "damaged" the moment a user double-clicks the DMG'd app on a
// fresh machine.
//
// Skipped on:
//   - non-macOS hosts (no codesign binary)
//   - signed CI runs (CSC_LINK is set, so electron-builder will
//     sign with the Developer ID cert and we must not stomp it)
//
// Hook timing: electron-builder fires afterPack right after the
// .app is laid out and before DMG creation, which is exactly the
// window we need for a working ad-hoc signature to make it into
// the final disk image.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (process.platform !== "darwin") return;
  if (process.env.CSC_LINK) {
    // Real signing identity is in play; let electron-builder do
    // its Developer ID + notarization flow without interference.
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  // --force replaces the inherited Electron signature.
  // --deep walks every nested binary (helpers, frameworks).
  // --sign - is the ad-hoc identity.
  // --timestamp=none avoids a pointless network call during CI.
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" },
  );
};
