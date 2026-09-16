// pi-goal-list-loop-audit — v0.28.1
// tests/stale-interrupt-resume.test.ts
//
// Pins the v0.28.1 stale-interruption rework (audit findings S1–S4, E6, T1 —
// audit/WRONG-OR-NOT-PREMIUM-2026-07-28.md Stream 1):
//   S1  resume-in-stale-session zombie: cmdResume persisted status="active"
//       and claimed "Resumed goal", then the stale send failure re-paused
//       (or worse, left an active-in-ledger/dead-in-process zombie).
//   S2  stale-paused goals never auto-resumed: goStaleTerminal persisted
//       status="paused" while the session_start restore gate only
//       auto-resumes ACTIVE goals → manual /goal resume forever.
//   S3  no staleness probe at command entry: "created — starting now" and
//       "Resumed goal" were lies in doomed processes.
//   E6  the drafting-seed send failed SILENTLY (/goal + Enter → nothing).
//   T1  a stale Confirm dialog was reported as "Draft rejected by the user".
// Fix shape: goals STAY ACTIVE with an interruptedAt/interruptedReason
// marker (sendContinuation's extensionApiStale guard stops sends in the
// doomed process; the next fresh session auto-resumes and clears the
// marker); entry probes via the side-effect-free getSessionName() →
// pi assertActive() throw; honest messaging everywhere.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const HEARTBEAT_SRC = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
const DISPLAY = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
const SCHEMA = fs.readFileSync("schemas/goal.schema.json", "utf-8");

test("Goal type + schema carry the interrupt marker fields", () => {
  assert.match(CORE, /interruptedAt\?: string;/);
  assert.match(CORE, /interruptedReason\?: string;/);
  assert.match(SCHEMA, /"interruptedAt": \{ "type": "string" \}/);
  assert.match(SCHEMA, /"interruptedReason": \{ "type": "string" \}/);
});

test("S3 probe: side-effect-free getSessionName() probe caches the positive", () => {
  assert.match(SRC, /function probeExtensionApiStale\(\): boolean/);
  assert.match(SRC, /extensionApi\.getSessionName\(\);/);
  assert.match(SRC, /if \(isStaleApiError\(err\)\) extensionApiStale = true;/);
});

test("S3 warn helper: honest 'state is safe' messaging + ledger", () => {
  assert.match(SRC, /function warnIfStaleAtEntry\(ctx: ExtensionContext, what: string\): boolean/);
  assert.match(SRC, /State is safe in \.pi-glla\/\. Use \/new to create a fresh context; its session_start will resume it\. If \/new does not create one, restart pi normally and restore the saved work\./);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "extension_api_stale", \{ where: `entry probe \(\$\{what\}\)` \}\)/);
});

test("S3: probes wired at cmdSet / cmdResume / cmdList / propose_goal_draft entry", () => {
  assert.match(CMDS, /const staleEntry = warnIfStaleAtEntry\(ctx, "\/goal"\);/, "cmdSet creation entry");
  // v0.34.51: cmdResume probes with the mode-correct command root (resumeCommand
  // = activeGoalCommand("resume") -> "/goal resume" or "/list resume").
  assert.match(CMDS, /const resumeCommand = activeGoalCommand\("resume"\);/ , "mode-correct resume command");
  assert.ok(
    (CMDS.match(/const staleEntry = warnIfStaleAtEntry\(ctx, resumeCommand\);/g) ?? []).length >= 2,
    "cmdResume entry probe (audit-resume + paused-goal paths)",
  );
  assert.match(CMDS, /warnIfStaleAtEntry\(ctx, "\/list"\);/, "cmdList entry");
  assert.match(SRC, /warnIfStaleAtEntry\(liveCtx, "goal drafting"\);/, "propose_goal_draft entry");
});

test("S3: stale creation marks the interrupt and tells the truth (no 'starting now' lie)", () => {
  assert.match(CMDS, /updateGoal\(\{ interruptedAt: nowIso\(\), interruptedReason: "created in a stale session" \}, ctx\)/);
  assert.match(CMDS, /safe in \.pi-glla\/, but this stale process can't send continuations\. Use \/new to create a fresh context; its session_start will resume it\. If \/new does not create one, restart pi normally/);
});

test("S1: stale resume persists active+marker, skips the misleading notify and the doomed send", () => {
  assert.match(CMDS, /interruptedReason: "resumed in a stale session"/);
  assert.match(CMDS, /if \(staleEntry\) return;/);
});

test("S2: restore gate clears the marker on auto-resume and names the recovery", () => {
  assert.match(SRC, /const wasInterrupted = !!state\.goal\.interruptedAt;/);
  assert.match(SRC, /updateGoal\(\{ interruptedAt: undefined, interruptedReason: undefined \}, ctx\)/);
  assert.match(SRC, /auto-resumed after the stale-handle interrupt/);
});

test("S2 (v0.28.21): the 0.28.3 interrupt exemption is SUPERSEDED — only autoresume=on auto-resumes", () => {
  // Default flipped to hold-everything: interrupted goals hold like any
  // other; the marker is cleared only inside the autoresume=on path.
  assert.match(SRC, /if \(autoResume\) \{/);
  assert.doesNotMatch(SRC, /autoResume \|\| \(wasInterrupted && autoResumeSetting !== false\)/);
  // v0.29.5: global-only. v0.35.23: consent reads the RAW global setting —
  // the aggressive-mode coercion used to flip the documented hold-by-
  // default into stock auto-resume on every load.
  assert.match(SRC, /const autoResumeSetting = loadGlobalSettings\(\)\.autoResume;/);
});

test("S1/S2: widget surfaces the interrupt on ACTIVE goals", () => {
  assert.match(DISPLAY, /if \(g\.interruptedAt\)/);
  assert.match(DISPLAY, /⚠ interrupted — stale handle · \/new \(or a fresh session_start\) rebinds/);
});

test("E6: drafting-seed send failure is loud and stale-aware (was silent)", () => {
  assert.match(SRC, /appendLedger\(ctx\.cwd, "extension_api_stale", \{ where: "startDrafting seed" \}\)/);
  assert.match(SRC, /can't start the drafting interview — this session's extension handle is stale/);
  assert.match(SRC, /couldn't start the drafting interview \(\$\{err instanceof Error \? err\.message : String\(err\)\}\) — try again\./);
});

test("T1: stale Confirm is NOT a rejection — both single and batch paths", () => {
  const honest = /This is NOT a rejection — do NOT refine or re-propose\. Wait for a fresh session_start, then re-run the drafting flow\./;
  const matches = SRC.match(new RegExp(honest.source, "g")) ?? [];
  assert.equal(matches.length, 2, "single + batch confirm paths");
  assert.match(SRC, /appendLedger\(liveCtx\.cwd, "extension_api_stale", \{ where: "draft confirm" \}\)/);
  assert.match(SRC, /appendLedger\(liveCtx\.cwd, "extension_api_stale", \{ where: "batch confirm" \}\)/);
});

test("v0.28.27: stale handle silences ALL stall machinery — refiring into a dead process misleads, and the stall escalation would PAUSE an interrupted goal (killing restart auto-resume)", () => {
  // junk-runner field observation: compaction replaced the session mid-goal;
  // the footer promised "auto-resumes on pi restart" (a lie under
  // hold-everything; v0.29.11 names /glla resume instead) while the heartbeat
  // kept printing "re-firing continuation (stall 4/5)" into a process where
  // sends can never land — marching toward a stall-escalation pause that
  // would silently cancel that promise (paused restores load-held).
  const tick = HEARTBEAT_SRC.indexOf("function heartbeatTick(): void {");
  const knownCtx = HEARTBEAT_SRC.indexOf("const knownCtx = flags.lastCtx;", tick);
  // v0.34.62: the heartbeat probe is the RAW non-caching form (debounced)
  // — single transient failures must not park a live session; consecutive
  // failures still reach the terminal before any stall machinery.
  const probe = HEARTBEAT_SRC.indexOf("const rawApiStale = probeExtensionApiStaleRaw();", knownCtx);
  const stale = HEARTBEAT_SRC.indexOf('if (knownCtx && !absorbStaleIfSuperseded(knownCtx)) goStaleTerminal(knownCtx, "heartbeat probe");', probe); // v0.34.48: probe the API before freshCtx() can discard the orphan context.
  const grace = HEARTBEAT_SRC.indexOf("if (Date.now() < flags.compactionGraceUntil) return;", stale);
  const watchdog = HEARTBEAT_SRC.indexOf("pending-latch watchdog");
  assert.ok(tick > 0 && knownCtx > tick && probe > knownCtx && stale > probe && grace > stale, "stale bail inside heartbeatTick precedes the grace gate");
  assert.ok(stale < HEARTBEAT_SRC.indexOf("const fire = shouldHeartbeatRefire({"), "stale bail precedes the refire path");
  assert.ok(stale < watchdog, "stale bail precedes the latch watchdog too");
});

test("v0.28.27/0.29.8: /goal verify (renamed from /goal audit) — manual auditor invocation with a synthesized claim, wired into the pendingCompletion machinery", () => {
  // Route: "verify" is an exact sub; "audit" moved to ARG subs (v0.29.8 —
  // /goal audit [focus] is now the one-shot project audit).
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  assert.match(CORE, /"decide", "verify"\]/);
  assert.ok(CORE.includes('"audit", "tweak", "archive", "start"'));
  // Dispatch: guards (no goal, audit in flight), seeds the synthesized
  // claim, ledgered, delegates to the shared engine with origin "manual".
  assert.match(CMDS, /if \(route\.name === "verify"\) \{/);
  assert.match(CMDS, /No active goal — \/goal verify needs a goal to verify\./);
  assert.match(CMDS, /Manual audit requested by the user via \/goal verify \(no agent completion claim\)/);
  assert.match(CMDS, /appendLedger\(ctx\.cwd, "manual_audit_requested", \{ goalId: state\.goal\.id \}\);/);
  assert.match(CMDS, /void retryStoredCompletionAudit\("manual"\);/);
  // Engine parametrized: origin flows into ledger + notifies + archive reason.
  assert.match(SRC, /origin: CompletionAuditOrigin = "provider-retry"/);
  assert.match(SRC, /via: origin === "manual" \? "manual-audit" : origin === "agent" \? "agent-audit" : "provider-retry-direct-audit"/);
  // v0.34.25: the shared completion engine annotates manual,
  // recovery, provider-retry, and model-fallback approval paths in one template.
  assert.match(SRC, /const approvalVia = `\$\{origin === "manual" \? " on \/goal verify" : origin === "agent" \? " after an agent resume" : origin === "session-recovery" \? " after session recovery" : " on the provider retry"\}\$\{fallbackUsed/);
  assert.ok(SRC.includes("Manual /goal verify — starting the detached auditor now"));
});

test("v0.29.8: /goal audit [focus] — the one-shot project audit; /glla status — the unified view", () => {
  // The canned target: triage law (FIX is not a decision; DECIDE is
  // presented, untouched), shared findings file, explicit Done-when.
  const FOREVER = fs.readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.ok(FOREVER.includes("export function projectAuditTarget(focus?: string): string {"));
  assert.ok(FOREVER.includes('whether to fix these is NOT a decision'));
  assert.ok(FOREVER.includes('"- [?] DECIDE:'));
  assert.ok(FOREVER.includes("never silently turn a DECIDE into a fix"));
  assert.ok(FOREVER.includes("Done when: the audit pass is complete, every new FIX finding has a fix commit"));
  // Dispatch: /goal audit goes through cmdSet with skipDraft (explicit
  // command → starts immediately), focus flows through.
  assert.ok(CMDS.includes("return cmdSet(projectAuditTarget(route.rest || undefined), ctx, true);"));
  // /glla status aggregates the ONE state + pointers.
  assert.ok(CMDS.includes("function cmdGllaStatus(ctx: ExtensionContext): void {"));
  assert.ok(CMDS.includes("decision pending (${g.pauseOptions.length} options) — ${activeGoalSurfaceCommand(\"decide\")}"));
  // v0.34.51: the /glla status decision line is mode-aware (goal vs list policy).
  assert.ok(CMDS.includes("deep: /goal status · /list · /loop status · /glla stats · /glla audits · /glla log"));
  assert.ok(CMDS.includes('if (/^status(?:\\s|$)/.test(trimmed)) {'));
});

// ---------- v0.34.2: manual resume clears the marker too ----------

test("v0.34.2: cmdResume clears interruptedAt/interruptedReason on a fresh-session resume", () => {
  // The autoResume restore path (:6227-ish) was the ONLY clear-site — with
  // autoresume=off a manually resumed goal kept the red interrupted banner
  // forever while actively working (hegemon, 2026-08-01).
  const resumeCall = CMDS.match(/updateGoal\(\{ status: "active", pauseReason: undefined[^\n]*\n?/);
  assert.ok(resumeCall, "cmdResume updateGoal call found");
  assert.match(resumeCall[0], /interruptedAt: undefined, interruptedReason: undefined/, "manual resume clears the marker");
  // …and the stale-session re-mark still wins when the resume itself is stale.
  assert.ok(
    resumeCall[0].indexOf("interruptedAt: undefined") < resumeCall[0].indexOf('interruptedReason: "resumed in a stale session"'),
    "the staleEntry re-mark spreads AFTER the clear, so it still wins",
  );
});

// ---------- v0.34.7: stale-ctx crash guard + re-kick marker clear ----------

test("v0.34.7: safeSteerUser wraps every orchestrator sendUserMessage (darklord crash)", () => {
  const g = readGoalRuntimeSource();
  assert.match(g, /function safeSteerUser\(ctx: ExtensionContext, text: string\): boolean/, "the helper exists");
  // The helper's OWN send line must be the real API call, not a self-call
  // (a regex conversion once rewrote it into infinite recursion — every
  // steer silently no-opped; caught by the /goal decide behavioral test).
  const helper = g.slice(g.indexOf("function safeSteerUser"), g.indexOf("function safeSteerUser") + 900);
  assert.match(helper, /extensionApi\?\.sendUserMessage\(text, \{ deliverAs: ctx\.isIdle\(\)/, "the helper sends for real");
  assert.ok(!/safeSteerUser\(ctx, text\)/.test(helper), "no recursive self-call inside the helper");
  assert.match(helper, /probeExtensionApiStale\(\)/, "probe before send");
  assert.match(helper, /steer_skipped_stale/, "skips are ledger-visible");
  // No raw orchestrator-path sends remain outside the helper.
  const raw = [...g.matchAll(/extensionApi\?\.sendUserMessage\(/g)].length;
  assert.equal(raw, 1, `exactly one raw sendUserMessage (inside the helper), got ${raw}`);
});

test("v0.34.7: the fan-out float carries a catch (rejection ≠ process exit)", () => {
  const g = readGoalRuntimeSource();
  assert.match(g, /void fanOutListAuditFindings\(fanoutCwd, fanoutGeneration\)\.catch\(/);
  assert.match(g, /list_audit_fanout_error/);
});

test("v0.34.7: re-kick clears the stale-handle marker (banner must not survive a working session)", () => {
  const g = fs.readFileSync(path.resolve("extensions/goal-commands.ts"), "utf-8");
  const gllaResume = g.slice(g.indexOf("async function cmdGllaResume"));
  const rek = gllaResume.indexOf('g.status === "active"');
  const clear = gllaResume.indexOf("updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx)", rek);
  const notify = gllaResume.indexOf("ACTIVE but idle", rek);
  assert.ok(rek > -1 && clear > rek && clear < notify, "cmdGllaResume re-kick clears interruptedAt before notifying");
  const cmdResume = g.slice(g.indexOf("async function cmdResume"), g.indexOf("async function cmdCancel"));
  const rek2 = cmdResume.indexOf('state.goal.status === "active"');
  const clear2 = cmdResume.indexOf("updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx)", rek2);
  assert.ok(rek2 > -1 && clear2 > rek2, "cmdResume re-kick clears interruptedAt too");
});
