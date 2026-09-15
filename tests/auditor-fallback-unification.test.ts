// tests/auditor-fallback-unification.test.ts
//
// The auditor keeps its detached-worker spawn shape, but its resolver and
// runtime retry walker use the same bounded ordered-chain primitives as the
// main agent and drafter.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAIN_MODEL_MAX_RETRY_DELAY_MS,
  MAX_MAIN_MODEL_FALLBACKS,
  normalizeMainModelFallbackRefs,
} from "../extensions/main-model-recovery.ts";
import {
  runAuditorFallbackWithPolicy,
  normalizeAuditorInfrastructureResult,
  type AuditorFallbackCandidate,
  type AuditorFallbackExhaustionInfo,
  type GoalAuditorResult,
} from "../extensions/goal-loop-auditor-process.ts";
import { resolveAuditorModel } from "../extensions/loops/goal-settings-ui.ts";

interface FakeContext {
  ctx: any;
  session: any;
  primary: any;
  fallback1: any;
  fallback2: any;
  forbiddenRef: any;
  tmpDir: string;
  restore: () => void;
}

function fakeContext(): FakeContext {
  const session = { provider: "test", id: "session", reasoning: true };
  const primary = { provider: "test", id: "primary", reasoning: true };
  const fallback1 = { provider: "test", id: "fallback-1", reasoning: true };
  const fallback2 = { provider: "test", id: "fallback-2", reasoning: true };
  const forbiddenRef = { provider: "test", id: "forbidden", reasoning: true };
  const extraFallbacks = Array.from({ length: 8 }, (_, index) => ({
    provider: "test",
    id: `fallback-${index + 3}`,
    reasoning: true,
  }));
  const models = new Map([
    ["test/session", session],
    ["test/primary", primary],
    ["test/fallback-1", fallback1],
    ["test/fallback-2", fallback2],
    ...extraFallbacks.map((model) => [`test/${model.id}`, model] as const),
    ["test/forbidden", forbiddenRef],
  ]);
  const registry = {
    find(provider: string, id: string) {
      return models.get(`${provider}/${id}`);
    },
    getAvailable() {
      return [...models.values()];
    },
    hasConfiguredAuth(_model: any) {
      return true;
    },
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-auditor-fb-"));
  const globalSettingsFile = path.join(tmpDir, "global.settings.json");
  fs.writeFileSync(globalSettingsFile, JSON.stringify({ forbiddenModels: ["test/forbidden"] }), "utf8");
  const previous = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = globalSettingsFile;
  const notifyMessages: { kind: string; text: string }[] = [];
  const ctx: any = {
    model: session,
    modelRegistry: registry,
    cwd: tmpDir,
    ui: { notify(text: string, kind: string) { notifyMessages.push({ kind, text }); } },
    __notifyMessages: notifyMessages,
  };
  const restore = () => {
    if (previous === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  return { ctx, session, primary, fallback1, fallback2, forbiddenRef, tmpDir, restore };
}

async function withFakeContext<T>(fn: (fixture: FakeContext) => T | Promise<T>): Promise<T> {
  const fixture = fakeContext();
  try {
    return await fn(fixture);
  } finally {
    fixture.restore();
  }
}

function readLedger(tmpDir: string): any[] {
  const file = path.join(tmpDir, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function result(overrides: Partial<GoalAuditorResult> = {}): GoalAuditorResult {
  return {
    approved: false,
    disapproved: false,
    output: "",
    model: "test/model",
    ...overrides,
  };
}

test("auditor ordered fallback refs retain order and use the main normalizer", async () => {
  await withFakeContext(({ ctx, primary, fallback1, fallback2, session }) => {
    const resolved = resolveAuditorModel(ctx, "test/primary", ["test/fallback-1", "test/fallback-2"], true);
    const walked = [resolved.model, ...(resolved.fallbackModels ?? []).map((candidate: any) => candidate.model)];
    assert.deepEqual(walked, [primary, fallback1, fallback2, session]);
    assert.deepEqual(
      normalizeMainModelFallbackRefs(["test/primary", "TEST/PRIMARY", "test/fallback-1"]),
      ["test/primary", "test/fallback-1"],
    );
    assert.equal(MAX_MAIN_MODEL_FALLBACKS, 10);
  });
});

test("auditor keeps all ten fallback slots after a pinned primary", async () => {
  await withFakeContext(({ ctx, session }) => {
    const fallbackRefs = Array.from({ length: 10 }, (_, index) => `test/fallback-${index + 1}`);
    const resolved = resolveAuditorModel(ctx, "test/primary", fallbackRefs, true);
    const walked = [resolved.model, ...(resolved.fallbackModels ?? []).map((candidate: any) => candidate.model)]
      .map((model: any) => `${model.provider}/${model.id}`);
    assert.deepEqual(walked, ["test/primary", ...fallbackRefs, "test/session"]);
    assert.equal(walked.at(-1), `${session.provider}/${session.id}`, "session remains the final last resort");
  });
});

test("auditor forbidden refs are skipped silently and recorded", async () => {
  await withFakeContext(({ ctx, primary, forbiddenRef }) => {
    const before = ctx.__notifyMessages.length;
    const resolved = resolveAuditorModel(ctx, "test/primary", "test/forbidden", true);
    const walked = [resolved.model, ...(resolved.fallbackModels ?? []).map((candidate: any) => candidate.model)];
    assert.ok(walked.includes(primary));
    assert.ok(!walked.includes(forbiddenRef));
    const forbiddenEvents = readLedger(ctx.cwd).filter(
      (entry) => entry.type === "auditor_model_fallback" && entry.value?.reason === "forbidden",
    );
    assert.ok(forbiddenEvents.length >= 1);
    const newWarnings = ctx.__notifyMessages.slice(before).filter((entry: any) => entry.kind === "warning" && /forbidden/i.test(entry.text));
    assert.equal(newWarnings.length, 0);
  });
});

test("a forbidden auditor primary is skipped before the configured fallback and remains silent", async () => {
  await withFakeContext(({ ctx, fallback1, forbiddenRef }) => {
    const before = ctx.__notifyMessages.length;
    const resolved = resolveAuditorModel(ctx, "test/forbidden", "test/fallback-1", true);
    const walked = [resolved.model, ...(resolved.fallbackModels ?? []).map((candidate: any) => candidate.model)];
    assert.equal(resolved.model, fallback1, "the configured fallback becomes the first runnable candidate");
    assert.ok(!walked.includes(forbiddenRef), "the forbidden primary never enters the worker candidate chain");
    const events = readLedger(ctx.cwd).filter(
      (entry) => entry.type === "auditor_model_fallback" && entry.value?.configured === "test/forbidden" && entry.value?.reason === "forbidden",
    );
    assert.equal(events.length, 1, "the forbidden primary leaves one forensic durable event");
    const warnings = ctx.__notifyMessages.slice(before).filter((entry: any) => entry.kind === "warning" && /forbidden/i.test(entry.text));
    assert.equal(warnings.length, 0, "explicit forbidden intent is skipped silently");
  });
});

test("auditor retries the same ref, then walks the next untried ref with bounded shared backoff", async () => {
  const candidates: AuditorFallbackCandidate[] = [
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "duplicate" },
    { ref: "test/fallback-1", model: { provider: "test", id: "fallback-1" }, via: "fallback-pin" },
  ];
  const calls: string[] = [];
  const waits: number[] = [];
  const selections: string[] = [];
  const fallbacks: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
    const ref = candidate.ref!;
    calls.push(ref);
    return ref === "test/primary"
      ? result({ error: "503 upstream unavailable", model: ref })
      : result({ approved: true, model: ref });
  }, {
    retryBaseMinutes: 1,
    sleep: async (ms) => { waits.push(ms); },
    shouldRetry: () => true,
    onSelection: (event) => { if (event.toRef) selections.push(`${event.reason}:${event.toRef}`); },
    onFallback: (from, to) => { fallbacks.push(`${from.ref}->${to.ref}`); },
  });

  assert.equal(outcome.result.approved, true);
  assert.equal(outcome.retriedOnce, true);
  assert.equal(outcome.fallbackUsed, true);
  assert.deepEqual(calls, ["test/primary", "test/primary", "test/fallback-1"]);
  assert.deepEqual(fallbacks, ["test/primary->test/fallback-1"]);
  assert.deepEqual(waits, [5_000, 120_000]);
  assert.ok(waits.every((delay) => delay >= 1_000 && delay <= MAIN_MODEL_MAX_RETRY_DELAY_MS));
  assert.deepEqual(selections, ["ok:test/primary", "ok:test/fallback-1"]);
});

test("auditor forbidden and duplicate refs are skipped before retry ordering", async () => {
  const candidates: AuditorFallbackCandidate[] = [
    { ref: "test/forbidden", model: { provider: "test", id: "forbidden" }, via: "forbidden" },
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "TEST/PRIMARY", model: { provider: "test", id: "primary" }, via: "duplicate" },
    { ref: "test/fallback-2", model: { provider: "test", id: "fallback-2" }, via: "fallback-pin" },
  ];
  const calls: string[] = [];
  const events: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
    calls.push(candidate.ref!);
    return candidate.ref === "test/primary"
      ? result({ error: "503 transient", model: candidate.ref })
      : result({ approved: true, model: candidate.ref });
  }, {
    forbiddenRefs: ["test/forbidden"],
    sleep: async () => {},
    shouldRetry: () => true,
    onSelection: (event) => { if (event.toRef) events.push(`${event.reason}:${event.toRef}`); },
  });
  assert.equal(outcome.result.approved, true);
  assert.deepEqual(calls, ["test/primary", "test/primary", "test/fallback-2"]);
  assert.ok(events.includes("forbidden:test/forbidden"));
});

test("an all-forbidden auditor chain does not launch a forbidden worker", async () => {
  let calls = 0;
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "test/forbidden", model: { provider: "test", id: "forbidden" }, via: "setting" },
  ], async () => {
    calls++;
    return result({ approved: true });
  }, { forbiddenRefs: ["forbidden"], shouldRetry: () => true });
  assert.equal(calls, 0);
  assert.equal(outcome.result.error, "no auditor model");
});

test("non-recoverable auditor failures stop without retrying or advancing", async () => {
  const waits: number[] = [];
  let calls = 0;
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/fallback-1", model: { provider: "test", id: "fallback-1" }, via: "fallback-pin" },
  ], async () => {
    calls++;
    return result({ error: "context window exceeded" });
  }, { sleep: async (ms) => { waits.push(ms); }, shouldRetry: () => true });
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(outcome.fallbackUsed, false);
});

test("auditor wall timeouts and watchdog stalls walk the fallback chain", async () => {
  const candidates: AuditorFallbackCandidate[] = [
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/fallback-pin", model: { provider: "test", id: "fallback-pin" }, via: "fallback-pin" },
  ];
  const calls: string[] = [];
  const fallbacks: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
    calls.push(candidate.ref!);
    return candidate.ref === "test/primary"
      ? result({ error: "Auditor stalled — no session activity since boot for 10m; the detached job was auto-cancelled.", model: candidate.ref })
      : result({ approved: true, model: candidate.ref });
  }, {
    retryBaseMinutes: 1,
    sleep: async () => {},
    shouldRetry: () => true,
    onFallback: (from, to) => { fallbacks.push(`${from.ref}->${to.ref}`); },
  });

  assert.equal(outcome.result.approved, true);
  assert.equal(outcome.retriedOnce, true);
  assert.equal(outcome.fallbackUsed, true);
  assert.deepEqual(calls, ["test/primary", "test/primary", "test/fallback-pin"]);
  assert.deepEqual(fallbacks, ["test/primary->test/fallback-pin"]);
});

test("a restarted retry cursor spends the second call once, then advances", async () => {
  const candidates: AuditorFallbackCandidate[] = [
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/fallback-1", model: { provider: "test", id: "fallback-1" }, via: "fallback-pin" },
  ];
  const calls: string[] = [];
  const attempts: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
    calls.push(candidate.ref!);
    return candidate.ref === "test/primary"
      ? result({ error: "503 service unavailable", model: candidate.ref })
      : result({ approved: true, model: candidate.ref });
  }, {
    resumeCandidateRef: "test/primary",
    retryCandidateRef: "test/primary",
    attemptedRefs: [],
    sleep: async () => {},
    shouldRetry: () => true,
    onAttempt: (_candidate, info) => { attempts.push(`${info.candidateRef}:${info.attempt}`); },
  });

  assert.deepEqual(calls, ["test/primary", "test/fallback-1"], "restart recovery must not issue a third primary call");
  assert.deepEqual(attempts, ["test/primary:2", "test/fallback-1:1"]);
  assert.equal(outcome.result.approved, true);
  assert.equal(outcome.retriedOnce, true);
  assert.equal(outcome.fallbackUsed, true);
});

test("a crash after launching the retry consumes that retry and advances without a third call", async () => {
  const calls: string[] = [];
  const exhausted: AuditorFallbackExhaustionInfo[] = [];
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/fallback-1", model: { provider: "test", id: "fallback-1" }, via: "fallback-pin" },
  ], async (candidate) => {
    calls.push(candidate.ref!);
    assert.notEqual(candidate.ref, "test/primary", "the already-started retry must not be replayed after restart");
    return result({ approved: true, model: candidate.ref });
  }, {
    resumeCandidateRef: "test/primary",
    retryCandidateRef: "test/primary",
    retryAttemptStarted: true,
    retryFailureClass: "provider",
    attemptedRefs: [],
    sleep: async () => {},
    shouldRetry: () => true,
    onCandidateExhausted: (_candidate, _error, info) => { exhausted.push(info); },
  });

  assert.deepEqual(calls, ["test/fallback-1"]);
  assert.equal(exhausted[0]?.candidateRef, "test/primary");
  assert.equal(exhausted[0]?.nextCandidateRef, "test/fallback-1");
  assert.equal(outcome.result.approved, true);
  assert.equal(outcome.retriedOnce, true);
  assert.equal(outcome.fallbackUsed, true);
});

test("infrastructure errors cannot survive as semantic auditor verdicts", async () => {
  const normalized = normalizeAuditorInfrastructureResult(result({
    approved: true,
    disapproved: true,
    impossible: true,
    impossibleReason: "mixed payload",
    regressionShieldPassed: false,
    regressionShieldMissing: ["contract item"],
    error: "503 provider unavailable",
  }));
  assert.equal(normalized.approved, false);
  assert.equal(normalized.disapproved, false);
  assert.equal(normalized.impossible, false);
  assert.equal(normalized.regressionShieldPassed, undefined);
  assert.deepEqual(normalized.regressionShieldMissing, undefined);
  assert.equal(normalizeAuditorInfrastructureResult(result({
    error: "transport failed",
    regressionShieldPassed: true,
  })).regressionShieldPassed, undefined);
  const classOnly = normalizeAuditorInfrastructureResult(result({
    approved: true,
    infrastructureClass: "timeout",
  }));
  assert.equal(classOnly.approved, false);
  assert.equal(classOnly.error, "Auditor timed out");
});

test("partial semantic flags cannot bypass fallback recovery", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
  ], async (candidate) => {
    calls.push(candidate.ref!);
    attempt += 1;
    return attempt === 1
      ? result({ approved: true, error: "503 provider unavailable", model: candidate.ref })
      : result({ approved: true, model: candidate.ref });
  }, {
    sleep: async () => {},
    shouldRetry: () => true,
  });

  assert.deepEqual(calls, ["test/primary", "test/primary"]);
  assert.equal(outcome.retriedOnce, true);
  assert.equal(outcome.result.approved, true);
  assert.equal(outcome.result.error, undefined);
});

test("same-provider rungs collapse after a provider-class failure", async () => {
  // One dead backend must not burn a launch per rung: after test/primary
  // fails twice with a provider-class error, test/fallback-1 (same backend)
  // is skipped and the chain reports exhausted with the concrete class.
  const exhausted: AuditorFallbackExhaustionInfo[] = [];
  const calls: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/fallback-1", model: { provider: "test", id: "fallback-1" }, via: "fallback-pin" },
  ], async (candidate) => {
    calls.push(candidate.ref!);
    return result({ error: "503 provider unavailable", model: candidate.ref });
  }, {
    sleep: async () => {},
    shouldRetry: () => true,
    onCandidateExhausted: (_candidate, _error, info) => { exhausted.push(info); },
  });

  assert.deepEqual(calls, ["test/primary", "test/primary"], "the same-backend rung is skipped, not launched");
  assert.equal(outcome.result.fallbackExhausted, true);
  assert.equal(outcome.result.infrastructureClass, "provider");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]?.nextCandidateRef, undefined);
  assert.deepEqual(exhausted[0]?.attemptedRefs, ["test/primary", "test/fallback-1"]);
});

test("cross-provider rungs still walk the full chain", async () => {
  // The collapse is provider-scoped: a dead backend never skips a rung on a
  // different backend.
  const exhausted: AuditorFallbackExhaustionInfo[] = [];
  const calls: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "a/primary", model: { provider: "a", id: "primary" }, via: "setting" },
    { ref: "b/fallback-1", model: { provider: "b", id: "fallback-1" }, via: "fallback-pin" },
  ], async (candidate) => {
    calls.push(candidate.ref!);
    return result({ error: "503 provider unavailable", model: candidate.ref });
  }, {
    sleep: async () => {},
    shouldRetry: () => true,
    onCandidateExhausted: (_candidate, _error, info) => { exhausted.push(info); },
  });

  assert.deepEqual(calls, ["a/primary", "a/primary", "b/fallback-1", "b/fallback-1"]);
  assert.equal(outcome.result.fallbackExhausted, true);
  assert.equal(outcome.result.infrastructureClass, "provider");
  assert.equal(exhausted.length, 2);
  assert.equal(exhausted[0]?.nextCandidateRef, "b/fallback-1");
  assert.equal(exhausted[1]?.nextCandidateRef, undefined);
  assert.deepEqual(exhausted[1]?.attemptedRefs, ["a/primary", "b/fallback-1"]);
});

test("cursor persistence failure fails closed before a retry or fallback", async () => {
  const calls: string[] = [];
  const waits: number[] = [];
  const outcome = await runAuditorFallbackWithPolicy([
    { ref: "test/primary", model: { provider: "test", id: "primary" }, via: "setting" },
    { ref: "test/fallback-1", model: { provider: "test", id: "fallback-1" }, via: "fallback-pin" },
  ], async (candidate) => {
    calls.push(candidate.ref!);
    return result({ error: "503 provider unavailable", model: candidate.ref });
  }, {
    sleep: async (ms) => { waits.push(ms); },
    shouldRetry: () => true,
    onRetry: () => false,
  });

  assert.deepEqual(calls, ["test/primary"]);
  assert.deepEqual(waits, []);
  assert.equal(outcome.result.error, "auditor recovery cursor persistence failed");
  assert.equal(outcome.result.fallbackExhausted, undefined);
  assert.equal(outcome.result.infrastructureClass, "transport");
});

test("auditor and drafter source paths name the shared policy primitives", () => {
  const processSource = fs.readFileSync("extensions/goal-loop-auditor-process.ts", "utf8");
  assert.match(processSource, /classifyMainModelFailure/);
  assert.match(processSource, /nextUntriedModelRef/);
  assert.match(processSource, /mainModelFailureDelayMs/);
  assert.match(processSource, /new ModelSelector/);

  const hooksSource = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.match(hooksSource, /runAuditorFallbackWithPolicy/);
  assert.doesNotMatch(hooksSource, /runWithInfraRetry\(/);

  const drafterSource = fs.readFileSync("extensions/drafter-model.ts", "utf8");
  assert.match(drafterSource, /normalizeMainModelFallbackRefs/);
  assert.match(drafterSource, /new ModelSelector/);
});

