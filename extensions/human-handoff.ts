import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { clipSummaryValue } from "./finding-lead.js";
import { CARD_SECTION, LEGACY_CARD_SECTIONS, cardSectionName } from "./card-sections.js";

/** Authoring contract, shared by goal/list completion and pause tools. The
 * display can preview a legacy report, but cannot invent its missing action. */
export const HUMAN_HANDOFF_GUIDANCE = `HUMAN HANDOFF: Write for the person using the project, not for an audit log. Say what changed or what is preventing progress in one or two plain sentences. Name the user's next action separately, or say no action is needed. Do not put investigation history, file inventories, tool counts, model names, hashes or verifier mechanics into the human explanation. Keep evidence in verificationSummary/gateRows (completion) or interruption.evidence (pause). Preserve real limitations; never claim an unobserved result. For completion use Outcome for the result, Changed for a short behavior-level explanation, Unresolved for limitations and Next for one useful action. Finding groups are detailed supporting material, not an excuse to repeat the whole report. For pause_goal keep reason to the unmet prerequisite and use suggestedAction for concrete steps, the relevant document or exact command; a resume command alone does not resolve a blocker. For waits explain the condition, not the scheduler, and do not promise completion at the next check.`;

/** A visibly abbreviated projection, never a semantic rewrite. Callers must
 * offer expansion or a durable record whenever this omits source content. */
export function humanTextPreview(text: string, budget = 280): string {
  const safe = stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return clipSummaryValue(safe, budget);
}

/** UTC is explicit and independent of the local machine's timezone. Keep the
 * original ISO value in state/details; invalid legacy values stay literal. */
export function humanCheckTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return humanTextPreview(value);
  return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date)}, ${date.toISOString().slice(11, 16)} UTC`;
}

/** Collapse supporting change inventories, not user actions or limitations.
 * The original message remains available through the host's expansion UI. */
export function compactHumanSummary(content: string): { content: string; omitted: boolean } {
  let section = "";
  let findings = 0;
  let summaryLines = 0;
  let omitted = false;
  let fence: { char: string; size: number; hidden: boolean } | undefined;
  const result: string[] = [];
  for (const line of content.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!fence.hidden) result.push(line);
      if (marker?.[0] === fence.char && marker.length >= fence.size && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (marker) {
      const hidden = section === CARD_SECTION.summary || section === CARD_SECTION.whatChanged
        || section === LEGACY_CARD_SECTIONS[0] || section === LEGACY_CARD_SECTIONS[1];
      fence = { char: marker[0]!, size: marker.length, hidden };
      if (hidden) omitted = true; else result.push(line);
      continue;
    }
    // Canonical receipt trailers are outside the agent's body sections.
    // A Summary-only receipt must never lose its no-review qualification,
    // challenge disclosure or saved-record link to the paragraph budget.
    if (/^•\s/.test(line)) section = "";
    const heading = line.trim().replace(/^#{2,4}\s+/, "").replace(/^\*\*(.*?)\*\*$/, "$1");
    const sectionName = cardSectionName(heading);
    if (sectionName) {
      section = sectionName;
      result.push(line);
      continue;
    }
    const isChangeArea = /^#{2,4}\s+What changed\s*\u00b7/i.test(line) || /^\*\*What changed\s*\u00b7/i.test(line);
    if (section === CARD_SECTION.summary && line.trim()) {
      if (/^#{2,4}\s|^\*\*.*\*\*$/.test(line) || ++summaryLines > 2) { omitted = true; continue; }
      const preview = humanTextPreview(line);
      if (preview !== line.trim()) omitted = true;
      result.push(preview);
      continue;
    }
    if (section === CARD_SECTION.whatChanged || section === LEGACY_CARD_SECTIONS[0]) {
      // One line per area label, then its findings; nested proof and area
      // headings are supporting details. Primary findings keep their
      // original words and order.
      if (isChangeArea) {
        if (++findings > 4) { omitted = true; continue; }
        result.push(humanTextPreview(line));
        continue;
      }
      if (/^\s{2,}\S|^\*\*\d+\./.test(line)) { omitted = true; continue; }
      if (/^(?:- |\d+\. )/.test(line)) {
        if (++findings > 4) { omitted = true; continue; }
        const preview = humanTextPreview(line);
        if (preview !== line.trim()) omitted = true;
        result.push(preview);
        continue;
      }
    }
    // Never silently clip Follow-up items, Next steps or limitations: these
    // may contain an exact command, a permission boundary or an important
    // limitation.
    result.push(line);
  }
  if (omitted) result.push("", "More details are available in the expanded message and saved record.");
  return { content: result.join("\n"), omitted };
}
