import * as fs from "node:fs";
import * as path from "node:path";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { buildWidgetLines, buildStatusText, type AuditDisplayProgress } from "../../extensions/goal-loop-display.js";
import type { Goal } from "../../extensions/goal-loop-core.js";
const now = Date.parse("2026-10-03T18:25:00Z");
const goal: Goal = { id: "doomtap-audit", objective: 'Fix audit finding: HIGH: the "no probe runs in no gate" guard counts a comment', status: "auditing", policy: "list", autoContinue: true,
  usage: { tokensUsed: 194000, tokensLimit: 0 }, createdAt: new Date(now - 70 * 60000).toISOString(), updatedAt: new Date(now).toISOString(),
  pendingCompletion: { at: new Date(now - 8 * 60000).toISOString(), phase: "running", attemptId: "glance", auditorThinkingLevel: "max" } };
const audit: AuditDisplayProgress = { phase: "thinking", elapsedMs: 8 * 60000, lastActivityAt: now - 17000, model: "openrouter/stealth/space-bunny-alpha",
  toolCalls: Array.from({ length: 11 }, () => ({ name: "bash", argsPrefix: "{}", finishedAt: now - 17000 })) };
const frames = [];
for (const appearance of ["dark", "light"]) {
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, `../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), "truecolor");
  for (const width of [40, 80, 190]) {
    for (const [key, progress] of [
      ["audit-running", audit],
      ["audit-quiet", { ...audit, lastActivityAt: now - 31 * 60000, toolCalls: audit.toolCalls!.map(call => ({ ...call, finishedAt: now - 31 * 60000 })) }],
      ["audit-tool", { ...audit, phase: "tool_executing", currentTool: "bash", currentToolStartedAt: now - 2000, toolTimeoutMs: 1200000 }],
    ] as [string, AuditDisplayProgress][]) {
      const extras = { compactAuditCard: true };
      frames.push({ key, theme: appearance, width, height: 10, lines: [...buildWidgetLines({ goal, list: [] }, progress, now, theme, width, extras)!, "", buildStatusText({ goal, list: [] }, progress, now, theme, extras, width)!] });
    }
  }
}
const out = path.resolve(import.meta.dirname, "../../audit/audit-glance-2026-10-03");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "rendered-frames.json"), JSON.stringify(frames, null, 2) + "\n");
console.log(`Rendered ${frames.length} actual audit frames.`);
