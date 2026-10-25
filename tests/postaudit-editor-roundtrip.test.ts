// pi-goal-list-loop-audit — v0.39.53
// tests/postaudit-editor-roundtrip.test.ts
//
// audit 2026-10-25, finding 2 (P1): the /glla postaudit editor read the
// LEGACY `reviewer` key, which load-migration consolidates into `postaudit`
// and DELETES on every read — the repo already pins "legacy key does not
// survive load" (tests/settings-menu-complete.test.ts). The read was therefore
// always `undefined`, so every edit merged over the DEFAULTS and silently
// discarded the options an earlier edit had saved: an explicit "off" reverted
// to the default "on", and the sub-menu rendered the defaults instead of the
// saved state.
//
// The existing tests covered the pieces (both keywords reach the same menu,
// reviewerMenuOptions renders a given config, the table row says "open
// sub-menu") but never the ROUND TRIP: write a block, then read it back
// through the editor. That is where the defect lived.
//
// These drive the REAL editor through the real /glla command.
//
// Shared-process hazard (note.md): this file activates the goal.js module
// singleton at module scope, so it copies glla-stale-context.test.ts's
// afterEach cleanup and the __testOnlyResetOwnerSession() in freshSession.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { loadSettings, projectSettingsPath } from "../extensions/goal-settings.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

afterEach(() => {
  __testOnlyResetOwnerSession(); // release the claim so later files are unaffected
});

async function freshSession(cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick();
  return ctx;
}

interface Render {
  title: string;
  options: string[];
}

/** Drive the postaudit sub-menu: pick `picks` in order, then Done.
 *  Every render is captured so a test can assert what the operator SAW. */
function driveMenu(ctx: MockCtx, picks: string[]): Render[] {
  const seen: Render[] = [];
  let step = 0;
  ctx.ui.selectImpl = async (title: string, options: string[]) => {
    seen.push({ title, options: [...options] });
    const want = picks[step];
    step += 1;
    if (!want) return options.find((o) => o === "Done");
    const hit = options.find((o) => o.startsWith(want));
    assert.ok(hit, `the menu offers a "${want}" option (got: ${options.join(" | ")})`);
    return hit;
  };
  return seen;
}

test("v0.39.53: a postaudit edit does not discard the options an earlier edit saved", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd);
  driveMenu(ctx, ["Enabled", "Mode"]);

  await pi.command("glla", "postaudit", ctx);
  await tick();

  const saved = loadSettings(cwd).postaudit as { enabled?: boolean; mode?: string } | undefined;
  assert.ok(saved, "the postaudit block was saved");
  assert.equal(saved.mode, "auto", "the second edit (Mode) landed");
  assert.equal(
    saved.enabled,
    false,
    "the first edit (Enabled → off) survived the second edit — a later edit must merge over the SAVED block, not over the defaults",
  );

  const onDisk = JSON.parse(fs.readFileSync(projectSettingsPath(cwd), "utf8"));
  assert.equal(onDisk.postaudit?.enabled, false, "the saved block on disk keeps the earlier edit");
  assert.equal(onDisk.postaudit?.mode, "auto", "the saved block on disk carries the later edit");
});

test("v0.39.53: the postaudit sub-menu shows the configuration the operator saved", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = await freshSession(cwd);
  const seen = driveMenu(ctx, ["Enabled"]);

  await pi.command("glla", "postaudit", ctx);
  await tick();

  assert.ok(seen.length >= 2, `the sub-menu rendered at least twice (got ${seen.length})`);
  const afterToggle = seen[1]!.options.find((o) => o.startsWith("Enabled"));
  assert.match(
    afterToggle ?? "",
    /Enabled — OFF/,
    "after turning the post-completion audit OFF the menu must show it OFF, not the default ON",
  );
});

test("v0.39.53: a legacy reviewer block is still honoured by the editor", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {});
  fs.mkdirSync(path.dirname(projectSettingsPath(cwd)), { recursive: true });
  fs.writeFileSync(projectSettingsPath(cwd), JSON.stringify({ reviewer: { mode: "auto" } }));
  const ctx = await freshSession(cwd);
  const seen = driveMenu(ctx, []);

  await pi.command("glla", "postaudit", ctx);
  await tick();

  const mode = seen[0]!.options.find((o) => o.startsWith("Mode"));
  assert.match(mode ?? "", /Mode — auto/, "the legacy reviewer block reaches the menu through load-migration");
});
