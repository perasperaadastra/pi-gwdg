# pi-gwdg

> **Not officially affiliated with GWDG.** This is a community project.

GWDG provider for pi — access GWDG AI services models (LLMs, embeddings, vision)
through pi's model selector.

## Quick Start

```bash
export GWDG_API_KEY=your-key-here
pi install git:github.com/perasperaadastra/pi-gwdg
# Or for development:
# pi -e ./pi-gwdg

# Select a model
/model gwdg/<model-id>
```

## Commands

| Command | Description |
|---------|-------------|
| `/gwdg-status` | Show connection status, rate limits, model count |
| `/gwdg-info <model>` | Show details for a specific model |
| `/gwdg-models` | List all available models grouped by capability (text / vision / embeddings) |
| `/gwdg-refresh` | Force-refresh model list from API, update cache, re-register provider |
| `/gwdg-simulate-ratelimit [seconds]` | Simulate a 429 with the given reset (default 30s) to exercise the countdown banner / cancel report and the wait-vs-cancel decision without exhausting real quota. Press `escape` to end the simulated wait early, as the banner offers |
| `/gwdg-settings [scope]` | Interactive TUI settings editor for hide footer, debug, footer timeout, cache TTL, max rate-limit wait, emit rate limit events, and **model overrides submenu** (add/edit/delete per-model overrides with field-level editor for maxTokens, contextWindow, reasoning, input, thinkingLevelMap). `scope` can be `project` (default, saves to `.pi/gwdg.json`) or `global` (saves to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json`). Autocomplete for `project`/`global` is installed via `session_start`. |

## Configuration

`GWDG_API_KEY` is required; everything else has a default. Settings come from
env vars, `.pi/gwdg.json` (project), and `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json`
(global), in that order of precedence, and can also be edited live via
`/gwdg-settings`.

Full env var list, config file schema, per-model overrides, and the
`thinkingLevelMap` reference are in **[docs/configuration.md](./docs/configuration.md)**.

## Cache

Models are cached to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/pi-gwdg/models-cache.json`.
Default TTL is 30 days. Run `/gwdg-refresh` to bypass the cache.

## Endpoint

`https://chat-ai.academiccloud.de/v1` — OpenAI-compatible API.
See [GWDG SAIA documentation](https://docs.hpc.gwdg.de/services/ai-services/saia/) for details.

## Rate Limits

On a 429, the extension either waits for the quota to reset (with a live
countdown banner) or cancels the request — whichever `maxRateLimitWaitSec`
dictates — and can share rate-limit state between concurrent pi sessions on the
same API key so peers don't all discover a limit the hard way.

See **[docs/rate-limiting.md](./docs/rate-limiting.md)** for the full behavior
and configuration, and [docs/rate-limit-internals.md](./docs/rate-limit-internals.md)
for the implementation.

## Cross-Extension Rate Limit Access

Other extensions can subscribe to GWDG rate-limit data on pi's shared event bus
(opt-in via `emitRateLimitEvents`). See **[docs/events.md](./docs/events.md)**
for the events, TypeScript types, and an example consumer.
