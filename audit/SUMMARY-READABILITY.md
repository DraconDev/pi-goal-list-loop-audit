# Terminal summary readability

## Implemented behavior

- Chat finding bodies are plain prose rather than automatically bolded sentences. Area labels retain bold hierarchy, and explicit inline author emphasis remains supported. Archive finding emphasis is unchanged.
- The registered goal-event renderer recognizes plain or bold structural section labels and canonical Markdown headings. It renders display-only depth-2 headings: installed Pi Markdown deliberately exposes depth-3 `###` prefixes, so promoting labels to depth 3 was insufficient. Durable receipt text is not rewritten or colored.
- Theme colors express meaning: accepted Done is success, Remaining is warning, section/action headings are accent, explicit Left out is dim, and body findings/evidence stay neutral. Neutral evidence is not painted as passed merely because it is in What Changed. Existing explicit verification coloring remains evidence-derived and opt-in.
- Chat removes only exact, case-sensitive whole-body Next duplicates already present under Remaining/Left out. It never extracts sentence fragments or removes prefixes. Partial repeats, abbreviations and ambiguous punctuation are retained; unique action clauses, qualifiers, negations and case-sensitive identifiers remain intact. The archive retains original clauses.
- Removed the prior same-label 12-word similarity deletion: overlapping topic words cannot prove semantic equivalence. Exact duplicate details still collapse. Existing problem/action pairing remains co-location, not rewording or deletion; deliberate omissions remain distinguishable.
- Blank separators close each area’s nested evidence list so later area headings do not inherit its indentation.

## Automated capture reproduction

1. `timeout 30 bun scripts/summary-readability-capture.ts`
2. `timeout 60 python3 scripts/capture-ui-status.py --summaries`

Both exited 0. Production registered renderer and installed Pi dark/light themes produce ANSI fixture output. Real xterm rasterization runs on a private Xvfb display (Xvfb, xterm, xdotool, Pillow); it does not touch the user’s desktop. Existing default widget-capture mode is preserved. Captured ANSI artifacts are intentional display evidence, not durable goal-record text; `fixture.md` remains ANSI-free and unchanged by rendering.

## Native visual inspection

Inspected all four final PNGs directly using native vision:

| Capture | Inspection |
|---|---|
| audit/summary-captures/dark-40.png | Full narrow receipt wraps inside the card. Both area labels share the same indentation; no literal heading hashes. Findings are neutral; warning Remaining and accent Next are distinguishable. |
| audit/summary-captures/light-40.png | Same hierarchy and complete wrapped risk/omission/action on light background. The omission is distinct from the unresolved provider risk. |
| audit/summary-captures/dark-120.png | Normal-width prose is readable without whole-sentence accent/bold wash. The repeated narrow-window sentence appears once, with its unique browser-gate action under Next. |
| audit/summary-captures/light-120.png | Normal-width light rendering preserves the same facts, neutral evidence and semantic labels. No hash-prefix leakage or inherited area indentation. |

Initial captures exposed literal `###` prefixes and inherited second-area indentation; both were corrected and captures regenerated before these observations. Each JSON records width, row count, max visible width, unchanged durable fixture and real-xterm capture dimensions. PNGs show static fixtures, not proof of a running session or actual provider/browser verification.

## Verification

`timeout 180 npm test -- tests/*summary*.test.ts tests/remaining-next-pairing.test.ts tests/finding-lead-contract.test.ts tests/outcome-first-chat.test.ts`: **143 pass, 0 fail across 14 files**, exit 0 (`/tmp/glla-summary-readability.log`).

`timeout 100 npm run check`: exit 0 (`/tmp/glla-summary-readability-types.log`, explicit exit recorded).

New regressions cover plain finding bodies/bold hierarchy, exact whole-detail repetition removal, distinct trailing risk/action preservation, negations, case-sensitive evidence, archive clause retention, ANSI-free content, and absence of literal heading prefixes in the real renderer.

The detached auditor’s falsification pass found that the initial punctuation-based splitter treated `e.g.` as a sentence ending and deleted “Do not enable” from a distinct provider-B prohibition. Two new regression cases failed before the fix (`/tmp/glla-summary-abbreviation-repro.log`). The first repair still tried to remove complete-body prefixes using a terminal-word guard. Independent follow-up review found that `Prof.` passed that guard and could delete `Wait for Prof.` from a distinct instruction. This was independently reproduced with failing tests in `/tmp/glla-summary-prefix-repro.log`. The durable pivot removes prefix deletion entirely: only exact whole-body equality can suppress a duplicate. The provider-A/provider-B reproduction, abbreviation endings (`e.g.`, `Dr.`, `Prof.`, `U.S.`), numeric endings, partial repeats and shared fragments of longer risks now retain their full instructions. Exact full duplicate bodies still collapse; distinct action bodies stay complete. Captures were regenerated after the final repair (both capture commands exit 0). The capture seed now represents redundancy as an exact duplicate Next detail alongside a distinct full action, rather than deleting a prefix from a combined instruction. Existing renderer tests prove message content remains unchanged, unsafe terminal sequences are removed, and dark/light results fit widths from 0 to 120.

Independent fresh-context review (run a48c2641-029f-42e3-8cf7-63149a8ba9ef) inspected the committed source/test/script/report diff from 4293a74a to 137ff3c0, current sources, all four PNGs using native vision, metadata and validation logs. Result: no issues found, BLOCKERS none. Reviewer did not rerun commands. Review artifact: `summary-readability-review.md` in the run’s managed output artifacts. That initial acceptance was superseded by the auditor’s abbreviation finding and follow-up prefix finding documented above. Final reviewer follow-up 4e9589f0-e5a8-48f9-98bf-e9806da9af60 verified exact-whole-body-only suppression, full prohibition/partial-instruction regression preservation, final capture seed and 143-pass/typecheck logs: original P1 resolved, no issues found, BLOCKERS none. No prefix or punctuation heuristic remains.
