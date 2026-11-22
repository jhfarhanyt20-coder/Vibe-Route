// Safety check before every release (and in CI): every file that would go into
// git or the installer is scanned for API keys and tokens, config files must not
// carry an apiKey, and the JavaScript must parse. Any finding stops the release.
"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const ROOT = path.resolve(__dirname, "..")
const SECRET = [
  /sk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{24,}/,
  /gsk_[A-Za-z0-9]{24,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /xox[abpr]-[A-Za-z0-9-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"(?:apiKey|api_key|token|secret)"\s*:\s*"(?!sk-or-v1-\.\.\.|dummy|sk-or-v1-x+)[^"]{16,}"/i,
]
const SKIP = new Set(["node_modules", "dist", ".git", "assets"])
const TEXT = /\.(c?js|mjs|json|html|txt|md|bat|vbs|ya?ml|cmd|ps1)$/i
const problems = []

function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue
    const full = path.join(dir, d.name)
    if (d.isDirectory()) { walk(full); continue }
    if (!TEXT.test(d.name)) continue
    const rel = path.relative(ROOT, full).split(path.sep).join("/")
    if (rel === "config.json") continue // your own settings: ignored by git, stripped at build
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/)
    lines.forEach((line, i) => {
      // An obvious example value (YOUR-KEY, xxxx, ..., <key>) is not a secret.
      if (/YOUR|PASTE|REPLACE|EXAMPLE|x{6,}|\.\.\.|<[^>]*>/i.test(line)) return
      for (const re of SECRET) if (re.test(line)) problems.push(`${rel}:${i + 1} looks like a key or token (${re.source.slice(0, 24)}…)`)
    })
    if (/\.c?js$/.test(d.name)) {
      try { execFileSync(process.execPath, ["--check", full], { stdio: "pipe" }) } catch (e) { problems.push(`${rel}: JavaScript does not parse: ${String(e.stderr || e.message).split("\n")[0]}`) }
    }
  }
}
walk(ROOT)

for (const f of ["config.example.json"]) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"))
  for (const [id, p] of Object.entries(cfg.providers || {})) if (p && p.apiKey) problems.push(`${f}: provider "${id}" has an apiKey`)
}

if (problems.length) {
  console.error("SAFETY CHECK FAILED — nothing may be released:\n  " + problems.join("\n  "))
  process.exit(1)
}
console.log("Safety check passed: no keys or tokens, config has no apiKey, all JavaScript parses.")
