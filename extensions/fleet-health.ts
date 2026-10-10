import * as fs from 'node:fs';
import * as path from 'node:path';
import type { State } from './goal-loop-core.js';
import { projectUiStatus, uiStatusOwnerKey, type UiStatus } from './ui-status.js';

export interface FleetBounds {
  maxDepth: number; maxDirectories: number; maxProjects: number; maxMs: number;
  maxJournalBytes: number; maxTotalBytes: number;
}
export const FLEET_DEFAULT_BOUNDS: Readonly<FleetBounds> = Object.freeze({
  maxDepth: 4, maxDirectories: 2000, maxProjects: 100, maxMs: 2000,
  maxJournalBytes: 512 * 1024, maxTotalBytes: 8 * 1024 * 1024,
});
export interface FleetIssue { path: string; kind: 'unreadable' | 'malformed' | 'partial' | 'skipped'; detail: string }
export interface FleetProject {
  path: string; journal: string; observedAt: number; savedAt?: string;
  status?: UiStatus; provenance: 'journal' | 'journal+closure'; partial: boolean;
}
export interface FleetReport {
  roots: string[]; bounds: FleetBounds; projects: FleetProject[]; issues: FleetIssue[];
  directories: number; bytesRead: number; complete: boolean; elapsedMs: number;
}
const excluded = new Set(['.git', '.pi', 'node_modules', '.pi-glla', 'vendor']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
class Deadline extends Error {}
/** Clamp settings to safety ceilings; zero is useful for proving read bounds. */
function boundsFor(input: Partial<FleetBounds>): FleetBounds {
  const result = { ...FLEET_DEFAULT_BOUNDS };
  for (const key of Object.keys(result) as (keyof FleetBounds)[]) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.min(result[key], Math.floor(value));
  }
  return result;
}
function validState(value: unknown): value is State {
  if (!object(value) || !Array.isArray(value.list)) return false;
  if (value.goal !== undefined && value.goal !== null) {
    if (!object(value.goal) || typeof value.goal.id !== 'string' || typeof value.goal.objective !== 'string'
      || !['active', 'paused', 'auditing', 'complete', 'aborted'].includes(String(value.goal.status))) return false;
    if (value.goal.pendingCompletion !== undefined && !object(value.goal.pendingCompletion)) return false;
  }
  if (value.loop !== undefined && value.loop !== null) {
    if (!object(value.loop) || typeof value.loop.active !== 'boolean' || typeof value.loop.startedAt !== 'string' || typeof value.loop.target !== 'string') return false;
    if (value.loop.builder !== undefined && (!object(value.loop.builder) || typeof value.loop.builder.phase !== 'string')) return false;
  }
  if (value.mainModelRecovery !== undefined && value.mainModelRecovery !== null) {
    if (!object(value.mainModelRecovery) || typeof value.mainModelRecovery.reason !== 'string') return false;
    if (value.mainModelRecovery.owner !== undefined && !object(value.mainModelRecovery.owner)) return false;
  }
  return true;
}

/** Read-only, explicit invocation only. No state loader, journal replay,
 * process probing, callbacks into dispatch, conversation reads or mutations. */
export async function inspectFleetHealth(roots: readonly string[], input: Partial<FleetBounds> = {}): Promise<FleetReport> {
  const start = Date.now(), bounds = boundsFor(input), deadline = start + bounds.maxMs;
  const report: FleetReport = { roots: [], bounds, projects: [], issues: [], directories: 0, bytesRead: 0, complete: true, elapsedMs: 0 };
  const issue = (file: string, kind: FleetIssue['kind'], detail: string): void => {
    report.complete = false;
    // Diagnostics are also bounded; the final entry records omitted issues.
    if (report.issues.length < 200) report.issues.push({ path: file, kind, detail });
    else report.issues[199] = { path: '', kind: 'partial', detail: 'Additional diagnostics omitted (200-entry limit)' };
  };
  async function bounded<T>(operation: Promise<T>, cleanup?: (value: T) => void): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { void operation.then(value => cleanup?.(value), () => {}); throw new Deadline(); }
    let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Deadline()); }, remaining); });
    void operation.then(value => { if (expired) cleanup?.(value); }, () => {});
    try { return await Promise.race([operation, timeout]); } finally { if (timer) clearTimeout(timer); }
  }
  async function readArtifact(file: string, limit: number, tail = false): Promise<{ text: string; partial: boolean } | undefined> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      if (report.bytesRead >= bounds.maxTotalBytes) { issue(file, 'partial', 'Total read-byte limit reached'); return; }
      handle = await bounded(fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK), h => { void h.close().catch(() => {}); });
      const stat = await bounded(handle.stat());
      if (!stat.isFile()) { issue(file, 'skipped', 'Artifact is not a regular file'); return; }
      const size = Math.min(stat.size, limit, bounds.maxTotalBytes - report.bytesRead);
      const buffer = Buffer.alloc(size);
      const position = tail ? Math.max(0, stat.size - size) : 0;
      const { bytesRead } = await bounded(handle.read(buffer, 0, size, position));
      report.bytesRead += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      const partial = position > 0 || bytesRead < stat.size;
      if (position > 0) text = text.slice(text.indexOf('\n') + 1); // discard an incomplete first record
      if (partial) issue(file, 'partial', 'Bounded artifact read; history omitted');
      return { text, partial };
    } catch (error) {
      if (error instanceof Deadline) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') issue(file, code === 'ELOOP' ? 'skipped' : 'unreadable', code ?? 'Read failed');
      return;
    } finally { if (handle) void handle.close().catch(() => {}); }
  }
  async function inspectProject(dir: string): Promise<void> {
    const runtime = path.join(dir, '.pi-glla');
    try {
      const stat = await bounded(fs.promises.lstat(runtime));
      if (stat.isSymbolicLink() || !stat.isDirectory()) { issue(runtime, 'skipped', 'Runtime directory is not a real directory'); return; }
    } catch (error) {
      if (error instanceof Deadline) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(runtime, 'unreadable', 'Runtime directory unavailable');
      return;
    }
    if (report.projects.length >= bounds.maxProjects) { issue(dir, 'partial', 'Project limit reached'); return; }
    const journal = path.join(runtime, 'active.jsonl');
    const project: FleetProject = { path: dir, journal, observedAt: Date.now(), provenance: 'journal', partial: false };
    report.projects.push(project);
    const read = await readArtifact(journal, bounds.maxJournalBytes, true);
    if (!read) { project.partial = true; issue(journal, 'partial', 'No readable active journal snapshot'); return; }
    project.partial = read.partial;
    let saved: State | undefined;
    for (const line of read.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (!object(record) || typeof record.type !== 'string') throw new Error();
        if (record.type !== 'state') continue;
        if (!validState(record.value) || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) {
          saved = undefined; project.savedAt = undefined; throw new Error();
        }
        saved = record.value; project.savedAt = record.at;
      } catch { saved = undefined; project.savedAt = undefined; project.partial = true; issue(journal, 'malformed', 'Malformed journal record or invalid state snapshot'); }
    }
    if (!saved) { project.partial = true; issue(journal, 'partial', 'No valid state snapshot in bounded read'); return; }
    const now = Date.now();
    const owner = await readArtifact(path.join(runtime, 'session-owner.json'), 4096);
    let closed = false;
    if (owner) {
      try {
        const record: unknown = JSON.parse(owner.text);
        if (!object(record)) throw new Error();
        if (record.shutdownAt !== undefined) {
          if (typeof record.shutdownAt !== 'string' || !Number.isFinite(Date.parse(record.shutdownAt))) throw new Error();
          closed = !owner.partial && Date.parse(record.shutdownAt) >= Date.parse(project.savedAt!) && Date.parse(record.shutdownAt) <= now;
        }
      } catch { project.partial = true; issue(path.join(runtime, 'session-owner.json'), 'malformed', 'Invalid owner artifact'); }
    }
    if (closed) project.provenance = 'journal+closure';
    // Only an explicit closure marker after the snapshot is an execution
    // fact. A PID, its absence or an old retry deadline proves no liveness.
    try {
      project.status = projectUiStatus(saved, closed ? { now, generation: 0,
        evidence: { ownerKey: uiStatusOwnerKey(saved) ?? '', generation: 0, observedAt: now, session: 'closed' } } : { now });
    } catch {
      project.partial = true;
      issue(journal, 'malformed', 'Snapshot contains invalid presentation fields');
    }
  }
  const queue: { dir: string; depth: number }[] = [];
  const seen = new Set<string>();
  try {
    if (roots.length > 16) issue('', 'partial', 'Root limit reached (16)');
    for (const root of roots.slice(0, 16)) {
      if (typeof root !== 'string' || !root.trim()) { issue('', 'skipped', 'Invalid root'); continue; }
      const dir = path.resolve(root);
      try {
        const stat = await bounded(fs.promises.lstat(dir));
        if (stat.isSymbolicLink() || !stat.isDirectory()) { issue(dir, 'skipped', 'Root is not a real directory'); continue; }
        if (!seen.has(dir)) { seen.add(dir); report.roots.push(dir); queue.push({ dir, depth: 0 }); }
      } catch (error) { if (error instanceof Deadline) throw error; issue(dir, 'unreadable', (error as NodeJS.ErrnoException).code ?? 'Root unavailable'); }
    }
    while (queue.length) {
      if (report.directories >= bounds.maxDirectories) { issue('', 'partial', 'Directory limit reached'); break; }
      if (report.projects.length >= bounds.maxProjects) { issue('', 'partial', 'Project limit reached'); break; }
      const current = queue.shift()!;
      report.directories++;
      await inspectProject(current.dir);
      let directory: fs.Dir | undefined;
      try {
        directory = await bounded(fs.promises.opendir(current.dir), d => { d.close(() => {}); });
        let entry: fs.Dirent | null;
        while ((entry = await bounded(directory.read()))) {
          if (excluded.has(entry.name)) continue;
          const child = path.join(current.dir, entry.name);
          if (entry.isSymbolicLink()) { issue(child, 'skipped', 'Symlink not followed'); continue; }
          if (!entry.isDirectory()) continue;
          if (current.depth >= bounds.maxDepth) { issue(child, 'skipped', 'Traversal depth limit reached'); continue; }
          if (seen.size >= bounds.maxDirectories) { issue(child, 'partial', 'Directory queue limit reached'); break; }
          if (!seen.has(child)) { seen.add(child); queue.push({ dir: child, depth: current.depth + 1 }); }
        }
      } catch (error) { if (error instanceof Deadline) throw error; issue(current.dir, 'unreadable', (error as NodeJS.ErrnoException).code ?? 'Directory unavailable'); }
      finally { if (directory) directory.close(() => {}); }
    }
  } catch (error) { if (error instanceof Deadline) issue('', 'partial', 'Time budget reached'); else throw error; }
  report.elapsedMs = Date.now() - start;
  return report;
}
const safe = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
export function formatFleetHealth(report: FleetReport): string[] {
  return [
    `glla fleet — ${report.complete ? 'bounded observation complete' : 'PARTIAL observation; not a fleet health verdict'}`,
    `Read-only · ${report.projects.length} projects · ${report.directories} directories · ${report.bytesRead} bytes · ${report.elapsedMs}ms`,
    `Bounds: depth ${report.bounds.maxDepth}, projects ${report.bounds.maxProjects}, directories ${report.bounds.maxDirectories}, ${report.bounds.maxMs}ms`,
    ...report.projects.flatMap(project => [
      `${safe(project.path)} — ${project.status ? `${project.status.mode} ${project.status.workflow} · ${project.status.execution}` : 'UNREADABLE/UNCONFIRMED'} · ${project.provenance}${project.partial ? ' (partial)' : ''}`,
      `  saved ${safe(project.savedAt ?? 'unknown')} · observed ${new Date(project.observedAt).toISOString()} · ${project.status ? safe(project.status.nextAction) : 'Inspect unreadable runtime artifacts in this project'}`,
    ]),
    ...report.issues.map(issue => `${issue.kind}: ${safe(issue.path)} — ${issue.detail}`),
    'Saved workflow is not a running session. Open the project and use /glla status to inspect or continue.',
  ];
}
