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

function addCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-expose-headers", "*");
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
  const info = findOpencodeCredential();
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
  if (rawCfg.autoDetectOpencode === false) return { pid: null, created: false, empty: false, info: findOpencodeCredential() };
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

function resolveModel(requested) {
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
    return { provider: explicit[1], model: explicit[2], alias };
  }
  // Not a known provider prefix (model ids may themselves contain "/", e.g.
  // "humansand/ampersand-v0.1"). Find the provider that owns the full id.
  const owner = findProviderForModel(current);
  if (owner) return { provider: owner, model: current, alias };
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
function blocksToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
  return "";
}

// tool_result content may be a string, an object, or an array of blocks
// (text + images). OpenAI tool messages only take text, so flatten it.
function toolResultText(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b) return "";
      if (typeof b === "string") return b;
      if (b.type === "text") return b.text || "";
      if (b.type === "image") return "[image attached]";
      if (b.type === "document") return "[document attached]";
      try { return JSON.stringify(b); } catch { return ""; }
    }).filter(Boolean).join("\n");
  }
  if (typeof c === "object") {
    if (c.type === "text") return c.text || "";
    try { return JSON.stringify(c); } catch { return String(c); }
  }
  return String(c);
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

function toOpenAI(body, pid) {
  const p = cfg.providers[pid] || {};
  const messages = [];

  // Merge adjacent plain text messages of the same role. Some providers
  // (Gemini, Mistral) reject consecutive user turns, and it is harmless.
  const push = (m) => {
    if (!m) return;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role && m.role !== "tool" &&
        typeof last.content === "string" && typeof m.content === "string" &&
        !last.tool_calls && !m.tool_calls) {
      last.content = last.content ? last.content + "\n\n" + m.content : m.content;
      return;
    }
    messages.push(m);
  };

  if (body.system) {
    const sys = typeof body.system === "string" ? body.system : blocksToText(body.system);
    if (sys && sys.trim()) messages.push({ role: "system", content: sys });
  }

  for (const m of body.messages || []) {
    if (!m) continue;

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
      const textParts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === "text" && b.text) textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id || "call_" + Math.random().toString(36).slice(2, 12),
            type: "function",
            function: { name: b.name || "tool", arguments: JSON.stringify(b.input || {}) },
          });
        }
        // thinking / redacted_thinking / server_tool_use are not portable.
      }
      const text = textParts.join("");
      // OpenAI rejects an assistant message with null content and no tool calls.
      if (!text && !toolCalls.length) continue;
      const msg = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      push(msg);
      continue;
    }

    const parts = [];
    const toolMsgs = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "text") {
        if (b.text) parts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const part = imagePart(b);
        if (part) parts.push(part);
      } else if (b.type === "tool_result") {
        toolMsgs.push({
          role: "tool",
          tool_call_id: b.tool_use_id || "",
          content: toolResultText(b.content),
        });
      }
    }
    // tool messages must directly follow the assistant tool_calls message
    if (toolMsgs.length) messages.push(...toolMsgs);
    if (parts.length) {
      const onlyText = parts.every((x) => x.type === "text");
      push({ role: "user", content: onlyText ? parts.map((x) => x.text).join("") : parts });
    }
  }

  const out = {
    model: null,
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
  }
  return out;
}

// ------------------------------------------------------------ response convert
function mapStopReason(finish, hasTools) {
  if (hasTools || finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
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

function toAnthropicMessage(oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = [];
  const text = messageText(msg.content);
  if (text.length) content.push({ type: "text", text });
  // Reasoning models sometimes put everything in reasoning_content.
  else if (!calls.length && (msg.reasoning_content || msg.reasoning)) {
    content.push({ type: "text", text: String(msg.reasoning_content || msg.reasoning) });
  }
  for (const tc of calls) {
    content.push({
      type: "tool_use",
      id: tc.id || "toolu_" + Math.random().toString(36).slice(2, 12),
      name: tc.function ? tc.function.name : "tool",
      input: safeJson(tc.function && tc.function.arguments),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const usage = oai.usage || {};
  const rawId = String(oai.id || "");
  return {
    id: rawId.startsWith("msg_") ? rawId : "msg_" + (rawId.replace(/[^A-Za-z0-9]/g, "").slice(-20) || Math.random().toString(36).slice(2, 14)),
    type: "message", role: "assistant", model,
    content,
    stop_reason: mapStopReason(choice.finish_reason, calls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
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

function callSignal(extra) {
  const timeout = AbortSignal.timeout(cfg.timeoutMs || 180000);
  if (!extra) return timeout;
  try { return AbortSignal.any([extra, timeout]); } catch { return extra; }
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
  } catch {}
  return { status: up.status, message: String(msg || "").slice(0, 500) };
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

async function relayStream(up, res, model) {
  sseHeaders(res);
  if (res.flushHeaders) { try { res.flushHeaders(); } catch {} }

  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  const msgId = "msg_" + Math.random().toString(36).slice(2, 14);

  send("message_start", {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let blockIndex = -1;
  let open = null;
  let finish = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const tools = new Map(); // tool_calls[].index -> tool
  let reasoning = "";

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
    send("content_block_delta", {
      type: "content_block_delta", index: blockIndex,
      delta: { type: "text_delta", text },
    });
  };

  // Providers differ: most stream argument fragments, some resend the whole
  // (growing) JSON every chunk. Handle both without duplicating the payload.
  const addArgs = (t, frag) => {
    if (!frag) return;
    if (!t.args) t.args = frag;
    else if (frag.startsWith(t.args)) t.args = frag;
    else if (t.args.endsWith(frag)) return;
    else t.args += frag;
  };

  const handleChunk = (json) => {
    if (!json || typeof json !== "object") return;
    if (json.error) {
      const m = json.error.message || json.error.type || JSON.stringify(json.error);
      throw new Error(String(m));
    }
    if (json.usage) {
      usage.input_tokens = json.usage.prompt_tokens || json.usage.input_tokens || usage.input_tokens;
      usage.output_tokens = json.usage.completion_tokens || json.usage.output_tokens || usage.output_tokens;
    }
    const choice = (json.choices && json.choices[0]) || null;
    if (!choice) return;
    const d = choice.delta || {};

    let text = d.content;
    if (Array.isArray(text)) {
      text = text.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("");
    }
    if (typeof text === "string" && text.length) sendText(text);
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    else if (typeof d.reasoning === "string") reasoning += d.reasoning;

    const tcs = Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (const tc of tcs) {
      const i = tc.index == null ? 0 : tc.index;
      let t = tools.get(i);
      if (!t) { t = { id: "", name: "", args: "" }; tools.set(i, t); }
      if (tc.id) t.id = tc.id;
      if (tc.function && tc.function.name) t.name = tc.function.name;
      addArgs(t, tc.function && tc.function.arguments);
    }

    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const decoder = new TextDecoder();
  let buf = "";
  let streamError = null;

  try {
    for await (const chunk of up.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        handleChunk(json);
      }
    }
    // flush a final line without trailing newline
    const tail = (buf + decoder.decode()).trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trim();
      if (data && data !== "[DONE]") {
        try { handleChunk(JSON.parse(data)); } catch {}
      }
    }
  } catch (e) {
    streamError = e;
    log("stream read error (" + (up.url || "upstream") + "): " + e.message);
  }

  if (streamError) {
    send("error", { type: "error", error: { type: "api_error", message: streamError.message } });
    if (!res.writableEnded) { try { res.end(); } catch {} }
    return Object.assign({}, usage, { error: streamError.message });
  }

  stopBlock();

  // Emit all tool calls once, in order, each as its own content block.
  if (tools.size) {
    for (const t of tools.values()) {
      const args = t.args && t.args.trim() ? t.args : "{}";
      blockIndex += 1;
      open = "tool_use";
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
      open = null;
    }
  }

  // Some reasoning models return only reasoning_content.
  if (blockIndex < 0 && reasoning) sendText(reasoning);
  // Always leave at least one block so strict clients are happy.
  if (blockIndex < 0) { startBlock("text", { text: "" }); stopBlock(); }

  const hasTool = tools.size > 0;
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: mapStopReason(finish, hasTool), stop_sequence: null },
    usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens },
  });
  send("message_stop", { type: "message_stop" });
  if (!res.writableEnded) { try { res.end(); } catch {} }
  return usage;
}

// ---------------------------------------------------------------- handlers
function anthropicError(res, status, type, message) {
  if (res.destroyed) return;
  if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function errorTypeFor(status) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
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

  let payload;
  try { payload = toOpenAI(body, first.provider); } catch (e) {
    return anthropicError(res, 400, "invalid_request_error", "could not convert request: " + e.message);
  }

  log(`-> anthropic ${req.headers["user-agent"] || "?"} ${requested} stream=${payload.stream} msgs=${payload.messages.length} tools=${(payload.tools || []).length} chain=${candidates.map((c) => c.provider + ":" + c.model).join(" > ")}`);

  let up = null;
  let used = null;
  let lastErr = null;

  for (const c of candidates) {
    payload.model = c.model;
    try {
      up = await callUpstream(c.provider, payload, callSignal(clientSignal));
      if (up.status === 401) {
        keyFor(c.provider, true);
        up = await callUpstream(c.provider, payload, callSignal(clientSignal));
      }
      if (up.ok) { used = c; break; }
      lastErr = await readError(up);
      log(`upstream ${c.provider} ${lastErr.status}: ${lastErr.message.replace(/\s+/g, " ").slice(0, 160)}`);
      if (!auto && lastErr.status !== 429 && lastErr.status < 500) break;
    } catch (e) {
      lastErr = { status: 502, message: e.name === "TimeoutError" ? "upstream timeout" : e.message };
      log(`upstream ${c.provider} failed: ${lastErr.message}`);
      up = null;
    }
  }

  if (!used || !up) {
    const status = (lastErr && lastErr.status) || 502;
    return anthropicError(res, status, errorTypeFor(status), lastErr ? lastErr.message : "no provider available");
  }

  res.setHeader("x-vibe-route-model", used.provider + "/" + used.model);
  res.setHeader("x-vibe-route-auto", auto ? "1" : "0");
  res.setHeader("x-vibe-route-attempts", String(candidates.indexOf(used) + 1));

  if (payload.stream) {
    let usage = null;
    try {
      usage = await relayStream(up, res, requested);
      bumpUsage(used.provider, used.model, (usage && usage.input_tokens) || 0, (usage && usage.output_tokens) || 0);
      if (usage && usage.error) log(`<- stream error ${used.provider}:${used.model}: ${usage.error}`);
      else log(`<- stream done ${used.provider}:${used.model}`);
    } catch (e) {
      log("stream error (" + used.provider + "): " + e.message);
      if (!res.headersSent) anthropicError(res, 502, "api_error", e.message);
      else if (!res.writableEnded) res.end();
    }
    return;
  }

  let raw = "";
  try { raw = await up.text(); } catch (e) {
    return anthropicError(res, 502, "api_error", "could not read upstream response: " + e.message);
  }
  let oai;
  try {
    oai = JSON.parse(raw);
  } catch {
    return anthropicError(res, 502, "api_error", "upstream returned non-JSON: " + String(raw).replace(/\s+/g, " ").slice(0, 300));
  }
  if (oai && oai.error) {
    const em = oai.error.message || oai.error.type || "upstream error";
    return anthropicError(res, 502, "api_error", String(em));
  }
  const out = toAnthropicMessage(oai, requested);
  bumpUsage(used.provider, used.model, out.usage.input_tokens, out.usage.output_tokens);
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
    return jsonRes(res, 400, { error: { type: "invalid_request_error", message: "no models configured — add models in the app first" } });
  }
  const first = candidates[0];
  if (!cfg.providers[first.provider]) {
    return jsonRes(res, 404, { error: { type: "not_found_error", message: "unknown model " + requested } });
  }

  const payload = Object.assign({}, body);
  log(`-> openai ${req.headers["user-agent"] || "?"} ${requested} stream=${Boolean(body.stream)} chain=${candidates.map((c) => c.provider + ":" + c.model).join(" > ")}`);

  let up = null;
  let used = null;
  let lastErr = null;

  for (const c of candidates) {
    payload.model = c.model;
    try {
      up = await callUpstream(c.provider, payload, callSignal(clientSignal));
      if (up.status === 401) {
        keyFor(c.provider, true);
        up = await callUpstream(c.provider, payload, callSignal(clientSignal));
      }
      if (up.ok) { used = c; break; }
      lastErr = await readError(up);
      log(`upstream ${c.provider} ${lastErr.status}: ${lastErr.message.replace(/\s+/g, " ").slice(0, 160)}`);
      if (!auto && lastErr.status !== 429 && lastErr.status < 500) break;
    } catch (e) {
      lastErr = { status: 502, message: e.name === "TimeoutError" ? "upstream timeout" : e.message };
      log(`upstream ${c.provider} failed: ${lastErr.message}`);
      up = null;
    }
  }

  if (!used || !up) {
    const status = (lastErr && lastErr.status) || 502;
    return jsonRes(res, status, { error: { type: openaiErrorType(status), message: lastErr ? lastErr.message : "no provider available" } });
  }

  res.setHeader("x-vibe-route-model", used.provider + "/" + used.model);
  res.setHeader("x-vibe-route-auto", auto ? "1" : "0");
  res.setHeader("x-vibe-route-attempts", String(candidates.indexOf(used) + 1));

  if (payload.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (res.flushHeaders) { try { res.flushHeaders(); } catch {} }
    const decoder = new TextDecoder();
    let buf = "";
    let usage = null;
    try {
      for await (const chunk of up.body) {
        if (res.destroyed) break;
        try { res.write(chunk); } catch { break; }
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (j && j.usage) usage = j.usage;
          } catch {}
        }
      }
    } catch (e) {
      log("openai stream error (" + used.provider + "): " + e.message);
    }
    if (!res.writableEnded) { try { res.end(); } catch {} }
    bumpUsage(used.provider, used.model, (usage && usage.prompt_tokens) || 0, (usage && usage.completion_tokens) || 0);
    log(`<- stream done ${used.provider}:${used.model}`);
    return;
  }

  let raw = "";
  try { raw = await up.text(); } catch (e) {
    return jsonRes(res, 502, { error: { type: "api_error", message: "could not read upstream response: " + e.message } });
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return jsonRes(res, 502, { error: { type: "api_error", message: "upstream returned non-JSON: " + String(raw).replace(/\s+/g, " ").slice(0, 300) } });
  }
  if (j && typeof j === "object" && !Array.isArray(j)) j.model = requested;
  bumpUsage(used.provider, used.model, (j && j.usage && j.usage.prompt_tokens) || 0, (j && j.usage && j.usage.completion_tokens) || 0);
  log(`<- 200 ${used.provider}:${used.model}`);
  jsonRes(res, 200, j);
}

function estimateTokens(body) {
  let chars = 0;
  const add = (v) => { chars += String(v || "").length; };
  if (body.system) add(typeof body.system === "string" ? body.system : blocksToText(body.system));
  for (const m of body.messages || []) {
    if (typeof m.content === "string") add(m.content);
    else for (const b of m.content || []) {
      add(b.text || "");
      if (b.type === "tool_use") add(JSON.stringify(b.input || {}));
      if (b.type === "tool_result") add(typeof b.content === "string" ? b.content : blocksToText(b.content));
    }
  }
  for (const t of body.tools || []) { add(t.description); add(JSON.stringify(t.input_schema || {})); }
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
  return k.slice(0, 6) + "..." + k.slice(-4);
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
  addCors(res);
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
        const apiKey = body.apiKey || (existing ? keyFor(body.id) : "");
        const result = await testProvider({ ...body, apiKey });
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
      providers: enabledProviders().map((id) => ({
        id, label: cfg.providers[id].label, baseUrl: cfg.providers[id].baseUrl,
        keySource: cfg.providers[id].keySource,
      })),
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderDashboard({}, list));
    }
  }

  const isMessages = p === "/v1/messages" || p === "/v1/messages/count_tokens";
  const isOpenAI = p === "/v1/chat/completions" || p === "/chat/completions";

  if (req.method !== "POST" || (!isMessages && !isOpenAI)) {
    return anthropicError(res, 404, "not_found_error", "unknown path " + p);
  }

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 64 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch (e) { return anthropicError(res, 400, "invalid_request_error", "invalid JSON: " + e.message); }

    // stop the upstream call if the client goes away
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });

    if (p === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
    }

    const task = isOpenAI ? handleOpenAI(req, res, body, ac.signal) : handleMessages(req, res, body, ac.signal);
    task.catch((e) => {
      log("handler crash:", e && e.message);
      anthropicError(res, 500, "api_error", String(e && e.message || e));
    });
  });
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
