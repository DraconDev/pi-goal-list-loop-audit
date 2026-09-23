// pi-goal-list-loop-audit — v0.34.72
// extensions/vision-assist.ts
//
// note.md 2026-08-07: "the agent is too eager when couldnt see it tried to
// use expensive mdoels. we need to special a vision setting where it called
// another model or cli like mmx vision to see if stuck. but not just this
// we need to specify that it cant be too eager to switch only preapproved."
//
// The vision-assist policy: when the agent needs to SEE something (a
// screenshot, a UI state, an error dialog), first use the native image
// capability of the model currently doing the work. Never assume that an
// external CLI such as mmx is installed. An external vision provider is an
// optional, explicitly confirmed fallback — not a model switch and not a
// package requirement. This module is pure — no pi runtime calls, no fs — so
// the rule is unit-testable in isolation; the orchestration layer injects the
// guidance into continuation prompts and writes vision_assist ledger entries.

import { isForbiddenModel, DEFAULT_FORBIDDEN_MODELS } from "./goal-loop-core.js";

/** The vision-assist setting is ON by default (opt-out) — the guidance
 * ships so agents prefer native vision without assuming an external tool. */
export const VISION_ASSIST_DEFAULT = true;

/** The guidance block injected into continuation prompts (the documented
 * vision-assist routing rule — single source of truth; docs/VISION-ASSIST.md
 * mirrors it for humans). */
export const VISION_ASSIST_GUIDANCE = `## VISION-ASSIST — USE NATIVE VISION FIRST; EXTERNAL TOOLS ARE OPTIONAL

When a task needs you to LOOK at a screenshot, UI state, error dialog, or
rendered mockup, first use the native image capability of the model currently
doing the work (the main model for executor work, or the configured auditor
model for detached audit work). Do NOT switch models merely to obtain vision,
and do NOT assume MMX or any other external CLI is installed.

- If an image is attached or otherwise available to the current model, inspect
  it directly and compare it with the objective. Do not invent observations.
- If the current model cannot accept images, use an external vision provider
  only after its availability has been explicitly confirmed. MMX is an optional
  example, not a default or a requirement:

  mmx vision describe --image <path-or-url> --prompt "<question>" --quiet --non-interactive

- If neither native vision nor a confirmed external provider is available,
  state that visual evidence is unavailable and request a supported capture or
  user description. Do not silently claim that MMX exists.

MODEL-SWITCH GATE (preapproval and intent): switching models solely to "see"
is the too-eager behavior this setting exists to stop. A preapproved model may
be selected only when the user explicitly requests it or it is needed for the
ordinary task, not as an assumed vision workaround. The forbiddenModels list
defaults to empty; users can explicitly add patterns such as gpt-5.5, sonnet,
or opus through /glla settings. Any switch to an explicitly forbidden model is
blocked and ledgered as forbidden_model_switch; vision-assist routing is
ledgered as vision_assist.`;

function shellQuote(value: string): string {
  // POSIX single-quote encoding: only `'` needs special treatment, and the
  // resulting text is literal inside a shell word (no $, ;, newline, or
  // backslash reinterpretation). The helper is a display/guidance command,
  // so we do not claim Windows cmd.exe compatibility.
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The exact optional mmx vision describe command for one external check. */
export function visionDescribeCommand(imagePath: string, question?: string): string {
  const q = question && question.trim().length > 0 ? question.trim() : "Describe what is shown in the image.";
  return `mmx vision describe --image ${shellQuote(imagePath)} --prompt ${shellQuote(q)} --quiet --non-interactive`;
}

export interface VisionCheckRequest {
  /** The image to look at (path or URL). */
  imagePath?: string;
  /** The question to ask about the image. */
  question?: string;
  /** The model the agent was reaching for (provider/id or bare id). */
  targetModelRef?: string;
  /** The forbidden-model policy to gate against (defaults to the policy). */
  forbiddenModels?: readonly string[];
  /** Set false only when native image input is known to be unavailable. */
  mainModelVisionCapable?: boolean;
  /** An external provider is usable only when availability is confirmed. */
  externalVisionProvider?: "mmx";
  externalVisionAvailable?: boolean;
  /** Explicit opt-in for a vision-only model switch; default is no switch. */
  allowModelSwitch?: boolean;
}

export type VisionCheckRoute =
  | { route: "main-model"; blockedSwitch?: string }
  | { route: "mmx-vision"; command: string; provider: "mmx"; blockedSwitch?: string }
  | { route: "model-switch"; ref: string; command?: string }
  | { route: "unavailable"; reason: string; blockedSwitch?: string };

/**
 * Prefer the current model's native image capability. A confirmed external
 * provider is an optional fallback; no external tool is assumed. A model
 * switch is allowed only when the caller explicitly opts into it and the
 * target is not forbidden. A false native-capability declaration with no
 * confirmed external provider fails closed instead of inventing a route.
 */
export function routeVisionCheck(request: VisionCheckRequest): VisionCheckRoute {
  const imagePath = request.imagePath?.trim();
  const command = imagePath ? visionDescribeCommand(imagePath, request.question) : undefined;
  const externalCommand = command ?? "mmx vision describe --image <path-or-url> --quiet --non-interactive";
  const fallback = (blockedSwitch?: string): VisionCheckRoute => {
    if (request.externalVisionProvider === "mmx" && request.externalVisionAvailable === true) {
      return { route: "mmx-vision", command: externalCommand, provider: "mmx", ...(blockedSwitch ? { blockedSwitch } : {}) };
    }
    if (request.mainModelVisionCapable !== false) {
      return { route: "main-model", ...(blockedSwitch ? { blockedSwitch } : {}) };
    }
    return {
      route: "unavailable",
      reason: "native image input is unavailable and no external vision provider was confirmed",
      ...(blockedSwitch ? { blockedSwitch } : {}),
    };
  };

  if (request.targetModelRef && isForbiddenModel(request.targetModelRef, request.forbiddenModels)) {
    return fallback(request.targetModelRef);
  }
  if (request.targetModelRef && request.allowModelSwitch === true) {
    return { route: "model-switch", ref: request.targetModelRef, command };
  }
  return fallback();
}

export interface VisionAssistLedgerValue {
  route: VisionCheckRoute["route"];
  command?: string;
  provider?: "mmx";
  imagePath?: string;
  question?: string;
  /** model-switch route: the explicitly allowed target. */
  ref?: string;
  /** A forbidden switch the gate turned into a non-switch route. */
  blockedSwitch?: string;
  /** unavailable route: why no visual path was safe. */
  reason?: string;
  at: string;
}

/** The ledger payload for a vision_assist entry. */
export function visionAssistLedger(route: VisionCheckRoute, request: VisionCheckRequest, at = new Date().toISOString()): VisionAssistLedgerValue {
  return {
    route: route.route,
    ...(typeof (route as { command?: unknown }).command === "string" ? { command: (route as { command: string }).command } : {}),
    ...(route.route === "mmx-vision" ? { provider: route.provider } : {}),
    ...(request.imagePath?.trim() ? { imagePath: request.imagePath.trim() } : {}),
    ...(request.question?.trim() ? { question: request.question.trim() } : {}),
    ...(route.route === "model-switch" ? { ref: route.ref } : {}),
    ...(typeof (route as { blockedSwitch?: unknown }).blockedSwitch === "string" ? { blockedSwitch: (route as { blockedSwitch: string }).blockedSwitch } : {}),
    ...(route.route === "unavailable" ? { reason: route.reason } : {}),
    at,
  };
}

// Re-export the gate so callers/tests share ONE matcher.
export { isForbiddenModel, DEFAULT_FORBIDDEN_MODELS };
