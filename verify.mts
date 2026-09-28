import { resolveAuditorModel } from "./extensions/loops/goal-settings-ui.ts";
const model:any = { id: "stealth/space-bunny-alpha", provider: "openrouter", name: "space-bunny-alpha" };
const base:any = {
  model,
  modelRegistry: {
    find: (p:string, m:string) => (p==="openrouter" && m==="stealth/space-bunny-alpha" ? model : undefined),
    hasConfiguredAuth: () => true,
    getAvailable: () => [model],
  },
  ui: { notify: () => {} },
  cwd: process.cwd(),
};
const A = (label:string, r:any) => console.log(
  label.padEnd(52),
  "-> model:", String(r.model?.id ?? r.error).padEnd(28),
  "via:", r.via ?? "-",
  "fallbacks:", (r.fallbackModels ?? []).map((f:any)=>f.model.id).join(",") || "(none)");
A("nothing configured (the field case)", resolveAuditorModel(base, undefined, undefined, true));
A("explicit auditor == session model",        resolveAuditorModel(base, "openrouter/stealth/space-bunny-alpha", undefined, true));
A("explicit auditor + one fallback",          resolveAuditorModel(base, "openrouter/stealth/space-bunny-alpha", "minimax/MiniMax-M3", true));
A("fallback only, no primary",                resolveAuditorModel(base, undefined, "minimax/MiniMax-M3", true));
A("no session model, nothing configured",     resolveAuditorModel({ ...base, model: undefined, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] } }, undefined, undefined, true));
