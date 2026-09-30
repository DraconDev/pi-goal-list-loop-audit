import { spawn } from "node:child_process";

const running = child => child.exitCode === null && child.signalCode === null;

/** Awaiting shutdown owns a referenced deadline, including when inherited
 * pipes stay open after the direct child has exited. */
function waitForExit(child, timeoutMs) {
  if (!running(child)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      for (const event of ["exit", "close", "error"]) child.removeListener(event, done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    for (const event of ["exit", "close", "error"]) child.once(event, done);
  });
}

/** The default POSIX strategy requires the caller to have spawned a
 * detached child. A caller owning a different tree supplies its fenced
 * signalling strategy; the TERM/KILL and pipe lifecycle stay shared. */
export async function terminateContainedChild(child, { graceMs = 1000, forceMs = 250, signalTree } = {}) {
  if (process.platform === "win32") {
    if (running(child) && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {});
      await waitForExit(killer, graceMs);
      if (running(killer)) killer.kill();
    }
    if (running(child)) { try { child.kill(); } catch {} }
    await waitForExit(child, forceMs);
  } else {
    const signal = signalTree ?? (sig => {
      if (child.pid) { try { process.kill(-child.pid, sig); } catch {} }
      if (running(child)) { try { child.kill(sig); } catch {} }
    });
    signal("SIGTERM");
    await waitForExit(child, graceMs);
    // Always escalate the owned group, even after the direct leader exits.
    signal("SIGKILL");
    await waitForExit(child, forceMs);
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch {}
  }
}
