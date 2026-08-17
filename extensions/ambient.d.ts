/**
 * Ambient declarations for external modules used by pi-gwdg.
 *
 * These declarations satisfy TypeScript's type-checker so that `tsc --noEmit`
 * passes without requiring `@types/node`, a fully-formed `@earendil-works/pi-coding-agent`
 * package.json, or the nested `@earendil-works/pi-tui` in node_modules.
 *
 * Actual types are drawn from the bundled `.d.ts` files shipped with the
 * respective packages. This file is never loaded at runtime.
 */

// ---------------------------------------------------------------------------
// Node.js built-ins
// ---------------------------------------------------------------------------

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding?: BufferEncoding): string;
  export function writeFileSync(
    path: string,
    data: string,
    options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
  ): void;
  export function appendFileSync(path: string, data: string, encoding?: BufferEncoding): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  export function renameSync(oldPath: string, newPath: string): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: BufferEncoding): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

declare var process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  /** Used to stamp shared-state writes and name their temp files. */
  pid: number;
};

// ---------------------------------------------------------------------------
// @earendil-works/pi-tui
// ---------------------------------------------------------------------------

declare module "@earendil-works/pi-tui" {
  export interface AutocompleteItem {
    value: string;
    label?: string;
    description?: string;
  }

  export interface AutocompleteProvider {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options?: unknown): Promise<{ items: AutocompleteItem[]; prefix: string }>;
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): string[];
    shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
  }

  export interface Component {
    render(w: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
    onSelect?(item: AutocompleteItem): void;
    onCancel?(): void;
  }

  export interface SelectItem {
    value: string;
    label: string;
    description?: string;
  }

  export interface SettingItem {
    id: string;
    label: string;
    currentValue: string;
    values?: string[];
    submenu?: (currentValue: string, done: (result: string) => void) => Component;
  }

  export interface SelectListTheme {
    prefix: (s: string) => string;
    item: (s: string) => string;
    selectedItem: (s: string) => string;
  }

  export interface SettingsListTheme {
    prefix: (s: string) => string;
    label: (s: string) => string;
    value: (s: string) => string;
  }

  export class SelectList implements Component {
    constructor(items: SelectItem[], visibleRows: number, theme: SelectListTheme);
    render(w: number): string[];
    invalidate(): void;
    handleInput(data: string): void;
    onSelect: ((item: AutocompleteItem) => void) | undefined;
    onCancel: (() => void) | undefined;
  }

  export class SettingsList implements Component {
    constructor(
      items: SettingItem[],
      visibleRows: number,
      theme: SettingsListTheme,
      onToggle?: (id: string, newValue: string) => void,
      onClose?: () => void,
    );
    render(w: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
  }

  export class Container implements Component {
    constructor();
    addChild(child: Component): void;
    render(w: number): string[];
    invalidate(): void;
  }

  export interface LoaderIndicatorOptions {
    /** Animation frames. Use an empty array to hide the indicator. */
    frames?: string[];
    /** Frame interval in milliseconds for animated indicators. */
    intervalMs?: number;
  }

  /**
   * Spinner + message line. The same component pi's own status indicators
   * (working / retry / compaction) are built on, hence the identical default
   * frames and 80ms cadence when reused by an extension.
   *
   * `render()` returns a leading blank line before the text line.
   */
  export class Loader implements Component {
    constructor(
      ui: TUI,
      spinnerColorFn: (s: string) => string,
      messageColorFn: (s: string) => string,
      message?: string,
      indicator?: LoaderIndicatorOptions,
    );
    render(w: number): string[];
    invalidate(): void;
    setMessage(message: string): void;
    setIndicator(indicator?: LoaderIndicatorOptions): void;
    start(): void;
    stop(): void;
  }

  /**
   * Resolves raw terminal input against the currently bound keys for an app/TUI
   * keybinding id. Only the members pi-gwdg uses are declared.
   */
  export class KeybindingsManager {
    matches(data: string, keybinding: string): boolean;
    getKeys(keybinding: string): string[];
  }

  /**
   * The process-global keybindings manager pi installs at startup (the same one
   * `keyText` reads). Falls back to a default manager when unset, so it never
   * throws in a non-pi host.
   */
  export function getKeybindings(): KeybindingsManager;

  /**
   * True for kitty-protocol key-RELEASE events. Extension input listeners run
   * before the TUI's own release filter, so they must apply this themselves or a
   * single keypress is seen twice.
   */
  export function isKeyRelease(data: string): boolean;

  export type TUI = unknown;
}

// ---------------------------------------------------------------------------
// @earendil-works/pi-coding-agent
// ---------------------------------------------------------------------------

declare module "@earendil-works/pi-coding-agent" {
  import type { AutocompleteItem, AutocompleteProvider, Component, TUI } from "@earendil-works/pi-tui";

  // --- Re-exported TUI helpers that are hoisted through pi-coding-agent ---
  export { DynamicBorder, ExtensionInputComponent } from "@earendil-works/pi-coding-agent";

  // --- Config helpers ---
  export function getAgentDir(): string;

  // --- Theme helpers ---
  export function getSelectListTheme(): import("@earendil-works/pi-tui").SelectListTheme;
  export function getSettingsListTheme(): import("@earendil-works/pi-tui").SettingsListTheme;

  /**
   * Render the currently bound keys for an app keybinding (e.g. "app.interrupt"
   * → "esc"), exactly as pi's own status indicators and hints display them.
   * Reads pi's global keybindings manager, so it only works in TUI mode.
   */
  export function keyText(keybinding: string): string;

  // --- Event types ---
  export interface AfterProviderResponseEvent {
    type: "after_provider_response";
    status: number;
    headers: Record<string, string>;
  }

  export interface SessionShutdownEvent {
    type: "session_shutdown";
  }

  export interface SessionStartEvent {
    type: "session_start";
  }

  /**
   * Minimal shape of a finalized message as surfaced to extension event
   * handlers. Only the fields the GWDG extension inspects are declared here;
   * the real message type carries much more (content blocks, usage, etc.).
   * An errored assistant turn has `stopReason: "error"` and an `errorMessage`.
   */
  export interface ProviderMessage {
    role: "user" | "assistant" | "toolResult" | string;
    stopReason?: string;
    errorMessage?: string;
    /**
     * Provider that produced the message (assistant messages only — pi-ai's
     * `AssistantMessage` declares it non-optional). Optional here because the
     * same shape covers user/toolResult messages: it is what scopes the
     * rate-limit fallbacks to GWDG.
     */
    provider?: string;
  }

  /** Fired for each message lifecycle end (user/assistant/toolResult). */
  export interface MessageEndEvent {
    type: "message_end";
    message: ProviderMessage;
  }

  /**
   * Fired when a low-level agent run ends. Pi may still auto-retry afterwards,
   * so this can fire multiple times for one user turn (e.g. once per failed
   * 429 attempt). `messages` holds the messages produced by that run.
   */
  export interface AgentEndEvent {
    type: "agent_end";
    messages: ProviderMessage[];
  }

  // --- Extension API ---
  export interface ProviderModelConfig {
    id: string;
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }

  export interface ProviderConfig {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    models?: ProviderModelConfig[];
    headers?: Record<string, string>;
  }

  export interface ExtensionCommandContext {
    model?: { provider: string };
    modelRegistry: {
      find(provider: string, modelId: string): ProviderModelConfig | undefined;
      getAll(): (ProviderModelConfig & { provider: string })[];
    };
    /** Run mode: "tui" | "rpc" | "json" | "print". Only "tui" has a real terminal. */
    mode?: string;
    /** True in TUI and RPC modes; false in print/json mode, where every `ui` method is a no-op. */
    hasUI?: boolean;
    /** False while an agent run is active (streaming). */
    isIdle?(): boolean;
    ui: {
      setStatus(key: string, text: string | undefined): void;
      notify(message: string, type?: "info" | "warning" | "error"): void;
      /**
       * Override the streaming working-loader message; call with no args to
       * restore the default.
       *
       * NOTE: a single global slot with no ownership — the "restore" call resets
       * it to pi's default, not to another extension's value. pi-gwdg therefore
       * uses `setWidget()` for its rate-limit banner. Also a no-op in RPC mode.
       */
      setWorkingMessage(message?: string): void;
      /**
       * Set a keyed widget above (default) or below the editor; pass `undefined`
       * to clear it. Widgets live in a per-key map, so extensions cannot clobber
       * each other. String-array content also works in RPC mode; component
       * factories are TUI-only (ignored elsewhere).
       */
      setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
      setWidget(key: string, content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
      /**
       * Listen to raw terminal input; returns an unsubscribe function. Handlers
       * run BEFORE every other consumer of the key (editor, app keybindings,
       * overlays); `{ consume: true }` stops that dispatch, `{ data }` rewrites
       * the input for later listeners. TUI-only — a no-op returning a no-op
       * unsubscribe in RPC mode, absent in print/json.
       */
      onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
      /** The active theme, for colouring text an extension renders itself. */
      readonly theme: Theme;
      custom<T>(factory: (tui: TUI, theme: Theme, kb: unknown, done: (result: T) => void) => Component | { render(w: number): string[]; invalidate(): void; handleInput?(data: string): void }): Promise<T extends undefined ? void : T>;
      addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void;
    };
  }

  export interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
    dim(text: string): string;
  }

  export interface ExtensionAPI {
    registerProvider(name: string, config: ProviderConfig): void;
    registerCommand(name: string, options: {
      description: string;
      handler: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
    }): void;
    on(event: "after_provider_response", handler: (event: AfterProviderResponseEvent, ctx: ExtensionCommandContext) => void): void;
    on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionCommandContext) => void): void;
    on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionCommandContext) => void): void;
    on(event: "message_end", handler: (event: MessageEndEvent, ctx: ExtensionCommandContext) => void): void;
    on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionCommandContext) => void): void;
    events?: { emit(event: string, data: unknown): void };
    registerEnvVar?(name: string, options: { description: string }): void;
  }

  // --- Components ---
  export class DynamicBorder implements Component {
    constructor(renderFn: (s: string) => string);
    render(w: number): string[];
    invalidate(): void;
  }

  export class ExtensionInputComponent implements Component {
    constructor(
      title: string,
      placeholder: string,
      onConfirm: (value: string) => void,
      onCancel: () => void,
    );
    render(w: number): string[];
    invalidate(): void;
    handleInput(data: string): void;
  }
}
