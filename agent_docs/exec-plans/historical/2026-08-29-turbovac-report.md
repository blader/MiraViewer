# MiraViewer TurboVac — 2026-08-29

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

## Delivery status

PR: https://github.com/blader/MiraViewer/pull/10\
Branch: `blader/siqi-chen/sharp-interpolated-slices`\
Pushed head: `5c0f77b37b2ac2ac64fec28d18e620cb333a0ccc`\
Actual base: `origin/main`\
Merge base: `f800ffbda5ae260d253dbb0fc79377c50a2cba21`

- First clean-pr: completed; created an honestly scoped draft. No existing PR description or reviewer evidence was overwritten.
- Diff reduction: completed; the third complete fresh pass found no further viable cuts. All candidate-head checks below have completed.
- Second clean-pr: completed; final head pushed, exact three-commit/91-file scope reconciled with GitHub, description refreshed and full readback verified.
- Hall-monitor: completed; both GitHub checks are successful across all four CI surfaces, all review surfaces are clear and GitHub reports `MERGEABLE` / `CLEAN` on the exact pushed head. The PR remains draft, not merged.

This report concerns PR grooming. It does not close the separate learned-segmentation integration and full-volume anatomical-validation objective.

## Scope and privacy

The initial publication contains exactly 91 task-owned frontend code/config/test paths: 37 production files, 53 tests/helpers and one ESLint configuration. That inventory is unchanged after reduction. No new documentation, visual artifacts, MRI source, private masks, model weights or execution receipts are included in this PR.

All 91 paths are regular UTF-8 code files. Sorted path-list SHA-256: `e6d949cf1e993bc8150d969db14af5ebbc0c0ee922e7aa5d6fa8f4c64d1ec042`. Candidate content-inventory SHA-256: `9c561f3ba5b61e601ac9fed2e46d75217b7ee3796854afe35f97c8c24fd87344`.

The protected MRI directory and `frontend/tmp/` remain ignored and untracked. Earlier unrelated untracked documents and artifacts were preserved. The one nonignored untracked code file is the older synthetic fixture generator: 101 lines, including 12 blank lines. It was included in reading/count accounting but neither executed, changed nor published. Ignored private prototype work is outside this PR's publication/reduction scope.

## Retained fixes and reductions

The most important finding was a cancellation regression between aligned browsing and Sharp slices. A consumer could abort or time out while its uncancelable Cornerstone load continued. Sharp's old limit followed the consumer promise, so eight replacement context loads could start while the abandoned load remained pending.

The existing single-load limit now follows the underlying load's settlement. Consumer cancellation remains prompt, existing deadlines remain intact, and no additional cache, retry or ownership ledger was introduced. Four composed regressions cover abort/timeout crossed with late success/failure. They failed before the fix and pass afterward; they also verify queued cancellation, no stale pixel conversion and recovery after settlement.

Behavior-preserving reductions:

- Reuse the existing deferred test helper and remove redundant source/preflight aliases.
- Count retained volumes and their distinct masks in one traversal, including volumes without masks.
- Centralize 21 private-artifact URL constructions without changing routes, branches or assertions.
- Share three display-only contour loops. Whole-file AST equivalence after inlining and 2,574 synthetic full-buffer comparisons preserve exact pixels, border behavior, subarray offsets, inversion and special numeric values. No private images or receipts were regenerated.
- Share the existing proposal fixture across selection/editor tests, replacing 12 duplicate literals. Expanded AST, object values, typed-buffer bytes and fresh nested-object identities were verified.
- Inline a one-use memory-summing wrapper.

No existing comment, test case, assertion, independent oracle or scientific-evidence classification was removed. The segmentation solver and the user's approved private prediction were not changed by grooming.

## Diff accounting

Comparison is the complete merge-base diff, not the last commit or whole-file net length. “Non-comment” includes blank lines; comments use TypeScript parser ranges and a string-aware CSS scanner. Baseline and final counts use the same classifier.

| Metric | Initial snapshot `5808468` | Candidate `5c0f77b` | Change |
| --- | ---: | ---: | ---: |
| Changed files | 91 | 91 | 0 |
| Insertions | 14,154 | 14,103 | −51 (0.36%) |
| Deletions | 1,076 | 1,076 | 0 |
| Total churn | 15,230 | 15,179 | −51 (0.33%) |
| Comment-only additions | 218 | 219 | +1 |
| Comment-only deletions | 42 | 42 | 0 |
| Comment-bearing additions | 247 | 248 | +1 |
| Non-comment insertions | 13,936 | 13,884 | −52 (0.37%) |
| Non-comment churn | 14,970 | 14,918 | −52 (0.35%) |

Pure reductions removed 141 insertions and one deletion, or 142 churn lines. The necessary cancellation repair and regression tests added 90 insertions and one deletion, including one explanatory comment. Both are included in the net figures; the fix is not concealed as a reduction.

Including the constant 101-line untracked generator, total working-code insertions are 14,255 → 14,204 and churn is 15,331 → 15,280. Blank additions are 476 → 478; blank deletions remain 14.

Pass-end accounting: pass 1 had 14,182 insertions / 1,076 deletions / 15,258 churn, with 219 comment-only additions, 13,963 non-comment insertions and 14,997 non-comment churn. Pass 2 reached the final table values. Pass 3 left them unchanged. This records the necessary fix's initial growth as well as the subsequent reductions.

## Iterations and verification

Three complete integrated passes finished. The same implementation lanes partitioned each pass, rather than adding an independent review gate. Every changed file and every merge-base hunk was reread on each pass, including the unchanged 101-line untracked code file. No viable scope- and behavior-preserving reductions remain from the final pass.

1. Pass 1: 91 files; retained nine edited paths in `48957c7763cc337671314ad755e06752a515d630`. Targeted suites passed: 187 selection/evaluation tests (33 private opt-ins skipped), 172 source/Sharp tests. The four cancellation cases have failing-before/passing-after evidence. Global lint and touched-file formatting passed.
2. Pass 2: 91 files; retained five edited paths in `5c0f77b37b2ac2ac64fec28d18e620cb333a0ccc`. Targeted suites passed: 50 memory tests, 61 native/golden tests (seven private opt-ins skipped), and 80 selection/editor tests. Expanded-AST/pixel equivalence, lint and formatting passed.
3. Pass 3: fresh 91-file read partitioned 29 / 41 / 21, covering 48,365 source lines and all 349 merge-base hunks. All source hashes remained unchanged, every lane finished with no jobs or edits in flight, and the tracked worktree is clean at `5c0f77b`. Final full-diff metrics were remeasured and match the table above. No source edits or additional commits were needed in this pass. The temporary `trim-codex.md` plan was removed after completion.

Final candidate-head checks, executed serially:

- `npm run test -- --fileParallelism=false --maxWorkers=1`: 2,073 passed, 54 optional tests skipped; 155 passing / six skipped files; 132.45 seconds.
- `npm run build`: TypeScript and Vite passed; 2,002 modules, 7.34-second Vite phase.
- `npm run lint`: passed.
- `npm run doctor -- --no-score`: no issues across 352 files, 5.7 seconds. Telemetry, supply-chain scanning and numerical scoring were disabled.
- Touched-file Prettier and full merge-base `git diff --check`: passed.

Existing React `act(...)` warnings and Vite's large-chunk warning remain visible. Test/build durations are validation receipts, not claims of improved end-to-end browser performance. The skipped corpus/model cases are not accuracy passes.

## Deliberately skipped cuts

The cold registration and accepted-pose browsing result builders retain distinct provenance and scoring semantics. Merging them would require a larger parameterized abstraction for little saving. Reference identity is also captured after reanchoring, not at an interchangeable earlier point.

Two attempted cleanups—shared source validation and ONNX context forwarding—shortened files but expanded the actual PR by rewriting unchanged base code. They passed their focused tests but were restored exactly to the initial snapshot. Phase-specific memory measurements, raw-load ownership, compatibility guards, independent numerical oracles and baseline/candidate separation remain necessary. Rewriting old test fixtures solely to shorten files was also excluded when it enlarged PR churn.

## Visual evidence and remaining product work

Actual-app route: `http://localhost:43124/`. Supported browser selection was rechecked and still returned `No browser is available`; read-only discovery returned `[]`. The existing runtime was reused. No tab, window or browser was opened, closed or restarted, and no unsupported fallback was used.

Live visual/GPU validation remains pending. Synthetic integration tests are explicitly not a substitute; Storybook evidence was not accepted. No MRI, prediction or private model was uploaded for review.

The private learned-segmentation prototype is not integrated by this PR. Its approved example remains preserved, and full-volume anatomical review, browser execution and memory admission are separate unfinished work. No clinical-accuracy claim is made.

## Publication and monitoring

Both clean-pr passes completed. The first created the scoped draft without overwriting previous PR evidence. The second preserved all valid evidence and privacy limitations, corrected synthetic-event wording, updated the test count and described the cancellation regression. Its three intended commits and 91-file inventory match GitHub exactly, with no hitchhikers. The title and complete body were reread immediately before publication and read back afterward; no concurrent edits appeared. The PR remains draft pending actual-app visual validation.

Hall-monitor completed an initial sweep and a final completion sweep on `5c0f77b37b2ac2ac64fec28d18e620cb333a0ccc`. Both reconciled the PR rollup, `gh pr checks`, paginated raw check runs and paginated legacy statuses:

- `Vercel`: successful; deployment completed at 2026-08-29 10:30:09 UTC.
- `Vercel Preview Comments`: successful; completed at 2026-08-29 10:30:10 UTC.
- No pending, failing or disagreeing check contexts. These are deployment checks; the test, lint and Doctor results above were run locally.
- Review threads: zero total, zero unresolved. Pagination reached `hasNextPage: false` on both sweeps.
- Review comments: zero. Submitted reviews: zero. No review approval is implied.
- One top-level comment, positively classified as `vercel[bot]`, reports the successful deployment. It contains no actionable review request.
- Open human items, open bot items, CI failures, merge conflicts and disagreements: zero.
- GitHub mergeability: `MERGEABLE`; merge state: `CLEAN`.
- Feedback-driven pushes after the second clean-pr: zero. Bot replies: zero. No review fixes or conflict resolutions were needed during monitoring.

No control-center watcher tools were available, so the installed Hall Monitor fallback watched only PR #10. Its recorded process handle was stopped after final clearance; exit was confirmed. No other watcher or browser was stopped. Local and remote branch heads match, and the tracked worktree is clean.

Cubic was not added as a gate, per the user's instruction. No merge was requested in this TurboVac turn, and none was performed. The preview deployment succeeding does not resolve the live visual/GPU validation blocker or finish the separate segmentation objective.

Final workflow audit:

- first `$clean-pr`: done
- diff reduction: done
- second `$clean-pr`: done
- `$hall-monitor`: done
