import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";

function identity(pid, strict = false) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const result = { pid, group: Number(fields[2]), session: Number(fields[3]), birth: fields[19], zombie: fields[0] === "Z" };
    if (!Number.isInteger(result.group) || result.group <= 0 || !Number.isInteger(result.session) || result.session <= 0 || !/^\d+$/.test(result.birth ?? "")) throw new Error("invalid process identity");
    return result;
  } catch (error) { if (strict) throw error; return null; }
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
  // Injected transport mocks are not launched OS children.
  if (!(child instanceof ChildProcess) || !child.spawnfile) return;
  if (env.GLLA_TEST_ROOT_PROCESS_REGISTRY && env.GLLA_TEST_ROOT_PROCESS_REGISTRY !== env.GLLA_TEST_PROCESS_REGISTRY) {
    registerOwnedTestProcess(child, {
      GLLA_TEST_PROCESS_REGISTRY: env.GLLA_TEST_ROOT_PROCESS_REGISTRY,
      GLLA_TEST_PROCESS_TOKEN: env.GLLA_TEST_ROOT_PROCESS_TOKEN,
    });
  }
  if (!configured(env) || !child?.pid || typeof child.once !== "function") return;
  const file = path.join(env.GLLA_TEST_PROCESS_REGISTRY, `process-${child.pid}-${randomUUID()}.json`);
  const expectation = path.join(obligationsDir(env.GLLA_TEST_PROCESS_REGISTRY), path.basename(file));
  let leader, timer;
  let declared = false;
  let retired = false;
  let anchors = [];
  let failed = false;
  const fail = error => {
    if (failed) return;
    failed = true;
    clearInterval(timer);
    registrationFailures.set(failureKey(env), (registrationFailures.get(failureKey(env)) ?? 0) + 1);
    const refusal = { token: env.GLLA_TEST_PROCESS_TOKEN, leader,
      anchors: anchors.length ? anchors : leader ? [leader] : [], failed: true };
    // Either channel can retain a refusal if the other cannot be written.
    // If both fail, stop the known child and propagate the launch error.
    for (const target of [expectation, file]) {
      if (target) { try { publish(target, refusal); } catch {} }
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
    if (failed || retired) return;
    try {
      // A declared launch exists before any fallible identity discovery.
      if (!declared) {
        publish(expectation, { token: env.GLLA_TEST_PROCESS_TOKEN, launchPid: child.pid, pending: true, anchors: [] });
        declared = true;
      }
      const provenExited = exited || child.exitCode !== null || child.signalCode !== null;
      let current;
      try { current = identity(child.pid, !provenExited); }
      catch (error) {
        // Proc disappearance can precede the host's exit event/status.
        // ENOENT alone is unknown; ESRCH independently proves absence.
        let absent = false;
        if (error.code === "ENOENT") {
          try { process.kill(child.pid, 0); }
          catch (probe) { absent = probe.code === "ESRCH"; }
        }
        if (!absent) throw error;
        current = null;
      }
      if (!leader && current?.group === child.pid && current.session === child.pid) leader = current;
      const owner = registry(env);
      // A launch error or already-exited child has no live cleanup duty.
      if (!leader) {
        // Only a proven non-detached or already-exited child can retire
        // the declaration without a separate group cleanup obligation.
        fs.unlinkSync(expectation);
        retired = true;
        return;
      }
      if (current && current.birth !== leader.birth) throw new Error("child PID identity changed");
      const live = (exited ? members(child.pid) : descendants(child.pid))
        .filter(p => !p.zombie && p.group === child.pid && p.session === child.pid);
      if (exited && !current && !live.some(p => anchors.some(a => a.pid === p.pid && a.birth === p.birth))) return;
      for (const member of live) if (!anchors.some(p => p.pid === member.pid && p.birth === member.birth)) anchors.push(member);
      const record = { token: owner.token, leader, anchors };
      publish(expectation, record);
      publish(file, record);
    } catch (error) { fail(error); }
  };
  snapshot(); // synchronous launch refusal; caller cannot trust the launch
  if (retired) return;
  const refresh = exited => {
    try { snapshot(exited); } catch (error) {
      process.stderr.write(`${error.message}\n`);
      // Propagate through the launcher's existing child-error path so the
      // runner still awaits containment cleanup. The failed obligation
      // survives even if the caller handles this child error.
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
    if (record.failed) unverified++;
    if (record.token !== owner.token || !Array.isArray(record.anchors)
      || !Number.isInteger(record.leader?.pid) || record.leader.pid <= 1) { unverified++; continue; }
    const group = record.leader.pid;
    const occupant = identity(group);
    const live = liveGroups.get(group) ?? [];
    if (live.length === 0) {
      if ([record.leader, ...record.anchors].some(a => {
        if (identity(a.pid)) return false;
        try { process.kill(a.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
      })) unverified++;
      continue;
    }
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
