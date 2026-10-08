import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockPi, makeMockCtx, type MockCtx } from './harness/mock-pi.ts';
import { registerGoalRuntime } from '../extensions/loops/goal-activation.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-progress-cmd-'));
  const pi = new MockPi();
  (pi.api as any).events = { on: () => undefined, off: () => undefined };
  const ctx = makeMockCtx(dir);
  registerGoalRuntime(pi.api as unknown as ExtensionAPI);
  const glla = pi.commands.get('glla')!;
  return { dir, pi, ctx, glla };
}

test('/glla progress is read-only and never mutates the journal, owner or settings', async (t: TestContext) => {
  const { dir, pi, ctx, glla } = setup();
  const settings = path.join(dir, '.pi-glla', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{"global":{}}');
  const journal = path.join(dir, 'active.jsonl');
  const owner = path.join(dir, 'owner.json');
  fs.writeFileSync(journal, '');
  fs.writeFileSync(owner, '{"generation":"foreign","pid":1}');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup is best-effort */ } });
  const before = (): [string, string, string[], string] => [fs.readFileSync(journal, 'utf8'), fs.readFileSync(owner, 'utf8'), fs.readdirSync(dir).sort(), fs.readFileSync(settings, 'utf8')];
  const snapshot = before();
  await glla('progress', ctx as unknown as ExtensionContext);
  await glla('progress json', ctx as unknown as ExtensionContext);
  const notify = ctx.ui.notifies.map(notification => notification.message).filter(message => typeof message === 'string');
  assert.ok(notify.length >= 1);
  assert.ok(!notify.some(content => content.includes('progress json')));
  assert.deepEqual(before(), snapshot);
});

test('/glla progress refuses to run when the global settings selector is unreadable', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-progress-pending-'));
  const pi = new MockPi();
  (pi.api as any).events = { on: () => undefined, off: () => undefined };
  const ctx = makeMockCtx(dir);
  registerGoalRuntime(pi.api as unknown as ExtensionAPI);
  const glla = pi.commands.get('glla')!;
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup is best-effort */ }
    // Restore the preload-populated settings so the rest of the suite keeps a valid selector.
    fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({ aggressiveMode: false }));
  });
  fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH!, JSON.stringify({ stateRoot: "invalid-root" }));
  await glla('progress', ctx as unknown as ExtensionContext);
  const warning = ctx.ui.notifies.find(notification => notification.message?.includes('Progress unavailable'))?.message;
  assert.ok(typeof warning === 'string' && warning.includes('select the GLLA state root'));
});
