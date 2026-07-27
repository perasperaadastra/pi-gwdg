# Configuration

> Back to [README.md](../README.md).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GWDG_API_KEY` | Yes | Your GWDG API key |
| `PI_GWDG_DEBUG` | No | Set to `1` for debug logging |
| `PI_GWDG_HIDE_FOOTER` | No | Set to `1` to suppress rate-limit status in footer |
| `PI_GWDG_FOOTER_TIMEOUT` | No | Seconds before the footer status auto-clears (default: `60`). Set to `0` to never auto-clear. |
| `PI_GWDG_MAX_RATE_LIMIT_WAIT_SEC` | No | Max seconds to wait for a quota reset on a 429 before cancelling the request instead (default: `3600`, clamped `0`–`86400`). `0` = never wait (fail on first 429). See [Rate Limits](./rate-limiting.md). |
| `PI_GWDG_EMIT_RATE_LIMIT_EVENTS` | No | Set to `1` to emit rate limit data on the shared pi event bus (opt-in). See [Cross-Extension Rate Limit Access](./events.md). |
| `PI_GWDG_SHARED_STATE` | No | Share rate-limit state between concurrent pi sessions (default: on). `0`/`false` disables, `1`/`true` enables. See [Cross-Session Rate Limit Coordination](./rate-limiting.md#cross-session-rate-limit-coordination). |
| `PI_GWDG_SHARED_STATE_DIR` | No | Directory for the shared state file. Default: `$XDG_RUNTIME_DIR/pi-gwdg`, falling back to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg-state`. |
| `PI_GWDG_SHARED_STATE_JITTER_MS` | No | Max random extra delay in ms when waking from a shared-state wait, so peers don't fire in lockstep (default: `1000`, clamped `0`–`60000`). |

## Configuration Files

Settings can also be provided via JSON files, merged global → project.
Environment variables take precedence over both.

| Path | Scope |
|------|-------|
| `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json` | Global (all projects) |
| `.pi/gwdg.json` | Project (overrides global) |

```jsonc
{
  // API base URL (default: https://chat-ai.academiccloud.de/v1)
  "baseUrl": "https://chat-ai.academiccloud.de/v1",
  // Model cache TTL in days (default: 30)
  "modelCacheTtlDays": 30,
  // Footer status auto-clear in seconds (default: 60, 0 = never)
  "footerTimeoutSec": 60,
  // Max seconds to wait for a quota reset on a 429 before cancelling instead
  // (default: 3600, clamped 0–86400; 0 = never wait, fail on first 429)
  "maxRateLimitWaitSec": 3600,
  // Hide footer status entirely (default: false)
  "hideFooter": false,
  // Enable debug logging (default: false)
  "debug": false,
  // Emit rate limit events on the pi event bus (opt-in, default: false)
  "emitRateLimitEvents": false,
  // Share rate-limit state between concurrent sessions (default: true)
  "sharedRateLimitState": true,
  // Where the shared state file lives ("" = auto: $XDG_RUNTIME_DIR/pi-gwdg,
  // else ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg-state). A leading ~ is expanded.
  "sharedStateDir": "",
  // Max random extra delay (ms) when waking from a shared-state wait
  // (default: 1000, clamped 0–60000; 0 = no jitter)
  "sharedStateJitterMs": 1000,
  // Per-model overrides — merge on top of API metadata
  "modelOverrides": {
    "some-model-id": {
      "contextWindow": 128000,
      "maxTokens": 8192,
      "reasoning": true,
      "input": ["text", "image"],
      "thinkingLevelMap": {
        "minimal": null,
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      }
    }
  }
}
```

## Thinking Level Map

For reasoning-capable models, you can configure which pi thinking levels are
supported and what value pi sends to the GWDG API for each level. This is
done via the `thinkingLevelMap` field in `modelOverrides`.

**Keys** are pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`.

**Values** can be:
- A **string** — the level is supported; pi sends this value as
  `reasoning_effort` to the GWDG API. Typically the level name itself
  (e.g. `"high"`).
- `null` — the level is explicitly unsupported (hidden from the UI).
- **Omitted** — the level uses pi's default behavior (levels through `high`
  use the default mapping; `xhigh` and `max` are unsupported).

> **Note:** The GWDG API uses OpenAI-compatible `reasoning_effort`
> parameters. Whether a particular GWDG model supports `xhigh` or `max`
> depends on the model provider. Start with the common `"low"`, `"medium"`,
> `"high"` map and experiment with `xhigh`/`max` from there.

### Quick Start via Config

```jsonc
{
  "modelOverrides": {
    "some-model-id": {
      "reasoning": true,
      "thinkingLevelMap": {
        "minimal": null,
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      }
    }
  }
}
```

### Via Settings TUI

Open `/gwdg-settings`, navigate to "Model overrides", select a model, then
select "Thinking level map". A submenu shows all 7 levels. Press **Enter**
to cycle each level through: *omitted* → *supported (value)* → *unsupported*
→ *omitted*. Use **←/→** when on a supported level to switch between the
level name and a custom value; press **Tab** on "custom" to enter your own
value.

### Persistence

`thinkingLevelMap` values are persisted to `.pi/gwdg.json` (or the global
config) alongside other model overrides. After saving, run `/gwdg-refresh`
to re-register the provider with the updated model config.

## Cache

Models are cached to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/pi-gwdg/models-cache.json`.
Default TTL is 30 days. Run `/gwdg-refresh` to bypass the cache.

## Endpoint

`https://chat-ai.academiccloud.de/v1` — OpenAI-compatible API.
See [GWDG SAIA documentation](https://docs.hpc.gwdg.de/services/ai-services/saia/) for details.
