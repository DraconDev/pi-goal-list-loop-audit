import { countTrailingDisapprovals, countTrailingComparableDisapprovals, AUDIT_CAP_HARD_DEFAULT } from "./extensions/goal-loop-core.ts";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
const files = globSync("/home/dracon/Dev/**/.pi-glla/active.jsonl");
console.log(`cap = ${AUDIT_CAP_HARD_DEFAULT}\n`);
console.log(`${'repo':<42} {'raw':>4} {'cmp':>4} {'fires?':>7}`);
for (const f of files) {
  let g:any=null;
  try { for (const l of readFileSync(f,"utf8").split("\n")) { if(!l.trim())continue; try{const x=JSON.parse(l); if(x.type==="state") g=(x.value||{}).goal;}catch{} } } catch { continue; }
  if (!g) continue;
  const h = g.auditHistory ?? [];
  const raw = countTrailingDisapprovals(h), cmp = countTrailingComparableDisapprovals(h);
  if (raw === 0) continue;
  const repo = f.split("/.pi-glla")[0].replace("/home/dracon/Dev/","");
  const wouldFire = cmp >= AUDIT_CAP_HARD_DEFAULT;
  console.log(`${repo.slice(0,41):<42} ${String(raw).padStart(4)} ${String(cmp).padStart(4)} ${(wouldFire?"PARKS":"no").padStart(7)}  ${g.status}`);
}
