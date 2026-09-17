// Transcribed/adapted from the supplied 20260916 screenshots, not fresh claims
// about external projects. Only GLLA's production renderer is exercised here.
import { buildTerminalApprovalRender, buildRichArchiveSection } from "../../extensions/completion-summary.js";
import type { Goal, FindingGroup, GateRow } from "../../extensions/goal-loop-core.js";

export interface ScreenshotCase {
  name: string;
  screenshots: string[];
  outcome: string;
  groups: FindingGroup[];
  gates: GateRow[];
  limitation: string;
  leftOut: string;
}

export const screenshotCases: ScreenshotCase[] = [
  {
    name: "GLLA", screenshots: ["20260916_224518"],
    outcome: "List routing, chatter classification and starvation recovery were corrected without weakening the audit gates.",
    groups: [
      { title: "List input", findings: ["Paragraph routing: Multi-sentence prose stays one list item rather than becoming a sentence-per-item import (extensions/goal-loop-core.ts:837)."] },
      { title: "Session input", findings: ["Chatter classification: Conversational text is resolved without treating it as a new work contract (extensions/start-context.ts:317)."] },
      { title: "Recovery", findings: ["Starvation reset: The reset hook clears leaked starvation-gate state instead of carrying it into later work (extensions/loops/goal-ui.ts)."], tests: ["Same probe before/after: 4 fail before the fix; 152 pass after. This is historical screenshot evidence, not a newly executed suite."] },
      { title: "Completion evidence", findings: ["Sanitizer: Anchored tarball matching prevents machine packaging from overwhelming the human recap (extensions/completion-summary.ts).", "Traceability repair: The closure record was corrected; the underlying list, chatter and reset fixes remained unchanged (findings.md:542, commit d55c5cf4)."] },
    ],
    gates: [
      { gate: "Before-fix probe", scope: "Historical starvation reproduction", notes: "4 failed before the fix", command: "bun test tests/starvation.test.ts" },
      { gate: "After-fix probe", scope: "Historical same probe", notes: "152 passed, 0 failed" },
      { gate: "Release gate", scope: "Screenshot: 2225 tests across 217 files", notes: "2223 pass, 0 fail; screenshot did not enumerate the remaining checks", command: "TMPDIR=/var/tmp npm run release:check" },
    ],
    limitation: "Historical screenshot evidence only; the screenshot does not enumerate every check in the release total.",
    leftOut: "External projects and live model behavior were not re-executed by this rendering fixture.",
  },
  {
    name: "Deathrun", screenshots: ["20260916_224746", "20260916_224749"],
    outcome: "Bonus orbs are collectible again, aiming accounts for camera dip, and UI and test assertions reflect the real game behavior.",
    groups: [
      { title: "Engine", findings: [
        "Bonus orbs: Platform bonus orbs were erased by the hazard clear and never pickup-checked — now rendered on the terrain layer and collected via the shared collectOrbAt path (src/lib/game/phaser/run-scene.ts:672,2760).",
        "Aiming: Landing camera dip displaced worldLayer but the pointer-to-world inverse ignored it — rendered dip is now captured and subtracted in the aim inverse (src/lib/game/phaser/run-scene.ts:750,1968).",
      ] },
      { title: "UI routes", findings: [
        "Reduced motion: Settings toggles leaked self-rescheduling parallax RAF chains — cleanup now cancels the pending frame (src/routes/settings/+page.svelte:100).",
        "Distance units: The hub rendered raw pixels as metres, inflating the personal best 100× — now converted using the canonical /100 form (src/routes/+page.svelte:180).",
        "Keyboard access: Reset-dialog handlers returned early on Shift, disabling reverse Tab wrap — Tab now routes to trapConfirmFocus before the modifier guard (src/routes/settings/+page.svelte:282).",
      ] },
      { title: "E2E tooling", findings: [
        "Booster assertions: The reader hardcoded /3 and fell back to 3 for every four-charge value — strict capacity-agnostic parsing now tests the real 4→3 contract (tests/e2e/test-helpers.ts:400).",
        "Audio telemetry: Voices were decremented on scheduled stop rather than ended, undercounting polyphony — the ended-event counter now measures the real peak 17 (tests/e2e/tier4-scenarios.e2e.ts:479).",
      ] },
      { title: "Docs and contracts", findings: ["Specification: Dash documentation said 3 charges/260px/1200ms versus the shipped 4/285/1000; rope timing and velocity were also reconciled to the implementation (SPEC.md:67,74)."] },
    ],
    gates: [
      { gate: "Unit sweep", scope: "Historical 357 files, 4288 tests", notes: "4082 passed / 206 skipped / 0 failed; 327 files passed / 30 skipped", command: "bun run test:sweep" },
      { gate: "Engine", scope: "Historical engine and route smoke", notes: "14 passed, 0 failed" },
      { gate: "Playwright", scope: "Historical tier1–4 and helper contracts", notes: "Tier1 90/90; Tier2 45/45; Tier3 44/45 (carried 8.1 frame-pacing exception); Tier4 20/20; one browser-closed launch flake, suite green on rerun", command: "bunx playwright test tests/e2e --workers=2" },
    ],
    limitation: "Carried Tier 3 Pairwise 8.1 frame-pacing determinism exception remains; a green rerun does not erase the earlier launch flake.",
    leftOut: "The fixed-timestep accumulator was deliberately not attempted inside the historical audit; it remains a separate root-cause change.",
  },
  {
    name: "Neonbreak", screenshots: ["20260916_224738", "20260916_224741"],
    outcome: "Save revisions survive overlapping requests, reduced motion no longer accelerates the backdrop, and browser tests honor the chosen port.",
    groups: [
      { title: "Persistence", findings: [
        "Save ordering: Overlapping saves discarded successful revisions — same-account success now updates revision and confirmed snapshot before optimistic supersession, keeping account-generation isolation (src/lib/game/persistence/neonbreakAccount.ts:425).",
        "Regression coverage: Revisions 1/2/3 cover newest-state preservation, latest-snapshot rollback and late-response isolation (src/lib/game/persistence/neonbreakAccount.test.ts:65-105).",
      ], tests: ["Before fix: 1 pass / 2 fail (/tmp/nb-race-before.log). After fix: 3 pass / 0 fail (/tmp/nb-race-after.log)."] },
      { title: "Routes and motion", findings: [
        "Reduced motion: A 4s override accelerated the 38s menu backdrop 9.5× — one near-zero iteration now preserves transitions instead of overriding them (src/routes/+layout.svelte:476).",
        "Meaningful browser assertion: The geoscape animation test had no save or real target — it now waits for the settings PUT and Saved acknowledgment and checks the real threat-sweep pseudo-element across a new document (tests/e2e/animations-policy-app-wide.e2e.ts:5).",
      ] },
      { title: "Test harness", findings: ["Port configuration: Eleven specs defaulted their own BASE to port 1453 and ignored NEONBREAK_PORT — shared resolution now preserves override precedence (tests/e2e/support/base-url.ts:1, commit d923419e)."], tests: ["Previously 39 connection failures; afterward 135 passed / 0 failed on port 1463 and standard 1453, no retries."] },
      { title: "Process", findings: ["Ledger: Four fix entries were checked; the append-only guard preserved the original record while adding the verified findings (docs/audits/2026-09-16-project-audit.md)."] },
    ],
    gates: [
      { gate: "Before-fix save probe", scope: "Historical overlapping saves", notes: "1 pass / 2 fail", command: "bun test src/lib/game/persistence/neonbreakAccount.test.ts" },
      { gate: "After-fix save probe", scope: "Historical same regression", notes: "3 pass / 0 fail" },
      { gate: "Unit tests", scope: "Historical 298 files", notes: "2689 passed, 4 skipped (NB_URL-gated), 0 failed", command: "timeout 180 bun run test" },
      { gate: "Browser standard port", scope: "Historical 119 e2e + 16 pixel baselines", notes: "135 passed / 0 failed" },
      { gate: "Browser alternate port", scope: "Historical same 135 tests, port 1463", notes: "135 passed / 0 failed" },
      { gate: "Spec audit", scope: "Historical spec checks", notes: "350 pass / 10 partial / 0 fail" },
    ],
    limitation: "Four NB_URL-gated live-DOM tests remain skipped by design; 10 spec checks are partial.",
    leftOut: "Deep-untouched card outcome, initiative, cover, squad-XP and renderer/debug areas were not re-surveyed and were not filed as findings.",
  },
];

export function renderScreenshotCase(example: ScreenshotCase) {
  const goal = {
    id: `fixture-${example.name}`, objective: `Historical ${example.name} completion example`, status: "complete",
    completionSummary: `Outcome: ${example.outcome}\nChanged: ${example.outcome}\nEvidence: Historical screenshot-derived renderer input.\nTests: See the historical gate inventory.\nUnresolved: ${example.limitation}\nNext: none.`,
    auditHistory: [{ approved: true, model: "fixture/model" }],
  } as unknown as Goal;
  return {
    chat: buildTerminalApprovalRender({ goal, status: "complete", approval: "— auditor fixture/model approved.", record: `— record: archive/${example.name}.md`, findingGroups: example.groups, gateRows: example.gates, leftOut: example.leftOut }).chatLines.join("\n"),
    archive: buildRichArchiveSection(goal, "complete", `archive/${example.name}.md`, example.groups, example.gates).join("\n"),
  };
}
