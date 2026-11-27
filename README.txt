BD Route  (one local gateway for many AI providers)
=====================================================
One local address that speaks the Anthropic Messages API and the OpenAI Chat
Completions API, in front of as many providers as you like (OpenAI, OpenRouter,
Groq, Gemini, DeepSeek, Mistral, OpenCode Go, local Ollama / LM Studio, ...).
Claude Code, Cline, Roo Code, Continue and any OpenAI-compatible app can use any
of their models. Streaming and tool calls (file read / edit / shell) work both
ways.

FILES
-----
  proxy.cjs                        the gateway
  catalog.cjs                      loads model info (context, vision, tools) from providers
  config.json                      your settings and keys (stays on your PC)
  config.openrouter.example.json   a ready OpenRouter example
  start.bat                        start with a console window
  start-hidden.vbs                 start in the background (no window)
  start-light.bat                  gateway only, dashboard opens in your browser
  set-claude-code-env.bat          points Claude Code at BD Route
  models-cache.json                model info cache (created automatically)
  vibe-route.log                   log

1) START
--------
  Install Vibe-Route-Setup-<version>.exe (recommended), or double-click
  start.bat / start-hidden.vbs.

  Dashboard:  http://127.0.0.1:8787
  It shows every provider and model with its context window and vision / tool
  support. Add, test and remove providers and models there.

2) CLAUDE CODE / CLAUDE DEV
---------------------------
  Base URL : http://127.0.0.1:8787
  API key  : any value (for example: dummy) - your real keys stay in BD Route
  Model    : any model id from the dashboard (or "auto")

  Double-click set-claude-code-env.bat once, or set it by hand:
    setx ANTHROPIC_BASE_URL   "http://127.0.0.1:8787"
    setx ANTHROPIC_AUTH_TOKEN "dummy"
    setx ANTHROPIC_MODEL      "auto"
  Then open a NEW terminal and run claude.

  OpenAI-compatible apps: base URL http://127.0.0.1:8787/v1, any API key.

3) PROVIDERS
------------
  Add them in the dashboard, or in config.json under "providers". Each needs:

    "baseUrl" : "https://openrouter.ai/api/v1"
    "apiKey"  : "YOUR-KEY"
    "enabled" : true

  Set "enabled": false to keep a provider without loading it.

  Three ways to name a model:
    a) provider/model   ->  "openrouter/anthropic/claude-sonnet-4.5"
    b) alias            ->  "claude-sonnet-4-5"  (from "aliases" in config.json)
    c) plain id         ->  "deepseek-v4.1-flash" (goes to the default provider)
    d) "auto"           ->  free models with automatic fallback

  Aliases map the names your app asks for to any provider and model:

    "aliases": {
      "claude-sonnet-4-5": "openrouter:anthropic/claude-sonnet-4.5",
      "claude-haiku-4-5":  "groq:llama-3.3-70b-versatile"
    }

4) MODEL INFO (context / vision / tools)
----------------------------------------
  Read from each provider's own /models endpoint, cached for 30 minutes:
    http://127.0.0.1:8787/v1/models
  Refresh at once:  http://127.0.0.1:8787/?refresh=1

5) NOTES
--------
  - OpenCode Go: with "keySource": "opencode-db" BD Route reads OpenCode's live
    token (read-only), so you never copy a key. Turn this off with
    "autoDetectOpencode": false; "autoSyncOpencode": false stops the model sync.
    OpenCode's free-tier models only work inside the OpenCode app.
  - Other providers: "apiKey" with "keySource": "config".
  - /v1/models lists only the models you added; set "exposeCatalogModels": true
    to list each provider's full catalog.
  - Port busy? Change "port" in config.json and the base URL in your apps.
  - The dashboard and the gateway only accept requests from this PC, and web
    pages cannot use them: requests from other websites are refused.

6) TROUBLESHOOTING
------------------
  401 / 403            : the key is wrong or expired.
  400 MissingSessionID : check the Go provider's sessionHeader.
  Nothing happens      : read the last lines of vibe-route.log.
  Empty model list     : check the provider's baseUrl / modelsPath
                         (open <baseUrl>/models in a browser).

7) START WITH WINDOWS
---------------------
  Win+R -> shell:startup -> Enter, then put a shortcut to BD Route there.
