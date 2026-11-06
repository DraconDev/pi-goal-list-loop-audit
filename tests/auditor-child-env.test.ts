// pi-goal-list-loop-audit — auditor child env + binary fence tests.
//
// Finding: the worker inherited full process.env into the auditor child and
// env could redirect the auditor binary, leaking host secrets if the parent
// fence ever regressed. The parent now hashes the exact fenced key list into
// the request (auditorEnvAllowlist); the worker forwards only those keys and
// validates the binary fail-closed. Pure units plus live worker runs (the
// worker itself cannot be imported — main() runs at load).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scaledBudgetMs } from "../scripts/host-contention.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fence = await import(pathToFileURL(path.join(__dirname, "../scripts/auditor-child-env.mjs")).href);
const { buildAuditorChildEnv, resolveAuditorBinary } = fence;
const proc = await import("../extensions/goal-loop-auditor-process.ts");
const { auditorEnvAllowlistFor, detachedAuditorEnv, requestHash } = proc;

test("v0.39.38: allowlist helper keeps sorted string-valued keys only", () => {
  assert.deepEqual(
    auditorEnvAllowlistFor({ PATH: "/bin", HOME: "/h", EMPTY: undefined, NUM: 42 } as unknown as NodeJS.ProcessEnv),
    ["HOME", "PATH"],
  );
  const fenced = detachedAuditorEnv(
    { PATH: "/bin", HOST_SECRET: "s3cr3t", ANTHROPIC_API_KEY: "k" },
    {},
    "anthropic/claude",
  );
  const list = auditorEnvAllowlistFor(fenced);
  assert.ok(list.includes("PATH"), "necessities listed");
  assert.ok(list.includes("ANTHROPIC_API_KEY"), "selected provider credential listed");
  assert.ok(!list.includes("HOST_SECRET"), "unrelated host secret never listed");
});

test("v0.39.38: child env forwards only listed keys, binary defaults to pi", () => {
  assert.deepEqual(buildAuditorChildEnv({ PATH: "/b", S: "s" }, ["PATH"]), { PATH: "/b" });
  assert.throws(() => buildAuditorChildEnv({ PATH: "/b" }, undefined), /auditorEnvAllowlist/);
  assert.throws(() => buildAuditorChildEnv({}, ["--evil"]), /invalid env name/);
  assert.equal(resolveAuditorBinary(undefined), "pi");
  assert.equal(resolveAuditorBinary("pi"), "pi");
  assert.throws(() => resolveAuditorBinary("pi-dev"), /absolute path/);
  assert.throws(() => resolveAuditorBinary("rel/evil"), /absolute path/);
  assert.throws(() => resolveAuditorBinary("/nonexistent/binary", () => false), /existing file/);
});

async function setupDir(): Promise<string> {
  const dir = await import("node:os").then((os) => `${os.tmpdir()}/glla-childenv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJob(dir: string, attemptId: string, extra: Record<string, unknown>): Promise<string> {
  const jobDir = path.join(dir, ".pi-glla", "audit-jobs", attemptId);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "lock"), "lock\n");
  const raw = {
    protocolVersion: 1, attemptId, cwd: dir, prompt: "Inspect artifact.", model: "test/provider-model",
    thinkingLevel: "medium", createdAt: new Date().toISOString(),
    auditorEnvAllowlist: ["PATH"],
    ...extra,
  };
  // Hash exactly what lands on disk (JSON drops undefined, so an explicit
  // `auditorEnvAllowlist: undefined` override tests a truly absent field
  // with a VALID hash — the worker must then fail on the shape gate itself).
  const withoutHash = JSON.parse(JSON.stringify(raw));
  await writeFile(path.join(jobDir, "request.json"), JSON.stringify({ ...withoutHash, requestHash: requestHash(withoutHash) }));
  return jobDir;
}

async function runWorker(dir: string, jobDir: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const worker = path.resolve(process.cwd(), "scripts/goal-auditor-worker.mjs");
  const child = spawn(process.execPath, [worker, "--job-dir", jobDir], { env, stdio: "ignore", detached: true });
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
  });
  return child;
}

async function stopTestProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-(child.pid as number), "SIGKILL"); } catch {}
  try { child.kill("SIGKILL"); } catch {}
}

test("v0.39.38: live worker keeps an unlisted host secret out of the pi child", { timeout: scaledBudgetMs(60_000) }, async () => {
  const dir = await setupDir();
  try {
    // Fake pi mirrors the repo handshake (answer once the prompt line
    // arrives) and dumps the env it actually received, then approves.
    const envDump = path.join(dir, "child-env.json");
    const fakePi = path.join(dir, "fake-pi.mjs");
    const fakePiSource = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({ keys: Object.keys(process.env).sort(), secret: process.env.HOST_ONLY_SECRET ?? null }));
let handled = false;
process.stdin.on("data", (chunk) => {
  if (handled || !String(chunk).includes("\\n")) return;
  handled = true;
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<approved/>\\n" } });
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
});
process.stdin.on("end", () => { process.exitCode = 0; });
`;
    await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiSource}`);
    await chmod(fakePi, 0o700);
    const jobDir = await writeJob(dir, "worker-env-fence", { auditorEnvAllowlist: ["PATH", "GLLA_PI_BINARY"] });
    const child = await runWorker(dir, jobDir, {
      ...process.env, GLLA_PI_BINARY: fakePi, HOST_ONLY_SECRET: "s3cr3t-regression-probe",
    } as NodeJS.ProcessEnv);
    try {
      const result = JSON.parse(await readFile(path.join(jobDir, "result.json"), "utf8"));
      assert.equal(result.ok, true, "audit still completes with a narrowed env");
      const dumped = JSON.parse(await readFile(envDump, "utf8"));
      assert.equal(dumped.secret ?? null, null, "unlisted host secret never reaches the pi child");
      assert.ok(!dumped.keys.includes("HOST_ONLY_SECRET"), "secret key absent from child env");
      assert.ok(dumped.keys.includes("PATH"), "allowlisted PATH still forwarded");
    } finally {
      await stopTestProcess(child);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.39.38: live worker rejects a redirected binary and a missing allowlist", { timeout: scaledBudgetMs(90_000) }, async () => {
  const dir = await setupDir();
  try {
    const fakePi = path.join(dir, "fake-pi.mjs");
    await writeFile(fakePi, "#!/usr/bin/env node\nprocess.exit(0);\n");
    await chmod(fakePi, 0o700);
    const cases: Array<[string, Record<string, unknown>, Record<string, string>]> = [
      ["worker-binary-redirect", { auditorEnvAllowlist: ["PATH"] }, { GLLA_PI_BINARY: "relative/evil-pi" }],
      ["worker-binary-missing", { auditorEnvAllowlist: ["PATH"] }, { GLLA_PI_BINARY: "/nonexistent/pi-binary" }],
      ["worker-envlist-missing", { auditorEnvAllowlist: undefined }, { GLLA_PI_BINARY: fakePi }],
    ];
    for (const [name, extra, workerEnv] of cases) {
      const jobDir = await writeJob(dir, name, extra);
      const child = await runWorker(dir, jobDir, { ...process.env, ...workerEnv } as NodeJS.ProcessEnv);
      try {
        // Identity failures are result-less: exit 1, stderr diagnostic, no verdict.
        assert.equal(child.exitCode, 1, `${name}: worker exits 1`);
        await assert.rejects(readFile(path.join(jobDir, "result.json")), `${name}: no result fabricated`);
      } finally {
        await stopTestProcess(child);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit 2026-11-06: custom provider credential admitted, empty provider admits none, cross-provider denied", () => {
  const src = { PATH: "/bin", MYPROVIDER_API_KEY: "custom-k", OTHER_API_KEY: "other-k", SOME_API_KEY: "any-k" };
  const custom = detachedAuditorEnv(src, {}, "myprovider/model");
  assert.equal(custom["MYPROVIDER_API_KEY"], "custom-k", "custom provider prefix admitted (case fix)");
  assert.equal(custom["OTHER_API_KEY"], undefined, "unrelated provider key never admitted");
  const empty = detachedAuditorEnv(src, {}, undefined);
  assert.equal(empty["SOME_API_KEY"], undefined, "empty provider admits no credential-shaped var");
  assert.equal(empty["MYPROVIDER_API_KEY"], undefined, "empty provider admits no custom key");
  assert.equal(empty["PATH"], "/bin", "passthrough unaffected");
  const cross = detachedAuditorEnv(src, {}, "other/model");
  assert.equal(cross["OTHER_API_KEY"], "other-k", "other provider admits its own key");
  assert.equal(cross["MYPROVIDER_API_KEY"], undefined, "other provider does not admit myprovider key");
});
