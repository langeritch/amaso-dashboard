// Amaso Driver popup. Two responsibilities:
//   1. Show whether the bridge WS to the dashboard is up.
//   2. Pick which tab is the driver target plus reconnect on demand.
//
// The dashboard URL is hardcoded in background.js (DASHBOARD_ORIGIN);
// the popup is read-only on that field. One office host means one
// known URL; making it configurable just gives us a foot-gun.

const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ kind: "driver/status" });
  const status = $("status");
  const originLine = $("origin-line");
  if (!s) {
    status.textContent = "background worker not responding";
    status.className = "status bad";
    return;
  }
  originLine.textContent = "connected to: " + (s.dashboardOrigin || "unknown");
  if (s.bridgeConnected) {
    status.textContent = "Connected.";
    status.className = "status ok";
  } else {
    status.textContent =
      "Disconnected" + (s.bridgeLastError ? ": " + s.bridgeLastError : ".");
    status.className = "status bad";
  }
  if (s.driverTabId) {
    try {
      const tab = await chrome.tabs.get(s.driverTabId);
      $("tab-info").textContent =
        "#" + tab.id + " " + (tab.title || tab.url || "(no title)");
    } catch {
      $("tab-info").textContent = "tab #" + s.driverTabId + " (closed)";
    }
  } else {
    $("tab-info").textContent = "(none, will default to active tab)";
  }
}

$("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ kind: "driver/reconnect" });
  setTimeout(refresh, 300);
});

$("use-current").addEventListener("click", async () => {
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!active || active.id == null) return;
  await chrome.runtime.sendMessage({
    kind: "driver/setDriverTab",
    tabId: active.id,
  });
  setTimeout(refresh, 200);
});

refresh();
