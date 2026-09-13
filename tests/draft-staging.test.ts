// v0.38.53: draft staging is a consent pipeline, not a single prompt.
// Pin the GLLA-owned order so a future refactor cannot move a confirmation
// after activation or let a stale/zero-reply proposal open the gate.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

const TOOLS = fs.readFileSync("extensions/loops/goal-tools.ts", "utf8");
const QUEUE = fs.readFileSync("extensions/loops/goal-list-queue.ts", "utf8");

function at(source: string, needle: string, from = 0): number {
  const position = source.indexOf(needle, from);
  assert.ok(position >= 0, `source seam exists: ${needle}`);
  return position;
}

test("v0.38.53: proposal stages stale and interview gates before Confirm", () => {
  const staleEntry = at(TOOLS, "const staleDraftEntry =");
  const floor = at(TOOLS, "const block = draftProposalBlock", staleEntry);
  const firstConfirm = at(TOOLS, "const c = await confirmDraft(", floor);
  assert.ok(staleEntry < floor, "stale-entry check precedes the interview floor");
  assert.ok(floor < firstConfirm, "the interview floor precedes every draft Confirm");
});

test("v0.38.53: list batch conflict handling follows confirmation and precedes enqueue", () => {
  const confirm = at(TOOLS, '"Confirm list batch"');
  const conflict = at(TOOLS, 'resolveDraftActivationConflict(liveCtx, "list", p.items.join("; "))', confirm);
  const clear = at(TOOLS, "draftingTarget = null;", conflict);
  const enqueue = at(TOOLS, 'const n = enqueueItems(liveCtx, p.items, "drafted batch");', clear);
  const activation = at(TOOLS, "const activated = activateNextListItem(liveCtx);", enqueue);
  assert.ok(confirm < conflict, "the user confirms the whole batch before conflict handling");
  assert.ok(conflict < clear && clear < enqueue, "conflict resolution and draft cleanup precede enqueue");
  assert.ok(enqueue < activation, "paused-carryover activation follows durable batch enqueue");
});

test("v0.38.53: single list confirmation precedes post-confirm conflict handling", () => {
  const confirm = at(TOOLS, 'isListDraft ? "Confirm list item"');
  const afterConfirm = at(TOOLS, "const afterConfirm = freshCtxForGeneration(draftGeneration);", confirm);
  const conflict = at(TOOLS, 'resolveDraftActivationConflict(liveCtx, "list", p.objective.trim())', afterConfirm);
  assert.ok(confirm < afterConfirm, "the replacement-session fence runs after the dialog returns");
  assert.ok(afterConfirm < conflict, "list activation conflict is resolved only after confirmation");
});

test("v0.38.53: drafting starts only after prompt construction and before steering", () => {
  const target = at(QUEUE, "draftingTarget = target;");
  const prompt = at(QUEUE, "let tmpl = loadPromptWhole(file);", target);
  const model = at(QUEUE, "await beginDrafterModel(ctx);", prompt);
  const steer = at(QUEUE, "const sent = safeSteerUser(ctx, tmpl);", model);
  assert.ok(target < prompt && prompt < model && model < steer, "draft state, prompt, model lease, then seed steering");
});
