// A missing/corrupt packaged drafting template must not claim the module's
// drafting gate. The next list operation must still be allowed, proving the
// failure left no latent "interview in progress" state.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync("extensions/loops/goal-list-queue.ts", "utf8");

test("drafting gate is claimed only after prompt construction", () => {
  const load = src.indexOf("tmpl = loadPromptWhole(file);");
  const claim = src.indexOf("draftingTarget = target;", load);
  const cleanup = src.indexOf("clearDraftingState();", claim);
  assert.ok(load >= 0 && claim > load, "loadPromptWhole runs before the gate is claimed");
  assert.ok(cleanup > claim, "all post-claim exits can clear the owned gate");
  assert.match(src.slice(load, claim), /try \{[\s\S]*loadPromptWhole\(file\)[\s\S]*\} catch/);
});

test("the post-claim model failure still clears drafting state before rethrow", () => {
  const claim = src.indexOf("draftingTarget = target;");
  const block = src.slice(claim, src.indexOf("/** Keep the malformed queue item", claim));
  assert.match(block, /await beginDrafterModel\(ctx\);[\s\S]*catch \(err\)[\s\S]*clearDraftingState\(\);[\s\S]*throw err/);
});
