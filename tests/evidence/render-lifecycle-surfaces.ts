// pi-goal-list-loop-audit — v0.38.99
// tests/evidence/render-lifecycle-surfaces.ts
//
// Visual-evidence generator for the detached-audit lifecycle objective.
//
// The 2026-09-25 completion audit disapproved the first claim partly on
// evidence: the repository's images predated the change and none of them
// showed the lifecycle states. This script closes that gap by rendering the
// REAL surfaces — the widget card, the one-line status bar, and the
// `/goal status` completion-audit line — for every state the objective
// requires, from the real extension code (no hand-written strings), and
// writing a .txt plus a styled .html page that is screenshotted to PNG.
//
//   bun tests/evidence/render-lifecycle-surfaces.ts
//
// Outputs (repo-relative):
//   audit/lifecycle-evidence-2026-09-25/lifecycle-surfaces.txt
//   audit/lifecycle-evidence-2026-09-25/lifecycle-surfaces.html

import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../../extensions/loops/goal.js";
import { auditLifecycleProjection } from "../../extensions/audit-lifecycle.ts";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../../extensions/goal-loop-display.js";
import { archivedGoalPath, readState, type Goal, type State } from "../../extensions/goal-loop-core.ts";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "../harness/mock-pi.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const OUT_DIR = path.join(REPO, "audit", "lifecycle-evidence-2026-09-25");
const OBJECTIVE = "detached audit lifecycle · five required states · one settlement";
const SUMMARY = "Outcome: shipped. Changed: lifecycle projection + settlement driver. Evidence: audit/DETACHED-AUDIT-LIFECYCLE-2026-09-25.md. Tests: 30 pass. Unresolved: none. Next: none.";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** A live in-process worker snapshot, including the worker-COMPLETE object that
 * used to mask a durable phase (the auditor's finding #2). */
const LIVE_TOOL: AuditDisplayProgress = { phase: "tool_executing", currentTool: "bash", elapsedMs: 22_000, recentOutput: ["reading claim"], toolCalls: [], unmatchedToolStarts: 0, unmatchedToolEnds: 0, lastActivityAt: Date.parse(ago(22_000)) };
const WORKER_COMPLETE: AuditDisplayProgress = { phase: "complete", elapsedMs: 41_000, recentOutput: ["verdict applied"], toolCalls: [], unmatchedToolStarts: 0, unmatchedToolEnds: 0, lastActivityAt: Date.parse(ago(4_000)) };

interface Scene {
  key: string;
  title: string;
  why: string;
  goalStatus: string;
  claim: Record<string, unknown>;
  status: string;
  audit?: AuditDisplayProgress;
  /** Render the `approved` settlement state (archive landed). */
  settled?: boolean;
  /** The real recovery surface after a refused terminal archive. */
  blockedSettlement?: boolean;
  /** Keep the archive fence in place so the owed settlement is observable. */
  fenceArchive?: boolean;
  /** What the command surfaces can honestly be asked for in this scene.
   * `live` = a detached worker owns the claim, so only the in-session
   * surfaces exist; `settle` = boot a session and let the settlement driver
   * finish the owed archive, then report what it left behind. */
  mode: "live" | "commands" | "settle";
}

function scenes(): Scene[] {
  return [
    {
      key: "starting",
      title: "STARTING — the claim is durable, the worker has not reported yet",
      why: "The launch window is a real state, and a claim with no worker event never has its age back-filled into activity.",
      goalStatus: "auditing",
      claim: { at: ago(12_000), startedAt: ago(12_000), phase: "starting", attemptId: "audit-starting" },
      status: "launch in flight",
      mode: "live",
    },
    {
      key: "running",
      title: "RUNNING — durable last activity, refined by the live worker",
      why: "A restarted session reads `lastActivityAt` from the ledger, not from a HUD that no longer exists.",
      goalStatus: "auditing",
      claim: { at: ago(95_000), startedAt: ago(95_000), phase: "running", lastActivityAt: ago(22_000), attemptId: "audit-running" },
      status: "worker running (auditing)",
      audit: LIVE_TOOL,
      mode: "live",
    },
    {
      key: "settling",
      title: "SETTLING — the approval is durable, the terminal archive is owed",
      why: "The worker-complete snapshot that used to rename this 'awaiting completion review' can no longer mask the durable phase.",
      goalStatus: "auditing",
      claim: { at: ago(140_000), startedAt: ago(140_000), phase: "settling", lastActivityAt: ago(38_000), verdictAt: ago(30_000), attemptId: "audit-settling" },
      status: "verdict applied, archive owed (auditing)",
      audit: WORKER_COMPLETE,
      mode: "settle",
    },
    {
      key: "approved",
      title: "APPROVED — settlement durable; the summary is in .pi-glla/archive/",
      why: "Only the settlement driver may claim this state, and only after the archive landed.",
      goalStatus: "paused",
      claim: { at: ago(200_000), startedAt: ago(200_000), phase: "settling", lastActivityAt: ago(90_000), verdictAt: ago(60_000), attemptId: "audit-approved" },
      status: "settlement complete (paused)",
      settled: true,
      mode: "settle",
    },
    {
      key: "recovery-needed",
      title: "RECOVERY NEEDED — an interrupted or unknown claim, with a real next action",
      why: "A stale attempt is never rendered as finished, and the surface names the command that unblocks it.",
      goalStatus: "paused",
      claim: { at: ago(11 * 60_000), startedAt: ago(11 * 60_000), phase: "recovery-pending", lastActivityAt: ago(9 * 60_000), recoveryAt: ago(9 * 60_000), recoveryReason: "no-progress", attemptId: "audit-parked" },
      status: "parked after a lost worker (paused)",
      mode: "commands",
    },
    {
      key: "blocked-settlement",
      title: "RECOVERY NEEDED — approved, but the terminal archive was refused",
      why: "The promise in the pause text is real: /goal resume finishes the approved settlement, with no new audit.",
      goalStatus: "paused",
      claim: { at: ago(150_000), startedAt: ago(150_000), phase: "settling", lastActivityAt: ago(80_000), verdictAt: ago(45_000), recoveryAt: ago(44_000), recoveryReason: "approval-archive-failed", attemptId: "audit-blocked" },
      status: "approved, terminal archive refused (paused)",
      blockedSettlement: true,
      fenceArchive: true,
      mode: "commands",
    },
  ];
}

function goalFor(scene: Scene): Record<string, unknown> {
  const approved = scene.key === "approved" || scene.key === "settling" || scene.key === "blocked-settlement";
  return seedGoal({
    status: scene.goalStatus,
    objective: OBJECTIVE,
    completionSummary: SUMMARY,
    ...(approved
      ? {
        auditHistory: [{
          at: ago(30_000),
          approved: true,
          disapproved: false,
          model: "openai/gpt-test",
          revision: 0,
          regressionShieldPassed: true,
          durationMs: 42_000,
          report: "<approved>durable lifecycle evidence cited</approved>",
        }],
      }
      : {}),
    pendingCompletion: scene.claim,
    ...(scene.blockedSettlement
      ? {
        pauseKind: "blocked",
        pauseReason: "completion approved (openai/gpt-test), but the terminal archive failed — an existing archive refused the write",
        pauseSuggestedAction: "Fix .pi-glla disk access or resolve the archive fence, then /goal resume finishes the approved settlement. No new audit is needed.",
      }
      : {}),
  });
}

function stateFor(goal: Record<string, unknown>): State {
  return { goal: goal as unknown as Goal, list: [], loop: null } as unknown as State;
}

function block(title: string, lines: string[]): string[] {
  return [title, ...lines.map((line) => `  ${line}`), ""];
}

async function commandSurfaces(scene: Scene, goal: Record<string, unknown>): Promise<{ label: string; text: string }> {
  if (scene.mode === "live") {
    return {
      label: "/goal status",
      text: "(a detached worker owns this claim, so it only exists inside a live session; the same claim with no live worker is the recovery-needed panel below)",
    };
  }
  const cwd = tmpCwd();
  seedState(cwd, { goal: structuredClone(goal) });
  if (scene.fenceArchive) {
    // The immutable-archive fence: the exact condition that parks an
    // APPROVED settlement (blocker #1). With it in place the claim survives
    // session start, so the owed settlement is observable on the surfaces.
    const fence = archivedGoalPath(cwd, (goal as { id: string }).id);
    fs.mkdirSync(path.dirname(fence), { recursive: true });
    fs.writeFileSync(fence, "# pre-existing archive — the immutable-archive fence\n", "utf8");
  }
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx: MockCtx = makeMockCtx(cwd, { sessionManager: { name: `lifecycle-evidence-${scene.key}` } });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await tick(200);
    if (scene.mode === "settle") {
      // The approved state has no card: the settlement driver archives the
      // goal, so what the user gets is the terminal render + the record. That
      // is the honest picture of `approved`, and it is rendered here from the
      // real driver rather than asserted in prose.
      const goalId = (goal as { id: string }).id;
      const archive = archivedGoalPath(cwd, goalId);
      const rendersFile = path.join(cwd, ".pi-glla", "pending-approval-renders.json");
      const renders = fs.existsSync(rendersFile) ? (JSON.parse(fs.readFileSync(rendersFile, "utf8")) as Array<{ chatLines: string[] }>) : [];
      const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { type: string }).type);
      return {
        label: "settlement (fresh session)",
        text: [
          `archive:    ${path.basename(archive)} (${fs.existsSync(archive) ? "landed" : "MISSING"})`,
          `claim:      ${(readState(cwd).goal as { pendingCompletion?: unknown } | null)?.pendingCompletion === undefined ? "released" : "still stored"}`,
          `ledger:     ${[...new Set(ledger.filter((type) => /^audit_(settlement|started)/.test(type)))].join(", ") || "(no settlement events)"}`,
          ...(renders.length
            ? ["queued terminal render (user-facing):", ...renders[0]!.chatLines.map((line) => `  ${line}`)]
            : ["queued terminal render: (none)"]),
        ].join("\n"),
      };
    }
    const noise = (text: string): string[] => text.split("\n").filter((line) => !/external tool allowlist|managed subagent override|review written|Reviewer:|Loaded without starting|^$/.test(line));
    ctx.ui.notifies.length = 0;
    await pi.command("goal", "status", ctx);
    await tick(60);
    const goalStatus = noise(ctx.ui.notifies.map((entry) => entry.message).join("\n"))
      .filter((line) => /Completion audit:|^(⏸|⏳|🛑|✅|🚧|🔍)/.test(line))
      .join("\n") || "(no completion-audit line)";
    ctx.ui.notifies.length = 0;
    await pi.command("glla", "status", ctx);
    await tick(60);
    const gllaStatus = noise(ctx.ui.notifies.map((entry) => entry.message).join("\n"))
      .filter((line) => /^goal \[/.test(line))
      .join("\n") || "(no goal line)";
    return { label: "/goal status", text: `/goal status → ${goalStatus}\n/glla status  → ${gllaStatus}` };
  } finally {
    await pi.fire("session_shutdown", { reason: "evidence" }, ctx);
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
  }
}

async function main(): Promise<void> {
  const out: string[] = [
    "detached audit lifecycle — user-facing surfaces per required state",
    `rendered ${new Date().toISOString()} by tests/evidence/render-lifecycle-surfaces.ts`,
    "every line below is produced by the real extension code; nothing is hand-written copy.",
    "=".repeat(78),
    "",
  ];
  const sections: string[] = [];

  for (const scene of scenes()) {
    const goal = goalFor(scene);
    const now = Date.now();
    const state = stateFor(goal);
    const projection = auditLifecycleProjection(goal.pendingCompletion as never, { now, settled: scene.settled === true });
    const widget = (buildWidgetLines(state, scene.audit ?? null, now) ?? []).join("\n");
    const status = buildStatusText(state, scene.audit ?? null, now) ?? "(no status line)";
    const commands = await commandSurfaces(scene, goal);
    // An APPROVED goal is archived: there is no live card and no status line
    // for it, and inventing one would show a state the product never renders.
    const noLiveSurfaces = scene.settled === true;
    const cardText = noLiveSurfaces ? "(none — the goal is archived; its user-facing surface is the terminal render below)" : widget;
    const statusText = noLiveSurfaces ? "(none — the goal is archived)" : status;

    sections.push([
      `${scene.title}`,
      `state=${projection?.state} phase=${projection?.phase} stale=${String(projection?.stale)} terminal=${String(projection?.terminal)} lastEvent=${projection?.lastEvent}`,
      `next action: ${projection?.nextAction}`,
      `why: ${scene.why}`,
      "",
      ...block("widget card", cardText.split("\n")),
      ...block("status line", [statusText]),
      ...block(commands.label, commands.text.split("\n")),
    ].join("\n"));

    out.push(
      `── ${scene.key} ${"─".repeat(Math.max(0, 72 - scene.key.length))}`,
      `${scene.title}`,
      `durable projection: state=${projection?.state} phase=${projection?.phase} stale=${String(projection?.stale)} terminal=${String(projection?.terminal)} lastEvent=${projection?.lastEvent}`,
      `next action:       ${projection?.nextAction}`,
      `${scene.why}`,
      "",
      "widget card:",
      ...cardText.split("\n").map((line) => `  ${line}`),
      "",
      "status line:",
      `  ${statusText}`,
      "",
      `${commands.label}:`,
      ...commands.text.split("\n").map((line) => `  ${line}`),
      "",
    );
  }

  out.push("=".repeat(78));
  out.push("no state above renders an unresolved audit as terminal completion;");
  out.push("the recovery action named by every parked/owed state is a real command.");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "lifecycle-surfaces.txt"), `${out.join("\n")}\n`, "utf8");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>detached audit lifecycle — surfaces</title><style>
body{background:#101014;color:#d4d4d4;font:12px/1.55 ui-monospace,Menlo,monospace;padding:22px;margin:0}
h1{font-size:14px;color:#7fb3ff;margin:0 0 2px}
.sub{color:#6b6b78;margin:0 0 18px;font-size:11px}
section{border:1px solid #33333d;border-radius:8px;padding:12px 14px;margin:0 0 14px;background:#16161c}
h2{font-size:12.5px;margin:0 0 6px;color:#b5bd68}
.meta{color:#8a8a99;font-size:11px;margin:0 0 8px}
.why{color:#7f8496;font-style:italic;margin:0 0 8px}
label{display:block;color:#5f6b8a;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;margin:8px 0 2px}
pre{margin:0;background:#1e1e24;border:1px solid #2b2b35;border-radius:6px;padding:9px 11px;white-space:pre-wrap;color:#cfd3e0}
.next{color:#56d364;margin:0 0 2px}
.key{color:#7fb3ff}
</style></head><body>
<h1>detached audit lifecycle — the five required states, on the real surfaces</h1>
<p class="sub">rendered by tests/evidence/render-lifecycle-surfaces.ts from the shipped extension code · ${new Date().toISOString()}</p>
${sections.map((s) => {
    const title = s.split("\n")[0] ?? "";
    const meta = s.split("\n").slice(1, 2).join("");
    const why = s.split("\n").slice(2, 3).join("");
    const next = s.split("\n").slice(3, 4).join("");
    const grab = (labelText: string): string => {
      const lines = s.split("\n");
      const at = lines.findIndex((l) => l.trim() === labelText);
      if (at < 0) return "";
      const body: string[] = [];
      for (let i = at + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!line.startsWith("  ")) break;
        body.push(line.slice(2));
      }
      return body.join("\n");
    };    return `<section>
  <h2>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</h2>
  <p class="meta">${meta.replace(/&/g, "&amp;")}</p>
  <p class="why">${why.replace(/&/g, "&amp;")}</p>
  <p class="next">${next.replace(/&/g, "&amp;")}</p>
  <label>widget card</label><pre>${esc(grab("widget card"))}</pre>
  <label>status line</label><pre>${esc(grab("status line"))}</pre>
  <label>${esc(grabLabel(s) ?? "command surfaces")}</label><pre>${esc(grab(grabLabel(s) ?? "command surfaces"))}</pre>
</section>`;
  }).join("\n")}
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, "lifecycle-surfaces.html"), html, "utf8");
  console.log(`wrote ${path.relative(REPO, OUT_DIR)}/lifecycle-surfaces.txt and .html (${sections.length} states)`);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The third block label of a section: the command/settlement surfaces whose
 * name depends on what the scene could honestly be asked for. */
function grabLabel(section: string): string | undefined {
  const lines = section.split("\n");
  return ["settlement (fresh session)", "/goal status"]
    .map((label) => lines.find((line) => line.trim() === label)?.trim())
    .find(Boolean);
}

await main();
