# Cross-Extension Rate Limit Access

> Back to [README.md](../README.md).

When enabled, the GWDG extension shares rate limit data on the pi shared event bus,
allowing other extensions to subscribe and react to rate limit state changes.

## Enable

```bash
# Via env var (takes precedence)
export PI_GWDG_EMIT_RATE_LIMIT_EVENTS=1

# Via config file (.pi/gwdg.json or ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/gwdg.json)
{
  "emitRateLimitEvents": true
}
```

> **Default: off.** This is opt-in to avoid unexpected telemetry/data sharing.

## Events

| Event | When | Payload |
|-------|------|---------|
| `pi:rate-limits` | Every provider response | `ProviderRateLimitEvent` |
| `pi:rate-limited` | Only on 429 (rate limited) responses | `ProviderRateLimitedEvent` |

## Consuming Events

Any extension with access to the pi event bus can subscribe:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.eventBus) return;

    // Listen for all rate limit updates
    ctx.eventBus.on("pi:rate-limits", (data) => {
      console.log(`[${data.provider}] quota:`, data.windows);
    });

    // Listen for 429 rate-limit events specifically
    ctx.eventBus.on("pi:rate-limited", (data) => {
      ctx.ui.notify(
        `⚠️ ${data.provider} rate limited — resets in ${Math.ceil(data.retryAfter.retryAfter)}s`,
        "warning",
      );
    });
  });
}
```

## TypeScript Types

Event payload types are exported from the GWDG extension package:

```typescript
import type {
  ProviderRateLimitEvent,
  ProviderRateLimitedEvent,
} from "pi-gwdg";
// or via relative path:
import type {
  ProviderRateLimitEvent,
  ProviderRateLimitedEvent,
} from "./extensions/rate-limits.js";
```

## Payload Shapes

```typescript
interface ProviderRateLimitEvent {
  provider: string;         // "gwdg"
  status: number;           // HTTP status code
  timestamp: number;        // When emitted (Date.now())
  windows: RateLimitWindows;
  retryAfter: RateLimitState | null;
}

interface ProviderRateLimitedEvent extends ProviderRateLimitEvent {
  retryAfter: RateLimitState;  // Non-null — rate limit is active
  isRetryAfter: boolean;       // True if retry-after was explicit
}
```
