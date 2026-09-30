import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { terminateContainedChild } from "../scripts/contained-child.mjs";

function executing(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test(`real ${process.platform} cleanup stops a live owned Node tree and inherited pipes`, { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-platform-tree-"));
  const ready = path.join(dir, "ready");
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const source = `require('node:child_process').spawn('node',['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const child = spawn("node", ["-e", source], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let descendant: number | undefined;
  child.on("error", () => {});
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("owned descendant did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    descendant = Number(fs.readFileSync(ready, "utf8"));
    assert.ok(executing(child.pid!) && executing(descendant));
    await terminateContainedChild(child, { graceMs: 1000, forceMs: 1000 });
    const settled = Date.now() + 3000;
    while ((executing(child.pid!) || executing(descendant)) && Date.now() < settled) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(executing(child.pid!), false);
    assert.equal(executing(descendant), false);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    await terminateContainedChild(child, { graceMs: 100, forceMs: 100 });
    if (descendant && executing(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
