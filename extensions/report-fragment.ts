/** Structural evidence is not an executable finding. Preserve the original
 * text; this classifier never rewrites a report row into guessed intent. */
export function reportFragmentKind(text: string): "table-row" | "source-heading" | "contract-label" | undefined {
  const raw = text.trim().replace(/^[-*•>]\s+/, "");
  // grep -n evidence is common in audit reports. Its line number must not
  // hide the structure from classification (incident 2026-10-27).
  const sourceLine = raw.match(/^\d+[:-]\s*(.*)$/);
  const body = sourceLine ? sourceLine[1]! : raw;
  if (/^\|[^\n]*\|/.test(body)) return "table-row";
  if (sourceLine && /^(?:#{1,6}\s+|\*\*[^\n]+:\*\*\s*$)/.test(body)) return "source-heading";
  if (/^Item:\s+/i.test(body)) return "contract-label";
  return undefined;
}
