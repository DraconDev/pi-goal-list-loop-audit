// Recovery follows a work identity, not whichever live slot happens to exist
// when a delayed callback fires. Ordinary-chat retries have a separate owner.
export type RecoveryOwner =
  | { kind: 'goal'; id: string }
  | { kind: 'loop'; startedAt: string }
  | { kind: 'chat' };

interface RecoveryWork {
  goal?: { id: string; status: string } | null;
  loop?: { startedAt: string; active: boolean; stopReason?: string } | null;
}

export function currentRecoveryOwner(work: RecoveryWork): RecoveryOwner {
  if (work.loop?.active) return { kind: 'loop', startedAt: work.loop.startedAt };
  if (work.goal && !['complete', 'aborted'].includes(work.goal.status)) return { kind: 'goal', id: work.goal.id };
  return { kind: 'chat' };
}

export type RecoveryOwnership = 'retained' | 'chat' | 'terminal' | 'absent' | 'replaced' | 'restore-pending';

/** The caller must positively establish restore completion. Absence in a
 * partially hydrated projection is not evidence that saved work disappeared.
 * A paused/stopped loop is still saved work: inactive does not mean terminal.
 * Terminal-loop disposal is performed by the lifecycle that removes its slot. */
export function recoveryOwnership(
  owner: RecoveryOwner | undefined,
  legacyKind: 'goal' | 'loop',
  work: RecoveryWork,
  restoreComplete: boolean,
): RecoveryOwnership {
  if (!restoreComplete) return 'restore-pending';
  if (owner?.kind === 'chat') return 'chat';
  if (owner?.kind === 'loop' || (!owner && legacyKind === 'loop')) {
    if (!work.loop) return 'absent';
    if (owner?.kind === 'loop' && owner.startedAt !== work.loop.startedAt) return 'replaced';
    return 'retained';
  }
  if (!work.goal) return 'absent';
  if (owner?.kind === 'goal' && owner.id !== work.goal.id) return 'replaced';
  if (['complete', 'aborted'].includes(work.goal.status)) return 'terminal';
  return 'retained';
}

/** Validate only the ownership tag, never infer an ordinary chat from a
 * legacy record missing its supervised target during restore. */
export function sanitizeRecoveryOwner(value: unknown): RecoveryOwner | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'chat') return { kind: 'chat' };
  if (raw.kind === 'goal' && typeof raw.id === 'string' && raw.id.trim() && raw.id.length <= 300) return { kind: 'goal', id: raw.id };
  if (raw.kind === 'loop' && typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt))) return { kind: 'loop', startedAt: raw.startedAt };
  return undefined;
}
