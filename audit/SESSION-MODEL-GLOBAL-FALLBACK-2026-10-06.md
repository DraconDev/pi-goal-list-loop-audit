# Current session model in global fallback preferences

The main fallback editor passed the current session ref as `currentRef` to the
shared picker, disabling its row and removing it from typed or returned
selections. That is inappropriate for a global chain edited from many sessions:
a model active here can be a useful fallback elsewhere, and changing session
model must not silently change global preferences.

Prepared 0.39.13 omits that session-local exclusion from the main fallback
editor. The model's ordinary registry row and typed ref remain selectable;
forbidden-model filtering, order, uniqueness, cap and per-model thinking remain
intact. The editor explains that the chain is global and runtime handles active
and already-tried candidates. No shared picker default or auditor-primary
exclusion was changed.

Verification: 91 tests passed across five files. A public editor regression
saves the current session model with its thinking pin, edits from another
current model without dropping either candidate, and saves typed input with
the active model first. The actual recovery walk now includes its primary in
the configured global chain and still advances directly to the first eligible
backup without repeating the active primary. TypeScript and inventory results
are retained in `audit/session-model-global-fallback-2026-10-06/`.
Version 0.39.13 is prepared and not published by this work. No live project
or global settings file was changed.
