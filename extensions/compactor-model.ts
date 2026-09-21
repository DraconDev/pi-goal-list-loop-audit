// Emergency compactor model resolution (v0.38.10).
//
// The compactor NEVER runs on the session model: when it fires, the session
// model is by definition the stuck one. Resolution order:
//   1. compactorModel + compactorModelFallbacks 0-10 chain, walked exactly
//      like Main/drafter/auditor via ModelSelector (scope {kind:"compactor"}).
//   2. Registry plan B: structured-metadata filter over getAvailable() —
//      verified free-only, contextWindow >= measured need. Unknown metadata
//      is disqualified (never auto-spend on what we cannot verify), the
//      stuck session model and forbidden refs are excluded, max 2 attempts.
//   3. Skip with a compactor_skipped_no_model ledger; the ladder covers.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { appendLedger, isForbiddenModel } from "./goal-loop-core.js";
import { MAX_MAIN_MODEL_FALLBACKS, modelRef, normalizeMainModelFallbackRefs } from "./main-model-recovery.js";
import { ModelSelector } from "./model-selector.js";
import type { Settings } from "./goal-settings.js";

export const MAX_COMPACTOR_FALLBACKS = MAX_MAIN_MODEL_FALLBACKS;

export interface CompactorModelCandidate {
  ref: string;
  model: any;
  via: "configured" | "plan-b";
}

/** Absolute floor for plan-B context windows: below this no model can absorb
 * a stuck session's state with headroom, free or not. */
export const PLAN_B_MIN_CONTEXT_TOKENS = 100_000;

/** Max plan-B attempts per episode: the chain already had its turn; plan B
 * is two verified free swings, not a walk. */
export const PLAN_B_MAX_ATTEMPTS = 2;

/** Resolve a provider/model ref without making a provider request. Same
 * resolver shape as the drafter chain (find + configured-auth gate). */
export function resolveCompactorModelRef(ctx: Pick<ExtensionContext, "modelRegistry">, ref: string): any | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  try {
    if (slash > 0) {
      const model = ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1));
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
      return model;
    }
    return ctx.modelRegistry
      .getAvailable()
      .filter((candidate: any) => candidate.id === trimmed || candidate.name === trimmed)
      .find((candidate: any) => ctx.modelRegistry.hasConfiguredAuth(candidate));
  } catch {
    return undefined;
  }
}

/** Walk the configured compactor chain. Deliberately NO session-last-resort:
 * the session model is the stuck one — leasing it would burn a spawn proving
 * what the starvation refuse already proved. */
export function resolveCompactorChain(
  ctx: ExtensionContext,
  settings: Pick<Settings, "compactorModel" | "compactorModelFallbacks" | "forbiddenModels">,
): { configuredRefs: string[]; candidates: CompactorModelCandidate[] } {
  const primary = typeof settings.compactorModel === "string" ? settings.compactorModel.trim() : "";
  const configuredRefs = normalizeMainModelFallbackRefs([
    ...(primary ? [primary] : []),
    ...normalizeMainModelFallbackRefs(settings.compactorModelFallbacks),
  ]).slice(0, MAX_COMPACTOR_FALLBACKS);
  const currentRef = modelRef(ctx.model);
  const forbidden = (ref: string) => isForbiddenModel(ref, settings.forbiddenModels);
  const selector = new ModelSelector({
    getChain: () => configuredRefs,
    resolve: (ref) => resolveCompactorModelRef(ctx, ref),
    isForbidden: forbidden,
    record: (event) => {
      appendLedger(ctx.cwd, "model_fallback_select", {
        scope: event.scope.kind,
        fromRef: event.fromRef,
        toRef: event.toRef,
        reason: event.reason,
      });
    },
  });
  const attempted: string[] = [];
  const candidates: CompactorModelCandidate[] = [];
  for (;;) {
    // currentRef seeds `attempted` semantics via nextUntriedModelRef: the
    // stuck session model is never re-selected even if configured.
    const selected = selector.selectNextValid({ kind: "compactor" }, currentRef, attempted);
    if (!("model" in selected) || typeof selected.ref !== "string") break;
    attempted.push(selected.ref);
    candidates.push({ ref: selected.ref, model: selected.model, via: "configured" });
  }
  return { configuredRefs, candidates };
}

export interface PlanBCandidate {
  ref: string;
  model: any;
  contextWindow: number;
}

/**
 * Registry plan B, pure and unit-pinned. Structured metadata only — never
 * substring-match "free" in a name. A candidate qualifies iff ALL hold:
 * configured auth, KNOWN contextWindow >= needTokens, KNOWN zero cost
 * (input and output), not the stuck session model, not forbidden.
 * Sorted largest-window-first; the caller tries at most the first two.
 */
export function selectPlanBCandidates(
  registry: Pick<ExtensionContext["modelRegistry"], "getAvailable" | "hasConfiguredAuth">,
  opts: { needTokens: number; excludeRefs: readonly string[]; forbiddenModels?: readonly string[] },
): PlanBCandidate[] {
  let available: any[];
  try {
    available = registry.getAvailable() ?? [];
  } catch {
    return [];
  }
  const excluded = new Set(opts.excludeRefs.map((r) => r.toLowerCase()));
  const qualified: PlanBCandidate[] = [];
  for (const candidate of available) {
    try {
      const ref = modelRef(candidate);
      if (!ref || excluded.has(ref.toLowerCase())) continue;
      if (!registry.hasConfiguredAuth(candidate)) continue;
      if (isForbiddenModel(ref, opts.forbiddenModels)) continue;
      const window = (candidate as { contextWindow?: unknown }).contextWindow;
      if (typeof window !== "number" || !(window >= opts.needTokens)) continue;
      const cost = (candidate as { cost?: unknown }).cost as
        | { input?: unknown; output?: unknown }
        | undefined;
      // Free-only: unknown or nonzero cost is disqualified, never assumed.
      if (!cost || cost.input !== 0 || cost.output !== 0) continue;
      qualified.push({ ref, model: candidate, contextWindow: window });
    } catch {
      continue;
    }
  }
  qualified.sort((a, b) => b.contextWindow - a.contextWindow);
  return qualified.slice(0, PLAN_B_MAX_ATTEMPTS);
}

/** Full resolution: chain, then plan B, then skip. Returns candidates with
 * their provenance plus the measured need (for the rationale ledger). */
export function resolveCompactorModel(
  ctx: ExtensionContext,
  settings: Pick<Settings, "compactorModel" | "compactorModelFallbacks" | "forbiddenModels">,
  needTokens: number,
): { candidates: CompactorModelCandidate[]; needTokens: number } {
  const chained = resolveCompactorChain(ctx, settings);
  if (chained.candidates.length > 0) return { candidates: chained.candidates, needTokens };
  const currentRef = modelRef(ctx.model);
  const planB = selectPlanBCandidates(ctx.modelRegistry, {
    needTokens: Math.max(needTokens, PLAN_B_MIN_CONTEXT_TOKENS),
    excludeRefs: [...(currentRef ? [currentRef] : []), ...chained.configuredRefs],
    forbiddenModels: settings.forbiddenModels,
  });
  if (planB.length > 0) {
    for (const pick of planB) {
      appendLedger(ctx.cwd, "compactor_plan_b_select", {
        toRef: pick.ref,
        contextWindow: pick.contextWindow,
        costFree: true,
        needTokens,
        fromScope: "plan-b",
      });
    }
    return { candidates: planB.map((p) => ({ ref: p.ref, model: p.model, via: "plan-b" as const })), needTokens };
  }
  appendLedger(ctx.cwd, "compactor_skipped_no_model", {
    needTokens,
    configuredRefs: chained.configuredRefs,
  });
  return { candidates: [], needTokens };
}
