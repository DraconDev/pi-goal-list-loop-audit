// GLLA delegation skill contract: the skill teaches existing goal/list tools
// without changing their enforcement. It is intentionally tested at the
// package boundary so a future files/manifest edit cannot silently ship an
// extension with no normal-chat policy.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const PACKAGE = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  files?: string[];
  pi?: { skills?: string[] };
};
const SKILL_PATH = "skills/glla-delegate/SKILL.md";
const SKILL = fs.readFileSync(SKILL_PATH, "utf8");

function frontmatter(): string {
  assert.ok(SKILL.startsWith("---\n"), "SKILL.md starts with YAML frontmatter");
  const end = SKILL.indexOf("\n---\n", 4);
  assert.ok(end > 4, "SKILL.md closes YAML frontmatter");
  return SKILL.slice(4, end);
}

function frontmatterValue(name: string): string {
  const line = frontmatter().split("\n").find((entry) => entry.startsWith(`${name}:`));
  assert.ok(line, `${name} is present in skill frontmatter`);
  return line.slice(name.length + 1).trim();
}

test("glla-delegate skill has valid discoverable frontmatter", () => {
  assert.equal(frontmatterValue("name"), "glla-delegate");
  const description = frontmatterValue("description");
  assert.ok(description.length > 0 && description.length <= 1024, "description fits the Agent Skills limit");
  assert.match(SKILL, /# GLLA delegation/);
});

test("package exposes the skill directory and pi.skills manifest entry", () => {
  assert.ok(PACKAGE.files?.includes("skills"), "npm files allowlist ships skills/");
  assert.deepEqual(PACKAGE.pi?.skills, ["skills/glla-delegate"], "Pi manifest discovers the skill directory");
});

test("skill documents consent and auto-activation boundaries", () => {
  assert.match(SKILL, /list_add/);
  assert.match(SKILL, /propose_goal_draft/);
  assert.match(SKILL, /Confirm\s+dialog/);
  assert.match(SKILL, /Never call `list_activate`/);
  assert.match(SKILL, /first item may activate immediately/);
  assert.match(SKILL, /Worker and subagent sessions do not own GLLA state/);
});

test("skill treats pasted list-like input as supplied, not an exactness choice", () => {
  assert.match(SKILL, /multi-line, bulleted, numbered, or checklist-style/);
  assert.match(SKILL, /one `list_add` call/);
  assert.match(SKILL, /Do \*\*not\*\* ask whether the user wants the list/);
  assert.match(SKILL, /there is no such choice/);
  assert.match(SKILL, /genuinely\s+ambiguous individual item/);
});
