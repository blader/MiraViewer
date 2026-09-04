# MiraViewer TurboVac and merge

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

## Scope and safety

PR: https://github.com/blader/MiraViewer/pull/10

Branch: `blader/siqi-chen/sharp-interpolated-slices`.

The user requested TurboVac followed by merging. The four stages are first Clean PR, complete local diff reduction, second Clean PR, and Hall Monitor. Merge follows final-head clearance. Cubic is not installed and is not a gate. No Storybook capture is accepted as integrated product evidence.

The public repository receives only task-owned application code, tests, scripts and the exact eight-file public EfficientTAM asset/license allowlist. MRI source images, masks, screenshots, private receipts, existing untracked documents and fixture artifacts are excluded. The primary browser and active local servers are preserved.

## Stage status

- First Clean PR: completed. Existing evidence preserved, description updated and fully read back, task-owned changes committed and pushed as `a8556b070be814189c877d01e4305c9bbee351a6`.
- Diff reduction: completed after four full passes. Pass 1 committed as `5c6eb939d6db7a62068242db6e8c754ed4474324`; pass 2 as `b1404ca19a971860874cafe0923c53a20c00cd28`; pass 3 as `776d2274b39e40f5a4969f3d5de3f0f15da73c32`. Pass 4 found no viable cuts and made no tracked edits.
- Second Clean PR: completed. Final head pushed and verified; actual GitHub scope matches all seven branch commits and 148 paths. Description refreshed with a live head/title/body concurrency check and complete readback; draft-to-ready transition verified.
- Hall Monitor: completed on exact head `776d2274b39e40f5a4969f3d5de3f0f15da73c32`. Both current-head checks passed; all review surfaces were read and threads paginated to completion, with zero threads and zero actionable items. GitHub reported `MERGEABLE` / `CLEAN`.
- Merge: completed and verified at 2026-08-30 06:59:33 UTC. Merge commit: `5f0efa433b6c8b6672add9a30184ec1140b2b5a3` on `main`.

## Reduction baseline

`origin/latest` is absent; the actual PR and default base is `origin/main`. Merge base: `f800ffbda5ae260d253dbb0fc79377c50a2cba21`. At pass 1 start the tracked worktree was clean and the branch was four commits ahead, zero behind.

The full base-relative diff contains 148 changed files, six binary assets, 26,421 insertions, 1,227 deletions and 27,648 total churn. There are 457 added delimiter-leading/comment-only lines and 25,964 non-comment insertions under that transparent heuristic; inline comments count as code. The preserved, excluded untracked fixture generator contributes another 101 code lines (26,522 insertions / 27,749 churn including it).

The single coordinated implementation pass is partitioned across root utilities/config/assets, UI/orchestration, core tests and app tests. These are disjoint portions of one pass, not extra independent/adversarial review gates. Complete-read receipts include source hashes and full diff coverage; binary assets use exact content pins and license metadata. Every scenario, assertion, comment and doc-comment is preserved.

### Pass 1 cuts

- Inline the single-use hook-free selection-action wrapper without changing DOM, handlers, conditions or labels.
- Reuse selection-description projection in edit history.
- Reuse existing test promises, worker-response helpers and exact fixture setup in newly added files. Distinct geometry, anatomical-reference and diagnostic contracts remain separate.

Base-relative measurement rejected the grid-validator consolidation (+7 PR insertions), cache-growth helper (+2), and seven inherited-test tidyups (+47). Although each reduced file length and passed behavior checks, they expanded the PR by changing code already on main. Only these task-owned candidate edits were reversed. The retained seven-file patch removes 138 PR insertions and 158 total churn; comments remain unchanged.

No MRI sample, interpolation, model graph, threshold, recurrent-state policy, hard-mark authority, cancellation boundary or admission limit changes in reduction. A new metadata-projection layer would add more imports/API than it removes; categorical transfer and exact-cell mapping have different contracts. Diagnostic providers, worker admission checks, cooperative yields and explicit test scenarios are required scope, not dead code.

### Validation observed so far

- First Clean PR: `npm run check` passed 2,828 tests, 54 gated tests skipped; ESLint passed.
- Pass 1 core targeted batch: 276 tests passed across six files.
- Pass 1 transfer/migration batch: 105 tests passed across two files.
- Pass 1 integrated UI batch: 396 tests passed across eight files, with existing React `act(...)` warnings. This batch included the subsequently withdrawn fixture/authority tidyups; full retained-only candidate checks follow.
- Public-model verifier: exact eight-file allowlist, 75,017,682 bytes; manifest SHA-256 `d3650eb88ce470238f3fad429726cf90887359a4a4b7b6c202881917d0a662f9`.
- Python exporter unit tests: eight passed.
- Retained-only pass 1: full `npm run check` passed 2,828 tests (54 skipped), 170 passing files and six gated files; ESLint passed. The production build at `5c6eb939` passed TypeScript, Vite and exact source/dist model-asset verification.
- React Doctor at `5c6eb939` exited 1 under its warning-blocking policy with ten advisories. Nine concern existing cooperative CPU-loop yields; one component-size advisory follows the removal of the single-use stateless wrapper. Restoring eleven-prop indirection solely to avoid that heuristic was rejected. No warning suppression was added.

### Pass 2 cuts and final-pass validation

All 148 files and every modified-file hunk were freshly read again. Two duplicated CSS declaration pairs now share existing policy groups. The two changed selectors retain identical computed styles across 16 width/pointer/enabled combinations and six affected elements; this is a stylesheet regression check, not a browser visual capture. Newly added tests reuse an existing deferred signal and a local synchronous allocation observer. All assertions, scenarios, case tables and comments are preserved. The 148 focused tests in the three affected suites passed, as did formatting and diff checks.

Pass 2 removes another 11 non-comment insertions, with unchanged deletions and comment additions. Reduction result before pass 3: 26,272 insertions, 1,207 deletions, 27,479 churn, 457 comment additions and 25,815 non-comment insertions. The excluded untracked generator still contributes 101 lines.

Compared with the original baseline, the two reduction commits remove 149 insertions (0.5639%), including 149 non-comment insertions (0.5739%), and 169 churn (0.6113%). Comment additions remain exactly 457. Including the excluded generator, the current totals are 26,373 insertions and 27,580 churn. No target percentage was requested; reductions stop only after a complete fresh no-cut pass.

The production build at `b1404ca` passed with exact source/dist public-asset verification; Vite completed in 8.09 seconds. The main chunk remains 2,736.95 kB (836.40 kB gzip), an acknowledged warning rather than a new performance claim. Eight Python exporter tests passed again. React Doctor again reported the same ten advisories with exit 1 under warning-blocking policy.

The first full check at `b1404ca` passed ESLint and 2,827 tests but caught one timing-sensitive assertion in `alignedBrowsingPresentation.test.tsx`. Its wait observed the low-level `displayImage` call before the parent passive effect published the displayed-content key. New CSS and the slice label were already committed. The isolated 27-test file then passed without a code change. The failure is retained in `frontend/tmp/turbovac-20260830/final-check.log`; it is not presented as a green full run. Pass 3 corrected the completion wait, with all image/transform assertions retained.

### Pass 3: resource ownership and validation reliability

All 148 files and modified-file hunks were freshly read. The two tracking routes shared identical tensor-allocation, release, abort checking and graph invocation code. A local `createRunScope` now supplies that single policy while creating a fresh ownership set per route. Directional/correction traversal, retained history, progress accounting, release sites and terminal disposal remain separate. The exact graph-call sequence and all 14 comments are preserved. This removes 24 base-relative source insertions; it does not change model arithmetic or output policy.

The displayed-content regression now waits for the viewer's public completed slice identity instead of an earlier internal display call. All 125 assertions, 21 named scenario declarations, seven comments and 27 expanded cases remain. This required four additional base-relative insertions/deletions and is reported as a validation correction, not a cut.

A subsequent full run hit the existing five-second limit in the 512×512×221 native source/context test. Source inspection showed that installed Vitest 4 ignores the obsolete `threads: false` setting and defaults to 15 workers on this 16-core host. The host concurrently had a busy browser renderer and unrelated machine workloads, which were not stopped. A four-worker trial passed all 2,828 tests with identical cases, assertions and timeouts; the large-grid case took 1.838 seconds. The repository now uses `maxWorkers: Math.min(4, availableParallelism())`, bounding only the test runner, not inference. One explanatory comment was added; all original comments remain.

Validation: 276 focused tracking/model/presentation tests passed; the normal-command configuration-focused batch passed 134 tests. On committed head `776d2274`, standard `npm run check` passed ESLint and all 2,828 tests, with 54 gated skips (170 passing files / six skipped files), in 65.70 seconds. `npm run build` passed TypeScript, Vite and exact source/dist model pins; Vite took 11.54 seconds. No private/model gated skip is counted as an accuracy pass. Earlier failed runs are retained, not erased.

The final-head Doctor rerun again found exactly ten advisories and exited 1 under warning-blocking policy. Its output is retained in `frontend/tmp/turbovac-20260830/pass-4-doctor.log`; standard tests/build are in `pass-4-check.log` and `pass-4-build.log`. The remaining advisories are accepted and disclosed, not suppressed or described as a 100% score. The eight Python exporter tests were rerun on the exact final head during publication and passed again.

Pass-3 final totals: 26,255 insertions, 1,212 deletions and 27,467 churn; 458 added comment-only/delimiter-leading lines and 25,797 non-comment insertions. This is a net reduction of 166 insertions (0.6283%), 167 non-comment insertions (0.6432%) and 181 churn (0.6547%) from the initial baseline, including the required validation fixes. Including the unchanged excluded 101-line generator gives 26,356 insertions and 27,568 churn.

### Pass 4: complete no-cut pass

The final pass freshly covered every one of the 148 changed files and every modified-file diff hunk. Its four disjoint receipts cover 142 text files and six SHA-pinned binary assets, with the preserved untracked generator counted separately. The union audit also confirms 148 unique paths, no missing paths, on each of passes 1–4. Source hashes and range audits show no gaps, overlaps or head drift. No viable behavior-preserving, scope-preserving, comment-preserving reductions remain.

Pass 4 made no tracked edits. Final metrics are identical to pass 3 above and were measured again immediately before publication. All reduction agents finished; no reduction or validation child process remains active. The tracked worktree is clean at `776d2274b39e40f5a4969f3d5de3f0f15da73c32`. The owned temporary `trim-codex.md` plan was removed after this final iteration. The durable report and ignored complete-read/validation receipts are retained locally and excluded from the PR.

## Preserved actual-app evidence and limits

Prior real-editor validation used headed Chrome at `http://localhost:43124/` on the Apple M4 Max. Exact directional pruning delivered 75 frames instead of 222 and made 298 graph calls instead of 886, preserving the 20,990-voxel selected mask and all 111 Add marks. Wall time was 8 minutes 25 seconds on a shared busy machine, not a controlled speedup result. The pre-cleanup runtime is represented by `a8556b0`; later cleanup does not change model/pixel math. Private receipts retain exact hashes, output equality, cancellation, reload and per-image visual audits.

Source texture and selected boundaries were inspected in the actual app. Browsing changed real canvas pixels without restarting prediction. Metadata undo/redo, cancellation and full reload preserved marks and mask; an earlier workflow separately covered geometric undo/redo. Saved-output replay of another example is adapter/geometry/postcondition evidence, not a new model/browser/anatomical test. Historical yellow labels are user-disputed, not authoritative ground truth.

The offline ZIP had a byte/hash/mode/privacy audit and cold empty-state browser check at `http://127.0.0.1:43125/` with external page requests blocked. Cold packaged import/model execution remain unverified because the supported file chooser returned `Not allowed` on two valid attempts. No access-control workaround was used. This smoke limitation is preserved in the public description, not replaced by Storybook.

Ten React Doctor advisories remain: nine concern intentional cooperative CPU-loop yields and one concerns the selection editor's size. Existing React test `act(...)` warnings and Vite's large-main-bundle warning remain. Neither a peak-RSS benchmark nor independent clinical/anatomical acceptance is claimed.

## Final clearance and merge

All four TurboVac stages completed in order. The final public head is `776d2274b39e40f5a4969f3d5de3f0f15da73c32`. Both description passes preserve valid prior evidence and reject Storybook. The second scopes browser/ZIP evidence to the pre-cleanup candidate, updates the Doctor warning count, and reports the exact final-head standard checks. No MRI-derived media was published.

The shared REST quota briefly blocked access; the server returned a reset of 06:59:01 UTC. After that reset, the full Hall Monitor sweep completed at 06:59:07 UTC. The PR rollup, `gh pr checks`, raw head check runs and legacy status contexts agreed: `Vercel` and `Vercel Preview Comments` both succeeded. The one top-level comment was a non-actionable Vercel bot deployment update. There were no submitted reviews, line-level review comments or review threads; the thread connection reached `hasNextPage: false`. There were no open human or bot items, CI failures, disagreements or conflicts. No manual review was triggered and Cubic was not treated as a gate.

Review-fix pushes after the second Clean PR: **0**. Bot replies: **0**. The owned fallback watcher was stopped through its recorded process session and its exit was confirmed immediately after clearance. No other watch or service was stopped.

The authorized normal merge used an exact-head guard. GitHub reports PR #10 **MERGED** at 2026-08-30 06:59:33 UTC, with merge commit `5f0efa433b6c8b6672add9a30184ec1140b2b5a3`. A fresh fetch confirms that `origin/main` contains the verified head and has an identical tree. The local branch/worktree is preserved at the tested head; no branch deletion, checkout, reset, squash or amend occurred. The tracked worktree remains clean, private/untracked artifacts remain intact, and the primary Chrome process plus local ports 43124 and 43125 remain running.

The remaining product/evidence limitations are those above: high interactive latency, ten Doctor advisories, large bundle warning, no independent full-volume anatomical acceptance, and blocked cold packaged import/model execution. They are disclosed limits, not hidden green checks.
