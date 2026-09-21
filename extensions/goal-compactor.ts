// Emergency compactor handoff (v0.38.10).
//
// Fires once per starvation episode, from the agent_end refuse path: resolve
// a compactor model (chain → registry plan B → skip), spawn the tiny
// prompt-in/text-out worker over a bounded disk-state packet, persist the
// brief, and page. The brief NEVER touches the transcript — the worker only
// ever sees the packet the parent composes from durable state.
//
// Callers inject notify/page (runtime-globals guidance: new state travels by
// dependency interface, not another ambient slot). Spawning is injectable so
// behavioral tests never fork a process.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  appendLedger,
  auditVerdictLabel,
  findNextPendingTask,
  ledgerPath,
  piGlaDir,
  readState,
} from "./goal-loop-core.js";
import { loadGlobalSettings, type Settings } from "./goal-settings.js";
import { PLAN_B_MAX_ATTEMPTS, resolveCompactorModel } from "./compactor-model.js";

/** Hard cap on the persisted brief: a handoff, not a transcript. */
export const COMPACTOR_BRIEF_MAX_CHARS = 2000;
/** Packet budget into the worker: the full brief source, bounded. */
export const COMPACTOR_PACKET_MAX_CHARS = 6000;
/** Worker wall clock: a brief is one completion, not an agentic loop. */
export const COMPACTOR_TIMEOUT_MS = 180_000;
/** Audit 2026-09-06: grace between SIGTERM and SIGKILL when the worker
 * overruns its timeout — SIGTERM alone can leave a stuck child alive. */
export const COMPACTOR_KILL_GRACE_MS = 5_000;
/** The compactor reasons as little as possible: compression, not judgment. */
export const COMPACTOR_THINKING = "minimal";

export const COMPACTOR_SYSTEM_PROMPT =
  "You compress a goal-state packet into a handoff brief a FRESH session will read after /new. " +
  "Output ONLY the brief: sections Objective / Next task / Audit verdicts + required fixes / Watch-outs. " +
  "No preamble, no code, no tool calls.";

export function compactorBriefPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "handoff-brief.md");
}

/** Fallback need when usage is unreadable: assume a full 200k window. */
export const PLAN_B_FALLBACK_NEED = 200_000;

export function compactorJobDir(cwd: string, attemptId: string): string {
  return path.join(piGlaDir(cwd), "compactor-jobs", attemptId);
}

// One-shot per episode: the refuse transition false→true fires; the streak
// reset (window expiry / compaction) re-arms via the next shouldRefuse=false.
let compactorRefuseArmed = true;

/** Test-only reset for the episode one-shot. */
export function __testOnlyResetCompactor(): void {
  compactorRefuseArmed = true;
  testSpawnWorker = undefined;
}

type SpawnWorkerFn = NonNullable<CompactorDeps["spawnWorker"]>;
let testSpawnWorker: SpawnWorkerFn | undefined;

/** Test-only spawn override: behavioral tests never fork a process. */
export function __testOnlySetSpawnWorker(fn: SpawnWorkerFn | undefined): void {
  testSpawnWorker = fn;
}

/** Claim the refuse transition. True exactly once per starvation episode. */
export function claimCompactorRefuseTransition(shouldRefuseNow: boolean): boolean {
  if (!shouldRefuseNow) {
    compactorRefuseArmed = true;
    return false;
  }
  if (!compactorRefuseArmed) return false;
  compactorRefuseArmed = false;
  return true;
}

function slice(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Bounded brief-source packet from durable state only. Pure given inputs. */
export function buildBriefPacket(input: {
  objective?: string;
  status?: string;
  pendingTasks?: Array<{ id: string; title: string }>;
  lastVerdict?: { label: string; at: string; feedback?: string };
  ledgerTail?: string[];
}): string {
  const lines = ["[GOAL STATE PACKET — compress into a handoff brief]", ""];
  lines.push(`Objective: ${slice((input.objective ?? "").trim() || "(none)", 400)}`);
  lines.push(`Status: ${input.status ?? "unknown"}`);
  lines.push("");
  lines.push("Pending tasks:");
  const tasks = (input.pendingTasks ?? []).slice(0, 5);
  lines.push(...(tasks.length ? tasks.map((t) => `- \`${t.id}\` — ${slice(t.title, 200)}`) : ["(none)"]));
  lines.push("");
  lines.push(
    input.lastVerdict
      ? `Last audit: ${input.lastVerdict.label} (${input.lastVerdict.at})${input.lastVerdict.feedback ? ` — required fixes: ${slice(input.lastVerdict.feedback, 800)}` : ""}`
      : "Last audit: none yet",
  );
  lines.push("");
  lines.push("Recent ledger:");
  const tail = (input.ledgerTail ?? []).slice(-25);
  lines.push(...(tail.length ? tail.map((l) => `- ${slice(l, 160)}`) : ["(empty)"]));
  return slice(lines.join("\n"), COMPACTOR_PACKET_MAX_CHARS);
}

/** Read the persisted brief excerpt for resync/banner. Undefined when absent. */
export function readHandoffBriefExcerpt(cwd: string, maxChars = 600): string | undefined {
  try {
    const text = fs.readFileSync(compactorBriefPath(cwd), "utf-8").trim();
    if (!text) return undefined;
    return slice(text, maxChars);
  } catch {
    return undefined;
  }
}

export interface CompactorDeps {
  spawnWorker?: (script: string, jobDir: string, request: Record<string, unknown>) => Promise<{ ok: boolean; brief?: string; error?: string }>;
  settings?: Pick<Settings, "compactorModel" | "compactorModelFallbacks" | "forbiddenModels">;
  needTokens?: number;
  notify?: (message: string) => void;
  page?: (message: string) => void;
}

function defaultSpawnWorker(script: string, jobDir: string, request: Record<string, unknown>): Promise<{ ok: boolean; brief?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { ok: boolean; brief?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(path.join(jobDir, "request.json"), JSON.stringify(request));
    } catch (error) {
      done({ ok: false, error: `job write failed: ${error}` });
      return;
    }
    const child = nodeSpawn(process.execPath, [script, "--job-dir", jobDir], { stdio: "ignore" });
    const timer = setTimeout(() => {
      // Audit 2026-09-06: SIGTERM first, SIGKILL fallback — a stuck worker
      // must not survive the timeout as a zombie holding the job dir.
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => {
            try {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            } catch { /* already gone */ }
          }, COMPACTOR_KILL_GRACE_MS);
          killTimer.unref?.();
        }
      } catch { /* already gone */ }
      done({ ok: false, error: "compactor worker timed out" });
    }, (typeof request.timeoutMs === "number" && request.timeoutMs > 0 ? request.timeoutMs : COMPACTOR_TIMEOUT_MS) + 15_000);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, error: `worker spawn failed: ${error}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(fs.readFileSync(path.join(jobDir, "result.json"), "utf-8"));
        if (result && result.ok === true && typeof result.brief === "string" && result.brief.trim()) {
          done({ ok: true, brief: result.brief });
        } else {
          done({ ok: false, error: (result && result.error) || "worker produced no brief" });
        }
      } catch (error) {
        done({ ok: false, error: `result unreadable: ${error}` });
      }
    });
  });
}

function pruneOldJobDirs(cwd: string, now = Date.now()): void {
  try {
    const root = path.join(piGlaDir(cwd), "compactor-jobs");
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && now - stat.mtimeMs > 24 * 3_600_000) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  } catch { /* absent root is fine */ }
}

/**
 * Emergency entry: call on every starvation-refuse engage. Fires the
 * compactor exactly once per episode (the refuse transition), resolves the
 * model (chain → plan B → skip), persists the brief, notifies + pages.
 * Fire-and-forget safe: never throws.
 */
/** Durable one-shot marker — audit 2026-09-06: the in-memory refuse
 * transition is process-local, so a restart mid-episode would re-fire the
 * brief + page. The marker survives restarts; recovery (shouldRefuse=false)
 * removes it to re-arm the next episode. */
export function compactorFiredMarkerPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "compactor-fired.json");
}

export async function runEmergencyCompactorIfDue(
  ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "getContextUsage">,
  shouldRefuseNow: boolean,
  deps: CompactorDeps = {},
): Promise<{ fired: boolean; briefChars?: number; via?: string }> {
  if (!shouldRefuseNow) {
    claimCompactorRefuseTransition(false);
    try { fs.rmSync(compactorFiredMarkerPath(ctx.cwd), { force: true }); } catch { /* re-arm best effort */ }
    return { fired: false };
  }
  // Restart mid-episode: the marker says this episode already fired.
  // Converge the in-memory transition (claim it) and stay silent.
  let alreadyFired = false;
  try { alreadyFired = fs.existsSync(compactorFiredMarkerPath(ctx.cwd)); } catch { alreadyFired = false; }
  if (alreadyFired) {
    claimCompactorRefuseTransition(true);
    return { fired: false };
  }
  if (!claimCompactorRefuseTransition(true)) return { fired: false };
  try {
    fs.mkdirSync(piGlaDir(ctx.cwd), { recursive: true });
    fs.writeFileSync(compactorFiredMarkerPath(ctx.cwd), JSON.stringify({ at: new Date().toISOString() }) + "\n");
  } catch { /* marker write is best effort; in-memory one-shot still holds this process */ }
  try {
    return await runEmergencyCompactor(ctx, deps);
  } catch (error) {
    try {
      appendLedger(ctx.cwd, "compactor_failed", { error: String(error).slice(0, 300) });
    } catch { /* ledger best effort */ }
    return { fired: true };
  }
}

async function runEmergencyCompactor(
  ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "getContextUsage">,
  deps: CompactorDeps,
): Promise<{ fired: boolean; briefChars?: number; via?: string }> {
  const notify = deps.notify ?? (() => {});
  const page = deps.page ?? (() => {});
  const settings = deps.settings ?? loadGlobalSettings();
  let usageTokens: number | undefined;
  try {
    const tokens = ctx.getContextUsage?.()?.tokens;
    if (typeof tokens === "number") usageTokens = tokens;
  } catch { /* usage best effort */ }
  const need = deps.needTokens ?? (typeof usageTokens === "number" && usageTokens > 0 ? Math.ceil(usageTokens * 1.25) : PLAN_B_FALLBACK_NEED);
  const { candidates } = resolveCompactorModel(ctx as ExtensionContext, settings, need);
  if (candidates.length === 0) {
    // Resolver already ledgered compactor_skipped_no_model; the ladder covers.
    return { fired: true };
  }
  const workerScript = path.resolve(__dirname, "..", "scripts", "goal-compactor-worker.mjs");
  const spawnWorker = deps.spawnWorker ?? testSpawnWorker ?? defaultSpawnWorker;
  pruneOldJobDirs(ctx.cwd);
  const packet = buildPacketFromDisk(ctx.cwd);
  // Configured chain walks fully (0-10 parity); plan B gets at most two verified free swings.
  const attempts = [
    ...candidates.filter((c) => c.via === "configured"),
    ...candidates.filter((c) => c.via === "plan-b").slice(0, PLAN_B_MAX_ATTEMPTS),
  ];
  for (const candidate of attempts) {
    appendLedger(ctx.cwd, "compactor_spawned", { toRef: candidate.ref, via: candidate.via, needTokens: need });
    const attemptId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = compactorJobDir(ctx.cwd, attemptId);
    const result = await spawnWorker(workerScript, jobDir, {
      model: candidate.ref,
      thinking: COMPACTOR_THINKING,
      systemPrompt: COMPACTOR_SYSTEM_PROMPT,
      prompt: packet,
      timeoutMs: COMPACTOR_TIMEOUT_MS,
      cwd: ctx.cwd,
    });
    if (result.ok && result.brief?.trim()) {
      const brief = slice(result.brief.trim(), COMPACTOR_BRIEF_MAX_CHARS);
      try {
        fs.mkdirSync(piGlaDir(ctx.cwd), { recursive: true });
        fs.writeFileSync(compactorBriefPath(ctx.cwd), brief + "\n");
      } catch (error) {
        appendLedger(ctx.cwd, "compactor_failed", { toRef: candidate.ref, error: `brief persist failed: ${error}` });
        return { fired: true };
      }
      appendLedger(ctx.cwd, "compactor_brief_written", { toRef: candidate.ref, via: candidate.via, chars: brief.length });
      notify(`glla: handoff brief ready (via ${candidate.ref}) — /new, then resume picks up objective + next task + verdicts. Nothing is lost.`);
      page(`Goal parked over context — handoff brief ready (via ${candidate.ref}); /new then resume.`);
      return { fired: true, briefChars: brief.length, via: candidate.via };
    }
    appendLedger(ctx.cwd, "compactor_failed", { toRef: candidate.ref, via: candidate.via, error: (result.error ?? "no brief").slice(0, 300) });
  }
  return { fired: true };
}

function buildPacketFromDisk(cwd: string): string {
  let objective: string | undefined;
  let status: string | undefined;
  let pendingTasks: Array<{ id: string; title: string }> | undefined;
  let lastVerdict: { label: string; at: string; feedback?: string } | undefined;
  try {
    const s = readState(cwd);
    objective = s.goal?.objective;
    status = s.goal?.status;
    const tasks = s.goal?.taskList?.tasks ?? [];
    pendingTasks = tasks
      .filter((t) => (t.status ?? "pending") === "pending")
      .slice(0, 5)
      .map((t) => ({ id: t.id, title: t.title }));
    if (!pendingTasks.length) {
      const next = findNextPendingTask(tasks);
      if (next) pendingTasks = [{ id: next.id, title: next.title }];
    }
    const history = s.goal?.auditHistory ?? [];
    const last = history[history.length - 1];
    if (last) lastVerdict = { label: auditVerdictLabel(last), at: last.at, feedback: last.report };
  } catch { /* state best effort */ }
  let ledgerTail: string[] | undefined;
  try {
    const raw = fs.readFileSync(ledgerPath(cwd), "utf-8").split("\n").filter(Boolean);
    ledgerTail = raw.slice(-40).map((line) => {
      try {
        const evt = JSON.parse(line);
        const v = evt.value && typeof evt.value === "object" ? JSON.stringify(evt.value).slice(0, 100) : "";
        return `${evt.type}${evt.at ? ` @${evt.at}` : ""}${v ? ` ${v}` : ""}`;
      } catch {
        return line.slice(0, 120);
      }
    });
  } catch { /* ledger best effort */ }
  return buildBriefPacket({ objective, status, pendingTasks, lastVerdict, ledgerTail });
}
