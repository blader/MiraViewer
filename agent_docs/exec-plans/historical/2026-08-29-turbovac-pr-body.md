## Why

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

Scrolling a comparison could leave already-aligned scans waiting behind image analysis or a cold registration. Tissue editing also required too many separate actions, and temporary processing buffers could make original-detail or enhanced-detail requests fail despite a small selected region.

This change separates accepted-alignment presentation from new registration work, simplifies direct editing, and makes processing ownership explicit without replacing source MRI values or weakening memory admission.

## What changed

- Browse with the accepted 3D pose, affine transform, display calibration and manual slice corrections. Cached planes publish first; cold scans do not hold up reusable registrations. Canceled or stale work cannot rewind the current slice.
- Add opt-in **Sharp slices**, a bounded cubic reconstruction at the same accepted physical plane. It preserves acquired support and the original display window. It is labeled experimental, defaults off, and is never used for registration or measurements. Cancellation and timeouts remain prompt while the single-load limit follows the underlying uncancelable image load through settlement.
- Simplify selection to **Add / Remove / Browse / Done**, with debounced **Auto-fill**, explicit stop, reversible corrections and direct access to original detail. Confirming already-correct tissue no longer recomputes a completed proposal or discards its enhancement.
- Bound worker source copies and processing prefetch; release parsed DICOM datasets under their actual loader keys; count distinct cached and displayed pixel buffers at memory-admission boundaries. Failed requests retain the accepted volume, selection and settings.
- Add synthetic behavioral tests and opt-in local corpus/evaluation adapters. The evaluator distinguishes independent anatomical references, disputed engineering labels and saved-output transport regressions; one cannot silently substitute for another.

## Validation

- Ordinary regression suite at `5c0f77b37b2ac2ac64fec28d18e620cb333a0ccc`: **2,073 passed, 54 optional tests skipped**. The skipped private/model cases are not accuracy passes.
- TypeScript/Vite production build, ESLint and local React Doctor pass. Doctor reports no issues with telemetry, supply-chain scanning and numerical scoring disabled.
- Regression coverage includes synthetic wheel events through the viewer hooks, retained affine/tone/manual offsets, cold/warm scheduling, stale-result rejection, worker cancellation, hard marks, undo/redo, save ordering and memory ownership.
- Four composed Sharp regressions failed before the cancellation fix and pass afterward: abort/timeout crossed with late source-load success/failure. They verify load serialization, prompt queued cancellation, no stale pixel conversion and recovery after settlement.
- Existing React `act(...)` warnings and Vite's large-chunk warning remain visible.

## Evidence limits and privacy

The actual-app route is `http://localhost:43124/`. Live visual/GPU validation is **pending**: supported browser selection returns `No browser is available`, and browser discovery returns an empty list. No browser was launched, closed or restarted. Synthetic integration tests are not a substitute for that check; no Storybook evidence is accepted.

This PR does **not** integrate the private learned-segmentation prototype or claim a validated replacement tumor classifier. The separately approved example and outstanding full-volume anatomical review remain local research work. Source MRI, model weights, private masks, patient-derived images and execution receipts are excluded from this public PR. No clinical-accuracy or measured end-to-end browser-performance claim is made.
