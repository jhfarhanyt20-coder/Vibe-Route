// BD Route - desktop app shell
// Starts the local gateway (proxy.cjs from the parent folder) and shows its
// dashboard in a native window. Closing the window keeps the gateway running
// in the tray.

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, ipcMain, clipboard, Notification } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// The app was called Vibe Route before it became BD Route. Its settings and
// provider keys live in "%APPDATA%\Vibe Route": keep using that folder so the
// rename never loses them (Electron would otherwise pick "BD Route").
app.setPath("userData", path.join(app.getPath("appData"), "Vibe Route"));

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
  <div class="t"><span class="dot"></span>BD Route</div>
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
    title: "BD Route",
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
      if (!trayHintShown) {
        trayHintShown = true;
        quietNote("BD Route is still running", "It keeps your gateway on in the tray. Right-click the tray icon and choose Quit to exit.");
      }
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

// Quiet notes, the same in every VibeCoder app: a silent Windows note (no
// system sound) with BD Route's own soft two-note chime, gone after a few
// seconds. Used only when the window is not in front and something matters.
const CHIME_JS = `(() => { try {
  const C = window.AudioContext || window.webkitAudioContext; if (!C) return 0;
  const ctx = window.__vrChime || (window.__vrChime = new C()); if (ctx.state === "suspended") ctx.resume();
  const out = ctx.createGain(); out.gain.value = 0.9; const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
  lp.connect(out); out.connect(ctx.destination); const t0 = ctx.currentTime + 0.02;
  for (const [f, at, len] of [[659.25, 0, 0.42], [987.77, 0.11, 0.55]]) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.07, t0 + at + 0.018); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
    o.connect(g); g.connect(lp); o.start(t0 + at); o.stop(t0 + at + len + 0.05);
  } return 1 } catch { return 0 } })()`;
function quietNote(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title, body: String(body || "").slice(0, 240), silent: true, timeoutType: "default", icon: ICON });
    const hide = setTimeout(() => { try { n.close(); } catch {} }, 3000);
    n.on("click", () => { clearTimeout(hide); try { (onClick || showWindow)(); } catch {} });
    n.show();
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(CHIME_JS).catch(() => {});
    return true;
  } catch { return false; }
}
let trayHintShown = false;

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

// ---- updates: from the public GitHub Releases of BD Route ----
// Installed copies check now and then. With "Download updates automatically"
// on (the default) a new version downloads by itself; with it off, nothing is
// downloaded until you press "Update now". Both the tray menu and the
// dashboard's Settings card offer Check for updates, Update now and
// Install & restart. The preference is kept in app-settings.json.
const SETTINGS = path.join(DATA_DIR, "app-settings.json");
function readSettings() {
  try { const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); return s && typeof s === "object" ? s : {}; } catch { return {}; }
}
function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch);
  try { fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2)); } catch (e) { logLine("settings not saved: " + e.message); }
  return next;
}
const autoDownloadOn = () => readSettings().autoDownloadUpdates !== false;

let updater = null;
let updateState = { status: "idle", version: null };
let userAskedDownload = false; // "Update now" pressed: the dashboard shows Install & restart, no extra dialog
function setUpdateState(next) {
  updateState = Object.assign({ status: "idle", version: null }, next);
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send("update:changed", publicUpdateState());
}
function publicUpdateState() {
  return {
    status: updateState.status,
    version: updateState.version || null,
    percent: updateState.percent == null ? null : updateState.percent,
    error: updateState.error || null,
    current: app.getVersion(),
    autoDownload: autoDownloadOn(),
    available: Boolean(updater),
  };
}
function setupUpdater() {
  if (!app.isPackaged) return;
  try { updater = require("electron-updater").autoUpdater; } catch (e) { logLine("updater unavailable: " + e.message); return; }
  updater.autoDownload = autoDownloadOn();
  updater.autoInstallOnAppQuit = true;
  updater.on("update-available", (info) => {
    const v = info && info.version;
    setUpdateState(updater.autoDownload || userAskedDownload ? { status: "downloading", version: v, percent: 0 } : { status: "available", version: v });
  });
  updater.on("update-not-available", () => setUpdateState({ status: "latest", version: app.getVersion() }));
  updater.on("download-progress", (p) => {
    if (updateState.status === "ready") return;
    setUpdateState({ status: "downloading", version: updateState.version, percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) });
  });
  updater.on("update-downloaded", async (info) => {
    const asked = userAskedDownload;
    userAskedDownload = false;
    setUpdateState({ status: "ready", version: info && info.version });
    if (asked && win && win.isVisible()) return; // the dashboard already shows Install & restart
    // In the background: a quiet note instead of a pop-up that steals focus.
    if (!win || !win.isVisible() || win.isMinimized()) {
      if (quietNote("BD Route update ready", `Version ${updateState.version || ""} is downloaded. Click to open BD Route and restart to install.`)) return;
    }
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "BD Route update",
      message: `BD Route ${updateState.version || ""} is ready to install.`,
      detail: "Restart now to update. Your settings and keys stay as they are.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) installUpdate();
  });
  updater.on("error", (e) => {
    logLine("update error: " + (e && e.message));
    userAskedDownload = false;
    setUpdateState({ status: "error", error: String((e && e.message) || e || "update failed").slice(0, 200) });
  });
  setTimeout(() => checkForUpdates(false), 15000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}
// manual: show a dialog with the result (tray). quiet: the dashboard shows it itself.
async function checkForUpdates(manual, quiet) {
  if (!updater) {
    if (manual && !quiet) dialog.showMessageBox({ type: "info", title: "BD Route", message: app.isPackaged ? "Updates are not available in this copy." : "Updates work in the installed app.", detail: "Download the latest version from github.com/jhfarhanyt20-coder/BD-Route/releases." });
    return publicUpdateState();
  }
  if (["checking", "downloading", "ready"].includes(updateState.status)) return publicUpdateState();
  try {
    updater.autoDownload = autoDownloadOn() || userAskedDownload;
    setUpdateState({ status: "checking" });
    const r = await updater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (latest && latest === app.getVersion() && updateState.status === "checking") setUpdateState({ status: "latest", version: latest });
    if (!manual || quiet) return publicUpdateState();
    if (latest && latest !== app.getVersion()) dialog.showMessageBox({ type: "info", title: "BD Route", message: `Version ${latest} is available.`, detail: updater.autoDownload ? "It is downloading now; BD Route asks you to restart when it is ready." : "Choose Update now in the tray menu or in the dashboard's Settings to download it." });
    else dialog.showMessageBox({ type: "info", title: "BD Route", message: "You have the latest version.", detail: `BD Route ${app.getVersion()}` });
  } catch (e) {
    logLine("update check failed: " + e.message);
    setUpdateState({ status: "error", error: String(e.message || e).slice(0, 200) });
    if (manual && !quiet) dialog.showMessageBox({ type: "warning", title: "BD Route", message: "Could not check for updates.", detail: String(e.message || e).slice(0, 300) });
  }
  return publicUpdateState();
}
// "Update now": download the new version even when automatic download is off,
// without changing that saved preference.
async function downloadUpdateNow() {
  if (!updater) return publicUpdateState();
  if (updateState.status === "downloading" || updateState.status === "ready") return publicUpdateState();
  userAskedDownload = true;
  try {
    if (updateState.status !== "available") {
      await checkForUpdates(true, true); // with userAskedDownload set, an update found here downloads at once
      if (updateState.status !== "available") { if (updateState.status !== "downloading") userAskedDownload = false; return publicUpdateState(); }
    }
    setUpdateState({ status: "downloading", version: updateState.version, percent: 0 });
    await updater.downloadUpdate();
  } catch (e) {
    userAskedDownload = false;
    logLine("update download failed: " + e.message);
    setUpdateState({ status: "error", error: String(e.message || e).slice(0, 200) });
  } finally {
    updater.autoDownload = autoDownloadOn();
  }
  return publicUpdateState();
}
function installUpdate() {
  if (!updater || updateState.status !== "ready") return;
  quitting = true;
  stopGateway();
  setTimeout(() => updater.quitAndInstall(false, true), 300);
}
function updateMenuItem() {
  if (updateState.status === "ready") return { label: `Install & restart (${updateState.version || "new version"})`, click: installUpdate };
  if (updateState.status === "downloading") return { label: `Downloading update ${updateState.version || ""}${updateState.percent ? ` (${updateState.percent}%)` : "…"}`, enabled: false };
  if (updateState.status === "checking") return { label: "Checking for updates…", enabled: false };
  if (updateState.status === "available") return { label: `Update now (${updateState.version || "new version"})`, click: () => downloadUpdateNow() };
  return { label: "Check for updates", click: () => checkForUpdates(true) };
}
// Only the dashboard (the gateway page in our own window) may drive updates.
function fromDashboard(e) {
  return Boolean(win && e && e.sender === win.webContents && e.senderFrame && isGatewayUrl(e.senderFrame.url));
}
ipcMain.handle("update:state", (e) => (fromDashboard(e) ? publicUpdateState() : null));
ipcMain.handle("update:check", (e) => (fromDashboard(e) ? checkForUpdates(true, true) : null));
ipcMain.handle("update:download", (e) => (fromDashboard(e) ? downloadUpdateNow() : null));
ipcMain.handle("update:install", (e) => { if (fromDashboard(e)) installUpdate(); return null; });
ipcMain.handle("update:set-auto", (e, on) => {
  if (!fromDashboard(e)) return null;
  writeSettings({ autoDownloadUpdates: Boolean(on) });
  if (updater) updater.autoDownload = autoDownloadOn();
  setUpdateState(updateState);
  return publicUpdateState();
});
function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}
ipcMain.handle("app:version", () => app.getVersion());

function createTray() {
  let img = null;
  if (fs.existsSync(ICON)) img = nativeImage.createFromPath(ICON);
  if (!img || img.isEmpty()) img = nativeImage.createFromDataURL(FALLBACK_ICON);
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip("BD Route");
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
        title: "BD Route",
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
