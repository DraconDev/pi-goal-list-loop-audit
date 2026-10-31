// tests/harness/stale-build-helper.mjs
//
// The loaded build's version, read from the package manifest that ships beside
// the extension — the same source `readGllaVersionInfo()` uses. Kept out of the
// test file so the assertion does not re-implement the comparison under test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadedGllaVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = path.resolve(here, '../../package.json');
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}
