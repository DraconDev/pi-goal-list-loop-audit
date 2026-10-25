import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scaledBudgetMs } from "../scripts/host-contention.mjs";

// Exercise the real runner and production wiring across files: a unit rig
// replaces recovery dependencies, then a behavioral file activates GLLA.
test('runner isolates recovery factory wiring per file and aggregates failures', { timeout: scaledBudgetMs(60000) }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-runner-isolation-'));
  const moduleUrl = (name: string) => JSON.stringify(new URL(`../${name}`, import.meta.url).href);
  try {
    const rig = path.join(directory, 'a-rig.test.ts');
    const runtime = path.join(directory, 'b-runtime.test.ts');
    const failure = path.join(directory, 'c-failure.test.ts');
    fs.writeFileSync(rig, `
      import { test } from 'bun:test';
      import ${moduleUrl('extensions/loops/goal.ts')};
      import { createGoalRecovery } from ${moduleUrl('extensions/goal-recovery.ts')};
      createGoalRecovery({}, new Proxy({}, { get() { return () => { throw new Error('LEAKED_RECOVERY_WIRING'); }; } }));
      console.log('FACTORY_RIG_INSTALLED');
      test('factory rig', () => {});
    `);
    fs.writeFileSync(runtime, `
      import { test } from 'bun:test';
      import assert from 'node:assert/strict';
      import activate from ${moduleUrl('extensions/loops/goal.ts')};
      import { MockPi, makeMockCtx, tmpCwd, seedState } from ${moduleUrl('tests/harness/mock-pi.ts')};
      test('production activation after factory rig', async () => {
        const cwd = tmpCwd(), pi = new MockPi(), ctx = makeMockCtx(cwd);
        seedState(cwd, { goal: null });
        activate(pi.api);
        await pi.fire('session_start', { reason: 'reload' }, ctx);
        assert.equal(pi.sent.length, 0);
        await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
        console.log('PRODUCTION_ACTIVATION_PASSED');
      });
    `);
    fs.writeFileSync(failure, `import { test, expect } from 'bun:test'; test('intentional failure', () => expect(1).toBe(2));`);
    // v0.39.53 (gate stability): the nested runner boots bun, loads the whole
    // extension and runs a real session_start. A hard-coded 30 s kill window
    // SIGTERMs it on a loaded host — the nested run then exits non-zero and the
    // gate reports a healthy system as broken. Size the window with the repo's
    // load-aware budget helper instead of a fixed guess.
    const run = (files: string[]) => spawnSync('node', [path.resolve('scripts/run-tests.mjs'), ...files], {
      env: { ...process.env, GLLA_GLOBAL_SETTINGS_PATH: path.join(directory, 'settings.json') },
      encoding: 'utf8', timeout: scaledBudgetMs(30_000),
    });
    const passing = run([rig, runtime]);
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    assert.match(passing.stdout + passing.stderr, /PRODUCTION_ACTIVATION_PASSED/);
    assert.ok(passing.stdout.indexOf('FACTORY_RIG_INSTALLED') < passing.stdout.indexOf('PRODUCTION_ACTIVATION_PASSED'), 'factory overwrite precedes production activation');
    const failing = run([rig, runtime, failure]);
    assert.equal(failing.status, 1, failing.stdout + failing.stderr);
    assert.match(failing.stdout + failing.stderr, /PRODUCTION_ACTIVATION_PASSED/);
    assert.match(failing.stdout + failing.stderr, /intentional failure/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
