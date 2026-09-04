# Automatic alignment: implementation and validation

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

## Outcome

Visible examinations now align in the background, without a tumor selection or separate Align All / Align Tumor actions. The first visible examination supplies the fixed comparison frame. Its slice and display settings are not changed by applying alignment results.

Registration estimation is independent of browsing position. The application selects an anatomy-rich reference slab, estimates a physical pose there, and reuses it to render other slices. It does not attempt to identify a tumor automatically. The user confirmed the latest alignment was visually correct; subsequent work preserved that behavior and focused on repeatability, cancellation, native-image access, and validation.

This evidence was collected locally before PR publication. It is not a clinical validation study or a claim that every structure across examinations should appear identical. MRI source data and patient-derived captures remain private.

## User-visible contract

- The first visible comparison column remains the reference; editing another panel does not silently promote it.
- Alignment begins after a 650 ms quiet interval. Browsing, filters, examination selection, and other workspace controls remain available.
- Visible means the enabled columns in the current comparison. The scheduler pauses for hidden documents, dialogs, playback, and 3D reconstruction mode.
- The current viewport, slice, patient, sequence, dataset revision, and reference presentation identify a request. Superseded results and errors cannot apply to a newer view.
- Automatic target updates do not schedule another alignment, create undo entries, or write a derived image to IndexedDB on every slice.
- Manual target adjustments are retained for the current patient/sequence session. Realign clears these holds and the pose cache, then explicitly recomputes the visible comparison.
- Pause stops background work without changing the current view. View acquired returns an individual panel to its original source image, holds that panel out of automatic alignment, and makes native annotation available again. This prevents automatic derived presentation from making segmentation inaccessible.
- Drag selections are now for segmentation, not an alignment prerequisite. Help text explains the new behavior and the distinction between acquired and derived images.

## Algorithm and data flow

### 1. Choose evidence independently of the cursor

The existing physically spaced, bounded reference stack is reused. For automatic registration, its sampling does not force inclusion of the browsing slice. Each sampled plane is reduced to a small analysis image and robustly normalized using acquired-pixel support.

The selector measures foreground support, spatial detail, and how much intensity variation survives a local average. Spatially incoherent noise loses most of its variance under averaging; persistent anatomical boundaries do not. A neighborhood statistic requires useful evidence in adjacent planes. Constant images, unsupported images, random-noise frames, and isolated detailed frames between blank neighbors cannot independently choose a slab.

The selected source index and output grid remain explicit. Selecting an internal estimation plane does not update the visible slice position.

### 2. Estimate and refine physical pose

The existing coarse 3D registration uses bounded samples from the full physical stacks. Native refinement uses an acquired reference slab and a contiguous target envelope, not sparse interpolated presentation pixels.

For selection-free registration, an additional bounded six-degree-of-freedom refinement compares multiple reference planes using existing local structural descriptors. MIND and normalized-gradient agreement dominate; local intensity/contrast structure supplies a smaller contribution. Every evidence plane retains a coverage requirement. Neighboring planes withheld from this contextual optimization must not regress before its proposed pose is accepted.

The context search is bounded around the native initializer: at most 4 mm per translation parameter and 3 degrees per rotation parameter. Target acquisition support includes the reference context and search margin. Frame-count and memory limits remain enforced; the code does not silently replace missing native support with a sparse approximation.

Native diagnostics are re-evaluated when a later anatomical refinement changes the selected pose. Published metrics no longer describe an earlier pose while presenting a different one. These diagnostic scores are not probabilities of clinical correctness; the contextual holdout is specifically a refinement guard, not independent validation of the entire pipeline.

### 3. Calibrate presentation at the informative plane

The optional final 2D affine is estimated and structurally checked on the informative plane, not an arbitrary empty browsing slice. Its accepted residual is composed with the reference's current display geometry. The physical resampling transform remains rigid; this is not deformable registration.

Automatic tone matching uses corresponding supported tissue after the selected affine. It fits a monotone, three-quantile display curve with fixed black and white endpoints. This avoids the positive black offset introduced by a CSS contrast filter below 100 percent. Flat, clipped, malformed, or non-finite calibration is declined.

The curve is applied only to the Cornerstone presentation encoding. The resliced floating-point pixel buffer and imported DICOM data remain unchanged. The native source window and calibration parameters are cached, and the reference's manual brightness/contrast controls remain shared display adjustments.

### 4. Reuse verified estimates while browsing

A bounded, 16-entry in-memory cache retains pose metadata, affine residual, and tone calibration—not MRI image buffers. Its identity includes patient, sequence, dataset revision, reference and target series, frame counts, and output mode.

A warm request decodes the required output reference frame and contiguous native target envelope, then reslices with the cached pose. It does not repeat coarse registration, native pose optimization, or affine estimation. The output grid still belongs to the exact currently displayed reference slice. Manual/derived-reference compatibility paths remain available internally; the ordinary UI exposes only automatic alignment.

## Reliability fixes accompanying the change

The scheduler and result application have separate responsibilities: the scheduler chooses the current request; the application hook verifies that a completed result still belongs to that request and to the live dataset. Patient/sequence/revision, source identity, output lattice, slice bounds, and reverse-order checks remain in place.

Settings readiness now covers both patient and sequence. A cancelled initial settings read followed by a date-filter change cannot leave readiness permanently false. Loading a newly visible examination also no longer overwrites newer in-memory automatic or manual settings with older stored values.

Per-examination failures remain visible and do not manufacture geometry or unsupported anatomy. An ambiguity between usable poses is not a reason to optimize toward an arbitrary historical acquired-slice index. In particular, the nearest acquired slice number is not an independent accuracy oracle for an obliquely resliced plane.

## Automated evidence

`npm run check`: lint passed; **997 tests passed, 11 optional tests skipped**. New coverage includes:

- Information-rich slab selection, brightness/contrast invariance, blank/constant/noise rejection, and neighboring-plane support.
- Multi-slice structural scoring when one central slice favors a misleading candidate.
- Informative preparation independent of the requested browsing slice.
- Fixed black/white tone endpoints, monotonicity, invalid calibration, actual Cornerstone luminance, and unchanged raw pixels.
- Debounced first-visible scheduling, cancellation, hidden-tab pause, retry behavior, readiness, manual holds, and absence of target-update feedback loops.
- Rejection of late view results, transient background application, pose-cache reuse, dataset invalidation, and explicit cache clearing.
- Settings hydration races, preservation of current settings, and separation of automatic updates from manual undo/persistence.

Final follow-up after the behavior-preserving orchestration cleanup: `npm run lint` and the full `npm run test` passed again with the same counts. `npm run build` passed. `npm run doctor -- --offline` scanned 258 files and reported **zero issues**; the remote numerical score was not requested. The workspace-level alignment wiring now lives in `useComparisonAlignment`, keeping the main comparison component smaller without changing the scheduler, estimator, or result-validation authorities.

### Private-MRI known-transform test

The new opt-in `frontend/tests/alignmentAutomaticCorpus.test.ts` uses the supplied E15 MRI anatomy in all three planes. It creates a target with a known physical transform, global intensity change, and changed local signal. Accuracy is measured against independently constructed physical points, not the optimizer's own similarity score.

| Plane    | Landmark RMS error | Maximum error | Output coverage |
| -------- | -----------------: | ------------: | --------------: |
| Axial    |          0.0961 mm |     0.1256 mm |             1.0 |
| Coronal  |          0.0905 mm |     0.1099 mm |             1.0 |
| Sagittal |          0.0500 mm |     0.0500 mm |             1.0 |

All three passed separately from the default suite, then passed again after final cleanup with identical accuracy measurements. The measured registration/native-refinement portions were approximately 1.44–1.65 seconds on the first run and 1.92–2.22 seconds on the final run. These are synthetic-transform recovery results using real MRI texture, not measured clinical accuracy across biological change, and not full browser cold-start timings.

Run locally from `frontend/`:

```sh
MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR="$MIRAVIEWER_PRIVATE_CORPUS" npm run test -- tests/alignmentAutomaticCorpus.test.ts
```

## Actual-application visual and interaction evidence

The existing isolated Chrome/CDP capture harness exercised `http://localhost:43124/`, importing 442 source frames per two-examination run through the real import UI. It did not attach to the user's browser profile.

1. **July/January, reviewed brain region:** the first scan remained at its chosen slice; one target became a labeled derived plane; no browser exceptions or visible alignment errors occurred. Browsing eight slices forward and back preserved the exact pose and tone parameters. Returning to the same plane reproduced the pixel sum. The inspected settled views retained black backgrounds, clear image composition, and unobstructed controls.
2. **July/March:** the same fixed-reference, cache, repeatability, and native-image return checks passed. Anterior anatomy remains visibly different; the visual result is not evidence that every region is anatomically identical.
3. **Off-focus startup:** starting at displayed slice 21, below the reviewed brain region, still produced alignment without moving the reference. Browsing away and back reused the pose and reproduced the pixel sum. This is an off-focus real-data test, not an entirely blank-frame test; blank/noise rejection is covered by the deterministic tests.
4. **Native annotation access:** View acquired removed the derived presentation and held the target out of automatic updates. The first reference remained unchanged. This checks access and source identity, not segmentation accuracy.

Warm browsing updates in these browser runs were approximately **1.03 seconds**, including the deliberate 650 ms debounce and the harness's 250 ms polling cadence. Installed Chrome was run headlessly with GPU disabled. The receipts support functional latency and settled pixels, not hardware-rendering performance, frame pacing, or smoothness between screenshots.

Private, ignored evidence directories:

- `frontend/tmp/alignment-pass-20260827/informative-slab-checkpoint/`
- `frontend/tmp/alignment-pass-20260827/automatic-navigation-final/`
- `frontend/tmp/alignment-pass-20260827/automatic-march-final/`
- `frontend/tmp/alignment-pass-20260827/off-focus-start-final/`
- `frontend/tmp/alignment-pass-20260827/final-integrated/` — repeated the full July/January import, alignment, cached browse/return, and acquired-image-access check after the final orchestration cleanup; no visible errors or browser exceptions, unchanged pose/tone, and repeatable pixel sum.

Each verdict-bearing source image was inspected individually at original resolution and reported immediately. Every batch closed its exact owned browser/profile and passed current/stale ownership audits. User and other-worktree browsers were preserved. MRI source files and captures are ignored and are not tracked by Git.

## Remaining limits and follow-up priorities

- Preserve the user-accepted alignment rather than forcing changing tissue to look identical. Expand independent, expert-reviewed landmarks across dates and planes before tightening real-anatomy accuracy claims.
- The new browser checks cover axial date comparisons; coronal/sagittal evidence in this pass is controlled physical-transform recovery, not full cross-date browser visual sign-off.
- No automatic tumor classifier, date-distance weighting, or groupwise longitudinal model was added. Registration remains pairwise against the first visible examination, with multi-slice context.
- The cache is session-local. It intentionally does not persist a new image on every browsing step. A fresh session estimates again.
- Reducing the warm browsing debounce or retaining more worker-side resampling state is a separate performance improvement. It should preserve exact pose/tone repeatability, cancellation, and memory bounds.
- Existing production bundle-size warnings remain; this pass does not replace the Cornerstone/DICOM rendering stack or claim to solve initial bundle loading.
