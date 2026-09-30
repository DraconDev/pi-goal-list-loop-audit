export function createCanaryBudget(options?: { maxUsd?: number; maxOutputTokens?: number; maxPayloadBytes?: number }): (payload: unknown, model: unknown) => Record<string, unknown>;
