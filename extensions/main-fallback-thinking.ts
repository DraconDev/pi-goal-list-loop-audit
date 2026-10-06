export const FALLBACK_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type FallbackThinkingLevel = typeof FALLBACK_THINKING_LEVELS[number];

export function normalizeMainFallbackThinking(value: unknown, refs: readonly string[]): Record<string, FallbackThinkingLevel> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = new Set(refs.map(ref => ref.toLowerCase()));
  const result: Record<string, FallbackThinkingLevel> = {};
  for (const [ref, level] of Object.entries(value)) {
    const key = ref.trim().toLowerCase();
    if (allowed.has(key) && FALLBACK_THINKING_LEVELS.includes(level as FallbackThinkingLevel)) result[key] = level as FallbackThinkingLevel;
  }
  return Object.keys(result).length ? result : undefined;
}
