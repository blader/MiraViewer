# SVR fidelity and editable segmentation — implementation and validation

Implemented in the current worktree on August 27, 2026. The architecture decision and original falsifiers are retained below; measured outcomes and remaining limitations follow the execution ledger.

## Outcome and constraints

Make reconstructed MRI detail useful for reviewing a region of interest, and make a tumor-region selection inspectable and correctable in three physical planes. A statistically unusual intensity is not a tumor label. A visually attractive 3D rendering is not an accuracy measurement. Preserve the approved longitudinal alignment, source DICOM bytes, patient/series isolation, acquired-support boundaries, cancellation, offline operation, and existing saved labels.

All patient-derived captures stay in ignored local storage. This document contains no patient identifiers, source-image URLs, or clinical claims. The browser database used by the user is not a test fixture and will not be replaced.

## Baseline and architecture checkpoint

Baseline head: `6e56aee0b7629265112d55419da7c154a4313db7`.

Actual app at `http://localhost:43124/`, 2048×1200, installed headed Chrome, WebGL2 ANGLE Metal / Apple M4 Max. Dedicated test profile; 716 locally imported FLAIR frames from three orientations in the latest supplied examination. Reconstruction: 13,831 ms, 171×192×173 voxels, 1.49 mm effective grid spacing for a 1 mm request, 59% acquired-supported grid coverage. These are implementation measurements, not clinical quality results.

The old box action chose intensity 0.352 rather than the geometric-center intensity 0.575 and produced 1,492 selected voxels. It crossed the drawn region's bounds. Worker computation was 24.2 ms; pointer-to-published selection was approximately 300 ms including capture polling. The user explicitly identified the magenta output as incorrect. Treat that output as a failed segmentation baseline, not a golden label.

Two baseline screenshots were individually inspected at original resolution: local `frontend/tmp/private-tumor-segmentation-validation/100a-actual-new-mri-before-segmentation.png` and `102-actual-new-mri-tumor-only.png`. Both fail the review/correction UX brief: a large opaque 3D image dominates while the actual editing slice is tiny and partly below the fold; there are no direct inclusion/exclusion corrections. Cleanup CLOSED: owned browser/profile removed, current/stale scoped audit clear, user browser preserved.

### Governing data flow

- IndexedDB source instances → geometry/support-aware decoding → SVR worker → accepted reconstruction.
- Renderer-owned generated label volume → persistence and GPU/slice presentation.
- Existing box → intensity-outlier seed → single-class path-cost growth → immediate magenta tumor presentation and volume number.

Classification: structural mismatch in segmentation and review UX; reconstruction fidelity/performance needs controlled experiments before replacing its physical model.

The failing segmentation assumption is that a box and an automatically chosen intensity outlier identify the intended anatomy. Existing phantom tests and nonempty-mask corpus checks do not independently prove that assumption. The current workflow also makes changing the seed implicitly retain the earlier preview, which is inappropriate for correcting a bad hypothesis.

### Alternatives and decision

1. Tune box selection and intensity tolerance again. Reject as the primary strategy: it cannot represent explicit foreground/background corrections and has already selected the wrong tissue.
2. Add a pretrained tumor model. Not the default: no supplied, independently validated model/preprocessing contract covers the corpus. Preserve the existing optional model path without representing it as validated tumor identification.
3. Replace the default with explicit positive/negative marks, physical-space seeded competition, direct mask correction, undo/redo, and a review step. Choose this approach. It represents user intent directly and provides a bounded local computation with hard seed and support guarantees.

For reconstruction, retain the physical acquisition/PSF model as the authority. Compare fine-grid initialization against the current coarse-to-fine schedule, test edge-preserving regularization against uniform Laplacian smoothing, and profile repeated projection work. Adopt only changes supported by independent phantom/held-out evidence and matched corpus timings. Do not substitute a sharper-looking image for fidelity or claim synthetic resolution absent from source data.

## Design

Use the existing Quiet Instrument tokens: image black, graphite surfaces, subdued warm-metal controls, off-white primary text, and teal selection evidence; amber is reserved for excluded/unobserved information. Keep the established display/body/monospace typography. No gradients or decorative cards over anatomy.

The signature is a four-view workbench: three equally useful, linked orthogonal slices and one 3D view. The images, not source settings, own the workspace after reconstruction. Use physical aspect ratios and a common crosshair position; changing plane must not jump to its midpoint. Each slice has direct keyboard/slider navigation. Source details remain accessible separately.

Primary workflow: mark tissue to include and exclude → grow a draft selection → inspect and directly add/remove tissue in any plane → accept the reviewed selection. Undo/redo must restore both marks and mask. A box, if present, bounds computation; it is never itself a segmentation. Drafts stay explicitly unreviewed and do not show an authoritative tumor-volume number. Accepted numbers describe selected tissue volume, not diagnosis.

## Algorithm contract

- Foreground and background marks are explicit hard constraints. Latest user edits are authoritative; no guessed intensity seed may substitute for them.
- Competition uses physical neighbor distances and intensity-boundary costs, not a bright-tumor assumption. Bound the working domain and scratch memory; never traverse missing acquired support.
- New computation replaces the prior draft instead of accumulating prior guesses. Direct brush edits do not secretly trigger a whole-volume replacement.
- Run in a worker with a single retained source copy; only the newest request can publish. Cancel and volume/patient changes invalidate pending work.
- Preserve source pixels, undoable edits, sparse GPU upload opportunities, and saved-label provenance. Restored legacy/model labels are unreviewed unless their review state was explicitly saved.

## Validation plan and falsifiers

1. Independent segmentation phantoms: bright, dark, heterogeneous, weak boundaries, adjacent similar tissue, anisotropic spacing, small lesions, disconnected support, and explicit positive/negative corrections. Assert overlap/precision/recall where truth is independently constructed, exact seed retention, no support violations, deterministic results, and bounded memory. Keep held-out shapes/noise levels separate from tuning cases.
2. Reconstruction phantoms: small structures and sharp edges with a separately defined acquisition model; acquired gaps, oblique geometry, fractional validity, constant-field conservation, and held-out slice prediction. Compare error, edge contrast, output support, runtime, and memory against baseline.
3. Private corpus: multiple examinations, three planes, unchanged source selection/parameters when timing variants. Real unlabeled MRI proves workflow, support, stability, and visual correspondence only—not a Dice score or clinical tumor accuracy.
4. Actual-app checkpoints immediately when the redesigned workspace is runnable, then after segmentation and reconstruction improvements. Inspect individual native-resolution screenshots and a normalized before/after comparison. Exercise add/remove, linked navigation, undo/redo, growth cancellation, reviewed/draft states, reload, and compact layout. Record GPU provenance; static images do not prove smooth motion.
5. Finish with targeted and full tests, lint, production build, formatting, React Doctor where available, privacy checks, and a clear limitations report.

Abandon an algorithm variant if it violates a hard mark/support/ownership invariant, regresses independent holdout fidelity, or introduces an unexplained performance/memory regression. Reopen the architecture after two failed experiments in the same causal area. Do not tune against the user's rejected magenta mask.

## Execution ledger

1. Reproduced the opaque, incorrectly seeded baseline in the real app. Rejected its output as an accuracy target.
2. Replaced the automatic intensity-outlier seed and single-class grower with explicit foreground/background competition, editable masks, bounded history, and explicit review. Removed the superseded grower, worker, box-seeding helper, and now-unused grid helper.
3. Built the four-view workbench and exercised it on the supplied MRI. Initial checkpoints exposed poor windowing, obscured texture, and editing failures; these were corrected rather than accepted as completion.
4. Traced an actual React development-preview out-of-memory failure to recursively profiled MRI-array props. Moved shared imaging buffers into context, preserving profiling and avoiding a renderer-specific workaround.
5. Replaced clipped intensity normalization and uniform SVR smoothing, then compared against independently acquired synthetic texture phantoms. Preserved the longitudinal alignment solver's existing regularization default.
6. Replaced the foggy clip boundary with an exact windowed MRI cut surface. Whole-head sampling was still too coarse for detailed region review, so added source-backed regional reconstruction with atomic draft-annotation transfer.
7. Validated growth, editing, undo/redo, acceptance, regional refinement, regrowth, and exact saved-mask/mark restoration in headed Chrome using the full three-orientation examination. Checked compact desktop and mobile layouts separately.
8. Final review fixed stale worker-error ownership, canceled/in-flight strokes, replacement-volume GPU identity, save/hydration ordering, and preservation of accepted reconstruction settings during regional refinement. Automated regressions cover these cases.
9. The final GPU-residency regression exposed a timing-sensitive test setup: a visibility uniform could precede the initial label upload. The test now waits for the actual accepted mask bytes before asserting zero reallocations on mode switches. The final full suite passes with that stronger readiness oracle.

## What changed

### 1. Explicit, correctable segmentation

The default workflow is **Add tissue / Remove tissue → Grow from marks → review and correct → Accept selection**. Growth is explicit; a brush stroke does not silently launch a new segmentation or overwrite an accepted mask. The application calls the result a tissue selection, not an automatically diagnosed tumor.

`seededVolume.ts` implements two multi-source Dijkstra passes over a bounded, physically spaced voxel graph. Foreground and background marks are hard constraints. The neighbor cost is:

```text
0.0025 × physical step + normalized intensity difference² / physical step
```

Both bright and dark tissue are eligible. Intensity normalization uses the local robust range, with sampled and explicitly marked extrema as a fallback when percentiles collapse around a small structure. Equal-cost competition deterministically chooses background. A distant background shell limits unconstrained growth; the default domain encloses all marks with 12 mm of context and cannot exceed 2,000,000 voxels. Neither path may cross missing or nonfinite acquired evidence.

The worker retains one source copy across growth requests. Renderer-owned arrays are never transferred or detached. An indexed heap stores each voxel once, work yields every 8,192 visited nodes, cancellation never publishes a partial result, and requests have a 30-second deadline. Source/geometry changes dispose the worker; a late event from a disposed worker cannot cancel its replacement. If workers are unavailable, the UI reports that growth is unavailable while keeping manual editing usable.

Direct edits are sparse reversible patches. Undo/redo restores the mask, both mark classes, and draft/reviewed state together; history is limited to 20 edits and 32 MiB. Marks persist with the mask. A new stroke wins over contradictory previous marks. Canceling a pointer interaction, changing the volume/plane/tool, or pressing Escape discards an unfinished stroke rather than committing partial input.

### 2. A review workbench, not a magenta surface

- Linked axial, coronal, sagittal, and 3D views occupy the main workspace. Reconstructed-source controls collapse after a successful run without disappearing.
- Slice aspect ratios and crosshair position use patient millimeters. Radiological orientation markers, 1-based slice inputs, sliders, wheel/keyboard browsing, physical coordinates, and acquired-support feedback are available together.
- Any pane can expand. The three slice views remain mounted when surrounding controls change, and Escape restores the four-view layout.
- A 0.5–8 mm brush draws include/exclude marks directly on any plane. Navigate mode permits mobile page scrolling; drawing mode owns its pointer gestures.
- Anatomy, Overlay, and Selection only are explicit display states. A thin teal boundary and approximately 10% interior tint leave MRI texture visible. Small teal/amber marks distinguish included and excluded evidence.
- Shared window/level controls affect display only. The 3D cut follows the axial crosshair and displays the actual windowed grayscale sample at the plane intersection, without synthetic surface shading at that cut.
- Draft status remains visible. A selected-tissue volume number appears only after explicit review; it is not a tumor diagnosis or algorithmic-confidence score.

The styling retains the application's restrained black/graphite surfaces, existing typography, and subdued controls. The visual hierarchy favors anatomy and editing context over large panels of parameters.

### 3. Preserve acquired texture throughout reconstruction

The old robust-percentile remapping clipped meaningful intensity tails before reconstruction. The new normalization applies one affine mapping over the finite acquired range. Percentiles determine a suggested display window only. Observed zero-valued pixels remain valid; missing evidence remains missing. The former debug-only histogram matching branch, which could diverge between inline and worker computation, is removed.

SVR now initializes the final grid directly by default. The optional explicit coarse schedule remains supported, but is no longer the default because the tested small structures and texture benefited from fine initialization. The existing acquisition/slice-profile model, robust residual treatment, and acquired-support accounting remain the reconstruction authority.

SVR's regularization uses the edge-preserving derivative `d / sqrt(1 + d² / edgeScale²)` rather than uniform Laplacian smoothing; the scale follows the robust acquired intensity range. The shared solver retains its previous default for longitudinal alignment, so this is not an implicit auto-alignment algorithm change. Reconstruction fingerprints include the texture-preserving algorithm revision to prevent reuse of labels against an incompatible reconstruction.

GPU rendering keeps the half-float MRI texture separate from categorical labels and support. Selected tissue remains windowed grayscale with a restrained tint, including dark selected tissue. The finite voxel boundary is not disguised with artificial smooth anatomy. Small brush edits update only the affected texture region; accepting metadata-only review does not reupload the mask. A ready GPU buffer is bound to its exact source volume, preventing old bytes from being uploaded under replacement geometry.

### 4. Finer regional reconstruction from source images

**Refine region** requests a 0.50 mm grid around the selected tissue and both classes of marks, with surrounding anatomical context. This reuses the original DICOM reconstruction pipeline and shared memory planner; it does not interpolate the previous MRI volume and call that super-resolution.

The old result remains visible while refinement runs. The new volume and patient-space-resampled annotations are published atomically. Only annotations are transferred with nearest-neighbor sampling; support/nonfinite checks still apply, and transferred annotations always become a draft requiring review. Cancellation or failure retains the previous result.

Refinement starts from the settings that produced the accepted reconstruction, not pending changes in the source controls. It does not introduce ROI registration into a previously native-geometry whole-head result. An explicitly registered result retains its registration mode and explicit source-reference choice rather than silently reverting to unregistered slices. That registration can be recomputed on the new regional evidence; exact fitted transforms are not cached/reused, and transferred boundaries remain provisional.

The requested grid is not promised physical resolution. In the full-corpus browser run, the memory planner admitted **0.62 mm at 108³**, versus **1.49 mm at 171×192×173** for the whole head. The UI reports effective spacing. More samples can expose source-supported detail, but cannot create detail the acquisitions never measured.

### 5. Save and lifecycle reliability

The persisted label key binds patient, examination, sorted series, spatial reference, dimensions, spacing, origin, dataset revision, and reconstruction fingerprint. Existing legacy keys remain readable when no fingerprint exists. Saved edits take precedence over automatically transferred draft annotations.

Hydration waits for pending writes and verifies volume identity and geometry. Failed loading locks edits and offers Retry loading rather than overwriting unread saved work. Completed edits are written through a serialized queue; there is no final-edit debounce that can be lost on unmount. Save failure retains in-memory work and exposes Retry saving. Sanitizing labels outside acquired support downgrades their review state.

The full native MRI and mask buffers now enter the component tree through shared imaging context. This fixed a reproduced React 19.2 development profiler `performance.measure` cloning failure without disabling profiling or altering React. Presentation components receive small control state, not multi-million-element binary arrays as recursively profiled props.

## Measured validation

### Independent reconstruction fidelity

`svrTextureFidelity.test.ts` uses a continuous 36³ phantom with texture, a small lesion, and a thin structure. Acquisitions are generated independently with 11 through-plane Gaussian samples and 2×2 subpixel quadrature. The comparator is the old coarse-initialized, uniform-regularization configuration. Both use the same generated source evidence.

| Slice thickness / noise | Old RMSE | New RMSE | Old gradient error | New gradient error |
| ----------------------- | -------: | -------: | -----------------: | -----------------: |
| 0.8 mm / 0              | 0.029677 | 0.027146 |           0.041603 |           0.037889 |
| 0.8 mm / 0.025          | 0.030271 | 0.028009 |           0.042031 |           0.038791 |
| 3.2 mm / 0              | 0.036389 | 0.032587 |           0.050470 |           0.045804 |
| 3.2 mm / 0.025          | 0.037307 | 0.034219 |           0.051655 |           0.047928 |

RMSE decreased approximately 7–10% on these fixtures, with lower gradient error in each case. Acquired support was identical, and unsupported values remained exactly zero. Warm fixture solver runs were approximately 39–56 ms for the new configuration and 57–72 ms for the old; one cold run was 86 versus 82 ms. These small synthetic timings do not establish a universal throughput gain.

### Segmentation oracles and private corpus

Independent synthetic masks cover bright/dark polarity, heterogeneous interiors, weak boundaries, cystic structure, attached distractors, tiny structures against bilateral cavities, off-center marks, anisotropic spacing, disconnected evidence, contradictions, and ties. Tests assert exact hard constraints, support isolation, deterministic output, overlap/precision thresholds, bounded domains, cancellation, and source immutability. The old misleading nonempty-output tests have been replaced or strengthened for the new algorithm.

Four private examinations were tested separately using the opt-in `svrTumorSegmentationGolden.test.ts` corpus path: examination ordinals **1, 9, 15, and 18**, each reporting **9 tests passed, 0 failed**. The corpus checks admit compatible patient/examination/spatial-frame/contrast evidence across three planes and validate deterministic marked-region behavior, support, and bounds. These are **not expert tumor contours** and must not be reported as clinical Dice scores.

### Actual-app, full-MRI workflow

Dedicated headed Chrome; WebGL2 ANGLE Metal on Apple M4 Max; the actual Vite app, workers, IndexedDB, and source decoding. The final run used all **716 source frames** from three orientations. It exercised:

1. Whole-head reconstruction and linked slice inspection.
2. Positive and negative marks, explicit growth, direct removal, and exact undo/redo.
3. Reviewed-state acceptance, source-backed finer reconstruction, transferred draft review, and explicit regrowth.
4. A full reload followed by exact IndexedDB readback, not just a visually similar screenshot.

Final measured values:

- Whole-head reconstruction: **10,229 ms**. Earlier new-path observations were 8.4–10.2 seconds; the initial baseline was 13.8 seconds. Cache/load conditions were not controlled across these app runs, so this is an observation, not a claimed percentage speedup.
- Regional reconstruction: **3,702 ms**, producing the admitted 0.62 mm / 108³ grid.
- Earlier coarse selection worker runs: approximately **42–44 ms**. Fine-grid regrowth in the final run: **495.6 ms**.
- Coarse growth: 966 selected voxels; a direct removal produced 961. Undo restored the exact earlier mask and marks; redo restored the exact edited state.
- Reload restored **961 voxels, 5 inclusion marks, 25 exclusion marks, reviewed state**, and exact mask hash **1554388442**. This hash is an implementation checksum, not an accuracy metric.
- Fine-grid transferred draft: 13,758 voxels; subsequent explicit regrowth: 6,437 voxels. Both had **zero selected unsupported voxels**. The changed count demonstrates that transfer and recomputation are distinct, reviewable steps, not an automatic clinical volume comparison.
- Visible GPU frame samples were approximately **5.4–19 ms** by display state. Hidden 1×1-canvas timings are excluded; no continuous-motion benchmark is claimed.
- **Zero browser errors** in the final end-to-end run.

### Individually inspected visual evidence

All paths below are private, ignored local artifacts under `frontend/tmp/private-tumor-segmentation-validation/`; no MRI image is embedded in this report or intended for a PR. Each named checkpoint was viewed individually at original resolution and received an immediate written visual audit. Captured files not listed here must not be inferred to have been inspected.

| Artifact                                                                           | Scope and verdict                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `100a-actual-new-mri-before-segmentation.png`, `102-actual-new-mri-tumor-only.png` | Baseline FAIL: tiny correction context and opaque automatic selection.                                                                                                                       |
| `221i-laptop-regional-workbench.png`                                               | PASS: 1280×900 workbench hierarchy and usable image area.                                                                                                                                    |
| `221j-mobile-workbench-top.png`                                                    | PASS: 430×932 controls, readable layout, no horizontal overflow.                                                                                                                             |
| `221k-mobile-workbench-volume.png`                                                 | PASS: lower views reachable, navigation scrolling preserved.                                                                                                                                 |
| `222f-finer-region-cutaway.png`                                                    | PASS: source-backed regional detail and visible grayscale inside the draft boundary. Not clinical segmentation validation.                                                                   |
| `223l-reloaded-reviewed-selection.png`                                             | PASS: reviewed selection visibly restored; separate database readback proved exact state restoration.                                                                                        |
| `223m-coarse-to-fine-comparison.png`                                               | PASS: qualitative increase in visible regional texture using unmodified app captures at comparable display scale. Windows/planes were recalculated, so this is not pixel-error ground truth. |

Intermediate failures included washed-out windowing, a foggy cut surface, too-coarse regional detail, and profiler-related editing failures. They were fixed and superseded by the listed checkpoints, not hidden or relabeled as passes. The final settings-preservation change is covered by integration/unit tests and does not change the visually tested default native-geometry workflow.

Browser cleanup: **CLOSED**. Current and stale validation-owned processes/profiles were audited and removed. The user's normal browser, local data, and all source MRI folders were preserved. The local preview remains available at `http://localhost:43124/`.

## Final verification

- Four private-corpus runs: 9 passing tests each.
- Final accepted-settings regression: 53 passing tests across three files.
- Full suite: **1,043 passed, 0 failed, 11 opt-in skips across 116 test files** (`frontend/tmp/svr-full-final-regression.json`). Private-corpus cases were run explicitly as recorded above.
- `npm run lint`: **PASS**. Prettier check over all changed production/test files and this report: **PASS**.
- `npm run build`: **PASS**, including TypeScript project references and the Vite production bundle. Vite still warns about the existing large main bundle (approximately 2.70 MB minified); this pass does not claim to resolve application-wide initial-download size.
- React Doctor: **273 files scanned, zero local issues**. Its numerical score requires an external service; that request was blocked, so no numerical score is claimed.
- Temporary trace logging is removed, obsolete production imports are absent, and `git diff --check` passes.
- Patient images, captures, and corpus receipts remain ignored/local; no MRI source files have been staged by this work.

The React Doctor configuration extends only two existing narrow exemptions: cooperative sequential yielding in annotation resampling, and keyboard-tested canvas application semantics in the new editor. Performance, lifecycle, derived-state, and component-size findings were fixed in code rather than hidden by broad exclusions. The final brush-controls extraction preserves the exact DOM/interaction contract and is covered by the rerun viewer tests.

## Remaining limits and next accuracy work

1. **This is interactive selection, not validated automatic tumor diagnosis.** The app now represents intent and corrections explicitly, but homogeneous adjacent tissue and weak boundaries can still require negative marks and direct editing. No algorithm can infer a clinically correct boundary from the supplied unlabeled corpus alone.
2. To measure clinical accuracy, obtain expert contours in native patient coordinates for multiple dates, planes, lesion morphologies, and sequences. Separate tuning and held-out examinations, record inter-rater disagreement, then evaluate Dice, surface distance, missed components, false inclusions, and correction time. Never use this algorithm's own output as its golden truth.
3. Add clinician-reviewed segmentation correction tasks before considering a pretrained model as the default. A model needs a verified sequence/preprocessing/output-space contract, independent holdout evaluation, and an explicit editable draft state.
4. Fine output sampling is not acquired resolution. Keep support and resolution provenance visible. Half-float GPU display and rasterization still impose display precision limits; source and solver arrays retain their CPU precision.
5. The processing memory planner is not a total-browser-RSS guarantee. The bounded segmentation domain, one worker source copy, bounded edit history, and sparse texture updates limit additional work; test lower-memory devices before raising defaults or domain limits.
6. Large, poorly bounded markings may exceed the 2,000,000-voxel growth domain. The operation fails clearly rather than silently subsampling the labels or pretending an incomplete grow succeeded. Manual correction remains available.
7. Registered regional refinement can recompute a local fit. If exact transform reuse becomes a requirement, persist accepted per-series transforms as reconstruction provenance and apply them consistently to source admission and projection; do not claim this current version freezes fitted matrices.
8. Extend performance validation with repeated cold/warm whole-head and regional runs on lower-memory integrated GPUs, recording source decoding, solver, worker, GPU, editing latency, and memory separately. Current static/frame evidence does not prove smooth sustained interaction on every device.

## Primary references

Interactive foreground/background seeding is established in [3D Slicer's Segment Editor](https://github.com/Slicer/Slicer/blob/main/Docs/user_guide/modules/segmenteditor.md). Its workflow supports iterative marking and review; this is design guidance, not validation of this implementation.

[Fast GrowCut](https://nac.spl.harvard.edu/publications/effective-interactive-medical-image-segmentation-method-using-fast-growcut) motivates efficient competing seeded regions. The proposed browser implementation must be tested on its own merits rather than inheriting the paper's results.

The acquisition-model and edge-preserving reconstruction experiments are informed by [MRI super-resolution reconstruction](https://pmc.ncbi.nlm.nih.gov/articles/PMC4644155/) and [reconstruction with intensity matching and robust outlier handling](https://pmc.ncbi.nlm.nih.gov/articles/PMC4067058/). They do not justify fusing incompatible sequences or fabricating missing anatomy.
