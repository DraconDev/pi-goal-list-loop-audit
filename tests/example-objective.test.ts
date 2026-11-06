// pi-goal-list-loop-audit — example-objective.md auditor-description pin.
//
// Finding: Loop 1 step 3 described a no-extension read-only auditor, stale
// on mirror default-ON (auditorMirrorSessionExtensions) and the bounded bash
// verifier tool (--tools read,grep,find,ls,bash). The doc now describes the
// real spawn; this test pins both directions so doc and worker cannot drift
// apart again.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..");
const doc = fs.readFileSync(path.join(repoRoot, "examples", "example-objective.md"), "utf-8");
const worker = fs.readFileSync(path.join(repoRoot, "scripts", "goal-auditor-worker.mjs"), "utf-8");

test("v0.39.38: Loop 1 step 3 no longer claims a no-extension read-only auditor", () => {
  const step3 = doc.slice(doc.indexOf("3. The **isolated auditor**"), doc.indexOf("4. Approved"));
  assert.ok(step3.length > 0, "step 3 still describes the isolated auditor");
  assert.doesNotMatch(step3, /no extensions and only\n?\s*read tools/, "the stale absolute claim is gone");
  assert.match(step3, /bounded/, "the bounded bash verifier is named");
  assert.match(step3, /`bash`/, "bash is listed in the tool surface");
  assert.match(step3, /auditorMirrorSessionExtensions/, "the mirror toggle is named");
  assert.match(step3, /GLLA itself is never mirrored/, "the mirror boundary is stated");
  assert.match(step3, /full isolation/, "the path to full isolation is documented");
});

test("v0.39.38: the doc matches the worker's real spawn spec", () => {
  // The worker really does spawn --no-extensions with the bounded tool set
  // including bash, and really does take allow-listed --extension specs.
  assert.match(worker, /"--tools",\s*"read,grep,find,ls,bash"/, "worker tool surface includes bounded bash");
  assert.match(worker, /"--no-extensions"/, "worker starts extension-less before the allow-list");
  assert.match(worker, /"--extension", spec/, "allow-listed specs reach the spawn");
  // Mirroring is default-ON in the settings UI copy the doc now cites.
  const ui = fs.readFileSync(path.join(repoRoot, "extensions", "loops", "goal-settings-ui.ts"), "utf-8");
  assert.match(ui, /session packages load in the worker \(default\)/, "mirror default-ON is the coded default");
});

test("audit 2026-11-06: auditor snippet names the global settings file, not the project file", () => {
  const auditorIdx = doc.indexOf("## The auditor model rule");
  assert.ok(auditorIdx >= 0, "auditor section exists");
  const section = doc.slice(auditorIdx);
  assert.match(section, /global-only/, "auditor keys are global-only");
  assert.match(section, /pi-goal-list-loop-audit\.settings\.json/, "global settings path named");
  assert.doesNotMatch(section, /\.pi-glla\/settings\.json/, "project file no longer suggested for auditor keys");
});
