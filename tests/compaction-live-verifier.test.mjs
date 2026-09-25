// Offline safety/structure checks for the provider-backed compaction verifier.
// The actual provider proof remains scripts/verify-compaction-live.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../scripts/verify-compaction-live.mjs", import.meta.url), "utf8");

test("loads both local extension entrypoints and isolates Pi's agent directory", () => {
  assert.match(SOURCE, /extensions", "loops", "goal\.ts/);
  assert.match(SOURCE, /GLOBAL_CONTEXT_LIMIT_ROOT/);
  assert.match(SOURCE, /global-context-limit\.ts/);
  assert.match(SOURCE, /PI_CODING_AGENT_DIR: agentDir/);
  assert.match(SOURCE, /stageProviderConfiguration\(agentDir, options\.provider, options\.model\)/);
  assert.match(SOURCE, /never parsed, logged, or included in reports/);
  assert.match(SOURCE, /compaction: DEFAULT_COMPACTION_SETTINGS/);
  assert.match(SOURCE, /contextWindow: GLOBAL_LIMIT/);
  assert.match(SOURCE, /state\?\.model\?\.contextWindow !== GLOBAL_LIMIT/);
  assert.match(SOURCE, /fs\.rmSync\(tempRoot, \{ recursive: true, force: true \}\)/);
});

test("accepts only ordered host compaction events plus persisted non-empty records", () => {
  assert.match(SOURCE, /waitForTerminalCompaction/);
  assert.match(SOURCE, /event\.type === "compaction_start"/);
  assert.match(SOURCE, /event\.type === "compaction_end" && event\.sequence > start\.sequence/);
  assert.match(SOURCE, /waitForPersistedCompaction/);
  assert.match(SOURCE, /record\?\.type === "compaction"/);
  assert.match(SOURCE, /record\.summary\.trim\(\)/);
});

test("exercises manual RPC compaction and both post-compaction continuations", () => {
  assert.match(SOURCE, /rpc\.send\(\{ type: "compact" \}/);
  assert.match(SOURCE, /post-automatic continuation/);
  assert.match(SOURCE, /post-manual continuation/);
  assert.match(SOURCE, /original historical session checksum changed/);
  assert.match(SOURCE, /No raw prompt, summary, environment value, or provider diagnostic/);
});
