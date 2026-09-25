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
  evidence: string[];
  legacyLead: boolean;
  technical: boolean;
}

const LEGACY_LEAD_PREFIX = /^\s*Lead(?:\s+[A-Za-z0-9_-]+)?\s*:\s*/i;
const TECHNICAL_PREFIX = /^\s*(?:Tests?|Test Results|Verification|Verdict|Audit)\s*:\s*/i;
const SEMANTIC_LABEL_PREFIX = /^\s*(?:Outcome|Changed|Changed behavior|Fix|Fixed|Result|Behavior|Improvement|Feature|Change|Error|Note|Reason|Evidence)\s*:\s*/i;
const EXPLICIT_OUTCOME_REASON_SEPARATOR = /\s+[—–](?:\s+|$)/;
const SAFE_LEAD_LABEL = /^[A-Za-z][A-Za-z0-9 /&()'.-]{0,71}$/;
const EVIDENCE_TOKEN_PATTERN = /(?<![/~+\w])[\w.+][\w.+/-]*\.[A-Za-z0-9]{1,8}:\d+(?:[-–]\d+)?(?:,\s*\d+(?:[-–]\d+)?)*\b/g;

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

/** Extract repo-relative path:line tokens without interpreting their colons
 * as label separators. Absolute paths are intentionally not evidence. */
export function extractFindingEvidence(text: string): { text: string; evidence: string[] } {
  const evidence: string[] = [];
  const clean = text.replace(EVIDENCE_TOKEN_PATTERN, (match) => {
    if (!evidence.includes(match) && evidence.length < 4) evidence.push(match);
    return "";
  })
    .replace(/\(([^()]*)\)/g, (group, inner: string) => (/\w/.test(inner) ? group : ""))
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: clean, evidence };
}

function hasRepoEvidence(text: string): boolean {
  EVIDENCE_TOKEN_PATTERN.lastIndex = 0;
  const found = EVIDENCE_TOKEN_PATTERN.test(text);
  EVIDENCE_TOKEN_PATTERN.lastIndex = 0;
  return found;
}

/** Split an outcome/reason pair without treating path:line or product-version
 * colons as a label boundary. The optional evidence flag permits an older
 * `Topic: explanation` form to migrate by dropping the topical label. */
export function splitFindingLeadText(
  text: string,
  hasEvidence = hasRepoEvidence(text),
): { outcome: string; reason: string } {
  const clean = text.trim();

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
      const nested = splitFindingLeadText(suffix, true);
      return { outcome: nested.outcome || suffix, reason: nested.reason };
    }
  }

  const separator = clean.search(EXPLICIT_OUTCOME_REASON_SEPARATOR);
  if (separator >= 0) {
    const left = clean.slice(0, separator).trim();
    const right = clean.slice(separator).replace(EXPLICIT_OUTCOME_REASON_SEPARATOR, "").trim();
    return right ? { outcome: left, reason: right } : { outcome: left, reason: "" };
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
  const outcomeParts = extractFindingEvidence(split.outcome);
  const reasonParts = extractFindingEvidence(split.reason);
  const evidence = [...outcomeParts.evidence, ...reasonParts.evidence].filter((token, index, all) => all.indexOf(token) === index);
  return {
    raw,
    normalized,
    outcome: outcomeParts.text || split.outcome,
    reason: reasonParts.text || split.reason,
    evidence,
    legacyLead,
    technical,
  };
}

/** Compatibility alias for callers that prefer the verb used by the schema. */
export const parseFindingLead = normalizeFindingLead;
