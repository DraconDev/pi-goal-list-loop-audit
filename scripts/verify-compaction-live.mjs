#!/usr/bin/env node
/**
 * Live, provider-backed proof for the local compaction coordinator stack.
 *
 * The verifier starts a fresh Pi RPC process, loads the two local activation
 * entrypoints (GLLA + pi-global-context-limit), and operates only on a copied
 * historical session under a private PI_CODING_AGENT_DIR. Pi remains the host
 * compactor for both automatic and manual paths. Output is scalar-only: raw
 * prompts, summaries, provider diagnostics, environment values, and credentials
 * never leave this process.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { homedir } from "node:os";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GLOBAL_CONTEXT_LIMIT_ROOT = path.resolve(REPO_ROOT, "..", "extensions", "pi-global-context-limit");
const REPORT_PATH = path.join(REPO_ROOT, "audit", "COMPACTION-DEFAULT-PROJECTION-LIVE-PROOF.md");
const LOCAL_EXTENSION_PATHS = [
  path.join(REPO_ROOT, "extensions", "loops", "goal.ts"),
  path.join(GLOBAL_CONTEXT_LIMIT_ROOT, "extensions", "global-context-limit.ts"),
];
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PERSISTENCE_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;
const MAX_COMPACTION_ATTEMPTS = 3;
const INPUT_BUDGET = 16_000;
const GLOBAL_LIMIT = 200_000;
const HISTORICAL_TRIM_TOKENS = 165_000;
const CONTINUATION_MARKER = "GLLA_POST_COMPACTION_CONTINUATION_OK";
const MANUAL_MARKER = "GLLA_MANUAL_COMPACTION_CONTINUATION_OK";
const MANUAL_SEED_CHARS = 120_000;
const DEFAULT_AGENT_DIR = path.join(homedir(), ".pi", "agent");
const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};
const DEFAULT_COMPACTION_PERCENT = 0.8;

let verifierStage = "startup";

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

function safeCodeRevision(repoRoot = REPO_ROOT) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function packageVersion(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version ?? "unknown";
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

function summarizeCompactionResult(result) {
  const usage = result?.usage;
  return {
    summaryChars: typeof result?.summary === "string" ? result.summary.length : 0,
    firstKeptEntryIdPresent: typeof result?.firstKeptEntryId === "string" && result.firstKeptEntryId.length > 0,
    tokensBefore: numberOrNull(result?.tokensBefore),
    estimatedTokensAfter: numberOrNull(result?.estimatedTokensAfter),
    usageInput: numberOrNull(usage?.input),
    usageOutput: numberOrNull(usage?.output),
    usageTotal: numberOrNull(usage?.totalTokens),
  };
}

function summarizeCompactionEvent(event, sequence) {
  return {
    ...event,
    sequence,
    result: event?.result && typeof event.result === "object" ? summarizeCompactionResult(event.result) : null,
  };
}

function textLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

function sanitizeEvent(record, sequence) {
  const type = typeof record?.type === "string" ? record.type : "unknown";
  if (type === "compaction_start") {
    return { type, sequence, reason: typeof record.reason === "string" ? record.reason : null };
  }
  if (type === "compaction_end") {
    return summarizeCompactionEvent({
      type,
      reason: typeof record.reason === "string" ? record.reason : null,
      aborted: record.aborted === true,
      willRetry: record.willRetry === true,
      errorClass: record.errorMessage ? redactClass(record.errorMessage) : null,
      result: record.result,
    }, sequence);
  }
  if (type === "agent_end" || type === "agent_settled") {
    return { type, sequence, willRetry: record.willRetry === true };
  }
  if (type === "message_end") {
    return {
      type,
      sequence,
      role: typeof record.message?.role === "string" ? record.message.role : null,
      stopReason: typeof record.message?.stopReason === "string" ? record.message.stopReason : null,
      textChars: textLength(record.message?.content),
      errorClass: typeof record.message?.errorMessage === "string" ? redactClass(record.message.errorMessage) : null,
    };
  }
  if (type === "summarization_retry_scheduled") return { type, sequence, attempt: numberOrNull(record.attempt) };
  if (type === "summarization_retry_attempt_start") return { type, sequence, source: record.source === "compaction" ? "compaction" : null };
  if (type === "extension_error") return { type, sequence, event: typeof record.event === "string" ? record.event : null };
  if (type === "extension_ui_request") return { type, sequence, method: typeof record.method === "string" ? record.method : null };
  return { type, sequence };
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
    this.nextSequence = 0;
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
      // Provider stderr may include prompts, request material, or credentials.
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
        this.emit({ type: "__malformed_rpc_record__", sequence: ++this.nextSequence });
        continue;
      }
      if (record?.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id);
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        pending.resolve(record);
        continue;
      }
      this.emit(sanitizeEvent(record, ++this.nextSequence));
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

  send(command, timeoutMs = COMMAND_TIMEOUT_MS) {
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
      let killTimer;
      const graceTimer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          resolve();
        }, 2_000);
      }, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(graceTimer);
        if (killTimer) clearTimeout(killTimer);
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

function readProjectionLedger(agentDir) {
  const file = path.join(agentDir, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "compaction_input_projection") records.push(record.value ?? {});
    } catch {
      // Projection evidence is checked separately from persisted compaction.
    }
  }
  return records;
}

function persistedCompactions(sessionFile) {
  if (!fs.existsSync(sessionFile)) return [];
  const records = [];
  for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "compaction" && typeof record.summary === "string" && record.summary.trim()) {
        records.push({
          id: typeof record.id === "string" ? record.id : null,
          parentId: typeof record.parentId === "string" ? record.parentId : null,
          timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
          summaryChars: record.summary.length,
          tokensBefore: numberOrNull(record.tokensBefore),
          fromHook: record.fromHook === true,
        });
      }
    } catch {
      // A torn final session line is retried by the bounded persistence poll.
    }
  }
  return records;
}

async function waitForPersistedCompaction(sessionFile, afterId, timeoutMs = PERSISTENCE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  do {
    latest = persistedCompactions(sessionFile);
    const fresh = latest.find((entry) => entry.id !== afterId && entry.id !== null);
    if (fresh) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("host compaction result was not persisted as a non-empty session record");
}

function stageProviderConfiguration(agentDir, provider, model) {
  // PI_CODING_AGENT_DIR intentionally redirects all runtime state. Pi resolves
  // credentials from that directory, so stage the provider auth file in the
  // disposable store. It is never parsed, logged, or included in reports; outer
  // cleanup removes the copy with the rest of the temporary root.
  const authSource = path.join(DEFAULT_AGENT_DIR, "auth.json");
  const authTarget = path.join(agentDir, "auth.json");
  if (fs.existsSync(authSource)) {
    fs.copyFileSync(authSource, authTarget, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(authTarget, 0o600);
  }
  // Stage only read-only provider/auth inputs required to compose the selected
  // model in the disposable agent dir. The real settings/models files remain
  // untouched, and the temporary copies are removed with the verifier root.
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({
    compaction: DEFAULT_COMPACTION_SETTINGS,
    compactionPercent: DEFAULT_COMPACTION_PERCENT,
    globalContextLimit: GLOBAL_LIMIT,
  }, null, 2)}\n`);
  // Apply the live cap from the first model composition, before extension
  // startup can inspect or replace the current model. This is isolated test
  // configuration; the extension itself owns the durable managed state.
  const sourceModelsPath = path.join(DEFAULT_AGENT_DIR, "models-store.json");
  if (fs.existsSync(sourceModelsPath)) {
    fs.copyFileSync(sourceModelsPath, path.join(agentDir, "models-store.json"), fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      [provider]: {
        modelOverrides: {
          [model]: {
            contextWindow: GLOBAL_LIMIT,
            maxTokens: 32_768,
          },
        },
      },
    },
  }, null, 2)}\n`);
}

function sessionContentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

function messageEstimatedTokens(message) {
  let chars = 0;
  if (message?.role === "system") chars = sessionContentChars(message.content);
  else if (message?.role === "user" || message?.role === "toolResult") chars = sessionContentChars(message.content);
  else if (message?.role === "assistant") {
    if (typeof message.content === "string") chars = message.content.length;
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
        else if (block?.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
        else if (block?.type === "toolCall") {
          try { chars += JSON.stringify(block.arguments ?? {}).length; } catch { chars += 1_024; }
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * The source incident session's final branch is already below Pi's own
 * threshold estimate because later recovery turns removed earlier failed
 * attempts. For this smoke we need a deterministic near-cap branch without
 * mutating the source: keep a recent run of assistant messages and prune older
 * semantic units from the copied branch. The final user prompt is appended
 * fresh by the verifier. This changes only the disposable fixture, never the
 * source transcript, and gives the real host threshold compactor a substantive
 * input near the 200k regression boundary. The selected historical
 * checkpoint is itself a real Pi compaction record, so Pi's active projection
 * remains structurally valid.
 */
function prepareHistoricalBranch(target, keepRecentTokens) {
  const raw = fs.readFileSync(target, "utf8");
  const lines = raw.split("\n");
  const records = lines.filter(Boolean).map((line) => JSON.parse(line));
  const header = records[0];
  if (header?.type !== "session" || typeof header.id !== "string") throw new Error("historical session header is malformed");
  const byId = new Map(records.filter((record) => typeof record.id === "string").map((record) => [record.id, record]));
  let leafId = records.at(-1)?.id;
  if (typeof leafId !== "string") throw new Error("historical session has no leaf entry");
  const branch = [];
  const seen = new Set();
  while (leafId) {
    if (seen.has(leafId)) throw new Error("historical session contains a parent cycle");
    seen.add(leafId);
    const record = byId.get(leafId);
    if (!record) throw new Error("historical session parent is missing");
    branch.push(record);
    leafId = typeof record.parentId === "string" ? record.parentId : null;
  }
  branch.reverse();
  const compactionIndices = branch
    .map((record, index) => record.type === "compaction" ? index : -1)
    .filter((index) => index >= 0);
  if (compactionIndices.length === 0) throw new Error("historical session has no compaction checkpoint");
  // Pick the newest compaction projection large enough to cross Pi's normal
  // reserve threshold, without carrying later failed recovery leaves.
  let selectedCompactionIndex = -1;
  let projectionMessages = [];
  let retainedTokens = 0;
  for (const candidateIndex of compactionIndices.toReversed()) {
    const nextCompactionIndex = compactionIndices.find((index) => index > candidateIndex) ?? branch.length;
    const messages = branch.slice(candidateIndex + 1, nextCompactionIndex).filter((record) => record.type === "message");
    const tokens = messages.reduce((sum, record) => sum + messageEstimatedTokens(record.message), 0);
    if (tokens >= keepRecentTokens) {
      selectedCompactionIndex = candidateIndex;
      projectionMessages = messages;
      retainedTokens = tokens;
      break;
    }
  }
  if (selectedCompactionIndex < 0) throw new Error("historical session has no near-cap compaction projection for the smoke");
  const checkpoint = structuredClone(branch[selectedCompactionIndex]);
  header.cwd = path.dirname(target);
  const output = [header, checkpoint];
  let previousId = checkpoint.id;
  let emitted = 0;
  for (const record of projectionMessages) {
    // Pi's projection retains a trailing assistant length/error response until
    // its context_edit removes it. That orphan is not useful semantic input and
    // can make the copied branch unrepeatable; skip it in the disposable fixture.
    if (record.message?.role === "assistant" && record.message?.stopReason === "length") continue;
    const copy = structuredClone(record);
    copy.parentId = previousId;
    output.push(copy);
    previousId = copy.id;
    emitted += 1;
  }
  fs.writeFileSync(target, output.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return {
    retainedMessages: emitted,
    retainedTokens,
    checkpointSummaryChars: typeof checkpoint.summary === "string" ? checkpoint.summary.length : 0,
  };
}

function copyHistoricalSession(source, tempRoot) {
  const target = path.join(tempRoot, "historical-session.jsonl");
  fs.copyFileSync(source, target);
  const prepared = prepareHistoricalBranch(target, HISTORICAL_TRIM_TOKENS);
  return { target, prepared };
}

async function waitForTerminalCompaction(rpc, options, fromIndex, expectedReason) {
  let index = fromIndex;
  const attempts = [];
  while (attempts.length < MAX_COMPACTION_ATTEMPTS) {
    const start = await rpc.waitForEvent(
      (event) => event.type === "compaction_start" && (!expectedReason || event.reason === expectedReason),
      `${expectedReason ?? "any"} compaction_start`,
      options.remainingMs(),
      index,
    );
    const startIndex = rpc.events.indexOf(start);
    const end = await rpc.waitForEvent(
      (event) => event.type === "compaction_end" && event.sequence > start.sequence,
      `${expectedReason ?? "any"} compaction_end`,
      options.remainingMs(),
      startIndex + 1,
    );
    const attempt = { start, end };
    attempts.push(attempt);
    if (!end.aborted && end.result && end.result.summaryChars > 0) {
      // On a successful automatic overflow compaction, willRetry means Pi
      // will retry the interrupted *agent turn*. The compaction itself is
      // already terminal and persisted; waiting for a second compaction would
      // incorrectly turn a healthy recovery into a timeout.
      return { attempts, start, end };
    }
    if (end.willRetry) {
      index = rpc.events.indexOf(end) + 1;
      continue;
    }
    throw new Error(`host compaction failed (${end.errorClass ?? "unknown"})`);
  }
  throw new Error("host compaction exceeded the bounded retry-attempt ceiling");
}

function manualSeedPrompt() {
  const unit = "Compaction smoke fixture: preserve the fact that the local Pi host owns cut selection, summarization, persistence, and retries. ";
  return `Store this deterministic context for the manual-compaction portion of the isolated regression, then reply with SEEDED. ${unit.repeat(Math.ceil(MANUAL_SEED_CHARS / unit.length)).slice(0, MANUAL_SEED_CHARS)}`;
}

function formatCommand(source, provider, model) {
  return `PI_CODING_AGENT_DIR="$(mktemp -d)" node scripts/verify-compaction-live.mjs --session "${source}" --provider ${provider} --model ${model}`;
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
  globalRevision,
  globalVersion,
  processId,
  copiedSession,
  automatic,
  manual,
  automaticPersisted,
  manualPersisted,
  projection,
  continuation,
  manualSeedChars,
}) {
  const projectionValue = projection ?? {};
  const compact = (proof) => `- Attempts: \`${proof.attempts.length}\`; start reason: \`${proof.start.reason}\`; terminal aborted: \`${proof.end.aborted ? "yes" : "no"}\`; terminal willRetry: \`${proof.end.willRetry ? "yes" : "no"}\`; in-memory summary characters: \`${proof.end.result?.summaryChars ?? 0}\`; persisted summary characters: \`${proof.persisted?.summaryChars ?? 0}\`.`;
  return `# Default compaction projection — live proof

- **Result:** PASS
- **Run (UTC):** ${new Date().toISOString()}
- **GLLA revision:** \`${gllaRevision}\` (package \`${gllaVersion}\`)
- **Global-context revision:** \`${globalRevision}\` (package \`${globalVersion}\`)
- **Pi revision:** \`${pi}\` (fresh child process)
- **Provider/model:** \`${provider}\` / \`${model}\`
- **Child PID:** \`${processId}\`
- **Loaded local extensions:** GLLA \`extensions/loops/goal.ts\`; global cap \`extensions/global-context-limit.ts\`.

## Isolation and source integrity

- Source session: \`${source}\`
- Source size: \`${sourceBytes}\` bytes
- SHA-256 before: \`${beforeHash}\`
- SHA-256 after: \`${afterHash}\`
- Checksum match: **yes**; the original was not opened for writing.
- Temporary copy: \`${copiedSession}\` (removed in the verifier's outer cleanup).
- Pi ran with a private temporary \`PI_CODING_AGENT_DIR\`; the source session and real agent directory were not used.
- GLLA used isolated settings with automatic resume disabled.
- Credentials were resolved by Pi from a private temporary copy of its configured auth store; the credential file was copied without inspection, logged, or written outside the disposable root.
- No raw prompt, summary, environment value, or provider diagnostic is included in this report or verifier stdout.

## Automatic host compaction

${compact({ ...automatic, persisted: automaticPersisted })}

- GLLA bounded preparation projection: **observed**.
- Estimated preparation characters: \`${projectionValue.inputCharsBefore ?? "unknown"}\` before → \`${projectionValue.inputCharsAfter ?? "unknown"}\` after (budget \`${INPUT_BUDGET}\`).
- Projection scale: \`${projectionValue.scale ?? "unknown"}\`; bounded messages: \`${projectionValue.boundedMessages ?? 0}\`; bounded fields: \`${projectionValue.boundedFields ?? 0}\`; replaced images: \`${projectionValue.replacedImages ?? 0}\`; hard bound applied: \`${projectionValue.hardBoundApplied === true ? "yes" : "no"}\`.
- Pi remained authoritative for the threshold/overflow trigger, cut point, default summarizer, retries, persistence, and result.

## Manual host compaction

${compact({ ...manual, persisted: manualPersisted })}

- The verifier seeded \`${manualSeedChars}\` deterministic input characters after the automatic recovery, called Pi RPC \`compact\`, and required a fresh ordered \`compaction_start\`/\`compaction_end\` pair plus a newly persisted non-empty session record. Command success alone was not accepted.

## Usable next turns

- Automatic-compaction continuation: **${continuation.automatic ? "passed" : "failed"}**; assistant text characters: \`${continuation.automaticChars}\`.
- Manual-compaction continuation: **${continuation.manual ? "passed" : "failed"}**; expected marker: \`${MANUAL_MARKER}\`.
- Both paths left Pi able to accept and answer a new prompt after its persisted compaction.

## Reproduction

\`\`\`sh
${formatCommand(source, provider, model)}
\`\`\`

## Scope and remaining risk

This is one real provider-backed run against the selected model, copied historical session shape, and installed Pi version. It is not a provider-wide guarantee. The verifier never supplies a custom compaction result, recursively retries a failed summary, edits model/provider/reserve settings, or writes the source session.
`;
}

function addDeadline(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return {
    remainingMs() {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("live proof exceeded its overall timeout");
      return remaining;
    },
  };
}

async function promptAndRead(rpc, deadline, message, label) {
  const fromIndex = rpc.events.length;
  const settled = rpc.waitForEvent((event) => event.type === "agent_settled", `${label} agent_settled`, deadline.remainingMs(), fromIndex);
  assertSuccessfulResponse(await rpc.send({ type: "prompt", message }, Math.min(COMMAND_TIMEOUT_MS, deadline.remainingMs())), "prompt");
  await settled;
  const result = assertSuccessfulResponse(await rpc.send({ type: "get_last_assistant_text" }, Math.min(COMMAND_TIMEOUT_MS, deadline.remainingMs())), "get_last_assistant_text");
  if (typeof result?.text !== "string" || result.text.length === 0) throw new Error(`${label} returned no assistant text`);
  return result;
}

function assistantTextSatisfies(text, marker) {
  if (typeof text === "string" && text.includes(marker)) return true;
  // Models occasionally add punctuation/spacing around an exact marker. Accept
  // only a whitespace-normalized exact marker, never a fuzzy semantic match.
  return typeof text === "string" && text.replace(/\s+/g, "").includes(marker.replace(/\s+/g, ""));
}
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deadline = addDeadline(options.timeoutMs);
  const source = path.resolve(options.session);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("session path is not a readable file");
  for (const extensionPath of LOCAL_EXTENSION_PATHS) {
    if (!fs.existsSync(extensionPath)) throw new Error("required local extension entrypoint is missing");
  }

  const piBinary = process.env.PI_BIN || "pi";
  const pi = piVersion(piBinary);
  assertLivePiVersion(pi);
  const gllaRevision = safeCodeRevision(REPO_ROOT);
  const gllaVersion = packageVersion(REPO_ROOT);
  const globalRevision = safeCodeRevision("/home/dracon/Dev/pi-plugins");
  const globalVersion = packageVersion(GLOBAL_CONTEXT_LIMIT_ROOT);
  const beforeHash = sha256File(source);
  const sourceBytes = fs.statSync(source).size;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glla-compaction-live-"));
  const agentDir = path.join(tempRoot, "agent");
  const cwd = path.join(tempRoot, "cwd");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  let rpc;
  let copiedSession;
  let processId = "unknown";
  let automatic;
  let manual;
  let automaticPersisted;
  let manualPersisted;
  let projection;
  const continuation = { automatic: false, manual: false, automaticChars: 0 };
  let manualSeedChars = 0;
  const setStage = (value) => { verifierStage = value; };

  try {
    const copied = copyHistoricalSession(source, tempRoot);
    copiedSession = copied.target;
    const initialPersisted = persistedCompactions(copiedSession);
    const settingsPath = path.join(agentDir, "glla-settings.json");
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      stateRoot: "workingDir",
      autoResume: false,
      auditorSameSessionSwap: false,
    })}\n`);
    stageProviderConfiguration(agentDir, options.provider, options.model);

    const args = [
      "--mode", "rpc",
      "--no-extensions",
      ...LOCAL_EXTENSION_PATHS.flatMap((extensionPath) => ["--extension", extensionPath]),
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
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        GLLA_GLOBAL_SETTINGS_PATH: settingsPath,
        NO_COLOR: "1",
      },
    });
    rpc.start();
    processId = String(rpc.child.pid ?? "unknown");


    setStage("state");
    const state = assertSuccessfulResponse(await rpc.send({ type: "get_state" }, Math.min(COMMAND_TIMEOUT_MS, deadline.remainingMs())), "get_state");
    if (state?.sessionFile !== copiedSession) throw new Error("Pi did not open the isolated session copy");
    if (state?.autoCompactionEnabled !== true) throw new Error("Pi auto-compaction was not enabled for the proof");
    if (state?.model?.provider !== options.provider || !String(state?.model?.id ?? "").endsWith(options.model)) {
      throw new Error("Pi selected a different provider/model than requested");
    }
    if (state?.model?.contextWindow !== GLOBAL_LIMIT) {
      throw new Error("Pi did not compose the isolated global context cap before the live prompt");
    }

    setStage("awaiting_automatic_compaction");
    const automaticStartIndex = rpc.events.length;
    const initialSettled = rpc.waitForEvent((event) => event.type === "agent_settled", "automatic prompt agent_settled", deadline.remainingMs(), automaticStartIndex);
    const promptAccepted = assertSuccessfulResponse(await rpc.send({
      type: "prompt",
      message: "Reply with a short acknowledgement that automatic compaction recovery is available.",
    }, Math.min(COMMAND_TIMEOUT_MS, deadline.remainingMs())), "prompt");
    void promptAccepted;
    const automaticProofPromise = waitForTerminalCompaction(rpc, deadline, automaticStartIndex, null);
    automatic = await Promise.race([
      automaticProofPromise.then((proof) => ({ kind: "compaction", proof })),
      initialSettled.then(() => ({ kind: "settled" })),
    ]);
    if (automatic.kind !== "compaction") {
      const failures = rpc.events.slice(automaticStartIndex).filter((event) => event.type === "message_end" && event.role === "assistant" && event.stopReason === "error");
      const failure = failures.at(-1);
      if (failure?.errorClass) throw new Error(`automatic request failed before host compaction (${failure.errorClass})`);
      // agent_settled can race the awaited event promise by one microtask even
      // though the ordered compaction event is already buffered. Prefer that
      // real host proof before declaring the historical session unchanged.
      automatic = { kind: "compaction", proof: await automaticProofPromise };
    }
    automatic = automatic.proof;
    if (!["threshold", "overflow"].includes(automatic.start.reason ?? "")) {
      throw new Error("the observed compaction was not Pi's automatic threshold/overflow path");
    }
    automaticPersisted = await waitForPersistedCompaction(copiedSession, initialPersisted.at(-1)?.id ?? null, Math.min(PERSISTENCE_TIMEOUT_MS, deadline.remainingMs()));
    await initialSettled;

    setStage("post_automatic_continuation");
    const firstText = await promptAndRead(rpc, deadline, `Reply with exactly ${CONTINUATION_MARKER}.`, "post-automatic continuation");
    continuation.automatic = assistantTextSatisfies(firstText.text, CONTINUATION_MARKER);
    continuation.automaticChars = firstText.text.length;
    if (!continuation.automatic) throw new Error("automatic-compaction continuation did not return the expected marker");

    setStage("manual_compaction_seed");
    const seed = manualSeedPrompt();
    manualSeedChars = seed.length;
    await promptAndRead(rpc, deadline, seed, "manual compaction seed");

    setStage("manual_compaction");
    const persistedBeforeManual = persistedCompactions(copiedSession);
    const manualEventStart = rpc.events.length;
    const manualPromise = waitForTerminalCompaction(rpc, deadline, manualEventStart, "manual")
      .then((proof) => ({ proof }), (error) => ({ error }));
    let manualResponse;
    try {
      manualResponse = await rpc.send({ type: "compact" }, Math.min(COMMAND_TIMEOUT_MS, deadline.remainingMs()));
    } catch (error) {
      const eventOutcome = await manualPromise;
      if (eventOutcome.error) throw eventOutcome.error;
      throw error;
    }
    const manualResult = assertSuccessfulResponse(manualResponse, "compact");
    const manualOutcome = await manualPromise;
    if (manualOutcome.error) throw manualOutcome.error;
    manual = manualOutcome.proof;
    const manualSummaryChars = typeof manualResult?.summary === "string" ? manualResult.summary.length : 0;
    if (manualSummaryChars <= 0 || manual.end.result?.summaryChars !== manualSummaryChars) {
      throw new Error("manual RPC result and host event did not describe the same non-empty summary");
    }
    manualPersisted = await waitForPersistedCompaction(copiedSession, persistedBeforeManual.at(-1)?.id ?? null, Math.min(PERSISTENCE_TIMEOUT_MS, deadline.remainingMs()));

    setStage("post_manual_continuation");
    const manualText = await promptAndRead(rpc, deadline, `Reply with exactly ${MANUAL_MARKER}.`, "post-manual continuation");
    continuation.manual = assistantTextSatisfies(manualText.text, MANUAL_MARKER);
    if (!continuation.manual) throw new Error("manual-compaction continuation did not return the expected marker");

    projection = readProjectionLedger(cwd).at(-1);
    if (!projection || numberOrNull(projection.inputCharsAfter) === null || projection.inputCharsAfter > INPUT_BUDGET) {
      throw new Error("GLLA compaction projection evidence is missing or exceeds its bounded-input budget");
    }
    setStage("complete");
  } finally {
    if (process.env.GLLA_LIVE_DEBUG === "1") {
      const recent = rpc?.events.slice(-20).map((event) => ({
        type: event.type,
        sequence: event.sequence,
        reason: event.reason ?? null,
        role: event.role ?? null,
        stopReason: event.stopReason ?? null,
        errorClass: event.errorClass ?? null,
        textChars: event.textChars ?? null,
        willRetry: event.willRetry ?? null,
        summaryChars: event.result?.summaryChars ?? null,
      })) ?? [];
      console.error(`DEBUG final-stage=${verifierStage} events=${JSON.stringify(recent)}`);
    }
    let stopError;
    let integrityError;
    try {
      await rpc?.stop();
    } catch (error) {
      stopError = error;
    }
    try {
      if (sha256File(source) !== beforeHash) integrityError = new Error("original historical session checksum changed");
    } catch (error) {
      integrityError = error;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stopError) throw stopError;
    if (integrityError) throw integrityError;
  }

  const report = makeReport({
    source,
    sourceBytes,
    beforeHash,
    afterHash: sha256File(source),
    provider: options.provider,
    model: options.model,
    pi,
    gllaRevision,
    gllaVersion,
    globalRevision,
    globalVersion,
    processId,
    copiedSession,
    automatic,
    manual,
    automaticPersisted,
    manualPersisted,
    projection,
    continuation,
    manualSeedChars,
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
    extensionsLoaded: 2,
    automaticReason: automatic.start.reason,
    automaticSummaryChars: automatic.end.result.summaryChars,
    automaticPersistedSummaryChars: automaticPersisted.summaryChars,
    manualSummaryChars: manual.end.result.summaryChars,
    manualPersistedSummaryChars: manualPersisted.summaryChars,
    inputCharsBefore: projection.inputCharsBefore,
    inputCharsAfter: projection.inputCharsAfter,
    continuation: true,
    originalChecksumMatch: true,
  }));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const category = redactClass(message);
  const stage = process.env.GLLA_LIVE_DEBUG === "1" ? verifierStage : "redacted";
  console.error(`FAIL: ${category}${stage === "redacted" ? "" : ` (stage=${stage})`}`);
  process.exitCode = 1;
}
