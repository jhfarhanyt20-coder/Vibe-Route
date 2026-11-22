// Builds the Windows installer.
// 1. copies the gateway files into app/assets (shipped inside the exe)
// 2. runs electron-builder -> dist/Vibe-Route-Setup-<version>.exe (+ latest.yml for updates)

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP = __dirname;
const ROOT = path.resolve(APP, "..");
const ASSETS = path.join(APP, "assets");

const SHARED = [
  "proxy.cjs",
  "catalog.cjs",
  "dashboard.html",
  "providers.catalog.json",
  "README.txt",
];

fs.mkdirSync(ASSETS, { recursive: true });
for (const f of SHARED) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) {
    console.warn("missing (skipped): " + f);
    continue;
  }
  fs.copyFileSync(src, path.join(ASSETS, f));
  console.log("packed " + f);
}

// Never ship API keys inside the exe. Providers/models stay, secrets are removed.
try {
  // Your own config.json when it exists (keys removed below); otherwise the
  // key-free config.example.json from git (CI builds).
  const own = path.join(ROOT, "config.json");
  const srcCfg = fs.existsSync(own) ? own : path.join(ROOT, "config.example.json");
  if (fs.existsSync(srcCfg)) {
    const cfg = JSON.parse(fs.readFileSync(srcCfg, "utf8"));
    for (const p of Object.values(cfg.providers || {})) {
      if (p && typeof p === "object") delete p.apiKey;
    }
    fs.writeFileSync(path.join(ASSETS, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
    console.log("packed config.json (api keys stripped) from " + path.basename(srcCfg));
    if (JSON.stringify(cfg).includes("apiKey")) throw new Error("an apiKey is still in the packed config");
  }
} catch (e) {
  console.warn("could not pack config.json: " + e.message);
}

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

console.log("\nbuilding the installer…\n");
// Extra options go to electron-builder (CI passes --publish never).
const res = spawnSync(npx, ["electron-builder", "--win", "--x64", ...process.argv.slice(2)], {
  cwd: APP,
  stdio: "inherit",
  shell: isWin,
});

if (res.status !== 0) {
  console.error("\nbuild failed (exit " + res.status + ")");
  process.exit(res.status || 1);
}

const out = path.resolve(APP, "..", "dist");
console.log("\nbuild done. look in: " + out);
try {
  for (const f of fs.readdirSync(out)) {
    if (f.endsWith(".exe")) {
      const p = path.join(out, f);
      console.log("  " + f + "  (" + Math.round(fs.statSync(p).size / 1024 / 1024) + " MB)");
    }
  }
} catch {}
