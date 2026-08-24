// pi-goal-list-loop-audit — v0.35.51
// extensions/payload-guard.ts
//
// note.md Now: "req body too large due to images in context" — generated
// images accumulate in conversation history as base64 blocks until the
// provider rejects the request with 413 ("Downloaded image content cannot
// exceed 30MB" / "Request Entity Too Large"). Every main-model-recovery
// probe re-sends the same history, so recovery can never classify or heal
// the failure — the session is wedged until a manual restart WITHOUT
// history.
//
// The durable fix is ONE chokepoint: the pi `context` event fires before
// EVERY LLM call with the outgoing message list. This module bounds the
// cumulative base64 image bytes in that list — evicting the OLDEST images
// first (they are the least relevant to the current turn) while always
// keeping the most recent few — replacing each evicted block with a short
// text placeholder. History on disk stays intact (this is a per-send
// projection, not a destructive edit), and because the guard runs at the
// context layer it protects ordinary turns AND recovery probes alike.
//
// Pure module — no pi runtime, no fs — so the policy is unit-testable in
// isolation; the orchestration layer (goal-activation.ts) registers the
// hook and writes the payload_guard_eviction ledger entries.

/** Cumulative base64 image bytes allowed in one outgoing request. The
 * observed provider cap is 30MB of image content; 16MB leaves ample headroom
 * for text and the always-kept recent images. */
export const DEFAULT_IMAGE_BUDGET_BYTES = 16 * 1024 * 1024;

/** The N most recent images are never evicted regardless of budget — the
 * current turn almost always needs the newest visual state. */
export const DEFAULT_KEEP_RECENT_IMAGES = 2;

export interface ImageBlockLocation {
  messageIndex: number;
  blockIndex: number;
  /** Wire cost of the base64 payload (characters ≈ request bytes). */
  bytes: number;
}

export interface ImageEviction {
  messageIndex: number;
  blockIndex: number;
  bytes: number;
}

export interface EvictionResult {
  /** The projected message list (same identity when nothing was evicted). */
  messages: readonly unknown[];
  evicted: ImageEviction[];
  /** Cumulative image bytes BEFORE eviction. */
  totalImageBytes: number;
  /** Cumulative image bytes AFTER eviction. */
  remainingImageBytes: number;
}

export interface PayloadGuardOptions {
  imageBudgetBytes?: number;
  keepRecentImages?: number;
}

interface ImageBlockLike {
  type: string;
  data: string;
  mimeType?: string;
}

/** True when the block is an image content block carrying inline base64. */
export function isInlineImageBlock(block: unknown): block is ImageBlockLike {
  return typeof block === "object" && block !== null
    && (block as { type?: unknown }).type === "image"
    && typeof (block as { data?: unknown }).data === "string";
}

/** Walk the message list and locate every inline image block. Message
 * content may be a plain string (no blocks) or an array of blocks; anything
 * unexpected is skipped defensively. */
export function collectImageBlocks(messages: readonly unknown[]): ImageBlockLocation[] {
  const out: ImageBlockLocation[] = [];
  messages.forEach((message, messageIndex) => {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      if (isInlineImageBlock(block)) {
        out.push({ messageIndex, blockIndex, bytes: block.data.length });
      }
    });
  });
  return out;
}

function evictionPlaceholder(bytes: number): { type: string; text: string } {
  const mb = bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return {
    type: "text",
    text: `[image evicted by glla payload guard: ~${mb} of image data removed to keep the request under the provider size cap; the image remains in the session transcript]`,
  };
}

/**
 * Project the outgoing message list with cumulative inline-image bytes
 * bounded to `imageBudgetBytes`. Oldest images are evicted first; the most
 * recent `keepRecentImages` images are never evicted (best effort when the
 * budget cannot be met even without them). Returns the input array identity
 * when nothing needs eviction — callers can cheaply detect the no-op.
 */
export function evictStaleImages(
  messages: readonly unknown[],
  opts: PayloadGuardOptions = {},
): EvictionResult {
  const budget = typeof opts.imageBudgetBytes === "number" && opts.imageBudgetBytes > 0
    ? opts.imageBudgetBytes
    : DEFAULT_IMAGE_BUDGET_BYTES;
  const keepRecent = typeof opts.keepRecentImages === "number" && opts.keepRecentImages >= 0
    ? opts.keepRecentImages
    : DEFAULT_KEEP_RECENT_IMAGES;

  const blocks = collectImageBlocks(messages);
  const totalImageBytes = blocks.reduce((sum, b) => sum + b.bytes, 0);
  if (totalImageBytes <= budget) {
    return { messages, evicted: [], totalImageBytes, remainingImageBytes: totalImageBytes };
  }

  // Evict oldest-first; the newest `keepRecent` are exempt. When even the
  // exempt set exceeds the budget the eviction stops there — best effort,
  // never a destructive sweep of the current visual state.
  const evict = new Set<ImageBlockLocation>();
  let remaining = totalImageBytes;
  const exempt = blocks.slice(Math.max(0, blocks.length - keepRecent));
  for (const block of blocks) {
    if (remaining <= budget) break;
    if (exempt.includes(block)) continue;
    evict.add(block);
    remaining -= block.bytes;
  }
  if (evict.size === 0) {
    return { messages, evicted: [], totalImageBytes, remainingImageBytes: totalImageBytes };
  }

  // Group evictions per message so each affected message is copied once.
  const byMessage = new Map<number, ImageEviction[]>();
  for (const block of evict) {
    const list = byMessage.get(block.messageIndex) ?? [];
    list.push({ messageIndex: block.messageIndex, blockIndex: block.blockIndex, bytes: block.bytes });
    byMessage.set(block.messageIndex, list);
  }

  const projected = messages.map((message, messageIndex) => {
    const evictions = byMessage.get(messageIndex);
    if (!evictions) return message;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    const evictIndexes = new Set(evictions.map((e) => e.blockIndex));
    const newContent = content.map((block, blockIndex) => {
      if (!evictIndexes.has(blockIndex)) return block;
      return isInlineImageBlock(block) ? evictionPlaceholder(block.data.length) : block;
    });
    return { ...(message as object), content: newContent };
  });

  return { messages: projected, evicted: [...byMessage.values()].flat(), totalImageBytes, remainingImageBytes: remaining };
}

/**
 * The `context`-event projection used by the hook registration. Returns the
 * messages unchanged (same identity) when the payload already fits.
 */
export function payloadGuardProjection(messages: readonly unknown[], opts: PayloadGuardOptions = {}): EvictionResult {
  return evictStaleImages(messages, opts);
}
