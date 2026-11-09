/**
 * pi-goal-list-loop-audit — v0.39.66 (GitHub #62)
 * extensions/goal-recovery-inventory.ts
 *
 * Read-only reconciliation between the LIVE durable state and the markdown
 * projections left on disk (`.pi-glla/goals/*.md`, `.pi-glla/archive/*.md`).
 *
 * The field report: after an unwanted list cancellation the operator found a
 * leftover `goals/<id>.md` still saying `Status: active` / `Policy: goal`
 * while `list_status()` correctly reported `Active: (none)` and `resume_goal`
 * answered `No active goal.`. Reading the projection alone said a goal was
 * running. Nothing named WHICH saved record was resumable, which was a stale
 * projection, and which was historical history — so recovery started with
 * manual ledger inspection.
 *
 * This module answers that with two deliberate limits:
 *
 *  1. It NEVER mutates state. It reports, and it prints a recreation recipe
 *     the operator (or agent) may run through the ordinary public controls.
 *  2. A non-current record is never presented as resumable. A goal's identity
 *     (checkpoints, audit history, approvals, timers, completed task states)
 *     does not survive the archive — only its objective, contract and plan
 *     structure can be recreated, as a NEW goal.
 *
 * The recipe is round-trip checked before it is printed: the objective text
 * plus a `Done when:` introducer plus the saved criteria must re-parse into
 * exactly the saved objective and the same criteria items. That check is what
 * makes the export honest — `CONTRACT_MARKER_PATTERN`/`stripContractIntroducers`
 * in goal-loop-core are the same primitives the parser uses, so a recipe that
 * previews clean cannot accumulate markers when it is fed back in.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  archiveDir,
  compactDisplayText,
  extractVerificationContract,
  piGlaDir,
  sanitizeDisplayText,
  stripContractIntroducers,
} from "./goal-loop-core.js";
import { contractItems } from "./goal-loop-shield.js";

/** How a saved markdown record relates to what is running right now. */
export type SavedRecordState =
  /** This record IS the live objective (resumable/tweakable in place). */
  | "current"
  /** A leftover projection: it LOOKS live, but nothing durable is running it. */
  | "stale-projection"
  /** A terminal record (complete/aborted) with its archive published. */
  | "historical"
  /** Terminal marker on disk with no published archive — cleanup debt. */
  | "unarchived-terminal"
  /** Present on disk but not parseable as a GLLA record. */
  | "unreadable";

export interface SavedGoalRecord {
  id: string;
  /** Projection locations this id was found in. */
  projection: { active: boolean; archive: boolean };
  status: string;
  policy?: string;
  objective: string;
  verificationContract: string;
  stopReason?: string;
  /** Plan structure, from the `## Tasks` rendered tree. */
  tasks: { total: number; subtasks: number; complete: number };
  /** The objective block itself carries a `## ` heading, so this record's
   * boundary cannot be trusted for a byte-faithful recreation. */
  objectiveAmbiguous: boolean;
}

export interface SavedLiveState {
  goal?: { id?: string; status?: string; policy?: string } | null;
  goalPresent: boolean;
  listCount: number;
  loop?: { active?: boolean; target?: string; iteration?: number } | null;
}

const SECTION_BOUNDARIES = [
  "## Durable-solution judgment (executor assertion)",
  "## Replan target (preserved)",
  "## Completion summary",
  "## Verification contract",
  "## Tasks",
  "## Audit history",
  "## Terminal summary",
];

function sectionText(md: string, header: string): string | undefined {
  const start = md.indexOf(`${header}\n`);
  if (start < 0) return undefined;
  const after = start + header.length;
  // Body begins after the blank separator line the renderer writes.
  const bodyStart = md.startsWith("\n\n", after) ? after + 2 : after + (md[after] === "\n" ? 1 : 0);
  const candidates = SECTION_BOUNDARIES
    .map((boundary) => md.indexOf(`\n\n${boundary}\n`, bodyStart))
    .filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : md.length;
  return md.slice(bodyStart, end).replace(/\s+$/, "");
}

/** Parse a `renderGoalMarkdown` projection back into the fields a recreation
 * recipe needs. Tolerant by design: an unreadable record is reported as
 * unreadable rather than mistaken for live work. */
export function parseSavedGoalMarkdown(md: string): Omit<SavedGoalRecord, "id" | "projection"> {
  const status = md.match(/^\*\*Status\*\*:\s*(\w+)/m)?.[1] ?? "unknown";
  const policy = md.match(/^\*\*Policy\*\*:\s*(goal|list)/m)?.[1];
  const stopReason = md.match(/^\*\*Stop reason\*\*:\s*(.+)$/m)?.[1]?.trim();
  const objectiveBlock = sectionText(md, "## Objective") ?? "";
  const objectiveLines = objectiveBlock.split("\n");
  const first = objectiveLines[0] ?? "";
  objectiveLines[0] = first.startsWith("> ") ? first.slice(2) : first.replace(/^>/, "");
  const objective = objectiveLines.join("\n").replace(/\s+$/, "");
  const objectiveAmbiguous = /^\s*(?:##\s+|> ##\s+)/m.test(objective);
  const verificationContract = sectionText(md, "## Verification contract") ?? "";
  const tasksSection = sectionText(md, "## Tasks") ?? "";
  const taskRows = [...tasksSection.matchAll(/^([ \t]*)- \[([ x~])\]/gm)];
  const topLevel = tasksSection.split("\n").filter((line) => /^- \[[ x~]\]/.test(line)).length;
  const subtasks = taskRows.length - topLevel;
  const complete = taskRows.filter((row) => row[2] === "x").length;
  return {
    status,
    ...(policy ? { policy } : {}),
    objective: sanitizeDisplayText(objective),
    verificationContract: stripContractIntroducers(verificationContract),
    ...(stopReason ? { stopReason: sanitizeDisplayText(stopReason) } : {}),
    tasks: { total: topLevel, subtasks, complete },
    objectiveAmbiguous,
  };
}

function readRecordsFrom(dir: string, kind: "active" | "archive"): Map<string, { md: string; found: { active: boolean; archive: boolean } }> {
  const found = new Map<string, { md: string; found: { active: boolean; archive: boolean } }>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    // Repair-fragment / sentinel naming is not a goal id; the archive keeps
    // such names only for legacy trees, and a record with no Status marker is
    // reported as unreadable rather than silently dropped.
    let md: string;
    try {
      md = fs.readFileSync(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const existing = found.get(id);
    if (existing) {
      // An archive copy is the terminal record; the projection is leftover.
      existing.found[kind] = true;
      if (kind === "archive") existing.md = md;
      continue;
    }
    found.set(id, { md, found: { active: kind === "active", archive: kind === "archive" } });
  }
  return found;
}

/** Every saved goal record on disk, newest first by id (ids are timestamped). */
export function collectSavedGoalRecords(cwd: string): SavedGoalRecord[] {
  const merged = readRecordsFrom(path.join(piGlaDir(cwd), "goals"), "active");
  for (const [id, value] of readRecordsFrom(archiveDir(cwd), "archive")) {
    const existing = merged.get(id);
    if (existing) {
      existing.found.archive = true;
      existing.md = value.md;
    } else {
      merged.set(id, value);
    }
  }
  const records: SavedGoalRecord[] = [];
  for (const [id, value] of merged) {
    const parsed = parseSavedGoalMarkdown(value.md);
    records.push({ id, projection: value.found, ...parsed });
  }
  return records.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Classify one saved record against the LIVE durable state. The projection's
 * own `Status:` marker is never promotional: a record only counts as
 * `current` when the live state names the same id. */
export function classifySavedRecord(record: Pick<SavedGoalRecord, "id" | "status" | "projection">, live: Pick<SavedLiveState, "goal" | "goalPresent">): SavedRecordState {
  const terminal = record.status === "complete" || record.status === "aborted";
  if (record.status === "unknown") return "unreadable";
  if (live.goalPresent && live.goal?.id === record.id) return "current";
  if (record.projection.archive) return "historical";
  if (terminal) return "unarchived-terminal";
  return "stale-projection";
}

export interface RestoreRecipe {
  /** The exact `/goal start` command text (objective line + `Done when:` block). */
  command: string;
  criteria: string[];
  /** Round-trip proof: the re-parsed objective/criteria equal the saved ones. */
  roundTrip: { ok: boolean; criteriaIn: number; criteriaOut: number; objectiveMatch: boolean; detail?: string };
}

/** Build the restore-as-new recipe for one saved record. The recipe is only
 * emitted when the round-trip check passes: an objective or criteria set that
 * cannot survive export must never be presented as a faithful recreation. */
export function buildRestoreRecipe(record: Pick<SavedGoalRecord, "objective" | "verificationContract" | "objectiveAmbiguous">): RestoreRecipe | undefined {
  if (!record.objective.trim() || record.objectiveAmbiguous) return undefined;
  const criteria = contractItems(record.verificationContract);
  const command = criteria.length > 0
    ? `${record.objective}\nDone when:\n${stripContractIntroducers(record.verificationContract)}`
    : record.objective;
  const reparsed = extractVerificationContract(command);
  const roundTrip = {
    ok: reparsed.objective.trim() === record.objective.trim()
      && JSON.stringify(contractItems(reparsed.verificationContract)) === JSON.stringify(criteria),
    criteriaIn: criteria.length,
    criteriaOut: contractItems(reparsed.verificationContract).length,
    objectiveMatch: reparsed.objective.trim() === record.objective.trim(),
  };
  return { command, criteria, roundTrip };
}

const ROW_LABEL: Record<SavedRecordState, string> = {
  current: "CURRENT",
  "stale-projection": "STALE PROJECTION",
  historical: "HISTORICAL",
  "unarchived-terminal": "TERMINAL, UNARCHIVED",
  unreadable: "UNREADABLE",
};

const ROW_VERDICT: Record<SavedRecordState, string> = {
  current: "this record IS the live objective",
  "stale-projection": "leftover projection only — NOT resumable",
  historical: "archived history — NOT resumable",
  "unarchived-terminal": "finished, but its archive never landed — not resumable",
  unreadable: "no Status marker — not a GLLA goal record",
};

export interface RecoveryInventoryInput {
  live: SavedLiveState;
  records: SavedGoalRecord[];
  /** Saved queue sidecars that the live list does not own. */
  orphanQueue: Array<{ objective: string }>;
  /** Path shown in the header (relative display kept short). */
  stateLabel?: string;
}

function liveStateLine(live: SavedLiveState): string {
  const parts: string[] = [];
  if (live.goalPresent && live.goal) {
    parts.push(`goal ${live.goal.status ?? "?"} (${live.goal.policy ?? "?"})`);
  } else {
    parts.push("no live goal");
  }
  parts.push(live.listCount > 0 ? `list ${live.listCount} waiting` : "list empty");
  if (live.loop?.active) parts.push(`loop active (iter ${live.loop.iteration ?? "?"})`);
  else if (live.loop) parts.push("loop stopped");
  else parts.push("no loop");
  return parts.join(" · ");
}

/** `/goal recover` renderer. Read-only: it describes state and prints the
 * public-control recipe, and never claims that printing a recipe, or a command
 * receipt, activated anything. */
export function formatRecoveryInventory(input: RecoveryInventoryInput): string {
  const { live, records } = input;
  const lines: string[] = [];
  lines.push(`Recovery inventory — live state: ${liveStateLine(live)}.`);
  if (records.length === 0 && input.orphanQueue.length === 0) {
    lines.push("", "No saved records on disk — nothing to recover and nothing stale.");
    return lines.join("\n");
  }
  const classified = records.map((record) => ({ record, state: classifySavedRecord(record, live) }));
  lines.push("", `Saved goal records (${records.length}):`);
  for (const { record, state } of classified) {
    const shortId = record.id.length > 12 ? record.id.slice(0, 6) + "…" : record.id;
    const where = record.projection.archive && record.projection.active
      ? "projection + archive"
      : record.projection.archive ? "archive only" : "projection only";
    const plan = record.tasks.total > 0
      ? ` · plan ${record.tasks.total} task${record.tasks.total === 1 ? "" : "s"}${record.tasks.subtasks > 0 ? `/${record.tasks.subtasks} subtask${record.tasks.subtasks === 1 ? "" : "s"}` : ""}${record.tasks.complete > 0 ? ` (${record.tasks.complete} complete — historical)` : ""}`
      : " · no saved plan";
    lines.push(
      `  ${shortId}  ${ROW_LABEL[state]}  status ${record.status}${record.policy ? ` · policy ${record.policy}` : ""} · ${where}${plan}`,
      `     objective: ${compactDisplayText(record.objective).slice(0, 160) || "(empty)"}`,
      `     ${ROW_VERDICT[state]}${state !== "current" && record.stopReason ? ` (stop reason: ${compactDisplayText(record.stopReason).slice(0, 80)})` : ""}`,
    );
  }
  const recoverable = classified.filter(({ state }) => state === "stale-projection" || state === "historical" || state === "unarchived-terminal");
  if (recoverable.length > 0) {
    lines.push(
      "",
      "Restore as NEW — the only supported path for a record above that is not CURRENT.",
      "It creates a fresh goal: new identity, no armed timers, no carried approvals, and every",
      "task starting pending. Old audit reports and test runs stay historical until revalidated here.",
    );
  }
  for (const { record, state } of recoverable) {
    const recipe = buildRestoreRecipe(record);
    lines.push("", `  ${record.id} — ${ROW_LABEL[state]}`);
    if (!recipe) {
      lines.push(
        `    no automatic recipe: ${record.objectiveAmbiguous ? "the objective carries its own section heading" : "the record has no readable objective"}.`,
        `    Open ${record.projection.archive ? "the archive file" : "the projection"} and recreate the objective by hand.`,
      );
      continue;
    }
    const args = recipe.command.split("\n").map((line) => `    ${line}`).join("\n");
    lines.push("    /goal start", args);
    if (recipe.criteria.length > 0) {
      lines.push(
        `    (round trip: ${recipe.roundTrip.criteriaIn} criteria in, ${recipe.roundTrip.criteriaOut} out, ${recipe.roundTrip.ok ? "objective and criteria identical" : "MISMATCH — do not reuse this recipe"})`,
      );
    }
    if (!recipe.roundTrip.ok) {
      lines.push("    This recipe failed its round-trip check; recreate the contract from the saved file instead.");
      continue;
    }
    if (record.tasks.total > 0) {
      lines.push(
        `    then propose_task_list with the saved plan (${record.tasks.total} task${record.tasks.total === 1 ? "" : "s"}${record.tasks.subtasks > 0 ? `, ${record.tasks.subtasks} subtask${record.tasks.subtasks === 1 ? "" : "s"}` : ""}) — all pending, nothing pre-completed.`,
      );
    }
    lines.push(
      "    After activating, confirm the durable result rather than a command receipt:",
      "    /goal status and list_status must show the new goal active, the same objective and",
      "    contract, and the expected task plan before any of it counts as recovered.",
    );
  }
  if (input.orphanQueue.length > 0) {
    lines.push(
      "",
      `Saved queue sidecars not in the live list (${input.orphanQueue.length}): this is a queue, not a goal.`,
      `/list show reads the durable queue; /list resume activates its head.`,
      `  ${input.orphanQueue.slice(0, 3).map((item) => compactDisplayText(item.objective).slice(0, 70)).join(" | ")}${input.orphanQueue.length > 3 ? ` | +${input.orphanQueue.length - 3} more` : ""}`,
    );
  }
  const currentRecords = classified.filter(({ state }) => state === "current");
  if (currentRecords.length > 0) {
    lines.push(
      "",
      `The CURRENT record is the only resumable one: use /goal status, /goal resume, /goal tweak, or /list resume for its own surface.`,
      "A record's markdown never overrides live state, so never edit these files to reopen work.",
    );
  } else if (live.goalPresent) {
    lines.push("", "The live goal has no saved projection yet — its markdown is written on the next goal update.");
  } else {
    lines.push("", "No CURRENT record exists, so resume cannot reopen any of the above — history is not resumable.");
  }
  return lines.join("\n");
}

/** One-line summary for `/goal status` / resume replies when there is no live
 * goal: says what is saved and that it is not resumable. */
export function savedRecordsOneLiner(records: SavedGoalRecord[], live: Pick<SavedLiveState, "goal" | "goalPresent">): string | undefined {
  const stale = records.filter((record) => {
    const state = classifySavedRecord(record, live);
    return state === "stale-projection" || state === "unarchived-terminal";
  });
  const historical = records.filter((record) => classifySavedRecord(record, live) === "historical");
  if (stale.length === 0 && historical.length === 0) return undefined;
  const parts: string[] = [];
  if (stale.length > 0) parts.push(`${stale.length} stale projection${stale.length === 1 ? "" : "s"}`);
  if (historical.length > 0) parts.push(`${historical.length} archived record${historical.length === 1 ? "" : "s"}`);
  return `${parts.join(" + ")} on disk — none is live work. /goal recover previews each one and the restore-as-new recipe.`;
}
