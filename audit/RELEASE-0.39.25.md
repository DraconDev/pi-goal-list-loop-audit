# Release 0.39.25 — 2026-10-10

- Tagged tested commit a4473b6f6f3a43d5267d26481f645629a7d889df as v0.39.25; synchronized package.json, minimal root version edits in package-lock.json, CHANGELOG.md and docs/INDEX.md.
- Includes the earlier three audited repairs, Get-objective guard fix, provider-recovery resume, expanded README and pre-release snapshot/session/hold fences for post-probe resume. README action list corrected to the implemented /glla cancel route rather than nonexistent /glla decide.
- Final local `timeout 1800 npm run release:check`: exit 0, 3641 pass, 1 skip, 0 fail across 387 files; package/launcher/RPC/skill/import probes pass. Log: /tmp/glla-03925-release2.log.
- First gate run hit one 5-second auditor-watchdog timeout; unchanged focused file passed 11/11, followed by the unchanged full gate passing. No test timeout relaxation.
- Post-probe resume regression suite passes 5 cases, including supervisor/load holds, successor replacement and a new pause. Typecheck is included in the release gate.
- GitHub Release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.39.25
- Trusted-publishing workflow 38086195551 succeeded: https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/38086195551
- Workflow log confirms npm published pi-goal-list-loop-audit@0.39.25. Registry propagation initially returned 0.39.24 and ETARGET/404; subsequent fresh registry checks returned version=0.39.25 and dist-tags.latest=0.39.25.
- `npm install -g pi-goal-list-loop-audit@0.39.25 --prefer-online`: exit 0; `npm ls -g pi-goal-list-loop-audit` reports 0.39.25 under /home/dracon/.npm-global/lib.
- Running Pi sessions are not forcibly reloaded. Loaded-extension version is distinct from installed package version; adopt through normal reload.
