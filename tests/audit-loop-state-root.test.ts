// The generated audit-loop target and metric must resolve the SAME selected
// state-root findings file. In sessionDir mode, cwd/.pi-glla is stale and must
// not silently measure as zero.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  auditFindingsPath,
  auditMeasureCmd,
  auditTarget,
} from "../extensions/goal-loop-forever.js";
import { setRuntimeSessionDir } from "../extensions/goal-loop-core.js";

const priorGlobal = process.env.GLLA_GLOBAL_SETTINGS_PATH;
const priorSession = process.env.PI_SESSION_FILE;
let temp: string | undefined;

function fixture() {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "glla-audit-loop-root-"));
  const cwd = path.join(temp, "cwd");
  const sessionDir = path.join(temp, "session");
  const settings = path.join(temp, "settings.json");
  fs.mkdirSync(cwd);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(settings, JSON.stringify({ stateRoot: "sessionDir" }));
  process.env.GLLA_GLOBAL_SETTINGS_PATH = settings;
  delete process.env.PI_SESSION_FILE;
  setRuntimeSessionDir(sessionDir);
  const selected = path.join(sessionDir, "pi-glla", "audit-loop", "findings.md");
  fs.mkdirSync(path.dirname(selected), { recursive: true });
  fs.writeFileSync(selected, "- [x] FIX: one durable closed finding\n- [ ] FIX: one open finding\n");
  fs.mkdirSync(path.join(cwd, ".pi-glla", "audit-loop"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "audit-loop", "findings.md"), "- [x] FIX: stale cwd finding\n");
  return { cwd, selected };
}

afterEach(() => {
  setRuntimeSessionDir(undefined);
  if (priorGlobal === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
  else process.env.GLLA_GLOBAL_SETTINGS_PATH = priorGlobal;
  if (priorSession === undefined) delete process.env.PI_SESSION_FILE;
  else process.env.PI_SESSION_FILE = priorSession;
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

test("sessionDir audit target, measure, and findings helper name the selected file", () => {
  const { cwd, selected } = fixture();
  assert.equal(auditFindingsPath(cwd), selected);
  assert.ok(auditTarget(cwd).includes(selected), "target points at selected findings");
  const command = auditMeasureCmd(cwd);
  assert.ok(command.includes(selected), "measure points at selected findings");
  const output = execFileSync("bash", ["-c", command], { cwd, encoding: "utf8" }).trim();
  assert.equal(output, "1", "cwd fallback with two FIX boxes is not measured");
});
