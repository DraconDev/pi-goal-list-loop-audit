import { extractMechanicalCheckCommands, runMechanicalPreAuditChecks } from './extensions/goal-loop-shield.ts';

const candidate = [
  '1. `npm run typecheck` exits 0.',
  '2. `npm run test` reports 0 failures.',
  '3. `npm run check:content-script-timing` exits 0.',
  '4. `npm run check:receipt-evidence` exits 0.',
  '5. `npm run build` exits 0.',
].join('\n');

const cmds = extractMechanicalCheckCommands(candidate);
console.log('EXTRACTED:', JSON.stringify(cmds, null, 0));

const cwd = '/home/dracon/Dev/browser-extensions-shared/extensions/standalones/youtube-filter';
for (const c of cmds) {
  const r = await runMechanicalPreAuditChecks(cwd, [c], 120000, undefined, undefined, {});
  console.log(String(r.passed).padEnd(5), c, '| exit', r.exitCode);
  if (!r.passed) console.log('   OUT:', String(r.output).slice(0, 200).replace(/\n/g, ' '));
}
