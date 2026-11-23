// Security checks for the gateway: web pages and DNS-rebinding pages are
// refused, the dashboard API needs the page's token, saved keys never travel to
// another address, and upstream errors never echo a key. Runs the real
// proxy.cjs with a throwaway VIBE_ROOT and FAKE keys against a fake upstream.
"use strict"
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { spawn } = require("node:child_process")

const PROXY = path.join(__dirname, "..", "proxy.cjs")
const FAKE_KEY = "sk-test-EXAMPLE-000000000000000000000000000" // a fake key for this test only
const seen = [] // what the fake upstream received: { path, auth }

function freePort() {
  return new Promise((resolve) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)) }) })
}

function upstream(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""
      req.on("data", (d) => (b += d))
      req.on("end", () => {
        seen.push({ path: req.url, auth: req.headers.authorization || "" })
        if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "m1" }] })) }
        if (req.url.includes("/leak/")) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid key Bearer " + FAKE_KEY + " for this account" } })) }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
      })
    })
    srv.listen(port, "127.0.0.1", () => resolve(srv))
  })
}

function req(port, { method = "GET", path: p = "/", headers = {}, body = null, host = null }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: Object.assign({ host: host || `127.0.0.1:${port}` }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers) }, (res) => {
      let t = ""
      res.on("data", (d) => (t += d))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: t }))
    })
    r.on("error", reject)
    if (data) r.write(data)
    r.end()
  })
}

;(async () => {
  const upPort = await freePort()
  const pxPort = await freePort()
  const up = await upstream(upPort)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vr-sec-test-"))
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: pxPort, autoDetectOpencode: false, autoFreeOnStart: false, defaultProvider: "paid", defaultModel: "m1",
    providers: {
      paid: { label: "Paid", baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: FAKE_KEY, keySource: "config", enabled: true, models: ["m1"] },
      leaky: { label: "Leaky", baseUrl: `http://127.0.0.1:${upPort}/leak/v1`, apiKey: FAKE_KEY, keySource: "config", enabled: true, models: ["m2"] },
    },
  }, null, 2))
  fs.copyFileSync(path.join(__dirname, "..", "dashboard.html"), path.join(root, "dashboard.html"))
  const child = spawn(process.execPath, [PROXY], { env: Object.assign({}, process.env, { VIBE_ROOT: root, PORT: String(pxPort) }), stdio: ["ignore", "pipe", "pipe"] })
  let ok = false
  for (let i = 0; i < 100 && !ok; i++) { try { ok = (await req(pxPort, { path: "/health" })).status === 200 } catch { await new Promise((r) => setTimeout(r, 100)) } }
  const evil = { origin: "https://evil.example" }
  let failed = 0
  const check = async (name, fn) => { try { await fn(); console.log("  ok  " + name) } catch (e) { failed++; console.log("  FAIL " + name + ": " + e.message) } }
  try {
    assert.ok(ok, "gateway started")
    const page = await req(pxPort, { path: "/" })
    const token = (/<meta name="vibe-route-token" content="([0-9a-f]+)">/.exec(page.text) || [])[1]

    await check("the dashboard page carries a token and is not cached", () => {
      assert.ok(token && token.length === 48)
      assert.equal(page.headers["cache-control"], "no-store")
    })
    await check("no CORS header is ever sent", async () => {
      for (const r of [page, await req(pxPort, { path: "/v1/models" }), await req(pxPort, { path: "/health" })]) assert.equal(r.headers["access-control-allow-origin"], undefined)
    })
    await check("a web page cannot steal a key through /api/providers/test (even with the token)", async () => {
      const before = seen.length
      const r1 = await req(pxPort, { method: "POST", path: "/api/providers/test", headers: { ...evil, "content-type": "text/plain" }, body: JSON.stringify({ id: "paid", baseUrl: "http://attacker.invalid" }) })
      assert.equal(r1.status, 403)
      const r2 = await req(pxPort, { method: "POST", path: "/api/providers/test", headers: { ...evil, "x-vibe-route-token": token }, body: { id: "paid", baseUrl: `http://127.0.0.1:${upPort}/attacker` } })
      assert.equal(r2.status, 403)
      assert.equal(seen.length, before, "the upstream never saw a request")
    })
    await check("the dashboard API needs the token", async () => {
      assert.equal((await req(pxPort, { path: "/api/state" })).status, 403)
      assert.equal((await req(pxPort, { path: "/api/state", headers: { "x-vibe-route-token": "0".repeat(48) } })).status, 403)
      const r = await req(pxPort, { path: "/api/state", headers: { "x-vibe-route-token": token } })
      assert.equal(r.status, 200)
      assert.ok(!r.text.includes(FAKE_KEY.slice(0, 12)), "no key prefix is shown")
      assert.match(r.text, /••••0000/, "only the last 4 characters")
    })
    await check("the dashboard itself (same origin + token) still works", async () => {
      const r = await req(pxPort, { method: "POST", path: "/api/default", headers: { origin: `http://127.0.0.1:${pxPort}`, "x-vibe-route-token": token }, body: { provider: "paid", model: "m1" } })
      assert.equal(r.status, 200)
    })
    await check("DNS rebinding (a foreign Host) is refused", async () => {
      assert.equal((await req(pxPort, { path: "/", host: "rebind.evil.example" })).status, 403)
      assert.equal((await req(pxPort, { method: "POST", path: "/v1/messages", host: `evil.example:${pxPort}`, body: { model: "m1", max_tokens: 10, messages: [{ role: "user", content: "hi" }] } })).status, 403)
    })
    await check("a web page cannot spend the keys through /v1", async () => {
      const before = seen.length
      assert.equal((await req(pxPort, { method: "POST", path: "/v1/chat/completions", headers: { ...evil, "content-type": "text/plain" }, body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }) })).status, 403)
      assert.equal((await req(pxPort, { method: "POST", path: "/v1/messages", headers: { "sec-fetch-site": "cross-site" }, body: { model: "m1", max_tokens: 10, messages: [{ role: "user", content: "hi" }] } })).status, 403)
      assert.equal((await req(pxPort, { method: "OPTIONS", path: "/v1/messages", headers: evil })).status, 403)
      assert.equal(seen.length, before)
    })
    await check("Claude Code / SDK clients (no Origin, dummy key) keep working", async () => {
      const r = await req(pxPort, { method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer dummy" }, body: { model: "m1", messages: [{ role: "user", content: "hi" }] } })
      assert.equal(r.status, 200)
      assert.equal(seen.at(-1).auth, "Bearer " + FAKE_KEY, "the real key is used upstream")
    })
    await check("testing a saved provider against another address does not send its key", async () => {
      const r = await req(pxPort, { method: "POST", path: "/api/providers/test", headers: { "x-vibe-route-token": token }, body: { id: "paid", baseUrl: `http://127.0.0.1:${upPort}/other` } })
      assert.equal(r.status, 200)
      assert.equal(seen.at(-1).path, "/other/models")
      assert.equal(seen.at(-1).auth, "", "no key went to the other address")
      await req(pxPort, { method: "POST", path: "/api/providers/test", headers: { "x-vibe-route-token": token }, body: { id: "paid" } })
      assert.equal(seen.at(-1).auth, "Bearer " + FAKE_KEY, "the saved address still gets its key")
    })
    await check("moving a provider to another address drops its saved key", async () => {
      const r = await req(pxPort, { method: "POST", path: "/api/providers", headers: { "x-vibe-route-token": token }, body: { id: "paid", baseUrl: `http://127.0.0.1:${upPort}/moved/v1` } })
      assert.equal(r.status, 200)
      assert.equal(JSON.parse(r.text).hasKey, false)
      const saved = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).providers.paid
      assert.equal(saved.apiKey, undefined)
    })
    await check("an upstream error that echoes the key is cleaned before the client sees it", async () => {
      const r = await req(pxPort, { method: "POST", path: "/v1/chat/completions", body: { model: "leaky/m2", messages: [{ role: "user", content: "hi" }] } })
      assert.ok(!r.text.includes(FAKE_KEY), r.text.slice(0, 200))
    })
    await check("/health shows no addresses or key sources", async () => {
      const r = await req(pxPort, { path: "/health" })
      assert.ok(!/baseUrl|keySource|127\.0\.0\.1:/.test(r.text))
    })
  } finally {
    child.kill()
    up.close()
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
  if (failed) { console.log(`security checks: ${failed} FAILED`); process.exit(1) }
  console.log("security checks: all passed")
})().catch((e) => { console.error(e); process.exit(1) })
