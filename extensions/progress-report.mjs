/** Pure observational projection. No host, filesystem, ownership or mutation APIs. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 240) => typeof value === 'string' ? value
  .replace(/Bearer\s+\S+|\bsk-[\w-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '[redacted]')
  .replace(/([?&](?:token|key|signature|secret)=)[^&\s]+/gi, '$1[redacted]')
  .slice(0, limit) : undefined;
const id = value => typeof value === 'string' && value.length <= 200 && /^[\w.:/-]+$/.test(value) ? value : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const bounded = (value, fallback, hard) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, hard) : fallback;

function emptyRun(runId, mode, target, timestamp) {
  return {
    id: runId, family: 'unknown', mode, target, status: 'unknown', iterations: 0, cycle: undefined, loadedVersion: 'unknown',
    capabilityProgress: 'unknown', coverage: { total: 0, verified: 0, open: 0, blocked: 0 },
    historicalVerification: [], historyTruncated: false, coverageIncomplete: false,
    checkpoint: { revision: undefined, attribution: 'unknown' },
    phaseAccounting: { provenance: 'unknown', durationsMs: {}, recordedTokens: undefined, monetaryCost: 'unknown' },
    latestObservationAt: timestamp,
  };
}

function integrateReceipt(runs, options, receipt, timestamp) {
  if (!object(receipt) || typeof receipt.runId !== 'string' || typeof receipt.family !== 'string') return;
  const family = ['goal', 'loop', 'project'].includes(receipt.family) ? receipt.family : 'goal';
  const key = `${family}:${receipt.runId}`;
  if (!runs.has(key)) {
    if (runs.size >= bounded(options.maxRuns, 16, 64)) runs.delete(runs.keys().next().value);
    runs.set(key, emptyRun(receipt.runId, typeof receipt.mode === 'string' ? text(receipt.mode, 40) ?? 'unknown' : 'unknown', 'unknown', timestamp));
    runs.get(key).family = family;
  }
  const run = runs.get(key);
  run.latestObservationAt = timestamp ?? run.latestObservationAt;
  if (typeof receipt.version === 'string') {
    const next = text(receipt.version, 40);
    if (next && (run.loadedVersion === 'unknown' || timestamp)) run.loadedVersion = next;
  }
  if (Number.isSafeInteger(receipt.tokensUsed)) {
    const previous = run.phaseAccounting.recordedTokens ?? 0;
    if (receipt.tokensUsed >= previous) run.phaseAccounting.recordedTokens = receipt.tokensUsed;
  }
  if (Number.isSafeInteger(receipt.iteration)) run.iterations = receipt.iteration;
  if (Number.isSafeInteger(receipt.cycle)) run.cycle = receipt.cycle;
  if (Number.isSafeInteger(receipt.revision)) run.checkpoint.revision = `r${receipt.revision}`;
  if (object(receipt.interval) && Number.isSafeInteger(receipt.interval.milliseconds) && receipt.interval.milliseconds >= 0 && typeof receipt.interval.phase === 'string') {
    run.phaseAccounting.durationsMs[receipt.interval.phase] = (run.phaseAccounting.durationsMs[receipt.interval.phase] ?? 0) + receipt.interval.milliseconds;
    run.phaseAccounting.provenance = 'observed';
  }
  if (Array.isArray(receipt.deltas)) {
    for (const delta of receipt.deltas.slice(0, 32)) {
      if (!object(delta) || typeof delta.to !== 'string' || !id(delta.id)) continue;
      const status = delta.to === 'verified' || delta.to === 'open' || delta.to === 'blocked' ? delta.to : null;
      if (!status) continue;
      const attemptId = id(delta.attemptId);
      const prior = run.historicalVerification.find(v => v.requirementId === delta.id && v.attemptId === attemptId);
      if (!prior) {
        run.historicalVerification.push({ requirementId: delta.id, attemptId, observedAt: timestamp, current: status === 'verified', provenance: 'observed-receipt' });
        if (run.historicalVerification.length > 32) { run.historicalVerification.shift(); run.historyTruncated = true; }
      }
    }
  }
  if (receipt.kind === 'state' || receipt.kind === 'ended') {
    run.status = receipt.kind === 'ended' ? 'ended' : typeof receipt.phase === 'string' ? receipt.phase : run.status;
  }
  run.capabilityProgress = run.historicalVerification.some(v => v.current) ? 'recorded-current-verification' : run.historicalVerification.length ? 'historical-verification-only' : 'unknown';
}

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
    if (record.type === 'glla_progress_receipt') {
      if (object(record.value)) integrateReceipt(runs, { ...options, maxRuns }, record.value.receipt ?? record.value, timestamp);
      continue;
    }
    if (record.type !== 'state' || !object(record.value)) continue;
    const state = record.value;
    const candidates = [];
    if (object(state.loop)) candidates.push({ loop: state.loop });
    if (object(state.goal)) candidates.push({ goal: state.goal });
    // A held project can coexist with a current goal. An observer must show
    // both, not perform the runtime owner's arbitration or hide either one.
    for (const { loop, goal } of candidates) {
      const builder = loop && object(loop.builder) ? loop.builder : undefined;
      const runId = builder ? id(builder.projectId) : loop ? id(loop.startedAt) : goal ? id(goal.id) : undefined;
      if (!runId) continue;
      const mode = builder ? 'requirement-builder' : loop ? typeof loop.measureCmd === 'string' && loop.measureCmd.trim() ? 'metric-loop' : 'metricless-loop' : goal.policy === 'list' ? 'list-goal' : 'goal';
      const key = `${builder ? 'project' : loop ? 'loop' : 'goal'}:${runId}`;
      if (!runs.has(key)) {
        if (runs.size >= maxRuns) { runs.delete(runs.keys().next().value); omittedRuns++; }
        runs.set(key, emptyRun(runId, mode, text(loop?.target ?? goal?.objective) ?? 'unknown', timestamp));
      }
      const run = runs.get(key);
      run.mode = mode;
      run.target = text(loop?.target ?? goal?.objective) ?? 'unknown';
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
  }
  return {
    schemaVersion: 1,
    window: { records: consumed, firstAt, lastAt, invalidRecords, truncated, omittedRuns, scope: 'provided-records-only' },
    runs: [...runs.values()],
    limitations: ['Activity and verification are not proof of product shipment.', 'Legacy records cannot establish loaded version, phase costs or causal checkpoint attribution.'],
  };
}

export function formatProgressReport(report) {
  const lines = ['GLLA progress — observational, not a delivery verdict',
    `Evidence window: ${report.window.records} records${report.window.truncated ? ' · PARTIAL' : ''}; not lifetime totals.`];
  if (!report.runs.length) lines.push('No identifiable run in this evidence window.');
  for (const run of report.runs) {
    const phases = Object.entries(run.phaseAccounting.durationsMs).map(([phase, ms]) => `${phase}=${ms}ms`).join(', ') || 'unknown';
    lines.push('', `${run.mode} · ${run.id} · ${run.status}`, `Intended outcome: ${run.target}`,
      `Iterations: ${run.iterations}; cycle: ${run.cycle ?? 'unknown'}; loaded version: ${run.loadedVersion}; checkpoint: ${run.checkpoint.revision ?? 'unknown'}`,
      `Capability evidence: ${run.capabilityProgress}`,
      `Phase durations (${run.phaseAccounting.provenance}): ${phases}; recorded tokens: ${run.phaseAccounting.recordedTokens ?? 'unknown'}; monetary cost: unknown.`,
      `Historical verification observations: ${run.historicalVerification.length}${run.historyTruncated ? '+' : ''} (current: ${run.historicalVerification.filter(v => v.current).length}).`);
  }
  lines.push('', ...report.limitations);
  return lines.join('\n');
}
