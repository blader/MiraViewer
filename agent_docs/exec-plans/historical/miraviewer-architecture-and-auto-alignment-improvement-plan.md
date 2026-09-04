# MiraViewer architecture review and auto-alignment improvement plan

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

- Date: 2026-08-24
- Reviewed baseline: `5c359bd10ebd7ce4bf7056b79306e0d64ceaf1e9`
- Worktree: `blader/siqi-chen/bring-in-new-images`
- Scope: the complete frontend application, emphasizing longitudinal MRI alignment accuracy, reliability, correctness, performance, architecture, visual design, accessibility, and implementation compactness.
- Status: baseline review, authorized implementation, measured results, and remaining validation gaps are documented below.

## Executive verdict

MiraViewer has an unusually strong foundation for a small browser-only medical-imaging application: data stays local, substantial DICOM metadata is retained, its alignment algorithm already uses serious structure-aware techniques, SVR has genuine patient-space geometry and worker-based computation, and its test corpus exercises many low-level mathematical invariants.

Nevertheless, the application is not yet sufficiently trustworthy for its central promise: comparing the same person's anatomy across studies and automatically aligning corresponding slices. Its most serious problems are not missing image-similarity metrics. They are missing authoritative identity, physical geometry, complete persistence, and reliable operation boundaries:

1. Different patients and same-day examinations can be silently mixed, and incompatible scans can even be fused into one 3D reconstruction.
2. The offline downloadable application starts on a new random browser origin, so a restart strands its previously imported MRI data, annotations, and settings in the old origin's IndexedDB.
3. The advertised backup omits saved tumor annotations, ground truth, and alignment settings; meanwhile “clear all local data” leaves other application databases and clinically revealing local-storage keys behind.
4. Alignment orders and searches scans by arbitrary instance number and normalized array position even though the importer already retains the physical DICOM metadata needed for anatomical ordering. Real longitudinal scans additionally differ in acquisition tilt by up to approximately 18°, which a single native 2D slice and affine transform cannot fully correct.
5. User-drawn lesion exclusions are expressed in viewport coordinates but consumed as image coordinates, so alignment can exclude healthy tissue while leaving the actual lesion in its optimizer.
6. Existing 3D rigid-registration and volume-resampling primitives can be reused, but their current support-dropping NCC objective, invalid final-voxel boundary handling, unconditional field-of-view recentering, and downsample-origin drift must be corrected before they become an alignment authority.
7. Saved lesion outlines drift when the viewer changes aspect ratio, 2D segmentation analyzes a screenshot instead of MRI pixels, ONNX segmentation silently accepts wrong spatial layouts and unknown tumor classes, and the 3D renderer submits an invalid WebGL matrix upload.
8. Alignment converts raw MRI data into windowed, quantized, 8-bit display pixels before comparing it, even though the actual axial scans have 160–192 distinct display windows per stack and some slices have a window width of just 1. It also repeatedly decodes the same slices because the configured image cache is never populated.
9. Ambiguous matches are automatically applied as though they were reliable, and changing sequence or playback position during a run can apply otherwise valid results to the wrong context.
10. The production scorer is sufficiently expensive that the repository's normal `npm run check` currently fails on clean `main`; the alignment test suite only passes when its timeout is explicitly raised. Interactive 3D segmentation also rescans up to 7.08 million voxels on every preview update.
11. The real empty-state and import-dialog surfaces show avoidable UI chrome, low-contrast controls, undersized interaction targets, missing accessible modal semantics, and essential loaded-study controls that are revealed only by mouse hover.

The shortest coherent route forward is to make the existing DICOM patient/geometry/pixel information authoritative, reuse the primitives already present in SVR, move image analysis out of the React/UI thread, and apply only explicitly identified, evidence-supported results. Adding more metrics, a learned model, or deformable registration before fixing those boundaries would make the implementation larger without addressing its principal failure modes.

## Review scope and evidence quality

### Git and application scope

The checkout began clean. `HEAD`, `origin/main`, the local `main` branch, and the current tracked branch all pointed to `5c359bd`. The associated GitHub pull request, `#6`, was already merged. The merge-base diff was empty.

Accordingly, this is a review of the complete current application, not a claim that the findings were introduced by an outstanding branch change.

The application contains approximately:

- 105 production TypeScript/TSX/CSS files and 28,525 production lines.
- 57 test/helper files and 9,195 test lines.
- A 2,667-line 3D viewer, a 1,336-line 2D tumor overlay, a 1,329-line alignment hook, and a 1,110-line 3D orchestration component.

These counts describe review scope, not an automatic demand to shrink files. They matter where a component currently mixes multiple independent ownership boundaries or makes correctness difficult to establish.

### Evidence classes used below

- **Reproduced:** observed in the current checkout, a running application surface, a build, or an executed command.
- **Statically demonstrated:** a reachable production path and a concrete counterexample are established by current source, even when no dedicated regression test exists yet.
- **Exact structural lower bound:** derived directly from actual allocations or fixed algorithmic work; not a browser runtime measurement.
- **Hypothesis:** a plausible improvement that still needs representative MRI data or measured validation.

The user authorized access to a real local MRI corpus during the review. A representative, Git-ignored subset was copied into `Critical MRI Source Images (LLM Agent - do not delete)/` and analyzed without recording patient identifiers, exact acquisition dates, UIDs, source filenames, or patient images. This supports real-data metadata findings and production importer/storage integration; it does **not** supply independent clinician-annotated landmark ground truth, measured clinical accuracy, actual loaded-study visual fidelity, or real-browser alignment latency.

An older checked-in smoke report explicitly records that representative MRI interaction, visual alignment inspection, allocation traces, and real-world accuracy were not completed: `.smoke-results/blader-siqi-chen-bring-in-new-images/20260707T223920Z/smoke-results.md:39-55` and `:75-81`. Existing design documents that describe an older phase-only algorithm must not be mistaken for the current production implementation.

### Real longitudinal MRI corpus examined

The original local archive contains approximately 35,898 DICOM files across 17 studies. Sampling 2,892 files identified 248 real series. A representative subset of **1,405 DICOM files, 257.6 MiB, one patient, four examinations, and six FLAIR series** was copied to the repository's existing protected, ignored fixture directory.

Anonymized study geometry:

| Study   | Plane          | Frames | In-plane pixels | In-plane spacing | Center spacing | Slice thickness | Obliquity |
| ------- | -------------- | -----: | --------------- | ---------------- | -------------- | --------------- | --------: |
| Study 1 | Axial FLAIR    |    221 | 512 × 512       | 0.4297 mm        | 1.0 mm         | 1.0 mm          |    4.335° |
| Study 1 | Coronal FLAIR  |    221 | 512 × 512       | 0.4297 mm        | 1.0 mm         | 1.0 mm          |    6.080° |
| Study 1 | Sagittal FLAIR |    300 | 512 × 512       | 0.4297 mm        | 0.6 mm         | 1.2 mm          |    4.631° |
| Study 2 | Axial FLAIR    |    221 | 512 × 512       | 0.4297 mm        | 1.0 mm         | 1.0 mm          |   17.640° |
| Study 3 | Axial FLAIR    |    221 | 512 × 512       | 0.4297 mm        | 1.0 mm         | 1.0 mm          |   14.350° |
| Study 4 | Axial FLAIR    |    221 | 512 × 512       | 0.4297 mm        | 1.0 mm         | 1.0 mm          |    0.934° |

Observed current-corpus facts:

- All 1,405 images parsed successfully and have valid patient, study, series, frame-of-reference, orientation, position, and pixel-spacing metadata.
- All are single-frame, 512 × 512, signed 16-bit, `MONOCHROME2` MRI images.
- Four different frame-of-reference identifiers appear across the four longitudinal examinations; **zero of six cross-study pairs share a frame of reference**. The same-study axial/coronal/sagittal series do share one frame.
- Longitudinal axial acquisition normals differ by up to approximately **18.1°**; in-plane axes also differ materially.
- Five series increase in physical depth as instance number increases, while the real coronal series moves in the opposite direction for all 220 adjacent steps.
- The sagittal series has 0.6 mm center spacing but 1.2 mm slice thickness: adjacent slices overlap by **50%**. Thickness cannot stand in for slice-center spacing.
- 1,184 of 1,405 images (**84.3%**) use JPEG Lossless compression; revisiting them through the current non-caching load path can repeat decompression as well as parsing and storage reads.
- The four axial stacks use 160–192 distinct per-slice display window widths each. Across those 884 longitudinal images, **116 frames** have a window width below 32, despite carrying signed 16-bit source pixels.
- All six real series are correctly classified by the current implementation as their physical plane and T2 FLAIR. The classifier false positives discussed below are independently reproduced counterexamples, not failures observed on this particular corpus.
- Despite sharing the same FLAIR classification, sampled acquisition echo times span approximately 113.2–118.2 ms and inversion times span approximately 1,847–1,877 ms; a shared text label does not imply identical source contrast.
- A direct production-path integration using real DICOM parsing and fake IndexedDB successfully imported **all 1,405 files**, classified all six series across four examinations, and reproduced the stale series-order cache after incremental import.

Real importer benchmark, using the production parser and ingestion code with an isolated in-memory IndexedDB implementation:

```text
DICOM objects processed:  1,405 / 1,405
Skipped / failed:         0 / 0
Total input:              257.6 MiB
Import elapsed time:      9,624 ms
Throughput:               approximately 146 files/s; 26.77 MiB/s
Peak Node process RSS:    462.1 MiB
Comparison aggregation:   45.39 ms
Resulting examinations:   4
Resulting series groups:  axial T2 FLAIR × 4; coronal × 1; sagittal × 1
```

The throughput and RSS describe an isolated Node/fake-IndexedDB harness, **not** real browser IndexedDB throughput, browser heap, first-image latency, or end-to-end UI responsiveness. They nevertheless establish that the current production importer and classifier can process the actual corpus, while its stale-order-cache defect remains reproducible with genuine files.

This corpus changes the central recommendation: patient-space ordering and 2.5D comparison are necessary but not sufficient. Because the longitudinal reference and target planes are genuinely nonparallel, the highest-value advanced option is **validated 3D rigid cross-study registration plus geometry-aware target-plane reslicing**, or an explicit warning that native single-slice comparison cannot fully remove the observed through-plane disagreement.

### Current structural scorer executed on real decoded MRI pixels

The shipped structural-scoring functions were also executed unchanged against actual decoded signed-16-bit MRI frames. The harness reused production normalization, MIND/NGF descriptors, structural phase correlation, 256-point FFT support, bounded phase correction, warp validity, area resampling, fixed-candidate ranking, and 128/64-pixel structural scales.

For each study pair, it decoded 41 target slices around the middle of the stack and evaluated two representations per candidate:

1. Consistently normalized raw 16-bit source pixels.
2. The corresponding per-slice DICOM display window, quantized to an emulated 8-bit presentation.

Anonymized results:

| Reference and target | Reference slice | Selected target slice | Runner-up slice | Relative percentile-rank gap | Total harness time | Decode component | Scoring component |
| -------------------- | --------------: | --------------------: | --------------: | ---------------------------: | -----------------: | ---------------: | ----------------: |
| Study 1 → Study 4    |             110 |                   123 |             111 |                      0.02439 |            5.506 s |          1.738 s |           2.832 s |
| Study 4 → Study 1    |             110 |                   118 |             126 |                      0.06341 |           12.078 s |          4.310 s |           6.289 s |
| Study 4 → Study 2    |             110 |                   110 |             111 |                      0.01829 |            7.044 s |          3.043 s |           3.355 s |

Each timing includes **41 real frame decodes and 82 structural/phase scoring passes**, because both raw and windowed representations were evaluated. The remainder outside decode and scoring includes reference preparation and downsampling. These are isolated harness workload observations, not real-browser latency, one-mode timing, or full production end-to-end measurements.

The corresponding winning raw-image MIND/NGF values were approximately `0.707 / 0.483`, `0.695 / 0.460`, and `0.739 / 0.506`. Winning relative ranks were high even though the nearest percentile-rank gaps were only 0.018–0.063. Those gaps describe candidate ordering only; they are not calibrated correctness probabilities or absolute structural-score margins.

Important interpretation limits:

- Raw-pixel and emulated 8-bit windows selected the **same winners in all three tested central-slice scenarios**. Central windows were sufficiently wide and clipped approximately 0% of nonzero foreground in those particular cases. Do not describe the observed per-slice window variability as a proven central-slice mismatch.
- Opposite-direction tests each began from their own native index 110. Their `+13` and `+8` selected offsets are not a valid round-trip inverse-consistency test and must not be reported as reciprocal error.
- The harness did not execute real Cornerstone DOM rendering, Elastix rigid registration, lesion exclusions, 256-pixel fine scoring, final affine refinement, a full 221-slice window, or expert landmark comparison.
- Therefore, the experiment establishes real decoded-image compatibility, meaningful current scoring cost, small candidate-ordering gaps, and the feasibility of a raw-pixel pipeline. It does not establish that any reported winner is anatomically correct or clinically incorrect.

## Current architecture and its genuine strengths

The actual product path is:

```text
DICOM files / ZIP
    -> browser-side DICOM parsing
    -> IndexedDB studies, series, instances, settings, annotations
    -> localApi comparison summary + instance-number-ordered SOP identifiers
    -> React comparison matrix
       -> Cornerstone 2D viewer and overlays
       -> structure-first 2D alignment
       -> physically informed SVR reconstruction and WebGL 3D rendering
```

The current alignment implementation is more advanced than some existing planning documents suggest:

```text
reference slice
    -> off-screen Cornerstone render at 256 and 128 pixels
    -> normalized reference features and exclusion-aware support
    -> proportional target-index seed
    -> three-resolution rigid Elastix seed
    -> bounded candidate search around the seed
    -> structural phase-correlation residual translation
    -> multi-scale MIND + NGF + CS-SSIM/LNCC ranking
    -> separated fine-candidate shortlist
    -> seed-only, intensity-affine, and structural-affine proposals
    -> structurally gated final transform
    -> immediate per-date panel-setting persistence
```

Important existing strengths to retain:

- Browser-local IndexedDB storage and no routine server-side handling of MRI data.
- SOP UID-based deduplication and a narrow index that can enumerate SOP identities without reading DICOM Blobs.
- Persisted position, orientation, spacing, thickness, and other DICOM metadata.
- Structure-first MIND/NGF ranking instead of selecting solely by intensity or phase peak.
- Exclusion-aware normalization and fixed-domain coverage accounting.
- Separation between pose estimation and slice comparison.
- Rigid initialization, deterministic bounded residual translation, and an always-available seed-only final-transform fallback.
- Dedicated SVR workers, transferable volume buffers, existing patient-space geometry utilities, area-average resampling, and direct raw-pixel access.
- A real, already-implemented six-degree-of-freedom ROI-constrained 3D rigid optimizer, normalized-cross-correlation scoring, patient-space transforms, and trilinear volume sampling; these can seed a compact geometry-correct alignment path instead of requiring an unrelated registration stack.
- Productive real-data defaults: valid axial FLAIR is selected automatically, and the four newest longitudinal examinations are shown together; preserve this existing workflow while adding explicit patient and examination identity.
- Meaningful low-level tests for affine direction, descriptors, coverage, exclusion masks, registration cancellation, and reconstruction geometry.

The architectural objective is to consolidate and extend those existing capabilities, not replace them with another parallel framework.

## Prioritized findings

### P0 — Patient and examination identity are lost before comparison or reconstruction

**Classification:** statically demonstrated; potentially misleading medical-image presentation.

`frontend/src/db/schema.ts:1-7` retains patient name, patient ID, and study UID. However, `frontend/src/utils/localApi.ts:90-105` reads all stored studies and series globally, and `:123-173` groups them only by acquisition date and sequence classification. Where several series share a date and sequence, the one with the largest slice count wins.

The UI contract in `frontend/src/types/api.ts:14-25` has no selected-patient identity, no examination identity beyond a date string, and no acquisition timestamp. `frontend/src/components/Svr3DView.tsx:434-485` then assembles multi-plane groups by date, sequence, and weight without requiring all input series to belong to the same patient, study, or compatible frame of reference.

Concrete failures:

- Import person A's January study and person B's February study: the comparison matrix can present them as one longitudinal timeline.
- Import two studies acquired on the same date: one can silently replace the other.
- Import an axial study from one person and a coronal study from another person with the same date and sequence labels: they can enter the same 3D reconstruction group.
- Save panel settings for a date/sequence combination: the same setting key can later be interpreted against another study sharing that date.

The appropriate identity hierarchy is:

```text
patient
    -> examination / StudyInstanceUID + acquisition time
       -> series / SeriesInstanceUID
          -> SOP instance + optional frame index
```

Patient identifiers can be missing, reused, or inconsistently anonymized. Unknown identity must therefore become an explicit unresolved state, not an automatic merge. `FrameOfReferenceUID` must also be persisted; identical patient identity does not by itself prove that absolute coordinates from different studies share a valid spatial frame.

### P0 — The offline application loses its storage origin on every restart

**Classification:** statically demonstrated from the packaged production launcher and the browser's origin-scoped storage contract; a packaged browser restart was not independently executed.

The downloadable ZIP is not merely a convenience wrapper: it is an advertised supported product path. `frontend/scripts/make-downloadable-zip.mjs:55-60` copies `frontend/distribution/run_miraviewer.py` directly into every generated distribution, and the macOS, Windows, and Linux launchers all invoke it. The distributed instructions explicitly promise that scans remain stored locally in browser IndexedDB: `frontend/distribution/README.txt:12-15`.

However, `frontend/distribution/run_miraviewer.py:35-38` binds `("127.0.0.1", 0)`, deliberately selecting an ephemeral port and constructing a new `http://127.0.0.1:<port>/` origin on each launch. Browser IndexedDB, localStorage, and storage-persistence permissions are scoped to the complete origin, including that port.

The concrete failure is:

```text
launch 1 -> http://127.0.0.1:<port A>/ -> import MRI + annotate -> stop
launch 2 -> http://127.0.0.1:<port B>/ -> empty IndexedDB + empty settings
```

The original records still occupy storage under origin A, but the application at origin B cannot see or delete them. This simultaneously breaks continuity, hides user-created clinical annotations, accumulates stranded sensitive data, and makes the product's delete-all promise impossible to fulfill across old origins.

Use one deterministic stable local origin and a documented conflict policy. Do not silently switch ports when the preferred origin is unavailable. The offline acceptance test must import representative data, save settings and annotations, stop the launcher, restart it multiple times, verify the identical origin and complete dataset, and confirm deletion operates on that same durable origin.

### P0 — “Export Backup” is not a recoverable backup

**Classification:** statically demonstrated; irreversible user-data loss.

`frontend/src/components/ExportModal.tsx:100-126` labels the action “Export Backup (ZIP).” `frontend/src/components/ClearDataModal.tsx:105-112` directs users to export before deleting their local data.

However, `frontend/src/services/exportBackup.ts:69-135` exports only studies, series, DICOM instances, and selected instance metadata. The following persisted stores are omitted despite being defined in `frontend/src/db/schema.ts:259-279`:

- `panel_settings`, including alignment transforms and display settings.
- `tumor_segmentations`, including authored tumor outlines and related metadata.
- `tumor_ground_truth`, including manually drawn reference polygons.

Consequently, export → clear → reimport destroys clinician/user-authored annotations and alignment work. This is especially serious because the delete flow explicitly positions the ZIP as protection against loss.

There is a second archive-identity defect: study and series folders derive from human-readable dates, descriptions, and series numbers in `frontend/src/services/exportBackup.ts:17-26` and `:96-110`. Distinct studies or series sharing those labels can reuse the same ZIP folder and overwrite metadata files.

Until a complete restore path exists, the honest minimum change is to label the existing behavior “Export DICOM files only” and state exactly what is excluded. The actual target is a versioned, UID-addressed, complete, integrity-checked, restorable snapshot of the selected patient's records.

### P0 — “Clear all local data” leaves clinically revealing data and a separate database behind

**Classification:** statically demonstrated across reachable production storage writers; delayed destructive deletion independently reproduced with fake IndexedDB.

`frontend/src/components/ClearDataModal.tsx:49-68` reports successful deletion after dropping `MiraViewerDB`, removing selected filter/playback keys, and deleting two playback cookies. Its helper at `:23-35` enumerates only playback-prefixed local-storage keys. It does not own or inspect the other namespaces written elsewhere in the application.

Confirmed omitted application state includes:

- `frontend/src/hooks/useOverlayNavigation.ts:6-9` and `:182-192` persist the currently selected examination date under the separate overlay-navigation key.
- `frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx:33-37` and `:270-289` persist keys containing both the exact examination date and tumor-tool/sequence identity.
- `frontend/src/utils/segmentation/onnx/modelCache.ts:3-26` stores uploaded model Blobs in an entirely separate IndexedDB database named `miraviewer:model-cache`.

The interface calls the result “Clear all local data,” but previously selected study dates, evidence of tumor-tool use, UI state, and potentially large uploaded model files survive. Silent storage exceptions in `ClearDataModal.tsx:23-37` can also produce apparent success without proving all owned data was removed.

The destructive operation also has an unsafe cross-tab outcome. `frontend/src/db/db.ts:29-34` rejects immediately when `indexedDB.deleteDatabase` emits `blocked`, but the IndexedDB deletion request itself cannot be cancelled and remains queued. A production-path/fake-IndexedDB reproduction returned:

```text
Delete reported:              failed; another tab still owns the database
Database immediately after:   still exists
After blocking tab closes:    database silently deleted
```

The application can therefore tell a user that their scans were not deleted, then destroy them later without another confirmation. Coordinate all application tabs before issuing destructive deletion, or keep the original request visibly pending until its actual terminal outcome. Never report definitive failure while a previously authorized destructive request can still complete.

Create one authoritative owned-storage inventory covering every MiraViewer IndexedDB database, prefixed local-storage item, owned cookie, and any future cache/service-worker state. Delete only the application's own data, explicitly verify the postcondition, and report a partial failure honestly. Origin fragmentation from the offline-launcher defect must be fixed first; a different browser origin cannot reach its predecessors' storage.

### P1 — Valid implicit-VR DICOM images are silently discarded as non-displayable

**Classification:** reproduced using a valid synthetic binary Part-10 DICOM object, the real `dicom-parser`, and the unchanged production importer.

`frontend/src/services/dicomIngestion.ts:69-117` attempts to handle numeric tags whose VR is absent, as it commonly is for implicit-VR transfer syntaxes. Its fallback chains `floatString(tag) ?? intString(tag) ?? uint16(tag) ...`. For binary `Rows` and `Columns`, `floatString` returns `NaN` rather than `null` or `undefined`; because `NaN` is not nullish, the chain never reaches the correct `uint16` accessor.

`dicomIngestion.ts:47-59` then concludes the image has no valid dimensions, and `:265-268` returns `skipped: non-displayable` even though real pixel data and valid `64 × 64` binary dimensions are present. A production-path execution produced:

```text
Transfer syntax:             Implicit VR Little Endian
Rows element VR:             absent, as expected for implicit encoding
Rows floatString result:     NaN
Actual binary rows/columns:  64 / 64
Pixel data:                  present
Production importer result:  skipped; non-displayable
```

Current tests hide this defect because `frontend/tests/dicomIngestion.test.ts:55-101` mocks numeric tags as ASCII-like strings rather than exercising authentic binary DICOM wire representations. The copied real corpus used explicit/compressed syntaxes, so this defect was demonstrated with a synthetic standard-compliant object, not falsely attributed to those particular scans.

Use dictionary-aware/tag-specific VR extraction and advance through accessors only when each returned number is finite. Add actual binary-wire implicit-VR, explicit-VR, compressed, malformed-numeric, missing-optional-tag, and renderability fixtures; valid images must not be silently counted as benign non-image objects.

### P1 — Anatomical slice order and target selection ignore physical DICOM geometry

**Classification:** statically demonstrated; principal alignment-accuracy root cause.

The importer already stores `ImagePositionPatient`, `ImageOrientationPatient`, `PixelSpacing`, `SliceThickness`, and `SpacingBetweenSlices`: `frontend/src/services/dicomIngestion.ts:339-351`. SVR already parses those fields into a patient-space representation: `frontend/src/utils/svr/dicomGeometry.ts:21-91`.

Nevertheless:

- `frontend/src/db/db.ts:68-75` indexes slice order by `[series UID, InstanceNumber, SOP UID]`.
- `frontend/src/utils/localApi.ts:245-260` makes that instance-number order authoritative for every viewer and alignment consumer.
- `frontend/src/services/dicomIngestion.ts:117-128` and `:343` coerce missing or invalid instance numbers into zero, allowing SOP UID lexicographic order to decide anatomical sequence.
- `frontend/src/hooks/useAutoAlign.ts:396-402` estimates target depth from the ratio of source and target array indices.
- No production alignment stage consumes patient-space position, orientation, spacing, slice thickness, or frame identity.

This fails for reversed numbering, interleaved acquisition, nonmonotonic export order, missing numbers, partial stacks, different anatomical coverage, unequal spacing, oblique acquisitions, and differing fields of view.

The fix is not to sort by `SliceLocation` alone: that field can also be absent or inconsistent. A validated series manifest should project each slice's `ImagePositionPatient` onto a consistent, validated patient-space slice normal, preserve signed order, record spacing and coverage, and surface degraded fallback quality when physical geometry is unavailable.

Cross-study geometry requires special care. Since `FrameOfReferenceUID` is not currently retained anywhere, absolute positions must not be compared across different or unknown frames as if they were registered. Within-series physical ordering remains valid, while cross-frame matching should use relative coverage, orientation, anatomical priors, and broader uncertainty-aware search unless a validated frame mapping exists.

The real corpus makes this more than a hypothetical interoperability concern: every one of the four longitudinal examinations has a distinct frame of reference, and the coronal series reverses physical depth relative to increasing instance number. An algorithm that uses raw cross-study positions as though they shared an origin or assumes all series progress in the same physical direction would be wrong on the user's actual scans.

### P1 — The lesion-exclusion rectangle is applied to the wrong anatomical region

**Classification:** statically demonstrated end to end, with an exact geometric counterexample.

`frontend/src/types/api.ts:72-84` explicitly defines an alignment exclusion as normalized **image** coordinates. However, `frontend/src/components/DragRectActionOverlay.tsx:82-122` undoes the panel pan/zoom/rotation but then divides the selected rectangle by the full **viewport** width and height; it never removes contain/letterbox padding. `:296-305` publishes that viewport-normalized result as `masks.base`, and `frontend/src/components/ComparisonMatrix.tsx:315-332` passes it unchanged into the alignment reference.

`frontend/src/hooks/useAutoAlign.ts:298-323` subsequently consumes the rectangle as image-space exclusion during normalization, descriptor preparation, phase scoring, and final registration. Off-screen reference rendering uses a square analysis surface, not the original rectangular viewport.

Concrete counterexample:

```text
Original square image:                 lesion occupies image x = 0.10 ... 0.20
Contain-rendered in 1000 × 500 view:  lesion appears at viewport x = 0.30 ... 0.35
Rectangle sent to image scorer:       x = 0.30 ... 0.35
Actual intended image exclusion:      x = 0.10 ... 0.20
Error on 256-pixel alignment grid:    51.2 pixels at the left edge; width halved
```

The actual lesion can remain fully visible to MIND, phase correlation, and Elastix while unrelated healthy anatomy is excluded. This is more consequential than the existing seed-mask limitation because every downstream supposedly exclusion-aware stage inherits the wrong coordinate space.

Convert selection corners through the inverse display transform **and** the image contain/letterbox mapping at creation time; persist the result as canonical source-image-normalized or patient-space geometry. Reuse `frontend/src/utils/viewportMapping.ts` rather than creating another geometry convention. Validate rectangular viewers, rectangular images, zoom, pan, rotation, affine residuals, partial out-of-image selections, and grid/overlay mode changes.

### P1 — Correct alignment translations are applied using the wrong display-space units

**Classification:** reproduced using production panel/view-transform functions and exact rectangular-viewer geometry.

The alignment engine correctly estimates transforms in its square image-analysis grid, but `frontend/src/utils/panelTransform.ts:12-30` converts existing panel pan to analysis pixels using only the square grid size, and `:34-41` divides recovered translation by that same grid size. The actual viewer interprets `panX` and `panY` as fractions of the **full viewport**, not the contained image: `frontend/src/components/DicomViewer.tsx:277-299`.

For a square scan inside a `1000 × 500` panel, the visible image is only 500 pixels wide: `frontend/src/utils/viewportMapping.ts:11-23`. A recovered translation of `25.6` pixels on a `256 × 256` analysis image means 10% of the image width and should move the displayed image **50 pixels**. The current conversion returns `panX = 0.1`, which the viewer multiplies by its 1000-pixel width, yielding **100 pixels**: a factor-of-two overshoot. Existing reference pans are inversely underconverted before transform composition.

Consequently, a mathematically correct registration can still display visibly incorrect overlay alignment whenever image and viewport aspect ratios differ. The existing square-only transform tests do not establish this integrated contract.

Make one image-to-viewport transform authoritative, including contain rectangle, source aspect ratio, panel size, pan, zoom, rotation, and affine. Convert recovered image displacement through the actual contained-image size before writing viewport-normalized panel settings; apply the exact inverse when composing an existing reference view. Add non-square, letterboxed, rotated, zoomed, and anisotropic-image regression tests.

### P1 — Real acquisition-plane tilt exceeds what a native 2D slice plus affine can correct

**Classification:** reproduced on all 1,405 current-corpus DICOM headers; geometric consequence is exact.

The four real axial FLAIR stacks have measured per-stack obliquities of approximately 4.3°, 17.6°, 14.4°, and 0.9°. Each stack is 512 × 512 with an approximately 220 mm field of view and 1 mm through-plane slice spacing. Their directly measured pairwise normal disagreements are:

| Longitudinal pair | Plane-normal angle | Estimated edge depth drift at 110 mm half-field |
| ----------------- | -----------------: | ----------------------------------------------: |
| Study 1 ↔ Study 2 |            13.387° |                                       25.468 mm |
| Study 1 ↔ Study 3 |            10.063° |                                       19.220 mm |
| Study 1 ↔ Study 4 |             4.665° |                                        8.946 mm |
| Study 2 ↔ Study 3 |             5.678° |                                       10.883 mm |
| Study 2 ↔ Study 4 |            18.050° |                                       34.083 mm |
| Study 3 ↔ Study 4 |            14.505° |                                       27.551 mm |

A single 2D source frame is a physical plane. An in-plane affine changes coordinates **within** that plane; it cannot manufacture anatomy from a differently tilted plane. Over an approximately 110 mm half-field, an 18° acquisition-angle difference corresponds to roughly **34 mm of through-plane displacement at the edge**, equivalent to approximately 34 one-millimeter axial slice intervals. Improving MIND, phase correlation, or the 2D affine optimizer cannot remove that missing physical information.

Consequences for the existing pipeline:

- One discrete target slice may align the center while mismatching peripheral anatomy.
- Different regions can favor different target slice indices.
- A flexible affine can falsely improve a numerical score by distorting anatomy rather than correcting the actual plane mismatch.
- A confidence system that examines only 2D structural rank can overstate certainty even when the best available native target frame is physically incapable of matching the reference plane.

The physically correct advanced path is:

1. Build validated reference and target 3D sampling grids from ordered DICOM frames, spacing, thickness, and acquisition orientation.
2. Estimate a **rigid 3D** transform between the different longitudinal frames of reference using stable nonlesion anatomy.
3. Resample the target volume along the selected reference plane using the validated rigid transform and spacing-aware interpolation.
4. Preserve the original native frame and make resliced/aligned presentation explicit; never overwrite the source image or hide real anatomical change.
5. Use residual 2D alignment only after the target plane has been physically matched.

This does not require introducing an entirely separate registration framework. `frontend/src/utils/svr/rigidRegistration.ts:30-45` already represents six rigid degrees of freedom; `:326-402` scores patient-space samples against a trilinearly sampled reference volume; and `:408-500` performs cancellable, multiscale rigid optimization. `frontend/src/utils/svr/svrComputeCore.ts:113-325` already builds a bounded scoring grid, samples an anatomical ROI, applies only a score-improving transform, and supports progress/cancellation. `frontend/src/utils/svr/reconstructionCore.ts:438-485` already contains trilinear grid resampling.

Those primitives are not plug-and-play for the observed longitudinal case: the optimizer currently assumes coarse alignment is already close and limits each residual rotation to **±10°** and translation to **±20 mm**. The actual maximum plane-normal disagreement is **18.050°**, and none of the cross-study frames of reference match. First establish a validated cross-frame initialization from acquisition orientation and stable anatomy; then optimize only the physically plausible residual, adapt bounds only when justified by measured uncertainty, protect changing lesions, and verify the result against held-out landmarks. Merely wiring the existing ±10° same-space optimizer into Align All would not solve the demonstrated case.

This is not a recommendation for nonrigid/deformable registration. Rigid 3D mapping preserves anatomy while addressing an acquisition geometry defect that is demonstrably present in the user's actual data. If the product must show only native acquired slices, expose the irreducible plane mismatch and avoid claiming complete alignment.

### P1 — The existing 3D rigid objective rewards discarding most anatomical evidence

**Classification:** reproduced using the unchanged production normalized-cross-correlation scorer.

Reusing the SVR rigid optimizer is architecturally preferable to introducing another registration stack, but its present objective cannot be used as a trustworthy cross-study alignment authority unchanged.

`frontend/src/utils/svr/rigidRegistration.ts:361-384` silently omits any moving sample that a candidate transform pushes outside the reference volume. `:386-400` then calculates NCC on the remaining candidate-specific support and accepts as few as 512 samples. `frontend/src/utils/svr/svrComputeCore.ts:242-245` starts with up to 40,000 samples, and `:254-303` commits a transform whenever its NCC improves by 0.001; it does not require its retained support to be comparable to the baseline.

A synthetic execution of the actual scorer produced:

```text
Identity transform:        NCC -0.9510; 12,474 valid anatomical samples
Allowed +20 mm transform:  NCC  1.0000;    594 valid anatomical samples
Retained support:          4.76% of the identity baseline
Current acceptance:        accepted; 594 exceeds the 512-sample floor
```

The apparent numerical improvement comes from moving inconvenient anatomy out of the scoring domain, not establishing a better anatomical correspondence. With a 40,000-sample input, the hard minimum theoretically permits only **1.28%** of initial support. The demonstrated example retains 4.76%; it is not a claim that the minimum occurred on the user's real MRIs.

Define one fixed anatomical support domain, expose reference/moving coverage, reject materially reduced overlap, and score only valid reconstructed anatomy rather than padded or unsupported voxels. Use baseline-relative support and bidirectional coverage or a justified coverage-weighted structural objective; preserve stable-anatomy/lesion exclusions. A transform must not become eligible merely by cropping more mismatching anatomy.

### P1 — Default 3D reconstruction overwrites valid same-frame acquisition geometry

**Classification:** reproduced using the unchanged production reconstruction core and synthetic physically valid partial-coverage stacks.

`frontend/src/types/svr.ts:91-99` defaults `seriesRegistrationMode` to `roi-rigid`. However, `frontend/src/utils/svr/svrComputeCore.ts:573-639` first translates every nonreference series so its field-of-view bounding-box center equals the reference center, regardless of valid original `ImagePositionPatient`, physical overlap, frame-of-reference compatibility, or anatomical evidence. At `:768-775`, a missing ROI causes the requested rigid stage to be skipped while preserving that unverified center translation.

Running the real `computeSvrFromLoadedSlices` path on a geometrically correct `5 × 5 × 5` reference and an overlapping `3 × 3 × 3` partial-coverage stack changed the partial stack's image position from `(0, 0, 0) mm` to `(1, 1, 1) mm` under default settings without an anatomical quality check. A smaller field of view is not evidence that its center should coincide with another series' center.

The actual three same-study real-MRI planes happened to have coincident acquisition centers, so this particular source corpus does not reproduce the error. The synthetic production-path counterexample demonstrates the failure for valid nonconcentric coverage.

For compatible frames with trustworthy geometry, preserve the acquisition transform as the default identity. Use bounds-center alignment only as an explicit hypothesis for incompatible/unknown frames, and commit it only when a fixed-domain anatomical objective and coverage checks improve. When no ROI exists, do not silently fall back to an unvalidated transform.

### P1 — Trilinear volume sampling discards valid final voxel centers and entire far faces

**Classification:** reproduced directly using unchanged production sampling and splatting functions.

`frontend/src/utils/svr/trilinear.ts:13-22` and `:84-93` always require both `floor(coordinate)` and `floor(coordinate) + 1` to be valid voxel indices. At an exact final voxel center, the upper neighbor has interpolation weight zero and is not needed, but the current implementation rejects the entire sample. `frontend/src/utils/svr/svrUtils.ts:53-70` repeats that incorrect exclusive bound, and volume resampling/rigid scoring consume it.

Executing the production functions on a `3 × 3 × 3` volume yielded:

```text
Sample final valid voxel (2, 2, 2):  expected 27; actual 0
Splat final valid voxel (2, 2, 2):   expected 99; actual 0
Exact identity-grid centers:         27 valid; only 8 retained; 19 dropped
```

Thus identity resampling removes every far X/Y/Z face rather than preserving the original volume. Reusing this primitive for reference-plane reslicing would introduce a geometric error precisely in the proposed accuracy-improvement path.

Accept exact coordinates through `dimension - 1`, clamp zero-weight ceil neighbors to their valid floor, and use the same boundary convention for sampling, splatting, support masks, reconstruction, and rigid scoring. Test identity volumes, every face/edge/corner, singleton dimensions, interpolation-weight conservation, and adjacent just-out-of-bounds coordinates.

### P1 — Downsampled MRI slices keep the wrong patient-space pixel origin

**Classification:** reproduced using the production area resampler; physical displacement is derived from actual source spacing.

`frontend/src/utils/svr/reconstructVolume.ts:98-110` correctly changes row and column spacing when reducing pixel resolution. `:123-128` then area-averages each source-pixel bin, but `:167-184` retains the original source image's `ImagePositionPatient` as though downsampled pixel zero still had source pixel zero's center.

The resampler's actual first destination sample represents the center of the first source bin: `frontend/src/utils/svr/resample2d.ts:31-45`. An executed four-pixel-to-two-pixel ramp produces a first-bin source center of `0.5`, while the loader assigns that sample origin `0`. The missing per-axis patient-space offset is:

```text
0.5 × (source pixel count / destination pixel count - 1) × source pixel spacing
```

For the copied 512-pixel MRI series at approximately `0.43 mm` spacing, `512 → 220` introduces approximately **0.285 mm per axis**; `512 → 128` introduces approximately **0.645 mm per axis**, or approximately **0.912 mm diagonally**. These are deterministic representation offsets, not a measured clinical registration-error estimate.

Shift the downsampled image origin along the actual DICOM row and column direction vectors by the destination-bin center offsets. Preserve separate row/column spacing and test anisotropic pixels, oblique acquisitions, different downsample factors, round trips, and agreement between native and resliced patient-space landmarks.

### P1 — ROI cropping drops thick slices whose centers fall just outside the selected region

**Classification:** reproduced using the production crop predicate; the problematic overlapping-thickness relationship is present in the real sagittal series.

`frontend/src/utils/svr/sliceRoiCrop.ts:6-18` omits slice thickness from its input representation, and `:36-52` rejects a slice whenever its **center plane** lies outside the projected ROI. However, the reconstruction models actual slice thickness and point-spread support, so a slice centered outside the region can still contribute valid anatomy inside it.

The copied sagittal study has **1.2 mm slice thickness and 0.6 mm center spacing**. A synthetic 1.2-mm slice centered at `z = -0.4 mm` occupies approximately `[-1.0, +0.2] mm`, overlapping an ROI that starts at `z = 0`; the production crop predicate nevertheless rejects it. This selectively drops valid edge evidence from physically overlapping acquisitions.

Carry center position, thickness, through-plane sampling support, and any interpolation halo through the crop contract. Retain a slice whenever its physically supported slab intersects the ROI, and add regression cases using the actual 1.2-mm-thick/0.6-mm-spaced acquisition geometry.

### P1 — Saved lesion annotations move when the viewing viewport changes shape

**Classification:** reproduced using production annotation/view-transform mapping and synthetic nonpatient geometry.

Ground-truth and tumor polygons are persisted in viewer-normalized coordinates rather than source-image or patient-space coordinates. `frontend/src/components/GroundTruthPolygonOverlay.tsx:237-255` stores the authored `viewportSize`, but its loader at `:64-76` retrieves only the polygon and view transform. `frontend/src/components/TumorSavedSegmentationOverlay.tsx:53-89` follows the same pattern; `frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx:416-439` likewise ignores the saved viewport when restoring existing annotations.

The existing transform remapping therefore reconstructs both the old and new states through the **current** viewport, losing the original contain/letterbox geometry. A direct production-function example saved an outline at the left edge of a square image in a `1000 × 500` viewer (`x = 0.25` in viewport-normalized coordinates). Reopening in a `500 × 1000` viewer kept `x = 0.25` even though that same image edge should now be `x = 0`, creating **125 CSS pixels** of displacement. Another rectangular-viewport example displaced the contour by **25 source-image pixels**.

Persist canonical source-image-normalized or patient-space annotation coordinates together with exact SOP/frame identity. Use the already stored legacy `viewportSize`, image dimensions, and authored view transform to migrate old records; project canonical geometry into the active viewport or a validated derived plane only at display time. Verify grid/overlay switches, aspect-ratio changes, pan/zoom/rotation, affine transforms, anisotropic spacing, reload, and backup/restore.

### P1 — Tumor segmentation operates on a displayed PNG instead of anatomical MRI data

**Classification:** statically demonstrated through the complete production capture/decode/grow path.

`frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx:607-623` captures the currently visible viewer as a PNG and decodes that screenshot before starting tumor growth. The capture in `frontend/src/components/DicomViewer.tsx:373-448` includes viewport dimensions, black padding, zoom, pan, rotation, residual affine, brightness, contrast, image display window, and lossy downsampling to at most 512 pixels. `frontend/src/utils/segmentation/segmentTumor.ts:11-21` and `:51-60` then decodes that PNG through a second canvas into an 8-bit grayscale array.

Therefore the apparent tumor mask can change merely because the user adjusted image brightness, contrast, zoom, or viewport shape, even though the underlying 16-bit DICOM image and selected anatomy did not change. Black letterbox pixels can enter the growing domain. The tool also caps its target area at 10,000 **capture** pixels (`TumorSegmentationOverlaySeedGrow.tsx:234-236`) and persists screenshot-pixel area rather than calibrated `mm²`; at 2× image zoom, an unchanged capture-pixel area corresponds to roughly one quarter of the original anatomical area. The PNG encoding, image decoding, second canvas, RGBA allocation, and grayscale copy also add unnecessary main-thread work.

Feed the same canonical decoded, modality-scaled MRI frame used by the improved alignment pipeline directly into segmentation. Express the seed/ROI in source-image or patient coordinates, compute the mask and physically calibrated `mm²` area there, and project only the resulting contour into the live viewport. Require identical segmentation and physical measurements for equivalent anatomy across presentation-only window, contrast, zoom, pan, rotation, device-pixel-ratio, and viewport changes.

The same annotation writer also lacks immutable slice ownership: `frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx:1053-1075` snapshots one SOP/slice, awaits IndexedDB persistence at `:1095-1106`, and unconditionally installs that old polygon/SOP into current component state at `:1108-1112`. Navigating to another slice while the prior save is pending can display the old lesion on the new slice. Bind saves and UI completion to an explicit `(patient, study, series, SOP, frame, run generation)` and ignore stale post-await results.

### P1 — Authored 3D tumor segmentations have no persistent source of truth

**Classification:** statically demonstrated across production writers, component state, and the IndexedDB schema.

`frontend/src/components/SvrVolume3DViewer.tsx:425-427` stores interactively grown/ONNX label volumes only in React state. `:538-564` clears that state whenever the volume object changes, while `frontend/src/hooks/useOnnxTumorSession.ts:247-250` delivers inferred labels only through a state callback. The actual IndexedDB schema contains 2D tumor and ground-truth stores but no durable 3D label-volume store.

Nevertheless, the UI calculates and presents tumor class counts and volumes as user-facing results. Switching reconstruction context, rebuilding the same volume, refreshing the browser, or restarting the offline application can silently discard that authored work. A complete backup cannot restore a label volume that was never persisted.

Persist accepted 3D labels under explicit patient/study/frame and reconstruction-grid identity, source-series provenance, voxel spacing, registration transform, algorithm/model/class contract, and dataset revision. Verify that reload, mode switch, reconstruction reuse, offline restart, export, and restore retain the work; reject or explicitly remap stale labels when the underlying volume fingerprint changes.

### P1 — ONNX segmentation accepts spatially incorrect outputs and silently erases unknown classes

**Classification:** unknown-class suppression reproduced; equal-voxel-count axis mismatch statically demonstrated through the complete production consumer path.

`frontend/src/utils/segmentation/onnx/tumorSegmentation.ts:76-85` rejects only a mismatch in total voxel count. When the model's `[X,Y,Z]` spatial dimensions differ from the current reconstruction but have the same product, it merely logs a warning and returns the labels. `frontend/src/hooks/useOnnxTumorSession.ts:247-250` immediately attaches the current volume's dimensions to that mismatched buffer and displays it as though voxel positions were correct.

For example, expected dimensions `[64,128,64]` and model dimensions `[128,64,64]` contain exactly the same number of voxels but represent different anatomical positions. The current count-only guard accepts the result despite its axis permutation.

There is a second silent failure in `frontend/src/utils/segmentation/onnx/logitsToLabels.ts:58-82`: arbitrary positive class counts are accepted, and winning classes beyond the declared label map become `0`, meaning background. Executing the unchanged production function with a five-class output, a four-class BRATS label map, and winning class index `4` returned background label `0` instead of rejecting the incompatible model.

Require an explicit model contract covering input channels, normalization, orientation, output layout, spatial dimensions, class count, class ordering, and label mapping. Reject unknown classes and axis mismatches unless a verified physical remapping exists. Test equal-count permuted dimensions, extra classes, missing labels, invalid model metadata, and the guarantee that rejected output never reaches an anatomical overlay.

### P1 — The 3D renderer submits an invalid WebGL matrix upload on every frame

**Classification:** statically demonstrated against the WebGL API contract; the actual loaded 3D product surface remains visually unverified.

`frontend/src/components/SvrVolume3DViewer.tsx:1899-1904` asserts that WebGL2 permits `transpose=true` and calls `gl.uniformMatrix3fv(u.invRot, true, rotMat)`. WebGL matrix-uniform uploads require that argument to be `false`; a true value generates `INVALID_VALUE` and leaves the intended uniform unchanged.

This uniform is not optional presentation polish: `frontend/src/utils/svr/glRaymarch.ts:254-257` declares it as the camera-to-object rotation, and `:302-308` uses it to compute both the ray origin and direction. A rejected upload can therefore produce blank/broken volume rendering or invalid rotation. Existing tests do not execute a genuine WebGL2 shader/draw path, and a loaded-MRI 3D browser screenshot was unavailable during this review.

Transpose the rotation matrix once into a reusable CPU buffer and upload it with `transpose=false`. Add a real WebGL2 shader/draw smoke test that asserts `gl.getError() === gl.NO_ERROR`, confirms the uniform value, and checks both identity and rotated reference-volume rendering. Do not infer actual visual fidelity solely from mocked GL calls.

### P1 — The correct slice can be excluded from the search entirely

**Classification:** statically demonstrated.

`frontend/src/hooks/useAutoAlign.ts:404-413` searches only ±40 slice indices around its proportional-index seed. `:722-753` extends a boundary at most once, and only when the shortlisted candidate evidence implicates that boundary.

For a 300-slice target seeded at index 149, the upper search boundary can expand at most to index 229. If the correct corresponding slice is index 240, no scoring algorithm can select it. If the boundary does not itself appear promising, even nearer out-of-window candidates remain unseen.

The candidate range should instead be based on physically plausible overlap, verified frame compatibility, measured spacing, actual coverage, acquisition direction, and an explicit resource budget. Where geometry is weak, use a clearly reported broader search instead of silently treating a narrow index window as anatomical truth.

### P1 — Text classification overrides valid physical scan orientation

**Classification:** reproduced.

`frontend/src/utils/dicomSeriesParsing.ts:44-60` deliberately accepts aggressive substrings such as `TRA` and `COR`. `frontend/src/services/dicomIngestion.ts:306-323` then prioritizes the inferred text plane over the actual `ImageOrientationPatient`.

Running the current production parser directly produced:

```text
POST CONTRAST T1       -> Axial
CONTRAST ENHANCED T1   -> Axial
BRAIN EXTRA T2         -> Axial
CORRELATION T1         -> Coronal
```

A physically sagittal or coronal post-contrast series can therefore be placed in the axial bucket and compared with unrelated anatomy. Existing coverage even codifies an aggressive `TAX-1 -> Axial` case: `frontend/tests/dicomSeriesParsing.test.ts:23-24`.

The six copied FLAIR series themselves were classified correctly. The examples above demonstrate a reachable parser defect, not a claim that this specific longitudinal corpus was mislabeled.

Measured orientation should own plane classification whenever it is valid. Carefully delimited scanner-vocabulary tokens are a fallback for absent geometry, not an override. Preserve obliquity, provenance, and disagreement instead of manufacturing a confident classification.

### P1 — Alignment operates on windowed display pixels instead of raw MRI samples

**Classification:** statically demonstrated.

`frontend/src/utils/cornerstoneSliceCapture.ts:149-161` creates a hidden DOM rendering element. `:206-255` loads and displays a Cornerstone image, waits for a render event, draws the canvas into another square canvas, and reads RGBA pixels. `:257-288` converts those 8-bit display channels back into floating-point grayscale.

That path:

- Applies a display window before image analysis.
- Quantizes potentially 12-bit or 16-bit image information into 8-bit samples.
- Clips signal outside the selected display range.
- Makes registration dependent on canvas rasterization, render timing, and a 200 ms image-render deadline.
- Resamples images through presentation geometry rather than explicit physical pixel spacing.
- Forces feature extraction onto the browser/UI thread.

The application already has a better primitive. `frontend/src/utils/svr/reconstructVolume.ts:96-143` obtains raw samples via `getPixelData()`, preserves geometry and physical spacing, area-resamples them, and applies modality slope/intercept.

The actual scans make the display-window problem particularly concrete. Representative longitudinal axial DICOM default window center/width pairs, including an edge slice for Study 1, are:

```text
Study 1: 1.5 / 3
Study 2: 512.5 / 1,025
Study 3: 618.5 / 1,237
Study 4: 490.5 / 981
```

Across the **complete actual stacks**, window widths vary as follows:

| Series                       | Minimum window width | Median window width | Maximum window width | Frames with width < 32 | Distinct widths |
| ---------------------------- | -------------------: | ------------------: | -------------------: | ---------------------: | --------------: |
| Study 1 axial, 221 frames    |                    1 |                 543 |                1,205 |                     37 |             160 |
| Study 2 axial, 221 frames    |                    1 |               1,293 |                3,742 |                     28 |             182 |
| Study 3 axial, 221 frames    |                    1 |               1,183 |                2,386 |                     27 |             192 |
| Study 4 axial, 221 frames    |                    1 |                 861 |                1,278 |                     24 |             166 |
| Study 1 coronal, 221 frames  |                    1 |                 628 |                1,211 |                     45 |             167 |
| Study 1 sagittal, 300 frames |                  669 |                 669 |                  669 |                      0 |               1 |

The longitudinal axial series are marked derived/secondary MRI images, while the sagittal companion is original. The current capture path therefore compares **a different display transfer function for most individual candidate slices**, not a stable intensity representation of the same tissue. This is a much stronger real-data argument for shared raw-pixel normalization than a general preference for avoiding 8-bit quantization.

All four sources contain signed 16-bit image samples, but the current alignment path converts their default-windowed presentation into 8-bit RGB before scoring. A default window width of 1 or 3 can clip most of the source dynamic range long before robust normalization, MIND, NGF, or phase correlation can examine it. Direct decoding of representative central slices produced approximate raw ranges of `0–1175`, `0–1313`, `0–1225`, and `0–950` across the four studies. The precise impact on clinical match accuracy still requires independently labeled landmarks, but the lossy representation, varying per-slice transfer function, and preserved source dynamic range are all directly demonstrated on the real corpus.

Promote that decoded-pixel representation into a shared service. Alignment should consume deterministic normalized source data; the viewer should remain a separate presentation layer.

### P1 — The configured image cache never owns the images that matter

**Classification:** statically demonstrated using the installed Cornerstone implementation.

`frontend/src/utils/cornerstoneInit.ts:81-95` configures a 256 MiB Cornerstone image cache. Yet the production viewer, alignment capture, 3D preview, and SVR decode paths all call `cornerstone.loadImage`, including:

- `frontend/src/components/DicomViewer.tsx:763`.
- `frontend/src/utils/cornerstoneSliceCapture.ts:207`.
- `frontend/src/components/Svr3DView.tsx:226`.
- `frontend/src/utils/svr/reconstructVolume.ts:114`.
- `frontend/src/utils/cornerstoneInit.ts:39`.

The installed library explicitly documents that `loadImage` does **not** store a newly loaded image in the cache: `frontend/node_modules/cornerstone-core/dist/cornerstone.js:3371-3394`. `loadAndCacheImage` is the distinct method that inserts it: `:3397-3421`.

As a result, revisiting an interactive slice repeats IndexedDB Blob retrieval, WADO registration, parsing, and decode. Alignment renders its reference twice, renders the seed, revisits shortlisted candidates at another resolution, and renders the winning slice again: `frontend/src/hooks/useAutoAlign.ts:280-309`, `:470-475`, `:613-619`, `:765-774`, and `:979-984`.

This inefficiency is especially relevant to the actual corpus: **1,184 of 1,405 frames are JPEG Lossless-compressed**. Repeated non-cached loads can therefore include repeated lossless decompression, not merely repeated small metadata lookups. A decoded 221-frame signed-16-bit axial stack occupies approximately **110.5 MiB** before image-object overhead; the 300-frame sagittal stack occupies approximately **150 MiB**. The complete copied corpus expands to approximately **702.5 MiB** of raw 16-bit pixels, so a bounded working set—not an all-images global cache—is essential.

Use one bounded decoded-image owner. Interactive slices and alignment working sets should use cache-aware loading; large sequential SVR imports should retain an explicit streaming/non-cache policy so they do not evict the interactive working set. A bounded per-run physical-resolution pyramid can then derive both 128 px and 256 px features from one decoded source.

### P1 — Real compressed-image rendering has no verified browser/offline integration gate

**Classification:** current-corpus compression reproduced; actual production browser rendering remains unverified.

Five of the six actual series use JPEG Lossless compression, but `frontend/src/utils/cornerstoneInit.ts:104-106` explicitly leaves decoder-worker configuration unresolved. Existing `frontend/tests/cornerstoneInit.test.ts` mocks the relevant Cornerstone/WADO initialization surfaces, while ingestion tests do not exercise real browser decoding or image display.

The application's installed no-worker decoding bundle was able to decode representative real signed-16-bit compressed frames in an isolated harness. This proves the installed codec can handle the source encoding under that harness. It does **not** prove that the configured production browser worker, content-security policy, Vite asset paths, or offline ZIP can decode and render those frames reliably.

Add a real compressed-DICOM decode → Cornerstone render → alignment-input smoke path for development, production build, and offline ZIP. Distinguish codec initialization failure, decode failure, unsupported transfer syntax, missing worker asset, and an otherwise valid but flat/window-clipped image.

### P1 — Alignment can write correct transforms into the wrong sequence

**Classification:** statically demonstrated.

The sequence selector stays active during alignment: `frontend/src/components/comparison/ComparisonFiltersSidebar.tsx:70-75`. Results in `frontend/src/types/api.ts:110-118` carry a date and series UID but no originating sequence, patient, or immutable run ID.

`frontend/src/hooks/useApplyAlignmentResults.ts:26-52` applies results to the **currently selected** sequence context. `frontend/src/hooks/usePanelSettings.ts:300-326` persists the update under the hook's captured `selectedSeqId`.

Counterexample: start Align All for sequence A; select sequence B before A completes; receive an A target result for a date also present in B. A's computed transform can be persisted into B.

The result contract must carry the producing run ID, patient ID, examination identity, sequence ID, reference identity, target identity, and relevant dataset revision. The destination writer must verify all identities before mutating visible or persisted state. Context changes should cancel, explicitly detach, or safely revalidate the run.

### P1 — Active playback can invalidate the slice that alignment just found

**Classification:** statically demonstrated.

`frontend/src/components/ComparisonMatrix.tsx:330-332` snapshots global slice progress when the operation starts. `frontend/src/hooks/useAutoAlign.ts:1238-1244` and `frontend/src/utils/alignment.ts:219-225` encode that snapshot into the output slice offset.

`frontend/src/components/ComparisonMatrix.tsx:758-766` leaves the global navigator active, and `frontend/src/components/comparison/SliceLoopNavigator.tsx:99-158` can continue advancing progress while alignment runs.

If a 100-slice stack moves from progress 0.50 to 0.60 during alignment, the resulting displayed slice can land roughly ten slices away from the selected anatomical match.

Either pause/freeze navigation while an alignment run is active or atomically rebase each computed offset against the authoritative current progress immediately before application. Guard sequence, patient, and series identity regardless of the chosen interaction model.

### P1 — Flat or ambiguous evidence is presented as a confident successful match

**Classification:** statically demonstrated and protected by an existing test.

When all structural and appearance channels are flat, `frontend/src/utils/perceptualSliceSimilarity.ts:714-729` falls back to distance from the seed. Existing tests establish that a guessed seed can receive a percentile rank of `5/6`: `frontend/tests/perceptualSliceSimilarity.test.ts:599-624`. `:753-765` confirms that the guessed candidate is selected.

`frontend/src/hooks/useAutoAlign.ts:1264-1279` and `frontend/src/hooks/useApplyAlignmentResults.ts:26-56` then emit and persist the chosen transformation without requiring:

- An absolute structural-evidence floor.
- A meaningful separation from the runner-up.
- Adequate bidirectional anatomical coverage.
- Consistent physical geometry.
- A non-flat or sufficiently informative reference image.
- A user-visible ambiguous/manual-review outcome.

A percentile rank describes ordering among available candidates; it is not a probability of anatomical correctness. The real decoded-image experiments independently produced high winning ranks with runner-up percentile-rank gaps as small as **0.01829**. Add typed outcomes such as `aligned`, `ambiguous`, `insufficient-overlap`, `incompatible-geometry`, `cancelled`, and `failed`. Calibrate any acceptance threshold against patient-disjoint MRI data; do not invent confidence from unvalidated constants.

### P1 — Correct field-of-view changes can be rejected as unsafe deformation

**Classification:** statically demonstrated with a concrete geometric counterexample.

The initial seed is rigid and cannot establish scale: `frontend/src/hooks/useAutoAlign.ts:460-487`. Final affine proposals are rejected when any corner moves more than 12.5% of image width: `frontend/src/utils/structuralAffineSelection.ts:23`, `:119-137`, and `:190-197`.

A legitimate 192 mm versus 256 mm field-of-view difference requires a scale of approximately `256 / 192 = 1.333`. On a 256-pixel image, centered corner displacement is approximately 42.5 pixels, or 16.6% of image width. The current safety gate can therefore reject the physically correct transform and keep an incorrect rigid-only fallback.

Expected orientation, pixel spacing, aspect ratio, and field-of-view differences must be normalized before enforcing narrow residual deformation limits. Those limits should constrain unexpected remaining distortion, not physically justified acquisition differences.

### P1 — The current alignment implementation overwhelms its own test and UI-thread budgets

**Classification:** reproduced plus exact structural allocation lower bounds.

The default repository validation command failed twice against the clean current revision:

```text
npm run check

Test Files  1 failed | 54 passed (55)
Tests       11 failed | 281 passed (292)
```

The first 21-slice alignment integration test exceeded Vitest's default 5,000 ms timeout. Its unfinished asynchronous React work then caused ten cascading `result.current === null` failures. The same failure happened without the concurrent production build.

Running the alignment file alone with an explicit realistic timeout succeeded:

```text
npm run test -- tests/useAutoAlign.test.tsx --testTimeout=30000

Test Files  1 passed (1)
Tests       11 passed (11)
Duration    33.49 s
```

Measured individual cases included:

- First production-path case: **8,030 ms** for 21 coarse and 15 fine candidates.
- Boundary-extension case: **5,431 ms** for 90 coarse candidates.
- Test execution alone: **29,871 ms** across the 11 alignment cases.

Cornerstone capture and Elastix registration were mocked. Therefore, those times are dominated by the actual JavaScript-side alignment/scoring path, not real DICOM decoding or WebAssembly registration.

Each MIND descriptor allocates full-resolution float scratch arrays, eight-channel patch/output arrays, and a validity array: `frontend/src/utils/mindDescriptor.ts:143-149` and `:193-194`. Exact lower bounds are:

| Descriptor resolution | Minimum transient bytes |
| --------------------- | ----------------------: |
| 64 × 64               |                 299,008 |
| 128 × 128             |               1,196,032 |
| 256 × 256             |               4,784,128 |

An 81-candidate coarse pass at 128 and 64 pixels allocates at least **115.49 MiB** solely in MIND buffers. Fifteen fine candidates at 256, 128, and 64 pixels add at least **89.82 MiB**. The combined lower bound exceeds **205 MiB per target date** before FFTs, warps, normalization, coverage arrays, image decode, references, registration, or garbage-collection overhead.

These are structural allocation totals, not a measured peak heap or real-world end-to-end timing. The score path additionally performs a custom JavaScript FFT and nested local-window statistics on the UI thread: `frontend/src/hooks/useAutoAlign.ts:613-679` and `:765-795`; `frontend/src/utils/perceptualSliceSimilarity.ts:424-475`. Yielding once every two slices does not prevent one candidate from becoming a long blocking task.

The durable fix is worker-owned decoded data, pyramids, feature extraction, scoring, reusable scratch buffers, and cancellation—not simply extending test timeouts. A realistic explicit integration-test budget and proper cleanup are still necessary so one failed case cannot corrupt subsequent tests.

### P1 — Interactive 3D segmentation repeats whole-volume scans and can silently fall back to the UI thread

**Classification:** exact structural work bound and statically demonstrated worker-failure fallback; actual browser frame time was not measured.

`frontend/src/components/SvrVolume3DViewer.tsx:1078-1127` already tracks precisely which segmentation voxels changed so GPU uploads can be restricted to a dirty region. Nevertheless, `:1129` creates a fresh label-volume object for every preview, and the `labelMetrics` memo at `:577-602` scans the entire label array whenever that object identity changes.

The default maximum reconstruction dimension is 192: `frontend/src/types/svr.ts:91-95`. A full `192 × 192 × 192` label volume therefore requires up to **7,077,888 voxel reads and repeated map updates per slider preview**, even if only a tiny region changed. `SvrVolume3DViewer.tsx:1045-1067` also runs region growth on the UI thread and yields only after 60,000 or 160,000 visited voxels, depending on mode.

Separately, `frontend/src/utils/svr/reconstructVolume.ts:278-313` describes reconstruction as a potentially minutes-long solve, then silently catches module-worker creation failures and executes that same solve inline on the UI thread. A content-security-policy, browser worker-support, or asset failure can thus turn an actionable unsupported-feature condition into an apparently frozen application.

Maintain class counts incrementally while restoring/applying the already known dirty voxel indices, and run growth/reconstruction in one bounded, cancellable worker-owned compute domain. Browser production should fail clearly if an essential worker cannot start; retain the inline path only behind an explicit test or tightly bounded compatibility policy. Measure representative main-thread long tasks, preview-update latency, cancellation, worker startup failures, and actual memory before claiming an end-to-end speedup.

### P1 — Series-order cache can become stale immediately after import

**Classification:** reproduced with real DICOM files and the production importer/local API.

`frontend/src/utils/localApi.ts:227-267` maintains a module-global 64-series UID-order cache without mutation, reset, or dataset-revision invalidation.

After importing additional instances, `frontend/src/components/ComparisonMatrix.tsx:444-447` reloads the comparison summary, so its series count reflects the new data. The cached slice-order array still reflects the old series contents. A series can thus advertise 100 slices while the loader can resolve only the original 80.

A real-data integration imported one genuine MRI slice, populated the order cache, then imported another genuine slice from the same series. IndexedDB and the refreshed comparison summary reported **two** stored frames, while `getSortedSopInstanceUidsForSeries` continued to return **one** indefinitely. Requesting the second visible slice can therefore fail with `Instance index out of range`. This uses actual `dicom-parser`, the production ingestion code, and a fake IndexedDB instance without mocked DICOM metadata.

Derived order and decoded-image caches must be keyed by an authoritative committed per-series or dataset revision. Successful imports should invalidate only affected series; database deletion/reset should invalidate all derived entries. Failed transactions must not advance the revision.

### P1 — Enhanced multi-frame MRI is silently represented as one slice

**Classification:** statically demonstrated.

The importer stores one `DicomInstance` per SOP UID: `frontend/src/services/dicomIngestion.ts:339-385`. No current path parses `NumberOfFrames`, per-frame functional groups, per-frame positions, or per-frame orientations. `frontend/src/utils/cornerstoneInit.ts:18-39` uses `miradb:<sop UID>` without frame identity, while `frontend/src/utils/localApi.ts:99-105` counts SOP records rather than displayable frames.

A 100-frame enhanced MRI object can therefore appear as a one-slice series. Alignment, annotation, and reconstruction inherit the same incorrect identity.

The durable representation is `(SOPInstanceUID, frameIndex)` with frame-specific geometry. If complete support cannot be implemented immediately, explicitly reject unsupported multi-frame objects and explain why rather than reporting a successful, complete import.

### P2 — Ingestion is not atomic and can report misleading partial success

**Classification:** statically demonstrated.

`frontend/src/services/dicomIngestion.ts:356-385` performs duplicate lookup and writes to `studies`, `series`, and `instances` in independent IndexedDB operations. A crash, quota failure, or concurrent import can leave partially written parents, unstable metadata, or duplicate-check/write races.

`frontend/src/components/UploadModal.tsx:196-215` reports overall success when at least one image was ingested, even if many other files failed. The error count appears only as low-emphasis tertiary copy in the success panel at `:250-269`.

Use a canonical ingestion writer with atomic cross-store transactions, bounded batches, transaction-local duplicate checks, stable parent metadata, quota awareness, post-commit revision updates, and explicit `complete`, `partial`, or `failed` results. Expose missing slices and incomplete stacks before allowing confident alignment.

### P2 — ZIP ingestion has no decompression, entry-count, or quota safety boundary

**Classification:** unbounded production import path statically demonstrated; high expansion ratio reproduced with a benign synthetic archive.

`frontend/src/components/UploadModal.tsx:152-166` loads all ZIP entries and fully expands each entry into a Blob before validating whether it is a DICOM candidate. There is no declared/cumulative uncompressed-size ceiling, entry-count limit, compression-ratio guard, projected storage-quota reservation, or cancellable decompression boundary.

A safe synthetic JSZip example used a **1,157-byte archive containing a 1,033-byte compressed entry that expanded to 1,048,576 bytes**, an approximately **1,015:1 entry expansion ratio**. This is an existence proof of the missing resource boundary, not a claim that the user's MRI ZIP is malicious.

Inspect archive metadata before expansion, cap entry count and cumulative uncompressed bytes, reject implausible expansion ratios, skip clearly irrelevant entries before inflation, reserve storage headroom, and support cancellation. Reject adversarial fixtures before allocating the expanded payload or writing partial database state.

### P2 — Browser storage persistence failures are invisible to users

**Classification:** statically demonstrated through the startup and storage-persistence paths.

`frontend/src/main.tsx:8-10` invokes `initStoragePersistence()` without awaiting or presenting its result. `frontend/src/db/db.ts:136-154` merely logs persistence approval and quota estimates; denial, unsupported persistence, estimate failure, and other errors become a false/ignored result with no user-visible durability state.

Consequently, a large locally stored MRI collection can remain browser-evictable while the interface promises that scans are stored locally. Archive inflation, user-uploaded models, and a separate model-cache database compete for the same origin quota.

There is also no safe recovery owner for an initially failed database connection. `frontend/src/db/db.ts:38-40` and `:118-120` memoize the first `openDB` promise permanently. A fake-IndexedDB production-path reproduction triggered a version mismatch, removed the incompatible database, and still received the same cached `VersionError` on every subsequent call. The underlying condition was gone, but the application remained broken until reload.

Represent persistence approval, available quota, projected import size, database-open lifecycle, and backup/restore readiness as explicit dataset-health state. Reset rejected connection promises after a recoverable failure, warn when storage is best-effort, preflight significant imports, reserve headroom, handle quota failures atomically, and provide truthful recovery guidance rather than implying durable storage without evidence.

### P2 — Partial failures produce partial mutations and fragmented undo

**Classification:** statically demonstrated.

Final affine optimizer failures have local fallbacks, but seed-registration and candidate-render/scoring failures escape to the outer run-level catch: `frontend/src/hooks/useAutoAlign.ts:470-487`, `:613-679`, and `:1292-1302`.

Previously completed dates are already persisted incrementally by `frontend/src/hooks/useApplyAlignmentResults.ts:26-56`. Each application creates a fresh history batch ID in `frontend/src/hooks/usePanelSettings.ts:300-326`.

If date three fails, dates one and two remain modified, later dates may never run, and a single undo does not necessarily revert the complete Align All action. Panel persistence also swallows storage failures via `.catch(() => {})` at `frontend/src/hooks/usePanelSettings.ts:325-326`.

Use one operation/run identity and one undo group, isolate failures per target date, report all terminal outcomes, and distinguish visible-state updates from confirmed persistence. Cancellation and context changes need explicit, deterministic semantics.

### P2 — The exclusion region does not protect the earliest rigid registration

**Classification:** statically demonstrated; real-world impact requires representative lesion data.

When an exclusion rectangle is supplied, the first rigid registration still runs without a moving-space exclusion: `frontend/src/hooks/useAutoAlign.ts:477-486`. The second registration after prewarping receives the exclusion: `:498-525`.

Because the moving-space exclusion is not yet known at the start, copying the fixed rectangle directly into the moving frame would be incorrect. Instead, initialize pose from trusted acquisition geometry or robust nonlesion structure, propagate the exclusion through the current canonical transform, and iteratively use weighted/masked objectives. A large changing lesion should not be allowed to select the initial optimization basin.

### P2 — Valid imported series can disappear behind classification filters

**Classification:** statically demonstrated.

`frontend/src/hooks/useComparisonFilters.ts:19-29`, `:66-68`, and `:132-141` exclude sequences without recognized labels. `frontend/src/components/ComparisonMatrix.tsx:427` and `:661-674` then treat the absence of a selected recognized sequence as the absence of any data.

Consequently, importing valid scans with unfamiliar vendor descriptions can return the user to the welcome/import screen while the DICOM data remains present in IndexedDB. Dataset presence and successful classification are different facts and require separate owners. Preserve an explicit “Unclassified” group and make all displayable scans discoverable.

### P2 — 3D reconstruction can display a stale result after date changes

**Classification:** statically demonstrated.

`frontend/src/components/Svr3DView.tsx:591-604` invokes `clear()` when the selected date changes. However, `frontend/src/hooks/useSvrReconstruction.ts:30-36` implements `clear()` as a state reset without aborting the in-flight controller.

The previous run can subsequently call `setState({ result, ... })` at `:79-84`, causing a volume from the old date to appear in the new date context. Replacing one run with another introduces a related ownership problem: `:38-42` installs a new controller, but the old run's unguarded `catch` and `finally` at `:91-106` can overwrite state and clear the newer controller reference.

Apply the same immutable operation/run-identity discipline to reconstruction: abort on clear, date change, unmount, or replacement; ignore late results unless the controller and run ID still match; never let an older run clear a newer controller.

### P2 — Geometry validation accepts degenerate orientation vectors

**Classification:** statically demonstrated.

`frontend/src/utils/svr/vec3.ts:35-38` returns a finite zero vector for zero-length inputs. `frontend/src/utils/svr/dicomGeometry.ts:21-37` rejects only non-finite normal components. Parallel or zero row/column directions can therefore yield a zero slice normal that is incorrectly accepted as valid geometry.

Validate vector norms, near-orthogonality, nonzero cross-product magnitude, finite positions, positive spacing, and within-stack normal consistency. Return structured geometry-quality failures instead of feeding degenerate coordinates into registration or reconstruction.

### P2 — The application pays for advanced features before users need them

**Classification:** reproduced by a current production build.

`frontend/src/components/ComparisonMatrix.tsx:18-34` imports upload/export dialogs, the 3D subsystem, and alignment hooks eagerly. `frontend/src/components/Svr3DView.tsx:16` eagerly imports the 2,667-line 3D volume viewer. `frontend/src/utils/elastixRegistration.ts:1-11` eagerly imports the ITK runtime through the standard comparison application graph.

Current build output:

```text
Modules transformed: 1,944
Primary JS chunk:    2,807.05 kB raw / 867.59 kB gzip
Production output:   101 MiB
ONNX runtime assets: 74 MiB
Elastix pipelines:   24 MiB
```

Individual bundled assets include approximately 24 MiB and 23 MiB ONNX WASM binaries and a 16 MiB Elastix WASM binary. ONNX segmentation still requires the user to upload their own model, yet the offline distribution currently ships a broad 74 MiB runtime set.

Lazy-load 3D, segmentation, modal workflows, and alignment runtime at real feature boundaries. Audit which vendored ONNX and ITK artifacts are actually requested in development, production, and the offline ZIP before removing or splitting assets. Measure initial download, parse/execute cost, first usable slice, and offline package size rather than promising an unverified percentage reduction.

### P2 — Summary and export do unnecessary storage and memory work

**Classification:** statically demonstrated.

`frontend/src/utils/localApi.ts:99-105` performs one IndexedDB count operation per series through unbounded `Promise.all`.

More significantly, `frontend/src/services/exportBackup.ts:87-93` materializes every full `DicomInstance`, including its Blob, merely to count archive progress. `:112-123` loads the same full records again for actual export. JSZip then retains each uncompressed payload before generating the final archive at `:138-149`.

Use index counts or key cursors for progress, one narrow summary path, bounded transaction concurrency, and a streaming/bounded-memory archive writer when representative datasets establish a material need. Instrument Blob reads, IndexedDB transactions, peak heap, and wall time before claiming runtime gains.

### P2 — Diagnostic fields misrepresent the evidence they contain

**Classification:** statically demonstrated.

`frontend/src/hooks/useAutoAlign.ts:837-851` stores appearance rank under `zncc`, structural boundary rank under `census`, coverage under `mi`, and phase peak-to-sidelobe ratio under `nmi`. `frontend/src/types/api.ts:121-134` calls the current search value `bestMiSoFar` even when it is a perceptual rank.

These names suggest physically meaningful metrics that are not actually present. Replace them with one explicit candidate-evidence contract: physical depth, stage, score components, within-stage ranks, overlap, phase correction, transform, confidence evidence, and decision outcome.

## Visual design, accessibility, and product aesthetics

### Actual surfaces inspected

Two real application screenshots were captured from the current checkout at `http://localhost:43124/`, with a measured browser viewport of **3029 × 1483 pixels**. Both surfaces contained zero MRI canvases and no patient data:

- `artifacts/visual-validation/architecture-review-2026-08-23/empty-state.png`.
- `artifacts/visual-validation/architecture-review-2026-08-23/import-modal.png`.

The screenshots establish only the first-run empty state and import dialog. Loaded studies, real MRI rendering, image overlays, smaller viewports, keyboard traversal, animation cadence, and alignment-result presentation remain unverified visually.

### What already works

The restrained near-black palette, subdued surfaces, blue accent, recognizable brain motif, and central dark canvas are directionally appropriate for an image-first radiology viewer. The primary onboarding import action measured **384 × 52 px**, giving it a usable visual and pointer target. The product has a clear opportunity to evolve toward a calm, precise diagnostic-workstation aesthetic rather than a generic dashboard.

### Empty-state composition fails to adapt to an empty dataset

The real empty state renders both empty sidebars, the Grid/Overlay/3D mode switch, date controls, and the full slice/playback bar despite containing no scans. `frontend/src/components/ComparisonMatrix.tsx:629-642`, `:661-690`, `:746-755`, and `:758-766` keep those independent workspace regions mounted while the main content displays onboarding.

At the observed ultrawide viewport, the welcome content floats in a large black void while irrelevant workspace chrome consumes the perimeter. This weakens the eye path and suggests unavailable actions before the product has established a patient, study, or image.

Target state:

- A purpose-built first-run shell with branding, a concise privacy statement, clear accepted formats, and one dominant import action.
- No empty patient/date sidebars, disabled imaging modes, or meaningless playback timeline.
- Progressive disclosure of filters, study context, compare modes, and navigation only after valid data exists.
- Distinct empty, loading, partially imported, unclassified, and populated states.

### Import and related dialogs lack accessible modal behavior

The running import modal exposed no `[role="dialog"]`, no `aria-modal`, and continued to expose underlying workspace controls. `frontend/src/components/UploadModal.tsx:233-246` renders two ordinary `div` containers and an icon-only close button without an accessible name. The actual close target measured **24 × 24 px**.

`frontend/src/components/ExportModal.tsx:97-110` repeats the same structural pattern. Upload and clear dialogs use fixed widths of 480 px and 520 px rather than a viewport-bounded width.

Create one compact accessible dialog primitive that owns:

- Dialog role, modal semantics, and accessible title/description.
- Initial focus, focus containment, Escape behavior where safe, and focus restoration.
- An explicitly named close action and appropriately sized pointer targets.
- Viewport-bounded width, long-content scrolling, and reduced-motion-aware transitions.
- Clearly distinguished idle, progress, partial-success, complete, and failure states.

This is an example where one abstraction is justified because it replaces several currently duplicated and defective ownership boundaries.

### Essential examination controls are invisible to keyboard and touch users

`frontend/src/components/comparison/GridView.tsx:47-64` and `:98-106` determine the active study cell solely from mouse-over/mouse-move events. `frontend/src/components/comparison/GridCell.tsx:71-75` and `:129-133` then hide the tumor, ground-truth, image-adjustment, and slice-offset controls using `opacity-0` and `pointer-events-none` whenever the mouse is not hovering.

The contained buttons remain keyboard-focusable even while visually invisible, and focusing them does not reveal their parent toolbar. Touch devices have no reliable equivalent of persistent desktop hover. Critical per-examination identity and clinical-image controls therefore become undiscoverable or unusable for nonmouse workflows.

Maintain a concise always-visible study/date/context strip, reveal additional controls on both pointer hover and keyboard `:focus-within`, and provide an explicit touch-accessible disclosure. Verify every focusable control is visible, named, and operable when reached through keyboard navigation; preserve sufficient unobstructed image area.

### Playback and global shortcuts remain active behind modal dialogs

`frontend/src/hooks/useOverlayNavigation.ts:194-201` continues cycling examination dates while overlay autoplay is active. Its global key handlers at `:203-259` ignore text inputs but do not exclude modal buttons or modal interaction scope. Pressing Space on a focused dialog button calls `preventDefault`, switches the comparison state, and forcibly blurs that button; arrow/number keys can change the underlying study while a dialog is open.

This compounds the missing dialog semantics: workspace interaction, active examination, keyboard focus, and modal ownership are currently independent state authorities. Introduce one interaction-scope owner; pause playback when a blocking dialog opens, mark the underlying workspace inert, route comparison shortcuts only to an active imaging scope, and restore the prior focus safely when the dialog closes.

### Colors and typography need measurable clinical-workstation standards

`frontend/src/index.css:3-11` defines only primary and secondary text colors, while `--text-tertiary` is referenced throughout **13 production files** without being declared. This makes low-emphasis text depend on invalid CSS custom-property resolution and inherited context rather than a designed token.

The measured white-on-blue accent pair `#ffffff` on `#3b82f6` has a contrast ratio of **3.68:1**, below the commonly required **4.5:1** contrast for normal-size text. Several selected state labels and controls use 10 px or 12 px text, making this a real readability issue rather than a purely stylistic preference.

Other source-backed issues include:

- `focus:outline-none` without an evident replacement in `frontend/src/components/comparison/ComparisonDatesSidebar.tsx:76` and several comparison controls.
- Date selection shortcuts rendered at 10 px: `frontend/src/components/comparison/ComparisonDatesSidebar.tsx:50-60`.
- Alignment reference controls and progress indicators rendered at 10 px: `frontend/src/components/AlignmentControls.tsx:42`, `:68`, and `:98`.
- Two persistent fixed-width sidebars (`w-64` and `w-56`) regardless of narrow-screen available space.
- No production `role="dialog"`, `aria-live`, `aria-pressed`, `aria-selected`, or `aria-current` usage was found in the reviewed TSX sources, leaving mode/selection/operation state largely unavailable to assistive technology.
- `frontend/src/components/comparison/SliceLoopNavigator.tsx:251-284` uses a fully transparent range input and approximately `12 × 20 px` loop-handle buttons whose only adjustment handler is `onMouseDown`; keyboard/touch loop-bound manipulation and visible focus are missing.
- Repeated spinner/pulse effects have no corresponding reduced-motion preference handling in the reviewed component styles.

Define semantic foreground/surface/action/status tokens, restore visible `:focus-visible` treatments, choose accessible accent foreground/background combinations, establish minimum legible control text and hit areas, announce operation progress, respect reduced-motion preferences, and collapse sidebars based on actual available image area.

### Alignment needs understandable, restrained user feedback

Current progress reports a generic score and count: `frontend/src/components/comparison/GridView.tsx:68-92`. It does not explain which dates are secure matches, which require review, whether geometry is incompatible, or whether a run partially succeeded.

The visual target is not a more crowded dashboard. Use small per-study states such as `Aligned`, `Needs review`, `Different acquisition geometry`, and `Failed`; identify the reference examination clearly; support quick before/after inspection and a one-operation undo; keep low-level metric details behind an explicit diagnostic disclosure.

## Target architecture

The smallest coherent target introduces a limited number of authoritative concepts:

```text
Stable browser origin + authoritative owned-storage lifecycle
    -> patient / examination identity + committed dataset revision
       -> canonical imported DICOM frame + validated physical series manifest
          -> bounded high-bit-depth decoded pixels
             -> canonical image ↔ patient ↔ viewport coordinate mapping
                -> interactive image + canonical lesion annotations
                -> immutable worker-owned alignment/reconstruction operations
                -> validated, geometry-bound 2D/3D tumor segmentations
                -> complete versioned backup / restore / verified deletion
```

One alignment operation should then have the following shape:

```text
selected patient + examination + sequence + reference frame
    -> immutable run snapshot and verified target set
    -> compatible physical geometry / explicit degraded mode
    -> bounded high-bit-depth decoded slices and pyramids
    -> orientation/FOV-aware rigid initialization
    -> frame-compatibility and acquisition-obliquity classification
    -> physically plausible candidate-depth search
    -> structure-first coarse ranking
    -> matched-physical-offset 2.5D shortlist scoring when planes are nearly parallel
    -> rigid 3D inter-study mapping + target-plane reslice when obliquity requires it
    -> constrained rigid/similarity refinement
    -> optional justified affine residual
    -> calibrated aligned / ambiguous / incompatible / failed outcome
    -> context-verified per-target application
    -> one complete operation-level undo group
```

Ownership rules:

1. One stable application origin plus an explicit storage inventory owns database lifetime, persistence health, backup/restore completeness, and verified deletion.
2. IndexedDB plus its committed dataset revision owns patient, examination, imported frame, canonical annotation, and accepted segmentation identity.
3. The physical geometry manifest owns frame order, spacing, orientation, field of view, compatibility, occupancy, and degraded-mode provenance.
4. One canonical frame-coordinate mapping owns conversions among source image, patient-space position, contained viewport, display affine, exclusions, annotations, and alignment pan.
5. One decoded-pixel service owns high-bit-depth image access, decode policy, cache invalidation, and bounded run-scoped pyramids shared by alignment, reconstruction, and segmentation.
6. Worker-owned analysis engines own expensive feature extraction, rigid scoring, volume reconstruction, segmentation, confidence evidence, and actual cancellation boundaries.
7. A run-scoped operation coordinator owns active context, result destinations, model/volume provenance, persistence, failure reporting, and undo identity.
8. A single interaction-scope owner arbitrates modal dialogs, image shortcuts, playback, focus, accessibility announcements, and touch/keyboard affordances.
9. React components own presentation; they do not become a second source of storage, geometric, patient, annotation, or alignment truth.

Avoid introducing a second image cache, a second geometry representation, a parallel alignment state machine, or another free-standing confidence heuristic. Reuse and promote the existing SVR and Cornerstone primitives instead.

## Detailed improvement plan

### Phase 0 — Establish an honest safety and measurement baseline

**Purpose:** prevent further architectural tuning from being mistaken for demonstrated accuracy.

**Dependencies:** none.

**Work:**

1. Start from the newly copied, Git-ignored local MRI subset: four longitudinal axial FLAIR examinations plus one coronal and one sagittal companion series. Expand only when additional scanner/protocol/pathology cases are needed.
2. Include patient-disjoint cases covering:
   - Multiple patients and same-day repeat examinations.
   - Different vendors, scanners, and sequence naming conventions.
   - Reversed, duplicate, missing, or interleaved instance numbers.
   - Different slice spacing, stack thickness, and anatomical coverage.
   - Different in-plane resolution, field of view, aspect ratio, and acquisition orientation.
   - Oblique and opposite-direction acquisitions.
   - Same and different frames of reference.
   - Authentic implicit-VR, explicit-VR, compressed, and enhanced multi-frame binary DICOM encodings.
   - Low-texture slices, motion artifacts, missing anatomy, and incomplete imports.
   - Changing lesions and user-defined exclusion regions.
   - Rectangular viewers/images, changed contain letterboxing, shifted fields of view, and thick overlapping slices.
3. Obtain blinded reference slice correspondences and reproducible internal anatomical landmarks; keep evaluator and calibration sets separated by patient.
4. Capture the current baseline without changing the algorithm:
   - Slice error in index units and physical millimeters.
   - Landmark target-registration error in millimeters.
   - Gross/catastrophic mismatch count.
   - Ambiguous or flat-evidence behavior.
   - Decode count, Blob reads, IndexedDB requests, per-date elapsed time, long tasks, allocations, and cancellation latency.
5. Repair validation-harness isolation so a timed-out alignment test cannot poison subsequent hook tests; use an explicit integration timeout while preserving the existing reproduced performance issue as visible evidence.
6. Establish a hard rule that screenshots, logs, and committed benchmark output contain no identifiable patient names, IDs, dates, UIDs, or MRI pixels unless independently approved and appropriately de-identified.
7. Add deterministic pre-implementation regression fixtures for the 51.2-pixel misplaced exclusion, 2× panel-pan error, 125-pixel annotation drift, 19/27 dropped identity voxels, support-gaming NCC candidate, implicit-VR skip, model-class suppression, blocked deletion, and offline restart.

**Tradeoffs:** corpus creation costs more upfront than another scoring tweak, but without independent ground truth there is no credible way to tune search, calibrate confidence, or compare alternatives.

**Exit evidence:** patient-disjoint benchmark inventory, baseline metrics, a repeatable execution command, test-harness isolation, and an explicit statement of any scenarios still lacking representative data.

### Phase 1 — Protect durable origins, patient identity, backup, and verified deletion

**Purpose:** eliminate the most harmful user-visible correctness failures before improving alignment quality.

**Primary boundaries:** `frontend/distribution/run_miraviewer.py`, platform launchers, `frontend/src/db/schema.ts`, `frontend/src/db/db.ts`, `frontend/src/services/dicomIngestion.ts`, `frontend/src/utils/localApi.ts`, `frontend/src/utils/storageKeys.ts`, `frontend/src/utils/segmentation/onnx/modelCache.ts`, `frontend/src/types/api.ts`, `frontend/src/components/ComparisonMatrix.tsx`, `frontend/src/components/Svr3DView.tsx`, `frontend/src/services/exportBackup.ts`, and the export/clear dialogs.

**Work:**

1. Give the offline distribution one stable, deterministic local browser origin across restarts, with explicit port-conflict behavior that never silently strands existing IndexedDB state.
2. Establish one inventory for every application-owned database, local-storage namespace, uploaded model, cookie, and future cache; preserve unrelated origin data.
3. Introduce explicit selected-patient identity and examination identity, retaining full study UID and acquisition timestamp.
4. Ensure every comparison column, saved setting, annotation, alignment run, and reconstruction run belongs to exactly one selected patient.
5. Preserve same-day examinations as distinct selectable entities rather than letting one date overwrite another.
6. Persist `FrameOfReferenceUID` and reject incompatible multi-plane reconstruction inputs unless a validated mapping is available.
7. Treat missing or ambiguous patient identifiers as requiring explicit clarification rather than silently merging studies.
8. Immediately rename the existing archive operation if it remains DICOM-only; remove any implication that annotations or settings are protected.
9. Implement a versioned complete snapshot containing selected DICOM content, user-created 2D/3D segmentations, ground-truth polygons, relevant settings, manifest versions, identity metadata, and integrity checks.
10. Use canonical UIDs in ZIP paths and implement a restore flow with collision/conflict handling and transactional import.
11. Coordinate destructive IndexedDB requests across tabs. Keep blocked deletes visibly pending until their actual terminal outcome; never show a failed/cancelled state while queued deletion can still erase data later.
12. Verify owned-storage absence after clear, surface persistence/quota health, and reset failed memoized database-open promises only after the relevant failure is actually resolved.

**Tradeoffs:** introducing patient/examination scoping changes persisted-key shape and requires migration. Preserve existing records through a deterministic, auditable migration or present unresolved legacy ownership explicitly.

**Acceptance gates:**

- Two different patients can never appear in the same longitudinal matrix or SVR reconstruction.
- Two same-day examinations remain independently addressable.
- Mixed frame-of-reference inputs are rejected or explicitly registered.
- Start the packaged app, import scans, save 2D/3D annotations and settings, stop it, restart twice, and verify the identical origin and complete saved state.
- Save a 2D/3D segmentation, ground-truth polygon, and alignment settings; export; clear; restore; verify all records, provenance, and image bytes are restored.
- Distinct same-name studies/series do not collide inside the archive.
- User-facing backup language exactly matches the implemented completeness contract.
- Seed every owned storage namespace/model database, clear data, and verify no MiraViewer-owned records remain while unrelated origin state survives.
- A second open tab cannot convert a displayed deletion failure into later unannounced data loss.
- Denied persistence, insufficient quota, and recoverable IndexedDB-open failures have explicit actionable UI states.

### Phase 2 — Establish one validated physical series/frame manifest

**Purpose:** give every consumer the same anatomical identity and ordering.

**Primary boundaries:** `frontend/src/services/dicomIngestion.ts`, `frontend/src/components/UploadModal.tsx`, `frontend/src/db/schema.ts`, `frontend/src/db/db.ts`, `frontend/src/utils/localApi.ts`, `frontend/src/utils/svr/dicomGeometry.ts`, `frontend/src/utils/svr/vec3.ts`, and `frontend/src/utils/dicomSeriesParsing.ts`.

**Work:**

1. Correct missing/implicit-VR numeric tag parsing using dictionary-aware typed accessors and finite-result checks; require authentic binary-wire tests rather than string-only parser mocks.
2. Promote reusable SVR geometry parsing into a shared DICOM-geometry module rather than inventing a separate alignment representation.
3. Validate finite image position, positive pixel spacing, nonzero direction vectors, near-orthogonality, a nonzero cross product, and within-series orientation consistency.
4. Model each displayable frame as `(StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, frameIndex)`.
5. Parse `FrameOfReferenceUID`, acquisition timestamp, frame count, and per-frame orientation/position when present.
6. Project frame positions onto a consistent signed series normal and sort by physical depth when valid.
7. Preserve physical spacing, slice thickness, frame coverage, pixel dimensions, field of view, orientation, and reliability status in a compact manifest.
8. Keep `InstanceNumber` ordering only as an explicit degraded fallback with visible provenance.
9. Make measured orientation authoritative for plane classification; constrain description parsing to explicit vocabulary and retain disagreement diagnostics.
10. Keep unknown classifications selectable under `Unclassified` instead of hiding imported data.
11. Implement committed dataset/per-series revisions and invalidate affected order/image caches only after successful writes.
12. Bound ZIP entry count, declared/uncompressed bytes, expansion ratio, cancellation, and available storage capacity before inflating or persisting entries.
13. Make ingestion cross-store atomic, bounded, quota-aware, and explicit about completeness and partial failure.

**Tradeoffs:** a manifest stores additional metadata but removes repeated independent ordering/classification decisions across viewer, alignment, annotation, and SVR. If enhanced multi-frame support needs a later increment, reject it clearly in the interim.

**Acceptance gates:**

- Physical ordering agrees across viewer navigation, tumor annotation, alignment, backup, and SVR.
- A valid binary Implicit VR Little Endian image with real `US` rows/columns imports and renders correctly alongside explicit and compressed syntaxes.
- Reversed, shuffled, duplicate, missing, and interleaved instance numbers resolve correctly.
- A physically coronal “POST CONTRAST T1” scan remains coronal.
- Valid unknown-protocol scans remain visible and selectable.
- Zero/parallel orientation vectors are rejected explicitly.
- Additional imported frames become visible immediately without reload or stale-cache errors.
- Injected transaction/quota failures cannot create orphan parents or falsely report complete success.
- A synthetic >1,000:1 archive is rejected before oversized inflation, database writes, or UI freeze.
- Enhanced multi-frame inputs are either fully frame-aware or rejected with an actionable explanation.

### Phase 2A — Establish one canonical frame-to-viewport coordinate mapping

**Purpose:** repair the common representation error behind misplaced lesion exclusions, drifting annotations, and incorrect displayed alignment translations.

**Dependencies:** patient/frame identity and source image dimensions from Phase 2; no 3D registration change is required.

**Primary boundaries:** `frontend/src/utils/viewportMapping.ts`, `frontend/src/utils/viewTransform.ts`, `frontend/src/utils/panelTransform.ts`, `frontend/src/components/DragRectActionOverlay.tsx`, `frontend/src/components/GroundTruthPolygonOverlay.tsx`, `frontend/src/components/TumorSavedSegmentationOverlay.tsx`, `frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx`, `frontend/src/components/DicomViewer.tsx`, and `frontend/src/hooks/useAutoAlign.ts`.

**Work:**

1. Define one explicit mapping among source-image pixels/normalized coordinates, physical DICOM coordinates where available, the contained image rectangle, viewport pixels, display pan, zoom, rotation, and affine residual.
2. Reuse `containRectPx`, `viewerNormToImageNorm`, and `imageNormToViewerNorm` instead of introducing a second geometry system.
3. Convert all four lesion-exclusion rectangle corners into canonical source-image coordinates after undoing display transforms and contain padding; reject/clip out-of-image selections explicitly.
4. Convert analysis-grid translations into panel pan through the actual contained-image dimensions; invert the same mapping when composing reference display transforms.
5. Persist lesion polygons, seeds, and exclusions in canonical source-image/patient coordinates with immutable SOP/frame identity.
6. Migrate existing viewport-normalized annotations using their already-persisted authored viewport dimensions, source image dimensions, and saved view transform.
7. Project canonical annotations into the current viewport only for presentation; reproject derived/resliced planes only when their physical transform and provenance are verified.
8. Report lesion area in calibrated `mm²` using independent row/column pixel spacing, not screenshot pixel count.

**Tradeoffs:** canonical-coordinate migration changes previously persisted annotation semantics. Preserve old records, label migration versions, and fail visibly when the authored dimensions needed to migrate safely are unavailable.

**Acceptance gates:**

- A lesion occupying image `x=0.10...0.20` in a `1000 × 500` letterboxed viewer excludes exactly that image interval, not viewport `x=0.30...0.35`.
- A 25.6-pixel translation on a 256-pixel square analysis grid moves a 500-pixel contained image exactly 50 viewport pixels, not 100.
- The same saved outline remains anatomically fixed when a `1000 × 500` viewport becomes `500 × 1000`; the demonstrated 125-pixel drift is eliminated.
- Grid/overlay modes, aspect-ratio changes, zoom, pan, rotation, affine transforms, anisotropic source spacing, reload, and backup/restore preserve annotation geometry within a declared source-pixel tolerance.
- Presentation-only changes do not alter exclusion, segmentation, or calibrated lesion area.

### Phase 3 — Make alignment and reconstruction operations context-safe

**Purpose:** prevent valid calculations from mutating invalid destinations.

**Primary boundaries:** `frontend/src/types/api.ts`, `frontend/src/hooks/useAutoAlign.ts`, `frontend/src/hooks/useApplyAlignmentResults.ts`, `frontend/src/hooks/usePanelSettings.ts`, `frontend/src/hooks/useSvrReconstruction.ts`, `frontend/src/hooks/useOnnxTumorSession.ts`, `frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx`, `frontend/src/components/ComparisonMatrix.tsx`, and `frontend/src/components/comparison/SliceLoopNavigator.tsx`.

**Work:**

1. Define an immutable alignment run containing run ID, patient, sequence, reference examination/frame, target examinations/series, dataset revision, and progress snapshot.
2. Attach producing-run and target identity to every result and progress update.
3. Verify patient, sequence, target series, reference, and dataset revision immediately before visible-state or persisted-state application.
4. Decide whether navigation/playback is paused for the run or whether offsets are rebased atomically to current progress; test the chosen behavior explicitly.
5. Reject, cancel, or explicitly detach results after incompatible patient, sequence, filter, or dataset changes.
6. Use one complete run-level undo group even if date results become visible incrementally.
7. Make each target produce a terminal status: success, ambiguous, incompatible, failed, or cancelled. A recoverable failure on one date must not silently prevent all later targets.
8. Surface actual persistence failures rather than swallowing them.
9. Give SVR the same operation-identity discipline; abort reconstruction on clear, date change, unmount, and replacement, and ignore stale completions.
10. Bind asynchronous tumor autosave, growth, ONNX inference, and model-session creation to immutable patient/study/series/SOP/frame/volume/model generations; discard stale results after every awaited boundary.
11. Give uploaded ONNX models one single-flight, generation-scoped inference session; close superseded sessions and distinguish true abort from an in-flight operation whose output is merely being ignored.

**Tradeoffs:** freezing playback is easier to explain and test; atomic rebase better preserves interaction but needs careful current-state ownership. Choose based on user workflow, not implementation convenience alone.

**Acceptance gates:**

- Switching sequence during Align All cannot write old transforms into the new sequence.
- Advancing playback cannot change which selected anatomy is finally displayed.
- Failure on date three does not silently mutate or skip unrelated targets.
- One undo reverses the complete Align All operation.
- Changing date while SVR runs aborts the old worker and never displays its result in the new context.
- Superseded operations cannot clear newer abort controllers or overwrite newer state.
- Changing slice while a tumor autosave awaits IndexedDB never paints the previous slice's lesion on the newly selected anatomy.
- Replacing a model or volume cannot install a stale inference session or stale segmentation; user-visible cancellation describes actual resource behavior accurately.

### Phase 4 — Reuse one raw decoded-pixel and bounded cache authority

**Purpose:** preserve actual MRI information while removing repeated decode and hidden-canvas dependencies.

**Primary boundaries:** `frontend/src/utils/cornerstoneInit.ts`, `frontend/src/components/DicomViewer.tsx`, `frontend/src/components/TumorSegmentationOverlaySeedGrow.tsx`, `frontend/src/utils/segmentation/segmentTumor.ts`, `frontend/src/utils/cornerstoneSliceCapture.ts`, `frontend/src/utils/svr/reconstructVolume.ts`, and the alignment engine.

**Work:**

1. Expose a canonical decoded frame containing native pixel samples, slope/intercept, polarity, dimensions, physical spacing, field of view, and validated geometry.
2. Reuse the current SVR `getPixelData()` and area-average resampling behavior instead of creating a second decoding stack.
3. Call Cornerstone's actual cache-owning API for interactive and alignment loads; preserve the configured bounded-memory policy.
4. Keep bulk SVR streaming explicitly non-caching or evict it promptly so it cannot displace the interactive working set.
5. Build one bounded run-scoped pyramid from each decoded frame and share it between seed, coarse scoring, fine scoring, and final refinement.
6. Preserve high-bit-depth intensity until a deterministic modality normalization step, independent of manual viewer brightness, contrast, and display window.
7. Move lesion exclusions through canonical source and physical transforms, preserving current exclusion-footprint protections.
8. Remove the hidden Cornerstone-render-element path from algorithmic alignment once equivalent behavior is proven.
9. Invalidate cache and pyramid entries on committed dataset/frame changes.
10. Verify JPEG Lossless codec initialization, worker asset resolution, actual Cornerstone rendering, and offline ZIP behavior with representative real or de-identified compressed frames.
11. Move 2D tumor growth from display PNG encode/decode to the same canonical high-bit-depth decoded frame and canonical image-space ROI; eliminate presentation padding and physically meaningless screenshot-area limits.

**Tradeoffs:** raw-pixel registration may differ from the historical windowed result. Treat that as a deliberate representation correction and evaluate it against patient-disjoint ground truth, not visual similarity to a lossy intermediate.

**Acceptance gates:**

- Repeated interactive visits hit the bounded cache rather than reloading the Blob.
- Reference, seed, shortlisted winner, and final refinement reuse one decoded frame when retained.
- Two source intensities that collapse into the same 8-bit display value remain distinguishable to registration.
- Manual brightness/contrast changes do not change anatomical matching.
- Manual brightness, contrast, zoom, viewport dimensions, and device-pixel ratio do not change an image-space lesion mask or its calibrated physical area.
- Memory remains bounded during large SVR and alignment runs.
- Correct behavior survives import, deletion, revision invalidation, and cancellation.
- Real JPEG Lossless frames decode and render through the production browser path and through the offline ZIP, not merely through mocked initialization.

### Phase 4A — Correct 3D geometric primitives before reusing them for alignment

**Purpose:** make existing SVR rigid-registration and resampling infrastructure physically trustworthy before it becomes the longitudinal alignment authority.

**Dependencies:** the physical frame manifest and decoded-pixel ownership from Phases 2 and 4.

**Primary boundaries:** `frontend/src/utils/svr/trilinear.ts`, `frontend/src/utils/svr/svrUtils.ts`, `frontend/src/utils/svr/reconstructionCore.ts`, `frontend/src/utils/svr/reconstructVolume.ts`, `frontend/src/utils/svr/resample2d.ts`, `frontend/src/utils/svr/sliceRoiCrop.ts`, `frontend/src/utils/svr/rigidRegistration.ts`, `frontend/src/utils/svr/svrComputeCore.ts`, `frontend/src/components/SvrVolume3DViewer.tsx`, and `frontend/src/utils/svr/glRaymarch.ts`.

**Work:**

1. Accept exact final voxel centers in trilinear sampling/splatting and clamp zero-weight ceil neighbors safely; make the support predicate use the same inclusive convention.
2. Shift downsampled image origins by the actual destination-bin center along DICOM row and column direction vectors.
3. Carry slice thickness, true center spacing, PSF support, and interpolation halos into ROI cropping; retain physically overlapping slabs.
4. Preserve a reconstructed occupancy/support mask so unsupported zero voxels cannot masquerade as measured zero-intensity anatomy.
5. Preserve trusted same-frame DICOM geometry; replace unconditional bounds-center mutation with an explicitly scored candidate pose.
6. Score rigid candidates on a fixed anatomical domain or validated bidirectional support, with baseline-relative retained coverage and explicit lesion exclusion; a cropping transform must never win by dropping evidence.
7. Initialize unlike frames using acquisition orientation/stable anatomy before residual optimization; do not treat the existing ±10° search bound as sufficient for the actual 18.050° case.
8. Compute a CPU-side transposed 3×3 rotation matrix once in a reusable buffer and upload it to WebGL with `transpose=false`.
9. Keep worker execution mandatory for unbounded production reconstruction; surface an actionable module-worker/CSP/asset failure instead of silently running a minutes-long solve on the UI thread.

**Tradeoffs:** correcting occupancy and boundary semantics can change historical reconstructions. Validate against deterministic phantoms, physically correct source geometry, and held-out landmarks rather than treating the current incorrect output as the preservation oracle.

**Acceptance gates:**

- Identity resampling preserves all 27 nonzero samples of a `3 × 3 × 3` volume, including every face, edge, corner, and exact final voxel; boundary splats conserve weights.
- Downsampled 512-pixel real-MRI geometry no longer carries the demonstrated 0.285–0.645 mm per-axis patient-space origin shift.
- A 1.2-mm-thick slice centered 0.4 mm outside an ROI remains included when its physical slab overlaps the ROI.
- A correct partial-coverage stack no longer moves from `(0,0,0)` to `(1,1,1) mm` merely because its field-of-view center differs.
- The adversarial transform with NCC 1.000 but only 594/12,474 retained samples is rejected.
- A genuine WebGL2 draw reports `gl.NO_ERROR` and correctly renders/rotates a reference volume.
- Missing worker support produces an explicit recoverable error without freezing the application.

### Phase 4B — Validate and persist clinically meaningful tumor segmentation

**Purpose:** ensure segmentation masks and lesion-volume measurements have correct anatomy, explicit model semantics, and durable ownership.

**Dependencies:** canonical image/volume geometry, patient identity, and the storage inventory; model validation can be implemented independently of alignment scoring.

**Primary boundaries:** `frontend/src/utils/segmentation/onnx/tumorSegmentation.ts`, `frontend/src/utils/segmentation/onnx/logitsToLabels.ts`, `frontend/src/utils/segmentation/onnx/modelCache.ts`, `frontend/src/hooks/useOnnxTumorSession.ts`, `frontend/src/components/SvrVolume3DViewer.tsx`, `frontend/src/db/schema.ts`, and complete backup/restore.

**Work:**

1. Define a validated model manifest for source modality, preprocessing/intensity normalization, input channels, tensor axis order, spatial geometry, output class count, and each class-to-anatomy mapping.
2. Reject output dimensions that differ from the current source-volume dimensions, even when their products match; allow remapping only through an explicit verified geometric transform.
3. Reject any model class without a declared semantic mapping instead of silently converting it into background.
4. Persist accepted 3D label volumes under patient/examination/series/frame-of-reference, source reconstruction fingerprint, voxel geometry, transform provenance, and model/algorithm metadata.
5. Invalidate or explicitly remap persistent labels when their physical source volume changes; never attach labels to a same-sized but incompatible reconstruction.
6. Include authored 2D/3D masks, ground truth, voxel units, semantics, and provenance in complete backup/restore.
7. Suppress lesion overlays and physical measurements until model, geometry, and provenance validation succeeds.

**Tradeoffs:** fail-closed validation can reject previously accepted user-uploaded models. Explain the missing model contract and offer an explicit adaptation workflow rather than displaying uncertain anatomy as correct.

**Acceptance gates:**

- `[64,128,64]` and `[128,64,64]` are rejected as distinct anatomical layouts despite equal voxel count.
- A five-class model with a four-class map errors visibly instead of turning winning class four into background.
- Invalid or stale labels never reach the 3D overlay or reported lesion milliliters.
- Accepted segmentations survive view changes, reconstruction reuse, reload, packaged offline restart, full export, and restore.
- Changed patient, frame, model semantics, volume geometry, or source-series fingerprint cannot resurrect an incompatible saved lesion mask.

### Phase 5 — Improve through-plane alignment accuracy with physical evidence

**Purpose:** select the anatomically corresponding slice rather than the nearest plausible image.

**Primary boundaries:** the shared series manifest, `frontend/src/hooks/useAutoAlign.ts`, `frontend/src/utils/alignment.ts`, `frontend/src/utils/perceptualSliceSimilarity.ts`, `frontend/src/utils/phaseCorrelation.ts`, `frontend/src/utils/svr/rigidRegistration.ts`, `frontend/src/utils/svr/svrComputeCore.ts`, and `frontend/src/utils/svr/reconstructionCore.ts`.

**Work:**

1. Verify patient, acquisition orientation, sequence compatibility, frame relationship, physical spacing, field of view, and stack coverage before search.
2. For a common or registered frame of reference, derive the target prior from projected physical slice depth rather than proportional array index.
3. For distinct or unknown frames, derive a relative/anatomical prior from signed stack orientation, normalized physical coverage, available landmarks, and explicit uncertainty.
4. Replace fixed ±40-index windows with physical-distance and coverage-aware candidate intervals.
5. Expand uncertain searches according to measured evidence and a declared work budget; never silently exclude a plausible anatomical match because of an arbitrary index ceiling.
6. Normalize true DICOM row/column orientation and field-of-view differences before phase correction.
7. Retain MIND/NGF-dominant fixed-domain scoring and exclusion-aware support, but separate relative rank from absolute evidence.
8. Build a small physically spaced shortlist rather than separating peaks by a fixed number of arbitrary indices.
9. Add geometry-gated **2.5D** comparison: evaluate the candidate frame together with adjacent slices at matched signed physical offsets, accounting for unequal slice spacing and slice thickness.
10. Skip or downweight slab evidence when orientation, spacing, adjacent coverage, or frame quality is unreliable; expose that degraded state explicitly.
11. Detect acquisition-angle disagreement explicitly. For materially nonparallel planes such as the observed ~18° longitudinal pair, compare a geometry-corrected reslice rather than pretending one target frame can match the full reference plane.
12. Reuse existing SVR 3D geometry, six-degree-of-freedom ROI-rigid optimization, cancellable scoring, validated occupancy, and corrected trilinear interpolation to estimate a rigid cross-study mapping and synthesize the target plane when that path improves held-out landmarks.
13. Initialize unlike frames from acquisition orientation and stable anatomical evidence before applying the existing residual optimizer; its current ±10° rotation bound cannot cover the observed 18.050° plane disagreement from an uninitialized starting pose.
14. Validate fixed-domain/bidirectional overlap, reconstruction occupancy, stable-anatomy ROI selection, lesion exclusion, intensity normalization, and preserved same-frame geometry before trusting a volume registration objective across longitudinal acquisitions.
15. Preserve source frames and make any resliced view an explicit derived presentation, with a native-image fallback and confidence state.
16. Consider lightweight candidate-specific rigid refinement only for a small top-K set and only when benchmarked evidence shows it resolves anatomically close competitors.

**Tradeoffs:** 2.5D scoring adds compute, but constraining it to a small physically justified shortlist is more targeted than evaluating another expensive metric across every candidate. On the actual corpus, 2.5D alone cannot remove ~18° acquisition-angle drift, so rigid 3D registration/reslicing must be evaluated as a distinct geometry-correct path. Do not reintroduce candidate-specific deforming transforms that can make a wrong slice resemble the right one.

**Acceptance gates:**

- Correct slices beyond the historical ±80-index maximum become reachable.
- Different coverage, slice spacing, stack direction, and oblique orientation preserve correct anatomical correspondence.
- Adjacent lookalike slices are distinguished using their neighboring physical anatomy.
- Different frames of reference never use unjustified absolute-coordinate assumptions.
- The actual longitudinal ~18° oblique-plane case either improves through validated rigid 3D reslicing or reports that native-slice alignment remains intrinsically incomplete.
- Cross-frame initialization places the actual ~18° acquisition mismatch within a justified residual search region; the existing ±10° optimizer is never silently treated as sufficient from an identity pose.
- A higher NCC obtained by discarding 95% of originally valid anatomical support cannot be accepted.
- The real sagittal 0.6 mm center spacing and 1.2 mm thickness remain distinct throughout sampling and evaluation.
- Missing or inconsistent geometry produces an explicit degraded result rather than fabricated certainty.
- Held-out physical-depth and gross-mismatch metrics improve without hiding meaningful pathology.

### Phase 6 — Improve in-plane registration while preserving longitudinal truth

**Purpose:** make overlay alignment more precise without deforming away actual anatomical change.

**Primary boundaries:** decoded image geometry, `frontend/src/utils/elastixRegistration.ts`, `frontend/src/utils/elastixTransform.ts`, `frontend/src/utils/structuralAffineSelection.ts`, and transform/panel conversion utilities.

**Work:**

1. Initialize orientation, expected scale, aspect ratio, and field-of-view mapping from validated acquisition geometry.
2. Normalize true acquisition-axis flips before registration; do not permit arbitrary anatomical reflection as an optimizer escape hatch.
3. Prefer rigid or physically justified similarity transforms for the default final solution.
4. Apply narrow displacement/shear/anisotropy bounds only to the unexplained residual after physical normalization.
5. Protect the first rigid seed from excluded/changing pathology using geometry initialization, robust weighting, and correctly propagated source-space masks.
6. Evaluate inverse consistency, forward and reverse anatomical coverage, physically plausible scale, convergence quality, and independent structural agreement.
7. Where direction conventions are ambiguous, compare transformations on valid anatomy rather than entire black-padded canvases; reject unresolved convention ties.
8. Retain the current non-degrading seed-only fallback and fixed-domain structural gate.
9. Permit affine residuals only where a held-out corpus demonstrates improvement and the deformation does not conceal true anatomical change.
10. Test higher-resolution refinement and optimizer iteration/sample settings only after the raw-pixel and geometry baselines are stable.

**Tradeoffs:** fully deformable registration could improve visual overlap while erasing meaningful treatment or lesion change. It is specifically inappropriate as the default for longitudinal comparison and should remain out of scope unless a separate clinically validated contract exists.

**Acceptance gates:**

- A physically valid 192 mm ↔ 256 mm field-of-view correction is accepted.
- Excluded lesion changes cannot steer initial or final registration.
- Reflections, unsupported anisotropy, anatomy-hiding crops, and ambiguous transform directions are rejected.
- Held-out landmark error in millimeters improves or remains equivalent.
- Known true pathology changes remain visible after alignment.

### Phase 7 — Add calibrated confidence, failure isolation, and concise results

**Purpose:** replace plausible-looking guesses with evidence-backed decisions.

**Primary boundaries:** alignment result types, candidate diagnostics, operation coordinator, viewer badges, and per-date status presentation.

**Work:**

1. Create a typed per-candidate record for raw structural scores, within-stage ranks, physical depth, anatomical support, phase correction, proposed transform, and optimizer diagnostics.
2. Remove misleading legacy field aliases such as `bestMiSoFar`, rank-as-`zncc`, coverage-as-`mi`, and phase-ratio-as-`nmi`.
3. Characterize informative versus flat references, runner-up gaps, cross-scale consistency, bidirectional overlap, geometry agreement, and transform plausibility on the calibration set.
4. Derive abstention/acceptance thresholds only from held-out patient-disjoint evidence; keep threshold provenance visible to developers.
5. Produce explicit per-target `aligned`, `ambiguous`, `insufficient-overlap`, `incompatible-geometry`, `failed`, and `cancelled` outcomes.
6. Do not automatically persist low-confidence transformations.
7. Present a small, readable result indicator and an optional evidence/detail affordance rather than opaque numerical scores.
8. Preserve privacy: ordinary logs should not expose patient identifiers, full UIDs, sensitive dates, or pixel arrays.

**Tradeoffs:** abstaining can leave more dates unmodified. That is preferable to silently presenting false anatomical correspondence; track both accepted-result precision and abstention coverage so the system does not improve one by rendering the other meaningless.

**Acceptance gates:**

- Flat images and indistinguishable candidates never receive automatic confident-success status.
- Accepted results meet the calibrated held-out precision target chosen after baseline collection.
- Ambiguous and incompatible dates are visible and do not overwrite settings.
- One target failure does not erase valid results or suppress all later targets.
- User-facing status remains understandable without interpreting research metrics.

### Phase 8 — Move feature extraction and scoring into one bounded worker engine

**Purpose:** restore interactive responsiveness and remove repeated transient allocation.

**Primary boundaries:** `frontend/src/hooks/useAutoAlign.ts`, `frontend/src/utils/mindDescriptor.ts`, `frontend/src/utils/perceptualSliceSimilarity.ts`, `frontend/src/utils/phaseCorrelation.ts`, and the existing transferable-worker patterns under `frontend/src/utils/svr/`.

**Work:**

1. Extract a pure, worker-compatible alignment engine from the 1,329-line React hook.
2. Transfer or otherwise share bounded decoded frame buffers without duplicating complete image stacks.
3. Prepare reference pyramids, FFT state, masks, and geometry once per run.
4. Reuse MIND descriptor scratch buffers, phase buffers, warp scratch, and local-statistics storage across serial candidates.
5. Keep retained candidate records scalar/narrow; release intermediate buffers after scoring.
6. Send coarse progress updates without generating a React render per pixel operation or candidate.
7. Preserve explicit worker startup failure, timeout, cancellation, and cleanup semantics.
8. Measure the worker boundary with real Cornerstone decoding and real Elastix; do not infer product responsiveness solely from a mocked test.
9. Keep descriptor/metric correctness tests, but separate low-cost unit cases from realistically budgeted production-path integration tests.
10. Eliminate the obsolete off-screen rendering mechanism and compatibility-only score aliases after all consumers move to the canonical engine.
11. Update 3D segmentation class/volume metrics incrementally from existing sparse dirty indices instead of rescanning up to 7,077,888 voxels per preview.
12. Move interactive 3D growth and unbounded reconstruction to the same worker-owned compute lifecycle; expose module-worker failure instead of silently performing a minutes-long solve on the main thread.
13. Centralize image/debug keyboard listeners under the active interaction scope; avoid one global keydown/keyup/blur registration per mounted viewer.

**Tradeoffs:** a worker adds a real execution boundary, but it replaces hidden DOM rendering, UI-thread FFT/feature extraction, and fragmented cancellation ownership. Reuse the SVR worker protocol patterns instead of inventing another unrelated lifecycle model.

**Acceptance gates:**

- The standard `npm run check` succeeds reliably without timeout cascades.
- A timed-out/failed integration test cannot corrupt later tests.
- Representative candidate scoring no longer creates long main-thread tasks.
- Cancellation and sequence changes remain responsive during a full search.
- Reference and winner decoded-frame counts, allocation volume, peak retained memory, and worker count are measured before/after.
- Repeated runs do not leak workers or pixel buffers.
- Numerical results match or improve the held-out accuracy baseline.
- Sparse segmentation previews perform work proportional to changed voxels, not the complete volume, and preserve exact class counts/physical volume.
- Unsupported workers, stale ONNX model sessions, and uncancellable inference have truthful status and bounded resource behavior.

### Phase 9 — Simplify and polish the product shell

**Purpose:** make the product feel like a clear, trustworthy imaging workstation.

**Primary boundaries:** `frontend/src/components/ComparisonMatrix.tsx`, comparison sidebars/views, dialog components, `frontend/src/components/AlignmentControls.tsx`, `frontend/src/components/comparison/SliceLoopNavigator.tsx`, and `frontend/src/index.css`.

**Work:**

1. Split the current root orchestration conceptually into:
   - Dataset/patient/examination selection.
   - Shared comparison workspace state.
   - Grid/overlay/3D presentation.
   - Import/export/reset operation presentation.
2. Preserve a single state owner for patient identity, active examination, view mode, sequence, selected dates, and global slice position.
3. Replace the current empty workspace with a dedicated onboarding surface; hide empty sidebars, unused mode switches, date actions, and playback.
4. Make the selected patient and examination unmistakable once data is loaded.
5. Introduce one accessible shared modal primitive with semantic title, focus management, safe dismiss behavior, and responsive sizing.
6. Define the missing tertiary text token and choose readable primary/secondary/muted/action/status color pairs.
7. Replace the 3.68:1 normal-text blue/white action treatment with a tested accessible combination.
8. Establish minimum font sizes, hit areas, focus-visible outlines, keyboard behavior, reduced-motion support, and responsive sidebar collapse.
9. Use progressive disclosure for expert SVR/segmentation controls and detailed alignment diagnostics.
10. Display truthful statuses for partial import, unclassified scans, unsupported frames, ambiguous alignment, and incomplete backups.
11. Validate actual integrated routes at representative small, standard, and ultrawide viewports; do not substitute isolated component stories for loaded product evidence.
12. Provide one modal/image interaction-scope owner; pause playback and suppress global image shortcuts while dialogs are open.
13. Reveal essential per-study controls on keyboard focus and touch as well as hover; offer accessible rectangle/segmentation initiation and keyboard-adjustable loop bounds.
14. Announce operation/error state through appropriate live regions, expose selected/pressed/current state semantics, and respect reduced-motion preferences.

**Tradeoffs:** simplifying visible chrome must not hide access to loaded-study functionality. The appropriate model is state-dependent disclosure, not deleting expert tools indiscriminately.

**Acceptance gates:**

- First-run state presents no unusable workspace controls or empty navigation.
- Loaded patient identity and study context are visible and unambiguous.
- Import/export/reset dialogs have correct semantics, named controls, focus containment, and responsive dimensions.
- Normal-size foreground/action text meets the chosen contrast standard.
- Keyboard-only navigation, focus restoration, Escape handling, and reduced motion are verified.
- Every keyboard-focusable loaded-study control is visible and named; touch users can access tumor tools, image controls, and slice offsets without desktop hover.
- Dialog button activation never changes the underlying examination or loses focus; playback pauses until modal interaction ends.
- Loop handles, selected modes, active dates, and operation status have accessible keyboard/assistive-technology semantics.
- Actual app screenshots cover empty, importing, partial/error, loaded grid, loaded overlay, alignment progress, ambiguous result, and 3D states without storing identifiable patient pixels.

### Phase 10 — Right-size startup cost and distribution payload

**Purpose:** reduce real download/startup work without breaking offline functionality.

**Primary boundaries:** `frontend/src/components/ComparisonMatrix.tsx`, 3D/alignment entrypoints, `frontend/vite.config.ts`, the offline ZIP staging scripts, and runtime asset-loading code.

**Work:**

1. Measure initial network transfer, parse/compile/evaluate time, first empty screen, first import interaction, and first loaded slice.
2. Lazy-load the 3D viewer, segmentation tooling, advanced dialogs, and registration runtime at actual first use.
3. Inspect which of the 47 copied ITK/ONNX artifacts are truly required by supported production and offline execution paths.
4. Exclude redundant formats, backends, or helper bundles only after proving the selected runtime resolves all required assets.
5. Consider an explicit optional advanced-imaging distribution only if real package-size data and product expectations justify it; preserve a complete offline-capable path.
6. Avoid making ONNX/model availability look functional when no compatible model has been provided.
7. Measure cold versus warm loaded-study interactions with representative datasets and device capabilities.
8. Trace the actual production/offline ONNX dependency closure before considering the currently copied approximately 3.64 MiB of WebGL-only entrypoints or 9.03 MiB of unminified alternative entrypoints; never assume safe deletion from filenames alone.

**Tradeoffs:** route-level code splitting can improve startup while adding first-use latency for alignment or 3D. Make those transitions explicit and benchmark both, rather than moving cost invisibly. Never remove an asset solely because its filename looks redundant.

**Acceptance gates:**

- The base viewer works before 3D/ONNX/registration code is needed.
- The offline ZIP still runs without internet access.
- The offline ZIP restarts on the identical origin and retains its complete local database; startup optimizations do not reintroduce ephemeral-origin data loss.
- Every supported Elastix and ONNX execution mode resolves its actual assets.
- Startup and package-size improvements are established with current before/after measurements.
- Basic viewing remains responsive while advanced features load lazily.

## Accuracy and performance evaluation contract

### Accuracy measures

Use a patient-disjoint held-out corpus and report:

- Absolute through-plane anatomical error in millimeters.
- Through-plane error in slice counts, normalized by the target's actual spacing.
- Internal-landmark target-registration error in millimeters.
- Image-space exclusion-mask placement error, displayed transform/pan error, and saved-annotation reprojection error in source pixels and physical millimeters.
- Top-one anatomical-match rate.
- Fraction of errors greater than one clinically meaningful slice interval.
- Gross/catastrophic wrong-anatomy rate.
- Results stratified by scanner, orientation, sequence, slice thickness, spacing, coverage, field of view, pathology, and frame-of-reference compatibility.
- Effect of lesion exclusion and preservation of real longitudinal changes.
- Reconstruction sampling identity, final-voxel support, downsample-origin error, retained registration support, and thick-slice ROI coverage.
- Lesion area/volume consistency under presentation-only changes and validated segmentation-model axis/class contracts.
- Same-input repeatability across runs and browser sessions.

Do not report arbitrary clinical thresholds, percentage gains, or statistical percentiles before the dataset and sample size justify them.

### Confidence and safety measures

Report:

- Accepted-result precision.
- Ambiguous-result/abstention rate.
- Correct rejection of mixed patients, unsupported frames, incompatible geometry, and insufficient overlap.
- Correct rejection of mismatched ONNX voxel axes, undeclared tumor classes, stale volume fingerprints, and support-losing rigid transforms.
- Calibration or reliability curves once enough labeled examples exist.
- User-visible behavior for per-date failure, cancellation, sequence change, date change, progress change, and persistence failure.
- Complete operation-level undo, restart persistence, cross-tab destructive-operation safety, verified deletion, and full backup/restore integrity.

### Performance measures

For identical input data, current revision, cache warmth, hardware, and machine load, measure:

- Total alignment duration and per-target duration.
- Decode, geometry, candidate enumeration, coarse scoring, fine scoring, registration, result application, and persistence subphases.
- IndexedDB transactions, Blob reads, WADO registrations, decode count, and cache hit rate.
- Candidate count, shortlist size, FFT count, descriptor count, and allocated scratch bytes.
- Changed-versus-total voxel counts during interactive 3D segmentation and class-metric recomputation.
- ZIP declared/inflated bytes, expansion ratio, available origin quota, and persistence approval.
- Main-thread long-task count/duration and visible interaction/cancellation latency.
- Peak retained heap, total transient allocation, image-cache occupancy, worker count, and worker teardown.
- Initial JavaScript download, parse/evaluation, advanced-feature first-use delay, and offline ZIP size.

The currently established structural facts are **>205 MiB** minimum descriptor allocation for an 81-coarse/15-fine target search, an **8.03 s** mocked 21-candidate integration case, **5.506–12.078 s** for real-image harness workloads containing 41 decodes and 82 two-mode structural/phase passes, up to **7,077,888 full-volume label reads per interactive preview**, a **2.807 MB** main JavaScript chunk, and a **101 MiB** production output. The real-data harness and structural voxel bound are not substitutes for full real-browser end-to-end performance measurements.

## Test strategy and concrete missing cases

Existing tests cover useful mathematical primitives but currently do not establish the product's highest-risk boundaries. Add or extend:

1. **Durable offline origin:** package, import, annotate, stop, restart repeatedly, verify the identical origin/full records, and handle occupied-port conflicts without silent origin hopping.
2. **Patient and study identity:** mixed patients, same-day examinations, missing patient IDs, and mixed-frame SVR inputs.
3. **Complete owned-storage deletion:** overlay dates, tumor-tool/date keys, uploaded model database, debug preferences, unrelated-origin data preservation, and post-delete verification.
4. **Blocked destructive operations:** hold another database connection, request clear, verify no displayed terminal failure while deletion remains pending, and coordinate all tabs.
5. **Backup recovery:** 2D/3D segmentations, ground truth, settings, archive-path collisions, full reset, and restore integrity.
6. **Binary DICOM encodings:** authentic implicit-VR `US` rows/columns, explicit VR, lossless JPEG, malformed numeric tags, and real decoder integration.
7. **Physical ordering:** reversed/nonmonotonic instance numbers, oblique orientation, duplicate positions, uneven spacing, missing geometry, and frame changes.
8. **Sequence classification:** “POST CONTRAST,” “EXTRA,” “CORRELATION,” physically authoritative orientation, and unclassified visible scans.
9. **Enhanced DICOM:** shared/per-frame functional groups and correct `(SOP UID, frame index)` identity.
10. **Atomic ingestion/resource boundaries:** quota exhaustion, persistence denial, decompression bombs, concurrent duplicate import, transaction interruption, and post-commit cache invalidation.
11. **Canonical display geometry:** rectangular contain viewports, mask placement, 2× pan-conversion counterexample, rotation/zoom, annotation reprojection, and old viewport-size migration.
12. **Decoded-image ownership:** cache hit/miss counts, one decode per retained frame, segmentation/window invariance, revision invalidation, and bounded SVR streaming.
13. **Alignment context:** sequence switch, patient switch, date change, filter change, playback movement, stale run completion, and stale lesion autosave.
14. **Depth search:** unequal coverage, true slice outside historical fixed windows, reversed direction, distinct frames of reference, and 2.5D anatomical disambiguation.
15. **Volume sampling:** 3D identity resampling, last face/edge/corner, singleton dimensions, weight conservation, downsample-origin centers, occupancy masks, and thickness-aware ROI cropping.
16. **Registration safety:** field-of-view scale changes, nonconcentric partial-FOV preservation, support-dropping NCC attacks, orientation flips, masked lesions, inverse consistency, ambiguous direction, and non-degrading fallback.
17. **Confidence:** flat anatomy, tied candidates, low overlap, runner-up ambiguity, unsupported geometry, and explicit abstention.
18. **Tumor-model contracts:** equal-count permuted spatial dimensions, unknown winning classes, invalid preprocessing/channel semantics, geometry-bound persistence, and physically calibrated lesion measurements.
19. **Reconstruction lifecycle:** clear during compute, date changes, replacement runs, cancellation, worker startup failure, old-result suppression, and sparse-vs-full preview work.
20. **Real WebGL rendering:** compile/link/draw, valid `transpose=false`, `gl.getError`, identity/rotated volumes, and correctly projected lesion overlays.
21. **Accessible UI:** modal semantics, inert workspace, scoped shortcuts/playback, focus-visible study controls, keyboard/touch loop bounds, live announcements, contrast, reduced motion, and responsive sidebars.
22. **Actual browser integration:** real IndexedDB, real Cornerstone decoding, real Elastix WASM assets, real worker lifecycle, safe representative DICOM fixtures, and offline operation.

## Recommended sequencing and decision gates

The first implementation increment should be **a stable offline storage origin, patient/study isolation, complete and honest backup/delete semantics, safe blocked-tab handling, and a representative measurement harness**. Those changes directly address data loss, residual clinical metadata, and cross-patient correctness before any algorithm tuning.

The next increment should establish the **canonical physical series/frame manifest and one frame-to-viewport coordinate mapping**, because implicit-VR ingestion, patient-space ordering, trustworthy plane classification, frame compatibility, correct exclusions, annotation placement, and displayed registration transforms all depend on those authorities.

After that, prioritize **run/context safety, shared decoded pixels, corrected 3D sampling/rigid support, and fail-closed segmentation contracts**. Only then connect geometry-aware cross-study 3D registration/reslicing and improve through-plane matching, in-plane pose, confidence, and worker performance using the benchmark rather than intuition.

Visual simplification, accessible dialogs, startup code splitting, and distribution slimming can progress alongside the alignment-engine work once they consume the same canonical patient/dataset state. They should not introduce independent state authorities or weaken offline operation.

Do not begin with a learned perceptual model, another uncalibrated scoring channel, deformable registration, speculative caching layers, broad component extraction, or arbitrary line-count targets. Those options are only worth reconsidering if a measured, physically grounded, patient-safe baseline demonstrates a specific remaining failure that they uniquely solve.

## Verification performed for this review

Current-revision checks and observations:

- Git merge-base with `origin/main` equals the current checkout revision; no initial branch-specific diff.
- `npm run build`: **passed**; 1,944 modules transformed, main chunk 2,807.05 kB / 867.59 kB gzip, 47 static items copied.
- Production output size: **101 MiB**, including **74 MiB** ONNX assets and **24 MiB** Elastix pipelines.
- Focused ingestion/storage/geometry tests: **7 files, 23 tests passed in 3.57 s**.
- Second-pass targeted SVR/ONNX/storage/annotation suite: **8 files, 30 existing tests passed in 5.41 s** while the newly demonstrated boundary, class-contract, and viewport defects remained untested.
- Additional existing ROI-crop/alignment-transform/drag-overlay suite: **3 files, 10 tests passed in 3.37 s**; all corresponding tests omit the actual rectangular-viewer, thick-slice, and last-voxel counterexamples.
- Default `npm run check`: **failed again on the refreshed run**, with **281 passing and 11 failing tests**; its first alignment case timed out after approximately **5.234 s** against a 5,000 ms limit, then ten subsequent cases failed on poisoned/null hook state.
- Isolated alignment suite with `--testTimeout=30000`: **11 tests passed in 33.49 s**.
- Full suite with an explicit 30-second integration timeout: **55 files and 292 tests passed**; the refreshed run completed in **15.25 s**, versus **41.51 s** in the earlier same-revision run under different machine load. The first alignment case still took **5.113 s**, exceeding the default 5-second individual-test budget.
- Standalone `npm run lint`: **passed**.
- Production series-description false positives reproduced directly against the current parser.
- Running application inspected at `http://localhost:43124/`; both canonical screenshots contain zero patient/MRI canvases.
- Real loaded-study browser rendering was blocked because the connected Chrome extension could not attach local files without its “Allow access to file URLs” permission; isolated importer/decoder harnesses were used instead.
- Real MRI corpus: **1,405 files, 257.6 MiB, 1 patient, 4 examinations, and 6 complete FLAIR series**, parsed with patient identifiers redacted.
- Real physical metadata: four distinct longitudinal frames of reference, up to approximately **18.1°** axial plane disagreement, one physically reversed coronal stack, and one **50%-overlapping** sagittal stack.
- Actual DICOM importer/local API integration: six real series classified correctly; an incremental import reproduced the stale series-order cache against real DICOM files.
- Actual binary synthetic implicit-VR DICOM object passed through the real parser/importer: valid `64 × 64` pixels were incorrectly skipped as `non-displayable` because a `NaN` text accessor masked the correct binary accessor.
- Production trilinear sampler/splat and full identity volume resampler: final valid voxel returned zero; `3 × 3 × 3` identity resampling retained **8/27** voxels and discarded **19**.
- Production registration scorer: identity NCC `-0.9510` over **12,474** supported samples lost to an NCC `1.0000` candidate retaining only **594** samples (**4.76%**).
- Production partial-field-of-view reconstruction: default coarse initialization shifted valid source geometry from `(0,0,0)` to `(1,1,1) mm` without anatomical evidence.
- Production viewport mapping: reopening a lesion outline across `1000 × 500` → `500 × 1000` viewports produced **125 CSS pixels** of anatomical drift.
- Production ONNX label conversion: a five-class model with undeclared winning class index 4 silently produced background label `0`.
- Production fake-IndexedDB destructive-flow reproduction: blocked deletion was reported as failed but later erased the database after the competing connection closed.
- Safe synthetic **1,157-byte ZIP** contained a **1,033-byte entry expanding to 1,048,576 bytes**, demonstrating the unbounded approximately **1,015:1** import expansion path.
- Offline ephemeral-origin persistence and WebGL invalid transpose are statically demonstrated production-contract violations; packaged restart and loaded 3D rendering were not falsely claimed as browser-reproduced.
- Full real-corpus production ingestion: **1,405/1,405 files imported, zero errors, 9,624 ms total, 45.39 ms comparison aggregation, and 462.1 MiB peak Node RSS** using fake IndexedDB; these are not browser-performance claims.
- Representative real DICOM window metadata ranged from **1.5/3** to **618.5/1,237** across signed 16-bit longitudinal sources, validating a substantial lossy-windowing risk in the existing 8-bit display-capture path.
- Real decoded-MRI scoring: three 41-candidate study-pair comparisons executed the actual MIND/NGF/phase functions in **5.506 s, 12.078 s, and 7.044 s**, including two scoring modes; raw and windowed central candidates selected the same winners, while relative runner-up gaps reached **0.01829**.
- The review-owned browser tab and development server were closed after inspection.
- Independent clinician-annotated landmark ground truth and a loaded-study screenshot were not available; real-data metadata and ingestion are validated, but clinical alignment accuracy remains unmeasured.

This review authorizes no production implementation by itself. Each phase above is an independently reviewable implementation boundary with explicit correctness, safety, performance, and visual acceptance evidence.

## Authorized implementation update — August 24, 2026

The findings and measurements above deliberately preserve the original review baseline. After the
review, implementation was separately authorized. This section records what was actually changed,
what was measured against representative source material, which release gates passed, and which
claims still require independent evidence. None of the measurements below contains patient names,
identifiers, examination dates, UIDs, source filenames, or patient-image pixels.

### Implemented ownership boundaries

1. **Durable application and patient identity.** The offline launcher now binds the fixed origin
   `http://127.0.0.1:43125/`, refuses an occupied port rather than silently changing origin, and
   distinguishes port conflicts from operating-system/network restrictions. Comparison data,
   examination columns, settings, annotations, reconstruction, segmentation, and registered planes
   are scoped to an explicit patient. Missing, conflicting, or reused identifiers do not silently
   merge people; same-day examinations retain distinct identities.
2. **Complete owned storage.** IndexedDB schema version 6 retains studies, series, instances,
   settings, two-dimensional tumor and ground-truth annotations, three-dimensional voxel labels,
   application state, and bounded verified alignment planes. Uploaded models and verified semantic
   manifests remain in their explicitly inventoried model database. Export/restore includes every
   owned record and required binary payload, verifies archive sizes and available hashes, preserves
   older version-2 backups, and rebases restored registration records to the newly committed
   dataset revision. Clear-all removes the complete owned inventory without deleting unrelated
   application storage; blocked cross-tab deletion remains visibly pending until it truly finishes.
3. **Canonical physical frame manifests.** Import accepts genuine implicit- and explicit-VR
   encodings, validates acquisition position/orientation/spacing and frame-of-reference
   consistency, orders frames by patient-space anatomy when trustworthy, records explicit degraded
   instance-number ordering when it is not, rejects unsupported enhanced multiframe objects
   visibly, prevents conflicting identities, bounds hostile ZIP expansion, and invalidates ordering
   only after committed writes.
4. **One decoded-pixel authority.** Interactive rendering, alignment, segmentation, and physical
   stack loading now consume canonical decoded high-bit-depth, modality-scaled source pixels.
   Cornerstone's actual cache-owning loader backs the bounded 256 MiB default image cache;
   sequential and registration working sets remain explicitly bounded. Display windowing,
   presentation contrast, canvas quantization, and viewer screenshots no longer define anatomical
   registration or segmentation samples.
5. **One canonical image-to-viewport mapping.** Lesion exclusions, native-frame annotations,
   translation/pan conversion, segmentation seeds, and physical area measurements agree on source
   image coordinates across contain letterboxing, rectangular viewports, zoom, rotation, pan,
   affine residuals, and independent row/column spacing. Legacy annotations lacking the authored
   viewport required for safe migration are preserved but visibly withheld instead of being drawn
   over potentially unrelated anatomy.
6. **One operation and interaction scope.** Alignment results carry their producing run, patient,
   sequence, dataset revision, reference, target series, and native-source identities. Application
   validates those identities immediately before visible-state and durable-state updates. Each
   target reaches a typed terminal result; one failed date does not stop later dates; one operation
   forms one undo group; persistence failures are visible. Playback, global wheel navigation,
   viewer-local slice scrolling, Command-wheel zoom, and comparison shortcuts cannot mutate the
   reference while a blocking modal or active alignment owns interaction.

### Implemented auto-alignment algorithm

The old pipeline treated a native two-dimensional slice plus affine presentation as sufficient even
when actual acquisition planes differed by approximately 18 degrees. The implemented decision path
now makes physical compatibility, anatomical support, and fail-closed evidence authoritative:

1. Resolve the reference and each target against patient-scoped, physically ordered frame
   manifests. Reject patient mismatch, unreliable position/orientation, incompatible in-stack frame
   identity, degenerate direction vectors, and flipped or inconsistent native frames.
2. Measure the acquisition-plane angle and the largest unavoidable native-plane displacement.
   Shared, geometrically compatible frames remain eligible for the cheaper physical two-dimensional
   path. Distinct frames or material through-plane drift require rigid three-dimensional
   registration; absolute coordinates from unrelated frames are never assumed to be interchangeable.
3. Decode a bounded, evenly distributed coarse stack with at most 48 frames per examination.
   Nonselected reference frames and target frames remain at a maximum in-plane dimension of 96;
   only the selected reference frame retains up to its native 512-pixel resolution.
4. Initialize rigid pose from acquisition orientation and stable anatomical support, then optimize
   a physically bounded six-degree-of-freedom transform against fixed-domain, bidirectional
   supported-anatomy correlation. Preserve same-frame partial-field-of-view geometry instead of
   inventing a field-of-view recentering transform.
5. Apply lesion exclusion in reference image coordinates before any two-dimensional seed
   registration and across the complete native source footprint used by each lower-resolution
   three-dimensional scoring voxel. This prevents interpolation or resampling from leaking a
   changing lesion back into the objective while leaving acquired moving-image pixels untouched.
6. Refuse absent or weak stable-anatomy evidence, insufficient forward/reverse support,
   incompatible geometry, nonpositive structural agreement, and materially different rigid poses
   whose fixed-domain scores are numerically indistinguishable. Numerical distinguishability is
   explicitly **not** represented as clinically calibrated correctness probability.
7. Once a coarse pose is accepted, inverse-map the exact reference-plane corners into target
   patient space, add one acquired-slice interpolation guard, and load every physically consecutive
   native target frame intersecting that plane. A separate bounded worker reslices those dense
   frames directly onto the native reference lattice. If the requested slab exceeds its 96-frame
   safety budget, the operation fails explicitly instead of displaying a sparsely interpolated
   lesion image.
8. Preserve full native output dimensions, accepted rigid pose, rotation center, source/reference
   SOP identities, source/reference frames of reference, reference IPP/IOP/spacing, native slice
   spacing, source-frame count, support coverage, structural score, runner-up margin, patient, and
   dataset revision. Label the result as a derived plane; do not project native-only saved lesion
   polygons over it unless an anatomically valid reprojection exists.
9. Persist at most 12 verified derived planes, validate the live patient/study/series/SOP/physical
   index/frame-of-reference/reference-plane geometry on every hydration, and tolerate legitimate
   cross-realm `Float32Array` values returned by browser IndexedDB structured cloning. Restore
   their exact Float32 binary payloads through complete backups and update the stored revision to
   the newly committed restored dataset.
10. On the same-frame two-dimensional path, choose a physical millimeter-aware search radius when
    trustworthy geometry exists; otherwise cover the complete plausible stack instead of excluding
    depths outside an unjustified fixed index window. Use percentile ranks only to order
    candidates. Acceptance compares **absolute fixed-domain MIND/NGF structural separation**,
    physically distinct depth, supported coverage, nonexcluded reference variance, and a documented
    numerical distinguishability floor. Flat references, excluded-lesion-only signal, tiny raw
    differences inflated into large percentile ranks, and unsupported anatomy produce explicit
    `ambiguous` or `insufficient-overlap` outcomes without overwriting existing settings.
11. Keep candidate pyramids, MIND scratch, phase references, coarse/fine scoring, and final
    affine-proposal comparison inside one run-scoped worker. Transfer bounded inputs, close workers
    on completion, cancellation, startup failure, synchronous transfer failure, or deadline, and
    load the ITK/Elastix runtime only when the two-dimensional refinement path actually needs it.

### Measured real-MRI algorithm behavior

The following measurements use the previously described local MRI corpus through real DICOM
decoding and production registration/reslicing primitives. They are isolated local-harness
measurements, not browser long-task statistics, independent anatomical labels, or clinical error
claims.

| Measurement                                               |                   Observed result |
| --------------------------------------------------------- | --------------------------------: |
| Distinct-frame acquisition-plane disagreement             |                           18.050° |
| Final derived output dimensions                           | 512 × 512 native-reference pixels |
| Valid supported area on the derived plane                 |                           98.789% |
| Accepted bidirectional structural score                   |                           0.68384 |
| Absolute supported-pose runner-up advantage               |                           0.02077 |
| Numerical distinguishability floor                        |                           0.00661 |
| Contiguous acquired frames required after pose acceptance |                                 5 |
| Native through-plane spacing of those frames              |                            1.0 mm |
| Previously transferred native coarse-stack memory         |      53,112,832 bytes / 50.65 MiB |
| Optimized transferred coarse-stack memory                 |        4,550,656 bytes / 4.34 MiB |
| Coarse-stack transfer reduction                           |                            91.43% |
| Dense native target-frame working set                     |               Approximately 5 MiB |
| Additional native JPEG-lossless decodes after cache reuse |                                 4 |
| Representative coarse rigid-registration time             |              Approximately 149 ms |
| Representative dense-frame decode time                    |              Approximately 9.6 ms |
| Representative native-plane reslice time                  |             Approximately 17.3 ms |

The numerical registration result remains unchanged after reducing the coarse working set. The
dense pass reads consecutive 1 mm acquired slices rather than silently interpolating between the
approximately 4–5 mm spacing of a 48-frame whole-stack preview. These measurements show physical
coverage, resource consumption, and reproducibility on this case; they do **not** establish
independently verified landmark or tumor-boundary accuracy.

### Segmentation, annotation, model, and presentation safety

- Two-dimensional segmentation consumes the exact native decoded frame, stores image-normalized
  coordinates, and measures lesion area using independent DICOM row/column spacing in `mm²`.
- Three-dimensional segmentation persists geometry-bound voxel labels, calculates `mm³` from
  calibrated spacing, updates changed regions incrementally, and isolates cancellable region
  growth in a worker.
- ONNX output is rejected for incompatible spatial layout, class count, unknown winning classes,
  or mismatched volume geometry. User-provided models additionally require a JSON sidecar bound
  to the exact ONNX SHA-256 and declaring MR modality, the supported normalization, one `NCZYX`
  input channel, and exact background/core/edema/enhancing class semantics. Existing unknown
  models remain stored but cannot initialize or produce labels until their contract is verified.
- Native-frame saved tumors, ground-truth polygons, and editing tools are suppressed on a derived
  oblique plane; this is safer than displaying an unreprojected native lesion over different
  anatomy. Their stored records remain intact.
- Dialogs provide accessible modal ownership, focus/keyboard handling, inert underlying controls,
  and clear persistence/alignment announcements. Previously hidden study controls expose
  focus/touch affordances; 3D layouts collapse responsively; contrast, reduced-motion preferences,
  and minimum interactive target sizes have explicit regression coverage.
- Debug image shortcuts now use a single reference-counted keyboard scope across mounted viewers
  and ignore text-entry/modal contexts. Disabled debug mode installs no image-debug key listeners.

### Build and distribution impact

| Production measurement             |       Review baseline | Implemented worktree |
| ---------------------------------- | --------------------: | -------------------: |
| Initial main JavaScript bundle     |           2,807.05 kB |          2,575.00 kB |
| Main JavaScript gzip payload       |             867.59 kB |            783.46 kB |
| Complete built application on disk | Approximately 101 MiB | Approximately 54 MiB |
| ONNX runtime assets                |  Approximately 74 MiB | Approximately 24 MiB |
| Copied runtime/static assets       |                    47 |                   29 |
| Complete offline runnable ZIP      |          Not recorded | Approximately 17 MiB |

The ONNX dependency audit removed **52,650,804 bytes**, approximately **50.2 MiB**, while retaining
exactly the three files required by the verified production runtime. A real isolated ONNX
inference using those retained production assets returned the expected identity output. 3D,
annotation tools, and the 109.01 kB raw / 44.39 kB gzip ITK registration entrypoint now load at
actual feature boundaries. The final offline archive contains the fixed-origin launcher, all
alignment/reconstruction workers, the selected ONNX WASM closure, and the required Elastix
pipeline/WASM assets.

### Final implementation verification

- `npm run check`: **passed — 77 test files and 459 tests**, including lint and the complete
  default-timeout regression suite.
- `npm run build`: **passed**, producing the lazy registration chunk, all run-scoped workers, and
  the reduced production runtime closure.
- `npm run package:zip`: **passed**, producing `frontend/release/MiraViewer.zip`; archive contents
  were inspected for the fixed-origin launcher, scoring worker, longitudinal worker, ONNX WASM,
  and Elastix WASM.
- Focused durable-storage, database, and backup suites: **36/36 passed**, including complete
  annotation/voxel/model/manifest/derived-plane recovery, patient isolation, 12-plane retention,
  cross-realm typed arrays, stale revisions, unsafe geometry, cross-series tampering, and older
  complete-backup compatibility.
- Production-path confidence regressions demonstrate that a two-millionths descriptor difference
  can create a 50-percentile ordering lead but is correctly rejected as ambiguous; excluded
  pathology, flat reference anatomy, and low overlap cannot manufacture confidence.
- Actual local-corpus parsing and decoding covered **1,405 source images** without writing patient
  identifiers or image pixels to the report. The production rigid/dense pipeline reproduced the
  18.050° distinct-frame case at full native resolution and supported coverage reported above.
- Packaged-launcher restart/conflict behavior, same-origin worker/WASM serving, required isolation
  headers, and an actual minimal production ONNX inference were separately exercised during the
  implementation run.

### Remaining evidence gaps and next priorities

1. **Independent clinical ground truth remains unavailable.** The supplied MRI corpus does not
   include blinded clinician-authored slice correspondences, reproducible internal landmarks, or
   lesion-boundary annotations. Therefore no patient-disjoint held-out registration accuracy,
   landmark error, clinical sensitivity/specificity, or calibrated correctness probability can be
   stated. Obtain those annotations before tuning thresholds or making clinical-performance claims.
2. **A real-browser compressed-DICOM end-to-end gate remains outstanding.** Real JPEG-lossless MRI
   decoding was exercised through local production-path harnesses, the packaged runtime assets were
   inspected/served, and worker initialization has coverage. This session did not complete a real
   Chrome/offline browser import-to-render run for an approved nonpatient compressed fixture.
   Create a wholly synthetic or independently de-identified lossless-JPEG DICOM and exercise
   actual browser IndexedDB, WADO worker/codec initialization, visible first frame, Align All,
   cancellation, restart hydration, and offline operation without exposing protected source data.
3. **Enhanced multiframe DICOM is explicitly unsupported.** Valid single-frame input is handled;
   enhanced objects fail visibly instead of silently rendering frame zero. Supporting functional
   groups and `(SOP UID, frame index)` ownership requires a separately validated physical-frame
   model and corpus.
4. **The initial viewer bundle still exceeds Vite's 500 kB warning threshold.** The startup payload
   improved substantially and ITK now loads on first use, but Cornerstone and the base viewer
   still yield approximately 2.575 MB raw / 783 kB gzip. Measure real-browser startup and import
   latency before introducing additional chunk boundaries.
5. **A model sidecar proves declared compatibility and byte identity, not trusted authorship.**
   Its SHA-256 prevents accidental/malicious model-sidecar mismatch but is not a signed medical
   certification. If models will come from untrusted suppliers, introduce independently verified
   signing and clinical model validation before granting inference trust.

These remaining items are intentionally identified as external evidence, supported-format, or
future product-policy gates. They are not represented as completed clinical validation.
