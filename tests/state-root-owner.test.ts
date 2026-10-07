// v0.38.11 (state-root owner takeover): classification matrix, guards,
// consented SIGTERM end-to-end against real child processes, heartbeat.
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildOwnerStatusLines,
  cmdGllaOwner,
  cmdGllaTakeover,
  cmdlineComm,
  classifyOwner,
  describeOwner,
  looksLikePi,
  normalizeOwnerAt,
  refreshOwnerHeartbeat,
  takeoverOwnerRoot,
  __testOnlyResetOwnerHeartbeat,
} from "../extensions/state-root-owner.js";
import {
  claimProcessOwner,
  ownerFilePath,
  readOwnerFile,
} from "../extensions/loops/goal-session.js";
import { tmpCwd } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function setGlobalSettings(value: Record<string, unknown>): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(value));
}

const children: ChildProcess[] = [];
afterEach(async () => {
  setGlobalSettings({ aggressiveMode: false });
  __testOnlyResetOwnerHeartbeat();
  for (const c of children.splice(0)) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  try { execSync(`pkill -f 'sleep 9999[12]'`); } catch { /* none left */ }
});

function writeOwner(cwd: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(ownerFilePath(cwd)), { recursive: true });
  fs.writeFileSync(ownerFilePath(cwd), JSON.stringify(record));
}
function readLedger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}
/** A child whose cmdline provably looks like pi (argv carries a pi- path). */
function spawnPiShaped(): ChildProcess {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-owner-probe-"));
  // Basename carries "pi" so the default looksLikePi guard admits it —
  // the same way a real pi host's argv does.
  const script = path.join(dir, "pi-probe.mjs");
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const c = spawn(process.execPath, [script], { stdio: "ignore" });
  children.push(c);
  return c;
}
function spawnSleep(marker = "99991"): ChildProcess {
  const c = spawn("sleep", [marker], { stdio: "ignore" });
  children.push(c);
  return c;
}
function fakeCtx(cwd: string, confirm: boolean, notes: string[]): ExtensionContext {
  return {
    cwd,
    ui: {
      notify: (message: string) => { notes.push(String(message)); },
      confirm: async () => confirm,
    },
    sessionManager: { getSessionId: () => "test-session-id" },
  } as unknown as ExtensionContext;
}

// ── pure matrix ───────────────────────────────────────────────────────

test("normalizeOwnerAt tolerates number and ISO, rejects garbage", () => {
  assert.equal(normalizeOwnerAt(1788461301980), 1788461301980);
  assert.equal(normalizeOwnerAt("2026-09-03T18:48:21.983Z"), Date.parse("2026-09-03T18:48:21.983Z"));
  assert.equal(normalizeOwnerAt("nonsense"), null);
  assert.equal(normalizeOwnerAt(undefined), null);
  assert.equal(normalizeOwnerAt(null), null);
});

test("looksLikePi admits pi hosts, refuses sleep, abstains on unknown", () => {
  assert.equal(looksLikePi("pi\0--agent\0"), true);
  assert.equal(looksLikePi("/usr/bin/sleep\0" + "99991\0"), false);
  assert.equal(looksLikePi(null), false);
  // Audit 2026-09-06: substring impostors must NOT pass the SIGTERM gate.
  assert.equal(looksLikePi("/usr/bin/pip\0install\0pi-subagents\0"), false, "pip refused");
  assert.equal(looksLikePi("/usr/local/bin/pilot\0run\0"), false, "pilot refused");
  assert.equal(looksLikePi("/opt/episode/bin/episode\0"), false, "episode refused");
  assert.equal(looksLikePi("/usr/bin/capital\0"), false, "capital refused");
  // …while genuine pi shapes still admit.
  assert.equal(looksLikePi("/usr/local/bin/pi\0"), true, "pi binary");
  assert.equal(looksLikePi(process.execPath + "\0/tmp/pi-probe.mjs\0"), true, "pi-*.mjs probe");
  assert.equal(looksLikePi("node\0/home/u/pi-coding-agent/run.mjs\0"), true, "source checkout");
  assert.equal(cmdlineComm("/usr/bin/sleep\0" + "99991\0"), "sleep");
  assert.equal(cmdlineComm(null), "(unknown)");
});

test("classifyOwner covers the full matrix", () => {
  const now = Date.now();
  const occ = (alive: boolean, startMs: number | null) => ({ alive, startMs });
  assert.equal(classifyOwner(null, 1, occ(true, null), now), "none");
  assert.equal(classifyOwner({ pid: 1 } as any, 1, occ(true, null), now), "self");
  assert.equal(classifyOwner({ pid: 2, shutdownAt: "x" } as any, 1, occ(true, 1), now), "released");
  assert.equal(classifyOwner({ pid: 2 } as any, 1, occ(false, null), now), "dead");
  assert.equal(
    classifyOwner({ pid: 2, at: now - 3600_000 } as any, 1, occ(true, now - 1000), now),
    "recycled",
    "occupant younger than the claim cannot be the claimant",
  );
  assert.equal(
    classifyOwner({ pid: 2, at: now - 3600_000 } as any, 1, occ(true, now - 7200_000), now),
    "live-foreign",
  );
  assert.equal(
    classifyOwner({ pid: 2, at: now - 3600_000 } as any, 1, occ(true, null), now),
    "live-foreign",
    "unknowable start time never recycles — it stays live-foreign",
  );
  assert.equal(
    classifyOwner({ pid: 2, at: now - 3600_000 } as any, 1, occ(true, now - 3570_000), now),
    "live-foreign",
    "30s younger than the claim is inside the skew margin — stays live-foreign",
  );
});

test("describeOwner returns null for self, shape for foreign", () => {
  assert.equal(describeOwner({ pid: process.pid } as any, process.pid), null);
  const d = describeOwner({ pid: 999999001, at: Date.now() - 5000 } as any, process.pid, {
    isAlive: () => false,
    readCmdline: () => null,
    procStartMs: () => null,
  });
  assert.ok(d);
  assert.equal(d!.ownerClass, "dead");
  assert.equal(d!.comm, "(unknown)");
});

// ── quiet paths: never signal ─────────────────────────────────────────

test("takeover with no record claims silently", async () => {
  const cwd = tmpCwd();
  let signaled = 0;
  const r = await takeoverOwnerRoot({ cwd, record: null, confirmed: false, deps: { signal: () => { signaled++; } } });
  assert.equal(r.outcome, "reclaimed");
  assert.equal((r as any).via, "none");
  assert.equal(signaled, 0);
  assert.equal(readOwnerFile(cwd)?.pid, process.pid);
});

test("takeover of a dead owner reclaims without signaling", async () => {
  const cwd = tmpCwd();
  let signaled = 0;
  const r = await takeoverOwnerRoot({
    cwd,
    record: { pid: 2 ** 30 + 7, at: Date.now() - 1000 } as any,
    confirmed: false,
    deps: { signal: () => { signaled++; } },
  });
  assert.equal(r.outcome, "reclaimed");
  assert.equal((r as any).via, "dead");
  assert.equal(signaled, 0, "dead owners are unlinked, never signaled");
  assert.match(readLedger(cwd), /"owner_takeover"/);
  assert.match(readLedger(cwd), /"via":"dead"/);
});

test("takeover of self reclaims (same-process sessions always win)", async () => {
  const cwd = tmpCwd();
  writeOwner(cwd, { instanceId: "other:1", pid: process.pid, at: Date.now() - 1000 });
  const r = await takeoverOwnerRoot({ cwd, record: readOwnerFile(cwd), confirmed: false });
  assert.equal(r.outcome, "reclaimed");
  assert.equal((r as any).via, "self");
});

// ── live foreign owner: confirm gate + guards ─────────────────────────

test("live owner without confirm returns needs-confirm and touches nothing", async () => {
  const cwd = tmpCwd();
  const child = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: child.pid, at: Date.now() });
  const r = await takeoverOwnerRoot({ cwd, record: readOwnerFile(cwd), confirmed: false });
  assert.equal(r.outcome, "needs-confirm");
  assert.equal((r as any).owner.pid, child.pid);
  assert.equal(child.kill(0), true, "still alive — no signal without confirm");
  assert.equal(readOwnerFile(cwd)?.pid, child.pid, "no claim without confirm");
});

test("confirmed takeover of a non-pi process is refused, survivor unclaimed", async () => {
  const cwd = tmpCwd();
  const child = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: child.pid, at: Date.now() });
  const r = await takeoverOwnerRoot({ cwd, record: readOwnerFile(cwd), confirmed: true });
  assert.equal(r.outcome, "refused");
  assert.equal((r as any).reason, "not-pi-process");
  assert.equal(child.kill(0), true, "sleep was never signaled");
  assert.equal(readOwnerFile(cwd)?.pid, child.pid);
  assert.match(readLedger(cwd), /"owner_takeover_refused"/);
});

test("persistent signal permission failure refuses after one attempt without reclaim", async () => {
  const cwd = tmpCwd();
  writeOwner(cwd, { pid: 987654, at: Date.now() });
  const before = readOwnerFile(cwd);
  let signals = 0;
  let sleeps = 0;
  const result = await takeoverOwnerRoot({ cwd, record: before, confirmed: true, deps: {
    isAlive: () => true,
    procStartMs: () => null,
    readCmdline: () => "pi\0",
    signal: () => { signals++; throw new Error("EPERM"); },
    sleepMs: async () => { sleeps++; },
  } });
  assert.equal(result.outcome, "refused");
  if (result.outcome === "refused") assert.equal(result.reason, "signal-failed");
  assert.equal(signals, 1);
  assert.equal(sleeps, 0);
  assert.deepEqual(readOwnerFile(cwd), before);
  assert.match(readLedger(cwd), /signal-failed/);
});

test("failed signal reclaims only after the owner is proven dead", async () => {
  const cwd = tmpCwd();
  writeOwner(cwd, { pid: 987654, at: Date.now() });
  let alive = true;
  let signals = 0;
  const result = await takeoverOwnerRoot({ cwd, record: readOwnerFile(cwd), confirmed: true, deps: {
    isAlive: () => alive,
    procStartMs: () => null,
    readCmdline: () => "pi\0",
    signal: () => { signals++; alive = false; throw new Error("ESRCH"); },
  } });
  assert.equal(result.outcome, "reclaimed");
  assert.equal(signals, 1);
  assert.equal(readOwnerFile(cwd)?.pid, process.pid);
});

test("confirmed takeover SIGTERMs a pi-shaped owner, verifies exit, claims", async () => {
  const cwd = tmpCwd();
  const child = spawnPiShaped();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(child.kill(0), true, "precondition: child alive");
  writeOwner(cwd, { pid: child.pid, at: Date.now() });
  const r = await takeoverOwnerRoot({ cwd, record: readOwnerFile(cwd), confirmed: true });
  assert.equal(r.outcome, "taken");
  assert.equal((r as any).signaled, true);
  assert.equal((r as any).prevPid, child.pid);
  // Bounded exit poll, not an instant kill(0): under suite load libuv may
  // briefly report a not-yet-reaped zombie as signalable. Kernel truth
  // (raw kill ESRCH) with a deadline is deterministic either way.
  const exitDeadline = Date.now() + 5000;
  let exited = false;
  while (Date.now() < exitDeadline) {
    try {
      process.kill(child.pid!, 0);
    } catch {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(exited, true, "owner exited after SIGTERM");
  assert.equal(readOwnerFile(cwd)?.pid, process.pid, "claimed after verified exit");
  assert.match(readLedger(cwd), /"signaled":true/);
});

test("owner surviving SIGTERM is never claimed", async () => {
  const cwd = tmpCwd();
  const child = spawn("sh", ["-c", 'trap "" TERM; sleep 99992'], { stdio: "ignore" });
  children.push(child);
  await new Promise((r) => setTimeout(r, 200));
  writeOwner(cwd, { pid: child.pid, at: Date.now() });
  const r = await takeoverOwnerRoot({
    cwd,
    record: readOwnerFile(cwd),
    confirmed: true,
    // settleMs shrinks the 5s production settle window: the busy poll
    // with immediate sleeps would otherwise eat the whole test timeout.
    deps: { readCmdline: () => "pi\0", sleepMs: () => Promise.resolve(), settleMs: 300 },
  });
  assert.equal(r.outcome, "refused");
  assert.equal((r as any).reason, "still-alive");
  assert.equal(child.kill(0), true, "ignorer survives");
  assert.equal(readOwnerFile(cwd)?.pid, child.pid, "no claim while the owner lives");
});

test("recycled pid is unlinked without signaling the innocent occupant", async () => {
  const cwd = tmpCwd();
  const child = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  // Claim predates the occupant's life: the pid number was recycled.
  writeOwner(cwd, { pid: child.pid, at: Date.now() - 3600_000 });
  const r = await takeoverOwnerRoot({ cwd, record: readOwnerFile(cwd), confirmed: true });
  assert.equal(r.outcome, "reclaimed");
  assert.equal((r as any).via, "recycled");
  assert.equal(child.kill(0), true, "occupant never signaled");
  assert.equal(readOwnerFile(cwd)?.pid, process.pid);
});

// ── heartbeat + commands ──────────────────────────────────────────────

test("heartbeat refresh is throttled and owner-scoped", async () => {
  const cwd = tmpCwd();
  __testOnlyResetOwnerHeartbeat();
  assert.equal(claimProcessOwner(cwd), true);
  // Drive the throttle with controlled timestamps — asserting against the
  // file's own `at` raced the millisecond clock under suite load.
  const t0 = Date.now();
  refreshOwnerHeartbeat(cwd, t0);
  const first = (readOwnerFile(cwd) as any).at as number;
  refreshOwnerHeartbeat(cwd, t0 + 1000);
  assert.equal((readOwnerFile(cwd) as any).at, first, "second refresh inside 60s is a no-op");
  refreshOwnerHeartbeat(cwd, t0 + 61_000);
  assert.ok((readOwnerFile(cwd) as any).at >= first, "refresh after 60s writes");
  // A foreign live owner must never be overwritten by our heartbeat.
  const child = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: child.pid, at: first });
  __testOnlyResetOwnerHeartbeat();
  refreshOwnerHeartbeat(cwd, first + 61_000);
  assert.equal(readOwnerFile(cwd)?.pid, child.pid, "heartbeat never steals a foreign root");
});

test("/glla owner reports unclaimed / self / live holder", async () => {
  const notes: string[] = [];
  const cwd = tmpCwd();
  cmdGllaOwner(fakeCtx(cwd, true, notes));
  assert.match(notes.join("\n"), /unclaimed/);
  notes.length = 0;
  writeOwner(cwd, { pid: process.pid, at: Date.now() });
  cmdGllaOwner(fakeCtx(cwd, true, notes));
  assert.match(notes.join("\n"), /YOU/);
  notes.length = 0;
  const holder = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: holder.pid, at: new Date().toISOString(), ownerSessionId: "s-1" });
  cmdGllaOwner(fakeCtx(cwd, true, notes));
  const text = notes.join("\n");
  assert.match(text, /LIVE foreign owner/);
  assert.match(text, /\/glla takeover/);
  assert.match(text, /sleep/);
  notes.length = 0;
  holder.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  cmdGllaOwner(fakeCtx(cwd, true, notes));
  assert.match(notes.join("\n"), /owner process is DEAD/);
});

test("/glla takeover end to end reclaims a dead root via command", async () => {
  const cwd = tmpCwd();
  const notes: string[] = [];
  writeOwner(cwd, { pid: 2 ** 30 + 11, at: Date.now() - 1000 });
  await cmdGllaTakeover(fakeCtx(cwd, true, notes));
  assert.match(notes.join("\n"), /reclaimed/);
  assert.equal(readOwnerFile(cwd)?.pid, process.pid);
});

test("/glla takeover aborts on dismissed confirm without signaling", async () => {
  const cwd = tmpCwd();
  const notes: string[] = [];
  const child = spawnSleep();
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: child.pid, at: Date.now() });
  await cmdGllaTakeover(fakeCtx(cwd, false, notes));
  assert.match(notes.join("\n"), /aborted/);
  assert.equal(child.kill(0), true);
  assert.equal(readOwnerFile(cwd)?.pid, child.pid);
});

test("source pins the new escape hatches on both read-only warnings", () => {
  const activation = fs.readFileSync("extensions/loops/goal-activation.ts", "utf8");
  const session = fs.readFileSync("extensions/loops/goal-session.ts", "utf8");
  assert.match(activation, /\/glla owner inspects the holder; \/glla takeover resolves it/);
  // v0.38.12 (last-wins): the command-entry warning names the newer
  // session and the automatic path back (fresh session takes over).
  assert.match(session, /a newer pi session owns this working-directory state root/);
  assert.match(session, /Start a fresh session to take it back/);
});

test("audit-2026-09-06: takeover re-verifies the occupant at signal time", async () => {
  const cwd = tmpCwd();
  const child = spawnSleep("99994");
  await new Promise((r) => setTimeout(r, 100));
  writeOwner(cwd, { pid: child.pid, at: Date.now() });
  let signaled = 0;
  let reads = 0;
  const r = await takeoverOwnerRoot({
    cwd,
    record: readOwnerFile(cwd),
    confirmed: true,
    deps: {
      // describeOwner + the gate see pi; the pre-signal re-read sees the
      // occupant turned over into sleep — the signal must not fire.
      readCmdline: () => (++reads <= 2 ? "pi\0--agent\0" : "/usr/bin/sleep\x0099994\x00"),
      signal: () => { signaled++; },
      sleepMs: () => Promise.resolve(),
      settleMs: 300,
    },
  });
  assert.equal(r.outcome, "refused");
  assert.equal((r as any).reason, "claim-lost");
  assert.equal(signaled, 0, "the turned-over occupant is never signaled");
  assert.equal(child.kill(0), true, "occupant survives");
  assert.match(readLedger(cwd), /"owner_takeover_refused"/);
});
