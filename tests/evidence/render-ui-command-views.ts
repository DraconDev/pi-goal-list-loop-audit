// Read-only command views driven through GLLA's registered public handlers.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "glla-ui-commands-"));
process.env.GLLA_GLOBAL_SETTINGS_PATH = path.join(sandbox, "global-settings.json");
fs.writeFileSync(process.env.GLLA_GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false, autoResume: false }));
const { default: activate, __testOnlyResetProcessState, __testOnlyLoadState } = await import("../../extensions/loops/goal.js");
const { MockPi, makeMockCtx, seedState } = await import("../harness/mock-pi.js");
const { UI_AUDIT_SCENES } = await import("./ui-audit-scenes.js");
const frames: Array<{ scene: string; command: string; messages: unknown }> = [];
for (const scene of UI_AUDIT_SCENES) {
 __testOnlyResetProcessState();
 const pi = new MockPi(); activate(pi.api);
 const cwd = path.join(sandbox, scene.key); fs.mkdirSync(cwd);
 seedState(cwd, structuredClone(scene.state) as Parameters<typeof seedState>[1]);
 __testOnlyLoadState(cwd);
 const ctx = makeMockCtx(cwd, { sessionManager: { name: `ui-command-${scene.key}` } });
 for (const [command, args] of [["goal", "status"], ["goal", "timeline"], ["list", "show"], ["loop", "status"], ["glla", "status"], ["glla", "stats"], ["glla", "audits"], ["glla", "agents"], ["glla", "list"]]) {
  ctx.ui.notifies.length = 0;
  await pi.command(command!, args!, ctx);
  if (!ctx.ui.notifies.length) throw new Error(`No command feedback: ${scene.key} /${command} ${args}`);
  frames.push({ scene: scene.key, command: `/${command} ${args}`, messages: structuredClone(ctx.ui.notifies) });
 }
 await pi.fire("session_shutdown", { reason: "fixture" }, ctx);
}
__testOnlyResetProcessState();
fs.writeFileSync(path.join(process.env.GLLA_UI_EVIDENCE_DIR ?? path.resolve(import.meta.dirname, "../../audit/full-ui-audit-2026-10-03"), "command-views.json"), JSON.stringify(frames, null, 2) + "\n");
console.log(`Rendered ${frames.length} command views from public handlers across ${UI_AUDIT_SCENES.length} durable state fixtures; every view gave feedback.`);
