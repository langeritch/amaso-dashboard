// Strip tsx's ESM loader args from execArgv *before* importing next. Next's
// static-paths worker forks child node processes (via jest-worker), and
// child_process.fork inherits parent execArgv by default. The tsx `--import`
// and `--require` hooks inside the worker mis-resolve next's internal modules
// (`next/dist/compiled/jest-worker/processChild.js`) and the worker dies with
// ERR_MODULE_NOT_FOUND, which cascades into a Turbopack FATAL panic that
// leaves the server listening on 3737 but unresponsive.
//
// The parent process has already booted — tsx isn't needed anymore for this
// process, and the Next workers don't run our TypeScript anyway (Turbopack
// handles `.ts` compilation itself).
//
// Flags and their values are separate execArgv elements, so we have to skip
// them in pairs: `["--require", ".../preflight.cjs"]` must be dropped as a
// unit, otherwise the orphaned `--require` trips "requires an argument" in
// every child fork.
{
  const isTsxValue = (v: string) => /tsx|preflight|loader\.mjs/i.test(v);
  const cleaned: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const a = process.execArgv[i];
    if ((a === "--require" || a === "--import") && i + 1 < process.execArgv.length && isTsxValue(process.execArgv[i + 1])) {
      i++; // skip the value too
      continue;
    }
    if (a.startsWith("--require=") || a.startsWith("--import=")) {
      if (isTsxValue(a)) continue;
    }
    if (isTsxValue(a) && !a.startsWith("-")) continue;
    cleaned.push(a);
  }
  process.execArgv = cleaned;
}

import { createServer } from "node:http";
import { connect as tcpConnect } from "node:net";
import next from "next";
import { getWatcher } from "./lib/watcher";
import { createWsServer } from "./lib/ws";
import { createTerminalWs } from "./lib/terminal-ws";
import { createBrowserWs } from "./lib/browser-ws";
import { createCompanionWs } from "./lib/companion-ws";
import { shutdownAll as shutdownLiveBrowsers } from "./lib/browser-stream";
import { seedFromConfig } from "./lib/history";
import { startKokoro } from "./lib/kokoro";
import { startTelegramVoice } from "./lib/telegram-voice-sidecar";
import { startHeartbeatCron } from "./lib/heartbeat-cron";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
// 3737 by default so we don't collide with Nuxt / Next / Vite dev servers
// on 3000 / 5173. Override with PORT env var.
const port = Number(process.env.PORT ?? 3737);

// Refuse to start if anything is already listening on our port. On Windows,
// a process that binds to IPv6 `::` and one that binds to IPv4 `0.0.0.0` can
// *both* end up LISTENING on the same port number without EADDRINUSE firing —
// incoming connections are then routed nondeterministically. This actively
// probes 127.0.0.1 and refuses to continue if anything answers, so the
// cloudflared tunnel never sees a stranger's origin.
async function assertPortFree(p: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = tcpConnect({ host: "127.0.0.1", port: p });
    sock.once("connect", () => {
      sock.destroy();
      reject(
        new Error(
          `port ${p} is already in use by another process — refusing to start. ` +
            `Run \`netstat -ano -p tcp | findstr :${p}\` to find it.`,
        ),
      );
    });
    sock.once("error", () => {
      sock.destroy();
      resolve();
    });
  });
}

// Tiny progress logger. Forces a flush via process.stdout.write so that
// when npm pipes our stdout to app.log we see the boot sequence in real
// time instead of hours later when the OS finally flushes the buffer.
// This was the difference between "server is silently stuck at step N"
// being diagnosable in seconds vs. hours of guessing.
function boot(step: string) {
  const line = `[boot] ${new Date().toISOString()} ${step}\n`;
  try {
    process.stdout.write(line);
  } catch {
    /* ignore */
  }
}

// Last-resort crash handlers. Without these the process can die from an
// async error inside Next, chokidar, or one of the WS handlers and leave
// nothing in the log — exactly what happened during the OOM-from-watcher-flood
// incident: process gone, app.log empty after `[server] ready`, no clue why.
// Sync writes via fs.appendFileSync because by the time these fire the event
// loop is on its way out and a queued console.log won't flush.
{
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const crashLog = path.resolve(process.cwd(), "logs", "crash.log");
  const dump = (kind: string, err: unknown) => {
    const stamp = new Date().toISOString();
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const line = `[${stamp}] ${kind}\n${stack}\n\n`;
    try { fs.appendFileSync(crashLog, line); } catch { /* ignore */ }
    try { process.stderr.write(line); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (err) => {
    dump("uncaughtException", err);
    // Give 250ms for the write to flush before we go down. Node will
    // exit on its own after the listener; we just want the log line
    // committed first.
    setTimeout(() => process.exit(1), 250).unref();
  });
  process.on("unhandledRejection", (reason) => {
    // Unhandled rejections used to silently leak — every chokidar
    // RangeError fed the rejection queue and the process kept running
    // until the GC gave up. We log them but DON'T exit (some libraries
    // produce noisy rejections that aren't fatal); the operator can
    // grep crash.log to spot patterns.
    dump("unhandledRejection", reason);
  });
}

/**
 * Fail fast on missing operator config.
 *
 * REQUIRED (production only — exits 1 if missing):
 *   - AMASO_PROJECTS_ROOT  Where new projects land. Has a cwd-relative
 *                          fallback for dev, but production deploys
 *                          should be explicit; the fallback resolves
 *                          to wherever the dashboard happens to be
 *                          installed, which is almost never right
 *                          when the install lives under /opt or a
 *                          systemd unit dir.
 *
 * RECOMMENDED (warn-only, both environments):
 *   - TELEGRAM_VOICE_TOKEN  /api/telegram/* returns 503 without it,
 *                           so the phone-call leg silently won't work.
 *   - AMASO_VAPID_PUBLIC    Web push subscriptions will fail to
 *                           AMASO_VAPID_PRIVATE   register / sign
 *                           AMASO_VAPID_SUBJECT   without the trio.
 *
 * The split between "exit" and "warn" is deliberate: anything that
 * would cause a crash on first request gets the hard exit; anything
 * that silently degrades a feature gets a warning so dev environments
 * can run minimal config.
 */
// Minimal .env.local loader. Next.js loads .env.local on its own, but only
// after `next({...})` is called inside main() — which is *after* validateEnv.
// validateEnv was therefore reading a half-empty process.env and tripping the
// FATAL exit path even though .env.local was sitting right next to server.ts.
// We don't pull in dotenv as a dep — a hand-rolled `KEY=VALUE` parser is
// enough for our config, and it keeps the boot path dependency-free.
//
// Precedence: existing process.env wins (so the cmd-level `set` in
// run-loop-prod.cmd still overrides the file). Quoted values are unwrapped.
// Lines starting with `#` and blank lines are skipped.
function loadDotEnvLocalIfPresent(): void {
  try {
    // Lazy-require: synchronous fs is fine at boot, and we don't want this
    // to be hoisted into module scope because that would force tsx to parse
    // node:fs before the execArgv-strip block above gets a chance to run.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const file = path.join(process.cwd(), ".env.local");
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* best-effort — validateEnv will surface anything actually missing */
  }
}

function validateEnv(): void {
  loadDotEnvLocalIfPresent();
  const isProd = process.env.NODE_ENV === "production";
  const missingRequired: string[] = [];
  const missingRecommended: string[] = [];

  if (!process.env.AMASO_PROJECTS_ROOT?.trim()) {
    if (isProd) missingRequired.push("AMASO_PROJECTS_ROOT");
    else missingRecommended.push("AMASO_PROJECTS_ROOT (using cwd/.. fallback)");
  }
  if (!process.env.TELEGRAM_VOICE_TOKEN?.trim()) {
    missingRecommended.push(
      "TELEGRAM_VOICE_TOKEN (telegram voice routes will return 503)",
    );
  }
  const vapidVars = [
    "AMASO_VAPID_PUBLIC",
    "AMASO_VAPID_PRIVATE",
    "AMASO_VAPID_SUBJECT",
  ];
  const vapidMissing = vapidVars.filter((v) => !process.env[v]?.trim());
  if (vapidMissing.length > 0 && vapidMissing.length < vapidVars.length) {
    // Partial config is worse than missing — push registration will
    // try, then fail at sign time. Treat as required regardless of env.
    missingRequired.push(
      `VAPID keys partially set; missing: ${vapidMissing.join(", ")}`,
    );
  } else if (vapidMissing.length === vapidVars.length) {
    missingRecommended.push("VAPID keys (web push notifications disabled)");
  }

  for (const v of missingRecommended) {
    console.warn(`[env] WARN: ${v}`);
  }
  if (missingRequired.length > 0) {
    for (const v of missingRequired) {
      console.error(`[env] FATAL: required env var missing — ${v}`);
    }
    console.error(
      "[env] aborting startup. Set the variables above (e.g. via .env.local) and retry.",
    );
    process.exit(1);
  }
}

async function main() {
  boot("main() entered");
  validateEnv();
  boot("env validated");
  await assertPortFree(port);
  boot(`port ${port} is free`);

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  boot(`next({dev:${dev}}) constructed, calling prepare()`);
  await app.prepare();
  boot("app.prepare() done");
  // Next's own HMR WebSocket lives at /_next/webpack-hmr in dev. With a
  // custom server it doesn't get wired up automatically — we have to
  // forward the upgrade ourselves or every HMR connect 404s in a tight
  // reconnect loop and the browser console fills with red. Must be called
  // AFTER prepare(), otherwise the internal server isn't initialised yet.
  const upgradeNext = app.getUpgradeHandler();

  // Previously we awaited seedFromConfig() here (to guarantee watcher "add"
  // events don't clobber the diff baseline), but with 10 project entries
  // walked in serial — several sharing the same codebase, so the same tree
  // was read up to 3× — seeding took long enough to keep the HTTP server
  // off :3737 for minutes. During that time the watchdog kept probe-timing
  // the task and recycling it, so the dashboard never came up.
  //
  // Fix: bring the listener up immediately, run seeding in the background,
  // and defer watcher.start() until seeding finishes. A brief window where
  // incoming file changes have no previous-content baseline is acceptable —
  // the server responding at all matters far more.
  void (async () => {
    boot("bg seedFromConfig() starting");
    try {
      await seedFromConfig();
      boot("bg seedFromConfig() done");
    } catch (err) {
      console.error("[server] seedFromConfig failed (non-fatal):", err);
    }
    try {
      getWatcher().start();
      boot("bg watcher started");
    } catch (err) {
      console.error("[server] watcher.start failed:", err);
    }
  })();
  void startKokoro();
  boot("startKokoro() dispatched");
  void startTelegramVoice();
  boot("startTelegramVoice() dispatched");
  startHeartbeatCron();
  boot("heartbeat cron started");
  const ws = createWsServer();
  const termWs = createTerminalWs();
  const browserWs = createBrowserWs();
  const companionWs = createCompanionWs();
  boot("ws servers constructed");

  const server = createServer((req, res) => {
    // Allow the Amaso portfolio (prod, Cloudflare Pages preview, and local
    // dev) to iframe the dashboard. Without frame-ancestors, Chrome blocks
    // the embed with its "content blocked / contact the site owner" page
    // even though we never set X-Frame-Options.
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors 'self' https://amaso.nl https://*.amaso.nl https://amaso-git.pages.dev http://localhost:* http://127.0.0.1:*",
    );
    // Defence-in-depth headers. Set on every response (HTML, JSON, WS
    // upgrade fall-through, static assets) — cheap, no per-route opt-in
    // needed.
    //
    // - HSTS: pin HTTPS for a year. Only meaningful when actually served
    //   over HTTPS (the Cloudflare tunnel terminates TLS upstream and
    //   forwards plaintext to us); browsers ignore the header on plain
    //   HTTP, so it's safe to set unconditionally.
    // - nosniff: the chat-attachments route already sets this, but
    //   making it the default protects every JSON/HTML response from
    //   MIME-sniffing-driven XSS in older browsers.
    // - Referrer-Policy: strip path/query when navigating to a third
    //   party. The dashboard URL itself can leak project IDs in the
    //   path, which we don't want pasted into other sites' analytics.
    // - Permissions-Policy: deny by default. The dashboard doesn't use
    //   camera/microphone/geolocation/payment/USB at the document
    //   level (Spar uses getUserMedia, but that's prompted explicitly
    //   on the /spar page and the policy doesn't block same-origin
    //   user gestures); listing them empty closes the door for any
    //   future iframe content that might.
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/sync")) {
      ws.handleUpgrade(req, socket, head);
    } else if (url.startsWith("/api/terminal")) {
      termWs.handleUpgrade(req, socket, head);
    } else if (url.startsWith("/api/browser")) {
      browserWs.handleUpgrade(req, socket, head);
    } else if (url.startsWith("/api/companion")) {
      companionWs.handleUpgrade(req, socket, head);
    } else if (url.startsWith("/_next")) {
      // Next.js HMR and any other framework-internal upgrades. Hand
      // them off to Next's own handler — rejecting these used to
      // flood the log with "unrouted ws upgrade" and kill HMR in dev.
      void upgradeNext(req, socket, head);
    } else {
      // Unrouted upgrades used to silently hang until the client
      // timed out — that's exactly what the "reconnecting…" loop on
      // the viewer looks like. Close the socket explicitly so the
      // client gets a fast failure and so we leave a log line.
      console.warn(`[server] unrouted ws upgrade: ${url}`);
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  server.on("error", (err) => {
    console.error("[server] listen error:", err);
    process.exit(1);
  });

  boot(`calling server.listen on ${hostname}:${port}`);
  server.listen({ host: hostname, port, exclusive: true }, () => {
    boot(`READY on http://${hostname}:${port} (dev=${dev})`);
    console.log(`[server] ready on http://${hostname}:${port} (dev=${dev})`);
  });

  // Graceful shutdown — make sure Playwright child processes don't
  // outlive the Node parent. Without this they linger as zombie
  // chromium.exe under the user's data dir and refuse to relaunch
  // cleanly on the next dev start. SIGINT covers Ctrl-C, SIGTERM
  // covers `kill` from a process supervisor.
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} → shutting down`);
    // 5-second budget. If anything hangs (e.g. a Playwright IPC stuck
    // mid-handshake) we still exit so a process supervisor doesn't
    // wait forever.
    const force = setTimeout(() => {
      console.warn("[server] force-exiting after 5s");
      process.exit(1);
    }, 5_000);
    force.unref();
    try {
      await shutdownLiveBrowsers();
    } catch (err) {
      console.error("[server] shutdown error:", err);
    }
    server.close(() => process.exit(0));
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
