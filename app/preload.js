const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibeRoute", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMax: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  isMax: () => ipcRenderer.invoke("win:is-max"),
  platform: process.platform,
  version: process.env.npm_package_version || "1.0.0",
  getVersion: () => ipcRenderer.invoke("app:version"),
  // App updates (Settings card in the dashboard)
  updates: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    setAuto: (on) => ipcRenderer.invoke("update:set-auto", Boolean(on)),
    onChange: (cb) => { if (typeof cb === "function") ipcRenderer.on("update:changed", (_e, st) => cb(st)); },
  },
});
