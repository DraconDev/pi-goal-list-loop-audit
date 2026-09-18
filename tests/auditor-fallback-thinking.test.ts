// pi-goal-list-loop-audit — v0.38.65
// tests/auditor-fallback-thinking.test.ts
//
// Field 152226: two fallback-selector bugs —
//   1. picking auditor fallback models never offers the thinking-level
//      select the primary flow has, so a fallback chain cannot be given
//      a reasoning level at pick time;
//   2. choosing agnes/agnes-3.0-flash (the session model, slot 0) does
//      not stick: the mutual exclusion drops it and the row stays 0/10.
//      The TUI row is disabled with a reason, but the headless/input
//      path drops it SILENTLY and reports "cleared".
// Pins:
//   • a non-empty fallback save is followed by the auditor thinking
//     select, and the chosen level persists;
//   • typing the session model into the fallback input names the slot-0
//     exclusion (no silent clear);
//   • clearing the chain still skips the thinking prompt.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import { loadSettings } from "../extensions/goal-settings.js";
import { handleSettingChoice } from "../extensions/loops/goal.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ORIGINAL_ENV = process.env.GLLA_GLOBAL_SETTINGS_PATH;

const SESSION_MODEL: any = { provider: "agnes", id: "agnes-3.0-flash", reasoning: true, thinkingLevelMap: { max: "max", xhigh: "xhigh" } };
const OTHER_MODEL: any = { provider: "agnes", id: "other-flash", reasoning: true, thinkingLevelMap: { max: "max", xhigh: "xhigh" } };

function mockCtxWithRegistry(cwd: string): any {
  const ctx: any = makeMockCtx(cwd);
  ctx.model = SESSION_MODEL;
  ctx.thinkingLevel = "max";
  ctx.modelRegistry = {
    getAvailable: () => [SESSION_MODEL, OTHER_MODEL],
    hasConfiguredAuth: () => true,
    find: (provider: string, id: string) =>
      [SESSION_MODEL, OTHER_MODEL].find((m) => m.provider === provider && m.id === id),
  };
  return ctx;
}

function redirectGlobal(): void {
  process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(os.tmpdir(), `glla-fbthink-${process.pid}.json`);
}

function restoreEnv(): void {
  if (ORIGINAL_ENV === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
  else process.env.GLLA_GLOBAL_SETTINGS_PATH = ORIGINAL_ENV;
}

test("non-empty fallback save is followed by the auditor thinking select", async () => {
  const cwd = tmpCwd();
  redirectGlobal();
  try {
    const ctx = mockCtxWithRegistry(cwd);
    const selectTitles: string[] = [];
    // TUI path: factory is stubbed, the impl returns the picked refs.
    ctx.ui.customStubMode = true;
    ctx.ui.customImpl = async () => ["agnes/other-flash"];
    ctx.ui.selectImpl = async (title: string, options: string[]) => {
      selectTitles.push(title);
      return options.find((option) => option.startsWith("high")) ?? options[0];
    };
    await handleSettingChoice("auditorModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(ctx.cwd).auditorModelFallbacks, ["agnes/other-flash"]);
    assert.ok(
      selectTitles.some((title) => /Auditor thinking/i.test(title)),
      `expected an auditor thinking select, saw: ${JSON.stringify(selectTitles)}`,
    );
    assert.equal(loadSettings(ctx.cwd).auditorThinkingLevel, "high");
  } finally {
    restoreEnv();
  }
});

test("typing the session model into the fallback input names the slot-0 exclusion", async () => {
  const cwd = tmpCwd();
  redirectGlobal();
  try {
    const ctx = mockCtxWithRegistry(cwd);
    // Headless path: custom never invokes the factory → input fallback.
    ctx.ui.customStubMode = true;
    ctx.ui.customImpl = async () => undefined;
    ctx.ui.inputImpl = async () => "agnes/agnes-3.0-flash";
    await handleSettingChoice("auditorModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(ctx.cwd).auditorModelFallbacks ?? [], []);
    assert.ok(
      ctx.ui.matching("slot 0").length > 0,
      "expected a slot-0 exclusion notice, not a silent clear",
    );
  } finally {
    restoreEnv();
  }
});

test("clearing the fallback chain skips the thinking prompt", async () => {
  const cwd = tmpCwd();
  redirectGlobal();
  try {
    const ctx = mockCtxWithRegistry(cwd);
    const selectTitles: string[] = [];
    ctx.ui.customStubMode = true;
    ctx.ui.customImpl = async () => [];
    ctx.ui.selectImpl = async (title: string, options: string[]) => {
      selectTitles.push(title);
      return options[0];
    };
    await handleSettingChoice("auditorModelFallbacks", ctx as unknown as ExtensionContext);
    assert.deepEqual(loadSettings(ctx.cwd).auditorModelFallbacks ?? [], []);
    assert.ok(
      !selectTitles.some((title) => /Auditor thinking/i.test(title)),
      `clearing must not prompt thinking, saw: ${JSON.stringify(selectTitles)}`,
    );
  } finally {
    restoreEnv();
  }
});
