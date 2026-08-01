/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/loops/goal.ts
 *
 * The goal loop. The agent continues working, and on complete_goal,
 * an isolated auditor verifies the work.
 *
 * Design: see docs/DESIGN.md.
 *
 * Command surface (v0.8.0 — four top-level commands):
 *   /goal "<objective>" | /goal (draft) | /goal status|pause|resume|cancel|tweak <text>|archive
 *   /list add|show|next|remove|clear
 *   /loop (draft) | /loop start|status|stop
 *   /glla (settings UI) | /glla key=value | /glla project key=value
 */

import * as fs from "node:fs";
import { exec } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type Goal,
  type State,
  type Status,
  appendLedger,
  archiveDir,
  archivedGoalPath,
  buildTaskList,
  buildTaskSummary,
  auditFeedbackExcerpt,
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_QUOTA_RETRY_MINUTES,
  DEFAULT_STALL_ESCALATION_REFIRES,
  DEFAULT_TOKEN_LIMIT,
  classifyImpossibleReason,
  extractPendingTasks,
  isFullAuditObjective,
  resolveEffectiveAggressiveSettings,
  appendAuditLog,
  computeListDepth,
  formatAuditLog,
  formatGoalAuditHistory,
  runWithInfraRetry,
  readAuditLog,
  stripThinkBlocks,
  type AuditLogEntry,
  ledgerPath,
  crossRecommendMode,
  formatListDepth,
  shouldEscalateStall,
  isStaleApiError,
  mergeSettings,
  parseListImport,

  routeGoalArgs,
  routeListText,
  listMutationBlocked,
  LIST_DRAFTING_BLOCK_MESSAGE,
  sumNewAssistantTokens,
  takeAt,
  countTrailingDisapprovals,
  goalArgsNeedDrafting,
  buildSeedGrillMessage,
  askUserQuestionAnswered,
  draftProposalBlock,
  type TaskProposal,
  validateTaskProposal,
  cloneGoal,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  newGoalId,
  nowIso,
  piGlaDir,
  normalizeDraftContract,
  draftContractItemCount,
  extractVerificationContract,
  classifySessionCtx,
  readState,
  renderGoalMarkdown,
  shouldAutoResumeOnSessionStart,
  statusLabel,
  writeGoalMd,
  missingGllaTools,
  runPersistStep,
  isPersistenceDegraded,
  lastPersistenceFailure,
} from "../goal-loop-core.js";
import {
  LENGTH_CONTINUE_MAX,
  LENGTH_CONTINUE_TEXT,
  resetLengthContinue,
  tickLengthContinue,
} from "../length-continue.js";
import {
  isQuotaError,
  isSubagentQuotaResult,
  parseQuotaError,
  scheduleQuotaRetry,
  cancelQuotaRetry,
} from "../quota-retry.js";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  globalSettingsPath,
  loadGlobalSettings,
  loadSettings,
  projectSettingsPath,
  saveSettings,
  settingsProvenance,
  type Settings,
} from "../goal-settings.js";
import {
  DEFAULT_REVIEWER_CONFIG,
  normalizeObjective,
  resolveReviewerConfig,
  reviewerMenuOptions,
  runReviewer,
  type ReviewerConfig,
} from "../reviewer.js";
import {
  discoverGllaProjects,
  parseLedgerEntries,
  filterPremature,
  formatRollupJson,
  formatRollupTable,
  rollupProject,
  type ProjectRollup,
} from "../goal-loop-stats.js";
import { runGoalCompletionAuditor } from "../goal-loop-auditor.js";
import {
  REPETITION,
  isActuallyStuck,
  loopInterventionDirective,
  continueVariant,
  textFingerprint,
  pushCapped as pushRepetitionCapped,
} from "../goal-loop-repetition.js";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../goal-loop-display.js";
import {
  defaultAgentDir,
  resolveEffectiveSubagentModel,
  syncSubagentModelOverrides,
  type SubagentModelStrategy,
} from "../goal-loop-subagents.js";
import {
  buildSettingsRows,
  SettingsMenuComponent,
  type SettingsRow,
} from "../settings-menu.js";
import {
  buildModelPickItems,
  ModelPickerComponent,
  type ModelPickItem,
} from "../model-picker.js";
import {
  applyMeasurement,
  applyMetriclessTick,
  applyRefinement,
  loopBranchName,
  parseLoopStartArgs,
  loopFinishStopReason,
  isLoopWriteTool,
  parseMetric,
  LOOP_DEFAULTS,
  resolveSpecFiles,
  respecTarget,
  topOpenAuditFinding,
  specFileHash,
  countCheckedSpecItems,
  auditMeasureCmd,
  auditTarget,
  AUDIT_PLATEAU_MAX_REPRIEVES,
  countOpenAuditFindings,
  AUDIT_FINDINGS_REL,
  projectAuditTarget,
  LIST_AUDIT_COLLECT_MARKER,
  GOAL_AUDIT_ONESHOT_MARKER,
  LOOP_AUDIT_MARKER,
  listAuditCollectTarget,
  parseAuditFindingsForFanout,
  listAuditFanoutItemText,
  type LoopTickOutcome,
  HELD_ON_RESTORE,
  type LoopState,
} from "../goal-loop-forever.js";
import {
  accountTurnForNudgesRich,
  BACKOFF_IDLE_RETRY_MS,
  DEFAULT_STALL_SIM_THRESHOLD,
  DEFAULT_STALL_SHORT_WORDS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  shouldHeartbeatRefire,
  MEASURE_TIMEOUT_MS,
  WEDGE_ALERT_DEFAULT_MINUTES,
  shouldWedgeAlert,
  PENDING_LATCH_STUCK_MS,
  shouldFirePendingLatchWatchdog,
  msUntilNextHourBoundary,
} from "../goal-loop-backoff.js";

// =================================================================
// Constants
// =================================================================

const GOAL_EVENT_ENTRY = "goal-event";
// HELD_ON_RESTORE (stopReason marker for a restore-held loop) lives in
// goal-loop-forever.js since v0.28.17 — the display layer imports it too.

// =================================================================
// Module-level state (one per session)
// =================================================================

// The ExtensionAPI captured in the factory. sendMessage lives on the API,
// not on ExtensionContext, so continuation sends need it at module scope.
let extensionApi: ExtensionAPI | null = null;
// v0.26.7: pi invalidates the extension runtime on session replacement
// (newSession/fork/switchSession/reload — and the compaction path reaches
// it via teardownCurrent in pi 0.82.x). Once stale, every sendMessage
// throws FOREVER in this process — retrying for hours is the hegemon
// failure shape. Detect the stale signature once and go terminally loud.
let extensionApiStale = false;
// v0.32.0: CRITICAL — goStaleTerminal must gate on its OWN flag, not
// extensionApiStale: probeExtensionApiStale() sets extensionApiStale on
// detection, so the heartbeat's `probe → goStaleTerminal` sequence always
// found the flag already true and returned silently — orphan-stale recovery
// (ledger, loop stop, interruptedAt, warn, AUTO-RELOAD SELF-HEAL) was dead
// code since v0.29.11. Field proof: hegemon sat stale for days and the
// wezterm self-heal never fired.
let staleTerminalDone = false;

/** v0.26.7: a stale api is terminal for this process — go loudly with
 * restart guidance instead of retrying sends that can never land.
 * v0.28.1 (S1/S2): goals STAY ACTIVE with an interrupt marker instead of
 * pausing — the restore gate only auto-resumes ACTIVE goals, so pausing
 * here stranded goals until manual /goal resume (hegemon/sraaal shape).
 * sendContinuation's extensionApiStale guard already stops further sends
 * in this doomed process; the next fresh session auto-resumes. */
/** v0.30.0: rebind-first session-replacement survival. pi's sanctioned
 * pattern (docs/extensions.md lifecycle + the stale error text itself):
 * session_shutdown → cleanup, session_start → re-establish with the NEW
 * ctx. glla used to treat every stale handle as terminal ("run /reload"),
 * but three replacement shapes need three responses:
 *  (a) switch (resume/new/fork): pi rebinds THIS module to the new
 *      session — session_start delivers a fresh ctx. No user action, no
 *      warning; reset the stale flag via a re-probe and continue.
 *  (b) /reload: pi re-imports the extension modules — a SUCCESSOR
 *      instance owns this cwd in the same process. The old module stands
 *      down silently (owner-file check) instead of screaming + injecting
 *      /reload (v0.29.22's injection is right for orphans, wrong here).
 *  (c) orphan: the session died with NO replacement (hegemon 2026-07-31:
 *      handle dead ~06:03, zero ledger events for 5h). Only a rebuild
 *      revives extension function — goStaleTerminal's warning + self-heal
 *      stays for this case ONLY.
 * session_shutdown is now ledgered with pi's reason, so the next
 * unexplained disposal is attributable from the ledger alone. */
const SESSION_REBIND_GRACE_MS = 60_000;
let sessionReplacementUntil = 0;
const instanceStartedAt = Date.now();
const instanceId = `${process.pid}:${instanceStartedAt}`;
let zombieStoodDown = false;

function ownerFilePath(cwd: string): string {
  return path.join(cwd, ".pi-glla", "owner.json");
}

function writeOwnerFile(cwd: string): void {
  try {
    fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
    fs.writeFileSync(ownerFilePath(cwd), JSON.stringify({ instanceId, pid: process.pid, at: Date.now() }));
  } catch {
    /* owner file is advisory — never block activation on it */
  }
}

function readOwnerFile(cwd: string): { instanceId?: string; pid?: number; at?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(ownerFilePath(cwd), "utf8")) as { instanceId?: string; pid?: number; at?: number };
  } catch {
    return null;
  }
}

/** A stale probe is terminal only for ORPHANS. Returns true when the
 * stale sighting was absorbed (a rebind window is open, or a successor
 * instance owns this cwd and we stand down silently), false when the
 * caller should go terminal (orphan — no replacement came). */
function absorbStaleIfSuperseded(ctx: ExtensionContext): boolean {
  if (Date.now() < sessionReplacementUntil) {
    appendLedger(ctx.cwd, "stale_awaiting_rebind", {});
    return true;
  }
  const owner = readOwnerFile(ctx.cwd);
  if (owner && owner.pid === process.pid && typeof owner.instanceId === "string" && owner.instanceId !== instanceId) {
    appendLedger(ctx.cwd, "zombie_stood_down", { owner: owner.instanceId });
    zombieStoodDown = true;
    extensionApiStale = true; // silence the send paths WITHOUT the terminal theatre
    clearLoopTimer();
    if (continuationTimer) { clearTimeout(continuationTimer); continuationTimer = null; }
    // v0.32.0: the superseded module's heartbeat + UI ticker were IMMORTAL
    // (clearInterval appeared nowhere) — N /reloads = N×2 zombie tickers.
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (uiTicker) { clearInterval(uiTicker); uiTicker = null; }
    return true;
  }
  return false;
}

function goStaleTerminal(ctx: ExtensionContext, where: string): void {
  if (staleTerminalDone) return; // already terminal — don't re-spam
  staleTerminalDone = true;
  extensionApiStale = true;
  appendLedger(ctx.cwd, "extension_api_stale", { where, kind: isLoopActive() ? "loop" : "goal" });
  const guidance = "pi invalidated this session's extension handle (session replacement — the session was disposed and this process's sends can never land). Run /reload — extensions rebuild IN PLACE, no pi restart needed — then /glla resume (autoresume=on resumes for you). Restart pi only if /reload itself fails.";
  // v0.32.0: kill the continuation re-arm too — otherwise an orphaned goal
  // keeps spinning a flat 50ms retry below every watchdog.
  if (continuationTimer) { clearTimeout(continuationTimer); continuationTimer = null; continuationScheduledFor = null; }
  if (isLoopActive()) {
    clearLoopTimer();
    state.loop = { ...state.loop!, active: false, stopReason: `extension api stale: ${guidance}` };
    persistState(ctx);
  } else if (state.goal && state.goal.status === "active") {
    updateGoal({ interruptedAt: nowIso(), interruptedReason: `extension api stale (${where})` }, ctx);
  }
  ctx.ui.notify(`glla: ${guidance}`, "warning");
  notifyExternal(ctx, `glla: extension api stale — run /reload, then /glla resume. (${where})`);
  attemptAutoReload(ctx, where);
}

/** v0.29.13: automatic recovery — the zombie handle can't call ctx.reload()
 * (pi walls EVERY runtime method behind assertActive), but fs/child_process
 * are extension-side and still work. Inject /reload as keystrokes into our
 * own terminal pane: pi rebuilds the extension runtime in place, the fresh
 * instance loads .pi-glla state and holds (autoresume=on resumes for you).
 * v0.29.22: transport-generalized — tmux OR WezTerm. Field: this rig runs
 * WezTerm (TERM_PROGRAM=WezTerm, WEZTERM_PANE set, no TMUX), so the
 * tmux-only gate failed silently 100% of the time — auto_reload_injected
 * never fired fleet-wide, and every stale handle fell back to the manual
 * warning (user: "stopping and told to reload is common"). v0.29.22 also
 * fires from the entry-probe path (the most common stale discovery).
 * Opt out: autoReloadOnStale=false. Best-effort: the manual warning
 * already fired, so failures cost nothing. */
function attemptAutoReload(ctx: ExtensionContext, where: string): boolean {
  try {
    if (loadSettings(ctx.cwd).autoReloadOnStale === false) return false;
    const tmuxPane = process.env.TMUX_PANE;
    const wezPane = process.env.WEZTERM_PANE;
    let transport: "tmux" | "wezterm";
    let cmd: string;
    let pane: string;
    if (process.env.TMUX && tmuxPane && /^%\d+$/.test(tmuxPane)) {
      transport = "tmux";
      pane = tmuxPane;
      // v0.29.22: NO leading Escape — a late zombie probe can fire AFTER a
      // fresh instance already resumed and started a turn, and Escape
      // would abort that turn without consent (the consent line). /reload
      // alone lands at a dead prompt and queues harmlessly mid-turn (pi
      // refuses the reload itself if a response is streaming).
      cmd = `tmux send-keys -t ${pane} -l '/reload' && tmux send-keys -t ${pane} Enter`;
    } else if (wezPane && /^\d+$/.test(wezPane)) {
      transport = "wezterm";
      pane = wezPane;
      // wezterm cli send-text --no-paste delivers bytes as keystrokes.
      // /reload + CR only — no Escape (see above). Literal CR byte inside
      // single quotes — no bash-isms (exec uses /bin/sh).
      cmd = `wezterm cli send-text --pane-id ${pane} --no-paste '/reload\r'`;
    } else {
      appendLedger(ctx.cwd, "auto_reload_skipped", { where, reason: "no supported multiplexer (tmux/WezTerm) in env" });
      return false;
    }
    appendLedger(ctx.cwd, "auto_reload_injected", { where, transport, pane });
    ctx.ui.notify("glla: injecting /reload into this pane — extensions rebuild in place and the fresh instance holds state. /glla resume after (automatic with autoresume=on).", "info");
    exec(cmd, () => { /* best-effort */ });
    return true;
  } catch {
    /* never let recovery take the warning path down */
    return false;
  }
}

/** v0.34.13: one rung of the auto-recovery ladder. Returns true when a
 * /reload was injected (caller should NOT also pause/alert the manual
 * cure). Writes the sidecar resume marker FIRST so the fresh instance
 * resumes the goal/loop even with autoresume=off. Throttled — a second
 * wedge inside the window is the pi-restart class and must reach the
 * user as a loud stop, not another reload. */
let lastAutoRecoveryAt = 0;
function attemptAutoRecovery(ctx: ExtensionContext, where: string): boolean {
  if (loadSettings(ctx.cwd).autoRecovery === false) return false;
  const now = Date.now();
  if (now - lastAutoRecoveryAt < AUTO_RECOVERY_THROTTLE_MS) return false;
  // Inject FIRST — the throttle stamp + marker must reflect a real
  // recovery, not a no-transport skip (else the watchdog would mislabel
  // the next wedge as the pi-restart class).
  if (!attemptAutoReload(ctx, where)) return false;
  lastAutoRecoveryAt = now;
  try {
    fs.writeFileSync(
      path.join(piGlaDir(ctx.cwd), RECOVERY_RESUME_MARKER),
      JSON.stringify({ at: new Date(now).toISOString(), where }),
    );
  } catch { /* best-effort — the reload still helps; restore just holds */ }
  appendLedger(ctx.cwd, "auto_recovery_reload", { where });
  ctx.ui.notify(`glla auto-recovery: ${where} — the ${isLoopActive() ? "loop" : "goal/list item"} resumes ITSELF after the rebuild (no /glla resume needed; the sidecar marker carries the consent). If this recurs within ${Math.round(AUTO_RECOVERY_THROTTLE_MS / 60_000)}m it's the pi-restart class and you'll get a loud stop.`, "warning");
  return true;
}

/** v0.34.14: /reload rebind detector. The extension runs INSIDE pi, so
 * process.pid IS pi's pid: an instance that boots and finds its OWN pid
 * already in the owner file is a /reload rebuild of a live session, not a
 * cold boot. Rebinds always resume active goals/loops — holding mid-work
 * after an in-place rebuild is pure friction (user directive: keep going
 * unless we must stop; "the list is not continuing" after /reload,
 * hellhunter 2026-08-01). Cold boots (new pid) still honor autoresume=off.
 * Sidecar, not the ledger: read-before-write must be atomic-ish and the
 * ledger is append-only. */
const SESSION_OWNER_FILE = "session-owner.json";
function claimSessionOwnerAndDetectRebind(cwd: string): boolean {
  try {
    const p = path.join(piGlaDir(cwd), SESSION_OWNER_FILE);
    let prevPid: number | null = null;
    try {
      prevPid = (JSON.parse(fs.readFileSync(p, "utf-8")) as { pid?: number }).pid ?? null;
    } catch { /* absent or corrupt — first boot */ }
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return prevPid !== null && prevPid === process.pid;
  } catch {
    return false;
  }
}

/** v0.34.13: consume the sidecar marker on session restore. Single-use,
 * freshness-bounded — a stale marker from an abandoned recovery must not
 * surprise-resume a later session. */
function consumeRecoveryResume(cwd: string): boolean {
  try {
    const p = path.join(piGlaDir(cwd), RECOVERY_RESUME_MARKER);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf-8");
    fs.unlinkSync(p);
    const at = Date.parse((JSON.parse(raw) as { at?: string }).at ?? "");
    return !Number.isNaN(at) && Date.now() - at < RECOVERY_RESUME_FRESH_MS;
  } catch {
    return false;
  }
}

/** TEST-ONLY hook (tests/harness): the stale flag is process-terminal in
 * production — only a pi restart clears it — so behavioral tests reset it
 * between stale scenarios. Never called by production code. */
export function __testOnlyResetStaleFlag(): void {
  extensionApiStale = false;
}

/** Test-only: release the claimed session owner so a later test file can
 * drive agent_end with its own sessionManager identity (ownerSession is
 * process-wide module state; behavioral-orchestrator claims it first). */
export function __testOnlyResetOwnerSession(): void {
  ownerSession = null;
}

/** v0.28.1 (S3): side-effect-free staleness probe — getSessionName()
 * routes through pi's assertActive() and throws the stale signature iff
 * pi invalidated this factory handle (session replacement). A positive
 * result is cached in extensionApiStale. */
function probeExtensionApiStale(): boolean {
  if (extensionApiStale) return true;
  if (!extensionApi) return false;
  try {
    extensionApi.getSessionName();
  } catch (err) {
    if (isStaleApiError(err)) extensionApiStale = true;
  }
  return extensionApiStale;
}

/** v0.34.7: orchestrator-path sendUserMessage that can NEVER crash the
 * process. Darklord 2026-08-01: fanOutListAuditFindings ran on a stale
 * handle (a /reload landed mid-collect), assertActive threw, the floating
 * promise from sync archiveCurrentGoal turned it into an uncaughtException
 * and pi EXITED mid-audit. Probe first, catch anyway, ledger the skip. */
function safeSteerUser(ctx: ExtensionContext, text: string): boolean {
  if (probeExtensionApiStale()) {
    appendLedger(ctx.cwd, "steer_skipped_stale", { chars: text.length });
    return false;
  }
  try {
    extensionApi?.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
    return true;
  } catch (err) {
    if (isStaleApiError(err)) extensionApiStale = true;
    appendLedger(ctx.cwd, "steer_skipped_stale", { chars: text.length, threw: true });
    return false;
  }
}

/** v0.28.1 (S3): command-entry staleness probe + honest warning. Returns
 * true when the handle is stale — callers must skip send-dependent paths
 * and must NOT claim work started (S3's "created — starting now" lie). */
function warnIfStaleAtEntry(ctx: ExtensionContext, what: string): boolean {
  if (!probeExtensionApiStale()) return false;
  // v0.30.0: a successor may already own this session (e.g. /reload
  // re-imported the modules) — the user's command belongs to the fresh
  // instance; say so softly instead of demanding a reload.
  // v0.32.0: the rebind window means a fresh instance is COMING, not here —
  // the old message claimed "handled there" while nothing owned the session.
  if (Date.now() < sessionReplacementUntil) {
    ctx.ui.notify(`glla: this session is rebinding after /reload — ${what} will be handled by the refreshed instance; retry in a moment if it doesn't.`, "info");
    return true;
  }
  if (absorbStaleIfSuperseded(ctx)) {
    ctx.ui.notify(`glla: a refreshed instance owns this session — ${what} is handled there; nothing to do.`, "info");
    return true;
  }
  appendLedger(ctx.cwd, "extension_api_stale", { where: `entry probe (${what})` });
  ctx.ui.notify(
    `glla: this session's extension handle is stale (pi session replacement) — ${what} can't send continuations in this process. State is safe in .pi-glla/ — run /reload (extensions rebuild in place), then /glla resume. Restart pi only if /reload fails.`,
    "warning",
  );
  // v0.29.22: deliberately NO self-heal from the entry probe — it fires
  // when the user is ACTIVELY typing a /glla command, and injected
  // keystrokes would race their input. User-present cases keep the manual
  // warning; the self-heal stays on the autonomous paths (heartbeat
  // probe, send paths) where no one is at the keyboard.
  return true;
}

/** v0.28.12: draft-class confirm with the auto-accept escape hatch SURFACED.
 * The polis incident: a user sat through a 14-item batch Confirm having
 * already reviewed every item during drafting, never knowing /glla
 * autoaccept=on existed — the Yes/No dialog never mentioned it. Now every
 * draft dialog is a 3-choice select; the ALWAYS choice persists project
 * autoAcceptDrafts=true and accepts. Returns "stale" when the dialog can't
 * render (session replacement) so call sites keep their NOT-a-rejection
 * handling; falls back to the plain confirm if select is unavailable. */
type DraftChoice = "yes" | "no" | "stale";
async function confirmDraft(ctx: ExtensionContext, title: string, body: string): Promise<DraftChoice> {
  const ALWAYS = "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)";
  try {
    const choice = await ctx.ui.select(`${title}\n\n${body}`, ["Yes", ALWAYS, "No"]);
    if (choice === ALWAYS) {
      saveSettings("project", ctx.cwd, { autoAcceptDrafts: true });
      appendLedger(ctx.cwd, "draft_autoaccept_enabled", { via: title });
      ctx.ui.notify("Draft auto-accept ON for this project — future draft confirms are skipped. Undo: /glla autoaccept=off.", "info");
      return "yes";
    }
    return choice === "Yes" ? "yes" : "no";
  } catch (err) {
    if (isStaleApiError(err)) return "stale";
    try {
      return (await ctx.ui.confirm(title, body)) ? "yes" : "no";
    } catch (err2) {
      return isStaleApiError(err2) ? "stale" : "no";
    }
  }
}

// v0.28.14: ONE summary + policy application for stale carryover when NEW
// work activates. pause (default): surface what's waiting, stack nothing
// silently. clear: drop the queue, dismiss the held loop, archive the
// paused goal — honestly, with a ledger trail. resume: legacy silent
// behavior. A new GOAL replacing a paused one archives it in every policy
// (one-active-thing: state.goal holds exactly one goal).
function resolveCarryover(ctx: ExtensionContext, trigger: "goal" | "loop" | "list"): void {
  if (carryoverResolved || !carryoverSnapshot) return;
  carryoverResolved = true;
  const snap = carryoverSnapshot;
  carryoverSnapshot = null;
  const policy = loadSettings(ctx.cwd).carryover ?? "pause";
  if (policy === "resume") return; // legacy silent stacking
  const done: string[] = [];
  const waiting: string[] = [];
  const pausedGoal = state.goal && state.goal.status === "paused" ? state.goal : null;
  // A new goal OR list item replaces the goal slot; a loop leaves it paused.
  if (pausedGoal && (trigger === "goal" || trigger === "list" || policy === "clear")) {
    archiveCurrentGoal(ctx, "aborted", trigger === "loop" ? "carryover cleared" : `replaced by new ${trigger} (carryover)`);
    done.push(`archived paused goal "${(snap.pausedGoal ?? pausedGoal.objective).slice(0, 60)}"`);
  } else if (snap.pausedGoal) {
    waiting.push(`paused goal "${snap.pausedGoal}" (/goal resume)`);
  }
  if (snap.listCount > 0) {
    if (policy === "clear") {
      state = { ...state, list: [] };
      done.push(`dropped ${snap.listCount} waiting list item(s)`);
    } else {
      waiting.push(`${snap.listCount} waiting list item(s) (/list next)`);
    }
  }
  if (snap.heldLoop) {
    if (policy === "clear" && state.loop && !state.loop.active && state.loop.stopReason === HELD_ON_RESTORE) {
      state.loop = { ...state.loop, stopReason: "cleared: carryover" };
      done.push(`dismissed held loop "${snap.heldLoop}"`);
    } else {
      waiting.push(`held loop "${snap.heldLoop}" (/loop to resume)`);
    }
  }
  persistState(ctx);
  appendLedger(ctx.cwd, "carryover_resolved", { policy, trigger, cleared: done.length, waiting: waiting.length });
  const summary = [...done.map((d) => `✂ ${d}`), ...waiting.map((w) => `⏸ ${w}`)].join(" · ");
  if (!summary) return;
  ctx.ui.notify(
    policy === "clear"
      ? `Carryover cleared (${trigger}): ${summary}`
      : `Carryover from before this session: ${summary}${waiting.length > 0 ? " — /glla carryover=clear drops these automatically." : ""}`,
    "info",
  );
}

// The most recent ExtensionContext seen from any event or command handler.
// pi replaces sessions (newSession/fork/reload) and stale ctx throws on use,
// so timers must never capture a ctx — they read lastCtx at fire time.
let lastCtx: ExtensionContext | null = null;
// v0.23.8: the session that OWNS the loop (its sessionManager). Subagent
// sessions (pi-subagents binds extensions there too) fire our handlers
// with their own ctx — they must never take over lastCtx (a headless
// subagent ctx would silently kill the heartbeat/wedge machinery).
let ownerSession: unknown = null;

function rememberCtx(ctx: ExtensionContext): void {
  let ownerLive = false;
  if (ownerSession && lastCtx) {
    try { lastCtx.isIdle(); ownerLive = true; } catch { /* owner went stale (session replaced) */ }
  }
  const claim = classifySessionCtx(ownerSession, ownerLive, ctx.sessionManager);
  if (claim === "foreign") return;
  ownerSession = ctx.sessionManager;
  lastCtx = ctx;
}

/** True when ctx belongs to a subagent/foreign session, not the loop owner. */
function isForeignCtx(ctx: ExtensionContext): boolean {
  return ownerSession !== null && ctx.sessionManager !== ownerSession;
}

const FOREIGN_SESSION_TOOL_MESSAGE =
  "This tool changes goal/loop/list state, which only the MAIN session owns — you are running in a subagent session. Report back to the main agent; it owns the goal and can call this tool.";

/** Refusal message when a state-mutating tool is called from a subagent session, else null. */
function foreignToolGuard(execCtx: unknown): string | null {
  const c = execCtx as ExtensionContext | undefined;
  return c && isForeignCtx(c) ? FOREIGN_SESSION_TOOL_MESSAGE : null;
}

let state: State = { goal: null };

// Drafting mode: a no-arg loop command starts a clarification turn; the agent
// must call propose_goal_draft / propose_loop_draft, which opens the user's
// Confirm dialog. The target decides where the confirmed contract lands.
let draftingTarget: "goal" | "list" | "loop" | null = null;
// v0.14.0 drafting floor: user replies counted while drafting; the injected
// seed prompt itself arrives as a user message — skip exactly that one.
let draftingUserReplies = 0;
let draftingBlockedProposals = 0; // v0.15.1: stuck-gate escape hatch
let draftingSeedInFlight = false;

// Dedup set for token accounting (agent_end may replay seen messages).
const countedTokenMessages = new Set<string>();
const countedLoopTokenMessages = new Set<string>();

// Heartbeat self-watchdog state: liveness is the loop's own job.
let lastActivityAt = Date.now();
// v0.29.16: zombie-run watchdog clock — updated ONLY by genuine pi stream
// events (message_update / tool_call / agent_start / turn_start /
// agent_end), never by heartbeat-internal bookkeeping. A session pi
// reports as BUSY with zero stream events for N min is a hung provider
// stream (pi has no read timeout): continuations queue into the void and
// the busy flag conceals the wedge from every other watchdog (field:
// hellhunter + hegemon 2026-07-30, MiniMax streams died silently).
let lastStreamActivityAt = Date.now();
let lastZombieAlertAt = 0;
let lastWedgeAlertAt = 0;
let heartbeatNudges = 0;
// v0.28.4 (P3): skip nudge accounting for the first agent_end turns after a
// session_start restore — recovery chatter is not a stall.
let postRestoreGraceTurns = 0;
// v0.26.1: consecutive heartbeat refires that produced NO real agent turn.
// Resets only on real activity (agent_end / tool_call) — never on the
// refire's own noteActivity, which is what made the hegemon zombie spin
// self-sustaining (619 refires / 23.5h / zero turns).
let consecutiveStalls = 0;
// v0.28.14: carryover snapshot — unfinished work loaded from disk at
// session_start (predates this session). Resolved ONCE per session at the
// first NEW activation (new goal / new loop) per the carryover setting.
let carryoverSnapshot: { pausedGoal?: string; listCount: number; heldLoop?: string } | null = null;
let carryoverResolved = true;
// v0.26.6: precise replacement for the removed ship-recency suppression —
// set while complete_goal's isolated audit runs, so the heartbeat never
// refires into an in-flight completion.
let completionAuditInFlight = false;
// v0.32.0: consecutive stored-claim quota retries (capped at 5, then hold).
let quotaRetryStreak = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

const ZOMBIE_RUN_SILENT_MS = 20 * 60_000;
const ZOMBIE_RUN_ALERT_THROTTLE_MS = 10 * 60_000;
// v0.34.11: unanswered-continuation watchdog. Hellhunter 2026-08-01: at a
// list-transition completion boundary pi ACCEPTED every continuation
// (sendMessage never threw; session reported idle) but started NO turn —
// transcript frozen, tokens flat, 10+ minutes of refires into the void.
// Same family as the post-compaction dropped trigger (v0.26.5), but the
// the pending latch needs idle&&pending and pi reported no pending
// here, and the zombie watchdog needs busy — this shape falls between both
// chairs. Disarm signal = real activity (agent_end/tool_call) AFTER the
// last send; a landed turn — even a lazy text-only one — disarms it.
const CONTINUATION_UNANSWERED_MS = 150_000;
const CONTINUATION_UNANSWERED_THROTTLE_MS = 300_000;
// v0.34.12: eager-continuation settle delay. Hellhunter 2026-08-01 (post-
// restart): every turn cycle paid a 60s heartbeat tax because the eager
// continuation fires AT agent_end — exactly pi's turn-teardown blackhole
// window — so it vanished and the 60s heartbeat refire did the real work.
// Ledger showed the tell: goal_continuation_sent pairs + a refire per
// cycle. Sending 2.5s AFTER agent_end lets teardown settle; the send lands
// and the next turn starts immediately. 2.5s per turn beats 60s per turn.
const EAGER_CONTINUATION_SETTLE_MS = Number(process.env.GLLA_EAGER_SETTLE_MS ?? 2_500);
// v0.34.13: auto-recovery ladder ("keep going unless we MUST stop — a
// question, or done" — user directive 2026-08-01). A wedge that only a
// /reload cures should /reload ITSELF: inject the keystrokes (v0.29.13
// transport) with a sidecar marker so the fresh instance RESUMES even when
// autoresume=off (the consent came from autoRecovery at recovery time, not
// the restore-time setting). Throttled to one attempt per window: a
// recurrence inside the window is the transcript-writer-dead class, which
// only a pi restart cures — that one stays a loud stop for the human.
const AUTO_RECOVERY_THROTTLE_MS = 600_000;
const RECOVERY_RESUME_MARKER = "recovery-resume.json";
const RECOVERY_RESUME_FRESH_MS = 300_000;
// v0.29.19: dead-turn caps (agent_end exemption path). 6 consecutive
// provider-error turns = a real outage, not bad luck — stop honestly.
// 3 consecutive user aborts = the user means it (user aborts mean STOP).
const LOOP_MAX_CONSECUTIVE_ERRORS = 6;
const LOOP_MAX_CONSECUTIVE_ABORTS = 3;

let lastRealActivityAt = 0;
let lastContinuationSentAt = 0;
let lastUnansweredAlertAt = 0;

function noteActivity(real = false): void {
  lastActivityAt = Date.now();
  if (real) { consecutiveStalls = 0; lastRealActivityAt = lastActivityAt; }
}

function isSupervising(): boolean {
  return isLoopActive() || (!!state.goal && state.goal.status === "active" && state.goal.autoContinue);
}

// =================================================================
// Live TUI (v0.9.0): persistent status segment + above-editor widget.
// "Can't tell if it's on" is a bug, not a nice-to-have.
// =================================================================

let latestAuditProgress: AuditDisplayProgress | null = null;
let uiTicker: NodeJS.Timeout | null = null;

// v0.33.0: slim widget "last action" feed — a tiny ring of finished tool
// calls {name, arg, ms, ok} captured from the tool_call/tool_result stream.
// Display-only, never persisted; cleared implicitly as new actions land.
const recentActions: import("../goal-loop-display.js").RecentActionDisplay[] = [];
const inFlightToolCalls = new Map<string, { name: string; arg?: string; at: number }>();
function summarizeToolArg(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.title;
  if (typeof v !== "string" || v.length === 0) return undefined;
  // v0.33.1: strip control chars BEFORE truncating — a raw \n breaks the
  // widget card into un-prefixed lines (footer spoof), a raw ESC corrupts
  // the TUI. The objective path was already whitespace-collapsed; this
  // path was the gap.
  const base = (name === "bash" ? v : v.split("/").pop() || v).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return base.length <= 24 ? base : base.slice(0, 23) + "…";
}
function noteToolCall(event: any): void {
  const name = String(event?.toolName ?? "?");
  const id = String(event?.toolCallId ?? event?.id ?? `anon-${Date.now()}`);
  if (inFlightToolCalls.size >= 20) inFlightToolCalls.delete(inFlightToolCalls.keys().next().value!); // v0.33.1: evict BEFORE the 21st
  inFlightToolCalls.set(id, { name, arg: summarizeToolArg(name, event?.input ?? event?.args), at: Date.now() });
}
function noteToolResult(event: any): void {
  const id = String(event?.toolCallId ?? event?.id ?? "");
  const f = id ? inFlightToolCalls.get(id) : undefined;
  if (id) inFlightToolCalls.delete(id);
  const ok = !Boolean(event?.isError ?? event?.error);
  const name = f?.name ?? String(event?.toolName ?? "?");
  recentActions.push({ name, arg: f?.arg ?? summarizeToolArg(name, event?.input ?? event?.args), ms: f ? Date.now() - f.at : 0, ok });
  if (recentActions.length > 3) recentActions.shift();
}

function refreshUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    const theme = ctx.ui.theme as unknown as import("../goal-loop-display.js").DisplayTheme | undefined;
    // Terminal width for truncation budgets: on wide terminals the widget
    // uses the room instead of cutting at fixed ~60-char floors.
    const width = process.stdout.columns || 80;
    ctx.ui.setStatus("pi-glla", buildStatusText(state, latestAuditProgress, Date.now(), theme, { stalls: consecutiveStalls }));
    ctx.ui.setWidget("pi-glla", buildWidgetLines(state, latestAuditProgress, Date.now(), theme, width, { stalls: consecutiveStalls, recent: recentActions }));
  } catch {
    // stale ctx — next event refreshes
  }
}

function startUITicker(): void {
  if (uiTicker) return;
  uiTicker = setInterval(() => {
    const ctx = freshCtx();
    // v0.34.12: keep ticking during a timed wait-pause too — the status
    // line counts down to resumeAt live (pully field request 2026-08-01).
    if (ctx && (isSupervising() || (state.goal?.status === "paused" && !!state.goal.pauseResumeAt))) refreshUI(ctx);
  }, 1_000);
  uiTicker.unref?.();
}

/** v0.26.5: shared loud-stop for both stall paths (refire streak and
 * pending-latch streak). Returns true when it escalated. */
// v0.28.5 (E3): send-retry re-arm accounting. The 50ms BACKOFF_IDLE_RETRY
// re-arm loop used to spin for HOURS with zero ledger events while the idle
// watchdogs stayed suppressed. Now: counted, ledgered (start + every 30s),
// and escalated loudly past 5 minutes.
let continuationRearmStreak = 0;
let loopRearmStreak = 0;
// v0.28.24: post-compaction grace — a just-replaced session gets 3 minutes
// to settle (queue drain, provider recovery) before stall counting resumes.
// Field-observed in junk-runner: a 196k-token compact finished, then the
// heartbeat burned all 5 stall refires in the next 5 minutes into a session
// whose turn trigger was still dead — pausing a resumable goal 4 minutes
// after the compact instead of giving pi room to recover.
let compactionGraceUntil = 0;
// v0.32.1 (pi-goal-x's lesson — "recover from compacts smarter"): a compact
// leaves a RESUME DEBT, not just two fixed-offset settle probes that can both
// lose (field: hellhunter 4-min dangle 2026-07-31; polis stall same day).
// postCompactResumeOwed discharges only when a real turn starts (agent_start);
// every heartbeat tick past grace retries it. postCompactResyncPending arms a
// deterministic [POST-COMPACTION RESYNC] block on the next continuation/loop
// message (pi-goal-x's #5) so the compacted agent re-anchors on artifact
// state instead of lost chat history.
let postCompactResumeOwed = false;
let postCompactResyncPending = false;
const COMPACTION_GRACE_MS = 3 * 60_000;
// v0.28.25: provider-error retry cadence. Field-observed in dracon-utilities
// (kimi, 19-session fleet on one provider account): a "concurrent request
// limit" 403 storm got 5 retries BACK-TO-BACK (delay 0 after each errored
// turn — the session is idle at agent_end, so scheduleContinuation fired
// instantly) and the brake then cycled on a flat 60s cooldown for 1h 38m.
// The condition clears on a minutes-to-fleet scale, not milliseconds:
// ladder the inter-error retries (5s, 15s, 45s, 90s, 3m — the 5-retry
// budget now spans ~5.5m) and escalate the brake cooldown per consecutive
// brake (1m, 2m, 4m, 8m, 16m cap). A successful turn resets both.
const ERROR_RETRY_LADDER_MS = [5_000, 15_000, 45_000, 90_000, 180_000];
const SEND_REARM_LEDGER_MILESTONES_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
// v0.28.29: escalation is TIME-based and ACTIVITY-gated. A busy session is
// NORMAL — the user conversing, or one long subagent turn — and the old
// flat-50ms × 6000-count rule misread 5 minutes of busy as "wedged" and
// paused the goal (the polis field report). Escalate only after 15 minutes
// of failed sends AND no session activity in the last 5 minutes (a wedged
// queue shows no events at all; a busy one streams constantly).
const SEND_REARM_ESCALATE_AFTER_MS = 15 * 60_000;
const SEND_REARM_ESCALATE_SILENT_MS = 5 * 60_000;
let continuationRearmSince = 0;
let loopRearmSince = 0;
let continuationRearmMilestone = 0;
let loopRearmMilestone = 0;

/** v0.28.29: busy-retry cadence backs off — 50ms for the first beats
 * (instant pickup right after a turn ends), then 250ms, 1s, 5s, 15s, 30s
 * cap. agent_end reschedules independently, so the slow tail costs nothing
 * in the common case; it only caps the ledger/CPU spam of a long busy stretch. */
function sendRearmDelayMs(streak: number): number {
  if (streak <= 4) return 50;
  if (streak <= 8) return 250;
  if (streak <= 12) return 1_000;
  if (streak === 13) return 5_000;
  if (streak === 14) return 15_000;
  return 30_000;
}

function accountSendRearm(ctx: ExtensionContext, kind: "continuation" | "loop"): void {
  const streak = kind === "continuation" ? ++continuationRearmStreak : ++loopRearmStreak;
  if (streak === 1) {
    if (kind === "continuation") { continuationRearmSince = Date.now(); continuationRearmMilestone = 0; } else { loopRearmSince = Date.now(); loopRearmMilestone = 0; }
    appendLedger(ctx.cwd, "send_rearm_start", { kind });
    return;
  }
  const since = kind === "continuation" ? continuationRearmSince : loopRearmSince;
  const elapsed = Date.now() - since;
  const milestone = kind === "continuation" ? continuationRearmMilestone : loopRearmMilestone;
  if (milestone < SEND_REARM_LEDGER_MILESTONES_MS.length && elapsed >= SEND_REARM_LEDGER_MILESTONES_MS[milestone]!) {
    if (kind === "continuation") continuationRearmMilestone++; else loopRearmMilestone++;
    appendLedger(ctx.cwd, "send_rearm_storm", { kind, streak, minutes: Math.round(elapsed / 60000) });
  }
  if (elapsed >= SEND_REARM_ESCALATE_AFTER_MS && Date.now() - lastActivityAt >= SEND_REARM_ESCALATE_SILENT_MS) {
    if (kind === "continuation") { continuationRearmStreak = 0; continuationRearmSince = 0; } else { loopRearmStreak = 0; loopRearmSince = 0; }
    escalateSendRearmStorm(ctx, kind);
  }
}

function escalateSendRearmStorm(ctx: ExtensionContext, kind: "continuation" | "loop"): void {
  // Same loud-terminal shape as escalateStallNow (v0.24.7). v0.28.29: this
  // only fires on a REAL wedge now (15m of failed sends + 5m of zero
  // session activity) — busy-but-alive sessions never reach it.
  const mins = Math.round(SEND_REARM_ESCALATE_AFTER_MS / 60000);
  const silent = Math.round(SEND_REARM_ESCALATE_SILENT_MS / 60000);
  appendLedger(ctx.cwd, "send_rearm_escalated", { kind, afterMinutes: mins, silentMinutes: silent });
  if (kind === "loop" && isLoopActive()) {
    if (attemptAutoRecovery(ctx, "send-retry storm")) {
      appendLedger(ctx.cwd, "send_rearm_escalated_suppressed", { reason: "auto-recovery reload" });
      return;
    }
    clearLoopTimer();
    state.loop = { ...state.loop!, active: false, stopReason: `send-retry storm: ${mins}m of re-arms with no session activity for ${silent}m — the session is wedged. Press Escape to cancel the stuck run (pi's own rate-limit retry holds it; pi prints "escape to cancel"), then /loop resume — the loop holds on restore. If still wedged: /reload rebuilds extensions in place, then /loop resume again. Restart pi only if /reload itself fails.` };
    persistState(ctx);
    ctx.ui.notify(`Loop stopped: send-retry storm (${mins}m, session silent ${silent}m). Escape cancels the stuck run, then /loop resume (the loop holds on restore). /reload if it persists; restart pi only if /reload fails.`, "warning");
    notifyExternal(ctx, "Loop stopped: send-retry storm.");
    return;
  }
  if (
    state.goal &&
    (state.goal.status === "auditing" || completionAuditInFlight || state.goal.pendingCompletion)
  ) {
    // v0.29.1: NEVER storm-pause the completion lifecycle. An isolated
    // auditor run takes minutes and the main session is EXPECTED to be
    // silent while it works — 15m of wedged re-arms + that silence is the
    // exact trigger shape, so completing a goal under a wedged queue used
    // to guarantee a mid-audit pause (field-observed in pully + hellhunter
    // + junk-runner: "complete ending in a pause retry storm"). The audit
    // lifecycle owns its own pauses (quota etc.).
    appendLedger(ctx.cwd, "send_rearm_escalated_suppressed", { reason: "audit-lifecycle" });
    ctx.ui.notify("Send-retry storm during the completion audit — NOT pausing; the auditor's silence is expected. If pi is wedged, Escape cancels the stuck run; the stored claim survives.", "info");
    return;
  }
  if (state.goal && state.goal.status === "active") {
    // v0.34.13: keep going unless we MUST stop — try the auto-recovery
    // /reload before spending the user's attention on a pause. A reload
    // that fails to cure throttles the next attempt, and the pause below
    // fires then as today.
    if (attemptAutoRecovery(ctx, "send-retry storm")) {
      appendLedger(ctx.cwd, "send_rearm_escalated_suppressed", { reason: "auto-recovery reload" });
      return;
    }
    updateGoal({
      status: "paused",
      pauseKind: "error",
      pauseReason: `send-retry storm: ${mins}m of re-arms with no session activity for ${silent}m — the session never went idle for the continuation`,
      pauseSuggestedAction: "The session produced no events while the send retried (wedged queue — often pi's own rate-limit retry holding the run; pi prints 'escape to cancel'). Press Escape, then /goal resume. If still wedged: /reload rebuilds extensions in place, then /goal resume again. Restart pi only if /reload fails.",
    }, ctx);
    ctx.ui.notify(`${goalNoun()} paused: send-retry storm (${mins}m, session silent ${silent}m). Escape cancels the stuck run, then /goal resume. /reload if it persists; restart pi only if /reload fails.`, "warning");
    notifyExternal(ctx, `${goalNoun()} paused: send-retry storm.`);
  }
}

function escalateStallNow(ctx: ExtensionContext, threshold: number): boolean {
  if (!shouldEscalateStall(consecutiveStalls, threshold)) return false;
  consecutiveStalls = 0;
  appendLedger(ctx.cwd, "stall_escalated", { threshold, kind: isLoopActive() ? "loop" : "goal" });
  // v0.34.13: recovery before stop — usually throttled (the 2.5min
  // watchdog already tried), in which case the stop proceeds as today.
  if (attemptAutoRecovery(ctx, "stall escalation")) {
    appendLedger(ctx.cwd, "stall_escalated_suppressed", { reason: "auto-recovery reload", threshold });
    return true;
  }
  if (isLoopActive()) {
    clearLoopTimer();
    state.loop = { ...state.loop!, active: false, stopReason: `stalled: ${threshold} continuation refires landed no turn — the session is not continuing (wedged message queue or stale API). Press Escape to cancel any stuck run, then /loop resume — the loop holds on restore. If the handle is stale, /reload rebuilds extensions in place; restart pi only if /reload fails.` };
    persistState(ctx);
    ctx.ui.notify(`Loop stopped: ${threshold} refires produced no turn — the continuation is not landing. Escape cancels a stuck run, then /loop resume (the loop holds on restore). /reload if stale; restart pi only if /reload fails.`, "warning");
    notifyExternal(ctx, "Loop stopped: stalled (continuation not landing).");
    return true;
  }
  if (state.goal && state.goal.status === "active") {
    updateGoal({
      status: "paused",
      pauseKind: "error",
      pauseReason: `stalled: ${threshold} continuation refires landed no turn`,
      pauseSuggestedAction: "The continuation chain is broken in this process (wedged message queue or stale API). Press Escape to cancel any stuck run, then /goal resume. If the handle is stale, /reload rebuilds extensions in place — restart pi only if /reload fails.",
    }, ctx);
    ctx.ui.notify(`${goalNoun()} paused: ${threshold} refires produced no turn. Escape cancels a stuck run, then /goal resume. /reload if stale; restart pi only if /reload fails.`, "warning");
    notifyExternal(ctx, `${goalNoun()} paused: stalled (continuation not landing).`);
    return true;
  }
  return true;
}

function heartbeatTick(): void {
  if (zombieStoodDown) return; // v0.30.0: a superseded instance stays silent forever
  const ctx = freshCtx();
  if (!ctx) return;
  let idle = false;
  let pending = false;
  try {
    idle = ctx.isIdle();
    pending = ctx.hasPendingMessages();
  } catch {
    return;
  }
  const sessionIdle = idle && !pending;
  // v0.28.24: post-compaction grace — the whole stall/refire/watchdog
  // machinery below stays quiet for 3 minutes while the replaced session
  // settles (latch watchdog, wedge alert, refire counting all resume after).
  if (Date.now() < compactionGraceUntil) return;
  // v0.29.11: PROBE the handle before the stall machinery runs — a
  // session-replaced handle can never land a refire, so detect it on the
  // first tick after replacement and go terminal immediately, instead of
  // burning refires into the void until a send happens to throw (field:
  // polis stall 3/5, endless-td stall 1/5 before the warning fired).
  // v0.28.27: once terminal, ALL stall machinery stays quiet from here
  // on: refiring into a dead process is misleading, and worse, the stall
  // escalation would PAUSE the goal — silently cancelling the
  // interruptedAt → hold-on-restart promise the footer shows.
  if (probeExtensionApiStale()) {
    // v0.30.0: stale ≠ terminal — absorb the rebind-window and
    // successor-instance cases; only orphans go terminal.
    if (!absorbStaleIfSuperseded(ctx)) goStaleTerminal(ctx, "heartbeat probe");
    return;
  }
  // v0.33.1: nothing supervised → the compact debt/resync belong to a dead
  // goal/loop. Discharge here so a later goal can't inherit a bogus RESYNC
  // block or a spurious forced refire (the old in-guard `else` was
  // unreachable — isSupervising() ≡ isLoopActive() || isActionableGoal()).
  if (!isSupervising() && (postCompactResumeOwed || postCompactResyncPending)) {
    postCompactResumeOwed = false;
    postCompactResyncPending = false;
  }
  // v0.32.1: post-compaction resume debt — retry on every heartbeat tick
  // past grace until a turn actually starts. Fixed-offset settles alone
  // can both lose (pi busy at 2s AND at grace+2s = a dangling chain).
  if (postCompactResumeOwed && isSupervising() && !abortedStandDown) {
    try {
      if (ctx.isIdle() && !ctx.hasPendingMessages() && continuationTimer === null && loopTimer === null) {
        if (isLoopActive()) {
          appendLedger(ctx.cwd, "compaction_resume_owed_refire", { kind: "loop" });
          scheduleLoopTick(ctx);
        } else if (isActionableGoal()) {
          appendLedger(ctx.cwd, "compaction_resume_owed_refire", { kind: "goal" });
          scheduleContinuation(ctx, true);
        } else {
          postCompactResumeOwed = false; // nothing to resume — discharge
        }
      }
    } catch { /* next tick */ }
  }
  // v0.29.16: zombie-run watchdog. pi reports BUSY (a run is "active") but
  // zero stream events for 20 min = the provider stream hung silently —
  // queued continuations can't land, and every other watchdog stays quiet
  // because busy≠wedged. Detection + loud guidance only: aborting a turn
  // is the user's call (consent line); Esc frees the queue and the
  // heartbeat refires the goal/loop by itself.
  const streamSilentMs = Date.now() - lastStreamActivityAt;
  if (isSupervising() && !idle && streamSilentMs >= ZOMBIE_RUN_SILENT_MS && Date.now() - lastZombieAlertAt >= ZOMBIE_RUN_ALERT_THROTTLE_MS) {
    lastZombieAlertAt = Date.now();
    appendLedger(ctx.cwd, "zombie_run_suspected", { streamSilentMs, pending });
    ctx.ui.notify(`glla: the session has been BUSY with zero stream activity for ${Math.round(streamSilentMs / 60000)} min — the provider stream is hung (pi never times it out; queued continuations can't land). Press Esc to abort the zombie turn — the goal/loop refires itself.`, "warning");
    notifyExternal(ctx, `glla: zombie run suspected (${Math.round(streamSilentMs / 60000)} min busy-silent) — press Esc to abort.`);
    return;
  }
  // v0.34.11: unanswered-continuation watchdog — pi took the send but no
  // turn started (no agent_end, no tool call, no stream). Re-sends don't
  // unstick a dropped trigger (hegemon law) — this alert's job is to say
  // the cure LOUDLY at ~2.5 min instead of leaving a silent 20-30 min gap
  // before the zombie/wedge alerts. Does NOT return: the heartbeat refire
  // below keeps sending underneath in case pi unsticks by itself.
  if (
    isSupervising() &&
    lastContinuationSentAt > 0 &&
    lastRealActivityAt < lastContinuationSentAt &&
    Date.now() - lastContinuationSentAt >= CONTINUATION_UNANSWERED_MS &&
    Date.now() - lastUnansweredAlertAt >= CONTINUATION_UNANSWERED_THROTTLE_MS
  ) {
    lastUnansweredAlertAt = Date.now();
    appendLedger(ctx.cwd, "continuation_unanswered", { silentMs: Date.now() - lastContinuationSentAt });
    // v0.34.13: recover, don't just report. Only the failure modes reach
    // the user: throttled (a reload already failed to cure → the
    // pi-restart class) or recovery unavailable (setting off / no pane).
    if (!attemptAutoRecovery(ctx, "continuation unanswered")) {
      const mins = Math.round((Date.now() - lastContinuationSentAt) / 60_000);
      const msg = lastAutoRecoveryAt > 0
        ? `glla: auto-recovery /reload did NOT unstick this session — still no turn ${mins}m after the continuation. This class kills pi's transcript writer; only a pi RESTART cures it: restart pi in this tab, then /glla resume (the goal holds in .pi-glla state).`
        : `glla: pi accepted the continuation ${mins}m ago but NO turn has started — no tool calls, no tokens, transcript frozen (the turn trigger is wedged). Cure: /reload — autoresume re-fires the ${isLoopActive() ? "loop" : "goal/list item"}. (auto-recovery is off or no tmux/WezTerm pane — /glla settings autoRecovery=on enables the automatic form.)`;
      ctx.ui.notify(msg, "warning");
      notifyExternal(ctx, msg);
    }
  }
  // v0.29.1: stranded-audit recovery. A goal left in "auditing" with NO
  // in-flight audit means the auditor's result never landed (wedged queue
  // ate the tool result; compaction/restart mid-audit). Field-observed in
  // pully: 12h+ stuck "auditing" while the model had already confabulated
  // the closure narrative. The audit silence is expected ONLY while
  // completionAuditInFlight — its absence here means the run is orphaned.
  // Recover: a stored claim re-runs the auditor directly; otherwise resume
  // active so the agent re-calls complete_goal.
  if (
    state.goal?.status === "auditing" &&
    !completionAuditInFlight &&
    Date.now() - lastActivityAt >= 90_000
  ) {
    appendLedger(ctx.cwd, "stranded_audit_recovered", { goalId: state.goal.id, via: state.goal.pendingCompletion ? "stored-claim" : "resume-active" });
    if (state.goal.pendingCompletion) {
      ctx.ui.notify("Recovering a completion audit whose result never landed — re-running the auditor with the stored claim.", "info");
      void retryStoredCompletionAudit(ctx, "quota-retry");
    } else {
      updateGoal({ status: "active" }, ctx);
      ctx.ui.notify("A completion audit was interrupted (its result never landed). Resuming — re-call complete_goal when the deliverable still stands.", "warning");
      scheduleContinuation(ctx, true);
    }
    return;
  }
  // v0.26.5: pending-latch watchdog — a queued continuation whose turn
  // trigger was dropped (field-observed post-compaction: continuation
  // ACCEPTED at compact+0s, then 22 minutes of silence). The stuck latch
  // keeps sessionIdle false, which suppresses the refire path AND the
  // stall escalation below — without this branch the session is silent
  // forever. We never re-send here (the message is already queued
  // pi-side; hegemon proved re-sends don't unstick a dropped trigger) —
  // count, notify, escalate to a loud stop.
  const latchSilentMs = Date.now() - lastActivityAt;
  if (
    shouldFirePendingLatchWatchdog({
      supervising: isSupervising(),
      idle,
      pending,
      timerPending: continuationTimer !== null || loopTimer !== null,
      silentMs: latchSilentMs,
      thresholdMs: PENDING_LATCH_STUCK_MS,
    })
  ) {
    consecutiveStalls++;
    appendLedger(ctx.cwd, "pending_latch_stuck", { consecutiveStalls, silentMs: latchSilentMs });
    noteActivity(); // re-arm the 3-minute cadence; never resets the stall streak
    const stallEscalation = loadSettings(ctx.cwd).stallEscalationRefires ?? DEFAULT_STALL_ESCALATION_REFIRES;
    if (escalateStallNow(ctx, stallEscalation)) return;
    const msg = `Heartbeat: a queued continuation never started its turn for ${Math.round(latchSilentMs / 60_000)}m — pi's pending-message latch appears stuck (known post-compaction failure; stall ${consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}). If this repeats, restart pi.`;
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
    return;
  }
  const fire = shouldHeartbeatRefire({
    supervising: isSupervising(),
    sessionIdle,
    timerPending: continuationTimer !== null || loopTimer !== null,
    msSinceActivity: Date.now() - lastActivityAt,
    stallMs: HEARTBEAT_STALL_MS,
    consecutiveStalls,
  });
  // Wedge alert (v0.23.2): session BUSY but silent for the threshold —
  // the classic hung-command case (a test suite that never exits holds
  // the entire goal hostage; field-observed at 5,056s and 6,800s on the
  // same wedged tool call). Independent of the refire path, which only
  // watches idle sessions.
  const wedgeMinutes = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).wedgeAlertMinutes ?? WEDGE_ALERT_DEFAULT_MINUTES;
  if (
    shouldWedgeAlert({
      supervising: isSupervising(),
      // v0.26.5: !idle, not !sessionIdle — an idle session with a stuck
      // pending latch is the watchdog's job above, not a "hung command".
      sessionBusy: !idle,
      silentMs: Date.now() - lastActivityAt,
      msSinceLastAlert: Date.now() - lastWedgeAlertAt,
      thresholdMs: wedgeMinutes * 60_000,
    })
  ) {
    lastWedgeAlertAt = Date.now();
    // v0.34.5: a wedge while blocked on a subagent wait is a DIFFERENT animal
    // from a hung bash command (junk-runner 2026-08-01: 2 Explore agents
    // "thinking…" 31 minutes — working, but indistinguishable from hung
    // without this hint). Name the wait and give the liveness check: a child
    // whose tool-use counter stops moving is hung, not thinking.
    const subWaits = new Set(
      [...inFlightToolCalls.values()]
        .filter((t) => t.name === "get_subagent_result" || t.name === "Agent")
        .map((t) => t.name),
    );
    const subHint = subWaits.size > 0
      ? ` The in-flight call is a SUBAGENT WAIT (${[...subWaits].join("/")}) — check the Agents panel: a child whose tool-use/token counters have stopped moving between checks is hung, not thinking (hard failures surface as ✗ failed + the wait returns; a HANG is silent). Esc interrupts the wait — then collect the survivors with get_subagent_result and absorb the dead scope inline.`
      : "";
    const msg = `${goalNoun()} appears wedged: no activity for ${Math.round((Date.now() - lastActivityAt) / 60_000)}m while the session is busy — likely a hung command (test/build/dev server without a timeout).${subHint} Check the session; Esc kills a stuck tool call.`;
    appendLedger(ctx.cwd, "wedge_alert", { silentMs: Date.now() - lastActivityAt, subagentWait: subWaits.size > 0 });
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
  }
  // v0.29.5: user-abort stand-down — the chain stays DOWN until the
  // user resumes. Without this guard the 60s heartbeat re-fired the
  // continuation and defeated the 0.29.4 stand-down within a minute.
  if (abortedStandDown) return;
  if (!fire) return;
  // v0.26.6: the 0.25.0 "recent ship (<5m)" suppression was REMOVED. It fed
  // lastShippedAtMs, which read the state-file MTIME — and the heartbeat's
  // own suppressed-tick ledger writes refreshed that mtime every 15s,
  // making the suppression self-sustaining forever (field-observed in
  // darklord: 2,184 suppressed ticks over 9.1h after a post-compaction
  // send failure; the completed list item never closed). Under an
  // auto-committing daemon the git-head term self-sustains too. The legit
  // windows are already covered precisely — busy mid-turn, pending
  // messages, scheduled timers — plus the audit-in-flight flag below.
  if (completionAuditInFlight) return;
  noteActivity();
  consecutiveStalls++;
  appendLedger(ctx.cwd, "heartbeat_refire", { nudgesSoFar: heartbeatNudges, consecutiveStalls });
  // v0.26.1: a refire streak means the continuation is NOT landing (wedged
  // message queue, stale API handle, dead turn trigger). Nudges can't catch
  // this — they count turns, and a zombie runs none. Escalate to a loud,
  // actionable stop instead of spinning silently forever.
  const stallEscalation = loadSettings(ctx.cwd).stallEscalationRefires ?? DEFAULT_STALL_ESCALATION_REFIRES;
  if (escalateStallNow(ctx, stallEscalation)) return;
  ctx.ui.notify(`Heartbeat: supervisor active but session stalled — re-firing continuation (stall ${consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}).`, "info");
  if (isLoopActive()) {
    scheduleLoopTick(ctx);
  } else {
    scheduleContinuation(ctx, true);
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}
let continuationTimer: NodeJS.Timeout | null = null;
let continuationScheduledFor: string | null = null;
let iterationCounter = 0;
let toolCallsThisTurn = 0;
let consecutiveErrorIterations = 0;
// v0.28.5 (E8): user aborts are NOT provider errors — separate counter,
// separate brake message, and no auto-resume (aborting is user intent).
let consecutiveAbortIterations = 0;
// v0.29.5: set when a user abort stands the chain down (0.29.4) — the
// heartbeat refire + post-compaction refire must NOT resurrect it; only
// an explicit schedule (resume/activate/next turn) clears it.
let abortedStandDown = false;
let consecutiveNoToolIterations = 0;

// =================================================================
// Helpers
// =================================================================

function clearContinuationTimer(): void {
  if (continuationTimer) {
    clearTimeout(continuationTimer);
    continuationTimer = null;
  }
  continuationScheduledFor = null;
}

function isActionableGoal(): boolean {
  return !!state.goal && state.goal.status === "active" && state.goal.autoContinue;
}

function freshCtx(): ExtensionContext | null {
  // A captured ctx throws "stale" after session replacement. Probe cheaply;
  // on stale, drop it and wait for the next event to hand us a fresh one.
  if (!lastCtx) return null;
  try {
    lastCtx.isIdle();
    return lastCtx;
  } catch {
    lastCtx = null;
    return null;
  }
}

// v0.34.15 (hegemon 2026-08-01): pi ACCEPTED the continuation — footer showed
// "1 queued" — but the turn trigger was dead, so the message sat queued while
// pi idled. The 0.34.11 watchdog gates on "pi reported NO pending" and the
// stall ladder takes ~10 minutes; a send that lands queued-without-a-turn is
// a CONFIRMED dead trigger (hegemon law), so probe once, ~45s after every
// landed send, and go straight to auto-recovery. A consumed message (even an
// instant-429 turn consumes it) or any real activity disarms the probe.
function queueStuckProbeMs(): number {
  return Number(process.env.GLLA_QUEUE_STUCK_MS ?? 45_000);
}
let queueStuckProbe: ReturnType<typeof setTimeout> | null = null;
function armQueueStuckProbe(ctx: ExtensionContext, sentAt: number): void {
  if (queueStuckProbe) clearTimeout(queueStuckProbe);
  queueStuckProbe = setTimeout(() => {
    queueStuckProbe = null;
    try {
      if (isForeignCtx(ctx)) return; // stale instance — the live one probes
      if (!isSupervising()) return; // paused/completed meanwhile
      if (lastContinuationSentAt !== sentAt) return; // a newer send armed its own probe
      if (lastRealActivityAt > sentAt) return; // the turn started and worked
      if (!ctx.isIdle()) return; // a turn is running — healthy
      if (!ctx.hasPendingMessages()) return; // consumed — even an instant 429 consumes
      appendLedger(ctx.cwd, "queue_stuck_detected", { waitedMs: Date.now() - sentAt });
      if (!attemptAutoRecovery(ctx, "queue-stuck continuation")) {
        const msg = `${goalNoun()}: the continuation is QUEUED but pi won't start a turn — the turn trigger is dead (re-sends only queue). Cure: /reload — the goal resumes itself after the rebuild (autoresume off? /glla resume).`;
        ctx.ui.notify(msg, "warning");
        notifyExternal(ctx, msg);
      }
    } catch { /* stale ctx — the live instance owns the probe now */ }
  }, queueStuckProbeMs());
  queueStuckProbe.unref?.();
}

function scheduleContinuation(ctx: ExtensionContext, force = false, delayMs?: number): void {
  abortedStandDown = false; // v0.29.5: any explicit schedule ends the stand-down
  if (!isActionableGoal()) return;
  // v0.34.9: cross-session leak guard. If the goal was created in a
  // different session, do NOT inject the continuation prompt into this
  // session. The heartbeat / post-compaction / stranded-audit paths all
  // call scheduleContinuation(ctx, true) with force=true — that flag
  // bypassed the previous duplicate-timer check, but it must NOT bypass
  // session ownership. The user runs /goal resume explicitly to opt in.
  {
    const currentSessionId = (ctx as any)?.sessionInfo?.id ?? (ctx as any)?.sessionId;
    const goalSessionId = state.goal && (state.goal as any).sessionId;
    if (goalSessionId && currentSessionId && goalSessionId !== currentSessionId) {
      if (continuationScheduledFor === state.goal!.id) {
        continuationScheduledFor = null;
      }
      appendLedger(ctx.cwd, "continuation_held_foreign_session", {
        goalId: state.goal!.id,
        goalSession: String(goalSessionId).slice(0, 12),
        currentSession: String(currentSessionId).slice(0, 12),
      });
      try {
        ctx.ui.notify(
          `glla: goal from a different session held (id ${state.goal!.id.slice(0, 12)}…, belongs to session ${String(goalSessionId).slice(0, 8)}…; this session is ${String(currentSessionId).slice(0, 8)}…). Run /goal resume to continue it here.`,
          "info",
        );
      } catch { /* ui not available */ }
      return;
    }
  }
  rememberCtx(ctx);
  const goalId = state.goal!.id;
  if (!force && continuationScheduledFor === goalId) return;
  clearContinuationTimer();
  let delay = 0;
  try {
    delay = delayMs ?? (ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS);
  } catch {
    return;
  }
  continuationScheduledFor = goalId;
  continuationTimer = setTimeout(() => sendContinuation(goalId), delay);
  continuationTimer.unref?.();
}

function sendContinuation(goalId: string): void {
  continuationTimer = null;
  continuationScheduledFor = null;
  if (!isActionableGoal()) return;
  const ctx = freshCtx();
  if (!ctx) {
    // v0.32.0: a stale handle must not spin a flat 50ms re-arm below every
    // watchdog — the heartbeat's terminal path does the theatre; we just stop.
    if (probeExtensionApiStale()) return;
    // No live ctx — retry shortly; the next session event will refresh it.
    continuationScheduledFor = goalId;
    continuationTimer = setTimeout(() => sendContinuation(goalId), BACKOFF_IDLE_RETRY_MS);
    continuationTimer.unref?.();
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    accountSendRearm(ctx, "continuation");
    continuationScheduledFor = goalId;
    // v0.28.29: backing-off cadence (was flat 50ms — 6,000 spins in 5m).
    continuationTimer = setTimeout(() => sendContinuation(goalId), sendRearmDelayMs(continuationRearmStreak));
    continuationTimer.unref?.();
    return;
  }
  if (!extensionApi || extensionApiStale) return;
  try {
    let resync = "";
    // v0.33.1: a builder throw (corrupt restored state) must not masquerade
    // as a transport failure — send without the block instead.
    if (postCompactResyncPending) { try { resync = buildPostCompactResync(); } catch { resync = ""; } }
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: resync + continuationPrompt(state.goal!),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (resync) postCompactResyncPending = false; // consumed only by a landed send
    continuationRearmStreak = 0; continuationRearmSince = 0; // v0.28.5 (E3): a landed send clears the storm
    appendLedger(ctx.cwd, "goal_continuation_sent", { goalId });
    lastContinuationSentAt = Date.now();
    armQueueStuckProbe(ctx, lastContinuationSentAt);
  } catch (err) {
    appendLedger(ctx.cwd, "goal_continuation_send_failed", { goalId, error: err instanceof Error ? err.message : String(err) });
    // v0.26.7: stale runtime = terminal (sends can never land); anything
    // else is transient — next agent_end/session_start reschedules.
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendContinuation");
  }
}

// v0.28.4 (P1): graduated escalation entry — sent at nudge 1 and 2, BEFORE
// the HEARTBEAT_MAX_NUDGES brake can pause the goal. Tells the model exactly
// what closes the turn: complete_goal if done, pause_goal if blocked, a tool
// call otherwise. display: true — the user should see the warning too.
function sendStallEscalation(ctx: ExtensionContext, nudges: number): void {
  if (!extensionApi || extensionApiStale) return;
  const remaining = HEARTBEAT_MAX_NUDGES - nudges;
  const text = [
    `[STALL WARNING ${nudges}/${HEARTBEAT_MAX_NUDGES}] The last turn produced no tool calls.`,
    "If the goal is DONE, call complete_goal NOW — prose closes nothing; only an auditor-approved complete_goal call closes a goal.",
    "If you are BLOCKED, call pause_goal with the blocker and a suggested action.",
    "Otherwise make a tool call that advances the goal this turn.",
    remaining === 1 ? "ONE more unproductive turn pauses the goal." : `${remaining} more unproductive turns pause the goal.`,
  ].join(" ");
  appendLedger(ctx.cwd, "stall_escalation_nudge", { nudges, remaining });
  try {
    extensionApi.sendMessage({ customType: GOAL_EVENT_ENTRY, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
  } catch (err) {
    appendLedger(ctx.cwd, "stall_escalation_nudge_failed", { error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendStallEscalation");
  }
}

// v0.27.2: send the truncation-continue nudge. Same guards as
// sendContinuation (stale api = terminal), independent of goal state —
// plain sessions truncate too.
function sendLengthContinue(ctx: ExtensionContext, consecutive: number): void {
  if (!extensionApi || extensionApiStale) return;
  try {
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: LENGTH_CONTINUE_TEXT,
      display: true,
    }, { triggerTurn: true, deliverAs: "followUp" });
    appendLedger(ctx.cwd, "length_continue_sent", { consecutive });
    ctx.ui.notify(`Response hit the output-token cap — auto-continuing (${consecutive}/${LENGTH_CONTINUE_MAX})`, "warning");
  } catch (err) {
    appendLedger(ctx.cwd, "length_continue_send_failed", { consecutive, error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendLengthContinue");
  }
}

/** v0.32.1: deterministic post-compaction re-anchor (pi-goal-x's #5) —
 * prepended to the first continuation/loop message after a compact. */
function buildPostCompactResync(): string {
  const lines: string[] = [
    "[POST-COMPACTION RESYNC] The transcript was just compacted. Trust the artifacts on disk and .pi-glla/ state — NOT your memory of the prior chat. Re-read files before editing them.",
  ];
  if (state.goal) {
    lines.push(`Goal ${state.goal.id} — status ${state.goal.status}`);
    lines.push(`Objective: ${state.goal.objective.slice(0, 200)}`);
    const next = findNextPendingTask(state.goal.taskList?.tasks ?? []);
    if (next) lines.push(`Next pending task: \`${next.id}\` — ${next.title}`);
    const lastAudit = state.goal.auditHistory?.[state.goal.auditHistory.length - 1];
    if (lastAudit) lines.push(`Last audit: ${lastAudit.approved ? "APPROVED" : lastAudit.impossible ? "IMPOSSIBLE" : "disapproved"} (${lastAudit.at})`);
  } else if (state.loop?.active) {
    lines.push(`Loop: ${state.loop.target.slice(0, 160)} — iteration ${state.loop.iteration}`);
  }
  return lines.join("\n") + "\n\n";
}

function continuationPrompt(goal: Goal): string {
  // Read the .md file as the template, then substitute {{tokens}}.
  // For v0.1.0 we inline-substitute so we don't need fs at runtime.
  const next = findNextPendingTask(goal.taskList?.tasks ?? []);
  const nextBlock = next
    ? `**Next pending task**: \`${next.id}\` — ${next.title}`
    : "**Next pending task**: (none — only call complete_goal when the objective is satisfied)";
  const taskSummary = goal.taskList?.tasks.length
    ? buildTaskSummary(goal.taskList.tasks)
    : "(no task list)";
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", "goal-loop-continuation.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = "[template-not-found]";
  }
  // v0.25.0 (contract items 22/28): conditional directives — aggressiveMode
  // TODOs from the audit cap, and the full-audit fan-out directive when the
  // objective reads as a survey pivot.
  const directives: string[] = [];
  const effSettings = resolveEffectiveAggressiveSettings(loadSettings(freshCtx()?.cwd ?? process.cwd()));
  if (goal.pendingTasks && goal.pendingTasks.length > 0) {
    directives.push(
      `## AUDITOR TODO LIST (from ${goal.pauseReason?.includes("cap") ? "the disapproval cap" : "the last audit"})\n\nAddress these objections, in order, before re-calling complete_goal:\n${goal.pendingTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    );
  }
  if (effSettings.aggressiveMode && isFullAuditObjective(goal.objective)) {
    directives.push(
      "## FULL-AUDIT MODE (aggressiveMode + survey objective)\n\nThis objective is a survey, not a single fix. Spawn 3+ `Explore` subagents NOW — one per subsystem, in a single message so they run in parallel — synthesize their findings, and call `propose_task_list` with the result. Do not start fixing before the task list exists.",
    );
  }
  const dynamicDirectives = directives.length > 0 ? directives.join("\n\n") : "(no active directives)";
  return tmpl
    .replace(/\$\{GOAL_ID\}/g, goal.id)
    .replace(/\$\{OBJECTIVE\}/g, goal.objective)
    .replace(/\$\{VERIFICATION_CONTRACT\}/g, goal.verificationContract || "(none — auditor will decide based on objective)")
    .replace(/\$\{TASK_LIST\}/g, taskSummary)
    .replace(/\$\{NEXT_PENDING_TASK_BLOCK\}/g, nextBlock)
    .replace(/\$\{DYNAMIC_DIRECTIVES\}/g, dynamicDirectives);
}

// =================================================================
// Goal lifecycle
// =================================================================

function createGoal(objective: string, ctx: ExtensionContext, policy: "goal" | "list" = "goal"): Goal {
  ensureDirs(ctx.cwd);
  // Extract verification contract if present in objective.
  const { objective: cleanObj, verificationContract } = extractVerificationContract(objective);
  const id = newGoalId();
  const goal: Goal = {
    id,
    objective: cleanObj,
    status: "active",
    policy,
    autoContinue: true,
    verificationContract: verificationContract || "",
    usage: { tokensUsed: 0, tokensLimit: loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return goal;
}

function persistState(ctx: ExtensionContext): void {
  appendLedger(ctx.cwd, "state", { goal: state.goal, list: state.list ?? [], loop: state.loop ?? null });
  notifyPersistenceState(ctx); // v0.28.6 (E1): loud on the first failure, all-clear on recovery
  refreshUI(ctx); // every state transition flows through here → the TUI is always current
}

// v0.28.6 (E1): persistence-degradation notify — once per failure streak,
// once per recovery. The TUI flag (buildWidgetLines) carries the standing
// state; these notifies are the LOUD part.
let persistenceDegradedNotified = false;

/** v0.28.11 (U9): objective-first notifies — truncate long objectives. */
const shortObj = (s: string): string => (s.length > 90 ? `${s.slice(0, 87)}…` : s);
/** v0.28.30: terminology — a list item is not a goal (user note: "we seem
 * to call everything goal"). User-facing pause/abort notifies name the policy. */
const goalNoun = (): string => (state.goal?.policy === "list" ? "List item" : "Goal");
function notifyPersistenceState(ctx: ExtensionContext): void {
  if (isPersistenceDegraded() && !persistenceDegradedNotified) {
    persistenceDegradedNotified = true;
    const err = lastPersistenceFailure();
    ctx.ui.notify(
      `⚠ Persistence degraded: ${err?.what ?? "disk write"} failed (${(err?.error ?? "unknown").slice(0, 80)}). State lives in RAM and re-syncs on the next successful write — .pi-glla may be missing recent entries. Fix the disk (space/permissions) and it self-heals.`,
      "warning",
    );
    notifyExternal(ctx, "pi-goal-list-loop-audit: persistence degraded — .pi-glla writes failing.");
  } else if (!isPersistenceDegraded() && persistenceDegradedNotified) {
    persistenceDegradedNotified = false;
    ctx.ui.notify("Persistence recovered — .pi-glla writes are landing again.", "info");
  }
}

function setGoal(goal: Goal, ctx: ExtensionContext, via = "user"): void {
  // v0.33.1: per-goal module state resets at activation — a new goal must
  // not inherit the previous goal's compact debt/resync, quota streak,
  // token-message dedupe set, or widget action feed.
  postCompactResumeOwed = false;
  postCompactResyncPending = false;
  quotaRetryStreak = 0;
  countedTokenMessages.clear();
  recentActions.length = 0;
  // v0.28.14: never silently orphan a live goal — a paused/active goal
  // being replaced is archived honestly first (the old behavior left it in
  // goals/ but untracked: "older goals lying around leading to confusion").
  if (state.goal && state.goal.id !== goal.id && (state.goal.status === "active" || state.goal.status === "paused")) {
    archiveCurrentGoal(ctx, "aborted", `replaced by goal ${goal.id}`);
  }
  goal.createdVia = via; // v0.28.28: provenance — answerable from the ledger + /glla log
  state = { ...state, goal }; // preserve list AND loop (v0.28.14: the bare reconstruction used to nuke a held/active loop whenever a goal was set)
  const file = writeGoalMd(ctx.cwd, goal);
  state.goal!.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
  appendLedger(ctx.cwd, "goal_created", { goalId: goal.id, objective: goal.objective, policy: goal.policy, via });
}

function updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void {
  if (!state.goal) return;
  state.goal = { ...state.goal, ...patch, updatedAt: nowIso() };
  const file = writeGoalMd(ctx.cwd, state.goal);
  state.goal.activePath = path.relative(ctx.cwd, file) || file;
  persistState(ctx);
}

// v0.29.6: stacked-state auto-arbitration (user directive: "auto archive /
// wipe extra goals/loops/lists … make sure that we only have one"). Dirty
// pre-guard states can persist a live loop AND a live goal; the 0.28.21
// decision picker asked the user to arbitrate artifacts they didn't
// remember at every pi start. Now deterministic: MOST RECENT ACTIVITY
// keeps the slot; the loser is ARCHIVED (recoverable), never wiped. The
// queued list is a backlog, not a live artifact — untouched.
function autoArbitrateStackedState(ctx: ExtensionContext): void {
  const loop = state.loop?.active ? state.loop : undefined;
  const goal = state.goal && state.goal.status !== "complete" && state.goal.status !== "aborted" ? state.goal : undefined;
  if (!loop || !goal) return; // at most one live artifact — the invariant holds
  const lastMeasure = loop.history.length > 0 ? loop.history[loop.history.length - 1] : undefined;
  const loopMs = Date.parse(lastMeasure?.at ?? loop.startedAt ?? "") || 0;
  const goalMs = Date.parse(goal.updatedAt ?? goal.createdAt ?? "") || 0;
  const keepGoal = goalMs > loopMs; // tie → the loop keeps the slot (0.28.21 default)
  appendLedger(ctx.cwd, "stacked_state_auto_arbitrated", {
    kept: keepGoal ? "goal" : "loop",
    goalId: goal.id,
    goalMs,
    loopMs,
    loopIteration: loop.iteration,
    loopTarget: loop.target.slice(0, 120),
  });
  if (keepGoal) {
    // Same shape as /loop stop: the loop record stays in state (inactive)
    // with an honest reason — /loop status still shows it.
    state = { ...state, loop: { ...loop, active: false, stopReason: "auto-arbitrated on session load: the goal was more recent (one active thing)" } };
    persistState(ctx);
  } else {
    archiveCurrentGoal(ctx, "aborted", "auto-arbitrated on session load: the loop was more recent (one active thing)");
  }
  ctx.ui.notify(
    `Stacked state auto-arbitrated (one active thing): kept the ${keepGoal ? "goal" : "loop"} — more recent activity — and archived the ${keepGoal ? `loop (iter ${loop.iteration}, best ${loop.bestValue ?? "n/a"})` : `goal (${goal.id})`}. Recoverable: /loop status · .pi-glla/archive/ · /glla wipe for a clean slate.`,
    "info",
  );
}

/** v0.31.0: /list audit completion fan-out — read the audit findings file,
 * queue every OPEN finding as its own list item (severity-sorted, deduped
 * against the live queue), present DECIDE findings without queueing them.
 * Confirm-gated like every bulk import (v0.23.7: the user reads what lands
 * in the queue); a decline leaves the findings open for a later re-run.
 */
async function fanOutListAuditFindings(ctx: ExtensionContext): Promise<void> {
  let md = "";
  try {
    md = fs.readFileSync(path.join(ctx.cwd, AUDIT_FINDINGS_REL), "utf-8");
  } catch {
    /* no findings file — the audit was clean or never wrote */
  }
  const { open, decisions } = parseAuditFindingsForFanout(md);
  // Dedupe against the live queue (a re-run must not double-queue a finding
  // that's already waiting) — match on the finding text's first 60 chars.
  const queuedText = listQueue().map((i) => i.objective).join("\n");
  // v0.32.0: cap one fan-out — a runaway findings file must not enqueue
  // hundreds of items on a single Confirm.
  const fresh = open.filter((f) => !queuedText.includes(f.text.slice(0, 60))).slice(0, 50);
  const alreadyQueued = open.length - fresh.length;
  // v0.33.3: DECIDE findings are RAISED TO THE USER as real questions
  // (hegemon 2026-07-31: a truncated notify left the user typing "decide
  // what" into the void). The orchestrator can't call ask_user_question —
  // the agent can — so the full untruncated findings go to the agent as a
  // steer with the raise + record protocol. Fires BEFORE the queueing
  // early-returns below: decisions need answers even when nothing new
  // queued or the fan-out was declined.
  if (decisions.length > 0) {
    const decList = decisions.slice(0, 8).map((d, i) => `${i + 1}. ${d.slice(0, 500)}`).join("\n");
    if (safeSteerUser(ctx,
      `[DECIDE FINDINGS — user decisions needed] The audit surfaced ${decisions.length} DECIDE finding(s) — direction calls only the user can make (a decision is not a task, so they were NOT queued):\n${decList}\nRaise them to the user NOW with ask_user_question — one question per finding, options from the finding's own two sides plus "Defer" (prose numbered list if ask_user_question is unavailable; Esc = Defer). Then record every answer in ${AUDIT_FINDINGS_REL}: replace the "- [?]" line with "- [x] DECIDED: <what was chosen> (<date>)" (or "- [x] DEFERRED") so it stops re-surfacing, and queue any chosen work with list_add — do NOT start the work inline.`))
      appendLedger(ctx.cwd, "list_audit_decisions_raised", { decisions: decisions.length });
  }
  const decideNote =
    decisions.length > 0
      ? ` ${decisions.length} DECIDE finding(s) need YOU — raising them as questions now (not queued — a decision is not a task).`
      : "";
  if (fresh.length === 0) {
    ctx.ui.notify(
      open.length > 0
        ? `Audit collected ${open.length} open finding(s) — all already queued.${decideNote}`
        : `Audit complete — no open findings; the project is clean, nothing to queue.${decideNote}`,
      "info",
    );
    appendLedger(ctx.cwd, "list_audit_fanout_empty", { open: open.length, decisions: decisions.length });
    return;
  }
  const preview = fresh.map((f, i) => `  ${i + 1}. ${f.text.slice(0, 110)}`).join("\n");
  let confirmed = true;
  if (ctx.hasUI) {
    try {
      confirmed = await ctx.ui.confirm(`Queue ${fresh.length} audit finding(s) as list items?`, preview);
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    appendLedger(ctx.cwd, "list_audit_fanout_declined", { findings: fresh.length });
    ctx.ui.notify(`Fan-out declined — the findings stay open in ${AUDIT_FINDINGS_REL}; /list audit re-queues them any time.`, "info");
    return;
  }
  const n = enqueueItems(ctx, fresh.map((f) => listAuditFanoutItemText(f.text)), "list audit fan-out");
  appendLedger(ctx.cwd, "list_audit_fanout", { queued: n, alreadyQueued, decisions: decisions.length });
  ctx.ui.notify(
    `Queued ${n} finding(s) — the list drains them fix by fix, each with its own audited commit.${alreadyQueued > 0 ? ` (${alreadyQueued} already queued.)` : ""}${decideNote}`,
    "info",
  );
}

function archiveCurrentGoal(ctx: ExtensionContext, status: Status, stopReason?: string): void {
  postCompactResumeOwed = false; // v0.33.1: the dead goal's compact debt/resync dies with it
  postCompactResyncPending = false;
  if (!state.goal) return;
  const goal = state.goal;
  ensureDirs(ctx.cwd);
  const target = archivedGoalPath(ctx.cwd, goal.id);
  const md = renderGoalMarkdown({ ...goal, status, stopReason });
  // v0.28.6 (E1): guarded — and the active md is only removed when the
  // archive actually LANDED (degraded mode must not destroy the only copy).
  const archived = runPersistStep("archiveCurrentGoal", () => {
    ensureDirs(ctx.cwd);
    fs.writeFileSync(target, md);
    return true;
  }) === true;
  if (archived) {
    try { fs.unlinkSync(goalMdPath(ctx.cwd, goal.id)); } catch {}
  }
  state = { ...state, goal: { ...goal, status, archivedPath: path.relative(ctx.cwd, target) || target, stopReason } };
  appendLedger(ctx.cwd, "goal_archived", { goalId: goal.id, status, stopReason, objective: goal.objective.slice(0, 300) });
  persistState(ctx);
  // Loop 2: a list-sourced goal COMPLETED → auto-activate the next item.
  // Aborts are user actions (/list next, /goal cancel, list_activate) which
  // pick their own next step — auto-advancing on abort double-activates
  // (v0.2.0 bug: bare /list next silently consumed TWO items, found by the
  // pick-any-item verification in v0.10.0).
  if (goal.policy === "list" && status === "complete") {
    // v0.31.0: a /list audit collection item completed → fan the open
    // findings out into the queue (async — Confirm-gated). When the queue
    // was empty, enqueueItems activates the first fix itself, so the
    // list-complete / reviewer noise below must NOT fire for this item.
    const isListAuditCollect = goal.objective.includes(LIST_AUDIT_COLLECT_MARKER);
    // v0.34.7: the float gets a catch — ANY rejection here used to become
    // an uncaughtException and kill pi (darklord 2026-08-01).
    if (isListAuditCollect)
      void fanOutListAuditFindings(ctx).catch((err) => {
        appendLedger(ctx.cwd, "list_audit_fanout_error", { error: String(err).slice(0, 200) });
      });
    const advanced = activateNextListItem(ctx);
    // v0.26.0: the queue just EMPTIED on a completion → list-complete.
    if (!advanced && !isListAuditCollect) {
      fireReviewer(ctx, { kind: "list", goalId: goal.id, objective: goal.objective, terminal: "goal-complete" });
      // v0.29.0: the well ran dry — point at the project-audit loop. A
      // suggestion, not an action: consent, never auto-start (v0.28.28).
      ctx.ui.notify("List complete. /loop audit to sweep the project for the next batch of work.", "info");
    }
    return;
  }
  // v0.26.0: a /goal (non-list) reached a terminal state → maybe fire.
  if (goal.policy !== "list") {
    fireReviewer(ctx, { kind: "goal", goalId: goal.id, objective: goal.objective, terminal: status === "complete" ? "goal-complete" : status === "aborted" ? "goal-aborted" : "goal-paused" });
  }
}

/**
 * v0.28.26: quota-window retry for a STORED completion claim. The auditor
 * was quota-blocked at complete_goal time; the claim (completionSummary +
 * verificationSummary) was persisted on the goal, and when the quota window
 * elapses we re-run the AUDITOR directly — no agent turn. Re-engaging the
 * agent to re-submit an unchanged claim produced a hallucinated-closure
 * repetition loop in the field (π-games: the model concluded the goal was
 * closed, repeated the same essay 4×+, stormed continuations, compacted 14×
 * in 35 minutes, and burned the stall brake).
 *
 * Outcomes: approved → close + cascade (archiveCurrentGoal handles list
 * advance + reviewer); quota again → re-pause with a fresh scheduled retry
 * (claim preserved); anything else (disapproved, impossible, non-quota
 * infra) → hand back to the agent: resume active + continuation, verdict
 * durable in auditHistory.
 */
async function retryStoredCompletionAudit(ctx: ExtensionContext, origin: "quota-retry" | "manual" = "quota-retry"): Promise<void> {
  const goal = state.goal;
  if (!goal?.pendingCompletion) return;
  if (completionAuditInFlight) return;
  const liveCtx = freshCtx() ?? ctx;
  const claim = goal.pendingCompletion;
  updateGoal({ status: "auditing" }, liveCtx);
  appendLedger(liveCtx.cwd, "goal_resumed", { via: origin === "manual" ? "manual-audit" : "quota-retry-direct-audit" });
  liveCtx.ui.notify(origin === "manual"
    ? "Manual /goal verify — running the isolated auditor now (no agent turn needed)."
    : "Auditor quota window elapsed — retrying the audit with your stored completion claim (no agent turn needed).", "info");
  const settings = loadSettings(liveCtx.cwd);
  const { model: auditorModel, error: modelError, via } = resolveAuditorModel(liveCtx, settings.auditorModel, settings.auditorModelFallback, settings.auditorSameSessionSwap !== false);
  if (modelError) liveCtx.ui.notify(`Auditor model issue: ${modelError}`, "warning");
  latestAuditProgress = { label: "quota-retry", lastEventAt: Date.now() };
  completionAuditInFlight = true;
  const auditStartMs = Date.now();
  let result: Awaited<ReturnType<typeof runGoalCompletionAuditor>>;
  try {
    ({ result } = await runWithInfraRetry(
      () =>
        runGoalCompletionAuditor({
          ctx: liveCtx,
          goal: state.goal!,
          completionSummary: claim.completionSummary,
          verificationSummary: claim.verificationSummary,
          model: auditorModel,
          thinkingLevel: (settings.auditorThinkingLevel ?? "high") as any, // may be "max" — pi ≥0.83 understands it; the dev-types predate it
          onProgress: (progress) => {
            latestAuditProgress = { currentTool: progress.currentTool, label: progress.label, elapsedMs: progress.elapsedMs, lastEventAt: Date.now() };
            refreshUI(liveCtx);
          },
        }),
      { onRetry: (err) => appendLedger(liveCtx.cwd, "audit_infra_retry", { goalId: state.goal?.id, error: err.slice(0, 200) }) },
    ));
  } finally {
    completionAuditInFlight = false;
    latestAuditProgress = null;
  }
  if (!state.goal) return; // aborted mid-audit

  // Record the run in history (same compact shape as the tool path).
  const auditorRan = result.output.trim().length > 0;
  const history = state.goal.auditHistory ?? [];
  if (auditorRan) {
    result.output = stripThinkBlocks(result.output);
    history.push({
      at: nowIso(),
      approved: result.approved,
      disapproved: result.disapproved,
      impossible: result.impossible,
      impossibleReason: result.impossibleReason,
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      report: result.output,
      error: result.error,
      regressionShieldPassed: result.regressionShieldPassed,
      regressionShieldMissing: result.regressionShieldMissing,
      durationMs: Date.now() - auditStartMs,
    } as any);
    if (history.length > 20) history.splice(0, history.length - 20);
  }

  if (result.approved) {
    updateGoal({ auditHistory: history, pendingCompletion: undefined }, liveCtx);
    const objective = state.goal.objective;
    archiveCurrentGoal(liveCtx, "complete", `auditor ${result.model} approved (${origin})`);
    liveCtx.ui.notify(`Goal complete — auditor ${result.model} approved${origin === "manual" ? " on /goal verify" : " on the quota retry"}.`, "info");
    notifyExternal(liveCtx, `Goal complete (auditor approved, ${origin}): ${objective.slice(0, 120)}`);
    return;
  }

  if (result.error && !result.disapproved && isQuotaError(result.error)) {
    // Still quota'd — re-pause with a fresh window, claim preserved.
    const settingsNow = loadSettings(liveCtx.cwd);
    const defaultSec = (settingsNow.quotaRetryMinutes ?? DEFAULT_QUOTA_RETRY_MINUTES) * 60;
    const quota = parseQuotaError(result.error, defaultSec);
    const retryMin = Math.max(1, Math.round(quota.retryAfterSec / 60));
    updateGoal({
      status: "paused",
      auditHistory: history,
      pauseKind: "wait",
      pauseResumeAt: new Date(Date.now() + quota.retryAfterSec * 1000).toISOString(),
      pauseReason: `auditor quota: ${result.error}`,
      pauseSuggestedAction: `Quota auto-retry in ${retryMin}m — or /goal resume to retry now`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, "goal_paused", { reason: `auditor quota: retry in ${quota.retryAfterSec}s (stored-claim retry)` });
    // v0.32.0: terminal cap — a permanently dead auditor key must not spawn
    // one auditor per hour forever. 5 consecutive quota retries → hold.
    quotaRetryStreak++;
    if (quotaRetryStreak >= 5) {
      appendLedger(liveCtx.cwd, "quota_retry_capped", { streak: quotaRetryStreak });
      liveCtx.ui.notify(`Auditor quota retry gave up after ${quotaRetryStreak} consecutive attempts — the claim stays stored; /goal resume retries by hand.`, "warning");
      return;
    }
    liveCtx.ui.notify(`Auditor still quota-limited — next auto-retry in ${retryMin}m (your completion claim is stored; no action needed).`, "warning");
    scheduleQuotaRetry(liveCtx, quota.retryAfterSec, result.error, () => {
      if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor quota:") && state.goal.pendingCompletion) {
        void retryStoredCompletionAudit(liveCtx, origin);
      }
    });
    return;
  }

  // Any other outcome — disapproved, impossible, non-quota infra — belongs
  // to the agent: resume and let the continuation drive the next step. The
  // verdict is durable in auditHistory + /goal status.
  quotaRetryStreak = 0;
  updateGoal({
    status: "active",
    auditHistory: history,
    pendingCompletion: undefined,
    pauseReason: result.disapproved
      ? `auditor disapproved on quota-retry — see /goal status`
      : result.impossible
        ? `auditor verdict: IMPOSSIBLE on quota-retry — ${(result.impossibleReason ?? "").slice(0, 120)}`
        : `auditor infrastructure error on quota-retry: ${(result.error ?? "").slice(0, 120)}`,
  }, liveCtx);
  liveCtx.ui.notify(
    result.disapproved
      ? `Auditor (${origin}) DISAPPROVED — resuming; the report is in /goal status.`
      : result.impossible
        ? `Auditor (${origin}): goal IMPOSSIBLE — ${(result.impossibleReason ?? "").slice(0, 100)}. Resuming; consider /goal tweak.`
        : `Auditor (${origin}) hit an infrastructure error — resuming; re-call complete_goal when ready.`,
    "warning",
  );
  appendLedger(liveCtx.cwd, "quota_retry_audit_verdict", {
    approved: false,
    disapproved: result.disapproved,
    impossible: result.impossible,
    error: result.error?.slice(0, 160),
  });
  scheduleContinuation(liveCtx, true);
}

/**
 * v0.26.0: bind the reviewer to the live session. Sources for finding
 * extraction: the archived goal markdown + its audit reports + the
 * durable audit log entries for this goal. List items are enqueued via
 * the ONE enqueue path; /goal proposals go through the agent (which
 * calls propose_goal_draft → the user's Confirm dialog).
 */
function fireReviewer(
  ctx: ExtensionContext,
  source: { kind: "goal" | "list"; goalId: string; objective: string; terminal: string },
  opts: { manual?: boolean; mode?: "off" | "on" | "auto" | "aggressive" } = {},
): void {
  try {
    const settings = loadSettings(ctx.cwd);
    // v0.27.5: dual-read `reviewer` (legacy) and `postaudit` (new) settings
    // keys. `postaudit` takes precedence when both are present — the
    // existing settings file shape is preserved; the rename is purely
    // vocabulary on the user-facing surface.
    const reviewerBlock = (settings.postaudit ?? settings.reviewer) as Partial<ReviewerConfig> | undefined;
    const config = resolveReviewerConfig(reviewerBlock);
    if (opts.mode) config.mode = opts.mode;
    const sources: Array<{ name: string; text: string }> = [];
    try {
      sources.push({ name: "archive", text: fs.readFileSync(archivedGoalPath(ctx.cwd, source.goalId), "utf-8") });
    } catch {
      /* archive md may not exist for manual review of a live goal */
    }
    // v0.26.4 source curation: an APPROVED audit report is the executor's
    // own completion claims — meta-text with zero finding signal (the
    // 0.26.2/0.26.3 misfires both mined it). Disapprovals/errors carry the
    // independent auditor's required-fixes — the real findings.
    const auditTexts = readAuditLog(ctx.cwd)
      .filter((e) => e.goalId === source.goalId && (e.verdict === "disapproved" || e.verdict === "error"))
      .map((e) => e.report);
    for (const t of auditTexts) sources.push({ name: "audit", text: t });
    let ledgerEntries: Array<{ type: string; at?: string; value?: any }> = [];
    try {
      ledgerEntries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
    } catch {
      /* no ledger yet */
    }
    const outcome = runReviewer(config, source, {
      cwd: ctx.cwd,
      nowMs: Date.now(),
      manual: opts.manual,
      ledgerEntries,
      sources,
      enqueueListItems: (objectives) => enqueueItems(ctx, objectives, "reviewer", { autoActivate: loadGlobalSettings().autoResume === true }),
      proposeGoal: (objective, reason) => {
        try {
          safeSteerUser(ctx, 
            `[REVIEWER FOLLOW-UP — ${reason}. Propose this as a /goal via propose_goal_draft (the user Confirms or rejects): ${objective}]`);
          return true;
        } catch (err) {
          // v0.28.8 (E4): the phantom-reviewer hole — a swallowed throw used
          // to still count as "proposed" in the report + notify. Now the
          // failure is LOUD and the proposal goes uncounted.
          ctx.ui.notify(
            `Postaudit /goal proposal NOT delivered: ${err instanceof Error ? err.message : String(err)} — the follow-up never reached the session. Run /reload if the session was just replaced (extensions rebuild in place), then retry.`,
            "warning",
          );
          return false;
        }
      },
      notify: (message, level) => ctx.ui.notify(message, level),
      ledger: (type, value) => appendLedger(ctx.cwd, type, value),
    });
    if (!outcome.fired && outcome.suppressedReason && opts.manual) {
      ctx.ui.notify(`Postaudit suppressed: ${outcome.suppressedReason}`, "info");
    }
    // v0.27.5: surface the silent review to interactive users. The internal
    // runReviewer notify fires DURING the goal-completion handler, easy to
    // miss because pi is busy transitioning state. The second notify
    // arrives AFTER everything settles and points at the file directly.
    // Skipped when manual=true (manual /review has its own UX already) and
    // when the runner wasn't fired (suppressed / not applicable).
    if (!opts.manual && outcome.fired && outcome.reportPath) {
      const relPath = path.relative(ctx.cwd, outcome.reportPath) || outcome.reportPath;
      ctx.ui.notify(
        `↳ review written: ${relPath}${outcome.enqueued ? ` (${outcome.enqueued} enqueued to /list)` : ""}${outcome.proposed ? ` (${outcome.proposed} /goal proposed)` : ""}`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`Postaudit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}

// =================================================================
// Loop 2: /list list
// =================================================================

function listQueue(): NonNullable<State["list"]> {
  return state.list ?? [];
}

function activateNextListItem(ctx: ExtensionContext, n = 1): boolean {
  // v0.28.14: one-active-thing choke point — NO call site (session_start,
  // completion cascade, /list next, list_activate, list-draft auto-activate)
  // may activate a list item over a live loop, present or future.
  if (isLoopActive()) {
    appendLedger(ctx.cwd, "list_activation_blocked_loop", {});
    return false;
  }
  // v0.34.9: cross-session leak guard — if the HEAD item's sessionId
  // belongs to a different session, refuse to cascade. The Goal guard
  // catches the continuation prompt, but we want to surface this BEFORE
  // draining the queue so the user explicitly opts in via /list resume.
  {
    const headQueue = listQueue();
    const headItem = headQueue[n - 1];
    if (headItem) {
      const headSessId = (headItem as any).sessionId;
      const curSessId = (ctx.sessionInfo as any)?.id ?? (ctx as any).sessionId;
      if (headSessId && curSessId && headSessId !== curSessId) {
        appendLedger(ctx.cwd, "list_activation_held_foreign_session", {
          item: headItem.id.slice(0, 12),
          itemSession: String(headSessId).slice(0, 12),
          currentSession: String(curSessId).slice(0, 12),
        });
        try {
          ctx.ui.notify(
            `glla: list item from a different session held (id ${headItem.id.slice(0, 12)}…, belongs to session ${String(headSessId).slice(0, 8)}…; this session is ${String(curSessId).slice(0, 8)}…). Run /list resume to continue it here.`,
            "info",
          );
        } catch { /* ui not available */ }
        return false;
      }
    }
  }
  // v0.28.14: carryover resolution runs BEFORE the item is taken — under
  // carryover=clear the stale queue is dropped first and there is nothing
  // to activate; under pause the ONE summary precedes the activation.
  resolveCarryover(ctx, "list");
  const queue = listQueue();
  const taken = takeAt(queue, n);
  if (!taken) return false;
  const [next, rest] = taken;
  state = { ...state, list: rest };
  const goal = createGoal(next.objective, ctx, "list");
  if (next.verificationContract) goal.verificationContract = next.verificationContract;
  setGoal(goal, ctx, "list-cascade");
  iterationCounter = 0;
  consecutiveErrorIterations = 0;
  consecutiveAbortIterations = 0;
  ctx.ui.notify(`List item #${n} activated (${rest.length} remaining): ${goal.objective.slice(0, 80)}`, "info");
  scheduleContinuation(ctx, true);
  return true;
}

// =================================================================
// Drafting: /goal with no args → clarify → Confirm dialog → activate
// =================================================================

async function startDrafting(ctx: ExtensionContext, target: "goal" | "list" | "loop", seed?: string): Promise<void> {
  draftingTarget = target;
  const prompts: Record<string, [string, string, string]> = {
    goal: ["goal-loop-draft.md", "Goal drafting", "propose_goal_draft"],
    list: ["goal-loop-draft.md", "Goal drafting (for the list)", "propose_goal_draft"],
    loop: ["goal-loop-forever-draft.md", "Loop drafting", "propose_loop_draft"],
  };
  const [file, label, tool] = prompts[target]!;
  const seededHint =
    target === "list"
      ? `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Add directly instead: include a "Done when:" clause.`
      : target === "loop"
        ? `${label}: a loop target needs a metric and a direction — the agent will help you design them first (nothing activates until you confirm). Skip the interview entirely: /loop start "<target>" (bare = infinite metricless) or /loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50] [time=h] [tokens=n] [branch=1].`
        : `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Skip the interview entirely: /goal start <objective>.`;
  ctx.ui.notify(
    seed
      ? seededHint
      : `${label} started. The agent will grill until the contract is concrete, then ${tool} opens a Confirm dialog. No work begins before confirmation.`,
    "info",
  );
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", file);
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
    if (target === "list") {
      tmpl = tmpl.replace(
        "[GOAL DRAFTING]",
        "[LIST DRAFTING — the confirmed item goes into the /list LIST, it does not activate immediately. " +
          "/list items are SHORT tasks, not multi-hour objectives: each item should fit comfortably in a single agent run " +
          "(minutes of work, a single focused change). The list's long-running property is QUEUE DEPTH — hundreds of short " +
          "items activated one at a time over days/weeks — never any single item's scope. " +
          "If the user describes work that would take hours, propose breaking it into multiple /list items, or suggest /goal " +
          "for the big version. When the user has many items to enqueue at once ('queue these 50 audits'), propose them ALL AT " +
          "ONCE with the items[] parameter — one Confirm for the whole batch, never 50 separate proposals. Each items[] entry " +
          "is still a SHORT task — never an aggregate wrapper ('land all N findings' with a '≥N commits' contract is the " +
          "canonical anti-pattern: the auto-committer squashes, the count fails, the auditor disapproves finished work).]",
      );
    }
  } catch {
    tmpl = `[DRAFTING] Clarify the user's ${target}, then call ${tool}.`;
  }
  // v0.14.0: the LLM grills (its strength — v0.13.0's canned questionnaire
  // accepted non-answers), the plugin enforces the floor: propose_goal_draft
  // is blocked until the user has replied at least once (see message_start).
  if (seed) {
    tmpl = buildSeedGrillMessage(tmpl, seed, tool);
    // v0.25.3: cross-mode recommendation — catch wrapper-goal seeds and
    // mode mismatches BEFORE the draft crystallizes.
    if (target === "goal" || target === "list") {
      const xr = crossRecommendMode(seed, target);
      if (xr) tmpl += `\n\n${xr}`;
    }
  }
  try {
    safeSteerUser(ctx, tmpl);
    draftingUserReplies = 0;
    draftingBlockedProposals = 0;
    draftingSeedInFlight = true; // our injected prompt also arrives as a user message — don't count it
  } catch (err) {
    draftingTarget = null;
    // v0.28.1 (E6): the seed send used to fail SILENTLY — the user pressed
    // Enter on /goal and nothing happened. Now: loud, and stale handles get
    // the honest restart guidance.
    if (isStaleApiError(err)) {
      extensionApiStale = true;
      appendLedger(ctx.cwd, "extension_api_stale", { where: "startDrafting seed" });
      ctx.ui.notify("glla: can't start the drafting interview — this session's extension handle is stale (pi session replacement). Run /reload (extensions rebuild in place), then re-run the command. Restart pi only if /reload fails.", "warning");
    } else {
      ctx.ui.notify(`glla: couldn't start the drafting interview (${err instanceof Error ? err.message : String(err)}) — try again.`, "warning");
    }
  }
}

// =================================================================
// /goal router (v0.8.0): subcommands route to their handlers; everything
// else is an objective (draft if empty, set+start otherwise).
// =================================================================

async function cmdGoal(args: string, ctx: ExtensionContext): Promise<void> {
  const route = routeGoalArgs(args);
  if (route.kind === "sub") {
    if (route.name === "status") return cmdStatus(ctx);
    if (route.name === "pause") return cmdPause(ctx);
    if (route.name === "resume") return cmdResume(ctx);
    if (route.name === "cancel") return cmdCancel(ctx);
    // v0.28.23: re-open the decision picker for a decision pause (the
    // popup auto-opens when the pause lands; this is the on-demand path).
    if (route.name === "decide") {
      const shown = await showDecisionPrompt(ctx);
      if (!shown) ctx.ui.notify("No pending decision — the goal isn't paused on a choice (or no UI).", "info");
      return;
    }
    // v0.29.8: /goal audit [focus] — the ONE-SHOT project audit (user:
    // "/goal audit IS the audit goal — we are not auditing the current
    // goal, that happens automatically"). Fire-and-address: one audit
    // pass, FIX findings fixed autonomously (a bug is not a decision),
    // DECIDE findings presented, untouched. Runs as a normal goal through
    // cmdSet — the isolated auditor verifies the finish line.
    if (route.name === "audit") {
      // v0.31.1: an active audit loop already owns auditing here — the
      // one-shot duplicates it (same stacking confusion as junk-runner).
      if (state.loop?.active && state.loop.target.includes(LOOP_AUDIT_MARKER)) {
        appendLedger(ctx.cwd, "audit_stack_warn", { have: "loop", starting: "goal" });
        ctx.ui.notify(
          "An audit loop is already running here — a one-shot /goal audit duplicates its work. /loop status to see it; /loop stop first if you want the one-shot instead.",
          "warning",
        );
      }
      return cmdSet(projectAuditTarget(route.rest || undefined), ctx, true);
    }
    // v0.28.27 (renamed /goal audit → /goal verify in v0.29.8): run the
    // isolated auditor on the current goal
    // RIGHT NOW, without engaging the agent. The user's "the work looks
    // done — just verify it" handle (and the manual counterpart of the
    // v0.28.26 stored-claim quota retry). Seeds a synthesized claim so a
    // quota block falls into the same pendingCompletion retry machinery.
    if (route.name === "verify") {
      if (!state.goal) {
        ctx.ui.notify("No active goal — /goal verify needs a goal to verify.", "warning");
        return;
      }
      if (completionAuditInFlight) {
        ctx.ui.notify("An audit is already running…", "info");
        return;
      }
      updateGoal({
        pendingCompletion: {
          completionSummary: "Manual audit requested by the user via /goal verify (no agent completion claim). Verify the objective against the repo directly.",
          at: nowIso(),
        },
      }, ctx);
      appendLedger(ctx.cwd, "manual_audit_requested", { goalId: state.goal.id });
      void retryStoredCompletionAudit(ctx, "manual");
      return;
    }
    if (route.name === "tweak") return cmdTweak(route.rest, ctx);
    if (route.name === "archive") return cmdGoals(ctx);
    // v0.16.0: /goal start <objective> — explicit skip-draft. Activates
    // immediately, no interview, no "Done when:" heuristic. Symmetric
    // with /loop start. The auditor infers the contract from the objective.
    if (route.name === "start") {
      if (!route.rest) {
        ctx.ui.notify("Usage: /goal start <objective> — activates immediately, skipping the drafting interview. (Without start, an objective needs a 'Done when:' clause or it gets drafted first.)", "warning");
        return;
      }
      return cmdSet(route.rest, ctx, true);
    }
  }
  return cmdSet(route.kind === "set" ? route.text : "", ctx);
}

// =================================================================
// /goal: bypass drafting, start now (the only entry in v0.1.0)
// =================================================================

async function cmdSet(args: string, ctx: ExtensionContext, skipDraft = false): Promise<void> {
  // v0.28.1 (S3): probe at the creation entry — no "created — starting now"
  // lie in a doomed process. (The draft path's seed send has its own loud
  // stale handling — E6.)
  const staleEntry = warnIfStaleAtEntry(ctx, "/goal");
  let raw = args.trim();
  // Users naturally quote the objective ("/goal \"do X\""); strip one layer of
  // surrounding matching quotes so they don't leak into the goal text.
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    await startDrafting(ctx, "goal");
    return;
  }
  if (isLoopActive()) {
    ctx.ui.notify("A /loop is active — /loop stop it before setting a goal.", "warning");
    return;
  }
  // v0.11.0: a contract-less objective gets drafted, not activated raw —
  // the pi-goal-x lesson: arg + Enter is worse than a 5-minute draft.
  // Include an explicit "Done when: …" clause to activate instantly.
  // v0.16.0: /goal start bypasses this by explicit user command.
  if (!skipDraft && goalArgsNeedDrafting(raw)) {
    await startDrafting(ctx, "goal", raw);
    return;
  }
  draftingTarget = null; // explicit objective cancels any drafting session
  resolveCarryover(ctx, "goal"); // v0.28.14: surface/clear stale leftovers
  const goal = createGoal(raw, ctx);
  setGoal(goal, ctx);
  // Reset counters
  iterationCounter = 0;
  consecutiveErrorIterations = 0;
  consecutiveAbortIterations = 0;
  consecutiveNoToolIterations = 0;
  if (staleEntry) {
    // v0.28.1 (S3): the goal is persisted — mark the interrupt so the next
    // fresh session LOADS it (held by default since v0.28.21), and tell the truth instead of "starting now".
    updateGoal({ interruptedAt: nowIso(), interruptedReason: "created in a stale session" }, ctx);
    ctx.ui.notify(`Goal saved: ${shortObj(goal.objective)} — safe in .pi-glla/, but this stale process can't send continuations. Run /reload (extensions rebuild in place, state survives), then /goal resume. Restart pi only if /reload itself fails.`, "warning");
    return;
  }
  ctx.ui.notify(`Goal started: ${shortObj(goal.objective)} — the auditor will verify on completion.`, "info");
  scheduleContinuation(ctx, true);
}

async function cmdStatus(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    ctx.ui.notify("No active goal. Use /goal <objective>.", "info");
    return;
  }
  const g = state.goal;
  const lines = [
    `${statusLabel(g.status)}: ${g.objective}`,
    // v0.24.7: name WHERE the work came from — a queue item is not a goal.
    ...(g.policy === "list" ? [`Source: /list queue (${listQueue().length} waiting) — /list to manage`] : []),
    `Auto-continue: ${g.autoContinue ? "on" : "off"}`,
    `Iteration: ${iterationCounter}`,
    `Tokens: ${(g.usage?.tokensUsed ?? 0).toLocaleString()}${(g.usage?.tokensLimit ?? 0) > 0 ? ` / ${(g.usage!.tokensLimit).toLocaleString()}` : " (no cap — /glla tokenlimit=<n> to set)"}`,
  ];
  if (g.auditHistory && g.auditHistory.length > 0) {
    lines.push(`Audits: ${g.auditHistory.length} (${g.auditHistory.filter((v) => v.approved).length} approved)`);
  }
  if (g.pauseReason) lines.push(`Paused: ${g.pauseReason}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdPause(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) return;
  updateGoal({ status: "paused" }, ctx);
  // v0.22.7: name WHAT was paused — a list item resumes through /list.
  if (state.goal.policy === "list") {
    const queued = listQueue().length;
    ctx.ui.notify(`List item "${shortObj(state.goal.objective)}" paused${queued > 0 ? ` (${queued} waiting in the list)` : ""}. /list resume to continue.`, "info");
    return;
  }
  ctx.ui.notify(`Goal "${shortObj(state.goal.objective)}" paused. /goal resume to continue.`, "info");
}

async function cmdResume(ctx: ExtensionContext): Promise<void> {
  // v0.34.3: /goal resume on an ACTIVE-but-idle goal re-kicks its
  // continuation (was: silent return — the user got NOTHING while the
  // widget said "active"). One-active-thing still holds: an active loop
  // wins over the re-kick.
  if (state.goal && state.goal.status === "active") {
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the goal.", "warning");
      return;
    }
    appendLedger(ctx.cwd, "resume_rekick", { goalId: state.goal.id, policy: state.goal.policy, via: "/goal resume" });
    if (state.goal.interruptedAt) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx); // v0.34.7: same marker law here
    ctx.ui.notify(
      `The ${state.goal.policy === "list" ? "list item" : "goal"} is ACTIVE but idle — re-firing its continuation: ${state.goal.objective.replace(/\s+/g, " ").slice(0, 70)}`,
      "info",
    );
    scheduleContinuation(ctx, true);
    return;
  }
  if (!state.goal || state.goal.status !== "paused") return;
  // v0.28.21: one-active-thing — the LAST unguarded activation path. A
  // paused goal/list-item must not resume over a live loop (covers
  // /goal resume AND /list resume, which routes here).
  if (isLoopActive()) {
    ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the goal.", "warning");
    return;
  }
  // v0.28.1 (S1/S3): resuming in a stale session used to flip status to
  // active, claim "Resumed goal", then re-pause on the stale send failure
  // (or zombie — S1). Now: persist the resume (the next fresh session
  // auto-resumes ACTIVE goals), mark the interrupt, tell the truth, and
  // skip the send that can never land.
  const staleEntry = warnIfStaleAtEntry(ctx, "/goal resume");
  // v0.12.0: refresh the token cap from CURRENT settings on resume — goals
  // snapshot the cap at creation, so a goal paused under an old default
  // (e.g. 10M) would re-pause instantly even after the default changed.
  const freshLimit = loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const usage = state.goal.usage
    ? { tokensUsed: state.goal.usage.tokensUsed, tokensLimit: freshLimit }
    : undefined;
  // v0.34.2: clear the stale-handle interrupt marker on a MANUAL resume too —
  // the only clear-site used to be the autoResume restore path, so with
  // autoresume=off a resumed goal kept the red "⚠ interrupted — stale handle"
  // status line forever while actively working (hegemon, 2026-08-01). The
  // marker's promise ("a fresh session will resume you") is fulfilled by a
  // manual resume exactly as by an automatic one. (staleEntry still re-marks
  // below — a resume inside a stale session is a NEW interrupt.)
  updateGoal({ status: "active", pauseReason: undefined, pauseSuggestedAction: undefined, pauseKind: undefined, pauseOptions: undefined, pauseRecommended: undefined, pauseResumeAt: undefined, interruptedAt: undefined, interruptedReason: undefined, ...(staleEntry ? { interruptedAt: nowIso(), interruptedReason: "resumed in a stale session" } : {}), ...(usage ? { usage } : {}) }, ctx);
  if (staleEntry) return;
  // v0.22.5: say what was resumed — with a non-empty list this also resumes
  // the queue (the active goal IS the list's head item).
  // v0.22.7: name WHAT was resumed — list items resume through /list.
  const queued = listQueue().length;
  const isListItem = state.goal.policy === "list";
  ctx.ui.notify(
    isListItem
      ? `Resumed list item [${state.goal.id}]: ${state.goal.objective.replace(/\s+/g, " ").slice(0, 70)}${queued > 0 ? ` (+${queued} waiting in the list)` : ""}`
      : `Resumed goal [${state.goal.id}]: ${state.goal.objective.replace(/\s+/g, " ").slice(0, 70)}${queued > 0 ? ` (+${queued} waiting in the list — resuming the list's head)` : ""}`,
    "info",
  );
  scheduleContinuation(ctx, true);
}

async function cmdCancel(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    // v0.28.14: users reach for /goal cancel to kill a LOOP (no goal
    // active) — point at the right verb instead of doing nothing silently.
    if (isLoopActive()) {
      ctx.ui.notify("No goal to cancel — a LOOP is active: /loop stop (or /loop cancel) ends it.", "info");
    }
    return;
  }
  archiveCurrentGoal(ctx, "aborted", "user cancelled");
  ctx.abort();
  ctx.ui.notify(`${goalNoun()} aborted.${isLoopActive() ? " A loop is still active — /loop stop ends it." : ""}`, "info");
}

// ---- v0.28.23: decision picker popup ----
// A decision pause is ACTIONABLE — the widget card summarizes (and
// truncates) it, but picking from a truncated wall was the user's
// complaint. Borrow Claude Code / muselinn-Ask: a real select() modal
// with the FULL option text, pick → act. Escape leaves the card as the
// fallback; /goal decide re-opens the picker at any time.

let decisionPromptOpen = false;

/** True when the goal is paused on a user decision with options. */
function pendingDecision(): Goal | null {
  const g = state.goal;
  return g && g.status === "paused" && g.pauseKind === "decision" && g.pauseOptions && g.pauseOptions.length > 0 ? g : null;
}

/** Open the decision picker for the current decision pause. Returns true
 * when a picker was shown (false → caller notifies "no pending decision"). */
async function showDecisionPrompt(ctx: ExtensionContext): Promise<boolean> {
  const g = pendingDecision();
  if (!g || !ctx.hasUI || decisionPromptOpen) return false;
  decisionPromptOpen = true;
  try {
    const title = `Decision needed — ${g.objective.replace(/\s+/g, " ").slice(0, 72)}${g.pauseReason ? ` · ${g.pauseReason.slice(0, 80)}` : ""}`;
    const options = g.pauseOptions!.map((o, i) => (g.pauseRecommended === i + 1 ? `${o}  (recommended)` : o));
    const pick = await ctx.ui.select(title, options);
    if (!pick) return true; // Escape — the widget card remains the fallback
    const idx = options.indexOf(pick);
    const label = g.pauseOptions![idx] ?? pick.replace(/ {2}\(recommended\)$/, "");
    // v0.29.3: the wipe escape — "… (/glla wipe)" options run the wipe
    // (which Confirms on its own — destructive actions keep their gate).
    if (/\(\/glla wipe\)\s*$/.test(label)) {
      await cmdGllaWipe(ctx);
      return true;
    }
    // Executable options — "Label (/goal cancel)" — RUN the command.
    // Placeholder commands (…/<arg>) fall through to the message path.
    const cmdMatch = label.match(/\(\/(goal|list|loop) ([a-z]+)\)\s*$/);
    if (cmdMatch && !label.includes("…") && !label.includes("<")) {
      const [, group, verb] = cmdMatch;
      if (group === "goal" && verb === "resume") await cmdResume(ctx);
      else if (group === "goal" && verb === "cancel") await cmdCancel(ctx);
      else if (group === "loop" && verb === "stop") await cmdLoop("stop", ctx);
      else if (group === "loop" && verb === "resume") await cmdLoop("resume", ctx);
      else {
        safeSteerUser(ctx, `Decision for the paused goal "${g.objective}": ${label} — continue on this path.`);
        await cmdResume(ctx);
      }
      return true;
    }
    // Content choice — deliver to the agent, then resume.
    safeSteerUser(ctx, `Decision for the paused goal "${g.objective}": ${label} — continue on this path.`);
    await cmdResume(ctx);
    return true;
  } finally {
    decisionPromptOpen = false;
  }
}

/** Pop the picker after a decision pause lands — deferred so the current
 * turn finishes first (pi serializes dialogs). No-ops without a UI, when
 * disabled (/glla decisionpopup=off), or when one is already open. */
function maybeDecisionPopup(ctx: ExtensionContext): void {
  if (!ctx.hasUI || loadSettings(ctx.cwd).decisionPopup === false) return;
  setTimeout(() => {
    void showDecisionPrompt(ctx).catch(() => {});
  }, 600);
}

async function cmdGoals(ctx: ExtensionContext): Promise<void> {
  const dir = archiveDir(ctx.cwd);
  if (!fs.existsSync(dir)) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
  if (files.length === 0) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const lines = files.slice(0, 20).map((f) => {
    let status = "?";
    let stop = "";
    let obj = "";
    try {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      status = content.match(/\*\*Status\*\*:\s*(\w+)/)?.[1] ?? "?";
      stop = content.match(/\*\*Stop reason\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
      obj = content.match(/## Objective\s+>\s*(.+)/)?.[1]?.trim() ?? "";
    } catch { /* unreadable file — show name only */ }
    return `${f.replace(/\.md$/, "")} [${status}] ${obj.slice(0, 60)}${stop ? ` — ${stop.slice(0, 40)}` : ""}`;
  });
  ctx.ui.notify(
    `Archived goals (${files.length}${files.length > 20 ? ", showing 20" : ""}):\n` + lines.join("\n"),
    "info",
  );
}

async function cmdTweak(args: string, ctx: ExtensionContext): Promise<void> {
  if (!state.goal || state.goal.status !== "active") {
    ctx.ui.notify("No active goal to tweak. /goal <objective> to start one.", "info");
    return;
  }
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    ctx.ui.notify("Usage: /goal tweak <replacement objective, optional 'Done when: ...' clause>", "info");
    return;
  }
  const current = state.goal;
  const proposed = extractVerificationContract(raw);
  const newObjective = proposed.objective;
  const newContract = proposed.verificationContract;
  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm(
      "Tweak goal?",
      `CURRENT:\n${current.objective}\n\nNEW:\n${newObjective}` +
      (newContract ? `\n\nNew contract:\n${newContract}` : "\n\n(New text carries no contract; old contract is dropped.)"),
    );
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    ctx.ui.notify("Tweak cancelled; goal unchanged.", "info");
    return;
  }
  updateGoal({ objective: newObjective, verificationContract: newContract }, ctx);
  appendLedger(ctx.cwd, "goal_tweaked", { goalId: current.id, objective: newObjective });
  ctx.ui.notify("Goal tweaked. The loop continues against the new objective.", "info");
  scheduleContinuation(ctx, true);
}

// =================================================================
// /list commands (loop 2)
// =================================================================

/**
 * The ONE enqueue path (v0.8.4): bulk import, items[] drafting, and the
 * agent's list_add tool all funnel here. Texts → ListItems (with per-item
 * contract extraction) → appended to the queue → persisted → first item
 * activated when nothing is running. Returns the count enqueued.
 */
// v0.29.1: zombie-twin guard. A draft/enqueue whose objective matches a
// goal COMPLETED in the last 24h re-creates just-finished work — field-
// observed in junk-runner: the INFRA-NEW-18 close was re-drafted 3 minutes
// after the auditor approved it and autoaccept waved the twin straight in,
// where it stormed for 9h against a dead provider. Normalized compare (goal
// ids stripped), 24h lookback, loud skip — never silent.
const DUPLICATE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LEDGER_TAIL_BYTES = 256 * 1024;
function recentlyCompletedObjectives(cwd: string): Set<string> {
  const done = new Set<string>();
  try {
    const p = ledgerPath(cwd);
    const size = fs.statSync(p).size;
    const buf = Buffer.alloc(Math.min(size, LEDGER_TAIL_BYTES));
    const fd = fs.openSync(p, "r");
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const cutoff = Date.now() - DUPLICATE_LOOKBACK_MS;
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.includes('"goal_archived"') || !line.includes('"complete"')) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type !== "goal_archived" || e.value?.status !== "complete") continue;
        if (!(Date.parse(e.ts ?? "") >= cutoff)) continue;
        // v0.29.1+ entries carry the objective inline; older entries fall
        // back to the archived goal file (## Objective → "> …" line).
        let objective = typeof e.value?.objective === "string" ? e.value.objective : "";
        if (!objective && e.value?.goalId) {
          try {
            const md = fs.readFileSync(archivedGoalPath(cwd, e.value.goalId), "utf-8");
            objective = md.split("## Objective")[1]?.split("\n").find((l: string) => l.startsWith("> "))?.slice(2) ?? "";
          } catch { /* archived file gone — skip */ }
        }
        if (objective) done.add(normalizeObjective(objective));
      } catch { /* malformed line — skip */ }
    }
  } catch { /* no ledger yet */ }
  return done;
}

function enqueueItems(ctx: ExtensionContext, texts: string[], source: string, opts?: { autoActivate?: boolean }): number {
  const recentlyDone = recentlyCompletedObjectives(ctx.cwd);
  const fresh = texts.filter((t) => !recentlyDone.has(normalizeObjective(extractVerificationContract(t).objective)));
  const skipped = texts.length - fresh.length;
  if (skipped > 0) {
    const first = texts.find((t) => recentlyDone.has(normalizeObjective(extractVerificationContract(t).objective))) ?? "";
    appendLedger(ctx.cwd, "list_duplicate_skipped", { source, count: skipped, objective: first.slice(0, 200) });
    ctx.ui.notify(`Skipped ${skipped} item(s) duplicating work COMPLETED in the last 24h (zombie-twin guard): ${first.slice(0, 90)}`, "warning");
  }
  if (fresh.length === 0) return 0;
  const items = fresh.map((text) => {
    const extracted = extractVerificationContract(text);
    // v0.34.9: tag each new list item with the current session id so the
    // cross-session guard can refuse to cascade foreign-session items.
    const sessId = (ctx.sessionInfo as any)?.id ?? (ctx as any).sessionId;
    return {
      id: newGoalId(),
      objective: extracted.objective,
      verificationContract: extracted.verificationContract || undefined,
      addedAt: nowIso(),
      sessionId: sessId ? String(sessId) : undefined,
    };
  });
  state = { ...state, list: [...listQueue(), ...items] };
  persistState(ctx);
  appendLedger(ctx.cwd, "list_imported", { source, count: items.length });
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    // v0.28.28: unsolicited sources (the reviewer) do NOT auto-start the
    // head unless autoResume is on — "I cancelled a goal and the next one
    // started itself" was the field complaint. User-driven imports keep
    // the immediate-start behavior (opts default true).
    if (opts?.autoActivate === false) {
      ctx.ui.notify(`Queued ${items.length} item(s) from ${source} — /list next when ready (auto-start is opt-in: /glla autoresume=on).`, "info");
      appendLedger(ctx.cwd, "list_autoactivation_held", { source, count: items.length });
    } else {
      activateNextListItem(ctx);
    }
  }
  return items.length;
}

/** Bulk-enqueue parsed items: one Confirm for the whole batch, never drafts. */
async function bulkAddItems(ctx: ExtensionContext, parsed: string[], sourceName: string): Promise<void> {
  if (parsed.length === 0) {
    ctx.ui.notify("No items found (headings/blank lines don't count).", "warning");
    return;
  }
  // v0.23.7: show ALL items in full — a Confirm the user can't fully
  // read is not a gate (same rule as the draft dialog, v0.23.5).
  const preview = parsed.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  let confirmed = true;
  if (ctx.hasUI) {
    try {
      confirmed = await ctx.ui.confirm(
        "Import into list?",
        `${parsed.length} items from ${sourceName}:\n${preview}`,
      );
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    ctx.ui.notify("Import cancelled.", "info");
    return;
  }
  const n = enqueueItems(ctx, parsed, sourceName);
  if (state.goal && state.goal.status === "active") {
    ctx.ui.notify(`Imported ${n} items (${listQueue().length} waiting in the list).`, "info");
  }
}

/** Bulk-enqueue from a file: read, parse, delegate to bulkAddItems. */
async function bulkAddFromFile(ctx: ExtensionContext, abs: string): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    ctx.ui.notify(`Cannot read: ${abs}`, "warning");
    return;
  }
  await bulkAddItems(ctx, parseListImport(content), path.basename(abs));
}

async function cmdList(args: string, ctx: ExtensionContext): Promise<void> {
  // v0.28.1 (S3): honest staleness warning; read-only subcommands still work.
  warnIfStaleAtEntry(ctx, "/list");
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (sub === "audit") {
    // v0.31.0: /list audit [focus] — collect-then-drain (user design
    // 2026-07-31: "run a project audit, collect a bunch of tasks, then do
    // them all too"). The audit item COLLECTS findings (changes no code);
    // its completion fans each open finding out into the queue and the
    // list drains them fix by fix, each with its own isolated audit.
    // Distinct from /goal audit (fix-in-pass, one audited unit) and
    // /loop audit (forever fix-first cadence).
    // v0.31.1: an active audit loop is already draining this findings file —
    // a collect pass would double-hunt the same ground.
    if (state.loop?.active && state.loop.target.includes(LOOP_AUDIT_MARKER)) {
      appendLedger(ctx.cwd, "audit_stack_warn", { have: "loop", starting: "list" });
      ctx.ui.notify("An audit loop is already draining findings here — /list audit would double-hunt the same ground. /loop status to see it.", "warning");
    }
    const objective = listAuditCollectTarget(rest || undefined);
    const n = enqueueItems(ctx, [objective], "/list audit");
    if (n === 0) return; // zombie-twin guard already explained itself
    ctx.ui.notify(
      "Audit collection item queued — it CHANGES NO CODE: it appends findings to " +
        AUDIT_FINDINGS_REL +
        ", and on completion each open finding becomes its own list item (fixes drain one audited commit at a time). DECIDE findings are presented to you, never queued.",
      "info",
    );
    return;
  }

  if (sub === "depth") {
    // v0.25.3: long-running state at a glance — queue depth, oldest item
    // age, average item duration from archived list-policy goals.
    let entries: Array<{ type: string; value?: any }> = [];
    try {
      entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
    } catch {
      /* no ledger yet */
    }
    const stats = computeListDepth(listQueue(), entries, Date.now());
    ctx.ui.notify(`/list depth: ${formatListDepth(stats)}`, "info");
    return;
  }

  if (sub === "resume") {
    // Resume the list's head. The head activates AS the active goal, so this
    // is the same motion as /goal resume — named for the surface the user is
    // looking at (v0.22.7: "we would just unpause, and that is next").
    if (!state.goal || state.goal.status !== "paused") {
      ctx.ui.notify("No paused list item to resume. /list show to see the list.", "info");
      return;
    }
    if (state.goal.policy !== "list") {
      ctx.ui.notify("The paused goal didn't come from the list — /goal resume to continue it.", "info");
      return;
    }
    await cmdResume(ctx);
    return;
  }

  if (!sub || sub === "show") {
    const queue = listQueue();
    const lines: string[] = [];
    if (state.goal) {
      lines.push(`Active: [${state.goal.policy}] ${state.goal.objective.slice(0, 80)} (${statusLabel(state.goal.status)})`);
    } else {
      lines.push("Active: (none)");
    }
    if (queue.length === 0) {
      lines.push("List: empty. /list <describe your tasks, or a plan file> — the agent shapes dumps into items, files import directly.");
    } else {
      lines.push(`List (${queue.length}):`);
      const PAGE = 15;
      queue.slice(0, PAGE).forEach((item, i) => lines.push(`  ${i + 1}. ${item.objective.slice(0, 90)}`));
      if (queue.length > PAGE) {
        lines.push(`  … and ${queue.length - PAGE} more. /list remove <n> to prune, /list clear to empty.`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }


  // v0.19.0: `add` and `import` are pure no-op aliases — the verb changes
  // nothing, detection routes everything. `/list plan.md` and
  // `/list add plan.md` both import; `/list fix x, do y` and
  // `/list add fix x, do y` both draft. Rationale: a list item activates
  // RAW when it reaches the head, so the drafting interview is the only
  // quality gate an item ever gets — a verb whose only job was skipping
  // that gate was a leak, not an escape hatch. The direct path is an
  // explicit "Done when:" clause (user already did the contract work).
  if (sub === "add" || sub === "import") {
    if (!rest) {
      await startDrafting(ctx, "list");
      return;
    }
    const aliased = routeListText(ctx.cwd, rest.replace(/^["']|["']$/g, ""));
    if (aliased.kind === "file") {
      await bulkAddFromFile(ctx, aliased.path);
      return;
    }
    if (aliased.kind === "batch") {
      await bulkAddItems(ctx, aliased.items, "pasted text");
      return;
    }
    if (aliased.kind === "direct") {
      addSingleItem(ctx, aliased.text);
      return;
    }
    await startDrafting(ctx, "list", aliased.seed);
    return;
  }

  if (sub === "clear") {
    state = { ...state, list: [] };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_cleared", {});
    ctx.ui.notify("List cleared. Active goal (if any) is untouched — /goal cancel for that, /list cancel to stop the whole list.", "info");
    return;
  }

  // v0.24.1: ONE verb for "stop this whole list" — aborts the active item
  // when it's list-sourced AND drops the waiting items. Before this the user
  // had to know to combine /goal cancel + /list clear.
  if (sub === "cancel") {
    const waiting = listQueue().length;
    const activeIsListItem = state.goal?.policy === "list" && (state.goal.status === "active" || state.goal.status === "paused");
    if (waiting === 0 && !activeIsListItem) {
      ctx.ui.notify("No list to cancel — nothing waiting, and the active goal (if any) isn't a list item. /goal cancel aborts a standalone goal.", "info");
      return;
    }
    const dropped = waiting;
    state = { ...state, list: [] };
    persistState(ctx);
    if (activeIsListItem) {
      archiveCurrentGoal(ctx, "aborted", "list cancelled");
      ctx.abort();
    }
    appendLedger(ctx.cwd, "list_cancelled", { abortedActive: activeIsListItem, dropped });
    ctx.ui.notify(
      `List cancelled: ${activeIsListItem ? "active item aborted + " : ""}${dropped} waiting item(s) dropped.${!activeIsListItem && state.goal && state.goal.status === "active" ? " Active goal is not a list item — untouched (/goal cancel for that)." : ""}`,
      "info",
    );
    return;
  }

  if (sub === "next") {
    // Skip the current active goal (abort it) and activate a queued item.
    // Bare = the head (FIFO default); /list next <n> = item n (shopping-list
    // semantics: order is the default, not the law).
    const n = rest ? Number.parseInt(rest, 10) : 1;
    if (!Number.isInteger(n) || n < 1) {
      ctx.ui.notify(`Usage: /list next [1-${listQueue().length || 1}]`, "info");
      return;
    }
    // v0.28.14: one-active-thing — /list next must not jump a live loop.
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — /loop stop it before activating a list item.", "warning");
      return;
    }
    if (state.goal && state.goal.status === "active") {
      archiveCurrentGoal(ctx, "aborted", `skipped via /list next ${n > 1 ? n : ""}`.trim());
    }
    if (!activateNextListItem(ctx, n)) {
      ctx.ui.notify(listQueue().length === 0 ? "List is empty — nothing to activate." : `No item #${n} (list has ${listQueue().length}).`, "info");
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const n = Number.parseInt(rest, 10);
    const queue = listQueue();
    if (!Number.isFinite(n) || n < 1 || n > queue.length) {
      ctx.ui.notify(`Usage: /list remove <1-${queue.length}>`, "info");
      return;
    }
    const removed = queue[n - 1]!;
    state = { ...state, list: queue.filter((_, i) => i !== n - 1) };
    persistState(ctx);
    appendLedger(ctx.cwd, "list_removed", { id: removed.id, objective: removed.objective });
    ctx.ui.notify(`Removed: ${removed.objective.slice(0, 80)}`, "info");
    return;
  }

  // v0.18.0: an unknown first word isn't an error — it's a natural-language
  // dump. "/list fix the login bug, add dark mode, write docs" should MAKE
  // a list, not print usage. Detection chain: file → batch → contract →
  // conversational decomposition (drafting). The explicit verb for adding
  // one item verbatim is /list add.
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  const route = routeListText(ctx.cwd, raw);
  if (route.kind === "file") {
    await bulkAddFromFile(ctx, route.path);
    return;
  }
  if (route.kind === "batch") {
    await bulkAddItems(ctx, route.items, "pasted text");
    return;
  }
  if (route.kind === "direct") {
    addSingleItem(ctx, route.text);
    return;
  }
  await startDrafting(ctx, "list", route.seed);
}

/** Append one objective to the list; activate immediately when idle. */
function addSingleItem(ctx: ExtensionContext, raw: string): void {
  const { objective, verificationContract } = extractVerificationContract(raw);
  const item = { id: newGoalId(), objective, verificationContract: verificationContract || undefined, addedAt: nowIso() };
  state = { ...state, list: [...listQueue(), item] };
  persistState(ctx);
  appendLedger(ctx.cwd, "list_added", { id: item.id, objective: item.objective });
  // Nothing active → activate immediately.
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    activateNextListItem(ctx);
  } else {
    ctx.ui.notify(`Added to the list (${listQueue().length} waiting): ${objective.slice(0, 80)}`, "info");
  }
}

/**
 * Push notification, folded IN by default (v0.28.34 — user: "leaving it to
 * the user to set up sucks, cause then they won't have it"). Resolution:
 *   notifyCmd === "off"   → silent (explicit opt-out)
 *   notifyCmd set         → that command, message passed as $1
 *   notifyCmd unset       → auto-detect ONCE per session: notify-send
 *                           (Linux) or osascript (macOS); none → silent.
 * Pushes fire only where there is something to DO — pauses, auditor
 * verdicts, storms, wedge, persistence degradation — never per-turn noise.
 * Fire-and-forget: a broken notifier never blocks the loop.
 */
let autoNotifyCmd: string | null | undefined; // undefined = not probed yet

function probeAutoNotify(ctx: ExtensionContext): void {
  if (autoNotifyCmd !== undefined || !extensionApi) return;
  autoNotifyCmd = null; // probing sentinel — drops at most the first push
  void extensionApi
    .exec("bash", ["-c", "command -v notify-send || command -v osascript || true"], { cwd: ctx.cwd })
    .then((r) => {
      const found = String((r as { stdout?: string }).stdout ?? "").trim();
      if (found.endsWith("notify-send")) autoNotifyCmd = `notify-send "pi-goal-list-loop-audit" "$1"`;
      // env-var handoff: the message never touches AppleScript quoting.
      else if (found.endsWith("osascript")) autoNotifyCmd = `GLLA_MSG="$1" osascript -e 'display notification (system attribute "GLLA_MSG") with title "pi-goal-list-loop-audit"'`;
      else autoNotifyCmd = null;
    })
    .catch(() => {
      autoNotifyCmd = null;
    });
}

function notifyExternal(ctx: ExtensionContext, message: string): void {
  try {
    const settings = loadSettings(ctx.cwd);
    if (settings.notifyCmd === "off" || !extensionApi) return;
    const cmd = settings.notifyCmd ?? autoNotifyCmd;
    if (!cmd) {
      if (settings.notifyCmd === undefined && autoNotifyCmd === undefined) probeAutoNotify(ctx);
      return;
    }
    void extensionApi.exec("bash", ["-c", cmd, "pi-goal-list-loop-audit", message], { cwd: ctx.cwd }).catch(() => {});
  } catch {
    // non-fatal by design
  }
}

// =================================================================
// Loop 3: /loop — metric-driven process loop (never completes)
//
// The anti-doorknob law: the loop only believes a number. The orchestrator
// runs the user's measure command (via pi.exec) after every agent turn;
// the agent never self-reports progress. Termination: plateau, iteration
// cap, or /loop stop. There is NO auditor in loop 3 — the metric is the
// verdict.
// =================================================================

let loopTimer: NodeJS.Timeout | null = null;

function clearLoopTimer(): void {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function isLoopActive(): boolean {
  return !!state.loop?.active;
}

/** Run the user's measure command. Orchestrator-side, never agent-side. */
async function runMeasure(ctx: ExtensionContext, cmd: string): Promise<number | null> {
  if (!extensionApi || extensionApiStale) return null;
  try {
    const result = await extensionApi.exec("bash", ["-c", cmd], { cwd: ctx.cwd, timeout: MEASURE_TIMEOUT_MS });
    const stdout = (result as any)?.stdout ?? "";
    return parseMetric(String(stdout));
  } catch {
    return null;
  }
}

/** git wrapper for branch=1 mode. Returns {ok, stdout}; never throws. */
async function runGit(ctx: ExtensionContext, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  if (!extensionApi) return { ok: false, stdout: "" };
  try {
    const result = await extensionApi.exec("git", args, { cwd: ctx.cwd });
    const r = result as any;
    const code = typeof r?.code === "number" ? r.code : (r?.exitCode ?? 1);
    return { ok: code === 0, stdout: String(r?.stdout ?? "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function loopPrompt(loop: LoopState, regressionNote: string, strategyNote: string, boundsNote: string, interventionNote = "", variantNote = "", hypothesisNote = "", refineHintNote = ""): string {
  // v0.23.0: metricless loops get their own prompt — no metric section,
  // anti-doorknob rules instead of anti-gaming rules.
  const metricless = !loop.measureCmd;
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", metricless ? "goal-loop-forever-metricless.md" : "goal-loop-forever.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = metricless
      ? `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Metricless spec loop — make ONE real, inspectable change advancing the target. No cosmetic churn. ${variantNote} ${interventionNote}`
      : `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Measure: ${loop.measureCmd} (${loop.direction}). Make ONE small change to improve the metric. ${interventionNote}`;
  }
  return tmpl
    .replace(/\$\{ITERATION\}/g, String(loop.iteration + 1))
    .replace(/\$\{TARGET\}/g, loop.target)
    .replace(/\$\{MEASURE_CMD\}/g, loop.measureCmd ?? "none")
    .replace(/\$\{DIRECTION\}/g, loop.direction ?? "none")
    .replace(/\$\{DIRECTION_WORD\}/g, loop.direction === "min" ? "lower is better" : "higher is better")
    .replace(/\$\{LAST_VALUE\}/g, loop.lastValue === null ? "(none yet)" : String(loop.lastValue))
    .replace(/\$\{BEST_VALUE\}/g, loop.bestValue === null ? "(none yet)" : String(loop.bestValue))
    .replace(/\$\{STALL_COUNT\}/g, String(loop.stallCount))
    .replace(/\$\{PLATEAU_WINDOW\}/g, String(loop.plateauWindow))
    .replace(/\$\{REGRESSION_NOTE\}/g, regressionNote)
    .replace(/\$\{STRATEGY_NOTE\}/g, strategyNote)
    .replace(/\$\{BOUNDS_NOTE\}/g, boundsNote)
    .replace(/\$\{INTERVENTION_NOTE\}/g, interventionNote)
    .replace(/\$\{VARIANT_NOTE\}/g, variantNote)
    .replace(/\$\{HYPOTHESIS_NOTE\}/g, hypothesisNote)
    .replace(/\$\{REFINE_HINT\}/g, refineHintNote);
}

function scheduleLoopTick(ctx: ExtensionContext): void {
  if (!isLoopActive()) return;
  // v0.34.9: cross-session leak guard. Mirror of the goal guard — if the
  // loop was started in a different session, do NOT inject its iteration
  // prompt into this session. /loop resume to opt in.
  {
    const currentSessId = (ctx as any)?.sessionInfo?.id ?? (ctx as any)?.sessionId;
    const loopSessId = state.loop && (state.loop as any).sessionId;
    if (loopSessId && currentSessId && loopSessId !== currentSessId) {
      appendLedger(ctx.cwd, "loop_tick_held_foreign_session", {
        goalSession: String(loopSessId).slice(0, 12),
        currentSession: String(currentSessId).slice(0, 12),
      });
      try {
        ctx.ui.notify(
          `glla: /loop from a different session held (belongs to session ${String(loopSessId).slice(0, 8)}…; this session is ${String(currentSessId).slice(0, 8)}…). Run /loop resume to continue it here.`,
          "info",
        );
      } catch { /* ui not available */ }
      return;
    }
  }
  rememberCtx(ctx);
  clearLoopTimer();
  let delay = 0;
  try {
    delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS;
  } catch {
    return;
  }
  loopTimer = setTimeout(() => sendLoopTurn(), delay);
  loopTimer.unref?.();
}

function sendLoopTurn(): void {
  loopTimer = null;
  if (!isLoopActive() || !extensionApi) return;
  const ctx = freshCtx();
  if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages()) {
    if (!ctx) {
      // v0.33.1: mirror sendContinuation — probe the handle (terminal exit)
      // and advance the streak so the cadence backs off instead of spinning
      // a flat 50ms below every watchdog.
      if (probeExtensionApiStale()) return;
      loopRearmStreak++;
    } else accountSendRearm(ctx, "loop");
    loopTimer = setTimeout(() => sendLoopTurn(), sendRearmDelayMs(loopRearmStreak)); // v0.28.29: backing-off cadence
    loopTimer.unref?.();
    return;
  }
  const loop = state.loop!;
  // v0.29.10: "regressed" = the last two measurements moved the WRONG way
  // — not merely "didn't beat best". The old trigger (any non-improving
  // iteration) cried REGRESSED on stalls and on the audit loop's
  // degenerate baseline-0, telling agents to undo GOOD fixes (junk-runner
  // 2026-07-30: 17→16 was real progress; the prompt demanded a revert).
  const hist = loop.history;
  const prevValue = hist.length >= 2 ? hist[hist.length - 2]!.value : null;
  const lastHistValue = hist.length >= 1 ? hist[hist.length - 1]!.value : null;
  const trueRegression = prevValue !== null && lastHistValue !== null && loop.direction !== undefined &&
    (loop.direction === "min" ? lastHistValue > prevValue : lastHistValue < prevValue);
  const regressionNote = trueRegression
    ? loop.kind === "audit"
      ? "**The closed-findings count went DOWN last iteration — a checked finding was reopened or findings.md was rewritten (both forbidden). Restore the closed entries, then keep fixing the highest-severity OPEN items.**"
      : "**Your last change REGRESSED the metric. Undo it first, then try a different small change.**"
    : "";
  // Strategy rotation (from pi-loop-mode's one good idea): one stall before
  // the plateau window closes, stop polishing and change approach entirely.
  const strategyNote = loop.stallCount >= loop.plateauWindow - 1 && loop.stallCount > 0
    ? "**You are one stall from a plateau stop. Small tweaks are not working — try a FUNDAMENTALLY different approach: different file, different technique, or revert and rethink the angle of attack.**" +
      // v0.33.2: a metric flat AT BEST may mean the spec stopped capturing
      // "better" — the loop holds the evidence, so it says so (was: the
      // prompt said "call propose_loop_refine" but the loop never suggested it).
      (loop.lastValue !== null && loop.lastValue === loop.bestValue
        ? " **The metric has been flat at best — if the spec no longer captures 'better' (saturated metric, drifted target), call propose_loop_refine.**"
        : "")
    : "";
  // v0.34.0: divergence bail (pi-auto-review's one good idea) — N consecutive
  // iterations moving the metric the WRONG way means the changes themselves
  // are hurting (audit loops: fixes breaking things / findings reopening).
  // Note-only: the agent reassesses; nothing auto-stops.
  let trailingRegressions = 0;
  if (loop.direction) {
    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1]!.value, b = hist[i]!.value;
      if (a === null || b === null) break; // metricless ticks carry no value
      const regressed = loop.direction === "min" ? b > a : b < a;
      if (regressed) trailingRegressions++; else break;
    }
  }
  const divergenceNote = trailingRegressions >= 3
    ? `**${trailingRegressions} consecutive regressions — every recent change moved the metric the WRONG way. Stop making small edits and reassess the whole approach: are the fixes breaking things, or is the measure being gamed? If the target itself is drifting, call propose_loop_refine or recommend /loop stop.**`
    : "";
  const strategyNote2 = strategyNote + (strategyNote && divergenceNote ? " " : "") + divergenceNote;
  // v0.15.0: arbitrary bounds (never "completion") — surface what's armed.
  // v0.23.0: for metricless loops the bounds are the ONLY stop (no
  // plateau), so the note names that — and an unbounded metricless loop
  // gets the furnace warning.
  const metricless = !loop.measureCmd;
  const bounds: string[] = [];
  if (loop.timeLimitHours !== undefined) bounds.push(`${loop.timeLimitHours}h`);
  if (loop.tokenBudget !== undefined) bounds.push(`${loop.tokenBudget.toLocaleString()} tokens (used ${(loop.tokensUsed ?? 0).toLocaleString()})`);
  let boundsNote = "";
  if (metricless) {
    if (loop.maxIterations > 0) bounds.unshift(`${loop.maxIterations} iterations`);
    boundsNote = bounds.length
      ? `\n- Bounds armed: the loop ends after ${bounds.join(" or ")} — or /loop stop. There is NO plateau stop.`
      : `\n- NO bounds armed — this loop ends only at /loop stop. Spend each iteration like it costs money; it does.`;
  } else if (bounds.length) {
    boundsNote = `\n- Arbitrary bounds: the loop also stops after ${bounds.join(" or ")}`;
  }
  // v0.24.0: a stuck intervention REPLACES the pep talk — the rotating
  // directive names why the loop is stuck and what rung of the ladder it's on.
  // v0.29.19: a plateau reprieve's one-shot shove takes priority over the
  // stuck directive (they can't both be meaningful in the same iteration).
  const reprieveNote = loop.auditReprieveNote ?? "";
  if (reprieveNote) loop.auditReprieveNote = undefined;
  const interventionNote = reprieveNote || ((loop.consecutiveStuck ?? 0) > 0 && loop.lastStuckReason
    ? loopInterventionDirective(loop.consecutiveStuck!, loop.lastStuckReason, loop.recentTexts ?? [])
    : "");
  // v0.24.0: identical prompts invite identical answers — rotate the base
  // instruction (metricless loops; metric loops already vary via values).
  const variantNote = metricless ? continueVariant(loop.iteration) : "";
  // v0.33.2: one-shot prompt payloads, consumed on use.
  const hypothesisNote = loop.hypothesisFeedback ?? "";
  if (hypothesisNote) loop.hypothesisFeedback = undefined;
  const refineHintNote = loop.refineHint
    ? `**The operator suggests refining the spec:** ${loop.refineHint} — if the current spec no longer captures "better", call propose_loop_refine (target and/or measureCmd${loop.specFile ? " and/or specText/specAppend" : ""}); if it still stands, say why in one line and keep working.`
    : "";
  if (refineHintNote) loop.refineHint = undefined;
  try {
    let loopResync = "";
    if (postCompactResyncPending) { try { loopResync = buildPostCompactResync(); } catch { loopResync = ""; } } // v0.33.1
    extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: loopResync + loopPrompt(loop, regressionNote, strategyNote2, boundsNote, interventionNote, variantNote, hypothesisNote, refineHintNote),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    if (loopResync) postCompactResyncPending = false; // consumed only by a landed send
    // v0.26.1: the send path is ledgered — the hegemon zombie spun 619
    // refires with zero visibility into whether sends were landing.
    loopRearmStreak = 0; loopRearmSince = 0; // v0.28.5 (E3): a landed turn clears the storm
    appendLedger(ctx.cwd, "loop_turn_sent", { iteration: loop.iteration });
    lastContinuationSentAt = Date.now();
    armQueueStuckProbe(ctx, lastContinuationSentAt);
  } catch (err) {
    // stale API — next agent_end reschedules (but if none comes, the
    // heartbeat's stall escalation stops the spin — v0.26.1).
    appendLedger(ctx.cwd, "loop_turn_send_failed", { error: err instanceof Error ? err.message : String(err) });
    // v0.26.7: stale runtime is terminal, not transient — go loud now.
    if (isStaleApiError(err)) goStaleTerminal(ctx, "sendLoopTurn");
  }
}

/** agent_end hook for loop 3: measure → judge → continue or stop. */
async function runLoopTick(ctx: ExtensionContext, event?: any): Promise<void> {
  const loop = state.loop!;
  // v0.15.0: token budget is an arbitrary bound; accumulate orchestrator-side.
  if (event?.messages) {
    loop.tokensUsed = (loop.tokensUsed ?? 0) + sumNewAssistantTokens(event.messages as unknown[], countedLoopTokenMessages);
  }
  const metricless = !loop.measureCmd;
  const value = metricless ? null : await runMeasure(ctx, loop.measureCmd!);
  // Hypothesis line (pi-autoresearch's good idea): the agent's stated intent
  // for the turn goes into the ledger, making loop history auditable.
  let hypothesis: string | undefined;
  let lastAssistantText = "";
  if (event) {
    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    lastAssistantText = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    hypothesis = lastAssistantText.match(/^HYPOTHESIS:\s*(.+)$/m)?.[1]?.trim().slice(0, 200);
  }
  // v0.24.0 anti-repetition: roll the behavior windows, then classify. The
  // plateau stop watches the NUMBER; this watches the WORK — a metricless
  // loop (no number) has no other defense against doorknob-polishing.
  const toolsUsed = loop.toolsThisTurn ?? 0;
  loop.toolsThisTurn = 0;
  loop.toollessStreak = toolsUsed === 0 ? (loop.toollessStreak ?? 0) + 1 : 0;
  // v0.25.1 multi-signal stuck gate: gather the iteration's progress
  // signals BEFORE classifying — file writes (tool_result bumps), git
  // commits since the iteration began (HEAD advance), spec_item_progress
  // ledger events since the iteration began. ANY positive signal exempts
  // the iteration: stable verification from a shipping loop is the goal
  // state of a metricless loop, not the stuck state.
  const iterStartHead = loop.iterMetrics?.iterationStartHead;
  const iterStartAt = loop.iterMetrics?.iterationStartAt;
  const currentHeadRes = await runGit(ctx, ["rev-parse", "HEAD"]);
  const currentHead = currentHeadRes.ok ? currentHeadRes.stdout : undefined;
  let gitCommits = 0;
  if (iterStartHead && currentHead && iterStartHead !== currentHead) {
    const countRes = await runGit(ctx, ["rev-list", "--count", `${iterStartHead}..HEAD`]);
    const n = Number.parseInt(countRes.stdout, 10);
    if (countRes.ok && Number.isFinite(n) && n > 0) gitCommits = n;
  }
  let specItemProgress = 0;
  if (iterStartAt) {
    try {
      const ledgerPath = path.join(ctx.cwd, ".pi-glla", "active.jsonl");
      const lines = fs.readFileSync(ledgerPath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.includes("spec_item_progress")) continue;
        try {
          const entry = JSON.parse(line) as { at?: string };
          if (entry.at && entry.at >= iterStartAt) specItemProgress++;
        } catch { /* malformed line */ }
      }
    } catch { /* no ledger yet */ }
  }
  // v0.33.2: respec spec drift + checkbox progress — hash compared per
  // tick (external edits ledger spec_updated); newly checked boxes emit
  // the spec_item_progress signal the stuck gate already consumes (it was
  // consumed-but-never-emitted until now).
  if (loop.specFile) {
    const hash = specFileHash(loop.specFile);
    if (hash && loop.specHash && loop.specHash !== hash) {
      appendLedger(ctx.cwd, "spec_updated", { via: "external", iteration: loop.iteration });
      ctx.ui.notify("Spec file changed mid-loop — drift ledgered (spec_updated).", "info");
    }
    if (hash) loop.specHash = hash;
    const checked = countCheckedSpecItems(loop.specFile);
    if (checked !== null && loop.specChecked !== undefined && checked > loop.specChecked) {
      appendLedger(ctx.cwd, "spec_item_progress", { iteration: loop.iteration, newlyChecked: checked - loop.specChecked, totalChecked: checked });
    }
    if (checked !== null) loop.specChecked = checked;
  }
  const iterSignals = {
    fileWrites: loop.iterMetrics?.fileWrites ?? 0,
    gitCommits,
    specItemProgress,
    currentHead,
  };
  const previousText = loop.recentTexts && loop.recentTexts.length > 0 ? loop.recentTexts[loop.recentTexts.length - 1] : undefined;
  if (lastAssistantText) {
    loop.recentPrints = pushRepetitionCapped(loop.recentPrints ?? [], textFingerprint(lastAssistantText), REPETITION.printWindow);
    loop.recentTexts = pushRepetitionCapped(loop.recentTexts ?? [], lastAssistantText, REPETITION.textWindow);
  }
  const stuckReason = isActuallyStuck({
    assistantText: lastAssistantText,
    recentPrints: loop.recentPrints ?? [],
    previousText,
    recentToolResults: loop.recentToolResults ?? [],
    toollessStreak: loop.toollessStreak ?? 0,
    fileWriteCount: iterSignals.fileWrites,
    gitCommitCount: iterSignals.gitCommits,
    specItemProgressCount: iterSignals.specItemProgress,
  }, loop.toolSameRepeat);
  // Reset the accumulators so the NEXT iteration measures only itself.
  loop.iterMetrics = {
    fileWrites: 0,
    iterationStartHead: iterSignals.currentHead ?? loop.iterMetrics?.iterationStartHead,
    iterationStartAt: nowIso(),
  };
  if (stuckReason) {
    loop.consecutiveStuck = (loop.consecutiveStuck ?? 0) + 1;
    loop.lastStuckReason = stuckReason;
    appendLedger(ctx.cwd, "loop_stuck", { iteration: loop.iteration, reason: stuckReason, consecutive: loop.consecutiveStuck });
    if (loop.consecutiveStuck === 1 || loop.consecutiveStuck >= REPETITION.hardResetAfter) {
      ctx.ui.notify(`Loop stuck (${loop.consecutiveStuck}×): ${stuckReason}`, "warning");
    }
  } else {
    loop.consecutiveStuck = 0;
    loop.lastStuckReason = undefined;
  }
  let outcome: LoopTickOutcome = metricless ? applyMetriclessTick(loop, nowIso()) : applyMeasurement(loop, value, nowIso());
  // v0.33.2: close the hypothesis feedback loop — the prediction went into
  // the ledger; now the VERDICT rides the next iteration's prompt.
  if (loop.lastHypothesis) {
    const h = loop.history;
    const cur = h.length >= 1 ? h[h.length - 1]!.value : null;
    const prev = h.length >= 2 ? h[h.length - 2]!.value : null;
    if (metricless || cur === null) {
      loop.hypothesisFeedback = `Last iteration you predicted: "${loop.lastHypothesis}". ${metricless ? "Metricless loop — no number to verify it against; say honestly whether the prediction landed." : "The measure printed no number — the prediction is unverifiable."}`;
    } else {
      const moved = prev === null
        ? `first measurement ${cur}`
        : cur === prev
          ? `flat at ${cur}`
          : loop.direction === "min"
            ? (cur < prev ? `improved ${prev} → ${cur}` : `regressed ${prev} → ${cur}`)
            : (cur > prev ? `improved ${prev} → ${cur}` : `regressed ${prev} → ${cur}`);
      loop.hypothesisFeedback = `Last iteration you predicted: "${loop.lastHypothesis}". Result: metric ${moved} (best ${loop.bestValue}).`;
    }
  }
  loop.lastHypothesis = hypothesis;
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_measured", {
    iteration: loop.iteration,
    value,
    best: loop.bestValue,
    stall: loop.stallCount,
    hypothesis,
    stuck: stuckReason,
  });
  // branch=1 mode: commit improvements, hard-reset regressions — always and
  // only on the scratch branch. v0.23.0: a metricless loop has no regression
  // signal, so every iteration stands and is committed.
  if (loop.branchName && outcome.kind === "continue") {
    if (metricless || outcome.improved) {
      await runGit(ctx, ["add", "-A"]);
      const committed = await runGit(ctx, ["commit", "-m", metricless ? `pi-glla-loop: iteration ${loop.iteration}` : `pi-glla-loop: iteration ${loop.iteration} (${loop.direction}=${loop.bestValue})`]);
      appendLedger(ctx.cwd, "loop_git", { action: "commit", iteration: loop.iteration, ok: committed.ok });
    } else {
      const reset = await runGit(ctx, ["reset", "--hard", "HEAD"]);
      appendLedger(ctx.cwd, "loop_git", { action: "reset", iteration: loop.iteration, ok: reset.ok });
    }
    persistState(ctx);
  }
  // v0.24.0: the top of the stuck ladder — bounded and surfaced, same
  // philosophy as a plateau stop. The loop ends WITH the reason, not in silence.
  // v0.25.0: aggressiveMode raises the ladder (default 5 → 10, explicit wins).
  const maxStuckInterventions = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).stuckMaxInterventions;
  if (outcome.kind !== "stop" && (loop.consecutiveStuck ?? 0) >= maxStuckInterventions) {
    loop.active = false;
    loop.stopReason = `stuck — ${loop.lastStuckReason} (${loop.consecutiveStuck} consecutive interventions)`;
    persistState(ctx);
    await finishLoopGit(ctx, loop);
    ctx.ui.notify(`Loop stopped: ${loop.stopReason}. ${loop.history.length} iterations recorded.`, "warning");
    appendLedger(ctx.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${loop.stopReason}`);
    return;
  }
  if (outcome.kind === "stop") {
    // v0.29.19: an audit loop's plateau is only honest when the well is
    // ACTUALLY dry. Plateauing with open findings means the agent fumbled
    // (or the provider ate) N turns — not "nothing left" (field: hegemon
    // stopped at best 74 with 13 OPEN boxes; polis at best 46 with 3+).
    // Stand the stop down with a strategy shove — bounded: the plateau
    // after the last reprieve stops with an honest blocked-named reason.
    if (loop.kind === "audit" && outcome.reason.startsWith("plateau —")) {
      const open = countOpenAuditFindings(ctx.cwd);
      if (open > 0) {
        const reprieves = (loop.auditPlateauReprieves ?? 0) + 1;
        if (reprieves <= AUDIT_PLATEAU_MAX_REPRIEVES) {
          loop.active = true;
          loop.stopReason = undefined;
          loop.stallCount = 0;
          loop.auditPlateauReprieves = reprieves;
          const topFinding = topOpenAuditFinding(ctx.cwd); // v0.33.2: name what to close, not just the count
          loop.auditReprieveNote = `PLATEAU REPRIEVE (${reprieves}/${AUDIT_PLATEAU_MAX_REPRIEVES}): ${open} finding(s) still OPEN in ${AUDIT_FINDINGS_REL} — the plateau stop does not fire while the well isn't dry. Stop hunting and stop narrating: pick the smallest OPEN finding and CLOSE it this iteration (fix commit + checked box).${topFinding ? ` Top open: ${topFinding}` : ""} ${AUDIT_PLATEAU_MAX_REPRIEVES - reprieves} reprieve(s) remain.`;
          persistState(ctx);
          appendLedger(ctx.cwd, "audit_plateau_reprieve", { open, reprieves, best: loop.bestValue });
          ctx.ui.notify(`Audit loop plateau reprieve (${reprieves}/${AUDIT_PLATEAU_MAX_REPRIEVES}): ${open} open findings — the well isn't dry, continuing.`, "info");
          scheduleLoopTick(ctx);
          return;
        }
        const honest = `plateau — no closure in ${loop.plateauWindow}×${reprieves} iterations despite ${open} open findings (treat as blocked; /loop resume to push again)`;
        loop.stopReason = honest;
        persistState(ctx);
        outcome = { kind: "stop", reason: honest };
      }
    }
    await finishLoopGit(ctx, loop);
    ctx.ui.notify(`Loop stopped: ${outcome.reason}. ${loop.history.length} iterations recorded.`, "info");
    appendLedger(ctx.cwd, "loop_stopped", { reason: outcome.reason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${outcome.reason}`);
    return;
  }
  scheduleLoopTick(ctx);
}

/** On loop stop (any reason): return to the original branch, tell the user
 * where the work lives and how to merge it. Scratch branch is never deleted. */
async function finishLoopGit(ctx: ExtensionContext, loop: LoopState): Promise<void> {
  if (!loop.branchName) return;
  // Uncommitted remnants (final stalled iterations were reset already, but be safe).
  await runGit(ctx, ["reset", "--hard", "HEAD"]);
  if (loop.originalBranch) {
    await runGit(ctx, ["checkout", loop.originalBranch]);
  }
  ctx.ui.notify(
    `Loop work is on branch ${loop.branchName} (${loop.iteration} iterations, best ${loop.bestValue ?? "n/a"}).\nMerge with: git merge ${loop.branchName} — or delete with: git branch -D ${loop.branchName}`,
    "info",
  );
  appendLedger(ctx.cwd, "loop_git", { action: "finish", branch: loop.branchName, returnedTo: loop.originalBranch });
}

interface LoopConfig {
  target: string;
  /** Empty string = metricless spec loop (v0.23.0). */
  measureCmd: string;
  direction?: "min" | "max";
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force?: boolean;
  timeLimitHours?: number;
  tokenBudget?: number;
  /** v0.25.1: /loop start toolsamerepeat=N (0 = disable legacy check). */
  toolSameRepeat?: number;
  /** v0.29.10: don't seed bestValue from the pre-work baseline measure —
   * the first REAL measurement becomes the baseline. For loops whose
   * metric is created BY the first iteration (the audit loop: 0 open
   * findings just means findings.md doesn't exist yet); a seeded 0 pins
   * best at a value no iteration can beat, stalling every iteration. */
  deferBaseline?: boolean;
  /** v0.29.10: audit loops get audit-flavoured regression wording. */
  kind?: "audit";
  /** v0.33.2: respec loops carry their spec file (drift detection,
   * checkbox progress, refine specText writes). */
  specFile?: string;
}

/** Shared loop-start path: /loop start AND propose_loop_draft (after Confirm). */
async function startLoopFromConfig(ctx: ExtensionContext, cfg: LoopConfig): Promise<boolean> {
  // branch=1 mode: scratch branch ONLY. Refuse on non-git or dirty tree —
  // we never mix uncommitted user work into the loop's branch.
  let branchName: string | undefined;
  let originalBranch: string | undefined;
  if (cfg.branch) {
    const isRepo = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.ok) {
      ctx.ui.notify("branch=1 requires a git repository.", "warning");
      return false;
    }
    const dirty = await runGit(ctx, ["status", "--porcelain"]);
    if (!dirty.ok || dirty.stdout.length > 0) {
      ctx.ui.notify("branch=1 requires a clean working tree — commit or stash your changes first.", "warning");
      return false;
    }
    const current = await runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    originalBranch = current.ok ? current.stdout : undefined;
    branchName = loopBranchName(nowIso(), cfg.target);
    const created = await runGit(ctx, ["checkout", "-b", branchName]);
    if (!created.ok) {
      ctx.ui.notify(`Failed to create scratch branch ${branchName}.`, "warning");
      return false;
    }
  }
  // Baseline measurement before the first agent turn. A measure that
  // produces no number is a footgun: without a baseline the loop burns stall
  // iterations before plateau stops it. Refuse fast (force=1 overrides for
  // measures that only work after the agent builds something first).
  // v0.23.0: metricless loops skip the baseline entirely — there is no
  // measure to run, and no plateau to protect.
  const metricless = !cfg.measureCmd;
  const baseline = metricless || cfg.deferBaseline ? null : await runMeasure(ctx, cfg.measureCmd);
  if (!metricless && !cfg.deferBaseline && baseline === null && !(cfg as { force?: boolean }).force) {
    ctx.ui.notify(
      `/loop start refused: the measure produced no number.\nCommand: ${cfg.measureCmd}\nFix it so it prints exactly one number, or re-run with force=1 if it only works after the agent builds something first.\n(Non-numeric goal — research, docs, features? Use /goal: the independent auditor verifies semantically. /loop only believes a number.)`,
      "warning",
    );
    return false;
  }
  resolveCarryover(ctx, "loop"); // v0.28.14: surface/clear stale leftovers
  state = {
    ...state,
    loop: {
      target: cfg.target,
      measureCmd: cfg.measureCmd || undefined,
      direction: cfg.direction,
      iteration: 0,
      maxIterations: cfg.maxIterations,
      plateauWindow: cfg.plateauWindow,
      stallCount: 0,
      bestValue: cfg.deferBaseline ? null : baseline,
      lastValue: cfg.deferBaseline ? null : baseline,
      kind: cfg.kind,
      active: true,
      history: [],
      startedAt: nowIso(),
      timeLimitHours: cfg.timeLimitHours,
      tokenBudget: cfg.tokenBudget,
      tokensUsed: 0,
      branchName,
      originalBranch,
      toolSameRepeat: cfg.toolSameRepeat,
      specFile: cfg.specFile,
      specHash: cfg.specFile ? specFileHash(cfg.specFile) ?? undefined : undefined,
      specChecked: cfg.specFile ? countCheckedSpecItems(cfg.specFile) ?? undefined : undefined,
      iterMetrics: { fileWrites: 0, iterationStartAt: nowIso() },
    },
  };
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_started", { target: cfg.target, measureCmd: cfg.measureCmd || "none", direction: cfg.direction ?? "none", baseline, branch: branchName, timeLimitHours: cfg.timeLimitHours, tokenBudget: cfg.tokenBudget });
  ctx.ui.notify(
    metricless
      ? `Loop started (metricless spec loop — NO plateau stop): ${cfg.target.slice(0, 60)}\nEnds only at ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations} iterations` : "no iteration cap"}${cfg.timeLimitHours ? ` · ${cfg.timeLimitHours}h` : ""}${cfg.tokenBudget ? ` · ${cfg.tokenBudget.toLocaleString()} tokens` : ""} · /loop stop. Every iteration must make ONE real, inspectable change — cosmetic churn is the doorknob failure.` +
        (branchName ? `\nbranch mode: committing each iteration to ${branchName}` : "")
      : `Loop started: ${cfg.target.slice(0, 60)}\nBaseline: ${cfg.deferBaseline ? "deferred — the first real measurement seeds it" : (baseline ?? "(forced without a number — first turn must produce one)")} · direction ${cfg.direction} · window ${cfg.plateauWindow} · ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations}` : "no iteration cap"}` +
        (branchName ? `\nbranch mode: committing improvements to ${branchName}` : ""),
    "info",
  );
  scheduleLoopTick(ctx);
  return true;
}

async function cmdLoop(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (!sub || sub === "resume") {
    // /loop with no args (or /loop resume, v0.28.22) → resume a held loop
    // if one is waiting; otherwise draft the loop config (metric design is
    // the whole game for a long-running loop; never start one blind).
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
      return;
    }
    const stored = state.loop;
    // v0.29.20: plain plateau stops are resumable too — pre-gate plateaus
    // could be false (hegemon/polis stopped 2026-07-31 with open findings
    // on 429-dead turns), and an explicit resume is the user's call; the
    // v0.29.19 gate + re-armed counters make the resumed run honest.
    const RESUMABLE_STOP = (r?: string): boolean =>
      r === HELD_ON_RESTORE ||
      !!r?.startsWith("provider errors —") ||
      !!r?.startsWith("stopped by user —") ||
      !!r?.startsWith("plateau —") ||
      !!r?.startsWith("stuck —");
    if (stored && !stored.active && RESUMABLE_STOP(stored.stopReason)) {
      // v0.28.14: one-active-thing — a held loop must not resume over an
      // active goal/list-item (this was the last unguarded stacking path).
      if (state.goal && state.goal.status === "active") {
        ctx.ui.notify("A goal is active — the held loop stays held. /goal pause or /goal cancel it first, then /loop resume.", "warning");
        return;
      }
      // An explicit resume re-arms the counters: fresh stall window,
      // cleared dead-turn/stuck streaks, reprieves restored — the user
      // saying "push again" wins over the ladder's memory (v0.29.19).
      state.loop = { ...stored, active: true, stopReason: undefined, consecutiveErrors: 0, consecutiveStuck: 0, lastStuckReason: undefined, stallCount: 0, auditPlateauReprieves: 0 };
      persistState(ctx);
      scheduleLoopTick(ctx);
      ctx.ui.notify(
        `Loop resumed: iteration ${stored.iteration}/${stored.maxIterations > 0 ? stored.maxIterations : "∞"} · best ${stored.bestValue ?? "n/a"} — ${stored.target.slice(0, 60)}`,
        "info",
      );
      return;
    }
    if (sub === "resume") {
      ctx.ui.notify("No held loop to resume. /loop to draft one, or /loop start \"<target>\" for an infinite metricless loop.", "info");
      return;
    }
    await startDrafting(ctx, "loop");
    return;
  }

  if (sub === "status") {
    const loop = state.loop;
    if (!loop) {
      ctx.ui.notify("No loop. /loop to draft one, /loop start \"<target>\" for an infinite metricless loop, or add measure=\"<cmd>\" direction=min|max for a metric loop [window=5] [max=50] [time=<hours>] [tokens=<budget>]", "info");
      return;
    }
    const lines = [
      `Loop: ${loop.active ? "active" : "stopped"} — ${loop.target.slice(0, 80)}`,
      `Metric: ${loop.measureCmd ? `${loop.measureCmd} (${loop.direction})` : "none — metricless spec loop (no plateau)"}`,
      `Iteration ${loop.iteration}/${loop.maxIterations > 0 ? loop.maxIterations : "∞"} · best ${loop.bestValue ?? "n/a"} · last ${loop.lastValue ?? "n/a"} · stall ${loop.stallCount}/${loop.plateauWindow}`,
    ];
    const bounds: string[] = [];
    if (loop.timeLimitHours !== undefined) bounds.push(`time ≤ ${loop.timeLimitHours}h`);
    if (loop.tokenBudget !== undefined) bounds.push(`tokens ${(loop.tokensUsed ?? 0).toLocaleString()}/${loop.tokenBudget.toLocaleString()}`);
    if (bounds.length) lines.push(`Bounds: ${bounds.join(" · ")}`);
    if (loop.refinements?.length) lines.push(`Spec refined ${loop.refinements.length}× (latest: iteration ${loop.refinements[loop.refinements.length - 1]!.iteration})`);
    if (loop.stopReason) lines.push(`Stopped: ${loop.stopReason}`);
    const tail = loop.history.slice(-5);
    if (tail.length > 0) {
      lines.push("Recent: " + tail.map((h) => `${h.value ?? "ERR"}${h.improved ? "↑" : ""}`).join(" "));
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (sub === "start") {
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify("A goal is active — /goal cancel or /goal pause it before starting a loop.", "warning");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    let cfg;
    try {
      cfg = parseLoopStartArgs(rest);
    } catch (err) {
      ctx.ui.notify(
        `/loop start: ${err instanceof Error ? err.message : String(err)}\n(Non-numeric goal — research, docs, features? Use /goal: the auditor verifies semantically. /loop only believes a number. Or /loop with no args to draft.)`,
        "warning",
      );
      return;
    }
    await startLoopFromConfig(ctx, cfg);
    return;
  }

  // v0.28.14: /loop cancel is a first-class alias — users reached for
  // /goal cancel to kill loops because "cancel" is the verb they know.
  if (sub === "refine" || sub === "polish") {
    // v0.33.2: the operator's respec verb. The refine flow stays
    // agent-proposed + user-confirmed (propose_loop_refine) — this command
    // queues the operator's suggestion into the next iteration's prompt.
    // ("polish" accepted as an alias: the widget footer advertised it
    // before the command existed — now it does.)
    if (!isLoopActive()) {
      ctx.ui.notify("No active loop to refine — /loop start first.", "warning");
      return;
    }
    const hint = rest.trim();
    if (!hint) {
      ctx.ui.notify("Usage: /loop refine <what the spec should capture better> — the suggestion rides the next iteration's prompt; the agent proposes via propose_loop_refine and you confirm.", "info");
      return;
    }
    state.loop!.refineHint = hint.slice(0, 300);
    persistState(ctx);
    appendLedger(ctx.cwd, "loop_refine_hint", { iteration: state.loop!.iteration, hint: state.loop!.refineHint });
    ctx.ui.notify("Refine hint queued — it rides the next iteration's prompt.", "info");
    return;
  }

  if (sub === "stop" || sub === "cancel") {
    if (!state.loop) {
      ctx.ui.notify("No loop to stop.", "info");
      return;
    }
    clearLoopTimer();
    state.loop = { ...state.loop, active: false, stopReason: state.loop.stopReason ?? `stopped by user (/loop ${sub})` };
    persistState(ctx);
    await finishLoopGit(ctx, state.loop);
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user", iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop stopped after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop stopped by user after ${state.loop.iteration} iterations (best: ${state.loop.bestValue ?? "n/a"})`);
    return;
  }

  // v0.25.1: a CLEAN end — "completed: <reason>", distinct from
  // stuck/plateau/stopped-by-user. Additive: /loop stop is untouched.
  if (sub === "finish") {
    if (!state.loop) {
      ctx.ui.notify("No loop to finish.", "info");
      return;
    }
    clearLoopTimer();
    const reason = loopFinishStopReason(rest);
    state.loop = { ...state.loop, active: false, stopReason: reason };
    persistState(ctx);
    await finishLoopGit(ctx, state.loop);
    appendLedger(ctx.cwd, "loop_stopped", { reason, iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop finished (${reason}) after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop finished: ${reason}`);
    return;
  }

  if (sub === "audit") {
    // v0.29.0: the project-audit loop (user design: "the looper running
    // audits to see where to progress and what to fix — the thing that
    // fires at the end of goals and lists"). Unlike respec this is a
    // METRIC loop: the orchestrator counts CLOSED findings every iteration,
    // direction=max (v0.29.14 — open-count/min punished discovery), and the
    // plateau stop is the termination — no fixes landing for the window =
    // the well is dry. User typed the command = the act (same auto-start
    // rule as respec).
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify("A goal is active — /goal cancel or /goal pause it before starting a loop.", "warning");
      return;
    }
    // v0.31.1: a paused/active one-shot audit goal + this loop = two stacked
    // audit initiatives (junk-runner 2026-07-31: the held one-shot read as
    // "stalled" for 8h while the loop did all the work — the agent conflated
    // them and proposed completing the goal for the loop's work). Warn, name
    // the supersession, don't block — the user's agency, the user's call.
    if (state.goal && state.goal.objective.includes(GOAL_AUDIT_ONESHOT_MARKER)) {
      appendLedger(ctx.cwd, "audit_stack_warn", { have: "goal", starting: "loop", goalStatus: state.goal.status });
      ctx.ui.notify(
        `Heads up: a ${state.goal.status} one-shot audit goal exists in this session — the audit loop SUPERSEDES it (one pass + fixes IS the loop's job). /goal cancel clears it; one audit initiative per session.`,
        "warning",
      );
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    await startLoopFromConfig(ctx, {
      target: auditTarget(),
      measureCmd: auditMeasureCmd(),
      direction: "max",
      plateauWindow: LOOP_DEFAULTS.plateauWindow,
      maxIterations: 0,
      branch: false,
      force: false,
      // v0.29.10: the audit loop's metric is CREATED by iteration 1 —
      // seeding best from the pre-discovery 0 stalls every iteration and
      // plateau-stops mid-work at the window. Defer the baseline.
      deferBaseline: true,
      kind: "audit",
    });
    return;
  }

  if (sub === "respec") {
    // v0.24.3: reconcile the codebase against the root spec, forever.
    // Same auto-start path as /loop start (the user typed the command —
    // that IS the act); metricless + unbounded by design. No limit-nagging:
    // bounds exist on /loop start for whoever wants them.
    if (state.goal && state.goal.status === "active") {
      ctx.ui.notify("A goal is active — /goal cancel or /goal pause it before starting a loop.", "warning");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active. /loop stop first.", "warning");
      return;
    }
    const specs = resolveSpecFiles(ctx.cwd);
    if (specs.length === 0) {
      // No spec → the target is undetermined; grill instead of dead-ending
      // on an error (v0.24.4).
      ctx.ui.notify("No SPEC.md / spec.md in the project root — drafting the loop target with you (or bootstrap a spec first).", "info");
      await startDrafting(
        ctx,
        "loop",
        "reconcile the codebase against the project spec — but NO SPEC.md / spec.md exists in the root. Grill the user: should the first work be bootstrapping a SPEC.md from the current code (then reconcile against it), or is the reconciliation target better stated in prose? Challenge vague answers.",
      );
      return;
    }
    let specPath = specs[0]!;
    if (specs.length > 1) {
      // Two specs = ambiguous — never silently pick (v0.24.4). One
      // slash-bar select, plus a nudge to consolidate.
      const names = specs.map((p) => path.basename(p));
      const choice = await ctx.ui.select(
        "Both SPEC.md and spec.md exist in the root — which one is the spec?",
        names,
      );
      if (choice === undefined) {
        ctx.ui.notify("respec cancelled.", "info");
        return;
      }
      specPath = specs[names.indexOf(choice)]!;
      ctx.ui.notify(
        `Using ${path.basename(specPath)} as the spec. Both files exist — worth consolidating; the loop treats only ${path.basename(specPath)} as the spec.`,
        "info",
      );
    }
    const target = respecTarget(path.basename(specPath));
    await startLoopFromConfig(ctx, {
      target,
      measureCmd: "",
      direction: undefined,
      plateauWindow: LOOP_DEFAULTS.plateauWindow,
      maxIterations: 0,
      branch: false,
      force: false,
      specFile: specPath, // v0.33.2
    });
    return;
  }

  // Anything else is a natural-language target (v0.22.4): draft it — the
  // metric is the whole game for a loop, and /loop start with full params
  // is the skip-drafting path. Previously this fell through to a usage
  // line, so "/loop make the tests faster" did nothing useful.
  if (isLoopActive()) {
    ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
    return;
  }
  await startDrafting(ctx, "loop", args.trim());
}

// =================================================================
// Tools exposed to the agent
// =================================================================

function registerAgentTools(pi: any, ctx: ExtensionContext): void {
  pi.registerTool(defineTool({
    name: "complete_goal",
    label: "Complete goal",
    description: "Mark the active goal as complete. Spawns an isolated auditor to verify. Use only when the objective is genuinely satisfied.",
    parameters: Type.Object({
      completionSummary: Type.Optional(Type.String({ description: "1-paragraph completion claim" })),
      verificationSummary: Type.Optional(Type.String({ description: "Per-item evidence for the verification contract" })),
      newObjective: Type.Optional(Type.String({ description: "v0.25.0 (contract item 15): when the work has legitimately shifted, pass the new objective here — it atomically replaces the goal objective AND the audit proceeds against the NEW objective in this same call. Do not use to dodge a legitimate disapproval; the auditor sees the change." })),
    }),
    async execute(_id, params, signal, _onUpdate, execCtx) {
      const foreign0 = foreignToolGuard(execCtx);
      if (foreign0) return { content: [{ type: "text", text: foreign0 }], details: {} };
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal." }], details: {} };
      }
      const p = params as { completionSummary?: string; verificationSummary?: string; newObjective?: string };
      // v0.25.0 (contract item 15): atomic objective update + audit in one
      // call — the objective-drift disapprove loop (ship shifted work →
      // auditor disapproves the ORIGINAL objective) ends here. Ledgered so
      // the shift is auditable.
      if (p.newObjective?.trim()) {
        const oldObjective = state.goal.objective;
        const { objective: cleanObj, verificationContract } = extractVerificationContract(p.newObjective.trim());
        updateGoal({ objective: cleanObj, ...(verificationContract ? { verificationContract } : {}) }, ctx);
        appendLedger(ctx.cwd, "goal_tweaked", { via: "complete_goal.newObjective", from: oldObjective.slice(0, 200), to: cleanObj.slice(0, 200) });
        ctx.ui.notify(`Objective updated (complete_goal newObjective): ${cleanObj.slice(0, 80)}`, "info");
      }
      updateGoal({ status: "auditing", pendingTasks: undefined }, ctx);
      const settings = loadSettings(ctx.cwd);
      const { model: auditorModel, error: modelError, via } = resolveAuditorModel(ctx, settings.auditorModel, settings.auditorModelFallback, settings.auditorSameSessionSwap !== false);
      if (modelError) {
        ctx.ui.notify(`Auditor model issue: ${modelError}`, "warning");
      }
      ctx.ui.notify(`Auditor running (isolated session, model: ${via ?? "setting"})…`, "info");
      // Esc during the audit aborts this tool's signal → threaded into the
      // auditor session, which aborts cleanly and returns "Auditor aborted."
      latestAuditProgress = { label: "starting", lastEventAt: Date.now() };
      const runAudit = () =>
        runGoalCompletionAuditor({
          ctx,
          goal: state.goal!,
          completionSummary: p.completionSummary,
          verificationSummary: p.verificationSummary,
          model: auditorModel,
          thinkingLevel: (settings.auditorThinkingLevel ?? "high") as any, // may be "max" — pi ≥0.83 understands it; the dev-types predate it
          signal: signal ?? undefined,
          onProgress: (progress) => {
            latestAuditProgress = {
              currentTool: progress.currentTool,
              label: progress.label,
              elapsedMs: progress.elapsedMs,
              lastEventAt: Date.now(),
            };
            refreshUI(ctx);
          },
        });
      // v0.25.4 (post-audit fix): a retriable infra failure (stream error,
      // auth blip — NOT user abort, NOT missing model) gets ONE automatic
      // retry with backoff before we report "auditor infrastructure error
      // (retried once)". Neither attempt is a verdict on the work.
      const auditStartMs = Date.now();
      completionAuditInFlight = true;
      let result: Awaited<ReturnType<typeof runAudit>>;
      let retriedOnce = false;
      try {
        ({ result, retriedOnce } = await runWithInfraRetry(runAudit, {
          onRetry: (err) => {
            latestAuditProgress = { label: `infra error (${err.slice(0, 40)}) — retrying once`, lastEventAt: Date.now() };
            refreshUI(ctx);
            appendLedger(ctx.cwd, "audit_infra_retry", { goalId: state.goal?.id, error: err.slice(0, 200) });
          },
        }));
      } finally {
        completionAuditInFlight = false;
      }
      const auditDurationMs = Date.now() - auditStartMs;
      latestAuditProgress = null;
      // Audit history: record REAL verdicts only — a non-empty report is the
      // evidence the auditor actually inspected something. Empty-report runs
      // (abort, auth failure, no model) are surfaced via pauseReason, not
      // logged as disapprovals.
      const auditorRan = result.output.trim().length > 0;
      // v0.28.5 (E2): a REAL auditor run clears the infra-error streak.
      // v0.34.14: …but only a CLEAN one. A STALLED run returns the partial
      // output it streamed before the abort — non-empty, so auditorRan is
      // true — while result.error still marks it an infrastructure failure.
      // Clearing the streak on those meant the 3-strike breaker at :3874
      // NEVER engaged: pully 2026-08-01 looped 10-min stall cycles for 4h
      // (the auditor hung on an ssh/sudo verification every attempt).
      if (auditorRan && !result.error && (state.goal.auditInfraStreak ?? 0) > 0) updateGoal({ auditInfraStreak: undefined }, ctx);
      const history = state.goal.auditHistory ?? [];
      if (auditorRan) {
        // v0.25.4: strip think-block leakage (MiniMax-M3 `</think>`
        // fragments + reasoning spillover) before anything stores or
        // displays the report.
        const cleanOutput = stripThinkBlocks(result.output);
        result.output = cleanOutput;
        history.push({
          at: nowIso(),
          approved: result.approved,
          disapproved: result.disapproved,
          impossible: result.impossible,
          impossibleReason: result.impossibleReason,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          report: cleanOutput,
          error: result.error,
          regressionShieldPassed: result.regressionShieldPassed,
          regressionShieldMissing: result.regressionShieldMissing,
          durationMs: auditDurationMs,
        } as any);
        // Cap history — 39 infra errors taught us unbounded growth is real.
        if (history.length > 20) history.splice(0, history.length - 20);
        // v0.25.4: durable append-only audit log — survives state-snapshot
        // rotation; the review surface for "where are we weak".
        const verdict: AuditLogEntry["verdict"] =
          result.error && !result.approved && !result.disapproved
            ? "error"
            : result.approved && result.regressionShieldPassed === false
              ? "shield_blocked"
              : result.approved
                ? "approved"
                : result.impossible
                  ? "impossible"
                  : "disapproved";
        appendAuditLog(ctx.cwd, {
          at: nowIso(),
          goalId: state.goal.id,
          objective: state.goal.objective.slice(0, 200),
          verdict,
          model: result.model,
          thinkingLevel: result.thinkingLevel ?? "(default)",
          report: cleanOutput,
          impossibleReason: result.impossibleReason,
          error: result.error,
          durationMs: auditDurationMs,
          retriedOnce,
        } as AuditLogEntry);
      }

      // Escape hatch: the user aborted the audit (Esc). Offer the explicit
      // choice — complete WITHOUT audit, or keep working. (pi-goal-x parity.)
      if (result.error === "Auditor aborted.") {
        updateGoal({ status: "active", auditHistory: history, pauseReason: "audit aborted by user (Esc)" }, ctx);
        let completeAnyway = false;
        try {
          completeAnyway = await ctx.ui.confirm(
            "Audit aborted",
            "You aborted the auditor (Escape).\n\nYes = mark the goal COMPLETE WITHOUT AUDIT (you take responsibility for verification).\nNo = continue working; the auditor will verify on the next complete_goal.",
          );
        } catch {
          completeAnyway = false;
        }
        if (completeAnyway) {
          updateGoal({ auditHistory: history }, ctx);
          archiveCurrentGoal(ctx, "complete", "completed without audit (user choice after Esc)");
          return { content: [{ type: "text", text: "Goal marked complete without audit (user choice)." }], details: {} };
        }
        scheduleContinuation(ctx, true);
        return {
          content: [{ type: "text", text: "Audit aborted; continuing. Call complete_goal again when ready — the auditor will re-run." }],
          details: {},
        };
      }

      if (result.approved) {
        updateGoal({ auditHistory: history }, ctx);
        const objective = state.goal.objective;
        archiveCurrentGoal(ctx, "complete", `auditor ${result.model} approved`);
        notifyExternal(ctx, `Goal complete (auditor approved): ${objective.slice(0, 120)}`);
        return { content: [{ type: "text", text: `Goal approved by auditor ${result.model}.` }], details: {} };
      }

      // IMPOSSIBLE (v0.24.2, Claude-Code lesson): the auditor's escape hatch
      // for goals that can NEVER be satisfied as stated. Not a disapproval —
      // continuing would burn tokens on a provably unwinnable objective.
      // Bounded and surfaced: the goal pauses and the user decides.
      if (result.impossible) {
        const reason = result.impossibleReason || "(no reason given)";
        // v0.25.0 (contract item 23): under aggressiveMode, a PARTIAL
        // impossible (some items can't ship) keeps the loop going — the
        // agent narrows to the remainder. A FULL impossible still pauses:
        // auto-resuming a provably unwinnable objective just burns tokens.
        const effectiveImp = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd));
        if (effectiveImp.aggressiveMode && classifyImpossibleReason(reason) === "partial") {
          updateGoal({
            status: "active",
            auditHistory: history,
            pauseReason: `auditor verdict: IMPOSSIBLE (partial) — ${reason}`,
            pauseSuggestedAction: "Narrow the objective past the impossible part (complete_goal newObjective or /goal tweak) and continue",
          }, ctx);
          ctx.ui.notify(`Auditor: part of the goal is IMPOSSIBLE — ${reason.slice(0, 100)}. aggressiveMode: narrowing and continuing.`, "warning");
          appendLedger(ctx.cwd, "impossible_partial_continue", { reason: reason.slice(0, 200) });
          scheduleContinuation(ctx, true);
          return {
            content: [{
              type: "text",
              text: `The auditor says PART of this goal can never be satisfied: ${reason}\n\naggressiveMode is ON, so the goal stays ACTIVE. Do NOT keep attempting the impossible part. Narrow the objective to the remaining shippable items — pass newObjective to complete_goal at completion time (or pause_goal proposing /goal tweak if the narrowing needs the user's call) — and continue working the rest now.`,
            }],
            details: {},
          };
        }
        updateGoal({
          status: "paused",
          auditHistory: history,
          pauseKind: "decision",
          pauseOptions: ["Tweak the objective — /goal tweak <new text>", "Cancel the goal (/goal cancel)"],
          pauseRecommended: 1,
          pauseReason: `auditor verdict: IMPOSSIBLE — ${reason}`,
          pauseSuggestedAction: "The auditor says this goal can never be satisfied as stated. /goal tweak the objective (or /goal cancel), then /goal resume.",
        }, ctx);
        ctx.ui.notify(`Auditor: goal IMPOSSIBLE — ${reason}. Goal paused; /goal tweak or /goal cancel, then /goal resume.`, "warning");
        maybeDecisionPopup(ctx);
        appendLedger(ctx.cwd, "goal_paused", { reason: `auditor impossible: ${reason}` });
        notifyExternal(ctx, `Goal paused (auditor: impossible): ${reason.slice(0, 120)}`);
        return {
          content: [{
            type: "text",
            text: `The auditor's verdict is IMPOSSIBLE: ${reason}\n\nThis is not a disapproval — the auditor says the objective can never be satisfied as stated. The goal is now PAUSED. Do not call complete_goal again. Report the verdict to the user and suggest /goal tweak (narrow or correct the objective) or /goal cancel.`,
          }],
          details: {},
        };
      }

      // THREE-WAY SPLIT (v0.9.9): infrastructure failure is NOT a verdict.
      // The wild-caught case: 6 silent "disapprovals" that were really a dead
      // auditor model. The agent must be able to tell the difference.
      if (result.error && !result.disapproved) {
        // v0.25.0 (contract Section C): quota errors used to re-fire the
        // continuation FOREVER against a window that resets in an hour.
        // Now: pause with a one-shot scheduled retry at the upstream's own
        // Retry-After hint (default quotaRetryMinutes).
        if (isQuotaError(result.error)) {
          const settingsNow = loadSettings(ctx.cwd);
          const defaultSec = (settingsNow.quotaRetryMinutes ?? DEFAULT_QUOTA_RETRY_MINUTES) * 60;
          const quota = parseQuotaError(result.error, defaultSec);
          const retryMin = Math.max(1, Math.round(quota.retryAfterSec / 60));
          updateGoal({
            status: "paused",
            auditHistory: history,
            auditInfraStreak: undefined, // quota reached the auditor — infra streak broken
            // v0.28.26: store the claim — the quota retry re-runs the
            // auditor DIRECTLY with it (no agent turn to confuse).
            pendingCompletion: { completionSummary: p.completionSummary, verificationSummary: p.verificationSummary, at: nowIso() },
            pauseKind: "wait",
            pauseResumeAt: new Date(Date.now() + quota.retryAfterSec * 1000).toISOString(),
            pauseReason: `auditor quota: ${result.error}`,
            pauseSuggestedAction: `Quota auto-retry in ${retryMin}m — or /goal resume to retry now`,
          }, ctx);
          appendLedger(ctx.cwd, "goal_paused", { reason: `auditor quota: retry in ${quota.retryAfterSec}s (${quota.fromUpstream ? "upstream hint" : "default"})` });
          scheduleQuotaRetry(ctx, quota.retryAfterSec, result.error, () => {
            // Re-check: only auto-resume if STILL paused for the quota
            // reason (a user /goal pause during the window is not stomped).
            if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor quota:")) {
              // v0.28.26: a stored claim retries the AUDITOR directly — the
              // agent is not needed to re-submit an unchanged claim, and
              // re-engaging it produced hallucinated-closure loops.
              if (state.goal.pendingCompletion) {
                void retryStoredCompletionAudit(ctx);
                return;
              }
              updateGoal({ status: "active" }, ctx);
              appendLedger(ctx.cwd, "goal_resumed", { via: "quota-retry" });
              if (resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).aggressiveMode) {
                ctx.ui.notify("Auto-resume fired (event: auditor quota window elapsed). Continue working.", "info");
              }
              scheduleContinuation(ctx, true);
            }
          });
          return {
            content: [{
              type: "text",
              text: `The auditor hit a QUOTA / rate-limit error (infrastructure, NOT a verdict): ${result.error}\nThe goal is PAUSED with an automatic retry scheduled in ${retryMin} minute(s)${quota.fromUpstream ? " (upstream Retry-After hint)" : " (default window — /glla quotaretryminutes=N to change)"}. Your completion claim was not evaluated; do not change your deliverable for this. /goal resume retries immediately.`,
            }],
            details: {},
          };
        }
        // v0.28.5 (E2): bound the silent retry-forever. Each infra error
        // used to reschedule a continuation unconditionally — a broken
        // auditor model spun forever (the 39-error incident). At 3 trailing
        // infra errors the model is broken, not unlucky: pause LOUDLY.
        const infraStreak = (state.goal.auditInfraStreak ?? 0) + 1;
        if (infraStreak >= 3) {
          updateGoal({
            status: "paused",
            auditHistory: history,
            auditInfraStreak: infraStreak,
            pauseKind: "error",
            pauseReason: `auditor infrastructure failed ${infraStreak}× in a row — the auditor model is likely broken OR a verification command is hanging (ssh/sudo/long test runs stall the stream) (last: ${result.error.slice(0, 120)})`,
            pauseSuggestedAction: "Fix the auditor model (/glla model=provider/id) or restart pi, then /goal resume. Your work was NOT judged.",
          }, ctx);
          appendLedger(ctx.cwd, "goal_paused", { reason: `auditor infra streak ${infraStreak}: ${result.error.slice(0, 120)}` });
          ctx.ui.notify(`${goalNoun()} paused: auditor infrastructure failed ${infraStreak}× in a row — model broken or a verification command hanging (ssh/sudo/long runs). Fix with /glla model=... or unblock the command, then /goal resume.`, "warning");
          notifyExternal(ctx, `${goalNoun()} paused: auditor infrastructure ${infraStreak}× — model likely broken.`);
          return {
            content: [{
              type: "text",
              text: `The auditor has now failed ${infraStreak} times in a row with infrastructure errors (NOT verdicts; last: ${result.error}). The goal is PAUSED — the retry-forever loop stops here. Fix the auditor model with /glla model=provider/id (or restart pi), then /goal resume and call complete_goal again. Do not change your deliverable for this.`,
            }],
            details: {},
          };
        }
        updateGoal({
          status: "active",
          auditHistory: history,
          auditInfraStreak: infraStreak,
          pauseReason: `auditor infrastructure${retriedOnce ? " (retried once)" : ""}: ${result.error}`,
          pauseSuggestedAction: "Fix the auditor model (/glla model=provider/id) and call complete_goal again — your work was NOT judged",
        }, ctx);
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `The auditor could not run (infrastructure, NOT a verdict${retriedOnce ? "; retried once with backoff, both attempts failed" : ""}): ${result.error}\nYour completion claim was not evaluated. Fix the auditor model with /glla model=provider/id and call complete_goal again — do not change your deliverable for this.`,
          }],
          details: {},
        };
      }

      // Shield-blocked approval (v0.22.6): the auditor APPROVED but the
      // regression shield found contract items the evidence never
      // referenced. NOT a verdict on the work — the next audit is told
      // exactly what to quote. (The hegemon case: three genuine approvals
      // shield-blocked on vocabulary mismatches read as a "parser bug".)
      if (result.regressionShieldPassed === false && result.regressionShieldMissing && result.regressionShieldMissing.length > 0) {
        const missing = result.regressionShieldMissing;
        updateGoal({
          status: "active",
          auditHistory: history,
          pauseReason: `regression shield: auditor approved, but evidence never referenced ${missing.length} contract item(s)`,
          pauseSuggestedAction: "call complete_goal again — the next auditor run is told exactly which items to quote evidence for",
        }, ctx);
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `The auditor APPROVED, but the orchestrator's regression shield blocked completion: the report's evidence never referenced these contract items:\n${missing.map((i) => `- ${i}`).join("\n")}\n\nThis is NOT a verdict on your work — do not change your deliverable for this. Call complete_goal again; the next auditor run is explicitly told to quote raw evidence for each of these items.`,
          }],
          details: {},
        };
      }

      const noContractHint = state.goal.verificationContract?.trim()
        ? ""
        : "\n\nNote: this goal has no verification contract, so the auditor inferred done-criteria from the objective text. For sharper verdicts, /goal tweak the objective to add a 'Done when: ...' clause.";
      // v0.24.2 (Claude-Code lesson — their stop-hook blocks cap at 8): a
      // goal the auditor can NEVER approve used to re-continue forever.
      // auditCap consecutive disapprovals → pause + notify, bounded and
      // surfaced like every other stop in this stack.
      const effectiveCap = resolveEffectiveAggressiveSettings(settings);
      const auditCap = effectiveCap.auditCap;
      const configuredFeedbackChars = settings.auditFeedbackChars;
      const auditFeedbackChars = Number.isInteger(configuredFeedbackChars) && configuredFeedbackChars! >= 0
        ? configuredFeedbackChars!
        : DEFAULT_AUDIT_FEEDBACK_CHARS;
      const auditFeedback = auditFeedbackExcerpt(result.output, auditFeedbackChars);
      const auditFeedbackIsFull = auditFeedbackChars === 0 || result.output.length <= auditFeedbackChars;
      const auditFeedbackLabel = auditFeedbackIsFull
        ? "full report"
        : `last ${auditFeedbackChars} chars (Required-fixes tail)`;
      const auditFeedbackTruncationHint = auditFeedbackIsFull
        ? ""
        : `\n\nReport truncated at the configured limit. /goal status shows the full report; change future feedback with /glla auditfeedbackchars=N (0 = full report).`;
      const trailingDisapprovals = countTrailingDisapprovals(history);
      if (auditCap > 0 && trailingDisapprovals >= auditCap) {
        // v0.25.0 (contract item 22): aggressiveMode turns the cap into a
        // TODO list and keeps going — the objections become pendingTasks
        // rendered into every continuation until addressed. OFF preserves
        // the pause (contract item 24 test 2).
        if (effectiveCap.aggressiveMode) {
          const pendingTasks = extractPendingTasks(result.output, 5);
          updateGoal({
            status: "active",
            auditHistory: history,
            pendingTasks,
            pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}) — aggressiveMode: continuing with TODOs`,
          }, ctx);
          const todoBlock = pendingTasks.length > 0
            ? pendingTasks.map((t, i) => ` ${i + 1}. ${t}`).join("\n")
            : " (no discrete objections extracted — re-read the latest report in /goal status)";
          ctx.ui.notify(`Auditor disapproved ${trailingDisapprovals}× (cap). Treating as TODOs:\n${todoBlock}`, "warning");
          appendLedger(ctx.cwd, "audit_cap_keep_going", { trailingDisapprovals, auditCap, pendingTasks });
          scheduleContinuation(ctx, true);
          return {
            content: [{
              type: "text",
              text: `The auditor has disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}), but aggressiveMode is ON — the goal stays ACTIVE and the objections are now your TODO list:\n${todoBlock}\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nWork the TODOs in order. If the auditor is WRONG about an objection, follow WHEN THE AUDITOR DISAPPROVES: investigate, quote its objection, compare against what you shipped, and present the user YOUR ASSESSMENT. If the objective itself has drifted, pass newObjective to complete_goal.`,
            }],
            details: {},
          };
        }
        updateGoal({
          status: "paused",
          auditHistory: history,
          pauseKind: "decision",
          pauseOptions: ["Fix the disapproval gap, then continue (/goal resume)", "Tweak the objective — /goal tweak <new text>", "Cancel the goal (/goal cancel)"],
          pauseRecommended: 1,
          pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap})`,
          pauseSuggestedAction: "Read the audit history (/goal status), fix the actual gap or /goal tweak the objective, then /goal resume. Raise the cap with /glla auditcap=N.",
        }, ctx);
        ctx.ui.notify(`${goalNoun()} paused: auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}). /goal status for the reports; /goal resume to continue.`, "warning");
          maybeDecisionPopup(ctx);
        appendLedger(ctx.cwd, "goal_paused", { reason: `disapproval cap: ${trailingDisapprovals} consecutive (cap ${auditCap})` });
        notifyExternal(ctx, `Goal paused: ${trailingDisapprovals} consecutive auditor disapprovals`);
        return {
          content: [{
            type: "text",
            text: `The auditor has now disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}). The goal is PAUSED — continuing to re-attempt without addressing the pattern wastes tokens.\n\nBefore asking the user, INVESTIGATE:\n1. Read the audit history (the auditor's previous reports — /goal status shows them; state.goal.auditHistory holds them).\n2. Identify the SPECIFIC objections — quote them.\n3. Compare against what you actually shipped (commits, diffs, test output, screenshots).\n4. Form a clear opinion: is the auditor right, wrong, or partially right?\n5. Present the user YOUR ASSESSMENT with quoted objections and shipped evidence — not a generic menu of options.\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nDo not call complete_goal again until the pattern is addressed. /goal resume resumes; /goal tweak fixes a drifted objective.`,
          }],
          details: {},
        };
      }
      updateGoal({
        status: "active",
        auditHistory: history,
        pauseReason: "auditor disapproved",
        pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
      }, ctx);
      scheduleContinuation(ctx, true);
      return {
        content: [{
          type: "text",
          text: `Auditor disapproved. Report (${auditFeedbackLabel}):\n${auditFeedback}${auditFeedbackTruncationHint}${noContractHint}`,
        }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "pause_goal",
    label: "Pause goal",
    description: "Pause the active goal with a reason and suggested action. Use when blocked on user input or unable to make progress. When the user must CHOOSE between options, pass kind=\"decision\" with the options list (recommended = 1-based index of the best one) — decision pauses render as a prominent DECISION NEEDED card. Time-gated waits (retry at a specific time) use kind=\"wait\" with resumeAt (ISO). Operational failures use kind=\"error\". VOCABULARY (v0.28.24): decision options and reasons must reference REAL commands only — /goal resume, /goal cancel, /goal tweak \"<new text>\", /list remove N, /list next, /list resume, /loop stop, /loop resume. These all act on the ACTIVE goal/item: there is NO /goal drop and NO command takes a goal id. Never show goal ids to the user — name the thing ('the active goal', 'list item \"<short name>\"'); ids are internal plumbing the user cannot act on.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the work is paused" }),
      suggestedAction: Type.Optional(Type.String({ description: "What the user should do next" })),
      kind: Type.Optional(Type.Union([Type.Literal("decision"), Type.Literal("error"), Type.Literal("wait"), Type.Literal("blocked")], { description: "Pause class: decision (user picks an option), error (operational failure), wait (time-gated), blocked (generic)" })),
      options: Type.Optional(Type.Array(Type.String(), { description: "For kind=decision: the options the user picks between (one line each)" })),
      recommended: Type.Optional(Type.Number({ description: "For kind=decision: 1-based index of the recommended option" })),
      resumeAt: Type.Optional(Type.String({ description: "For kind=wait: ISO time the pause lifts (countdown is shown)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign1 = foreignToolGuard(execCtx);
      if (foreign1) return { content: [{ type: "text", text: foreign1 }], details: {} };
      const p = params as { reason: string; suggestedAction?: string; kind?: "decision" | "error" | "wait" | "blocked"; options?: string[]; recommended?: number; resumeAt?: string };
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      updateGoal({
        status: "paused",
        pauseReason: p.reason,
        pauseSuggestedAction: p.suggestedAction,
        pauseKind: p.kind,
        pauseOptions: p.kind === "decision" && p.options && p.options.length > 0 ? p.options : undefined,
        pauseRecommended: p.kind === "decision" && p.recommended && p.recommended >= 1 ? Math.floor(p.recommended) : undefined,
        pauseResumeAt: p.kind === "wait" && p.resumeAt ? p.resumeAt : undefined,
      }, ctx);
      if (p.kind === "decision" && p.options && p.options.length > 0) maybeDecisionPopup(ctx);
      // v0.27.1: surface the FULL pause contract — reason AND suggested
      // action. Before, the action only appeared in /goal status and the
      // widget truncated both at ~60 chars, so decision-pauses ("choose a
      // or b") reached the user as an unreadable fragment.
      ctx.ui.notify(`${goalNoun()} paused: ${p.reason}${p.suggestedAction ? `\n\n→ ${p.suggestedAction}` : ""}`, "info");
      notifyExternal(ctx, `${goalNoun()} paused: ${(p.suggestedAction ? `${p.reason} → ${p.suggestedAction}` : p.reason).slice(0, 200)}`);
      return { content: [{ type: "text", text: "Goal paused. /goal resume to continue." }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "complete_task",
    label: "Complete task",
    description: "Mark a task in the active goal's task list as complete (does not stop the turn).",    parameters: Type.Object({
      id: Type.String({ description: "Task id to complete" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign7 = foreignToolGuard(execCtx);
      if (foreign7) return { content: [{ type: "text", text: foreign7 }], details: {} };
      const p = params as { id: string };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id && t.status !== "complete") {
          t.status = "complete";
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} marked complete.` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "update_task_status",
    label: "Update task status",
    description: "Update a task's status (pending/in_progress/complete).",
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("complete")]),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign8 = foreignToolGuard(execCtx);
      if (foreign8) return { content: [{ type: "text", text: foreign8 }], details: {} };
      const p = params as { id: string; status: "pending" | "in_progress" | "complete" };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id) {
          t.status = p.status;
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} → ${p.status}` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_goal_draft",
    label: "Propose goal draft",
    description: "During goal drafting (/goal with no args), propose the clarified goal contract. Opens the user's Confirm dialog — nothing activates until they confirm. BLOCKED until the user has replied to at least one of your interview questions.",
    parameters: Type.Object({
      objective: Type.String({ description: "The clarified, concrete objective (single item) or a summary when items[] is used" }),
      verificationContract: Type.Optional(Type.String({ description: "Checkable done-criteria (commands, file states, test outcomes)" })),
      items: Type.Optional(Type.Array(Type.String(), { description: "LIST drafting only: many objectives at once (e.g. 'queue these 50 things'). Each becomes a list item; per-item 'Done when:' clauses are honored." })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign2 = foreignToolGuard(execCtx);
      if (foreign2) return { content: [{ type: "text", text: foreign2 }], details: {} };
      const p = params as { objective: string; verificationContract?: string; items?: string[] };
      if (draftingTarget !== "goal" && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "Not in goal drafting mode. The user starts drafting with /goal or /list add (no args), or activates directly with /goal <objective>." }],
          details: {},
        };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      // v0.28.14: one-active-thing EARLY guard — refuse the whole interview
      // when a loop is live (the post-confirm backstop below stays: state
      // can change mid-interview).
      if (isLoopActive()) {
        return { content: [{ type: "text", text: "A loop is active — one active thing at a time. The user must /loop stop it before a goal or list item can activate; do not re-propose until then." }], details: {} };
      }
      // v0.14.0: the interview floor — no Confirm until the user replied.
      // v0.23.8: /glla autoaccept=on skips the floor AND the Confirm —
      // the seed carries the intent (unattended rigs). Default off.
      const autoAccept = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      if (!autoAccept) {
        if (draftingUserReplies === 0) draftingBlockedProposals++;
        const block = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
        if (block) {
          return { content: [{ type: "text", text: block }], details: {} };
        }
      }
      // Multi-item drafts are LIST-only: a goal is single by definition.
      if (p.items && p.items.length > 0 && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "items[] is only valid in /list drafting — a goal is a single objective. Propose one objective, or ask the user to switch to /list." }],
          details: {},
        };
      }
      // v0.28.1 (S3): honest staleness warning before any Confirm attempt.
      warnIfStaleAtEntry(liveCtx, "goal drafting");
      // Multi-item list draft: one Confirm for the whole batch.
      if (p.items && p.items.length > 0) {
        // v0.23.7: show ALL items in full — the user approves the whole
        // batch; hidden items would be approved blind.
        const preview = p.items.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
        const batchActivates = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        let batchConfirmed = false;
        if (autoAccept) {
          batchConfirmed = true;
          liveCtx.ui.notify(`List batch auto-accepted (/glla autoaccept=on): ${p.items.length} items${batchActivates ? " — item 1 ACTIVATES now" : ""}.`, "info");
          appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "batch", count: p.items.length });
        } else {
          const c = await confirmDraft(
            liveCtx,
            "Confirm list batch",
            `${p.items.length} items:\n${preview}${batchActivates ? "\n\n(List is empty — confirming ACTIVATES item 1 immediately as the active goal.)" : ""}`,
          );
          if (c === "stale") {
            // v0.28.1 (T1): a stale dialog is NOT a rejection — nothing was
            // refused; the dialog simply can't render in a doomed process.
            extensionApiStale = true;
            appendLedger(liveCtx.cwd, "extension_api_stale", { where: "batch confirm" });
            return { content: [{ type: "text", text: "The Confirm dialog could not render: pi invalidated this session's extension handle (session replacement). This is NOT a rejection — do NOT refine or re-propose. Tell the user to restart pi, then re-run the drafting flow." }], details: {} };
          }
          batchConfirmed = c === "yes";
        }
        if (!batchConfirmed) {
          return {
            content: [{ type: "text", text: "Batch rejected by the user. Ask what to change, refine the item list, and propose again." }],
            details: {},
          };
        }
        draftingTarget = null;
        const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        const n = enqueueItems(liveCtx, p.items, "drafted batch");
        if (wasIdle) {
          return { content: [{ type: "text", text: `${n} items confirmed; first activated (list was empty). Begin work now.` }], details: {} };
        }
        return { content: [{ type: "text", text: `${n} items confirmed and added to the list (${listQueue().length} waiting).` }], details: {} };
      }
      const normContract = p.verificationContract?.trim() ? normalizeDraftContract(p.verificationContract) : "";
      const checkCount = normContract ? draftContractItemCount(normContract) : 0;
      const contractBlock = normContract
        ? `\n\nDone when${checkCount > 0 ? ` — ${checkCount} check${checkCount === 1 ? "" : "s"}` : ""}:\n${normContract}`
        : "\n\n(No verification contract — the auditor will infer done-criteria from the objective. Consider adding one.)";
      // v0.22.6: a list draft that will activate immediately must SAY so in
      // the Confirm dialog — "I started a list and ended up with a running
      // goal" was a real surprise. Title + trailing note name the outcome.
      const isListDraft = draftingTarget === "list";
      const willActivate = isListDraft && (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted");
      const activationNote = isListDraft
        ? willActivate
          ? "\n\n(List is empty — confirming ACTIVATES this immediately as the active goal. Reject if you only wanted to add it, not start it.)"
          : "\n\n(Goes into the list, waiting behind the active goal.)"
        : "";
      let confirmed = false;
      if (autoAccept) {
        confirmed = true;
        liveCtx.ui.notify(`Draft auto-accepted (/glla autoaccept=on)${willActivate ? " — ACTIVATING now" : ""}: ${p.objective.trim().slice(0, 90)}`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: isListDraft ? "list" : "goal", objective: p.objective.trim().slice(0, 200) });
      } else {
        const c = await confirmDraft(liveCtx, isListDraft ? "Confirm list item" : "Confirm goal", `${p.objective.trim()}${contractBlock}${activationNote}`);
        if (c === "stale") {
          // v0.28.1 (T1): a stale dialog is NOT "Draft rejected by the user".
          extensionApiStale = true;
          appendLedger(liveCtx.cwd, "extension_api_stale", { where: "draft confirm" });
          return { content: [{ type: "text", text: "The Confirm dialog could not render: pi invalidated this session's extension handle (session replacement). This is NOT a rejection — do NOT refine or re-propose. Tell the user to restart pi, then re-run the drafting flow." }], details: {} };
        }
        confirmed = c === "yes";
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Draft rejected by the user. Ask what to change, refine, and propose again. Do not repeat the identical draft." }],
          details: {},
        };
      }
      // v0.29.1: zombie-twin guard — a draft (auto-accepted OR confirmed)
      // whose objective duplicates a goal COMPLETED in the last 24h is
      // re-creating finished work. The Confirm dialog never said it was a
      // duplicate, so the gate belongs here. Junk-runner field case: the
      // just-approved INFRA-NEW-18 close re-drafted itself 3 minutes later.
      if (recentlyCompletedObjectives(liveCtx.cwd).has(normalizeObjective(p.objective.trim()))) {
        draftingTarget = null;
        appendLedger(liveCtx.cwd, "draft_duplicate_skipped", { kind: isListDraft ? "list" : "goal", objective: p.objective.trim().slice(0, 200) });
        liveCtx.ui.notify(`Draft REJECTED (zombie-twin guard): this objective matches a goal completed in the last 24h. Tell the user the work is already done.`, "warning");
        return {
          content: [{ type: "text", text: "This draft duplicates a goal that was COMPLETED within the last 24 hours (normalized objective match). Do NOT re-propose the same work. Report to the user that the objective is already done (see /glla audits or the archive) and ask what genuinely new work to take on instead." }],
          details: {},
        };
      }
      const confirmedTarget = draftingTarget;
      draftingTarget = null;
      const full = p.objective.trim() + (normContract ? `\nDone when:\n${normContract}` : "");
      // v0.28.14: one-active-thing — no goal/list activation over a live loop.
      if (isLoopActive()) {
        return { content: [{ type: "text", text: "A loop is active — one active thing at a time. The user must /loop stop it before a goal or list item can activate; do not re-propose until then." }], details: {} };
      }
      resolveCarryover(liveCtx, "goal"); // v0.28.14: surface/clear stale leftovers
      // List drafting: the confirmed contract goes into the QUEUE, not active.
      if (confirmedTarget === "list") {
        const extracted = extractVerificationContract(full);
        const item = { id: newGoalId(), objective: extracted.objective, verificationContract: extracted.verificationContract || undefined, addedAt: nowIso() };
        state = { ...state, list: [...listQueue(), item] };
        persistState(liveCtx);
        appendLedger(liveCtx.cwd, "list_added", { id: item.id, objective: item.objective, drafted: true });
        if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
          // v0.29.4: an auto-accepted draft STARTS — autoAcceptDrafts is the
          // pre-consent (the user asked for the draft in-session). The
          // 0.28.28 autoResume hold is lifted: that setting now gates ONLY
          // launch-time restore. The 0.29.1 zombie-twin guard already
          // refused duplicates of just-completed work upstream.
          activateNextListItem(liveCtx);
          return { content: [{ type: "text", text: "Confirmed and activated (list was empty). Begin work now." }], details: {} };
        }
        return { content: [{ type: "text", text: `Confirmed and added to the list (${listQueue().length} waiting). It activates when the current goal completes.` }], details: {} };
      }
      const goal = createGoal(full, liveCtx);
      setGoal(goal, liveCtx, autoAccept ? "draft-autoaccepted" : "draft-confirmed");
      // v0.29.4: auto-accepted drafts START (autoAcceptDrafts is the
      // pre-consent — the user asked for the draft in-session). autoResume
      // no longer gates draft starts; it gates ONLY launch-time restore of
      // persisted state ("load it but not auto start it"). Zombie twins of
      // just-completed work are refused upstream (0.29.1).
      iterationCounter = 0;
      consecutiveErrorIterations = 0;
      consecutiveAbortIterations = 0;
      scheduleContinuation(liveCtx, true);
      return {
        content: [{ type: "text", text: `Goal confirmed and activated (id ${goal.id}). Begin work now; call complete_goal only when the objective is genuinely satisfied.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_draft",
    label: "Propose loop draft",
    description: "During loop drafting (/loop with no args), propose the loop configuration. The orchestrator test-runs the measure command ONCE and shows the user real output + parsed number in a Confirm dialog. A measure producing no number is auto-rejected. Omit measureCmd (or pass \"none\") for a metricless spec loop — no plateau stop; ends only at bounds or /loop stop.",
    parameters: Type.Object({
      target: Type.String({ description: "What to improve, concretely" }),
      measureCmd: Type.Optional(Type.String({ description: 'Shell command that prints ONE number representing progress — or the literal "none" for a metricless spec loop' })),
      direction: Type.Optional(Type.Union([Type.Literal("min"), Type.Literal("max")], { description: "min = lower is better, max = higher is better (omit for a metricless loop)" })),
      window: Type.Optional(Type.Number({ description: "Plateau stop after N non-improving iterations (default 5)" })),
      max: Type.Optional(Type.Number({ description: "Iteration cap (default 50)" })),
      time: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many hours" })),
      tokens: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many tokens (input+output)" })),
      branch: Type.Optional(Type.Boolean({ description: "branch=true: scratch-branch mode (clean git tree required)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign3 = foreignToolGuard(execCtx);
      if (foreign3) return { content: [{ type: "text", text: foreign3 }], details: {} };
      const p = params as { target: string; measureCmd?: string; direction?: "min" | "max"; window?: number; max?: number; time?: number; tokens?: number; branch?: boolean };
      if (draftingTarget !== "loop") {
        return {
          content: [{ type: "text", text: "You cannot start or draft a loop — only the user can, from the slash bar (the Confirm is the product). Do NOT write draft files or wait for the user to say 'start' in chat; that dead-ends. Instead hand the user the exact command: /loop start \"<target>\" (bare = infinite metricless; add measure=\"<cmd>\" direction=min|max for a metric loop), or /loop respec to reconcile against the root spec, or /loop with no args to draft interactively." }],
          details: {},
        };
      }
      // v0.28.14: one-active-thing EARLY guard — refuse before the
      // interview floor (a live goal blocks any loop proposal).
      if (state.goal && state.goal.status === "active") {
        return { content: [{ type: "text", text: "A goal is active — one active thing at a time. The user must /goal pause or /goal cancel it before a loop can start; do not re-propose until then." }], details: {} };
      }
      // v0.14.0: the interview floor — no Confirm until the user replied.
      if (draftingUserReplies === 0) draftingBlockedProposals++;
      const loopBlock = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
      if (loopBlock) {
        return { content: [{ type: "text", text: loopBlock }], details: {} };
      }
      if (!p.target?.trim()) {
        return { content: [{ type: "text", text: "target is required." }], details: {} };
      }
      // v0.23.0: measureCmd omitted or "none" → metricless spec loop.
      const metricless = !p.measureCmd?.trim() || p.measureCmd.trim().toLowerCase() === "none";
      if (!metricless && p.direction !== "min" && p.direction !== "max") {
        return { content: [{ type: "text", text: 'direction=min|max is required for a measured loop (omit measureCmd or pass "none" for a metricless spec loop).' }], details: {} };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      // v0.28.14: one-active-thing — refuse to even test-run a loop measure
      // while a goal/list-item is active (the /loop start COMMAND guards
      // this; the tool path used to skip it and stack a loop over a goal).
      if (state.goal && state.goal.status === "active") {
        return { content: [{ type: "text", text: "A goal is active — one active thing at a time. The user must /goal pause or /goal cancel it before a loop can start; do not re-propose until then." }], details: {} };
      }
      // THE TEST-RUN: orchestrator runs the proposed measure once. The user
      // sees the real number before a single iteration burns tokens.
      // (Metricless loops skip this — there is no measure to test-run.)
      let rawOutput = "";
      let parsed: number | null = null;
      if (!metricless && extensionApi) {
        try {
          const result = await extensionApi.exec("bash", ["-c", p.measureCmd!], { cwd: liveCtx.cwd });
          rawOutput = String((result as any)?.stdout ?? "").trim();
          parsed = parseMetric(rawOutput);
        } catch (err) {
          rawOutput = `(measure command failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      if (!metricless && parsed === null) {
        return {
          content: [{
            type: "text",
            text: `Measure test-run produced NO number — proposal auto-rejected.\nCommand: ${p.measureCmd}\nOutput: ${rawOutput.slice(0, 300) || "(empty)"}\nFix the command so it prints exactly one number, sanity-check it against the repo, and propose again.`,
          }],
          details: {},
        };
      }
      const window = p.window && p.window > 0 ? Math.floor(p.window) : 5;
      // v0.23.0: explicit max=0 = truly unbounded (no iteration cap).
      // v0.23.8: metricless + no explicit max = UNBOUNDED here too — the
      // drafter path was still defaulting to 50 after v0.23.6 flipped the
      // CLI default.
      const max = p.max !== undefined && Number.isFinite(p.max) && p.max >= 0 ? Math.floor(p.max) : metricless ? 0 : 50;
      const autoAccept = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      let confirmed = false;
      if (autoAccept) {
        confirmed = true;
        liveCtx.ui.notify(`Loop draft auto-accepted (/glla autoaccept=on): ${p.target.trim().slice(0, 90)}`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "loop", target: p.target.trim().slice(0, 200), metricless });
      } else {
        try {
          const c = await confirmDraft(
          liveCtx,
          "Confirm loop",
          metricless
            ? `Target: ${p.target.trim()}\n\nMeasure: NONE — metricless spec loop. There is NO plateau stop: the loop ends only at ${max > 0 ? `${max} iterations` : "NO iteration cap"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""} · /loop stop.${p.branch ? "\nbranch mode: scratch branch, every iteration committed (clean tree required)" : ""}\n\nEvery iteration must make ONE real, inspectable change — cosmetic churn is the known failure mode (doorknob-polishing). Start it?`
            : `Target: ${p.target.trim()}\n\nMeasure: ${p.measureCmd}\nTest-run output: ${rawOutput.slice(0, 200)}\nParsed number: ${parsed} (${p.direction === "min" ? "lower is better" : "higher is better"})\n\nPlateau stop: ${window} non-improving iterations · Cap: ${max > 0 ? `${max} iterations` : "none (unbounded)"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""}${p.branch ? "\nbranch mode: scratch branch (clean tree required)" : ""}\n\nThe loop never completes — it runs until one of these bounds, plateau, or /loop stop. Start it?`,
          );
          confirmed = c === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Loop draft rejected by the user. Ask what to change — target, metric, direction, or window/max — and propose again." }],
          details: {},
        };
      }
      draftingTarget = null;
      const started = await startLoopFromConfig(liveCtx, {
        target: p.target.trim(),
        measureCmd: metricless ? "" : p.measureCmd!.trim(),
        direction: metricless ? undefined : p.direction,
        plateauWindow: window,
        maxIterations: max,
        timeLimitHours: typeof p.time === "number" && Number.isFinite(p.time) && p.time > 0 ? p.time : undefined,
        tokenBudget: typeof p.tokens === "number" && Number.isFinite(p.tokens) && p.tokens > 0 ? Math.floor(p.tokens) : undefined,
        branch: p.branch === true,
      });
      if (!started) {
        return { content: [{ type: "text", text: "Loop could not start (see the warning above — likely a git/dirty-tree issue with branch mode)." }], details: {} };
      }
      return {
        content: [{ type: "text", text: metricless ? "Loop confirmed and started (metricless — no plateau). Make ONE real, inspectable change per turn." : `Loop confirmed and started. Baseline ${parsed}. Make ONE small change per turn to move the metric ${p.direction === "min" ? "down" : "up"}.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_refine",
    label: "Propose loop spec refinement",
    description: "While a loop is ACTIVE, propose refining the loop's spec — sharpen the target and/or change the measure command — when the current spec no longer captures 'better'. The user confirms; on a measure change the orchestrator test-runs the new command and re-baselines. Never edit the measure command or its inputs directly — that is gaming the metric.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "The sharpened target text (omit to keep the current target)" })),
      measureCmd: Type.Optional(Type.String({ description: "The new measure command printing ONE number (omit to keep the current metric)" })),
      specText: Type.Optional(Type.String({ description: "v0.33.2: full replacement text for the loop's spec file (respec loops only) — the orchestrator owns the write on user confirm" })),
      specAppend: Type.Optional(Type.String({ description: "v0.33.2: lines to append to the loop's spec file (respec loops only)" })),
      rationale: Type.String({ description: "Why the current spec no longer captures 'better' — shown to the user in the Confirm dialog" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign4 = foreignToolGuard(execCtx);
      if (foreign4) return { content: [{ type: "text", text: foreign4 }], details: {} };
      const p = params as { target?: string; measureCmd?: string; specText?: string; specAppend?: string; rationale: string };
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const loop = state.loop;
      if (!loop?.active) {
        return { content: [{ type: "text", text: "No active loop to refine. propose_loop_refine is only valid while a loop is running." }], details: {} };
      }
      const newTarget = p.target?.trim() || loop.target;
      const newMeasure = p.measureCmd?.trim() || loop.measureCmd || "";
      // v0.23.0: a metricless loop can't be refined into a measured one
      // (no direction, no baseline semantics) — stop and restart instead.
      if (!loop.measureCmd && p.measureCmd?.trim()) {
        return { content: [{ type: "text", text: "This loop is metricless — refining it into a measured loop isn't supported. /loop stop, then /loop start with a metric." }], details: {} };
      }
      const specChange = (p.specText?.trim() || p.specAppend?.trim()) ? true : false;
      if (specChange && !loop.specFile) {
        return { content: [{ type: "text", text: "This loop has no spec file (specText/specAppend apply to /loop respec loops). Refine the target instead." }], details: {} };
      }
      if (newTarget === loop.target && newMeasure === loop.measureCmd && !specChange) {
        return { content: [{ type: "text", text: "Refinement proposed no changes — provide a new target, a new measureCmd, a spec change, or any combination." }], details: {} };
      }
      // Measure change → orchestrator test-runs the new command first.
      let newBaseline: number | null = null;
      let testOutput = "";
      if (newMeasure !== loop.measureCmd) {
        if (!extensionApi) return { content: [{ type: "text", text: "No extension API available." }], details: {} };
        try {
          const result = await extensionApi.exec("bash", ["-c", newMeasure], { cwd: liveCtx.cwd });
          testOutput = String((result as any)?.stdout ?? "");
        } catch (e) {
          return { content: [{ type: "text", text: `New measure command failed to run: ${String(e).slice(0, 200)}` }], details: {} };
        }
        newBaseline = parseMetric(testOutput);
        if (newBaseline === null) {
          return {
            content: [{ type: "text", text: `New measure produced NO number — refinement auto-rejected.\nCommand: ${newMeasure}\nOutput: ${testOutput.slice(0, 300) || "(empty)"}\nFix it and propose again.` }],
            details: {},
          };
        }
      }
      let confirmed = false;
      if (loadSettings(liveCtx.cwd).autoAcceptDrafts === true) {
        confirmed = true;
        liveCtx.ui.notify("Loop spec refinement auto-accepted (/glla autoaccept=on).", "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "loop-refine" });
      } else {
        try {
          confirmed = (await confirmDraft(
            liveCtx,
            "Confirm loop spec refinement",
          `Rationale: ${p.rationale}\n\nTarget:\n  old: ${loop.target.slice(0, 120)}\n  new: ${newTarget.slice(0, 120)}\n\nMeasure:\n  old: ${loop.measureCmd}\n  new: ${newMeasure}${newMeasure !== loop.measureCmd ? `\n  test-run: ${testOutput.slice(0, 120)} → ${newBaseline}` : ""}${specChange ? `\n\nSpec file (${loop.specFile}):\n  ${p.specText?.trim() ? `REPLACE with ${p.specText!.trim().length} chars` : ""}${p.specText?.trim() && p.specAppend?.trim() ? " + " : ""}${p.specAppend?.trim() ? `APPEND: ${p.specAppend!.trim().slice(0, 120)}` : ""}` : ""}\n\nThe loop keeps running against the refined spec (iteration ${loop.iteration} so far). Apply?`,
          )) === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Refinement rejected by the user. The loop continues against the current spec — keep improving the metric as defined." }], details: {} };
      }
      applyRefinement(loop, {
        at: nowIso(),
        iteration: loop.iteration,
        oldTarget: loop.target,
        newTarget,
        oldMeasureCmd: loop.measureCmd ?? "",
        newMeasureCmd: newMeasure,
      }, newBaseline);
      // v0.33.2: the orchestrator owns the spec write (honesty stays
      // inspectable — the agent never edits the spec it's judged against
      // outside a confirmed refine).
      if (specChange && loop.specFile) {
        try {
          if (p.specText?.trim()) fs.writeFileSync(loop.specFile, p.specText.trim() + "\n");
          if (p.specAppend?.trim()) fs.appendFileSync(loop.specFile, (p.specText?.trim() ? "" : "\n") + p.specAppend.trim() + "\n");
          loop.specHash = specFileHash(loop.specFile) ?? undefined;
          appendLedger(liveCtx.cwd, "spec_updated", { via: "refine", iteration: loop.iteration, replaced: Boolean(p.specText?.trim()), appended: Boolean(p.specAppend?.trim()) });
        } catch (e) {
          return { content: [{ type: "text", text: `Spec file write failed: ${String(e).slice(0, 200)}. The target/measure refinement was applied; re-propose the spec change.` }], details: {} };
        }
      }
      persistState(liveCtx);
      appendLedger(liveCtx.cwd, "loop_refined", { iteration: loop.iteration, newTarget, newMeasureCmd: newMeasure, newBaseline, specChanged: specChange || undefined });
      liveCtx.ui.notify(`Loop spec refined at iteration ${loop.iteration}.${newBaseline !== null ? ` New baseline: ${newBaseline}.` : ""}${specChange ? " Spec file updated." : ""}`, "info");
      return { content: [{ type: "text", text: "Refinement confirmed and applied. Continue improving against the NEW spec — one small change per turn." }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_add",
    label: "Add to list",
    description: "Add one or many objectives to the /list list (loop 2). Use when the user asks to add work — 'add these to my list', 'queue these 10 things', 'put this on the backlog'. The list is a POOL, not a FIFO: order is the default, not the law — any item can be activated next. Each item becomes an audited goal; per-item 'Done when:' clauses are honored. The first item activates automatically when nothing is running. The list is UNBOUNDED — hundreds of small items are fine; propose them all.",
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Objectives to add — no count limit; large plans belong in ONE call." }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign5 = foreignToolGuard(execCtx);
      if (foreign5) return { content: [{ type: "text", text: foreign5 }], details: {} };
      const p = params as { items: string[] };
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        return { content: [{ type: "text", text: "No items given." }], details: {} };
      }
      const clean = p.items.map((t) => t.trim()).filter((t) => t.length > 0);
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
      const n = enqueueItems(liveCtx, clean, "agent list_add");
      return {
        content: [{
          type: "text",
          text: wasIdle
            ? `${n} item(s) added; the first is now active. Work it normally and call complete_goal when done — the next item activates automatically.`
            : `${n} item(s) queued (${listQueue().length} waiting behind the active goal).`,
        }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_activate",
    label: "Activate list item",
    description: "Activate a specific item from the /list queue by position (1-based). Order is the default, not the law: use this when a different item should be worked next (e.g. you want to research item 5 while item 1 waits). Aborts the currently active goal if one is running.",
    parameters: Type.Object({
      n: Type.Number({ description: "1-based position in the queue (1 = head)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign6 = foreignToolGuard(execCtx);
      if (foreign6) return { content: [{ type: "text", text: foreign6 }], details: {} };
      const p = params as { n: number };
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      const n = Math.floor(p.n);
      if (!Number.isInteger(n) || n < 1) {
        return { content: [{ type: "text", text: "n must be a positive integer (1-based position)." }], details: {} };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      // v0.28.14: one-active-thing — a list item must not jump a live loop.
      if (isLoopActive()) {
        return { content: [{ type: "text", text: "A loop is active — one active thing at a time. The user must /loop stop it before a list item can activate." }], details: {} };
      }
      if (state.goal && state.goal.status === "active") {
        archiveCurrentGoal(liveCtx, "aborted", "skipped via list_activate");
      }
      if (!activateNextListItem(liveCtx, n)) {
        return { content: [{ type: "text", text: listQueue().length === 0 ? "List is empty." : `No item #${n} (list has ${listQueue().length} items).` }], details: {} };
      }
      return { content: [{ type: "text", text: `Item #${n} activated. Work it normally; call complete_goal when done.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_status",
    label: "List status",
    description: "Show the active goal and the /list list (loop 2) as text: what's running, what's waiting.",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];
      if (state.goal) {
        lines.push(`Active [${state.goal.policy}] (${statusLabel(state.goal.status)}): ${state.goal.objective}`);
      } else {
        lines.push("Active: (none)");
      }
      const queue = listQueue();
      if (queue.length === 0) {
        lines.push("List: empty.");
      } else {
        lines.push(`List (${queue.length}):`);
        queue.slice(0, 20).forEach((item, i) => lines.push(`${i + 1}. ${item.objective}`));
        if (queue.length > 20) lines.push(`… and ${queue.length - 20} more`);
      }
      if (state.loop) {
        lines.push(`Loop: ${state.loop.active ? "active" : "stopped"} — ${state.loop.target} (best ${state.loop.bestValue ?? "n/a"}, iteration ${state.loop.iteration})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_task_list",
    label: "Propose task list",
    description: "Propose a task breakdown for the active goal. Opens the user's Confirm dialog. Limits: 20 top-level tasks, 5 subtasks per task.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        title: Type.String(),
        subtasks: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign9 = foreignToolGuard(execCtx);
      if (foreign9) return { content: [{ type: "text", text: foreign9 }], details: {} };
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal to break down." }], details: {} };
      }
      if (state.goal.taskList && state.goal.taskList.tasks.length > 0) {
        return { content: [{ type: "text", text: "A task list already exists. Use update_task_status / complete_task to work it." }], details: {} };
      }
      const p = params as { tasks: TaskProposal[] };
      const invalid = validateTaskProposal(p.tasks);
      if (invalid) {
        return { content: [{ type: "text", text: invalid }], details: {} };
      }
      const liveCtx = (execCtx as ExtensionContext | undefined) ?? ctx;
      const preview = p.tasks.map((t, i) => {
        const subs = (t.subtasks ?? []).map((s, j) => `   ${i + 1}.${j + 1} ${s}`).join("\n");
        return `${i + 1}. ${t.title}` + (subs ? `\n${subs}` : "");
      }).join("\n");
      const autoAcceptTasks = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      let confirmed = false;
      if (autoAcceptTasks) {
        confirmed = true;
        liveCtx.ui.notify(`Task list auto-accepted (/glla autoaccept=on): ${p.tasks.length} tasks.`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "tasks", count: p.tasks.length });
      } else {
        try {
          confirmed = (await confirmDraft(liveCtx, "Confirm task list", preview)) === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Task list rejected by the user. Adjust and propose again." }], details: {} };
      }
      const taskList = buildTaskList(p.tasks);
      updateGoal({ taskList }, liveCtx);
      const subCount = taskList.tasks.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0);
      return {
        content: [{ type: "text", text: `Task list set: ${taskList.tasks.length} tasks, ${subCount} subtasks. Track progress with complete_task / update_task_status.` }],
        details: {},
      };
    },
  }));
}

// =================================================================
// Settings (auditor model, thinking level)
// =================================================================

/**
 * Session thinking level with a "high" floor (v0.8.5): the auditor follows
 * the thinking level the user selected in pi; if none is set, audits run at
 * "high" — the auditor is the verification gate, depth beats speed there.
 */
/**
 * Resolve the auditor model (v0.6.2). The principle: **the user selects the
 * model in pi; the auditor uses it.** The plugin never picks a model itself.
 *
 * Chain:
 *   1. Explicit `/glla model=provider/id` override (rare).
 *   2. The pi session model (ctx.model) — whatever the user selected.
 *
 * If the session model's provider is extension-registered, the auditor's
 * extension-less session cannot auth it; that failure is surfaced with a
 * clear explanation (switch pi's model to a built-in provider, or set the
 * override) — we do NOT silently substitute a different model.
 */
/** v0.31.3: the auditor model chain — pinned primary, pinned fallback,
 * session model LAST (user design 2026-07-31: "it can be the primary auditor
 * and the session model is always the last; we can have a fallback auditor
 * too" + "if the session model is the same as the auditor we auto fallback").
 * Two explicit pins and a cascade — no preference tables, no strategy
 * resolution (the v0.31.2 diverse-strategy machinery cost more complexity than it
 * bought; it lasted one version). Every hop is LOUD (ledger + notify): the
 * v0.9.12 no-SILENT-substitution law.
 */
/** v0.31.8: the auditor thinking options are derived from the PICKED
 * model, not a hardcoded list — same rule as pi's own thinking selector
 * (pi-ai getSupportedThinkingLevels): non-reasoning models expose only
 * "off"; xhigh/max exist only when the model maps them (thinkingLevelMap).
 * Replicated inline so the extension's older pi-ai dev-types don't matter —
 * the fields are read at runtime from the user's installed pi. */
function auditorThinkingLevels(model: any): string[] {
  const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
  return ALL.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function resolveAuditorModel(ctx: ExtensionContext, ref?: string, fallbackRef?: string, sameSessionSwap = true): { model: any; error?: string; via?: string } {
  const sessionModel = ctx.model as any;
  const tryRef = (trimmed: string): { model?: any; reason?: string } => {
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const provider = trimmed.slice(0, slash);
      const model = ctx.modelRegistry.find(provider, trimmed.slice(slash + 1));
      if (!model) return { reason: "model not found" };
      // v0.29.17: an unkeyed provider counts as unavailable. (Quota-exhausted
      // keys stay on the quota-retry path — the model IS available there;
      // the key's window is the failure, not the model.)
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { reason: `no configured auth for ${provider}` };
      return { model };
    }
    const matches = ctx.modelRegistry.getAvailable().filter((m: any) => m.id === trimmed || m.name === trimmed);
    return matches[0] ? { model: matches[0] } : { reason: "no available model matching" };
  };
  const isSession = (m: any) => sessionModel && m.provider === sessionModel.provider && m.id === sessionModel.id;
  // v0.32.0: per-pin source labels — when the primary is unset, pins[0] IS
  // the fallback and the old i===0→"setting" map mislabeled it.
  const pins: Array<{ pin: string; src: "setting" | "fallback-pin" }> = [];
  if (ref?.trim()) pins.push({ pin: ref.trim(), src: "setting" });
  if (fallbackRef?.trim()) pins.push({ pin: fallbackRef.trim(), src: "fallback-pin" });
  for (let i = 0; i < pins.length; i++) {
    const { pin } = pins[i]!;
    const r = tryRef(pin);
    if (!r.model) {
      // Unavailable pin → cascade: next pin, then the session model (LOUD).
      appendLedger(ctx.cwd, "auditor_model_fallback", { configured: pin, reason: r.reason });
      // v0.32.0: the last pin no longer pre-announces the session fallback —
      // the post-loop block does that (it notified twice before).
      ctx.ui.notify(`Auditor model "${pin}" is unavailable (${r.reason})${i + 1 < pins.length ? " — trying the fallback pin" : ""}. Fix via /glla → Auditor model.`, "warning");
      continue;
    }
    if (sameSessionSwap && isSession(r.model) && i + 1 < pins.length) {
      // The pin IS the session model — the verifier would be the executor's
      // own model; auto-swap down the chain (the user's move).
      appendLedger(ctx.cwd, "auditor_model_same_as_session", { model: `${r.model.provider}/${r.model.id}`, fallback: pins[i + 1]!.pin });
      ctx.ui.notify(`Session model IS the pinned auditor (${r.model.provider}/${r.model.id}) — auditor auto-swapped to ${pins[i + 1]!.pin} so the verifier differs.`, "info");
      continue;
    }
    // v0.32.0: the nudge must fire when the LAST pin stands on the session
    // model — the old `!fallbackRef` guard went SILENT when the fallback pin
    // itself resolved to the session model (verifier == executor, and hop 0's
    // notify had just claimed "auto-swapped so the verifier differs" — false).
    if (sameSessionSwap && isSession(r.model) && i + 1 >= pins.length) {
      // Last resort reached and it IS the session model, with no fallback
      // ever pinned — the model stands (the session IS the last resort);
      // one loud nudge so the user can wire the swap.
      appendLedger(ctx.cwd, "auditor_model_same_as_session", { model: `${r.model.provider}/${r.model.id}`, fallback: null });
      ctx.ui.notify(`The session model IS the pinned auditor (${r.model.provider}/${r.model.id}) — pin a different /glla → Auditor fallback model so the verifier can differ.`, "warning");
    }
    return { model: r.model, via: pins[i]!.src };
  }
  if (sessionModel) {
    if (pins.length > 0) {
      appendLedger(ctx.cwd, "auditor_model_fallback", { configured: pins.map((p) => p.pin).join(" → "), reason: "all pins exhausted" });
      ctx.ui.notify("All pinned auditor models are unavailable — falling back to the session model. Fix via /glla → Auditor model.", "warning");
      return { model: sessionModel, via: "session-fallback" };
    }
    return { model: sessionModel, via: "session" };
  }
  return { model: undefined, error: "no session model and no auditorModel configured — set one with /glla → Auditor model" };
}

// (v0.9.12) The auto-fallback apparatus was REMOVED: no tier ranking, no
// candidate chains, no dead-model caches. The plugin never picks a model —
// you select it in pi (session model) or in /glla (explicit override). When
// neither works, the failure surfaces plainly (see the three-way split in
// the complete_goal handler) with the exact fix; nothing is substituted
// silently.

/**
 * The /glla interactive settings UI (v0.8.0): a menu loop over pi's dialog
 * primitives. Pick a setting → edit it → saved to GLOBAL → back to the menu.
 * Done/Esc exits. Rarely opened by design; scriptable /glla key=value remains
 * for tmux/headless.
 */
/**
 * v0.28.0: open the /glla settings menu as a TUI table (top tabs row +
 * 4-column body: KEY | VALUE | SOURCE | DESCRIPTION). Loops until the user
 * exits (Esc / undefined from confirm or cancel) or until a handler returns.
 *
 * The dispatcher (handleSettingChoice, below) takes a stable id and calls the
 * per-key editor (input/select/confirm dialog) used by the pick. The prior
 * v0.27.0 dispatcher used `choice.startsWith(label)` strings; the new id-based
 * switch is contract-equal in behavior and unit-testable via
 * extensions/settings-menu.ts.
 */
async function openSettingsUI(ctx: ExtensionContext): Promise<void> {
  for (;;) {
    const settings = loadSettings(ctx.cwd);
    const prov = settingsProvenance(ctx.cwd);
    const rows = buildSettingsRows(settings, prov);
    const id = await promptSettingsMenu(ctx, rows);
    if (!id) return;
    try {
      await handleSettingChoice(id, ctx);
    } catch {
      return;
    }
  }
}

/**
 * Show the table-rendered settings menu and return the user's pick id (or
 * undefined for cancel). Wraps `ctx.ui.custom` so openSettingsUI stays a thin
 * loop. Falls back to a select-based legacy menu when the runtime has no
 * `ctx.ui.custom` (the `ctx.hasUI` guard already protects this path elsewhere;
 * this is a second-line defense for headless custom-only shards).
 */
async function promptSettingsMenu(
  ctx: ExtensionContext,
  rows: SettingsRow[],
): Promise<string | undefined> {
  const title = `pi-goal-list-loop-audit settings — global: ${globalSettingsPath()}`;
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function") {
    // Headless / no custom shard — fall back to the legacy flat-row select
    // for any environment that lacks the new primitive. This is rare and
    // effectively an emergency hatch; the new UI is the supported path.
    const flat = rows.map((r) => `${r.label} — ${r.valueText} [${r.sourceText.replace(/^\[|\]$/g, "")}] — ${r.description}`);
    flat.push("Done");
    const v = await ctx.ui.select(title, flat);
    if (!v || v === "Done") return undefined;
    return rows.find((r) => v.startsWith(r.label))?.id;
  }
  return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    return new SettingsMenuComponent({ rows, title }, () => tui.requestRender(), theme, keybindings, done);
  });
}

/**
 * v0.28.0: per-key dispatch for the settings menu. The id comes from
 * `buildSettingsRows` (e.g. "autoResume", "auditorModel", "subagentModelOverrides.Explore").
 * Same handlers as v0.27.0's if/else chain — only the trigger changed from
 * `startsWith(label)` strings to stable ids.
 */
// v0.28.7 (T4): exported for the behavioral settings-editor tests
// (tests/settings-editors.test.ts drives each editor class end-to-end).
/**
 * v0.29.17: /model-style fuzzy picker for model-valued settings. Builds the
 * item list from the registry (configured-auth providers only — a pick
 * from this list can never be a dead provider) and hosts the picker via
 * ctx.ui.custom. Falls back to the typed input when the runtime has no
 * custom shard (headless) — typing stays the emergency hatch there.
 * Returns { kind: "session" } to clear the override, { kind: "ref" } with
 * provider/id, or undefined for cancel.
 */
async function promptModelRef(
  ctx: ExtensionContext,
  title: string,
  emptyLabel: string,
): Promise<{ kind: "session" } | { kind: "ref"; ref: string } | undefined> {
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function" || !ctx.modelRegistry) {
    const v = await ctx.ui.input(title, "provider/model-id — empty keeps the default");
    if (v === undefined) return undefined;
    return v.trim() ? { kind: "ref", ref: v.trim() } : { kind: "session" };
  }
  const sessionModel = ctx.model as any;
  const sessionLabel = sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "pi session model";
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((m: any) => ctx.modelRegistry.hasConfiguredAuth(m));
  const items = buildModelPickItems(models, sessionLabel);
  const pick = await ctx.ui.custom<ModelPickItem | undefined>((tui, theme, keybindings, done) => {
    return new ModelPickerComponent({ title, items }, () => tui.requestRender(), theme, keybindings, done);
  });
  if (!pick) return undefined;
  if (pick.kind === "session") return { kind: "session" };
  if (pick.kind === "model" && pick.ref) return { kind: "ref", ref: pick.ref };
  // manual escape hatch — typed provider/model, validated like before
  const v = await ctx.ui.input(title, emptyLabel);
  if (v === undefined) return undefined;
  return v.trim() ? { kind: "ref", ref: v.trim() } : { kind: "session" };
}

export async function handleSettingChoice(id: string, ctx: ExtensionContext): Promise<void> {
  switch (id) {
    case "autoResume": {
      const v = await ctx.ui.select("Auto-resume goals/loops on session start", [
        "default — HOLD when a session is loaded (popup shows what waits); auto-resume on reload/fork so machinery never strands work",
        "on — auto-resume on EVERY session start (unattended rigs)",
        "off — never auto-resume; always wait for an explicit resume",
      ]);
      if (v) saveSettings("global", ctx.cwd, { autoResume: v.startsWith("on") ? true : v.startsWith("off") ? false : undefined });
      return;
    }
    case "autoAcceptDrafts": {
      const v = await ctx.ui.select("Auto-accept goal/loop drafts", [
        "off — the Confirm dialog gates every draft",
        "on — drafts activate immediately, no Confirm (unattended rigs)",
      ]);
      if (v) saveSettings("global", ctx.cwd, { autoAcceptDrafts: v.startsWith("on") ? true : undefined });
      return;
    }
    case "decisionPopup": {
      const v = await ctx.ui.select("Decision popup (v0.28.23 — decision pauses pop the select() picker)", [
        "on — a decision pause opens the picker; the widget card is the Escape fallback",
        "off — widget card only; /goal decide opens the picker on demand",
      ]);
      if (v) saveSettings("global", ctx.cwd, { decisionPopup: v.startsWith("off") ? false : undefined });
      return;
    }
    case "aggressiveMode": {
      const v = await ctx.ui.select("Aggressive mode (flips DEFAULTS toward keep-going — explicit per-key settings still win)", [
        "off — current behavior: pause at the audit cap, wedge alerts on, manual resume",
        "on — autoResume, audit cap 10, stuck max 10, wedge alerts off, quota auto-retry, cap disapprovals become a TODO list and the goal KEEPS GOING",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { aggressiveMode: v.startsWith("on") });
        ctx.ui.notify(`Aggressive mode ${v.startsWith("on") ? "ON — goals keep going past the audit cap; objections become TODOs" : "off"}.`, "info");
      }
      return;
    }
    case "auditorModel": {
      const pick = await promptModelRef(ctx, "Auditor model override", "provider/model-id — empty keeps the pi session model");
      if (pick === undefined) return;
      saveSettings("global", ctx.cwd, { auditorModel: pick.kind === "session" ? undefined : pick.ref });
      // v0.31.4: thinking is chosen WITH the model (user: "we are setting
      // the thinking when we select the model now or we should") — there is
      // no standalone thinking row to forget about. Esc keeps the level.
      // v0.31.7: the select must be UNMISTAKABLY the auditor's — the user
      // Esc'd through it because it read like pi's own (general) thinking
      // dialog, and nothing was ever saved.
      // v0.31.8: the options come from the PICKED MODEL's info (user: "we
      // are not using the model information cause it has no max") — a model
      // that maps xhigh/max offers them; a non-reasoning model is told, not asked.
      let pickedModel: any = pick.kind === "session" ? (ctx.model as any) : undefined;
      if (pick.kind === "ref" && pick.ref) {
        const parts = pick.ref.split("/");
        try {
          pickedModel = parts.length === 2 ? (ctx.modelRegistry?.find?.(parts[0]!, parts[1]!) as any) : (ctx.modelRegistry?.getAvailable?.().filter((m: any) => m.id === pick.ref)[0] as any);
        } catch { pickedModel = undefined; } // levels fall back to the full ladder below
      }
      const curThinking = loadSettings(ctx.cwd).auditorThinkingLevel;
      const levels = auditorThinkingLevels(pickedModel);
      if (levels.length <= 1) {
        ctx.ui.notify(`Auditor model: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref} — this model exposes no thinking levels (auditor runs with thinking off).`, "info");
        return;
      }
      const DESCR: Record<string, string> = { off: "no reasoning", minimal: "~1k tokens", low: "~2k tokens", medium: "~8k tokens", high: "the default; the gate must not ride the session's coding dial", xhigh: "~32k tokens", max: "maximum reasoning" };
      const t = await ctx.ui.select(
        "Auditor thinking — ISOLATED auditor session ONLY (your session model's thinking is untouched)",
        levels.map((lv) => `${lv} — ${DESCR[lv] ?? ""}${lv === "high" && curThinking === undefined ? " (current)" : curThinking === lv ? " (current)" : ""}`),
      );
      if (t) saveSettings("global", ctx.cwd, { auditorThinkingLevel: t.split(" ")[0] as Settings["auditorThinkingLevel"] });
      ctx.ui.notify(`Auditor model: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref}${t ? ` · thinking ${t.split(" ")[0]}` : ""}`, "info");
      return;
    }
    case "auditorModelFallback": {
      const pick = await promptModelRef(ctx, "Auditor fallback model (used when the session model IS the auditor)", "provider/model-id — empty clears the fallback");
      if (pick === undefined) return;
      saveSettings("global", ctx.cwd, { auditorModelFallback: pick.kind === "session" ? undefined : pick.ref });
      if (pick.kind === "session") ctx.ui.notify("Auditor fallback cleared — a session on the pinned auditor model keeps that model.", "info");
      return;
    }
    case "auditorSameSessionSwap": {
      const v = await ctx.ui.select("Same-model swap — when the pinned auditor IS the session model, walk the fallback pin", [
        "on — the verifier differs from the executor (default; a same-family model shares the executor's blind spots)",
        "off — same-model audits stand (you accept the executor's model as its own verifier; isolation + evidence contract still apply)",
      ]);
      if (v) saveSettings("global", ctx.cwd, { auditorSameSessionSwap: v.startsWith("off") ? false : undefined });
      return;
    }
    case "auditCap": {
      const v = await ctx.ui.input("Consecutive auditor disapprovals before the goal pauses", "non-negative integer; 0 = unlimited, empty = default 5");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { auditCap: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { auditCap: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "auditFeedbackChars": {
      const v = await ctx.ui.input("Auditor feedback returned to the executor (characters)", "non-negative integer cap; 0 or empty = full report (default)");
      if (v !== undefined) {
        const raw = v.trim();
        const n = Number(raw);
        if (/^\d+$/.test(raw) && Number.isSafeInteger(n)) saveSettings("global", ctx.cwd, { auditFeedbackChars: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { auditFeedbackChars: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "quotaRetryMinutes": {
      const v = await ctx.ui.input("Minutes before auto-retrying a quota-exhausted auditor", `positive integer; empty = default ${DEFAULT_QUOTA_RETRY_MINUTES}`);
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n > 0) saveSettings("global", ctx.cwd, { quotaRetryMinutes: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { quotaRetryMinutes: undefined });
        else ctx.ui.notify(`Not a positive integer: ${v}`, "warning");
      }
      return;
    }
    case "wedgeAlertMinutes": {
      const v = await ctx.ui.input("Wedge alert threshold (minutes)", "non-negative integer; 0 = off, empty = default 30");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stuckMaxInterventions": {
      const v = await ctx.ui.input("Consecutive stuck interventions before a loop stops", "positive integer; empty = default 5 (10 under aggressiveMode)");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n > 0) saveSettings("global", ctx.cwd, { stuckMaxInterventions: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stuckMaxInterventions: undefined });
        else ctx.ui.notify(`Not a positive integer: ${v}`, "warning");
      }
      return;
    }
    case "stallEscalationRefires": {
      const v = await ctx.ui.input("Heartbeat refires without a turn before the goal pauses / loop stops", "non-negative integer; 0 = never escalate, empty = default 5");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { stallEscalationRefires: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallEscalationRefires: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stallShortWords": {
      const v = await ctx.ui.input("Stall short words threshold", "non-negative integer; 0 = off, empty = default 15");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { stallShortWords: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallShortWords: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stallSimilarityThreshold": {
      const v = await ctx.ui.input("Stall similarity threshold (0..1)", "decimal between 0 and 1; empty = default 0.6");
      if (v !== undefined) {
        const n = Number(v.trim());
        if (Number.isFinite(n) && n >= 0 && n <= 1) saveSettings("global", ctx.cwd, { stallSimilarityThreshold: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallSimilarityThreshold: undefined });
        else ctx.ui.notify(`Not a decimal between 0 and 1: ${v}`, "warning");
      }
      return;
    }
    case "subagentModelStrategy": {
      const v = await ctx.ui.select("Subagent model (pi-subagents default agents)", [
        "inherit-parent — share your session model + quota pool (recommended)",
        "agent-default — use the upstream pi-subagents default agents",
      ]);
      if (v) {
        const strategy: SubagentModelStrategy = v.startsWith("agent-default") ? "agent-default" : "inherit-parent";
        saveSettings("global", ctx.cwd, { subagentModelStrategy: strategy });
        ctx.ui.notify("Subagent model strategy saved — applies to NEW pi sessions (pi-subagents registers agents at session start).", "info");
      }
      return;
    }
    case "subagentModelOverrides.Explore":
    case "subagentModelOverrides.Plan":
    case "subagentModelOverrides.general-purpose": {
      const agentType = id.slice("subagentModelOverrides.".length);
      const pick = await promptModelRef(ctx, `Model pin for ${agentType} subagents`, "provider/model-id e.g. minimax/MiniMax-M3 — always wins over strategy; empty = follow strategy");
      if (pick === undefined) return;
      const current = loadSettings(ctx.cwd).subagentModelOverrides ?? {};
      const next = { ...current };
      if (pick.kind === "ref") next[agentType] = pick.ref;
      else delete next[agentType];
      saveSettings("global", ctx.cwd, { subagentModelOverrides: Object.keys(next).length > 0 ? next : undefined });
      ctx.ui.notify(`${agentType} model pin saved — applies to NEW pi sessions.`, "info");
      return;
    }
    case "subagentResolved":
      // Read-only (effective resolution row) — no editor; row just shows the
      // current effective subagent models. Treat as no-op.
      return;
    case "notifyCmd": {
      const v = await ctx.ui.input("Notify command — the event message is passed as $1", "custom command · empty = auto-detect (notify-send/osascript) · 'off' = silent");
      if (v !== undefined) saveSettings("global", ctx.cwd, { notifyCmd: v.trim() || undefined });
      return;
    }
    case "tokenLimit": {
      const v = await ctx.ui.input("Per-goal token budget", "non-negative integer; 0 or empty = off (no cap)");
      if (v !== undefined) {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isFinite(n) && n >= 0) saveSettings("global", ctx.cwd, { tokenLimit: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { tokenLimit: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "postaudit":
      await cmdReviewerSettings(ctx);
      return;
    default:
      // Unknown id — keep the menu looping. Surface a soft warning so the
      // user knows a row existed but had no handler (better than silently
      // swallowing it).
      ctx.ui.notify(`/glla: unknown setting id "${id}" — please report this.`, "warning");
      return;
  }
}

/** v0.26.0: /review <archived-goal-id> — manual reviewer invocation. */
async function cmdReview(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const id = parts[0] ?? "";
  const modeArg = parts[1];
  const validModes = ["off", "on", "auto", "aggressive"] as const;
  const mode = (validModes as readonly string[]).includes(modeArg ?? "")
    ? (modeArg as typeof validModes[number])
    : undefined;
  if (modeArg && !mode) {
    ctx.ui.notify(`Unknown mode "${modeArg}" — use off | on | auto | aggressive.`, "warning");
    return;
  }
  if (!id) {
    ctx.ui.notify(`Usage: /review <goal-id> [${validModes.join("|")}] — see /goal archive for ids.`, "info");
    return;
  }
  // Resolve the id against the archive (suffix match allowed).
  let goalId = id;
  let objective = "(archived goal)";
  try {
    const files = fs.readdirSync(archiveDir(ctx.cwd)).filter((f) => f.endsWith(".md"));
    const match = files.find((f) => f === `${id}.md`) ?? files.find((f) => f.includes(id));
    if (!match) {
      ctx.ui.notify(`No archived goal matching "${id}". /goal archive lists them.`, "warning");
      return;
    }
    goalId = match.replace(/\.md$/, "");
    const md = fs.readFileSync(path.join(archiveDir(ctx.cwd), match), "utf-8");
    const objMatch = md.match(/## Objective\n\n> ([\s\S]*?)(?:\n\n|$)/);
    if (objMatch) objective = objMatch[1]!.replace(/\n/g, " ").slice(0, 300);
  } catch {
    ctx.ui.notify(`No archive found for ${id}.`, "warning");
    return;
  }
  fireReviewer(ctx, { kind: "goal", goalId, objective, terminal: "goal-complete" }, { manual: true, mode });
}

/** v0.27.9: /glla tooloverride <action> [args] — per-tool override menu.
 * Actions:
 *   list                                show current allow/hide/perToolConfig
 *   allow <tool>                        force <tool> visible despite modlist
 *   hide <tool>                         force <tool> hidden despite session
 *   unallow <tool>                      remove from allow list
 *   unhide <tool>                       remove from hide list
 *   set <tool> <key>=<value>            write perToolConfig[tool][key]
 *   unset <tool> <key>                  remove perToolConfig[tool][key]
 * Example: /glla tooloverride allow bash hide write_file set bash timeout=60 */
async function cmdToolOverride(args: string, ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  const current = settings.toolOverrides ?? {};
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0];
  if (!action || action === "list" || action === "show") {
    const allow = current.allow ?? [];
    const hide = current.hide ?? [];
    const cfg = current.perToolConfig ?? {};
    const out = `toolOverrides (project):\n  allow: ${allow.length ? allow.join(", ") : "(none)"}\n  hide: ${hide.length ? hide.join(", ") : "(none)"}\n  perToolConfig: ${Object.keys(cfg).length ? JSON.stringify(cfg) : "(none)"}`;
    ctx.ui.notify(out, "info");
    return;
  }
  const apply = (patch: Partial<NonNullable<Settings["toolOverrides"]>>) => {
    saveSettings("project", ctx.cwd, { toolOverrides: { ...current, ...patch } });
  };
  if (action === "allow" || action === "hide" || action === "unallow" || action === "unhide") {
    const tool = parts[1];
    if (!tool) {
      ctx.ui.notify(`Usage: /glla tooloverride ${action} <tool>`, "warning");
      return;
    }
    if (action === "allow") {
      const allow = current.allow ?? [];
      if (!allow.includes(tool)) apply({ allow: [...allow, tool] });
      ctx.ui.notify(`"${tool}" is now always visible to the agent (project override saved).`, "info");
    } else if (action === "hide") {
      const hide = current.hide ?? [];
      if (!hide.includes(tool)) apply({ hide: [...hide, tool] });
      ctx.ui.notify(`"${tool}" is now always hidden from the agent (project override saved).`, "info");
    } else if (action === "unallow") {
      apply({ allow: (current.allow ?? []).filter((t) => t !== tool) });
      ctx.ui.notify(`"${tool}" visibility override removed — the session decides again.`, "info");
    } else {
      apply({ hide: (current.hide ?? []).filter((t) => t !== tool) });
      ctx.ui.notify(`"${tool}" hide override removed — the session decides again.`, "info");
    }
    return;
  }
  if (action === "set" || action === "unset") {
    const tool = parts[1];
    const kv = parts[2];
    if (!tool || !kv) {
      ctx.ui.notify(`Usage: /glla tooloverride ${action} <tool> <key>[=<value>]`, "warning");
      return;
    }
    const cfg = { ...(current.perToolConfig ?? {}) };
    const toolCfg = { ...(cfg[tool] ?? {}) };
    if (action === "set") {
      const eq = kv.indexOf("=");
      if (eq < 0) {
        ctx.ui.notify(`set needs key=value: got "${kv}"`, "warning");
        return;
      }
      const k = kv.slice(0, eq);
      const v: unknown = parseToolOverrideValue(kv.slice(eq + 1));
      toolCfg[k] = v;
    } else {
      delete toolCfg[kv];
    }
    cfg[tool] = toolCfg;
    apply({ perToolConfig: cfg });
    ctx.ui.notify(
      action === "set"
        ? `"${tool}" setting saved: ${kv.slice(0, kv.indexOf("="))} = ${JSON.stringify(toolCfg[kv.slice(0, kv.indexOf("="))])} (project override).`
        : `"${tool}" setting "${kv}" removed — back to the built-in default.`,
      "info",
    );
    return;
  }
  ctx.ui.notify(`Unknown tooloverride action: ${action}. Use: list | allow | hide | unallow | unhide | set | unset.`, "warning");
}

/** Parse a tool-override value: numbers, booleans, JSON objects/arrays, else string. */
function parseToolOverrideValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return trimmed;
}

/** v0.27.5: /glla reviewer | postaudit — the post-completion audit config menu
 * (project-scoped). Reads the dual-write settings (postaudit wins over the
 * legacy reviewer key), and writes back to whichever key was read first —
 * so we don't drift two parallel config blocks. */
async function cmdReviewerSettings(ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  const block = (settings.postaudit ?? settings.reviewer) as Partial<ReviewerConfig> | undefined;
  const settingsKey: "postaudit" | "reviewer" = settings.postaudit !== undefined ? "postaudit" : "reviewer";
  if (!ctx.hasUI) {
    const cfg = resolveReviewerConfig(block);
    ctx.ui.notify(`${settingsKey} (project): ${JSON.stringify(cfg, null, 2)}`, "info");
    return;
  }
  const load = () => resolveReviewerConfig(loadSettings(ctx.cwd)[settingsKey] as Partial<ReviewerConfig> | undefined);
  const save = (patch: Partial<ReviewerConfig>) =>
    saveSettings("project", ctx.cwd, { [settingsKey]: { ...load(), ...patch } as Record<string, unknown> });
  for (;;) {
    const cfg = load();
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select("Postaudit — post-completion follow-up enqueuer (project settings)", reviewerMenuOptions(cfg));
    } catch {
      return;
    }
    if (!choice || choice === "Done") return;
    try {
      if (choice.startsWith("Enabled")) save({ enabled: !cfg.enabled });
      else if (choice.startsWith("Mode")) {
        // v0.27.9: 4-state cycle off → on → auto → aggressive → off
        const order: Array<"off" | "on" | "auto" | "aggressive"> = ["off", "on", "auto", "aggressive"];
        const i = order.indexOf(cfg.mode as typeof order[number]);
        const next = order[(i + 1) % order.length]!;
        save({ mode: next });
      }
      else if (choice.startsWith("Leverage mode")) save({ leverageMode: cfg.leverageMode === "fix-without-confirm" ? "confirm-all" : "fix-without-confirm" });
      else if (choice.startsWith("Fire on goal-complete")) save({ fireOn: cfg.fireOn.includes("goal-complete") ? cfg.fireOn.filter((e) => e !== "goal-complete") : [...cfg.fireOn, "goal-complete"] });
      else if (choice.startsWith("Fire on list-complete")) save({ fireOn: cfg.fireOn.includes("list-complete") ? cfg.fireOn.filter((e) => e !== "list-complete") : [...cfg.fireOn, "list-complete"] });
      else if (choice.startsWith("Cascade: audit-on-clean")) save({ cascade: cfg.cascade.includes("fire-audit-on-clean") ? cfg.cascade.filter((c) => c !== "fire-audit-on-clean") : [...cfg.cascade, "fire-audit-on-clean"] });
      else if (choice.startsWith("Max findings")) {
        const v = await ctx.ui.input("Max findings per review", "1-50");
        const n = Number(v?.trim());
        if (Number.isSafeInteger(n) && n >= 1 && n <= 50) save({ maxFindingsPerReview: n });
      } else if (choice.startsWith("Max reviews")) {
        const v = await ctx.ui.input("Max reviewer fires per day", "1-100");
        const n = Number(v?.trim());
        if (Number.isSafeInteger(n) && n >= 1 && n <= 100) save({ maxReviewsPerDay: n });
      }
    } catch (err) {
      // v0.28.11 (E7): a swallowed save failure made the user believe the
      // toggle landed. Loud now.
      ctx.ui.notify(`Postaudit setting NOT saved: ${err instanceof Error ? err.message : String(err)} — check .pi-glla/settings.json permissions.`, "warning");
    }
  }
}

/**
 * v0.25.2: /glla stats — one command, every project's rollup. Args:
 *   (none)            markdown table, all discovered projects
 *   json              machine-readable rollup (same schema as the table)
 *   premature         only projects with premature_success > 0, ratio-sorted
 *   project=<path>    limit the scan to one project
 */
function cmdStats(args: string, ctx: ExtensionContext): void {
  const asJson = /\bjson\b/.test(args);
  const prematureOnly = /\bpremature\b/.test(args);
  const projectMatch = args.match(/project=(\S+)/);
  let rollups: ProjectRollup[] = [];
  if (projectMatch) {
    const p = projectMatch[1]!.replace(/^~/, os.homedir());
    const r = rollupProject(p);
    if (!r) {
      ctx.ui.notify(`/glla stats: no .pi-glla/active.jsonl under ${p}`, "warning");
      return;
    }
    rollups = [r];
  } else {
    const projects = discoverGllaProjects({ cwd: ctx.cwd });
    for (const p of projects) {
      const r = rollupProject(p);
      if (r) rollups.push(r);
    }
    if (rollups.length === 0) {
      ctx.ui.notify("/glla stats: no projects with .pi-glla/active.jsonl found on this rig.", "info");
      return;
    }
  }
  if (prematureOnly) rollups = filterPremature(rollups);
  const out = asJson ? formatRollupJson(rollups) : formatRollupTable(rollups);
  ctx.ui.notify(`glla stats — ${rollups.length} project(s)${prematureOnly ? " (premature filter)" : ""}\n${out}`, "info");
}

/**
 * v0.25.4: /glla audits [N|full] — browse the durable per-project audit
 * log (.pi-glla/audits.jsonl). Default: last 10 verdicts, one line each.
 * "full" prints the latest report in full.
 */
/**
 * v0.28.28: /glla log [N] — human-readable tail of the event ledger (the
 * forensic trail: who created/resumed/paused goals, from where). Skips the
 * high-frequency noise entries (state snapshots, re-arm internals) unless
 * "all" is passed. N defaults to 15.
 */
const LOG_NOISE = new Set(["state", "send_rearm_start", "heartbeat_suppressed_tick"]);
function cmdLog(args: string, ctx: ExtensionContext): void {
  const all = /\ball\b/.test(args);
  const nMatch = args.match(/\b(\d+)\b/);
  const n = Math.min(Math.max(parseInt(nMatch?.[1] ?? "15", 10) || 15, 1), 100);
  let entries: Array<{ type: string; at?: string; value?: any }> = [];
  try {
    entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
  } catch {
    ctx.ui.notify("No ledger yet — .pi-glla/active.jsonl doesn't exist.", "info");
    return;
  }
  const visible = all ? entries : entries.filter((e) => !LOG_NOISE.has(e.type));
  const tail = visible.slice(-n);
  if (tail.length === 0) {
    ctx.ui.notify("Ledger is empty (no non-noise events yet).", "info");
    return;
  }
  const lines = tail.map((e) => {
    const t = (e.at ?? "").slice(11, 19);
    const v = e.value ?? {};
    const detail = Object.entries(v)
      .filter(([k]) => k !== "goalId" && k !== "report")
      .map(([k, val]) => `${k}=${typeof val === "string" ? val.slice(0, 60) : JSON.stringify(val)?.slice(0, 60)}`)
      .join(" ");
    return `${t}  ${e.type}${detail ? `  ${detail}` : ""}`;
  });
  ctx.ui.notify(`Ledger tail (last ${tail.length}${all ? "" : " non-noise"} events — /glla log <N> for more, /glla log all to include noise):\n${lines.join("\n")}`, "info");
}

/**
 * v0.28.31 (renamed v0.28.33): /glla wipe — ONE confirmed command that leaves a project with
 * zero live glla state. User directive: "make sure we only have one goal or
 * loop or list at a time — many of my older projects have leftovers" (the
 * fleet scan found queued lists up to 56 deep, held loops at iter 50, and
 * paused goals across ~10 projects). The goal is archived HONESTLY (aborted
 * — lands in goals/ + the archive, reviewer's abort-suppression applies),
 * the list is cleared, the loop record is wiped after a graceful stop.
 * History stays in .pi-glla; only the live state goes.
 */
async function cmdGllaWipe(ctx: ExtensionContext): Promise<void> {
  const g = state.goal;
  const live = g && (g.status === "active" || g.status === "paused" || g.status === "auditing");
  const n = listQueue().length;
  const loop = state.loop;
  if (!g && n === 0 && !loop) {
    ctx.ui.notify("glla state is already clean — no goal, no list, no loop.", "info");
    return;
  }
  const parts: string[] = [];
  if (live) parts.push(`goal archived as aborted: ${g!.objective.replace(/\s+/g, " ").slice(0, 70)}`);
  else if (g) parts.push(`terminal goal record cleared (${g.status})`);
  if (n > 0) parts.push(`list cleared (${n} item${n === 1 ? "" : "s"})`);
  if (loop) parts.push(`loop ${loop.active ? "stopped" : "cleared"} (iter ${loop.iteration}${loop.bestValue !== null && loop.bestValue !== undefined ? `, best ${loop.bestValue}` : ""})`);
  if (ctx.hasUI) {
    try {
      const ok = await ctx.ui.confirm("Wipe glla state?", `${parts.map((p) => `  ${p}`).join("\n")}\n\nHistory stays in .pi-glla (archive + ledger); the live state is wiped.`);
      if (!ok) {
        ctx.ui.notify("Wipe cancelled.", "info");
        return;
      }
    } catch {
      ctx.ui.notify("Wipe cancelled.", "info");
      return;
    }
  }
  appendLedger(ctx.cwd, "glla_wipe", { goalId: live ? g!.id : undefined, listCleared: n, loop: loop ? { iteration: loop.iteration, active: loop.active } : undefined });
  if (live) {
    archiveCurrentGoal(ctx, "aborted", "user wipe (/glla wipe)");
    ctx.abort();
  } else if (g) {
    state = { ...state, goal: null };
  }
  if (n > 0) {
    state = { ...state, list: [] };
    appendLedger(ctx.cwd, "list_cleared", { via: "glla_wipe" });
  }
  if (loop) {
    clearLoopTimer();
    state.loop = undefined;
    await finishLoopGit(ctx, loop);
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user wipe (/glla wipe)", iterations: loop.iteration, best: loop.bestValue });
  }
  persistState(ctx);
  ctx.ui.notify(`glla wipe done: ${parts.join(" · ")}. Clean slate.`, "info");
  notifyExternal(ctx, "glla state wiped by user — clean slate.");
}

/**
 * v0.28.32: /glla resume — resume WHATEVER is resumable, without the user
 * needing to know whether they're supervising a goal, a list item, or a
 * held loop. Safe because one-active-thing is enforced (v0.28.14+): at
 * most one thing can be ACTIVE, so the only ambiguity is paused-goal +
 * held-loop coexisting (nothing running, two resumables — e.g. polis
 * today) → the v0.28.23 decision-picker pattern. Verbs whose semantics
 * genuinely differ per type (tweak/finish/next/decide/refine) stay typed.
 */
async function cmdGllaResume(ctx: ExtensionContext): Promise<void> {
  // v0.29.12: a zombie instance (handle dead after session replacement)
  // used to answer "Nothing to resume" — the resume path must name the
  // real recovery (/reload rebuilds extensions in place), not mislead.
  if (warnIfStaleAtEntry(ctx, "/glla resume")) return;
  const g = state.goal;
  const goalResumable = g && g.status === "paused";
  const loopResumable = state.loop && !state.loop.active && state.loop.stopReason === HELD_ON_RESTORE;
  if (goalResumable && loopResumable) {
    if (ctx.hasUI) {
      try {
        const loopLabel = `Resume the held loop (iter ${state.loop!.iteration}, best ${state.loop!.bestValue ?? "n/a"}): ${state.loop!.target.replace(/\s+/g, " ").slice(0, 80)}`;
        const pick = await ctx.ui.select("Two things can resume — which one?", [
          `Resume the ${g!.policy === "list" ? "list item" : "goal"}: ${g!.objective.replace(/\s+/g, " ").slice(0, 80)}`,
          loopLabel,
        ]);
        if (pick === undefined) {
          ctx.ui.notify("Resume cancelled.", "info");
          return;
        }
        if (pick === loopLabel) {
          await cmdLoop("resume", ctx);
          return;
        }
        await cmdResume(ctx);
        return;
      } catch {
        // picker failed — fall through to goal-first
      }
    }
    await cmdResume(ctx);
    return;
  }
  if (goalResumable) {
    await cmdResume(ctx);
    return;
  }
  if (loopResumable) {
    await cmdLoop("resume", ctx);
    return;
  }
  // v0.34.3: an ACTIVE-but-idle goal is exactly what the user means by
  // "resume" (hellhunter 2026-08-01: widget said "list item · active", the
  // agent sat idle after a prose-only turn — the continuation that should
  // drive the new head never landed — and /glla resume shrugged "Nothing to
  // resume"). Re-kick the continuation instead of shrugging.
  if (g && g.status === "active") {
    appendLedger(ctx.cwd, "resume_rekick", { goalId: g.id, policy: g.policy });
    // v0.34.7: the re-kick fulfills the stale-handle marker's promise too
    // (junk-runner/polis/neonbreak 2026-08-01: actively working with the
    // ⚠ interrupted banner still screaming — the v0.34.2 clear only lived
    // in the paused-resume path; the staleness entry-guard above already
    // filtered out a stale session reaching this branch).
    if (g.interruptedAt) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
    ctx.ui.notify(
      `The ${g.policy === "list" ? "list item" : "goal"} is ACTIVE but idle — re-firing its continuation: ${g.objective.replace(/\s+/g, " ").slice(0, 70)}`,
      "info",
    );
    scheduleContinuation(ctx, true);
    return;
  }
  if (g && g.status === "auditing") {
    ctx.ui.notify("An audit is in flight — wait for the isolated auditor's verdict (the status line shows auditing…).", "info");
    return;
  }
  if (state.loop?.active) {
    appendLedger(ctx.cwd, "resume_rekick", { loop: true, iteration: state.loop.iteration });
    ctx.ui.notify(`The loop is ACTIVE — re-firing its tick (iteration ${state.loop.iteration}). If it wedges again, /loop status for the diagnostics.`, "info");
    scheduleLoopTick(ctx);
    return;
  }
  ctx.ui.notify("Nothing to resume — no paused goal/list-item, no held loop. /goal, /list, or /loop to start something.", "info");
}

/**
 * v0.28.32: /glla cancel — cancel the ONE live thing, uniformly: a goal or
 * list item is archived as aborted (its queue is untouched), an active or
 * held loop is stopped. Same outcome shape regardless of hidden type —
 * the user's caveat ("this sucks if one command doesn't work for others")
 * is why /list cancel (item + drop queue) and /glla wipe (nuke all)
 * remain the power verbs instead of being folded in.
 */
async function cmdGllaCancel(ctx: ExtensionContext): Promise<void> {
  const g = state.goal;
  if (g && (g.status === "active" || g.status === "paused" || g.status === "auditing")) {
    await cmdCancel(ctx);
    return;
  }
  if (state.loop) {
    await cmdLoop("stop", ctx);
    return;
  }
  ctx.ui.notify("Nothing to cancel — no active/paused goal/list-item, no loop. Queued list items: /list clear; everything: /glla wipe.", "info");
}

function cmdAudits(args: string, ctx: ExtensionContext): void {
  const full = /\bfull\b/.test(args);
  const all = /\b(?:all|global|log)\b/.test(args);
  const nMatch = args.match(/\b(\d+)\b/);
  if (full) {
    // Latest report — active goal's history first, then the log.
    const fromGoal = state.goal?.auditHistory?.at(-1);
    if (fromGoal?.report) {
      ctx.ui.notify(`Latest audit on this goal — ${fromGoal.model} (${fromGoal.at})\n${fromGoal.report}`, "info");
      return;
    }
    const latest = readAuditLog(ctx.cwd).at(-1);
    ctx.ui.notify(latest ? `Latest audit — ${latest.verdict} (${latest.model}, ${latest.at})\n${latest.report}` : "No audits logged yet.", "info");
    return;
  }
  // Default: the ACTIVE goal's own audit history (with per-audit elapsed);
  // "all"/"global"/"log" browses the durable cross-goal log.
  if (!all && state.goal?.auditHistory && state.goal.auditHistory.length > 0) {
    ctx.ui.notify(
      `glla audits — this goal's history (${state.goal.auditHistory.length} verdict(s); /glla audits all for the project log)\n${formatGoalAuditHistory(state.goal)}`,
      "info",
    );
    return;
  }
  const n = nMatch ? Number(nMatch[1]) : 10;
  const entries = readAuditLog(ctx.cwd, n);
  ctx.ui.notify(`glla audits — last ${entries.length} verdict(s) in ${ctx.cwd}\n${formatAuditLog(entries)}`, "info");
}

// v0.29.8: /glla status — the unified "what's running" surface (user: "we
// need to type goal status [to check], so that command at least is missing
// for checking on whatever active process we have"). Read-only aggregate of
// the ONE state — goal, list queue, loop, pending decisions — with pointers
// to the deep surfaces.
function cmdGllaStatus(ctx: ExtensionContext): void {
  const lines: string[] = [];
  const g = state.goal;
  if (g) {
    const tok = (g.usage?.tokensUsed ?? 0) > 0 ? ` · ${g.usage!.tokensUsed} tok` : "";
    const audit = g.status === "auditing" ? " (auditor running…)" : "";
    const pause = g.status === "paused" && g.pauseReason ? ` — ${g.pauseReason.slice(0, 90)}` : "";
    lines.push(`goal [${g.policy}] ${g.status}${audit}${tok}: ${g.objective.slice(0, 90)}${pause}`);
  } else {
    lines.push("goal: none");
  }
  const q = listQueue();
  lines.push(`list: ${q.length === 0 ? "empty" : `${q.length} queued — head: ${(q[0]?.objective ?? "").slice(0, 70)}`}`);
  const l = state.loop;
  if (l) {
    lines.push(`loop: ${l.active ? "ACTIVE" : `held/stopped — ${l.stopReason ?? "n/a"}`} · iter ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"} · best ${l.bestValue ?? "n/a"} · stall ${l.stallCount} — ${l.target.slice(0, 60)}`);
  } else {
    lines.push("loop: none");
  }
  if (g?.status === "paused" && g.pauseKind === "decision" && g.pauseOptions?.length) {
    lines.push(`decision pending (${g.pauseOptions.length} options) — /goal decide`);
  }
  lines.push("deep: /goal status · /list · /loop status · /glla stats · /glla audits · /glla log");
  ctx.ui.notify(`glla status\n${lines.join("\n")}`, "info");
}

async function cmdSettings(args: string, ctx: ExtensionContext): Promise<void> {
  // The plugin's ONE config surface — global by default, rarely opened.
  //   /glla                      show effective values + where each comes from
  //   /glla model=provider/id    write to GLOBAL config
  //   /glla thinking=high        write to GLOBAL config
  //   /glla notify='cmd $1'      write to GLOBAL config
  //   /glla tokenlimit=2000000   write to GLOBAL config
  //   /glla wedgealert=30         hung-command alert minutes (0=off, unset=30)
  //   /glla auditfeedbackchars=800 cap executor-visible disapproval report (0=full, the default)
  //   /glla project model=...    write to PROJECT override (rare)
  //   /glla model=unset          remove key (from global; project model=unset for project)
  //   /glla stats [json|premature|project=<path>]   per-project ledger rollups (v0.25.2)
  const trimmed = args.trim();
  // v0.25.2: /glla stats sub-mode — cross-project telemetry rollups.
  if (/^stats\b/.test(trimmed)) {
    cmdStats(trimmed.slice("stats".length).trim(), ctx);
    return;
  }
  if (/^audits\b/.test(trimmed)) {
    cmdAudits(trimmed.slice("audits".length).trim(), ctx);
    return;
  }
  // v0.29.8: /glla status — the unified what's-running view.
  if (/^status\b/.test(trimmed)) {
    cmdGllaStatus(ctx);
    return;
  }
  // v0.28.28: /glla log [N] — the raw event trail, human-readable. "Log it
  // so we can look back and see where we are doing things wrong."
  if (/^log\b/.test(trimmed)) {
    cmdLog(trimmed.slice("log".length).trim(), ctx);
    return;
  }
  // v0.28.33: renamed reset → wipe — "reset" sat at edit-distance 2 from
  // "resume" in the same namespace, and it's the destructive one (user
  // catch, same day it shipped, before any muscle memory formed).
  if (/^wipe\b/.test(trimmed)) {
    await cmdGllaWipe(ctx);
    return;
  }
  if (/^reset\b/.test(trimmed)) {
    ctx.ui.notify("/glla reset is now /glla wipe (renamed — too close to /glla resume). Nothing was done.", "info");
    return;
  }
  // v0.28.32: /glla resume + /glla cancel — type-blind verbs over the ONE
  // live thing ("so we don't have to check what type we are running").
  if (/^resume\b/.test(trimmed)) {
    await cmdGllaResume(ctx);
    return;
  }
  if (/^cancel\b/.test(trimmed)) {
    await cmdGllaCancel(ctx);
    return;
  }
  if (/^reviewer\b/.test(trimmed)) {
    await cmdReviewerSettings(ctx);
    return;
  }
  // v0.27.5: postaudit is the new vocabulary (the post-completion auditor).
  // Both keywords open the same config menu and resolve to the same settings
  // key — the legacy `reviewer` label is kept for backwards compatibility.
  if (/^postaudit\b/.test(trimmed)) {
    await cmdReviewerSettings(ctx);
    return;
  }
  // v0.27.9: per-tool overrides — sub-mode `tooloverride <action> <tool>`
  if (/^tooloverride\b/.test(trimmed)) {
    await cmdToolOverride(trimmed.slice("tooloverride".length).trim(), ctx);
    return;
  }
  if (!trimmed) {
    if (ctx.hasUI) {
      await openSettingsUI(ctx);
      return;
    }
    // Headless fallback: text display with provenance.
    const prov = settingsProvenance(ctx.cwd);
    const fmt = (k: keyof Settings, label: string) => {
      const p = prov[k];
      const v = p.value === undefined ? "(unset)" : String(p.value);
      return `${label}: ${v}  [${p.source}]`;
    };
    ctx.ui.notify(
      [
        fmt("auditorModel", "auditorModel"),
        fmt("auditorThinkingLevel", "thinking"),
        fmt("notifyCmd", "notify"),
        fmt("tokenLimit", "tokenLimit"),
        fmt("autoResume", "autoResume"),
        fmt("autoAcceptDrafts", "autoAccept"),
        fmt("auditCap", "auditCap"),
        fmt("auditFeedbackChars", "auditFeedbackChars"),
        fmt("aggressiveMode", "aggressiveMode"),
        fmt("quotaRetryMinutes", "quotaRetryMinutes"),
        fmt("stuckMaxInterventions", "stuckMaxInterventions"),
        fmt("stallEscalationRefires", "stallEscalation"),
        fmt("wedgeAlertMinutes", "wedgeAlert"),
        fmt("stallShortWords", "stallShortWords"),
        fmt("stallSimilarityThreshold", "stallSimilarityThreshold"),
        // v0.27.5: post-completion auditor config — read either the new
        // `postaudit` key or the legacy `reviewer` key (postaudit wins).
        `postaudit: ${JSON.stringify(loadSettings(ctx.cwd).postaudit ?? loadSettings(ctx.cwd).reviewer ?? {}) || '(unset — defaults)'}`,
        // v0.25.6: effective per-type subagent model resolution.
        ...["Explore", "Plan", "general-purpose"].map(
          (t) => `subagent ${t}: ${resolveEffectiveSubagentModel(t, loadSettings(ctx.cwd), (ctx.model as any)?.id ? `${(ctx.model as any).provider}/${(ctx.model as any).id}` : undefined)}`,
        ),
        `\nglobal:  ${globalSettingsPath()}`,
        `project: ${projectSettingsPath(ctx.cwd)}`,
        `Set with: /glla key=value (global) · /glla project key=value (project override)`,
      ].join("\n"),
      "info",
    );
    return;
  }
  // Optional scope prefix: "project" writes the project override; default is global.
  let scope: "global" | "project" = "global";
  let rest = trimmed;
  if (/^project\s+/i.test(rest)) {
    scope = "project";
    rest = rest.replace(/^project\s+/i, "");
  }
  const patch: Partial<Settings> = {};
  let changed = false;
  // Quote-aware key=value parsing: notify='echo $1 >> /tmp/log' must survive
  // with its spaces intact (naive whitespace splitting mangled it to "'echo").
  const kvRe = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = kvRe.exec(rest)) !== null) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (key === "model" || key === "auditormodel") {
      patch.auditorModel = value === "unset" ? undefined : value;
      changed = true;
    } else if (key === "notify" || key === "notifycmd") {
      patch.notifyCmd = value === "unset" ? undefined : value;
      changed = true;
    } else if (key === "tokenlimit") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) {
        patch.tokenLimit = n;
        changed = true;
      } else {
        ctx.ui.notify(`tokenlimit must be a positive integer, got: ${value}`, "warning");
      }
    } else if (key === "wedgealert") {
      if (value === "unset") {
        patch.wedgeAlertMinutes = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n >= 0) {
          patch.wedgeAlertMinutes = n; // 0 = off; unset = default 30
          changed = true;
        } else {
          ctx.ui.notify(`wedgealert must be a non-negative integer (minutes, 0 = off), got: ${value}`, "warning");
        }
      }
    } else if (key === "autoresume") {
      if (["on", "true", "1", "yes"].includes(value)) {
        patch.autoResume = true;
        changed = true;
      } else if (["off", "false", "0", "no", "unset"].includes(value)) {
        patch.autoResume = false; // v0.26.8: explicit off must persist — undefined now means ON
        changed = true;
      } else {
        ctx.ui.notify(`autoresume must be on or off, got: ${value}`, "warning");
      }
    } else if (key === "decisionpopup") {
      if (["on", "true", "1", "yes"].includes(value)) {
        patch.decisionPopup = true;
        changed = true;
      } else if (["off", "false", "0", "no"].includes(value)) {
        patch.decisionPopup = false;
        changed = true;
      } else {
        ctx.ui.notify(`decisionpopup must be on or off, got: ${value}`, "warning");
      }
    } else if (key === "carryover") {
      if (["resume", "pause", "clear"].includes(value)) {
        patch.carryover = value as "resume" | "pause" | "clear";
        changed = true;
        ctx.ui.notify(`carryover=${value}: ${value === "clear" ? "stale goals/lists/held-loops are dropped when new work activates" : value === "pause" ? "stale carryover is surfaced in one summary when new work activates (default)" : "legacy behavior — carryover stacks silently"}.`, "info");
      } else {
        ctx.ui.notify(`carryover must be resume, pause, or clear, got: ${value}`, "warning");
      }
    } else if (key === "autoaccept") {
      if (["on", "true", "1", "yes"].includes(value)) {
        patch.autoAcceptDrafts = true;
        changed = true;
        ctx.ui.notify("autoaccept=on: drafts will ACTIVATE without the Confirm dialog (the interview floor is skipped too — the seed is the intent). /glla autoaccept=off restores the gate.", "warning");
      } else if (["off", "false", "0", "no", "unset"].includes(value)) {
        patch.autoAcceptDrafts = undefined;
        changed = true;
      } else {
        ctx.ui.notify(`autoaccept must be on or off, got: ${value}`, "warning");
      }
    } else if (key === "auditcap") {
      if (["off", "unset", "default"].includes(value)) {
        patch.auditCap = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0) {
          patch.auditCap = n;
          changed = true;
        } else {
          ctx.ui.notify(`auditcap must be a non-negative integer (0 = unlimited), got: ${value}`, "warning");
        }
      }
    } else if (key === "auditfeedbackchars") {
      if (["unset", "default"].includes(value)) {
        patch.auditFeedbackChars = undefined;
        changed = true;
      } else {
        const n = Number(value);
        if (/^\d+$/.test(value) && Number.isSafeInteger(n)) {
          patch.auditFeedbackChars = n;
          changed = true;
        } else {
          ctx.ui.notify(`auditfeedbackchars must be a non-negative integer (0 = full report), got: ${value}`, "warning");
        }
      }
    } else if (key === "aggressivemode" || key === "aggressive") {
      if (["on", "true", "1", "yes"].includes(value)) {
        patch.aggressiveMode = true;
        changed = true;
        ctx.ui.notify("aggressivemode=on: autoResume, audit cap 10, stuck max 10, wedge off, quota auto-retry — and audit-cap disapprovals become TODOs while the goal KEEPS GOING. Explicit per-key settings still win.", "warning");
      } else if (["off", "false", "0", "no", "unset"].includes(value)) {
        patch.aggressiveMode = undefined;
        changed = true;
      } else {
        ctx.ui.notify(`aggressivemode must be on or off, got: ${value}`, "warning");
      }
    } else if (key === "quotaretryminutes") {
      if (["unset", "default"].includes(value)) {
        patch.quotaRetryMinutes = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n > 0) {
          patch.quotaRetryMinutes = n;
          changed = true;
        } else {
          ctx.ui.notify(`quotaretryminutes must be a positive integer, got: ${value}`, "warning");
        }
      }
    } else if (key === "stallescalation" || key === "stallescalationrefires") {
      if (["unset", "default"].includes(value)) {
        patch.stallEscalationRefires = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n >= 0) {
          patch.stallEscalationRefires = n;
          changed = true;
        } else {
          ctx.ui.notify(`stallescalation must be a non-negative integer (0 = never escalate), got: ${value}`, "warning");
        }
      }
    } else if (key === "stuckmax" || key === "stuckmaxinterventions") {
      if (["unset", "default"].includes(value)) {
        patch.stuckMaxInterventions = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n > 0) {
          patch.stuckMaxInterventions = n;
          changed = true;
        } else {
          ctx.ui.notify(`stuckmax must be a positive integer, got: ${value}`, "warning");
        }
      }
    } else if (key === "stallshortwords" || key === "stallshort") {
      if (["unset", "default"].includes(value)) {
        patch.stallShortWords = undefined;
        changed = true;
      } else {
        const n = Number.parseInt(value, 10);
        if (Number.isInteger(n) && n >= 1) {
          patch.stallShortWords = n;
          changed = true;
        } else {
          ctx.ui.notify(`stallshortwords must be a positive integer, got: ${value}`, "warning");
        }
      }
    } else if (key === "stallsim" || key === "stallsimilaritythreshold") {
      if (["unset", "default"].includes(value)) {
        patch.stallSimilarityThreshold = undefined;
        changed = true;
      } else {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n) && n >= 0 && n <= 1) {
          patch.stallSimilarityThreshold = n;
          changed = true;
        } else {
          ctx.ui.notify(`stallsimilaritythreshold must be between 0 and 1, got: ${value}`, "warning");
        }
      }
    } else if (key === "thinking" || key === "auditorthinkinglevel") {
      if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
        patch.auditorThinkingLevel = value as Settings["auditorThinkingLevel"];
        changed = true;
      } else {
        ctx.ui.notify(`Unknown thinking level: ${value}`, "warning");
      }
    }
  }
  if (!changed) {
    ctx.ui.notify("Nothing changed. Use key=value (model, thinking, notify, tokenlimit, autoresume, decisionpopup, carryover, auditcap, auditfeedbackchars, aggressivemode, quotaretryminutes, stuckmax), optionally prefixed with 'project'.", "info");
    return;
  }
  saveSettings(scope, ctx.cwd, patch);
  const effective = loadSettings(ctx.cwd);
  ctx.ui.notify(
    `Saved to ${scope} config. Effective now: model=${effective.auditorModel ?? "(session model)"} thinking=${effective.auditorThinkingLevel ?? "(session)"} notify=${effective.notifyCmd ?? "(off)"} tokenLimit=${effective.tokenLimit ?? 0}${(effective.tokenLimit ?? 0) > 0 ? "" : " (off)"} autoResume=${effective.autoResume === true ? "on" : effective.autoResume === false ? "off" : "default (hold on load)"} auditFeedbackChars=${effective.auditFeedbackChars ?? DEFAULT_AUDIT_FEEDBACK_CHARS}${(effective.auditFeedbackChars ?? DEFAULT_AUDIT_FEEDBACK_CHARS) === 0 ? " (full report)" : ""}\n` +
    `Note: the auditor runs without extensions — it must be a built-in provider, not an extension-registered one.`,
    "info",
  );
}

// =================================================================
// Command-collision detector (PLAN.md D1)
//
// pi's runner.js resolveRegisteredCommands() never throws on duplicate
// command names: the first registrant keeps the bare name, later ones
// become "goal:2", "list:3", etc. So a collision degrades UX silently.
// We detect duplicates at session start and warn loudly once.
// =================================================================

const OUR_COMMANDS = ["goal", "glla", "list", "loop"];
let collisionWarned = false;

// Providers known to pi core. The auditor inherits the already-resolved
// Model object from this session (in-process createAgentSession), so a
// provider defined in ~/.pi/agent/models.json with auth.json credentials
// works even though it is not "built-in". Unknown providers get a soft
// one-time conditional notice: if audits error with auth failures, an
// explicit /glla model= override is the fix. (v0.22.0: reworded from the
// stale "extension-registered → auditor fails auth" premise.)
const KNOWN_BUILTIN_PROVIDERS = new Set([
  "anthropic", "google", "google-vertex", "google-gemini-cli", "openai", "openai-codex",
  "openrouter", "opencode", "azure-openai-responses", "groq", "cerebras", "xai", "zai",
  "minimax", "minimax-cn", "moonshotai", "kimi-coding", "github-copilot", "mistral", "huggingface",
]);
let providerWarned = false;

function warnIfAuditorProviderRisky(ctx: ExtensionContext): void {
  if (providerWarned) return;
  providerWarned = true;
  try {
    const settings = loadSettings(ctx.cwd);
    if (settings.auditorModel) return; // explicit auditor model — user's call
    const provider = (ctx.model as any)?.provider as string | undefined;
    if (!provider || KNOWN_BUILTIN_PROVIDERS.has(provider)) return;
    ctx.ui.notify(
      `pi-goal-list-loop-audit: session provider "${provider}" is not a known built-in. The auditor inherits the resolved model in-process, so this usually works — but if audits error with auth/provider failures, set an explicit override once: /glla model=provider/id`,
      "info",
    );
  } catch {
    // non-fatal by design
  }
}

function warnOnCommandCollision(ctx: ExtensionContext): void {
  if (collisionWarned) return;
  collisionWarned = true;
  try {
    if (!extensionApi) return;
    const counts = new Map<string, number>();
    for (const cmd of extensionApi.getCommands() as any[]) {
      const name = String(cmd.invocationName ?? cmd.name ?? "").split(":")[0] ?? "";
      if (OUR_COMMANDS.includes(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => `/${n}`);
    if (dupes.length > 0) {
      const first = dupes[0] ?? "goal";
      ctx.ui.notify(
        `pi-goal-list-loop-audit: command collision on ${dupes.join(", ")}. Another extension registered the same name; ours may be reachable as /${first.slice(1)}:2. Consider disabling the other plugin.`,
        "warning",
      );
    }
  } catch {
    // getCommands unavailable or shape changed — stay silent, collision is non-fatal.
  }
}

// =================================================================
// Public extension entry
// =================================================================

export default function (pi: ExtensionAPI): void {
  extensionApi = pi;
  extensionApiStale = false; // a fresh factory run means a fresh runtime (reload path)
  resetLengthContinue(); // v0.27.2: fresh runtime, fresh truncation streak
  startHeartbeat();
  startUITicker();
  // Four top-level commands, that's all (v0.8.0 consolidation):
  //   /goal  — set/draft + status|pause|resume|cancel|tweak|archive subcommands
  //   /list — the list (add|show|next|remove|clear)
  //   /loop  — the metric loop (draft|start|status|stop)
  //   /glla   — the settings UI (+ scriptable key=value)
  // v0.22.5: subcommand autocomplete for the /-menu.
  // v0.27.4: pi's applyCompletion does NOT add a trailing space for argument
  // completions (it does for the top-level /goal itself). Without a trailing
  // space the user has to press Space before typing — and if they forget
  // they end up with `/goal startasdahlasf` (goal.ts:3545 area). Items whose
  // value ends in `=` (key=value pairs — the user types the value right
  // after the `=`) get no space; everything else gets a single trailing
  // space. `label` stays clean for the picker display.
  const completions = (items: Array<[string, string]>) => (prefix: string) =>
    items
      .filter(([value]) => value.startsWith(prefix))
      .map(([value, description]) => ({
        value: value.endsWith("=") ? value : value + " ",
        label: value,
        description,
      }));

  pi.registerCommand("goal", {
    description: "Set/draft a goal, or /goal status|pause|resume|cancel|tweak <text>|archive|start <objective>. Objectives without a 'Done when:' clause are grilled into a contract first; include the clause or use /goal start to skip the interview and activate instantly.",
    getArgumentCompletions: completions([
      ["start", "skip drafting — /goal start <objective> activates immediately"],
      ["audit", "one-shot project audit goal: /goal audit [focus] — fix the non-decisions, present the decisions (v0.29.8)"],
      ["verify", "run the isolated auditor on the current goal NOW (v0.28.27, renamed from /goal audit)"],
      ["status", "show the active goal and its task list"],
      ["pause", "pause the active goal"],
      ["resume", "resume a paused goal (and the list, when items are queued)"],
      ["cancel", "abort the active goal"],
      ["decide", "re-open the decision picker for a decision pause"],
      ["tweak", "change the objective: /goal tweak <text>"],
      ["archive", "list archived goals"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdGoal(args, ctx); },
  });
  const settingsHandler = (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdSettings(args, ctx); };
  pi.registerCommand("glla", {
    description: "Open the settings UI for goals, loops, lists, and the auditor. Scriptable form: /glla key=value · /glla project key=value",
    getArgumentCompletions: completions([
      ["model=", "auditor model override: /glla model=provider/id"],
      ["thinking=", "auditor thinking level: /glla thinking=high"],
      ["notify=", "desktop push command: /glla notify='notify-send pi \"$1\"'"],
      ["tokenlimit=", "per-goal token budget (0 = off): /glla tokenlimit=2000000"],
      ["autoresume=", "default: hold when a session is loaded, auto-resume on reload/fork; on: always auto-resume; off: never"],
      ["decisionpopup=", "on|off: decision pauses pop the select() picker (default on; the widget card always lists the options, /goal decide reopens the picker)"],
      ["auditcap=", "N: pause goal after N consecutive auditor disapprovals (default 5, 0 = unlimited)"],
      ["status", "unified what's-running view: goal + list queue + loop + pending decisions (v0.29.8)"],
      ["log", "event-trail tail: /glla log [N] — who created/resumed/paused what, from where (v0.28.28)"],
      ["wipe", "WIPE live glla state (goal archived, list cleared, loop stopped) — one-shot cleanup for leftover-laden projects"],
      ["resume", "resume WHATEVER is paused/held (goal, list item, or held loop) — no need to know the type"],
      ["cancel", "cancel the ONE live thing uniformly (goal/list item archived, loop stopped) — queue untouched; /list clear or /glla wipe for more"],
      ["auditfeedbackchars=", "cap on executor-visible disapproval report chars (0 = full report, the default)"],
      ["aggressivemode=", "on: keep-going defaults — autoResume, cap 10, stuck 10, wedge off, quota auto-retry, cap→TODOs"],
      ["quotaretryminutes=", "N: minutes before auto-retrying a quota-exhausted auditor (default 60)"],
      ["stuckmax=", "N: consecutive stuck interventions before a loop stops (default 5)"],
      ["stallescalation=", "N: heartbeat refires without a turn before goal pauses / loop stops (default 5, 0 = never)"],
      ["stats", "per-project ledger rollups: /glla stats [json|premature|project=<path>]"],
      ["audits", "audit-log browser: /glla audits [N|full] — recent verdicts from .pi-glla/audits.jsonl"],
      ["autoaccept=", "on: drafts activate without the Confirm dialog (unattended rigs)"],
      ["reviewer", "reviewer config menu (alias of postaudit — post-completion follow-up enqueuer)"],
      ["postaudit", "post-completion audit config menu (the new name for /glla reviewer)"],
      ["project", "write a project override: /glla project key=value"],
    ]),
    handler: settingsHandler,
  });
  pi.registerCommand("review", {
    description: "Manually run the postaudit on an archived goal: /review <goal-id> [off|on|auto|aggressive] — extracts findings, writes a report to .pi-glla/reviews/, cascades per the mode (auto/aggressive = no Confirms). Bypasses the trigger gates (explicit user request).",
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdReview(args, ctx); },
  });
  pi.registerCommand("list", {
    description: "Loop 2: the list of audited goals — order is the default, not the law. /list <describe tasks or name a plan file> (dumps get shaped into items, files import, 'Done when:' adds directly) | /list audit [focus] (collect findings, then drain them as items) | /list show | /list resume | /list next [n] | /list remove <n> | /list clear | /list cancel",
    getArgumentCompletions: completions([
      ["show", "display the waiting items"],
      ["audit", "collect-then-drain: audit the project, queue every finding as its own item"],
      ["resume", "resume the paused list item (the list's head)"],
      ["next", "activate the next item (or /list next <n> for position n)"],
      ["remove", "remove an item: /list remove <n>"],
      ["clear", "empty the list"],
      ["depth", "queue depth, oldest item age, average item duration"],
      ["cancel", "stop the whole list: abort the active item + drop all waiting"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdList(args, ctx); },
  });
  pi.registerCommand("loop", {
    description: "Loop 3: metric-driven process — it never completes. /loop <target> drafts the metric with you · /loop start \"<target>\" = infinite metricless loop (no plateau, no cap; ends at time=/tokens= or /loop stop) · /loop respec = infinite metricless reconcile against the root SPEC.md · add measure=\"<cmd>\" direction=min|max [window=5] [max=50] [branch=1] for a metric loop · /loop status · /loop stop (alias /loop cancel). 'Improve until X' is a /goal, not a loop.",
    getArgumentCompletions: completions([
      ["start", "skip drafting: /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50]"],
      ["respec", "infinite metricless loop reconciling the codebase against the root SPEC.md"],
      ["audit", "project-audit loop: each iteration audits fresh, appends findings, fixes the top ones — plateau stops when the well is dry (v0.29.0)"],
      ["status", "show metric, iteration, best/last values, stall count"],
      ["stop", "end the loop (keeps the best state)"],
      ["cancel", "alias of /loop stop — end the loop"],
      ["finish", "end the loop cleanly: /loop finish [reason] → stopReason 'completed: <reason>'"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => { rememberCtx(ctx); return cmdLoop(args, ctx); },
  });

  // Tool registration is lazy: done on the first session event, when a
  // context exists. Tools show even without an active goal (and return
  // "no active goal" if called).
  let registeredCtx: ExtensionContext | null = null;

  // v0.24.5 tool-visibility self-heal: surface the notify exactly once
  // per session so the user learns about an external allowlist once and
  // can fix their profile to silence it.
  // v0.27.9: also applies toolOverrides.allow / toolOverrides.hide from
  // .pi-glla/settings.json — the project's per-tool policy wins over the
  // external allowlist (allow) or over the session default (hide).
  let toolHealNotified = false;
  function ensureAgentToolsActive(pi: ExtensionAPI, ctx: ExtensionContext): void {
    try {
      const active = pi.getActiveTools();
      const missing = missingGllaTools(active);
      const overrides = loadSettings(ctx.cwd).toolOverrides;
      let next = [...active, ...missing];
      let changed = missing.length > 0;
      // Apply per-tool allowlist — force tools visible despite an external modlist.
      if (overrides?.allow && overrides.allow.length > 0) {
        const toAdd = overrides.allow.filter((t) => !next.includes(t));
        if (toAdd.length > 0) {
          next = [...next, ...toAdd];
          changed = true;
        }
      }
      // Apply per-tool hide — force tools hidden even when the session allows them.
      if (overrides?.hide && overrides.hide.length > 0) {
        const before = next.length;
        next = next.filter((t) => !overrides.hide!.includes(t));
        if (next.length !== before) changed = true;
      }
      if (changed) pi.setActiveTools(next);
      if (!toolHealNotified && missing.length > 0) {
        // v0.29.3: the notify used to fire even when NOTHING was missing —
        // "glla: 0 agent tool(s) were hidden … re-activated ()" at every pi
        // start (field-observed in darklord). Warn only on a real heal.
        toolHealNotified = true;
        const list = missing.join(", ");
        ctx.ui.notify(
          `glla: ${missing.length} agent tool(s) were hidden by an external tool allowlist (e.g. a modlist profile) and have been re-activated (${list}). Add them to your allowlist profile to silence this.`,
          "warning",
        );
      }
    } catch {
      // Older pi without getActiveTools/setActiveTools — nothing we can do.
    }
  }

  // v0.26.1: compaction ends WITHOUT an agent_end (the compaction turn is
  // not an agent turn), so the continuation chain can dangle until the
  // 60s heartbeat notices. Re-arm it as soon as pi settles post-compact.
  pi.on("session_compact", async (_event: any, ctx: ExtensionContext) => {
    if (isForeignCtx(ctx)) return;
    rememberCtx(ctx);
    if (!isSupervising()) return;
    appendLedger(ctx.cwd, "session_compact", {});
    // v0.28.24: a compaction is LEGITIMATE busy time — reset the send-rearm
    // storm streaks (π-web nearly escalated a "send-retry storm" pause during
    // a 3.5-minute compact) and open the post-compaction stall grace.
    continuationRearmStreak = 0; continuationRearmSince = 0;
    loopRearmStreak = 0; loopRearmSince = 0;
    compactionGraceUntil = Date.now() + COMPACTION_GRACE_MS;
    // v0.32.1: arm the resume debt + the resync block (the settle probes
    // below stay as the fast path; the heartbeat now retries the debt on
    // EVERY post-grace tick until agent_start discharges it).
    postCompactResumeOwed = true;
    postCompactResyncPending = true;
    const settle = setTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && continuationTimer === null && loopTimer === null && isSupervising() && !abortedStandDown) {
          appendLedger(c.cwd, "compaction_refire", {});
          if (isLoopActive()) scheduleLoopTick(c);
          else scheduleContinuation(c, true);
        }
      } catch {
        /* settle race — the 60s heartbeat covers it */
      }
    }, 2000);
    settle.unref?.();
    // v0.29.21: a SECOND settle at grace expiry. The 2s settle almost
    // always loses (pi is mid-compact / mid-resumed-turn then), and the
    // heartbeat's first post-grace tick lands up to one interval late —
    // meanwhile the continuation chain can dangle with ZERO rearm
    // attempts (field: hellhunter 2026-07-31 — auto-compact 04:31 at
    // 195.8k after two output-limit turns, zero rearms after the compact
    // event, recovery only at 04:34:48 via the post-grace heartbeat;
    // ~4 min that read as a stoppage). Refire the moment the grace ends.
    const graceSettle = setTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && continuationTimer === null && loopTimer === null && isSupervising() && !abortedStandDown) {
          appendLedger(c.cwd, "compaction_grace_refire", {});
          if (isLoopActive()) scheduleLoopTick(c);
          else scheduleContinuation(c, true);
        }
      } catch {
        /* settle race — the 60s heartbeat covers it */
      }
    }, COMPACTION_GRACE_MS + 2_000);
    graceSettle.unref?.();
  });

  pi.on("message_start", async (event: any, _ctx: ExtensionContext) => {
    // v0.14.0 drafting floor: count real user replies while drafting. Our
    // own injected draft prompt arrives as a user message — skip that one.
    if (draftingTarget === null) return;
    if (event?.message?.role !== "user") return;
    if (draftingSeedInFlight) {
      draftingSeedInFlight = false;
      return;
    }
    draftingUserReplies++;
  });

  // v0.15.1: ask_user_question answers arrive as tool results, not chat
  // messages — count answered (non-cancelled) questionnaires as replies too.
  pi.on("tool_result", async (event: any) => {
    noteToolResult(event); // v0.33.0: slim widget "last action" feed
    // v0.24.0: roll loop tool-result fingerprints (same-tool-same-result
    // detection) — recorded for ANY tool result while a loop is active.
    if (isLoopActive()) {
      const loop = state.loop!;
      const out = event?.output ?? event?.result ?? event?.details ?? "";
      const text = typeof out === "string" ? out : JSON.stringify(out) ?? "";
      loop.recentToolResults = pushRepetitionCapped(
        loop.recentToolResults ?? [],
        { tool: String(event?.toolName ?? "?"), hash: textFingerprint(text), isError: Boolean(event?.isError ?? event?.error) },
        REPETITION.toolWindow,
      );
      // v0.25.1: file-write progress signal for the multi-signal stuck
      // gate — a loop that is WRITING files is shipping, not stuck.
      if (isLoopWriteTool(String(event?.toolName ?? ""))) {
        const metrics = loop.iterMetrics ?? { fileWrites: 0 };
        metrics.fileWrites++;
        loop.iterMetrics = metrics;
      }
    }
    // v0.25.2: per-goal tool telemetry (/glla stats premature detection).
    if (state.goal && state.goal.status === "active") {
      const toolName = String(event?.toolName ?? "");
      if (isLoopWriteTool(toolName) || toolName === "bash") {
        const t = state.goal.telemetry ?? { turns: 0, fileWrites: 0, bashCalls: 0 };
        if (isLoopWriteTool(toolName)) t.fileWrites++;
        if (toolName === "bash") t.bashCalls++;
        state.goal.telemetry = t;
      }
    }
    // v0.25.6: subagent quota errors (the pi-subagents#175 shape —
    // Explore's upstream haiku pin 403s on shared keys). Surface the
    // repair path immediately; the continuation prompt's WHEN SUBAGENTS
    // HIT QUOTA ERRORS section carries the full guidance.
    if (isSubagentQuotaResult(String(event?.toolName ?? ""), Boolean(event?.isError ?? event?.error), event?.output ?? event?.result ?? event?.details ?? "")) {
      const errText = typeof (event?.output ?? event?.result) === "string" ? (event?.output ?? event?.result) : JSON.stringify(event?.output ?? event?.result ?? event?.details ?? "");
      appendLedger(registeredCtx?.cwd ?? process.cwd(), "subagent_quota_error", { error: String(errText).slice(0, 200) });
      registeredCtx?.ui.notify(
        "Subagent hit a quota error (403/limit). Repair: re-spawn with an explicit model= on your quota pool, or do the work inline — see the continuation prompt's WHEN SUBAGENTS HIT QUOTA ERRORS. Explore's upstream haiku pin is the usual cause (pi-subagents#175); glla's inherit-parent strategy removes it for NEW sessions.",
        "warning",
      );
    }
    if (draftingTarget === null) return;
    if (askUserQuestionAnswered(String(event?.toolName ?? ""), event?.details)) {
      draftingUserReplies++;
    }
  });

  pi.on("session_shutdown", async (event: any, ctx: ExtensionContext) => {
    if (isForeignCtx(ctx)) return;
    // v0.30.0: attribution + rebind window. pi announces WHY the session
    // is being replaced (reload/resume/new/fork/quit) — the ledger can
    // now answer "what killed the handle?" without guesswork (hegemon's
    // 5-hour orphan silence 2026-07-31 was unattributable). The window
    // tells the stale probe that a rebind (session_start) is imminent.
    const shutdownReason = typeof event?.reason === "string" ? event.reason : "unknown";
    appendLedger(ctx.cwd, "session_shutdown", { reason: shutdownReason });
    sessionReplacementUntil = Date.now() + SESSION_REBIND_GRACE_MS;
  });

  pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    // v0.23.8: subagent sessions (pi-subagents binds extensions there too)
    // are workers — never run the restore gate or reschedule the loop from
    // a foreign session.
    if (isForeignCtx(ctx)) return;
    // v0.30.0: rebind bookkeeping — claim ownership, close any replacement
    // window, and reset a stale flag left over from the PREVIOUS session's
    // invalidation. pi rebinds THIS module to the new session (switch) or
    // re-imports it (/reload — fresh module, flag already false); either
    // way the fresh ctx makes the old poison flag wrong. Re-probe to
    // confirm the new handle actually works.
    writeOwnerFile(ctx.cwd);
    sessionReplacementUntil = 0;
    zombieStoodDown = false;
    staleTerminalDone = false; // v0.33.1: a rebound session must be able to go terminal AGAIN (was: one-shot for the process lifetime)
    postCompactResumeOwed = false; // v0.33.1: a compact from a previous session must not resync THIS one
    postCompactResyncPending = false;
    const startReason = typeof event?.reason === "string" ? event.reason : "unknown";
    appendLedger(ctx.cwd, "session_rebound", { reason: startReason });
    if (extensionApiStale) {
      extensionApiStale = false; // fresh ctx delivered — re-probe
      const stillStale = probeExtensionApiStale();
      appendLedger(ctx.cwd, "stale_flag_reset_on_rebind", { reason: startReason, stillStale });
      if (stillStale) {
        ctx.ui.notify("glla: session rebound but the extension handle is still stale — run /reload (extensions rebuild in place), then /glla resume.", "warning");
      }
    }
    state = readState(ctx.cwd);
    // v0.34.9: session-ownership tag — set the goal/loop sessionId on the
    // FIRST active session that loads them. Subsequent sessions will see a
    // mismatch and the heartbeat will hold the continuation prompt.
    // For UNLOADED goals (paused, complete, aborted) we leave the prior
    // sessionId untouched so a future /goal resume in the same session
    // continues to work.
    if (state.goal && state.goal.status === "active" && !(state.goal as any).sessionId) {
      const sid = (ctx.sessionInfo as any)?.id ?? (ctx as any).sessionId;
      if (sid) {
        (state.goal as any).sessionId = String(sid);
        appendLedger(ctx.cwd, "goal_session_tagged", { goalId: state.goal.id, sessionId: String(sid).slice(0, 12) });
        persistState(ctx);
      }
    }
    // v0.34.9: same session-ownership tag for the loop. A loop running in
    // session A must not fire its iteration prompt into session B.
    if (state.loop && state.loop.active && !(state.loop as any).sessionId) {
      const sid2 = (ctx.sessionInfo as any)?.id ?? (ctx as any).sessionId;
      if (sid2) {
        (state.loop as any).sessionId = String(sid2);
        appendLedger(ctx.cwd, "loop_session_tagged", { sessionId: String(sid2).slice(0, 12) });
        persistState(ctx);
      }
    }
    // v0.34.9: tag list items that have no sessionId yet — back-fill only,
    // never reassign existing tags (so a foreign-session queue stays
    // flagged foreign).
    if (state.list && state.list.length > 0) {
      const sessId3 = (ctx.sessionInfo as any)?.id ?? (ctx as any).sessionId;
      let mutated = false;
      const tagged = state.list.map((it) => {
        if (!(it as any).sessionId && sessId3) {
          mutated = true;
          return { ...it, sessionId: String(sessId3) };
        }
        return it;
      });
      if (mutated) {
        state = { ...state, list: tagged };
        appendLedger(ctx.cwd, "list_session_backfill", { count: tagged.length, sessionId: String(sessId3).slice(0, 12) });
        persistState(ctx);
      }
    }
    // v0.28.14: snapshot carryover BEFORE any restore logic mutates state —
    // a paused goal, waiting list items, or a loop that was live/held when
    // the last session ended. Resolved once at the first NEW activation.
    carryoverSnapshot = {
      pausedGoal: state.goal && state.goal.status === "paused" ? state.goal.objective.slice(0, 60) : undefined,
      listCount: listQueue().length,
      heldLoop: state.loop && (state.loop.active || state.loop.stopReason === HELD_ON_RESTORE) ? state.loop.target.slice(0, 60) : undefined,
    };
    carryoverResolved = !(carryoverSnapshot.pausedGoal || carryoverSnapshot.listCount > 0 || carryoverSnapshot.heldLoop);
    if (!registeredCtx) {
      registerAgentTools(pi, ctx);
      registeredCtx = ctx;
    }
    ensureAgentToolsActive(pi, ctx);
    warnOnCommandCollision(ctx);
    warnIfAuditorProviderRisky(ctx);
    // v0.24.6: sync the pi-subagents model override (managed Explore.md) with
    // settings. Idempotent; applies to NEW sessions (pi-subagents registers
    // its agents at its own session start).
    try {
      const s = loadSettings(ctx.cwd);
      const sync = syncSubagentModelOverrides({
        agentDir: defaultAgentDir(),
        strategy: s.subagentModelStrategy ?? "inherit-parent",
        overrides: s.subagentModelOverrides,
      });
      for (const skip of sync.skipped) {
        ctx.ui.notify(`glla subagent override skipped [${skip.name}]: ${skip.reason}`, "warning");
      }
      // v0.25.6: notify-with-repair — a managed override that went missing
      // or was altered externally (pi update, manual edit, sync churn) is
      // re-written AND surfaced, not silently restored.
      if (sync.repaired.length > 0) {
        ctx.ui.notify(
          `glla repaired managed subagent override(s): ${sync.repaired.join(", ")} — the file(s) were missing or altered externally; re-written per your subagent settings.`,
          "warning",
        );
      }
    } catch (err) {
      ctx.ui.notify(`glla subagent override sync failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    // v0.29.6: stacked-state auto-arbitration FIRST — one live artifact
    // survives before the restore gate decides hold-vs-resume for it.
    autoArbitrateStackedState(ctx);
    // Restore gate (v0.26.9 tri-state): a human LOADING a session
    // ("startup"/"new"/"resume", or no reason) HOLDS — the popup shows what
    // is waiting and nothing starts until they resume explicitly. In-session
    // machinery ("reload"/"fork") auto-resumes. /glla autoresume=on opts
    // into auto-resume everywhere (unattended rigs); autoresume=off never
    // auto-resumes. v0.29.5: the setting is GLOBAL-only — project-level
    // autoResume keys are ignored. Once running, the chain auto-continues
    // forever unless a super-stuck brake (stall escalation / stale-api /
    // latch) stops it loudly.
    const autoResumeSetting = resolveEffectiveAggressiveSettings(loadGlobalSettings()).autoResume;
    const autoResume = shouldAutoResumeOnSessionStart(event?.reason, autoResumeSetting);
    // v0.25.0 (contract item 6): aggressiveMode announces every auto-event.
    if (
      autoResume &&
      resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).aggressiveMode &&
      (isLoopActive() || (state.goal && state.goal.status === "active") || listQueue().length > 0)
    ) {
      ctx.ui.notify("Auto-resume fired (event: session start). Continue working.", "info");
    }
    // v0.29.11: loops stopped by the stale-handle terminal or the stall
    // escalation told the user "restart pi, then /loop start" — but a
    // fresh start discards iteration/best/history. Hold them on load like
    // any restore-held loop: /loop resume continues from the saved state.
    if (state.loop && !state.loop.active &&
        (state.loop.stopReason?.startsWith("extension api stale") || state.loop.stopReason?.startsWith("stalled:") || state.loop.stopReason?.startsWith("send-retry storm:"))) {
      appendLedger(ctx.cwd, "loop_held_for_resume", { was: (state.loop.stopReason ?? "").slice(0, 40) });
      state.loop = { ...state.loop, stopReason: HELD_ON_RESTORE };
      persistState(ctx);
    }
    // v0.29.14: migrate live/held audit loops off the open-count/min
    // metric — it punished DISCOVERY (11 new real findings read as a
    // regression; iter 27→38→37 nearly plateau-stopped mid-work). Flip to
    // closed-count/max, null the pinned best (the next closed-count
    // measure becomes the honest baseline), reset the stall streak. This
    // supersedes the v0.29.10 baseline-0 reseed (every old-measure loop
    // gets nulled here).
    if (state.loop && state.loop.measureCmd?.includes("audit-loop/findings.md") && state.loop.measureCmd?.includes("\\[ \\]")
      && state.loop.direction !== "max") {
      state.loop = { ...state.loop, measureCmd: auditMeasureCmd(), direction: "max", bestValue: null, stallCount: 0, kind: state.loop.kind ?? "audit" };
      persistState(ctx);
      appendLedger(ctx.cwd, "audit_loop_metric_migrated", { from: "open-count/min", to: "closed-count/max" });
    }
    // v0.29.18: migrate live/held audit loops to the FIX-FIRST target —
    // the audit-every-iteration template made discovery (8-12/iter)
    // outpace fixes (1/iter) and allowed "no new action" iterations with
    // open boxes (field: hegemon iter 26 — the user watched it find and
    // present instead of fix). Target-only swap: the metric (closed
    // count/max) is unchanged, so best/stall stay.
    if (state.loop?.kind === "audit" && state.loop.target?.includes("Every iteration: (1) run a FRESH audit pass")) {
      state.loop = { ...state.loop, target: auditTarget() };
      persistState(ctx);
      appendLedger(ctx.cwd, "audit_loop_target_migrated", { from: "audit-every-iteration", to: "fix-first" });
    }
    // v0.34.13: an auto-recovery /reload carries its own resume consent —
    // the sidecar marker overrides autoresume=off for THIS restore only.
    const recoveryResume = consumeRecoveryResume(ctx.cwd);
    // v0.34.14: a /reload rebind (same pi pid) ALWAYS resumes — the session
    // is live mid-work; holding is the "list is not continuing" bug.
    const rebindResume = claimSessionOwnerAndDetectRebind(ctx.cwd);
    if (rebindResume) appendLedger(ctx.cwd, "rebind_resume", { pid: process.pid });
    if (isLoopActive()) {
      const l = state.loop!;
      if (autoResume || recoveryResume || rebindResume) {
        ctx.ui.notify(
          `Resuming loop (iteration ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"}, best ${l.bestValue ?? "n/a"}, stall ${l.stallCount}/${l.plateauWindow}): ${l.target.slice(0, 60)}`,
          "info",
        );
        scheduleLoopTick(ctx);
      } else {
        state.loop = { ...l, active: false, stopReason: HELD_ON_RESTORE };
        persistState(ctx);
        ctx.ui.notify(
          `Loop held on restore: ${l.target.slice(0, 60)} — /loop resume to continue, /glla autoresume=on to auto-resume on session load (global setting).`,
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active" && state.goal.autoContinue) {
      const wasInterrupted = !!state.goal.interruptedAt;
      // v0.28.21: the 0.28.3 interrupted-goal exemption is SUPERSEDED —
      // the default is now hold-everything on session load (user directive:
      // "load it but not auto start it"). Interrupted goals hold like
      // everything else; autoresume=on (unattended rigs) still auto-resumes
      // them, and the marker is cleared only on that promised auto-resume.
      if (autoResume || recoveryResume || rebindResume) {
        // v0.28.1 (S2): clear the stale-handle interrupt marker — this IS
        // the auto-resume the marker promised.
        if (wasInterrupted) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
        ctx.ui.notify(
          `Resuming ${state.goal.policy === "list" ? "list item" : "goal"}: ${state.goal.objective.slice(0, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}${wasInterrupted ? " — auto-resumed after the stale-handle interrupt" : ""}`,
          "info",
        );
        // v0.28.4 (P3): skip nudge accounting for the first recovery turns.
        postRestoreGraceTurns = 2;
        scheduleContinuation(ctx, true);
      } else {
        const queued = listQueue().length;
        // v0.22.7: name WHAT is held — a list head resumes through /list.
        const isListItem = state.goal.policy === "list";
        const resumeCmd = isListItem ? "/list resume" : "/goal resume";
        const resumeHint = `${resumeCmd} to continue${queued > 0 ? ` (+${queued} waiting in the list)` : ""} · /glla autoresume=on to auto-resume on load (global setting)`;
        // v0.31.1: name the supersession — a held one-shot audit whose work a
        // live audit loop now owns reads as "stalled" for HOURS otherwise
        // (junk-runner: 8h21m of "held for explicit resume" on a goal the
        // loop had superseded). The widget surface must say so.
        const auditSuperseded =
          state.goal.objective.includes(GOAL_AUDIT_ONESHOT_MARKER) &&
          !!state.loop &&
          (state.loop.active || state.loop.stopReason === HELD_ON_RESTORE) &&
          !!state.loop.target?.includes(LOOP_AUDIT_MARKER);
        updateGoal({
          status: "paused",
          pauseKind: "blocked",
          pauseReason: auditSuperseded
            ? "restored on session load — SUPERSEDED by the audit loop in this session"
            : "restored on session load — held for explicit resume",
          pauseSuggestedAction: auditSuperseded
            ? `/goal cancel clears it (the loop already owns the audit) · ${resumeHint} if you disagree`
            : resumeHint,
        }, ctx);
        ctx.ui.notify(
          `${isListItem ? "List item" : "Goal"} held on restore: ${state.goal.objective.slice(0, 70)}${queued > 0 ? ` (+${queued} waiting in the list)` : ""} — ${resumeCmd} to continue.`,
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active") {
      // Active but autoContinue off: nothing auto-fires — just surface it.
      ctx.ui.notify(
        `Restored ${state.goal.policy === "list" ? "list item" : "goal"}: ${state.goal.objective.slice(0, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}`,
        "info",
      );
    } else if ((!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") && listQueue().length > 0) {
      if (autoResume) {
        // Session restarted with a non-empty queue but no active goal.
        activateNextListItem(ctx);
      } else {
        ctx.ui.notify(`List has ${listQueue().length} item(s) waiting — /list next to activate the head.`, "info");
      }
    }
    // v0.29.6: the 0.28.21 loop-vs-goal decision picker is SUPERSEDED by
    // auto-arbitration above — stacked states resolve deterministically
    // (most recent activity keeps the slot; the loser is archived) before
    // the restore gate, so a live loop and a live goal cannot coexist here.
    // Always paint on session load (v0.22.1): the branches above only reach
    // refreshUI via persistState, so a goal that was ALREADY paused (or any
    // state that doesn't mutate on load) rendered nothing — "can't tell if
    // it's on" is a bug. Painting unconditionally also clears/refreshes any
    // stale widget carried over from a previous in-process session.
    refreshUI(ctx);
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    // v0.23.8: a subagent finishing must not drive the main session's
    // continuation loop.
    if (isForeignCtx(ctx)) return;
    noteActivity(true);
    lastStreamActivityAt = Date.now();
    // v0.27.2: folded-in length-continue (standalone pi-length-continue is
    // deprecated). A response cut by the per-response output cap is NOT a
    // completed turn (no telemetry), NOT a stall (no no-tool nudge), and
    // must not run the loop measure or the normal goal continuation on half
    // a response — re-trigger immediately with split-smaller guidance and
    // skip ALL turn bookkeeping; the NEXT agent_end processes the run.
    // Works with no goal active (plain sessions truncate too).
    // v0.27.3: enrich lastA with text + priorText for the smarter nudge
    // accounting below.
    const assistants = (event.messages as any[]).filter((m: any) => m.role === "assistant");
    const rawLastA = assistants.length ? assistants[assistants.length - 1] : null;
    const rawPriorA = assistants.length >= 2 ? assistants[assistants.length - 2] : null;
    const extractText = (m: any): string => (m && Array.isArray(m.content)) ? m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const lastA = rawLastA ? { stopReason: rawLastA.stopReason, text: extractText(rawLastA), priorText: extractText(rawPriorA) } : null;
    const lc = tickLengthContinue(lastA?.stopReason === "length");
    if (lc.giveUpNow) {
      ctx.ui.notify(`glla: response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — stepping aside. Ask the model to split the work into smaller pieces.`, "warning");
      notifyExternal(ctx, "Response truncated 3× in a row — giving up auto-continue.");
    }
    if (lastA?.stopReason === "length") {
      if (lc.fire && !ctx.hasPendingMessages()) sendLengthContinue(ctx, lc.consecutive);
      return;
    }
    // v0.25.2: per-goal turn telemetry (/glla stats).
    if (state.goal && state.goal.status === "active") {
      const t = state.goal.telemetry ?? { turns: 0, fileWrites: 0, bashCalls: 0 };
      t.turns++;
      state.goal.telemetry = t;
    }
    if (!registeredCtx) {
      registerAgentTools(pi, ctx);
      registeredCtx = ctx;
    }
    ensureAgentToolsActive(pi, ctx);
    // v0.27.3: nudge accounting — substantive analytical turns (long, novel
    // text) reset the counter even with no tool calls. Polis-session
    // incident showed the tool-only check fired on real investigation work.
    if (isSupervising()) {
      if (postRestoreGraceTurns > 0) {
        // v0.28.4 (P3): the first turns after a session_start restore are
        // recovery chatter (orientation reads, plan narration) — counting
        // them toward the stall brake paused restored goals mid-recovery.
        postRestoreGraceTurns--;
        appendLedger(ctx.cwd, "post_restore_grace", { remaining: postRestoreGraceTurns });
      } else if (lastA?.stopReason === "error") {
        // v0.28.13 (endless-td 429 incident 2026-07-28): provider-error
        // turns (429 quota exhaustion, 5xx) are NOT model unproductivity —
        // the model never got a say. Counting them tripped the brake on a
        // healthy goal mid-CDP-capture (4 MiniMax-M3 429s → wrong
        // "unproductive turns" pause). pi's own retry owns the backoff;
        // the nudge counter neither increments nor resets on these turns.
        appendLedger(ctx.cwd, "stall_nudge_exempt_error", { nudgesSoFar: heartbeatNudges });
      } else if (lastA?.stopReason === "aborted") {
        // v0.29.4: user aborts are not model unproductivity either — the
        // user pressed Esc. Counting the interrupt tripped the stall brake
        // on the USER's action (pully field case: Esc-spam → STALL WARNING
        // 1/3, 2/3 → a bogus "stalled" pause). Neither increment nor reset.
        appendLedger(ctx.cwd, "stall_nudge_exempt_aborted", { nudgesSoFar: heartbeatNudges });
      } else {
      const s = loadSettings(ctx.cwd);
      const shortWordsThr = s.stallShortWords ?? DEFAULT_STALL_SHORT_WORDS;
      const simThr = s.stallSimilarityThreshold ?? DEFAULT_STALL_SIM_THRESHOLD;
      heartbeatNudges = accountTurnForNudgesRich(
        { toolCalls: toolCallsThisTurn, text: lastA?.text ?? "", priorText: lastA?.priorText ?? "", shortWords: shortWordsThr, simThreshold: simThr },
        heartbeatNudges,
      );
      if (heartbeatNudges >= HEARTBEAT_MAX_NUDGES) {
        heartbeatNudges = 0;
        if (isLoopActive()) {
          clearLoopTimer();
          state.loop = { ...state.loop!, active: false, stopReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive unproductive turns (no tools, short or repetitive)` };
          persistState(ctx);
          ctx.ui.notify(`Loop stopped: stalled (${HEARTBEAT_MAX_NUDGES} unproductive turns). /loop start to begin a new one.`, "warning");
          notifyExternal(ctx, "Loop stopped: stalled (no tool calls).");
          return;
        }
        if (state.goal) {
          updateGoal({
            status: "paused",
            pauseKind: "decision",
            pauseOptions: ["Retry — /goal resume", "Tweak the objective — /goal tweak <new text>", "Cancel the goal (/goal cancel)"],
            pauseRecommended: 1,
            pauseReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive unproductive turns (no tools, short or repetitive)`,
            pauseSuggestedAction: "Inspect the goal — /goal resume to retry, /goal tweak to narrow it, /goal cancel to abort.",
          }, ctx);
          ctx.ui.notify(`${goalNoun()} paused: stalled (${HEARTBEAT_MAX_NUDGES} unproductive turns).`, "warning");
          maybeDecisionPopup(ctx);
          notifyExternal(ctx, "Goal paused: stalled (no tool calls).");
          return;
        }
      }
      // v0.28.4 (P1): graduated escalation — before the brake can fire,
      // tell the model exactly what closes the turn. A done-but-unclosed
      // goal gets "call complete_goal NOW", not a silent count. Replaces
      // this turn's normal continuation (the escalation IS the entry).
      if (heartbeatNudges >= 1 && state.goal && state.goal.status === "active" && !isLoopActive()) {
        toolCallsThisTurn = 0;
        sendStallEscalation(ctx, heartbeatNudges);
        return;
      }
      } // end post-restore grace else
    }
    toolCallsThisTurn = 0;
    // Loop 3 runs on the same heartbeat: measure after every agent turn.
    if (isLoopActive()) {
      clearLoopTimer();
      // v0.29.19: provider-error / user-abort turns are NOT iterations —
      // the model never got a say, so a dead turn carries no stall/stuck/
      // plateau signal (field 2026-07-31, MiniMax token-plan 429 storm:
      // hegemon false-plateau'd with 13 open findings, polis with 3+,
      // hellhunter stuck-stopped at iter 93 — every counted turn was a
      // dead 429 turn; the v0.28.13/v0.29.4 exemptions only covered the
      // goal nudge counter). Skip the measure and refire — bounded, so a
      // real outage stops the loop honestly instead of burning turns.
      const sr = lastA?.stopReason;
      if (sr === "error" || sr === "aborted") {
        const loop = state.loop!;
        loop.consecutiveErrors = (loop.consecutiveErrors ?? 0) + 1;
        persistState(ctx);
        appendLedger(ctx.cwd, "loop_turn_exempt_error", { stopReason: sr, consecutive: loop.consecutiveErrors, iteration: loop.iteration });
        const cap = sr === "aborted" ? LOOP_MAX_CONSECUTIVE_ABORTS : LOOP_MAX_CONSECUTIVE_ERRORS;
        if (loop.consecutiveErrors >= cap) {
          loop.active = false;
          loop.stopReason = sr === "aborted"
            ? `stopped by user — ${loop.consecutiveErrors} consecutive aborts (iteration ${loop.iteration} preserved; /loop resume to continue)`
            : `provider errors — ${loop.consecutiveErrors} consecutive error turns (iteration ${loop.iteration} preserved; /loop resume when the provider recovers)`;
          persistState(ctx);
          ctx.ui.notify(`Loop stopped: ${loop.stopReason}`, "warning");
          appendLedger(ctx.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, best: loop.bestValue });
          notifyExternal(ctx, `Loop stopped: ${sr === "aborted" ? "user aborts" : "provider errors"} (${loop.consecutiveErrors}×)`);
          return;
        }
        scheduleLoopTick(ctx);
        return;
      }
      if ((state.loop!.consecutiveErrors ?? 0) > 0) state.loop!.consecutiveErrors = 0; // a real turn clears the streak (runLoopTick persists)
      await runLoopTick(ctx, event);
      return;
    }
    if (!state.goal) return;
    if (state.goal.status !== "active") return;
    clearContinuationTimer();

    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    const text = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const stopReason = last?.stopReason;
    iterationCounter++;

    // Token accounting + cost guard: accumulate this turn's assistant tokens
    // (deduped — agent_end may replay seen messages). Crossing the goal's
    // token limit pauses it; /glla tokenlimit=<n> to raise.
    const newTokens = sumNewAssistantTokens(event.messages as unknown[], countedTokenMessages);
    if (newTokens > 0) {
      const used = (state.goal.usage?.tokensUsed ?? 0) + newTokens;
      const limit = state.goal.usage?.tokensLimit ?? DEFAULT_TOKEN_LIMIT;
      // v0.12.0: the guard is opt-in — limit 0/unset means never pause.
      if (limit > 0 && used > limit) {
        updateGoal({
          usage: { tokensUsed: used, tokensLimit: limit },
          status: "paused",
          pauseKind: "error",
          pauseReason: `token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()})`,
          pauseSuggestedAction: "/glla tokenlimit=<n> to raise the cap (or 0 to disable), then /goal resume",
        }, ctx);
        ctx.ui.notify(`${goalNoun()} paused: token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()}). /glla tokenlimit=<n> to raise, 0 to disable.`, "warning");
        notifyExternal(ctx, `Goal paused: token limit exceeded (${used} > ${limit}).`);
        return;
      }
      updateGoal({ usage: { tokensUsed: used, tokensLimit: limit } }, ctx);
    }

    if (stopReason === "error") {
      consecutiveErrorIterations++;
      consecutiveAbortIterations = 0;
      if (consecutiveErrorIterations >= 5) {
        // v0.28.5 (E8): carry the REAL error text — the pause used to say
        // literally "5 consecutive errors: error" (stopReason, not the
        // provider error). And give transient flakes ONE auto-resume per brake
        // (escalating cooldown, reason re-checked) — the E8 incident lost 1.5h to a
        // 60-second provider hiccup waiting on a manual /goal resume.
        const detail = text.trim() ? ` (last: ${text.trim().replace(/\s+/g, " ").slice(0, 160)})` : "";
        const reason = `5 consecutive errors${detail}`;
        // v0.34.15: the streak now lives ON THE GOAL so it survives the
        // auto-recovery /reloads that used to zero the module counter —
        // hegemon 2026-08-01: a hard-exhausted MiniMax plan churned 1-minute
        // probes for an hour because every reload reset the ladder to rung 1
        // and the 6-brake park (v0.29.9) could never engage.
        const brakeStreak = state.goal!.errorBrakeStreak ?? 0;
        // v0.34.15: a quota/rate-limit wall is NOT a flake — the card must
        // say "resuming won't help; switch /model or wait out the window"
        // (the raw 429 text was in `detail` but nobody parses JSON on a card).
        const quotaWall = /rate.?limit|usage limit|quota|insufficient|credits/i.test(detail);
        // v0.29.1: brake-cycle CAP. The v0.28.25 ladder slows the thrash
        // (1m→16m) but never STOPS it — junk-runner/hellhunter/pully each
        // burned 4+ pause↔retry cycles against provider windows that last
        // hours. After 6 consecutive brakes: park. v0.29.9: the park keeps
        // probing at the top of each hour (clock-aligned window resets).
        if (brakeStreak >= 6) {
          // v0.29.9: park — but keep probing at the top of each hour
          // (user: "simply adding an hourly retry … just to pick up work
          // faster assuming the retry expired"). Coding-plan rate-limit
          // windows typically expire on clock-hour boundaries, so a probe
          // scheduled for :01 catches the reset within seconds. One dunk
          // per hour, free (429s are rejected pre-billing); a successful
          // probe resets the whole error cycle. If the wall is something
          // else (auth, outage), the hourly probe is a harmless failed
          // resume attempt that re-parks via the same brake.
          updateGoal({
            status: "paused",
            pauseKind: "error",
            pauseReason: `${reason} — 6 error-brakes in a row; the provider has been erroring for an extended window`,
            pauseSuggestedAction: quotaWall
              ? "Provider quota/rate-limit wall — resuming won't help until the window resets. Hourly top-of-hour probes will pick work back up; switch /model to a different provider to continue immediately."
              : "Probing at the top of each hour — rate-limit windows typically expire on clock-hour boundaries. /goal resume retries now.",
          }, ctx);
          ctx.ui.notify(`${goalNoun()} parked: ${reason} — 6 brakes in a row. ${quotaWall ? "Quota/rate-limit wall — switching /model continues immediately; otherwise hourly" : "Hourly"} top-of-hour probes will pick work back up when the window opens.`, "warning");
          notifyExternal(ctx, `${goalNoun()} parked: provider erroring across 6 error-brake cycles — hourly top-of-hour probes scheduled.`);
          appendLedger(ctx.cwd, "error_brake_capped", { streak: brakeStreak, reason });
          const probeMs = msUntilNextHourBoundary(Date.now());
          scheduleQuotaRetry(ctx, probeMs / 1000, reason, () => {
            // Re-check: only probe if STILL parked by the error-brake cap —
            // a user pause/resume/cancel meanwhile is never stomped.
            if (state.goal && state.goal.status === "paused" && state.goal.pauseKind === "error"
              && (state.goal.pauseReason ?? "").includes("error-brakes in a row")) {
              appendLedger(ctx.cwd, "hourly_rate_probe", { goalId: state.goal.id, streak: state.goal.errorBrakeStreak ?? 0 });
              updateGoal({ status: "active" }, ctx);
              appendLedger(ctx.cwd, "goal_resumed", { via: "hourly-rate-probe" });
              ctx.ui.notify("Hourly probe: resuming (rate-limit windows typically expire at the top of the hour).", "info");
              scheduleContinuation(ctx, true);
            }
          }, "Hourly rate-limit probe");
          return;
        }
        // v0.28.25: the cooldown escalates per CONSECUTIVE brake — a fleet-wide
        // 403 window is not cleared by re-braking every 60 seconds.
        const cooldownMs = 60_000 * 2 ** Math.min(brakeStreak, 4);
        const cooldownMin = Math.round(cooldownMs / 60_000);
        updateGoal({
          status: "paused",
          pauseKind: "wait",
          pauseResumeAt: new Date(Date.now() + cooldownMs).toISOString(),
          pauseReason: reason,
          errorBrakeStreak: brakeStreak + 1,
          pauseSuggestedAction: quotaWall
            ? `Provider quota/rate-limit wall — resuming won't help until the window resets. Switch /model to a different provider to continue now, or let the probe auto-resume in ${cooldownMin}m.`
            : `Transient provider flake? The goal auto-resumes once in ${cooldownMin}m if still paused for this reason — or /goal resume now.`,
        }, ctx);
        ctx.ui.notify(`Goal paused: ${reason}.${quotaWall ? " Quota/rate-limit wall — resuming won't help until the window resets; switch /model to continue now." : ""}`, "warning");
        notifyExternal(ctx, `Goal paused: ${reason}.`);
        appendLedger(ctx.cwd, "goal_paused", { reason });
        scheduleQuotaRetry(ctx, cooldownMs / 1000, reason, () => {
          // Re-check: only auto-resume if STILL paused for the error brake
          // (a user /goal pause during the window is not stomped).
          if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("5 consecutive errors")) {
            updateGoal({ status: "active" }, ctx);
            appendLedger(ctx.cwd, "goal_resumed", { via: "error-brake-retry" });
            ctx.ui.notify("Auto-resumed after the 5-error brake (cooldown elapsed).", "info");
            scheduleContinuation(ctx, true);
          }
        }, "5 consecutive errors — auto-retry");
        return;
      }
      // v0.28.25: under the brake, the retry rides the exponential ladder —
      // NOT the immediate scheduleContinuation at the bottom of this handler
      // (an errored turn leaves the session idle, so the default delay is 0:
      // exactly how 5 retries fired back-to-back in dracon-utilities).
      const retryDelayMs = ERROR_RETRY_LADDER_MS[Math.min(consecutiveErrorIterations - 1, ERROR_RETRY_LADDER_MS.length - 1)];
      appendLedger(ctx.cwd, "error_retry_backoff", { attempt: consecutiveErrorIterations, delayMs: retryDelayMs });
      scheduleContinuation(ctx, true, retryDelayMs);
      return;
    } else if (stopReason === "aborted") {
      // v0.28.5 (E8): user aborts are not provider errors. Separate brake,
      // honest message, and NO auto-resume — aborting five turns in a row
      // is the user telling the goal to stop; we stay stopped.
      consecutiveAbortIterations++;
      consecutiveErrorIterations = 0;
      if (consecutiveAbortIterations >= 5) {
        updateGoal({
          status: "paused",
          pauseKind: "blocked",
          pauseReason: "5 consecutive aborts (user interrupted)",
          pauseSuggestedAction: "You interrupted 5 turns in a row — the goal stays paused until you /goal resume (or /goal cancel).",
        }, ctx);
        ctx.ui.notify("Goal paused: 5 consecutive aborts (user interrupted).", "warning");
        appendLedger(ctx.cwd, "goal_paused", { reason: "5 consecutive aborts (user interrupted)" });
        return;
      }
      // v0.29.4: an abort stands the chain DOWN — no auto re-fire. The old
      // fall-through re-fired the continuation immediately, so every Esc
      // was answered by another turn under the user's hands ("it auto
      // triggered and I kept spamming esc on it" — pully, 2026-07-30).
      ctx.ui.notify(`${goalNoun()} standing down — turn aborted by user (not counted toward stalls). /goal resume to continue, /goal cancel to stop.`, "info");
      abortedStandDown = true; // v0.29.5: heartbeat/compaction refires must not resurrect the chain
      appendLedger(ctx.cwd, "abort_stand_down", { consecutiveAborts: consecutiveAbortIterations });
      return;
    } else {
      consecutiveErrorIterations = 0;
      consecutiveAbortIterations = 0;
      // v0.28.25/v0.34.15: a healthy turn clears the (now persisted) brake streak
      if ((state.goal?.errorBrakeStreak ?? 0) > 0) updateGoal({ errorBrakeStreak: undefined }, ctx);
    }

    // No wall-clock cap by design: a goal ends via completion, explicit
    // pause/cancel, the stall watchdog, the 5-consecutive-errors pause, or
    // the token guard — never via an elapsed-time cutoff.

    // v0.34.12: NOT immediately — agent_end is the blackhole boundary.
    scheduleContinuation(ctx, false, EAGER_CONTINUATION_SETTLE_MS);
  });

  pi.on("tool_call", (event: any) => {
    toolCallsThisTurn++;
    noteActivity(true);
    lastStreamActivityAt = Date.now();
    noteToolCall(event); // v0.33.0
    // v0.24.0: count loop-iteration tool calls (narration-only detection).
    if (isLoopActive()) {
      state.loop!.toolsThisTurn = (state.loop!.toolsThisTurn ?? 0) + 1;
    }
  });

  // v0.29.16: stream liveness for the zombie-run watchdog — deltas, run
  // starts, and turn starts all prove the provider stream is alive.
  pi.on("message_update", () => {
    lastStreamActivityAt = Date.now();
  });
  pi.on("agent_start", () => {
    lastStreamActivityAt = Date.now();
    // v0.32.1: a real turn started — the post-compaction resume debt is
    // discharged (the heartbeat stops retrying it).
    postCompactResumeOwed = false;
  });
  pi.on("turn_start", () => {
    lastStreamActivityAt = Date.now();
  });
}
