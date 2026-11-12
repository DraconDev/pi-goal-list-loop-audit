## Done — Completion reports now read as one account of the work

## Summary
**What changed · Report shape**
- **The card is one document: headline, lede, changes, verification, follow-ups, next steps, receipt** — sections, not an audit log · extensions/completion-summary.ts:1200

**What changed · Verification**
- **The gate inventory is always visible, derived from the notes rather than claimed** — impossible gate rows stay REPORTED, never PASS

## Verification
| Gate | Command | Result |
| --- | --- | --- |
| Release gate | npm run release:check | PASS: 4552 passed, 0 failed |
| Typecheck | npm run check | exited 0 |

## Follow-up items
- Provider results are still unknown.
- **Left out** — The narrow-window check is not wired into smoke.

## Next steps
- Wire the 390px case into the browser gate.

