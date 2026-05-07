// Amaso Driver popup — small UI for the bridge:
//   - Show whether the WS to the dashboard is up.
//   - Let the user paste the dashboard URL once (so the driver works
//     even before they visit a #recording=… link).
//   - Pick which tab is the driver target.

const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ kind: "driver/status" });
  const status = $("status");
  if (!s) {
    status.textContent = "background worker not responding";
    status.className = "status bad";
    return;
  }
  if (s.bridgeConnected) {
    status.textContent = "Connected to dashboard.";
    status.className = "status ok";
  } else if (!s.dashboardOrigin) {
    status.textContent = "Set the dashboard URL below to connect.";
    status.className = "status";
  } else {
    status.textContent = `Disconnected${s.bridgeLastError ? `: ${s.bridgeLastError}` : ""}`;
    status.className = "status bad";
  }
  $("origin").value = s.dashboardOrigin || "";
  if (s.driverTabId) {
    try {
      const tab = await chrome.tabs.get(s.driverTabId);
      $("tab-info").textContent = `#${tab.id} — ${tab.title || tab.url || "(no title)"}`;
    } catch {
      $("tab-info").textContent = `tab #${s.driverTabId} (closed)`;
    }
  } else {
    $("tab-info").textContent = "(none — will default to active tab)";
  }
}

$("save-origin").addEventListener("click", async () => {
  const origin = $("origin").value.trim();
  if (!origin) return;
  await chrome.runtime.sendMessage({ kind: "driver/setOrigin", origin });
  setTimeout(refresh, 300);
});

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
