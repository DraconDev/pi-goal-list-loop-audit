import { extractMechanicalCheckCommands, runMechanicalPreAuditChecks } from './extensions/goal-loop-shield.ts';
import { extractVerificationContract } from './extensions/goal-loop-core.ts';
import fs from 'node:fs';
const raw = fs.readFileSync('/tmp/newobj.txt', 'utf8');
const { objective, verificationContract } = extractVerificationContract(raw);
console.log('OBJECTIVE chars:', objective.length);
console.log('CONTRACT:'); console.log(verificationContract);
const cmds = extractMechanicalCheckCommands(verificationContract);
console.log('EXTRACTED', cmds.length, '=>', JSON.stringify(cmds));
const cwd = '/home/dracon/Dev/browser-extensions-shared/extensions/standalones/youtube-filter';
for (const c of cmds) {
  const r: any = await runMechanicalPreAuditChecks(cwd, [c], 900000, undefined, undefined, {});
  console.log(String(r.passed).padEnd(5), c, '| exit', r.exitCode ?? '-');
  if (!r.passed) console.log('   OUT:', String(r.output).slice(0, 300).replace(/\n/g, ' '));
}
