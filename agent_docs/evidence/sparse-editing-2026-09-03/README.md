# Sparse editing: implementation and acceptance

This closes the three dense-work boundaries in [audit finding F3](../../exec-plans/active/2026-09-01-full-codebase-audit.md#f3-sparse-editing-is-not-sparse-through-painting-and-persistence): pointer painting, label ownership and durable writes. It does not close the larger audit.

## What changed

- Editing panes retain calibrated grayscale and composite annotations at native resolution. Brush drafts accumulate new cells and paint once per animation frame, without copying the accumulated stroke or rebuilding grayscale.
- The selection hook owns a working mask, publishes revision-specific views and keeps immutable sparse undo patches. Hydrated or asynchronously borrowed labels copy on the next changing edit. Original-detail callbacks borrow before receiving labels, not after starting their work.
- The existing sparse patch also updates label counts, selected bounds and GPU dirty regions. Consecutive edits combine their pending GPU region rather than losing an earlier unpublished edit.
- Database schema 8 stores a revisioned metadata head and nonzero 4 KiB label chunks. Completed edits capture their payload before yielding and commit touched chunks and metadata atomically. Dense changes use checkpoints. Legacy dense records remain readable and migrate on intentional edits.
- Save failures retain the visible draft. A retryable failure can checkpoint against the last acknowledged revision. Dataset/revision conflicts offer **Discard edits and reload**, not a retry that overwrites newer saved work.

Hard marks are still saved exactly; their payload is reported separately below. Backup compatibility is unchanged. This work does not implement large streaming backups or migrate all historical reconstruction identities.

## Exact source and fixture

The baseline is merged commit `e84e208264431164eeeb627c544fc38e62db1155`, with source fingerprint `526789ca62d20cd3870ea065558d589c8f16ec199897e54d6da1e582bcaeb4fa`. Its original generated bundle had already been released and was unavailable. A fresh archive of that commit was checked against the retained source/model fingerprints and rebuilt; no baseline application code was changed.

The candidate was an uncommitted working tree based on that commit, source fingerprint `e719d61c4eb8357201da974c126053978bd8c3dd6135036d3f61a25822ce43f9`, application fingerprint `fc6b134fe710e15cdeca27e33c01895a6a8b98d8da3c035ae730dd4bddf4f7ca`. A commit identifier alone would not distinguish those builds. The shared pinned model-manifest fingerprint is `5662be7768cef65140ce885dde9099fb16c0e64f0b90927d79ef8a9461aa725c`.

Both were normal production builds, without browser-test probe entrypoints, served at `http://127.0.0.1:43134/` to isolated headed Chrome `152.0.7977.82`. The same checked-in harness imported one synthetic 256 × 256 × 128 native acquisition, opened the ordinary 3D editor and disabled Auto-fill. After one unmeasured warm-up stroke, it made five 40-step Add/Remove gestures, then Undo and Redo. The mask was 8 MiB; no inference or patient data was involved.

Source fingerprints were unchanged throughout each run. Owned browser/server resources closed and port 43134 was released. Physical generated bundles and the archived baseline source were preserved, not deleted.

## Measured work and parity

See [comparison.json](comparison.json) for exact inputs, raw-receipt hashes, per-operation counts and timing distributions.

| Across seven measured edits                    |            Baseline |       Candidate |
| ---------------------------------------------- | ------------------: | --------------: |
| Pointer events during gestures                 |                 210 |             210 |
| Draft ImageData allocations                    |                 205 |               0 |
| Commit ImageData allocations                   |                  27 |              21 |
| Whole-mask `Uint8Array.slice` calls            |                   7 |               0 |
| Label bytes submitted to IndexedDB             | 58,720,256 (56 MiB) | 36,864 (36 KiB) |
| Hard-mark bytes submitted                      |              57,184 |          57,184 |
| Completed save transactions                    |                   7 |               7 |
| Failed save transactions                       |                   0 |               0 |
| Mean input-to-canvas-command time              |            7.828 ms |        0.390 ms |
| 95th percentile, input-to-canvas-command       |            8.205 ms |        0.275 ms |
| 95th percentile, input-to-next-animation-frame |           10.420 ms |        9.440 ms |
| Observed long tasks during measured edits      |                   0 |               0 |

Label writes fell by **99.94%** for these sparse edits. Each candidate edit wrote one or two chunks; Undo could also delete an all-zero chunk. Full mask copies remain valid for borrowed-input protection, dense proposals and explicit checkpoints; zero here is not a claim that the application never makes a full copy.

Every measured saved mask hash, hard-mark index, review state and source key matched the baseline. Undo restored the preceding saved state and Redo restored the final one. Choosing Done, reloading and reopening preserved the reviewed result. Exporting and restoring into a fresh browser context preserved the same durable mask and marks. The final 702 × 285 canvas hash matched exactly: `7c09e5340731c36330885874d6ae51af16107bfa528e75c1e0604ca240f58bac`.

Timing starts in the document's pointer-event capture listener and ends at a canvas command or the following animation-frame callback. It is **not physical screen-presentation latency**. Coalescing yielded 207 candidate paint samples versus 210 baseline samples. These are one baseline/candidate workflow pair, not a hardware-wide frame-rate or clinical-performance claim. The end-to-end workflow times include import, export and setup and are not used as an editing-speed comparison.

Process RSS was sampled every 500 ms over each complete browser workflow. Aggregate observed maxima were 2,235,328 KiB for the baseline and 2,100,528 KiB for the candidate. They include shared pages and browser infrastructure; they are neither unique retained editing memory nor a guaranteed instantaneous peak. The cached rasters trade some steady-state memory for less repeated work, and their allowance is included in heavy-operation admission.

## Regression and failure coverage

TypeScript and ESLint passed. Seven focused files passed **373 tests**, including:

- Exclusive working-buffer reuse, borrowed-snapshot preservation, hard marks and exact undo/redo.
- Native raster reuse during long gestures and retained editor-memory accounting.
- Immediate capture before asynchronous save, queued revisions, metadata-only saves and dense checkpoints.
- Atomic rollback after a late preimage conflict or a second-chunk quota failure; successful retry without partial writes.
- Real schema-7 upgrade, first-edit migration, missing-chunk rejection, dataset/source/revision fences and compatible backup restoration.
- Visible distinction between retryable persistence failure and a newer saved dataset/revision.

All **six existing normal-production browser workflows passed** in 44.1 seconds. [workflow.json](workflow.json) records their source identity and results: real custom-model execution and saved draft, cancellation/replacement, import/navigation/outline/reopen/backup, acquisition/date collision ownership, exact alignment replay, cold/warm visible-pair ordering and failure context at desktop/mobile sizes.

The direct original-detail callback regression first failed: retaining its input and editing again changed that input before downstream preparation ran. Borrowing at callback handoff fixed the owning boundary. Earlier failed unit attempts are retained locally; a stale display-effect wait and missing snapshot mocks were corrected without weakening their product assertions.

Two baseline-build setup failures are also retained: buffering the public LFS archive exceeded a harness limit, then a `/var` versus `/private/var` root mismatch broke Vite's emitted HTML path. Streaming the archive and canonicalizing its filesystem root fixed the setup. Neither required candidate application changes or invalidated its completed browser evidence.

The [complete default unit suite](unit-suite.json) passed **3,183 tests**, with zero failures and 54 existing skips, at the same unchanged source fingerprint. Private anatomical suites remain separate. Pixel equality, DOM checks and durable state are not a new aesthetic or anatomical sign-off; Storybook was not used.

## Reproduction and preservation

The candidate test is in `frontend/tests/browser/performance.spec.ts` and uses `selectionEditingWorkflow.ts`. The normal repository command is `npm run build:browser`, then `npm run test:performance -- --grep 'sparse brush edits'`. Keep `PLAYWRIGHT_HTML_OPEN=never` and a non-HTML reporter for direct Playwright commands.

Ignored raw receipts and synthetic archives are retained under `artifacts/performance/audit-sparse-editing-2026-09-03/attempt-01/`. The authored baseline builder, isolated runner and configuration remain under `frontend/tmp/`; original failed logs remain there as well. The public files here omit machine-local paths and contain only synthetic/aggregate evidence. Canonical MRI, private models, saved marks and original receipts remain protected.
