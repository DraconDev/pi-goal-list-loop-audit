/**
 * pi-goal-list-loop-audit — extensions/auditor-failure-classes.ts
 *
 * The ONE declaration of auditor failure classes, in a LEAF module.
 *
 * v0.39.60 (auditor objection 2026-10-31): every runtime whitelist must derive
 * from this list. It lives here rather than in goal-loop-core because
 * goal-loop-core imports infrastructure-retry, so a core declaration would make
 * `infrastructure-retry -> core -> infrastructure-retry` a cycle that fails at
 * module-init time (`Cannot access ... before initialization`).
 *
 * `satisfies` plus the exhaustiveness assertion below make a union member that
 * is missing from the array a COMPILE ERROR, not a silent runtime drop.
 */
export type AuditorInfrastructureClass =
  | "no-verdict" | "timeout" | "transport" | "provider" | "context-exhausted";

export const AUDITOR_INFRASTRUCTURE_CLASS_VALUES = [
  "no-verdict", "timeout", "transport", "provider", "context-exhausted",
] as const satisfies readonly AuditorInfrastructureClass[];

type MissingAuditorClass =
  Exclude<AuditorInfrastructureClass, (typeof AUDITOR_INFRASTRUCTURE_CLASS_VALUES)[number]>;
const AUDITOR_CLASSES_ARE_EXHAUSTIVE: MissingAuditorClass extends never ? true : never = true;
void AUDITOR_CLASSES_ARE_EXHAUSTIVE;

const AUDITOR_INFRASTRUCTURE_CLASS_SET: ReadonlySet<string> =
  new Set<string>(AUDITOR_INFRASTRUCTURE_CLASS_VALUES);

/** True when `value` is one of the known auditor failure classes. */
export function isAuditorInfrastructureClass(value: unknown): value is AuditorInfrastructureClass {
  return typeof value === "string" && AUDITOR_INFRASTRUCTURE_CLASS_SET.has(value);
}

/** The one runtime Set. Consumers must read this, never a copy. */
export const AUDITOR_INFRASTRUCTURE_CLASSES: ReadonlySet<string> =
  AUDITOR_INFRASTRUCTURE_CLASS_SET;
