/*
 * Model catalog for Vibe Route - multi provider.
 *
 * For every provider in config.json it pulls the real model list
 * (context window, max output, vision, tools, reasoning), normalizes the
 * different shapes (OpenRouter, OpenCode, Groq, vLLM, LM Studio, ...) and
 * caches the result in models-cache.json keyed by provider.
 */

const fs = require("node:fs");
const path = require("node:path");

const CACHE_FILE = path.join(process.env.VIBE_ROOT || __dirname, "models-cache.json");
const TTL_MS = 30 * 60 * 1000;

const memory = new Map(); // providerId -> catalog
const memoryAt = new Map();

function pickNumber(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function normalizeModel(m) {
  const id = m.id || m.model || m.name;
  if (!id) return null;
  const inputs =
    (m.modalities && m.modalities.input) ||
    (m.architecture && m.architecture.input_modalities) ||
    m.input_modalities || [];
  const vision = Array.isArray(inputs)
    ? inputs.some((x) => /image/i.test(String(x)))
    : Boolean(m.supports_vision || m.vision);
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const tools =
    Boolean(m.capabilities && m.capabilities.tools && m.capabilities.tools.supported) ||
    params.includes("tools") ||
    Boolean(m.supports_tools);
  const reasoning =
    Boolean(m.capabilities && m.capabilities.reasoning && m.capabilities.reasoning.supported) ||
    params.includes("reasoning") ||
    Boolean(m.supports_reasoning);
  // Free detection: explicit flag, a free suffix, or zero input+output price.
  // OpenRouter/Vercel use pricing.prompt|completion, Vercel uses input|output.
  const pricing = m.pricing || {};
  const priceIn = Number(pricing.prompt != null ? pricing.prompt : pricing.input);
  const priceOut = Number(pricing.completion != null ? pricing.completion : pricing.output);
  const zeroPriced = Number.isFinite(priceIn) && Number.isFinite(priceOut) && priceIn === 0 && priceOut === 0;
  const free =
    m.free === true || m.isFree === true || zeroPriced ||
    /(?:[:/_-])free$/i.test(String(id));
  return {
    id,
    name: m.name || m.display_name || id,
    context: pickNumber(
      m.limit && m.limit.context,
      m.context_length,
      m.top_provider && m.top_provider.context_length,
      m.context_window,
      m.max_context_length
    ),
    output: pickNumber(
      m.limit && m.limit.output,
      m.top_provider && m.top_provider.max_completion_tokens,
      m.max_output_tokens,
      m.max_completion_tokens
    ),
    vision,
    tools,
    reasoning,
    free,
    description: m.description || "",
    canonicalId: m.canonical_id || null,
  };
}

function readCacheFile() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {}; } catch { return {}; }
}

function readCache(pid) {
  const all = readCacheFile();
  const c = all[pid];
  if (c && Array.isArray(c.models)) return c;
  return null;
}

function writeCache(pid, data) {
  const all = readCacheFile();
  all[pid] = data;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(all, null, 2), "utf8"); } catch {}
}

async function fetchModels(pid, provider, key) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  const url = base + (provider.modelsPath || "/models");
  const headers = Object.assign({ "user-agent": provider.userAgent || "vibe-route/1.0" }, provider.headers || {});
  if (key) headers.authorization = "Bearer " + key;

  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error("models " + r.status + " from " + url);
  const json = await r.json();
  const raw = Array.isArray(json) ? json : json.data || json.models || [];
  const models = raw.map(normalizeModel).filter(Boolean);
  const data = {
    provider: pid,
    label: provider.label || pid,
    baseUrl: base,
    fetchedAt: new Date().toISOString(),
    count: models.length,
    models,
  };
  memory.set(pid, data);
  memoryAt.set(pid, Date.now());
  writeCache(pid, data);
  return data;
}

async function getCatalog(pid, provider, key, opts = {}) {
  const fresh = memory.get(pid);
  if (!opts.force && fresh && Date.now() - (memoryAt.get(pid) || 0) < TTL_MS) return fresh;
  try {
    return await fetchModels(pid, provider, key);
  } catch (e) {
    const cached = readCache(pid);
    const fallback = cached
      ? Object.assign({}, cached, { stale: true, error: e.message })
      : {
          provider: pid,
          label: provider.label || pid,
          baseUrl: provider.baseUrl,
          fetchedAt: null,
          count: 0,
          models: (provider.extraModels || []).map((id) => ({ id, name: id })),
          error: e.message,
        };
    memory.set(pid, fallback);
    memoryAt.set(pid, Date.now());
    return fallback;
  }
}

function findModel(cat, id) {
  if (!cat || !cat.models) return null;
  return cat.models.find((m) => m.id === id) || cat.models.find((m) => m.canonicalId === id) || null;
}

function getCachedCatalog(pid) {
  return readCache(pid);
}

module.exports = { getCatalog, findModel, normalizeModel, getCachedCatalog };
