// Preload for the hidden VAD window. Exposes a tiny IPC surface so the
// renderer can report speech state back to main without leaking Node APIs.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("amasoVad", {
  sendState: (state) => ipcRenderer.send("amaso:vad:state", state),
  sendError: (msg) => ipcRenderer.send("amaso:vad:error", String(msg || "")),
  onConfig: (cb) => {
    ipcRenderer.on("amaso:vad:config", (_evt, cfg) => {
      try {
        cb(cfg || {});
      } catch {
        /* ignore renderer-side errors */
      }
    });
  },
});
