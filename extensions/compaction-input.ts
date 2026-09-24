// pi-goal-list-loop-audit — bounded compaction input
//
// Pi's default compactor serializes the prepared history into a summarization
// prompt.  Tool-result text is capped by pi, but assistant text/thinking and
// tool-call arguments are not.  A long successful run can therefore make the
// summarizer spend its entire output budget reasoning about the input and
// finish with an incomplete summary (the field symptom: "generation hit the
// token cap and the summary is incomplete").
//
// This module is deliberately a preparation *projection*, not a compactor.
// It clones messages and trims mutable content while retaining every message,
// tool-call block, tool-result block, id, role, and ordering relationship.  Pi
// still owns the cut point, file-operation extraction, previous summary,
// settings, and the actual summarization call.  No CompactionResult is ever
// produced here, so another extension's session_before_compact result remains
// authoritative.

/** Soft budget for mutable content sent to the summarizer. */
export const DEFAULT_COMPACTION_INPUT_CHAR_BUDGET = 64_000;

/** Per-field ceilings before the global budget pass. */
export const DEFAULT_MAX_COMPACTION_TEXT_CHARS = 4_096;
export const DEFAULT_MAX_COMPACTION_THINKING_CHARS = 1_024;
export const DEFAULT_MAX_COMPACTION_TOOL_ARGUMENT_CHARS = 1_536;
export const DEFAULT_MAX_COMPACTION_TOOL_RESULT_CHARS = 2_000;
export const DEFAULT_MAX_COMPACTION_USER_CHARS = 4_096;
export const DEFAULT_MAX_COMPACTION_CUSTOM_CHARS = 4_096;
export const DEFAULT_MAX_COMPACTION_BASH_OUTPUT_CHARS = 4_096;
export const DEFAULT_MAX_COMPACTION_SUMMARY_CHARS = 8_192;

const TRUNCATION_MARKER = "\n[…glla compaction truncation; full content remains in the session transcript…]";
const COMPACT_TRUNCATION_MARKER = "…";
const GOAL_PAYLOAD_PLACEHOLDER = "[GLLA continuation payload omitted from compaction input; durable state remains in .pi-glla]";
const MAX_TOOL_ARGUMENT_KEYS = 12;
const MAX_TOOL_ARGUMENT_ARRAY_ITEMS = 8;
const MAX_TOOL_ARGUMENT_DEPTH = 3;
const MIN_SCALED_TEXT_CHARS = 32;
const MIN_SCALED_ARGUMENT_CHARS = 64;

export interface CompactionInputOptions {
  /** Maximum estimated mutable input characters. Must be positive. */
  maxInputChars?: number;
  maxTextChars?: number;
  maxThinkingChars?: number;
  maxToolArgumentChars?: number;
  maxToolResultChars?: number;
  maxUserChars?: number;
  maxCustomChars?: number;
  maxBashOutputChars?: number;
  maxSummaryChars?: number;
}

export interface CompactionInputStats {
  /** Estimated mutable content size before projection. */
  inputCharsBefore: number;
  /** Estimated mutable content size after projection. */
  inputCharsAfter: number;
  /** Number of messages whose content was cloned/changed. */
  boundedMessages: number;
  /** Number of individual text/argument fields shortened. */
  boundedFields: number;
  /** Number of image blocks replaced with text placeholders. */
  replacedImages: number;
  /** Old GLLA goal-event payloads replaced by a bounded marker. */
  boundedGoalPayloads: number;
  /** GLLA goal-event payloads retained (normally zero or one). */
  retainedGoalPayloads: number;
  /** Final per-field scale selected by the global budget pass. */
  scale: number;
}

export interface CompactionInputProjectionResult extends CompactionInputStats {
  changed: boolean;
  messagesToSummarize: readonly unknown[];
  turnPrefixMessages: readonly unknown[];
}

interface ProjectionLimits {
  text: number;
  thinking: number;
  toolArguments: number;
  toolResult: number;
  user: number;
  custom: number;
  bashOutput: number;
  summary: number;
}

interface FieldProjection {
  value: unknown;
  changed: boolean;
  fields: number;
}

interface MessageProjection {
  value: unknown;
  changed: boolean;
  fields: number;
  images: number;
}

function positiveLimit(value: unknown, fallback: number, minimum = 1): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

function baseLimits(options: CompactionInputOptions): ProjectionLimits {
  return {
    text: positiveLimit(options.maxTextChars, DEFAULT_MAX_COMPACTION_TEXT_CHARS),
    thinking: positiveLimit(options.maxThinkingChars, DEFAULT_MAX_COMPACTION_THINKING_CHARS),
    toolArguments: positiveLimit(options.maxToolArgumentChars, DEFAULT_MAX_COMPACTION_TOOL_ARGUMENT_CHARS),
    toolResult: positiveLimit(options.maxToolResultChars, DEFAULT_MAX_COMPACTION_TOOL_RESULT_CHARS),
    user: positiveLimit(options.maxUserChars, DEFAULT_MAX_COMPACTION_USER_CHARS),
    custom: positiveLimit(options.maxCustomChars, DEFAULT_MAX_COMPACTION_CUSTOM_CHARS),
    bashOutput: positiveLimit(options.maxBashOutputChars, DEFAULT_MAX_COMPACTION_BASH_OUTPUT_CHARS),
    summary: positiveLimit(options.maxSummaryChars, DEFAULT_MAX_COMPACTION_SUMMARY_CHARS),
  };
}

function scaledLimit(value: number, scale: number, minimum: number): number {
  return Math.max(minimum, Math.max(1, Math.floor(value * scale)));
}

function scaleLimits(limits: ProjectionLimits, scale: number): ProjectionLimits {
  return {
    text: scaledLimit(limits.text, scale, MIN_SCALED_TEXT_CHARS),
    thinking: scaledLimit(limits.thinking, scale, Math.min(MIN_SCALED_TEXT_CHARS, limits.thinking)),
    toolArguments: scaledLimit(limits.toolArguments, scale, MIN_SCALED_ARGUMENT_CHARS),
    toolResult: scaledLimit(limits.toolResult, scale, MIN_SCALED_TEXT_CHARS),
    user: scaledLimit(limits.user, scale, MIN_SCALED_TEXT_CHARS),
    custom: scaledLimit(limits.custom, scale, MIN_SCALED_TEXT_CHARS),
    bashOutput: scaledLimit(limits.bashOutput, scale, MIN_SCALED_TEXT_CHARS),
    summary: scaledLimit(limits.summary, scale, MIN_SCALED_TEXT_CHARS),
  };
}

/** Keep both ends of a value: paths/errors at the tail are often useful. */
export function boundCompactionText(value: string, maxChars: number): string {
  const limit = positiveLimit(maxChars, 1);
  if (value.length <= limit) return value;
  if (limit <= 48) return value.slice(0, limit);
  const marker = TRUNCATION_MARKER.length < limit - 16 ? TRUNCATION_MARKER : COMPACT_TRUNCATION_MARKER;
  const room = Math.max(1, limit - marker.length);
  const head = Math.max(1, Math.ceil(room * 0.65));
  const tail = Math.max(0, room - head);
  return value.slice(0, head) + marker + (tail > 0 ? value.slice(-tail) : "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : undefined;
  } catch {
    return undefined;
  }
}

function isPathKey(key: string): boolean {
  return key === "path" || key === "file" || key === "filePath" || key.endsWith("Path");
}

/**
 * Bound an arbitrary JSON value without ever returning a non-object for a
 * normal tool call.  This is intentionally conservative: familiar scalar
 * fields (especially paths) stay visible, while large nested payloads become
 * bounded excerpts.
 */
function boundJsonValue(
  value: unknown,
  maxChars: number,
  depth: number,
  ancestors: Set<object>,
): unknown {
  const limit = positiveLimit(maxChars, MIN_SCALED_ARGUMENT_CHARS);
  if (typeof value === "string") return boundCompactionText(value, limit);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value).slice(0, limit);
  if (depth >= MAX_TOOL_ARGUMENT_DEPTH) return "[bounded nested value]";
  if (ancestors.has(value)) return "[circular value]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_TOOL_ARGUMENT_ARRAY_ITEMS).map((item) => (
        boundJsonValue(item, Math.max(MIN_SCALED_ARGUMENT_CHARS, Math.floor(limit / MAX_TOOL_ARGUMENT_ARRAY_ITEMS)), depth + 1, ancestors)
      ));
      if (value.length > MAX_TOOL_ARGUMENT_ARRAY_ITEMS) kept.push(`[${value.length - MAX_TOOL_ARGUMENT_ARRAY_ITEMS} more items omitted]`);
      return kept;
    }

    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    // Paths are the most valuable bounded arguments for a continuation summary.
    entries.sort(([left], [right]) => Number(isPathKey(right)) - Number(isPathKey(left)));
    for (const [key, item] of entries.slice(0, MAX_TOOL_ARGUMENT_KEYS)) {
      const perValue = isPathKey(key)
        ? Math.max(MIN_SCALED_ARGUMENT_CHARS, Math.floor(limit / 3))
        : Math.max(MIN_SCALED_ARGUMENT_CHARS, Math.floor(limit / MAX_TOOL_ARGUMENT_KEYS));
      out[key] = boundJsonValue(item, perValue, depth + 1, ancestors);
    }
    if (entries.length > MAX_TOOL_ARGUMENT_KEYS) out.__glla_truncated_keys = entries.length - MAX_TOOL_ARGUMENT_KEYS;
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function boundToolArguments(value: unknown, maxChars: number): FieldProjection {
  const encoded = safeJson(value);
  if (isRecord(value) && encoded !== undefined && encoded.length <= maxChars) {
    return { value, changed: false, fields: 0 };
  }
  if (!isRecord(value)) {
    const bounded = boundJsonValue(value, Math.max(MIN_SCALED_ARGUMENT_CHARS, maxChars), 0, new Set());
    return { value: { value: bounded }, changed: true, fields: 1 };
  }

  const limit = positiveLimit(maxChars, DEFAULT_MAX_COMPACTION_TOOL_ARGUMENT_CHARS, MIN_SCALED_ARGUMENT_CHARS);
  const projected = boundJsonValue(value, limit, 0, new Set()) as Record<string, unknown>;
  const projectedEncoded = safeJson(projected) ?? "";
  if (projectedEncoded === encoded) return { value, changed: false, fields: 0 };
  return { value: projected, changed: true, fields: 1 };
}

function imagePlaceholder(): { type: "text"; text: string } {
  return { type: "text", text: "[image omitted from compaction input; image remains in the session transcript]" };
}

function projectContentBlock(
  block: unknown,
  limits: ProjectionLimits,
  textLimit: number,
): FieldProjection & { image: boolean } {
  if (!isRecord(block)) return { value: block, changed: false, fields: 0, image: false };
  if (block.type === "text" && typeof block.text === "string") {
    const text = boundCompactionText(block.text, textLimit);
    return text === block.text
      ? { value: block, changed: false, fields: 0, image: false }
      : { value: { ...block, text }, changed: true, fields: 1, image: false };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    const thinking = boundCompactionText(block.thinking, limits.thinking);
    return thinking === block.thinking
      ? { value: block, changed: false, fields: 0, image: false }
      : { value: { ...block, thinking }, changed: true, fields: 1, image: false };
  }
  if (block.type === "toolCall") {
    const args = boundToolArguments(block.arguments, limits.toolArguments);
    return args.changed
      ? { value: { ...block, arguments: args.value }, changed: true, fields: args.fields, image: false }
      : { value: block, changed: false, fields: 0, image: false };
  }
  if (block.type === "image" && typeof block.data === "string") {
    return { value: imagePlaceholder(), changed: true, fields: 1, image: true };
  }
  return { value: block, changed: false, fields: 0, image: false };
}

function projectContentArray(
  content: readonly unknown[],
  limits: ProjectionLimits,
  textLimit: number,
): { value: unknown[]; changed: boolean; fields: number; images: number } {
  let changed = false;
  let fields = 0;
  let images = 0;
  const projected = content.map((block) => {
    const result = projectContentBlock(block, limits, textLimit);
    if (result.changed) {
      changed = true;
      fields += result.fields;
      if (result.image) images += 1;
    }
    return result.value;
  });
  // `textLimit` is intentionally accepted here to make the role-specific
  // policy explicit at call sites; the common block ceiling is still the
  // safety bound for mixed content arrays.
  void textLimit;
  return { value: projected, changed, fields, images };
}

function projectMessage(message: unknown, limits: ProjectionLimits): MessageProjection {
  if (!isRecord(message)) return { value: message, changed: false, fields: 0, images: 0 };
  const role = message.role;

  if (role === "assistant" && Array.isArray(message.content)) {
    const content = projectContentArray(message.content, limits, limits.text);
    if (!content.changed) return { value: message, changed: false, fields: 0, images: 0 };
    return {
      value: { ...message, content: content.value },
      changed: true,
      fields: content.fields,
      images: content.images,
    };
  }

  if (role === "user" && typeof message.content === "string") {
    const content = boundCompactionText(message.content, limits.user);
    return content === message.content
      ? { value: message, changed: false, fields: 0, images: 0 }
      : { value: { ...message, content }, changed: true, fields: 1, images: 0 };
  }

  if (role === "user" && Array.isArray(message.content)) {
    const content = projectContentArray(message.content, limits, limits.user);
    if (!content.changed) return { value: message, changed: false, fields: 0, images: 0 };
    return { value: { ...message, content: content.value }, changed: true, fields: content.fields, images: content.images };
  }

  if (role === "custom") {
    if (typeof message.content === "string") {
      const content = boundCompactionText(message.content, limits.custom);
      return content === message.content
        ? { value: message, changed: false, fields: 0, images: 0 }
        : { value: { ...message, content }, changed: true, fields: 1, images: 0 };
    }
    if (Array.isArray(message.content)) {
      const content = projectContentArray(message.content, limits, limits.custom);
      if (!content.changed) return { value: message, changed: false, fields: 0, images: 0 };
      return { value: { ...message, content: content.value }, changed: true, fields: content.fields, images: content.images };
    }
  }

  if (role === "toolResult") {
    if (typeof message.content === "string") {
      const content = boundCompactionText(message.content, limits.toolResult);
      return content === message.content
        ? { value: message, changed: false, fields: 0, images: 0 }
        : { value: { ...message, content }, changed: true, fields: 1, images: 0 };
    }
    if (Array.isArray(message.content)) {
      const content = projectContentArray(message.content, limits, limits.toolResult);
      if (!content.changed) return { value: message, changed: false, fields: 0, images: 0 };
      return { value: { ...message, content: content.value }, changed: true, fields: content.fields, images: content.images };
    }
  }

  if (role === "bashExecution") {
    let changed = false;
    let fields = 0;
    const command = typeof message.command === "string" ? boundCompactionText(message.command, limits.bashOutput) : message.command;
    const output = typeof message.output === "string" ? boundCompactionText(message.output, limits.bashOutput) : message.output;
    if (command !== message.command) { changed = true; fields += 1; }
    if (output !== message.output) { changed = true; fields += 1; }
    return changed
      ? { value: { ...message, command, output }, changed: true, fields, images: 0 }
      : { value: message, changed: false, fields: 0, images: 0 };
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    if (typeof message.summary === "string") {
      const summary = boundCompactionText(message.summary, limits.summary);
      return summary === message.summary
        ? { value: message, changed: false, fields: 0, images: 0 }
        : { value: { ...message, summary }, changed: true, fields: 1, images: 0 };
    }
  }

  return { value: message, changed: false, fields: 0, images: 0 };
}

function contentTextLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (!isRecord(block)) return sum;
    if (block.type === "text" && typeof block.text === "string") return sum + block.text.length;
    if (block.type === "image" && typeof block.data === "string") return sum + block.data.length;
    return sum;
  }, 0);
}

/** Approximate the text Pi's serializeConversation() sends, without importing
 * Pi runtime code into this pure module. */
function estimateMessageChars(message: unknown): number {
  if (!isRecord(message)) return 0;
  let chars = 24; // role label and separators
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
      else if (block.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
      else if (block.type === "toolCall") chars += String(block.name ?? "").length + (safeJson(block.arguments)?.length ?? 0);
    }
    return chars;
  }
  if (message.role === "user" || message.role === "custom" || message.role === "toolResult") {
    return chars + contentTextLength(message.content);
  }
  if (message.role === "bashExecution") {
    return chars + (typeof message.command === "string" ? message.command.length : 0) + (typeof message.output === "string" ? message.output.length : 0);
  }
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    return chars + (typeof message.summary === "string" ? message.summary.length : 0);
  }
  return chars;
}

function estimateMessagesChars(messages: readonly unknown[]): number {
  return messages.reduce<number>((sum, message) => sum + estimateMessageChars(message), 0);
}

function isGoalEvent(message: unknown): boolean {
  return isRecord(message) && message.customType === "goal-event";
}

/**
 * Keep only the newest GLLA continuation payload. Older payloads are replaced
 * (not removed) by a short marker so message order and any surrounding turn
 * structure remain visible without repeating a large control-plane prompt.
 */
function boundOldGoalPayloads(messages: readonly unknown[]): { messages: unknown[]; bounded: number; retained: number } {
  const indexes = messages.flatMap((message, index) => isGoalEvent(message) ? [index] : []);
  if (indexes.length === 0) return { messages: [...messages], bounded: 0, retained: 0 };
  const keep = new Set(indexes.slice(-1));
  let bounded = 0;
  const projected = messages.map((message, index) => {
    if (!isGoalEvent(message) || keep.has(index)) return message;
    bounded += 1;
    return { ...(message as Record<string, unknown>), content: GOAL_PAYLOAD_PLACEHOLDER };
  });
  return { messages: projected, bounded, retained: indexes.length - bounded };
}

function countChangedMessages(original: readonly unknown[], projected: readonly unknown[]): number {
  let changed = 0;
  const length = Math.max(original.length, projected.length);
  for (let index = 0; index < length; index += 1) {
    if (original[index] !== projected[index]) changed += 1;
  }
  return changed;
}

function countProjectionFields(messages: readonly unknown[]): { fields: number; images: number } {
  let fields = 0;
  let images = 0;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "image") { images += 1; continue; }
        // A bounded marker is the only projected text block we can identify
        // without retaining a side table. Count it as a bounded field.
        if (block.type === "text" && typeof block.text === "string" && block.text.includes("compaction input")) fields += 1;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.includes("compaction truncation")) fields += 1;
        if (block.type === "toolCall") {
          const args = safeJson(block.arguments) ?? "";
          if (args.includes("glla_truncated") || args.includes("compaction")) fields += 1;
        }
      }
    } else if (typeof message.content === "string" && message.content.includes("compaction")) fields += 1;
    if (message.role === "bashExecution" && ((typeof message.command === "string" && message.command.includes("compaction")) || (typeof message.output === "string" && message.output.includes("compaction")))) fields += 1;
    if ((message.role === "branchSummary" || message.role === "compactionSummary") && typeof message.summary === "string" && message.summary.includes("compaction")) fields += 1;
  }
  return { fields, images };
}

/**
 * Project a CompactionPreparation-shaped object in place.  Only the two
 * message-array properties are reassigned; fileOps and all preparation
 * metadata are deliberately left untouched.  The return value is suitable for
 * bounded ledger statistics and tests.
 */
export function projectCompactionPreparation(
  preparation: unknown,
  options: CompactionInputOptions = {},
): CompactionInputProjectionResult {
  const empty: CompactionInputProjectionResult = {
    changed: false,
    messagesToSummarize: [],
    turnPrefixMessages: [],
    inputCharsBefore: 0,
    inputCharsAfter: 0,
    boundedMessages: 0,
    boundedFields: 0,
    replacedImages: 0,
    boundedGoalPayloads: 0,
    retainedGoalPayloads: 0,
    scale: 1,
  };
  if (!isRecord(preparation)) return empty;

  const hasHistory = Array.isArray(preparation.messagesToSummarize);
  const hasPrefix = Array.isArray(preparation.turnPrefixMessages);
  if (!hasHistory && !hasPrefix) return empty;

  const history = hasHistory ? preparation.messagesToSummarize as unknown[] : [];
  const prefix = hasPrefix ? preparation.turnPrefixMessages as unknown[] : [];
  const original = [...history, ...prefix];
  const before = estimateMessagesChars(original);
  const goalProjection = boundOldGoalPayloads(original);
  const limits = baseLimits(options);
  const budget = positiveLimit(options.maxInputChars, DEFAULT_COMPACTION_INPUT_CHAR_BUDGET, 1_024);

  let scale = 1;
  let projected = goalProjection.messages.map((message) => projectMessage(message, limits).value);
  let after = estimateMessagesChars(projected);
  // A descending pass is intentionally simple and deterministic.  It avoids a
  // dependency on Pi's serializer and remains monotonic enough for the JSON
  // shaped values used by the preparation contract.
  while (after > budget && scale > 0.01) {
    scale = Math.max(0.01, scale * 0.65);
    const scaled = scaleLimits(limits, scale);
    projected = goalProjection.messages.map((message) => projectMessage(message, scaled).value);
    after = estimateMessagesChars(projected);
  }

  const bounded = countChangedMessages(original, projected);
  const fieldStats = countProjectionFields(projected);
  const result: CompactionInputProjectionResult = {
    changed: bounded > 0 || goalProjection.bounded > 0,
    messagesToSummarize: projected.slice(0, history.length),
    turnPrefixMessages: projected.slice(history.length),
    inputCharsBefore: before,
    inputCharsAfter: after,
    boundedMessages: bounded,
    boundedFields: fieldStats.fields,
    replacedImages: fieldStats.images,
    boundedGoalPayloads: goalProjection.bounded,
    retainedGoalPayloads: goalProjection.retained,
    scale,
  };

  if (hasHistory) preparation.messagesToSummarize = result.messagesToSummarize;
  if (hasPrefix) preparation.turnPrefixMessages = result.turnPrefixMessages;
  return result;
}
