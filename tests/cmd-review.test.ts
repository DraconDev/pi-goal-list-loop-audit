import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { archiveDir } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tick, tmpCwd } from "./harness/mock-pi.js";

function events(cwd: string) {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function boot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `cmd-review-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120); return ctx;
}
function seedArchive(cwd: string, id: string): void {
  const dir = archiveDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), `# Goal\n\n**Status**: complete\n\n## Objective\n\n> did the thing ${id}\n`);
}
afterEach(() => { __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

test("C8: ambiguous substring id refuses with the candidates instead of reviewing the first match", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  seedArchive(cwd, "abc-first");
  seedArchive(cwd, "abc-second");
  try {
    await pi.command("review", "abc", ctx);
    const hits = ctx.ui.matching("matches 2 archived goals");
    assert.equal(hits.length, 1, "ambiguity refusal names the match count");
    assert.ok(hits[0]!.message.includes("abc-first") && hits[0]!.message.includes("abc-second"), "refusal lists the candidates");
    assert.equal(events(cwd).filter(e => e.type === "reviewer_fired").length, 0, "no review fired on ambiguity");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("C8 control: exact id fires the review", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  seedArchive(cwd, "abc-first");
  seedArchive(cwd, "abc-second");
  try {
    await pi.command("review", "abc-first", ctx);
    assert.equal(ctx.ui.matching("matches 2 archived goals").length, 0);
    assert.equal(events(cwd).filter(e => e.type === "reviewer_fired").length, 1, "exact id fires exactly one review");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
