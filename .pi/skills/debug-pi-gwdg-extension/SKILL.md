---
name: debug-pi-gwdg-extension
description: Use when investigating and debugging pi-gwdg extension issues.
---

Check your current working directory before start doing anything.

# Extension Runtime Debugging

Verify by enable debugging and grep for the expected logging outputs.

## Testing an extension without TUI

To get cleaner debug output, disable TUI with `-p` flag:

```bash
pi -e /path/to/extension -p "your prompt"
```

## Running extension with debug output

Enable extension-specific debug flags. Common patterns:

```bash
PI_GWDG_DEBUG=1 pi -e /path/to/extension -p "prompt"
```

Read the extension's code or documentation to find the specific environment variable names.

---

## Testing Rate Limiting Safely

### Quick method: Repeated bash commands

To test key rotation without heavy resource usage, use simple repeated tool calls:

```bash
pi -e /path/to/project -p "Do this exactly 20 times: Run the bash command \"echo test\" and then tell me the number you're on (like \"Done 1\"). Start with number 1 and go up to 20."
```

Each bash execution results in a separate API call, allowing you to observe rate limiting behavior.
