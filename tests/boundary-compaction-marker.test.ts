import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundaryCompactionEvidence, writeBoundaryCompactionMarker } from '../extensions/boundary-compaction-marker.js';
import { readCompactionMetadata } from '../extensions/compaction-status.js';
import { tmpCwd } from './harness/mock-pi.js';
const dirs: string[] = [];
afterEach(() => { for (const cwd of dirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true }); });
function file() { const cwd = tmpCwd(); dirs.push(cwd); return path.join(cwd, 'boundary.json'); }

test('atomic marker replacement records success without leaving partial/temp files', () => {
  const marker = file(); const at = new Date(Date.now() - 1000).toISOString();
  writeBoundaryCompactionMarker(marker, { at, tokens: 903644 });
  writeBoundaryCompactionMarker(marker, { at, tokens: 903644, completedAt: Date.now() });
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).tokens, 903644);
  assert.equal(readBoundaryCompactionEvidence(marker, Date.now()).unknown, false);
  assert.ok(readBoundaryCompactionEvidence(marker, Date.now()).completedAt);
  assert.deepEqual(fs.readdirSync(path.dirname(marker)), ['boundary.json']);
});

test('failed atomic replacement preserves the live destination and cleans its temporary file', () => {
  const marker = file(); fs.mkdirSync(marker); fs.writeFileSync(path.join(marker, 'preserved'), 'user evidence');
  assert.throws(() => writeBoundaryCompactionMarker(marker, { at: new Date().toISOString(), tokens: 300000 }));
  assert.equal(fs.readFileSync(path.join(marker, 'preserved'), 'utf8'), 'user evidence');
  assert.deepEqual(fs.readdirSync(path.dirname(marker)), ['boundary.json']);
});

test('malformed evidence reconciles only later durable success and agrees with status', () => {
  const marker = file(), now = Date.now(), old = now - 240000;
  fs.writeFileSync(marker, ''); fs.utimesSync(marker, old / 1000, old / 1000);
  assert.equal(readBoundaryCompactionEvidence(marker, now, old - 1).completedAt, undefined, 'older success cannot release a later attempt');
  assert.equal(readBoundaryCompactionEvidence(marker, now, now + 1).completedAt, undefined, 'future timestamps do not prove success');
  assert.equal(readBoundaryCompactionEvidence(marker, now, old + 1000).completedAt, old + 1000);
  assert.equal(readCompactionMetadata(marker, marker + '.budget', 'goal:x', now, 903644, 200000, old + 1000).marker, 'rearming');
  assert.equal(fs.readFileSync(marker, 'utf8'), '', 'observation does not mutate evidence');
});

for (const kind of ['oversize', 'directory', 'symlink'] as const) {
  test(`untrusted ${kind} marker cannot authorize a compaction retry`, () => {
    const marker = file();
    if (kind === 'oversize') fs.writeFileSync(marker, 'x'.repeat(4097));
    if (kind === 'directory') fs.mkdirSync(marker);
    if (kind === 'symlink') { fs.writeFileSync(marker + '.target', '{}'); fs.symlinkSync(marker + '.target', marker); }
    const result = readBoundaryCompactionEvidence(marker, Date.now(), Date.now());
    assert.equal(result.exists, true); assert.equal(result.unknown, true); assert.equal(result.completedAt, undefined);
  });
}
