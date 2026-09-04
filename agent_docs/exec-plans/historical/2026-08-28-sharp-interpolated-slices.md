# Sharp intermediate MRI slices

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

## Outcome and contract

The opt-in **Sharp slices** control displays a higher-order reconstruction at the already accepted aligned plane. Switching it off restores the original aligned presentation, not a different acquired slice. It is an explicitly labeled experimental display, not new acquired MRI or a diagnostic measurement.

Original DICOM, baseline derived pixels, registration, tone calibration, annotations, manual corrections and browsing identity remain authoritative. A same-plane display switch does not move/remount the image or change alignment. No source MRI or patient-derived images are published. The existing server remains at http://localhost:43124/; no browser was launched, closed, restarted or cleaned.

## Final algorithm

1. Load only the native context intersecting the accepted reference plane, with neighboring source planes for the cubic stencil. Validate patient, examination, series, SOP, reference grid and dataset revision.
2. For each output pixel, reuse the existing patient-space inverse transform and footprint sampling. Sample the four surrounding native planes with physical-coordinate Lagrange cubic interpolation; in-plane sampling remains the existing bilinear/footprint operation.
3. Limit each result to its four acquired neighborhood values. This avoids new intensity extrema/ringing, at the cost of small errors relative to unrestricted cubic in some cases.
4. Preserve exact native-plane centers. Missing outer context uses the existing linear interpolation; missing acquired support and real slice gaps never become invented support.
5. Preserve the baseline support mask exactly and restore baseline values wherever sharper sampling is unsupported. Apply the same baseline-derived tone, physical geometry, polarity and VOI.

There is no trained model, enlarged volume, post-blend sharpening filter, or quarter-slice depth quantization. The original reslicer's default remains linear; only this explicit display path requests bounded cubic. Registration/scoring never consumes its output.

The shared numeric kernel and standalone test renderer are in `frontend/src/utils/sharpSliceSynthesis.ts`. Direct physical sampling is the opt-in branch of `frontend/src/utils/svr/longitudinalRegistration.ts`. `sharpSlicePresentation.ts` binds it to the accepted baseline.

## Runtime and UX ownership

- `sharpSliceDisplay.ts` owns one serial request/worker across mounted panels. Only fresh decoded buffers or baseline copies are transferred; accepted/source buffers are never detached.
- Additional working-buffer admission is 96 MiB: `(nativeFrames + 3) × nativePixels × 5 + outputPixels × 10 + 8 MiB`. This is not a claim about the entire browser heap. Admission precedes decoding; native detail is never downsampled to fit.
- Native I/O and the worker have 60-second deadlines. An abandoned uncancellable Cornerstone load retains the decode slot until it settles, so cancelling one request cannot spawn parallel abandoned loads. Queued requests are independently cancellable.
- `useSharpSliceDisplay` retains only the current original/sharp pair. Source-object changes invalidate pending work, including reruns that reuse the same string ID. Off/on comparison reuses a completed result.
- Rendering keeps the original visible until the replacement is ready. Errors leave it unchanged. Pan, dialogs, playback and active alignment suspend synthesis/variant swaps without freezing ordinary slice navigation.
- A shared `derivedImagePresentation` factory pins tone and fallback windowing to the baseline. Weak source provenance prevents old Cornerstone cache entries being mistaken for new derived pixels; fresh display IDs invalidate Cornerstone's ID-based render cache without retaining another strong MRI owner.
- The source resolver preserves packet identity when all four fields are unchanged. This prevents reloading held aligned pixels merely because a requested native index advanced.
- The top-bar toggle is default-off and persisted only as a UI preference. A visible synthesized/experimental badge remains while synthesized pixels are displayed. Narrow control rails scroll horizontally instead of clipping controls.

Backend API: `requestSharpSliceDisplay(frame, {signal?, onProgress?})` returns `{pixels, valid, rows, columns, stats: {method, durationMs}}`. It does not write MRI or registration state.

## Why the learned prototype was removed

A four-plane, 36-feature scan-trained residual was the initial experiment. It passed synthetic invariants but failed external native-plane reconstruction on real E1 AX100:

| Raw metric | Linear | Unrestricted cubic | Learned |
| --- | ---: | ---: | ---: |
| Full-frame RMSE | 16.637 | 15.627 | 16.260 |
| Central-neighborhood RMSE | 24.338 | 21.809 | 23.491 |
| Neighborhood edge MAE | 32.949 | 27.334 | 31.641 |

The same-window PNG visibly showed extra smoothing. Internal coarser-scale validation did not transfer to the requested plane. The learned correction, training reads, model cache, fitting machinery and virtual slab were deleted, rather than hidden behind a fallback.

The bounded-cubic replacement reduced that pilot's MSE by 12.0% across the image and 21.2% in its neighborhood versus linear interpolation, with zero neighborhood-range overshoots. Standalone inference was 12.2 ms versus 66.9 ms for the learned prototype. These are CPU benchmark timings, not browser frame rate or end-to-end panel latency.

## Real MRI validation

The predictor was frozen before confirmation examinations. Tests omit whole native planes, compute predictions before reading omitted pixels, and compare against independently implemented linear and unrestricted-cubic baselines. Inputs determine the single display window; predictions are not normalized independently. Source files, decoded pixels, support, geometry and endpoint hashes are checked. All individual metrics and baseline comparisons remain in the local receipts.

E1 development coverage: AX/COR/SAG, three neighboring held-out planes each (nine 512×512 images). Every case improves full-frame and neighborhood MSE versus linear, with zero missing support or range overshoots.

| E1 plane | Full-frame MSE reduction vs linear | Neighborhood MSE reduction |
| --- | ---: | ---: |
| AX | 13.21% | 21.05% |
| COR | 14.21% | 19.24% |
| SAG | 41.51% | 45.06% |
| Pooled | 20.40% | 25.44% |

Versus unrestricted cubic, E1 pooled full-frame MSE is 0.356% worse and neighborhood MSE 0.428% better. The limiter is therefore an explicit tradeoff, not a universal fidelity win against unrestricted cubic. No tuning was done against confirmation images.

A real-MRI, translated, oblique 0.37-depth presentation is also checked against an independently implemented world-coordinate oracle. All pixels of both the 128×128 and full-native 512×512 cases match exactly, with unchanged baseline/support/source hashes. The latest CLI run took 16.22 ms for the small case and 142.87 ms for the full-native case; ordinary linear sampling of the full plane took 72.72 ms. These timings exclude native decoding, worker startup, display conversion and browser rendering. The sharper sampling is therefore extra computation, not a claimed end-to-end speedup. The oracle proves implementation/geometry, not acquired truth at an unseen oblique plane.

E2/E3 protected resident examinations contain only axial FLAIR. Their six axial confirmation planes improve full-frame MSE by 10.41–16.18% and neighborhood MSE by 10.24–21.61% versus linear. Missing COR/SAG acquisitions are reported as unavailable, not fabricated or borrowed from another examination. A fourth, previously reserved examination adds three final axial planes. Source/date hashes distinguish all four examinations.

All **18 unique held-out planes across four dates** pass the predeclared gate. Every individual case has lower full-frame and neighborhood MSE than linear: the minimum reductions are 10.17% and 10.24%, respectively. Across all cases, pooled raw MSE falls 14.49% / 16.98% (full frame / neighborhood); input-range-normalized MSE falls 13.27% / 15.21%. Edge MAE falls 9.48% / 10.01%. The nine confirmation-only cases also improve independently: 13.41% / 15.90% pooled raw MSE reduction.

The worst individual penalty versus unrestricted cubic is 5.65% MSE, retained in the report rather than hidden by pooling. No case loses support, exceeds its source neighborhood range, mutates MRI or includes withheld pixels in its prediction inputs. The private summary with every case and frozen hashes is `frontend/tmp/inter-slice-validation/bounded-cubic/quality-gate.json`. The clean final axial corpus run passed 8/8 tests in 9.73 seconds; the earlier complete E1 multiplane run passed 7/7.

Data limitations: this is one patient's supplied corpus. E1 AX/COR are derived viewing series; E1 SAG is tagged original 3D, with 1.2 mm declared slice thickness and 0.6 mm spacing. Its nominal slice profiles overlap. These are not three independent acquisitions, certified tumor contours, clinical accuracy, or proof of new acquired resolution. ROI locations are anatomical neighborhood hints, not certified tumor boundaries.

### Data access and privacy

Initial Desktop discovery stalled before model execution: previously unread FileProvider-backed files took 2.7–3.8 seconds each to hydrate, while parsing took at most 1 ms. Exhaustive discovery of a flat 1,513-file study would take about an hour. Those test processes were stopped. Validation instead uses the protected, already-resident real MRI copy organized by examination and plane, not generated synthetic fixtures. Desktop E18 pixels were not used. Desktop examination ordinals have changed with new imports, so dates are never inferred from an old ordinal mapping.

All patient-derived images/receipts stay under ignored `frontend/tmp/inter-slice-validation/`. Failed learned and pilot cubic results remain separately preserved; final results are in `bounded-cubic/`. No DICOM copies or captures belong in a commit.

## Visual inspection and remaining boundary

Original-detail, common-window comparison PNGs were inspected for axial, coronal and sagittal planes, the actual small/full-native oblique renderer, and E2/E3/E4 confirmation examinations. The bounded reconstruction retains more texture than linear blending, while still missing some native detail. The learned comparison failed; bounded comparisons passed within those stated limits. No visual inspection result is a diagnosis or a new native measurement.

Live application visual validation is **blocked**: the connected-browser inventory is empty. The existing preview serves the new module, but HTTP/component/CLI evidence does not prove browser appearance, browser performance or complete GUI behavior. No alternate browser/profile was launched.

## Verification ledger

- Final numerical core: 18 focused tests pass.
- Direct presentation and service: 34 focused tests pass, including exact source centers, non-quarter oblique geometry, support/gaps, cancellation, deadlines, queue ownership, dimension/memory preflight, source/revision guards and source-buffer preservation.
- UI/factory/browsing: 109 tests across nine suites pass, including same-ID changed pixels/tone, current-original restoration, instant off/on comparison, pending navigation, pan suspension and unchanged native annotation access.
- First broad run: 1,788 passed, four held-browsing load-count failures. Root cause was duplicate identical resolver packets plus stale mock provenance. Packet identity was corrected and every existing assertion retained; all 109 affected/related tests then passed.
- Final full suite: 1,796 passed, 24 opt-in cases skipped, across 142 passing and six skipped files (116.97 seconds). Private MRI coverage above was run explicitly and separately.
- Final affected-UI recheck after the cancellation/promise-chain cleanup: all 109 tests across nine suites pass (9.41 seconds).
- Final full lint and TypeScript/production build pass. Vite reports a large main-bundle warning; the new background worker is 10.87 kB. No new dependencies or Doctor suppressions were added.
- React Doctor's local scan reports zero issues across 331 files. Its external numeric score API was unreachable in the sandbox; escalation was denied because it could transmit repository-derived data. No alternative external scoring route was attempted, and no numeric score is claimed.
- The existing localhost preview responds HTTP200 with JavaScript containing the new hook and source-identity guard, not merely an HTML fallback. This is delivery evidence only, not browser visual validation.
- No current PR or merge request was created. Branch `blader/siqi-chen/sharp-interpolated-slices` starts at `f800ffbda5ae260d253dbb0fc79377c50a2cba21`. Unrelated dirty/untracked work is preserved; viewport-weighted alignment is a separate proposal.
