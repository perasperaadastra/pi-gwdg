/**
 * Shared debug logging for pi-gwdg.
 *
 * Provides a single debug logging function that all extension modules can use.
 * Messages are routed to `ctx.ui.notify()` when in TUI mode (no flickering),
 * and to `console.log` in print/RPC/json mode or when no ctx is available.
 *
 * Usage:
 * ```ts
 * import { debug, setDebugCtx } from "./debug.js";
 *
 * setDebugCtx(ctx);  // call once per event handler
 * debug("some message", arg1, arg2);
 * ```
 *
 * For printf-style formatting, use %d, %s, etc.:
 * ```ts
 * debug("count=%d, name=%s", count, name);
 * ```
 */

import { isDebugEnabled } from "./config.js";
import { appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// File tracer (investigation aid)
// ---------------------------------------------------------------------------

/**
 * Append a line to a trace file when PI_GWDG_TRACE is set. Unlike debug(),
 * this never touches the TUI (no notification spam) and always writes,
 * regardless of debug/TUI mode — ideal for capturing a complete, timestamped
 * event trace during a single reproduction run.
 *
 * PI_GWDG_TRACE="1"            → writes to ./pi-gwdg-trace.log
 * PI_GWDG_TRACE="/path/to.log" → writes to that path
 */
export function trace(msg: string, ...args: unknown[]): void {
  const target = process.env.PI_GWDG_TRACE;
  if (!target) return;
  const path = target === "1" ? "./pi-gwdg-trace.log" : target;
  const line = `${new Date().toISOString()} ${formatMessage(msg, args)}\n`;
  try {
    appendFileSync(path, line, "utf-8");
  } catch {
    // Never let tracing break the extension.
  }
}

// ---------------------------------------------------------------------------
// Module-level mutable ctx reference
// ---------------------------------------------------------------------------

/**
 * The most recently set debug context (set by event handlers via setDebugCtx).
 * Used to determine the UI mode and to call ctx.ui.notify().
 * Stored as a WeakRef-like pattern: we only hold a reference; callers must
 * not rely on it being non-null or valid across async boundaries.
 */
let _debugCtx: { mode?: string; ui?: { notify: (...args: unknown[]) => void } } | null = null;

/**
 * Set the debug context for the current event handler.
 *
 * Call this at the top of every event handler (before any debug() call).
 * The reference is stored module-level and used by all subsequent debug()
 * calls until the next setDebugCtx() or clearDebugCtx().
 */
export function setDebugCtx(ctx: unknown): void {
  _debugCtx = ctx as { mode?: string; ui?: { notify: (...args: unknown[]) => void } } | null;
}

/**
 * Clear the debug context (e.g. at the end of event handlers or when ctx
 * is no longer valid).
 */
export function clearDebugCtx(): void {
  _debugCtx = null;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format a message with interpolated args in a notification-friendly way.
 * Supports printf-style %d, %s, %j, %o, %O placeholders.
 */
function formatMessage(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;
  if (/%[sdifoOj]/.test(msg)) {
    let i = 0;
    const formatted = msg.replace(/%[sdifoOj]/g, () => {
      const val = i < args.length ? args[i++] : undefined;
      if (val === undefined) return "undefined";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    });
    // Append any remaining args
    const remaining = args.slice(i);
    if (remaining.length > 0) {
      const appendix = remaining
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
      return `${formatted} ${appendix}`;
    }
    return formatted;
  }
  // No placeholders — append all args
  const appendix = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
  return appendix ? `${msg} ${appendix}` : msg;
}

// ---------------------------------------------------------------------------
// Main debug function
// ---------------------------------------------------------------------------

/**
 * Log a debug message.
 *
 * In TUI mode (when ctx is available and mode === "tui"), shows a notification.
 * In other modes (print, rpc, json), or when no ctx is available, uses console.log.
 *
 * @param msg - The message string (may contain %d/%s/etc format specifiers)
 * @param args - Additional arguments (formatted values or objects)
 */
export function debug(msg: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) return;

  const ctx = _debugCtx;
  const fullMsg = `[GWDG DEBUG] ${formatMessage(msg, args)}`;

  if (ctx?.mode === "tui") {
    try {
      ctx.ui?.notify(fullMsg, "info");
    } catch {
      // Fallback if notify fails
      console.log(fullMsg);
    }
  } else {
    console.log(fullMsg);
  }
}
