const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibeRoute", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMax: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  isMax: () => ipcRenderer.invoke("win:is-max"),
  platform: process.platform,
  version: process.env.npm_package_version || "1.0.0",
  getVersion: () => ipcRenderer.invoke("app:version"),
});
