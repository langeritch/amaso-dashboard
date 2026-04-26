// Server-side headless Chromium manager for the /browser remote
// viewer. One LiveBrowser per user (starting a second kills the
// first), launched with --headless=new so the recorder extension
// loads. The browser owns multiple tabs; one is active at a time and
// drives the JPEG screencast that feeds attached viewers. Input/nav
// operations target the active tab. Idle for IDLE_TIMEOUT_MS with no
// viewers attached → tear down.
//
// The dashboard's session cookie is forwarded into the headless
// BrowserContext so the recorder extension's flushes back to
// /api/recording/... authenticate as the same user that opened the
// stream.

import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { WebSocket } from "ws";
import { SESSION_COOKIE } from "./auth-core";

const VIEWPORT = { width: 1280, height: 800 } as const;
const IDLE_TIMEOUT_MS = 60_000;
// Pixel stream is the human-viewer affordance; the AI/state endpoint
// uses the extension's structured event log instead. Tuned a bit
// quieter than before: ~15 fps when busy and roughly half the JPEG
// bandwidth, since the structured channel carries the meaningful
// signal anyway.
const SCREENCAST_EVERY_NTH = 4;
const SCREENCAST_QUALITY = 45;
// Backpressure threshold: if a viewer's WebSocket has more than this
// many bytes still queued in the kernel/userspace send buffer, we skip
// pushing the next frame to that viewer. Stops a slow client (mobile
// on cellular) from ballooning server memory while leaving fast
// viewers on the same LiveBrowser unaffected. Tuned to ~3 frames'
// worth at typical JPEG sizes.
const MAX_QUEUED_BYTES = 800_000;

interface Tab {
  id: number;
  page: Page;
  cdp: CDPSession | null;
  // Latest title/url cached so the tab strip and AI polling endpoint
  // can render without an extra await per tab.
  title: string;
  url: string;
  // Cleanup function returned by attaching the screencast handler;
  // null means this tab isn't actively streaming.
  detachScreencast: (() => void) | null;
}

interface LiveBrowser {
  userId: number;
  context: BrowserContext;
  tabs: Map<number, Tab>;
  activeTabId: number;
  nextTabId: number;
  viewers: Set<WebSocket>;
  recordingId: string | null;
  dashboardOrigin: string;
  closing: boolean;
  idleTimer: NodeJS.Timeout | null;
  framesSent: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoLiveBrowsers: Map<number, LiveBrowser> | undefined;
}

function getRegistry(): Map<number, LiveBrowser> {
  if (!globalThis.__amasoLiveBrowsers) {
    globalThis.__amasoLiveBrowsers = new Map();
  }
  return globalThis.__amasoLiveBrowsers;
}

function extensionDir(): string {
  return path.resolve(process.cwd(), "extension");
}

function userDataDir(userId: number): string {
  const dir = path.resolve(
    process.cwd(),
    "data",
    "browser-profiles",
    String(userId),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface AcquireOpts {
  userId: number;
  signedSessionCookie: string;
  recordingId: string | null;
  dashboardOrigin: string;
}

export async function acquireSession(opts: AcquireOpts): Promise<LiveBrowser> {
  const tag = `[browser-stream u=${opts.userId}]`;
  const registry = getRegistry();
  const existing = registry.get(opts.userId);
  // Detect a stale LiveBrowser from a previous code revision (HMR or
  // server reload kept the global Map alive but the object inside has
  // the pre-multi-tab `{page, cdp}` shape). A torn-down rebuild is
  // safer than trying to coerce the old object into the new one.
  const hasNewShape =
    existing != null && existing.tabs instanceof Map && existing.tabs.size > 0;
  if (existing && !hasNewShape) {
    console.warn(
      `${tag} discarding stale LiveBrowser (missing tabs Map — probably a pre-refactor instance)`,
    );
    try {
      await stopSession(opts.userId);
    } catch {
      /* ignore */
    }
    registry.delete(opts.userId);
  } else if (existing && !existing.closing) {
    console.log(`${tag} reusing existing LiveBrowser`);
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    if (opts.recordingId && opts.recordingId !== existing.recordingId) {
      console.log(
        `${tag} switching recording ${existing.recordingId ?? "-"} → ${opts.recordingId}`,
      );
      existing.recordingId = opts.recordingId;
      const active = existing.tabs.get(existing.activeTabId);
      if (active) {
        await bindRecording(
          tag,
          active.page,
          opts.dashboardOrigin,
          opts.recordingId,
        );
      }
    }
    return existing;
  }

  const ext = extensionDir();
  const profile = userDataDir(opts.userId);
  const launchStart = Date.now();
  console.log(
    `${tag} launching chromium ext=${ext} profile=${profile} recording=${opts.recordingId ?? "-"}`,
  );

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
      args: [
        `--load-extension=${ext}`,
        `--disable-extensions-except=${ext}`,
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  } catch (err) {
    console.error(
      `${tag} chromium launch FAILED after ${Date.now() - launchStart}ms:`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }

  const origin = new URL(opts.dashboardOrigin);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: opts.signedSessionCookie,
      domain: origin.hostname,
      path: "/",
      httpOnly: true,
      secure: origin.protocol === "https:",
      sameSite: "Lax",
    },
  ]);

  const initialPage = context.pages()[0] ?? (await context.newPage());
  await initialPage.setViewportSize({ ...VIEWPORT });

  const live: LiveBrowser = {
    userId: opts.userId,
    context,
    tabs: new Map(),
    activeTabId: 0,
    nextTabId: 0,
    viewers: new Set(),
    recordingId: opts.recordingId,
    dashboardOrigin: opts.dashboardOrigin,
    closing: false,
    idleTimer: null,
    framesSent: 0,
  };

  // If a recording was attached at launch, bind the extension to the
  // session id BEFORE settling on about:blank. The extension only
  // learns the session id by scraping #recording=<uuid> from a
  // webNavigation.onCommitted event, so the page has to commit at
  // least one URL containing the fragment.
  if (opts.recordingId) {
    await bindRecording(tag, initialPage, opts.dashboardOrigin, opts.recordingId);
  } else {
    // No recording → just settle on about:blank so the React launcher
    // overlay shows immediately.
    await initialPage.goto("about:blank").catch(() => {});
  }

  const initialTab = await registerPage(live, initialPage);
  live.activeTabId = initialTab.id;
  await activateTab(live, initialTab.id);

  // New tabs opened by JS (window.open, target=_blank, etc.) come
  // through context.on('page'). We track them so they show up in the
  // tab strip and the AI state endpoint.
  context.on("page", (p) => {
    if (live.closing) return;
    void registerPage(live, p).then((tab) => {
      console.log(`${tag} popup tab opened id=${tab.id} url=${p.url()}`);
      broadcastTabs(live);
    });
  });

  context.on("close", () => {
    registry.delete(opts.userId);
  });

  registry.set(opts.userId, live);
  console.log(
    `${tag} chromium ready in ${Date.now() - launchStart}ms recording=${opts.recordingId ?? "-"}`,
  );
  return live;
}

/**
 * Bind a recording session id to the recorder extension by briefly
 * navigating the page to /recording-bind.html with `#recording=<id>`
 * in the URL. The extension's webNavigation.onCommitted listener
 * scrapes that fragment and persists the session id to
 * chrome.storage.local, after which any captured events flush to
 * /api/recording/sessions/<id>/events. We then return the page to
 * about:blank so the React launcher overlay can take over.
 *
 * Only needed for the embedded /browser flow — without this the
 * extension never learns the session id and silently drops every
 * event it captures.
 */
async function bindRecording(
  tag: string,
  page: Page,
  dashboardOrigin: string,
  recordingId: string,
): Promise<void> {
  const bindUrl = `${dashboardOrigin}/recording-bind.html#recording=${recordingId}`;
  try {
    await page.goto(bindUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${tag} recording bind goto failed: ${msg}`);
    return;
  }
  // The extension's onCommitted listener runs synchronously after the
  // navigation commits, but chrome.storage.local.set is async. A short
  // wait ensures the write lands before we move the page elsewhere —
  // not strictly necessary for correctness (the session id stays valid
  // until reset) but cleaner for any later tab whose first event
  // arrives within the same tick.
  await page.waitForTimeout(150).catch(() => {});
  await page.goto("about:blank").catch(() => {});
  console.log(`${tag} recording bound id=${recordingId}`);
}

/**
 * Navigate with a localhost fallback. The dashboardOrigin we forward
 * is hard-coded to http://127.0.0.1:<port>, but on some Windows/Node
 * setups the dev server binds only to ::1 (IPv6) and the v4 loopback
 * is unreachable. A blanket `.catch(() => {})` here would silently
 * leave the page on about:blank, which is the bug the user just hit.
 * Logs the underlying error so future failures are visible in the
 * server console.
 */
async function navigateWithFallback(
  tag: string,
  page: Page,
  url: string,
): Promise<void> {
  const tryGoto = (target: string) =>
    page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
  try {
    await tryGoto(url);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${tag} goto ${url} failed: ${msg}`);
    if (url.includes("127.0.0.1")) {
      const fallback = url.replace("127.0.0.1", "localhost");
      console.warn(`${tag} retrying with ${fallback}`);
      try {
        await tryGoto(fallback);
        return;
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        console.error(`${tag} fallback goto ${fallback} ALSO failed: ${msg2}`);
      }
    }
  }
}

/** Register a Playwright page as a tab — sets up listeners and metadata
 *  but does NOT start screencasting. Call activateTab to switch to it. */
async function registerPage(live: LiveBrowser, page: Page): Promise<Tab> {
  const id = live.nextTabId++;
  const tab: Tab = {
    id,
    page,
    cdp: null,
    title: "",
    url: page.url(),
    detachScreencast: null,
  };
  live.tabs.set(id, tab);

  // Track navigation + title changes so the tab strip stays current.
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    tab.url = page.url();
    // Titles often update slightly after navigation; refresh on the
    // next tick to catch the stable value.
    void page
      .title()
      .then((t) => {
        tab.title = t || "";
        broadcastTabs(live);
      })
      .catch(() => {});
    if (id === live.activeTabId) {
      const payload = JSON.stringify({
        type: "navigation",
        tabId: id,
        url: tab.url,
        title: tab.title,
      });
      for (const ws of live.viewers) {
        try {
          ws.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
    broadcastTabs(live);
  });

  // Initial title fetch.
  void page
    .title()
    .then((t) => {
      tab.title = t || "";
      broadcastTabs(live);
    })
    .catch(() => {});

  page.on("close", () => {
    void closeTabInternal(live, id);
  });

  return tab;
}

async function activateTab(live: LiveBrowser, tabId: number): Promise<void> {
  const tab = live.tabs.get(tabId);
  if (!tab) return;
  // Stop screencasting any other tab first — only one feed at a time
  // because viewers expect one canvas.
  for (const t of live.tabs.values()) {
    if (t.id === tabId) continue;
    if (t.detachScreencast) {
      t.detachScreencast();
      t.detachScreencast = null;
    }
    if (t.cdp) {
      try {
        await t.cdp.send("Page.stopScreencast");
      } catch {
        /* ignore — cdp may already be torn down */
      }
    }
  }
  live.activeTabId = tabId;

  if (!tab.cdp) {
    try {
      tab.cdp = await live.context.newCDPSession(tab.page);
    } catch (e) {
      console.warn(
        `[browser-stream u=${live.userId}] failed to create CDP for tab ${tabId}:`,
        e,
      );
      return;
    }
  }
  await tab.cdp
    .send("Page.startScreencast", {
      format: "jpeg",
      quality: SCREENCAST_QUALITY,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: SCREENCAST_EVERY_NTH,
    })
    .catch(() => {});

  const cdp = tab.cdp;
  const onFrame = (frame: { data: string; sessionId: number }) => {
    const payload = JSON.stringify({
      type: "frame",
      data: frame.data,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
    let sent = 0;
    let dropped = 0;
    for (const ws of live.viewers) {
      if (ws.bufferedAmount > MAX_QUEUED_BYTES) {
        dropped++;
        continue;
      }
      try {
        ws.send(payload);
        sent++;
      } catch {
        /* dropped — close handler will detach */
      }
    }
    live.framesSent++;
    if (live.framesSent === 1 || live.framesSent % 100 === 0 || dropped > 0) {
      console.log(
        `[browser-stream u=${live.userId}] screencast frame #${live.framesSent} ` +
          `tab=${tabId} sent=${sent} dropped=${dropped} viewers=${live.viewers.size} bytes=${payload.length}`,
      );
    }
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(
      () => {},
    );
  };
  cdp.on("Page.screencastFrame", onFrame);
  tab.detachScreencast = () => {
    cdp.off("Page.screencastFrame", onFrame);
  };

  // Push a navigation hint so the viewer's address bar updates.
  const payload = JSON.stringify({
    type: "navigation",
    tabId,
    url: tab.url,
    title: tab.title,
  });
  for (const ws of live.viewers) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
  broadcastTabs(live);
}

async function closeTabInternal(live: LiveBrowser, tabId: number) {
  const tab = live.tabs.get(tabId);
  if (!tab) return;
  if (tab.detachScreencast) {
    tab.detachScreencast();
    tab.detachScreencast = null;
  }
  if (tab.cdp) {
    try {
      await tab.cdp.send("Page.stopScreencast");
    } catch {
      /* ignore */
    }
    try {
      await tab.cdp.detach();
    } catch {
      /* ignore */
    }
    tab.cdp = null;
  }
  live.tabs.delete(tabId);

  // No tabs left → tear down the whole session.
  if (live.tabs.size === 0) {
    void stopSession(live.userId);
    return;
  }

  // If the active tab closed, fall back to the most-recently-created
  // remaining tab. Mirrors regular browser behaviour.
  if (live.activeTabId === tabId) {
    const fallback = Array.from(live.tabs.keys()).sort((a, b) => b - a)[0];
    await activateTab(live, fallback);
  } else {
    broadcastTabs(live);
  }
}

function tabSummary(live: LiveBrowser): {
  tabs: Array<{ tabId: number; url: string; title: string; active: boolean }>;
  activeTabId: number;
} {
  const tabs = Array.from(live.tabs.values())
    .sort((a, b) => a.id - b.id)
    .map((t) => ({
      tabId: t.id,
      url: t.url,
      title: t.title,
      active: t.id === live.activeTabId,
    }));
  return { tabs, activeTabId: live.activeTabId };
}

function broadcastTabs(live: LiveBrowser) {
  const summary = tabSummary(live);
  const payload = JSON.stringify({ type: "tabs", ...summary });
  for (const ws of live.viewers) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

export function attachViewer(userId: number, ws: WebSocket): boolean {
  const live = getRegistry().get(userId);
  if (!live || live.closing) return false;
  live.viewers.add(ws);
  if (live.idleTimer) {
    clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }
  console.log(
    `[browser-stream u=${userId}] viewer attached — total=${live.viewers.size}`,
  );
  // Push current tab list + active tab nav so the viewer renders
  // immediately without waiting for the next change.
  const summary = tabSummary(live);
  try {
    ws.send(JSON.stringify({ type: "tabs", ...summary }));
  } catch {
    /* ignore */
  }
  const active = live.tabs.get(live.activeTabId);
  if (active) {
    try {
      ws.send(
        JSON.stringify({
          type: "navigation",
          tabId: active.id,
          url: active.url,
          title: active.title,
        }),
      );
    } catch {
      /* ignore */
    }
  }
  return true;
}

export function detachViewer(userId: number, ws: WebSocket) {
  const live = getRegistry().get(userId);
  if (!live) return;
  const removed = live.viewers.delete(ws);
  if (removed) {
    console.log(
      `[browser-stream u=${userId}] viewer detached — remaining=${live.viewers.size}`,
    );
  }
  if (live.viewers.size === 0 && !live.closing) {
    console.log(
      `[browser-stream u=${userId}] no viewers — idle shutdown in ${IDLE_TIMEOUT_MS}ms`,
    );
    live.idleTimer = setTimeout(() => {
      console.log(`[browser-stream u=${userId}] idle timeout reached — stopping`);
      void stopSession(userId);
    }, IDLE_TIMEOUT_MS);
  }
}

export async function stopSession(userId: number): Promise<void> {
  const registry = getRegistry();
  const live = registry.get(userId);
  if (!live || live.closing) return;
  live.closing = true;
  if (live.idleTimer) clearTimeout(live.idleTimer);
  // Tell connected viewers the session is ending *before* we close the
  // socket. The client uses this signal to suppress its reconnect loop
  // (which would otherwise transparently launch a fresh Chromium) and
  // show the end-of-session modal. A plain `ws.close()` can't carry
  // intent — 1006 reads the same as a network blip.
  const endedPayload = JSON.stringify({
    type: "session_ended",
    recordingId: live.recordingId,
  });
  for (const ws of live.viewers) {
    try {
      ws.send(endedPayload);
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  live.viewers.clear();
  for (const tab of live.tabs.values()) {
    if (tab.detachScreencast) tab.detachScreencast();
    if (tab.cdp) {
      try {
        await tab.cdp.send("Page.stopScreencast");
      } catch {
        /* ignore */
      }
      try {
        await tab.cdp.detach();
      } catch {
        /* ignore */
      }
    }
  }
  live.tabs.clear();
  try {
    await live.context.close();
  } catch {
    /* ignore */
  }
  registry.delete(userId);
}

// ───────────────────────── input forwarding ─────────────────────────
// All input goes to the active tab's page. The client never names a
// tab when sending input — it sends "switch_tab" first if it wants to
// retarget. That keeps the input/streaming pipe coherent with the
// frame data the user is looking at.

type MouseButton = "left" | "right" | "middle";

function getLive(userId: number): LiveBrowser | null {
  const live = getRegistry().get(userId);
  return live && !live.closing ? live : null;
}

function getActivePage(userId: number): Page | null {
  const live = getLive(userId);
  if (!live) return null;
  const tab = live.tabs.get(live.activeTabId);
  return tab ? tab.page : null;
}

export async function mouseMove(userId: number, x: number, y: number) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.mouse.move(x, y).catch(() => {});
}

export async function mouseDown(
  userId: number,
  x: number,
  y: number,
  button: MouseButton,
) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.down({ button }).catch(() => {});
}

export async function mouseUp(
  userId: number,
  x: number,
  y: number,
  button: MouseButton,
) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.up({ button }).catch(() => {});
}

export async function wheel(
  userId: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.wheel(deltaX, deltaY).catch(() => {});
}

export async function keyDown(userId: number, key: string) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.keyboard.down(key).catch(() => {});
}

export async function keyUp(userId: number, key: string) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.keyboard.up(key).catch(() => {});
}

export async function typeText(userId: number, text: string) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.keyboard.type(text).catch(() => {});
}

export async function navigate(userId: number, url: string) {
  const page = getActivePage(userId);
  if (!page) return;
  // Bare hostnames → https; everything else gets passed through, so
  // about:, chrome:, file: still work for power users.
  const target = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
  await page.goto(target).catch(() => {});
}

export async function goBack(userId: number) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.goBack().catch(() => {});
}

export async function goForward(userId: number) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.goForward().catch(() => {});
}

export async function reload(userId: number) {
  const page = getActivePage(userId);
  if (!page) return;
  await page.reload().catch(() => {});
}

// ───────────────────────── tab management ─────────────────────────

export async function newTab(userId: number, url?: string): Promise<number | null> {
  const live = getLive(userId);
  if (!live) return null;
  const page = await live.context.newPage();
  await page.setViewportSize({ ...VIEWPORT });
  const tab = await registerPage(live, page);
  if (url) {
    const target = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
    await page.goto(target).catch(() => {});
  }
  await activateTab(live, tab.id);
  return tab.id;
}

export async function closeTab(userId: number, tabId: number): Promise<void> {
  const live = getLive(userId);
  if (!live) return;
  const tab = live.tabs.get(tabId);
  if (!tab) return;
  // Closing the page fires our page.on('close') handler which calls
  // closeTabInternal — that path also handles "last tab → tear down".
  try {
    await tab.page.close();
  } catch {
    await closeTabInternal(live, tabId);
  }
}

export async function switchTab(userId: number, tabId: number): Promise<void> {
  const live = getLive(userId);
  if (!live) return;
  if (!live.tabs.has(tabId)) return;
  if (live.activeTabId === tabId) return;
  await activateTab(live, tabId);
}

/**
 * Snapshot of the user's current LiveBrowser tabs — used by the
 * AI-polling state endpoint. Returns null when no LiveBrowser exists
 * (the caller decides whether that's a 404 or an empty tab list).
 */
export function listTabsForUser(userId: number): {
  tabs: Array<{ tabId: number; url: string; title: string; active: boolean }>;
  activeTabId: number;
} | null {
  const live = getRegistry().get(userId);
  if (!live || live.closing) return null;
  return tabSummary(live);
}

export interface TabSnapshot {
  tabId: number;
  url: string;
  title: string;
  capturedAt: number;
  // Playwright's accessibility tree — semantic structure (roles,
  // names, states) of every focusable/announceable node. Roughly an
  // "AI-friendly DOM" without the styling noise.
  accessibility: unknown;
  // Visible text (innerText of body) — coarse but cheap context for
  // an LLM that just needs to know what's on screen.
  text: string;
}

/**
 * Heavy, on-demand snapshot of a single tab's content. Use sparingly
 * — pulling the full AX tree walks the DOM and innerText forces
 * layout. Returns null if the user has no LiveBrowser, the tab id is
 * unknown, or the page is closing.
 *
 * For inactive tabs we create a transient CDP session (the persistent
 * one only exists while a tab is the active streamer), then detach so
 * we don't leak protocol sessions.
 */
export async function snapshotTab(
  userId: number,
  tabId: number,
): Promise<TabSnapshot | null> {
  const live = getLive(userId);
  if (!live) return null;
  const tab = live.tabs.get(tabId);
  if (!tab) return null;
  const page = tab.page;

  let accessibility: unknown = null;
  let cdpToDetach: CDPSession | null = null;
  try {
    const cdp = tab.cdp ?? (await live.context.newCDPSession(page));
    if (!tab.cdp) cdpToDetach = cdp;
    await cdp.send("Accessibility.enable").catch(() => {});
    const tree = await cdp
      .send("Accessibility.getFullAXTree")
      .catch(() => null);
    if (tree) accessibility = tree;
  } catch {
    /* best-effort */
  } finally {
    if (cdpToDetach) {
      await cdpToDetach.detach().catch(() => {});
    }
  }

  let text = "";
  try {
    text = await page.locator("body").innerText({ timeout: 2_000 });
  } catch {
    /* best-effort */
  }

  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    capturedAt: Date.now(),
    accessibility,
    text,
  };
}

export const STREAM_VIEWPORT = VIEWPORT;

/**
 * Tear down every active LiveBrowser. Called from the server's SIGINT
 * / SIGTERM hook so Playwright child processes don't outlive the
 * Node parent. Safe to call multiple times — each stopSession is a
 * no-op if its target is already closing.
 */
export async function shutdownAll(): Promise<void> {
  const ids = Array.from(getRegistry().keys());
  await Promise.allSettled(ids.map((id) => stopSession(id)));
}
