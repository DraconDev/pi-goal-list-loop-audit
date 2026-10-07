// pi-goal-list-loop-audit — bounded injected-failure tests for the test
// runner's retained diagnostics. Pin the helpers without launching the
// real suite; verify safe capture paths and absence of secret leakage.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { captureTestFailureDiagnostics, type TestFailureDiagnostics } from "../scripts/test-failure-diagnostics.mjs";

function tmpCwd(prefix = "glla-fail-diag-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFailingFixture(cwd: string, marker: string, detail: string): void {
  // The test surface must not have a real child re-spawning bun test (a
  // collected test running the suite is a fork bomb per AGENTS.md). The
  // diagnostic helper is invoked on synthetic inputs instead.
  fs.writeFileSync(path.join(cwd, "marker.txt"), marker);
  fs.writeFileSync(path.join(cwd, "detail.txt"), detail);
}

test("captureTestFailureDiagnostics retains a bounded tail and the diagnostic markers", () => {
  const cwd = tmpCwd();
  writeFailingFixture(cwd, "testA", "stdout\nstderr\n");
  const diag = captureTestFailureDiagnostics({ cwd, exitCode: 1, registryDir: cwd });
  assert.equal(diag.exitCode, 1);
  assert.match(diag.markers[0]!, /testA/);
  assert.ok(diag.timedOutMs !== undefined);
  assert.ok(diag.commands.length > 0);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("captureTestFailureDiagnostics redacts obvious secret tokens and long opaque strings", () => {
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, "detail.txt"), "[DRACON_SECRET:YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBBcHIzMXVPVDNJaHpHRU5BVUt0VG83N204L084dU5aZms3UlRMdVh0SXlBCmtteVdYczl2eUdwTzk2cHc4TjNyL3RZYjNvemlnaS9hcjVmZFJkSTYrYzAKLT4gWDI1NTE5IDI4aW1hcjJybWFWWEg1cTBCN2hRdHFsaE1yczJkeFhuRWJ4MlZ1emIxV3cKTXhudkRIYUduR01LK2FPbWtSMkZlai9xbS96SzZKV1gwcytOSFUxR1JkNAotPiBYMjU1MTkgSTVqR1pNa2lhVGcxbmhrZTEzRWJDcEtuYk91NnpISEJLSXQxZjNESDBGdwpGMFYvZUFaaEFlWitJN3JpM29yM1pua3pKSE5laUZoZHQrTlBtcFhuSjBvCi0+IFgyNTUxOSB3bWI4UmY4cUhWWXpNd1U2M3BwajN1YU9WekszOUZETWV3OHhDbWQ0YmpzCjh4TnZuYUYwMDExaWxLR1h6ZWVlcThhOUZLWEVWQmxOMm54RGUzaTdNT1kKLT4gWDI1NTE5IGN0Q3FYQVJvM0t1QkNnK29QL2g2SlNjOEVNM0xvL0RDY1A4Znh6WVNEQmMKN1lPS1lWT3luRmlMdXBvTUNKQVQ0NFI1aFU5M3haalhYT1A2dXhPblRZWQotPiBqPztXPV99Ti1ncmVhc2UgKytMZCB2QyBMSXI2LGgkCjBzTUw5Nml4dGNMOXUwNmtPVWl2Ky9nS29PQk1UMkJ4NTNWR0JiMU40ckRpMGJvc1pFZUZidE40cHFCOG8wNDMKZEwvVUhIQVZyU3ZydFNmTm4zbHNwMm5TdzE2bFBKeXRNV1EKLS0tIEl2YW12aEZmejNOV0tqL1VsaFVJNmhuZlBDaUU3RG0wTzJINlRnczlZQWsK9IhUk96qJcTViK9YIhzRlVu3yqJcy1BTwawWYo56VLIQGNtpOvtILuTy4QfqOv6oT6EEsw==] [DRACON_SECRET:YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSAzVFpjcVNLWmUzV2hORGxLSWQ0SlJhd2xxQ0RNTStEZGNIa1RDVDJGY1NnCm9idm43M01NNkFiWlNlUysvUnJWU2NNcWdScUVJWTAxdUtCOXlYOFlxcDQKLT4gWDI1NTE5IGVSZFdoby9NcS9saXBoblZ6ZGpnbklmNVNQT1NyYUtHMnJNNHdKeTJ6UncKeFU0UjFYZURLM1NSdnE4SVJEY29HdU1iMFJKOUFLeDJ4VmxqcXZHaEpaWQotPiBYMjU1MTkgQXJJR1Znd3pxb3RDejA3dnU4OUlrRDhQK2JFUUQzU0JVR0ZBZGNDYVpERQplbFN2bW5pZFBWTzJWTCtEK0tXWHN2RjQzWHowOHIraHQ1UTlrUDJ4TXdnCi0+IFgyNTUxOSBKMnhTRTNORVV2TDJNbC9EVHVPenlyUW93d3NwN1RtV0hQRG1mbUVJbFNNCldwVllIdkdGVjAzektuSjFVb2RNTVV0dVJLbGVLZXhyWi9GMXFVYlIzNUEKLT4gWDI1NTE5IEdVaDB5SnA2Q0NSeHZkUFI4a2FhRjFoVXlGd1RnRkR1V0tocHZJSlJJalUKeW5mWEdqY1BtTkRFK1BTMWF1c0JjTlQ1UStKdW9qUEhIRitLQ05mTkNLbwotPiBROitWU3RfLWdyZWFzZQo2c0ZkQ21GbTIrajBTc0p1SmFTNk5mNTJTQ2JzRWxlaWRPWXNIQUs3ei9FSUphdTgyMC9jTGF6MUY0cEJXdjVoCk01RGhmN3JMbFRTclBMWFR5d3RkTDRqZjdRNmpzTC82b0swRE1naUoxL1JvbGpJc0NjOFlVZ2Y5RUEKLS0tIDA1dkxvellYa0k1WlNkSWdFdHk4NU5jN0E2TDZiN1drWHNHN1BLb051dVUKuvB4638Cl58BICwhZXPgh6+NfhDpg9XpfIw/reAPsdUPeS7mtBaWMOzH5eWg854JP3C4VC4ibXpmtioDBx2QCNv7moBd5D0L] /var/tmp/leaked.log");
  const diag = captureTestFailureDiagnostics({ cwd, exitCode: 124 });
  assert.ok(!diag.commands.some(line => /AKIA[0-9A-Z]{8,}/.test(line)), "AWS keys are redacted");
  assert.ok(!diag.commands.some(line => /ghp_[0-9a-fA-F]{8,}/.test(line)), "GitHub tokens are redacted");
  assert.ok(!diag.commands.some(line => /\/var\/tmp\/[^\s]+/.test(line)), "machine paths are redacted");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("captureTestFailureDiagnostics fails closed on an unwritable cwd without throwing", () => {
  const cwd = tmpCwd();
  fs.chmod(cwd, 0o000);
  let diag: TestFailureDiagnostics | undefined;
  try { diag = captureTestFailureDiagnostics({ cwd, exitCode: 1 }); }
  finally { fs.chmod(cwd, 0o755); fs.rmSync(cwd, { recursive: true, force: true }); }
  assert.ok(diag);
  assert.equal(diag.exitCode, 1);
  assert.deepEqual(diag.markers, []);
});

test("real spawned bun test that fails does not run the suite", async () => {
  // Surface the harness, not the runner: spawn a trivial bun test that
  // does NOT re-enter the project's tests and assert the helper preserves
  // an exit-code and bounded tail without inheriting the suite.
  const cwd = tmpCwd("glla-fail-spawn-");
  const child = spawn("bun", ["test", path.resolve(process.cwd(), "tests/harness/mock-pi.test.ts")], { cwd, env: process.env });
  const chunks: string[] = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk.toString()));
  child.stderr.on("data", (chunk) => chunks.push(chunk.toString()));
  const code: number = await new Promise((resolve) => child.on("close", (status) => resolve(status ?? 1)));
  const diag = captureTestFailureDiagnostics({ cwd, exitCode: code });
  assert.equal(diag.exitCode, code);
  fs.rmSync(cwd, { recursive: true, force: true });
});
