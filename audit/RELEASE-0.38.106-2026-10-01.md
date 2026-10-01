# v0.38.106 — documentation, companion policy and store icon

**Released and registry verified.** npm `latest` is **0.38.106**; the GitHub
release and its trusted-publishing workflow completed successfully.

- [GitHub release](https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.38.106)
- [Publish workflow](https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/36872564036)
- [npm version](https://www.npmjs.com/package/pi-goal-list-loop-audit/v/0.38.106)
- [Verification evidence](release-0.38.106-evidence-2026-10-01/)

Tag commit: `3dad5f27675d5bd8b3530af9c3af54d2c1f539da`.

## Delivered changes

README, INSTALL, DESIGN and COMPATIBILITY use versionless
`pi install npm:pi-subagents`. The optional companion is separately installed,
not a GLLA runtime dependency. Development uses `*`, with 0.74.0 resolved in
its lockfile. Role-preservation tests compare the installed upstream
frontmatter/context and complete prompt rather than requiring the older
worker's fork policy. No upstream plugin was modified.

The SVG icon now renders a bold mint loop, white verification check and amber
progress node on a navy tile. Its 96px preview was visually checked. The
1024px PNG ships as `media/glla-icon.png`, with a new public `pi.image` URL.
The existing thumbnail path also serves the refreshed image. Both public URLs
were downloaded and their bytes match the reviewed asset and published tarball.

Settings docs name the actual global file and describe root-selector
failure/recovery. Release docs explain daemon-owned checkpoints, thumbnail
publication and registry verification. The docs index tracks 0.38.106; the
changelog includes the previously unpublished 0.38.105 source work and keeps
one empty Unreleased section for future changes.

The audit repairs remain documented in
[POST-FIX-IMPLEMENTATION-2026-10-01.md](POST-FIX-IMPLEMENTATION-2026-10-01.md).
Release validation additionally found a compactor signal window: its handlers
now install before child launch/registration. The test runner likewise installs
settlement before registration and routes refusal through cleanup/evidence.

## Verification

Local and GitHub full `npm run release:check` runs both passed:
**2,966 pass, one skip, zero failures across 321 files**, plus TypeScript,
Node/jiti singleton, offline auditor-extension checks, inventory, packaging and
installed-tarball RPC/skill/import probes. Local gate: **644.689 seconds**.
All **480** source-manifest entries stayed unchanged and match the tag and
current tree. Local log SHA-256:
`4a97c2f2ef1c834d5fc13475e700a7d3fb157a66daa77f8f0803c4550263a6d6`.

The actual registry tarball passes its published SHA-1 and SHA-512 integrity
checks. All **133 shipped files** match the reviewed tree; package metadata
matches semantically. Its README contains the versionless companion install,
its manifest uses `*` for the development companion, and its icon equals both
public image downloads. npm gitHead matches the tag commit. See
[published-verification.json](release-0.38.106-evidence-2026-10-01/published-verification.json)
and [workflow.json](release-0.38.106-evidence-2026-10-01/workflow.json).

Focused evidence includes 54 companion/version tests, 20 release-contract/version
tests, 30 containment tests, 13 runner tests, 29 stale-host boundary tests, and
20 repeated permission-fault cases. The full gates cover the final source.

## Retained attempts and corrections

Historical audit reports and prior evidence remain unchanged. Each interrupted
or failed release attempt retains its command, source hashes and log:

1. `release-check-signal-window.*`: immediate SIGTERM arrived before compactor
   handlers; handlers now arm before launch. The regression holds registration
   until the parent signals, then checks failure receipt and descendant cleanup.
2. `release-check-doc-contract.*`: docs-index version and empty Unreleased
   section were corrected; release-contract checks then passed.
3. `release-check-stale-fixture.*`: a healthy predecessor mock allowed legitimate
   heartbeat self-heal before replacement contact. The fixture now keeps the
   API stale until replacement and the predecessor context unusable afterward;
   runtime recovery was unchanged.
4. `release-check-permission-fixture.*`: permission injection raced the nested
   runner's own startup, stopping its fixture before permission restoration and
   leaving an expected failure in the outer registry. The fixture waits for
   startup acknowledgement, isolates expected failures, and restores its own
   temporary directory permissions before removal. Both channels passed ten
   consecutive runs each. The recorded incomplete obligation's process was
   independently observed absent; no unrelated process was signalled.

## Publication and external-store disposition

npm accepted signed provenance, then explicitly reported asynchronous package
processing. Registry probes retained 404/old-latest observations until version
and latest both returned 0.38.106; no duplicate publish was attempted.

The Pi store page still showed cached **0.38.104** metadata at inspection.
Its existing image URL already serves the new reviewed icon, and the published
npm README/metadata are verified current. Store indexing/cache refresh is
external-only under AGENTS.md; no upstream repair or immediate refresh is
claimed. See [store-observation.json](release-0.38.106-evidence-2026-10-01/store-observation.json).

Coverage is local Linux/Node 22.22.2 and GitHub Ubuntu/Node 22.19.0 with Bun
1.3.14. No fresh Windows/macOS run or paid provider calls are claimed. Machine
runtime journals stayed ignored; the sync daemon owns evidence checkpoints.
