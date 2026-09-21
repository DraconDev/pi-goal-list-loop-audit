// pi-goal-list-loop-audit — v0.38.81
// tests/audit-tier.test.ts
//
// Risk-tiered auditing: the pure tier resolver. Full tier = audit plus
// the falsification round (today's behavior); light tier = the same
// single-round audit with the same brief, shield, and tool floor — only
// round 2 is skipped. Escalation is free, de-escalation is suspect:
// signals, draft consent, and the agent's own request can only push a
// claim UP to full, never down. Spot-checks silently escalate a sampled
// fraction of light audits so systematic under-tiering is caught
// statistically and the flip-rate data calibrates the signals.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIGHT_AUDIT_CEILINGS,
  resolveAuditTier,
} from "../extensions/goal-loop-auditor-process.js";
import { DEFAULT_SETTINGS, normalizeLoadedSettings } from "../extensions/goal-settings.js";

const SMALL = { turns: 5, fileWrites: 3, bashCalls: 2 };
const QUIET = {
  objective: "Fix the typo in the README header.",
  verificationContract: "Done when: header reads correctly.",
  completionSummary: "Outcome: fixed header.",
  verificationSummary: "Read the header back.",
};

test("tier: a small quiet claim with no history audits light", () => {
  const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 0 });
  assert.equal(d.tier, "light");
  assert.equal(d.spotCheck, false);
  assert.deepEqual(d.reasons, []);
});

test("tier: draft-time full-audit consent escalates", () => {
  const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 0, goalFullAudit: true });
  assert.equal(d.tier, "full");
  assert.ok(d.reasons.some((r) => /draft-time full-audit consent/.test(r)));
});

test("tier: the agent's own full-audit request escalates", () => {
  const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 0, claimRequestFullAudit: true });
  assert.equal(d.tier, "full");
  assert.ok(d.reasons.some((r) => /agent requested full audit/.test(r)));
});

test("tier: any prior disapproval escalates (rework proved risky once)", () => {
  const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 2, ...QUIET, spotCheckRate: 0 });
  assert.equal(d.tier, "full");
  assert.ok(d.reasons.some((r) => /rework history \(2 prior disapprovals\)/.test(r)));
});

test("tier: missing telemetry escalates (unknown activity, conservative floor)", () => {
  const d = resolveAuditTier({ priorDisapprovals: 0, ...QUIET, spotCheckRate: 0 });
  assert.equal(d.tier, "full");
  assert.ok(d.reasons.some((r) => /no activity telemetry/.test(r)));
});

test("tier: activity above any ceiling escalates, at-ceiling stays light", () => {
  const over = resolveAuditTier({
    telemetry: { turns: 5, fileWrites: LIGHT_AUDIT_CEILINGS.fileWrites + 1, bashCalls: 2 },
    priorDisapprovals: 0, ...QUIET, spotCheckRate: 0,
  });
  assert.equal(over.tier, "full");
  assert.ok(over.reasons.some((r) => /above light ceiling/.test(r)));
  const at = resolveAuditTier({
    telemetry: { turns: LIGHT_AUDIT_CEILINGS.turns, fileWrites: LIGHT_AUDIT_CEILINGS.fileWrites, bashCalls: LIGHT_AUDIT_CEILINGS.bashCalls },
    priorDisapprovals: 0, ...QUIET, spotCheckRate: 0,
  });
  assert.equal(at.tier, "light", "ceilings are inclusive");
});

test("tier: high-stakes language escalates and names the match", () => {
  for (const objective of [
    "Run the production database migration.",
    "Deploy the new release to prod.",
    "Rotate the Stripe api key and redeploy.",
    "Delete the legacy auth table.",
  ]) {
    const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, objective, spotCheckRate: 0 });
    assert.equal(d.tier, "full", objective);
    assert.ok(d.reasons.some((r) => /high-stakes language/.test(r)), objective);
  }
  // Claim text counts too — escalation direction is safe for agent text.
  const viaClaim = resolveAuditTier({
    telemetry: SMALL, priorDisapprovals: 0,
    objective: QUIET.objective,
    completionSummary: "Outcome: dropped the unused table.",
    spotCheckRate: 0,
  });
  assert.equal(viaClaim.tier, "full");
});

test("tier: ordinary objectives do not trip the keyword list", () => {
  for (const objective of [
    "Fix the typo in the README header.",
    "Retire the single-module runtime globals.",
    "Add flip-rate columns to the stats table.",
    "Investigate the slow test file.",
  ]) {
    const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, objective, spotCheckRate: 0 });
    assert.equal(d.tier, "light", objective);
  }
});

test("tier: spot-check rate 1 escalates every light claim and marks it", () => {
  const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 1 });
  assert.equal(d.tier, "full");
  assert.equal(d.spotCheck, true);
  assert.ok(d.reasons.some((r) => /spot-check/.test(r)));
});

test("tier: spot-check never marks a claim that was already full", () => {
  const d = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 1, goalFullAudit: true });
  assert.equal(d.tier, "full");
  assert.equal(d.spotCheck, false, "spot-checks sample the light population only");
});

test("tier: injected random decides the draw (seeded, no flakes)", () => {
  const hit = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 0.1, random: () => 0.05 });
  assert.equal(hit.spotCheck, true);
  const miss = resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 0.1, random: () => 0.5 });
  assert.equal(miss.tier, "light");
  assert.equal(miss.spotCheck, false);
});

test("tier: rates clamp to [0, 1]; junk restores the default", () => {
  assert.equal(resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: 99, random: () => 0.999 }).spotCheck, true);
  assert.equal(resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: -1, random: () => 0 }).spotCheck, false);
  assert.equal(resolveAuditTier({ telemetry: SMALL, priorDisapprovals: 0, ...QUIET, spotCheckRate: Number.NaN, random: () => 0 }).spotCheck, false);
});

test("tier: spot-check rate ships at 0.1 and normalizes junk to default", () => {
  assert.equal(DEFAULT_SETTINGS.auditSpotCheckRate, 0.1);
  assert.equal(normalizeLoadedSettings({ auditSpotCheckRate: 0.5 }).auditSpotCheckRate, 0.5);
  assert.equal(normalizeLoadedSettings({ auditSpotCheckRate: 0 }).auditSpotCheckRate, 0, "0 disables spot-checks");
  assert.equal(normalizeLoadedSettings({ auditSpotCheckRate: 99 }).auditSpotCheckRate, 0.1, "junk restores the default");
  assert.equal(normalizeLoadedSettings({ auditSpotCheckRate: -2 }).auditSpotCheckRate, 0.1);
  assert.equal(normalizeLoadedSettings({}).auditSpotCheckRate, 0.1, "unset means the default");
});
