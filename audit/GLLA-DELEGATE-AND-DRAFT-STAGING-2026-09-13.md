# Consent-safe delegation skill and draft staging — 2026-09-13 (v0.38.53)

This release ships the packaged `glla-delegate` skill and the pasted-list /
confirmed-draft staging fixes from goal `20260913103751-o9tzvz`.

## Scope and ownership

- The skill is progressive-disclosure guidance only. It does not add runtime
  powers, worker ownership, loop control, or Pi-core behavior.
- Explicit queue requests may use `list_add`; discovered follow-ups are offered
  before queueing unless standing permission exists.
- Durable goals use `propose_goal_draft` and the user's Confirm gate. Unowned
  activation and speculative queueing remain refused.
- Pasted multi-line, bullet, numbered, and checklist input preserves supplied
  boundaries and wording. Clarification remains available only for an
  individually ambiguous item.
- Draft staging keeps interview-floor and stale-entry checks before proposal,
  user confirmation before activation, and conflict handling after
  confirmation. Paused list carryover is resolved after durable enqueue so the
  confirmed batch cannot be stranded behind the paused predecessor.

## Shipped surfaces

- `skills/glla-delegate/SKILL.md` has quoted YAML frontmatter so Pi's loader
  accepts its description containing `: `.
- `package.json` allowlists `skills/` and declares `pi.skills` with
  `skills/glla-delegate`.
- `scripts/release-pack-smoke.mjs` requires the packaged skill, and
  `tests/release-contract.test.ts` loads it through Pi's public loader with no
  diagnostics.
- `prompts/goal-loop-draft.md` and `prompts/goal-loop-plan.md` document the
  supplied-list policy; questionnaire, import, confirmation, and staging tests
  pin the behavior.

## Verification evidence

Commands were run with `TMPDIR=/var/tmp` where applicable:

- `bun test --parallel=1 --max-concurrency=1 --timeout=60000` — **2156 pass,
  2 skip, 0 fail** across 213 files. The two skips are the existing
  environment-gated AgentManager RPC and daemon-commit tests.
- `npx tsc --noEmit` — `TypeScript: No errors found`.
- `npm run release:check` — passed: full test suite, typecheck, Jiti state-split
  check, offline auditor-extension check, `npm pack --dry-run`, and packed
  smoke.
- `npm pack --dry-run --json --ignore-scripts` — 98 files, including
  `skills/glla-delegate/SKILL.md`.
- Real packed-tarball probe — `DefaultPackageManager.resolve()` resolved the
  extracted package skill; Pi `loadSkills()` returned `glla-delegate` with
  `diagnostics: []`; `formatSkillsForPrompt()` contained `glla-delegate`.
- `git diff --check` — clean.

The first full-suite run exposed one documentation-version assertion before
release verification; `docs/INDEX.md` was corrected to include v0.38.53 and the
release contract then passed 10/10. No history rewrite was used.

## Release state

The package and documentation target v0.38.53. Tagging, GitHub Release
publication, npm registry verification, and final archive/goal closure are
performed only after this evidence is durable and the release gates remain
clean.
