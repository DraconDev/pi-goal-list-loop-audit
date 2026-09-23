// pi-goal-list-loop-audit — v0.34.72
// tests/vision-assist.test.ts
//
// note.md 2026-08-07: "the agent is too eager when couldnt see it tried to
// use expensive mdoels. we need to special a vision setting where it called
// another model or cli like mmx vision to see if stuck. but not just this
// we need to specify that it cant be too eager to switch only preapproved."
//
// Contract: documented vision-assist guidance prefers the current model's
// native image capability, never assumes an external CLI, and permits a
// confirmed optional provider only as a fallback. Suite green + tsc clean.
//
// Pinned here: (a) VISION_ASSIST_GUIDANCE (the single source of truth) carries
// native-first guidance, optional MMX wording, and the preapproval rule; (b)
// docs/VISION-ASSIST.md documents the same; (c) the pure router defaults to
// the current model, fails closed when native vision is known unavailable,
// uses confirmed MMX only when explicitly available, and requires explicit
// opt-in for model switches; (d) the preapproval gate itself; (e)
// continuation prompts carry the directive by default and drop it when
// visionAssist is off; (f) a forbidden switch observed at runtime records
// the vision_assist routing entry (off → no entry).

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { readState, isForbiddenModel, DEFAULT_FORBIDDEN_MODELS } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession, __testOnlySetLastModelRef } from "../extensions/loops/goal.js";
import {
  VISION_ASSIST_DEFAULT,
  VISION_ASSIST_GUIDANCE,
  visionDescribeCommand,
  routeVisionCheck,
  visionAssistLedger,
} from "../extensions/vision-assist.js";
import {
  MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick,
  type MockCtx,
} from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

function readLedger(cwd: string): Array<{ type: string; value: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sentContinuations(): string[] {
  return pi.sent
    .map((s) => s.message as { content?: unknown })
    .filter((m) => typeof m?.content === "string" && (m.content as string).includes("[GOAL CHECKPOINT"))
    .map((m) => m.content as string);
}

afterEach(() => {
  __testOnlyResetOwnerSession();
});

// ── (a) the guidance block ─────────────────────────────────────────────

test("VISION_ASSIST_GUIDANCE prefers native vision without assuming MMX", () => {
  assert.equal(VISION_ASSIST_DEFAULT, true, "the setting defaults ON");
  assert.match(VISION_ASSIST_GUIDANCE, /native image capability/i);
  assert.match(VISION_ASSIST_GUIDANCE, /mmx vision describe --image <path-or-url>/);
  assert.match(VISION_ASSIST_GUIDANCE, /optional/i);
  assert.match(VISION_ASSIST_GUIDANCE, /do NOT switch models/i);
  assert.match(VISION_ASSIST_GUIDANCE, /do NOT assume MMX/i);
  assert.match(VISION_ASSIST_GUIDANCE, /preapproved/i, "the preapproval rule is in the guidance");
  assert.match(VISION_ASSIST_GUIDANCE, /forbiddenModels/, "the gate is named");
  assert.match(VISION_ASSIST_GUIDANCE, /defaults to empty/i, "the empty default is truthful");
  assert.match(VISION_ASSIST_GUIDANCE, /gpt-5\.5|sonnet|opus/, "explicit policy examples remain named");
  assert.match(VISION_ASSIST_GUIDANCE, /forbidden_model_switch/, "violations are ledgered");
  assert.match(VISION_ASSIST_GUIDANCE, /vision_assist/, "the routing entry is ledgered");
  assert.doesNotMatch(VISION_ASSIST_GUIDANCE, /Prefer mmx vision for every vision check/i);
});

test("docs/VISION-ASSIST.md documents native-first guidance and the preapproval gate", () => {
  const doc = fs.readFileSync(path.resolve("docs", "VISION-ASSIST.md"), "utf-8");
  assert.match(doc, /native image capability/i);
  assert.match(doc, /mmx vision describe --image <path-or-url>/);
  assert.match(doc, /optional/i);
  assert.match(doc, /preapproval gate/i);
  assert.match(doc, /forbiddenModels/);
  assert.match(doc, /Default `forbiddenModels` is empty/i, "the documented default is truthful");
  assert.match(doc, /visionAssist/, "the setting is documented");
  assert.match(doc, /`\/glla`\s+→\s+\*\*Keep-going\*\*\s+→\s+\*\*Vision assist\*\*/, "the documented navigation matches the settings menu");
  assert.match(doc, /\*\*Forbidden models\*\*/, "the forbidden-model editor is documented as a settings row");
  assert.doesNotMatch(doc, /\/glla\s+(?:forbiddenModels|visionAssist)=/, "invalid argument-style /glla syntax is not documented");
  assert.match(doc, /vision_assist/, "the ledger type is documented");
  assert.match(doc, /Never invent/i);
});

// ── (c) the command builder + pure router ──────────────────────────────

test("visionDescribeCommand builds the exact mmx call", () => {
  const cmd = visionDescribeCommand("/home/dracon/Pictures/Screenshots/Screenshot_20260806_115855.png", "Is there an error dialog?");
  assert.match(cmd, /^mmx vision describe --image '/);
  assert.ok(cmd.includes("/home/dracon/Pictures/Screenshots/Screenshot_20260806_115855.png"));
  assert.ok(cmd.includes("--prompt 'Is there an error dialog?'"));
  assert.ok(cmd.includes("--quiet"));
  const bare = visionDescribeCommand("/tmp/shot.png");
  assert.ok(bare.includes("Describe what is shown in the image."), "a default question is provided");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glla-vision-quote-"));
  try {
    const bin = path.join(tmp, "bin");
    const argsFile = path.join(tmp, "args");
    const pwn = path.join(tmp, "pwn");
    const promptPwn = path.join(tmp, "prompt-pwn");
    fs.mkdirSync(bin);
    const fakeMmx = path.join(bin, "mmx");
    fs.writeFileSync(fakeMmx, "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$MMX_ARGS_FILE\"\n", { mode: 0o700 });
    const image = `x'; touch ${pwn}; #`;
    const question = `$(touch ${promptPwn}); 'quoted'\nnext`;
    execFileSync("bash", ["-c", visionDescribeCommand(image, question)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MMX_ARGS_FILE: argsFile },
      encoding: "utf8",
    });
    assert.equal(fs.existsSync(pwn), false, "path metacharacters stay inside one argv value");
    assert.equal(fs.existsSync(promptPwn), false, "prompt substitution never executes");
    const args = fs.readFileSync(argsFile).toString("utf8").split("\0");
    assert.equal(args[args.length - 1], "", "nul-separated argv has a trailing sentinel");
    assert.equal(args[3], image, "image path arrives as one literal argument");
    assert.equal(args[5], question, "question arrives as one literal argument");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("routeVisionCheck: a forbidden target stays on the current model", () => {
  const forbidden = ["gpt-5.5", "sonnet", "opus"];
  const r = routeVisionCheck({ targetModelRef: "openai/gpt-5.5", forbiddenModels: forbidden });
  assert.equal(r.route, "main-model");
  assert.equal((r as { blockedSwitch?: string }).blockedSwitch, "openai/gpt-5.5");
});

test("routeVisionCheck: confirmed MMX is an optional external fallback", () => {
  const r = routeVisionCheck({
    imagePath: "/tmp/ui.png",
    question: "What state is the UI in?",
    mainModelVisionCapable: false,
    externalVisionProvider: "mmx",
    externalVisionAvailable: true,
  });
  assert.equal(r.route, "mmx-vision");
  assert.equal((r as { provider: string }).provider, "mmx");
  assert.ok((r as { command: string }).command.includes("/tmp/ui.png"));
});

test("routeVisionCheck: native vision is the default and no external tool is assumed", () => {
  const r = routeVisionCheck({ imagePath: "/tmp/shot.png" });
  assert.equal(r.route, "main-model");
  const noImage = routeVisionCheck({});
  assert.equal(noImage.route, "main-model");
});

test("routeVisionCheck: known unavailable native vision fails closed", () => {
  const r = routeVisionCheck({ mainModelVisionCapable: false, imagePath: "/tmp/shot.png" });
  assert.equal(r.route, "unavailable");
  assert.match((r as { reason: string }).reason, /no external vision provider was confirmed/);
});

test("routeVisionCheck: model switch requires explicit opt-in", () => {
  const r = routeVisionCheck({ targetModelRef: "minimax/minimax-m3" });
  assert.equal(r.route, "main-model");
  const optedIn = routeVisionCheck({ targetModelRef: "minimax/minimax-m3", allowModelSwitch: true });
  assert.equal(optedIn.route, "model-switch");
  assert.equal((optedIn as { ref: string }).ref, "minimax/minimax-m3");
});

// ── (d) the preapproval gate itself ────────────────────────────────────

test("isForbiddenModel: v0.34.115 default is empty — no model is forbidden by default", () => {
  assert.equal(DEFAULT_FORBIDDEN_MODELS.length, 0, "v0.34.115: empty default — no opinionated ban list ships");
  assert.equal(isForbiddenModel("openai/gpt-5.5", DEFAULT_FORBIDDEN_MODELS), false, "gpt-5.5 allowed by default");
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5", DEFAULT_FORBIDDEN_MODELS), false, "sonnet allowed by default");
  assert.equal(isForbiddenModel("anthropic/claude-opus-4-5", DEFAULT_FORBIDDEN_MODELS), false, "opus allowed by default");
  assert.equal(isForbiddenModel("minimax/minimax-m3", DEFAULT_FORBIDDEN_MODELS), false, "session model always preapproved");
  // explicit lists still gate:
  const explicit = ["gpt-5.5", "sonnet", "opus"];
  assert.equal(isForbiddenModel("openai/gpt-5.5", explicit), true);
  assert.equal(isForbiddenModel("anthropic/claude-sonnet-4-5", explicit), true);
  assert.equal(isForbiddenModel("anthropic/claude-opus-4-5", explicit), true);
});

test("visionAssistLedger builds a native-model audit payload", () => {
  const forbidden = ["gpt-5.5", "sonnet", "opus"];
  const r = routeVisionCheck({ targetModelRef: "openai/gpt-5.5", imagePath: "/tmp/ui.png", forbiddenModels: forbidden });
  const v = visionAssistLedger(r, { targetModelRef: "openai/gpt-5.5", imagePath: "/tmp/ui.png", forbiddenModels: forbidden }, "2026-08-07T00:00:00.000Z");
  assert.equal(v.route, "main-model");
  assert.equal(v.blockedSwitch, "openai/gpt-5.5");
  assert.equal(v.imagePath, "/tmp/ui.png");
  assert.equal(v.command, undefined, "native routing does not invent an external command");
  assert.equal(v.at, "2026-08-07T00:00:00.000Z");
});

// ── (e) continuation wiring ────────────────────────────────────────────

async function continuationFixture(extra: Record<string, unknown> = {}) {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "ship vision assist" }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  return { cwd, ctx };
}

test("continuation prompts carry native-first VISION-ASSIST guidance by default", async () => {
  const { cwd } = await continuationFixture();
  const conts = sentContinuations();
  assert.ok(conts.length >= 1, "a continuation was sent");
  const last = conts.at(-1)!;
  assert.match(last, /VISION-ASSIST/);
  assert.match(last, /native image capability/i);
  assert.match(last, /do NOT assume MMX/i);
  assert.match(last, /preapproved/);
  void cwd;
});

test("visionAssist off → the directive is dropped from continuation prompts (gate still ships)", async () => {
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  // project-scoped off — hermetic per test (global default stays on)
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ visionAssist: false }));
  seedState(cwd, { goal: seedGoal({ policy: "goal", status: "active", objective: "ship vision assist" }) });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const conts = sentContinuations();
  assert.ok(conts.length >= 1, "a continuation was sent");
  assert.ok(!conts.at(-1)!.includes("VISION-ASSIST"), "no vision directive when disabled");
  void ctx;
});

// ── (f) runtime ledger wiring ──────────────────────────────────────────

test("a forbidden switch at runtime records the vision_assist routing entry", async () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  // v0.34.115: default forbidden list is empty; tests must declare an explicit one.
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ forbiddenModels: ["gpt-5.5", "sonnet", "opus"] }));
  __testOnlySetLastModelRef(undefined);
  const ctx = ownerCtx(cwd);
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-5.5" }, previousModel: { provider: "minimax", id: "minimax-m3" }, source: "set" },
    ctx,
  );
  const forbidden = readLedger(cwd).filter((e) => e.type === "forbidden_model_switch");
  assert.equal(forbidden.length, 1, "the gate fired");
  assert.equal(forbidden[0]!.value.to, "openai/gpt-5.5");
  const va = readLedger(cwd).filter((e) => e.type === "vision_assist");
  assert.equal(va.length, 1, "the routing entry landed");
  assert.equal(va[0]!.value.route, "main-model");
  assert.equal(va[0]!.value.blockedSwitch, "openai/gpt-5.5");
  assert.equal(va[0]!.value.reason, "forbidden_model_switch");
});

test("visionAssist off → the forbidden switch records no vision_assist entry (gate still fires)", async () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ visionAssist: false, forbiddenModels: ["gpt-5.5", "sonnet", "opus"] }));
  __testOnlySetLastModelRef(undefined);
  const ctx = ownerCtx(cwd);
  await pi.fire(
    "model_select",
    { model: { provider: "openai", id: "gpt-5.5" }, previousModel: { provider: "minimax", id: "minimax-m3" }, source: "set" },
    ctx,
  );
  const forbidden = readLedger(cwd).filter((e) => e.type === "forbidden_model_switch");
  assert.equal(forbidden.length, 1, "the gate still fired");
  assert.equal(readLedger(cwd).filter((e) => e.type === "vision_assist").length, 0, "no vision routing entry when disabled");
});
