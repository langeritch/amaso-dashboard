// Preload for the menu-bar popover window. Exposes a minimal IPC surface
// the login / status HTML can call — nothing more.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  login: (email, password) =>
    ipcRenderer.invoke("amaso:login", { email, password }),
  status: () => ipcRenderer.invoke("amaso:status"),
  signOut: () => ipcRenderer.invoke("amaso:signout"),
  // Quick actions surfaced in the popover.
  openDashboard: () => ipcRenderer.invoke("amaso:openDashboard"),
  reconnect: () => ipcRenderer.invoke("amaso:reconnect"),
  // Settings toggles. Each returns the resolved value so the renderer
  // can sync its UI even if the OS clamped the change (e.g. login
  // items unsupported on a given platform).
  setLaunchAtLogin: (next) => ipcRenderer.invoke("amaso:setLaunchAtLogin", next),
  setDucking: (next) => ipcRenderer.invoke("amaso:setDucking", next),
  // Live status push. Main fires `amaso:status:update` with the same
  // shape `status()` returns whenever WS / VAD / settings transition.
  // Returns the unsubscribe function — the renderer wires it on mount
  // and tears it down on unload (popover gets destroyed when hidden).
  onStatus: (cb) => {
    const handler = (_evt, snapshot) => cb(snapshot);
    ipcRenderer.on("amaso:status:update", handler);
    return () => ipcRenderer.removeListener("amaso:status:update", handler);
  },
});
