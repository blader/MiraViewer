# SVR fidelity and editable segmentation — implementation and validation

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

Implemented and validated in the current worktree on August 27, 2026, including the native original-3D volume path, original MRI planes inside the 3D viewer, and full-stored-pitch regional detail. Final tests, build, and offline diagnostics passed. The earlier inverse-reconstruction implementation and optional-outside-mark follow-up are retained as explicitly historical records; their timings, admitted spacing, and full-suite totals are not current native-path results. Current implementation and corpus evidence are recorded under **Implemented native fidelity path** below.

## Outcome and constraints

Make reconstructed MRI detail useful for reviewing a region of interest, and make a tumor-region selection inspectable and correctable in three physical planes. A statistically unusual intensity is not a tumor label. A visually attractive 3D rendering is not an accuracy measurement. Preserve the approved longitudinal alignment, source DICOM bytes, patient/series isolation, acquired-support boundaries, cancellation, offline operation, and existing saved labels.

All patient-derived captures stay in ignored local storage. This document contains no patient identifiers, source-image URLs, or clinical claims. The browser database used by the user is not a test fixture and will not be replaced.

## Historical baseline and first architecture checkpoint (pre-native)

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

The initial reconstruction decision was to retain the physical acquisition/PSF model as the authority, compare fine-grid initialization against the coarse-to-fine schedule, test edge-preserving regularization against uniform Laplacian smoothing, and profile repeated projection work. The later acquisition audit narrowed that inverse path to positively independent inputs and selected direct native-volume assembly for this corpus. In either path, do not substitute a sharper-looking image for fidelity or claim synthetic resolution absent from source data.

## Design

Use the existing Quiet Instrument tokens: image black, graphite surfaces, subdued warm-metal controls, off-white primary text, and teal selection evidence; amber is reserved for excluded/unobserved information. Keep the established display/body/monospace typography. No gradients or decorative cards over anatomy.

The signature is a four-view workbench: three equally useful, linked orthogonal slices and one 3D view. The images, not source settings, own the workspace after reconstruction. Use physical aspect ratios and a common crosshair position; changing plane must not jump to its midpoint. Each slice has direct keyboard/slider navigation. Source details remain accessible separately.

Primary workflow: **Mark inside → Suggest boundary → review and correct → Confirm selection**. **Mark outside** is optional and excludes unwanted tissue. Undo/redo must restore both marks and mask. A box, if present, bounds computation; it is never itself a segmentation. Drafts stay explicitly unreviewed and do not show an authoritative tumor-volume number. Confirmed numbers describe selected tissue volume, not diagnosis.

## Algorithm contract

- Inside marks are required; outside marks are optional. Both are explicit hard constraints. Latest user edits are authoritative; no guessed intensity seed may substitute for them.
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

## Initial inverse-path execution ledger (historical)

1. Reproduced the opaque, incorrectly seeded baseline in the real app. Rejected its output as an accuracy target.
2. Replaced the automatic intensity-outlier seed and single-class grower with explicit foreground/background competition, editable masks, bounded history, and explicit review. Removed the superseded grower, worker, box-seeding helper, and now-unused grid helper.
3. Built the four-view workbench and exercised it on the supplied MRI. Initial checkpoints exposed poor windowing, obscured texture, and editing failures; these were corrected rather than accepted as completion.
4. Traced an actual React development-preview out-of-memory failure to recursively profiled MRI-array props. Moved shared imaging buffers into context, preserving profiling and avoiding a renderer-specific workaround.
5. Replaced clipped intensity normalization and uniform SVR smoothing, then compared against independently acquired synthetic texture phantoms. Preserved the longitudinal alignment solver's existing regularization default.
6. Replaced the foggy clip boundary with an exact windowed MRI cut surface. Whole-head sampling was still too coarse for detailed region review, so added source-backed regional reconstruction with atomic draft-annotation transfer.
7. Validated growth, editing, undo/redo, acceptance, regional refinement, regrowth, and exact saved-mask/mark restoration in headed Chrome using the full three-orientation examination. Checked compact desktop and mobile layouts separately.
8. Final review fixed stale worker-error ownership, canceled/in-flight strokes, replacement-volume GPU identity, save/hydration ordering, and preservation of accepted reconstruction settings during regional refinement. Automated regressions cover these cases.
9. The final GPU-residency regression exposed a timing-sensitive test setup: a visibility uniform could precede the initial label upload. The test now waits for the actual accepted mask bytes before asserting zero reallocations on mode switches. The final full suite passes with that stronger readiness oracle.

## Initial segmentation and inverse-path changes (historical implementation record)

These sections describe the initial implementation before native-source admission. The segmentation intent, correction, support, and persistence contracts remain relevant. Original MRI planes, source selection, retained registration transforms, and native-detail sampling are superseded by the current native implementation described later; the 0.50 mm request and memory-coarsened inverse-grid figures below are not the native-detail contract.

### 1. Explicit, correctable segmentation

The default workflow is **Mark inside → Suggest boundary → review and correct → Confirm selection**, with optional **Mark outside** corrections. Suggestion is explicit; a brush stroke does not silently launch a new segmentation or overwrite a confirmed mask. The application calls the result a tissue selection, not an automatically diagnosed tumor. The suggestion action, not the confirmation action, receives the primary warm-metal emphasis.

`seededVolume.ts` implements a two-class multi-source Dijkstra traversal over a bounded, physically spaced voxel graph. Foreground and background marks are hard constraints. The neighbor cost is:

```text
0.0025 × physical step + normalized intensity difference² / physical step
```

Both bright and dark tissue are eligible. Intensity normalization uses the local robust range, with sampled and explicitly marked extrema as a fallback when percentiles collapse around a small structure. Equal-cost competition deterministically chooses background. The default domain uses the full reconstruction when it fits the 2,000,000-voxel cap; otherwise it admits the widest equal physical padding around all explicit marks that fits. Explicit caller bounds remain authoritative. A mark span exceeding the cap fails before solver allocation.

Automatic outside seeds sit on the acquired search exterior. A bounded flood through missing/nonfinite data connected to the rectangular shell locates that exterior without turning enclosed data gaps into outside annotations. No missing voxel becomes selected or contributes an intensity edge to the geodesic solver. Explicit outside marks are applied next and inside marks last. The publication hook independently composes the supported explicit marks over the proposed mask, so a proposal is never authoritative over the user's corrections. A memory-limited context is disclosed in the review UI.

The worker retains one source copy across growth requests. Renderer-owned arrays are never transferred or detached. An indexed heap stores each voxel once, work yields every 8,192 visited nodes, cancellation never publishes a partial result, and requests have a 30-second deadline. Source/geometry changes dispose the worker; a late event from a disposed worker cannot cancel its replacement. If workers are unavailable, the UI reports that growth is unavailable while keeping manual editing usable.

Direct edits are sparse reversible patches. Undo/redo restores the mask, both mark classes, and draft/reviewed state together; history is limited to 20 edits and 32 MiB. Marks persist with the mask. A new stroke wins over contradictory previous marks. Canceling a pointer interaction, changing the volume/plane/tool, or pressing Escape discards an unfinished stroke rather than committing partial input.

### 2. A review workbench, not a magenta surface

- Linked axial, coronal, sagittal, and 3D views occupy the main workspace. Reconstructed-source controls collapse after a successful run without disappearing.
- Slice aspect ratios and crosshair position use patient millimeters. Radiological orientation markers, 1-based slice inputs, sliders, wheel/keyboard browsing, physical coordinates, and acquired-support feedback are available together.
- Any pane can expand. The three slice views remain mounted when surrounding controls change, and Escape restores the four-view layout.
- A 0.5–8 mm brush draws include/exclude marks directly on any plane. Navigate mode permits mobile page scrolling; drawing mode owns its pointer gestures.
- Anatomy, Overlay, and Selection only are explicit display states. A thin teal boundary and approximately 10% interior tint leave MRI texture visible. Small teal/amber marks distinguish included and excluded evidence.
- At this stage, shared window/level controls affected display only. The 3D cut followed the axial crosshair and displayed the windowed **reconstructed-volume** sample at the plane intersection, without synthetic surface shading at that cut. The original DICOM image plane was not yet implemented; it is now available in the native workflow below.
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

## Historical initial implementation validation (pre-native)

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

## Historical initial implementation verification (pre-native)

These completed checks apply to the earlier implementation checkpoint, not to the final native-source worktree. Current full-suite, build, and React Doctor results are recorded in the final native verification section below.

- Four private-corpus runs: 9 passing tests each.
- Final accepted-settings regression: 53 passing tests across three files.
- Full suite: **1,043 passed, 0 failed, 11 opt-in skips across 116 test files** (`frontend/tmp/svr-full-final-regression.json`). Private-corpus cases were run explicitly as recorded above.
- `npm run lint`: **PASS**. Prettier check over all changed production/test files and this report: **PASS**.
- `npm run build`: **PASS**, including TypeScript project references and the Vite production bundle. Vite still warns about the existing large main bundle (approximately 2.70 MB minified); this pass does not claim to resolve application-wide initial-download size.
- React Doctor: **273 files scanned, zero local issues**. Its numerical score requires an external service; that request was blocked, so no numerical score is claimed.
- Temporary trace logging is removed, obsolete production imports are absent, and `git diff --check` passes.
- Patient images, captures, and corpus receipts remain ignored/local; no MRI source files have been staged by this work.

The React Doctor configuration extends only two existing narrow exemptions: cooperative sequential yielding in annotation resampling, and keyboard-tested canvas application semantics in the new editor. Performance, lifecycle, derived-state, and component-size findings were fixed in code rather than hidden by broad exclusions. The final brush-controls extraction preserves the exact DOM/interaction contract and is covered by the rerun viewer tests.

## Historical follow-up: optional outside marks and reliable boundary suggestions

This follow-up preceded native-volume assembly. Its segmentation corrections remain in the current implementation, but its whole-head/regional reconstruction timings and coarsened grids describe the former inverse path. Three orientations in these older corpus runs were not proof of three independent acquisitions; the subsequent source-header audit corrected that assumption.

### Reproductions and decision

The user reported that suggestions could remove explicitly included tissue. No realistic solver counterexample dropping a valid hard foreground seed was found: the existing zero-cost hard seeds already win. The follow-up adds a publication-level invariant and deliberately faulty-worker regressions so that even a proposal omitting inside marks or including outside marks cannot violate explicit edits. Latest contradictory brush edits still win, and suggestions remain undoable drafts.

Two independent context defects were reproduced:

1. A fixed 12 mm margin can place automatic outside seeds **inside** a larger structure. For independently defined bright and dark 32 mm spheres, the old default selected 515 of 17,077 true voxels (Dice 0.05855). The unchanged competing-geodesic solver with full context selects all 17,077 (Dice/precision/recall 1). This justifies replacing the guessed radius, not adding a more elaborate solver.
2. A rectangular shell containing no acquired data can leave an inside-only component without any outside competitor. A 9³ fixture with a 7³ acquired island selected all 343 supported voxels despite a sharply bounded 27-voxel interior structure. The exterior-aware initialization fixes both intensity polarities and preserves an explicit inside mark on the acquired frontier. Separate enclosed-cavity fixtures retain all 123 supported structure voxels, rather than eroding tissue around a missing/NaN hole.

The alternatives were a new graph-cut/random-walker solver, automatic seeds at every missing-data neighbor, and correcting the existing solver's context. A different optimizer does not repair incorrect constraints; treating every internal gap as outside would introduce another incorrect constraint. The implementation retains the geodesic solver, expands physically bounded context, and finds the boundary-connected acquired exterior. Frontier scratch is bounded at an additional 10 MB at the domain cap; cancellation is checked during both the exterior flood and geodesic traversal. This deliberately spends more computation on context instead of promising the former tiny-domain latency.

### Real-app validation on the full MRI examination

Clean-source run `308` used all 716 source frames in an isolated, headed installed Chrome, WebGL2 / ANGLE Metal / Apple M4 Max. Temporary source traces had been removed. Actual UI actions exercised inside-only suggestion, marks on adjacent slices, optional outside corrections, repeated suggestion, direct editing, exact undo/redo, confirmation, source-backed refinement, and reload.

- Inside-only suggestion: five inside marks, no outside marks, 175,940 selected voxels; **zero missing inside marks, included outside marks, or unsupported selections**. Worker time 2,542.6 ms; action-to-observed-result 2,829.7 ms for a 1,921,875-voxel domain. The deliberately unlabeled test point produced a broad anatomy selection, not a clinically verified tumor mask.
- Multi-slice suggestion: 20 inside / 20 outside marks, 7,220 selected voxels. A later outside stroke overlapping earlier inside marks produced 15 inside / 25 outside marks and 7,215 selected voxels. Undo/redo restored the exact mask and mark states.
- Regional reconstruction admitted 0.84 mm at 129³. Transferred annotations were a draft; subsequent suggestion preserved all 104 inside and 140 outside marks, with no support violations. The 0.50 mm request is not the admitted grid spacing or a claim of acquired resolution.
- Reload restored 7,215 selected voxels, the exact 15/25 marks, reviewed state, and mask hash `88969244`. This is a persistence checksum, not an accuracy metric.
- Whole-head reconstruction took 13,592 ms; regional reconstruction 5,588.6 ms. These were uncontrolled machine/cache observations, not a reconstruction speed comparison. The reconstruction algorithm itself did not change in this follow-up.
- Zero browser errors. Mobile document/viewport width both 430 px; navigation touch actions remained `pan-y`. This geometry receipt does not imply that every captured mobile image was visually inspected.

Private receipt: `frontend/tmp/private-tumor-segmentation-validation/308-editing-receipt.json`.

The following current captures were each inspected individually at original resolution and immediately audited:

| Local artifact                          | Bounded finding                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `308b2-inside-only-draft-selection.png` | PASS for suggestion/review presentation: clear primary action, readable draft/context warning, grayscale visible through a thin contour. Broad test selection; not tumor-accuracy evidence.   |
| `308f-finer-region-cutaway.png`         | **FAIL for maximum-fidelity review**: selected tissue is undersized in the viewport, with soft texture and visibly stepped geometry. This is a reconstructed cutaway, not native MRI imagery. |
| `308i-laptop-regional-workbench.png`    | PASS for 1280×900 editing layout: all four panes and navigation fit, with unobstructed controls and clear draft status. Does not clear the 3D fidelity limitation.                            |

Other run-308 images are captured but not individually validated. Browser cleanup is **CLOSED**: current and stale owned processes/profiles were audited clear, the user's browser was preserved, and the local preview remains available.

### Historical follow-up verification

- Full source suite at this checkpoint: **1,077 passed, 0 failed, 11 opt-in skips across 116 files** (`frontend/tmp/svr-optional-outside-full-regression.json`).
- Private examination ordinals **1, 9, 15, and 18**: **13 passed, 0 failed, 0 skipped each**, including both optional-outside modes on the same source reconstruction. These are unlabeled workflow/support checks, not clinical accuracy scores.
- Focused viewer workflow: **33 passed**. Final focused solver tests: **33 passed**, including explicit cancellation during exterior discovery and during geodesic traversal.
- Lint, TypeScript/Vite production build, scoped formatting, and `git diff --check`: **PASS**. The existing approximately 2.70 MB minified main-bundle warning remains.
- Offline React Doctor: **267 files scanned, complete, zero errors or warnings** (`frontend/tmp/svr-optional-outside-react-doctor.json`). The existing cooperative-yield exception is narrowly extended to `seededVolume.ts`: these are dependent queue traversals, not parallelizable I/O. Tests prove cancellation in both phases. Remote scoring/telemetry and supply-chain requests were disabled; no numerical score is claimed.
- Temporary source tracing is removed. MRI files and captures remain private/ignored; no new files were staged or committed. Current implementation receipts above supersede the initial implementation totals for this follow-up.

## Implemented native fidelity path: preserve native 3D data and browse original MRI planes

**Implemented and validated within the evidence scope below.** The user approved browsing original MRI planes inside the 3D selection, then asked why three planes do not produce a more detailed volume. The resulting source-header audit changes the volume architecture, not just its rendering settings. For the audited corpus, the original 3D acquisition is now the primary data source, with source-faithful MRI planes; multi-acquisition reconstruction is reserved for positively independent compatible acquisitions. The numbered requirements below record the approved contract; the implementation receipts following them identify what has actually been verified. Native source/control/editing workflows have now been exercised in all four audited examinations; complete reload and native-detail workflows were exercised in checkpoints 314, 315, and 318, not in the representative-only 316/317 runs.

### Acquisition audit: the three views are not three independent measurements

A header-only audit inspected 8,439 MR instances, including 2,890 FLAIR frames, in examination ordinals 1, 9, 15, and 18. No pixels were decoded or images published. One additional candidate header did not parse; its modality/relevance was not established. The private script and receipt remain ignored under `frontend/tmp/private-tumor-segmentation-validation/audit-svr-acquisition.mjs` and `audit-svr-acquisition-receipt.json`.

Every audited FLAIR triplet has:

- A sagittal series with MR Acquisition Type `3D` and Image Type `ORIGINAL / PRIMARY / OTHER`.
- Axial and coronal series explicitly marked `DERIVED / SECONDARY / REFORMATTED / AVERAGE`.
- A shared spatial frame, acquisition number, matching acquisition timestamp evidence, echo/repetition times, and acquisition matrix. Examination 15's original series contains two timestamps; timing alone is not the authority.
- No explicit Source Image / Derivation Image Sequence linking those FLAIR series. The calibrated conclusion is **explicit averaged reformats with strongly coherent same-acquisition metadata**, not a verified source-UID derivation graph. No additional independent measurements are evidenced by the reformats.

| Examination | Original sagittal stack: frames × rows × columns | Stored in-plane sample spacing | Slice-center spacing / declared thickness | Acquisition frequency samples / FOV |
| ----------- | ------------------------------------------------ | ------------------------------ | ----------------------------------------- | ----------------------------------- |
| 1           | 300 × 512 × 512                                  | 0.4297 mm                      | approximately 0.60 / 1.20 mm              | 224 / 220 mm                        |
| 9           | 260 × 1024 × 1024                                | 0.2266 mm                      | approximately 0.60 / 1.20 mm              | 232 / 232 mm                        |
| 15          | 264 × 512 × 512                                  | 0.4297 mm                      | approximately 0.60 / 1.20 mm              | 224 / 220 mm                        |
| 18          | 274 × 512 × 512                                  | 0.4297 mm                      | approximately 0.60 / 1.19 mm              | 224 / 220 mm                        |

The nominal frequency-direction acquisition sampling is approximately 0.982–1.000 mm (FOV divided by acquisition matrix), while stored images use a finer reconstruction grid. These are different quantities. Neither the stored 0.23/0.43 mm pixels nor the 0.60 mm slice spacing proves equally fine acquired resolution. Actual effective resolution also depends on the scanner's point-spread function and reconstruction; it was not measured here. Phase FOV varies, so the simple frequency calculation is not presented as a two-axis measured resolution. [DICOM MR Image Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.3.html).

Before this implementation, admission in `reconstructVolume.ts` verified different series/SOPs and different normals, but called that “physically independent acquisition orientations.” `svrComputeCore.ts` repeated the normal-count heuristic. That proves orientation diversity, not acquisition independence. Image Type, acquisition type/matrix, and derivation provenance were not persisted. The new versioned acquisition metadata and classifier replace that assumption; prior workflow/support tests and orientation counts alone do not validate acquisition independence.

### Why the previous volume lost detail

These observations describe the baseline that motivated the implementation, not the new native-volume path.

1. **The input model is wrong for this corpus.** The original stack is already a reconstructed 3D acquisition. Treating its averaged reformats as new independent thick-slice observations can double-count correlated evidence and add interpolation/profile-model error. The exact contribution to visible blur has not yet been isolated experimentally.
2. **Spatial sampling is deliberately reduced.** Defaults request 1 mm with a 192-voxel-per-axis cap. Source frames undergo area averaging toward the requested pitch, and the 512 MiB memory planner can coarsen both source and output sampling. The recent whole-head run admitted 1.49 mm. In voxel-aware mode, 128 pixels is a floor on the allowed source size, not a universal hard input cap.
3. **Regional cropping happens too late.** `Svr3DView.tsx` budgets full in-plane frame dimensions and coarsens sampling before decoding. `reconstructVolume.ts` then downsamples the full frames. `svrComputeCore.ts` only crops their in-plane pixels after its own memory admission and registration. Frame filtering already drops irrelevant slice planes, but full in-plane pixels that are later discarded still influence the earlier memory/quality decision.
4. **Inverse reconstruction is approximate.** The current solver uses a finite slice-profile model, three iterations, and edge-preserving regularization. More iterations or less regularization could recover some residual structure in an appropriate independent-acquisition problem, but could also amplify noise/model mismatch. The current default does not use the old coarse initialization or percentile clipping; those are not explanations for this version's remaining softness.
5. **Presentation loses detail separately.** Composite rendering integrates opacity and lighting, uses a fixed 256 settled ray samples, and caps device pixel ratio at 1.5. Interaction reduces samples/resolution further. The current cut surface samples the SVR texture; it is not an original MRI plane. A higher-resolution mask can improve voxel-stepped geometry, while display smoothing alone cannot establish more accurate anatomy.

### What genuine super-resolution can and cannot recover

A useful forward model is `observed image = sampling(blur(transform(volume))) + noise`. Independent acquisitions with different slice directions or sub-voxel offsets can constrain spatial detail lost by each individual acquisition. Repeated measurements can also improve noise, but more files or finer output voxels do not by themselves increase recoverable spatial bandwidth. Derived reformats are transformations of existing observations, not fresh measurements. Most adjacent slices add spatial coverage, not hundreds of independent measurements of the same voxel.

For genuinely independent thick-slice acquisitions, model-based reconstruction can improve through-plane detail and 3D delineation. This does not promise arbitrarily fine isotropic resolution or improvement beyond the best native in-plane detail. Blur, incomplete frequency coverage, noise, motion, and uncertain slice profiles constrain the result. [Comparative MRI reconstruction study](https://pubmed.ncbi.nlm.nih.gov/26632048/), [analysis of complementary acquisition strategies](https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2022.1044510/full).

Halving voxel spacing creates eight times as many voxels, but not eight times as much measured information. For the current corpus, the immediate target is **recovering fidelity our software discards**, not claiming new anatomy beyond the scanner's original 3D acquisition. Different dates remain separate volumes; changed tumor anatomy is not repeated measurement noise that can safely be averaged away.

### Native architecture decision and falsifiers

- **Failed baseline outcome:** the earlier reconstructed cutaway was softer/blockier than original images; its original-resolution visual evidence and the acquisition headers independently motivated the change.
- **Classification:** structural source-model mismatch plus avoidable source-sampling loss, with separate rendering limitations.
- **Retained progress:** explicit marks, correction/undo/persistence, source isolation, and cancellation are still useful. Their passing tests do not clear acquisition independence or maximum fidelity.
- **Alternative A:** raise reconstruction dimensions/iterations and improve rendering while still fusing the same reformats. This increases cost without correcting the input evidence model.
- **Alternative B — selected:** provenance-aware source selection; native original-3D rendering for a coherent original stack; bounded full-detail native ROI/planes; model-based fusion only for verified complementary acquisitions. Unknown or derived-only data can still be viewed honestly without a super-resolution claim.
- **Migration boundary:** retain all imported DICOMs and saved selections. Read missing provenance from existing local blobs or a versioned metadata refresh, not forced re-import. Masks stay bound to their original reconstruction fingerprint; transfer into new geometry is explicit and becomes a draft.
- **Forecast/falsifier:** source-aligned native planes should preserve decoded values before display mapping, and early regional extraction should retain native pitch with fewer copied source bytes. Reject a variant that alters source values, mixes coordinate frames, relies on reformats as independent holdouts, violates support/marks, or looks sharper without improving independently measured fidelity.

### Experience

- Default to the original 3D acquisition for the audited examinations. Whole-head overview quality may be adaptive, but the selected region and original-image planes retain native stored samples within a bounded cache. Do not require three orientation series to open an already-3D acquisition.
- A movable, unlit **Original MRI** plane passes through the 3D selection. Scroll steps through stored source-series frames; source series, provenance, and slice index remain visible. A derived reference reformat is not relabeled as an independent acquisition.
- **Whole slice / Selection only** chooses between anatomical context and a mask-cropped slice. A thin contour is the default annotation; optional faint surrounding context helps orientation without obscuring grayscale detail.
- Linked crosshairs synchronize the 3D plane and orthogonal views. **Fit selection** frames the selected region instead of leaving it tiny within the whole reconstruction bounds.
- Arbitrary oblique sections remain available as **Interpolated** views. Native acquired planes and interpolated/reconstructed planes must never share a misleading “Original” label.
- Original means the acquired DICOM pixel image, not scanner k-space. Window/level changes only display mapping; it does not alter stored source values.

### Implementation order and correctness requirements

1. **Classify source provenance before choosing an algorithm.** Persist/read Image Type, MR Acquisition Type, acquisition matrix/FOV, and available source/derivation references. Distinguish original 3D stacks, derived reformats, genuinely independent compatible acquisitions, and unknown provenance. Reuse patient/examination/frame/sequence safety checks. Different normals or SOP UIDs alone do not establish independence.
2. **Provide a native original-3D path.** Validate regular slice geometry and preserve the native grid's orientation, spacing, origin, signed intensities, and support. Avoid another inverse reconstruction when a coherent original volume already exists. Render a bounded overview and extract the selected native region at full stored pitch; use streaming/bricking where a full native stack exceeds CPU/GPU budgets. Do not silently promote scanner interpolation to acquired resolution.
3. **Retain accepted geometry provenance.** The prior SVR path mutated source geometry for bounds-center/ROI-rigid registration and later discarded loaded slices. Return small immutable source identities and native-patient-mm → accepted-volume-patient-mm transforms, including explicit identities. Keep canonical full native frame metadata main-side, separate from cropped/downsampled geometry and from the subset that contributed to reconstruction. Bind it to fingerprint, dataset generation, examination, and spatial frame. Do not infer a registration transform from a crop-origin shift. Refinement must receive its own accepted provenance; if fitted transforms are reused, ROI admission must use those transforms too.
4. **Retain intensity provenance.** Preserve the normalization affine alongside a reconstructed volume, or keep source VOI explicitly independent. The prior normalization result exposed a display window and robust range scale but not enough metadata to convert arbitrary original-source window values into normalized SVR units reliably.
5. **Extract native regions before reducing detail.** Decode through the existing bounded Cornerstone path, crop at native pitch before source-copy budgeting/downsampling, and account for the decoded cache separately. Include interpolation, acquisition-profile, and registration-context margins where the independent-acquisition inverse model requires them; direct native copying needs only its physical crop halo. For registered sources, inverse-map the accepted ROI into source coordinates; a tight unregistered crop can discard needed anatomy. Retain source VOI/inversion, padding, finite-sample validity, and signed modality-scaled values. Native planes load by accepted SOP identity, with a bounded visible-plus-neighbor cache and stale-result guards.
6. **Render a native-resolution textured plane.** Add an unlit patient-space image plane with depth-correct compositing in the existing WebGL renderer, using original integer or float32 source samples with explicit interpolation and windowing. Avoid silently inheriting the reconstructed volume's R16F/R8 precision path. A whole source plane must remain visible outside a smaller reconstructed region; volume-box early rejection cannot clip it accidentally. Full stored-sample fidelity means preserving the image samples, not establishing acquisition resolution; their projected screen image still undergoes rasterization.
7. **Project labels, not reconstructed texture.** Map native pixels through DICOM geometry and the accepted transform into label coordinates. Sample labels categorically for selection-only clipping; never interpolate new labels into existence or tint away grayscale texture. Display-only edge antialiasing must not alter the measurement mask. Reuse the existing patient-space crosshair authority rather than adding an independently drifting cursor.
8. **Tune actual reconstruction only on appropriate inputs.** For complementary independent acquisitions, compare native-pitch regional inputs first, then separately evaluate acquisition-aware PSF, noise/intensity calibration, and convergence (including 3 versus 6/10 iterations). Fit to all retained native measurements with robust data consistency and edge-preserving regularization; choose parameters on independent phantoms/held-out acquisitions, not perceived sharpness alone.
9. **Improve settled rendering after source fidelity.** Scale ray steps with voxel traversal distance, use full-device-resolution settled frames when admitted, and keep the fast interaction path. Fit the camera to the selected region. Any display surface smoothing stays separate from the categorical selection and reported volume.

DICOM defines image placement through image position, orientation, and pixel spacing; preserve its pixel-center convention, not a guessed image-box transform. [DICOM Image Plane Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html). Slice visibility in 3D and linked crosshairs are established review interactions in [3D Slicer](https://slicer.readthedocs.io/en/latest/user_guide/user_interface.html#slice-view); this is interaction guidance, not validation of MiraViewer.

### Acceptance evidence

- Provenance tests include original 3D plus derived reformats, truly independent anisotropic stacks, missing legacy metadata, conflicting lineage, and source changes. A same-acquisition reformat cannot count as an independent acquisition or independent held-out fidelity test.
- Asymmetric synthetic planes with oblique orientation, anisotropic pixels, nonzero origin, reversed ordering, known rigid transforms, and half-pixel offsets; exact expected patient-space landmarks.
- Same-window source pixel and display parity for signed values, padding, inversion, and narrow windows. Compare original viewer versus the new native 3D plane at matched native zoom, and label the reconstructed comparison separately.
- First controlled fidelity experiment: reuse the independently integrated texture phantom; hold ROI, output grid, registration, normalization, PSF, iterations, regularization, and display fixed. Compare current pre-averaged source frames against correctly positioned native-pitch regional crops. Measure anatomy/gradient error, thin-structure contrast, independent held-out prediction, support equality, resident bytes, and wall time. Then vary solver convergence separately. On this corpus, use native-source parity for fidelity preservation rather than treating its reformats as independent anatomical truth.
- Exact mask-projection and hard-mark tests; no anatomy rendered in missing support. Source/reconstruction switches, cancellation, reload, and cache eviction must not combine stale texture with new geometry.
- Several dates, sequences, and selection edges from the private corpus, plus expert contours before claiming clinical segmentation accuracy. The audited FLAIR orientation triplets explicitly include averaged reformats and must not count as independent resolution evidence.
- Record first-frame latency, cached slice browsing, settled-frame cost, and peak bounded cache memory separately. Current frame samples and static captures do not prove sustained interaction performance.

### Native-source implementation and current evidence

The implementation now has one source-authority decision before processing:

- An original, geometrically coherent 3D acquisition is opened directly. Its grid is permuted/flipped without interpolation, retaining residual obliquity, physical sample centers, signed modality values, padding validity, and source windowing. A memory-admitted overview uses explicitly reported integer sampling strides; regional detail requests retain the original stored pitch or fail without replacing the previous result.
- Positively independent, compatible original 2D acquisitions use the existing model-based inverse solver. Different normals alone no longer qualify. Regional input copies are cropped at native pitch before reduction; the UI and pre-decode runtime share the source-copy memory estimate. Complete solver admission remains authoritative.
- Unknown or derived-only input may be opened as one honest source stack, without inventing independence. A conflicting identity or derivation graph is rejected. Additional sources only receive a usable pose when they have an accepted registration or positively coherent same-acquisition reformat provenance.

The source provenance is a detached immutable metadata snapshot, not another copy of the MRI pixels. It retains canonical full-frame identities and geometry separately from contributing/cropped frames, binds them to the dataset generation and reconstruction fingerprint, and preserves accepted patient-space transforms for refinement. Missing acquisition metadata is read from existing local blobs in bounded batches; re-import is not required.

The first integrated refinement attempt exposed a structural memory mismatch, not a reason to reduce native resolution. Processing frames were copied into the volume and also accumulated in the general decoded-image cache, while a narrow selection was expanded into a large cube. Native assembly now uses Cornerstone's non-inserting `loadImage` path: existing cache entries are reusable, newly streamed processing frames are not added, and no global cache is purged or reconfigured. The planner reserves measured existing residency, bounded future browsing frames and upload buffers, with a conservative fallback when telemetry is unavailable. Independent-acquisition decoding and long-running ONNX inference retain their separate cache allowances.

Native refinement uses a rectangular patient-space box around the actual selected voxel footprints and every inside/outside mark, plus `max(2 mm, twice the largest native sample spacing)` of context. It does not require the inverse solver's registration margin; the original MRI plane independently supplies wider anatomical context. Independent-acquisition refinement retains its existing cube and 12 mm margins. This is not a smaller mask or reduced pitch: it avoids allocating unrelated corners of a cube. In the reported oblique failure envelope, the new physical box occupies 19.7% of the old cube's volume. An oversized real selection still fails without replacing the accepted result or silently reducing native sampling.

Annotation transfer is categorical, not another MRI reconstruction. It maps the mask through patient coordinates and independently forward-maps every explicit inside/outside mark so a thin mark cannot disappear when grids change. A mark outside the target crop or acquired support, an invalid source mark, or opposing classes collapsing into one target cell rejects the transfer and retains the original. Successful transfers remain drafts; cancellation and source ownership are checked before publication.

The 3D viewer now includes a float32, unlit original-image plane with independent DICOM window/level and inversion. A shared patient-space cursor drives actual source-frame navigation and linked volume views, including fractional positions on coarser overviews. The plane supports whole-slice context, categorical selection-only clipping, a thin contour, optional explicitly interpolated display, camera-facing alignment, and selection fitting. Source planes remain visible outside a cropped volume's bounds. Settled volume rendering uses voxel-aware ray sampling and full device resolution within a framebuffer pixel budget; interaction keeps its cheaper path.

Saved selections remain geometry-bound. Compatible prior grids can be copied only by an explicit **Copy saved selection as draft** action; unverified older grids remain stored and included in backups. Exact saved-grid restoration, cancellation, dataset changes, and transfer failures cannot silently publish stale work. The original is never deleted by a transfer. The first-interactive-commit hydration race was reproduced before the fix and covered by a regression test. Optional ONNX preprocessing now normalizes native values independently of display contrast and requires explicit native-grid compatibility: `input.spatialFrame: "source-grid"` is an assertion the supplied model must genuinely satisfy, not a workaround for an incompatible model.

Evidence recorded so far, all local and with no MRI publication:

- The production acquisition extractor/classifier was replayed against **all 2,890 FLAIR headers in the four supplied examinations**. Each admitted its original sagittal source plus both coherent reference reformats. The original two-timestamp case was retained. Receipt: `frontend/tmp/private-tumor-segmentation-validation/replay-native-reference-metadata-receipt.json`.
- Actual-app checkpoint 312 used installed headed Chrome on **ANGLE Metal / Apple M4 Max**, not software rendering. The original source plane was inspected expanded and at matched scale against an independently decoded source reference. **427,716 eligible displayed pixels had zero grayscale error**; all 262,144 original samples had zero modality/validity mismatch. Projection error was approximately `7.0e-15` grid units. The comparison excludes padding, out-of-plane rays, and texel-edge rounding bands. This proves preservation for that checkpoint, not additional acquired resolution.
- `312c-expanded-original-source.png`: **PASS** for complete framing, readable controls, unobscured grayscale texture, and the restrained visual design. `312c-source-normalized-comparison.png`: **PASS** for matched-scale source-plane fidelity. Both are under the ignored private validation directory. Earlier camera-framing failure 310 was corrected before this checkpoint. Current and stale owned browser/profile cleanup was audited **CLOSED**; the user's browser and local preview were preserved.
- The controlled independent-observation experiment in `tests/svrNativeInputFidelity.test.ts` fixes the output at `32³`, 0.5 mm pitch and compares native input against 2×2 pre-averaged input. Its analytic acquisition integration is independent of the production projector. It withholds **one complete acquired axial frame**, not an entire examination or orientation series. Native-input anatomy RMSE was `0.01582` versus `0.06854` without noise, and `0.01536` versus `0.05579` with noise; withheld-frame prediction RMSE was `0.02900` versus `0.06205`, and `0.02808` versus `0.05078`. Support was identical. Six and ten iterations reduced residual error further on these phantoms, with diminishing returns; this does not justify changing the global iteration default without independent real acquisitions.
- Focused UI/native-plane/persistence checks currently pass, including explicit draft copying, immediate cancellation, late completion after dataset change, untouched original records, source-contrast independence, exact narrow-window polarity, and recovery from a failed native texture upload. Final whole-suite and broader corpus/workflow receipts are recorded below when completed.

#### Integrated native-detail checkpoint 314

The same examination and reviewed axial slice-79 landmark were exercised through the real import, source selection, physical brush inputs, worker suggestion, correction, undo/redo, confirmation, page reload, and native-detail workflow. This completed with **zero browser errors**. All measurements below are one observed instrumented desktop run, not a sustained-performance benchmark:

| Check                          | Observed result                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Original overview              | `274 × 256 × 256`, `0.60 × 0.8594 × 0.8594 mm`; all original sagittal planes retained                                            |
| Overview readiness             | 1,943 ms; 317 MiB planned processing peak, versus the earlier 433 MiB estimate for half as many overview slices                  |
| Cached source browsing         | 10 samples; reported p50 65.54 ms / p95 79.49 ms through matching loaded-frame state                                             |
| First mark                     | 246.54 ms input-to-ready including two paint opportunities and observation overhead                                              |
| Real worker suggestion         | 4,227.84 ms; no selected unsupported samples, removed inside marks, or included outside marks                                    |
| Reload                         | Exact persisted mask hash, inside/outside marks, and reviewed state restored                                                     |
| Native detail                  | `51 × 102 × 109` at exact `0.60 × 0.4297 × 0.4297 mm`; 704.37 ms through accepted volume, transferred draft, and original plane  |
| Hard-mark transfer             | All 10 inside and 25 outside source marks mapped correctly; no missing, unsupported, out-of-region, or incorrectly labeled marks |
| Source parity after refinement | Zero error across 350,464 eligible display pixels; all 262,144 original samples unchanged; accepted source transforms unchanged  |

`314k-native-detail-full-source-plane.png` and `314k-source-normalized-comparison.png` were individually inspected at original resolution and passed native-region/full-plane context, source fidelity, and layout. Focused images `314l-native-detail-fit-selection.png` and `314l1-native-detail-whole-source-restored.png` proved the rectangular fog artifact was removed and whole-slice context restored correctly, but **failed contour weight at high magnification**; they do not clear the final annotation styling. The contour correction and subsequent corpus matrix must supersede that visual defect. Current and stale owned browser cleanup for this batch was audited **CLOSED**.

#### Native-detail checkpoint 315: the 1024-pixel original acquisition

Checkpoint 315 used examination ordinal **9**, whose original sagittal series contains `260 × 1024 × 1024` stored samples at `0.60 × 0.2266 × 0.2266 mm`. It completed the real source controls, multi-slice marking, worker suggestion, direct correction, undo/redo, confirmation, reload, native-detail extraction, and labeled source browsing with **zero browser errors**. It used the installed headed Chrome / ANGLE Metal / Apple M4 Max path, not a software renderer. These are individual instrumented observations, not controlled speedup or device-wide performance claims.

| Check                             | Observed result                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native-source overview            | `130 × 342 × 342` at `1.20 × 0.6798 × 0.6798 mm`; explicitly subsampled from the original stack                                                                                |
| Overview readiness                | 6,465 ms from open action to accepted volume and slice inspector; this timer does not include the subsequent original-plane readiness wait                                     |
| Cached original-frame browsing    | 10 samples; reported p50 108.39 ms / p95 120.90 ms                                                                                                                             |
| First inside mark                 | 290.94 ms input-to-label-ready; 224.91 ms pointer-up-to-ready, including observation and paint opportunities                                                                   |
| Suggestion                        | 3,634.66 ms over 1,992,536 working voxels; 14,299 selected voxels; all 9 inside and 12 outside marks respected; zero selected unsupported samples                              |
| Correction, undo/redo, and reload | Correction produced 14,296 selected voxels with 6 inside / 15 outside marks; undo/redo hashes matched, and reload restored the exact reviewed mask and both mark classes       |
| Native-detail region              | `89 × 240 × 219` at exact `0.60 × 0.2266 × 0.2266 mm`; no pitch downgrade                                                                                                      |
| Native-detail readiness           | 4,297.27 ms through accepted new volume, transferred draft, and loaded original plane; screenshot capture excluded                                                             |
| Hard-mark transfer                | 6/6 inside and 15/15 outside source marks mapped; zero outside-crop, missing, or incorrectly labeled marks; accepted transforms unchanged                                      |
| Refined draft                     | 257,745 selected voxels; 108 inside / 270 outside target mark voxels after categorical expansion; zero missing inside marks, selected outside marks, or unsupported selections |
| Labeled original-frame browsing   | 6 cached samples with the refined draft present; reported p50 48.975 ms / p95 109.235 ms                                                                                       |
| Native-plane cache                | Maximum recorded 24 MiB against a 32 MiB limit; this is not a measured processing peak or total-browser memory                                                                 |

The browsing percentiles use the harness's nearest-rank convention; the conventional median of the six labeled samples is 49.1125 ms. Browser-clock timings include a 16 ms observation interval and are not GPU frame rates. The 315 JSON receipts do not contain a total processing-peak or browser-RSS measurement; the 314 planner estimate must not be reused for this larger source.

Original sagittal source parity was exact: **427,716 eligible display pixels before refinement** and **350,464 afterward** had zero grayscale error; all **1,048,576 original samples** had zero modality or validity mismatch at each checkpoint. The axial landmark reformat had a maximum one-level difference in 8-bit display grayscale and mean error `0.00041149`, with zero mismatches at the harness tolerance; its 262,144 decoded samples were unchanged. This distinction matters: the original-plane result does not establish zero display error for every source plane. Comparisons exclude padding, out-of-plane rays, and texel-edge rounding bands.

The actual 315 native-detail focused image passed thin-contour and visible-texture inspection; the rotated image passed for its settled endpoint only. The 1280-pixel workbench and expanded mobile image failed their layout/contrast checks and were corrected in checkpoint 316. These failures are retained in the visual ledger below, not silently counted as passes.

Private receipts: `frontend/tmp/private-tumor-segmentation-validation/315-native-validation-receipt.json`, `315c-native-source-parity.json`, `315e0-native-source-parity.json`, and `315k-native-source-parity.json`.

#### Representative native workflows 316 and 317

Checkpoint 316 exercised examination ordinal **1** and checkpoint 317 exercised ordinal **15**, including the original series whose acquisition metadata contains two timestamps. Both completed source selection and browsing, independent source/volume window controls, physical marks across slices, actual worker suggestion, direct correction, exact undo/redo, confirmation, and whole-slice/selection-only presentation with **zero browser errors**. Their declared stage is `representative`: these receipts do **not** establish another reload or native-detail run. Those stronger workflow checks are supplied by 314 and 315.

| Check                                   | 316 / examination 1                                                                   | 317 / examination 15                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| Original source                         | `300 × 512 × 512`                                                                     | `264 × 512 × 512`                           |
| Overview                                | `300 × 256 × 256`                                                                     | `264 × 256 × 256`                           |
| Overview / original stored pitch        | `0.60 × 0.8594 × 0.8594 mm` / `0.60 × 0.4297 × 0.4297 mm`                             | Same pitches                                |
| Accepted overview/inspector readiness   | 4,356 ms                                                                              | 1,635 ms                                    |
| Cached source browsing, 10 samples each | Reported p50 58.37 ms / p95 67.10 ms                                                  | Reported p50 68.69 ms / p95 93.33 ms        |
| First mark, input-to-ready              | 279.04 ms                                                                             | 203.61 ms                                   |
| Suggestion                              | 3,686.13 ms; 6,310 selected voxels                                                    | 3,446.77 ms; 22,381 selected voxels         |
| Working domain                          | 1,937,754 voxels                                                                      | 1,937,754 voxels                            |
| Reviewed selection after correction     | 6,305 voxels; 10 inside / 25 outside marks                                            | 22,376 voxels; 10 inside / 25 outside marks |
| Hard-mark / support violations          | None before or after correction                                                       | None before or after correction             |
| Original-plane parity                   | 427,716 eligible display pixels with zero error; all 262,144 source samples unchanged | Same zero-error counts                      |
| Maximum recorded native-plane cache     | 6 MiB / 32 MiB limit                                                                  | 6 MiB / 32 MiB limit                        |

Both reference-series switches preserved the physical cursor and accepted frame identity. Source-window changes did not modify the volume window or MRI samples; selection-only clipping did not modify the mask or the volume visualization mode. Source and axial-landmark parity receipts both passed numerically. The individually inspected original-source comparisons are listed below; numerical parity alone does not imply every saved image was visually inspected.

The compact-workbench correction was exercised in 316: at a 1280 × 900 viewport, the lower 3D canvas measured **622 × 287 pixels**, replacing 315's **626 × 99** canvas. The lower row remains reachable by scrolling rather than compressing the images to fit everything above the fold. At a 430-pixel mobile viewport, the unexpanded 3D canvas measured **404 × 331 pixels**; source navigation remained usable. Mobile checks use desktop Metal with a touch/CSS viewport, not an actual mobile GPU or a mobile performance benchmark.

Private receipts: `frontend/tmp/private-tumor-segmentation-validation/316-native-validation-receipt.json`, `317-native-validation-receipt.json`, and their `c-native-source-parity.json` / `e0-native-source-parity.json` companions.

#### Individually inspected native-source visual ledger

Each named image below was inspected at original resolution during its parent validation pass. The JSON capture receipts deliberately retain `CAPTURED-UNVALIDATED`; the scoped written verdicts here record the separate visual inspection. Files not named here do not inherit a visual pass. All images remain private and ignored under `frontend/tmp/private-tumor-segmentation-validation/`; none is embedded or published.

| Artifact                                                                     | Scope and verdict                                                                                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `315c-source-normalized-comparison.png`                                      | PASS: original 1024-pixel matched-scale source fidelity; not evidence of new acquired resolution.                                                                           |
| `315l-native-detail-fit-selection.png`                                       | PASS: focused native-detail region with a thin contour and visible source texture; supersedes 314's high-magnification contour-weight failure. Not an expert tumor contour. |
| `315l2-native-detail-rotated-selection-context.png`                          | PASS: settled rotated endpoint and selected-region context; no motion or frame-rate verdict.                                                                                |
| `315m-laptop-native-workbench-1280.png`                                      | FAIL: lower 3D canvas too short. Superseded by the inspected 316 lower-row correction.                                                                                      |
| `315p-mobile-expanded-native-source.png`                                     | FAIL: contrast/readability of over-image controls. Superseded by the inspected 316 mobile correction.                                                                       |
| `316a-actual-new-mri-before-segmentation.png`                                | PASS: desktop workbench hierarchy and usable image presentation.                                                                                                            |
| `316m2-laptop-native-source.png`                                             | PASS: usable lower-row 3D image at 1280 pixels and reachable scrolling layout.                                                                                              |
| `316p-mobile-expanded-native-source.png`                                     | PASS: touch controls, clear control halo, and useful expanded-image height.                                                                                                 |
| `316n-mobile-native-workbench-top.png`                                       | PASS: mobile toolbar readability and layout.                                                                                                                                |
| `316c-source-normalized-comparison.png`                                      | PASS: matched-scale original-source fidelity; numerical zero error across 427,716 eligible displayed pixels and 262,144 original samples.                                   |
| `316h-confirmed-source-plane-selection-only.png`                             | PASS: bounded selection-only presentation on the coarse overview. Does not establish clinical boundaries or native-ROI mask geometry.                                       |
| `317c-expanded-original-source.png`, `317c-source-normalized-comparison.png` | PASS: expanded source framing and matched-scale original-source fidelity; zero error across 427,716 eligible display pixels and 262,144 original samples.                   |

Current and stale validation-owned browser processes/profiles for 316 and 317 were audited **CLOSED**. The user's browser, loaded local data, and source MRI folders were preserved. Cleanup and zero browser errors do not substitute for source-fidelity or clinical validation.

#### Final integrated checkpoint 318

After the reliability fixes below, the complete high-resolution examination-9 workflow was repeated in the actual app: source browsing/windowing, multi-slice marks, worker suggestion, correction, exact undo/redo, confirmation, reload, native-detail extraction, original-plane clipping, rotation, and compact layouts. It completed with **zero browser errors** on headed Chrome / ANGLE Metal / Apple M4 Max.

- The overview remained `130 × 342 × 342` at `1.20 × 0.6798 × 0.6798 mm`; the native region remained `89 × 240 × 219` at exact `0.60 × 0.2266 × 0.2266 mm`. The bounded planner did not change these normal-corpus sampling decisions.
- Overview/inspector readiness was 5,801 ms; native-region readiness was 4,377.61 ms, including annotation transfer and the loaded original plane. Suggestion took 4,023.49 ms across 1,992,536 working voxels. These are observed instrumented durations, not controlled speedup claims.
- All six inside and fifteen outside source marks mapped correctly into the native region, with no missing, unsupported, out-of-crop, or incorrectly labeled marks. Exact reviewed-state reload and undo/redo checks passed. The transferred native selection remained a draft; accepted source transforms were unchanged.
- All 1,048,576 original sagittal samples remained unchanged before and after extraction. Original-plane display parity had zero error across 427,716 eligible pixels before extraction and 350,464 afterward. The derived axial reference retained the previously disclosed maximum one-level display difference, not a falsely claimed zero-error result.
- Ten cached browsing samples reported p50 89.87 ms / p95 115.98 ms. Six labeled native-region samples reported p50 43.79 ms / p95 142.63 ms. These include UI observation overhead and do not establish sustained GPU frame rates.
- The compact 3D canvas measured `622 × 287` at laptop width and `404 × 310` at phone width, with no horizontal document overflow. Phone checks remain desktop touch/CSS emulation.

The following final images were each inspected separately at original resolution with an immediate written audit: `318c-source-normalized-comparison.png` and `318k-source-normalized-comparison.png` **PASS** for matched source fidelity; `318l-native-detail-fit-selection.png` **PASS** for focused native-detail review and a thin contour; `318l2-native-detail-rotated-selection-context.png` **PASS** for its settled endpoint only; `318m2-laptop-native-source.png` and `318p-mobile-expanded-native-source.png` **PASS** for compact layout, readable over-image labels, and accessible controls. These are test-tissue selections, not expert tumor contours.

Private receipt: `frontend/tmp/private-tumor-segmentation-validation/318-native-validation-receipt.json`, with the matching source-parity receipts. Browser cleanup is **CLOSED**: current and attributable stale resources were audited clear, and the user's browser/data were preserved. Subsequent fixture/document updates did not change the captured production rendering.

#### Final reliability and release verification

The final audit fixes are implemented:

1. **Bounded geometry admission.** Native overview planning uses at most 165 memory evaluations rather than incrementing a stride millions of times for pathological declared spacing. Unsafe grid indices/products and nonfinite physical bounds fail before allocation; valid sparse support and ordinary sampling order remain unchanged. Native planning/frame-wait/source-admission tests: **61 passed**.
2. **Canceled consumers release their work.** A shared native-frame wait rejects immediately on abort, has a 30-second stalled-load deadline, removes timers/listeners, and ignores late results. Assembly and the original-plane cache use it without purging or canceling shared Cornerstone images. Production-reader guards prevent late pixel reads/publication. The original-plane stalled-decoder tests failed before this fix and pass afterward; the complete native-plane/decoder group has **34 passing tests**.
3. **Atomic model persistence.** Models are verified before replacing the previous model/manifest pair. Upload, clear, replacement, and unmount share generation and abort ownership; volume changes cannot accidentally re-enable upload controls. Pair writes/deletions are atomic, with cancellation active through transaction completion. Real IndexedDB regression tests verify rollback of both bytes and timestamps even after the last request succeeds. ONNX/cache and backup compatibility group: **37 passed**.
4. **Readable overlays and current UI fixtures.** Orientation labels have a narrow dark halo and remain separated from the dimension readout during rotation. The viewer group has **46 passing tests**. Two older Quiet Instrument fixtures were updated with explicit independent-acquisition metadata and the current source-geometry wording; real classification and production ownership guards were not weakened.

- Final current-source full test suite: **1,302 passed, zero failed, 11 opt-in skips across 129 test files** (`frontend/tmp/svr-native-full-regression-final.json`). The private segmentation corpus checks were enabled and run separately as recorded below; other opt-in integration/benchmark cases are not silently counted as passes.
- `npm run lint` and `npm run build`: **PASS**, including TypeScript project references and the production Vite bundle. The existing approximately **2.71 MB minified main-bundle warning remains**; this feature does not claim to solve application-wide initial-download size.
- Final current-source offline React Doctor: **293 files scanned, complete, zero errors or warnings**, with no skipped checks (`frontend/tmp/svr-native-react-doctor-final.json`). Remote scoring/telemetry and supply-chain calls were disabled; no external numerical score is claimed. Narrow sequential-yield exemptions document real shared-buffer/transaction constraints rather than excluding these modules from review.
- Final changed-file formatting: **PASS across 65 task source/test/config/document files**. `git diff --check`: **PASS**.
- Current private-corpus checks: examination ordinals **1, 9, 15, and 18 each passed 13 tests, with zero failures or skips** (`frontend/tmp/svr-native-corpus-final-{ordinal}.json`). These are explicitly unlabeled support/mark/workflow checks, not clinical accuracy scores or independent-acquisition evidence for the reformatted series.
- Privacy and preview: source MRI files, local corpus receipts, and patient-derived captures are not tracked or staged. The private validation directory remains ignored. No temporary browser probes were added to production source. `http://localhost:43124/` responded **HTTP 200** after the final build; the user's existing local data and browser were preserved.

The historical full-suite, build, and Doctor results earlier in this document must not be read as final clearance for the native implementation.

## Remaining limits and next accuracy work

1. **This is interactive selection, not validated automatic tumor diagnosis.** The app now represents intent and corrections explicitly, but homogeneous adjacent tissue and weak boundaries can still require negative marks and direct editing. No algorithm can infer a clinically correct boundary from the supplied unlabeled corpus alone.
2. To measure clinical accuracy, obtain expert contours in native patient coordinates for multiple dates, planes, lesion morphologies, and sequences. Separate tuning and held-out examinations, record inter-rater disagreement, then evaluate Dice, surface distance, missed components, false inclusions, and correction time. Never use this algorithm's own output as its golden truth.
3. Add clinician-reviewed segmentation correction tasks before considering a pretrained model as the default. A model needs a verified sequence/preprocessing/output-space contract, independent holdout evaluation, and an explicit editable draft state.
4. Fine output sampling is not acquired resolution. Keep support and sampling provenance visible. The composite volume may use a half-float GPU texture; the new original-image plane uses float32 samples with explicit windowing. Both still undergo screen rasterization. Neither supplies scanner k-space or establishes sub-voxel anatomical resolution.
5. The processing memory planner is not a total-browser-RSS guarantee. The bounded segmentation domain, one worker source copy, bounded edit history, and sparse texture updates limit additional work; test lower-memory devices before raising defaults or domain limits.
6. Large, poorly bounded markings may exceed the 2,000,000-voxel growth domain. The operation fails clearly rather than silently subsampling the labels or pretending an incomplete grow succeeded. Manual correction remains available.
7. Accepted per-series rigid transforms are now preserved and reused during regional refinement, source admission, and original-plane projection. Sources without an accepted fit cannot inherit identity. Native reference reformats require explicit lineage or strong same-acquisition metadata; this does not amount to a verified source-UID graph when the scanner omitted its links.
8. Extend performance validation with repeated cold/warm whole-head and regional runs on lower-memory integrated GPUs, recording source decoding, solver, worker, GPU, editing latency, and memory separately. Current static/frame evidence does not prove smooth sustained interaction on every device.

## Primary references

Interactive foreground/background seeding is established in [3D Slicer's Segment Editor](https://github.com/Slicer/Slicer/blob/main/Docs/user_guide/modules/segmenteditor.md). Its workflow supports iterative marking and review; this is design guidance, not validation of this implementation.

[Fast GrowCut](https://nac.spl.harvard.edu/publications/effective-interactive-medical-image-segmentation-method-using-fast-growcut) motivates efficient competing seeded regions. The proposed browser implementation must be tested on its own merits rather than inheriting the paper's results.

The acquisition-model and edge-preserving reconstruction experiments are informed by [MRI super-resolution reconstruction](https://pmc.ncbi.nlm.nih.gov/articles/PMC4644155/) and [reconstruction with intensity matching and robust outlier handling](https://pmc.ncbi.nlm.nih.gov/articles/PMC4067058/). They do not justify fusing incompatible sequences or fabricating missing anatomy.
