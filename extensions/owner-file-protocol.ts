import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

interface Participant {
  pid: number;
  birth: string | null;
  choosing: boolean;
  ticket: number;
}

function birth(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

function active(p: Participant): boolean {
  try { process.kill(p.pid, 0); }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
  // A reused PID cannot keep a dead contender's ticket alive on Linux.
  // Elsewhere, an ambiguous live PID conservatively blocks the mutation.
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${p.pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z") return false;
    } catch { /* inaccessible process identity remains ambiguous/live */ }
  }
  const current = birth(p.pid);
  return p.birth === null || current === null || current === p.birth;
}

/** Publish a complete record. All owner.json replacements run under the
 * mutation protocol; readers never see a newly-created empty placeholder. */
export function publishOwnerRecord(file: string, record: unknown): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record), { flag: "wx" });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

/** Lamport's bakery protocol over atomic records on a local filesystem.
 * Each contender owns a unique filename. Dead contenders are ignored, never
 * reclaimed by unlinking a shared lock name: that stale-lock deletion race
 * can otherwise delete a successor's lock. Timeout fails closed; it never
 * expires another live contender's ticket. Actions must be synchronous.
 * A shared/network filesystem without coherent rename/readdir is unsupported.
 */
export function withOwnerMutation<T>(file: string, action: () => T, timeoutMs = 2000): T | undefined {
  const dir = `${file}.mutations`;
  fs.mkdirSync(dir, { recursive: true });
  const id = `${process.pid}-${randomUUID()}.json`;
  const own = path.join(dir, id);
  const me: Participant = { pid: process.pid, birth: birth(process.pid), choosing: true, ticket: 0 };
  const deadline = Date.now() + timeoutMs;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const participants = (): Array<[string, Participant]> => fs.readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .flatMap(name => {
      let p: Participant;
      try { p = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error("ambiguous owner mutation participant");
      }
      if (!Number.isInteger(p.pid) || p.pid <= 0 || typeof p.choosing !== "boolean"
        || !Number.isSafeInteger(p.ticket) || p.ticket < 0
        || !(p.birth === null || typeof p.birth === "string")) throw new Error("invalid owner mutation participant");
      if (active(p)) return [[name, p] as [string, Participant]];
      // This unique participant name will never be reused by a successor.
      // Removing a proven-dead record cannot unlink a shared live lock.
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
      return [];
    });
  try {
    publishOwnerRecord(own, me);
    me.ticket = Math.max(0, ...participants().map(([, p]) => p.ticket)) + 1;
    if (!Number.isSafeInteger(me.ticket)) return undefined;
    me.choosing = false;
    publishOwnerRecord(own, me);
    for (;;) {
      const blocked = participants().some(([name, p]) => name !== id &&
        (p.choosing || p.ticket < me.ticket || (p.ticket === me.ticket && name < id)));
      if (!blocked) return action();
      if (Date.now() >= deadline) return undefined;
      Atomics.wait(waitBuffer, 0, 0, Math.min(10, deadline - Date.now()));
    }
  } finally {
    // Only our unique participant is removed. A crash leaves a provably
    // dead record that future contenders can ignore without an unlink race.
    try { fs.unlinkSync(own); } catch {}
  }
}
