import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectProgress } from './progress-report.mjs';

const bounded = (n, fallback, hard) => Number.isSafeInteger(n) && n > 0 ? Math.min(n, hard) : fallback;

/** Explicit root only: never create directories, resolve ownership or claim a session. */
export function readProgressReport(stateDir, options = {}) {
  const maxBytes = bounded(options.maxBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  const maxFiles = bounded(options.maxFiles, 32, 64);
  const maxRecords = bounded(options.maxRecords, 5000, 50000);
  const maxLineBytes = bounded(options.maxLineBytes, 1024 * 1024, 4 * 1024 * 1024);
  const source = { bytesRead: 0, filesRead: 0, truncated: false, malformedLines: 0, oversizedLines: 0, errors: [] };
  const root = path.resolve(stateDir);
  const segments = [];
  // Directory enumeration is bounded too. A crowded directory yields an
  // explicitly partial observation rather than an unbounded sorting pass.
  let directory;
  try {
    directory = fs.opendirSync(path.join(root, 'ledger-segments'));
    let entry, entries = 0;
    while ((entry = directory.readSync())) {
      if (++entries > 256) { source.truncated = true; break; }
      if (entry.isFile() && /^\d[^/]*\.jsonl$/.test(entry.name)) segments.push(path.join(root, 'ledger-segments', entry.name));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') source.errors.push({ location: 'segments', code: error.code ?? 'unknown' });
  } finally { directory?.closeSync(); }
  const files = [...segments.sort(), path.join(root, 'active.jsonl')];
  if (files.length > maxFiles) source.truncated = true;
  const records = [];
  for (const file of files.slice(-maxFiles).reverse()) {
    if (source.bytesRead >= maxBytes || records.length >= maxRecords) { source.truncated = true; break; }
    let fd;
    try {
      // Do not follow ledger symlinks, special files or replaced descriptors.
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) { source.errors.push({ location: path.basename(file), code: 'not-regular-file' }); continue; }
      const bytes = Math.min(stat.size, maxBytes - source.bytesRead);
      const start = stat.size - bytes;
      if (start > 0) source.truncated = true;
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, start);
      source.bytesRead += read;
      source.filesRead++;
      let data = buffer.subarray(0, read);
      // Discard a possibly partial first record at the byte boundary.
      if (start > 0) { const newline = data.indexOf(10); data = newline < 0 ? Buffer.alloc(0) : data.subarray(newline + 1); }
      const lines = data.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (records.length >= maxRecords) { source.truncated = true; break; }
        if (Buffer.byteLength(line) > maxLineBytes) { source.oversizedLines++; source.truncated = true; continue; }
        try { records.push(JSON.parse(line)); } catch { source.malformedLines++; }
      }
    } catch (error) { source.errors.push({ location: path.basename(file), code: error.code ?? 'unknown' }); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const report = projectProgress(records.reverse(), { maxRecords });
  report.source = source;
  report.window.truncated ||= source.truncated;
  if (source.malformedLines || source.oversizedLines || source.errors.length) report.limitations.push('Unreadable, oversized or malformed source records make this observation incomplete.');
  return report;
}
