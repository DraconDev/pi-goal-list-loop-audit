import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Type, type TSchema } from "typebox";
import { applyToolConfig } from "../extensions/tool-config.js";
import { runToolCall, type AgentContext } from "@earendil-works/pi-agent-core";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import activate, { __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import { globalSettingsPath, saveSettings } from "../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tmpCwd, invalidateHostSession } from "./harness/mock-pi.js";

const settingsFile = globalSettingsPath();
const original = fs.readFileSync(settingsFile, "utf8");
let session: { pi: MockPi; ctx: ReturnType<typeof makeMockCtx> } | undefined;
const schema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()), format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])) });
async function boot(options: Record<string, unknown>, parameters: TSchema = schema) {
  __testOnlyResetProcessState();
  fs.writeFileSync(settingsFile, JSON.stringify({ autoResume: false, aggressiveMode: false }));
  const pi = new MockPi();
  activate(pi.api);
  const sessionId = `tool-options-${Math.random()}`;
  const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: sessionId, getSessionId: () => sessionId, getSessionFile: () => undefined } });
  pi.api.getAllTools = () => [{ name: "bash", parameters }] as ReturnType<typeof pi.api.getAllTools>;
  await pi.fire("session_start", { reason: "startup" }, ctx);
  saveSettings("project", ctx.cwd, { toolOverrides: { perToolConfig: { bash: options } } });
  session = { pi, ctx };
  return session;
}
afterEach(async () => {
  if (session) await session.pi.fire("session_shutdown", { reason: "test" }, session.ctx);
  session = undefined;
  __testOnlyResetProcessState();
  fs.writeFileSync(settingsFile, original);
});
async function call(input: Record<string, unknown>) {
  const { pi, ctx } = session!;
  return await pi.handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", toolCallId: "configured-call", input } as never, ctx as never) as unknown as { block?: boolean; reason?: string } | undefined;
}

test("project optional arguments override supplied values and apply to later calls", async () => {
  const { ctx } = await boot({ timeout: 60, format: "json" });
  const first = { command: "example", timeout: 5 } as Record<string, unknown>;
  assert.equal((await call(first))?.block, undefined);
  assert.deepEqual(first, { command: "example", timeout: 60, format: "json" });
  saveSettings("project", ctx.cwd, { toolOverrides: { perToolConfig: { bash: { timeout: 12 } } } });
  const second = { command: "another" };
  await call(second);
  assert.deepEqual(second, { command: "another", timeout: 12 });
  assert.deepEqual(first, { command: "example", timeout: 60, format: "json" }, "saved changes do not mutate an earlier call");
});

for (const config of [{ timeout: "bad" }, { unsupported: true }, { command: "replace the operation" }]) {
  test(`invalid options block atomically: ${JSON.stringify(config)}`, async () => {
    await boot(config);
    const input = { command: "original", timeout: 5 };
    const result = await call(input);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /tool.*(?:option|configuration)/i);
    assert.deepEqual(input, { command: "original", timeout: 5 });
  });
}

test("a stale host cannot rewrite tool arguments", async () => {
  const { pi, ctx } = await boot({ timeout: 60 });
  invalidateHostSession(pi, ctx);
  const input = { command: "original", timeout: 5 };
  await call(input);
  assert.deepEqual(input, { command: "original", timeout: 5 });
});

test("the real Pi tool pipeline executes bash with the configured timeout", async () => {
  let observedTimeout: number | undefined;
  const definition = createBashToolDefinition(tmpCwd(), { operations: {
    exec: async (_command, _cwd, options) => {
      observedTimeout = options.timeout;
      options.onData(Buffer.from("configured execution\n"));
      return { exitCode: 0 };
    },
  } });
  const { pi, ctx } = await boot({ timeout: 60 }, definition.parameters);
  const context: AgentContext = { messages: [], tools: [{ ...definition, execute: (...args: any[]) => (definition.execute as any)(...args, ctx) }] };
  const outcome = await runToolCall({ type: "toolCall", id: "pipeline-call", name: "bash", arguments: { command: "fixture command", timeout: 5 } }, {
    tools: context.tools!, context,
    assistantMessage: { role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage,
    beforeToolCall: async ({ toolCall, args }) => await pi.handlers.get("tool_call")!({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never, ctx as never) as any,
  });
  assert.equal(outcome.isError, false, JSON.stringify(outcome));
  assert.equal(observedTimeout, 60, "the actual bash execution receives the override");
});

test("invalid merged options leave every input field unchanged", () => {
  const input = { command: "original", timeout: 5, format: "text" };
  assert.equal(applyToolConfig("bash", input, { timeout: 60, format: "unsupported" }, () => [{ name: "bash", parameters: schema }])?.block, true);
  assert.deepEqual(input, { command: "original", timeout: 5, format: "text" });
});

test("nested overrides belong to each call, and optional zero remains valid", () => {
  const parameters = Type.Object({ command: Type.String(), options: Type.Optional(Type.Object({ limit: Type.Number(), labels: Type.Array(Type.String()) })) });
  const config = { options: { limit: 0, labels: ["original"] } };
  const tools = () => [{ name: "bash", parameters }];
  const first: Record<string, any> = { command: "first" };
  const second: Record<string, any> = { command: "second" };
  assert.equal(applyToolConfig("bash", first, config, tools), undefined);
  first.options.labels.push("mutated");
  assert.equal(applyToolConfig("bash", second, config, tools), undefined);
  assert.deepEqual(second.options, { limit: 0, labels: ["original"] });
  assert.deepEqual(config.options, second.options);
});

test("unconfigured calls do not need a registry; missing or unsupported schemas block configured calls", () => {
  const input = { command: "original" };
  const unavailable = () => { throw new Error("registry unavailable"); };
  assert.equal(applyToolConfig("bash", input, undefined, unavailable), undefined);
  assert.equal(applyToolConfig("bash", input, {}, unavailable), undefined);
  assert.equal(applyToolConfig("bash", input, { timeout: 60 }, unavailable)?.block, true);
  assert.equal(applyToolConfig("bash", input, { timeout: 60 }, () => [])?.block, true);
  assert.equal(applyToolConfig("bash", input, { timeout: 60 }, () => [{ name: "bash", parameters: Type.String() }])?.block, true);
  assert.deepEqual(input, { command: "original" });
});
