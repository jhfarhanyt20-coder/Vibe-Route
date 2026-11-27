# BD Route

**One local gateway for all your AI providers.** BD Route runs on your Windows PC and gives every AI app one address — `http://127.0.0.1:8787` — that speaks **both the Anthropic API and the OpenAI API**. Behind it you connect as many providers as you like (OpenAI, OpenRouter, Groq, Gemini, DeepSeek, Mistral, local Ollama / LM Studio and more) and pick any of their models from one dashboard.

The best-known use: **run Claude Code with your OpenAI key** (or any other provider). Claude Code only speaks the Anthropic format; BD Route translates it to the OpenAI format on the fly — streaming, tool calls (read / edit / bash) and all.

**[⬇ Download the latest installer](https://github.com/jhfarhanyt20-coder/BD-Route/releases/latest)** · Windows 10 / 11 (64-bit) · free · updates itself

---

## Features

- **Anthropic + OpenAI compatible in one place**
  - Anthropic Messages API: `http://127.0.0.1:8787` (`/v1/messages`, `/v1/messages/count_tokens`) — for Claude Code and Claude Dev / Cline.
  - OpenAI Chat Completions API: `http://127.0.0.1:8787/v1` (`/v1/chat/completions`, `/v1/models`) — for Cline, Roo Code, Continue and any OpenAI-compatible app.
- **Many providers at once** — models from every connected provider are merged into one list. Ready-made presets: OpenAI-compatible endpoints in general, **OpenRouter, Groq, Google Gemini, Mistral, DeepSeek, Together AI, Cerebras, NVIDIA NIM, GitHub Models, Fireworks AI, Vercel AI Gateway, Kilo Gateway, OpenCode Go**, and local **Ollama** and **LM Studio**. Any other provider works too: give it a name, base URL and key.
- **Full streaming and tool use** — answers stream live; tool calls (file read, edit, shell) are translated both ways, with token usage reported.
- **Model info loaded for you** — context window, max output, vision and tool support come from each provider's own model list, so you only type a model name. Cached for 30 minutes; refresh any time.
- **Choose a model three ways** — `provider/model` (`openai/gpt-4.1`), a plain model id (goes to your default provider), or an **alias**: map the model names your app asks for (for example `claude-sonnet-4-5`) to any provider and model you want.
- **Dashboard app** — add, test and remove providers; see every model with its context size, vision and tool support; add one model or **all models** of a provider in one click; **Test** checks the key and the models endpoint.
- **Free models load by themselves** — save a provider with its key and its free models are listed at once. Kilo Gateway's free models work even without a key.
- **OpenCode auto-detect** — if OpenCode is installed and signed in on the PC, BD Route adds it as a provider by itself and keeps its model list in sync, reading the live token from OpenCode's own files (read-only). No key to copy, and the token is never shown in the browser.
- **Long agent runs** — a 10-minute request timeout by default (`timeoutMs` in the config).
- **Runs quietly in the tray** — closing the window keeps the gateway running; the tray menu has Dashboard, Restart gateway, Open data folder, Edit config.json, **Check for updates** and Quit.
- **Updates itself** — the installed app checks GitHub Releases, downloads a new version in the background and asks you to restart. The **Settings** button (gear) in the title bar shows your version and has **Check for updates**, **Update now** and **Install & restart**, plus a switch to turn automatic downloads off (then nothing downloads until you press Update now). The same actions are in the tray menu.
- **Light mode** — `start-light.bat` runs only the gateway and opens the dashboard in your browser (no Electron window; needs Node.js).
- **Your keys stay on your PC** — they live only in your own `config.json` in the app's data folder. The installer never contains a key (the build removes them and the release is refused if one is found), and this repository contains none.

## Install

1. Download **`Vibe-Route-Setup-<version>.exe`** from [Releases](https://github.com/jhfarhanyt20-coder/BD-Route/releases/latest) and run it (Windows may ask you to confirm because the installer is not code-signed).
2. BD Route starts and opens its dashboard. Later updates arrive by themselves.

## Use Claude Code with your OpenAI key (or any provider)

1. Open the BD Route dashboard and **add a provider**:
   - name: `openai` · base URL: `https://api.openai.com/v1` · API key: your OpenAI key (`sk-…`)
   - press **Test**, then add the models you want (for example `gpt-4.1`, or **Add all models**).
2. Point Claude Code at BD Route (once, in a new terminal or with `set-claude-code-env.bat`):

   ```bat
   setx ANTHROPIC_BASE_URL   "http://127.0.0.1:8787"
   setx ANTHROPIC_AUTH_TOKEN "dummy"
   setx ANTHROPIC_MODEL      "openai/gpt-4.1"
   ```

   `dummy` is fine: Claude Code needs some token, and your real key stays in BD Route.
3. Open a **new** terminal and run `claude`. Its requests go to BD Route, which sends them to OpenAI with your key and streams the answers back in Claude's format.

Tip: add an alias so Claude Code's own model names land on your model, e.g. `"claude-sonnet-4-5": "openai:gpt-4.1"` under `"aliases"` in `config.json`.

The same works with any provider in the list — OpenRouter, Groq, Gemini, DeepSeek, a local Ollama model, and so on.

## Use it from other apps

| App | Setting |
|---|---|
| Claude Code, Claude Dev | Anthropic base URL `http://127.0.0.1:8787`, any API key (e.g. `dummy`) |
| Cline, Roo Code, Continue, other OpenAI-compatible apps | OpenAI base URL `http://127.0.0.1:8787/v1`, any API key, model `provider/model` |

## Configuration (`config.json`)

Open it from the tray (**Edit config.json**). Each provider needs a base URL, a key and `"enabled": true`:

```json
{
  "port": 8787,
  "defaultProvider": "openai",
  "providers": {
    "openai": { "label": "OpenAI", "baseUrl": "https://api.openai.com/v1", "apiKey": "YOUR-KEY", "keySource": "config", "enabled": true }
  },
  "aliases": { "claude-sonnet-4-5": "openai:gpt-4.1" }
}
```

Other options: `timeoutMs`, `firstByteTimeoutMs` / `idleTimeoutMs` (give up when a provider sends nothing at the start or stops mid-answer), `nonStreamTimeoutMs`, `allowedOrigins` (extra web origins you trust to call the gateway; empty by default), `exposeCatalogModels` (list a provider's full catalog instead of only the models you added), `autoDetectOpencode`, `autoSyncOpencode`. If port 8787 is busy, change `port` and the base URL in your apps.

## Troubleshooting

- **401 / 403** — the key is wrong or expired. (OpenCode's free-tier models only work inside the OpenCode app.)
- **Empty model list** — check the provider's base URL and models path; open `<baseUrl>/models` in a browser to test.
- **Nothing happens** — look at the last lines of `vibe-route.log` in the data folder (tray → Open data folder).
- **Start with Windows** — Win+R → `shell:startup`, and put a shortcut to BD Route there.

## Security

- Keys are stored only in your local `config.json` (in the app's data folder) and are sent only to the provider they belong to.
- The installer and this repository contain no keys; a safety check (`scripts/check.cjs`) scans every release and stops it if something looks like a key or token.
- The gateway listens on `127.0.0.1` only, so other computers cannot use it.
- Web pages cannot use it: requests sent by a browser page from another site (or a renamed host, "DNS rebinding") are refused, and no CORS headers are sent. Apps such as Claude Code, Cline or an SDK are not web pages and keep working.
- The dashboard API (`/api/*`) needs a random token that changes on every start and only the dashboard page knows, so another program or page cannot read or change your providers.
- A saved key is only ever sent to that provider's saved address. Testing a provider against a new address does not send the saved key, and moving a provider to a new address forgets its old key.
- Keys are shown only as their last 4 characters, and an upstream error that echoes a key is cleaned before it reaches your app or the log.
- The desktop window is sandboxed, cannot open other sites inside the app, and opens outside links in your normal browser.

## Build from source

```bat
cd app
npm ci
npm test            :: safety check, gateway and security tests
npm run dist        :: builds dist\Vibe-Route-Setup-<version>.exe
```

---

Made by **JH Farhan** · [VibeCoder AI](https://vibecoderai.onrender.com)

**License:** proprietary, all rights reserved — you may install and use the official app, but you may not modify, copy, rebrand or redistribute the code. See [LICENSE](LICENSE).
