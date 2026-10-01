# v0.38.106 — documentation, companion policy and store icon

Requested scope: refresh README/docs, remove companion-version pinning,
improve the Pi store icon, and release afterward.

README, INSTALL, DESIGN and COMPATIBILITY recommend the versionless
`pi install npm:pi-subagents`. The optional companion is separately installed,
not a runtime dependency. Development uses `*`, with 0.74.0 resolved in the
lockfile for reproducible checks. Role-preservation tests now compare the
installed upstream frontmatter/context and complete prompt rather than
requiring the older worker's fork context. No upstream plugin was modified.
The focused companion/version run passed 54 tests across four files.

The SVG icon source now renders a bold mint loop, white verification check
and amber progress node on a navy tile. Its 96px preview was visually checked.
The 1024px PNG is published as `media/glla-icon.png`; `pi.image` uses that new
URL to avoid the previous thumbnail cache. The old thumbnail path is kept
consistent with the vector source.

Settings documentation now names the actual global selector path and describes
root-selector failure/recovery. Release docs explain daemon-owned checkpoints,
thumbnail publication, and registry verification. Changelog groups the new work
and previously unpublished 0.38.105 source changes under the real 0.38.106
release rather than presenting 0.38.105 as a published release.

The three audit fixes are documented separately in
[POST-FIX-IMPLEMENTATION-2026-10-01.md](POST-FIX-IMPLEMENTATION-2026-10-01.md).
Historical evidence is unchanged. The first release gate reproduced an immediate-SIGTERM cleanup window:
the compactor installed signal handlers after synchronous child registration.
The attempt was stopped and its unchanged-source evidence is retained as
`release-check-signal-window.*`. GLLA now installs handlers before child launch;
the regression deliberately holds registry discovery until the parent signals,
then verifies failure receipt and descendant cleanup. The nested runner's
permission fixture also exposed a registration refusal before its own handlers
were installed; the runner now arms settlement before registration and routes
refusal through cleanup/evidence rather than an uncaught exception. Local release validation
is in progress;
tag publication, GitHub workflow success and npm availability remain pending.
The second attempt caught the docs-index version trail and the required empty
Unreleased section; its unchanged-source evidence is retained as
`release-check-doc-contract.*`. Both release documents were corrected before
re-running the release contract.
Evidence: [release directory](release-0.38.106-evidence-2026-10-01/).
