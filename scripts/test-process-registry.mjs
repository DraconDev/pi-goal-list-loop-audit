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

function members(group) {
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))
    .map(name => identity(Number(name)))
    .filter(p => p && !p.zombie && p.group === group && p.session === group);
}

function registry(env) {
  if (process.platform !== "linux") return null;
  const dir = env.GLLA_TEST_PROCESS_REGISTRY;
  const token = env.GLLA_TEST_PROCESS_TOKEN;
  if (!dir || !token) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
    return owner.token === token ? { dir, token } : null;
  } catch { return null; }
}

/** Test-only containment metadata. Production environments have no registry.
 * Keep records after leader exit so the runner can own surviving group
 * members. Birth ticks fence each PID; no basename/process-name sweeping. */
export function registerOwnedTestProcess(child, env = process.env) {
  const owner = registry(env);
  if (!owner || !child?.pid || typeof child.once !== "function") return;
  const file = path.join(owner.dir, `process-${child.pid}-${randomUUID()}.json`);
  let leader;
  let anchors = [];
  const snapshot = () => {
    const current = identity(child.pid);
    leader ??= current;
    if (!leader || leader.group !== child.pid || leader.session !== child.pid) return;
    const live = members(child.pid);
    for (const member of live) {
      if (!anchors.some(p => p.pid === member.pid && p.birth === member.birth)) anchors.push(member);
    }
    try {
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ token: owner.token, leader, anchors }), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch { /* runner diagnoses missing/unreadable records */ }
  };
  snapshot();
  child.once("spawn", snapshot);
  const timer = setInterval(snapshot, 100);
  timer.unref();
  child.once("exit", () => { snapshot(); clearInterval(timer); });
  child.once("error", () => clearInterval(timer));
}

export function createTestProcessRegistry(dir) {
  const token = randomUUID();
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ token, pid: process.pid }), { mode: 0o600 });
  return { GLLA_TEST_PROCESS_REGISTRY: dir, GLLA_TEST_PROCESS_TOKEN: token };
}

/** Signal only a session group with at least one captured, still-matching
 * member. A reused leader PID or unverified surviving group fails closed.
 * Snapshot before TERM retains descendant identities for KILL escalation. */
export async function reapOwnedTestProcesses(env, { graceMs = 1000 } = {}) {
  const owner = registry(env);
  if (!owner) return { reaped: 0, unverified: 0 };
  const groups = new Map();
  let unverified = 0;
  for (const name of fs.readdirSync(owner.dir).filter(name => name.startsWith("process-") && name.endsWith(".json"))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(owner.dir, name), "utf8"));
      if (record.token !== owner.token || !Array.isArray(record.anchors)
        || !Number.isInteger(record.leader?.pid) || record.leader.pid <= 1) { unverified++; continue; }
      const group = record.leader.pid;
      const occupant = identity(group);
      const live = members(group);
      if (live.length === 0) continue;
      if ((occupant && occupant.birth !== record.leader.birth)
        || !live.some(p => record.anchors.some(a => a.pid === p.pid && a.birth === p.birth))) { unverified++; continue; }
      groups.set(group, live);
    } catch { unverified++; }
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
