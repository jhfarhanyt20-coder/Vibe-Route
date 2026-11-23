// Gateway tests: starts proxy.cjs against a fake OpenAI-compatible upstream
// with a throwaway VIBE_ROOT, talks to it as an Anthropic client and as an
// OpenAI client, and checks the translation, streaming, retries and fallbacks.
// Plain node, no dependencies, no real providers. Exit code 1 on any failure.
"use strict"
const http = require("node:http")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")

const PROXY = path.resolve(__dirname, "..", "proxy.cjs")

// ------------------------------------------------------------ fake upstream
const calls = [] // { pid, model, body }
const ch = (delta, finish = null, extra = {}) =>
  Object.assign({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] }, extra)
const usageChunk = (u) => ({ id: "c1", choices: [], usage: u })

function sse(res, events, opts = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  let i = 0
  const tick = () => {
    if (res.destroyed) return
    if (i < events.length) {
      const e = events[i++]
      if (e && e.pause) return setTimeout(tick, e.pause)
      res.write("data: " + JSON.stringify(e) + "\n\n")
      return setTimeout(tick, opts.delay || 2)
    }
    if (opts.hangAtEnd) return
    if (!opts.trunc) res.write("data: [DONE]\n\n")
    res.end()
  }
  tick()
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(obj))
}

function answer(model, text, extra = {}) {
  return Object.assign({
    id: "chatcmpl-1",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } },
  }, extra)
}

function fakeHandler(req, res) {
  let b = ""
  req.on("data", (c) => { b += c })
  req.on("end", () => {
    const pid = req.url.split("/")[1]
    if (req.url.endsWith("/models")) return json(res, 200, { data: [] })
    let j = {}
    try { j = JSON.parse(b) } catch {}
    const m = j.model || ""
    calls.push({ pid, model: m, body: j })
    const s = Boolean(j.stream)
    switch (m) {
      case "hang": return // never answers
      case "e400": return json(res, 400, { error: { message: "bad request: nope" } })
      case "e401": return json(res, 401, { error: { message: "invalid api key" } })
      case "e404": return json(res, 404, { error: { message: "model not found" } })
      case "strict":
        if (j.max_tokens > 8192) return json(res, 400, { error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]" } })
        break
      case "nocache":
        if (b.includes("cache_control")) return json(res, 400, { error: { message: "Invalid request: extra inputs are not permitted" } })
        break
      case "noso":
        if (j.stream_options) return json(res, 400, { error: { message: "Unrecognized request argument supplied: stream_options" } })
        break
      case "noreason":
        if (j.reasoning_effort) return json(res, 400, { error: { message: "reasoning_effort is not supported with this model" } })
        break
    }
    if (!s) {
      if (m === "err200rate") return json(res, 200, { error: { message: "Rate limit exceeded, retry later", code: 429 } })
      if (m === "err200bad") return json(res, 200, { error: { message: "Invalid parameter: foo", type: "invalid_request_error" } })
      if (m === "stopseq") return json(res, 200, answer(m, "done", { choices: [{ index: 0, finish_reason: "stop", stop_reason: "END", message: { role: "assistant", content: "done" } }] }))
      if (m === "filter") return json(res, 200, answer(m, "", { choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: "" } }] }))
      if (m === "reason") return json(res, 200, answer(m, "answer", { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer", reasoning_content: "deep thought" } }] }))
      return json(res, 200, answer(m, "ok " + pid + " " + m))
    }
    const end = [ch({}, "stop"), usageChunk({ prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } })]
    switch (m) {
      case "frag": {
        const f1 = ['{"n":', "1", "0", "0", "}"]
        const f2 = ['{"a":{"b":', '{"c":[1,1', "]", "}", "}", "}"]
        return sse(res, [
          ch({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "T", arguments: "" } }] }),
          ...f1.map((f) => ch({ tool_calls: [{ index: 0, function: { arguments: f } }] })),
          ch({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "U", arguments: "" } }] }),
          ...f2.map((f) => ch({ tool_calls: [{ index: 1, function: { arguments: f } }] })),
          ch({}, "tool_calls"),
        ])
      }
      case "noindex":
        return sse(res, [
          ch({ tool_calls: [{ id: "call_x", type: "function", function: { name: "A", arguments: '{"p":' } }] }),
          ch({ tool_calls: [{ function: { arguments: "1}" } }] }),
          ch({ tool_calls: [{ id: "call_y", type: "function", function: { name: "B", arguments: '{"q":2}' } }] }),
          ch({}, "tool_calls"),
        ])
      case "sameindex":
        return sse(res, [
          ch({ tool_calls: [{ index: 0, id: "call_s1", type: "function", function: { name: "A", arguments: '{"p":1}' } }] }),
          ch({ tool_calls: [{ index: 0, id: "call_s2", type: "function", function: { name: "B", arguments: '{"q":2}' } }] }),
          ch({}, "tool_calls"),
        ])
      case "trunc": return sse(res, [ch({ content: "partial" })], { trunc: true })
      case "stall": return sse(res, [ch({ content: "start" })], { hangAtEnd: true })
      case "err200rate": return sse(res, [{ error: { message: "Rate limit exceeded", code: 429 } }])
      case "err200bad": return sse(res, [{ error: { message: "Invalid parameter: foo", type: "invalid_request_error" } }])
      case "reason":
        return sse(res, [ch({ reasoning_content: "let me " }), ch({ reasoning_content: "think" }), ch({ content: "answer" }), ...end])
      case "slowalive": {
        const ev = []
        for (let i = 0; i < 5; i++) { ev.push(ch({ content: "x" + i })); ev.push({ pause: 700 }) }
        return sse(res, [...ev, ...end])
      }
      default:
        return sse(res, [ch({ role: "assistant", content: "hel" }), ch({ content: "lo" }), ...end])
    }
  })
}

// ---------------------------------------------------------------- helpers
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

let BASE = ""
async function post(p, body, opts = {}) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch {}
  return { status: r.status, headers: r.headers, text, json: j, ms: opts.t0 ? Date.now() - opts.t0 : 0 }
}
function events(text) {
  return text.split("\n\n").filter((x) => x.trim()).map((x) => {
    const e = /^event: (.*)$/m.exec(x)
    const d = /^data: (.*)$/m.exec(x)
    let data = null
    try { data = d && JSON.parse(d[1]) } catch {}
    return { event: e && e[1], data }
  })
}
function msg(model, extra = {}) {
  return Object.assign({ model, max_tokens: 1000, messages: [{ role: "user", content: "hi" }] }, extra)
}
const callsFor = (model) => calls.filter((c) => c.model === model)
const lastCall = (model) => { const l = callsFor(model); return l[l.length - 1] }
const toolInputs = (evs) => {
  const out = []
  let cur = null
  for (const e of evs) {
    if (e.event === "content_block_start" && e.data.content_block.type === "tool_use") cur = { id: e.data.content_block.id, name: e.data.content_block.name, json: "" }
    if (e.event === "content_block_delta" && e.data.delta.type === "input_json_delta" && cur) cur.json += e.data.delta.partial_json
    if (e.event === "content_block_stop" && cur) { out.push(cur); cur = null }
  }
  return out
}

const results = []
function check(name, cond, info) {
  results.push({ name, ok: Boolean(cond) })
  console.log((cond ? "PASS " : "FAIL ") + name + (cond || info === undefined ? "" : "  -> " + (typeof info === "string" ? info : JSON.stringify(info)).slice(0, 400)))
}

// ------------------------------------------------------------------- tests
async function run() {
  const evsOf = async (body) => { const r = await post("/v1/messages", Object.assign({ stream: true }, body)); return Object.assign(r, { evs: events(r.text) }) }

  // 1 tool argument fragments
  {
    const r = await evsOf(msg("frag"))
    const t = toolInputs(r.evs)
    check("fragments {\"n\": 1 0 0 } give {\"n\":100}", t[0] && t[0].json === '{"n":100}', t)
    let nested = null
    try { nested = JSON.stringify(JSON.parse(t[1].json)) } catch {}
    check("nested JSON fragments stay intact", nested === '{"a":{"b":{"c":[1,1]}}}', t)
  }

  // 2 count_tokens on bad input, process keeps serving
  {
    const bad1 = await post("/v1/messages/count_tokens", { model: "m1", messages: [{ role: "user", content: [null] }] })
    const bad2 = await post("/v1/messages/count_tokens", "null")
    const bad3 = await post("/v1/messages/count_tokens", { messages: [{ role: "user", content: { text: "x" } }] })
    const good = await post("/v1/messages/count_tokens", { messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }] })
    check("count_tokens content:[null] -> 400 Anthropic error", bad1.status === 400 && bad1.json && bad1.json.type === "error", bad1.text)
    check("count_tokens body null -> 400", bad2.status === 400, bad2.text)
    check("count_tokens content object -> 400", bad3.status === 400, bad3.text)
    check("count_tokens valid -> 200", good.status === 200 && good.json.input_tokens > 0, good.text)
    const h = await fetch(BASE + "/health")
    check("gateway still answers /health", h.status === 200)
  }

  // 3 max_tokens clamp and retry
  {
    const r = await post("/v1/messages", msg("strict", { max_tokens: 32000 }))
    const c = callsFor("strict")
    check("max_tokens 400 -> retried with 8192", r.status === 200 && c.length === 2 && c[1].body.max_tokens === 8192, { status: r.status, sent: c.map((x) => x.body.max_tokens) })
    await post("/v1/messages", msg("strict", { max_tokens: 32000 }))
    const c2 = callsFor("strict")
    check("learned max_tokens is reused (no failing first call)", c2.length === 3 && c2[2].body.max_tokens === 8192, c2.map((x) => x.body.max_tokens))
    await post("/v1/messages", msg("capped", { max_tokens: 64000 }))
    check("max_tokens clamped to provider maxTokens", lastCall("capped").body.max_tokens === 4096, lastCall("capped").body.max_tokens)
    const o = await post("/v1/chat/completions", { model: "strict", max_tokens: 50000, messages: [{ role: "user", content: "x" }] })
    check("OpenAI path max_tokens clamped from learned limit", o.status === 200 && lastCall("strict").body.max_tokens === 8192, o.status)
  }

  // 4 truncated stream
  {
    const r = await evsOf(msg("trunc"))
    const names = r.evs.map((e) => e.event)
    const err = r.evs.find((e) => e.event === "error")
    check("truncated stream -> error event, no end_turn", err && /ended early/.test(err.data.error.message) && !names.includes("message_stop"), names)
    const n = await evsOf(msg("m1"))
    const order = n.evs.map((e) => e.event).filter((e) => e !== "ping")
    check("normal stream keeps event order", JSON.stringify(order) === JSON.stringify(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]), order)
    const o = await post("/v1/chat/completions", { model: "trunc", stream: true, messages: [{ role: "user", content: "x" }] })
    check("OpenAI truncated stream -> error chunk", /"error":\{"message":"upstream stream ended early"/.test(o.text), o.text)
  }

  // 5 parallel tool calls without index / same index
  {
    const r = await evsOf(msg("noindex"))
    const t = toolInputs(r.evs)
    check("two index-less tool calls stay separate", t.length === 2 && t[0].id === "call_x" && t[0].json === '{"p":1}' && t[1].id === "call_y" && t[1].json === '{"q":2}', t)
    const s = toolInputs((await evsOf(msg("sameindex"))).evs)
    check("two calls on the same index with new ids stay separate", s.length === 2 && s[0].json === '{"p":1}' && s[1].json === '{"q":2}', s)
  }

  // 6 errors inside a 200 answer
  {
    const a = await post("/v1/messages", msg("err200rate"))
    check("Anthropic non-stream 200 {error: rate limit} -> fallback", a.status === 200 && a.headers.get("x-vibe-route-model") === "pb/fb", a.text)
    const b = await post("/v1/messages", msg("err200rate", { stream: true }))
    check("Anthropic stream first event error -> fallback", b.status === 200 && b.headers.get("x-vibe-route-model") === "pb/fb" && /message_stop/.test(b.text), b.text)
    const c = await post("/v1/chat/completions", { model: "err200bad", messages: [{ role: "user", content: "x" }] })
    check("OpenAI non-stream 200 {error: invalid} -> 400 OpenAI error", c.status === 400 && c.json && c.json.error && c.json.error.message && !c.json.type, c.text)
    const d = await post("/v1/chat/completions", { model: "err200bad", stream: true, messages: [{ role: "user", content: "x" }] })
    check("OpenAI stream first event error -> 400 OpenAI error", d.status === 400 && d.json && d.json.error && /Invalid parameter/.test(d.json.error.message), d.status + " " + d.text)
    const e = await post("/v1/chat/completions", { model: "err200rate", messages: [{ role: "user", content: "x" }] })
    check("OpenAI 200 {error: rate limit} -> fallback", e.status === 200 && e.headers.get("x-vibe-route-model") === "pb/fb", e.text)
  }

  // 7a system blocks joined with blank line
  {
    await post("/v1/messages", msg("echo", { system: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }))
    const sys = lastCall("echo").body.messages[0]
    check("system blocks joined with \\n\\n", sys.role === "system" && sys.content === "A\n\nB", sys)
  }
  // 7b cached tokens -> cache_read_input_tokens
  {
    const ns = await post("/v1/messages", msg("m1"))
    check("non-stream cached_tokens -> cache_read_input_tokens, input = prompt - cached",
      ns.json && ns.json.usage.cache_read_input_tokens === 80 && ns.json.usage.input_tokens === 20, ns.json && ns.json.usage)
    const st = await evsOf(msg("m1"))
    const md = st.evs.find((e) => e.event === "message_delta")
    check("stream cached_tokens -> message_delta usage", md && md.data.usage.cache_read_input_tokens === 8 && md.data.usage.input_tokens === 4, md && md.data.usage)
  }
  // 7c cache_control forwarded, no-marks retry, remembered
  {
    const body = msg("echo", {
      system: [{ type: "text", text: "S1", cache_control: { type: "ephemeral" } }, { type: "text", text: "S2" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "u1", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file", cache_control: { type: "ephemeral" } }] },
      ],
    })
    await post("/v1/messages", body)
    const sent = lastCall("echo").body.messages
    check("system sent as parts with cache_control", Array.isArray(sent[0].content) && sent[0].content[0].cache_control && sent[0].content[0].text === "S1" && !sent[0].content[1].cache_control, sent[0])
    check("user text part keeps cache_control", Array.isArray(sent[1].content) && sent[1].content[0].cache_control && sent[1].content[0].text === "u1", sent[1])
    check("tool result keeps cache_control", sent[3].role === "tool" && Array.isArray(sent[3].content) && sent[3].content[0].cache_control, sent[3])
    const before = callsFor("nocache").length
    const r1 = await post("/v1/messages", Object.assign({}, body, { model: "nocache" }))
    const c1 = callsFor("nocache").slice(before)
    check("upstream 400 on marks -> retried without cache_control", r1.status === 200 && c1.length === 2 && !JSON.stringify(c1[1].body).includes("cache_control"), { status: r1.status, n: c1.length })
    const r2 = await post("/v1/messages", Object.assign({}, body, { model: "nocache" }))
    const c2 = callsFor("nocache").slice(before + 2)
    check("no-marks choice remembered for that upstream", r2.status === 200 && c2.length === 1 && !JSON.stringify(c2[0].body).includes("cache_control"), { status: r2.status, n: c2.length })
    const sysTwice = callsFor("echo").slice(-1)[0].body.messages[0]
    await post("/v1/messages", body)
    check("request prefix is stable between calls", JSON.stringify(lastCall("echo").body.messages[0]) === JSON.stringify(sysTwice))
  }

  // 8 tool_result image and is_error
  {
    await post("/v1/messages", msg("echo", {
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "Shot", input: {} }, { type: "tool_use", id: "toolu_b", name: "Bash", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "screen" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
          { type: "tool_result", tool_use_id: "toolu_b", is_error: true, content: "ENOENT" },
        ] },
      ],
    }))
    const m = lastCall("echo").body.messages
    const tools = m.filter((x) => x.role === "tool")
    const after = m[m.length - 1]
    check("is_error tool result prefixed with Error:", tools[1] && tools[1].content === "Error: ENOENT", tools)
    check("tool_result image sent in a user message after the tool messages",
      after.role === "user" && Array.isArray(after.content) && after.content.some((p) => p.type === "image_url" && p.image_url.url === "data:image/png;base64,QUJD") &&
      m.indexOf(after) > m.indexOf(tools[1]), after)
  }

  // 9 unknown claude-* model -> default model
  {
    const r = await post("/v1/messages", msg("claude-haiku-4-5"))
    check("unknown claude-* routed to the default model", r.status === 200 && r.headers.get("x-vibe-route-model") === "pa/m1" && lastCall("m1"), r.headers.get("x-vibe-route-model"))
  }

  // 10 timeouts
  {
    const t0 = Date.now()
    const r = await post("/v1/messages", msg("hang", { stream: true }))
    const ms = Date.now() - t0
    check("first-byte timeout falls back", r.status === 200 && r.headers.get("x-vibe-route-model") === "pb/fb" && ms < 5000, { status: r.status, ms, model: r.headers.get("x-vibe-route-model") })
    const s = await evsOf(msg("slowalive"))
    const texts = s.evs.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("")
    check("slow but alive stream (gaps > first-byte timeout) is not cut", texts === "x0x1x2x3x4" && s.evs.some((e) => e.event === "message_stop"), texts)
    check("ping events sent while the upstream is quiet", s.evs.some((e) => e.event === "ping"))
    const st = await evsOf(msg("stall"))
    const err = st.evs.find((e) => e.event === "error")
    check("idle timeout ends a stalled stream with an error event", err && /no data/.test(err.data.error.message), st.evs.map((e) => e.event))
  }

  // 11 thinking
  {
    const r = await evsOf(msg("reason", { thinking: { type: "enabled", budget_tokens: 20000 } }))
    const kinds = r.evs.filter((e) => e.event === "content_block_start").map((e) => e.data.content_block.type)
    const thinking = r.evs.filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta").map((e) => e.data.delta.thinking).join("")
    check("reasoning streamed as thinking block before text", kinds[0] === "thinking" && kinds[1] === "text" && thinking === "let me think", { kinds, thinking })
    check("thinking budget -> reasoning_effort", lastCall("reason").body.reasoning_effort === "high", lastCall("reason").body.reasoning_effort)
    await post("/v1/messages", msg("reason", { messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "earlier thought", signature: "" }, { type: "text", text: "a" }] },
      { role: "user", content: "q2" },
    ] }))
    const asst = lastCall("reason").body.messages.find((x) => x.role === "assistant")
    check("assistant thinking sent back as reasoning_content", asst && asst.reasoning_content === "earlier thought", asst)
    const ns = await post("/v1/messages", msg("reason"))
    check("non-stream reasoning -> thinking block", ns.json && ns.json.content[0].type === "thinking" && ns.json.content[0].thinking === "deep thought" && ns.json.content[1].text === "answer", ns.json && ns.json.content)
    const nr = await post("/v1/messages", msg("noreason", { thinking: { type: "enabled", budget_tokens: 2000 } }))
    const c = callsFor("noreason")
    check("upstream 400 on reasoning_effort -> retried without", nr.status === 200 && c.length === 2 && !("reasoning_effort" in c[1].body), { status: nr.status, n: c.length })
  }

  // 12 small items
  {
    await post("/v1/messages", msg("echo", { tools: [{ name: "Read", input_schema: { type: "object" } }], tool_choice: { type: "auto", disable_parallel_tool_use: true } }))
    check("disable_parallel_tool_use -> parallel_tool_calls:false", lastCall("echo").body.parallel_tool_calls === false)
    const sq = await post("/v1/messages", msg("stopseq", { stop_sequences: ["END"] }))
    check("matched stop sequence reported", sq.json && sq.json.stop_reason === "stop_sequence" && sq.json.stop_sequence === "END", sq.json && [sq.json.stop_reason, sq.json.stop_sequence])
    const cf = await post("/v1/messages", msg("filter"))
    check("content_filter -> refusal", cf.json && cf.json.stop_reason === "refusal", cf.json && cf.json.stop_reason)
    const so = await post("/v1/messages", msg("noso", { stream: true }))
    const sc = callsFor("noso")
    check("upstream 400 on stream_options -> retried without", so.status === 200 && /message_stop/.test(so.text) && sc.length === 2 && !sc[1].body.stream_options, { status: so.status, n: sc.length })
    const a401 = await post("/v1/messages", msg("e401"))
    check("401 retried once with a fresh key, then fallback", a401.status === 200 && a401.headers.get("x-vibe-route-model") === "pb/fb" && callsFor("e401").length === 2, { status: a401.status, n: callsFor("e401").length })
    const a404 = await post("/v1/messages", msg("e404"))
    check("404 on the primary -> configured fallback", a404.status === 200 && a404.headers.get("x-vibe-route-model") === "pb/fb", a404.status)
    const a400 = await post("/v1/messages", msg("e400"))
    check("plain 400 is returned (no fallback)", a400.status === 400 && a400.json && a400.json.type === "error", a400.status)
    const o404 = await post("/v1/chat/unknown", { model: "m1" })
    check("OpenAI-style unknown path -> OpenAI-format 404", o404.status === 404 && o404.json && o404.json.error && !o404.json.type, o404.text)
    const oBad = await post("/v1/chat/completions", "{nope")
    check("OpenAI invalid JSON -> OpenAI-format 400", oBad.status === 400 && oBad.json && oBad.json.error && !oBad.json.type, oBad.text)
    const p1 = await post("/v1/messages", msg("openai/gpt-4o"))
    check("exact model id with a provider-like prefix stays whole", p1.status === 200 && lastCall("openai/gpt-4o") && lastCall("openai/gpt-4o").pid === "openai", p1.headers.get("x-vibe-route-model"))
    const p2 = await post("/v1/messages", msg("openai/other-model"))
    check("provider prefix still splits when no exact id exists", p2.status === 200 && lastCall("other-model") && lastCall("other-model").pid === "openai", p2.headers.get("x-vibe-route-model"))
  }

  // 413 on a huge body
  {
    const big = JSON.stringify({ model: "m1", max_tokens: 10, messages: [{ role: "user", content: "x".repeat(65 * 1024 * 1024) }] })
    let r = null
    try { r = await post("/v1/messages", big) } catch (e) { r = { status: 0, text: String(e && e.message) } }
    check("body over 64 MB -> 413 JSON error", r.status === 413 && r.json && r.json.error && r.json.error.type === "request_too_large", r.status + " " + String(r.text).slice(0, 200))
    const h = await fetch(BASE + "/health")
    check("gateway still answers after 413", h.status === 200)
  }
}

// -------------------------------------------------------------------- main
async function main() {
  const upPort = await freePort()
  const pxPort = await freePort()
  const fake = http.createServer(fakeHandler)
  await new Promise((r) => fake.listen(upPort, "127.0.0.1", r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-route-test-"))
  const up = (pid) => `http://127.0.0.1:${upPort}/${pid}/v1`
  const config = {
    port: pxPort,
    defaultProvider: "pa",
    defaultModel: "m1",
    autoDetectOpencode: false,
    autoFreeOnStart: false,
    autoSyncOpencode: false,
    firstByteTimeoutMs: 600,
    nonStreamTimeoutMs: 600,
    idleTimeoutMs: 1000,
    pingIntervalMs: 200,
    providers: {
      pa: { label: "A", baseUrl: up("pa"), apiKey: "test-a", models: ["m1", "echo", "frag", "noindex", "sameindex", "trunc", "stall", "err200rate", "err200bad", "reason", "slowalive", "hang", "strict", "nocache", "noso", "noreason", "stopseq", "filter", "e400", "e401", "e404"] },
      pb: { label: "B", baseUrl: up("pb"), apiKey: "test-b", models: ["fb"] },
      pc: { label: "C", baseUrl: up("pc"), apiKey: "test-c", maxTokens: 4096, models: ["capped"] },
      openai: { label: "O", baseUrl: up("openai"), apiKey: "test-o", models: ["openai/gpt-4o"] },
    },
    aliases: {},
    fallbacks: ["pb:fb"],
  }
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config, null, 2))
  const env = Object.assign({}, process.env, { VIBE_ROOT: root, PORT: String(pxPort) })
  const child = spawn(process.execPath, [PROXY], { env, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (c) => { out += c })
  child.stderr.on("data", (c) => { out += c })
  BASE = `http://127.0.0.1:${pxPort}`
  let code = 1
  try {
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(BASE + "/health")).ok } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    if (!ready) throw new Error("proxy did not start:\n" + out)
    await run()
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    if (/uncaught exception|unhandled rejection/i.test(out)) {
      console.log("FAIL proxy logged an uncaught error:\n" + out.split("\n").filter((l) => /uncaught|unhandled/i.test(l)).join("\n"))
      code = 1
    } else code = failed.length ? 1 : 0
    if (code && process.env.VIBE_TEST_VERBOSE) console.log(out)
  } catch (e) {
    console.log("FAIL " + (e && e.stack || e))
    code = 1
  } finally {
    child.kill()
    fake.close()
    if (fake.closeAllConnections) fake.closeAllConnections()
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
  process.exit(code)
}

main()
