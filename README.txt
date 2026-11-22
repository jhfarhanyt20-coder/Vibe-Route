Vibe Route  (multi provider)
============================
Anthropic Messages API  ->  OpenAI Chat Completions

Ki kore:
  Claude Code / Claude Dev (Cline) shudhu Anthropic format bojhe.
  Ei proxy tomar ekadhik provider (OpenCode Go, OpenRouter, Groq, local LM Studio)
  er model ek jaygay merge kore Claude ke dey. Kon model chaile, sei provider e
  request jay. Streaming + tools (file read/edit/bash) shob kaj kore.

FILE GULO
---------
  proxy.cjs                        main program
  catalog.cjs                      provider theke model info (context/vision) ane
  config.json                      ei ta tumi edit korbe
  config.openrouter.example.json   OpenRouter block er ready example
  start.bat                        normal start (console dekhabe)
  start-hidden.vbs                 background start (window nei)
  set-claude-code-env.bat          Claude Code er env set kore
  models-cache.json                auto toiri hoy (model info cache)
  vibe-route.log                   log

1) CHALU KORA
-------------
  start.bat double-click  (ba) start-hidden.vbs

  Check:  http://127.0.0.1:8787
  Dashboard e provider, shob model, context window, vision/tools support dekhabe.
  Ei page tai tomar "app" - ekhane sob kichhu dekha jay.

2) CLAUDE CODE / CLAUDE DEV
---------------------------
  Base URL : http://127.0.0.1:8787
  API key  : dummy
  Model    : deepseek-v4.1-flash        (ba table er jekono id)

  Claude Code er jonno ekbar set-claude-code-env.bat double-click koro.
  Manual:
    setx ANTHROPIC_BASE_URL   "http://127.0.0.1:8787"
    setx ANTHROPIC_AUTH_TOKEN "dummy"
    setx ANTHROPIC_MODEL      "deepseek-v4.1-flash"

3) MULTI PROVIDER (notun)
--------------------------
  config.json -> "providers" er vitore joto khushi provider rakho.
  Protita te shudhu 3 ta jinish dorkar:

    "baseUrl" : "https://openrouter.ai/api/v1"
    "apiKey"  : "sk-or-v1-..."
    "enabled" : true

  Provider na chaile "enabled": false rakho - proxy oita load korbe na.

  Model er nam Claude e kivabe dibe (3 ta style, shob cholbe):

    a) provider/model   ->  "go/deepseek-v4.1-flash"
                            "openrouter/anthropic/claude-sonnet-4.5"
    b) alias            ->  "claude-sonnet-4-5"  (config.json er "aliases" theke)
    c) plain id         ->  "deepseek-v4.1-flash" (default provider e jay)

  Alias set kora thake eivabe:

    "aliases": {
      "claude-sonnet-4-5": "go:deepseek-v4.1-flash",
      "claude-opus-4-1":   "openrouter:anthropic/claude-opus-4.1"
    }

  Mane Claude Code jodi "claude-sonnet-4-5" pathay, proxy seta je provider/model
  bole dey sekhane pathiye dey. Ek provider fail korle onno model e fallback
  korte chaile alias ta onno provider e bodle dao.

4) MODEL INFO (context / vision / tools)
----------------------------------------
  Provider er nijer /models endpoint theke proxy nijei niye ney:
  context window, max output, vision support, tool support.
  Dashboard e ar /v1/models e shob dekha jay:

    http://127.0.0.1:8787/v1/models
    http://127.0.0.1:8787/v1/models/go/deepseek-v4.1-flash

  Tai Claude e shudhu model er nam ta dilei enough - baki info load hoye jay.
  Cache 30 min thake; sathe sathe notun korte:  http://127.0.0.1:8787/?refresh=1

5) NOTE
-------
  - OpenCode Go provider e key dite hoy na: "keySource": "opencode-db" dile
    proxy OpenCode app er DB theke live token pore ney, token rotate holeo cholte thake.
  - Onno provider e "apiKey" + "keySource": "config" dao.
  - Port busy hole config.json er "port" bodlao, sathe Claude er base url o.

6) PROBLEM
----------
  401/403        : key bhul / expire.
  400 MissingSessionID : Go provider e sessionHeader ache kina dekho.
  Kichhu na ashle : vibe-route.log er shesh line gulo dekho.
  Model list khali : provider er baseUrl/modelsPath thik ache kina dekho
                     (browser e <baseUrl>/models khule test koro).

7) AUTO-START
-------------
  Win+R -> shell:startup -> Enter -> start-hidden.vbs er shortcut sekhane rakho.

8) UPDATE (bug fix)
-------------------
  - Sob provider ekta dropdown e. Saved provider select korle tar sob model
    (free + manual) sathe sathe "Selected provider models" list e dekha jay.
  - Provider save korar somoy API key dile tar FREE model gulo auto load hoy
    ebong niche list e dekha jay. Key na dile auto load hoy na.
  - Manual model add sob somoy kaj kore - nam likhlei context/vision/tools
    info provider theke fetch kore list e bosiye dey.
  - Notun provider: Vercel AI Gateway (ai-gateway.vercel.sh/v1) ebong
    Kilo Gateway (ai-gateway.kilo.ai/api/v1). Kilo-r free model key charao chole.
  - Provider card e "Add all models" button - oi provider er shob model add kore.
  - "Test" button - key + /models endpoint thik ache kina dekhey.
  - Fast open: Vibe-Route-Setup exe install koro (portable exe protibar extract
    hoy tai slow). Electron chara shudhu browser e chalate: start-light.bat.
  - OpenCode auto-detect: PC te OpenCode install + login thakle Vibe Route nijei
    OpenCode er DB/auth.json theke token pore (read-only) provider add kore,
    model list auto sync kore. Key kothao likhte hoy na, token browser e dekhay na.
    Config e "autoDetectOpencode": false dile auto-detect, "autoSyncOpencode": false
    dile model auto-sync bondho thakbe.
  - /v1/models e shudhu connected provider er ADD KORA model gulo ashe
    (agent app er auto-fetch e oi list tai jay). Provider er FULL catalog
    chaile config.json e "exposeCatalogModels": true dao.
    NOTE: OpenCode er free-tier model sudhu OpenCode app er moddhe chole; onno
    client (Vibe Route) theke 403 dey. Go/paid/credit thakle sob model cholbe.
  - Streaming e tool call ar usage crash fix; tool arguments ar duplicate hoy na.
  - Long agent run er jonno timeout 10 min (config.json e "timeoutMs" diye bodlao).
  - Model remove/provider delete korle default model ar alias ar dangling thake na.
  - Exe build e tomar API key embed hoy na (build.cjs key strip kore).
  - Claude Code, Cline/Roo, Continue, jekono OpenAI-compatible app ek e base URL e cholbe:
      Anthropic: http://127.0.0.1:8787
      OpenAI   : http://127.0.0.1:8787/v1
