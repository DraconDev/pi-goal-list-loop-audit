import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function runtimeLoadedPrompts(): string[] {
  const found = new Set<string>();
  for (const file of fs.readdirSync("extensions")) {
    if (!file.endsWith(".ts")) continue;
    const src = fs.readFileSync(path.join("extensions", file), "utf8");
    for (const m of src.matchAll(/loadPromptWhole\(\s*"([^"]+\.md)"\s*\)/g)) found.add(`prompts/${m[1]}`);
  }
  for (const file of fs.readdirSync("extensions/loops")) {
    if (!file.endsWith(".ts")) continue;
    const src = fs.readFileSync(path.join("extensions/loops", file), "utf8");
    for (const m of src.matchAll(/loadPromptWhole\(\s*"([^"]+\.md)"\s*\)/g)) found.add(`prompts/${m[1]}`);
  }
  return [...found].sort();
}

function smokeRequired(): string[] {
  const src = fs.readFileSync("scripts/release-pack-smoke.mjs", "utf8");
  return [...src.matchAll(/"(prompts\/[^"]+\.md)"/g)].map((m) => m[1] as string);
}

function contractRequired(): string[] {
  const src = fs.readFileSync("tests/release-contract.test.ts", "utf8");
  return [...src.matchAll(/"(prompts\/[^"]+\.md)"/g)].map((m) => m[1] as string);
}

test("every runtime-loaded prompt rides the ship-gate in both tiers", () => {
  const loaded = runtimeLoadedPrompts();
  assert.ok(loaded.length > 0, "the scan finds runtime prompt loads");
  assert.ok(loaded.includes("prompts/goal-loop-respec-builder.md"), "respec builder is runtime-loaded");
  assert.ok(loaded.includes("prompts/goal-loop-respec-draft.md"), "respec draft is runtime-loaded");
  for (const prompt of loaded) {
    assert.ok(smokeRequired().includes(prompt), `${prompt} is pinned in release-pack-smoke required[]`);
    assert.ok(contractRequired().includes(prompt), `${prompt} is pinned in the release-contract prompt list`);
    assert.ok(fs.existsSync(prompt), `${prompt} exists on disk`);
  }
});
