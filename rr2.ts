import { extractMechanicalCheckSteps, runMechanicalPreAuditChecks } from './extensions/goal-loop-shield.ts';
const contract = "2. `cd web/jobs && bun run check` exits 0 (svelte-check reports 0 errors, 0 warnings counts printed in the raw output).";
console.log('steps:', JSON.stringify(extractMechanicalCheckSteps(contract)));
const r = await runMechanicalPreAuditChecks('/home/dracon/Dev/dracon-platform/web/jobs', extractMechanicalCheckSteps(contract), 30_000);
console.log('passed:', r.passed, '| exit', r.exitCode);
console.log(String(r.output ?? '').slice(0, 200));
