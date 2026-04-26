// Amaso Recorder — background service worker.
//
// Responsibilities:
//   - Owns the active session id and dashboard origin (persisted in
//     chrome.storage.local so a service-worker restart doesn't lose
//     them).
//   - Receives event batches from content scripts, queues them, and
//     flushes to the dashboard's events endpoint on a fixed cadence.
//   - Picks up the session id from the dashboard tab's URL fragment
//     (#recording=<id>) the first time it sees it after the
//     RECORDING_DASHBOARD_URL is loaded.
//
// The wire format is the RecordingEvent type from
// types/recording.ts — keep them in sync by hand.

const FLUSH_INTERVAL_MS = 1500;
const MAX_BATCH = 50;

let queue = [];
let flushing = false;
let state = {
  sessionId: null,
  dashboardOrigin: null,
};

// Hydrate state from storage on each cold start of the worker. MV3
// can shut the worker down between events, so storage is the source
// of truth.
chrome.storage.local.get(["sessionId", "dashboardOrigin"]).then((s) => {
  if (s.sessionId) state.sessionId = s.sessionId;
  if (s.dashboardOrigin) state.dashboardOrigin = s.dashboardOrigin;
});

// Pick up the session id when a dashboard tab first opens with the
// recording fragment. The launcher in lib/recording-launcher.ts
// appends #recording=<sessionId> to the initial URL.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  try {
    const u = new URL(details.url);
    const m = /(?:^|&)recording=([0-9a-f-]{36})/.exec(
      u.hash.replace(/^#/, ""),
    );
    if (!m) return;
    state.sessionId = m[1];
    state.dashboardOrigin = u.origin;
    void chrome.storage.local.set({
      sessionId: state.sessionId,
      dashboardOrigin: state.dashboardOrigin,
    });
  } catch {
    /* malformed URL — ignore */
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.kind === "events" && Array.isArray(msg.events)) {
    for (const ev of msg.events) queue.push(ev);
    sendResponse({ queued: msg.events.length });
    void scheduleFlush();
    return true;
  }
  if (msg && msg.kind === "ping") {
    sendResponse({ active: state.sessionId != null });
    return true;
  }
  return false;
});

async function scheduleFlush() {
  if (flushing) return;
  flushing = true;
  try {
    await new Promise((r) => setTimeout(r, FLUSH_INTERVAL_MS));
    await flush();
  } finally {
    flushing = false;
    if (queue.length > 0) void scheduleFlush();
  }
}

async function flush() {
  if (queue.length === 0) return;
  if (!state.sessionId || !state.dashboardOrigin) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    const res = await fetch(
      `${state.dashboardOrigin}/api/recording/sessions/${state.sessionId}/events`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      },
    );
    if (!res.ok) {
      // Re-queue the batch; we'll retry on the next flush tick.
      // 401/404 likely means the session was ended or auth lapsed; in
      // that case dropping is the right call to avoid an infinite
      // retry storm.
      if (res.status !== 401 && res.status !== 404) {
        queue.unshift(...batch);
      }
    }
  } catch {
    queue.unshift(...batch);
  }
}
