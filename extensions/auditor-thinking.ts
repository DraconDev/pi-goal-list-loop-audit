/** Resolve the auditor dial against each selected candidate, not just the primary.
 * Old settings keep their meaning: unset inherits the session dial. Unsupported
 * levels fall downwards; a non-reasoning model always gets off. */
export function resolveAuditorThinkingLevel(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> } | undefined, requested: string): string {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!model?.reasoning) return 'off';
  const ceiling = levels.indexOf(requested);
  const start = ceiling < 0 ? levels.indexOf('high') : ceiling;
  for (let index = start; index >= 0; index--) {
    const level = levels[index]!;
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null || ((level === 'xhigh' || level === 'max') && mapped === undefined)) continue;
    return level;
  }
  return 'off';
}
