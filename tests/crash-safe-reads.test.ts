import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

// Issue #63: `fs.readFileSync(path, "utf8")` (and "utf-8") does not take
// Node's JS open/read/close path. It calls the native `binding.readFileUtf8`,
// which asserts that close(2) succeeds. On a flaky VirtioFS/FUSE mount a
// failed close ABORTS the host pi process — no try/catch can intercept it.
// The buffer form (`readFileSync(path)` + `.toString("utf8")`) closes through
// `fs.closeSync`, which throws an ordinary, catchable error instead.
//
// Every module that loads inside the pi host process must use the buffer
// form. Child-process workers are out of scope: a worker abort is already
// observed and classified by the parent.

const ROOT = path.resolve(import.meta.dirname, "..");
// scripts/*.mjs modules imported in-process by extensions/.
const IN_PROCESS_SCRIPTS = [
  "scripts/auditor-provider-failure.mjs",
  "scripts/auditor-round-prompts.mjs",
  "scripts/goal-auditor-launch.mjs",
  "scripts/test-process-registry.mjs",
];

function hostFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, "extensions"));
  for (const rel of IN_PROCESS_SCRIPTS) out.push(path.join(ROOT, rel));
  return out;
}

// Matches the encoding argument of a readFileSync call, string or options form.
const NATIVE_UTF8_READ = /readFileSync\([^;]*?,\s*(?:["']utf-?8["']|\{[^}]*encoding:\s*["']utf-?8["'][^}]*\})\s*\)/;

describe("crash-safe host reads (issue #63)", () => {
  test("no host module uses the native utf8 readFileSync fast path", () => {
    const offenders: string[] = [];
    for (const file of hostFiles()) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (NATIVE_UTF8_READ.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `use fs.readFileSync(p).toString("utf8") instead:\n${offenders.join("\n")}`);
  });

  test("the in-process script list matches what extensions import", () => {
    const imported = new Set<string>();
    for (const file of hostFiles().filter((f) => f.includes(`${path.sep}extensions${path.sep}`))) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/from\s+["']((?:\.\.\/)+scripts\/[^"']+\.mjs)["']/g)) {
        imported.add(path.relative(ROOT, path.resolve(path.dirname(file), m[1]!)));
      }
    }
    for (const rel of imported) assert.ok(IN_PROCESS_SCRIPTS.includes(rel), `${rel} is imported in-process; add it to IN_PROCESS_SCRIPTS`);
  });

  test("the pattern catches both encodings and the options form", () => {
    assert.match('fs.readFileSync(p, "utf8")', NATIVE_UTF8_READ);
    assert.match("fs.readFileSync(p, 'utf-8')", NATIVE_UTF8_READ);
    assert.match('fs.readFileSync(p, { encoding: "utf8" })', NATIVE_UTF8_READ);
    assert.doesNotMatch('fs.readFileSync(p).toString("utf8")', NATIVE_UTF8_READ);
  });
});
