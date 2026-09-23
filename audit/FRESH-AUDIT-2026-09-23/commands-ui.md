# Fresh read-only audit — scoped command/UI surfaces

Scope was limited to the requested command, display, settings, picker, agents-panel, vision-assist, loop-forever, and quota files plus directly relevant tests. No repository files were edited. Existing `.pi-glla/audit-loop/findings.md` was checked for deduplication.

## Findings

### 1. HIGH — audit-loop measure/target still ignore the configured state root
- **Location:** `extensions/goal-loop-forever.ts:569,580-586,599-600`; call site `extensions/goal-loop.ts:1433-1435`.
- **Failure scenario:** set global `stateRoot=sessionDir`, resolve a session directory, put a checked finding under `<sessionDir>/pi-glla/audit-loop/findings.md`, then run `/loop audit` from a cwd whose `.pi-glla/audit-loop/findings.md` is absent or stale. `auditMeasureCmd()` emits a relative `.pi-glla/...` grep, so the loop measures the wrong file (often `0`); the audit target also tells the agent to append to the wrong relative file. The loop can plateau/misreport progress while the configured-root findings file is untouched.
- **Missing test:** `tests/list-audit-state-root.test.ts` covers list fan-out/root selection, but no sessionDir `/loop audit` behavioral test drives the real measure command and target against a cwd decoy.
- **Dedup:** this is the remaining measure/target half of the prior cwd-vs-sessionDir fan-out finding; it is not the already-fixed fan-out reader.

### 2. MEDIUM — stale read-only `/list` commands still write the durable ledger
- **Location:** `extensions/goal-commands.ts:1270-1287,1422-1429,1682-1693`.
- **Failure scenario:** on a stale handle, invoke `/list show` with an empty in-memory queue but a recoverable sidecar. `show` reads the sidecar and calls `appendLedger("list_recovered_from_disk")`; invoke `/list settings` and it calls `appendLedger("list_settings_redirect")`. Both branches are described as read-only, so an old session can write shared state after ownership has moved to a successor.
- **Missing test:** stale-context tests exercise refused mutators, but do not assert that sidecar-backed `/list show` and `/list settings` leave `active.jsonl` byte-identical on a stale handle.
- **Dedup:** distinct from the prior generic stale-mutation fence; these are nominally read-only branches that bypass it.

### 3. MEDIUM — `/glla bug` writes a cwd fallback tree while `sessionDir` is pending
- **Location:** `extensions/goal-commands.ts:2709-2714` (`cmdGllaBug`).
- **Failure scenario:** configure global `stateRoot=sessionDir` before the host session directory resolves, then run `/glla bug repro`. `cmdGllaBug` calls `resolveGllaStateDir()` and immediately `mkdirSync(<resolved>/bugs)` without `stateRootPending()` or a deferred-result check. In the pending state that resolves to the cwd fallback, recreating the ambiguous `<cwd>/.pi-glla` tree the persistence boundary is intended to prevent.
- **Missing test:** the sessionDir lifecycle tests cover `/goal cancel`/wipe deferrals, but have no `/glla bug` pending-root case.
- **Dedup:** prior sidecar-writer fixes covered other sidecars; this is the separate bug-capture writer.

### 4. MEDIUM — provider diagnostics still pass terminal control bytes through unchanged
- **Location:** `extensions/quota-retry.ts:131-135,167-170,193-247,265-270`; user surface `extensions/goal-commands.ts:2677-2695` (`/glla audits`).
- **Failure scenario:** return an auditor/provider report containing `plain text\u001b[2J` (or another control sequence) but none of the sensitive-marker words. `sanitizeProviderAuditReport()` returns every unmarked line verbatim, and `sanitizeProviderDisplayText()` likewise returns its input verbatim when `sensitive` is false. `/glla audits` interpolates the result into `ctx.ui.notify`; the terminal can clear/rewrite the screen. The generic display projection also only collapses whitespace.
- **Missing test:** quota tests cover sensitive redaction, but no unmarked ANSI/control-byte case crosses the audit-report/display projection.
- **Dedup:** prior fixes covered rich terminal summaries and agent transcript text, not these provider projections.

### 5. MEDIUM — transcript role labels bypass transcript sanitization
- **Location:** `extensions/goal-agents-panel.ts:398-415`; `extensions/goal-commands.ts:2813-2823`.
- **Failure scenario:** a child transcript entry such as `{"message":{"role":"\u001b[2Jfake","content":"hello"}}` passes `formatTranscriptEntry`: the text is sanitized, but `role` is interpolated raw as `[<role>] hello`. `/glla agents --tail` sends that line to `ctx.ui.notify`, allowing a child/provider-controlled terminal escape.
- **Missing test:** `tests/agents-panel.test.ts` pins hostile controls in content and malformed/raw JSON, but not in the role/type label.
- **Dedup:** the v0.35.46 fix covered raw and text paths; this residual is the untrusted role prefix.

### 6. MEDIUM — malformed `forbiddenModels` survives normalization and crashes the settings menu
- **Location:** `extensions/goal-settings.ts:434-456` (no type guard for `forbiddenModels`); consumer `extensions/settings-menu.ts:264-269`.
- **Failure scenario:** hand-edit global settings to `{"forbiddenModels":"sonnet"}`. `loadSettings()` leaves the string, and `buildSettingsRows()` sees a non-empty `.length` then calls `.join(", ")` on the string, throwing while `/glla` builds its interactive table. The same untyped value can reach `isForbiddenModel` and break model-change handling.
- **Missing test:** the settings normalization tests cover several junk scalars/enums, but have no wrong-type `forbiddenModels` fixture and no menu-build regression.
- **Dedup:** the prior normalization fix covered selected numeric/boolean/enum keys, not this policy array.

### 7. LOW — provenance/UI display raw invalid values after normalization
- **Location:** `extensions/goal-settings.ts:718-727`; display consumers `extensions/settings-menu.ts:149-155` and `extensions/goal-commands.ts:3030-3032`.
- **Failure scenario:** write `{"auditCap":"oops"}` (or another normalized-away key). `normalizeLoadedSettings()` deletes the invalid value, so runtime uses the default, but `settingsProvenance()` returns the raw project/global string. The menu/headless `/glla` then reports `oops [global]` as the effective policy rather than the actual fallback.
- **Missing test:** tests assert normalized `loadSettings()` values, not that provenance and the rendered value agree for malformed input.
- **Dedup:** this is a display-side residual of the earlier hand-edit normalization work, not a new runtime-normalization claim.

### 8. LOW — settings UI still advertises `bash` for a read-only auditor
- **Location:** `extensions/goal-settings.ts:165-174`; `extensions/settings-menu.ts:395-405`.
- **Failure scenario:** open `/glla` and inspect “Allowed extensions”: the description says the detached auditor’s restricted tools include `bash`. The current worker allowlist is read/grep/find/ls only (the prior security fix removed bash), so the displayed policy promises a capability that is rejected at runtime.
- **Missing test:** settings-menu tests check the row/count, but do not cross-check the description against the actual detached-worker allowlist.
- **Dedup:** the runtime read-only fix is already recorded; this is the remaining UI/docs copy drift.

### 9. MEDIUM — vision command construction is shell-injectable
- **Location:** `extensions/vision-assist.ts:56-60` (`visionDescribeCommand`), consumed as a command by `routeVisionCheck()` at `extensions/vision-assist.ts:93-117`.
- **Failure scenario:** call the helper with `imagePath='x"; touch /tmp/pwn; #'` or a `question` containing `$(...)`. The values are inserted into a double-quoted shell command without escaping, so any caller that executes the returned command (as the module’s external-provider guidance advertises) can run attacker-controlled shell text. `formatTranscriptEntry`-style input sanitization is unrelated here.
- **Missing test:** `tests/vision-assist.test.ts` checks routing/guidance, but has no quote, command-substitution, newline, or shell-metacharacter case.
- **Dedup:** no prior finding covers command construction escaping in `vision-assist.ts`.

### 10. MEDIUM — loop measure commands are emitted to the display without control-text sanitization
- **Location:** `extensions/goal-loop-display.ts:2370-2372` (and the metric branch around `1190-1213`).
- **Failure scenario:** persist a loop whose `measureCmd` contains an ESC/control sequence (via a hand-edited state, refinement, or pasted command). The widget interpolates `l.measureCmd` after width truncation but never calls `sanitizeDisplayText`; the resulting loop card/status can execute terminal control bytes. The user-facing value is not a trusted provider diagnostic—it is directly configurable loop input.
- **Missing test:** display tests cover hostile completion/agent text but do not run the loop card/status with a hostile measure command.
- **Dedup:** distinct from the provider/quota projection finding above.

## Residual risks / limitations
- No focused tests were executed; this pass was read-only and reached the browsing budget while verifying source paths and existing-finding deduplication.
- Findings 4, 5, and 10 are terminal-safety issues whose impact depends on the host UI preserving control bytes; they are still actionable because the surrounding code explicitly performs projection rather than escaping.
- Existing findings in `.pi-glla/audit-loop/findings.md` were not re-reported merely for being present in the current tree.

## BLOCKERS: none

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Produced a concise read-only audit with exact scoped file:line locations, reproducible scenarios, missing-test rationale, and deduplication notes; residual risks are listed and no blocker was found."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "targeted find/grep/read/nl inspection",
      "result": "passed",
      "summary": "Mapped all requested source files and directly relevant tests."
    },
    {
      "command": "git status --short",
      "result": "passed",
      "summary": "Observed only pre-existing unstaged .pi-glla/active.jsonl; no audit source/test edits made."
    },
    {
      "command": "focused test suites",
      "result": "not-run",
      "summary": "Read-only audit reached the browsing budget; findings are source-verified candidates."
    }
  ],
  "validationOutput": [
    "Cross-checked candidates against .pi-glla/audit-loop/findings.md.",
    "BLOCKERS: none"
  ],
  "residualRisks": [
    "No runtime test execution; terminal-control findings should be confirmed against the live host UI before prioritization."
  ],
  "noStagedFiles": true,
  "diffSummary": "No repository source or test files changed; findings artifact written outside the repository.",
  "reviewFindings": [
    "no blockers; 10 new scoped candidates reported"
  ],
  "manualNotes": "The authoritative findings artifact is the requested output path."
}
```