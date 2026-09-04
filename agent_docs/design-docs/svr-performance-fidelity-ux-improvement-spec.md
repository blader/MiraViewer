# SVR Reconstruction: Performance, Fidelity, and User Experience Specification

- **Status:** Proposed; implementation is not authorized by this document.
- **Prepared:** 2026-08-24.
- **Reviewed revision:** `219eb32b58a472c10c906ca269349dece678b4b0`.
- **Product:** MiraViewer browser-local, offline-capable MRI reconstruction.
- **Scope:** The complete live SVR workflow, including acquisition admission, reconstruction, 3D presentation, associated segmentation, and recovery.

## Reading guide

- **Why the current feature is unsafe or misleading:** [executed evidence](#3-evidence-revision-and-investigation-limits), [architectural findings](#4-current-architectural-findings), and [product contract](#5-product-contract).
- **What the reconstruction should become:** [architectural ownership](#6-governing-architectural-ownership), [target data flow](#7-target-end-to-end-architecture), [physical observation](#8-physical-observation-model), [registration](#9-source-registration-and-orientation-independence), and [supported reconstruction](#10-reconstruction-objective-and-supported-domain-policy).
- **How fidelity and performance coexist:** [physical bounds](#11-physical-bounds-and-focus-box-geometry), [render fidelity](#12-rendering-fidelity-and-display-provenance), and [unified execution](#13-unified-performance-and-memory-model).
- **What the actual user should experience:** [workspace design](#14-acquisition-aware-workspace-and-interaction-design), [operation lifecycle](#15-operation-ownership-and-run-lifecycle), [accessibility](#16-accessibility-and-interaction-contract), [supported segmentation](#17-supported-segmentation-and-model-inference), and [privacy](#18-observability-privacy-and-operator-diagnostics).
- **How the result will be measured:** [performance budgets](#19-performance-workload-budgets-and-measurement), [independent phantoms](#20-independent-physical-fidelity-validation), [numerical acceptance](#21-quantitative-engineering-acceptance-criteria), and [private MRI evaluation](#22-private-real-mri-evaluation-protocol).
- **How to implement and verify it:** [ordered implementation phases](#23-ordered-implementation-program), [verification architecture](#24-verification-architecture-and-regression-ownership), [alternatives](#25-design-alternatives-and-explicit-tradeoffs), [risks](#26-risks-guardrails-and-unresolved-decisions), and [definition of done](#27-definition-of-done).

## 1. Executive decision

SVR should become a trustworthy **acquisition-aware MRI reconstruction workspace**, not simply a faster volume renderer.

The current implementation already has valuable foundations: patient-space DICOM geometry, area-aware decoding, a transferable compute worker, a PSF-aware iterative solver, bidirectional rigid-scoring primitives, conservative render acceleration, demand-driven WebGL drawing, and bounded segmentation workers. The principal failures occur at the seams between those components.

Most importantly:

1. The actual SVR ingestion path throws away acquired-pixel validity before reconstruction.
2. The resulting volume has no authoritative acquisition-support or source-identity contract.
3. Regularization can create nonzero anatomy where no acquisition exists.
4. A prior patient's volume can remain visible while newly selected patient metadata becomes the authority for persisted annotations.
5. The reconstruction UI hides eligibility failures behind a disabled button and presents advanced controls before there is anything to inspect.
6. The render path can create convincing high-frequency aliasing while concealing the actual display resolution and precision.

The first implementation increment must therefore establish one canonical acquisition identity and one end-to-end evidence-support contract. Only then should the product optimize observation physics, progressive execution, visual fidelity, and interaction.

This specification explicitly permits scientifically justified changes to reconstructed pixels when those changes demonstrably improve acquisition fidelity. The existing performance plan intentionally prohibited algorithmic-output changes; preserving that historical invariant would preserve several defects documented below.

No claim in this document establishes clinical efficacy. Synthetic numerical targets are engineering acceptance thresholds. Clinical claims require independent expert-labeled, patient-disjoint validation.

## 2. Scope and exclusions

### 2.1 In scope

- Selecting one patient, one examination, one sequence family, and its eligible source stacks.
- Reusing canonical DICOM frame manifests, stored-pixel padding semantics, physical geometry, and dataset revisions.
- Source decoding, support-aware resampling, physical stack admission, intensity handling, registration, ROI selection, and forward/backprojection.
- Reconstruction support, confidence, source provenance, grid geometry, and cancellation.
- Worker scheduling, main-thread responsiveness, memory ownership, rendering preparation, GPU presentation, and context recovery.
- The actual `3D` application surface, source previews, linked orthogonal slices, crosshairs, appearance controls, quality disclosure, and accessible interactions.
- Interactive 3D lesion labeling and model inference insofar as they consume, display, measure, or persist reconstructed voxels.
- Deterministic synthetic phantoms, performance benchmarks, browser-integrated tests, real MRI evaluation, and privacy boundaries.

### 2.2 Explicitly out of scope

- Reworking the 2D longitudinal auto-alignment algorithm except when sharing an existing canonical DICOM, support, geometry, or uncertainty primitive.
- A hosted reconstruction service, PHI uploads, cloud processing, external GPU infrastructure, or server-only dependencies.
- Enhanced multiframe DICOM until frame-aware ingestion has its own complete product contract.
- Automatic multi-examination 3D fusion or longitudinal 3D comparison in this increment.
- A bundled diagnostic or lesion-segmentation model without a verified model, documented preprocessing, and appropriate evaluation.
- Promises of clinically validated diagnosis, subvoxel anatomy unsupported by the acquisition, or resolution inferred only from output-array dimensions.
- WebGPU compute, learned reconstruction, full Bayesian inference, and per-slice motion estimation unless later evidence demonstrates that their additional complexity is justified.
- Commits, production edits, PR updates, deployment, or repository cleanup as part of writing this specification.

## 3. Evidence, revision, and investigation limits

### 3.1 Current implementation

The live product path at the reviewed revision is:

```text
ComparisonMatrix: select 3D
  -> Svr3DView: infer examination and sequence; choose source series and ROI
  -> useSvrReconstruction: own run, progress, result, and cancellation
  -> reconstructVolumeMultiPlane: read IndexedDB metadata and decode Cornerstone images
  -> svrCompute.worker: receive source buffers
  -> computeSvrFromLoadedSlices:
       normalize -> choose grid -> optional ROI-rigid registration -> crop -> reconstruct
  -> reconstructionCore:
       PSF-weighted splat -> coarse bootstrap -> robust residual refinement -> smoothing
  -> SvrVolume3DViewer:
       prepare display texture -> raymarch -> inspect slices -> grow or infer labels
  -> localApi: hydrate or persist segmentation under an independently assembled volume identity
```

Primary production boundaries:

- `frontend/src/components/ComparisonMatrix.tsx:898`
- `frontend/src/components/Svr3DView.tsx:410`
- `frontend/src/hooks/useSvrReconstruction.ts:51`
- `frontend/src/utils/svr/reconstructVolume.ts:389`
- `frontend/src/utils/svr/svrCompute.worker.ts:41`
- `frontend/src/utils/svr/svrComputeCore.ts:450`
- `frontend/src/utils/svr/reconstructionCore.ts:190`
- `frontend/src/components/SvrVolume3DViewer.tsx:439`
- `frontend/src/types/svr.ts:112`

The existing documents are useful background but are not current evidence:

- `agent_docs/design-docs/svr-3d-segmentation-spec.md` describes an older branch state, older test counts, and previously live or unwired surfaces.
- `agent_docs/exec-plans/historical/svr-performance-optimization-plan.md` documents valuable completed optimizations but expressly requires unchanged algorithmic results and no product changes.
- The new specification supersedes neither document wholesale; it defines the next SVR-only increment and permits measured fidelity corrections.

### 3.2 Actual-product UX evidence

The real Vite application was inspected at `http://localhost:43124/` on the reviewed revision using only an existing browser-local **synthetic** patient, two synthetic examinations, and ten synthetic DICOM frames.

Canonical source: [actual SVR workspace with synthetic data](../../artifacts/visual-validation/svr-spec-2026-08-24/current-synthetic-workspace.png).

Observed viewport: **3029 × 1483 CSS pixels**, device pixel ratio **2**.

The selected examination contains one axial sequence with five slices. The application displays:

- A disabled `Run SVR` button with no explanation or next action.
- An almost entirely empty black central viewport.
- Source settings, slice inspection, appearance sliders, segmentation controls, model-management controls, and an examination sidebar simultaneously.
- An unlabeled **26 × 26 pixel** generation-panel toggle.
- Four canvases without accessible names or keyboard focus.
- A radial-threshold appearance control before a reconstruction exists.

This validates the actual no-volume/one-plane state. It does **not** establish rendered-volume fidelity, frame pacing, WebGL hardware performance, or behavior with real patient images. No Storybook capture, real patient image, or published PHI is used as visual evidence.

### 3.3 Executed current-code counterexamples

The following measurements execute unmodified production kernels with entirely synthetic in-memory inputs:

| Counterexample                                                                                    | Current observed result                                                                                                   | Required interpretation                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Fuse one acquired voxel of intensity 100 with one zero-filled unsupported padding sample.         | The same production solver returns 100 with the validity mask and 50 when support is dropped: **50% false attenuation**.  | Unsupported padding must never contribute intensity, normalization mass, registration evidence, or reconstruction weight. |
| Crop an acquired `8 × 8` slice and its 64-entry validity mask to a smaller ROI.                   | The crop retains `pixels.length = 16` but leaves `validity.length = 64`.                                                  | Pixel values, acquired support, and physical origin are one indivisible image representation.                             |
| Submit two otherwise valid synthetic source stacks with different frame-of-reference identifiers. | The actual production compute entrypoint accepts both stacks and returns a 27-voxel fused volume.                         | Cross-frame fusion must fail closed unless an explicitly admitted physical transform establishes compatibility.           |
| Reconstruct one genuinely supported voxel with the default `0.02` Laplacian weight.               | One supported voxel produces **six unsupported nonzero neighbors** at `0.0199999996`; the center falls to `0.8799999952`. | Regularization must not cross the boundary of acquired anatomical support.                                                |
| Downsample a `16³` alternating volume to `4³` through the actual render-LOD builder.              | The display variance is `0.2499984975`; correct footprint averaging yields variance `0`.                                  | Point-sampled display LOD can invent visually convincing high-frequency structure.                                        |
| Project a `10 mm × 10 mm` ROI rotated `45°` into patient-space axes.                              | The true enclosing extent is `14.1421356237 mm`; the current `10 mm` box clips each corner by `2.0710678119 mm`.          | All selected physical ROI corners and their through-plane extent must be enclosed.                                        |

All **84 tests across 14 existing focused SVR, decoding, rendering, and segmentation suites** passed despite these counterexamples. Green utility tests therefore do not prove that the complete production observation contract is safe.

### 3.4 Current synthetic performance baseline

Benchmarks run the actual current TypeScript production algorithms bundled in memory on the local Node 22 runtime. Inputs are synthetic, contain no PHI, and do not include browser image decode, Web Worker messaging, GPU upload, GPU execution, or integrated user-interaction latency.

For the reconstruction rows below, complete axial, coronal, and sagittal stacks use Gaussian `3 mm` slice thickness and three through-plane PSF samples:

| Output grid | Source slices | Observations | Initial reconstruction, zero iterations | Reconstruction, three iterations |
| ----------- | ------------: | -----------: | --------------------------------------: | -------------------------------: |
| `48³`       |           144 |      331,776 |                                27.25 ms |                        181.37 ms |
| `64³`       |           192 |      786,432 |                                63.88 ms |                        567.32 ms |
| `96³`       |           288 |    2,654,208 |                               334.28 ms |                      1,355.56 ms |

A `48³` point-PSF initial reconstruction takes **17.68 ms**, compared with **27.25 ms** for the three-sample Gaussian observation model. This isolates a meaningful physical-model cost without implying that the lower-fidelity mode is preferable.

Additional production-kernel measurements:

| Path                           | Synthetic workload                              |                                          Current observed cost |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------: |
| Rigid score, forward direction | 40,000 samples; repeated evaluations            |                                        1.973 ms per evaluation |
| Rigid score, both directions   | 40,000 samples; repeated evaluations            |                                        3.702 ms per evaluation |
| Representative rigid optimizer | 73 bidirectional evaluations                    |                                                      276.64 ms |
| Rigid optimizer object churn   | The same 73-evaluation workload                 | Approximately 17.52 million executed `Vec3` construction sites |
| Half-float preparation         | `192³` reconstructed voxels                     |                                                       13.21 ms |
| Display occupancy preparation  | `192³` reconstructed voxels                     |                                                       10.77 ms |
| Half-float preparation         | `256³` reconstructed voxels                     |                                                       32.83 ms |
| Display occupancy preparation  | `256³` reconstructed voxels                     |                                                       23.62 ms |
| Half-float preparation         | `320³` reconstructed voxels                     |                                                       49.84 ms |
| Display occupancy preparation  | `320³` reconstructed voxels                     |                                                       33.19 ms |
| Display downsample             | `192³ -> 128³`                                  |                          68.93 ms; 32 cooperative timer yields |
| Display downsample             | `256³ -> 192³`                                  |                         158.46 ms; 48 cooperative timer yields |
| Decode/resample                | `512² -> 128²`, validity-aware versus area only |                                       31.72 ms versus 14.31 ms |
| Decode/resample                | `512² -> 256²`, validity-aware versus area only |                                       36.37 ms versus 12.20 ms |
| Decode/resample                | `512² -> 512²`, validity-aware versus area only |                                        21.09 ms versus 6.69 ms |

The rigid scorer was measured over 30 repetitions; decode/resample comparisons used 20 repetitions. Reconstruction and display-preparation values are workload-specific local observations, not population percentiles or end-to-end browser promises. Machine contention, JIT warmth, device GPU, and browser scheduling must be recorded by the eventual reproducible benchmark harness.

At `512²`, the present validity-aware decode path creates approximately **2 MiB** of native temporary arrays per source frame. Preserving support is mandatory; the goal is to eliminate avoidable passes and temporary ownership, not remove validity.

### 3.5 Privacy-safe real-world source cardinality

A deliberately bounded, read-only sample of the user-authorized local MRI source material inspected metadata only. It logged no filenames, paths, patient identifiers, study identifiers, accession numbers, dates, or pixel data.

- First bounded sample: 800 files.
- Recognized DICOM headers: 777.
- Distinct partially observed series: 13.
- Frames measuring 512 × 512 pixels: 769.
- Partial per-series frame counts: 1, 1, 3, 3, 32, 83, 87, 87, 88, 90, 95, 96, and 111.
- End-to-end metadata sampling time: 482 ms on the current machine.

The scan is intentionally incomplete. These counts do not establish examination membership, final series sizes, patient distribution, reconstruction fidelity, or real-MRI runtime.

A representative synthetic planning case of three 90-frame stacks at 512 × 512 therefore has 270 source frames. Native Float32 source intensity alone occupies **270 MiB**. At the observed acquisition pitch of approximately 0.4296875 mm and a selected 1 mm target, voxel-aware downsampling yields roughly 220 × 220 pixels per frame, or approximately **49.85 MiB**. The existing automatic ROI preset forces native 512 × 512 retention, increasing source-intensity residency by approximately **5.42×** before support, worker scratch, rendering, labels, or inference are counted.

These calculations motivate representative benchmark cardinalities; they are not measurements of a particular patient's complete examination.

## 4. Current architectural findings

### F1. Patient and volume identity can disagree

**Severity: patient-safety blocker.**

`Svr3DView` derives `volumeIdentity` from the currently selected patient, study, sequence, frame, and dataset revision at `frontend/src/components/Svr3DView.tsx:535-551`. Its existing reconstruction result comes from a separate hook and is cleared only after the selected date changes at `:607-620`.

`ComparisonMatrix` keeps the same SVR component mounted across patient changes at `frontend/src/components/ComparisonMatrix.tsx:898-904`. If two patients share an examination date and sequence, or the sequence changes without a date change, the previous `result.volume` can remain visible while the newly computed identity is passed beside it at `frontend/src/components/Svr3DView.tsx:1119-1122`.

`SvrVolume3DViewer` then derives its persisted segmentation key from the current identity plus the old volume geometry at `frontend/src/components/SvrVolume3DViewer.tsx:439-450`, hydrates labels at `:453-474`, and writes labels under that identity at `:476-506`.

This is not an appearance issue. The displayed anatomy and durable patient-scoped annotation authority can diverge.

**Decision:** identity must be captured when the run is admitted and embedded immutably in the successful result. Rendering, annotation, inference, and persistence must reject any mismatch synchronously.

### F2. SVR discards acquired-pixel support at its production boundary

**Severity: reconstruction-fidelity and downstream-safety blocker.**

`decodeImageWithValidity` already decodes padding-aware, modality-linear pixels and returns their fractional acquired footprint at `frontend/src/utils/decodedFrame.ts:55-105`.

However, `resampleDecodedImage` immediately returns only `.pixels` at `frontend/src/utils/decodedFrame.ts:108-115`. The actual SVR loader consumes that wrapper at `frontend/src/utils/svr/reconstructVolume.ts:110-122` and creates a `LoadedSlice` without its validity mask at `:136-155`.

Consequences:

- Unsupported padding is included in normalization samples at `frontend/src/utils/svr/reconstructVolume.ts:124-133`.
- The compute core normalizes unsupported pixels as real intensity at `frontend/src/utils/svr/svrComputeCore.ts:468` and `:574-579`.
- Reconstruction and rigid scoring contain useful validity checks, but those checks are unreachable in real SVR because no mask arrives: `frontend/src/utils/svr/reconstructionCore.ts:216-232` and `frontend/src/utils/svr/rigidRegistration.ts:286-289`.
- Fractionally supported downsampled footprints are promoted to fully acquired anatomy.

**Decision:** keep `{ pixels, acquiredSupport, geometry, sourceIdentity }` together from native decode through worker transfer, ROI crop, normalization, registration, reconstruction, rendering, segmentation, and export.

### F3. The ROI path cannot currently preserve support

**Severity: implementation-order blocker.**

`CropSlice` has no validity member at `frontend/src/utils/svr/sliceRoiCrop.ts:6-20`. `cropSliceToRoiInPlace` replaces the pixel buffer and changes its dimensions at `:92-112` without cropping a corresponding mask.

The current worker transfer list includes only `slice.pixels.buffer` at `frontend/src/utils/svr/reconstructVolume.ts:365-377`.

Fixing source decoding alone will therefore break ROI reconstructions or force an unsafe mismatch. Decode, crop, worker protocol, support-weighted math, and output metadata must land as one coherent observation-contract increment.

### F4. The solver fabricates anatomy outside acquired support

**Severity: reconstruction-fidelity blocker.**

`SvrVolume` contains only float intensities, dimensions, spacing, origin, and bounds at `frontend/src/types/svr.ts:112-121`. It has no acquired-support map, contributing-frame provenance, per-direction evidence, or uncertainty.

The solver can emit occupancy if a caller asks for it at `frontend/src/utils/svr/reconstructionCore.ts:195-196`, but the final production paths never request that output at `frontend/src/utils/svr/svrComputeCore.ts:906-958`.

Unsupported initial voxels are assigned numeric zero at `frontend/src/utils/svr/reconstructionCore.ts:139-143`. Subsequent coarse-to-fine interpolation and unmasked Laplacian smoothing treat them as ordinary values at `:146-185`, `:434-441`, and `:455-490`.

The reproduced single-voxel counterexample creates six apparently anatomical neighbors where no observation exists. Ordinary shader occupancy is an intensity-based acceleration structure and is not evidence of acquisition.

**Decision:** acquired support is durable reconstruction truth. Unsupported voxels must remain unsupported through refinement, interpolation, 3D presentation, lesion growth, model input, and volume metrics.

### F5. Physical admission is based on UI labels, not independent acquisition evidence

**Severity: correctness blocker.**

`Svr3DView` decides eligibility from at least two series and at least two distinct plane-label strings at `frontend/src/components/Svr3DView.tsx:434-503` and `:747-748`.

`reconstructVolumeMultiPlane` checks only that two series were requested at `frontend/src/utils/svr/reconstructVolume.ts:389-398`; missing instances are silently skipped at `:83-87`, and the final admission condition requires only one decoded slice at `:502-503`.

`SvrSelectedSeries` omits patient, canonical study, frame-of-reference, and dataset-revision identity at `frontend/src/types/svr.ts:149-158`. Individual frame-of-reference values are copied into slices at `frontend/src/utils/svr/reconstructVolume.ts:154` but never become an admission invariant.

The UI can therefore deny a genuinely usable single-stack inspection without explanation while the low-level path can accept a physically invalid or effectively single-stack fusion.

**Decision:** canonical frame manifests determine patient, study, ordering, acquisition completeness, normal independence, frame compatibility, and whether the result is single-stack inspection, supported multiplane fusion, or a fail-closed rejection.

### F6. Source registration is optional exactly where users expect whole-volume consistency

**Severity: fidelity blocker.**

Default SVR parameters choose `roi-rigid` at `frontend/src/types/svr.ts:91-107`. With no focus box, that mode explicitly does no registration at `frontend/src/utils/svr/svrComputeCore.ts:777-784`.

When an ROI exists, the current path optimizes an identity-seeded NCC objective and accepts a score improvement greater than `0.001` at `frontend/src/utils/svr/svrComputeCore.ts:244-312`.

It does not establish:

- Whether the source frames are already compatible in the same patient coordinate system.
- Whether a distinct frame of reference is quantitatively transformable.
- Whether a competing rigid pose explains the same tissue nearly as well.
- Whether agreement survives independently held-out anatomical blocks.
- Whether the inverse transform is independently consistent.
- Whether the observed improvement comes from removing difficult anatomy from the comparison domain.

The existing safeguard that avoids centering valid partial-field-of-view stacks must remain intact.

### F7. Output bounds and focus boxes do not enclose the physical acquisition

**Severity: fidelity and lesion-loss blocker.**

The focus-box implementation converts an oriented image-space square into a patient-axis-aligned cube of side `max(widthMm, heightMm)` at `frontend/src/components/Svr3DView.tsx:60-105`. That shortcut clips oblique selections.

Global output bounds use center-plane corners and a fixed `1 mm` margin at `frontend/src/utils/svr/svrComputeCore.ts:353-391`. The true observed region also includes each pixel footprint, slice-profile support, orientation, and any accepted registration transform.

The correct shape is the union of transformed physical acquisition footprints intersected with the complete selected ROI extrusion. Missing coverage must remain visible as missing; enlarging a box cannot create evidence.

### F8. The forward model overstates what the data resolves

**Severity: fidelity and labeling risk.**

The present PSF model samples only along the slice normal, caps quadrature at seven samples, uses a fixed Gaussian-width heuristic, and substitutes inter-slice spacing or voxel size when slice thickness is unknown: `frontend/src/utils/svr/reconstructionCore.ts:63-119`.

Inter-slice spacing is a geometric center distance, not an excitation-profile measurement. In-plane acquisition footprints, native-to-analysis downsampling, slice-profile provenance, series-dependent intensity scale, noise, and directional information are not represented explicitly.

An isotropic `1 mm` array does not prove that the acquisition resolves `1 mm` anatomy in all directions. Conversely, valid multiplane observations can improve directional detail if their measurement operators and independence are modeled correctly.

### F9. Render preparation can alias anatomy and hide degraded presentation

**Severity: fidelity and performance risk.**

The render LOD builder downsamples by sampling trilinear volume points at `frontend/src/utils/svr/renderLod.ts:172-266`. It does not integrate the destination voxel footprint, which reproduces the measured near-full-contrast checkerboard artifact.

The settled raymarch shader additionally applies a radial intensity threshold and a center-weighted edge gain at `frontend/src/utils/svr/glRaymarch.ts:325-334`. Identical tissue therefore need not appear equally visible at the center and periphery.

The viewer exposes its achieved render resolution and numeric mode briefly during preparation at `frontend/src/components/SvrVolume3DViewer.tsx:2415-2423`; that information disappears once the volume is ready.

`boxScale` is derived only from voxel counts at `frontend/src/components/SvrVolume3DViewer.tsx:744-756`. Any future anisotropic output grid would therefore be visually distorted even if its millimeter metadata remained correct.

### F10. Memory planning is split across incompatible authorities

**Severity: reliability and responsiveness risk.**

The compute planner bounds only two or three float voxel arrays and explicitly excludes source slices, JavaScript overhead, and GPU textures at `frontend/src/utils/svr/svrComputeCore.ts:688-703`.

The display planner separately considers only GPU volume and label textures at `frontend/src/utils/svr/renderLod.ts:84-105`.

Even the minimal simultaneous display footprint is larger than either planner communicates:

```text
authoritative Float32 reconstruction + Float16 upload staging
  + Float16 GPU texture + one Uint8 label volume
  = 9 bytes per voxel, before acquired support, solver scratch,
    decoded frames, occupancy grids, framebuffers, or model tensors.
```

| Volume dimensions |      Voxels | Minimal listed display footprint |
| ----------------- | ----------: | -------------------------------: |
| `192³`            |   7,077,888 |                        60.75 MiB |
| `256³`            |  16,777,216 |                       144.00 MiB |
| `320³`            |  32,768,000 |                       281.25 MiB |
| `384³`            |  56,623,104 |                       486.00 MiB |
| `512³`            | 134,217,728 |                     1,152.00 MiB |

These are lower bounds, not measured browser peak RSS. A support-aware implementation must explicitly account for every additional mask, staging buffer, scratch array, label, worker-owned frame, and GPU resource.

### F11. A focus box silently changes expensive quality decisions

**Severity: UX, predictability, and memory risk.**

Drawing an ROI modifies target voxel spacing, input downsample limits, maximum volume dimensions, iteration count, step size, and registration mode at `frontend/src/components/Svr3DView.tsx:970-995`.

In particular, the maximum dimension can rise from the default `192` to `320`, and iterations can rise from three to six. The user receives no before/after memory estimate, expected runtime, or confirmation.

An ROI should reduce the selected anatomical region. It must not silently grant a larger memory budget or change scientifically relevant reconstruction parameters.

### F12. The interaction state machine is inconsistent

**Severity: UX and operational correctness risk.**

`useSvrReconstruction` clears the last successful result at run start at `frontend/src/hooks/useSvrReconstruction.ts:61-65`; cancellation and failure also discard it at `:109-116`.

Decode progress reports raw slice counts at `frontend/src/utils/svr/reconstructVolume.ts:157-162` and `:448-460`. Compute then reports values such as `52 / 100` and `55 / 100` at `frontend/src/utils/svr/svrComputeCore.ts:588-589` and `:681-685`. The visible percentage can consequently move backward.

Success retains a non-null `progress` value at `frontend/src/hooks/useSvrReconstruction.ts:95-100`; the UI renders an animated spinner whenever `progress` is truthy at `frontend/src/components/Svr3DView.tsx:1079-1083`.

There is no first-class canceled, identity-invalidated, GPU-fallback, or context-lost state. There is no direct component or hook test for the live SVR workflow.

### F13. Segmentation treats every reconstruction voxel as equally real

**Severity: lesion measurement and persistence risk.**

3D region growth receives intensity and dimensions but no acquired-support mask at `frontend/src/components/SvrVolume3DViewer.tsx:1096-1155`. Model inference likewise receives the volume without a support contract at `frontend/src/hooks/useOnnxTumorSession.ts:318`.

Label metrics count every nonzero label and multiply by voxel volume at `frontend/src/components/SvrVolume3DViewer.tsx:665-693`. They cannot distinguish acquired, interpolated, inferred, or unsupported lesion boundaries.

The `904`-line `frontend/src/utils/segmentation/regionGrow3D_v2.ts` has no direct tests. Existing worker tests verify transport and lifecycle, not lesion fidelity, support holes, anisotropy, or physical measurement correctness.

## 5. Product contract

An SVR result is acceptable only when all of the following statements are simultaneously true:

1. Every source frame belongs to the selected patient, examination, permitted sequence family, and admitted dataset revision.
2. Every displayed or quantified voxel has an explicit relationship to acquired source evidence.
3. Native valid zero and negative intensities are distinguishable from unsupported padding.
4. Registration never replaces patient-space identity with visual similarity, field-of-view centering, or an unverified frame-of-reference assumption.
5. A requested voxel size, reconstructed sampling lattice, measured directional effective resolution, and GPU display resolution remain distinct facts.
6. User-selected anatomy and its complete physical footprint are never silently clipped.
7. Unsupported anatomy cannot become plausible because of smoothing, interpolation, color mapping, segmentation, or a missing-data convention.
8. An acquisition without enough independent evidence is honestly labeled anisotropic, uncertain, ineligible, or unavailable rather than upgraded into "super-resolution."
9. Compute, memory use, quality, cancellation, and fallback are visible before or during execution and correspond to actual work.
10. A previously valid volume remains visible during a same-identity rerun until the replacement is atomically accepted; an identity change instead invalidates it before it can be displayed or persisted.
11. Every user can complete source selection, reconstruction, inspection, and supported annotation with a mouse, touch, or keyboard.
12. All raw MRI pixels, identities, acquisition metadata, models, labels, and traces remain local unless the user explicitly exports a safe artifact.

## 6. Governing architectural ownership

| Durable or operational fact                                                  | Sole canonical owner                                                                                                        | Other components may                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Patient, study, sequence, source SOP identities, and dataset revision        | Existing IndexedDB records interpreted by `getSeriesFrameManifest` and one admitted SVR source contract                     | Carry an immutable snapshot and reject mismatches.                                |
| Native stored-pixel padding and modality-linear intensity                    | Existing `decodeImageWithValidity`                                                                                          | Resample pixels and support together without redefining padding.                  |
| Patient-space row, column, normal, pixel center, spacing, and frame identity | Existing DICOM geometry and frame-manifest primitives                                                                       | Derive grids, ROI projections, and display transforms.                            |
| Accepted source registration                                                 | One evidence-backed per-source physical transform in the admitted reconstruction                                            | Apply or inspect the transform, never independently re-estimate source identity.  |
| Acquired voxel support and effective source contribution                     | The reconstruction result generated by the forward/backprojection pipeline                                                  | Render, segment, summarize, downsample conservatively, and persist a fingerprint. |
| Requested versus admitted compute plan                                       | One bounded execution planner derived from source geometry, selected quality, support representation, and device capability | Render a preview or report estimated and observed costs.                          |
| Run identity, cancellation, phase, and last valid result                     | One reconstruction operation controller                                                                                     | Subscribe to immutable progress and result transitions.                           |
| GPU presentation representation                                              | One derived, replaceable render plan bound to the accepted volume fingerprint                                               | Prepare a support-safe texture and disclose its achieved resolution.              |
| Patient-space inspection cursor and ROI                                      | One SVR workspace interaction model                                                                                         | Project into source slices, orthogonal views, rendering, and annotation tools.    |
| Persisted 3D label ownership                                                 | Existing patient-scoped segmentation storage plus the accepted reconstruction fingerprint                                   | Hydrate or save only matching, acquired-supported label data.                     |

No second image cache, second manifest authority, independent volume identity, shadow progress state machine, or inferred GPU occupancy-as-support model should be introduced.

## 7. Target end-to-end architecture

```text
Selected patient / examination / sequence
  -> canonical physical frame manifests
  -> admitted immutable acquisition identity
  -> bounded execution and memory plan shown to the user
  -> native decode { modality-linear pixels, fractional acquired support, physical frame }
  -> bounded worker-owned source arena
  -> physically justified source registration or explicit abstention
  -> matched support-aware forward and adjoint observation operators
  -> conservative observed-support reconstruction + bounded refinement
  -> atomic result { volume, support, provenance, quality, effective resolution }
  -> anti-aliased support-aware GPU representation
  -> linked 3D viewport + orthogonal inspection + honest quality disclosures
  -> acquired-supported segmentation, uncertainty-aware measurements, safe persistence
```

The architectural goal is not more subsystems. It is one complete chain in which the source identity, observation support, physical geometry, and user-visible outcome retain their meaning.

### 7.1 Canonical acquisition identity

Illustrative shape; actual implementation should extend existing repository-native types rather than introduce duplicate manifest registries:

```ts
type SvrAcquisitionIdentity = {
  patientKey: string;
  studyUid: string;
  sequenceKey: string;
  datasetRevision: number;
  frameOfReferenceUid?: string;
  orderedSeriesUids: readonly string[];
  geometryFingerprint: string;
};

type AdmittedSvrSeries = {
  identity: SvrAcquisitionIdentity;
  manifest: SeriesFrameManifest;
  orderedSopInstanceUids: readonly string[];
  measuredNormal: readonly [number, number, number];
  inPlaneSpacingMm: readonly [number, number];
  sliceSpacingMm?: number;
  sliceThicknessMm?: number;
  sliceProfileSource: "dicom-thickness" | "verified-profile" | "unknown";
  acceptedTargetToReference?: PhysicalRigidTransform;
};
```

Admission rules:

- All source manifests must exist and belong to the same canonical patient and study.
- Source frame ordering must be physically verified, finite, strictly increasing where required, and stable for the captured dataset revision.
- DICOM row and column directions must form a valid orthonormal basis with positive finite pixel spacing.
- Duplicate, missing, stale, cross-series, or replaced SOP identities reject the run.
- Matching frame-of-reference identifiers may use the existing patient-space geometry directly.
- Distinct identifiers require an explicitly accepted, evidence-backed patient-space rigid transform.
- Unknown or incompatible reference frames never fall back to numerical-origin coincidence or bounding-box centers.
- "Multiplane" is derived from measured independent normals, not display-label strings.
- A stack with incomplete or missing source frames cannot silently count as a complete admitted orientation.
- A single valid source stack may support an explicitly labeled anisotropic inspection mode; it must never be described as true multiplane SVR.

### 7.2 Complete source observation

Illustrative existing-type extension:

```ts
type SvrSourceObservation = {
  pixels: Float32Array;
  acquiredSupport: Float32Array;
  rows: number;
  columns: number;
  sourceSopInstanceUid: string;
  sourceSeriesUid: string;
  frameOfReferenceUid?: string;
  pixelCenterOriginMm: readonly [number, number, number];
  rowDirection: readonly [number, number, number];
  columnDirection: readonly [number, number, number];
  normalDirection: readonly [number, number, number];
  rowSpacingMm: number;
  columnSpacingMm: number;
  sliceThicknessMm?: number;
  profileEvidence: "measured" | "dicom-declared" | "unknown";
};
```

Invariants:

- `pixels.length === acquiredSupport.length === rows * columns`.
- Each support value is finite and in `[0, 1]`.
- `support === 0` means no acquired anatomy, regardless of the pixel value.
- `support > 0` means acquired footprint mass exists; a fractional value remains fractional until the consuming operation justifies a stricter threshold.
- Finite intensity `0` and negative modality-linear values remain valid whenever support is positive.
- Downsampling aggregates supported intensity as `sum(weight * intensity) / sum(weight)` and separately reports `sum(acquiredWeight) / sum(fullFootprintWeight)`.
- ROI crop applies the exact same spatial selection to pixels and support and shifts the pixel-center origin once.
- Structured cloning and transferable-buffer lists include each owned pixel and support buffer exactly once.
- Worker cancellation cannot leave detached source buffers attached to an accepted result or retry a partially transferred payload inline.

### 7.3 Truthful reconstruction result

Illustrative product-level extension:

```ts
type SvrReconstructionEvidence = {
  acquisition: SvrAcquisitionIdentity;
  contributingSourceSopInstanceUids: readonly string[];
  perSeriesTransforms: readonly AcceptedSeriesTransform[];
  observedSupport: Uint8Array;
  supportWeight?: Uint8Array;
  directionalEvidence?: Uint8Array;
  unsupportedVoxelCount: number;
  supportedVoxelCount: number;
  achievedVoxelSpacingMm: readonly [number, number, number];
  effectiveResolutionMm?: readonly [number, number, number];
  effectiveResolutionCalibrated: boolean;
  registrationSummary: SvrRegistrationQuality;
  reconstructionSummary: SvrReconstructionQuality;
  confidenceCalibration: "engineering-only" | "clinically-validated";
};

type VerifiedSvrResult = {
  identity: SvrAcquisitionIdentity;
  volume: SvrVolume;
  evidence: SvrReconstructionEvidence;
  resultFingerprint: string;
};
```

Representation choices must be justified by measured resource cost:

- A binary support bitset costs `N / 8` bytes but requires unpacking or a specialized GPU path.
- A `Uint8Array` support map costs `N` bytes and is convenient for worker transfer and an `R8` GPU support texture.
- Quantized contribution confidence or orientation coverage adds another `N` bytes per retained channel.
- A full `Float32Array` confidence map costs `4N` bytes and is inappropriate unless a demonstrated operation requires its precision.
- GPU intensity occupancy remains an optional acceleration structure derived from the actual display representation and never replaces acquisition support.

The result fingerprint must incorporate the accepted acquisition identity, ordered source SOP identities, accepted transforms, output geometry, and support identity. Viewer context is never allowed to substitute a new identity beside an old result.

## 8. Physical observation model

For source series `s`, frame `f`, and acquired pixel `p`:

```text
y[s,f,p] = gain[s] * A[s,f,p](T[s] · V) + bias[s] + noise[s,f,p]

A[s,f,p](V) = integral over the pixel footprint and slice profile:

  h_inplane[s,f,p](u, v)
    * h_through[s,f](w)
    * V(patientPosition[s,f,p](u, v, w))
```

Where:

- `V` is the unknown patient-space volume on its admitted output grid.
- `T[s]` is the accepted rigid source-to-reference transform, or identity where verified geometry is sufficient.
- `h_inplane` represents native readout/pixel footprint plus any explicitly admitted source downsample footprint.
- `h_through` represents a measured or transparently inferred slice-excitation profile.
- `gain` and `bias` are optional nuisance parameters, not arbitrary image-level histogram equalization.
- Observations are weighted by acquired footprint support, estimated noise, and robust residual evidence.

### 8.1 Slice profile requirements

1. Prefer scanner-declared slice thickness or an explicitly verified profile.
2. Record whether a profile was measured, declared, assumed, or unknown.
3. Never represent inter-slice center spacing as a measured excitation width.
4. Treat gaps between thick slices as potentially unsupported space.
5. Include profile support in physical output bounds and ROI admission.
6. Choose bounded quadrature spacing from the actual voxel size and profile width.
7. Demonstrate numerical-profile integration error on independent high-resolution phantoms.
8. Increase quadrature cost only when the fidelity gain survives the fixed performance and memory budgets.

Initial engineering target:

```text
quadrature spacing <= min(achieved voxel spacing / 2, profile FWHM / 4)

bounded sample count = the smallest tested count meeting
independent profile-integration error <= 1%.
```

The current seven-sample cap may remain where the measured error target is satisfied. It must not be a global claim of physical adequacy.

### 8.2 Matched forward and backprojection

The production forward operator `A` and adjoint `Aᵀ` must share:

- The exact patient-space pixel-center convention.
- The same full or fractional acquired-footprint mask.
- The same accepted source transform.
- The same in-plane and through-plane PSF samples.
- The same clipped physical support at output-grid boundaries.
- The same ROI and conservative acquisition domain.

An independently generated adjoint identity is a mandatory regression:

```text
abs(dot(A(x), y) - dot(x, adjointA(y)))
  / max(1, abs(dot(A(x), y)), abs(dot(x, adjointA(y)))) <= 1e-5.
```

This is an engineering invariant. Passing it does not by itself establish that the chosen scanner-profile model is clinically correct.

### 8.3 Acquisition-aware intensity model

- Padding is evaluated in the stored-pixel domain before slope/intercept.
- Valid modality-linear zero and negative values survive every source step.
- Percentiles, normalization statistics, and cross-series comparisons ignore unsupported samples.
- Intensity summaries report sample counts and retained support rather than relying on visual black-background heuristics.
- Global percentile clipping must not silently remove a small supported lesion from the acquisition evidence used for registration or measurement.
- Any per-series gain, offset, bias field, or histogram correction must be estimated only from matched supported stable anatomy and must improve an independently held-out reprojection objective.
- Original source intensity, normalized solver intensity, display window/level, and model preprocessing remain explicitly distinct.

## 9. Source registration and orientation independence

### 9.1 Admission before optimization

Classify the actual source relationship before deciding to register:

```text
same patient + same study + same verified frame + consistent DICOM geometry
  -> identity is admissible; no correction required

same patient + same study + distinct frame + sufficient independent overlap
  -> bounded evidence-backed rigid registration is eligible

different patient / study / revision / missing frame / insufficient overlap
  -> reject before expensive reconstruction
```

Compatibility is a property of frame manifests and measured patient coordinates, not source radio labels or date strings.

### 9.2 Orientation information

For each source family:

1. Derive the measured normal from the DICOM orientation basis.
2. Collapse parallel or nearly parallel normals into the same effective acquisition family.
3. Compute angular separation and physical overlap between distinct families.
4. Track actual acquired support after decode and crop, not the number of requested series.
5. Distinguish useful independent orientations from duplicate acquisitions or repeated labels.

Proposed initial interpretation:

- One independent direction: valid anisotropic stack inspection; no true multiplane reconstruction claim.
- Two independent directions: supported partial directional improvement; report the weak axis.
- Three materially independent directions: eligible for isotropic-detail evaluation, contingent on measured support and conditioning.

Exact angle and directional-conditioning thresholds must be selected against the independent synthetic benchmark before being treated as fixed gates.

### 9.3 Reliable rigid evidence

An accepted nonidentity source transform should expose:

- Forward and reverse retained anatomical support.
- Absolute and relative similarity on a fixed candidate-independent support domain.
- Appropriate structure-sensitive metrics for the relevant contrasts.
- Independently optimized, physically distinct rival hypotheses.
- Held-out spatial blocks that were not used to optimize the winner.
- Independent inverse consistency in millimeters.
- Effective independent anatomical samples, not raw interpolated-pixel counts.
- Translation and rotation in physical patient units.
- The source-frame relationship and whether the transform is identity, optimized, or unavailable.

Reject a visually attractive transform when support shrinks, the held-out rival is indistinguishable, the inverse disagrees, anatomy is flat/repetitive, or frame compatibility cannot be established.

Existing structure-first longitudinal registration and confidence primitives should be reused where the contracts match. They must not become a second manifest owner or force every compatible SVR series through an unnecessary whole-brain alignment.

### 9.4 Performance-sensitive scorer

The current rigid scorer constructs temporary vectors inside the per-sample inner loop at `frontend/src/utils/svr/rigidRegistration.ts:373-389`. A representative 73-evaluation, 40,000-sample bidirectional workload executes approximately **17.52 million vector-construction sites**.

The target scoring kernel should:

- Precompute rigid matrices and translation terms once per candidate.
- Transform sample coordinates with scalar arithmetic or reusable fixed-size storage.
- Keep the sampled source domain and support identity immutable across competitors.
- Preserve complete bidirectional coverage checks and physical coordinate precision.
- Accumulate statistics directly without per-sample object allocation.
- Run in the existing compute worker and remain cooperatively cancellable.

Any speed improvement must be measured against the same sample positions, masks, transforms, and accepted outcome.

## 10. Reconstruction objective and supported-domain policy

The recommended practical browser objective is:

```text
minimize over V, and only over evidence-supported T/gain/bias where applicable:

  sum over source observations:

    acquiredSupport
      * inverseNoiseVariance
      * robustLoss((A(T · V) - observedIntensity) / noiseScale)

  + regularizationWeight * supportRestrictedEdgePreservingPrior(V).
```

### 10.1 Supported-domain semantics

- An acquired-supported voxel is one whose physical footprint receives nonzero, verified contribution from admitted observations.
- A voxel with no supported contribution is explicitly unsupported; its float storage value has no anatomical meaning.
- Fractional support is not equivalent to full acquired certainty.
- Directional support describes which independent acquisition families contribute, not simply the number of nearby nonzero intensities.
- Gaps between slabs remain gaps unless a separately disclosed inference policy is intentionally selected.
- Negative or zero observed tissue remains supported when its acquisition support is positive.
- Label generation and lesion volume metrics cannot cross unsupported voxels.

### 10.2 Edge-preserving, support-restricted refinement

Replace unrestricted global smoothing with the smallest support-aware scheme that passes the phantom and lesion-boundary gates:

1. Establish conservative observed support during initial backprojection.
2. Carry that support through coarse initialization and fine-grid resampling.
3. Initialize unsupported voxels to a storage-safe value without granting them support.
4. Apply regularization only within connected acquired-supported neighborhoods.
5. Prevent smoothing or interpolation across unsupported gaps and distinct disconnected anatomy.
6. Prefer a bounded Huber-TV or edge-aware anisotropic diffusion only if it improves held-out reprojection and preserves small lesion boundaries.
7. Estimate robust residual scales from supported per-series or per-slice residuals rather than relying only on a fixed global `0.1` threshold.
8. Stop refinement based on measured improvement, accepted cost, and noise evidence rather than blindly maximizing iteration count.

TV-like regularization can introduce staircasing or lesion shrinkage. It is not automatically preferable to the existing solver. Its adoption depends on independent edge, support, held-out reprojection, and lesion-volume measurements.

### 10.3 Directional effective resolution

Use source geometry and support to estimate a physically interpretable directional information model:

```text
I(x) = sum over sources:

  localAcquiredWeight[source, x]
    * R[source]
    * diag(
        1 / inPlaneRowResolution[source]^2,
        1 / inPlaneColumnResolution[source]^2,
        1 / throughPlaneEffectiveResolution[source]^2
      )
    * transpose(R[source]).
```

The information model is an engineering diagnostic, not a clinical-confidence claim. It should support:

- Identifying the least observed direction.
- Explaining why near-parallel source stacks do not create isotropic anatomical detail.
- Distinguishing achieved voxel spacing from effective supported resolution.
- Warning when a focus box contains too few independent source families.
- Choosing an output lattice that does not imply precision unsupported by the data.

Any user-visible "isotropic" fidelity claim requires independent slanted-edge or modulation-transfer measurements in all relevant supported directions.

## 11. Physical bounds and focus-box geometry

### 11.1 Full acquisition bounds

For each admitted frame:

1. Compute all four native pixel-footprint corners, including half-pixel physical extent.
2. Extrude them by the physically admitted slice-profile support along the true slice normal.
3. Apply the accepted source-to-reference transform.
4. Include only physically supported source regions; unsupported padding does not expand observed anatomy.
5. Union those polyhedra into conservative patient-space reconstruction bounds.
6. Derive voxel-center origin and lattice dimensions with the same convention used by source decoding and projection.

Fixed `1 mm` padding is not a substitute for actual voxel footprint or slice thickness.

### 11.2 Focus-box contract

The focus-box interaction remains simple, but its geometry must be exact:

- The selected image-space corners are transformed through the actual anisotropic DICOM row/column basis.
- The desired physical through-plane extent is explicit.
- An oriented ROI may remain oriented internally, or the complete oriented prism may be conservatively enclosed by a patient-axis-aligned box.
- Every selected corner and its admitted through-plane extrusion is inside the reconstructed ROI.
- ROI cropping retains the pixel/support pair and updates the source origin once.
- The preview displays the box dimensions in millimeters and estimates source slices, output voxels, and cost before running.
- Drawing, resizing, or clearing a focus box never silently changes quality, iteration count, voxel spacing, maximum dimensions, or registration behavior.

If a higher-detail ROI preset is valuable, offer it as an explicit choice with the original and proposed memory/time/resolution estimates.

## 12. Rendering fidelity and display provenance

### 12.1 Separate reconstruction from display

The reconstruction volume and its acquired support are the authoritative anatomical representation. Display textures are bounded, replaceable derivatives.

The viewer must separately disclose:

```text
Acquisition: 0.8 × 0.8 × 4.0 mm; 3 supported orientation families
Reconstruction lattice: 1.0 × 1.0 × 1.0 mm
Estimated effective detail: 1.1 × 1.2 × 1.8 mm; engineering estimate
GPU display: 256 × 224 × 192; float16
Unsupported reconstruction voxels: 12.4%; excluded from measurements
```

Actual values must come from the accepted result and current render plan. They must remain visible after the volume is ready.

### 12.2 Anti-aliased display LOD

When display dimensions are lower than reconstruction dimensions:

1. Integrate the complete destination voxel footprint or use a demonstrably equivalent low-pass mipmap/prefilter.
2. Accumulate values only from acquired-supported source voxels.
3. Produce a conservative display support channel separately from the color/intensity channel.
4. Keep true zero intensity distinguishable from missing support.
5. Avoid nearest-neighbor label disappearance when a supported small lesion spans a reduced display voxel; retain an explicitly documented conservative label-presence policy.
6. Preserve exact source values for equal-dimension uploads where no prefilter is necessary.
7. Keep acquisition occupancy separate from shader acceleration occupancy.

The reproduced checkerboard case must change from variance `0.2499984975` to no more than `1e-4` after correct downsampling.

### 12.3 Anatomy-neutral default appearance

The initial diagnostic-style appearance should:

- Apply the same transfer function to equivalent supported tissue regardless of its radial position.
- Use explicit window/level and opacity controls with understandable units and reset behavior.
- Preserve orientation and physical proportions.
- Make unsupported voxels transparent, hatched, or explicitly classified as unavailable rather than ordinary black tissue.
- Separate optional aesthetic edge emphasis from acquisition evidence.
- Make center-prior artifact suppression a clearly labeled optional mode if retained.

The existing center-amplified radial threshold must not be the unqualified default for inspecting lesion presence or comparing peripheral anatomy.

### 12.4 GPU reliability

- Check the result of every texture upload and format fallback.
- Surface an actionable error instead of leaving a silently black canvas.
- Handle `webglcontextlost` and `webglcontextrestored` explicitly.
- Rebuild only derived GPU resources after context restoration; preserve the accepted volume and labels.
- Distinguish unsupported WebGL2, exhausted texture budget, unavailable filtering, and context loss.
- Keep an accessible orthogonal-slice fallback available when volume rendering is unavailable.
- Preserve render-on-demand and zero idle GPU work.
- Measure real GPU adapter and renderer provenance before making hardware-dependent performance claims.

## 13. Unified performance and memory model

### 13.1 User-visible operations to measure

1. Select a patient, examination, and sequence.
2. Receive an immediate source-readiness and cost estimate.
3. Start a reconstruction without freezing the interface.
4. Decode and validate the admitted source frames.
5. Register only incompatible-but-admissible source stacks.
6. Produce the first truthful coarse supported preview.
7. Refine to the accepted final result.
8. Prepare and upload a bounded display representation.
9. Orbit, zoom, inspect, adjust appearance, and modify a supported lesion label.
10. Cancel, replace, clear, change examination, and recover from resource failure.

Internal solver throughput is useful only when it improves one or more of these operations without weakening the support or identity contract.

### 13.2 Unified peak-memory accounting

At minimum, the planner must account for:

```text
source native decoder/cache residency
+ admitted downsampled source intensity
+ admitted source support masks
+ transfer ownership or temporary structured-clone costs
+ reconstruction float volume
+ observation/contribution weight
+ refinement update and other simultaneous scratch
+ authoritative binary or quantized output support
+ optional directional-evidence channels
+ retained previous same-identity result, when permitted
+ preview/display downsample staging
+ float16 or u8 texture staging
+ actual GPU volume/support/label/occupancy textures
+ GPU framebuffers and conservative WebGL overhead
+ segmentation working labels and worker state
+ optional verified-model input/output tensors
+ explicit safety margin.
```

Rules:

- Every term has a single owner and a known lifetime.
- The same transferred buffer must not be counted twice after ownership transfers, but overlapping lifetimes must never be hidden.
- The accepted previous volume may be retained only when the planner can prove that the rerun and previous result fit simultaneously.
- When retention cannot fit, explain the tradeoff before discarding the previous result.
- Support representation, display precision, output dimensions, and iteration count are included before allocation.
- Device-derived budget policy should remain conservative when browser memory telemetry is unavailable.
- A GPU-only `256 MiB` budget cannot be presented as a total browser-memory bound.
- ONNX and reconstruction workloads must not independently consume the entire process budget at the same time.

### 13.3 Execution architecture

Recommended minimal design:

1. Validate source manifests and compute an estimate before bulk pixel allocation.
2. Decode physical frames through the existing canonical Cornerstone/image owner.
3. Produce pixels and acquired support in one tightly bounded source pass.
4. Send frames or bounded batches to the existing dedicated reconstruction worker.
5. Apply explicit backpressure so the main thread cannot enqueue an unbounded number of decoded buffers.
6. Transfer each intensity and support buffer exactly once.
7. Preserve only the worker-owned frame arena required by iterative projection.
8. Emit truthful coarse previews only when their support mask and run identity are complete.
9. Transfer final volume and support buffers back without copying.
10. Prepare CPU-heavy display downsampling, float16 conversion, and occupancy in the same worker or a bounded derived-data worker when measurement justifies it.
11. Reserve the browser main thread for input, React updates, and unavoidable WebGL upload calls.

The target is a bounded source arena, not a second persistent decoded-image cache.

### 13.4 Hot-loop priorities

Prioritize root causes demonstrated by the existing measurements:

1. Eliminate per-sample rigid-score vector allocations while preserving support-aware scoring.
2. Fuse source padding classification, supported resampling, intensity sampling, and acquisition-mask construction where equivalent.
3. Avoid building full-resolution temporary masks more than once per source frame.
4. Crop source intensity and support together before subsequent high-cost projection when physical admission permits.
5. Reuse immutable source operators and precomputed coordinate coefficients across solver iterations.
6. Bound through-plane quadrature by measured approximation error rather than a universally fixed count.
7. Move half-float conversion, support-safe volume prefiltering, and occupancy generation off the main thread when possible.
8. Use incremental updates for label metrics and subvolume uploads while preserving exact counts.
9. Emit progress at phase boundaries and bounded intervals rather than from individual pixels.
10. Retain existing zero-idle rendering, transferable buffers, safe cancellation, and conservative empty-space skipping.

Do not introduce a broad cache, a speculative shared-memory protocol, GPU compute, or aggressive approximation unless an actual workload identifies that mechanism as the bottleneck.

### 13.5 Progressive presentation

The product may show a coarse preview before final refinement only if:

- It belongs to the same immutable admitted source identity.
- Its observed-support mask is already valid.
- It is visibly labeled `Preview — reconstruction in progress`.
- Unsupported regions remain unavailable.
- Annotation and quantitative measurement remain disabled until the final accepted result.
- Refinement replaces the preview atomically without cross-patient or cross-run leakage.
- Coarse preview creation does not significantly delay the final result on small volumes.

Target: where sufficient source data has already been validated and decoded, display a truthful bounded coarse preview within **1 second** of the worker becoming reconstruction-ready on the frozen reference workload. This is not a promise that every real MRI study finishes decoding within one second.

## 14. Acquisition-aware workspace and interaction design

### 14.1 Product metaphor and aesthetic direction

The intended experience is an **MRI reconstruction lightbox**: a restrained, precise instrument in which anatomy occupies the visual center, source evidence remains intelligible, and every visible control has an immediate relationship to the current operation.

The existing MiraViewer visual language is an asset. Preserve its near-black canvas, charcoal structural surfaces, restrained indigo or electric-blue active selection, small-radius controls, precise hairline separators, and clear grayscale anatomy. Use cyan sparingly for the shared physical inspection cursor. Reserve amber for genuinely incomplete acquisition support, weak registration evidence, or a materially degraded presentation. Red indicates a rejected or failed operation, not routine interaction.

Measured baseline contrast is already adequate for the primary palette: approximately **16.4:1** for primary text, **7.58:1** for secondary text, **6.65:1** for tertiary text, and **5.17:1** for white text against the existing accent. The observed failure is not insufficient saturation or a missing gradient. It is the combination of an empty central surface, four simultaneous control regions, unnecessary 9–10 px utility text, and unexplained disabled actions.

Design rules:

- Anatomy, source readiness, and the next meaningful action form the primary visual hierarchy.
- Keep the canonical dark canvas near `#0a0a0f` and structural panels near `#12121a`; preserve actual repository tokens rather than introduce competing theme constants.
- Do not use glossy gradients, oversized cards, fake depth, generic dashboard tiles, or decorative scan-line treatments.
- Keep body and control labels at least **12 CSS px**; use 13–14 px for frequently consulted values and 15–16 px for the examination heading.
- Express physical quantities in millimeters, acquired slice counts, achieved voxel spacing, or supported-voxel percentage; avoid ornamental percentages that are not calibrated.
- Keep advanced appearance, model, and labeling controls unavailable until their prerequisite result exists.
- Maintain stable panel geometry when phases change; preserve the user's visual relationship with the volume.
- If nothing can be reconstructed, explain the exact blocking fact in the central viewport instead of displaying a black void.

The product should feel closer to a carefully designed radiology workstation than to a configurable machine-learning demo.

### 14.2 Desktop information architecture

At desktop widths, the workspace has four purposeful areas:

1. A compact examination header establishes the immutable patient/examination/sequence context and displays source readiness and admitted quality.
2. A left source rail, approximately **280 px** wide, owns source stack selection, physical orientation evidence, focus-box editing, quality choice, estimates, and the primary run or cancel action.
3. A dominant central 3D lightbox owns the volume, orientation glyph, physical crosshair, window/level readout, support disclosure, and operation feedback.
4. A bottom linked-filmstrip or optional right-side context drawer owns orthogonal inspection, appearance, quantitative inspection, and supported annotations.

Illustrative populated state:

```text
┌ Patient A · Examination 2026-05-14 · T2 ── 3 orientations · 270 slices ─ Balanced ▾ ┐
│┌ Sources ────────────────┐ ┌ 3D lightbox ───────────────────────────────────────────┐│
││ Axial       90  ✓ 0.43  │ │                                                    S   ││
││ Coronal     88  ✓ 0.46  │ │                    reconstructed                       ││
││ Sagittal    92  ✓ 0.43  │ │                      anatomy                           ││
││                         │ │                  ────────┼────────                  R  ││
││ Focus box    Full volume│ │                         │                               ││
││ Output      0.75 mm     │ │                         │                               ││
││ Acquired    0.43 × 3 mm │ │                 supported anatomy                       ││
││ Supported          94%  │ │                                                          ││
││ Peak estimate    438 MB │ │ 0.75 mm voxels · 94% acquired support · display: native ││
││ [Reconstruct volume]    │ └──────────────────────────────────────────────────────────┘│
│└─────────────────────────┘ ┌ Axial ─────────┐ ┌ Coronal ────────┐ ┌ Sagittal ──────┐│
│                            │    ──┼──       │ │     ──┼──      │ │    ──┼──      ││
│                            └────────────────┘ └─────────────────┘ └────────────────┘│
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The quantities above illustrate placement, not a promise that any specific examination has those values. Displayed values must come from the actual admitted result and memory plan.

### 14.3 Source readiness and explicit examination ownership

Replace incidental date inference and label-based eligibility with a compact readiness summary derived from the canonical frame manifests:

- Selected examination, sequence family, and dataset revision.
- Admitted source count and physically distinct acquisition-orientation count.
- Source series row spacing, column spacing, slice thickness, center spacing, number of acquired frames, and source coverage where available.
- Frame-of-reference compatibility or the exact reason a source was rejected.
- Missing, duplicated, stale, unsupported, or contradictory source frames.
- Whether the available data supports anisotropic stack inspection, two-orientation reconstruction, or three-orientation fidelity evaluation.

Unknown or missing sequence labels should be represented as an explicit **Unclassified** source family when the underlying patient/examination/geometry identity is otherwise valid. A display-label omission must not make real acquisitions disappear.

The main comparison date sidebar may remain the application's navigation owner. Within SVR, however, the examination being reconstructed must be explicit, visually stable, and derived from the same identity that owns the result. A neighboring selected date must not imply that a finished volume belongs to another examination.

### 14.4 Actionable no-volume and one-stack states

The actual inspected one-plane state must become a clear physical explanation:

```text
                    This examination has one acquired orientation

       Axial · 5 acquired slices · 0.43 × 0.43 mm in-plane · 4.0 mm thick

    A second independent acquisition orientation is required for multiplane
    reconstruction. A single stack can still be inspected honestly.

                   [Inspect axial stack]  [Choose another examination]

           No unsupported between-slice detail will be fabricated.
```

Required empty and blocked states:

| State                                     | User-visible explanation                                                         | Permitted next action                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| No patient or examination selected        | Identify that no source examination is available.                                | Select an imported examination.                                         |
| No displayable source frames              | Explain the absence of acquired, decodable image data.                           | Select a different sequence or review import status.                    |
| One physically valid orientation          | Explain that multiplane reconstruction is unavailable; show acquired anisotropy. | Inspect the acquired stack or choose another examination.               |
| Multiple labels, one physical orientation | Explain that the stacks are effectively parallel.                                | Inspect the best stack or select a genuinely independent source.        |
| Missing or contradictory source geometry  | Identify the affected source without inventing orientation.                      | Exclude that stack or select a compatible examination.                  |
| Distinct unverified reference frames      | Explain that the acquisitions cannot be safely placed together.                  | Request a supported evidence-backed registration or exclude the source. |
| Output exceeds the admitted memory budget | Show source, solver, display, and inference costs separately.                    | Reduce output quality, shrink the focus box, or defer inference.        |
| WebGL context unavailable or lost         | Preserve the accepted patient-specific result and explain the display failure.   | Retry the renderer or continue in linked orthogonal inspection.         |
| Reconstruction was canceled               | Preserve the prior valid same-identity result where budget permits.              | Resume with the same verified source identity or change settings.       |

Disabled actions must have visible explanatory text, not only a hover tooltip. Error messages must not contain patient identifiers, SOP identifiers, or raw exception objects in general-purpose logs.

### 14.5 Running, preview, and completed states

The running state keeps the source rail and established context visible:

```text
            Reconstructing supported anatomy · 48%

              Registering coronal acquisition to reference
              180 / 270 acquired frames validated
              Peak estimate: 438 MB · output: 0.75 mm

                [Cancel reconstruction]
```

If a same-identity volume already exists, retain it with a restrained **Previous result — updating** indicator while the new run proceeds, subject to the admitted peak-memory plan. A coarse preview may replace the central lightbox only when its source identity and observed-support mask satisfy section 13.5.

Completion reveals inspection and annotation controls progressively:

1. Display the accepted volume and linked orthogonal slices.
2. Show achieved output voxel spacing, directional evidence, supported fraction, and actual display resolution.
3. Make neutral appearance controls available without changing scientific acquisition evidence.
4. Enable supported-voxel inspection and lesion labeling.
5. Show model inference only when a real, verified compatible model is present.

A successful operation cannot retain a stale loading spinner, misleading percentage, or nonterminal cancellation state.

### 14.6 Linked physical inspection

There is exactly one patient-space inspection cursor:

- The cursor is represented in **millimeters** in the accepted volume's patient coordinate system.
- The 3D ray hit, axial/coronal/sagittal cross-sections, source previews, selected lesion voxel, and focus-box interactions project the same physical position.
- Source previews preserve physical pixel aspect ratio rather than assuming that image rows and columns correspond to equal millimeters.
- Each view displays appropriate **L/R**, **A/P**, and **S/I** orientation labels derived from the accepted DICOM geometry.
- Physical rulers and position readouts reflect true achieved voxel spacing and output transforms.
- Inspecting an unsupported coordinate produces an explicit **No acquired support** state instead of a plausible intensity or clickable lesion seed.
- Inspection views can reveal the acquired-support mask and orientation coverage as a diagnostic overlay.
- Slice location changes do not silently alter the selected source examination or reconstruction identity.

The existing fixed-size inspector, approximately 256 px, should become a resizable or layout-driven surface when the viewport permits. High-DPI and anisotropic source data should be presented without forced nearest-neighbor pixelation except where the user intentionally requests raw-pixel inspection.

### 14.7 Focus-box and quality controls

A focus box is a physical selection, not a hidden quality preset.

Before the user runs an ROI reconstruction, show:

- The selected center and extents in millimeters.
- The admitted output dimensions and voxel spacing.
- The source slice count intersecting the expanded physical ROI.
- The exact registration-search and PSF margins.
- Estimated source, worker, display, and optional model peak memory.
- Expected supported fraction where it can be estimated from acquisition geometry.
- Any requested quality difference from the preceding full-volume run.

If a higher-detail quality preset is desirable, offer it explicitly:

```text
Focus box selected: 34 × 28 × 31 mm

Keep current quality:       1.0 mm ·  52 MB estimated
Use higher supported detail: 0.5 mm · 188 MB estimated

                              [Keep current] [Use higher detail]
```

These values are examples. The actual product must compute and disclose the real estimate. Changing the ROI must never silently change maximum input resolution, iteration count, solver step size, maximum output grid, registration mode, or target voxel spacing.

Numeric focus-box controls provide an accessible alternative to drag handles. A drag interaction cannot lose the linked inspector because its parent panel was collapsed; portal ownership must be independent of transient generation-panel visibility.

### 14.8 Responsive behavior

| Available workspace width | Required staging                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At least 1440 px          | Left source rail, dominant lightbox, linked filmstrip, and optional contextual appearance or annotation drawer may coexist.                             |
| 1024–1439 px              | Maintain one persistent source rail and the central lightbox; use tabs or a single drawer for inspection and annotation.                                |
| 768–1023 px               | Collapse the source rail into a labeled drawer; retain a full-width central lightbox and an expandable linked-slice strip.                              |
| Below 768 px              | Use a bottom sheet or full-screen contextual drawer; keep examination identity, current slice, and primary action visible without horizontal scrolling. |

At every width:

- The primary reconstructed viewport must retain at least **320 px** of usable width when the page itself is at least that wide.
- **200% browser zoom** must not make the primary action, source rejection reason, cancel action, or support disclosure unreachable.
- Tooltips, overlays, drawers, and focus-box handles must stay inside the usable viewport.
- Sidebars must not obscure the patient/examination identity, the accepted result, or error recovery controls.
- The application must never require an unadvertised hover interaction to reach a safety-critical explanation.

## 15. Operation ownership and run lifecycle

### 15.1 Immutable operation identity

Every run captures a single admitted context before decoding begins:

```text
operation =
  monotonic run identifier
  + canonical patient identifier
  + canonical examination/study identifier
  + sequence family
  + dataset revision
  + ordered admitted source identities
  + verified frame-of-reference relationship
  + admitted quality/ROI/memory plan
```

The accepted result embeds the same context and a reconstruction fingerprint. A viewer may render the result only when its identity matches the current workspace identity **synchronously in the same render pass**.

Changing patient, examination, sequence, admitted frame identity, or dataset revision must:

1. Invalidate all in-flight runs before their messages are applied.
2. Prevent a prior context's anatomy from appearing under the new patient's header, even for one frame.
3. Disable annotation hydration and persistence until a verified matching result exists.
4. Dispose of stale previews, support masks, labels, inference results, and prior GPU resources safely.
5. Preserve compatible prior state only if its complete immutable identity still matches.

An ordinary passive effect that clears an old result after React has already painted is insufficient. Use a synchronous identity predicate or an identity-keyed component boundary; keep whichever mechanism most simply satisfies the no-wrong-patient-frame invariant.

### 15.2 State transitions

```text
no-source
  -> source-ineligible
  -> ready
  -> validating
  -> decoding
  -> registering
  -> coarse-reconstruction
  -> refinement
  -> presentation-preparation
  -> ready-with-result

Every nonterminal running state:
  -> canceling -> canceled
  -> failed
  -> stale, when the admitted context changes

ready-with-result:
  -> rerunning, while retaining the previous same-identity result if budget permits
  -> stale, when its admitted context no longer matches
```

Only the operation controller owns these transitions. React components, the worker, the renderer, and the model hook may report events; none may independently promote a stale run to success.

Required transition invariants:

- At most one admitted compute run owns an operation identity.
- A newer run supersedes every earlier progress, preview, result, and error message.
- Cancellation does not become failure unless terminating the worker itself fails.
- A successful result is published atomically with its support map and identity.
- Success clears progress immediately and enables only features justified by the actual result.
- Failure cannot wipe a still-valid previous result unless the user accepted a memory plan that required releasing it.
- Reopening SVR cannot hydrate labels from a different geometry, source fingerprint, or patient.
- Browser tab backgrounding and worker teardown do not create a ghost operation that later writes stale labels.

### 15.3 Monotonic, work-weighted progress

Initial proposed phase allocation:

| Phase                                      | Progress interval | Actual accounting basis                                                             |
| ------------------------------------------ | ----------------: | ----------------------------------------------------------------------------------- |
| Admission and plan validation              |              0–5% | Completed source manifests and budget checks.                                       |
| Decode and source support                  |             5–35% | Acquired frames or weighted source pixels completed.                                |
| Registration and source checks             |            35–55% | Admitted source pairs, candidate batches, and verification blocks.                  |
| Initial supported reconstruction           |            55–70% | Completed backprojection work.                                                      |
| Refinement and evidence generation         |            70–90% | Actual admitted iteration/sample work.                                              |
| Display preparation and atomic publication |           90–100% | Completed support-safe LOD, texture preparation, and accepted presentation handoff. |

Phase boundaries are an initial honest weighting, not a universal estimate. Adapt them only from measured operation history for comparable local workload shapes.

The currently observed behavior, in which source decoding approaches 99% and later compute reports roughly 55%, is prohibited. Progress must be monotonically nondecreasing for one operation, update at human-meaningful intervals, and identify its active physical phase.

Time remaining may be shown only when enough comparable local phase history exists. Otherwise report the active phase and completed frame/iteration counts without inventing an ETA. Never use an animated timer to imply scientific precision.

### 15.4 Cancellation and recovery

Requirements:

- A run or cancellation interaction acknowledges the input within **100 ms** on the supported reference browser when the main thread is otherwise responsive.
- The user-visible canceling state appears within **200 ms**.
- Cooperative or worker-termination cancellation reaches a terminal state within **1 second** for the frozen supported workloads.
- Native decode cancellation is checked between bounded frame batches; source queues stop accepting new work immediately.
- Worker-owned buffers and stale display preparation are released without writing a canceled result.
- WebGL context loss preserves a still-valid CPU-side accepted result when the current memory plan permits.
- Restoring a context rebuilds derived render resources from the accepted identity and canonical support; it does not rerun reconstruction automatically.
- Recoverable errors explain whether the source, memory plan, registration, reconstruction worker, renderer, or model failed.
- A retry always revalidates the canonical dataset revision and source manifests.

## 16. Accessibility and interaction contract

### 16.1 Semantics and focus

Every SVR action must have a programmatically determinable accessible name and role:

- Generation, focus-box, source-selection, registration, view-mode, appearance, and segmentation buttons expose clear labels.
- Collapsible panels report expanded/collapsed state.
- The central 3D canvas and each orthogonal inspection surface expose an accessible label, instructions, focus state, and relevant result identity.
- Progress uses a real progressbar with minimum, maximum, current value, and active phase.
- Recoverable status messages use a polite live region; blocking reconstruction or identity errors use an appropriate alert.
- Keyboard focus remains visible against the dark canvas and is not hidden by overlays or WebGL content.
- Opening and closing a drawer restores focus to the invoking control.
- Every disabled safety-critical action has a linked textual explanation that is accessible without pointer hover.

### 16.2 Target sizes and typography

- Pointer-oriented desktop targets: at least **36 × 36 CSS px**.
- Touch-oriented or coarse-pointer targets: at least **44 × 44 CSS px**.
- Adjacent destructive and nondestructive controls have sufficient separation.
- Frequently used controls must not depend on 9–10 px labels or hit areas like the currently measured 26 × 26 px panel toggle.
- Utility text is at least **12 px**; critical physical measurements and status messages are legible at 200% browser zoom.
- Contrast remains at or above applicable text and focus-indicator standards; the existing dark palette should not be altered merely to satisfy a mistaken contrast diagnosis.

### 16.3 Keyboard, pointer, and touch model

Proposed discoverable workspace shortcuts:

| Input                      | Operation                                                                        | Context constraint                                                           |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Arrow keys                 | Orbit the focused 3D viewport or move the active orthogonal slice.               | Only when an SVR viewport has keyboard focus.                                |
| Plus/minus                 | Zoom the focused viewport.                                                       | Never intercept text or numeric entry.                                       |
| 0                          | Reset the active camera.                                                         | Only when the 3D viewport has focus.                                         |
| 1, 2, 3                    | Select axial, coronal, or sagittal inspection.                                   | Only within the SVR workspace.                                               |
| Left/right brackets        | Move one acquired or reconstructed slice.                                        | Respect actual physical slice spacing and support.                           |
| Shift plus directional key | Move the focus-box center or resize through an explicit selected handle.         | Only when the accessible ROI editor is active.                               |
| Escape                     | Cancel the current drag, dismiss the active drawer, or request run cancellation. | Choose the nearest active interaction; never silently discard accepted work. |
| Question mark              | Show the actual SVR shortcut and interaction guide.                              | Exclude focused editable text.                                               |

Pointer orbit, scroll zoom, pinch zoom, and ROI drag must not conflict with source-list scroll or page scroll. Reduced-motion preferences disable nonessential camera tweening and progress animation without removing operational feedback.

### 16.4 Accessible alternatives to visual-only interactions

Provide:

- Numeric patient-space coordinates and focus-box dimensions.
- Explicit buttons for standard axial, coronal, and sagittal orientation.
- Source selection without relying on color alone.
- Textual acquired-support and directional-evidence summaries.
- A listed lesion-label summary with keyboard-reachable editing and deletion.
- Readable error explanations for unsupported seed placement, cross-frame rejection, or invalid source geometry.
- Equivalent access to one-stack inspection even when the 3D canvas cannot initialize.

## 17. Supported segmentation and model inference

### 17.1 Label admission

A reconstructed volume may expose segmentation tools only when:

1. Its immutable result identity matches the selected patient, examination, source identities, and dataset revision.
2. Its acquired-support map is present and complete.
3. The requested seed maps to a finite, physically supported voxel.
4. The label operation's source result fingerprint matches the currently displayed volume.
5. The active worker and persisted annotation key belong to the same accepted result.

Region growing, morphological cleanup, connected-component operations, contour rendering, and manual label painting must never admit an unsupported voxel. A valid tissue value of zero or a negative modality-linear source intensity is not equivalent to missing support.

An unsupported seed produces an explicit explanation rather than an empty or misleading lesion measurement.

### 17.2 Truthful quantitative measurements

For every visible or persisted label, record:

- Accepted source-result fingerprint.
- Patient-space voxel spacing and physical transform.
- Count of physically supported labeled voxels.
- Supported lesion volume in cubic millimeters and milliliters.
- Boundary adjacency to unsupported voxels or incomplete acquisition coverage.
- Any calibration status associated with quantitative uncertainty.

When a lesion touches an unsupported boundary, label the extent **incomplete acquisition coverage** rather than treating the measured supported subset as a confidently complete lesion volume. A segmentation overlay may indicate the unsupported boundary without drawing fictitious tissue beyond it.

Confidence intervals or diagnostic interpretation must not be shown until their calibration is established on an independent appropriate evaluation set.

### 17.3 Safe persistence and hydration

Persisted labels remain local and patient scoped:

- Hydration requires an exact match on patient, examination, accepted source geometry, dataset revision, and reconstruction fingerprint.
- A geometry-compatible volume from a different source stack or revised acquisition is not automatically the same annotation target.
- A prior patient, stale operation, canceled run, or detached GPU context cannot write through a newly selected identity.
- Saving is idempotent for the same label revision and rejects stale operation ownership.
- Undo and redo operate only within the active accepted result.
- Clearing a patient's data uses the existing canonical local storage boundary; SVR must not introduce a parallel authoritative persistence store.

### 17.4 Model-management visibility

The actual inspected no-volume screen currently exposes ONNX setup before any reconstruction can exist. The target is:

- Hide model installation and inference from the no-source, ineligible, decoding, registration, preview, and unsupported-volume states.
- Reveal inference only after a final supported result and a genuinely available verified model exist.
- Explain the model's expected input geometry, intensity convention, channel order, dimensionality, and output-label meaning before execution.
- Admit model tensors through the same unified peak-memory plan used for reconstruction and display.
- Reject any proposed inference that would exceed the accepted process budget.
- Use sliding-window inference only after proving that the model accepts dynamic shapes and that tiled overlap, padding, and merge behavior match a known full-volume reference.
- Mask unsupported voxels before presenting labels and exclude them from all quantitative volumes.
- Make no clinical or diagnostic accuracy claim without a specifically validated model and independently reviewed evidence.

## 18. Observability, privacy, and operator diagnostics

### 18.1 Local-only operational metrics

The SVR observability channel is local, bounded, and privacy preserving. Suggested event fields:

```text
operation category
ephemeral run identifier scoped to the browser session
source orientation count
source frame count and pixel cardinality
input and output dimensions
source and achieved spacing buckets
selected quality and focus-box size bucket
admitted peak-memory estimate by ownership phase
actual elapsed admission / decode / registration / solve / display times
per-iteration held-out residual summaries
supported fraction and directional-coverage summary
registration acceptance or rejection category
render precision and display-resolution ratio
cancel / failure / context-loss category
optional browser-reported graphics adapter class when explicitly inspected locally
```

Do not include patient names, dates of birth, examination dates, institution names, accession numbers, DICOM UIDs, filenames, source paths, patient pixels, source thumbnails, segmentation masks, or reconstructable free-text scanner metadata.

No network request, external analytics provider, remote error reporting, or persisted cross-patient correlation is introduced by this design. Existing explicit alignment-debug configuration should not become an excuse to emit SVR patient identifiers into ordinary logs.

### 18.2 Debugging surface

A user-requested local diagnostic panel may expose:

- The admitted source orientations and frame counts.
- Rejected-source reasons without identifiers beyond local row positions.
- Source and output physical spacing.
- Estimated versus measured phase durations.
- Planned versus observed support and memory representation.
- Rendered precision, GPU maximum texture dimension, and actual display grid.
- Registration residual, retained overlap, inverse consistency, and refusal category.
- Worker lifetime, cancellation state, and renderer context status.

The panel should reuse current debug conventions and remain hidden in normal inspection. It must not become a second operation state machine or an always-running performance monitor.

## 19. Performance workload, budgets, and measurement

### 19.1 Freeze representative benchmark scenarios

The existing focused test phantoms are predominantly at or below approximately 35³ voxels. Those fixtures are valuable for numerical regressions but do not expose source residency, GPU preparation, or browser responsiveness at representative MRI scale.

Define fixed, deterministic, PHI-free source fixtures:

| Scenario                       | Independent source orientations |                       Source frame cardinality | Native source size | Proposed output                                  | Purpose                                                                           |
| ------------------------------ | ------------------------------: | ---------------------------------------------: | ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| S: small interactive           |                               2 |                                         2 × 24 | 256 × 256          | Up to 128³                                       | Fast feedback, correctness, and cancellation.                                     |
| M: common multiplane           |                               3 |                                         3 × 48 | 512 × 512          | Up to 192³                                       | Default-quality browser reconstruction.                                           |
| L: observed-cardinality stress |                               3 |                                         3 × 90 | 512 × 512          | Up to 256³ where admitted                        | Representative source residency and sustained decoding.                           |
| F: focused detail              |                               3 | 3 × 64, with only intersecting slices retained | 512 × 512          | Up to 192³ inside an explicit physical focus box | Early source rejection, physical crop, registration margins, and ROI quality.     |
| A: acquisition adversity       |                             2–3 |                       Deterministically varied | 256–512 px         | 96³–192³                                         | Partial FOV, obliquity, slice gaps, invalid padding, bias, and controlled motion. |
| I: optional inference          |                               3 |                              Scenario M source | 512 × 512          | 192³                                             | Peak reconstruction plus verified-model tensor budgeting.                         |

These are proposed benchmark fixtures, not measured claims about a particular patient's complete examination. Scenario L is motivated by the privacy-safe observed partial-series cardinalities; there is no assertion that the sampled series all belong to one patient or study.

For each scenario, freeze:

- Frame geometry, profile, deterministic noise seed, acquired support, and exact source byte cardinality.
- Output spacing and dimensions, ROI, registration mode, admitted source downsampling, PSF samples, solver iterations, and support representation.
- Browser, OS, CPU, available memory, GPU adapter, browser graphics backend, display resolution, and device pixel ratio.
- Offline ZIP mode versus dev-server mode and cross-origin isolation availability.
- Cold versus warmed IndexedDB, Cornerstone decode, Web Worker, shader compilation, and texture allocation.
- Concurrent machine workload and power/thermal state when they materially alter results.

Compare the same accepted output contract. A faster run that drops source masks, rejects hard slices, changes the output grid, or silently lowers the solver iteration count is not a valid performance improvement.

### 19.2 Benchmark protocol

Use three measurement layers:

1. Deterministic production-kernel benchmarks for operator, score, normalization, mask, resampling, and display-preparation costs.
2. Integrated real-browser runs through the actual SVR application route with synthetic IndexedDB datasets.
3. Opt-in private local execution on protected MRI data after acquisition identity and support safety are in place.

For each integrated run, record:

```text
user click -> input acknowledged
           -> source admission complete
           -> first acquired frame decoded
           -> all required source buffers admitted
           -> registration accepted or rejected
           -> first supported preview, if one is justified
           -> final supported solve complete
           -> display representation prepared
           -> first final rendered frame
```

Also record phase-specific memory estimates, actual observable resident-array sizes, browser long tasks, worker transfer counts, canceled-operation cleanup, source support, and final volume/label correctness.

Run at least **20 comparable repetitions** for interactive latency and registration microbenchmarks before reporting a median. Report p95 only when sample cardinality and the sampling method make the percentile meaningful; collect at least **100 representative render frames** before drawing frame-tail conclusions. Isolate cold-start trials from warmed trials.

The Node 22 numbers in section 3 are reproducible engineering baselines for current production algorithms, not representative GPU timing. Do not promote them to end-to-end promises.

### 19.3 Main-thread responsiveness

Mandatory targets on the declared reference browser and frozen scenarios:

| Operation                                  | Required result                                                                | Evidence                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Start or cancel input acknowledgement      | At most 100 ms while the main thread is otherwise responsive.                  | Real-browser event timestamp and application acknowledgment.       |
| Visible canceling state                    | At most 200 ms from the cancel request.                                        | Real-browser user event and observed state transition.             |
| Terminal worker cancellation               | At most 1,000 ms on supported frozen workloads.                                | Run-scoped worker termination and no further result messages.      |
| Main-thread CPU chunks attributable to SVR | No continuous task longer than 50 ms on admitted scenarios.                    | Browser PerformanceObserver long-task trace or equivalent profile. |
| Accepted prior result during recompute     | No black flash or cross-context anatomy.                                       | Actual-app state transition and validated screenshot sequence.     |
| First eligible coarse preview              | At most 1,000 ms after source data is validated, decoded, and worker-ready.    | Worker phase timestamps and first support-safe paint.              |
| Idle volume rendering                      | Zero continuous animation frames after interaction and presentation settle.    | Real browser requestAnimationFrame or renderer invalidation trace. |
| Interaction rendering, p95                 | At most 33 ms per frame under the declared GPU scenario.                       | At least 100 headed hardware-backed interaction frames.            |
| Interaction rendering, p99                 | At most 50 ms per frame under the same declared GPU scenario.                  | Sufficient headed hardware-backed frame samples.                   |
| Final-quality settle after interaction     | Within 250 ms unless the hardware-aware plan discloses a slower admitted mode. | Input-end timestamp and first accepted final-quality frame.        |

The interaction frame targets are **reference-hardware goals**, not universal claims for every browser, GPU, output size, or device. Unsupported hardware must fail safely or select a disclosed lower-cost display plan.

### 19.4 Registration and solver optimization gates

Freeze the existing 40,000-sample bidirectional source-scoring workload and validate identical sampled support, candidate transforms, and final acceptance:

- Current repeated scorer baseline: approximately **3.702 ms per evaluation**.
- Initial same-machine target after removing per-sample object churn: **2.8 ms or less**, subject to equivalent numerical results.
- Current representative 73-evaluation optimizer observation: approximately **276.64 ms**.
- Initial same-workload optimizer target: **210 ms or less**, without reducing hypothesis coverage, overlap checks, or inverse verification.

An allocation-site count is not a proven heap allocation count. Capture an actual allocation or garbage-collection profile before claiming a particular heap reduction.

Additional current production observations:

- A synthetic 64³, zero-iteration, three-stack compute run was approximately **32.76 ms** without registration versus **232.57 ms** with the current ROI-rigid path.
- The comparable four-stack cases were approximately **41.74 ms** and **243.21 ms**.
- A synthetic full 64³, three-iteration solve was approximately **467.11 ms** for one resolution and **556.87 ms** for the current coarse-plus-fine schedule.

These are single warmed-process observations with possible JIT and ordering effects, not stable distributions.

The current ROI-rigid design builds leave-one-out reference and moving volumes for each nonreference series. Investigate a shared supported registration pyramid or reusable additive splat statistics only when leave-one-out independence, physical coverage, acquired support, and per-series transform semantics remain equivalent. The current multiresolution schedule must either improve independently held-out reconstruction quality at its added cost or adaptively skip work that provides no measurable benefit.

### 19.5 Unified phase-peak memory table

The following are exact array-size arithmetic examples, not independently measured browser process residency:

| Cubic output | Float32 accepted volume | Three concurrent Float32 solver arrays | Float16 presentation volume | Byte-per-voxel label/support channel | Four Float32 ONNX-logit channels |
| ------------ | ----------------------: | -------------------------------------: | --------------------------: | -----------------------------------: | -------------------------------: |
| 192³         |                  27 MiB |                                 81 MiB |                    13.5 MiB |                             6.75 MiB |                          108 MiB |
| 256³         |                  64 MiB |                                192 MiB |                      32 MiB |                               16 MiB |                          256 MiB |
| 320³         |                 125 MiB |                                375 MiB |                    62.5 MiB |                            31.25 MiB |                          500 MiB |
| 384³         |                 216 MiB |                                648 MiB |                     108 MiB |                               54 MiB |                          864 MiB |

The solver column already includes three arrays and must not be added to the separate accepted-volume column when that volume is one of the same live arrays. Conversely, source data, worker-transfer overlap, a retained prior result, GPU textures, label channels, model tensors, and browser runtime overhead must be added when their lifetimes genuinely overlap.

For the observed-cardinality 270-frame scenario:

- Native 512² Float32 source intensity: **270 MiB**.
- Approximate 220² target-aware source intensity: **49.85 MiB**.
- Source support adds its chosen representation cost; a native byte-per-pixel mask adds approximately **67.5 MiB**, while Float32 fractional support adds another **270 MiB**.
- Moving from a 192³ to 320³ three-array solver raises scratch from **81 MiB** to **375 MiB**, approximately **4.63×**.
- Combining that change with native-source retention can exhaust a process budget before any visible renderer or model begins.

The current approximate **512 MiB** reconstruction preflight excludes several real ownership categories. Replace it with a single phase-aware plan instead of adding independently optimistic per-subsystem limits.

### 19.6 Decode, crop, and transfer execution

The production loader currently reads and decodes frames serially even though Cornerstone is configured for multiple decode workers. It also reaches an IndexedDB instance through the SVR loader and again through the Cornerstone custom image loader.

Required target behavior:

1. Admit ordered physical manifests before bulk decoding.
2. Skip source slices whose complete profile support cannot intersect the expanded physical focus box.
3. Include margins for the PSF, interpolation footprint, accepted rigid displacement, and registration evidence domain.
4. Use bounded decode concurrency, initially **2–4** frames only when the unified memory estimate supports it.
5. Preserve deterministic physical ordering and cancellation despite concurrent completion.
6. Reuse the existing canonical Cornerstone decode and IndexedDB ownership paths rather than introduce another image cache.
7. Crop source pixels and support together before long-lived worker retention whenever the physical contract permits.
8. Apply worker backpressure so decoded frames do not accumulate without bound.
9. Transfer each owned intensity and support buffer without structured-clone duplication.
10. Verify that moving a crop earlier does not remove tissue required for registration, PSF support, or accepted motion.

No purported decode speedup may bypass DICOM padding classification, modality slope/intercept, physical frame metadata, or the existing supported image loader.

### 19.7 Render workload and honest GPU evidence

The raymarch structural upper bound for a 1000 × 700 CSS viewport at the current approximate 1.5 device-pixel-ratio cap and 256 settled steps is approximately **403.2 million potential ray positions per frame**. An interaction mode at half resolution and 96 steps has approximately **37.8 million**, roughly **10.67×** fewer potential positions.

These are structural upper bounds before early exit or empty-space skipping. They are **not measured shader operations, measured GPU milliseconds, or a promise that every ray sample executes the same texture lookups**.

Where available:

- Measure GPU elapsed time with a WebGL2 disjoint-timer-query extension.
- Record the actual graphics adapter, renderer, display pixel ratio, volume precision, output viewport, step count, and support/label configuration.
- Reject SwiftShader or another software renderer as evidence for hardware interaction pacing.
- Keep conservative acquired-support and intensity-occupancy skipping independent.
- Adapt interaction resolution or step count only within the declared physical-display fidelity budget.
- Maintain zero-idle rendering and bounded high-quality settle.

Label creation must not force recompilation or reupload of an unchanged immutable volume merely because label existence changes. Separate volume texture ownership from label texture ownership unless dimensions or actual shader semantics require rebuilding both.

## 20. Independent physical-fidelity validation

### 20.1 Ground-truth generation must be independent

Build analytic or high-resolution synthetic reference anatomy without using the production projector, voxelizer, resampler, registration scorer, ROI cropper, or renderer as the ground-truth generator.

Reference physical sampling resolution should initially be **0.1 mm or finer** in the relevant region, with convergence checked against a still finer reference when validating thin structures. Generate source DICOM-like frames by independently integrating their true pixel footprints, slice profiles, patient-space transforms, and noise models.

Each reference fixture owns:

- Physical coordinate bounds and independent analytic patient-space geometry.
- Source orientation, pixel-center positions, row/column directions, spacing, slice thickness, center-to-center distance, and slice profile.
- Stored-pixel padding and modality slope/intercept.
- True support in source pixels and reconstructed patient space.
- Ground-truth structure intensity and boundary location.
- Known rigid transforms, source gains, noise, and outlier regions where relevant.
- A held-out set of acquired frames or independent orientations not used in fitting.

Never reuse the production forward operator to create its own perfect acceptance oracle.

### 20.2 Phantom families

Required independent families:

1. Constant and linear-ramp volumes to verify normalized reconstruction and coordinate conventions.
2. Ellipsoids or a 3D Shepp–Logan-like phantom for broad anatomical intensity and registration structure.
3. Slanted edges, line-pair targets, and zone plates for edge position, MTF, resolution, and render aliasing.
4. Cylinders, shells, thin connected branches, and parallel structures for topology and partial-volume effects.
5. Spherical or irregular lesion analogues at approximately **1, 2, 5, 10, and 20 mm**.
6. Signed background and valid zero-valued tissue combined with explicit stored-pixel padding.
7. Partial-field-of-view stacks and disconnected supported regions.
8. Known 3D rigidly displaced and rotated source acquisitions.
9. Spatially varying bias, intensity gain/offset, and realistic outlier or motion contamination.
10. Checkerboard and impulse inputs dedicated to support-preserving display antialiasing.

### 20.3 Acquisition stress dimensions

Stratify combinations rather than construct an unbounded Cartesian test product:

| Dimension                                  | Initial engineering coverage                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| In-plane acquired spacing                  | 0.3–1.2 mm.                                                                                                        |
| Slice thickness                            | 1–8 mm.                                                                                                            |
| Slice-center spacing                       | 1–10 mm, independently varied from thickness.                                                                      |
| Number of independent orientation families | 1, 2, and 3, including near-parallel mislabeled stacks.                                                            |
| Oblique frame orientation                  | Approximately 5°, 15°, 30°, and 45°.                                                                               |
| Controlled rigid translation               | Approximately 0.25–5 mm.                                                                                           |
| Controlled rigid rotation                  | Approximately 0.1°–5°.                                                                                             |
| Partial field of view                      | Approximately 25–75% shared anatomical coverage.                                                                   |
| Missing slab or acquisition gap            | Approximately 3–25 mm.                                                                                             |
| Signal-to-noise ratio                      | Approximately 10, 20, and 40 under the chosen validated noise model.                                               |
| Source intensity gain                      | Approximately 0.5–2.0.                                                                                             |
| Source bias field                          | Approximately 0.7–1.3 across supported anatomy.                                                                    |
| Invalid and signed padding                 | Padding-only, fractional edge support, signed zero, and negative valid tissue.                                     |
| Frame compatibility                        | Matching frame, incompatible frame, missing frame, evidence-backed registered frame, and changed dataset revision. |
| ROI                                        | Full volume, physically axis-aligned ROI, rotated 45° ROI, edge-adjacent ROI, and insufficient-margin ROI.         |

Include at least one case where a physically valid zero-valued lesion analogue is surrounded by unsupported zero padding. Intensity alone must never distinguish those states.

### 20.4 Held-out evidence

Every candidate reconstruction method must be evaluated on observations it did not use to fit:

- Hold out individual source slices.
- Hold out spatially distinct blocks from registration scoring.
- Where three independent orientations exist, hold out an orientation for evaluation.
- Compare predicted support-aware source observations to independently generated ground truth.
- Report residual improvement separately from edge retention, topology, small-lesion preservation, and unsupported-voxel behavior.
- Reject an apparent PSNR gain caused by blurring away diagnostically relevant small structures.

An algorithm may optimize its own internal objective while becoming less faithful to the independent acquisition. Held-out reprojection and geometry are the acceptance authority.

## 21. Quantitative engineering acceptance criteria

### 21.1 Identity, source integrity, and physical geometry

| Invariant                                               | Required engineering result                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cross-patient displayed result                          | Exactly zero accepted frames, even during rapid patient changes.                                               |
| Cross-examination or stale-revision result              | Exactly zero accepted renders, annotations, or persisted writes.                                               |
| Incompatible unregistered frame fusion                  | Exactly zero accepted reconstructions.                                                                         |
| Source pixel/support length mismatch                    | Exactly zero accepted source observations or worker payloads.                                                  |
| Silent skipped required source frame                    | Exactly zero successful runs with incomplete admitted manifests.                                               |
| Patient-space pixel/voxel round-trip                    | Maximum error at most 1e-5 mm on deterministic finite geometry.                                                |
| Acquired footprint and slice-profile enclosure          | Every supported transformed physical corner lies inside the declared output bounds within numerical tolerance. |
| Rotated focus-box enclosure                             | Every physically selected ROI corner and admitted thickness margin is retained.                                |
| Visible previous-patient anatomy after selection change | Exactly zero actual-app render frames.                                                                         |

### 21.2 Support and numerical observation model

| Metric                                               | Initial acceptance threshold                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unsupported reconstructed voxels marked supported    | Exactly zero on independent support phantoms.                                                         |
| Unsupported labeled or measured voxels               | Exactly zero.                                                                                         |
| Interior observed-support recall                     | At least 0.99 where the analytic footprint is strictly inside the admitted physical domain.           |
| Supported zero/negative tissue retention             | 100% of analytically supported zero/negative samples remain eligible.                                 |
| Matched forward/adjoint relative inner-product error | At most 1e-5.                                                                                         |
| Constant-field reconstruction absolute error         | At most 1e-4 on supported interior voxels.                                                            |
| Linear-ramp reconstruction absolute error            | At most 1e-4 on interior fixtures where the chosen observation model should exactly reproduce a ramp. |
| Integrated admitted slice-profile error              | At most 1% against the independent high-resolution reference.                                         |
| Invalid-padding intensity bias                       | Zero unsupported contribution; the reproduced 100-plus-padding fixture reconstructs 100, not 50.      |
| Regularization leakage into unsupported neighbors    | Exactly zero on the reproduced one-voxel regression.                                                  |

Thresholds must be adjusted only by recorded physical justification, fixture convergence evidence, and an explicit documented decision.

### 21.3 Reconstruction and directional fidelity

Provisional engineering targets against independently generated representative phantoms:

| Metric                                                  | Initial acceptance threshold                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Supported-domain PSNR versus naive point-splat baseline | Improve by at least 3 dB on the representative thick-slice phantom.                                                     |
| Supported-domain PSNR versus current production default | Improve by at least 1 dB on the frozen physically challenging fixture, without losing small-structure accuracy.         |
| Supported-domain 3D SSIM                                | At least 0.92 on the high-SNR representative phantom.                                                                   |
| Held-out normalized reprojection RMSE                   | Improve by at least 20% against the current comparable reconstruction.                                                  |
| Held-out p95 residual                                   | No statistically material regression for the admitted representative workload.                                          |
| Slanted-edge physical position error, p95               | At most the larger of 0.5 mm and half an achieved voxel.                                                                |
| Edge overshoot or undershoot                            | At most 3% of the supported fixture's intensity range.                                                                  |
| Independent-axis MTF50                                  | Improve at least 15% over the appropriate thick-slice-only baseline before claiming meaningful directional improvement. |
| Directional MTF50 ratio for an isotropic-detail claim   | No more than 1.35 across the declared supported axes.                                                                   |
| Disconnected-support topology                           | Never bridge unsupported gaps or connect disconnected anatomy.                                                          |

These thresholds are proposed engineering gates, not statements that the current production algorithm already satisfies them. If an independent fixture proves a target physically unattainable for a particular acquisition, disclose the achieved directional limitation rather than relabel interpolation as resolution.

### 21.4 Registration evidence and abstention

On frozen independently generated rigid-motion fixtures:

- Median translation error: at most **0.25 mm**.
- Translation error p95: at most **0.75 mm**.
- Rotation error p95: at most **0.25°**.
- Forward/inverse patient-space disagreement: at most **0.5 mm** over the retained anatomical support.
- No candidate may win by dropping the difficult or unsupported portions of the common comparison domain.
- Flat, repetitive, insufficient-overlap, or incompatible-frame fixtures must abstain rather than return a confident arbitrary transform.
- Near-parallel or mislabeled orientations must not be counted as independent anatomical information.
- Partial-FOV but genuinely aligned acquisitions must not be forcibly recentered.

Candidate confidence remains an engineering quality indicator unless independently calibrated on representative labeled clinical data.

### 21.5 Display and render fidelity

| Metric                                              | Initial acceptance threshold                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Alternating 16³-to-4³ footprint-downsample variance | At most 1e-4 rather than the current approximately 0.25.                                                                  |
| Constant-field presentation error                   | At most 1e-6 before intentional texture quantization.                                                                     |
| Float16 intensity quantization error                | Within the expected format quantization envelope, initially at most approximately 1/1024 on the normalized test interval. |
| Unsigned 8-bit intensity quantization error         | At most 0.5/255 in the normalized test interval after correct rounding.                                                   |
| Support-aware LOD                                   | Zero destination voxels become acquired-supported solely through interpolation from unsupported input.                    |
| Same-transfer-function presentation SSIM            | At least 0.98 against the frozen analytic reference for the admitted display resolution.                                  |
| Physical viewport aspect                            | Matches accepted millimeter dimensions, not merely array index dimensions.                                                |
| Default radial or edge intensity gain               | None unless explicitly enabled and disclosed as display-only enhancement.                                                 |
| Graphics-context recovery                           | Restores the same accepted result, acquired support, and label identity without rerunning source reconstruction.          |

Display comparisons must hold camera, transfer function, background, hardware backend, viewport, step count, and source support constant. An image screenshot does not independently establish GPU timing.

### 21.6 Segmentation engineering targets

On independent supported lesion-like phantoms:

- For supported lesion volumes at least **1 mL**, target Dice similarity at least **0.90**.
- For supported lesion volumes approximately **0.1–1 mL**, target Dice similarity at least **0.80**.
- Target 95th-percentile Hausdorff boundary distance at most the larger of **1.5 mm** and **two achieved voxels**.
- Target supported lesion-volume error at most **5%** above 1 mL and **10%** for the smaller engineering fixture range.
- Label zero unsupported voxels even when an unsupported intensity matches the lesion.
- Mark an unsupported-boundary lesion **indeterminate extent** rather than evaluating only the visible fragment as complete.
- Preserve the lesion fingerprint and patient identity across hydration, undo/redo, rerun, cancellation, and patient selection changes.

These are algorithmic phantom thresholds. They do not establish clinical tumor-detection or lesion-diagnosis efficacy.

### 21.7 If confidence is ever presented clinically

A nominal 90% confidence interval may be described as calibrated only after independent expert-labeled evaluation establishes, at minimum:

- Empirical interval coverage in the approximate **85–95%** range for the intended evaluation population.
- Expected calibration error no greater than approximately **0.10** under a justified calibration procedure.
- Patient-disjoint evaluation across the intended scanner, sequence, lesion, and acquisition-quality strata.
- Clearly disclosed failure modes and unsupported-coverage exclusions.

Until those conditions exist, use transparent phrases such as **acquired support**, **source agreement**, **registration overlap**, or **engineering uncertainty**. Do not present a clinical probability or a reassuring unsupported confidence percentage.

## 22. Private real-MRI evaluation protocol

### 22.1 Evaluation populations

Real-image testing begins only after patient identity, frame compatibility, acquired support, and annotation ownership pass the deterministic production-path regressions.

Proposed minimum planning cohorts:

| Cohort                       | Initial planning target                                                                                                                       | Purpose                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Development                  | At least 20 patients and 40 examinations across at least two scanner vendors where available.                                                 | Tune source admission, supported physical geometry, workflow, and failure handling. |
| Frozen challenge             | At least 15 additional patient-disjoint cases selected for obliquity, anisotropy, partial coverage, source gaps, and registration difficulty. | Prevent overfitting to ordinary or convenient acquisitions.                         |
| Final independent evaluation | At least 40 patients and 80 examinations across at least three vendors where actually available.                                              | Evaluate the final accepted algorithm and report subgroup behavior.                 |

These are evaluation-planning targets, not a claim that the locally available MRI directory satisfies them. If independent patients, vendors, reference standards, or expert review are unavailable, state that limitation and withhold any clinical generalization.

### 22.2 Reference standards

Prefer one or more of:

- A same-examination high-resolution 3D acquisition with verified spatial correspondence.
- Physical landmarks independently annotated by at least two qualified reviewers.
- Lesion or structure contours independently annotated by at least two reviewers, with documented adjudication.
- Repeated acquisitions appropriate for stability and reproducibility checks.
- Source-slice holdout that preserves clinically meaningful structures and known acquisition geometry.

Record inter-reader disagreement and evaluate results against that uncertainty rather than pretending an imperfect manual label is exact truth.

Patient, not source slice, is the primary unit for partitioning and reporting. Never place slices or examinations from the same patient across development and final test cohorts.

### 22.3 Required subgroup reporting

Report failure and quality separately by:

- Scanner vendor and field strength when available without exposing identifying metadata.
- Sequence family and acquired contrast.
- Slice thickness, center spacing, and true acquisition-orientation count.
- Source-frame compatibility and accepted registration status.
- Partial-field-of-view severity and physically unsupported fraction.
- Lesion size or structure scale, where independent references exist.
- Acquired noise, bias, motion, or missing-source severity.
- Focused versus whole-volume reconstruction.
- Reference-grade versus constrained display hardware for workflow-performance testing.

One excellent central tendency must not hide unsafe subgroup failure, confident incompatible-frame fusion, or systematic small-lesion loss.

### 22.4 Privacy and execution boundaries

- Keep protected DICOM source files in their existing user-authorized local locations.
- Do not delete, rename, commit, upload, publish, or emit patient images, UIDs, names, dates, institution names, or source paths.
- Run any optional corpus evaluation locally with bounded input discovery.
- Persist only aggregate, deidentified metrics or synthetic fixtures specifically generated for tests.
- Obtain explicit authorization before creating any artifact that contains real patient images or potentially reidentifying metadata.
- Preserve offline ZIP behavior and browser-local storage ownership.
- Do not assume that a browser debugging screenshot is safe merely because an image appears grayscale or a name is cropped.

## 23. Ordered implementation program

### Phase 0. Make current production failures executable

**Purpose:** establish trustworthy baseline evidence before changing solver mathematics or optimizing implementation.

**Primary boundaries:**

- `frontend/src/utils/svr/reconstructVolume.ts`
- `frontend/src/utils/svr/svrComputeCore.ts`
- `frontend/src/utils/svr/reconstructionCore.ts`
- `frontend/src/utils/svr/sliceRoiCrop.ts`
- `frontend/src/utils/svr/renderLod.ts`
- Actual SVR component, hook, and browser-integrated test boundaries.

**Required work:**

1. Build independent synthetic frame manifests, padding-aware DICOM-like acquisitions, and trusted analytic support.
2. Add a production loader → ROI → worker → reconstruction regression proving that unsupported zero padding currently halves a supported intensity from 100 to 50.
3. Add the 8 × 8 source crop regression proving pixels and acquired support must remain identical in shape.
4. Add the incompatible-frame-of-reference regression that currently produces an invalid 27-voxel result.
5. Add the unsupported-neighbor regularization regression, 45° physical-ROI enclosure regression, and 16³-to-4³ checkerboard render regression.
6. Add a mounted actual-workspace patient-switch regression that proves no old anatomy or persisted labels may appear under a new patient identity.
7. Add the one-plane application-state regression proving that the user receives an explicit explanation and available next action.
8. Freeze representative source-cardinality, timing, and phase-memory benchmark fixtures.

**Exit gate:** each confirmed current defect fails at the smallest realistic integrated production boundary; the fixture generator does not reuse the production code being validated.

### Phase 1. Establish canonical acquisition and operation identity

**Purpose:** remove cross-patient, cross-examination, stale-revision, and unsupported frame-fusion hazards before exposing more advanced reconstruction.

**Primary boundaries:**

- `frontend/src/components/ComparisonMatrix.tsx`
- `frontend/src/components/Svr3DView.tsx`
- `frontend/src/hooks/useSvrReconstruction.ts`
- `frontend/src/utils/localApi.ts`
- `frontend/src/types/svr.ts`
- `frontend/src/components/SvrVolume3DViewer.tsx`

**Required work:**

1. Reuse the existing canonical frame-manifest access layer; do not create a parallel series registry.
2. Admit exactly one patient, study, sequence family, dataset revision, and ordered source identity.
3. Derive physical orientation independence from measured source normals.
4. Fail closed on incompatible frames unless a later phase provides accepted evidence-backed registration.
5. Attach immutable identity to every run, preview, accepted result, label operation, and saved segmentation.
6. Guard result presentation synchronously on the current identity or establish a keyed component ownership boundary.
7. Replace the silently disabled one-plane action with an actionable anisotropic-inspection or examination-selection state.
8. Preserve existing legitimate patient switching, import, sequence navigation, and browser-local storage behavior.

**Dependencies:** phase 0 production-path identity tests.

**Exit gate:** no wrong-patient anatomy, cross-frame fusion, stale accepted result, or mismatched label write occurs under rapid source selection; actual-app one-plane state explains the exact blocking fact.

### Phase 2. Land the complete acquired-observation contract atomically

**Purpose:** make physically acquired support survive the entire reconstruction pipeline.

**Primary boundaries:**

- `frontend/src/utils/decodedFrame.ts`
- `frontend/src/utils/svr/reconstructVolume.ts`
- `frontend/src/utils/svr/sliceRoiCrop.ts`
- `frontend/src/utils/svr/svrCompute.worker.ts`
- `frontend/src/utils/svr/svrComputeCore.ts`
- `frontend/src/utils/svr/reconstructionCore.ts`
- `frontend/src/types/svr.ts`
- Segmentation and viewer support boundaries.

**Required work:**

1. Preserve stored-domain padding classification and valid modality-linear zero or negative tissue.
2. Keep acquired support adjacent to every pixel array during source resampling.
3. Crop source intensity, support, and physical origin together.
4. Validate and transfer both pixel and support buffers across the worker boundary.
5. Exclude unsupported samples from normalization, registration scoring, forward projection, and backprojection.
6. Emit conservative result support and source provenance atomically with the accepted volume.
7. Restrict solver regularization, interpolation, rendering, lesion growth, model outputs, and measurements to supported evidence.
8. Include the chosen support representation in the unified memory plan.

**Indivisibility rule:** source validity, ROI crop, worker protocol, support-aware math, returned evidence, and downstream unsupported-voxel rejection are one coherent increment. Do not land only source decoding while the production ROI still leaves mismatched support lengths.

**Dependencies:** phase 1 canonical identity and admission.

**Exit gate:** the 100-versus-50 padding regression, 8 × 8 crop mismatch, fabricated six neighbors, and unsupported segmentation fixtures all pass through the real production path; valid zero and negative anatomy remain available.

### Phase 3. Correct patient-space bounds, ROI, and explicit quality admission

**Purpose:** ensure the visible and computed volume represents all and only the physically admitted acquisition.

**Primary boundaries:**

- `frontend/src/utils/svr/svrComputeCore.ts`
- `frontend/src/utils/svr/sliceRoiCrop.ts`
- `frontend/src/components/Svr3DView.tsx`
- Existing DICOM geometry and transform primitives.

**Required work:**

1. Derive source bounds from transformed full pixel footprints and admitted slice-profile extent.
2. Enclose oblique ROI corners, true physical thickness, registration search margins, and output interpolation support.
3. Preserve the physical patient coordinate convention across source crop and output-grid origin.
4. Estimate intersecting source frames before decoding or retaining entire stacks.
5. Remove silent focus-box changes to source resolution, output grid, voxel spacing, solver iterations, or registration mode.
6. Present explicit source and admitted-quality costs before reconstruction begins.
7. Offer high-detail ROI quality only as a clearly disclosed and separately accepted choice.

**Dependencies:** phase 2 support-coupled source representation.

**Exit gate:** no supported frame footprint or rotated ROI corner is clipped; early source rejection preserves all physically required acquisition and registration margins; the ROI cannot silently escalate compute quality.

### Phase 4. Make source registration reliable and allocation-conscious

**Purpose:** align only physically justified source stacks and stop accepting plausible but unverified transforms.

**Primary boundaries:**

- `frontend/src/utils/svr/rigidRegistration.ts`
- `frontend/src/utils/svr/svrComputeCore.ts`
- Existing canonical geometry and support-aware registration primitives.

**Required work:**

1. Preserve identity transforms for already compatible DICOM patient-space acquisitions.
2. Reject incompatible frame relationships with insufficient supported overlap.
3. Evaluate meaningful rigid alternatives on a stable candidate-independent acquired-support domain.
4. Add held-out spatial-block checks, inverse consistency, source coverage, and ambiguity abstention.
5. Preserve valid partial-FOV placement rather than recentering stacks.
6. Remove temporary vector construction from the rigid scorer's innermost loop.
7. Investigate reusable supported registration volumes only if leave-one-out transform semantics and registration coverage remain correct.
8. Benchmark equivalent candidate sets and record actual heap or garbage-collection evidence before claiming allocation reductions.

**Dependencies:** phases 1–3 identity, acquired support, and physical ROI correctness.

**Exit gate:** the independent rigid-motion and abstention metrics in section 21.4 pass; the frozen 40,000-sample scorer and optimizer improve without weaker registration acceptance.

### Phase 5. Improve the physical observation model and supported solver

**Purpose:** increase actual reconstructed anatomical fidelity rather than merely produce more voxels.

**Primary boundaries:**

- `frontend/src/utils/svr/reconstructionCore.ts`
- `frontend/src/utils/svr/svrComputeCore.ts`
- Source resampling and independent phantom benchmarks.

**Required work:**

1. Distinguish declared slice thickness from inter-slice spacing and missing slabs.
2. Model physically justified in-plane source footprint and through-plane slice profile.
3. Implement a matched acquired-support-aware forward and adjoint operator.
4. Bound quadrature by independently measured profile integration error.
5. Evaluate robust residual weighting and an edge-preserving, support-restricted prior.
6. Preserve small structures, valid signed intensity, disconnected support, and held-out reprojection.
7. Compute directional acquisition information and disclose effective versus achieved spacing.
8. Keep or remove multiresolution work based on measured held-out quality and representative end-to-end cost.
9. Stop adaptive refinement when added work no longer improves independently validated reconstruction.

**Dependencies:** phases 2–4 acquired support, physical bounds, and accepted source transforms.

**Exit gate:** the adjoint, PSF integration, support, held-out error, edge, MTF, and small-lesion gates pass; true anatomical gains are documented against the frozen prior production baseline.

### Phase 6. Unify planning, source ownership, and progressive execution

**Purpose:** make representative 512² MRI workloads predictable without hiding memory or blocking interaction.

**Primary boundaries:**

- `frontend/src/components/Svr3DView.tsx`
- `frontend/src/hooks/useSvrReconstruction.ts`
- `frontend/src/utils/svr/reconstructVolume.ts`
- `frontend/src/utils/svr/svrCompute.worker.ts`
- `frontend/src/utils/svr/svrComputeCore.ts`
- Viewer and optional inference memory-estimation paths.

**Required work:**

1. Replace disconnected source, solver, renderer, and model estimates with one phase-lifetime-aware memory plan.
2. Account for support buffers, worker transfer, optional prior-result retention, display staging, GPU textures, labels, and model tensors.
3. Reuse canonical image-loading ownership and avoid duplicate instance lookup where the production integration permits it.
4. Admit bounded source decode concurrency based on actual workload and available memory.
5. Crop or reject nonintersecting source frames before long-lived worker retention.
6. Preserve deterministic manifest ordering, cancellation, and worker backpressure.
7. Produce a support-safe, identity-safe coarse preview only when it materially improves user-visible response.
8. Move expensive half-float conversion, occupancy generation, or anti-aliased LOD off the main thread when actual transferable ownership and browser support justify it.
9. Preserve offline non-cross-origin-isolated operation without mandatory SharedArrayBuffer or OffscreenCanvas assumptions.

**Dependencies:** phases 1–5 accepted identity, physical source contract, and benchmark fixtures.

**Exit gate:** representative workloads satisfy unified budget admission, bounded source residency, no greater than 50 ms attributable main-thread tasks, zero idle rendering, monotonic cancellation, and the proposed user-visible phase targets.

### Phase 7. Make displayed anatomy faithful and presentation failures recoverable

**Purpose:** ensure the 3D display does not invent structure, conceal degradation, or unnecessarily rebuild immutable GPU resources.

**Primary boundaries:**

- `frontend/src/utils/svr/renderLod.ts`
- `frontend/src/components/SvrVolume3DViewer.tsx`
- Existing SVR raymarch and WebGL utility modules.

**Required work:**

1. Replace point-sampled display shrinkage with an acquired-support-aware antialiasing filter.
2. Preserve supported physical detail and conservative destination support.
3. Distinguish actual reconstruction dimensions from admitted display dimensions and texture precision.
4. Remove automatic center/edge gain from the neutral default display; preserve an optional clearly labeled visual enhancement if justified.
5. Keep volume textures, support textures, and label textures under distinct derived ownership.
6. Avoid recompiling or reuploading an unchanged accepted volume merely because a label is introduced.
7. Respect anisotropic physical aspect and accepted patient-space orientation.
8. Recover from graphics-context loss using the same immutable accepted result.
9. Record actual hardware adapter provenance before drawing GPU pacing conclusions.

**Dependencies:** phases 2, 5, and 6 canonical support, correct physical volume, and admitted memory plan.

**Exit gate:** checkerboard, constant-field, support-aware LOD, orientation, texture-precision, context-recovery, and hardware-backed interaction frame requirements pass.

### Phase 8. Complete the acquisition-aware workspace

**Purpose:** turn reconstruction correctness into an understandable, accessible user experience.

**Primary boundaries:**

- `frontend/src/components/Svr3DView.tsx`
- `frontend/src/components/SvrVolume3DViewer.tsx`
- `frontend/src/hooks/useSvrReconstruction.ts`
- Comparison workspace and existing design tokens.

**Required work:**

1. Implement the lightbox hierarchy, explicit examination header, compact source rail, dominant central viewport, and linked inspection layout.
2. Present actionable no-source, one-stack, incompatible-frame, budget, cancellation, and context-loss states.
3. Show monotonic phase-weighted progress, accurate current phase, honest acquired-source counts, and optional same-identity prior-result retention.
4. Synchronize 3D interaction, orthogonal slices, source previews, lesion seeds, and focus boxes to one physical patient-space cursor.
5. Explain output spacing, directional resolution, acquired support, and display degradation without implying clinical confidence.
6. Hide advanced appearance, segmentation, and model features until their prerequisites exist.
7. Provide keyboard, focus, screen-reader, reduced-motion, target-size, and zoom requirements.
8. Re-stage the workspace across desktop, compact, mobile, and 200%-zoom breakpoints.
9. Capture the actual running application at each materially visible checkpoint using synthetic patient-free data.

**Dependencies:** phases 1–7; the ineligible one-plane and identity safety states should land earlier in phase 1.

**Exit gate:** actual-app evidence confirms every requested empty/running/ready/error state, identity-safe physical inspection, accessible interaction, and a clear responsive information hierarchy. Storybook-only screenshots do not satisfy this gate.

### Phase 9. Harden supported lesion labeling and optional inference

**Purpose:** make downstream measurements honest about source evidence and persistence ownership.

**Primary boundaries:**

- `frontend/src/components/SvrVolume3DViewer.tsx`
- Existing SVR segmentation workers and storage utilities.
- `frontend/src/hooks/useOnnxTumorSession.ts`
- Existing local segmentation persistence owner.

**Required work:**

1. Reject unsupported seeds and prevent unsupported label growth or edits.
2. Record physically supported voxel volume and unsupported lesion-boundary status.
3. Bind label hydration, saving, undo, and redo to the accepted result fingerprint.
4. Expose model inference only for verified final supported volumes and genuinely available validated models.
5. Include optional model working tensors in the unified execution budget.
6. Prove any tiled inference against an accepted full-volume reference before enabling it.
7. Preserve local-only persistence and patient-data deletion semantics.
8. Evaluate supported lesion phantoms and uncertainty presentation against the nonclinical engineering gates.

**Dependencies:** phases 1–8 identity, acquired support, physical fidelity, and final workspace.

**Exit gate:** zero unsupported lesion voxels, no cross-patient writes, truthful incomplete-coverage messaging, stable supported physical-volume calculations, and appropriately hidden unavailable model functionality.

### Phase 10. Freeze integrated evaluation and verify the offline product

**Purpose:** prove the completed SVR feature through its real user-visible and privacy-preserving execution boundaries.

**Required work:**

1. Run every independent synthetic physical and numerical acceptance family.
2. Run frozen small/common/stress/focus browser scenarios with cold and warmed source state.
3. Record representative p50 and meaningful tail metrics only from adequate sample counts.
4. Capture actual application evidence for responsive, support-aware, running, complete, canceled, and failed states.
5. Verify hardware-backed render pacing and actual graphics adapter provenance.
6. Build the existing offline runnable distribution and verify SVR in the real offline serving environment.
7. Verify browser operation without cross-origin isolation.
8. Confirm patient data, DICOM images, identifiers, screenshots, and benchmark artifacts remain local and protected.
9. If independent real MRI and expert references are available, execute the patient-disjoint evaluation protocol and report limitations honestly.
10. Compare the final production contract, resource ownership, source identity, and output quality against the frozen reviewed baseline.

**Dependencies:** all preceding phases and any user authorization required for protected local data or real-patient screenshots.

**Exit gate:** every applicable correctness, physical fidelity, interaction, memory, accessibility, privacy, and offline acceptance requirement passes; unresolved evidence gaps are explicit and no clinical claim exceeds the available validation.

## 24. Verification architecture and regression ownership

### 24.1 Extend existing focused suites

Use the current repository-native Vitest suites before introducing overlapping infrastructure:

| Existing test boundary                         | Required extension                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frontend/tests/decodedFrame.test.ts`          | Signed padding, fractional acquired support, supported zero, and source intensity/support shape identity.                                              |
| `frontend/tests/svrSliceRoiCrop.test.ts`       | Coupled pixel/support crop, physical-origin update, oblique ROI corners, and registration/profile margin preservation.                                 |
| `frontend/tests/svrComputeCore.test.ts`        | Frame compatibility, missing source frames, orientation independence, accepted identity, worker result support, and unsupported-domain regularization. |
| `frontend/tests/svrDicomGeometry.test.ts`      | Full source-footprint enclosure, transformed profile support, obliquity, physical pixel-center convention, and finite valid geometry.                  |
| `frontend/tests/svrGeometryInvariants.test.ts` | Independent patient-space forward/inverse round trips and accepted registration transforms.                                                            |
| `frontend/tests/svrRigidRegistration.test.ts`  | Source masks, stable comparison domain, competing hypotheses, held-out blocks, inverse consistency, and explicit abstention.                           |
| `frontend/tests/svrPhantom.test.ts`            | Independent 64³/128³/192³ phantoms, held-out residual, matched adjoint, thick slices, small lesions, partial support, and directional fidelity.        |
| `frontend/tests/svrRenderLod.test.ts`          | Alternating-volume antialiasing, support-safe downsampling, constant preservation, achieved display resolution, and cancellation.                      |
| `frontend/tests/svrFloat16.test.ts`            | Precision error against declared actual render formats.                                                                                                |
| `frontend/tests/svrOccupancyGrid.test.ts`      | Independence between acceleration occupancy and authoritative acquired support.                                                                        |
| `frontend/tests/onnxTumorSegmentation.test.ts` | Unsupported output masking, exact result identity, real model availability, tensor budget admission, and tile equivalence where supported.             |
| `frontend/tests/onnxLogitsToLabels.test.ts`    | Unsupported voxel exclusion and truthful incomplete-boundary labels.                                                                                   |

Do not repurpose longitudinal-registration tests as proof of SVR correctness unless the live SVR production path actually reaches the same verified primitive.

### 24.2 New production-boundary suites

Proposed additions, using repository naming conventions:

| Proposed suite                                     | Product boundary and mandatory regressions                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/tests/svrObservationContract.test.ts`    | Actual loader → padding-aware decode → acquired-support resample → ROI crop → worker payload → accepted result.                                           |
| `frontend/tests/svrAcquisitionAdmission.test.ts`   | Canonical patient, study, frame, sequence, dataset revision, source completeness, and physically independent orientations.                                |
| `frontend/tests/useSvrReconstruction.test.tsx`     | Immutable operation identity, monotonic progress, superseded runs, cancellation, retained previous result, and terminal success.                          |
| `frontend/tests/Svr3DView.test.tsx`                | No-source/one-stack/invalid-frame/budget states, patient switching, physical focus-box decisions, and explicit quality choice.                            |
| `frontend/tests/SvrVolume3DViewer.test.tsx`        | Matching accepted volume identity, support-safe inspection, unsupported seed rejection, actual display disclosure, context recovery, and label ownership. |
| `frontend/tests/svrFidelityPhantoms.test.ts`       | Independent physical source generation, PSNR/SSIM, slanted edges, MTF, lesions, held-out reprojection, and support topology.                              |
| `frontend/tests/svrExecutionBudget.test.ts`        | Full phase-overlap memory ownership, decoded-source cardinality, prior-result retention, display staging, and optional inference tensors.                 |
| `frontend/tests/svrProductionIntegration.test.tsx` | Actual component/hook/local-API integration with synthetic IndexedDB data and deterministic worker behavior.                                              |
| `frontend/tests/svrSegmentationSupport.test.ts`    | Supported growth, connected components, physical volume, unsupported-boundary status, persistence fingerprint, and no cross-patient writes.               |

Names are illustrative. If the same ownership and realism fit cleanly into an existing suite, extend that suite instead of adding tests solely to satisfy a filename list.

### 24.3 Worker and transferable-buffer integration

The production worker contract must be tested for:

- Pixel and support buffer transfer ownership.
- Duplicate-buffer transfer rejection.
- Structured-clone fallback only when explicitly supported and budgeted.
- Stale result and progress message suppression.
- Cancellation before decode, during decode, during scoring, during refinement, and during display preparation.
- Worker initialization failure and termination timeout.
- No detached-buffer reuse in a fallback inline compute path.
- Atomically paired returned volume and support evidence.
- Zero accepted writes after an operation becomes stale.
- A retained previous same-identity result that remains valid while its replacement is computing.

Mocking the solver alone is insufficient to prove the production loader or transferable-message boundary.

### 24.4 Actual application and visual evidence

Required real-product states, exercised through the application's actual route with synthetic browser-local data:

1. No eligible examination.
2. One physically valid source orientation.
3. Near-parallel mislabeled orientations.
4. Physically independent compatible orientations with an admitted run estimate.
5. A running reconstruction with truthful monotonic progress.
6. A support-safe coarse preview, where enabled.
7. A finished volume with achieved spacing, acquired support, and actual display resolution.
8. A focused ROI before and after explicit quality selection.
9. An unsupported inspection coordinate and rejected lesion seed.
10. A supported lesion label and truthful supported physical-volume display.
11. Rapid examination and patient switching while a prior run or result exists.
12. Cancellation, failure, memory rejection, and graphics-context recovery.
13. Desktop, compact, narrow, 200%-zoom, keyboard-only, and reduced-motion states.

For every materially visible checkpoint:

- Capture the real product surface, not a Storybook-only component.
- Use synthetic images unless explicit approval authorizes real-patient visual artifacts.
- Save and individually inspect the canonical screenshot.
- Record actual route, reviewed implementation revision, viewport, product state, and relevant graphics backend.
- Audit typography, composition, hierarchy, responsive staging, accessibility-visible state, support disclosure, and patient-context consistency.
- For motion or frame pacing, pair an ordered screenshot sequence with monotonic timestamps and real frame telemetry; one still cannot prove smoothness.

The current verified baseline is the actual synthetic one-plane screenshot linked in section 3.2. It validates only that current application state; it is not a reference for finished-volume rendering or GPU performance.

### 24.5 Build and offline validation

After implementation is separately authorized, the minimum existing repository checks from `frontend/` are:

```bash
npm run lint
npm run test
npm run build
npm run package:zip
```

Also launch the resulting local distribution through its documented offline HTTP entrypoint and verify:

- Browser-local DICOM import and source manifest admission.
- Same-origin worker, pipeline, WebGL, and optional ONNX assets.
- SVR operation without cross-origin isolation.
- Local-only segmentation persistence and clear-data behavior.
- Cancellation, context loss, and recoverable model unavailability.
- No network dependency, patient-data upload, or accidental patient artifact in the distribution.

A passing production build does not replace an actual running offline SVR execution.

## 25. Design alternatives and explicit tradeoffs

### 25.1 Acquisition support representation

| Option                                                          | Advantages                                                               | Costs and failure risks                                                                               | Decision                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Treat numeric zero as missing support                           | No additional array.                                                     | Conflates valid zero/negative anatomy with padding and fabricates incorrect support.                  | Reject.                                                                          |
| Full Float32 support for every retained source and output voxel | Preserves fractional source evidence and simple arithmetic.              | Up to 4 extra bytes per pixel/voxel; expensive for native 512² sources and large outputs.             | Permit where fractional evidence is required, with explicit lifetime accounting. |
| Byte-quantized support                                          | Cheap transfer, GPU-friendly R8 texture, and straightforward inspection. | Quantization requires documented thresholds; source-edge fractions lose precision.                    | Preferred initial final-volume representation when numeric gates pass.           |
| Packed support bitset                                           | Lowest persistent output memory.                                         | More complicated worker, shader, and inspection access; cannot directly encode fractional confidence. | Adopt only if representative memory measurements justify the complexity.         |

Keep source fractional support as long as it materially changes projection. Quantize final support only after validating that unsupported rejection and meaningful fractional boundaries remain correct.

### 25.2 Reconstruction method

| Option                                             | Advantages                                                                                   | Costs and failure risks                                                                                      | Decision                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Existing point splat with a support mask only      | Smallest immediate safety correction and fast initial baseline.                              | Does not fully model slice thickness, pixel footprints, source motion, or directional fidelity.              | Useful phase-2 baseline; insufficient as the final target alone. |
| Physically matched robust iterative reconstruction | Reuses existing solver structure while improving source-support, PSF, and held-out fidelity. | Requires independent projection/adjoint tests and bounded compute.                                           | Recommended target.                                              |
| Strong global TV regularization                    | Can suppress noise and preserve some high-contrast edges.                                    | Staircasing, lesion shrinkage, unsupported bridging, and difficult parameter interpretation.                 | Consider only with independent edge and lesion evidence.         |
| Full Bayesian or learned reconstruction            | Could represent richer uncertainty or learned anatomy.                                       | Model dependency, calibration, substantial resource cost, privacy risk, and potential anatomy hallucination. | Defer.                                                           |

The objective is not to add the most sophisticated inverse method. It is to recover physically supported detail that the actual browser and acquired source data can justify.

### 25.3 Registration policy

- **Always register every stack:** simpler to describe, but wastes compute and can damage valid native patient geometry.
- **Never register any stack:** preserves geometry but rejects clinically common compatible motion or unverified reference-frame differences.
- **Identity when evidence supports it; bounded rigid registration only when required and verifiable:** preserves valid native geometry while controlling both cost and unsafe source fusion.
- **Per-slice nonrigid correction:** substantially larger complexity, ambiguity, and deformation risk; defer until a representative motion benchmark proves rigid registration is inadequate.

Choose the third policy.

### 25.4 Progressive preview

Preview is valuable only when:

- Source identity, support, and physical geometry are already valid.
- It appears materially before the accepted final result.
- Its creation fits the phase-aware memory budget.
- The user can distinguish it from final quantitative anatomy.
- It cannot accept persistent segmentation or model inference.

If a small workload completes faster than a preview can be prepared, publish only the final result. Progress must not become an extra full-volume solve disguised as responsiveness.

### 25.5 Browser execution technology

| Technology                                 | Potential benefit                                                                  | Required evidence before adoption                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Existing dedicated transferable Web Worker | Preserves current offline architecture and keeps core compute off the main thread. | Verify support transfer, cancellation, and bounded ownership.                                        |
| Bounded decode concurrency                 | Can use existing Cornerstone worker capacity.                                      | Show lower end-to-end decode time without a worse admitted memory peak.                              |
| SharedArrayBuffer                          | May reduce copies for some shared source arenas.                                   | Verify cross-origin isolation and offline ZIP compatibility; provide a complete fallback.            |
| OffscreenCanvas                            | May move some display preparation or rendering away from the main thread.          | Verify browser support, transferred resource ownership, input latency, and actual GPU correctness.   |
| WebGPU compute                             | Could accelerate large operators on suitable devices.                              | Demonstrate a representative solver bottleneck and preserve offline/browser portability.             |
| A second permanent decoded-image cache     | Could hide repeated decode latency.                                                | Must prove bounded ownership, canonical invalidation, and measured benefit; currently not justified. |

The default design remains the existing worker and browser-local rendering model. Add an execution mechanism only when measured end-to-end evidence shows that it removes more complexity or cost than it creates.

## 26. Risks, guardrails, and unresolved decisions

### 26.1 Risks that block implementation signoff

1. A physically unsupported voxel is reconstructed, displayed as acquired, labeled, measured, or inferred as supported.
2. Anatomy, labels, or persisted writes cross patient, study, source, frame, geometry, or dataset-revision identity boundaries.
3. A distinct source frame is fused without a verified physical transform.
4. A supported acquisition footprint or focus-box corner is clipped.
5. An optimization changes source support, output dimensions, registration acceptance, solver quality, or label semantics without an explicit documented contract change.
6. A display texture invents convincing high-frequency structure or hides a lower resolution from the user.
7. A planner omits overlapping source, support, solver, GPU, label, prior-result, or model allocations.
8. The interface claims isotropic detail, calibrated confidence, lesion certainty, or clinical diagnostic accuracy beyond independent evidence.
9. Actual-product visual or GPU claims rely solely on Storybook, synthetic DOM assumptions, a software graphics backend, or an uninspected screenshot.
10. Any benchmark, screenshot, trace, report, or test fixture exposes real patient information.

### 26.2 Decisions to resolve with measured evidence

| Decision                                         | Evidence required                                                                              | Safe interim behavior                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Minimum physically independent orientation angle | Independent directional MTF and conditioning across plausible source normals.                  | Report measured normals and reject effectively parallel stacks as multiplane evidence.      |
| Final support byte versus bitset representation  | Large-grid memory profile, support precision, GPU sampling, and segmentation cost.             | Use the simplest representation that passes support and memory gates.                       |
| Source slice-profile shape                       | Available scanner metadata and independent profile-integration phantom error.                  | Mark unknown profiles honestly; never infer a measured thickness from center spacing alone. |
| Exact bounded decode concurrency                 | Cold/warm actual-browser timing and phase-peak residency.                                      | Begin serial or conservatively bounded; never exceed the admitted memory estimate.          |
| Supported regularization family and strength     | Held-out residual, slanted edge, small-lesion volume, and unsupported topology.                | Preserve support-safe conservative refinement.                                              |
| Rigid registration similarity metric             | Relevant source-contrast distributions, source masks, block holdout, and inverse consistency.  | Abstain on ambiguous or insufficiently overlapping acquisitions.                            |
| Off-main display preparation strategy            | Actual main-thread long tasks, transferred-buffer lifetime, and offline browser compatibility. | Keep a measured cooperative bounded implementation.                                         |
| Preview threshold                                | Difference between truthful first-preview paint and final result across frozen workload sizes. | Skip preview where its extra work provides no meaningful user benefit.                      |
| Segmentation uncertainty wording                 | Independent clinician-reviewed accuracy and uncertainty calibration.                           | Disclose acquired support and incomplete extent; avoid diagnostic probabilities.            |
| Clinical cohort size and vendor diversity        | Actually available patient-disjoint, expert-labeled examinations.                              | Report the real available cohort and withhold unsupported claims.                           |

### 26.3 Preserve these existing strengths

The implementation must preserve:

- Browser-local and offline-capable MRI processing.
- The existing canonical DICOM data owner and Cornerstone custom image loader.
- DICOM patient-space geometry, physical slice ordering, and partial-field-of-view placement.
- Safe worker termination and zero-copy accepted-volume transfer where already present.
- Existing conservative empty-space acceleration and zero-idle demand-driven rendering.
- Existing bounded segmentation-worker behavior and local persistence ownership.
- Existing 2D viewer, comparison, import, alignment, and clear-data contracts.
- Current meaningful geometry, PSF, registration, segmentation, and offline regression suites.

Restoring safety and physical fidelity may intentionally change incorrect reconstructed pixel values. Unrelated product behavior must remain intact.

## 27. Definition of done

The SVR feature satisfies this specification only when all applicable statements are true:

1. Every visible and persisted volume belongs to one immutable admitted patient, examination, sequence, frame relationship, source set, and dataset revision.
2. No old patient's anatomy, annotation, preview, or model output appears under a new patient's identity, even transiently.
3. Every reconstructed and labeled anatomical voxel is backed by authoritative acquired support.
4. Unsupported padding does not alter supported intensity; valid zero and negative anatomy remains valid.
5. The source pixel/support representation survives decode, ROI crop, worker transfer, registration, projection, result publication, rendering, and segmentation without divergence.
6. Physically incompatible frames fail closed, while supported compatible sources preserve correct patient-space placement.
7. Full acquisition footprints, slice profiles, partial coverage, and oblique focus boxes are represented without clipping or fabricated bridges.
8. Independent physical phantoms show meaningful held-out reconstruction improvement, faithful edges, preserved small structures, and honest directional resolution.
9. The display antialiases reduced-resolution data, preserves support, respects true physical aspect, and discloses actual texture precision and achieved resolution.
10. One phase-aware execution plan accounts for source data, support, solver scratch, accepted result, GPU preparation, labels, optional inference, and retained prior results.
11. Representative source-cardinality workloads remain responsive, cancellable, predictably bounded, and free of continuous idle rendering.
12. Reconstruction progress never moves backward, the previous same-identity result is retained when safely budgeted, and a successful run terminates without a stale spinner.
13. A single-plane or unsafe-source examination explains exactly what is available and what the user can do next.
14. The workspace foregrounds anatomy, explicitly owns the selected examination, links physical inspection surfaces, and hides advanced unavailable controls.
15. Keyboard, accessible names, visible focus, 36/44 px targets, narrow layouts, reduced motion, and 200% zoom satisfy the interaction contract.
16. Segmentation and optional inference never cross unsupported anatomy or patient/result identity, and incomplete lesion coverage is clearly disclosed.
17. The actual application and offline ZIP satisfy the deterministic production-path, physical fidelity, memory, rendering, UX, accessibility, privacy, and recovery gates.
18. No clinical accuracy, calibrated confidence, isotropic acquired resolution, or model capability is claimed without the corresponding independent evidence.
19. Protected MRI images and identifiers remain local, unchanged, and absent from committed fixtures, screenshots, logs, and diagnostics.

The desired result is not merely a faster 3D effect. It is a physically grounded, responsive, visually coherent, privacy-preserving reconstruction workflow whose apparent detail and quantitative tools remain accountable to the MRI data that actually exists.
