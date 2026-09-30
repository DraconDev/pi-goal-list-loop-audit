import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_TERMINAL_RECEIPT_BYTES } from "./terminal-summary-limits.js";

/** Pi can mutate the branch before a session write fails, and sendMessage's
 * void API is not a persistence acknowledgement. Read only the bounded tail
 * on delivery/replay; never mutate the host session or poll for a receipt. */
function persistedEntry(sessionFile: string | undefined, expected: { id: string; customType: string; content: unknown; details?: unknown }): boolean {
  if (!sessionFile) return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(sessionFile, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TERMINAL_RECEIPT_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    // A partial trailing JSONL record is not a durable receipt.
    lines.pop();
    return lines.some((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === "custom_message" && entry.id === expected.id &&
          entry.customType === expected.customType && entry.display === true &&
          entry.content === expected.content &&
          entry.details?.terminalApprovalGoalId === (expected.details as { terminalApprovalGoalId?: string })?.terminalApprovalGoalId;
      } catch { return false; }
    });
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** True means a visible contextual summary is persisted, not that a human
 * has read it. An unpersisted branch entry suppresses same-session duplicates
 * but leaves the durable outbox pending for recovery in a fresh session. */
export function deliverTerminalSummary(
  ctx: Pick<ExtensionContext, "sessionManager">,
  pi: Pick<ExtensionAPI, "sendMessage">,
  customType: string,
  goalId: string,
  content: string,
): boolean {
  const find = () => ctx.sessionManager.getBranch().find((entry) =>
    entry.type === "custom_message" && entry.customType === customType && entry.display === true &&
    (entry.details as { terminalApprovalGoalId?: string } | undefined)?.terminalApprovalGoalId === goalId &&
    entry.content === content,
  );
  let entry = find();
  if (!entry) {
    pi.sendMessage({ customType, content, display: true, details: { terminalApprovalGoalId: goalId } }, { triggerTurn: false });
    entry = find();
  }
  return entry?.type === "custom_message" && persistedEntry(ctx.sessionManager.getSessionFile(), entry);
}
