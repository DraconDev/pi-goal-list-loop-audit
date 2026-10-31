// tests/stale-build-warning.test.ts
//
// note.md 2026-10-31: a banner reported v0.39.36 while the repo's package.json
// said 0.39.54 — the loaded extension build was older than the checkout being
// edited, so the user was reading behaviour that was not in the source under
// discussion. Every display observation from that session was unreliable.
//
// Requirement: warn, name the fix, and NEVER block. This asserts all three
// directions — stale warns, matching stays silent, and a NEWER loaded build
// (a published install driving an older checkout) is not treated as stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareGllaVersions, detectStaleBuild, formatStaleBuildWarning,
} from '../extensions/glla-version.js';
import { loadedGllaVersion } from './harness/stale-build-helper.mjs';
import { tmpCwd } from './harness/mock-pi.js';

/** Write a repo package.json at `cwd` with the given version. */
function seedRepoVersion(cwd: string, version: string): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'pi-goal-list-loop-audit', version }, null, 2));
}

test('an older loaded build warns and names the reconcile action', () => {
  const cwd = tmpCwd();
  const loaded = loadedGllaVersion();
  // Simulate the note.md mismatch: repo is AHEAD of what is loaded.
  seedRepoVersion(cwd, `${Number(loaded.split('.')[0]) + 1}.0.0`);

  const status = detectStaleBuild(cwd);
  assert.equal(status.stale, true, 'a loaded build behind the repo is stale');
  assert.equal(status.loaded, loaded);
  assert.equal(status.repo, `${Number(loaded.split('.')[0]) + 1}.0.0`);

  const line = formatStaleBuildWarning(status);
  assert.ok(line, 'a stale build produces a warning line');
  assert.match(line!, /older than this repo/, 'the warning says which way round the mismatch is');
  assert.match(line!, /Reload|reinstall/i, 'the warning names the action that fixes it');
});

test('a matching version stays silent — the normal case must not nag', () => {
  const cwd = tmpCwd();
  const loaded = loadedGllaVersion();
  seedRepoVersion(cwd, loaded);

  const status = detectStaleBuild(cwd);
  assert.equal(status.stale, false, 'identical versions are not stale');
  assert.equal(formatStaleBuildWarning(status), undefined, 'no warning when nothing is stale');
});

test('a NEWER loaded build is not stale — a published install driving an old checkout', () => {
  const cwd = tmpCwd();
  const loaded = loadedGllaVersion();
  // Repo behind the loaded build: common when developing against an install.
  seedRepoVersion(cwd, '0.0.1');

  const status = detectStaleBuild(cwd);
  assert.equal(status.stale, false,
    'only a strictly OLDER loaded build is stale; a newer one is not a defect to report');
  assert.equal(formatStaleBuildWarning(status), undefined);
});

test('a missing or unreadable repo manifest proves nothing and stays silent', () => {
  const cwd = tmpCwd();
  // No package.json at all.
  assert.equal(detectStaleBuild(cwd).stale, false,
    'absence of a repo manifest is not evidence of staleness');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{ not json');
  assert.equal(detectStaleBuild(cwd).stale, false,
    'a damaged manifest must not produce a warning');
  assert.equal(detectStaleBuild(undefined).stale, false, 'no cwd means no comparison');
});

test('version comparison is numeric, not lexical', () => {
  assert.ok(compareGllaVersions('0.39.9', '0.39.10') < 0, '9 is older than 10 numerically');
  assert.ok(compareGllaVersions('0.39.36', '0.39.54') < 0, 'the note.md pair is ordered correctly');
  assert.equal(compareGllaVersions('0.39.54', '0.39.54'), 0);
  assert.ok(compareGllaVersions('1.0.0', '0.99.99') > 0);
  // A prerelease suffix must not make an older build look newer.
  assert.ok(compareGllaVersions('0.39.54-beta.1', '0.39.54') <= 0);
});
