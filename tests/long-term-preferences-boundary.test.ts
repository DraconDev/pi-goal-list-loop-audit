// pi-goal-list-loop-audit — v0.35.6
// tests/long-term-preferences-boundary.test.ts
//
// Pins the safety boundary described in
// audit/LONG-TERM-PREFERENCES-POLICY-2026-08-19.md:
//   (a) a remembered preference cannot override a newer explicit
//       instruction in the prompt merge, and
//   (b) an Explore/auditor transcript string never lands in settings
//       storage.
//
// The glla surface today has no auto-preference pipeline — these are
// NEGATIVE structural pins. They fail closed if a future refactor adds
// any "auto-preference from prose" pathway, an untyped setting key, or
// a non-settings writer to the typed storage API.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

// =================================================================
// (a) prompt merge surface: no preference auto-injection
// =================================================================
//
// The continuation prompt is built from a base template plus typed
// runtime context (state, model ref, recovery status, etc.). A
// "remembered preference" cannot exist if no code path constructs a
// preference section from prose. The pin walks the source tree for the
// forbidden pattern: a function that injects a free-form text blob
// into the prompt that is NOT one of the known typed sources.

test("continuation prompt has no auto-injected preference section", () => {
  const src = fs.readFileSync("prompts/goal-loop-continuation.md", "utf-8");
  // The template may not advertise "preference" or "remembered" headings
  // — the policy says remembered intent is advisory and never injected.
  assert.doesNotMatch(src, /^#{1,6}\s+(Remembered preferences|User preferences|Personal preferences)/im);
  assert.doesNotMatch(src, /^#{1,6}\s+Memory\b/im, "no 'Memory' section header in the continuation template");
});

test("no extension auto-prefers a remembered prose value", () => {
  // Walk the extensions/ tree for the forbidden shape: a function or
  // string that pulls a remembered/preference value from non-typed
  // storage (settings storage is typed; the only acceptable free-form
  // text in a prompt is the typed Settings.* keys rendered by
  // settings-menu). The pattern: a helper named `*prefer*` /
  // `*remember*` / `*memory*` that reads from a transcript or
  // completion string and writes to a prompt section.
  const roots = ["extensions"];
  const offenders: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && full.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf-8");
          // Match helpers that look like auto-preference pipelines.
          const remember = /(?:function|const)\s+\w*(?:RememberedPref|RemberedPreference|UserPref|AutoPref|RememberUser|MemorizedUserPreference)\w*/;
          const memorySection = /<remembered_preferences>|<user_preferences>|<memory>/;
          if (remember.test(text) || memorySection.test(text)) {
            offenders.push(full);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `no extension may auto-prefer prose; offenders: ${offenders.join(", ")}`);
});

// =================================================================
// (b) settings storage: typed boundary; transcript strings never land
// =================================================================
//
// The Settings interface is the only schema accepted by saveSettings.
// A regression that asserts:
//   - Settings has no free-form string[] field that could absorb an
//     arbitrary transcript blob (string[] is acceptable when it is a
//     typed list such as forbiddenModels / mainModelFallbacks);
//   - saveSettings is the only writer; no other path mutates the
//     settings JSON files.

test("Settings has no opaque free-form text field (typed boundary)", () => {
  const src = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  const settingsBlock = src.match(/export interface Settings \{[\s\S]+?\n\}/m);
  assert.ok(settingsBlock, "Settings interface found");
  const body = settingsBlock[0]!;
  // No field whose name suggests a free-form transcript / memory /
  // user-notes blob.
  assert.doesNotMatch(body, /\?\s*:\s*string\s*;\s*\/\*[^/]*memory/i, "no string field described as memory");
  assert.doesNotMatch(body, /\?\s*:\s*string\s*;\s*\/\*[^/]*preference/i, "no string field described as preference");
  assert.doesNotMatch(body, /\?\s*:\s*string\s*;\s*\/\*[^/]*remember/i, "no string field described as remember");
  assert.doesNotMatch(body, /\b(?:memory|preferences|rememberedNotes|userNotes|conversationLog)\s*\??\s*:/i, "no field named memory/preferences/rememberedNotes/userNotes/conversationLog");
});

test("saveSettings is the only writer to the settings JSON files", () => {
  // Both helpers must route through os.homedir() and cwd respectively —
  // a literal constant would let a writer bypass and still pass the
  // path test. The dependency-free state-root module owns the global
  // helper so goal-loop-core can resolve piGlaDir without a settings cycle;
  // goal-settings re-exports it for API compatibility.
  const globalPathFn = fs.readFileSync("extensions/glla-state-root.ts", "utf-8").match(/globalSettingsPath\(\):\s*string\s*\{[\s\S]+?\n\}/m);
  const projectPathFn = fs.readFileSync("extensions/goal-settings.ts", "utf-8").match(/projectSettingsPath\([^)]*\):\s*string\s*\{[\s\S]+?\n\}/m);
  assert.ok(globalPathFn && projectPathFn, "global/project path helpers found");
  assert.match(globalPathFn[0]!, /os\.homedir\(/, "global path routes through os.homedir");
  assert.match(projectPathFn[0]!, /cwd/, "project path routes through cwd");

  // Walk extensions/ for any direct writeFileSync against the settings
  // file names. Only goal-settings.ts may write them — the policy
  // says saveSettings is the sole writer.
  const forbidden: string[] = [];
  const stack = ["extensions"];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && full.endsWith(".ts") && full !== "extensions/goal-settings.ts") {
        const text = fs.readFileSync(full, "utf-8");
        // Any direct fs write against the settings file basenames.
        if (
          /writeFileSync\s*\(\s*[^)]*pi-goal-list-loop-audit\.settings\.json/.test(text) ||
          /writeFileSync\s*\(\s*[^)]*settings\.json/.test(text) ||
          /writeFile\s*\(\s*[^)]*pi-goal-list-loop-audit\.settings\.json/.test(text) ||
          /writeFile\s*\(\s*[^)]*settings\.json/.test(text)
        ) {
          forbidden.push(full);
        }
      }
    }
  }
  assert.deepEqual(forbidden, [], `only goal-settings.ts may write the settings files; offenders: ${forbidden.join(", ")}`);
});

// =================================================================
// (c) policy artifact is referenced from the typed settings surface
// =================================================================

test("goal-settings.ts header documents the long-term-preferences policy", () => {
  const src = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  // The policy artifact must be reachable from the typed boundary —
  // otherwise a future refactor can drift from the safety contract
  // without anyone noticing.
  assert.match(src, /LONG-TERM-PREFERENCES-POLICY-2026-08-19\.md/, "policy artifact is cited in extensions/goal-settings.ts");
});
