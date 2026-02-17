# GWDG Provider for Pi

Provides dynamic model fetching for GWDG instances via OpenAI-compatible API.

## Quick Start

See below how to configure Authentication.

```bash
# Install package
pi install https://github.com/perasperaadastra/pi-gwdg

# Load extension
git clone https://github.com/perasperaadastra/pi-gwdg
pi -e ./pi-gwdg

# Select model
/model gwdg/<model-id>
```

See [packages.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md#install-and-manage) for more variants.

## Commands

- `/refresh-gwdg-models` - Refresh model list
- `/model gwdg/<model-id>` - Select model

## Configuration

```bash
export PI_GWDG_API_KEY=your-key      # Authentication required
export PI_GWDG_DEBUG=1               # Optional: Enable debug logging
export PI_GWDG_ASYNC_INIT=true       # Optional: Enable async initialization
```

Authentication can be configured via settings too, like:
- **Environment variable:** `MY_PI_GWDG_API_KEY_VARIABLE` (uses the variable value)
- **Shell command:** `!op read 'op://vault/item/key'` (executes and uses stdout)
- **Literal value:** `sk-...` (used directly)

See [models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md#provider-configuration) for details.

## Cache

Models cached to `~/.pi/agent/gwdg-models-cache.json` for 30 days.

To override the model list manually, see [models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md#minimal-example).

## Troubleshooting

If no models appear:
1. Run `/refresh-gwdg-models` to force refresh
2. Check `~/.pi/agent/gwdg-models-cache.json` exists
3. Ensure GWDG service is accessible

- Extension will fail gracefully with empty models until key is set
