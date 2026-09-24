/**
 * GLLA drafting interview state.
 *
 * The interview is deliberately ephemeral.  It records what was actually
 * asked and answered so the drafting prompt, proposal gate, and UI can share
 * one source of truth without adding another durable/ambient state slot.
 * Nothing in this module infers an answer: an answer exists only when it was
 * supplied by a user message or a question-tool result.
 */

export const INITIAL_DRAFTING_ESTIMATE = 4;

export type DraftingInterviewStatus =
  | "idle"
  | "pending-draft"
  | "needs-user-input"
  | "ready-to-confirm"
  | "activated"
  | "blocked"
  | "done";

export type DraftingClarificationCategory =
  | "scope"
  | "acceptance"
  | "risks"
  | "tradeoffs"
  | "out-of-scope"
  | "non-negotiables"
  | "assumptions"
  | "unanswered";

export type DraftingQuestionState = "asked" | "answered" | "cancelled";
export type DraftingClarificationState = "open" | "answered" | "approved" | "cancelled" | "assumption";

export interface DraftingQuestionRecord {
  id: string;
  round: number;
  text: string;
  category: DraftingClarificationCategory;
  state: DraftingQuestionState;
  askedAt: string;
  toolCallId?: string;
  inputFingerprint: string;
}

export interface DraftingAnswerRecord {
  id: string;
  round: number;
  questionId?: string;
  questionIndex?: number;
  text: string;
  source: "question-tool" | "user-message";
  evidence: string;
  answeredAt: string;
}

export interface DraftingClarification {
  id: string;
  category: DraftingClarificationCategory;
  question: string;
  answer?: string;
  state: DraftingClarificationState;
  evidence?: string;
}

export interface DraftingPendingCall {
  id: string;
  round: number;
  toolCallId?: string;
  inputFingerprint: string;
  questionIds: string[];
  questionTexts: string[];
  startedAt: string;
  implicit?: boolean;
}

export interface DraftingInterviewSnapshot {
  active: boolean;
  target: "goal" | "list" | "loop" | null;
  seed?: string;
  generation: number;
  initialEstimate: number;
  estimate: number;
  completedRounds: number;
  progress: string;
  status: DraftingInterviewStatus;
  statusLabel: string;
  pending: DraftingPendingCall | null;
  questions: DraftingQuestionRecord[];
  answers: DraftingAnswerRecord[];
  clarifications: DraftingClarification[];
  approvedClarifications: DraftingClarification[];
  remainingClarification: string[];
  latestQuestion?: string;
  latestAnswer?: string;
  summary?: string;
  blockedReason?: string;
}

export interface DraftingInterviewStartOptions {
  target: "goal" | "list" | "loop";
  seed?: string;
  generation?: number;
  initialEstimate?: number;
}

export interface DraftingQuestionCallOptions {
  generation?: number;
  toolCallId?: string;
}

export interface DraftingQuestionResultOptions extends DraftingQuestionCallOptions {
  input?: unknown;
  details?: unknown;
  answers?: unknown;
  cancelled?: unknown;
}

export interface DraftingQuestionCallResult {
  accepted: boolean;
  reason?: string;
  round?: number;
  pending?: DraftingPendingCall;
}

export interface DraftingQuestionResult {
  accepted: boolean;
  ignored?: boolean;
  cancelled?: boolean;
  completedRound?: boolean;
  reason?: string;
  round?: number;
  snapshot: DraftingInterviewSnapshot;
}

export interface NormalizedQuestionInput {
  questions: string[];
  raw: unknown;
  fingerprint: string;
}

export interface NormalizedQuestionResult {
  answers: string[];
  answerObjects: unknown[];
  cancelled: boolean;
  raw: unknown;
  fingerprint: string;
}

const STATUS_LABELS: Record<DraftingInterviewStatus, string> = {
  idle: "Idle",
  "pending-draft": "Pending draft",
  "needs-user-input": "Needs user input",
  "ready-to-confirm": "Ready to confirm",
  activated: "Activated",
  blocked: "Blocked",
  done: "Done",
};

function isoNow(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** A small deterministic fingerprint; this is identity evidence, not a security hash. */
export function draftingInputFingerprint(value: unknown): string {
  const text = stableSerialize(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length.toString(16)}`;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  if (isRecord(value)) {
    for (const key of ["text", "answer", "value", "label", "content"]) {
      if (key in value) {
        const text = asText(value[key]);
        if (text) return text;
      }
    }
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return "";
}

function questionListFrom(raw: unknown): string[] {
  const value = isRecord(raw) ? (raw.questions ?? raw.questionnaire ?? raw.items) : raw;
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item.trim();
    if (isRecord(item)) return asText(item.question ?? item.text ?? item.prompt ?? item.header);
    return asText(item);
  }).filter(Boolean);
}

/** Normalize typed Pi and legacy tool-call argument shapes. */
export function normalizeDraftingQuestionInput(raw: unknown): NormalizedQuestionInput {
  const questions = questionListFrom(raw);
  return { questions, raw, fingerprint: draftingInputFingerprint(raw) };
}

function answerObjectsFrom(raw: unknown): { objects: unknown[]; texts: string[] } {
  const value = isRecord(raw)
    ? (raw.answers ?? raw.answer ?? raw.responses ?? raw.results)
    : raw;
  const objects = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const texts = objects.map((item) => {
    if (typeof item === "string") return item.trim();
    if (isRecord(item)) {
      const direct = asText(item.answer ?? item.value ?? item.text ?? item.content ?? item.label);
      if (direct) return direct;
      if (Array.isArray(item.selectedOptions)) return item.selectedOptions.map(asText).filter(Boolean).join(", ");
    }
    return asText(item);
  }).filter(Boolean);
  return { objects, texts };
}

function cancelledFrom(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return raw.cancelled === true || raw.canceled === true || raw.cancelled === "true";
}

/** Normalize typed Pi, observed runtime, and legacy question-result shapes. */
export function normalizeDraftingQuestionResult(raw: unknown): NormalizedQuestionResult {
  const { objects, texts } = answerObjectsFrom(raw);
  return {
    answers: texts,
    answerObjects: objects,
    cancelled: cancelledFrom(raw),
    raw,
    fingerprint: draftingInputFingerprint(raw),
  };
}

function categoryForQuestion(question: string): DraftingClarificationCategory {
  const text = question.toLowerCase();
  if (/\b(out[- ]of[- ]scope|exclude|not include|outside|defer)\b/.test(text)) return "out-of-scope";
  if (/\b(accept|success|done when|verify|verification|evidence|test|criterion|criteria)\b/.test(text)) return "acceptance";
  if (/\b(risk|failure|fail|security|privacy|regression|edge case)\b/.test(text)) return "risks";
  if (/\b(trade[- ]?off|versus|vs\.?|compare|prefer|choice)\b/.test(text)) return "tradeoffs";
  if (/\b(must|non[- ]negotiable|constraint|require|invariant|never)\b/.test(text)) return "non-negotiables";
  if (/\b(assume|assumption|unknown|unclear|if no)\b/.test(text)) return "assumptions";
  if (/\b(scope|boundary|include|feature|deliver|goal|objective)\b/.test(text)) return "scope";
  return "unanswered";
}

function clonePending(pending: DraftingPendingCall | null): DraftingPendingCall | null {
  return pending ? { ...pending, questionIds: [...pending.questionIds], questionTexts: [...pending.questionTexts] } : null;
}

function cloneQuestion(question: DraftingQuestionRecord): DraftingQuestionRecord {
  return { ...question };
}

function cloneAnswer(answer: DraftingAnswerRecord): DraftingAnswerRecord {
  return { ...answer };
}

function cloneClarification(clarification: DraftingClarification): DraftingClarification {
  return { ...clarification };
}

/**
 * Owns one drafting interview.  A fresh instance is cheap; tests should make
 * one directly instead of relying on process-global state.
 */
export class DraftingInterviewTracker {
  private generationCounter = 0;
  private sequence = 0;
  private active = false;
  private target: "goal" | "list" | "loop" | null = null;
  private seed: string | undefined;
  private status: DraftingInterviewStatus = "idle";
  private initialEstimate = INITIAL_DRAFTING_ESTIMATE;
  private estimate = INITIAL_DRAFTING_ESTIMATE;
  private completedRounds = 0;
  private pending: DraftingPendingCall | null = null;
  private questions: DraftingQuestionRecord[] = [];
  private answers: DraftingAnswerRecord[] = [];
  private clarifications: DraftingClarification[] = [];
  private seenResults = new Set<string>();
  private blockedReason: string | undefined;

  start(options: DraftingInterviewStartOptions): DraftingInterviewSnapshot {
    this.reset();
    this.target = options.target;
    this.seed = options.seed?.trim() || undefined;
    this.initialEstimate = Math.max(1, Math.floor(options.initialEstimate ?? INITIAL_DRAFTING_ESTIMATE));
    this.estimate = this.initialEstimate;
    this.active = true;
    this.status = "pending-draft";
    this.blockedReason = undefined;
    if (typeof options.generation === "number") this.generationCounter = Math.max(this.generationCounter, options.generation);
    return this.snapshot();
  }

  /** Clear live interview state and fence every late event from the old run. */
  reset(): void {
    this.generationCounter++;
    this.sequence = 0;
    this.active = false;
    this.target = null;
    this.seed = undefined;
    this.status = "idle";
    this.initialEstimate = INITIAL_DRAFTING_ESTIMATE;
    this.estimate = INITIAL_DRAFTING_ESTIMATE;
    this.completedRounds = 0;
    this.pending = null;
    this.questions = [];
    this.answers = [];
    this.clarifications = [];
    this.seenResults.clear();
    this.blockedReason = undefined;
  }

  isActive(): boolean {
    return this.active;
  }

  hasPendingCall(): boolean {
    return this.pending !== null;
  }

  /** The initial four is an estimate, never a hard quota. */
  reviseEstimate(nextEstimate: number, _reason?: string): number {
    if (!Number.isFinite(nextEstimate)) return this.estimate;
    const next = Math.max(1, Math.floor(nextEstimate));
    if (next > this.estimate) this.estimate = next;
    return this.estimate;
  }

  private stale(generation?: number): boolean {
    return typeof generation === "number" && generation !== this.generationCounter;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.generationCounter}-${this.sequence}`;
  }

  private ensureEstimateForRound(round: number): void {
    if (round > this.estimate) this.estimate = round;
  }

  beginQuestionCall(rawInput: unknown, options: DraftingQuestionCallOptions = {}): DraftingQuestionCallResult {
    if (this.stale(options.generation)) return { accepted: false, reason: "stale drafting interview" };
    if (!this.active) return { accepted: false, reason: "drafting interview is not active" };
    if (this.pending) {
      return { accepted: false, reason: "A drafting question is already waiting for an answer. Wait for it before asking dependent questions.", pending: clonePending(this.pending) ?? undefined };
    }
    const normalized = normalizeDraftingQuestionInput(rawInput);
    if (normalized.questions.length === 0) return { accepted: false, reason: "ask_user_question needs at least one question" };
    // The opening exchange is intentionally singular. Later rounds may batch
    // independent questions, but a dependent question cannot be smuggled into
    // the first call.
    if (this.completedRounds === 0 && normalized.questions.length !== 1) {
      return { accepted: false, reason: "Start the drafting interview with ONE ordinary, seed-specific question. Wait for its answer before asking dependent follow-ups." };
    }
    const round = this.completedRounds + 1;
    this.ensureEstimateForRound(round);
    const fingerprint = normalized.fingerprint;
    const id = options.toolCallId?.trim() || `${this.nextId("call")}-${fingerprint}`;
    const startedAt = isoNow();
    const questionIds: string[] = [];
    const questionTexts: string[] = [];
    for (const text of normalized.questions) {
      const id = this.nextId("question");
      const category = categoryForQuestion(text);
      this.questions.push({ id, round, text, category, state: "asked", askedAt: startedAt, toolCallId: options.toolCallId, inputFingerprint: fingerprint });
      this.clarifications.push({ id: `clarification-${id}`, category, question: text, state: "open" });
      questionIds.push(id);
      questionTexts.push(text);
    }
    this.pending = { id, round, toolCallId: options.toolCallId, inputFingerprint: fingerprint, questionIds, questionTexts, startedAt };
    this.status = "needs-user-input";
    return { accepted: true, round, pending: clonePending(this.pending) ?? undefined };
  }

  private implicitPending(rawInput: unknown, result: NormalizedQuestionResult): DraftingPendingCall {
    const input = rawInput === undefined ? result.raw : rawInput;
    const normalized = normalizeDraftingQuestionInput(input);
    const round = this.completedRounds + 1;
    this.ensureEstimateForRound(round);
    const texts = normalized.questions.length > 0 ? normalized.questions : ["(question text unavailable)"];
    const ids: string[] = [];
    const startedAt = isoNow();
    for (const text of texts) {
      const id = this.nextId("question");
      const category = categoryForQuestion(text);
      this.questions.push({ id, round, text, category, state: "asked", askedAt: startedAt, inputFingerprint: normalized.fingerprint });
      this.clarifications.push({ id: `clarification-${id}`, category, question: text, state: "open" });
      ids.push(id);
    }
    return { id: this.nextId("legacy-result"), round, inputFingerprint: normalized.fingerprint, questionIds: ids, questionTexts: texts, startedAt, implicit: true };
  }

  completeQuestionCall(rawResult: unknown, options: DraftingQuestionResultOptions = {}): DraftingQuestionResult {
    if (this.stale(options.generation)) return { accepted: false, ignored: true, reason: "stale drafting interview", snapshot: this.snapshot() };
    if (!this.active) return { accepted: false, ignored: true, reason: "drafting interview is not active", snapshot: this.snapshot() };
    const normalized = normalizeDraftingQuestionResult(rawResult ?? options.details ?? options.answers);
    const resultKey = `${options.toolCallId ?? "no-id"}:${normalized.fingerprint}`;
    if (this.seenResults.has(resultKey)) return { accepted: false, ignored: true, reason: "duplicate question result", snapshot: this.snapshot() };
    this.seenResults.add(resultKey);

    let pending = this.pending;
    if (pending && options.toolCallId && pending.toolCallId && options.toolCallId !== pending.toolCallId) {
      const inputNormalized = normalizeDraftingQuestionInput(options.input);
      if (inputNormalized.fingerprint !== pending.inputFingerprint) {
        return { accepted: false, ignored: true, reason: "late or mismatched question result", snapshot: this.snapshot() };
      }
    }
    // Older tests and some Pi versions emitted a result without a preceding
    // tool_call. Treat it as an implicit round instead of dropping the answer.
    if (!pending) pending = this.implicitPending(options.input, normalized);
    const round = pending.round;
    const pendingIds = new Set(pending.questionIds);
    if (normalized.cancelled || normalized.answers.length === 0) {
      for (const question of this.questions) {
        if (pendingIds.has(question.id) && question.state === "asked") {
          question.state = "cancelled";
          const clarification = this.clarifications.find((item) => item.question === question.text);
          if (clarification) clarification.state = "cancelled";
        }
      }
      this.pending = null;
      this.status = "needs-user-input";
      return { accepted: true, cancelled: true, completedRound: false, round, snapshot: this.snapshot() };
    }

    const answerByIndex = new Map<number, string>();
    normalized.answerObjects.forEach((item, index) => {
      if (isRecord(item) && typeof item.questionIndex === "number") answerByIndex.set(item.questionIndex, asText(item.answer ?? item.value ?? item.text ?? item.content ?? item.label));
      else if (!answerByIndex.has(index)) answerByIndex.set(index, normalized.answers[index] ?? asText(item));
    });
    normalized.answers.forEach((answer, index) => {
      if (!answerByIndex.has(index)) answerByIndex.set(index, answer);
    });
    let answered = 0;
    pending.questionIds.forEach((questionId, index) => {
      const answer = answerByIndex.get(index) ?? "";
      if (!answer) return;
      answered++;
      const question = this.questions.find((item) => item.id === questionId);
      if (!question || question.state !== "asked") return;
      question.state = "answered";
      const clarification = this.clarifications.find((item) => item.question === question.text);
      if (clarification) {
        clarification.answer = answer;
        clarification.state = "answered";
        clarification.evidence = `round ${round}, answer ${index + 1}`;
      }
      this.answers.push({
        id: this.nextId("answer"),
        round,
        questionId,
        questionIndex: index,
        text: answer,
        source: "question-tool",
        evidence: `tool result ${options.toolCallId ?? "legacy"}`,
        answeredAt: isoNow(),
      });
    });
    // A result with only some answers leaves the unanswered questions open;
    // it is still a completed interaction, not a fabricated full round.
    if (answered > 0) this.completedRounds++;
    this.ensureEstimateForRound(this.completedRounds);
    this.pending = null;
    this.status = pending.questionIds.some((id) => this.questions.find((question) => question.id === id)?.state === "asked") ? "needs-user-input" : "pending-draft";
    return { accepted: true, completedRound: answered > 0, round, snapshot: this.snapshot() };
  }

  noteUserReply(text: string, generation?: number): DraftingAnswerRecord | undefined {
    if (this.stale(generation) || !this.active) return undefined;
    const answer = text.trim();
    if (!answer) return undefined;
    const openQuestion = [...this.questions].reverse().find((question) => question.state === "asked");
    const round = openQuestion?.round ?? this.completedRounds;
    const record: DraftingAnswerRecord = {
      id: this.nextId("answer"),
      round,
      questionId: openQuestion?.id,
      text: answer,
      source: "user-message",
      evidence: openQuestion ? `user reply to ${openQuestion.id}` : "user message during drafting",
      answeredAt: isoNow(),
    };
    this.answers.push(record);
    if (openQuestion) {
      openQuestion.state = "answered";
      const clarification = this.clarifications.find((item) => item.question === openQuestion.text);
      if (clarification) {
        clarification.answer = answer;
        clarification.state = "answered";
        clarification.evidence = record.evidence;
      }
      this.completedRounds++;
      this.ensureEstimateForRound(this.completedRounds);
      this.pending = null;
    }
    this.status = "pending-draft";
    return { ...record };
  }

  unresolvedClarification(): string[] {
    const values: string[] = [];
    if (this.pending) values.push(`waiting for the answer to: ${this.pending.questionTexts[0] ?? "the current question"}`);
    for (const question of this.questions) {
      if (question.state === "asked" || question.state === "cancelled") values.push(question.text);
    }
    return [...new Set(values)];
  }

  proposalBlock(): string | null {
    if (!this.active || this.status === "activated" || this.status === "done") return null;
    const unresolved = this.unresolvedClarification();
    if (unresolved.length === 0) return null;
    return `CLARIFICATIONS INCOMPLETE — answer the remaining drafting question(s) before proposing a contract: ${unresolved.slice(0, 3).join(" ")} Do not invent answers or activate a partial contract.`;
  }

  markReadyToConfirm(): boolean {
    if (!this.active || this.proposalBlock()) return false;
    this.status = "ready-to-confirm";
    for (const clarification of this.clarifications) {
      if (clarification.state === "answered") clarification.state = "approved";
    }
    return true;
  }

  markNeedsUserInput(reason?: string): void {
    if (!this.active) return;
    this.status = "needs-user-input";
    this.blockedReason = reason;
  }

  markBlocked(reason: string): void {
    this.status = "blocked";
    this.blockedReason = reason;
  }

  markActivated(): void {
    this.status = "activated";
    this.blockedReason = undefined;
    for (const clarification of this.clarifications) {
      if (clarification.state === "answered" || clarification.state === "approved") clarification.state = "approved";
    }
  }

  markDone(): void {
    this.status = "done";
    this.pending = null;
  }

  snapshot(): DraftingInterviewSnapshot {
    const questions = this.questions.map(cloneQuestion);
    const answers = this.answers.map(cloneAnswer);
    const clarifications = this.clarifications.map(cloneClarification);
    const approved = clarifications.filter((item) => item.state === "approved");
    const remaining = this.unresolvedClarification();
    const latestQuestion = questions.at(-1)?.text;
    const latestAnswer = answers.at(-1)?.text;
    let summary: string | undefined;
    if (this.status === "ready-to-confirm" || this.status === "activated" || this.status === "done") {
      summary = `Clarifications reviewed · ${this.completedRounds}/${this.estimate}`;
    }
    return {
      active: this.active,
      target: this.target,
      seed: this.seed,
      generation: this.generationCounter,
      initialEstimate: this.initialEstimate,
      estimate: this.estimate,
      completedRounds: this.completedRounds,
      progress: `${this.completedRounds}/${this.estimate}`,
      status: this.status,
      statusLabel: STATUS_LABELS[this.status],
      pending: clonePending(this.pending),
      questions,
      answers,
      clarifications,
      approvedClarifications: approved.map(cloneClarification),
      remainingClarification: remaining,
      latestQuestion,
      latestAnswer,
      summary,
      blockedReason: this.blockedReason,
    };
  }
}

export function createDraftingInterview(): DraftingInterviewTracker {
  return new DraftingInterviewTracker();
}

export function draftingProgress(snapshot: DraftingInterviewSnapshot | null | undefined): string {
  return snapshot?.progress ?? `0/${INITIAL_DRAFTING_ESTIMATE}`;
}

export function draftingStatusLabel(snapshot: DraftingInterviewSnapshot | null | undefined): string {
  return snapshot?.statusLabel ?? "Idle";
}
