import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, group: Number(fields[2]), session: Number(fields[3]), birth: fields[19], zombie: fields[0] === "Z" };
  } catch { return null; }
}

function allMembers() {
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))
    .map(name => identity(Number(name)))
    .filter(p => p && !p.zombie && p.group === p.session);
}

const members = group => allMembers().filter(p => p.group === group);

function descendants(pid, seen = new Set()) {
  if (seen.has(pid)) return [];
  seen.add(pid);
  let children = [];
  try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch {}
  return [identity(pid), ...children.flatMap(child => descendants(child, seen))].filter(Boolean);
}

// Independent expectations survive a failed write to the process registry.
// Local errors additionally survive failure of both filesystem channels.
const registrationFailures = new Map();
const failureKey = env => `${env.GLLA_TEST_PROCESS_REGISTRY}:${env.GLLA_TEST_PROCESS_TOKEN}`;
const configured = env => process.platform === "linux" && !!(env.GLLA_TEST_PROCESS_REGISTRY || env.GLLA_TEST_PROCESS_TOKEN);
const obligationsDir = dir => `${dir}.obligations`;

function registry(env) {
  if (!configured(env)) return null;
  const dir = env.GLLA_TEST_PROCESS_REGISTRY;
  const token = env.GLLA_TEST_PROCESS_TOKEN;
  if (!dir || !token) throw new Error("incomplete test process registry configuration");
  const owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  if (owner.token !== token) throw new Error("test process registry token mismatch");
  return { dir, token };
}

function publish(file, record) {
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

/** Test-only containment metadata. A configured registry must acknowledge
 * every live detached launch. Failure kills the known child and propagates;
 * an independent expectation lets the runner detect missing records. */
export function registerOwnedTestProcess(child, env = process.env) {
  if (env.GLLA_TEST_ROOT_PROCESS_REGISTRY && env.GLLA_TEST_ROOT_PROCESS_REGISTRY !== env.GLLA_TEST_PROCESS_REGISTRY) {
    registerOwnedTestProcess(child, {
      GLLA_TEST_PROCESS_REGISTRY: env.GLLA_TEST_ROOT_PROCESS_REGISTRY,
      GLLA_TEST_PROCESS_TOKEN: env.GLLA_TEST_ROOT_PROCESS_TOKEN,
    });
  }
  if (!configured(env) || !child?.pid || typeof child.once !== "function") return;
  let leader, file, expectation, timer;
  let anchors = [];
  let failed = false;
  const fail = error => {
    if (failed) return;
    failed = true;
    clearInterval(timer);
    registrationFailures.set(failureKey(env), (registrationFailures.get(failureKey(env)) ?? 0) + 1);
    if (expectation) {
      try { publish(expectation, { token: env.GLLA_TEST_PROCESS_TOKEN, leader, anchors, failed: true }); } catch {}
    }
    // Signal only the child we launched or a group with captured birth
    // identity. Never discover ownership through a name or reused PID.
    const current = identity(child.pid);
    if (leader && current?.birth === leader.birth) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    } else if (leader) {
      if (members(child.pid).some(p => anchors.some(a => a.pid === p.pid && a.birth === p.birth))) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    } else { try { child.kill("SIGKILL"); } catch {} }
    throw new Error(`test process registration failed: ${error instanceof Error ? error.message : error}`);
  };
  const snapshot = (exited = false) => {
    if (failed) return;
    try {
      const owner = registry(env);
      const current = identity(child.pid);
      if (!leader && current?.group === child.pid && current.session === child.pid) leader = current;
      // A launch error or already-exited child has no live cleanup duty.
      if (!leader) {
        // Non-detached children are already covered by the suite group.
        return;
      }
      if (current && current.birth !== leader.birth) throw new Error("child PID identity changed");
      const live = (exited ? members(child.pid) : descendants(child.pid))
        .filter(p => !p.zombie && p.group === child.pid && p.session === child.pid);
      if (exited && !current && !live.some(p => anchors.some(a => a.pid === p.pid && a.birth === p.birth))) return;
      for (const member of live) if (!anchors.some(p => p.pid === member.pid && p.birth === member.birth)) anchors.push(member);
      const record = { token: owner.token, leader, anchors };
      if (!file) {
        file = path.join(owner.dir, `process-${child.pid}-${randomUUID()}.json`);
        expectation = path.join(obligationsDir(owner.dir), path.basename(file));
        // Publish the obligation before the fallible primary record write.
        publish(expectation, record);
      }
      publish(file, record);
    } catch (error) { fail(error); }
  };
  snapshot(); // synchronous launch refusal; caller cannot trust the launch
  const refresh = exited => {
    try { snapshot(exited); } catch (error) {
      process.stderr.write(`${error.message}\n`);
      // Propagate through the launcher's existing child-error path so the
      // runner still awaits containment cleanup. With no listener Node
      // fails the worker; the independent failed obligation survives it.
      child.emit("error", error);
    }
  };
  child.once("spawn", () => refresh(false));
  timer = setInterval(() => refresh(false), 500);
  timer.unref();
  child.once("exit", () => { clearInterval(timer); refresh(true); });
  child.once("error", () => clearInterval(timer));
}

export function createTestProcessRegistry(dir) {
  const token = randomUUID();
  const owner = JSON.stringify({ token, pid: process.pid });
  fs.mkdirSync(obligationsDir(dir), { mode: 0o700 });
  fs.writeFileSync(path.join(obligationsDir(dir), "owner.json"), owner, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "owner.json"), owner, { mode: 0o600 });
  return { GLLA_TEST_PROCESS_REGISTRY: dir, GLLA_TEST_PROCESS_TOKEN: token };
}

/** Signal only a session group with at least one captured, still-matching
 * member. A reused leader PID or unverified surviving group fails closed.
 * Snapshot before TERM retains descendant identities for KILL escalation. */
export async function reapOwnedTestProcesses(env, { graceMs = 1000 } = {}) {
  if (!configured(env)) return { reaped: 0, unverified: 0 };
  let unverified = registrationFailures.get(failureKey(env)) ?? 0;
  const owner = { dir: env.GLLA_TEST_PROCESS_REGISTRY, token: env.GLLA_TEST_PROCESS_TOKEN };
  if (!owner.dir || !owner.token) return { reaped: 0, unverified: unverified + 1 };
  try { registry(env); } catch { unverified++; }
  const groups = new Map();
  const liveGroups = new Map();
  for (const p of allMembers()) {
    if (!liveGroups.has(p.group)) liveGroups.set(p.group, []);
    liveGroups.get(p.group).push(p);
  }
  const records = new Map();
  const expectations = new Map();
  const readRecords = (dir, target) => {
    try {
      for (const name of fs.readdirSync(dir).filter(name => name.startsWith("process-") && name.endsWith(".json"))) {
        try { target.set(name, JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); }
        catch { unverified++; }
      }
    } catch { unverified++; }
  };
  readRecords(owner.dir, records);
  try {
    const independentOwner = JSON.parse(fs.readFileSync(path.join(obligationsDir(owner.dir), "owner.json"), "utf8"));
    if (independentOwner.token !== owner.token) throw new Error("obligation owner mismatch");
    readRecords(obligationsDir(owner.dir), expectations);
  } catch { unverified++; }
  for (const [name, expected] of expectations) {
    if (expected.failed || !records.has(name)) unverified++;
    // A failed primary write still leaves a birth-fenced cleanup anchor.
    if (!records.has(name)) records.set(name, expected);
  }
  for (const record of records.values()) {
    if (record.token !== owner.token || !Array.isArray(record.anchors)
      || !Number.isInteger(record.leader?.pid) || record.leader.pid <= 1) { unverified++; continue; }
    const group = record.leader.pid;
    const occupant = identity(group);
    const live = liveGroups.get(group) ?? [];
    if (live.length === 0) continue;
    if ((occupant && occupant.birth !== record.leader.birth)
      || !live.some(p => record.anchors.some(a => a.pid === p.pid && a.birth === p.birth))) { unverified++; continue; }
    groups.set(group, live);
  }
  const signal = (group, anchors, sig) => {
    const live = members(group);
    if (!live.some(p => anchors.some(a => a.pid === p.pid && a.birth === p.birth))) return;
    try { process.kill(-group, sig); } catch {}
  };
  for (const [group, anchors] of groups) signal(group, anchors, "SIGTERM");
  if (groups.size) await new Promise(resolve => setTimeout(resolve, graceMs));
  for (const [group, anchors] of groups) signal(group, anchors, "SIGKILL");
  if (groups.size) await new Promise(resolve => setTimeout(resolve, 100));
  for (const group of groups.keys()) if (members(group).length) unverified++;
  return { reaped: groups.size, unverified };
}
