// pi-goal-list-loop-audit — v0.28.7 (T7)
// tests/harness/mock-pi.ts
//
// The mock-ctx harness the audit called for (WRONG-OR-NOT-PREMIUM Stream 4,
// T7): a fake ExtensionAPI + stub ExtensionContext that let tests REGISTER
// goal.ts's tools/commands/event handlers and DRIVE them behaviorally —
// instead of regex-pinning source text.
//
// Design notes:
// - goal.ts is a singleton module with process-wide state (state.goal,
//   ownerSession, extensionApiStale, …). bun test SHARES module state across
//   files (verified empirically). v0.38.88: the preload (setup.ts) calls
//   __testOnlyResetProcessState() before EACH file, so latch state never
//   crosses a file boundary; per-test afterEach resets stay as defense in
//   depth. Within ONE file, tests that share a sessionManager run in a
//   deliberate order (the first session_start claims it; anything else is
//   "foreign") — behavioral-orchestrator.test.ts is the big one.
// - sendMessageError / ui.*Impl are the fault-injection knobs (stale handle,
//   dialog throws, editor answers).
// - tick() lets the 0ms/50ms scheduled continuation timers fire.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** pi's exact stale-handle signature (matched by isStaleApiError). */
export const STALE_ERROR_MESSAGE = "stale after session replacement or reload";

export function staleError(): Error {
  return new Error(`This extension's context is ${STALE_ERROR_MESSAGE}`);
}

/** Reproduce pi invalidating the host runtime without delivering a successor
 * session_start. Both the captured context probes and the ExtensionAPI fail
 * with pi's stale signature; tests intentionally decide when (or whether) a
 * replacement lifecycle event is emitted afterward. */
export function invalidateHostSession(pi: MockPi, ctx: MockCtx): void {
  const error = staleError();
  pi.sendMessageError = error;
  pi.sessionNameError = error;
  ctx.isIdle = () => { throw error; };
  ctx.hasPendingMessages = () => { throw error; };
}

export interface SentMessage {
  message: { customType?: string; content?: string; display?: boolean };
  options: unknown;
}

export class MockPi {
  tools = new Map<string, { name: string; execute: (...args: never[]) => Promise<unknown> }>();
  commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  handlers = new Map<string, (...args: never[]) => Promise<void>>();
  sent: SentMessage[] = [];
  userMessages: Array<{ message: string; options: unknown }> = [];
  /** When set, sendMessage throws it SYNCHRONOUSLY — matching pi's real
   * assertActive() semantics (stale = sync throw, not a rejected promise,
   * so goal.ts's try/catch send paths observe it exactly as in prod). */
  sendMessageError: Error | null = null;
  /** When set, getSessionName() throws it — trips the stale entry probe. */
  sessionNameError: Error | null = null;
  /** v0.29.19: programmable exec (loop measure commands). Default keeps
   * the historical empty-stdout behavior so existing tests are unaffected.
   * A Promise result lets lifecycle tests suspend an async measure while a
   * replacement session is delivered. */
  execHandler: ((cmd: string, args: string[], opts: unknown) => { code: number; stdout: string; stderr: string } | Promise<{ code: number; stdout: string; stderr: string }>) | null = null;
  /** v0.34.57: models passed to api.setModel() — the forbidden-gate revert
   * path records its selections here. */
  modelSelections: unknown[] = [];
  sessionName = "mock-session";
  private activeTools: string[] = [];
  /** v0.34.71: cross-extension event bus (pi.events) — the extension
   * subscribes to pi-subagents lifecycle channels here; tests fire spawn
   * events via emitBus(). */
  eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  messageRenderers = new Map<string, (...args: any[]) => unknown>();
  readonly api: ExtensionAPI;

  constructor() {
    const self = this;
    this.api = {
      registerTool(def: { name: string; execute: (...args: never[]) => Promise<unknown> }): void {
        self.tools.set(def.name, { name: def.name, execute: def.execute });
      },
      registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
        self.commands.set(name, spec.handler);
      },
      registerMessageRenderer(customType: string, renderer: (...args: any[]) => unknown): void {
        self.messageRenderers.set(customType, renderer);
      },
      on(event: string, handler: (...args: never[]) => Promise<void>): void {
        self.handlers.set(event, handler);
      },
      sendMessage(message: SentMessage["message"], options: unknown): Promise<void> {
        if (self.sendMessageError) throw self.sendMessageError; // sync throw, like pi's assertActive()
        self.sent.push({ message, options });
        return Promise.resolve();
      },
      sendUserMessage(message: string, options: unknown): void {
        if (self.sendMessageError) throw self.sendMessageError;
        self.userMessages.push({ message, options });
      },
      async setModel(model: unknown): Promise<boolean> {
        self.modelSelections.push(model);
        return true;
      },
      getThinkingLevel(): string {
        return "high";
      },
      getSessionName(): string {
        if (self.sessionNameError) throw self.sessionNameError;
        return self.sessionName;
      },
      getActiveTools(): string[] {
        return [...self.activeTools];
      },
      setActiveTools(names: string[]): void {
        self.activeTools = [...names];
      },
      getCommands(): Array<{ name: string }> {
        return [...self.commands.keys()].map((name) => ({ name }));
      },
      events: {
        emit(channel: string, data: unknown): void {
          for (const h of self.eventHandlers.get(channel) ?? []) h(data);
        },
        on(channel: string, handler: (data: unknown) => void): () => void {
          const hs = self.eventHandlers.get(channel) ?? [];
          hs.push(handler);
          self.eventHandlers.set(channel, hs);
          return () => {
            const cur = self.eventHandlers.get(channel) ?? [];
            self.eventHandlers.set(channel, cur.filter((h) => h !== handler));
          };
        },
      },
      async exec(cmd: string, args: string[], opts: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
        if (self.execHandler) return self.execHandler(cmd, args, opts);
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as ExtensionAPI;
  }

  async fire(event: string, ...args: unknown[]): Promise<void> {
    const h = this.handlers.get(event);
    if (!h) throw new Error(`no handler registered for event: ${event}`);
    await (h as (...a: unknown[]) => Promise<void>)(...args);
  }

  async runTool(name: string, params: unknown, ctx: unknown, signal: AbortSignal = new AbortController().signal): Promise<{ content: Array<{ type: string; text: string }> }> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return (await (t.execute as (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>)(
      "call-1",
      params,
      signal,
      undefined,
      ctx,
    )) as { content: Array<{ type: string; text: string }> };
  }

  async command(name: string, args: string, ctx: unknown): Promise<void> {
    const h = this.commands.get(name);
    if (!h) throw new Error(`command not registered: ${name}`);
    await h(args, ctx);
  }

  /** Fire a cross-extension event-bus message (pi.events.emit) — tests use
   * this to simulate pi-subagents lifecycle broadcasts. */
  emitBus(channel: string, data: unknown): void {
    for (const h of this.eventHandlers.get(channel) ?? []) h(data);
  }
}

export interface MockNotify {
  message: string;
  type?: string;
}

// Minimal theme/keybindings the emulated interactive custom TUI passes to
// the builder — mirrors the FAKE_THEME/FAKE_KB fixtures in confirm-draft.test.ts.
const FAKE_THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
const FAKE_KB = { matches: () => false };

export class MockUi {
  notifies: MockNotify[] = [];
  statuses: Record<string, string | undefined> = {};
  widgets: Record<string, unknown> = {};
  confirmImpl: ((title: string, message: string) => Promise<boolean>) | undefined = async () => true;
  selectImpl: ((title: string, options: string[]) => Promise<string | undefined>) | undefined = async () => undefined;
  inputImpl: ((title: string, placeholder?: string) => Promise<string | undefined>) | undefined = async () => undefined;
  customImpl: ((...args: unknown[]) => Promise<unknown>) | undefined = async () => undefined;
  // v0.34.80: real interactive pi INVOKES the custom factory (the builder
  // runs, then the component's done() resolves the dialog). The old mock
  // never invoked it — which accidentally emulated the RPC/noOp stub shape
  // (pi 0.84.1: `async custom() { return undefined; }`, factory never
  // called). Both shapes are now explicit: customStubMode=true reproduces
  // the RPC stub (factory never invoked, resolves via customImpl/default
  // undefined); false (default) emulates interactive pi.
  customStubMode = false;

  notify(message: string, type?: string): void {
    this.notifies.push({ message, type });
  }
  setStatus(key: string, text: string | undefined): void {
    this.statuses[key] = text;
  }
  setWidget(key: string, lines: unknown): void {
    this.widgets[key] = lines;
  }
  confirm(title: string, message: string): Promise<boolean> {
    return this.confirmImpl ? this.confirmImpl(title, message) : Promise.resolve(true);
  }
  select(title: string, options: string[]): Promise<string | undefined> {
    return this.selectImpl ? this.selectImpl(title, options) : Promise.resolve(undefined);
  }
  input(title: string, placeholder?: string): Promise<string | undefined> {
    return this.inputImpl ? this.inputImpl(title, placeholder) : Promise.resolve(undefined);
  }
  custom(...args: unknown[]): Promise<unknown> {
    if (!this.customStubMode) {
      const factory = args[0] as ((tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown) | undefined;
      if (typeof factory === "function") {
        try {
          factory({ requestRender: () => {} }, FAKE_THEME, FAKE_KB, () => {});
        } catch {
          // builder errors surface through customImpl's promise in tests that
          // opt into them — never let the emulated TUI mask the resolver.
        }
      }
    }
    return this.customImpl ? this.customImpl(...args) : Promise.resolve(undefined);
  }
  get theme(): undefined {
    return undefined;
  }

  /** All notify messages containing `substr` (case-insensitive). */
  matching(substr: string): MockNotify[] {
    const needle = substr.toLowerCase();
    return this.notifies.filter((n) => n.message.toLowerCase().includes(needle));
  }
}

export type MockCtx = Omit<ExtensionContext, "ui"> & { ui: MockUi };

export function makeMockCtx(cwd: string, opts: { sessionManager?: unknown; idle?: boolean; pending?: boolean } = {}): MockCtx {
  const ui = new MockUi();
  return {
    cwd,
    hasUI: true,
    sessionManager: opts.sessionManager ?? { mock: "session-manager" },
    model: { provider: "anthropic", id: "mock-model" },
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => opts.pending ?? false,
    abort: () => {},
    ui,
  } as unknown as MockCtx;
}

export function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-behavioral-"));
}

/** Seed a .pi-glla/active.jsonl with ONE state line (the restore-gate input). */
export function seedState(cwd: string, value: { goal?: unknown; list?: unknown[]; loop?: unknown; lastCompactionAt?: number | null; postCompactRecovery?: unknown }): void {
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  const line = JSON.stringify({ type: "state", value: { goal: null, list: [], loop: null, ...value }, at: new Date().toISOString() });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), line + "\n");
}

/** A minimal valid active-goal object for seedState. */
export function seedGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    objective: "seeded test objective — done when pinned",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A minimal valid active-loop object for seedState. */
export function seedLoop(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: "seeded loop target",
    measureCmd: "echo 1",
    direction: "min",
    iteration: 1,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: null,
    lastValue: null,
    active: true,
    history: [],
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Let scheduled 0ms/50ms continuation timers fire. */
export function tick(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
