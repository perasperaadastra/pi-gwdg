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
pi -e . -p "your prompt"
```

## Running extension with debug output

Enable extension-specific debug flags. Common patterns:

```bash
PI_GWDG_DEBUG=1 pi -e . -p "prompt"
```

Read the extension's code or documentation to find other environment variable names for specific logs.

---

### Special Case: Testing Rate Limiting by repeated bash commands

To test key rotation without heavy resource usage, use simple repeated tool calls:

```bash
PI_GWDG_DEBUG=1 pi -e . --model gwdg/qwen3-vl-30b-a3b-instruct -p "i want to debug key rotation ui behavior. all you have to do is call bash tool without timeout to run only a single date command. its important to wait for the result. repeat that a lot of times (no need to count explicitly) but always wait on the bash result. i know this sounds stupid but please do as i say and nothing else. do not think hard about it. it really just what i said. thank you"```

Each bash execution results in a separate API call, allowing you to observe rate limiting behavior.
Specify at least 60s timeout.
