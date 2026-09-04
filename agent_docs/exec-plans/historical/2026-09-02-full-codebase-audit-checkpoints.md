# Historical audit implementation checkpoints

This is a frozen pre-remediation history, not current status. See the [current ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

# Full-codebase audit implementation

Status: **in progress**. This is the implementation/evidence ledger for the
[September 1 audit](../active/2026-09-01-full-codebase-audit.md), not a replacement or a
reduction of its scope. The user requested the audit be implemented fully.

## September 3 review remediation

The user requested implementation of the [CTO review](../active/2026-09-03-cto-architectural-review.md),
excluding PR splitting. Its finding numbers below are prefixed **CTO** to distinguish
them from the original audit. This is one remediation branch, not a PR-splitting exercise.

The design is to bind persistence to verified source ownership at hydration, keep
browsing available without write authority, and prepare heavy imaging work through
the existing imaging context. Exact acquired pixels must remain independently
selectable from blended anatomy. Remove redundant mechanisms rather than add a
parallel settings, memory, or request authority. Preserve private inputs and original
evidence; use synthetic data for new verification.

| Findings | Work | State |
| --- | --- | --- |
| CTO1, CTO5, CTO12 | Read-only snapshots, verified source writes, usable ephemeral browsing | In progress |
| CTO2, CTO8, CTO11, CTO17, CTO21, CTO22 | Exact acquired-plane mode, DICOM window parity, contained errors, ray termination, honest oblique classification | Pending |
| CTO3, CTO6, CTO23 | Device-derived custom-model budget and one heavy-operation preparation owner | Pending |
| CTO4, CTO14–16 | Stable pending-image children, filmstrip keyboard ownership, navigation reference, pending decode reuse | Pending |
| CTO7, CTO18–20 | Stable alignment request identity and worker cleanup; remove unused image-producing runner | Pending |
| CTO13 | Patient-scoped backup application state | Pending |
| CTO9, CTO24 and repository hygiene | Current architecture/status, capability notes, browser typechecking, private/generated artifact boundaries | Pending |
| CTO10 | Review explicitly refuted the proposed dataset-token race | No change required; retain transactional token initialization |

Implementation and acceptance results will replace the pending states here. Previous
receipts below describe their recorded source fingerprints, not proof of this new tree.

## Contract and starting state

Keep local-only scan processing, native image fidelity, source/geometry ownership,
hard Add/Remove marks, exact undo/redo, saved work across remounts, and honest
resource/cancellation states. Imported private MRI fixtures stay private and
untouched. Use synthetic fixtures for reproducible checks. Preserve genuinely
reachable compatibility, especially the single-frame alignment route.

Started from HEAD `5f0efa433b6c8b6672add9a30184ec1140b2b5a3` on
`blader/siqi-chen/segmentation-sampled-plane-pruning`. The tree already contained
46 tracked changes and untracked EfficientTAM v2 assets, tests, plans, and visual
evidence. These are input to this work, not changes to discard or claim as ours.
The original audit records the pre-implementation code fingerprint and checks.

The baseline passes lint, typecheck, model-asset verification, and production
build. The full unit run has one reproducible whole-file failure in the
save-after-boundary-suggestion workflow; a filtered pass is not sufficient.
Previous browser automation reached only the empty shell. Populated-browser,
hardware GPU, real-model, and large-backup evidence remain outstanding.

## Design and sequence

Reuse the existing source, worker, storage, and request owners. First establish
reliable completion evidence and remove bounded waste. Then change ownership
boundaries, extending existing tests at each boundary. Do not add a second cache,
state authority, or compatibility route where the existing one can own the fact.

The order is: workflow failure and key-only derived storage; shipped-browser
harness; explicit capabilities and obsolete-path removal; alignment scoring and
content identity; startup/host parity; stable study/acquisition identity and
metadata upgrades; bounded interactive/custom-model workers; sparse editing and
persistence; streaming/staged backups; measured warm rendering; full acceptance.
Some checks span several findings and are recorded once with their exact inputs.

## Requirement and evidence matrix

No row is complete until both implementation and its applicable acceptance
evidence are recorded. Conditional optimizations require measurements and an
explicit decision, not silent omission.

| Finding | Required change | Acceptance still required | State |
| --- | --- | --- | --- |
| F1 | Exact coverage-only reverse scoring; final-only scoring on the existing worker; preserve accepted physical pose on optional failure | Transform/coverage parity, abort and stale-result protection, browser main-thread and total-completion measurements | Implemented; focused and real-worker evidence retained. Latest whole-suite gate has two separate timeout failures; see refresh checkpoint |
| F2 | Accepted-source metadata/intensity lifetime; constant-time source generation checks; phase timing; bounded reusable model worker with explicit idle expiry and fresh per-run state | Two corrections measure source once and reuse sessions; changed source invalidates; cancel releases before replacement; exact masks/marks, peak memory and complete-correction time | Source context/range now retained; 139 focused tests pass. Phase timing added; retained-session ownership and measured peak/correction acceptance remain |
| F3 | Separate grayscale and editing layers; rAF brush updates; carry sparse patches to durable storage where representative measurements justify it | Gesture raster/copy/write counts and pointer-to-paint timing; exact undo/redo, hard marks, remount and GPU behavior | Pending |
| F4 | Key-only eviction; indexed patient/revision/sequence/series hydration before payload reads | Exact retained IDs, zero eviction payload reads, relevant candidates only, malformed/source rejection, representative large-frame check | Implemented; focused and 160-MiB browser evidence retained. Latest whole-suite gate has two separate timeout failures |
| F5 | Shared export/restore admission and cancellation first; then bounded streaming export and durable verified restore staging with atomic publication | Below/above-512-MiB and multi-GiB synthetic round trips with all saved work/models; memory, corruption, quota and pre-publication cancellation preserve previous dataset | Pending |
| F6 | Stable Study UID identity, visible acquisition candidates and persisted choice; source-owned settings; conservative legacy migration | Collision and larger-alternative import/reload/source switch/export/restore preserve original intent; ambiguous old settings remain recoverable | Pending |
| F7 | Separate immutable plane content from request metadata; measure warm path; bounded worker-owned rolling slabs/coalescing if justified | Replay avoids raster/synthesis; real changes invalidate; exact pixels/support; completed-plane latency, canceled bytes/work and retained-memory measurements | Exact-replay ownership implemented; 179 focused tests retained and current two-exam browser receipt confirms unchanged raster/worker count through reference pan. Broader warm-path, canceled-work and memory measurements remain |
| F8 | Remove seven unreachable modules, their private protocols/tests/CSS and old viewer capture API; remove unreachable seeded-worker fallback; trim unused ONNX hook surface | Reachability/build/test proof; retain live geometry helpers, custom models, single-frame alignment and genuine compatibility | Production legacy paths removed; 425 focused tests pass; unused ONNX hook surface remains with F13 |
| F9 | Remove unused Cornerstone tools bootstrap after smoke proof; lazy dialogs and measured imaging startup; consistent host isolation/assets | Real pan/zoom/wheel/outline/overlay and compressed-DICOM checks; build size, shell/first-image timing; supported host/offline delivery checks | Pending |
| F10 | Source-derived Auto-fill availability with usable brush-only mode; bounded image loading/error/retry; keyboard shortcuts respect interactive controls | Independent-2D and native editor workflows; timeout/retry/stale-image metadata; keyboard/focus/dialog checks; populated/mobile visual evidence | Core behaviors and long-warning header fix implemented. Normal-build static header checks cover 1440/1024/390 px; one-exam decoder/retry/outline/restore workflow completes. Automated warning test has a selector failure; independent-2D volume-save proof remains |
| F11 | Fix baseline failure; repository-owned synthetic browser, GPU and real-inference commands/receipts; CI release gates; current canonical docs | Whole unit suite, lint/type/build, built-app IndexedDB/worker/asset import-to-restore acceptance; clearly separate software and hardware evidence | Current lint/type/model checks pass; matching production build retained. Latest unit run: 3,102 pass, two timeouts, 54 skipped; focused timeout files: 45 pass. Browser: two completed cases including a real pair, one selector failure. Product selection and CI gates remain |
| F12 | Versioned idempotent stored-geometry enrichment and bounded header recovery; duplicate reimport enriches metadata without replacing source/work | Old-schema upgrade, interruption/retry, true invalidity rejection, preserved ordering/labels/settings | Pending |
| F13 | Worker-owned custom inference with real abort/timeout/disposal and conservative model-session admission | Slow real-model cancellation releases editing/resources; init failure/hang/bad outputs/repeat runs; browser memory evidence | Pending |

## Decisions and evidence

### 2026-09-02: baseline workflow investigation

Temporary stderr traces cover suggestion startup, cancellation, source/label
ownership reset, result receipt, component filtering, publication, and durable
submission. The entire viewer test file is the reproducer; changing the expected
mask or relying on an isolated test pass is not an acceptable repair. Traces must
be removed after the cause and fix are verified.

Four complete viewer-file runs and the subsequent full suite passed the original
case under tracing. The traces showed seeds `[941]`, result `[941,942]`, connected
mask count 2, publication, and then persistence of both voxels. Cancellation
aborted the controller and rejected the late result before publication. No mask
corruption was observed, and the original timing-sensitive failure was not
reproduced under instrumentation. The test had synchronized on an enabled control
before reading a save owned by a separate passive effect. Its final assertion now
waits for that saved mask directly; all error/cancel assertions remain. This is a
test synchronization repair, not a claim of a proven production segmentation bug.
Temporary traces were removed and an `rg` check found none in source/tests.

### 2026-09-02: derived-frame storage

`saveDerivedAlignmentFrame` now prunes creation-ordered primary keys, not records.
Database version 7 adds the compound patient/revision/sequence/series index;
hydration passes the active source set to the storage API before loading pixels.
Examination-specific clearing also walks index keys. Existing display admission
still validates candidate pixels and source provenance. The schema migration
indexes old records without rewriting their image data.

Focused verification: `npm run test -- tests/storageIntegrity.test.ts
tests/db.test.ts tests/derivedAlignmentFrame.test.ts
tests/SvrVolume3DViewer.test.tsx --maxWorkers=2`: **199 passed, 4 files**.
New assertions cover key-only pruning, exclusion of unrelated/stale payloads,
rejection of malformed selected data, empty source selection, and schema upgrade.
The first full run after this change passed the viewer case and found three
storage-test assumptions (cross-realm typed-array equality twice and a hard-coded
future database version); these were corrected in the focused rerun. A final
untraced whole-suite pass remains required.

### 2026-09-02: browser acceptance boundary

The new harness uses a disposable Chromium profile and a dedicated strict-port
preview; it cannot attach to the user's existing MRI storage or reuse another
workspace's service. An acceptance-only build emits the app and synthetic probe
entrypoint. Normal/offline builds omit probes. A source/model fingerprint guards
against testing stale output. Workflow receipts and screenshots identify the
synthetic fixture and browser; GPU receipts distinguish pixel correctness from
hardware performance. Browser results are not yet claimed.

The first workflow run imported all synthetic files and reached the comparison
surface, but its visible-anatomy assertion stopped on slice 1/24. That synthetic
edge plane is outside the phantom. The harness must explicitly navigate to an
interior slice before its pixel assertion; no production renderer defect is
established by this failure. Saved/inspected source:
`artifacts/visual-validation/audit-implementation-2026-09-02/initial-synthetic-slice.png`.
Its static shell is legible and unclipped; populated-image judgment is BLOCKED
until the intended interior plane is exercised.

### Resolved pause: browser cleanup

The isolated Playwright browser and strict-port preview are closed. A scoped
process audit found no remaining Playwright browser process and no listener on
43134. However, the earlier audit's Chrome tab `1997590267`, title `MiraViewer`,
URL `http://127.0.0.1:43134/`, remains listed in group
`🔎 MiraViewer audit cleanup`. The supported connection lists it but both close
and exact-tab reclaim time out. Chrome-running, extension-enabled, and native
host diagnostics all return success. No other user tab or profile was changed.

At the pause, cleanup was **BLOCKED** — current batch CLEAR; stale owned tab NOT CLEAR;
preservation CLEAR. The visual-validation skill requires that stale owned tab
to be closed before implementation or another visual batch continues. The user
was asked asynchronously to close that exact tab. Do not work around the broken
connection with AppleScript, profile changes, or broad process termination.

On the resumed goal turn, fresh Chrome tab listings showed both the exact tab
and the stale-owned set empty. The session tab list, Playwright process audit,
and port-43134 listener audit were also clear. **Cleanup CLOSED** was reported;
user and other-worktree browser state was preserved. The workflow now explicitly
selects an interior phantom slice and exercises plane changes. New isolated
browser launches carry a worktree/run ownership marker. The full F1–F13 objective
remains active; a partial implementation or green focused suite is not completion.

### 2026-09-02: retained workflow and final-ranking evidence

The built-app synthetic workflow now passes: 72 DICOM files, interior-slice and
plane navigation, pointer pan, compare/overlay switches, native polygon save,
reload/reopen, download, and restore in a fresh isolated browser database.
The restored studies, instance count, outlines and panel settings equal the
snapshot taken at export. This is **one examination**, not a two-exam alignment
or a complete large-backup acceptance. Durable receipt:
[workflow-receipt.json](../../../artifacts/visual-validation/audit-implementation-2026-09-02/workflow-receipt.json).
Desktop inspection found misleading post-save feedback; the outline now derives
its saved state from the committed geometry, hides the duplicate draft, disables
redundant Save, and retains draft undo. The existing annotation suite covers
the deferred commit and undo. The mobile screenshot still exposes clipped
plane/sequence context beside the sharp-slice control; that UX issue is open.

Final physical refinement uses a final-only operation on the existing scoring
worker. It copies UI-owned inputs before transfer, terminates on abort/deadline,
and leaves accepted physical geometry intact when optional scoring fails.
Reverse scoring computes only coverage, reusing the same support/exclusion/
resampling rules. The worker emits a start phase and performance mark, without
resetting its deadline, so cancellation can be checked after ranking actually
begins. **142 tests in six focused files pass** (scorer, coverage, selector,
physical/confidence routes and annotation keyboard ownership).

The browser performance build has source fingerprint
`f91f34fa8c51ad5c8cdc1bf353761b28353a379abaebbd22bbdf0dcf912d0ae8`.
Chromium 151.0.7922.34 executed the actual built module worker. Two 256-square
inline calls took 170.9/142.3 ms, with zero animation callbacks and maximum
timer gaps of 171.6/142.5 ms. Two fresh-worker calls took 217.5/209.9 ms,
allowed 27/26 animation callbacks and had maximum timer gaps of 4.6/5.0 ms.
Outputs were exactly equal. **This demonstrates responsiveness, not a total
completion-time speedup.** A 512-square ranking was canceled after worker entry;
the caller rejected in 1.5 ms, all three workers closed, and display input buffers
remained attached. The trace locates ranking on worker threads distinct from the
renderer main thread. It is a scoring-boundary probe, not a complete multi-exam
alignment benchmark. Receipts:
[final-scoring-receipt.json](../../../artifacts/performance/audit-implementation-2026-09-02/final-scoring-receipt.json),
[Chrome trace](../../../artifacts/performance/audit-implementation-2026-09-02/final-scoring-trace.json.gz).
The earlier Node before/after parity probe retained 22 exactly equal outputs;
its 59–61 ms candidate versus 103–112 ms baseline timings follow 18 warm-up/parity
calls, so they must not be compared to the audit's cold Node numbers.

The actual browser IndexedDB probe wrote 32 1024-square float/support frames
(160 MiB). The old bookkeeping query materialized all 160 MiB; the production
33rd-frame save read **zero retained pixel payloads**, used one key query, and
retained precisely frames 1–32. The previous patient-wide hydration query read
160 MiB in 83.5 ms; the selected sequence read 40 MiB in 61.1 ms including full
validation, and switching to another sequence read 40 MiB in 48.1 ms. These are
one-sample operation timings and actual cloned payload counts, **not peak RAM**.
[derived-storage-receipt.json](../../../artifacts/performance/audit-implementation-2026-09-02/derived-storage-receipt.json).

The repository GPU command also passed all **22** production-shader pixel checks.
Its renderer is ANGLE/SwiftShader: software pixel evidence only, not hardware
performance or clinical/anatomical acceptance.
[gpu-receipt.json](../../../artifacts/performance/audit-implementation-2026-09-02/gpu-receipt.json).
Both isolated launches exited cleanly; scoped process/profile and preview-port
checks were clear before continuing implementation. All private fixtures and
user/other-worktree browser sessions remain untouched.

### Causal checkpoint: pan gestures and nested recovery controls

The first real decoder-recovery capture is statically legible, but the live
workflow cannot activate Retry. The retained Playwright trace repeatedly reports
`element is not enabled` for that button. The pan wrapper has `role="button"`
and inherits `aria-disabled=true` while a new native image is pending; its nested
recovery control consequently becomes disabled too. Unit `fireEvent.click` did
not exercise this native/ARIA admission boundary. The decoder timeout, previous
pixel retention and source-label work remain useful; retry acceptance is false.

Classification: **structural mismatch** between a multi-control viewport and
single-button semantics. Alternatives are a separate portal-based recovery host,
per-control disabled-state overrides, or making the existing viewport a group.
Choose the group: retain the existing focusable pan/Enter handlers and their
availability checks, remove inherited disabled/button semantics, and let nested
controls own their keyboard events. This removes the need for a special global
shortcut exemption rather than introducing another DOM/state owner. The cost is
updating selectors that asserted the old role; native mouse and keyboard behavior
must remain unchanged. Falsifier: real Retry activation or viewport pan/Enter/
Space fails after the boundary change. Do not force-click or weaken the check.

Next proof: the same built-app corrupt-frame → retained image → keyboard Retry
workflow, then annotation/save/reload/restore and focused pan/keyboard tests.
The first run was intentionally interrupted after diagnosis (exit 130); its
browser/profile/server were closed and both scoped ownership sweeps were clear.
Evidence: [capture and failure receipt](../../../artifacts/visual-validation/audit-recovery-2026-09-02/recovery-capture.json),
[disabled-Retry trace](../../../artifacts/visual-validation/audit-recovery-2026-09-02/retry-disabled-trace.zip).

### 2026-09-02: obsolete paths and explicit selection capability

Removed the seven proven unreachable source modules (3,108 physical lines), the
private capture/display-wait/decoded-frame ref API, orphan threshold CSS and tests
specific to the removed feature. Current pan/zoom/annotation and accepted-image
regressions remain; tests now inspect displayed pixels/metadata rather than a
test-only imperative handle. Persisted old segmentation metadata and archive
compatibility remain intact.

The selection hook no longer owns a second solver, worker, copied source cache,
or result-shape branch. It uses the existing `SelectionProposer` contract, or
brush-only editing when no proposer exists. The accepted independent-2D source
does not expose the incompatible native proposer. Auto-fill is visibly disabled
with a specific explanation; direct marks, review and history remain available.
Shared voxel geometry lives in `voxelGeometry.ts`; the retired seeded solver is
explicitly in `tests/helpers/legacySeededVolume.ts` for research comparisons,
not an application fallback. Its portable snapshot contract is retained.
The old worker implementation/protocol tests were retired; relevant hard-mark,
history, cancellation, support, enhancement and persistence tests use the current
proposal contract. The full focused retirement batch passed **425 tests in 12
files**. A fresh TypeScript import/worker graph finds **175 source modules,
all 175 reachable**, and no application reference to the retired solver.
The smaller unused custom-ONNX hook surface is still due with F13.

### 2026-09-02: image recovery, keyboard ownership and responsive context

Native image lookup and decoding share the existing 10-second/30-second bounded
operation primitive with alignment capture. Failures retain the prior image and
its label/transform, state which requested slice failed, and offer local Retry.
Retry evicts only that failed/in-flight decoded cache entry. Late completions are
discarded; annotations for a new slice are not mounted over the prior pixels.
The viewport is a focusable group rather than a disabled ancestor button, and
its Enter handler acts only when the viewport itself owns focus. Global compare
keys leave controls, editable content, dialogs and consumed events alone; Space
no longer blurs the focused element. Window blur still releases hold-to-compare.

After the real-browser failure described above, the unchanged corrupt-frame
reproducer succeeded with **native Enter activation of Retry**, then completed
annotation, reload and fresh-context backup restore. The focused recovery/
navigation batch passed **172 tests in eight files**. The initial two new test
failures were fixture synchronization/selection issues: the decoder deadline
must start after its lookup commits, and a populated reconstruction has different
action text. Neither deadline nor assertion about displayed image ownership was
weakened to resolve those tests.

The mobile context rail now separates secondary display/alignment controls from
the selected plane/sequence. The final synthetic workflow passed, including DOM
checks that both context values fit at 390 × 844. Mobile and desktop screenshots
were individually inspected at original resolution and reported immediately.
Both passed their static context/annotation scope; the long synthetic patient
name remains ellipsized, and no hardware/motion/anatomical claim is made.

Latest browser source fingerprint:
`8f9da42a6c1074050a9b7695646864802a8279a1d41a19deeb1db06047a3e545`.
Receipt and inspected artifacts:
[workflow](../../../artifacts/visual-validation/audit-mobile-2026-09-02/workflow-receipt.json),
[mobile](../../../artifacts/visual-validation/audit-mobile-2026-09-02/restored-mobile.png),
[desktop](../../../artifacts/visual-validation/audit-mobile-2026-09-02/annotated-desktop.png),
[assessment](../../../artifacts/visual-validation/audit-mobile-2026-09-02/visual-assessment.json).
Every isolated browser/profile and preview server in these batches closed;
current and stale-owned sweeps were clear.

### 2026-09-02: broad regression follow-up

The first post-recovery full run finished with **3 failures, 3,090 passes and
54 skips**. The import test waited for entry into the ingestion mock, before the
refresh callback and React completion commit; it now waits for visible completion.
The visual-system test required the retired rule hiding selected plane/sequence
when notices are present; only that obsolete assertion was removed. Existing
notice-accessibility checks and the real mobile fit proof remain. The unchanged
512-square, 221-frame native-source budget case timed out under the full run,
then passed in the complete owning file. No timeout, dimensions, fidelity or
production behavior was weakened. All three owning files pass (**83 tests**),
and lint passes. The unchanged, two-worker full-suite rerun then passed:
**3,093 passed, 54 skipped; 167 files passed, 6 skipped; 147.46 seconds**.
Private-corpus environment opt-ins were excluded. This is the clean checkpoint
before the F2 source-lifetime changes below, not final validation of all F1–F13.

### 2026-09-02: repeated source preparation

F2 retains one source context with the accepted source, not one per correction.
The context owns detached immutable metadata and only a successfully
completed full-acquisition intensity range; it does not own decoded pixels or
per-job memory measurements. Plan/load operations receive freshly measured
residency. Source identity is validated at the operation boundary, with
constant-time owner/cancel checks inside the frame loop and live database checks
before publishing the range. Caller metadata changes still reject the result;
snapshots prevent mixed-frame interpretation while a scan is in flight.

The **139-test** source/context/workspace batch passes. Two successive proposals
read the acquisition range once, perform fresh budget admission, and recompute
the range after an accepted-source change. Getter-count checks on 16/64-frame
sources bound metadata visits linearly rather than quadratically. Existing
signed-intensity, padding, aborted-decode, changed-owner and source-geometry
checks remain. The initial JSON-based snapshot normalized negative zero; the
snapshot uses `structuredClone` instead, retaining exact metadata values.

Model creation and execution now emit completed-operation timings for runtime
loading, each verified asset load, each graph initialization and each graph run.
The existing progress path transports these measurements. The **372-test**
model/controller/worker/proposal batch passes, including observer interruption
cleanup. These are measurements of completed phases, not estimates of browser
peak memory or a claim that model sessions are already reused.

Retaining sessions changes the source-assembly, publication and enhancement
memory overlaps: their existing policies assume the model worker has been
released. Keep the disposable lifecycle until retained-session residency,
expiry and transitions to other work have a coherent budget and proof. The
new real-model browser check establishes actual initialization/execution
timings, verified offline-asset use and cancel/recovery before that change.

### 2026-09-02: real-model browser execution baseline

`npm run test:inference` now owns a real Playwright test, not an empty project.
The built app's modules perform production memory admission and run the pinned
EfficientTAM v2 model in the actual disposable tracking worker with one WASM
thread. A 32 × 32 × 3 synthetic texture and two conditioning planes exercise
preparation, all four graphs, and both final directions. The first run completed
all four outputs; a second run canceled after a real encoder completed; a third
fresh worker recovered and returned exactly matching native-logit hashes with
model-download URLs blocked. All model bytes came from the verified local cache
on the latter runs. No graph output or model session was mocked.

The test passed in **21.0 seconds**. Source fingerprint:
`97e31f555cc433c9d35c3bebdc7fac13608509e1995a61e85c26764ec9885be0`.
Chromium 151.0.7922.34, model manifest SHA
`5662be7768cef65140ce885dde9099fb16c0e64f0b90927d79ef8a9461aa725c`.

| Measured operation | First asset load | Cached-asset recovery |
| --- | ---: | ---: |
| Complete worker call, including source/output exchange and disposal | 9,766 ms | 4,349 ms |
| Verified asset loads, summed | 5,409 ms | 62 ms |
| Four session initializations, summed | 1,078 ms | 972 ms |
| Encoder graph calls, summed | 1,595 ms | 1,610 ms |
| Decoder graph calls, summed | 132 ms | 138 ms |
| Memory-encoder graph calls, summed | 270 ms | 280 ms |
| Memory-attention graph calls, summed | 1,115 ms | 1,125 ms |

The cached run still creates all four sessions. Its faster completion is an
asset-cache comparison on the same implementation, **not a session-reuse speedup**.
Cancellation rejected in 0.33 ms after the request, and all three worker-close
events were observed. This proves cancellation after initialized inference, not
inside an uninterruptible graph call. The 1,120,972,944-byte admission value is an
**estimate, not measured peak memory**. Source buffers remained attached and
unchanged; animation callbacks continued during execution.

All raw binary masks were empty on this synthetic fixture. Consequently this is
an execution, transport, cache-integrity and recovery gate—not useful anatomical
segmentation or saved-product-selection acceptance. Those distinctions remain
explicit in the receipt and open F2/F10/F11 gates.

[Inference receipt](../../../artifacts/performance/audit-source-inference-2026-09-02/attempt-01/inference-receipt.json),
[terminal log](../../../artifacts/performance/audit-source-inference-2026-09-02/attempt-01/playwright.log),
[cleanup receipt](../../../artifacts/performance/audit-source-inference-2026-09-02/attempt-01/cleanup.json).
Cleanup **CLOSED**: browser PID 86696 exited, its isolated profile was removed,
no owned browser remained and port 43134 had no listener. User/private MRI and
other-worktree sessions were untouched.

### 2026-09-02: documentation and current validation checkpoint

The [architecture and validation guide](../../design-docs/miraviewer-architecture.md)
is now the canonical code map and current workflow/resource account. `AGENTS.md`
and the package README point to it instead of duplicating older alignment and
storage descriptions. The old Align All intent file is explicitly historical;
its evidence remains intact. Root/launcher instructions now use the actual
Export menu and explain the current 512-MiB restore/export mismatch, profile/
origin ownership, and local HTTP launcher. Pending mechanisms are described as
pending, including session reuse, custom-model cancellation and hosted isolation.

After the source-lifetime and timing changes, **3,098 tests passed, 54 skipped**
in 173 files (167 passed, 6 skipped), in 137.22 seconds. Lint, production
typecheck, a separate production build and verification of the copied v2 model
assets all passed. The production build contains neither the browser probe
entrypoint/chunk nor a retired seeded-worker chunk. Existing `frontend/dist`
and active services were preserved by building into a new temporary directory.
The production entry chunk is still 2,721 kB raw / 831 kB gzip; F9 remains real
work, not a warning hidden by changing a build threshold.

[Current validation receipt](../../../artifacts/performance/audit-source-inference-2026-09-02/validation-receipt.json)
records the source fingerprint, commands/results, model verification and logs.
This is a clean implementation checkpoint, **not completion of F1–F13**.
The next F2 change must account for idle-model memory beside source assembly,
publication and enhancement before retaining sessions. The current cached-asset
probe attributes roughly 22% of its complete call to session initialization;
that bounded case supports investigating reuse, not claiming a full-volume gain.

### 2026-09-02: resumed original scope and immutable-content replay

The preceding audit turn made progress by producing fresh counterexamples and
checking the live source, but did not implement the remaining original findings.
The September 1 F1–F13 contract remains authoritative; the new September 2 audit
does not replace or silently expand it. The resumed source fingerprint was
`97e31f555cc433c9d35c3bebdc7fac13608509e1995a61e85c26764ec9885be0`.

F7 now uses the existing accepted result's immutable derived payload as the
content identity. Request wrappers and computed settings can change without
reloading/repainting the original or restarting pending/completed sharp work.
The raster cache holds a weak reference to that payload, not the short-lived
request wrapper. A changed payload, calibration, image/source identity or native
index still invalidates the presentation; shared pixel arrays alone are not an
adequate identity. No new cache, pixel hash registry or mutable label owner was
added.

Three new regressions failed on the previous implementation with duplicated
loads/synthesis. The first candidate removed those duplicates but exposed a
remaining wrapper-equality gate that froze updated display settings; the same
content predicate now governs admission and committed-display readiness.
An integration test also treated the raster's weak provenance as a full request
packet. The architecture checkpoint retained the immutable raster contract
instead of adding another cache/provenance field: the test now links the actual
displayed payload to its matching accepted packet when checking manual sampling.
Exact rendered pixels, transforms, calibration and saved offset checks remain.

The ten-file focused batch passes **179 tests**, including pending/settled replay,
calibration-only changes with the same pixel array, same-ID changed pixels,
sharp toggles, pan, source changes, retry, stale work and warm/cold comparison.
Targeted lint and the configured production typecheck pass. The first broader
run exposed a full-module test mock that hid the new pure identity export; it
now mocks only rendering, not the identity contract. No production fallback or
weakened assertion was added to satisfy it.

The synthetic DICOM helper now accepts an examination date for genuine two-date
browser checks. The next proof runs the normal production app with two synthetic
examinations. Rolling native slabs, complete warm-navigation measurements and
the rest of F1–F13 remain open; these focused checks do not close the full goal.

The first normal-build two-exam attempt imported 144 files but correctly refused
an aligned presentation from the original padded phantom. An identity reslice
against the actual decoded fixture has **30.864%** support at slice 12 and at most
**40.895%** on any axial slice, below the unchanged **55%** presentation minimum.
The [identity-admission receipt](../../../artifacts/performance/audit-plane-content-2026-09-02/padded-fixture-admission.json)
reproduces exactly the browser's insufficient-coverage result. This is a fixture
admission mismatch, not evidence of an F7 regression or a reason to loosen the
production gate.

The fixture now also supports omitting PixelPaddingValue, explicitly representing
acquired zero-valued background. A new regression preserves the default padded
fixture's rejection and proves full-FOV admission for the acquired-background
fixture, with identical source pixels and physical geometry. Both fixture tests
pass; the browser replay check remains pending until that supported case runs.
The first [stopped-state screenshot](../../../artifacts/visual-validation/audit-plane-content-2026-09-02/stopped-state.png)
was inspected directly: two acquired images and dates are legible, but the long
alignment warning clips selected plane/sequence context. That F10 visual defect
is recorded, not silently passed. Browser/profile/server cleanup was verified
CLOSED before returning to code.

### 2026-09-02: replay/header evidence and read-only audit refresh

The supported two-examination case subsequently completed real alignment and
sharp display. A native reference-pan gesture changed presentation while keeping
the same sharp image ID, actual canvas raster hash, and worker count (6 → 6).
The current browser-test build records that result at source fingerprint
`c716d913a6812ff76adcdbdb5bb5360855bf4c772db83df9351a114f7f3875f1`.
The earlier normal-build replay receipt retains its own older fingerprint; it
was not relabeled as a current whole-app build. F7's exact-replay acceptance is
now established, but warm navigation, wasted work, and peak-memory measurements
are still open.

The header CSS now gives long notices the remaining row space, and places them
after primary context/options on mobile. Normal-build manual inspection of the
original padded fixture passed bounded header-legibility checks at 1440, 1024,
and 390 px while preserving the expected coverage rejection. At 1024 the open
Scans drawer still overlays part of the image; at 390 the second examination is
below the fold. These are not claims of complete comparison or motion coverage.

The latest three-case browser suite has **two completed workflows and one failed
test**. The warning-layout test's unscoped examination-dates button selector
matches both the header toggle and sidebar Close button. Its first screenshot
shows legible desktop context; the test itself is not passed. Repair the test's
intended-control selection and rerun all three viewports. Existing artifacts and
failure context were preserved.

During the user's subsequent report-only audit request, no production/test code
was changed. All 180 source files were reconciled against full-read coverage;
64 were freshly reread, including all four changed source files. Seven tiny
storage probes reproduced the existing restore, identity, and admission issues.
The refreshed [audit report](../historical/2026-09-02-codebase-audit-next-priorities.md) also
identifies visible-first Overlay scheduling as a concrete next opportunity.
Its A-numbered recommendations do not silently replace or expand F1–F13.

Fresh lint, app typecheck, and shipped model-asset verification passed; the normal
production build matches the current source. The full unit run finished with
**3,102 passed, two five-second timeouts, and 54 skipped** (165 passing, two
failing, six skipped files). The two timeout files then passed all **45** tests
in a focused run with unchanged source and assertions. The timing cause remains
unproven; the focused pass does not clear the whole-suite failure. Private corpus
opt-ins were removed from test environments without logging their values.

Current source, exact result counts, original browser paths, coverage hashes,
and scope limits are retained in
[the refresh receipt](../../../artifacts/performance/fresh-codebase-audit-2026-09-02/refresh-c716d913/validation.json).
Known owned browser/profile/preview sweeps were clear; no user or other-worktree
session was modified. No PR exists for the current branch, and no TurboVac stage,
commit, push, or PR mutation was performed. The full implementation remains in
progress; neither a partial fix nor an audit report completes F1–F13.

### 2026-09-02: F2 runtime ownership checkpoint

Previous goal turn: **progress**. The fresh audit retained current evidence and
changed the next implementation decision; it did not complete F1–F13. This turn
resumes implementation rather than another broad review.

F2's remaining mismatch is structural: successful correction lifetime currently
equals model-runtime lifetime. A new regression reproduced worker termination
after an otherwise complete source/output exchange. The existing serial tracking
controller already releases per-job history, so it can retain compiled sessions
without retaining prior prompts or model proposals.

Decision: refactor the existing worker and accepted-source owner. One runtime may
survive successful jobs; each job gets a separate MessageChannel. Closing that
channel isolates old replies without adding a run-ID protocol to every message.
Hard cancellation/failure still terminates the worker. A 30-second idle deadline,
source invalidation, and incompatible-work admission must reclaim it.

Compared alternatives: retaining one-shot workers keeps recompilation cost;
a global pool/model manager would broaden source/memory ownership; per-job IDs
would work but add protocol state the native channel can own. The chosen design
must still account for retained runtime high-water memory during source loading
and publication, and release it before other heavy operations. The worker edit
alone is not sufficient to enable retention in the normal editor.

Proof required: two completed corrections reuse the same model but fresh history;
late channels cannot affect the next job; source/provider changes, cancellation,
failure, and expiry reclaim the runtime. Then verify two normal-editor corrections,
saved marks/masks, real phase timings, and observed peak memory. Reopen this choice
if useful reuse requires weaker source fidelity, unbudgeted overlap, or a second
competing model owner. No completion claim is made at this checkpoint.

### 2026-09-02: resumed F2 integration after the full fresh audit

Previous goal turn: **progress**. The new full read and synthetic/browser checks
provided current evidence, including the missing live runtime owner. The
September 1 F1–F13 objective remains unchanged; the newer A-numbered report is
evidence, not a replacement implementation scope.

The resumed fingerprint is `c18937dd03909c510e9efb75c60cef2be94499e4a92ad037ebbc0504afb45efe`.
The fresh baseline is 3,095 unit passes, 11 tracking-lifecycle assertion failures,
and 54 skips. Lint/typecheck/normal production build and all three existing
normal-app browser workflows pass. The added 3D brush probe did not finish saved
selection hydration before its 15-second interaction timeout; no brush/durable
selection proof or root cause is inferred from that attempt.

Architecture checkpoint: the transport now retains sessions, but the proposal
wrapper still creates/disposes it per request. This is a structural lifetime
mismatch, not a reason to weaken cancellation assertions. Keep the existing
accepted-source owner and worker; lend the worker to each proposal, retain fresh
job channels/history, and reclaim it on source changes or competing operations.
A global model pool would add a second resource owner and broader invalidation.

Retained high-water memory must cover native loading, later model work, and
publication. Reuse is optional residency, not a new restriction on source
fidelity: release idle sessions before a phase that cannot fit alongside them,
then perform the same admitted correction. Expiry/cancel must remove the charge
only after actual termination. An old signal/channel must not destroy a later
job. No feature cache or extra crop optimization will be added without timings.

Next proof: focused memory/lifetime regressions, two calls through the accepted
source owner, then actual model reuse and normal-editor/save evidence. Reopen
the design if it requires duplicate source authority, unbudgeted overlap, drops
marks/context, rejects work that fits after reclaiming idle memory, or exposes
late replies to another correction. F2 and the full goal remain incomplete.

### 2026-09-02: implementation resumed after the next-priorities audit

The preceding goal turn made progress through fresh source inspection and actual-code
probes; it did not implement the newly demonstrated failures. This turn implements
them. The original F1–F13 scope is retained in full, together with N01–N12 and the
smaller follow-ups in [the next-priorities audit](../historical/2026-09-02-codebase-audit-next-priorities.md).
No row is removed because it is expensive or requires browser evidence.

The pre-change source fingerprint was
`ec49ee531807dd0e2df4d7c0bd8bf9d472a52de52c68ac83a72274f285bb6321`.
At that fingerprint the full unit run passed **3,122 tests, with 54 skipped**;
lint/type/model checks and isolated production/browser builds passed. These replace
the older timeout descriptions above as the last pre-change baseline, not as proof
for subsequent edits. F2 retained-runtime parity and the normal hardware-backed
brush save/reopen receipt are retained in
`artifacts/performance/audit-retained-runtime-2026-09-02/attempt-02` and `attempt-06`.
The hardware brush receipt does not establish learned-editor or multi-GiB acceptance.

**N02 ownership checkpoint.** A settings writer must hold a successful read of the
current saved-work generation. A failed read must not become an empty successful
read. Restore and reset must invalidate already-mounted writers, including unload
and debounce paths. The existing IndexedDB `app_state` transaction is the owner.
Using `dataset_revision` alone was rejected after verifying that ordinary additive
imports increment it for every new instance. A separate application-wide lock or
session manager was also rejected. Instead, a persisted `dataset_token` is created
once per database and rotated in the existing restore publication transaction.
The settings read returns that token atomically with its data; each hook-owned
write checks it in the same transaction as its put. Additive imports do not rotate
it. Existing mutation notifications retire mounted callbacks synchronously, while
the database check also rejects work queued after publication or database deletion.

Implementation now separates successful hydration from read failure, waits for the
replacement catalog before reloading, clears old undo ownership, and adds local
settings/scans Retry controls. Unload flushes only pending progress and changed
automatic baselines; the latter are required to retain the unclipped baseline of
manual alignment intent. An existing regression test caught that requirement when
the first reduction omitted it, and it is preserved. No automatic per-slice durable
write was added.

**Verification so far:** 166 tests pass across the existing hooks, local API,
backup/restore, database, manual-alignment, annotation keyboard, browsing, and
patient-selector suites. New cases exercise failed-read/no-write/retry, additive
import preservation, synchronous callback retirement, atomic stale-token rejection,
mounted real IndexedDB restore, subsequent progress persistence, and clear followed
by a synthetic unload event. These are deterministic jsdom/fake-indexeddb tests,
not browser unload timing evidence. Current built-app retry/restore validation is
still required. The full goal and all remaining F/N acceptance gates remain open.

### 2026-09-02: source-owned settings, acquisition choice and navigation implementation

N01/F6 now has a canonical settings owner in `db/panelSettings.ts`. Settings are
bound to Study/Series UID, while dates and patient grouping remain presentation and
scope metadata. The catalog is one metadata/index-count transaction and exposes all
displayable acquisition candidates. It persists the chosen Series UID instead of
continually choosing whichever series most recently became largest. Conservative
patient selection keeps a Study UID anchor, and volume-label scope checks consult
the actual owning study rather than treating an old grouping string as permanent.
Import and restore now share the Study UID patient-identity conflict policy.

Legacy settings are copied automatically only where examination and acquisition are
unambiguous. Originals remain stored. An explicit Examinations-panel action assigns
ambiguous settings to the chosen acquisition. Source rows, selected acquisitions and
source-bound labels survive the tested isolated-patient backup/restore path. This
does **not** close F6: historical 3D volume-key migration and ambiguity preservation
across selective legacy export still require work.

N09 now stores Overlay selected/previous examinations by Study UID, deriving indices
after filtering. Wheel/footer/playback share the active view's reference count and
offset. The footer identifies its reference and inverts offset/reverse order for
acquired-slice entry. A visible message explains unavailable-selection fallback.
The real stacked-grid touch-scroll acceptance remains open.

The new browser cases use actual binary synthetic DICOM, ordinary production UI,
native pointer pan, IndexedDB, ZIP download and restore. At source
`83d6e89791087147779adc546bb21c03ab151bf097bfe2ef038cbb8f72767be0`, all four
workflow cases passed in **23.8 seconds** with installed headed Chrome. The receipt
at `artifacts/performance/audit-source-ownership-2026-09-02/attempt-02/browser-run.json`
records unchanged source, no remaining owned PIDs/profiles and a free port 43134.
The initial attempt failed in the test harness before app launch because its
web-server cwd was relative to `tmp`; that failed receipt and exact harness are
retained rather than being labeled an application failure.

New browser evidence covers failed-read/no-unsolicited-write/Retry, mounted restore
followed by progress saving, clear followed by a real reload and zero-row readback,
explicit acquisition switching, a later timestamp collision, existing outline and
decoder recovery, two-exam exact replay, and responsive warning context. Individual
original-resolution screenshots were inspected. The recovery and restored-mobile
UI passed, but the acquisition screenshot exposed a newly introduced progress reset.
That reset has been fixed: catalog/source changes preserve shared progress, whereas
patient/sequence or restored-generation changes hydrate saved progress. Both unit and
browser regressions now assert this distinction; a new current build is being checked.

A full unit run after the progress fix passed **3,135 tests, 54 skipped, zero failed**
(`attempt-03/unit-tests.json`, 116.4 seconds). A subsequent bounded regression proved
that recreating an identical source-map object retried a failed read without user
action (two reads instead of one). Hydration now follows its primitive source-identity
key; an effect event reads the latest map without making reference identity a retry
trigger. That guard and the existing settings/manual-alignment/browsing suites pass
**67 focused tests**. The earlier full-unit receipt predates this small guard and is
not represented as an exact-source result for the forthcoming build.

Remaining implementation scope is unchanged: N05 visible scheduling/pose-only output;
F2/F7/N08 bounded warm native preparation; F3/N04 sparse rendering/metrics/persistence;
F5/N03 streaming and staged backup; F9/N11 startup/deletion/delivery; F12/N10 metadata
enrichment and key-first discovery; F13/N06 custom-worker lifetime and full retained
memory accounting; N07 proportional render/upload work; and current CI/release,
ordinary learned-editor and representative-memory acceptance. No goal completion or
TurboVac clearance is claimed by these partial findings.

### 2026-09-02: current source-ownership browser checkpoint and N05 implementation

After the slice-position repair, attempt 03 passed three workflows; the acquisition
test stopped because its baseline had been captured before the existing 200-ms
progress save completed. Its later value was correctly `7/15`, not the baseline's
temporary `0`. The test now waits for that durable value before capturing the
baseline and retains strict whole-row comparison. No production behavior was changed
to satisfy that timing assertion.

Attempt 04 passes **all four workflows in 21.7 seconds**, including explicit slice-8
checks after both source switching and timestamp collision. Source stayed unchanged
and owned resources are **CLOSED**. Current original-resolution desktop and mobile
acquisition screenshots show the acquired phantom and correct position. The prior
failed visual verdict remains in
`artifacts/visual-validation/source-ownership-2026-09-02/inspection-receipt.json`;
it has not been retroactively relabeled. The exact temporary harness and browser
fixture are retained beside attempt 04. These receipts precede N05 below.

**N05 design checkpoint:** preserve the physical reference and every fitting,
confidence, support and native-publication gate. The coarse application's next step
already performs native rendering, so it should request only the existing pose
estimate shape. The shared fitting implementation now optionally renders an image;
the application calls a pose-only worker request, while actual image consumers keep
their image-producing API. No replacement registration algorithm or new pose cache
was added. The worker sends no pixel/support transfer for an estimate.

The UI now passes a separate ordered displayed/compare set. It does not reorder the
stable reference column. Visible targets lead cold scheduling; warm offscreen slabs
cannot run ahead of visible cold work, while zero-work exact replay remains
immediate. Reprioritization changes the request identity and cancels obsolete work.
Remaining offscreen work retains the quiet interval; visible cold work after replay
yields to the event loop without an additional 650-ms wait.

Initial validation: **193 tests pass** across longitudinal worker/compute/preparation,
visible scheduling, physical alignment, real browsing integration and manual intent.
The mathematical regression compares the exact pose/diagnostics and reconstructed
pixels/support between image and estimate routes. Additional real-worker and
visible-settling measurements remain required; removed output bytes alone are not
reported as an end-to-end speedup.

### 2026-09-02: N05 real-worker and normal-viewer acceptance

The final focused alignment tranche passes **194 tests across seven files**.
TypeScript passes. The production and browser-test builds both pass, including
the pinned model-asset integrity check, at source fingerprint
`820295d8991f021bc19fe203d4b8ac24d191cda5d8e934d99b95739115a78eff`.

[Attempt 01](../../../artifacts/performance/audit-visible-alignment-2026-09-02/attempt-01)
contains the exact builds, copied harness/fixtures, receipts and cleanup evidence:

- A real module-worker test alternates the old image-producing API with the new
  pose-only API over the same asymmetric physical phantom. Every physical
  transform and diagnostic matches exactly. The 512-square image result returns
  1,310,720 pixel/support bytes; the estimate returns zero. Three complete calls
  take 98.62–129.32 ms for image output and 54.30–67.77 ms for estimate output.
  This is a small synthetic boundary measurement, not an end-to-end or percentile
  speed claim.
- The **normal production app** imports five synthetic examinations, enables all
  dates, selects an overlay pair, and observes real worker requests plus actual
  rendered pixels. Both displayed studies precede offscreen computation for cold
  and warm navigation; cold requests use `estimate`, never `run`, and completed
  estimates transfer no pixels. The next slice uses existing poses without a new
  estimate. Two animation frames after accepted visible output occur at
  1,968.09 ms cold and 169.22 ms warm in this run. This does not compare against
  an old production build, and it is not clinical or representative-size evidence.
- Chrome 152.0.7977.75, headed, one browser worker. Both test runs pass; source
  fingerprints remain unchanged; both owned server/browser/profile lifecycles
  report **CLOSED**. No private MRI or existing browser profile was accessed.

**Next ownership change (F13/N06):** custom inference will use a bounded,
operation-owned worker, terminated on completion, cancellation, timeout and
source replacement. There is no live product consumer for standalone session
initialization or the unsafe-resolution override; retire that unused surface
instead of adding a second idle-session manager. Retained editing/enhancement
owners must be reported to ordinary reconstruction as well as refinement and
selection; failed admission must preserve the accepted image and saved work.

## Completion gates

- All F1–F13 and N01–N12 findings (including the audit's smaller follow-ups) resolved
  with linked code and concrete evidence, including an
  explicit measurement-based decision for conditional cache/chunk optimizations.
- Lint, typecheck, full unit suite, production build, and model-asset verification
  pass on the final tree, with no temporary tracing.
- Synthetic built-app workflow covers import, compare, source/plane changes,
  outline/selection, save/reopen, and complete backup/restore. Browser and GPU
  capability limitations must be disclosed, not represented by unit mocks.
- Multi-GiB restore, cancellation, legacy migration, and concurrent/remount writes
  preserve previously saved data. No required workflow is traded for a benchmark.
- Final documentation describes the shipped ownership boundaries, commands,
  supported hosts, and remaining genuine human/anatomical validation limits.
