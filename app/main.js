// Vibe Route - desktop app shell
// Starts the local gateway (proxy.cjs from the parent folder) and shows its
// dashboard in a native window. Closing the window keeps the gateway running
// in the tray.

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, ipcMain, clipboard } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const ASSET_DIR = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
const DATA_DIR = app.isPackaged ? app.getPath("userData") : path.resolve(__dirname, "..");

const ROOT = DATA_DIR;
const PROXY = path.join(ROOT, "proxy.cjs");
const CONFIG = path.join(ROOT, "config.json");
const ICON = path.join(__dirname, "icon.png");
const APP_LOG = path.join(ROOT, "app.log");
let PORT = Number(process.env.PORT || 8787);
let BASE = `http://127.0.0.1:${PORT}`;

// The gateway port lives in config.json; follow it instead of assuming 8787.
function syncPortFromConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const n = Number(c && c.port);
    if (n > 0) { PORT = n; BASE = `http://127.0.0.1:${PORT}`; }
  } catch {}
}

// copy the gateway files next to the writable data folder on first run / update
function ensureAssets() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of ["proxy.cjs", "catalog.cjs", "dashboard.html", "providers.catalog.json"]) {
    const src = path.join(ASSET_DIR, f);
    if (!fs.existsSync(src)) continue;
    try { fs.copyFileSync(src, path.join(DATA_DIR, f)); } catch {}
  }
  const cfg = path.join(DATA_DIR, "config.json");
  if (!fs.existsSync(cfg)) {
    const src = path.join(ASSET_DIR, "config.json");
    if (fs.existsSync(src)) try { fs.copyFileSync(src, cfg); } catch {}
  }
  syncPortFromConfig();
}

let win = null;
let tray = null;
let child = null;
let quitting = false;

function logLine(msg) {
  try { fs.appendFileSync(APP_LOG, `${new Date().toISOString()}  ${msg}\r\n`); } catch {}
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(BASE + "/health", { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealth(ms = 20000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function startGateway() {
  if (child) return;
  logLine("starting gateway: " + PROXY);
  child = spawn(process.execPath, [PROXY], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", VIBE_ROOT: DATA_DIR, PORT: String(PORT) }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => logLine("[proxy] " + String(d).trim()));
  child.stderr.on("data", (d) => logLine("[proxy:err] " + String(d).trim()));
  child.on("exit", (code, signal) => {
    logLine(`gateway exited code=${code} signal=${signal}`);
    child = null;
    if (!quitting) setTimeout(async () => {
      if (!(await ping())) startGateway();
    }, 1500);
  });
}

function stopGateway() {
  if (!child) return;
  try { child.kill(); } catch {}
  child = null;
}

async function ensureGateway() {
  if (await ping()) {
    logLine("gateway already running");
    return true;
  }
  startGateway();
  const ok = await waitForHealth();
  logLine(ok ? "gateway ready" : "gateway did not answer in time");
  return ok;
}

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#0b0f16;color:#e8eef6;font:14px "Segoe UI",system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  .box{text-align:center}
  .dot{width:10px;height:10px;border-radius:50%;background:#3ddc84;display:inline-block;margin-right:8px;
    animation:p 1.2s infinite ease-in-out}
  @keyframes p{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
  .t{font-size:15px;letter-spacing:.3px}
  .s{margin-top:8px;color:#8ea0b5;font-size:12px}
</style></head><body><div class="box">
  <div class="t"><span class="dot"></span>Vibe Route</div>
  <div class="s">starting local gateway…</div>
</div></body></html>`;

function isGatewayUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.host === `127.0.0.1:${PORT}` || u.host === `localhost:${PORT}`);
  } catch { return false; }
}
function openInBrowser(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") shell.openExternal(u.href);
    else logLine("blocked a link with protocol " + u.protocol);
  } catch {}
}

function loadDashboard() {
  if (!win) return;
  win.loadURL(BASE + "/?refresh=1").catch((e) => logLine("load failed: " + e.message));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: "#0b0f16",
    title: "Vibe Route",
    icon: fs.existsSync(ICON) ? ICON : undefined,
    frame: false,
    show: false,
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // The dashboard needs no camera, microphone, notifications or other permissions.
  try { win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); } catch {}

  win.once("ready-to-show", () => win.show());
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOADING_HTML))
    .catch((e) => logLine("loading page failed: " + e.message));

  // Right-click menu: select all, copy, cut/paste in inputs.
  win.webContents.on("context-menu", (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: "undo", enabled: Boolean(params.editFlags && params.editFlags.canUndo) },
        { role: "redo", enabled: Boolean(params.editFlags && params.editFlags.canRedo) },
        { type: "separator" },
        { role: "cut", enabled: Boolean(params.editFlags && params.editFlags.canCut) },
        { role: "copy", enabled: Boolean(params.editFlags && params.editFlags.canCopy) },
        { role: "paste", enabled: Boolean(params.editFlags && params.editFlags.canPaste) },
        { type: "separator" },
        { role: "selectAll" }
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
    } else {
      items.push({ role: "selectAll" });
      if (params.linkURL) {
        items.push({ type: "separator" }, {
          label: "Copy link address",
          click: () => { try { clipboard.writeText(params.linkURL); } catch {} },
        });
      }
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Only the gateway's own pages may open inside the app (exact origin, not a
  // prefix: http://127.0.0.1.evil.com is a different site). Other links open in
  // the user's browser, and only when they are http(s) - never file:, ms-* or
  // other protocol handlers.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGatewayUrl(url)) return { action: "allow" };
    openInBrowser(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isGatewayUrl(url) || url.startsWith("data:text/html")) return;
    event.preventDefault();
    openInBrowser(url);
  });

  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => { win = null; });
  win.on("maximize", () => win.webContents.send("win:state", { maximized: true }));
  win.on("unmaximize", () => win.webContents.send("win:state", { maximized: false }));
}

ipcMain.on("win:minimize", () => { if (win) win.minimize(); });
ipcMain.on("win:maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("win:close", () => { if (win) win.hide(); });
ipcMain.handle("win:is-max", () => (win ? win.isMaximized() : false));

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

// ---- updates: from the public GitHub Releases of Vibe Route ----
// Installed copies check now and then and download a new version by
// themselves; "Check for updates" in the tray checks at once, and
// "Restart to update" installs it.
let updater = null;
let updateState = { status: "idle", version: null };
function setupUpdater() {
  if (!app.isPackaged) return;
  try { updater = require("electron-updater").autoUpdater; } catch (e) { logLine("updater unavailable: " + e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("update-available", (info) => { updateState = { status: "downloading", version: info && info.version }; refreshTray(); });
  updater.on("update-not-available", () => { updateState = { status: "latest", version: app.getVersion() }; refreshTray(); });
  updater.on("update-downloaded", async (info) => {
    updateState = { status: "ready", version: info && info.version };
    refreshTray();
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Vibe Route update",
      message: `Vibe Route ${updateState.version || ""} is ready to install.`,
      detail: "Restart now to update. Your settings and keys stay as they are.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) installUpdate();
  });
  updater.on("error", (e) => { logLine("update error: " + (e && e.message)); updateState = { status: "error", version: null }; refreshTray(); });
  setTimeout(() => checkForUpdates(false), 15000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}
async function checkForUpdates(manual) {
  if (!updater) {
    if (manual) dialog.showMessageBox({ type: "info", title: "Vibe Route", message: app.isPackaged ? "Updates are not available in this copy." : "Updates work in the installed app.", detail: "Download the latest version from github.com/jhfarhanyt20-coder/Vibe-Route/releases." });
    return;
  }
  try {
    updateState = { status: "checking", version: null };
    refreshTray();
    const r = await updater.checkForUpdates();
    if (!manual) return;
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (latest && latest !== app.getVersion()) dialog.showMessageBox({ type: "info", title: "Vibe Route", message: `Version ${latest} is available.`, detail: "It is downloading now; Vibe Route asks you to restart when it is ready." });
    else dialog.showMessageBox({ type: "info", title: "Vibe Route", message: "You have the latest version.", detail: `Vibe Route ${app.getVersion()}` });
  } catch (e) {
    logLine("update check failed: " + e.message);
    updateState = { status: "error", version: null };
    refreshTray();
    if (manual) dialog.showMessageBox({ type: "warning", title: "Vibe Route", message: "Could not check for updates.", detail: String(e.message || e).slice(0, 300) });
  }
}
function installUpdate() {
  if (!updater) return;
  quitting = true;
  stopGateway();
  setTimeout(() => updater.quitAndInstall(false, true), 300);
}
function updateMenuItem() {
  if (updateState.status === "ready") return { label: `Restart to update (${updateState.version || "new version"})`, click: installUpdate };
  if (updateState.status === "downloading") return { label: `Downloading update ${updateState.version || ""}…`, enabled: false };
  if (updateState.status === "checking") return { label: "Checking for updates…", enabled: false };
  return { label: "Check for updates", click: () => checkForUpdates(true) };
}
function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}
ipcMain.handle("app:version", () => app.getVersion());

function createTray() {
  let img = null;
  if (fs.existsSync(ICON)) img = nativeImage.createFromPath(ICON);
  if (!img || img.isEmpty()) img = nativeImage.createFromDataURL(FALLBACK_ICON);
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip("Vibe Route");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", showWindow);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `Dashboard  (${BASE})`, click: showWindow },
    { type: "separator" },
    {
      label: "Restart gateway",
      async click() {
        stopGateway();
        await new Promise((r) => setTimeout(r, 700));
        syncPortFromConfig();
        await ensureGateway();
        if (win) win.reload();
      },
    },
    { label: "Open data folder", click: () => shell.openPath(ROOT) },
    { label: "Edit config.json", click: () => shell.openPath(CONFIG) },
    { type: "separator" },
    updateMenuItem(),
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
}

const FALLBACK_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAVElEQVR42u3NMQ0AIAwEwF9CJ2yCJmyCJmyCJmyCJmyCBgyCJmyCBgyCJmyCBgyCJmyCBgyCJmyCBgyCJmyCBgyCJmyCBgyCJmyCBgyCJgzCBwYQAJg2wXgAAAAASUVORK5CYII=";

app.setAppUserModelId("com.vibeproxy.app");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    ensureAssets();
    // Show the window immediately; the gateway starts in parallel.
    createWindow();
    createTray();
    setupUpdater();
    const ok = await ensureGateway();
    if (ok) loadDashboard();
    else {
      dialog.showMessageBox({
        type: "warning",
        title: "Vibe Route",
        message: "Gateway slow to start",
        detail: `The local gateway on ${BASE} did not answer yet. Check app.log / vibe-route.log.\n\nYou can retry from the tray menu -> Restart gateway.`,
      });
    }
  });
}

app.on("window-all-closed", () => {
  // keep running in the tray; Quit lives in the tray menu
});
app.on("before-quit", () => { quitting = true; stopGateway(); });
