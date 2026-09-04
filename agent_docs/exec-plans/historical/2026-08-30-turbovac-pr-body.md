## Why this work

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

Scrolling a comparison could leave already-aligned scans waiting behind image analysis or a cold registration. Tissue editing required too many separate actions, and temporary processing buffers could make original-detail or enhanced-detail requests fail despite a small selected region.

The subsequent segmentation evaluation exposed another mismatch: a strong central prediction could include disconnected, unmarked tissue elsewhere, and tracking an entire acquisition made corrections slow. This PR keeps the accepted alignment visible while browsing, makes brush marks authoritative, and removes model work only when it cannot change the foreground-connected selection. Original MRI values and memory-admission limits remain authoritative.

## What changes

- Browse with the accepted 3D pose, affine transform, display calibration and manual slice corrections. Cached planes publish first; cold scans do not hold up reusable registrations. Cancelled or stale work cannot rewind the current slice.
- Add opt-in **Sharp slices**, a bounded cubic reconstruction at the accepted physical plane. It preserves acquired support and the original display window, defaults off, is labeled experimental, and is never used for registration or measurements. Load serialization follows the underlying uncancellable image load through settlement.
- Simplify selection to **Add / Remove / Browse / Done**, with debounced **Auto-fill**, Stop, reversible corrections and original-detail access. Integrate the pinned EfficientTAM proposal through a disposable one-thread WASM worker; this is editable draft tissue selection, not automatic tumor detection.
- Apply acquired support and literal Add/Remove marks before retaining every 26-connected component containing an Add mark. Skip propagation beyond certified empty editing-grid planes only for eligible single-plane marks and exact grid mappings. Raw diagnostics and ineligible/multi-plane cases retain full traversal; skipped frames are never represented as observed predictions.
- Preserve selection-context metadata through edits, cancellation, history, backup, migration and reload. Unknown raw extent counts remain unknown after pruning. Enclose valid source-frame display windows to avoid the washed-out middle-frame default without changing MRI samples.
- Bound worker copies, prefetch and decoded-frame ownership. Failed requests retain the accepted volume, selection and settings. Ship same-origin, SHA-pinned Apache-2.0 model assets with license/notices and a reproducible guarded exporter.
- Keep independent anatomical references, disputed engineering labels and saved-output transport regressions distinct in the synthetic tests and opt-in local corpus adapters.

## Evidence

- Final head `776d2274b39e40f5a4969f3d5de3f0f15da73c32`: standard `npm run check` passed **2,828 Vitest tests; 54 gated tests skipped**, plus ESLint. TypeScript, the production build and exact source/dist model-asset verification passed. Eight stdlib-only exporter tests also passed on the unchanged exporter. Skipped private/model cases are not accuracy passes.
- Four complete reduction passes removed duplicate UI/test setup and shared tracking-resource handling without changing model/pixel math, hard marks or cancellation policy. The final pass found no further safe cuts. A timing-sensitive regression now waits for the public displayed-content identity; Vitest uses at most four workers for large native-grid tests instead of its ignored legacy `threads` option. Test scenarios, assertions and timeouts are preserved.
- Preserved earlier evidence: the ordinary suite passed **2,073 tests** at `5c0f77b37b2ac2ac64fec28d18e620cb333a0ccc`. Four composed Sharp regressions failed before the cancellation fix and pass afterward: abort/timeout crossed with late source-load success/failure. They cover serialization, queued cancellation, stale conversion and recovery.
- Preserved actual-application validation used the pre-cleanup runtime represented by `a8556b0`, at `http://localhost:43124/` in headed Chrome on the Apple M4 Max. A completed real-editor run returned **75 frames rather than 222** and made **298 model graph calls rather than 886**, with the exact same 20,990-voxel selection and all 111 Add marks preserved. Wall time was **8 min 25 sec** on a shared, busy machine; this is not a controlled speedup comparison or a new final-head browser run.
- Individually inspected actual-app captures and an unscaled, position-normalized three-plane comparison preserve the selected boundary and interior MRI texture. Browsing changes real canvas pixels without restarting prediction. Cancellation, metadata undo/redo and full reload preserve the selection and marks. An earlier workflow separately verified geometric undo/redo.
- Saved-output replay through the real adapter/geometry/postcondition code preserves the endorsed section and final mask in a second example, while a no-stopping-boundary control still processes its full extent. That replay uses simulated transport of pinned saved logits; it is not a new model, browser or anatomical-accuracy test.
- The pre-cleanup offline ZIP passed file-by-file byte/hash/mode and privacy checks. Its cold empty app rendered with external page requests blocked and correct isolation/MIME headers. This preserves the prior package evidence; the ZIP was not rebuilt during reduction. No Storybook evidence was accepted. Patient-derived captures and raw execution receipts remain private rather than being attached to this public PR.

## Known Issues

- Interactive latency remains too high for large acquisitions. Four-thread and GPU paths are diagnostic-only; they are not automatic fallbacks. The model remains draft assistance, and full-volume independent anatomical acceptance is not established. Disputed historical yellow labels are not treated as ground truth.
- Cold **packaged-app import and model execution remain unverified**: Chrome's supported automated file chooser returns `Not allowed` for local file selection. The packaged startup passes, but this does not substitute for that remaining workflow check. No access-control workaround was used.
- Final-head React Doctor reports **ten advisories** and exits 1 under its warning-blocking policy: nine `async-await-in-loop` warnings at intentional cooperative CPU-loop yields and one selection-editor size advisory after inlining a single-use stateless wrapper. No suppression was added; this is not reported as green or 100%. Existing React `act(...)` warnings and Vite's large-main-bundle warning remain visible.
- The first native browser result is not a peak-memory/RSS measurement or a smoothness/frame-budget benchmark.

## Instructions to Reviewers

Start with alignment browsing ownership, then follow `Svr3DView` through the native-context planner, proposal adapter, tracking transport/controller and selection hook. Check hard-mark authority, exact categorical geometry, stop acknowledgements, stale-result rejection, publication ordering and persisted context metadata.

Run `npm run check` and `npm run build` in `frontend/`, plus `python3 tests/test_export_efficient_tam.py`. Use authorized local MRI for manual validation; this PR does not include patient source images, masks, screenshots or private experiment receipts. The included weights are public Apache-2.0 assets, not patient-derived data. No clinical-accuracy claim is made.
