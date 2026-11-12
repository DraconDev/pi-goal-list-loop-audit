export declare const CHALLENGE_SEPARATOR: string;
export declare const CONTINUATION_SEPARATOR: string;
export declare const REWORK_SCOPE_RULES: string[];
export declare const FIRST_ROUND_CHALLENGE_SCOPE_RULES: string[];
export declare function buildChallengePrompt(
  originalPrompt: string,
  round1Output: string,
  reworkRound?: boolean,
): string;
export declare function buildContinuationPrompt(args: {
  originalPrompt: string;
  completedToolCalls?: Array<{ name: string; argsPrefix: string }>;
  cancelled: { name: string; argsPrefix: string };
  timeoutLabel: string;
}): string;
