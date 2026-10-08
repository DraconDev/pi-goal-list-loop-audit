/** Pure observational projection. No host, filesystem, ownership or mutation APIs. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 240) => typeof value === 'string' ? value
  .replace(/Bearer\s+\S+|\bsk-[\w-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '[redacted]')
  .replace(/([?&](?:token|key|signature|secret)=)[^&\s]+/gi, '$1[redacted]')
  .slice(0, limit) : undefined;
const id = value => typeof value === 'string' && value.length <= 200 && /^[\w.:/-]+$/.test(value) ? value : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const bounded = (value, fallback, hard) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, hard) : fallback;

/**
 * Legacy evidence is intentionally not promoted to new-code receipt certainty.
 * A verified requirement proves recorded verification, not feature shipment.
 */
export function projectProgress(records, options = {}) {
  const maxRecords = bounded(options.maxRecords, 5000, 50000);
  const maxRuns = bounded(options.maxRuns, 16, 64);
  const runs = new Map();
  let consumed = 0, invalidRecords = 0, truncated = false, omittedRuns = 0;
  let firstAt, lastAt;
  for (const record of records) {
    if (consumed >= maxRecords) { truncated = true; break; }
    consumed++;
    if (!object(record) || typeof record.type !== 'string') { invalidRecords++; continue; }
    const timestamp = typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) ? record.at : undefined;
    if (timestamp) { firstAt ??= timestamp; lastAt = timestamp; }
    if (record.type !== 'state' || !object(record.value)) continue;
    const state = record.value;
    const loop = object(state.loop) ? state.loop : undefined;
    const goal = object(state.goal) ? state.goal : undefined;
    const builder = loop && object(loop.builder) ? loop.builder : undefined;
    const runId = builder ? id(builder.projectId) : loop ? id(loop.startedAt) : goal ? id(goal.id) : undefined;
    if (!runId) continue;
    const mode = builder ? 'requirement-builder' : loop ? typeof loop.measureCmd === 'string' && loop.measureCmd.trim() ? 'metric-loop' : 'metricless-loop' : goal.policy === 'list' ? 'list-goal' : 'goal';
    const key = `${mode}:${runId}`;
    if (!runs.has(key)) {
      if (runs.size >= maxRuns) { runs.delete(runs.keys().next().value); omittedRuns++; }
      runs.set(key, {
        id: runId, mode, target: text(loop?.target ?? goal?.objective) ?? 'unknown',
        status: 'unknown', iterations: 0, cycle: undefined, loadedVersion: 'unknown',
        capabilityProgress: 'unknown', coverage: { total: 0, verified: 0, open: 0, blocked: 0 },
        historicalVerification: [], historyTruncated: false, coverageIncomplete: false,
        checkpoint: { revision: undefined, attribution: 'unknown' },
        phaseAccounting: { provenance: 'unknown', durationsMs: {}, recordedTokens: undefined, monetaryCost: 'unknown' },
        latestObservationAt: timestamp,
      });
    }
    const run = runs.get(key);
    run.status = loop ? loop.active === true ? builder?.phase ?? 'running' : 'inactive' : text(goal.status, 40) ?? 'unknown';
    run.iterations = count(loop?.iteration) ?? run.iterations;
    run.cycle = count(builder?.cycle);
    run.latestObservationAt = timestamp ?? run.latestObservationAt;
    // Missing phase/timing evidence remains unknown; a current state does not
    // establish how the elapsed run time was spent or who changed the repo.
    run.phaseAccounting.recordedTokens = count(loop?.tokensUsed ?? goal?.usage?.tokensUsed);
    const requirements = Array.isArray(builder?.requirements) ? builder.requirements : [];
    run.coverage = { total: requirements.length, verified: 0, open: 0, blocked: 0 };
    run.coverageIncomplete = requirements.length > 1024;
    const current = new Set();
    for (const requirement of requirements.slice(0, 1024)) {
      if (!object(requirement)) { run.coverageIncomplete = true; continue; }
      const requirementId = id(requirement.id);
      if (!requirementId) { run.coverageIncomplete = true; continue; }
      const status = requirement.status;
      if (status === 'verified' || status === 'open' || status === 'blocked') run.coverage[status]++;
      else { run.coverageIncomplete = true; continue; }
      if (status !== 'verified') continue;
      current.add(requirementId);
      const attemptId = object(requirement.evidence) ? id(requirement.evidence.attemptId) : undefined;
      const prior = run.historicalVerification.find(x => x.requirementId === requirementId && x.attemptId === attemptId);
      if (!prior) {
        run.historicalVerification.push({ requirementId, title: text(requirement.text), attemptId, observedAt: timestamp, current: true, provenance: 'recorded-state' });
        if (run.historicalVerification.length > 32) { run.historicalVerification.shift(); run.historyTruncated = true; }
      }
    }
    for (const verification of run.historicalVerification) verification.current = current.has(verification.requirementId);
    run.capabilityProgress = run.coverage.verified ? 'recorded-current-verification' : run.historicalVerification.length ? 'historical-verification-only' : 'unknown';
  }
  return {
    schemaVersion: 1,
    window: { records: consumed, firstAt, lastAt, invalidRecords, truncated, omittedRuns, scope: 'provided-records-only' },
    runs: [...runs.values()],
    limitations: ['Activity and verification are not proof of product shipment.', 'Legacy records cannot establish loaded version, phase costs or causal checkpoint attribution.'],
  };
}
