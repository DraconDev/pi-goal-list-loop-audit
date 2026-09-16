/**
 * Bounded context handoff for the explicit `start` commands.
 *
 * A bare `/goal start`, `/loop start`, or `/list start` is allowed to use
 * recent conversation only as a convenience. It must not turn the whole
 * session (or assistant/tool output) into a new objective. Keep this module
 * deterministic and deliberately conservative: a single user-authored,
 * actionable request is usable; multiple or underspecified requests go back
 * through the existing drafting/confirmation paths.
 */

export const START_CONTEXT_MAX_ENTRIES = 48;
export const START_CONTEXT_MAX_TURNS = 8;
export const START_CONTEXT_MAX_CHARS = 3_200;
export const START_CONTEXT_MAX_TURN_CHARS = 800;
export const START_CONTEXT_MAX_CANDIDATE_CHARS = 700;

export interface StartContextTurn {
  role: "user" | "assistant";
  text: string;
  truncated?: boolean;
}

export interface StartContextWindow {
  /** The latest user turn, kept separate because it is the current prompt. */
  currentPrompt: string;
  currentPromptTruncated?: boolean;
  /** Older turns on the active branch, already bounded. */
  recent: StartContextTurn[];
}

export type StartContextInference =
  | {
    kind: "clear";
    objective: string;
    source: "current-prompt" | "recent-context";
  }
  | {
    kind: "ambiguous";
    candidates: string[];
    seed?: string;
    reason: "multiple-objectives" | "unclear-objective";
  }
  | {
    kind: "none";
    reason: "no-context" | "no-actionable-objective";
  };

interface RawSessionEntry {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

interface Candidate {
  text: string;
  source: "current-prompt" | "recent-context";
}

const ACTION_WORDS = [
  "add", "audit", "build", "change", "clean", "configure", "create", "debug", "delete",
  "design", "document", "enable", "fix", "improve", "implement", "investigate", "migrate",
  "optimize", "refactor", "remove", "repair", "replace", "resolve", "run", "ship", "start",
  "test", "update", "write",
] as const;

const ACTION_WORD_RE = new RegExp(`\\b(?:${ACTION_WORDS.join("|")})\\b`, "gi");
const ACTION_AT_START_RE = new RegExp(
  `^(?:(?:please|kindly)\\s+)?(?:${ACTION_WORDS.join("|")})\\b`,
  "i",
);
const REQUEST_PREFIX_RE = /^(?:(?:please|kindly)\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?|^(?:i|we)\s+(?:want|need|would like)(?:\s+you)?\s+(?:to\s+)?|^(?:let's|lets)\s+/i;
const REQUIREMENT_RE = /\b(?:should|needs?\s+to|must|acceptance\s+(?:criterion|criteria)|done\s+when)\b/i;
const GENERIC_REPLY_RE = /^(?:ok(?:ay)?|yes|no|sure|thanks?|thank\s+you|go\s+ahead|do\s+it|continue|resume|start|run\s+it|looks?\s+good|sounds?\s+good|not\s+sure|none|whatever|what\s+next|status)\s*[.!?]*$/i;
const QUESTION_ONLY_RE = /^(?:what|why|how|when|where|which|who|is|are|do|does|did|tell\s+me|explain)\b/i;
const EXPLANATION_REQUEST_RE = /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:explain|tell|describe|show|clarify)\b/i;
const PRONOUN_ONLY_RE = /^(?:it|this|that|the\s+(?:issue|bug|thing|problem)|everything|stuff|things|as\s+discussed)\s*[.!?]*$/i;
const VAGUE_ACTION_RE = new RegExp(
  `^(?:(?:please|kindly)\\s+)?(?:${ACTION_WORDS.join("|")})(?:\\s+(?:it|this|that|the\\s+(?:issue|bug|thing|problem)))?\\s*[.!?]*$`,
  "i",
);

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().replace(/[ \t\n]+/g, " ");
}

function normalizeKey(text: string): string {
  return normalizeWhitespace(text)
    .toLocaleLowerCase()
    .replace(/["'`.,!?;:()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w-]*(?:\s|$)/.test(text.trim());
}

function actionCount(text: string): number {
  return [...text.matchAll(ACTION_WORD_RE)].length;
}

function hasMultipleTasks(text: string): boolean {
  const objectivePart = text.split(/\bdone\s+when\b/i, 1)[0] ?? text;
  const lines = objectivePart.split("\n").map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  if (bullets >= 2) return true;

  const count = actionCount(objectivePart);
  if (count >= 2 && /\b(?:and|also|then|plus)\b|;/.test(objectivePart.toLocaleLowerCase())) return true;
  return false;
}

function classifyCandidate(raw: string, truncated = false): "clear" | "ambiguous" | "none" {
  const source = raw.replace(/\r\n?/g, "\n").trim();
  const text = normalizeWhitespace(source);
  if (!text || isSlashCommand(text) || GENERIC_REPLY_RE.test(text)) return "none";
  if (truncated || text.length > START_CONTEXT_MAX_CANDIDATE_CHARS) return "ambiguous";
  if (QUESTION_ONLY_RE.test(text) && !ACTION_AT_START_RE.test(text) && !REQUEST_PREFIX_RE.test(text)) return "none";
  if (EXPLANATION_REQUEST_RE.test(text)) return "none";
  if (isVagueCandidate(text)) return "none";
  if (hasMultipleTasks(source)) return "ambiguous";

  const hasAction = ACTION_AT_START_RE.test(text) || REQUEST_PREFIX_RE.test(text) || REQUIREMENT_RE.test(text);
  if (!hasAction || text.length < 6) return "none";
  return "clear";
}

function isVagueCandidate(text: string): boolean {
  if (PRONOUN_ONLY_RE.test(text) || VAGUE_ACTION_RE.test(text)) return true;
  const stripped = text.replace(REQUEST_PREFIX_RE, "").trim();
  return stripped !== text && VAGUE_ACTION_RE.test(stripped);
}

function candidateFrom(text: string, source: Candidate["source"], truncated = false): Candidate | null {
  const normalized = normalizeWhitespace(text);
  const kind = classifyCandidate(normalized, truncated);
  if (kind !== "clear") return null;
  return { text: normalized, source };
}

function boundedSeed(candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const seed = candidates.slice(0, 3).join("\n");
  return seed.length <= START_CONTEXT_MAX_CHARS ? seed : seed.slice(0, START_CONTEXT_MAX_CHARS).trimEnd();
}

/**
 * Read only the active session branch and retain a small tail of real
 * user/assistant messages. `getBranch()` is preferred deliberately: using
 * all entries would allow an abandoned branch or old tool transcript to
 * become the objective of a new explicit start command.
 */
export function readBoundedStartContext(sessionManager: unknown): StartContextWindow {
  const manager = sessionManager as { getBranch?: () => unknown[] } | undefined;
  let entries: unknown[] = [];
  try {
    const branch = manager?.getBranch?.();
    entries = Array.isArray(branch) ? branch.slice(-START_CONTEXT_MAX_ENTRIES) : [];
  } catch {
    return { currentPrompt: "", recent: [] };
  }

  const turns: StartContextTurn[] = [];
  for (const raw of entries) {
    const entry = raw as RawSessionEntry;
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const rawText = textFromContent(entry.message?.content);
    if (!rawText.trim()) continue;
    const normalized = rawText.replace(/\r\n?/g, "\n").trim();
    const text = normalized.slice(0, START_CONTEXT_MAX_TURN_CHARS);
    turns.push({
      role,
      text,
      ...(text.length < normalized.length ? { truncated: true } : {}),
    });
  }

  const selected: StartContextTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && selected.length < START_CONTEXT_MAX_TURNS; i -= 1) {
    const turn = turns[i]!;
    const remaining = START_CONTEXT_MAX_CHARS - chars;
    if (remaining <= 0) break;
    const text = turn.text.slice(0, remaining);
    if (!text) break;
    selected.push({
      role: turn.role,
      text,
      ...(turn.truncated || text.length < turn.text.length ? { truncated: true } : {}),
    });
    chars += text.length;
  }
  selected.reverse();

  let currentIndex = -1;
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    if (selected[i]!.role === "user") {
      currentIndex = i;
      break;
    }
  }
  if (currentIndex < 0) return { currentPrompt: "", recent: selected };
  const current = selected[currentIndex]!;
  return {
    currentPrompt: current.text,
    ...(current.truncated ? { currentPromptTruncated: true } : {}),
    recent: selected.filter((_turn, index) => index !== currentIndex),
  };
}

/**
 * Infer one actionable user objective from an explicit current prompt plus
 * the already-bounded recent window. This function never treats assistant
 * text as authority and never chooses between two distinct user requests.
 */
export function inferStartObjective(
  currentPrompt: string,
  recent: readonly StartContextTurn[],
  options: { currentPromptTruncated?: boolean } = {},
): StartContextInference {
  const candidates: Candidate[] = [];
  let hadAmbiguousText = false;

  const currentSource = currentPrompt.replace(/\r\n?/g, "\n").trim();
  const current = normalizeWhitespace(currentSource);
  if (current) {
    const currentKind = classifyCandidate(currentSource, options.currentPromptTruncated);
    if (currentKind === "clear") {
      candidates.push({ text: current, source: "current-prompt" });
    } else if (currentKind === "ambiguous") {
      hadAmbiguousText = true;
    }
  }

  // Newest context wins only when it is the sole clear request. We still
  // inspect every bounded user turn so two distinct requests fail closed.
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i]!;
    if (turn.role !== "user") continue;
    const kind = classifyCandidate(turn.text, turn.truncated);
    if (kind === "ambiguous") {
      hadAmbiguousText = true;
      continue;
    }
    if (kind !== "clear") continue;
    const candidate = candidateFrom(turn.text, "recent-context", turn.truncated);
    if (candidate) candidates.push(candidate);
  }

  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = normalizeKey(candidate.text);
    if (key && !unique.has(key)) unique.set(key, candidate);
  }
  const distinct = [...unique.values()];

  if (distinct.length === 1 && !hadAmbiguousText) {
    return {
      kind: "clear",
      objective: distinct[0]!.text,
      source: distinct[0]!.source,
    };
  }
  if (distinct.length > 0 || hadAmbiguousText) {
    return {
      kind: "ambiguous",
      candidates: distinct.map((candidate) => candidate.text).slice(0, 3),
      ...(boundedSeed(distinct.map((candidate) => candidate.text)) ? { seed: boundedSeed(distinct.map((candidate) => candidate.text)) } : {}),
      reason: distinct.length > 1 ? "multiple-objectives" : "unclear-objective",
    };
  }
  return {
    kind: "none",
    reason: current || recent.length > 0 ? "no-actionable-objective" : "no-context",
  };
}

/** Convenience used by command handlers; failures produce no candidate. */
export function inferStartFromSession(sessionManager: unknown): StartContextInference {
  const window = readBoundedStartContext(sessionManager);
  return inferStartObjective(window.currentPrompt, window.recent, {
    currentPromptTruncated: window.currentPromptTruncated,
  });
}

/** Acknowledgment openers: the user is responding to a proposal, not
 * stating an objective. `\b` keeps "goals"/"going" out. */
const ACK_PREFIX_RE = /^(?:ok(?:ay)?|yes|yeah|yep|sure|go|fine|great|perfect|thanks?|thank\s+you)\b[\s,—–-]*/i;

/** Field 2026-09-16 (VidPro ledger: `/goal tweak` adopted "ok adjsut it"
 * as the objective): chatter is an acknowledgment / pronoun / bare vague
 * action — possibly behind an ack opener ("ok adjust it") — never a
 * self-contained objective. Deliberately NOT length-based: short-but-real
 * objectives ("fix typo in X") pass through untouched. Questions pass
 * through too — only the acknowledgment shapes divert. */
export function isChatterReplacement(text: string): boolean {
  const clean = normalizeWhitespace(text ?? "");
  if (!clean) return false;
  if (GENERIC_REPLY_RE.test(clean) || PRONOUN_ONLY_RE.test(clean) || VAGUE_ACTION_RE.test(clean)) return true;
  const stripped = clean.replace(ACK_PREFIX_RE, "").trim();
  if (stripped !== clean) return stripped ? classifyCandidate(stripped) !== "clear" : true;
  return false;
}

export type TweakReplacement =
  | { kind: "verbatim" }
  | { kind: "inferred"; text: string; source: "current-prompt" | "recent-context" }
  | { kind: "unresolvable"; reason: "ambiguous" | "none"; candidates: string[] };

/** Resolve a tweak/update replacement against what was actually discussed.
 * Self-contained text is adopted verbatim (today's path, byte-identical).
 * Chatter ("go fix it", "ok adjsut it") resolves via the session
 * context into the discussed objective — the user pointed at the context,
 * so the context supplies the words. When nothing clear was discussed,
 * the caller guides instead of adopting garbage: raw chatter must never
 * land in the ledger as an objective again. */
export function resolveTweakReplacement(raw: string, sessionManager: unknown): TweakReplacement {
  if (!isChatterReplacement(raw)) return { kind: "verbatim" };
  const inference = inferStartFromSession(sessionManager);
  if (inference.kind === "clear") return { kind: "inferred", text: inference.objective, source: inference.source };
  if (inference.kind === "ambiguous") {
    return { kind: "unresolvable", reason: "ambiguous", candidates: inference.candidates };
  }
  return { kind: "unresolvable", reason: "none", candidates: [] };
}
