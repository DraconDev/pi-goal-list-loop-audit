// pi-goal-list-loop-audit — semantic contract for human-facing finding leads.
//
// A finding is an outcome first, followed by a concrete reason/evidence. The
// persisted wire format stays a string for compatibility, but `Lead:` is a
// legacy marker rather than a label the user should see.

export interface FindingLead {
  raw: string;
  normalized: string;
  outcome: string;
  reason: string;
  legacyLead: boolean;
  technical: boolean;
}

const LEGACY_LEAD_PREFIX = /^\s*Lead\s*:\s*/i;
const TECHNICAL_PREFIX = /^\s*(?:Tests?|Test Results|Verification|Verdict|Audit)\s*:\s*/i;
const SEMANTIC_LABEL_PREFIX = /^\s*(?:Outcome|Changed|Changed behavior|Fix|Fixed|Result|Behavior|Improvement|Feature|Change|Error|Note|Reason|Evidence)\s*:\s*/i;
const EXPLICIT_OUTCOME_REASON_SEPARATOR = /\s+[—–]\s+/;
const SAFE_LEAD_LABEL = /^[A-Za-z][A-Za-z0-9 /&()'.-]{0,71}$/;

function stripLabelPrefixes(text: string): string {
  let current = text.trim();
  // Strip only recognized labels. This deliberately leaves prose such as
  // `Gemini 3: ...` and path/version colons untouched.
  for (;;) {
    const next = current
      .replace(LEGACY_LEAD_PREFIX, "")
      .replace(SEMANTIC_LABEL_PREFIX, "")
      .replace(TECHNICAL_PREFIX, "")
      .trim();
    if (next === current) return current;
    current = next;
  }
}

/** Split an outcome/reason pair without treating path:line or product-version
 * colons as a label boundary. The optional evidence flag permits an older
 * `Topic: explanation` form to migrate by dropping the topical label. */
export function splitFindingLeadText(
  text: string,
  hasEvidence = false,
): { outcome: string; reason: string } {
  const clean = text.trim();
  const separator = clean.search(EXPLICIT_OUTCOME_REASON_SEPARATOR);
  if (separator >= 0) {
    const left = clean.slice(0, separator).trim();
    const right = clean.slice(separator).replace(EXPLICIT_OUTCOME_REASON_SEPARATOR, "").trim();
    // A legacy `Topic: outcome — proof` may put the delimiter inside the
    // topical prefix. Only split when the left side is already a full,
    // user-visible outcome; otherwise keep the full sentence and let the
    // mechanically extracted evidence follow it.
    if (!hasEvidence || left.length >= 24 || !/^[A-Za-z][A-Za-z0-9 /&()'.-]{0,71}$/.test(left) || /^[A-Za-z]+\s*:/.test(left)) {
      return { outcome: left, reason: right };
    }
  }

  // Older callers used a short topical prefix (`Paragraph routing: ...`).
  // When the suffix contains real proof, the prefix is a category rather than
  // the user-visible outcome, so drop it. Version/path phrases are protected.
  const colon = clean.indexOf(":");
  if (hasEvidence && colon > 0 && colon <= 72) {
    const candidate = clean.slice(0, colon).trim();
    const suffix = clean.slice(colon + 1).trim();
    if (
      suffix
      && SAFE_LEAD_LABEL.test(candidate)
      && !/\d/.test(candidate)
      && !candidate.includes("/")
      && !candidate.includes(".")
      && !/^(?:the|a|an)\b/i.test(candidate)
    ) {
      return { outcome: suffix, reason: "" };
    }
  }

  return { outcome: clean, reason: "" };
}

/** Normalize a persisted/new finding for display. Raw input is returned in
 * the result so callers can preserve provenance while rendering the semantic
 * outcome/reason pair. */
export function normalizeFindingLead(value: string): FindingLead {
  const raw = value.trim();
  const legacyLead = LEGACY_LEAD_PREFIX.test(raw);
  const technical = TECHNICAL_PREFIX.test(raw);
  const normalized = stripLabelPrefixes(raw);
  const split = splitFindingLeadText(normalized);
  return {
    raw,
    normalized,
    outcome: split.outcome,
    reason: split.reason,
    legacyLead,
    technical,
  };
}

/** Compatibility alias for callers that prefer the verb used by the schema. */
export const parseFindingLead = normalizeFindingLead;
