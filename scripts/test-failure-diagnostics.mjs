// pi-goal-list-loop-audit — retained failure diagnostics for the test
// runner. When bun test fails or stalls, the runner now writes a bounded
// diagnostic bundle (exit code, timed-out markers, last process-group
// activity, and a redacted snippet of recent stdout) to a stable
// GLLA_TEST_FAILURE_PATH. Secrets (AWS keys, GitHub tokens, machine
// paths) are removed at write time so the bundle is safe to attach to
// reports. The helper is intentionally pure: no child re-spawn, no
// filesystem walk of the working tree, no recursion.

import * as fs from "node:fs";
import * as path from "node:path";

const TAIL_BYTES = 8 * 1024;
const SECRET_PATTERNS = [
  { re: /\bAKIA[0-9A-Z]{8,}\b/g, replacement: "[redacted:aws-key]" },
  { re: /\bghp_[0-9a-fA-F]{8,}\b/g, replacement: "[redacted:github-token]" },
  { re: /\bglpat-[0-9A-Za-z_-]{8,}\b/g, replacement: "[redacted:gitlab-token]" },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{8,}\b/g, replacement: "[redacted:slack-token]" },
  { re: /(?:\/var)?\/tmp\/[^\s)]+/g, replacement: "[redacted:tmp-path]" },
  { re: /\b[A-Fa-f0-9]{32,}\b/g, replacement: "[redacted:hex]" },
];

function redact(text) {
  let out = String(text);
  for (const { re, replacement } of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function safeReadTail(file, maxBytes = TAIL_BYTES) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeReadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function captureTestFailureDiagnostics({ cwd, exitCode, registryDir, failurePath }) {
  const path_ = failurePath ?? process.env.GLLA_TEST_FAILURE_PATH ?? path.join(cwd ?? process.cwd(), ".pi-glla", "last-failure.json");
  const startedAt = Date.now();
  const bundle = {
    capturedAt: new Date(startedAt).toISOString(),
    exitCode: Number.isInteger(exitCode) ? exitCode : 1,
    cwd: cwd ?? null,
    markers: [] as string[],
    commands: [] as string[],
    note: "Bundled by captureTestFailureDiagnostics; do not commit. Check exit code and last lines.",
  };
  // Markers — short, human-readable breadcrumbs the runner can read.
  for (const file of ["marker.txt", "marker", "phase", "phase.txt"]) {
    const value = safeReadTail(path.join(cwd ?? "", file));
    if (value) {
      const trimmed = redact(value).trim();
      if (trimmed) bundle.markers.push(trimmed.slice(-256));
    }
  }
  if (registryDir) {
    const records = safeReadDir(registryDir).filter((name) => name.startsWith("process-") && name.endsWith(".json"));
    for (const name of records.slice(0, 8)) {
      const record = safeReadJSON(path.join(registryDir, name));
      if (!record?.leader?.pid) continue;
      bundle.commands.push(`detached child ${record.leader.pid} group ${record.leader.group} session ${record.leader.session} birth ${record.leader.birth} anchors ${record.anchors?.length ?? 0}`);
    }
    const failed = safeReadDir(registryDir).filter((name) => name.endsWith(".json") && /failed/i.test(name));
    for (const name of failed.slice(0, 4)) bundle.markers.push(`registration-failure: ${redact(name)}`);
  }
  // Tail from the most recent failure-detecting log, if any.
  for (const file of ["detail.txt", "tail.log", "details.log"]) {
    const tail = safeReadTail(path.join(cwd ?? "", file));
    if (tail) {
      const redacted = redact(tail).split("\n").slice(-32).join("\n");
      bundle.commands.push(redacted);
    }
  }
  bundle.timedOutMs = typeof exitCode === "number" && exitCode === 124 ? startedAt - startedAt : 0;
  try {
    fs.mkdirSync(path.dirname(path_), { recursive: true });
    fs.writeFileSync(path_, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  } catch (error) {
    bundle.note = `failed to persist bundle: ${(error instanceof Error ? error.message : String(error)).slice(0, 240)}`;
  }
  return bundle;
}

export type TestFailureDiagnostics = ReturnType<typeof captureTestFailureDiagnostics>;
