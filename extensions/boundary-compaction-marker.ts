import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Read one bounded regular file without following links. An unreadable or
 * malformed attempt remains a guard, not permission for blind retry. */
export function readBoundaryCompactionEvidence(file: string, now: number, lastCompactionAt?: number): {
  exists: boolean; unknown: boolean; completedAt?: number;
} {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return { exists: true, unknown: true };
    const bytes = Buffer.alloc(4097);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 4096) return { exists: true, unknown: true };
    let marker: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) marker = parsed as Record<string, unknown>;
    } catch { /* A later durable success can reconcile a truncated attempt. */ }
    const parsedAt = typeof marker?.at === 'string' ? Date.parse(marker.at) : NaN;
    const known = Number.isFinite(parsedAt);
    // For malformed metadata only the file's own write time and durable
    // session_compact success are evidence. Never trust partial completedAt.
    const firedAt = known ? parsedAt : stat.mtimeMs;
    const recorded = known && typeof marker?.completedAt === 'number' ? marker.completedAt : lastCompactionAt;
    const completedAt = Number.isFinite(firedAt) && typeof recorded === 'number' && Number.isFinite(recorded)
      && recorded >= firedAt && recorded <= now ? recorded : undefined;
    return { exists: true, unknown: !known, ...(completedAt !== undefined ? { completedAt } : {}) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { exists: false, unknown: false } : { exists: true, unknown: true };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Same-directory replacement prevents a crash from truncating the live
 * one-shot guard. Persistence failure is surfaced to the admission caller. */
export function writeBoundaryCompactionMarker(file: string, marker: { at: string; tokens: number; completedAt?: number }): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(marker) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* Preserve original error. */ }
  }
}
