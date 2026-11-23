#!/usr/bin/env node
/*
 * Vibe Route  -  multi provider
 * Anthropic Messages API  ->  OpenAI Chat Completions
 *
 * Any Anthropic-format client (Claude Code, Claude Dev / Cline, ...) can use
 * every provider you configure here (OpenCode Go, OpenRouter, Groq, local
 * servers, ...). Claude sees one merged model list; each model routes to the
 * provider that owns it.
 *
 * Endpoints
 *   POST /v1/messages               Anthropic Messages (stream + non-stream)
 *   POST /v1/messages/count_tokens  rough token count
 *   GET  /v1/models                 merged model list + capabilities
 *   GET  /v1/models/<id>            one model
 *   GET  /api/models                raw catalog per provider
 *   GET  /health                    status
 *   GET  /                          dashboard
 *
 * Run: node proxy.cjs
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const catalog = require("./catalog.cjs");

const ROOT = process.env.VIBE_ROOT || __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const LOG_PATH = path.join(ROOT, "vibe-route.log");

let rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const PRESETS_PATH = path.join(ROOT, "providers.catalog.json");
let presets = [];
try { presets = JSON.parse(fs.readFileSync(PRESETS_PATH, "utf8")); } catch {}
function presetFor(id, baseUrl) {
  return presets.find((x) => x.id === id) ||
    presets.find((x) => String(x.baseUrl).replace(/\/+$/, "") === String(baseUrl || "").replace(/\/+$/, "")) ||
    null;
}

// ------------------------------------------------------------------- config
function providerDefaults(id, p) {
  const preset = presetFor(p.configId || id, p.baseUrl);
  return {
    id,
    label: p.label || id,
    baseUrl: String(p.baseUrl || "").replace(/\/+$/, ""),
    chatPath: p.chatPath || "/chat/completions",
    modelsPath: p.modelsPath || "/models",
    apiKey: p.apiKey || "",
    keySource: p.keySource || (preset && preset.keySource) || "config",
    sessionHeader: p.sessionHeader || (preset && preset.sessionHeader) || "",
    userAgent: p.userAgent || "vibe-route/1.0",
    headers: Object.assign({}, preset && preset.headers, p.headers),
    maxTokens: p.maxTokens || 8192,
    configId: p.configId || id,
    enabled: p.enabled !== false,
    models: p.models || null,
  };
}

function buildCfg() {
  const c = {
    port: Number(process.env.PORT || rawCfg.port || 8787),
    defaultProvider: rawCfg.defaultProvider || "",
    defaultModel: rawCfg.defaultModel || "",
    aliases: rawCfg.aliases || {},
    fallbacks: Array.isArray(rawCfg.fallbacks) ? rawCfg.fallbacks : [],
    // Whole-request cap. Long agent runs routinely pass 3 minutes, so 10 min default.
    timeoutMs: Number(rawCfg.timeoutMs || 600000),
    providers: {},
  };

  if (rawCfg.providers) {
    for (const [id, p] of Object.entries(rawCfg.providers)) c.providers[id] = providerDefaults(id, p);
  } else if (rawCfg.upstream) {
    // old single-provider config
    const id = rawCfg.defaultProvider || "default";
    c.providers[id] = providerDefaults(id, rawCfg.upstream);
    c.defaultProvider = c.defaultProvider || id;
    if (rawCfg.models) {
      for (const [alias, target] of Object.entries(rawCfg.models)) c.aliases[alias] = `${id}:${target}`;
    }
  }
  if (!c.defaultProvider || !c.providers[c.defaultProvider]) {
    c.defaultProvider = Object.keys(c.providers)[0];
  }
  if (!c.defaultModel) {
    const first = c.providers[c.defaultProvider];
    c.defaultModel = (first && Array.isArray(first.models) && first.models[0]) || "deepseek-v4.1-flash";
  }
  return c;
}

let cfg = buildCfg();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(rawCfg, null, 2), "utf8");
  cfg = buildCfg();
  log("config saved (" + Object.keys(cfg.providers).length + " providers)");
}

const PORT = cfg.port;
const HOST = "127.0.0.1";

// ------------------------------------------------------------------- usage
const USAGE_PATH = path.join(ROOT, "usage.json");
let usage = (() => {
  try { return JSON.parse(fs.readFileSync(USAGE_PATH, "utf8")); } catch { return {}; }
})();
let usageDirty = false;
let usageTimer = null;

function bumpUsage(pid, model, input, output) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${pid}:${model}`;
  usage[day] = usage[day] || {};
  const row = usage[day][key] || { provider: pid, model, requests: 0, input: 0, output: 0 };
  row.requests += 1;
  row.input += input || 0;
  row.output += output || 0;
  usage[day][key] = row;
  usageDirty = true;
  if (!usageTimer) {
    usageTimer = setTimeout(() => {
      usageTimer = null;
      if (!usageDirty) return;
      usageDirty = false;
      try { fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2), "utf8"); } catch {}
    }, 1500);
  }
}

function usageSummary() {
  const days = Object.keys(usage).sort().slice(-7);
  const totals = {};
  for (const d of days) {
    for (const row of Object.values(usage[d] || {})) {
      const t = totals[row.provider + ":" + row.model] || { provider: row.provider, model: row.model, requests: 0, input: 0, output: 0 };
      t.requests += row.requests; t.input += row.input; t.output += row.output;
      totals[row.provider + ":" + row.model] = t;
    }
  }
  return { days, rows: Object.values(totals).sort((a, b) => b.requests - a.requests) };
}

// ------------------------------------------------------------------ request guard
// The gateway listens on 127.0.0.1 only, but the user's own browser can still
// reach 127.0.0.1. So:
// - Host must be this machine on this port: a DNS-rebinding page arrives with
//   its own host name and is refused.
// - A request that comes from a web page (it carries an Origin / Sec-Fetch-Site
//   header) is refused unless it is the dashboard itself. Claude Code, Cline,
//   SDKs and curl send no Origin and keep working with any API key ("dummy").
// - No CORS headers are sent, so other sites cannot read any response.
// - The dashboard API (/api/*) also needs a random per-run token that the
//   gateway writes into the dashboard page; other sites cannot read that page.
const crypto = require("node:crypto");
const DASHBOARD_TOKEN = crypto.randomBytes(24).toString("hex");
const localHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const ownOrigins = () => new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);

/** Returns an error text when the request must be refused, else "". */
function guardRequest(req, pathname) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!localHosts().has(host)) return "this gateway only answers requests addressed to 127.0.0.1 or localhost";
  const origin = req.headers.origin;
  const extra = Array.isArray(cfg && cfg.allowedOrigins) ? cfg.allowedOrigins.map(String) : [];
  const fromPage = origin !== undefined || /cross-site|same-site/i.test(String(req.headers["sec-fetch-site"] || ""));
  const ownPage = origin !== undefined && (ownOrigins().has(String(origin).toLowerCase()) || extra.includes(String(origin)));
  if (fromPage && !ownPage) return "requests from web pages are not allowed";
  if (pathname.startsWith("/api/")) {
    const sent = String(req.headers["x-vibe-route-token"] || "");
    const ok = sent.length === DASHBOARD_TOKEN.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(DASHBOARD_TOKEN));
    if (!ok) return "the dashboard API needs the dashboard's token (open the dashboard from the Vibe Route app or http://127.0.0.1:" + PORT + ")";
  }
  return "";
}

/** The dashboard page, with this run's token for its API calls. */
function withDashboardToken(html) {
  const meta = `<meta name="vibe-route-token" content="${DASHBOARD_TOKEN}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + "\n" + meta) : meta + html;
}

/** Upstream error text can echo a key back: hide anything key-shaped before a client sees it. */
function redactSecrets(text) {
  return String(text == null ? "" : text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [hidden]")
    .replace(/\b(sk-(?:or-v1-|ant-|proj-)?|gsk_|AIza|gh[pousr]_|github_pat_|xox[abpr]-|glpat-|hf_|npm_|r8_|xai-)[A-Za-z0-9_-]{8,}/g, "$1[hidden]")
    .replace(/("?(?:api[_-]?key|x-api-key|access_token|authorization|token|secret)"?\s*[:=]\s*"?)[^"\s,}&]{8,}/gi, "$1[hidden]");
}

// ------------------------------------------------------------------ logging
function log(...args) {
  const line = new Date().toISOString() + "  " + args.join(" ");
  try { fs.appendFileSync(LOG_PATH, line + "\r\n"); } catch {}
  console.log(line);
  try {
    if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) fs.truncateSync(LOG_PATH, 0);
  } catch {}
}

// ------------------------------------------------------------- provider key
const keyCache = new Map();
const OPENCODE_GO_BASE = "https://opencode.ai/inference/go/openai/v1";
let opencodeCache = { at: 0, info: null };

function opencodeDbCandidates() {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const home = os.homedir();
  add(process.env.OPENCODE_DB);
  if (process.env.XDG_DATA_HOME) add(path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"));
  add(path.join(home, ".local", "share", "opencode", "opencode.db"));
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, "opencode", "opencode.db"));
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, "opencode", "opencode.db"));
  add(path.join(home, ".opencode", "opencode.db"));
  add(path.join(home, ".config", "opencode", "opencode.db"));
  return out;
}

function opencodeAuthCandidates() {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const home = os.homedir();
  if (process.env.XDG_DATA_HOME) add(path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json"));
  add(path.join(home, ".local", "share", "opencode", "auth.json"));
  add(path.join(home, ".config", "opencode", "auth.json"));
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, "opencode", "auth.json"));
  return out;
}

function tokenFromValue(value) {
  if (!value) return null;
  if (typeof value === "object") {
    return value.access || value.key || value.token || value.apiKey || null;
  }
  const s = String(value).trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (typeof v === "string") return v;
    return v.access || v.key || v.token || v.apiKey || null;
  } catch {
    // Older builds stored the raw token instead of JSON.
    return s.length > 20 && !s.startsWith("{") ? s : null;
  }
}

// Reads OpenCode's login (read-only) from its SQLite DB or auth.json.
// The token is never logged or sent to the browser.
function findOpencodeCredential(force) {
  if (!force && opencodeCache.info && Date.now() - opencodeCache.at < 60 * 1000) return opencodeCache.info;
  const info = { installed: false, detected: false, dbPath: null, integrationId: null, token: null, error: null };

  for (const dbPath of opencodeDbCandidates()) {
    if (!fs.existsSync(dbPath)) continue;
    info.installed = true;
    info.dbPath = dbPath;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        let rows = [];
        try {
          rows = db.prepare(
            "select integration_id,value from credential where active = 1 and integration_id like 'opencode%'"
          ).all();
        } catch {}
        if (!rows.length) {
          try {
            rows = db.prepare(
              "select integration_id,value from credential where active = 1 and integration_id in ('opencode','opencode-go','opencode-zen')"
            ).all();
          } catch {}
        }
        for (const row of rows) {
          const t = tokenFromValue(row.value);
          if (t) {
            info.integrationId = row.integration_id;
            info.token = t;
            break;
          }
        }
      } finally {
        db.close();
      }
    } catch (e) {
      info.error = e.message;
    }
    if (info.token) break;
  }

  if (!info.token) {
    for (const authPath of opencodeAuthCandidates()) {
      if (!fs.existsSync(authPath)) continue;
      info.installed = true;
      info.dbPath = info.dbPath || authPath;
      try {
        const j = JSON.parse(fs.readFileSync(authPath, "utf8")) || {};
        const key = Object.keys(j).find((k) => /opencode/i.test(k));
        const t = key ? tokenFromValue(j[key]) : null;
        if (t) { info.integrationId = key; info.token = t; break; }
      } catch (e) {
        info.error = info.error || e.message;
      }
    }
  }

  info.detected = Boolean(info.token);
  opencodeCache = { at: Date.now(), info };
  return info;
}

function readOpencodeToken(force) {
  return findOpencodeCredential(force).token || null;
}

function keyFor(pid, force) {
  const p = cfg.providers[pid];
  if (!p) return "";
  if (p.keySource !== "opencode-db") return p.apiKey || "";
  const c = keyCache.get(pid);
  if (!force && c && Date.now() - c.at < 5 * 60 * 1000) return c.key;
  try {
    const t = readOpencodeToken(force);
    if (t) { keyCache.set(pid, { key: t, at: Date.now() }); return t; }
  } catch (e) {
    log("key read failed for " + pid + ": " + e.message);
  }
  return c ? c.key : "";
}

function opencodeProviderId() {
  const entries = Object.entries(cfg.providers);
  const byDb = entries.find(([, p]) => p.keySource === "opencode-db");
  if (byDb) return byDb[0];
  const byUrl = entries.find(([, p]) => /opencode\.ai\/inference\/go/i.test(String(p.baseUrl || "")));
  return byUrl ? byUrl[0] : null;
}

function opencodeStatus() {
  const info = rawCfg.autoDetectOpencode === false ? { detected: false, installed: false, disabled: true } : findOpencodeCredential();
  const pid = opencodeProviderId();
  const pr = pid ? cfg.providers[pid] : null;
  const modelCount = pr ? (pr.models || []).length : 0;
  let mode = "none";
  if (info.detected) mode = modelCount ? "go" : "free";
  return {
    installed: Boolean(info.installed),
    detected: Boolean(info.detected),
    mode,
    integrationId: info.integrationId || null,
    db: info.dbPath ? path.basename(info.dbPath) : null,
    provider: pid,
    providerLabel: pr ? pr.label : null,
    models: modelCount,
    error: info.error || null,
  };
}

// If OpenCode is installed and logged in but Vibe Route has no provider using
// it yet, add one automatically. The token stays in OpenCode's own DB.
function ensureOpencodeAutoProvider() {
  // Turned off: do not even read OpenCode's token files.
  if (rawCfg.autoDetectOpencode === false) return { pid: null, created: false, empty: false, info: { detected: false, installed: false, disabled: true } };
  const info = findOpencodeCredential();
  const existing = opencodeProviderId();
  if (existing) {
    return { pid: existing, created: false, empty: !(cfg.providers[existing].models || []).length, info };
  }
  if (!info.token) return { pid: null, created: false, empty: false, info };

  rawCfg.providers = rawCfg.providers || {};
  let pid = "opencode";
  if (rawCfg.providers[pid]) pid = "opencode-auto";
  if (rawCfg.providers[pid]) return { pid: null, created: false, empty: false, info };

  rawCfg.providers[pid] = {
    label: "OpenCode (auto)",
    baseUrl: OPENCODE_GO_BASE,
    chatPath: "/chat/completions",
    modelsPath: "/models",
    keySource: "opencode-db",
    sessionHeader: "ses_vibe_route",
    maxTokens: 16384,
    enabled: true,
    models: [],
  };
  if (!rawCfg.defaultProvider) rawCfg.defaultProvider = pid;
  saveConfig();
  log("OpenCode detected (" + info.dbPath + ") - added provider " + pid);
  return { pid, created: true, empty: true, info };
}

// Add only the free models a provider advertises. Shared by the Save flow,
// the "Add free models" button, and the startup warm-up.
async function addFreeModels(pid) {
  const pr = cfg.providers[pid];
  if (!pr) return { ok: false, error: "unknown provider" };
  const preset = presetFor(pr.configId || pid, pr.baseUrl);
  const cat = await catalog.getCatalog(pid, pr, keyFor(pid), { force: true });
  const all = cat.models || [];
  const freeOnly = presetFreeOnly(preset);
  const providerFreeTier = !preset || !preset.free || preset.free.available !== false;
  const free = all.filter((m) =>
    m.free === true || FREE_ID_RE.test(m.id) ||
    (!freeOnly && providerFreeTier)
  );
  if (!free.length) {
    return { ok: true, added: 0, total: all.length, models: pr.models || [], error: cat.error || "provider listed no free models" };
  }
  rawCfg.providers[pid] = rawCfg.providers[pid] || {};
  const list = Array.isArray(rawCfg.providers[pid].models) ? rawCfg.providers[pid].models.slice() : [];
  let added = 0;
  for (const m of free.slice(0, 30)) {
    if (!list.includes(m.id)) { list.push(m.id); added += 1; }
    modelMeta[metaKey(pid, m.id)] = {
      id: m.id, found: true, name: m.name,
      context: m.context, output: m.output,
      vision: m.vision, tools: m.tools, reasoning: m.reasoning, free: Boolean(m.free),
      checkedAt: new Date().toISOString(), provider: pid,
    };
  }
  saveMeta();
  rawCfg.providers[pid].models = list;
  if (!rawCfg.defaultProvider) rawCfg.defaultProvider = pid;
  if (!rawCfg.defaultModel && list[0]) rawCfg.defaultModel = list[0];
  saveConfig();
  if (added) log(`auto-free ${pid}: +${added} models (total ${list.length})`);
  return { ok: true, added, total: all.length, models: list };
}

async function warmFreeModels() {
  const opencodePid = opencodeAuto && opencodeAuto.pid;
  for (const pid of connectedProviderIds()) {
    if (pid === opencodePid) continue; // OpenCode already syncs all models
    try { await addFreeModels(pid); }
    catch (e) { log("free model warm-up failed for " + pid + ": " + e.message); }
  }
}

async function autoSyncOpencodeModels(pid) {
  const pr = cfg.providers[pid];
  if (!pr) return;
  try {
    const cat = await catalog.getCatalog(pid, pr, keyFor(pid), { force: true });
    const all = cat.models || [];
    if (!all.length) return;
    rawCfg.providers[pid] = rawCfg.providers[pid] || {};
    const list = Array.isArray(rawCfg.providers[pid].models) ? rawCfg.providers[pid].models.slice() : [];
    let added = 0;
    for (const m of all.slice(0, 100)) {
      if (!list.includes(m.id)) { list.push(m.id); added += 1; }
      modelMeta[metaKey(pid, m.id)] = {
        id: m.id, found: true, name: m.name,
        context: m.context, output: m.output,
        vision: m.vision, tools: m.tools, reasoning: m.reasoning, free: Boolean(m.free),
        checkedAt: new Date().toISOString(), provider: pid,
      };
    }
    saveMeta();
    rawCfg.providers[pid].models = list;
    if (!rawCfg.defaultModel && list[0]) rawCfg.defaultModel = list[0];
    saveConfig();
    log("OpenCode auto-sync " + pid + ": +" + added + " models (total " + list.length + ")");
  } catch (e) {
    log("OpenCode model sync failed: " + e.message);
  }
}

// ----------------------------------------------------------- model routing
function parseTarget(t) {
  const m = /^([A-Za-z0-9_-]+)[:/](.+)$/.exec(t);
  if (m && cfg.providers[m[1]]) return { provider: m[1], model: m[2] };
  return { provider: cfg.defaultProvider, model: t };
}

// Plain model id (no provider prefix) -> find the provider that owns it.
// This makes clients that send display names / strip the prefix still work.
// The models-cache.json lookup is served from memory (short TTL in catalog.cjs).
function findProviderForModel(model) {
  const ids = enabledProviders();
  const dp = cfg.defaultProvider;
  if (dp && cfg.providers[dp] && (cfg.providers[dp].models || []).includes(model)) return dp;
  for (const pid of ids) {
    if ((cfg.providers[pid].models || []).includes(model)) return pid;
  }
  for (const pid of ids) {
    const cached = catalog.getCachedCatalog(pid);
    if (cached && Array.isArray(cached.models) && cached.models.some((m) => m && m.id === model)) return pid;
  }
  return null;
}

const claudeRouteLogged = new Set();

function resolveModel(requested, depth) {
  if (!requested) return { provider: cfg.defaultProvider, model: cfg.defaultModel, alias: null };
  let current = String(requested);
  const seen = new Set();
  let alias = null;
  // Follow alias chains (alias -> alias -> provider:model) safely.
  for (let i = 0; i < 8 && cfg.aliases[current]; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (!alias) alias = current;
    current = String(cfg.aliases[current]);
  }

  const explicit = /^([A-Za-z0-9_-]+)[:/](.+)$/.exec(current);
  if (explicit && cfg.providers[explicit[1]]) {
    // An exact model id wins over a provider prefix: "openai/gpt-4o" stays one
    // id when a provider lists it under that full name.
    const exactOwner = findProviderForModel(current);
    if (exactOwner) return { provider: exactOwner, model: current, alias };
    return { provider: explicit[1], model: explicit[2], alias };
  }
  // Not a known provider prefix (model ids may themselves contain "/", e.g.
  // "humansand/ampersand-v0.1"). Find the provider that owns the full id.
  const owner = findProviderForModel(current);
  if (owner) return { provider: owner, model: current, alias };
  // Anthropic clients send their own model names (Claude Code uses a small
  // claude-* model for background calls). Nobody owns it: use the default model.
  if (!depth && /^claude-/i.test(current) && cfg.defaultModel && cfg.defaultModel !== current) {
    const def = resolveModel(cfg.defaultModel, 1);
    if (!claudeRouteLogged.has(current)) {
      claudeRouteLogged.add(current);
      log(`model ${current} is not configured - routing it to the default model ${def.provider}:${def.model}`);
    }
    return { provider: def.provider, model: def.model, alias: alias || current };
  }
  return { provider: cfg.defaultProvider, model: current, alias };
}

function enabledProviders() {
  const ids = Object.keys(cfg.providers).filter((id) => cfg.providers[id].enabled);
  return ids.sort((a, b) => (a === cfg.defaultProvider ? -1 : b === cfg.defaultProvider ? 1 : a.localeCompare(b)));
}

async function loadCatalogs(force) {
  const out = {};
  for (const pid of enabledProviders()) {
    out[pid] = await catalog.getCatalog(pid, cfg.providers[pid], keyFor(pid), { force });
  }
  return out;
}

// ------------------------------------------------------------- request convert
function blocksToText(content, sep) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === "text" && b.text).map((b) => b.text).join(sep == null ? "\n\n" : sep);
  }
  return "";
}

// tool_result content may be a string, an object, or an array of blocks
// (text + images). OpenAI tool messages only take text, so flatten it.
function toolResultText(c) {
  return toolResultContent(c).text;
}

// Same as toolResultText, but also returns the images so they can be sent in
// a user message right after the tool messages.
function toolResultContent(c) {
  const images = [];
  const one = (b) => {
    if (!b) return "";
    if (typeof b === "string") return b;
    if (typeof b !== "object") return String(b);
    if (b.type === "text") return b.text || "";
    if (b.type === "image") {
      const part = imagePart(b);
      if (part) images.push(part);
      return "[image attached]";
    }
    if (b.type === "document") return "[document attached]";
    try { return JSON.stringify(b); } catch { return ""; }
  };
  let text;
  if (c == null) text = "";
  else if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.map(one).filter(Boolean).join("\n");
  else text = one(c);
  return { text, images };
}

function imagePart(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === "base64" && src.data) {
    return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

function isMarked(b) {
  return Boolean(b && typeof b === "object" && b.cache_control && typeof b.cache_control === "object");
}

function hasCacheControl(body) {
  if (Array.isArray(body.system) && body.system.some(isMarked)) return true;
  if (Array.isArray(body.tools) && body.tools.some(isMarked)) return true;
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m && Array.isArray(m.content) && m.content.some(isMarked)) return true;
  }
  return false;
}

// Anthropic thinking budget -> OpenAI reasoning_effort.
function reasoningEffortFor(thinking) {
  if (!thinking || typeof thinking !== "object") return null;
  if (thinking.type !== "enabled" && thinking.type !== "adaptive") return null;
  const budget = Number(thinking.budget_tokens) || 0;
  if (!budget) return thinking.type === "adaptive" ? "medium" : "low";
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

// opts.model           upstream model id (filled into the payload)
// opts.cacheMarks      false = never forward cache_control
// opts.reasoningField  "reasoning_content" | "reasoning" | null: send assistant
//                      thinking back under this field (the upstream used it)
function toOpenAI(body, pid, opts) {
  opts = opts || {};
  const p = cfg.providers[pid] || {};
  const messages = [];
  const marks = opts.cacheMarks !== false && hasCacheControl(body);
  let placedMarks = false;
  const textPart = (b) => {
    const part = { type: "text", text: b.text };
    if (marks && isMarked(b)) { part.cache_control = Object.assign({}, b.cache_control); placedMarks = true; }
    return part;
  };

  // Merge adjacent plain text messages of the same role. Some providers
  // (Gemini, Mistral) reject consecutive user turns, and it is harmless.
  const push = (m) => {
    if (!m) return;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role && m.role !== "tool" &&
        typeof last.content === "string" && typeof m.content === "string" &&
        Object.keys(last).length === 2 && Object.keys(m).length === 2) {
      last.content = last.content ? last.content + "\n\n" + m.content : m.content;
      return;
    }
    messages.push(m);
  };

  if (body.system) {
    if (typeof body.system === "string") {
      if (body.system.trim()) messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const blocks = body.system.filter((b) => b && b.type === "text" && b.text);
      if (marks && blocks.some(isMarked)) {
        // Keep the blocks as parts so each cache_control mark stays on its text.
        messages.push({ role: "system", content: blocks.map(textPart) });
      } else {
        const sys = blocksToText(blocks);
        if (sys && sys.trim()) messages.push({ role: "system", content: sys });
      }
    }
  }

  const list = Array.isArray(body.messages) ? body.messages : [];
  for (let mi = 0; mi < list.length; mi += 1) {
    const m = list[mi];
    if (!m || typeof m !== "object") continue;

    if (m.role === "system" || m.role === "developer") {
      const s = typeof m.content === "string" ? m.content : blocksToText(m.content);
      if (s && s.trim()) push({ role: "system", content: s });
      continue;
    }

    const role = m.role === "assistant" ? "assistant" : "user";

    if (typeof m.content === "string") {
      if (m.content) push({ role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];

    if (m.role === "assistant") {
      const textBlocks = [];
      const toolCalls = [];
      const thinking = [];
      for (let bi = 0; bi < blocks.length; bi += 1) {
        const b = blocks[bi];
        if (!b) continue;
        if (b.type === "text" && b.text) textBlocks.push(b);
        else if (b.type === "tool_use") {
          toolCalls.push({
            // Deterministic id keeps the request prefix stable for caching.
            id: b.id || "call_" + mi + "_" + bi,
            type: "function",
            function: { name: b.name || "tool", arguments: JSON.stringify(b.input || {}) },
          });
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
          thinking.push(b.thinking);
        }
        // redacted_thinking / server_tool_use are not portable.
      }
      const text = textBlocks.map((b) => b.text).join("");
      // OpenAI rejects an assistant message with null content and no tool calls.
      if (!text && !toolCalls.length) continue;
      let content = text || null;
      if (marks && textBlocks.some(isMarked)) content = textBlocks.map(textPart);
      const msg = { role: "assistant", content };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (opts.reasoningField && thinking.length) msg[opts.reasoningField] = thinking.join("\n");
      push(msg);
      continue;
    }

    const parts = [];
    const toolMsgs = [];
    const toolImages = [];
    let userMarked = false;
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "text") {
        if (b.text) { parts.push(textPart(b)); if (marks && isMarked(b)) userMarked = true; }
      } else if (b.type === "image") {
        const part = imagePart(b);
        if (part) parts.push(part);
      } else if (b.type === "tool_result") {
        const r = toolResultContent(b.content);
        let text = r.text;
        if (b.is_error) text = "Error: " + (text || "tool failed");
        let content = text;
        if (marks && isMarked(b)) {
          content = [{ type: "text", text: text || " ", cache_control: Object.assign({}, b.cache_control) }];
          placedMarks = true;
        }
        toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id || "", content });
        toolImages.push(...r.images);
      }
    }
    // tool messages must directly follow the assistant tool_calls message
    if (toolMsgs.length) messages.push(...toolMsgs);
    // Images from tool results cannot go in a tool message: send them in the
    // user message that follows the tool messages.
    const all = toolImages.length ? [{ type: "text", text: "Images from the tool result above:" }, ...toolImages, ...parts] : parts;
    if (all.length) {
      const onlyText = all.every((x) => x.type === "text");
      if (onlyText && !userMarked) push({ role: "user", content: all.map((x) => x.text).join("\n\n") });
      else push({ role: "user", content: all });
    }
  }

  const out = {
    model: opts.model || null,
    messages,
    max_tokens: Number(body.max_tokens) > 0 ? body.max_tokens : (p.maxTokens || 8192),
    stream: Boolean(body.stream),
  };
  if (out.stream) out.stream_options = { include_usage: true };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter((t) => t && t.name).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
    const c = body.tool_choice;
    if (c && c.type === "any") out.tool_choice = "required";
    else if (c && c.type === "tool" && c.name) out.tool_choice = { type: "function", function: { name: c.name } };
    else if (c && c.type === "none") out.tool_choice = "none";
    else out.tool_choice = "auto";
    if (c && c.disable_parallel_tool_use === true && out.tool_choice !== "none") out.parallel_tool_calls = false;
  }
  const effort = reasoningEffortFor(body.thinking);
  if (effort) out.reasoning_effort = effort;
  // Hidden flag (not serialized): the payload carries cache_control marks.
  if (placedMarks) Object.defineProperty(out, "_vrCacheMarks", { value: true, enumerable: false });
  return out;
}

// Largest output the upstream model is known to accept, or null when unknown.
// Order: learned from an earlier 400, model meta, catalog, provider maxTokens.
function maxOutputLimit(pid, model, flags) {
  const limits = [];
  if (flags && Number(flags.maxTokens) > 0) limits.push(Number(flags.maxTokens));
  let known = 0;
  try {
    const meta = modelMeta[metaKey(pid, model)];
    if (meta && Number(meta.output) > 0) known = Number(meta.output);
  } catch {}
  if (!known) {
    try {
      const cat = catalog.getCachedCatalog(pid);
      const m = cat && catalog.findModel(cat, model);
      if (m && Number(m.output) > 0) known = Number(m.output);
    } catch {}
  }
  if (!known) {
    const raw = rawCfg.providers && rawCfg.providers[pid];
    if (raw && Number(raw.maxTokens) > 0) known = Number(raw.maxTokens);
  }
  if (known) limits.push(known);
  return limits.length ? Math.min(...limits) : null;
}

function clampMaxTokens(payload, pid, model, flags) {
  const limit = maxOutputLimit(pid, model, flags);
  if (!limit) return;
  for (const k of ["max_tokens", "max_completion_tokens"]) {
    if (Number(payload[k]) > limit) payload[k] = limit;
  }
}

// ------------------------------------------------------------ response convert
function mapStopReason(finish, hasTools) {
  return mapStop(finish, hasTools, null, null).stop_reason;
}

function mapStop(finish, hasTools, choice, stops) {
  if (hasTools || finish === "tool_calls" || finish === "function_call") return { stop_reason: "tool_use", stop_sequence: null };
  if (finish === "length") return { stop_reason: "max_tokens", stop_sequence: null };
  if (finish === "content_filter") return { stop_reason: "refusal", stop_sequence: null };
  // vLLM / SGLang report the matched stop string.
  const matched = choice && (typeof choice.stop_reason === "string" ? choice.stop_reason
    : typeof choice.matched_stop === "string" ? choice.matched_stop : null);
  if (matched && Array.isArray(stops) && stops.includes(matched)) return { stop_reason: "stop_sequence", stop_sequence: matched };
  if (finish === "stop_sequence") return { stop_reason: "stop_sequence", stop_sequence: matched || null };
  return { stop_reason: "end_turn", stop_sequence: null };
}

// OpenAI usage -> Anthropic usage. prompt_tokens includes cached tokens, the
// Anthropic input_tokens does not.
function mapUsage(u) {
  u = u && typeof u === "object" ? u : {};
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const read = Number(d.cached_tokens || u.cache_read_input_tokens || u.prompt_cache_hit_tokens || 0) || 0;
  const write = Number(d.cache_write_tokens || d.cache_creation_tokens || u.cache_creation_input_tokens || 0) || 0;
  const hasPrompt = u.prompt_tokens != null;
  const input = hasPrompt ? Math.max(0, (Number(u.prompt_tokens) || 0) - read - write) : (Number(u.input_tokens) || 0);
  return {
    usage: {
      input_tokens: input,
      output_tokens: Number(u.completion_tokens || u.output_tokens || 0) || 0,
      cache_creation_input_tokens: write,
      cache_read_input_tokens: read,
    },
    prompt: hasPrompt ? (Number(u.prompt_tokens) || 0) : input + read + write,
  };
}

function safeJson(text) {
  if (text == null || text === "") return {};
  if (typeof text === "object") return text;
  let s = String(text).trim();
  if (!s) return {};
  // Some models wrap JSON in a markdown fence.
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  try { return JSON.parse(s); } catch {}
  // Last resort: pull the first JSON object/array out of surrounding prose.
  const m = /[{\[][\s\S]*[}\]]/.exec(s);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return { _raw: String(text) };
}

function messageText(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("");
  }
  if (typeof c === "object" && typeof c.text === "string") return c.text;
  return "";
}

function reasoningOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.reasoning_content === "string") return { field: "reasoning_content", text: obj.reasoning_content };
  if (typeof obj.reasoning === "string") return { field: "reasoning", text: obj.reasoning };
  return null;
}

function toAnthropicMessage(oai, model, stops) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = [];
  const text = messageText(msg.content);
  const r = reasoningOf(msg);
  if (r && r.text) content.push({ type: "thinking", thinking: r.text, signature: "" });
  if (text.length) content.push({ type: "text", text });
  // Reasoning models sometimes put everything in reasoning_content.
  else if (!calls.length && r && r.text) content.push({ type: "text", text: r.text });
  for (const tc of calls) {
    content.push({
      type: "tool_use",
      id: tc.id || "toolu_" + Math.random().toString(36).slice(2, 12),
      name: tc.function ? tc.function.name : "tool",
      input: safeJson(tc.function && tc.function.arguments),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const rawId = String(oai.id || "");
  const stop = mapStop(choice.finish_reason, calls.length > 0, choice, stops);
  return {
    id: rawId.startsWith("msg_") ? rawId : "msg_" + (rawId.replace(/[^A-Za-z0-9]/g, "").slice(-20) || Math.random().toString(36).slice(2, 14)),
    type: "message", role: "assistant", model,
    content,
    stop_reason: stop.stop_reason,
    stop_sequence: stop.stop_sequence,
    usage: mapUsage(oai.usage).usage,
  };
}

// ---------------------------------------------------------------- upstream
async function callUpstream(pid, payload, signal) {
  const p = cfg.providers[pid];
  const url = p.baseUrl + p.chatPath;
  const headers = Object.assign({
    "content-type": "application/json",
    accept: payload.stream ? "text/event-stream" : "application/json",
    "user-agent": p.userAgent,
  }, p.headers);
  const key = keyFor(pid);
  if (key) headers.authorization = "Bearer " + key;
  if (p.sessionHeader) headers["x-opencode-session"] = headers["x-opencode-session"] || p.sessionHeader;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
}

// Config value in ms: missing/invalid -> default, 0 -> off.
function cfgMs(name, def) {
  const v = rawCfg[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// Timers for one upstream attempt:
//   firstByteTimeoutMs (60 s)  no response headers yet -> abort, try the fallback
//   idleTimeoutMs     (120 s)  no new data between chunks -> abort
//   timeoutMs         (off)    overall cap, only when set in config.json
//   nonStreamTimeoutMs         header wait for non-stream calls (default 300 s,
//                              the whole answer is generated before headers)
function upstreamTimer(clientSignal, stream) {
  const firstByte = stream ? cfgMs("firstByteTimeoutMs", 60000) : cfgMs("nonStreamTimeoutMs", Math.max(cfgMs("firstByteTimeoutMs", 60000), 300000));
  const idle = cfgMs("idleTimeoutMs", 120000);
  const overall = Number(rawCfg.timeoutMs) > 0 ? Number(rawCfg.timeoutMs) : 0;
  const ac = new AbortController();
  let fbT = null;
  let idleT = null;
  let allT = null;
  let fired = null;
  const fire = (message) => {
    if (ac.signal.aborted) return;
    const e = new Error(message);
    e.name = "TimeoutError";
    fired = e;
    ac.abort(e);
  };
  const onClient = () => { if (!ac.signal.aborted) ac.abort(clientSignal.reason); };
  if (clientSignal) {
    if (clientSignal.aborted) onClient();
    else clientSignal.addEventListener("abort", onClient, { once: true });
  }
  if (overall) allT = setTimeout(() => fire(`upstream timeout (overall cap ${overall} ms)`), overall);
  if (firstByte) fbT = setTimeout(() => fire(`upstream timeout (no response within ${firstByte} ms)`), firstByte);
  const armIdle = () => {
    if (idleT) clearTimeout(idleT);
    idleT = idle ? setTimeout(() => fire(`upstream timeout (no data for ${idle} ms)`), idle) : null;
  };
  return {
    signal: ac.signal,
    get fired() { return fired; },
    responded() { if (fbT) { clearTimeout(fbT); fbT = null; } armIdle(); },
    touch() { armIdle(); },
    pause() { if (idleT) { clearTimeout(idleT); idleT = null; } },
    done() {
      for (const t of [fbT, idleT, allT]) if (t) clearTimeout(t);
      fbT = idleT = allT = null;
      if (clientSignal) clientSignal.removeEventListener("abort", onClient);
    },
  };
}

function netError(e, timer, clientSignal) {
  if (clientSignal && clientSignal.aborted) return { status: 499, message: "client closed the request", clientGone: true };
  if (timer && timer.fired) return { status: 502, message: timer.fired.message, timeout: true };
  if (e && e.name === "TimeoutError") return { status: 502, message: "upstream timeout", timeout: true };
  const cause = e && e.cause && e.cause.message ? ": " + e.cause.message : "";
  return { status: 502, message: String((e && e.message) || e) + cause };
}

function routeCandidates(requested) {
  const primary = resolveModel(requested);
  const list = [primary];
  const seen = new Set([primary.provider + ":" + primary.model]);
  for (const fb of cfg.fallbacks || []) {
    const r = resolveModel(fb);
    const key = r.provider + ":" + r.model;
    if (!seen.has(key)) { seen.add(key); list.push(r); }
  }
  return list;
}

// ------------------------------------------------------- auto / free chain
function isAutoModel(m) {
  return /^auto$/i.test(String(m || "")) ||
    /^auto\/(free|cheap|fast|smart)$/i.test(String(m || "")) ||
    /^free$/i.test(String(m || ""));
}

const FREE_ID_RE = /(?:[:/_-])free$/i;

// Some gateways (OpenRouter, Vercel, Kilo) mix free and paid models under one
// key, so only the zero-priced / *-free entries are considered free.
function presetFreeOnly(preset) {
  if (!preset) return false;
  if (preset.usage === "openrouter") return true;
  return Boolean(preset.free && preset.free.zeroOnly);
}

function modelIsFree(pid, modelId) {
  const pr = cfg.providers[pid];
  if (!pr) return false;
  if (FREE_ID_RE.test(modelId)) return true;
  const meta = modelMeta[metaKey(pid, modelId)];
  if (meta && meta.free === true) return true;
  const preset = presetFor(pr.configId || pid, pr.baseUrl);
  if (!preset) return true;
  if (preset.free && preset.free.available === false) return false;
  if (presetFreeOnly(preset)) return false; // only zero-priced / *-free ids
  return true;
}

function autoChain() {
  const free = [];
  const rest = [];
  for (const pid of enabledProviders()) {
    const pr = cfg.providers[pid];
    for (const id of pr.models || []) {
      const c = { provider: pid, model: id };
      if (modelIsFree(pid, id)) free.push(c);
      else rest.push(c);
    }
  }
  const chain = free.length ? free.concat(rest) : rest;
  return chain.slice(0, 12);
}

async function readError(up) {
  let text = "";
  try { text = await up.text(); } catch {}
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || j.error.type)) || j.message || text;
    if (typeof j.error === "string") msg = j.error;
  } catch {}
  return { status: up.status, message: redactSecrets(String(msg || "")).slice(0, 500) };
}

async function discardBody(up) {
  try { if (up && up.body) await up.body.cancel(); } catch {}
}

// HTTP status for an error object found inside a 200 response.
function statusFromError(e, dflt) {
  if (!e || typeof e !== "object") e = { message: String(e || "") };
  for (const v of [e.status, e.code, e.status_code, e.http_status]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 400 && n <= 599) return n;
  }
  const s = [e.type, e.code, e.message].filter((x) => x != null).join(" ").toLowerCase();
  if (/rate.?limit|too many requests|quota|throttl/.test(s)) return 429;
  if (/overload|unavailable|capacity|busy/.test(s)) return 503;
  if (/unauthori|authenticat|api.?key|credential/.test(s)) return 401;
  if (/permission|forbidden/.test(s)) return 403;
  if (/not.?found|does not exist|no such model|unknown model/.test(s)) return 404;
  if (/context|too long|invalid|bad request|max_tokens/.test(s)) return 400;
  return dflt || 502;
}

// {error: ...} body (JSON answer or one SSE event) -> {status, message} or null.
function bodyError(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (Array.isArray(j.choices) && j.choices.length) return null;
  let e = j.error;
  if (!e && j.type === "error") e = { message: j.message || "upstream error" };
  if (!e) return null;
  if (typeof e !== "object") e = { message: String(e) };
  let message = e.message || e.type || e.code;
  if (!message) { try { message = JSON.stringify(e); } catch { message = "upstream error"; } }
  return { status: statusFromError(e), message: redactSecrets(String(message)).slice(0, 500) };
}

function fallbackEligible(status) {
  return !status || status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

// ------------------------------------------------- adaptive upstream retries
// Things learned about an upstream (provider + model) for this process, e.g.
// "rejects cache_control" or "max output is 8192". Only stored after the
// changed request succeeded.
const quirks = new Map();
const reasoningSeen = new Map(); // upstream key -> field the upstream used
function quirkKey(pid, model) { return pid + "\u0000" + model; }

function rememberQuirks(key, patch) {
  if (!patch || !Object.keys(patch).length) return;
  const cur = quirks.get(key) || {};
  quirks.set(key, Object.assign(cur, patch));
  log(`remembered for ${key.replace("\u0000", ":")}: ${JSON.stringify(patch)}`);
}

function lowerMaxTokens(msg, cur) {
  const ctx = /maximum context length is (\d+)[\s\S]*?(\d+) in the messages/i.exec(msg);
  if (ctx) {
    const room = Number(ctx[1]) - Number(ctx[2]) - 64;
    return room >= 256 && room < cur ? room : null;
  }
  const nums = (msg.match(/(?<![\w.-])\d+(?![\w-]|\.\d)/g) || []).map(Number).filter((n) => n >= 256 && n < cur);
  if (nums.length) return Math.max(...nums);
  if (cur > 8192) return 8192;
  if (cur > 4096) return 4096;
  return null;
}

const MAX_TOKENS_ERR = /max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens|(valid range|maximum|exceed|too large|at most|less than or equal)[^.]{0,60}tokens?|tokens?[^.]{0,60}(valid range|at most|exceed)/i;
const NOT_GENERIC_400 = /context|too long|too many tokens|rate.?limit|quota|unauthori|authenticat|api.?key|permission|forbidden|(model|deployment)[^.]{0,40}(not found|does not exist|unknown|not available|no such)|unknown model|invalid model|model_not_found/i;

// A 400 the request itself can fix -> { flags, why, remember } or null.
function adaptPayload(err, payload, flags) {
  if (!err || (err.status !== 400 && err.status !== 422)) return null;
  const msg = String(err.message || "");
  const low = msg.toLowerCase();
  const cur = Number(payload.max_tokens || payload.max_completion_tokens) || 0;
  if (cur && MAX_TOKENS_ERR.test(msg) && !/rate.?limit/.test(low)) {
    const next = lowerMaxTokens(msg, cur);
    if (next && next < cur) {
      return { flags: { maxTokens: next }, why: `max_tokens ${cur} -> ${next}`, remember: !/context/.test(low) };
    }
  }
  if (payload.stream_options && /stream_options|include_usage/.test(low)) {
    return { flags: { noStreamOptions: true }, why: "without stream_options", remember: true };
  }
  if (payload.reasoning_effort && /reasoning/.test(low)) {
    return { flags: { noReasoning: true }, why: "without reasoning_effort", remember: true };
  }
  if (payload.parallel_tool_calls !== undefined && /parallel_tool_calls|parallel tool/.test(low)) {
    return { flags: { noParallel: true }, why: "without parallel_tool_calls", remember: true };
  }
  if (payload._vrCacheMarks && !flags.noCache && /cache_control|cache control/.test(low)) {
    return { flags: { noCache: true }, why: "without cache_control", remember: true };
  }
  if (NOT_GENERIC_400.test(low)) return null;
  if (payload._vrCacheMarks && !flags.noCache) {
    return { flags: { noCache: true }, why: "without cache_control", remember: true };
  }
  if (!flags.noExtras && (payload.reasoning_effort || payload.parallel_tool_calls !== undefined || payload.stream_options)) {
    return { flags: { noExtras: true, noReasoning: true, noParallel: true, noStreamOptions: true }, why: "without optional fields", remember: true };
  }
  return null;
}

function applyFlags(payload, pid, model, flags) {
  clampMaxTokens(payload, pid, model, flags);
  if (flags.noStreamOptions) delete payload.stream_options;
  if (flags.noReasoning) delete payload.reasoning_effort;
  if (flags.noParallel) delete payload.parallel_tool_calls;
  return payload;
}

// --------------------------------------------------------- stream sources
const PEEK_MS = 10000;

// Reader over the upstream body that can wait for data with a deadline
// without losing the pending read. Chunks read while peeking are buffered.
function makeSource(up, timer) {
  const reader = up.body.getReader();
  let pending = null;
  return {
    buffered: [],
    read() {
      const p = pending || reader.read();
      pending = null;
      return p.then((r) => { timer.touch(); return r; });
    },
    readWithin(ms) {
      if (!pending) pending = reader.read();
      const p = pending;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ timeout: true }), ms);
        p.then((r) => { clearTimeout(t); if (pending === p) pending = null; timer.touch(); resolve(r); },
          (e) => { clearTimeout(t); if (pending === p) pending = null; reject(e); });
      });
    },
    cancel() { try { reader.cancel().catch(() => {}); } catch {} },
  };
}

async function* sourceChunks(src) {
  while (src.buffered.length) yield src.buffered.shift();
  for (;;) {
    const r = await src.read();
    if (r.done) return;
    if (r.value) yield r.value;
  }
}

function scanFirstEvent(text, final) {
  const lines = text.split("\n");
  if (!final) lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") return { ok: true };
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    const e = bodyError(j);
    return e ? { error: e } : { ok: true };
  }
  return null;
}

// Look at the first SSE event before committing to this upstream: an error
// event there is handled like the matching HTTP error (fallback eligible).
// After PEEK_MS without an event the stream is accepted as is.
async function peekStream(src, timer, clientSignal) {
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + PEEK_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return {};
    let r;
    try { r = await src.readWithin(left); } catch (e) { return { error: netError(e, timer, clientSignal) }; }
    if (r.timeout) return {};
    if (r.done) {
      text += dec.decode();
      const found = scanFirstEvent(text, true);
      if (found) return found.error ? { error: found.error } : {};
      let j = null;
      try { j = JSON.parse(text.trim()); } catch {}
      const e = bodyError(j);
      if (e) return { error: e };
      return { error: { status: 502, message: "upstream stream ended without data" } };
    }
    src.buffered.push(r.value);
    text += dec.decode(r.value, { stream: true });
    const found = scanFirstEvent(text, false);
    if (found) return found.error ? { error: found.error } : {};
  }
}

// One candidate: call, refresh the key once on 401, retry with a fixed
// request on fixable 400s, and check for an error hidden in a 200 answer.
// -> { ok: true, payload, json | src, timer } or { ok: false, err }
async function attemptUpstream(c, build, clientSignal) {
  const qk = quirkKey(c.provider, c.model);
  const flags = Object.assign({}, quirks.get(qk));
  const learned = {};
  let authRetried = false;
  let adaptive = 0;
  for (;;) {
    const payload = build(c, flags);
    const timer = upstreamTimer(clientSignal, Boolean(payload.stream));
    let up;
    try {
      up = await callUpstream(c.provider, payload, timer.signal);
    } catch (e) {
      const err = netError(e, timer, clientSignal);
      timer.done();
      return { ok: false, err };
    }
    timer.responded();
    if (up.status === 401 && !authRetried) {
      authRetried = true;
      await discardBody(up);
      timer.done();
      keyFor(c.provider, true);
      continue;
    }
    let err = null;
    let json = null;
    let src = null;
    if (!up.ok) {
      err = await readError(up);
    } else if (!payload.stream) {
      let raw = "";
      try { raw = await up.text(); } catch (e) { err = netError(e, timer, clientSignal); }
      if (!err) {
        try { json = JSON.parse(raw); } catch {
          err = { status: 502, message: "upstream returned non-JSON: " + redactSecrets(String(raw).replace(/\s+/g, " ")).slice(0, 300) };
        }
      }
      if (!err) err = bodyError(json);
    } else {
      src = makeSource(up, timer);
      const peek = await peekStream(src, timer, clientSignal);
      if (peek.error) { err = peek.error; src.cancel(); src = null; }
    }
    if (!err) {
      if (!payload.stream) timer.done();
      if (Object.keys(learned).length) rememberQuirks(qk, learned);
      return { ok: true, payload, json, src, timer };
    }
    timer.done();
    if (err.clientGone) return { ok: false, err };
    const fix = adaptive < 5 ? adaptPayload(err, payload, flags) : null;
    if (!fix) return { ok: false, err };
    adaptive += 1;
    log(`upstream ${c.provider}:${c.model} ${err.status}: ${String(err.message).replace(/\s+/g, " ").slice(0, 120)} - retrying ${fix.why}`);
    Object.assign(flags, fix.flags);
    if (fix.remember) Object.assign(learned, fix.flags);
  }
}

async function runCandidates(candidates, build, clientSignal, auto) {
  let lastErr = null;
  for (const c of candidates) {
    if (!cfg.providers[c.provider]) { lastErr = { status: 404, message: "unknown provider " + c.provider }; continue; }
    const r = await attemptUpstream(c, build, clientSignal);
    if (r.ok) return { got: r, used: c, lastErr };
    lastErr = r.err;
    log(`upstream ${c.provider}:${c.model} ${lastErr.status}: ${String(lastErr.message).replace(/\s+/g, " ").slice(0, 160)}`);
    if (lastErr.clientGone) break;
    if (!auto && !fallbackEligible(lastErr.status)) break;
  }
  return { got: null, used: null, lastErr };
}

// --------------------------------------------------------------- streaming
function sseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

// res.write that waits for 'drain' when the client reads slowly.
function makeWriter(res, timer) {
  return async (data) => {
    if (res.writableEnded || res.destroyed) return false;
    let ok = true;
    try { ok = res.write(data); } catch { return false; }
    if (!ok && !res.destroyed && !res.writableEnded) {
      if (timer) timer.pause();
      await new Promise((resolve) => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.on("drain", done);
        res.on("close", done);
      });
      if (timer) timer.touch();
    }
    return !res.destroyed;
  };
}

// ctx: { timer, stops, onReasoning(field) }
async function relayStream(src, res, model, ctx) {
  ctx = ctx || {};
  sseHeaders(res);
  if (res.flushHeaders) { try { res.flushHeaders(); } catch {} }

  const write = makeWriter(res, ctx.timer);
  let queue = [];
  let lastOut = Date.now();
  const send = (event, data) => { queue.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const flush = async () => {
    if (!queue.length) return;
    const s = queue.join("");
    queue = [];
    lastOut = Date.now();
    await write(s);
  };
  // Keep the client from stalling while the upstream thinks.
  const pingMs = cfgMs("pingIntervalMs", 10000);
  const ping = pingMs ? setInterval(() => {
    if (Date.now() - lastOut < pingMs - 20 || queue.length) return;
    send("ping", { type: "ping" });
    flush().catch(() => {});
  }, Math.max(50, Math.floor(pingMs / 4))) : null;

  const msgId = "msg_" + Math.random().toString(36).slice(2, 14);
  send("message_start", {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  let blockIndex = -1;
  let open = null;
  let finish = null;
  let finishChoice = null;
  let sawDone = false;
  let rawUsage = null;
  let reasoning = "";
  let textStarted = false;
  const tools = new Map(); // slot key -> tool, in arrival order
  const indexSlot = new Map(); // tool_calls[].index -> current slot key
  let lastKey = null;
  let slotSeq = 0;

  const startBlock = (type, extra) => {
    blockIndex += 1;
    open = type;
    send("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: Object.assign({ type }, extra),
    });
    return blockIndex;
  };
  const stopBlock = () => {
    if (open) {
      send("content_block_stop", { type: "content_block_stop", index: blockIndex });
      open = null;
    }
  };
  const sendText = (text) => {
    if (!text) return;
    if (open !== "text") { stopBlock(); startBlock("text", { text: "" }); }
    textStarted = true;
    send("content_block_delta", {
      type: "content_block_delta", index: blockIndex,
      delta: { type: "text_delta", text },
    });
  };
  // Upstream reasoning -> Anthropic thinking block, before any text/tool.
  const sendThinking = (text) => {
    if (!text || textStarted || tools.size) return;
    if (open !== "thinking") { stopBlock(); startBlock("thinking", { thinking: "", signature: "" }); }
    send("content_block_delta", {
      type: "content_block_delta", index: blockIndex,
      delta: { type: "thinking_delta", thinking: text },
    });
  };

  // Providers differ: most stream argument fragments, some resend the whole
  // (growing) JSON every chunk. A fragment is a full resend only when it is
  // longer than and starts with what we already have.
  const addArgs = (t, frag) => {
    if (!frag || typeof frag !== "string") return;
    if (!t.args) t.args = frag;
    else if (frag.length > t.args.length && frag.startsWith(t.args)) t.args = frag;
    else t.args += frag;
  };

  const isCompleteJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
  // A new id (or a new name after complete arguments) opens a new slot, also
  // when the provider sends no index or reuses one index for every call.
  const slotFor = (tc) => {
    const name = tc.function && tc.function.name;
    const differs = (t) => Boolean(t && ((t.id && tc.id && t.id !== tc.id) ||
      (!tc.id && name && t.name && t.args && isCompleteJson(t.args))));
    let key;
    if (tc.index != null) {
      key = indexSlot.get(tc.index);
      if (!key || differs(tools.get(key))) { key = "s" + (slotSeq += 1); indexSlot.set(tc.index, key); }
    } else {
      key = lastKey;
      if (!key || differs(tools.get(key))) key = "s" + (slotSeq += 1);
    }
    if (!tools.has(key)) tools.set(key, { id: "", name: "", args: "" });
    lastKey = key;
    return tools.get(key);
  };

  const handleChunk = (json) => {
    if (!json || typeof json !== "object") return;
    const e = bodyError(json);
    if (e) { const err = new Error(e.message); err.status = e.status; throw err; }
    if (json.usage) rawUsage = json.usage;
    const choice = (json.choices && json.choices[0]) || null;
    if (!choice) return;
    const d = choice.delta || choice.message || {};

    const r = reasoningOf(d);
    if (r && r.text) {
      reasoning += r.text;
      if (ctx.onReasoning) ctx.onReasoning(r.field);
      sendThinking(r.text);
    }

    let text = d.content;
    if (Array.isArray(text)) {
      text = text.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("");
    }
    if (typeof text === "string" && text.length) sendText(text);

    const tcs = Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      if (open === "thinking") stopBlock();
      const t = slotFor(tc);
      if (tc.id) t.id = tc.id;
      if (tc.function && tc.function.name) t.name = tc.function.name;
      addArgs(t, tc.function && tc.function.arguments);
    }

    if (choice.finish_reason) { finish = choice.finish_reason; finishChoice = choice; }
  };

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") { sawDone = true; return; }
    let json;
    try { json = JSON.parse(data); } catch { return; }
    handleChunk(json);
  };

  const decoder = new TextDecoder();
  let buf = "";
  let streamError = null;
  let clientGone = false;

  try {
    await flush();
    for await (const chunk of sourceChunks(src)) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
      await flush();
      if (res.destroyed) { clientGone = true; break; }
    }
    if (!clientGone) {
      // flush a final line without trailing newline
      const tail = buf + decoder.decode();
      if (tail.trim()) handleLine(tail);
    }
  } catch (e) {
    if (res.destroyed) clientGone = true;
    else {
      streamError = e;
      const why = ctx.timer && ctx.timer.fired ? ctx.timer.fired.message : e.message;
      streamError.message = why;
      log("stream read error (" + (src.url || "upstream") + "): " + why);
    }
  } finally {
    if (ping) clearInterval(ping);
    if (ctx.timer) ctx.timer.done();
  }

  const mapped = mapUsage(rawUsage);
  const result = Object.assign({}, mapped.usage, { prompt: mapped.prompt });

  if (clientGone) {
    src.cancel();
    return Object.assign(result, { error: "client closed the stream" });
  }

  // Upstream closed without finish_reason and without [DONE]: the answer is
  // incomplete, so do not report a normal end of turn.
  if (!streamError && !finish && !sawDone) {
    streamError = new Error("upstream stream ended early");
    log("stream ended early (" + model + ")");
  }

  if (streamError) {
    send("error", { type: "error", error: { type: errorTypeFor(streamError.status || 500), message: streamError.message } });
    await flush();
    if (!res.writableEnded) { try { res.end(); } catch {} }
    return Object.assign(result, { error: streamError.message });
  }

  stopBlock();

  // Emit all tool calls once, in order, each as its own content block.
  for (const t of tools.values()) {
    let args = t.args && t.args.trim() ? t.args : "{}";
    if (!isCompleteJson(args)) args = JSON.stringify(safeJson(args));
    blockIndex += 1;
    send("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: {
        type: "tool_use",
        id: t.id || "toolu_" + Math.random().toString(36).slice(2, 12),
        name: t.name || "tool",
        input: {},
      },
    });
    send("content_block_delta", {
      type: "content_block_delta", index: blockIndex,
      delta: { type: "input_json_delta", partial_json: args },
    });
    send("content_block_stop", { type: "content_block_stop", index: blockIndex });
  }

  // Some reasoning models return only reasoning_content.
  if (!textStarted && !tools.size && reasoning) { sendText(reasoning); stopBlock(); }
  // Always leave at least one block so strict clients are happy.
  if (blockIndex < 0) { startBlock("text", { text: "" }); stopBlock(); }

  const stop = mapStop(finish, tools.size > 0, finishChoice, ctx.stops);
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop.stop_reason, stop_sequence: stop.stop_sequence },
    usage: mapped.usage,
  });
  send("message_stop", { type: "message_stop" });
  await flush();
  if (!res.writableEnded) { try { res.end(); } catch {} }
  return result;
}

// OpenAI passthrough stream: bytes go through unchanged; only an early end
// or a read error adds a final error chunk.
async function relayOpenAIStream(src, res, ctx) {
  ctx = ctx || {};
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  if (res.flushHeaders) { try { res.flushHeaders(); } catch {} }
  const write = makeWriter(res, ctx.timer);
  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;
  let finish = null;
  let sawDone = false;
  let sawError = false;
  let streamError = null;
  const onLine = (raw) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") { sawDone = true; return; }
    try {
      const j = JSON.parse(data);
      if (j && j.usage) usage = j.usage;
      if (bodyError(j)) sawError = true;
      const ch = j && j.choices && j.choices[0];
      if (ch && ch.finish_reason) finish = ch.finish_reason;
    } catch {}
  };
  try {
    for await (const chunk of sourceChunks(src)) {
      if (res.destroyed) break;
      await write(chunk);
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) onLine(buf);
  } catch (e) {
    if (!res.destroyed) {
      streamError = (ctx.timer && ctx.timer.fired) ? ctx.timer.fired.message : e.message;
      log("openai stream error: " + streamError);
    }
  } finally {
    if (ctx.timer) ctx.timer.done();
  }
  if (res.destroyed) { src.cancel(); return { usage, error: "client closed the stream" }; }
  let error = null;
  if (streamError && !sawError) error = streamError;
  else if (!streamError && !finish && !sawDone && !sawError) error = "upstream stream ended early";
  if (error) {
    await write("\n\ndata: " + JSON.stringify({ error: { message: error, type: "server_error", param: null, code: "upstream_stream_error" } }) + "\n\n");
  }
  if (!res.writableEnded) { try { res.end(); } catch {} }
  return { usage, error };
}

// ---------------------------------------------------------------- handlers
function anthropicError(res, status, type, message) {
  if (res.destroyed) return;
  if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function openaiError(res, status, type, message, code) {
  if (res.destroyed) return;
  if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: type || openaiErrorType(status), param: null, code: code || null } }));
}

function errorTypeFor(status) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function openaiErrorType(status) {
  if (status === 401) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

function noteReasoning(c, field) {
  const k = quirkKey(c.provider, c.model);
  if (!reasoningSeen.has(k)) reasoningSeen.set(k, field);
}

async function handleMessages(req, res, body, clientSignal) {
  const requested = body.model || cfg.defaultModel;
  const auto = isAutoModel(requested);
  const candidates = auto ? autoChain() : routeCandidates(requested);
  if (!candidates.length) {
    return anthropicError(res, 400, "invalid_request_error", "no models configured — add models in the app first");
  }
  const first = candidates[0];

  if (!cfg.providers[first.provider]) {
    return anthropicError(res, 404, "not_found_error", "unknown provider for model " + requested);
  }

  let probe;
  try { probe = toOpenAI(body, first.provider, { model: first.model }); } catch (e) {
    return anthropicError(res, 400, "invalid_request_error", "could not convert request: " + e.message);
  }

  log(`-> anthropic ${req.headers["user-agent"] || "?"} ${requested} stream=${probe.stream} msgs=${probe.messages.length} tools=${(probe.tools || []).length} chain=${candidates.map((c) => c.provider + ":" + c.model).join(" > ")}`);

  const stops = Array.isArray(body.stop_sequences) ? body.stop_sequences : null;
  const build = (c, flags) => {
    const out = toOpenAI(body, c.provider, {
      model: c.model,
      cacheMarks: !flags.noCache,
      reasoningField: reasoningSeen.get(quirkKey(c.provider, c.model)) || null,
    });
    return applyFlags(out, c.provider, c.model, flags);
  };

  const { got, used, lastErr } = await runCandidates(candidates, build, clientSignal, auto);
  if (!got) {
    const status = (lastErr && lastErr.status) || 502;
    return anthropicError(res, status, errorTypeFor(status), lastErr ? lastErr.message : "no provider available");
  }

  res.setHeader("x-vibe-route-model", used.provider + "/" + used.model);
  res.setHeader("x-vibe-route-auto", auto ? "1" : "0");
  res.setHeader("x-vibe-route-attempts", String(candidates.indexOf(used) + 1));

  if (got.payload.stream) {
    try {
      const usage = await relayStream(got.src, res, requested, {
        timer: got.timer, stops, onReasoning: (field) => noteReasoning(used, field),
      });
      bumpUsage(used.provider, used.model, (usage && usage.prompt) || 0, (usage && usage.output_tokens) || 0);
      if (usage && usage.error) log(`<- stream error ${used.provider}:${used.model}: ${usage.error}`);
      else log(`<- stream done ${used.provider}:${used.model}`);
    } catch (e) {
      log("stream error (" + used.provider + "): " + e.message);
      if (!res.headersSent) anthropicError(res, 502, "api_error", e.message);
      else if (!res.writableEnded) res.end();
    }
    return;
  }

  const oai = got.json;
  const choice0 = (oai && oai.choices && oai.choices[0]) || {};
  const r = reasoningOf(choice0.message);
  if (r && r.text) noteReasoning(used, r.field);
  const out = toAnthropicMessage(oai, requested, stops);
  bumpUsage(used.provider, used.model, mapUsage(oai.usage).prompt, out.usage.output_tokens);
  log(`<- 200 ${used.provider}:${used.model} blocks=${out.content.length} stop=${out.stop_reason}`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
}

// OpenAI-compatible endpoint: same routing, no translation.
async function handleOpenAI(req, res, body, clientSignal) {
  const requested = body.model || cfg.defaultModel;
  const auto = isAutoModel(requested);
  const candidates = auto ? autoChain() : routeCandidates(requested);
  if (!candidates.length) {
    return openaiError(res, 400, "invalid_request_error", "no models configured — add models in the app first");
  }
  const first = candidates[0];
  if (!cfg.providers[first.provider]) {
    return openaiError(res, 404, "not_found_error", "unknown model " + requested, "model_not_found");
  }

  log(`-> openai ${req.headers["user-agent"] || "?"} ${requested} stream=${Boolean(body.stream)} chain=${candidates.map((c) => c.provider + ":" + c.model).join(" > ")}`);

  const build = (c, flags) => applyFlags(Object.assign({}, body, { model: c.model }), c.provider, c.model, flags);
  const { got, used, lastErr } = await runCandidates(candidates, build, clientSignal, auto);
  if (!got) {
    const status = (lastErr && lastErr.status) || 502;
    return openaiError(res, status, openaiErrorType(status), lastErr ? lastErr.message : "no provider available");
  }

  res.setHeader("x-vibe-route-model", used.provider + "/" + used.model);
  res.setHeader("x-vibe-route-auto", auto ? "1" : "0");
  res.setHeader("x-vibe-route-attempts", String(candidates.indexOf(used) + 1));

  if (got.payload.stream) {
    const r = await relayOpenAIStream(got.src, res, { timer: got.timer });
    const usage = r && r.usage;
    bumpUsage(used.provider, used.model, (usage && usage.prompt_tokens) || 0, (usage && usage.completion_tokens) || 0);
    if (r && r.error) log(`<- stream error ${used.provider}:${used.model}: ${r.error}`);
    else log(`<- stream done ${used.provider}:${used.model}`);
    return;
  }

  const j = got.json;
  if (j && typeof j === "object" && !Array.isArray(j)) j.model = requested;
  bumpUsage(used.provider, used.model, (j && j.usage && j.usage.prompt_tokens) || 0, (j && j.usage && j.usage.completion_tokens) || 0);
  log(`<- 200 ${used.provider}:${used.model}`);
  jsonRes(res, 200, j);
}

// count_tokens input check: the shape Anthropic accepts, so a malformed body
// gets a clear 400 instead of a guess.
function countTokensProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
  if (body.system != null && typeof body.system !== "string") {
    if (!Array.isArray(body.system)) return "system must be a string or an array of blocks";
    if (body.system.some((b) => !b || typeof b !== "object")) return "system blocks must be objects";
  }
  if (body.messages != null && !Array.isArray(body.messages)) return "messages must be an array";
  const msgs = body.messages || [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) return `messages.${i} must be an object`;
    if (typeof m.content === "string") continue;
    if (!Array.isArray(m.content)) return `messages.${i}.content must be a string or an array of blocks`;
    for (let j = 0; j < m.content.length; j += 1) {
      const b = m.content[j];
      if (!b || typeof b !== "object" || Array.isArray(b)) return `messages.${i}.content.${j} must be an object`;
    }
  }
  if (body.tools != null && !Array.isArray(body.tools)) return "tools must be an array";
  return null;
}

function estimateTokens(body) {
  let chars = 0;
  const add = (v) => {
    if (v == null) return;
    if (typeof v === "string") { chars += v.length; return; }
    try { chars += JSON.stringify(v).length; } catch {}
  };
  const addBlocks = (c, depth) => {
    if (c == null || depth > 4) return;
    if (typeof c === "string") return add(c);
    const list = Array.isArray(c) ? c : [c];
    for (const b of list) {
      if (!b) continue;
      if (typeof b === "string") { add(b); continue; }
      if (typeof b !== "object") continue;
      if (typeof b.text === "string") add(b.text);
      if (typeof b.thinking === "string") add(b.thinking);
      if (b.type === "tool_use") add(b.input || {});
      if (b.type === "tool_result") addBlocks(b.content, depth + 1);
    }
  };
  if (!body || typeof body !== "object") return 1;
  addBlocks(body.system, 0);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m && typeof m === "object") addBlocks(m.content, 0);
  }
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!t || typeof t !== "object") continue;
    add(t.name); add(t.description); add(t.input_schema || {});
  }
  return Math.max(1, Math.ceil(chars / 4));
}

// ------------------------------------------------------- my models (lazy)
// Only the models you add by name are ever looked up. No bulk discovery.
const MODEL_META_PATH = path.join(ROOT, "model-meta.json");
let modelMeta = (() => {
  try { return JSON.parse(fs.readFileSync(MODEL_META_PATH, "utf8")); } catch { return {}; }
})();
function metaKey(pid, id) { return pid + "::" + id; }
function saveMeta() {
  try { fs.writeFileSync(MODEL_META_PATH, JSON.stringify(modelMeta, null, 2), "utf8"); } catch {}
}

async function lookupModel(pid, modelId, force) {
  const provider = cfg.providers[pid];
  if (!provider) throw new Error("unknown provider " + pid);
  const cat = await catalog.getCatalog(pid, provider, keyFor(pid), { force: Boolean(force) });
  const found = catalog.findModel(cat, modelId);
  const meta = found
    ? {
        id: modelId, found: true, name: found.name,
        context: found.context, output: found.output,
        vision: found.vision, tools: found.tools, reasoning: found.reasoning,
        free: Boolean(found.free),
      }
    : { id: modelId, found: false, context: null, output: null, vision: null, tools: null, reasoning: null, free: false };
  meta.checkedAt = new Date().toISOString();
  meta.provider = pid;
  modelMeta[metaKey(pid, modelId)] = meta;
  saveMeta();
  return meta;
}

function myModels() {
  const out = [];
  const chain = autoChain();
  const freeCount = chain.filter((c) => modelIsFree(c.provider, c.model)).length;
  if (chain.length) {
    out.push({
      id: "auto",
      aliasId: "auto",
      provider: "*",
      providerLabel: freeCount ? `Auto — ${freeCount} free model(s), fallback` : `Auto — ${chain.length} model(s), fallback`,
      contextWindow: null,
      maxOutput: null,
      vision: null,
      tools: null,
      reasoning: null,
      found: true,
      checkedAt: null,
      isAuto: true,
      chainLength: chain.length,
      freeCount,
    });
  }
  for (const pid of enabledProviders()) {
    const pr = cfg.providers[pid];
    for (const id of pr.models || []) {
      const meta = modelMeta[metaKey(pid, id)] || { id, found: false };
      out.push({
        id,
        aliasId: pid === cfg.defaultProvider ? id : `${pid}/${id}`,
        provider: pid,
        providerLabel: pr.label,
        contextWindow: meta.context ?? null,
        maxOutput: meta.output ?? null,
        vision: meta.vision ?? null,
        tools: meta.tools ?? null,
        reasoning: meta.reasoning ?? null,
        free: Boolean(meta.free),
        found: Boolean(meta.found),
        checkedAt: meta.checkedAt || null,
      });
    }
  }
  return out;
}

function aliasesAsModels() {
  return Object.entries(cfg.aliases).map(([alias, target]) => {
    const t = parseTarget(target);
    const meta = modelMeta[metaKey(t.provider, t.model)] || {};
    return {
      id: alias,
      aliasId: alias,
      provider: t.provider,
      providerLabel: (cfg.providers[t.provider] && cfg.providers[t.provider].label) || t.provider,
      contextWindow: meta.context ?? null,
      maxOutput: meta.output ?? null,
      vision: meta.vision ?? null,
      tools: meta.tools ?? null,
      reasoning: meta.reasoning ?? null,
      free: Boolean(meta.free),
      found: Boolean(meta.found),
      checkedAt: meta.checkedAt || null,
      isAlias: true,
      target: target,
    };
  });
}

async function mergedModels(force) {
  const list = myModels().concat(aliasesAsModels());
  return { list };
}

// Providers that actually have credentials (or are keyless/local). Used when
// exposing a provider's full catalog to agent apps.
function connectedProviderIds() {
  return enabledProviders().filter((pid) => {
    const p = cfg.providers[pid];
    if (!p) return false;
    if (p.apiKey) return true;
    if (p.keySource === "opencode-db") {
      try { return Boolean(readOpencodeToken()); } catch { return false; }
    }
    const preset = presetFor(p.configId || pid, p.baseUrl);
    if (preset && (preset.keyless || (preset.free && preset.free.anonymous))) return true;
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(String(p.baseUrl || ""));
  });
}

// Agent model pickers (Cline/Roo/Continue/OpenAI SDK) call /v1/models.
// Return everything the connected providers advertise, not just the models
// that were manually added, so auto-fetch shows every connected model.
function catalogClientModels() {
  const out = [];
  for (const pid of connectedProviderIds()) {
    const pr = cfg.providers[pid];
    const cached = catalog.getCachedCatalog(pid);
    const models = cached && Array.isArray(cached.models) ? cached.models : [];
    for (const m of models) {
      if (!m || !m.id) continue;
      out.push({
        id: m.id,
        aliasId: pid === cfg.defaultProvider ? m.id : `${pid}/${m.id}`,
        provider: pid,
        providerLabel: pr.label,
        contextWindow: m.context ?? null,
        maxOutput: m.output ?? null,
        vision: m.vision ?? null,
        tools: m.tools ?? null,
        reasoning: m.reasoning ?? null,
        free: Boolean(m.free),
        found: true,
        catalog: true,
        checkedAt: cached.fetchedAt || null,
      });
    }
  }
  return out;
}

function clientModels() {
  const base = myModels().concat(aliasesAsModels());
  // Default: only models added for connected providers. Set
  // "exposeCatalogModels": true in config.json to expose whole catalogs.
  if (rawCfg.exposeCatalogModels !== true) return { list: base };
  const seen = new Set();
  for (const m of base) { seen.add(m.aliasId); seen.add(m.id); }
  const out = base.slice();
  for (const m of catalogClientModels()) {
    if (seen.has(m.aliasId) || seen.has(m.id)) continue;
    seen.add(m.aliasId); seen.add(m.id);
    out.push(m);
  }
  return { list: out };
}

// ---------------------------------------------------------------- dashboard
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const fmt = (n) => (n == null ? "-" : n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n));

function renderDashboard(_cats, list) {
  const route = resolveModel(cfg.defaultModel);
  const dm = modelMeta[metaKey(route.provider, route.model)] || null;

  const providerCards = enabledProviders().map((pid) => {
    const p = cfg.providers[pid];
    const count = (p.models || []).length;
    return `<div class="card">
      <h2>${esc(p.label)} ${pid === cfg.defaultProvider ? '<span class="badge ok">default</span>' : ""}</h2>
      <div><code>${esc(p.baseUrl)}</code></div>
      <div class="muted">key: ${esc(p.keySource)} - models: ${count}</div>
    </div>`;
  }).join("");

  const rows = list.map((m) => `<tr>
      <td><span class="pill">${esc(m.provider)}</span></td>
      <td class="id">${esc(m.id)}</td>
      <td class="num">${fmt(m.context_window)}</td>
      <td class="num">${fmt(m.max_output_tokens)}</td>
      <td>${m.supports_vision ? "yes" : "-"}</td>
      <td>${m.supports_tools ? "yes" : "-"}</td>
    </tr>`).join("\n");

  const active = dm
    ? `<span class="badge">context ${fmt(dm.context)}</span>
       <span class="badge">max out ${fmt(dm.output)}</span>
       <span class="badge ${dm.vision ? "ok" : ""}">vision ${dm.vision ? "yes" : "no"}</span>
       <span class="badge ${dm.tools ? "ok" : ""}">tools ${dm.tools ? "yes" : "no"}</span>`
    : `<span class="badge warn">not found in provider list</span>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Vibe Route</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
 :root{color-scheme:dark}
 body{background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:13px;margin:0 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em}
 .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:16px}
 code,pre{font-family:ui-monospace,Consolas,monospace;font-size:13px}
 pre{background:#0b0f14;border:1px solid #30363d;border-radius:8px;padding:12px;overflow:auto;margin:0}
 .badge{display:inline-block;background:#21262d;border:1px solid #30363d;border-radius:999px;padding:2px 10px;margin:2px 6px 2px 0;font-size:12px}
 .badge.ok{border-color:#238636;color:#7ee787} .badge.warn{border-color:#9e6a03;color:#e3b341}
 .pill{background:#1f6feb33;border:1px solid #1f6feb;border-radius:6px;padding:1px 6px;font-size:11px}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d}
 th{color:#8b949e;font-weight:600;position:sticky;top:0;background:#0d1117}
 td.num{text-align:right} td.id{font-family:ui-monospace,Consolas,monospace}
 .muted{color:#8b949e} a{color:#58a6ff} .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950;margin-right:6px}
</style></head><body>
<h1><span class="dot"></span>Vibe Route</h1>
<div class="muted">Anthropic â‡„ OpenAI Â· ${enabledProviders().length} provider(s) Â· ${list.length} models Â· uptime ${Math.round(process.uptime())}s Â· <a href="/?refresh=1">refresh</a></div>

<div class="card">
  <h2>Paste into Claude Code / Claude Dev</h2>
  <pre>Base URL : http://127.0.0.1:${PORT}
API key  : dummy
Model    : ${esc(cfg.defaultModel)}   (or any id from the table below)</pre>
  <div class="muted" style="margin-top:8px">env: ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} &nbsp; ANTHROPIC_AUTH_TOKEN=dummy &nbsp; ANTHROPIC_MODEL=${esc(cfg.defaultModel)}</div>
  <div style="margin-top:10px"><strong>${esc(cfg.defaultModel)}</strong> ${active}</div>
</div>

${providerCards}

<div class="card">
  <h2>All models (${list.length})</h2>
  <table><thead><tr><th>provider</th><th>model id</th><th style="text-align:right">context</th><th style="text-align:right">max out</th><th>vision</th><th>tools</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="muted">no models loaded</td></tr>'}</tbody></table>
</div>
</body></html>`;
}

// ------------------------------------------------------------------ server
function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function jsonRes(res, status, obj) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj, null, 2));
}

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 10) return "***";
  // Only the last 4 characters: enough to tell keys apart, too little to help guess one.
  return "••••" + k.slice(-4);
}

/** Same provider address (scheme + host + port + path), ignoring a trailing slash and case of the host. */
function sameBase(a, b) {
  const norm = (s) => {
    try { const u = new URL(String(s || "").trim()); return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`; }
    catch { return String(s || "").trim().replace(/\/+$/, "").toLowerCase(); }
  };
  return norm(a) === norm(b);
}

async function testProvider(p) {
  const base = String(p.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("base URL must start with http:// or https://");
  const url = base + (p.modelsPath || "/models");
  const headers = Object.assign({ "user-agent": p.userAgent || "vibe-route/1.0" }, p.headers || {});
  if (p.apiKey) headers.authorization = "Bearer " + p.apiKey;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return {
    ok: true,
    count: list.length,
    models: list.slice(0, 200).map((m) => ({
      id: m.id || m.model || m.name,
      name: m.name || m.display_name || m.id,
      context: (m.limit && m.limit.context) || m.context_length || (m.top_provider && m.top_provider.context_length) || null,
      vision: JSON.stringify(m.modalities || m.architecture || "").includes("image"),
      tools: Boolean(m.capabilities && m.capabilities.tools && m.capabilities.tools.supported) ||
        (Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools")),
    })),
  };
}

async function probeUsage(pid) {
  const pr = cfg.providers[pid];
  if (!pr) return { supported: false, error: "unknown provider " + pid };
  const preset = presetFor(pr.configId || pid, pr.baseUrl);
  const kind = preset ? preset.usage : "none";

  if (kind === "openrouter") {
    const key = keyFor(pid);
    if (!key) return { supported: true, ok: false, error: "no api key saved" };
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { authorization: "Bearer " + key } });
    if (!r.ok) return { supported: true, ok: false, error: "OpenRouter HTTP " + r.status };
    const j = await r.json();
    const d = j.data || {};
    const remaining = d.limit == null ? null : Math.max(0, d.limit - (d.usage || 0));
    return {
      supported: true, ok: true, kind: "openrouter",
      label: "OpenRouter credits",
      used: d.usage == null ? null : d.usage,
      limit: d.limit == null ? null : d.limit,
      remaining,
      currency: "USD",
      isFreeTier: Boolean(d.is_free_tier),
      rateLimit: d.rate_limit || null,
      freeTierNote: preset && preset.free ? preset.free.detail : null,
    };
  }

  return {
    supported: false,
    reason: "provider has no public usage endpoint",
    freeTier: preset ? preset.free : null,
    docs: preset ? preset.docs : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const force = url.searchParams.get("refresh") === "1";
  const refused = guardRequest(req, p);
  if (refused) {
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: refused } }));
  }
  // Same-origin pages never need a CORS preflight; nothing else is let in.
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ---------------------------------------------------------------- app api
  if (req.method === "GET" && p === "/api/catalog") {
    return jsonRes(res, 200, { presets });
  }

  if (req.method === "GET" && p === "/api/usage") {
    const id = url.searchParams.get("id") || "";
    try {
      return jsonRes(res, 200, await probeUsage(id));
    } catch (e) {
      return jsonRes(res, 200, { supported: false, error: e.message });
    }
  }

  if (req.method === "GET" && p === "/api/state") {
    const { list } = await mergedModels(force);
    return jsonRes(res, 200, {
      port: PORT,
      defaultProvider: cfg.defaultProvider,
      defaultModel: cfg.defaultModel,
      aliases: cfg.aliases,
      providers: enabledProviders().concat(Object.keys(cfg.providers).filter((id) => !enabledProviders().includes(id))).map((id) => {
        const pr = cfg.providers[id];
        const preset = presetFor(pr.configId || id, pr.baseUrl);
        const own = (pr.models || []).map((mid) => {
          const meta = modelMeta[metaKey(id, mid)] || {};
          return { id: mid, context: meta.context ?? null, output: meta.output ?? null, vision: meta.vision ?? null, tools: meta.tools ?? null, free: Boolean(meta.free), found: Boolean(meta.found) };
        });
        return {
          id,
          label: pr.label,
          baseUrl: pr.baseUrl,
          modelsPath: pr.modelsPath,
          sessionHeader: pr.sessionHeader,
          keySource: pr.keySource,
          apiKeyMasked: maskKey(pr.apiKey),
          enabled: pr.enabled,
          models: own,
          modelCount: own.length,
          preset: preset ? {
            free: preset.free || null,
            docs: preset.docs || null,
            signup: preset.signup || null,
            usage: preset.usage || "none",
            notes: preset.notes || "",
          } : null,
        };
      }),
      models: list,
    });
  }

  if (req.method === "POST" && (p === "/api/models/add" || p === "/api/models/remove")) {
    try {
      const body = await readJson(req);
      const pid = String(body.provider || "");
      const model = String(body.model || "").trim();
      if (!cfg.providers[pid]) return jsonRes(res, 400, { ok: false, error: "unknown provider" });
      if (!model) return jsonRes(res, 400, { ok: false, error: "model name required" });

      rawCfg.providers[pid] = rawCfg.providers[pid] || {};
      const list = Array.isArray(rawCfg.providers[pid].models) ? rawCfg.providers[pid].models.slice() : [];
      const adding = p.endsWith("/add");

      if (adding) {
        if (!list.includes(model)) list.push(model);
      } else {
        const i = list.indexOf(model);
        if (i >= 0) list.splice(i, 1);
        delete modelMeta[metaKey(pid, model)];
        saveMeta();
      }

      rawCfg.providers[pid].models = list;
      if (!rawCfg.defaultProvider) rawCfg.defaultProvider = pid;
      if (!rawCfg.defaultModel) rawCfg.defaultModel = model;
      // Do not leave the default pointing at a model that was just removed.
      if (!adding && rawCfg.defaultProvider === pid && rawCfg.defaultModel === model) {
        rawCfg.defaultModel = list[0] || "";
      }
      saveConfig();

      let meta = null;
      let error = null;
      if (adding) {
        try { meta = await lookupModel(pid, model, true); }
        catch (e) { error = e.message; }
      }
      return jsonRes(res, 200, { ok: true, meta, error, models: list });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && p === "/api/models/autofree") {
    try {
      const body = await readJson(req);
      const pid = String(body.provider || "");
      if (!cfg.providers[pid]) return jsonRes(res, 400, { ok: false, error: "unknown provider" });
      return jsonRes(res, 200, await addFreeModels(pid));
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  // Add every model a provider advertises (one key -> usable immediately).
  if (req.method === "POST" && p === "/api/models/all") {
    try {
      const body = await readJson(req);
      const pid = String(body.provider || "");
      const pr = cfg.providers[pid];
      if (!pr) return jsonRes(res, 400, { ok: false, error: "unknown provider" });

      const preset = presetFor(pr.configId || pid, pr.baseUrl);
      const cat = await catalog.getCatalog(pid, pr, keyFor(pid), { force: true });
      const all = cat.models || [];
      if (!all.length) {
        return jsonRes(res, 200, { ok: true, added: 0, total: 0, error: cat.error || "provider listed no models" });
      }
      const freeOnly = body.freeOnly !== false && presetFreeOnly(preset);
      const picked = freeOnly ? all.filter((m) => m.free === true || FREE_ID_RE.test(m.id)) : all;

      rawCfg.providers[pid] = rawCfg.providers[pid] || {};
      const list = Array.isArray(rawCfg.providers[pid].models) ? rawCfg.providers[pid].models.slice() : [];
      let added = 0;
      for (const m of picked.slice(0, 100)) {
        if (!list.includes(m.id)) { list.push(m.id); added += 1; }
        modelMeta[metaKey(pid, m.id)] = {
          id: m.id, found: true, name: m.name,
          context: m.context, output: m.output,
          vision: m.vision, tools: m.tools, reasoning: m.reasoning, free: Boolean(m.free),
          checkedAt: new Date().toISOString(), provider: pid,
        };
      }
      saveMeta();
      rawCfg.providers[pid].models = list;
      if (!rawCfg.defaultProvider) rawCfg.defaultProvider = pid;
      if (!rawCfg.defaultModel) rawCfg.defaultModel = list[0] || "";
      saveConfig();
      log(`add-all ${pid}: +${added} models (total ${list.length})`);
      return jsonRes(res, 200, { ok: true, added, total: all.length, models: list, freeOnly });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (p.startsWith("/api/providers")) {
    const idFromPath = decodeURIComponent(p.slice("/api/providers".length).replace(/^\//, ""));

    if (req.method === "POST" && p === "/api/providers/test") {
      try {
        const body = await readJson(req);
        const existing = cfg.providers[body.id];
        // A saved key is only ever sent to the address it was saved for: testing
        // the same provider id against another base URL needs its own key.
        const sameAddress = existing && sameBase(existing.baseUrl, body.baseUrl || existing.baseUrl);
        const apiKey = body.apiKey || (existing && sameAddress ? keyFor(body.id) : "");
        const saved = existing && sameAddress ? { baseUrl: existing.baseUrl, modelsPath: existing.modelsPath, headers: existing.headers } : {};
        const asked = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        const result = await testProvider({ ...saved, ...asked, apiKey });
        return jsonRes(res, 200, result);
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: e.message });
      }
    }

    if (req.method === "POST" && p === "/api/providers") {
      try {
        const body = await readJson(req);
        const id = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        if (!id) return jsonRes(res, 400, { ok: false, error: "provider name is required (a-z, 0-9, -)" });
        if (!/^https?:\/\//i.test(String(body.baseUrl || ""))) {
          return jsonRes(res, 400, { ok: false, error: "base URL must start with http:// or https://" });
        }
        const prev = rawCfg.providers && rawCfg.providers[id] ? rawCfg.providers[id] : {};
        const entry = Object.assign({}, prev, {
          label: body.label || id,
          baseUrl: String(body.baseUrl).replace(/\/+$/, ""),
          enabled: body.enabled !== false,
        });
        if (body.modelsPath) entry.modelsPath = body.modelsPath;
        if (typeof body.sessionHeader === "string") entry.sessionHeader = body.sessionHeader;
        if (Array.isArray(body.models)) entry.models = body.models.filter(Boolean);
        // A provider moved to another address loses its saved key (and an
        // OpenCode-linked token): the old key must never follow it there.
        if (prev.baseUrl && !sameBase(prev.baseUrl, entry.baseUrl)) {
          delete entry.apiKey;
          if (entry.keySource && entry.keySource !== "config") entry.keySource = "config";
          if (entry.headers && typeof entry.headers === "object") {
            for (const h of Object.keys(entry.headers)) if (/authorization|api[-_]?key|token|secret|cookie/i.test(h)) delete entry.headers[h];
          }
        }
        if (typeof body.apiKey === "string" && body.apiKey.trim() && body.apiKey !== "***") {
          entry.apiKey = body.apiKey.trim();
          entry.keySource = "config";
        }
        if (body.keySource) entry.keySource = body.keySource;
        if (body.headers && typeof body.headers === "object") entry.headers = body.headers;

        rawCfg.providers = rawCfg.providers || {};
        rawCfg.providers[id] = entry;
        if (!rawCfg.defaultProvider || !rawCfg.providers[rawCfg.defaultProvider]) {
          rawCfg.defaultProvider = id;
          rawCfg.defaultModel = (entry.models && entry.models[0]) || rawCfg.defaultModel || "";
        }
        saveConfig();
        const hasKey = Boolean(entry.apiKey && String(entry.apiKey).trim());
        return jsonRes(res, 200, { ok: true, id, hasKey });
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: e.message });
      }
    }

    if (req.method === "DELETE") {
      const id = idFromPath || url.searchParams.get("id");
      if (!id || !rawCfg.providers || !rawCfg.providers[id]) {
        return jsonRes(res, 404, { ok: false, error: "provider not found" });
      }
      delete rawCfg.providers[id];
      // Drop aliases that pointed at the removed provider.
      const aliases = rawCfg.aliases || {};
      for (const [alias, target] of Object.entries(aliases)) {
        const s = String(target || "");
        if (s.startsWith(id + ":") || s.startsWith(id + "/")) delete aliases[alias];
      }
      rawCfg.aliases = aliases;
      if (rawCfg.defaultProvider === id) {
        rawCfg.defaultProvider = Object.keys(rawCfg.providers)[0] || "";
        const dp = rawCfg.providers[rawCfg.defaultProvider];
        rawCfg.defaultModel = (dp && Array.isArray(dp.models) && dp.models[0]) || "";
      }
      // If the default model was an alias we just dropped, pick a real one.
      if (rawCfg.defaultModel && !aliases[rawCfg.defaultModel]) {
        const dp = rawCfg.providers[rawCfg.defaultProvider];
        if (dp && Array.isArray(dp.models) && !dp.models.includes(rawCfg.defaultModel)) {
          rawCfg.defaultModel = dp.models[0] || "";
        }
      }
      saveConfig();
      return jsonRes(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && p === "/api/default") {
    try {
      const body = await readJson(req);
      if (body.provider && rawCfg.providers && rawCfg.providers[body.provider]) {
        rawCfg.defaultProvider = body.provider;
      }
      if (body.model) rawCfg.defaultModel = body.model;
      saveConfig();
      return jsonRes(res, 200, { ok: true, defaultProvider: cfg.defaultProvider, defaultModel: cfg.defaultModel });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === "GET" && p === "/api/opencode") {
    return jsonRes(res, 200, opencodeStatus());
  }

  if (req.method === "GET" && p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      name: "vibe-route",
      status: "ok",
      defaultProvider: cfg.defaultProvider,
      defaultModel: cfg.defaultModel,
      // No addresses or key sources here: /health needs no token.
      providers: enabledProviders().map((id) => ({ id, label: cfg.providers[id].label })),
      uptime: Math.round(process.uptime()) + "s",
    }, null, 2));
  }

  if (req.method === "GET" && (p === "/" || p === "/models" || p === "/api/models" || p.startsWith("/v1/models"))) {
    const wantsClientList = p === "/models" || p.startsWith("/v1/models");
    const { list } = wantsClientList ? clientModels() : await mergedModels(force);

    if (p === "/api/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ generated: new Date().toISOString(), models: list }, null, 2));
    }

    const created = Math.floor(Date.now() / 1000);

    if (p.startsWith("/v1/models/")) {
      const want = decodeURIComponent(p.slice("/v1/models/".length));
      const m = list.find((x) => x.aliasId === want || x.id === want);
      if (!m) return anthropicError(res, 404, "not_found_error", "unknown model " + want);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        id: m.aliasId,
        object: "model",
        created,
        owned_by: m.provider,
        type: "model",
        name: m.aliasId,
        display_name: m.aliasId,
        provider: m.provider,
        context_window: m.contextWindow,
        max_output_tokens: m.maxOutput,
        supports_vision: m.vision,
        supports_tools: m.tools,
        supports_reasoning: m.reasoning,
        free: Boolean(m.free),
      }));
    }

    if (p === "/v1/models" || p === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        object: "list",
        data: list.map((m) => ({
          id: m.aliasId, object: "model", created, owned_by: m.provider,
          type: "model", name: m.aliasId, display_name: m.aliasId,
          provider: m.provider, provider_label: m.providerLabel,
          context_window: m.contextWindow, max_output_tokens: m.maxOutput,
          supports_vision: m.vision, supports_tools: m.tools, supports_reasoning: m.reasoning,
          free: Boolean(m.free), checked_at: m.checkedAt,
        })),
      }, null, 2));
    }

    try {
      const html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
      // no-store: the page carries this run's dashboard token.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
      return res.end(withDashboardToken(html));
    } catch {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
      return res.end(withDashboardToken(renderDashboard({}, list)));
    }
  }

  const isMessages = p === "/v1/messages" || p === "/v1/messages/count_tokens";
  const isOpenAI = p === "/v1/chat/completions" || p === "/chat/completions";
  // OpenAI-style paths get OpenAI-format errors, everything else Anthropic.
  const openaiStyle = isOpenAI || /(^|\/)(chat|completions|embeddings|responses)(\/|$)/.test(p);
  const sendError = (status, type, message) => (openaiStyle
    ? openaiError(res, status, type === "request_too_large" ? "invalid_request_error" : type, message)
    : anthropicError(res, status, type, message));

  if (req.method !== "POST" || (!isMessages && !isOpenAI)) {
    return sendError(404, "not_found_error", "unknown path " + p);
  }

  const MAX_BODY = 64 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    size += c.length;
    if (tooLarge) {
      // Drain the rest so the client can read the 413; give up on absurd sizes.
      if (size > MAX_BODY * 4) req.destroy();
      return;
    }
    if (size > MAX_BODY) {
      tooLarge = true;
      chunks.length = 0;
      res.setHeader("connection", "close");
      sendError(413, "request_too_large", "request body is larger than 64 MB");
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch (e) { return sendError(400, "invalid_request_error", "invalid JSON: " + e.message); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(400, "invalid_request_error", "request body must be a JSON object");
    }

    // stop the upstream call if the client goes away
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    if (p === "/v1/messages/count_tokens") {
      try {
        const problem = countTokensProblem(body);
        if (problem) return anthropicError(res, 400, "invalid_request_error", problem);
        const n = estimateTokens(body);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: n }));
      } catch (e) {
        log("count_tokens failed: " + (e && e.message));
        return anthropicError(res, 400, "invalid_request_error", "could not count tokens: " + (e && e.message));
      }
    }

    const task = isOpenAI ? handleOpenAI(req, res, body, ac.signal) : handleMessages(req, res, body, ac.signal);
    task.catch((e) => {
      log("handler crash:", e && e.stack || e);
      sendError(500, isOpenAI ? "server_error" : "api_error", String(e && e.message || e));
    });
  });
  req.on("error", (e) => { log("request read error: " + (e && e.message)); });
});

// Auto-detect OpenCode's login at startup (cold config / new PC).
const opencodeAuto = ensureOpencodeAutoProvider();

// Agent clients hold connections open between turns; do not close idle sockets.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.timeout = 0;
server.requestTimeout = 0;

server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    const m = "port " + PORT + " is already in use - change \"port\" in config.json (and the client base URL) or stop the other instance";
    log("FATAL: " + m);
    console.error(m);
    process.exit(1);
  }
  log("server error: " + (e && e.message));
});

server.listen(PORT, HOST, () => {
  log("=================================================");
  log("Vibe Route listening on http://" + HOST + ":" + PORT);
  for (const id of enabledProviders()) {
    const p = cfg.providers[id];
    log(`provider ${id}: ${p.baseUrl} (key: ${p.keySource})${id === cfg.defaultProvider ? " [default]" : ""}`);
  }
  log("default model: " + cfg.defaultModel);
  log("Claude: ANTHROPIC_BASE_URL=http://" + HOST + ":" + PORT);
  log("=================================================");

  if (opencodeAuto.pid && rawCfg.autoSyncOpencode !== false) {
    const t = setTimeout(() => autoSyncOpencodeModels(opencodeAuto.pid), 1200);
    if (t.unref) t.unref();
  }
  if (rawCfg.autoFreeOnStart !== false) {
    const t = setTimeout(() => warmFreeModels(), 2500);
    if (t.unref) t.unref();
  }
});

process.on("SIGINT", () => { log("stopped"); process.exit(0); });

// One bad request must never take the gateway down: log and keep serving.
process.on("uncaughtException", (e) => { try { log("uncaught exception: " + ((e && e.stack) || e)); } catch {} });
process.on("unhandledRejection", (e) => { try { log("unhandled rejection: " + ((e && e.stack) || e)); } catch {} });
