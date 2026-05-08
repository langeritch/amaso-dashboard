// Preload for the Sparring Partner window. Exposes a tight IPC
// surface: outbound spar.* messages flow through `send`, inbound
// dashboard pushes arrive via `onMessage`, and the renderer can
// react to focus changes for the unfocused-fade effect.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spar", {
  send: (msg) => ipcRenderer.invoke("spar:send", msg),
  setMode: (mode) => ipcRenderer.invoke("spar:setMode", mode),
  hide: () => ipcRenderer.invoke("spar:hide"),
  onMessage: (cb) => {
    const handler = (_evt, msg) => cb(msg);
    ipcRenderer.on("spar:message", handler);
    return () => ipcRenderer.removeListener("spar:message", handler);
  },
  onFocusChange: (cb) => {
    const handler = (_evt, focused) => cb(focused);
    ipcRenderer.on("spar:focus", handler);
    return () => ipcRenderer.removeListener("spar:focus", handler);
  },
});
