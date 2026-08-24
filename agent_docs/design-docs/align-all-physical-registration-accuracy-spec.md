# Align All physical-registration accuracy specification

- Status: proposed; no production implementation is authorized by this document.
- Reviewed revision: df59ceccaa90151c20fd9ba32a524c952f00c667.
- Date: 2026-08-24.
- Scope: longitudinal MRI correspondence, physical geometry, source-pixel validity, registration, resampling, derived-image presentation, confidence, provenance, accuracy evaluation, and their necessary user controls.
- Existing foundation: agent_docs/exec-plans/active/miraviewer-architecture-and-auto-alignment-improvement-plan.md.
- Relationship to prior alignment documents: supersedes scoring-only proposals wherever they assume that 2D perceptual ranking, square analysis images, or a single native target slice are sufficient.

## Executive decision

MiraViewer already performs real patient-scoped, rigid 3D registration and reconstructs a native-resolution derived plane for incompatible longitudinal acquisitions. The next accuracy improvement is not another similarity metric in isolation. It is establishing one physically truthful representation of acquisition geometry, anatomical validity, the chosen output lattice, and registration evidence from import through presentation.

Current source-level experiments demonstrate that the existing implementation can:

1. Rotate an otherwise identical scan by approximately 3° solely because a lesion-exclusion rectangle was applied.
2. Accept an almost unrelated 2D candidate with an absolute structural score of only 0.020.
3. Reclassify image background as anatomy when a positive modality intercept is applied.
4. Invent a value of -950 by averaging a DICOM padding sample with valid tissue that should have remained 100.
5. Choose a target source image approximately 13 acquired slices away from the correct physical anchor.
6. Route a diagonally tilted acquisition through 2D even though its true corner displacement requires 3D reslicing.
7. Present one derived image with three mutually contradictory descriptions of its pixel spacing.
8. Interpolate across a 23 mm acquisition hole while reporting complete geometric coverage.

The proposed architecture fixes these failures at their shared causes:

```text
validated native DICOM pixels + explicit native validity
    -> immutable physical stack geometry
    -> one explicitly selected output-plane grid
    -> common physically meaningful stable-anatomy domain
    -> bounded multi-start rigid registration
    -> native-resolution, lesion-safe local refinement
    -> independent absolute, relative, support, and inverse evidence gates
    -> gap-aware direct resampling onto the exact selected grid
    -> physically truthful derived-image metadata and durable provenance
    -> clinician-labeled, patient-disjoint accuracy evaluation
```

No change may improve an image-similarity score by hiding true anatomical change, silently fabricating unsupported anatomy, mixing physical coordinate systems, or reporting a confidence probability that has not been independently calibrated.

## 1. Scope and existing baseline

### 1.1 Product contract

For a chosen reference examination, sequence, and source slice, Align All should display each other examination on the same verified anatomical plane whenever the available acquisitions support that result. It must preserve real lesion changes, report unsupported or ambiguous cases honestly, and retain the exact physical meaning of every displayed pixel.

The contract is not simply “find two images that look alike.” It is:

> For the same patient, estimate the physically plausible rigid relationship between examinations, evaluate whether stable anatomy establishes that relationship uniquely, and sample only acquired target anatomy onto an explicit reference-owned plane without hiding biological change.

### 1.2 Verified capabilities to preserve

The reviewed revision already provides:

- Patient-, examination-, series-, frame-of-reference-, and dataset-revision-scoped alignment.
- Physical ordering when trustworthy per-frame DICOM metadata is available.
- High-bit-depth, modality-linear decoded MRI pixels.
- A 2D structure-first path using MIND, NGF, local appearance features, bounded phase correction, and structurally gated affine proposals.
- A bounded 3D rigid path for incompatible reference frames or materially tilted acquisitions.
- Bidirectional occupied-volume correlation and explicit failure outcomes.
- Native contiguous-target-frame reslicing after an accepted coarse rigid pose.
- Cancellable scoring and registration workers.
- Explicit lesion-exclusion support, although its current 3D implementation is incorrect.
- Verified derived-frame persistence, backup recovery, and patient/revision revalidation.
- 77 passing test files and 460 passing tests at the reviewed revision.

These are existing implementation facts, not proposed work.

### 1.3 What the available real MRI corpus proves

The existing architecture report documents:

- 1,405 imported DICOM images.
- One patient, four examinations, and six FLAIR series.
- Four distinct longitudinal DICOM frames of reference.
- Longitudinal plane disagreement up to approximately 18°.
- Representative axial in-plane spacing of approximately 0.4297 mm.
- A sagittal series with 0.6 mm center spacing and 1.2 mm slice thickness.
- A demonstrated 18.050° registered case with 512 × 512 output and 98.789% supported coverage.
- One representative 3D rigid-registration measurement around 149 ms, dense decode around 9.6 ms, and native-plane reslice around 17.3 ms.
- A reduction of coarse-stack transfer from 50.65 MiB to 4.34 MiB.

The corpus does not provide independent anatomical landmarks, clinician-labeled correspondence, blinded assessment, multiple independent patients, a patient-disjoint holdout, or clinically calibrated confidence. It is an engineering smoke/challenge corpus, not a clinical accuracy benchmark.

## 2. Confirmed remaining accuracy failures

### A01. Lesion exclusion can create a false rigid rotation

Classification: reproduced on the current production registration functions.

The current 3D pipeline normalizes both acquisitions, then overwrites excluded reference anatomy with literal zero:

- frontend/src/utils/svr/longitudinalRegistration.ts:259.
- frontend/src/utils/svr/longitudinalRegistration.ts:281.
- frontend/src/utils/svr/longitudinalRegistration.ts:535.

Target anatomy is not excluded on the corresponding physical support. Sampling subsequently treats nonpositive values as absent:

- frontend/src/utils/svr/rigidRegistration.ts:286.
- frontend/src/utils/svr/reconstructionCore.ts:220.

Using the existing 19 × 19 × 19 synthetic registration fixture, the same reference and target, a 5 × 5 central exclusion, a 16-pixel coarse dimension, and 4,000 maximum samples produces:

| Measurement                        | No exclusion | Reference exclusion |
| ---------------------------------- | -----------: | ------------------: |
| Translation                        |   0, 0, 0 mm |          0, 0, 0 mm |
| Rotation                           |   0°, 0°, 0° |     -2.5°, -3°, +2° |
| Structural objective               |     0.999658 |            0.759667 |
| Output-plane coverage              |     1.000000 |            0.900277 |
| Forward supported fraction         |     1.000000 |            0.818636 |
| Reverse supported fraction         |     1.000000 |            1.000000 |
| Forward/reverse score disagreement |     0.000000 |            0.070935 |
| Reported outcome                   |      Aligned |             Aligned |

The existing lesion test checks translation but not all three rotations or physical landmark error: frontend/tests/svrLongitudinalRegistration.test.ts:172.

Required correction: an exclusion is missing comparison support, never an intensity value. Apply the same physical exclusion to both registration directions before normalization, scoring, reconstruction support, and confidence estimation.

### A02. The 2D confidence gate accepts nearly unrelated anatomy

Classification: reproduced by calling the production confidence function.

At full support with a textured reference:

```text
winning MIND                = 0.0200
winning NGF                 = 0.0200
winning signed raw NGF      = -0.9600
physically distinct rival   = 0.0195
absolute runner-up gap      = 0.0005
numerical distinction floor = 0.0001953125
current result              = aligned
```

The implementation checks relative distinction but has no required minimum absolute stable-anatomy agreement:

- frontend/src/utils/alignmentConfidence.ts:63.
- frontend/src/hooks/useAutoAlign.ts:993.
- frontend/src/hooks/useAutoAlign.ts:1501.
- frontend/src/hooks/useApplyAlignmentResults.ts:39.

A candidate can therefore beat an almost equally wrong rival and still overwrite visible alignment settings.

Required correction: independently require sufficient absolute structural agreement, physically meaningful anatomical support, a meaningful competing-pose margin, and trustworthy inverse/phase evidence. A relative lead can never substitute for an acceptable absolute match.

### A03. Positive modality intercepts convert background into foreground

Classification: reproduced by calling production normalization.

The current normalization chooses zero as background whenever the image minimum is positive:

- frontend/src/utils/perceptualSliceSimilarity.ts:146.
- frontend/src/utils/perceptualSliceSimilarity.ts:163.
- frontend/src/utils/perceptualSliceSimilarity.ts:168.

For a 4 × 4 image containing twelve background pixels and four tissue values:

```text
native tissue values          = 50, 100, 150, 200
offset 0                      = 4 foreground pixels; background 0
offset +1000                  = 16 foreground pixels; background 0.05
offset -1000                  = 4 foreground pixels; background 0
```

The decoded-pixel pipeline explicitly supports positive modality intercepts:

- frontend/src/utils/decodedFrame.ts:68.

The current normalization regression covers a negative intercept only:

- frontend/tests/perceptualSliceSimilarity.test.ts:89.

Required correction: derive anatomical validity independently of image sign and additive intensity shifts. Positive or negative modality intercepts must not change anatomical support, scoring weights, or confidence.

### A04. DICOM padding is averaged into anatomy before registration

Classification: reproduced on the existing area-average resampler; missing metadata demonstrated in production ingestion.

Pixel Padding Value and Pixel Padding Range Limit are not retained by the current ingestion and decoded-frame contracts:

- frontend/src/services/dicomIngestion.ts:180.
- frontend/src/utils/decodedFrame.ts:5.
- frontend/src/db/schema.ts:206.

The existing resampler produces:

```text
stored source samples       = -2000, 100, 100, 100
declared padding value      = -2000
current 1 × 2 output        = -950, 100
validity-aware 1 × 2 output = 100, 100
```

The fabricated -950 sample is then fed into normalization, MIND, gradients, support extraction, phase correlation, volume reconstruction, and NCC. A downstream threshold cannot recover the original valid tissue value.

Required correction: preserve stored-domain padding semantics and propagate an explicit per-pixel validity/support weight through every interpolation and image-analysis boundary.

### A05. Diagonal acquisition tilt can be routed through the wrong algorithm

Classification: mathematically demonstrated against the current mode-selection formula.

The current drift estimate uses half the longest image side:

- frontend/src/utils/svr/longitudinalFrames.ts:318.
- frontend/src/hooks/useAutoAlign.ts:389.

For a 200 × 200 mm field, a 1° diagonal tilt, and 4 mm acquired center spacing:

```text
current estimated maximum drift = 100 × sin(1°) = 1.745 mm
half the acquired center spacing = 2.000 mm
current route                    = 2D

true diagonal corner drift       = √2 × 100 × sin(1°)
                                 = 2.468 mm
required route                   = 3D plane reslicing
```

The current implementation also inspects the first acquisition frames instead of the actual selected reference plane.

Required correction: calculate signed displacement at all four physical output-plane corners using the selected frame, actual row and column directions, anisotropic spacing, and the local acquired slice-center geometry.

### A06. The representative target SOP can be approximately 13 slices wrong

Classification: mathematically demonstrated against current physical target selection.

The existing anchor minimizes target-slice center displacement projected onto the reference normal:

- frontend/src/utils/alignmentGeometry.ts:40.
- frontend/src/hooks/useAutoAlign.ts:472.

For 18° target obliquity, 1 mm acquired target spacing, and a lateral crop-center shift of 40 mm:

```text
wrong anchor displacement ≈ 40 × tan(18°)
                           ≈ 12.997 target slices
```

The wrong SOP becomes the viewer anchor, derived-image source identity, and durable target-frame identity.

Required correction: inverse-map the physical center of the chosen output plane through the accepted rigid transform and choose the acquired target center nearest along the target stack's canonical normal. Persist that representative image separately from the complete ordered list of genuinely contributing source images.

### A07. One derived image can advertise three conflicting physical grids

Classification: statically demonstrated with exact pixel-center arithmetic.

The selected reference is capped at 512 pixels:

- frontend/src/utils/svr/longitudinalFrames.ts:85.
- frontend/src/utils/svr/longitudinalFrames.ts:140.
- frontend/src/hooks/useAutoAlign.ts:403.

The derived result stores original reference spacing and origin:

- frontend/src/hooks/useAutoAlign.ts:533.
- frontend/src/db/schema.ts:270.

The Cornerstone derived-image loader copies the target source image and does not override its row/column spacing:

- frontend/src/utils/cornerstoneInit.ts:82.
- frontend/src/utils/cornerstoneInit.ts:94.

For a reference image with 640 rows, 512 columns, and 0.4/0.8 mm row/column spacing:

| Geometry authority              | Dimensions | Row spacing | Column spacing |
| ------------------------------- | ---------- | ----------: | -------------: |
| Actual current output lattice   | 512 × 410  | 0.500000 mm |    0.999024 mm |
| Persisted original reference    | 640 × 512  | 0.400000 mm |    0.800000 mm |
| Example inherited target loader | 512 × 410  | 0.700000 mm |    0.700000 mm |

The actual resampled pixel-center origin also shifts approximately +0.050000 mm in the row direction and +0.099512 mm in the column direction, while stored provenance still records the original origin.

This affects physical measurements, overlay registration, interpretation of output pixels, hydration, and backup restoration.

Required correction: one explicit immutable output-plane grid must own dimensions, both spacings, pixel-center origin, directions, reference frame of reference, field of view, and interpolation provenance.

### A08. Through-plane interpolation fabricates unsupported anatomy

Classification: statically demonstrated by the current bracketing algorithm.

Dense-frame selection uses a median acquired-spacing guard:

- frontend/src/utils/svr/longitudinalFrames.ts:183.

Resampling then interpolates between any two neighboring acquired center depths without checking whether their physical support actually bridges the gap:

- frontend/src/utils/svr/longitudinalRegistration.ts:429.

For acquired center depths:

```text
0 mm, 1 mm, 2 mm, 25 mm, 26 mm
```

a requested plane at 13.5 mm can be synthesized by interpolating across a 23 mm hole. The current coverage calculation can still report that the resulting image is fully supported.

Slice center spacing is not equivalent to slice thickness: the supplied sagittal MRI has 0.6 mm center spacing and 1.2 mm thickness.

Required correction: report per-pixel acquired support, actual bracket depths, local spacing, source-slice thickness/profile, and unsupported gaps. Never count interpolation across a physically unjustified gap as acquired anatomy.

### A09. Geometry reliability is weaker than its name suggests

Classification: statically demonstrated.

The current frame manifest considers geometry reliable when stored per-frame depth values are finite:

- frontend/src/utils/localApi.ts:426.

Depth values are initially computed against each frame's own normal:

- frontend/src/services/dicomIngestion.ts:154.

Ingestion checks normal agreement but does not require complete row/column basis agreement:

- frontend/src/services/dicomIngestion.ts:443.

A 90° in-plane row/column rotation can preserve the same normal while representing a materially incompatible frame basis. Sparse 48-frame coarse selection can omit the problematic frame.

Required correction: validate every frame against one canonical stack basis and project all frame origins onto one canonical normal before ordering, grouping, and registration.

### A10. Coarse sampling and optimization cap achievable precision

Classification: statically demonstrated; magnitude depends on image geometry.

Frames are selected uniformly by array index, not physical depth:

- frontend/src/utils/svr/longitudinalFrames.ts:40.
- frontend/src/utils/svr/longitudinalFrames.ts:146.

The coarse reconstruction uses a world-axis-aligned isotropic grid capped around 96 dimensions:

- frontend/src/utils/svr/longitudinalRegistration.ts:323.
- frontend/src/utils/svr/longitudinalRegistration.ts:550.

The finest rigid search steps are 0.5 mm and 0.5°:

- frontend/src/utils/svr/rigidRegistration.ts:536.

For a 220 × 220 mm image, half a 0.5° angular step can create:

```text
corner distance = √(110² + 110²) mm
angular error   = 0.25°
corner error    = 0.679 mm
```

That exceeds the actual 0.4297 mm axial in-plane pixel spacing in the supplied MRI corpus. A 45° oblique 220 mm image can also occupy an approximately 311 mm world-axis-aligned bounding box, making a 96-cell isotropic coarse grid substantially coarser than the acquired in-plane data.

The target stack's reconstruction grid is additionally initialized with reference spacing:

- frontend/src/utils/svr/longitudinalRegistration.ts:591.

Required correction: sample frames by physical depth, retain anisotropic acquisition geometry, optimize multiple plausible seeds, and refine on a native-resolution stable-anatomy slab rather than merely using smaller steps on a coarse volume.

### A11. Pose ambiguity and inverse consistency are not genuinely tested

Classification: statically demonstrated and reproduced in A01.

The current 3D algorithm optimizes only the best initial seed:

- frontend/src/utils/svr/longitudinalRegistration.ts:644.
- frontend/src/utils/svr/longitudinalRegistration.ts:662.

The reported runner-up margin compares the optimized winner with unoptimized initial seeds:

- frontend/src/utils/svr/longitudinalRegistration.ts:682.

For a same-frame registration, the only seed can be identity. The mask-induced false rotation in A01 therefore reports its absolute score of 0.759667 as a supposed runner-up margin even though no independent optimized alternative was tested.

Forward/reverse NCC disagreement is recorded, but does not gate acceptance:

- frontend/src/utils/svr/longitudinalRegistration.ts:721.

This score disagreement is not independently optimized geometric inverse consistency.

Required correction: compare distinct optimized hypotheses, inspect local pose perturbations, preserve an explicit same-frame identity hypothesis, and independently estimate the reverse transform before claiming inverse consistency.

### A12. The existing confidence values are not clinical probabilities

Classification: explicitly documented by the current implementation.

Current gates include:

- A 0.55 support threshold.
- A 0.000001 variance threshold.
- A 2 mm slice-rival distinction.
- Numerical distinguishability floors based on pixel/sample counts.

See frontend/src/utils/alignmentConfidence.ts:12 and frontend/src/utils/svr/longitudinalRegistration.ts:682.

Interpolation, neighboring voxels, slices, and repeated examinations are correlated. The optimistic independent-sample formula is not a clinically calibrated probability.

Required correction: report raw evidence and explicit rejection reasons until independently blinded, patient-disjoint calibration supports a specific probability claim.

## 3. Architectural invariants

Every implementation phase must preserve the following:

1. No patient, examination, or frame-of-reference identity is inferred from image appearance.
2. Absolute coordinates from distinct frames of reference are never compared without an accepted transform.
3. DICOM image position identifies a pixel center, not a pixel-footprint corner.
4. DICOM orientation's first direction advances the column index; its second direction advances the row index.
5. Row and column spacing remain independent throughout every transform.
6. Native slice center spacing, acquired slice thickness, and requested output spacing are distinct facts.
7. Pixel intensity, anatomical validity, user exclusion, and interpolation support are separate representations.
8. An excluded or padded pixel cannot become a legitimate zero-valued anatomical sample.
9. A real zero-valued or negative-valued anatomical sample cannot be discarded merely because its intensity is nonpositive.
10. The selected output lattice is immutable throughout one alignment operation.
11. The registration analysis lattice and presentation output lattice are separate, explicitly related facts.
12. An upsampled display pixel never implies superior acquired anatomical resolution.
13. Unsupported anatomy is visibly unsupported; it is never filled by a hidden fallback.
14. Registration remains rigid unless a separately validated future product requirement explicitly changes that contract.
15. Lesion appearance and true longitudinal change remain visible in the final presentation.
16. Every accepted result is validated against the live patient, dataset revision, sequence, reference image, output grid, and target identity before application.
17. No confidence probability is shown without patient-disjoint calibration.
18. Protected MRI pixels, names, dates, UIDs, and exact source paths never appear in committed fixtures, logs, screenshots, or reports.

## 4. Authoritative data contracts

### 4.1 Validated acquisition geometry

One immutable stack contract owns per-frame physical truth:

```ts
type StackGeometry = {
  patientKey: string;
  studyUid: string;
  seriesUid: string;
  frameOfReferenceUid: string;
  rowDirection: [number, number, number];
  columnDirection: [number, number, number];
  normalDirection: [number, number, number];
  frames: Array<{
    sopInstanceUid: string;
    physicalFrameIndex: number;
    pixelCenterOriginMm: [number, number, number];
    rowSpacingMm: number;
    columnSpacingMm: number;
    rows: number;
    columns: number;
    depthAlongCanonicalNormalMm: number;
    sliceCenterSpacingBeforeMm?: number;
    sliceCenterSpacingAfterMm?: number;
    sliceThicknessMm?: number;
    pixelPaddingValue?: number;
    pixelPaddingRangeLimit?: number;
    validityFlags: string[];
  }>;
  depthGaps: Array<{
    beforeIndex: number;
    afterIndex: number;
    distanceMm: number;
    expectedLocalDistanceMm: number;
    supported: boolean;
  }>;
};
```

This is a target contract, not a commitment to create an additional independent cache or duplicate the existing manifest. Extend or replace the current SeriesFrameManifest if that is the smallest coherent implementation.

Validate every frame before labeling a stack geometrically trustworthy:

- Patient, examination, series, and frame-of-reference ownership.
- Finite pixel-center image position.
- Unit-length, mutually orthogonal DICOM row and column directions.
- A consistent right-handed normal.
- Row and column basis agreement across the complete stack.
- Strictly positive independent row and column spacing.
- Explicitly supported per-frame dimensions and spacing changes.
- All center depths projected onto one canonical normal.
- Duplicate or nearly duplicate physical positions.
- Local center-spacing variation and unsupported acquisition gaps.
- Ordering independent of Instance Number.
- Slice thickness retained separately from center spacing.
- No silently combined temporal, echo, orientation, or acquisition variants.

If the complete stack cannot satisfy the chosen geometry contract, return an explicit incompatible-geometry outcome rather than treating finite positions as sufficient.

### 4.2 Explicit native-pixel validity

Decoded anatomy should carry value and support independently:

```ts
type ValidatedPixelPlane = {
  values: Float32Array;
  valid: Uint8Array;
  fractionalSupport?: Float32Array;
  rows: number;
  columns: number;
  rowSpacingMm: number;
  columnSpacingMm: number;
  pixelCenterOriginMm: [number, number, number];
  sourceSopInstanceUid: string;
};
```

Evaluate declared DICOM padding in the stored pixel domain, before applying slope/intercept and before any spatial averaging. A missing padding declaration must not make zero or negative anatomical values invalid automatically.

For interpolation:

```text
value_out   = sum(weight_i × valid_i × value_i)
              / sum(weight_i × valid_i)

support_out = sum(weight_i × valid_i)
              / sum(weight_i)
```

If the valid-weight denominator is zero, the destination sample is invalid. The validity of a descriptor, gradient, phase window, NCC sample, reconstruction voxel, or presentation pixel must incorporate every contributing source footprint.

### 4.3 One explicit output-plane grid

The target output representation is:

```ts
type OutputPlaneGrid = {
  version: 1;
  referencePatientKey: string;
  referenceStudyUid: string;
  referenceSeriesUid: string;
  referenceSopInstanceUid: string;
  referenceFrameOfReferenceUid: string;
  pixelCenterOriginMm: [number, number, number];
  rowDirection: [number, number, number];
  columnDirection: [number, number, number];
  rowSpacingMm: number;
  columnSpacingMm: number;
  rows: number;
  columns: number;
  rowFieldOfViewMm: number;
  columnFieldOfViewMm: number;
  mode:
    | "reference-native"
    | "fixed-square"
    | "longest-edge"
    | "physical-isotropic";
  requestedResolution?: number;
  requestedSpacingMm?: number;
  acquiredReferenceSpacingMm: [number, number];
  acquiredTargetSpacingMm?: [number, number, number];
  isUpsampled: boolean;
  interpolationKernel: "validity-aware-linear" | "validity-aware-lanczos";
};
```

The user selects the grid once per run. Registration search may use smaller analysis grids, but final presentation, image-loader spacing, physical measurements, overlays, persistence, hydration, export, and debug evidence must all derive from this one object.

Never retain separate competing “original reference spacing,” “target source spacing,” and “actual output spacing” as though each describes the derived image. Original source geometries remain provenance, not output-lattice authorities.

## 5. Output-grid selection and exact physical arithmetic

### 5.1 Supported modes

The minimum meaningful options are:

1. Reference native: identical rows, columns, pixel-center origin, directions, and row/column spacing to the selected source frame.
2. Fixed square: an exact user-selected 256 × 256, 512 × 512, or 1024 × 1024 output lattice.
3. Longest edge: an exact selected maximum dimension while preserving the reference matrix aspect and full physical field.
4. Physical isotropic: a user-selected spacing in millimeters with derived rectangular dimensions and a clearly disclosed bounded edge adjustment.

The default is reference native whenever that choice satisfies the explicit memory budget.

A fixed square image does not imply isotropic physical spacing. A rectangular physical field represented by 512 × 512 pixels necessarily has different row and column spacings.

### 5.2 Pixel-footprint preservation

For each independent image axis:

```text
native physical footprint = native sample count × native sample spacing

output sample spacing
    = native sample count × native sample spacing
      / requested output sample count

output first pixel-center offset
    = ((native sample count / requested sample count) - 1)
      × native sample spacing / 2
```

Apply the row offset in the DICOM second orientation direction and the column offset in the DICOM first orientation direction.

The full output origin is:

```text
origin_out
    = origin_native
      + column_direction × row_center_offset_mm
      + row_direction × column_center_offset_mm
```

The existing centered downsampling helper already expresses the corresponding convention: frontend/src/utils/svr/dicomGeometry.ts:77.

### 5.3 Worked anisotropic example

Reference:

```text
rows                = 640
columns             = 512
row spacing         = 0.4 mm
column spacing      = 0.8 mm
row field of view   = 256.0 mm
column field of view = 409.6 mm
```

Correct output grids:

| Requested mode                 | Output dimensions | Row spacing | Column spacing | Origin shift             |
| ------------------------------ | ----------------- | ----------: | -------------: | ------------------------ |
| Reference native               | 640 × 512         | 0.400000 mm |    0.800000 mm | 0 / 0 mm                 |
| Fixed 256                      | 256 × 256         | 1.000000 mm |    1.600000 mm | +0.300000 / +0.400000 mm |
| Fixed 512                      | 512 × 512         | 0.500000 mm |    0.800000 mm | +0.050000 / 0 mm         |
| Fixed 1024                     | 1024 × 1024       | 0.250000 mm |    0.400000 mm | -0.075000 / -0.200000 mm |
| Existing implicit longest edge | 512 × 410         | 0.500000 mm |    0.999024 mm | +0.050000 / +0.099512 mm |

The 1024 output is spatial interpolation, not a new 0.25 mm acquisition. It must retain and expose the actual 0.4/0.8 mm native sampling limits.

For physical-isotropic output, choose one requested spacing, derive dimensions from the two physical fields, and either:

- Preserve the original field exactly with separately disclosed effective row/column spacing after integer rounding.
- Or preserve exact isotropic spacing while disclosing and bounding any added/cropped physical border to at most half an output pixel per edge.

Do not silently stretch anatomy to satisfy both incompatible constraints.

### 5.4 Upsampling edges

The first and last native pixel centers are not the boundaries of acquired image support. The physical footprint spans approximately:

```text
native sample coordinates in [-0.5, sample_count - 0.5]
```

For requested output centers inside that footprint but outside the first/last native center:

- Accept the sample only while it remains inside the true footprint.
- Clamp interpolation to the nearest acquired edge center.
- Preserve its validity/support provenance.
- Do not extrapolate outside the acquired field.

The current bilinear sampler rejects these physically valid upsampled edge centers: frontend/src/utils/svr/longitudinalRegistration.ts:382.

### 5.5 Explicit resolution and memory limits

Replace hidden 512-pixel clamping and the implicit 512² persistence rejection with explicit checked limits:

- Validate requested dimensions before allocation.
- Bound the output pixel count, pixel bytes, validity bytes, and total retained derived-frame bytes.
- Keep the existing bounded derived-frame retention policy.
- Support 1024 × 1024 output only when the whole live/worker/storage budget permits it.
- Explain an unsupported preset visibly; never silently substitute a smaller output.
- Never materialize a 1024 × 1024 × 1024 volume to present a 1024 × 1024 plane.

Raw Float32 presentation data costs:

```text
256 × 256    = 0.25 MiB
512 × 512    = 1.00 MiB
1024 × 1024  = 4.00 MiB
```

Twelve retained 1024 × 1024 Float32 planes require 48 MiB before validity masks, metadata, IndexedDB overhead, or source-frame working sets.

Ninety-six native 1024 × 1024 Float32 source planes would require 384 MiB. A valid implementation must stream, tile, or reject such a request; it must not allocate the whole stack opportunistically.

## 6. Physical mode selection and target anchoring

### 6.1 Decide 2D versus 3D on the actual requested plane

For the selected OutputPlaneGrid:

1. Compute the world-space center of the complete pixel footprint.
2. Compute all four world-space footprint corners.
3. Compare each corner with the target acquisition plane or the currently verified frame relationship.
4. Project displacement along the target acquisition normal.
5. Use the largest absolute corner displacement.
6. Compare against the local target acquired-center spacing and explicitly defined through-plane support.

Require 3D rigid registration and direct plane reslicing when:

- The examinations use distinct frames of reference.
- Any frame relationship is unverified.
- Any corner exceeds the acceptable physical through-plane mismatch.
- The target output center is not representable safely by one native target slice.
- Stack basis, FOV, or acquired support requires a plane synthesized from multiple native target slices.

The conservative threshold may begin around half the local center spacing, but its final value is an engineering policy that requires validation on the benchmark matrix.

### 6.2 Choose a representative target image correctly

After the target-to-reference rigid transform is accepted:

1. Compute the physical center of the selected output plane.
2. Apply the inverse accepted rigid transform.
3. Project that point onto the target stack's canonical normal.
4. Find the nearest acquired target center depth.
5. Preserve its SOP identity solely as the navigation/representative image.
6. Record every distinct target SOP that contributes actual interpolation support.

Never minimize a laterally shifted target image center against the reference normal; those are not equivalent geometry problems for cropped, oblique acquisitions.

## 7. Validity, exclusion, and intensity normalization

### 7.1 Native validity is not an intensity threshold

Ingest and retain:

- Pixel Padding Value when present.
- Pixel Padding Range Limit when present.
- Stored pixel representation and signedness.
- Modality slope and intercept.
- Relevant photometric polarity.
- The exact original pixel footprint.

Build the native support mask in stored-value coordinates before any modality transform.

If no authoritative padding metadata is available:

- Keep finite zero and negative image samples valid by default.
- Estimate an optional anatomical foreground separately from pixel validity.
- Never silently declare all zero or negative samples to be padding.
- Refuse an objective that cannot distinguish anatomical support from a dominating padded canvas.

### 7.2 Normalize after support and exclusion are known

Compute robust modality-linear intensity statistics over:

```text
valid acquired anatomy
    ∩ physically supported comparison domain
    ∩ stable-anatomy mask
    ∖ user exclusion
```

Requirements:

- Additive intercepts must not change anatomical support.
- Positive multiplicative scaling must not change anatomical support.
- Negative/zero valid anatomy must remain eligible when physically meaningful.
- Excluded pathology must not determine histogram percentiles.
- Padding must never enter normalization or confidence statistics.
- Empty or structurally flat usable support must produce an explicit ambiguous/insufficient-evidence outcome.

### 7.3 Pair exclusion support across both acquisitions

Represent the user exclusion as a physical mask on the chosen reference plane. For each candidate rigid pose:

1. Dilate the mask by the actual interpolation, descriptor, gradient, and slice-profile footprint at that analysis scale.
2. Map candidate target sample positions into reference space.
3. Exclude target samples whose mapped support intersects the reference mask.
4. Exclude the same reference samples in the reverse objective.
5. Use validity masks, not zero-filled intensities.
6. Recompute support denominators on the same stable-anatomy domain.

For a 2D user rectangle with unknown through-plane lesion extent, conservatively exclude the corresponding physical cylinder through the evaluated stable-anatomy slab unless a verified 3D lesion mask supplies narrower support.

The final target presentation remains unmasked. Exclusion changes registration evidence only; it must not erase, overwrite, or cosmetically normalize the actual lesion.

## 8. Registration algorithm

### 8.1 Run-scoped reference preparation

Prepare one immutable reference representation per Align All run:

- Validated physical frame manifest.
- Selected output grid.
- Native reference pixel validity.
- Physically meaningful stable-anatomy mask.
- Lesion exclusion at each analysis scale.
- Reference-oriented coarse pyramid.
- Reference coarse occupancy/support.
- Native-resolution local refinement slab.
- Physical landmark/edge sample distribution.

Currently up to 48 reference slices can be decoded and reconstructed again for each target date:

- frontend/src/hooks/useAutoAlign.ts:403.
- frontend/src/utils/svr/longitudinalFrames.ts:146.
- frontend/src/utils/svr/longitudinalRegistration.ts:535.

Reuse is valid only within the immutable run/patient/reference/revision/grid scope. A shared cache without explicit ownership and cancellation would create a second authority and must not be introduced.

### 8.2 Physically stratified stack sampling

Select bounded coarse samples by physical depth rather than array index:

- Include the first and last valid acquired depth.
- Include the selected reference plane and its immediate acquired neighbors.
- Stratify remaining samples over actual occupied millimeters.
- Preserve boundaries of each detected unsupported gap.
- Preserve the target region physically relevant to the chosen output field.
- Weight anatomical structure and support, not scanner background.
- Expose the exact selected source SOPs and their acquired depths.

For irregular spacing, a region containing many densely acquired frames must not consume the whole coarse budget while a distant region containing clinically relevant anatomy receives no samples.

### 8.3 Physically plausible initial hypotheses

Generate a bounded deterministic set of hypotheses:

1. Identity, mandatory for verified same-frame acquisitions.
2. User- or operation-provided validated rigid initialization.
3. Stable-anatomy center alignment, if the frame relationship requires it.
4. Acquisition-basis rotation with physically justified translation.
5. Small independent perturbations around plausible ambiguous modes.
6. Optional scanner/protocol-specific priors only when independently validated.

Reject initialization that depends on comparing unrelated absolute frame origins.

Do not let an automatically estimated FOV center overwrite verified same-frame geometry.

### 8.4 Symmetric stable-anatomy coarse objective

For each candidate rigid transform:

```text
forward evidence
    = robust structural agreement on valid target samples
      mapped into supported, nonexcluded reference anatomy

reverse evidence
    = robust structural agreement on valid reference samples
      mapped into supported, nonexcluded target anatomy

supported agreement
    = symmetric combination of forward and reverse evidence
      penalized for missing required anatomical support
```

The initial implementation can reuse existing fixed-domain NCC, NGF, and MIND infrastructure when it preserves one coherent domain. A new learned model is not required.

The score must:

- Exclude padding and declared lesion support in both directions.
- Preserve true physical overlap rather than rewarding cropped support.
- Normalize by the physically feasible stable-anatomy domain.
- Preserve partially overlapping acquisitions when the chosen output plane and required reference anatomy are fully supported.
- Reject dominant background, flat images, orientation ambiguity, and repeated anatomy.
- Report forward and reverse support independently.
- Use robust local/structural evidence when acquisition gain, contrast, or bias field differs.

The existing global 0.55 bidirectional volume-overlap threshold is not a universal accuracy policy. A legitimate cropped follow-up may overlap less than 55% of the entire acquisition while completely supporting the requested plane and anatomical ROI.

### 8.5 Bounded multi-start optimization

Optimize the best small set of physically distinct hypotheses, not only the initially highest scoring seed.

Each optimized hypothesis must retain:

- Its initial pose.
- Its independently optimized pose.
- Physical translation and rotation.
- Per-region stable-anatomy support.
- Forward and reverse evidence.
- Output-plane coverage.
- Exclusion/padding footprint.
- Objective curvature or local perturbation evidence.

The competing runner-up must be another materially distinct optimized hypothesis. An unoptimized starting pose or a missing competitor cannot become a fictitious confidence margin.

### 8.6 Native-resolution local refinement

After coarse registration:

1. Construct the physically relevant stable-anatomy slab around the requested output plane.
2. Decode only acquired frames required by that slab.
3. Evaluate native or appropriately bounded near-native in-plane anatomy.
4. Reuse the same validity/exclusion domain and accepted coarse pose.
5. Refine all six rigid degrees of freedom with physically scaled steps.
6. Test smaller local translations and rotations only when the native sampling actually supports them.
7. Verify that final refinement improves held-out stable anatomy, not just its own optimization samples.

Engineering starting points may include approximately 0.1 mm translation and 0.05° angular probes, but these are hypotheses rather than clinical guarantees. Fine steps on an unchanged 96-cell coarse volume do not create native-resolution accuracy.

A correct optimizer must recover all six rigid parameters, not only the x translation currently checked by the existing exclusion regression.

### 8.7 Independent inverse and cycle checks

For sufficiently informative acquisitions:

- Estimate the reverse registration independently.
- Compose forward and reverse physical transforms.
- Measure the resulting displacement on distributed reference landmarks and output corners.
- Inspect forward versus reverse anatomical support and score agreement.
- Preserve the distinct same-frame identity hypothesis.
- Optionally evaluate A → B → C → A consistency for three examinations without forcing biological anatomy to become identical.

The existing inverseScoreGap is only a difference between two correlation scores. It is not an inverse-transform displacement and must not be labeled as inverse geometric accuracy.

## 9. Acceptance and confidence policy

### 9.1 Independent acceptance gates

An alignment is applied only when every required gate passes:

1. Verified patient, acquisition, and frame identity.
2. Reliable complete-stack and selected-output geometry.
3. Sufficient valid stable-anatomy support.
4. Adequate support in both registration directions.
5. Adequate support on the actual output plane and required lesion neighborhood.
6. Sufficient absolute structural agreement.
7. A materially distinct optimized rival does not explain the anatomy comparably well.
8. No unsupported through-plane interpolation is required.
9. Phase correction has valid support and an independently distinguishable peak when used.
10. Forward and independently estimated reverse poses are consistent.
11. The result remains bound to the active operation, patient, revision, sequence, reference SOP, and output grid.

Failure of any required gate preserves the previous visible and durable settings.

### 9.2 Evidence is not probability

Expose a structured evidence object:

```ts
type AlignmentEvidence = {
  geometryMode: "physical-2d" | "registered-3d";
  absoluteStructuralAgreement: number;
  signedGradientAgreement: number;
  optimizedRunnerUpGap: number | null;
  forwardAnatomicalSupport: number;
  reverseAnatomicalSupport: number;
  outputPlaneSupport: number;
  requiredRegionSupport: number;
  effectiveIndependentSamples: number;
  inverseLandmarkErrorMm?: number;
  phasePeakToSidelobeRatio?: number;
  translationMm: [number, number, number];
  rotationDegrees: [number, number, number];
  outputGridFingerprint: string;
  rejectionReason?: string;
};
```

Numerical cutoffs begin as explicitly provisional engineering policies. Any displayed probability or risk percentage requires:

- A clinician-defined failure endpoint.
- Patient-disjoint labeled calibration data.
- Locked calibration parameters.
- Independent held-out calibration evaluation.
- Documented confidence intervals and relevant subgroup behavior.

### 9.3 Effective anatomical sample size

Do not treat every interpolated pixel as independent.

Estimate information content from:

- Independent acquired slice centers.
- Native row and column spacing.
- Interpolation footprint.
- Descriptor/gradient neighborhood size.
- Local spatial autocorrelation.
- Stable-anatomy connected components.
- Excluded and padded regions.

Use spatial block resampling or another justified correlated-sample method when estimating numerical uncertainty. This remains an engineering evidence measure until validated against clinician labels.

### 9.4 Low-support and ambiguous outcomes

Distinguish at least:

- Invalid acquisition geometry.
- Different or uncertain patient identity.
- Unsupported output field.
- Unsupported acquisition gap.
- Insufficient stable anatomy.
- Weak absolute anatomical agreement.
- Competing optimized rigid poses.
- Forward/reverse inconsistency.
- Weak or boundary-clipped phase evidence.
- Exclusion removing too much comparison support.
- Explicit resolution or memory limit.
- Cancellation or stale operation.

Each outcome must explain the practical problem without exposing protected acquisition identifiers.

## 10. Direct, physically supported final resampling

### 10.1 Sampling contract

For every output pixel:

1. Convert its row and column to an exact world-space pixel center on OutputPlaneGrid.
2. Apply the inverse accepted target-to-reference rigid transform.
3. Project onto the canonical target normal.
4. Find physically adjacent acquired source centers.
5. Verify that the requested depth lies within supported acquired slice footprints.
6. Reject or mark invalid any physically unjustified acquisition gap.
7. Interpolate in-plane using explicit valid source pixel weights.
8. Interpolate through-plane only across physically justified local support.
9. Record fractional support, source depth, interpolation fraction, and contributing SOP identities.

The output carries:

```ts
type RegisteredPlane = {
  grid: OutputPlaneGrid;
  pixels: Float32Array;
  valid: Uint8Array;
  fractionalSupport: Float32Array;
  targetToReferenceRigid: {
    translationMm: [number, number, number];
    rotationRadians: [number, number, number];
    rotationCenterMm: [number, number, number];
  };
  representativeTargetSopUid: string;
  contributingTargetSopUids: string[];
  acquiredCenterDepthsMm: number[];
  acquiredSliceThicknessMm?: number[];
  effectiveAcquiredResolutionMm: [number, number, number];
};
```

### 10.2 Interpolation modes

The default should be validity-aware linear interpolation:

- In-plane bilinear interpolation over valid acquired support.
- Through-plane linear interpolation only between physically supported acquired neighbors.
- Optional higher-order in-plane interpolation only when its complete support is valid and overshoot/ringing does not distort lesion boundaries.
- Area-weighted, validity-aware filtering when the selected output grid is coarser than native data.

Lanczos or other sharper interpolation must not:

- Cross missing support.
- Mix declared padding into tissue.
- Create ringing interpreted as a lesion.
- Claim new detail below the acquired sampling resolution.
- Change the output physical field or pixel-center origin.

### 10.3 Gap and slice-profile policy

Evaluate:

- Actual adjacent center distance.
- Robust local expected center spacing.
- Declared slice thickness and any known slice-profile support.
- Whether neighboring slice footprints overlap, meet, or leave a gap.
- The physical distance from the requested sample to genuine acquired centers.

Examples:

- 0.6 mm center spacing with 1.2 mm slice thickness is overlapping acquired support.
- A 23 mm gap between otherwise 1 mm centers is not valid support.
- 3 mm center spacing with 1 mm slice thickness contains a true unsupported interval unless an independently justified acquisition model says otherwise.

Unsupported samples remain invalid. If the invalid region affects the requested stable anatomy or lesion neighborhood, the alignment must be rejected rather than displayed as complete.

### 10.4 Coverage categories

Report separately:

1. Raw output-grid geometric coverage.
2. Acquired valid-pixel support.
3. Stable-reference-anatomy coverage.
4. Required central/landmark-region coverage.
5. Lesion-neighborhood presentation coverage.
6. Forward registration support.
7. Reverse registration support.

Shared black canvas, excluded pixels, and unsupported acquisition gaps are not anatomical coverage.

## 11. Physically correct same-frame 2D alignment

When the corner-based geometry policy proves that one native target slice is sufficient:

1. Choose candidates by physical millimeter depth, not only index distance.
2. Build a common physically calibrated analysis grid.
3. Preserve independent row and column spacing for rectangular acquisitions.
4. Apply valid-pixel and user-exclusion masks before feature extraction.
5. Use phase correlation only as a bounded translation proposal.
6. Require sufficient phase support, a non-boundary peak, and a meaningful peak-to-sidelobe relationship.
7. Score aligned candidates with existing MIND/NGF/local structural evidence.
8. Evaluate a small physically diverse shortlist at higher resolution.
9. Require a meaningful absolute structure floor and a physically distinct runner-up comparison.
10. Optionally compare neighboring reference/target planes when acquired support justifies limited 2.5D context.
11. Preserve rigid physical meaning; reject a cosmetic affine transform that invents anisotropic anatomical deformation.

Current square 256 × 256 capture disregards physical matrix aspect and independent pixel spacing:

- frontend/src/utils/cornerstoneSliceCapture.ts:125.

Elastix spacing is currently supplied as an isotropic image-space convention:

- frontend/src/utils/elastixRegistration.ts:188.

The target implementation must either pass actual spacing into the optimizer or explicitly transform both images onto one documented physical analysis lattice before registration.

Descriptor offsets, maximum phase correction, ROI dilation, and transform bounds should be defined in millimeters and converted to the selected analysis lattice.

## 12. Derived-image integration and durability

### 12.1 Runtime image loader

The derived Cornerstone image must explicitly own:

- Output rows and columns.
- Output rowPixelSpacing and columnPixelSpacing.
- Output image position and orientation.
- Output frame of reference.
- The exact output support/validity semantics.
- The target intensity samples.
- The representative target source identity as provenance only.

Do not inherit physical spacing from the target image through an unrestricted object spread.

### 12.2 Durable record and compatibility

Extend the existing derived-frame record only as needed to preserve:

- The complete versioned OutputPlaneGrid.
- Reference source image identity.
- Target representative source identity.
- Ordered contributing source SOP identities and acquired depths.
- The accepted rigid transform and rotation center.
- The relevant support and evidence values.
- Patient, examination, sequence, and dataset-revision ownership.
- Algorithm and calibration versions.

For older records without an explicit output grid:

1. Reconstruct geometry only when original reference metadata and output dimensions prove that the grid is identical to native reference geometry.
2. Otherwise preserve the stored record but withhold its presentation and explain that realignment is needed.
3. Never guess output spacing from target source metadata.
4. Keep older backups readable without treating incomplete physical provenance as verified.

### 12.3 Output preference and cache identity

The selected output preset is an operation parameter, not an independent alignment authority.

Derived-frame cache identity must distinguish physically different output grids when necessary while preserving:

- One live patient/revision scope.
- Existing cancellation and stale-result protection.
- The bounded 12-plane policy.
- Correct undo grouping.
- Honest persistence-quota errors.

## 13. User-visible interaction

Keep the product surface minimal:

- A default “Reference resolution” output mode.
- An advanced output-resolution control exposing physically labeled presets.
- An explicit “Interpolated from lower-resolution acquisition” indicator when applicable.
- Per-target outcomes such as aligned, uncertain, insufficient anatomical support, or incompatible geometry.
- A concise rejection explanation.
- Optional advanced inspection of rigid shift/rotation, valid support, and acquisition versus presentation spacing.
- Existing lesion-exclusion editing without introducing automatic unverified lesion detection.
- Optional ghost/checkerboard comparison for an already accepted result.

The viewer must never present:

- A misleading confidence percentage without validated calibration.
- A requested 1024-pixel image as a 1024-sample physical acquisition when the source was 512 pixels.
- A cosmetically filled unsupported target region.
- A new aligned state when the previous result failed one required gate.

## 14. Deterministic engineering benchmark

### 14.1 Synthetic dataset design

Generate protected-data-free signed 16-bit analytical phantoms with:

- Asymmetric stable anatomy.
- Distributed internal and peripheral landmarks.
- Independent changing or newly appearing lesions.
- Known six-degree-of-freedom target-to-reference transforms.
- Authentic DICOM image position/orientation and frame-of-reference relationships.
- Known separate row spacing, column spacing, center spacing, and slice thickness.
- Declared padding values/ranges and explicit valid anatomical support.
- Known full-resolution analytic output-plane values.

Every fixture records generator version, seed, true transform, true landmarks, true validity mask, and exact physical acquisition geometry.

### 14.2 Mandatory challenge matrix

The deterministic corpus must cover:

| Failure axis       | Required cases                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- |
| Identity           | Same-frame, no exclusion; same-frame with central and eccentric exclusions          |
| Rigid motion       | Independent x/y/z translation; independent x/y/z rotation; compound motion          |
| Plane tilt         | 1° diagonal threshold case; 18.050° real-corpus-like tilt; compound obliquity       |
| Matrix shape       | Square; 320 × 512; 512 × 384; 640 × 512; large native dimensions                    |
| Pixel spacing      | Isotropic; 0.4/0.8 mm; 0.4/0.9 mm; row/column reversal                              |
| Slice geometry     | Reversed order; irregular centers; 0.6 mm centers with 1.2 mm thickness             |
| Acquisition gaps   | Duplicate depth; missing local center; 23 mm unsupported hole                       |
| Frame relationship | Same verified frame; distinct frame; missing/unverified frame                       |
| Frame basis        | Same normal with 90° in-plane basis rotation                                        |
| Background         | Zero anatomy; negative anatomy; padding value; padding range                        |
| Modality transform | Positive intercept; negative intercept; positive gain                               |
| Exclusion          | 5 × 5 central lesion; eccentric lesion; changing lesion intensity                   |
| FOV                | Partial valid overlap; 40 mm lateral crop offset; unsupported lesion neighborhood   |
| Search ambiguity   | Symmetric anatomy; repeated structures; equally plausible optimized poses           |
| Phase evidence     | Flat domain; boundary peak; weak peak-to-sidelobe ratio                             |
| Output lattice     | Native; fixed 256; fixed 512; fixed 1024; longest-edge; isotropic-mm                |
| Persistence        | Restart; hydration; backup/restore; old record without trusted grid                 |
| Safety             | Wrong patient; stale revision; mixed frame; cancellation; oversized allocation      |
| Browser            | Approved synthetic compressed DICOM import, rendering, worker execution, and reload |

### 14.3 Exact red regressions required before implementation

Add focused failing tests for:

1. Mask-induced 19³ identical-scan rotation; assert all translation and rotation axes.
2. Absolute structural score 0.020 incorrectly accepted.
3. Positive +1000 intercept turning 4 valid foreground pixels into 16.
4. Declared -2000 padding averaged into an incorrect -950 value.
5. Diagonal 1° tilt incorrectly remaining on the 2D path.
6. 18° obliquity plus 40 mm lateral crop selecting a target index about 13 slices away.
7. 640 × 512 at 0.4/0.8 mm producing contradictory actual/persisted/loader spacing.
8. A requested depth between 2 mm and 25 mm falsely counted as valid.
9. Same-normal 90° rotated row/column axes being labeled reliable.
10. A distinct optimized pose losing its ambiguity challenge because only raw seeds were compared.
11. Legitimate zero/negative anatomy being discarded as unsupported.
12. 1024 output edge centers inside the native pixel footprint being rejected.

The tests must fail against the reviewed revision for the stated reason and pass only after its corresponding contract is repaired.

## 15. Physical accuracy metrics

### 15.1 Landmark target-registration error

For independently labeled corresponding target/reference points:

```text
TRE_i
    = Euclidean distance in millimeters between:
      transform(target_landmark_i)
      and reference_landmark_i
```

Report:

- Median, p90, p95, and maximum TRE.
- Separate per-patient summaries.
- Physical row-direction error.
- Physical column-direction error.
- Through-plane target-normal/reference-normal error.
- Center versus peripheral-field error.
- Performance under each output grid.
- Patient-cluster confidence intervals.

Never report pixel error without specifying both physical spacings.

### 15.2 Through-plane and in-plane decomposition

```text
through-plane error
    = absolute projection of landmark residual on the reference normal

in-plane error
    = norm of residual after removing its reference-normal component
```

Report through-plane error alongside the local actual acquired center spacing and slice thickness. A 0.25 mm output grid does not justify a 0.25 mm through-plane accuracy claim for 5 mm acquired slices.

### 15.3 Rigid-pose accuracy

Measure:

- Translation error in millimeters.
- Rotation geodesic error in degrees.
- Worst and p95 landmark displacement induced by the estimated rigid pose.
- Right-handedness and positive rotation determinant.
- Physical corner displacement on the actual output grid.
- Independently optimized inverse-composition error.
- Optional three-examination cycle inconsistency.

### 15.4 Anatomical masks and lesion fidelity

For independently authored masks:

- Stable-anatomy Dice overlap.
- Symmetric 95th-percentile Hausdorff distance in millimeters.
- Explicit anisotropic voxel spacing for every surface-distance calculation.
- Separate lesion-signal retention.
- Lesion-neighborhood support.
- Lesion contour Dice/HD95 only where biological comparability is valid.
- Explicit behavior for empty masks and newly appearing lesions.

A changing lesion must remain visible; registration must not optimize its disappearance.

### 15.5 Candidate-search quality

Compare against a bounded exhaustive engineering oracle:

- True physical correspondence included in the search window.
- Top-1 and top-K slice/pose recall.
- Shortlist recall for the physically correct candidate.
- Structural-score regret versus exhaustive search.
- Physical spacing sensitivity.
- Suppression of genuinely distinct versus nearly identical neighboring slices.
- Candidate-specific pose-refinement impact.

The exhaustive oracle is an evaluation instrument, not a requirement to evaluate every candidate in production.

### 15.6 Support and rejection quality

Report separately:

- Forward stable-anatomy support.
- Reverse stable-anatomy support.
- Required output-plane support.
- Lesion-neighborhood support.
- Invalid padding fraction.
- Unsupported-gap fraction.
- Exclusion footprint.
- Accepted precision.
- Catastrophic false-accept rate.
- Abstention rate and rejection reason.
- Patient- and subgroup-specific error bounds.

### 15.7 Calibration, if later justified

Only after a labeled patient-disjoint calibration cohort exists:

- Reliability curves.
- Expected calibration error with justified adaptive bins.
- Brier score.
- Risk-versus-coverage curves.
- Confidence intervals clustered by patient.
- Vendor, sequence, field-strength, pathology, spacing, and FOV subgroup behavior.

Until then, label all scores as uncalibrated structural evidence.

## 16. Human-labeled evaluation and privacy

### 16.1 Separate engineering and clinical evidence

Use three clearly different evidence tiers:

1. Deterministic synthetic correctness and exact geometric arithmetic.
2. The existing one-patient protected MRI smoke/challenge corpus.
3. Independently labeled, patient-disjoint clinical evaluation.

Tier 1 and tier 2 can demonstrate implementation correctness on their respective cases. Neither establishes clinician-level registration accuracy across patients.

### 16.2 Patient-level splits

An aspirational evaluation design is:

- Development: at least 30 independent patients.
- Calibration: at least 50 different independent patients.
- Locked internal holdout: at least 100 further independent patients.
- External-site challenge: at least 50 additional independent patients.

These are proposed feasibility targets, not existing data and not universally adequate safety-cohort sizes.

All dates, series, slices, and directed examination pairs for one patient belong to exactly one partition. Multiple slices or dates from one person never become independent patients.

Stratify by:

- Vendor and acquisition site.
- Sequence and contrast.
- Field strength when available.
- Pathology and true longitudinal lesion change.
- Native in-plane spacing.
- Slice center spacing versus acquired thickness.
- FOV overlap.
- Acquisition obliquity.
- Same versus distinct frame of reference.
- Padding, signedness, gain, and intercept.
- Compression and codec path.
- Motion, bias field, and noise.

A subgroup without enough independently represented patients remains underpowered; an aggregate pass does not erase that limitation.

### 16.3 Blinded annotation

Obtain, where appropriate:

- Two independent trained neuroradiology raters.
- Approximately 8–12 stable, distributed, noncoplanar landmarks per examination pair.
- Central and peripheral anatomical correspondences.
- Reference-plane correspondence labels.
- Separately authored lesion masks where appropriate.
- Visibility and uncertainty labels for each landmark.
- Independent adjudication for disagreements.
- Baseline intra-rater and inter-rater variability.

The clinical owner must specify the acceptable task-specific error before looking at holdout results. An algorithm output or an image-similarity score must not define its own ground truth.

### 16.4 Sample size and false reassurance

For independent accepted patients with zero observed catastrophic errors, an approximate one-sided 95% upper risk bound is:

```text
100 patients -> about 2.95%
299 patients -> about 1.00%
598 patients -> about 0.50%
```

These calculations do not apply to hundreds of correlated slices from one patient. Use patient-cluster bootstrap, hierarchical analysis, or another defensible clustered confidence method.

Actual release sample size depends on the predeclared allowable harm, expected acceptance rate, prevalence, annotation noise, and required subgroup guarantees.

### 16.5 Protected-data handling

- Keep source MRI files in the existing ignored protected fixture location.
- Do not commit DICOM, source filenames, names, exact dates, UIDs, or patient images.
- Do not upload protected MRI to a reviewer service, public preview, or third-party benchmark.
- Use nonreversible or salted patient/case aliases; keep any secret outside Git.
- Emit aggregate metrics, source-free errors, and approved synthetic imagery only.
- Do not create clinical screenshots from protected MRI for PR evidence.
- Use a separately approved synthetic or independently de-identified compressed DICOM for real-browser E2E.

## 17. Performance and resource contract

### 17.1 Distinguish measured baseline from targets

Existing single-case engineering observations:

```text
coarse rigid registration    ≈ 149 ms
dense acquired-frame decode  ≈ 9.6 ms
native 512² plane reslice    ≈ 17.3 ms
coarse worker transfer       = 4.34 MiB
representative native slab   ≈ 5 MiB
```

These are local harness measurements, not browser percentiles or promised service-level objectives.

### 17.2 Complexity expectations

The desired shape is:

```text
run-scoped reference setup:
    once per reference/patient/revision/grid scope

target registration:
    bounded physical samples × bounded optimized pose hypotheses

final presentation:
    output rows × output columns
    + physically contributing acquired source frames
```

Changing output resolution must not repeat coarse reference reconstruction or enlarge the registration search volume.

As a first-order pixel-work hypothesis, 1024² resampling may require approximately four times the 512² per-pixel work. A 17.3 ms representative 512² reslice would therefore suggest roughly 69 ms under otherwise identical conditions, but this is an unverified planning estimate, not a measured result.

### 17.3 Required measured dimensions

For each supported output grid and representative acquisition type:

- End-to-end wall time per examination.
- Cold versus warm compressed-DICOM decode time.
- Number of physical reference frames decoded per run.
- Number of target frames decoded per target.
- Registration-worker execution time.
- Final-resampling worker execution time.
- Worker-transfer bytes.
- Peak incremental browser heap.
- Main-thread long tasks.
- Cancellation latency.
- IndexedDB derived-plane bytes.
- Cache eviction behavior.
- Full source-frame decode/reconstruction repetitions.

### 17.4 Engineering performance gates

The initial engineering goals are:

- Reference stack/pyramid preparation occurs once per immutable run, not once per date.
- Coarse registration work remains independent of output resolution when inputs and pose policy are unchanged.
- Final plane work scales approximately with output pixels and truly contributing frames.
- Existing bounded worker cancellation and teardown remain intact.
- No interactive main-thread image-analysis task exceeds the agreed browser long-task budget.
- A 1024² output cannot allocate an unbounded 3D high-resolution volume.
- Every memory-limit rejection is explicit and preserves existing settings.
- The real 18.050° / 98.789% existing engineering case remains functional.

Suggested local targets such as less than 50 ms main-thread tasks or less than 100 ms cancellation are starting measurement goals. They become acceptance thresholds only after real-browser profiling establishes that they are appropriate.

## 18. Phased implementation plan

### Phase 0. Establish red tests and baseline evidence

Purpose: prove each current failure and separate already functioning behavior from proposed improvements.

Changes:

- Add deterministic regression cases for A01–A11.
- Extend the existing 19³ lesion test to assert tx, ty, tz, rx, ry, rz, support, and landmark displacement.
- Record the current positive/negative modality-intercept behavior.
- Add a declared-padding mixed-footprint resampling case.
- Add anisotropic output-loader geometry and backup round-trip cases.
- Add diagonal-tilt, 13-slice crop-offset, and 23 mm support-gap cases.
- Preserve the anonymized real-corpus smoke comparison as a separate engineering check.

Acceptance:

- Every new failure is reproduced for its stated reason.
- Existing full-suite behavior remains characterized.
- No protected patient pixels or identifiers enter source control.

### Phase 1. Make acquisition geometry and pixel validity authoritative

Dependencies: phase 0 regression evidence.

Primary boundaries:

- frontend/src/services/dicomIngestion.ts.
- frontend/src/db/schema.ts.
- frontend/src/utils/localApi.ts.
- frontend/src/utils/decodedFrame.ts.
- frontend/src/utils/svr/dicomGeometry.ts.
- frontend/src/utils/svr/longitudinalFrames.ts.

Changes:

- Retain declared pixel padding value/range and stored-domain validity.
- Extend the existing frame manifest into one complete validated StackGeometry authority.
- Validate the entire row/column basis, FoR, position, spacing, and depth sequence.
- Propagate validity-aware weighted interpolation through native decoding.
- Keep acquisition thickness distinct from center spacing.
- Expose physical gap and unsupported-region metadata.

Acceptance:

- The -2000/100 mixed-footprint case yields 100, not -950.
- Positive and negative intercept preserve identical anatomical validity.
- Legitimate zero and negative anatomy remain valid.
- A same-normal 90° basis swap is rejected.
- Duplicate, missing, or mixed physical frame identities fail safely.

### Phase 2. Introduce one truthful output-plane grid

Dependencies: trustworthy complete acquisition geometry.

Primary boundaries:

- frontend/src/types/api.ts.
- frontend/src/utils/svr/longitudinalFrames.ts.
- frontend/src/utils/svr/longitudinalRegistration.ts.
- frontend/src/utils/cornerstoneInit.ts.
- frontend/src/utils/derivedAlignmentFrame.ts.
- frontend/src/db/schema.ts.
- frontend/src/utils/localApi.ts.
- frontend/src/services/exportBackup.ts.

Changes:

- Define the immutable OutputPlaneGrid contract.
- Add native, fixed-square, longest-edge, and explicit physical-spacing modes.
- Apply exact pixel-center and field-preserving arithmetic.
- Remove implicit presentation-grid selection by hardcoded coarse dimensions.
- Explicitly set derived Cornerstone physical metadata.
- Persist and validate complete grid/contributor provenance.
- Add disclosed output pixel/byte budgets.

Acceptance:

- The 640 × 512, 0.4/0.8 mm worked example produces the exact expected grids.
- Reference-native output reproduces source origin, orientation, spacing, and dimensions exactly.
- Fixed 1024 output identifies itself as upsampled when appropriate.
- Pixel-center/physical-coordinate round trips remain within 0.00001 mm for deterministic geometry.
- Live view, hydration, backup, and restore all report the same output spacing.
- Unsupported output presets fail explicitly without silent downsampling.

### Phase 3. Correct physical mode routing and representative source identity

Dependencies: phases 1 and 2.

Primary boundaries:

- frontend/src/utils/svr/longitudinalFrames.ts.
- frontend/src/utils/alignmentGeometry.ts.
- frontend/src/hooks/useAutoAlign.ts.

Changes:

- Evaluate the actual selected output-plane footprint and all four corners.
- Compare the true maximum drift against locally justified acquired support.
- Inverse-map the output-grid center to the accepted target frame.
- Anchor navigation by the target canonical normal.
- Persist all genuinely contributing source SOPs separately from the representative target frame.

Acceptance:

- The diagonal 1° / 4 mm-center-spacing example chooses 3D.
- The 18° / 40 mm-crop example chooses the correct central target SOP instead of an image approximately 13 slices away.
- Rectangular, anisotropic, compound-tilt, and transformed-center cases all preserve correct physical anchors.
- Same-frame identity remains on the cheaper 2D path only when every output-plane corner is genuinely safe.

### Phase 4. Repair paired exclusion and symmetric anatomical support

Dependencies: phases 1–3.

Primary boundaries:

- frontend/src/utils/perceptualSliceSimilarity.ts.
- frontend/src/utils/svr/longitudinalRegistration.ts.
- frontend/src/utils/svr/rigidRegistration.ts.
- frontend/src/utils/svr/reconstructionCore.ts.
- frontend/src/utils/alignmentConfidence.ts.

Changes:

- Replace zero-filled lesion exclusion with explicit stable-anatomy validity.
- Map exclusion support into both registration directions for each pose.
- Propagate exclusion through descriptor/interpolation footprints.
- Compute normalization and support statistics from valid nonexcluded anatomy.
- Separate padding, excluded anatomy, absent geometry, and real zero-valued tissue.
- Report independent forward, reverse, output, and required-region support.

Acceptance:

- Identical masked acquisitions remain within approximately 0.1 mm translation and 0.1° rotation in the deterministic phantom.
- The existing false -2.5°, -3°, +2° result is impossible.
- Excluded lesion intensity changes do not move the accepted rigid pose.
- The actual lesion remains present in the displayed output.
- Too little remaining stable anatomy produces an explicit ambiguous outcome.

The numerical tolerances above are deterministic engineering targets, not clinical safety claims.

### Phase 5. Add bounded multi-start and native-resolution refinement

Dependencies: a correct physically paired stable-anatomy objective.

Primary boundaries:

- frontend/src/utils/svr/longitudinalFrames.ts.
- frontend/src/utils/svr/longitudinalRegistration.ts.
- frontend/src/utils/svr/rigidRegistration.ts.
- frontend/src/hooks/useAutoAlign.ts.

Changes:

- Stratify coarse slice selection by physical millimeters.
- Reuse one immutable per-run reference pyramid.
- Preserve same-frame identity as an explicit hypothesis.
- Optimize several materially different plausible seeds.
- Refine on a bounded native-resolution stable-anatomy slab.
- Evaluate held-out local support and independently optimized reverse alignment.
- Record optimized alternatives, effective sample support, and physical pose uncertainty.

Acceptance:

- Synthetic translations around 0.2–0.4 mm remain distinguishable where native sampling supports them.
- Synthetic rotations around 0.1–0.3° remain distinguishable where landmark geometry supports them.
- Peripheral landmark error is evaluated directly, not inferred from an improved NCC score.
- Separate optimized basins are reported as ambiguous when genuinely indistinguishable.
- Irregular depth sampling preserves far-FOV and selected-plane anatomical coverage.
- Reference preparation is measured once per immutable run.

### Phase 6. Enforce honest 2D and 3D acceptance

Dependencies: phases 4 and 5.

Primary boundaries:

- frontend/src/utils/alignmentConfidence.ts.
- frontend/src/utils/alignmentScoringEngine.ts.
- frontend/src/utils/phaseCorrelation.ts.
- frontend/src/utils/svr/longitudinalRegistration.ts.
- frontend/src/hooks/useAutoAlign.ts.
- frontend/src/hooks/useApplyAlignmentResults.ts.

Changes:

- Require independent absolute stable-anatomy agreement.
- Preserve physically distinct optimized rival comparisons.
- Gate weak, unsupported, or boundary-clipped phase corrections.
- Gate forward/reverse support and independent inverse geometric disagreement.
- Require output-plane/lesion-neighborhood support.
- Expose typed uncalibrated evidence and practical rejection reasons.
- Keep all thresholds provisional until independently labeled calibration exists.

Acceptance:

- The structural-score 0.020 / raw-NGF -0.96 case is ambiguous, not aligned.
- Flat, repetitive, padded, low-support, and contradictory candidates cannot overwrite visible settings.
- Legitimate contrast/intensity changes remain accepted on supported synthetic and real engineering cases.
- Previous settings survive every rejection, cancellation, stale revision, and wrong-patient case.

### Phase 7. Make final presentation gap-aware and physically complete

Dependencies: an accepted rigid pose and explicit output grid.

Primary boundaries:

- frontend/src/utils/svr/longitudinalFrames.ts.
- frontend/src/utils/svr/longitudinalRegistration.ts.
- frontend/src/utils/cornerstoneInit.ts.
- frontend/src/utils/derivedAlignmentFrame.ts.
- frontend/src/services/exportBackup.ts.

Changes:

- Select genuinely contributing contiguous acquired frames by physical depth.
- Evaluate local acquisition gaps and declared slice-support footprints.
- Produce a validity/fractional-support output map.
- Reject unsupported anatomy in required regions.
- Preserve all contributor identities and native spacing/thickness provenance.
- Stream or tile native source frames when output or source dimensions demand it.

Acceptance:

- The 23 mm gap is visibly unsupported and cannot produce an accepted full-coverage plane.
- 0.6 mm centers with 1.2 mm thick overlapping slices remain valid.
- 1024 output edge centers inside the native footprint remain valid.
- No accepted plane invents support outside native FOV or inside padding.
- Live view, restart, and restore agree on the exact output physical grid.

### Phase 8. Add restrained controls and independently validated release evidence

Dependencies: all deterministic correctness gates.

Changes:

- Expose reference-native and advanced physically labeled output presets.
- Explain uncertain/unsupported outcomes concisely.
- Add an approved synthetic compressed-DICOM real-browser alignment E2E.
- Assemble patient-disjoint blinded clinician annotations if available.
- Predeclare clinical accuracy, rejection, and false-acceptance endpoints.
- Fit any confidence thresholds on the calibration cohort only.
- Evaluate the locked holdout without changing thresholds after observation.

Engineering acceptance:

- The approved browser fixture imports, displays, aligns, changes output resolution, persists, reloads, exports/restores, and cancels without protected patient imagery.
- Existing 460-test behavior remains intact.
- The current 18.050° representative real-MRI challenge remains supported.

Clinical release acceptance:

- A clinical owner has predeclared acceptable landmark/lesion error.
- Inter-rater reliability is measured.
- Patient-disjoint sample size supports the chosen false-acceptance risk.
- Prespecified median/p95 TRE and stable-anatomy HD95 pass.
- Accepted-case patient-cluster precision bounds meet the chosen clinical target.
- Required acquisition/pathology subgroups meet their prespecified gates.
- Lesion changes remain visible and unsupported anatomy is rejected.
- Any displayed probability meets preregistered calibration criteria.

If blinded labels or a sufficiently powered patient cohort are unavailable, the system may satisfy deterministic engineering gates but must not claim validated clinical alignment accuracy.

## 19. Proposed focused test boundaries

Extend or add tests near:

- frontend/tests/decodedFrame.test.ts: stored-domain padding, signed anatomy, positive/negative intercept, and validity-aware resampling.
- frontend/tests/perceptualSliceSimilarity.test.ts: additive/multiplicative intensity invariance and stable-anatomy mask support.
- frontend/tests/alignmentConfidence.test.ts: weak absolute agreement, correlated support, optimized rivals, and safe abstention.
- frontend/tests/svrDicomGeometry.test.ts: pixel-center origins, full frame-basis validation, rectangular/anisotropic grids, and four-corner drift.
- frontend/tests/svrLongitudinalFrames.test.ts: millimeter-stratified selection, output presets, native contributor identities, and unsupported gaps.
- frontend/tests/svrLongitudinalRegistration.test.ts: all-six-axis exclusion invariance, multi-start ambiguity, native refinement, partial-FOV support, and output-lattice sampling.
- frontend/tests/svrRigidRegistration.test.ts: physically scaled fine optimization and independently optimized inverse transforms.
- frontend/tests/useAutoAlignPhysical.test.tsx: end-to-end mode routing, target anchoring, typed evidence, output grids, and preserved rejection behavior.
- frontend/tests/cornerstoneInit.test.ts: exact derived loader row/column spacing and physical metadata.
- frontend/tests/derivedAlignmentFrame.test.ts: grid identity, old-record safety, contributor provenance, and hydration.
- frontend/tests/storageIntegrity.test.ts: 1024-grid persistence, quota limits, exact geometry, and backup recovery.

Add one separate approved synthetic browser integration rather than substituting a mocked viewer or a screenshot for actual compressed-image decoding.

## 20. Risks, tradeoffs, and rejected approaches

### 20.1 Do not begin with learned image similarity

Generic pretrained perceptual embeddings are not a substitute for physical frame identity, padding validity, lesion-safe paired support, an explicit output grid, or labeled MRI ground truth. A learned model adds assets, runtime cost, and clinical generalization risk before fixing the demonstrated failures.

### 20.2 Do not use deformable registration to increase visual agreement

A deformable transform can suppress genuine longitudinal tumor or tissue changes. Rigid patient-space alignment remains the default product contract.

### 20.3 Do not optimize scores without physical acceptance evidence

NCC, mutual information, MIND, NGF, percentile rank, coverage, and phase-peak strength are diagnostic signals. None alone proves correct anatomy.

### 20.4 Do not infer better anatomical resolution from larger output

1024 × 1024 may be valuable for shared presentation, precise cursor mapping, or avoiding secondary display interpolation. It does not create an acquisition sharper than its actual in-plane or through-plane sampling.

### 20.5 Do not unify incompatible worker lifetimes

Run-scoped sequential scoring, one-shot transferred registration buffers, and reusable interactive segmentation volumes have different ownership and cancellation contracts. Reuse image/geometry primitives without introducing a generic worker coordinator that obscures those boundaries.

### 20.6 Do not claim a fixed clinical threshold from a single patient

The current corpus has one patient. No amount of repeated slice pairing changes that independence limit.

### 20.7 Do not silently fall back to a visually plausible result

If geometry, support, memory, confidence, frame identity, or persistence is insufficient, preserve the existing image settings and explain the refusal.

## 21. Definition of done

The alignment-accuracy project is complete only when:

1. Every confirmed failure A01–A11 has a deterministic regression and a verified fix.
2. Exactly one validated stack geometry owns frame basis and acquired depth.
3. Exactly one native-pixel validity representation owns padding and anatomical support.
4. Exactly one output-plane grid owns displayed image dimensions, spacing, origin, orientation, and FOV.
5. The selected output resolution is explicit, physically correct, memory-bounded, and durably reproducible.
6. Lesion exclusion cannot rotate or translate an otherwise identical scan.
7. Weak absolute anatomical agreement cannot be accepted merely because its competitors are worse.
8. Diagonal tilt routes correctly and oblique cropped acquisitions choose the correct source anchor.
9. Unsupported acquisition gaps cannot manufacture accepted anatomy.
10. Native refinement improves independently measured physical landmark error, not only the objective score.
11. Forward, reverse, output, and lesion-neighborhood support remain independently inspectable.
12. Validity, output geometry, and contributor provenance survive real rendering, reload, and backup.
13. Worker, memory, cancellation, and decoded-frame reuse budgets are measured and preserved.
14. Existing patient, dataset-revision, frame-of-reference, and operation safety boundaries remain intact.
15. The current protected real-MRI engineering challenge still succeeds without exposing patient data.
16. Clinical accuracy or confidence is claimed only after an independently powered, blinded, patient-disjoint evaluation passes predeclared acceptance gates.

Until item 16 is satisfied, describe the result as geometrically and algorithmically validated on defined engineering cases—not as clinically proven registration accuracy.
