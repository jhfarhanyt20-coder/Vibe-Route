@echo off
echo Setting Claude Code environment for Vibe Route (current user)...
setx ANTHROPIC_BASE_URL "http://127.0.0.1:8787"
setx ANTHROPIC_AUTH_TOKEN "dummy"
setx ANTHROPIC_MODEL "claude-sonnet-4-5"
setx ANTHROPIC_SMALL_FAST_MODEL "claude-3-5-haiku-20241022"
echo.
echo Done. Close this window and open a NEW terminal before running Claude Code.
pause
