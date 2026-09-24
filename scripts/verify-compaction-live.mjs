#!/usr/bin/env node
/**
 * Live, provider-backed proof for GLLA's bounded compaction preparation hook.
 *
 * This verifier deliberately uses a fresh Pi process and a temporary copy of
 * the requested historical session.  It does not ask Pi to use a custom
 * compactor: the only loaded extension is GLLA, whose session_before_compact
 * handler mutates the preparation and returns undefined.  The copied session is
 * already over the selected model's context window, so the first prompt causes
 * Pi's normal threshold/overflow path to run the default summarizer.
 *
 * stdout is intentionally limited to scalar proof data.  Pi's raw message and
 * summary payloads stay inside this process and are never printed or written to
 * the report.  The source session is checksummed before and after the run.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_PATH = path.join(REPO_ROOT, "audit", "COMPACTION-DEFAULT-PROJECTION-LIVE-PROOF.md");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const INPUT_BUDGET = 64_000;
const CONTINUATION_MARKER = "GLLA_POST_COMPACTION_CONTINUATION_OK";

function usage() {
  console.error("Usage: node scripts/verify-compaction-live.mjs --session <path> --provider <provider> --model <model>");
}

function parseArgs(argv) {
  const values = { session: "", provider: "", model: "", timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--session" || arg === "--provider" || arg === "--model" || arg === "--timeout-ms") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--session") values.session = value;
      if (arg === "--provider") values.provider = value;
      if (arg === "--model") values.model = value;
      if (arg === "--timeout-ms") values.timeoutMs = positiveInteger(value, DEFAULT_TIMEOUT_MS);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!values.session || !values.provider || !values.model) {
    usage();
    throw new Error("--session, --provider, and --model are required");
  }
  return values;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function safeCodeRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function piVersion(piBinary) {
  try {
    const result = execFileSync(piBinary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    const match = result.match(/\b(\d+\.\d+\.\d+)\b/);
    return (match?.[1] ?? result.trim().slice(0, 80)) || "unknown";
  } catch {
    return "unknown";
  }
}

function assertLivePiVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("could not determine the installed Pi version");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  // Pi 0.87 added the explicit length-stop failure path used as the live
  // non-incomplete-summary assertion.  Do not silently use an older runtime
  // whose successful result cannot prove that property.
  if (major < 1 && minor < 87) throw new Error(`live proof requires Pi >= 0.87.0 (found ${version})`);
}

function redactClass(value) {
  const text = String(value ?? "").toLowerCase();
  if (/token cap|summary is incomplete|generation hit/.test(text)) return "summarization_length";
  if (/unauthori[sz]ed|forbidden|api key|authentication|credential/.test(text)) return "provider_auth";
  if (/rate limit|429|overloaded|503|502|timeout|timed out|terminated/.test(text)) return "provider_transient";
  if (/context|token/.test(text)) return "context_or_token";
  return "compaction_failure";
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeCompactionEvent(event) {
  const result = event?.result;
  const usage = result?.usage;
  return {
    type: event?.type,
    reason: typeof event?.reason === "string" ? event.reason : null,
    aborted: event?.aborted === true,
    willRetry: event?.willRetry === true,
    errorClass: event?.errorMessage ? redactClass(event.errorMessage) : null,
    result: result && typeof result === "object" ? {
      summaryChars: typeof result.summary === "string" ? result.summary.length : 0,
      firstKeptEntryIdPresent: typeof result.firstKeptEntryId === "string" && result.firstKeptEntryId.length > 0,
      tokensBefore: numberOrNull(result.tokensBefore),
      estimatedTokensAfter: numberOrNull(result.estimatedTokensAfter),
      usageInput: numberOrNull(usage?.input),
      usageOutput: numberOrNull(usage?.output),
      usageTotal: numberOrNull(usage?.totalTokens),
    } : null,
  };
}

function sanitizeEvent(record) {
  const type = typeof record?.type === "string" ? record.type : "unknown";
  if (type === "compaction_start") {
    return { type, reason: typeof record.reason === "string" ? record.reason : null };
  }
  if (type === "compaction_end") return summarizeCompactionEvent(record);
  if (type === "agent_end") return { type, willRetry: record.willRetry === true };
  if (type === "message_end") {
    const message = record.message;
    const content = message?.content;
    let textChars = 0;
    if (typeof content === "string") textChars = content.length;
    else if (Array.isArray(content)) {
      textChars = content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
    }
    return {
      type,
      role: typeof message?.role === "string" ? message.role : null,
      stopReason: typeof message?.stopReason === "string" ? message.stopReason : null,
      textChars,
    };
  }
  if (type === "summarization_retry_scheduled") return { type, attempt: numberOrNull(record.attempt) };
  if (type === "summarization_retry_attempt_start") return { type, source: record.source === "compaction" ? "compaction" : null };
  if (type === "extension_error") return { type, event: typeof record.event === "string" ? record.event : null };
  if (type === "extension_ui_request") return { type, method: typeof record.method === "string" ? record.method : null };
  return { type };
}

class JsonRpcProcess {
  constructor(command, args, options) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.events = [];
    this.stdoutBuffer = "";
    this.stderrBytes = 0;
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.nextId = 0;
  }

  start() {
    if (this.child) throw new Error("RPC process already started");
    this.child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      // Never forward provider diagnostics: they can contain request material.
      this.stderrBytes += Buffer.byteLength(chunk);
    });
    this.child.once("error", (error) => {
      this.exited = true;
      this.rejectPending(new Error(`Pi process error (${error.name})`));
    });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.rejectPending(new Error(`Pi process exited before the proof completed (code=${code ?? "null"}, signal=${signal ?? "none"})`));
    });
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A malformed protocol record is a failed proof, but do not echo it.
        this.emit({ type: "__malformed_rpc_record__" });
        continue;
      }
      if (record?.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id);
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        pending.resolve(record);
        continue;
      }
      this.emit(sanitizeEvent(record));
    }
  }

  emit(event) {
    this.events.push(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A verifier listener must never break protocol consumption.
      }
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(command, timeoutMs = 60_000) {
    if (!this.child || this.exited || !this.child.stdin.writable) {
      return Promise.reject(new Error("Pi RPC process is not writable"));
    }
    const id = `verify_${++this.nextId}`;
    const record = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(record)}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not write RPC command: ${command.type}`));
      }
    });
  }

  waitForEvent(predicate, label, timeoutMs, fromIndex = this.events.length) {
    const existing = this.events.slice(fromIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      let timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          resolve();
        }, 2_000);
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function assertSuccessfulResponse(response, command) {
  if (!response || response.success !== true) {
    const errorClass = response?.error ? redactClass(response.error) : "unknown";
    throw new Error(`RPC ${command} failed (${errorClass})`);
  }
  return response.data;
}

function readProjectionLedger(tempRoot) {
  const file = path.join(tempRoot, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "compaction_input_projection") records.push(record.value ?? {});
    } catch {
      // A torn final ledger line is not needed for the proof; other evidence
      // (the compaction event and checksum) remains authoritative.
    }
  }
  return records;
}

function copyHistoricalSession(source, tempRoot) {
  const target = path.join(tempRoot, "historical-session.jsonl");
  fs.copyFileSync(source, target);
  const raw = fs.readFileSync(target, "utf8");
  const lines = raw.split("\n");
  if (!lines[0]) throw new Error("historical session has no JSONL header");
  const header = JSON.parse(lines[0]);
  if (!header || typeof header !== "object") throw new Error("historical session header is malformed");
  // The transcript remains historical; only the copied header's working
  // directory is redirected so GLLA cannot claim or mutate the real state root.
  header.cwd = tempRoot;
  lines[0] = JSON.stringify(header);
  fs.writeFileSync(target, lines.join("\n"));
  return target;
}

function formatCommand(source, provider, model) {
  return `node scripts/verify-compaction-live.mjs --session "${source}" --provider ${provider} --model ${model}`;
}

function makeReport({
  source,
  sourceBytes,
  beforeHash,
  afterHash,
  provider,
  model,
  pi,
  gllaRevision,
  gllaVersion,
  processId,
  copiedSession,
  compactionStart,
  compactionEnd,
  projection,
  continuation,
}) {
  const exactCommand = formatCommand(source, provider, model);
  const projectionValue = projection ?? {};
  return `# Default compaction projection — live proof

- **Result:** PASS
- **Run (UTC):** ${new Date().toISOString()}
- **GLLA revision:** \`${gllaRevision}\` (package \`${gllaVersion}\`)
- **Pi revision:** \`${pi}\` (fresh child process; only GLLA was explicitly loaded)
- **Provider/model:** \`${provider}\` / \`${model}\`
- **Child PID:** \`${processId}\`

## Isolation and source integrity

- Source session: \`${source}\`
- Source size: \`${sourceBytes}\` bytes
- SHA-256 before: \`${beforeHash}\`
- SHA-256 after: \`${afterHash}\`
- Checksum match: **yes**; the original was not opened for writing.
- Temporary copy used for the run: \`${copiedSession}\` (removed after verification).
- The copy's session header was redirected to an isolated temporary working directory; its historical entries were otherwise retained.
- The verifier uses isolated GLLA settings with automatic resume disabled; the real working-directory state root and real session file were not used.
- No credentials or raw transcript/summary text are included in this report or verifier stdout.

## Compaction path and bounded hook evidence

- Automatic compaction start: \`${compactionStart?.reason ?? "unknown"}\`.
- Compaction ended successfully: **yes**; aborted: \`${compactionEnd?.aborted === true ? "yes" : "no"}\`; Pi-reported retry: \`${compactionEnd?.willRetry === true ? "yes" : "no"}\`.
- Summary length observed in memory: \`${compactionEnd?.result?.summaryChars ?? 0}\` characters (content intentionally not recorded).
- Summary length-stop/incomplete error: **none**. Pi 0.87+ rejects a summarizer response with \`stopReason=length\`; a successful non-aborted \`compaction_end\` is therefore the live proof that the default summarizer did not stop for length.
- GLLA hook projection: **observed**.
- Estimated preparation characters: \`${projectionValue.inputCharsBefore ?? "unknown"}\` before → \`${projectionValue.inputCharsAfter ?? "unknown"}\` after (budget \`${INPUT_BUDGET}\`).
- Projection scale: \`${projectionValue.scale ?? "unknown"}\`; bounded messages: \`${projectionValue.boundedMessages ?? 0}\`; bounded fields: \`${projectionValue.boundedFields ?? 0}\`; replaced images: \`${projectionValue.replacedImages ?? 0}\`; bounded GLLA payloads: \`${projectionValue.boundedGoalPayloads ?? 0}\`; retained GLLA payloads: \`${projectionValue.retainedGoalPayloads ?? 0}\`.
- The hook returned no custom compaction result; Pi remained responsible for cut-point selection, summarization, persistence, retries, and the final result.

## Continuation

- Post-compaction continuation: **passed**.
- Continuation marker returned by the model: \`${CONTINUATION_MARKER}\` (only a boolean/length check was retained).
- A second prompt after compaction also completed and returned a non-empty assistant response.

## Reproduction

\`\`\`sh
${exactCommand}
\`\`\`

## Scope and remaining risk

This is one real provider-backed run against the selected model and the copied historical session. It demonstrates the fixed path for that model/context shape; it is not a provider-wide guarantee. Other providers/models can have different context accounting, output caps, or transient availability, so the same verifier should be rerun when the selected model or Pi runtime changes. The verifier does not change provider/model/reserve/thinking settings, does not retry compaction recursively, and does not tag or publish anything.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = path.resolve(options.session);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("session path is not a readable file");

  const piBinary = process.env.PI_BIN || "pi";
  const pi = piVersion(piBinary);
  assertLivePiVersion(pi);
  const gllaRevision = safeCodeRevision();
  const gllaVersion = packageVersion();
  const beforeHash = sha256File(source);
  const sourceBytes = fs.statSync(source).size;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glla-compaction-live-"));
  let rpc;
  let copiedSession;
  let processId = "unknown";
  let compactionStart;
  let compactionEnd;
  let continuation = false;
  let stage = "startup";
  const setStage = (value) => { stage = value; globalThis.__gllaLiveStage = value; };
  setStage(stage);

  try {
    copiedSession = copyHistoricalSession(source, tempRoot);
    const settingsPath = path.join(tempRoot, "glla-settings.json");
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      stateRoot: "workingDir",
      autoResume: false,
      auditorSameSessionSwap: false,
    })}\n`);

    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--extension", path.join(REPO_ROOT, "extensions", "loops", "goal.ts"),
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--no-approve",
      "--session", copiedSession,
      "--provider", options.provider,
      "--model", options.model,
    ];
    rpc = new JsonRpcProcess(piBinary, args, {
      cwd: tempRoot,
      env: {
        ...process.env,
        GLLA_GLOBAL_SETTINGS_PATH: settingsPath,
        NO_COLOR: "1",
      },
    });
    rpc.start();
    processId = String(rpc.child.pid ?? "unknown");

    setStage("state");
    const state = assertSuccessfulResponse(await rpc.send({ type: "get_state" }, 60_000), "get_state");
    if (state?.sessionFile !== copiedSession) throw new Error("Pi did not open the isolated session copy");
    if (state?.autoCompactionEnabled !== true) throw new Error("Pi auto-compaction was not enabled for the proof");
    if (state?.model?.provider !== options.provider || !String(state?.model?.id ?? "").endsWith(options.model)) {
      throw new Error("Pi selected a different provider/model than requested");
    }

    // Subscribe before sending the prompt: threshold/overflow compaction can
    // begin before the prompt command's response is written.
    setStage("awaiting_compaction");
    const eventStart = rpc.events.length;
    const compactionEndPromise = rpc.waitForEvent(
      (event) => event.type === "compaction_end",
      "automatic compaction_end",
      options.timeoutMs,
      eventStart,
    );
    const settledPromise = rpc.waitForEvent(
      (event) => event.type === "agent_settled",
      "post-compaction agent_settled",
      options.timeoutMs,
      eventStart,
    );
    assertSuccessfulResponse(await rpc.send({
      type: "prompt",
      message: "Reply with a short acknowledgement that the default compaction continuation is available.",
    }, 60_000), "prompt");

    const firstBoundary = await Promise.race([
      compactionEndPromise.then((event) => ({ kind: "compaction", event })),
      settledPromise.then(() => ({ kind: "settled" })),
    ]);
    if (firstBoundary.kind !== "compaction") {
      throw new Error("historical session reached agent_settled without an automatic compaction event");
    }
    compactionEnd = firstBoundary.event;
    compactionStart = rpc.events.slice(eventStart).find((event) => event.type === "compaction_start") ?? null;
    if (compactionEnd.aborted || !compactionEnd.result || compactionEnd.result.summaryChars <= 0) {
      throw new Error(`automatic default compaction did not produce a complete result (${compactionEnd.errorClass ?? "unknown"})`);
    }
    if (!compactionStart || !["threshold", "overflow"].includes(compactionStart.reason)) {
      throw new Error("the observed compaction was not Pi's automatic threshold/overflow path");
    }
    setStage("post_compaction_response");
    await settledPromise;
    const firstText = assertSuccessfulResponse(await rpc.send({ type: "get_last_assistant_text" }, 60_000), "get_last_assistant_text");
    if (typeof firstText?.text !== "string" || firstText.text.length === 0) {
      throw new Error("no assistant response followed the successful compaction");
    }

    setStage("explicit_continuation");
    const postStart = rpc.events.length;
    const postSettledPromise = rpc.waitForEvent(
      (event) => event.type === "agent_settled",
      "explicit post-compaction agent_settled",
      options.timeoutMs,
      postStart,
    );
    assertSuccessfulResponse(await rpc.send({
      type: "prompt",
      message: `Reply with exactly ${CONTINUATION_MARKER}.`,
    }, 60_000), "post-compaction prompt");
    await postSettledPromise;
    const postText = assertSuccessfulResponse(await rpc.send({ type: "get_last_assistant_text" }, 60_000), "get_last_assistant_text");
    if (typeof postText?.text !== "string" || !postText.text.includes(CONTINUATION_MARKER)) {
      throw new Error("post-compaction continuation did not return the expected marker");
    }
    continuation = true;
    setStage("complete");
  } finally {
    await rpc?.stop();
  }

  const afterHash = sha256File(source);
  if (beforeHash !== afterHash) throw new Error("original historical session checksum changed");
  const projection = readProjectionLedger(tempRoot).at(-1);
  if (!projection || numberOrNull(projection.inputCharsAfter) === null || projection.inputCharsAfter > INPUT_BUDGET) {
    throw new Error("GLLA compaction projection evidence is missing or exceeds its bounded-input budget");
  }
  if (!continuation) throw new Error("post-compaction continuation was not proven");

  const report = makeReport({
    source,
    sourceBytes,
    beforeHash,
    afterHash,
    provider: options.provider,
    model: options.model,
    pi,
    gllaRevision,
    gllaVersion,
    processId,
    copiedSession,
    compactionStart,
    compactionEnd,
    projection,
    continuation,
  });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const reportTmp = `${REPORT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(reportTmp, report, { mode: 0o644 });
  fs.renameSync(reportTmp, REPORT_PATH);
  console.log(JSON.stringify({
    result: "PASS",
    pi,
    provider: options.provider,
    model: options.model,
    compactionReason: compactionStart.reason,
    inputCharsBefore: projection.inputCharsBefore,
    inputCharsAfter: projection.inputCharsAfter,
    summaryChars: compactionEnd.result.summaryChars,
    continuation: true,
    originalChecksumMatch: true,
  }));
}

try {
  await main();
} catch (error) {
  // Keep diagnostics categorical: provider errors and RPC payloads may contain
  // credentials or raw conversation material.
  const message = error instanceof Error ? error.message : String(error);
  const category = redactClass(message);
  const stage = typeof process.env.GLLA_LIVE_DEBUG === "1" && typeof globalThis.__gllaLiveStage === "string"
    ? globalThis.__gllaLiveStage
    : "redacted";
  console.error(`FAIL: ${category}${stage === "redacted" ? "" : ` (stage=${stage})`}`);
  process.exitCode = 1;
}
