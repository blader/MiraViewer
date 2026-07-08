# Improving “Align All” with Perceptual Slice Similarity

## Accuracy-focused implementation plan

- **Status:** phases 1–3 implemented; phase 4 remains optional and deferred
- **Date:** 2026-07-06
- **Primary goal:** choose the target-date slice whose aligned anatomy most closely resembles the selected reference slice
- **Scope:** slice ranking, residual in-plane alignment, masks, final transform initialization, and final-transform precision
- **Explicitly deferred:** a reusable benchmark harness, curated golden set, learned-model training, broad UX changes, and full 3D registration

## Implementation status

The recommended first implementation slice and phases 1–3 are now present in the frontend:

- rigid-only shared seed registration with three resolutions;
- signed, bounded phase correction with fixed 128 px sampling and 256 px zero-padded FFT support;
- one-pass original-candidate warping with fractional validity;
- fixed-reference, exclusion-aware CS/LNCC and NGF scoring at the prescribed coarse and fine scales;
- exhaustive bounded search, one-time boundary extension, deterministic five-peak-plus-neighbor shortlist, and stage-local tie-aware rank fusion;
- residual final affine composition through `StandardAffine2D` and panel geometry;
- complete per-candidate debug provenance, cancellable capture/registration work, and deterministic regressions for the transform, masking, ranking, and support invariants below.

Automated acceptance is green (`npm run check` plus a clean scoped production build). The representative local MRI overlay/flicker checks in §15.2 have not yet been recorded; they remain a sanity check before making any real-world or population-level accuracy claim, not a reason to substitute a harness or golden set.

## Executive summary

Align All already tends to return a plausible result. The next accuracy problem is distinguishing the *best anatomical match* from several nearby slices that all look reasonable.

The current implementation ranks candidates by the maximum value of a 64×64 phase-correlation surface. Phase correlation is useful for estimating translation, but its peak height is not a strong final measure of anatomical resemblance. The implementation also discards the peak location, uses one affine transform estimated from a possibly wrong seed slice for every candidate, and can stop searching after a short run of decreasing scores.

The recommended first implementation is deliberately fixed and deterministic:

1. Replace the pre-selection affine seed with a **rigid seed**. Shear and anisotropic scale must not influence slice selection.
2. Exhaustively examine every slice in the existing bounded search window. Remove local-decrease termination.
3. For each candidate, use phase correlation only to estimate a **bounded residual translation**.
4. Compose that translation in the correct direction and rewarp the original candidate once.
5. Compare aligned anatomy at 256, 128, and 64 px using two perceptual families:
   - an **intensity-structure family**, containing contrast-structure SSIM and LNCC;
   - a **boundary-structure family**, containing normalized gradient-field agreement.
6. Score against one fixed reference-derived anatomical domain. Missing or cropped target anatomy must lower the score rather than disappear from the denominator.
7. Rank all coarse candidates, retain a fixed shortlist of five separated peaks plus their immediate neighbors, and fine-score that fixed set.
8. Select the slice from the fine perceptual score, then run the final affine refinement only on that slice, initialized from the winning rigid + residual transform.

This changes phase correlation from “the slice similarity metric” into “a translation estimator.” The final decision comes from aligned local structure.

Two later accuracy layers remain worthwhile, but should not be mixed into the first change:

- candidate-specific rigid re-registration, after the Elastix adapter supports rigid transforms and transform-chain conversion correctly;
- three-slice 2.5D scoring, after reliable physical slice order and spacing are exposed to Align All.

Because the user has explicitly deferred a harness and golden set, the constants below are initial engineering hypotheses, not calibrated clinical thresholds. The plan uses fixed behavior and focused tests rather than an adaptive cascade whose many thresholds would pretend to be calibrated.

## 1. What “perceptual similarity” means for Align All

Here, perceptual similarity does not mean generic image aesthetics or broad semantic similarity. It means:

> After removing plausible in-plane pose differences, the same anatomical boundaries, internal structures, and spatial relationships appear in the same locations.

A useful score should therefore be:

| Property | Why it matters |
|---|---|
| Tolerant of brightness and contrast changes | Longitudinal scans and rendered canvases can use different intensity scaling |
| Sensitive to local structure | Nearby slices can share a histogram and silhouette while differing in ventricles, sulci, lesions, and internal boundaries |
| Evaluated after residual alignment | A correct slice shifted by a few pixels should not lose to a conveniently centered wrong slice |
| Multi-resolution | Coarse shape rejects large errors; fine structures distinguish adjacent slices |
| Background-resistant | Shared black canvas is not anatomical correspondence |
| Honest about missing support | A cropped or badly shifted candidate must not improve by removing its own mismatches |
| Robust to focal change | The user-supplied lesion exclusion should keep treatment change from dominating the rest of the anatomy |
| Resistant to transform cheating | A wrong slice must not win by using shear, anisotropic scale, or a different pose model |
| Inspectable | Debug output should explain the translation, coverage, component scores, ranks, and final selection |

No single metric supplies all of these properties. The proposal therefore separates pose estimation, appearance structure, boundary structure, and coverage.

## 2. Current algorithm and accuracy limitations

### 2.1 Current path

```text
selected reference slice
        │
        ▼
normalized-index estimate in target series
        │
        ▼
affine registration against that estimated slice
        │
        ▼
same affine pre-warp applied to every candidate
        │
        ▼
64×64 phase-correlation peak height
        │
        ▼
early-stopped winner within ±40 indices
        │
        ▼
new affine registration of that one winner, from scratch
```

### 2.2 Repository evidence

| Finding | Current code | Consequence |
|---|---|---|
| Production slice metric is `phase` | `frontend/src/hooks/useAutoAlign.ts:54-57` | Phase-peak height, rather than anatomical structure, selects the slice |
| Phase score runs at 64×64 | `frontend/src/utils/alignment.ts:258-304` | Fine structures present in the 512 px capture cannot affect the winning score |
| Phase returns only `{ phase, pixelsUsed }` | `frontend/src/utils/phaseCorrelation.ts:339-415` | Translation coordinates and peak ambiguity are discarded |
| The seed is an unconstrained affine | `frontend/src/hooks/useAutoAlign.ts:370-400`; `frontend/src/utils/elastixRegistration.ts:290-305` | A possibly wrong seed slice can introduce shear or anisotropic scale before perceptual comparison |
| The same seed warp is applied to all candidates | `frontend/src/hooks/useAutoAlign.ts:442-469` | Candidate-specific residual pose is not corrected |
| SSIM, LNCC, NGF, and other signals are alternatives/debug values | `frontend/src/utils/alignment.ts:359-519` | Useful structural evidence does not drive production selection |
| Existing SSIM uses non-overlapping blocks | `frontend/src/utils/ssim.ts:54-62` | Block boundaries and pixel-count pooling can make scores unstable or background-heavy |
| Existing blocks are weighted by included pixel count | `frontend/src/utils/ssim.ts:189-237` | Large flat regions can outweigh smaller informative regions |
| Foreground is a fixed intensity threshold | `frontend/src/utils/imageFeatures.ts:48-82` | Mask quality depends on windowing and may include padding or omit dark anatomy |
| Search can stop after three decreases | `frontend/src/hooks/useAutoAlign.ts:43-46`; `frontend/src/utils/alignment.ts:562-658` | A later, stronger peak can remain unexamined |
| Only the coarse winner receives final registration | `frontend/src/hooks/useAutoAlign.ts:626-652` | An early ranking error cannot be reconsidered |
| Final affine does not consume the seed transform | `frontend/src/hooks/useAutoAlign.ts:648-652` | Useful initialization is thrown away |
| Warp output has no validity footprint | `frontend/src/utils/warpAffine.ts:25-69` | Zero-valued padding is indistinguishable from valid dark pixels |

### 2.3 The central failure mode

Adjacent MRI slices are strongly correlated. Several candidates can share:

- the same outer silhouette;
- similar intensity distributions;
- similar low-frequency anatomy;
- similar edge density;
- a strong phase-correlation peak.

The decisive evidence is often a smaller internal structure that changes gradually through depth. Reducing the decision to one 64×64 frequency-domain peak throws away much of that evidence.

Simply changing `SLICE_SEARCH_SCORE_METRIC` from `phase` to `ssim` would not fix the problem. SSIM and LNCC are sensitive to residual displacement. The correct order is:

```text
constrain the shared seed
    → estimate candidate residual translation
    → compose and apply it once
    → compare local structure
```

## 3. Proposed first-version pipeline

```text
reference slice
      │
      ├──────────────► normalize in source space
      │                build fixed ROI, weights, pyramids
      │
target candidate
      │
      ▼
apply shared rigid seed
      │
      ▼
bounded phase correlation estimates correction δ
      │
      ▼
Translate(δ) ∘ rigid seed
      │
      ▼
rewarp original candidate once + produce fractional validity
      │
      ▼
mask-normalized local scoring over a fixed reference denominator
      │
      ├──────────────► appearance family: CS-SSIM + LNCC
      │
      └──────────────► boundary family: NGF
      │
      ▼
tie-aware family-rank fusion within a fixed candidate set
      │
      ▼
fixed top-K fine shortlist
      │
      ▼
winning slice
      │
      ▼
final seeded affine for display
```

The design separates four questions:

1. **What in-plane transform is safe before slice selection?** Rigid only.
2. **What residual translation remains for this candidate?** Bounded phase correlation.
3. **How much aligned anatomy matches?** Two perceptual families plus coverage.
4. **Which flexible display transform is needed after depth is fixed?** Final affine.

## 4. Constrain the pre-selection transform

### 4.1 Why the current affine seed is unsafe

The seed transform is estimated against the normalized-index target slice before the correct slice is known. If that seed is wrong, an affine optimizer can use anisotropic scale or shear to make its anatomy appear more like the reference. The same distorted transform is then applied to every candidate.

This contradicts the desired invariant:

> Before slice selection, the algorithm may correct pose, but it may not deform anatomy.

### 4.2 Recommended seed

Generalize the registration adapter to request an Elastix rigid parameter map for the seed. The seed may contain:

- translation;
- rotation around the image center.

It may not contain:

- anisotropic scale;
- shear;
- arbitrary affine residual.

Use a fixed three-level registration pyramid for this seed rather than the current single-resolution setting. The extra capture range supports the rigid pose estimate without adding deformable freedom.

If rigid support cannot land in the same change, the temporary fallback is to decompose the current affine and keep only its closest rotation plus translation. Do not carry the affine residual into slice scoring.

The seed remains shared across the search window because longitudinal in-plane pose is a series-level property. Candidate-specific freedom is limited to residual translation in the first version.

### 4.3 Required adapter work

The current adapter always requests `defaultParameterMap('affine')`, and the current transform parser expects affine chains. Rigid support therefore requires explicit work:

1. cache parameter maps by **transform kind and resolution count**, not resolution alone;
2. add a rigid registration entry point;
3. parse the returned Euler/rigid representation or canonicalize it to `StandardAffine2D`;
4. document moving-to-fixed direction and center-of-rotation semantics;
5. test the parsed transform against the resampled Elastix output.

Do not describe similarity bounds as available until a custom similarity parameter map and enforceable bounds actually exist.

## 5. Turn phase correlation into a bounded translation estimator

### 5.1 Output contract

Rename the displacement fields to make their meaning explicit:

```ts
type PhaseCorrection = {
  /** Translation to apply to the seed-warped moving image, in sample-grid pixels. */
  correctionX: number;
  correctionY: number;
  peak: number;
  peakToSidelobeRatio: number;
  sampleGridSize: number; // 128 in the first implementation
  fftSize: number; // 256 after fixed 2× zero-padding
  pixelsUsed: number;
};
```

The inverse FFT already produces the correlation surface. The implementation should retain the best peak coordinate, convert wrapped coordinates into a signed correction, and optionally fit a subpixel offset from the immediate neighborhood.

Peak height and peak-to-sidelobe ratio remain diagnostics. They do not contribute to the final perceptual score in the first version.

### 5.2 Avoid mask- and wrap-induced false peaks

The current implementation applies the same hard reference-space mask to reference and target before the FFT. A shared mask boundary or exclusion hole can itself create a strong zero-shift feature. Same-size FFT correlation is also circular, while `warpGrayscaleAffine` uses zero padding.

For the residual estimator:

1. normalize reference and target in their own source-space foreground before warping;
2. use a soft, apodized anatomical support rather than multiplying both inputs by the same hard-edged mask;
3. do not cut a hard exclusion rectangle into the phase inputs; use smooth inpainting/downweighting if lesion influence is material;
4. zero-pad both 128 px sample grids to a fixed 256×256 FFT grid so the selected peak has a linear-shift interpretation;
5. search only an allowed signed residual window around zero instead of taking a global peak and clamping it afterward;
6. start with a fixed bound of ±16 **sample-grid** pixels in each axis and treat that value as an engineering hypothesis to inspect manually.

Zero-padding changes FFT support, not displacement units. `correctionX` and `correctionY` remain measured in the original 128 px sample grid; `fftSize` must never be used to scale them.

Searching only the physically allowed correction window prevents a wrapped large displacement from being interpreted as a plausible small zero-padded warp.

### 5.3 Exact composition

Let:

- `T_seed` map original candidate coordinates into reference coordinates;
- `δ_i` be the signed correction measured on the seed-warped candidate in the phase grid;
- `s = scoringSize / sampleGridSize`.

Then:

```text
T_i = Translate(s × δ_i) ∘ T_seed
```

If `T_seed(x) = A x + b`, then:

```text
T_i(x) = A x + b + s × δ_i
```

The residual is applied in output/reference coordinates. It is not multiplied by `A`.

Use the seed-warped buffer only to estimate `δ_i`. Rewarp the **original** candidate once with `T_i` for perceptual scoring; translating an already interpolated seed warp would blur it twice.

### 5.4 Focused transform tests

Before the score depends on this correction, verify:

- positive and negative x/y shifts;
- wrapped peaks near each FFT boundary;
- a non-identity seed rotation;
- sample-grid-to-scoring-grid scale conversion;
- subpixel interpolation;
- the exact `warpGrayscaleAffine` moving-to-fixed convention;
- exclusion/apodization behavior.

These are small deterministic unit tests, not an evaluation harness.

## 6. Build a fixed, honest comparison domain

### 6.1 Normalize before warping

Compute robust low/high intensity percentiles over each source image’s stable foreground, then map that interval to `[0, 1]` and clip outliers. Do this before candidate warping and independently of the surviving overlap.

Do not compute a candidate’s normalization only over the pixels that happen to overlap the reference. That would let crop and transform differences change the intensity basis from candidate to candidate.

The first implementation may continue using the existing rendered grayscale buffers. Moving to modality-scaled raw DICOM pixels is a later input-quality improvement, not a prerequisite for testing the ranking design.

### 6.2 Fixed reference ROI and structural weights

Prepare one reference-derived ROI per run:

```text
reference anatomy
− user exclusion region
− outer interpolation-safe boundary
```

Within that ROI, compute a reference structural weight from local variance and gradient energy, but retain a modest uniform floor. The floor ensures that target-only structures over a locally flat reference region still incur a mismatch rather than receiving zero weight. Cap the maximum weight so one high-contrast edge cannot dominate.

The reference ROI and its total weight form the denominator for every candidate at that stage.

### 6.3 Fractional validity footprint

Extend the warp operation to return both:

```ts
type WarpedImage = {
  pixels: Float32Array;
  validity: Float32Array; // [0, 1], including interpolation at the boundary
};
```

Validity must come from the same inverse mapping used to sample the pixels, not from testing whether the warped intensity equals zero. Valid dark anatomy and zero-filled padding are not the same thing.

Downsample validity by area averaging and retain it as fractional `Float32Array` data. Thresholding it to `Uint8Array` would throw away partial-support information at edges and coarse scales.

### 6.4 Missing support must lower the score

For candidate `i`, define weighted coverage:

```text
coverage(i) = sum(referenceWeight × validity(i))
              / sum(referenceWeight)
```

Local metric values use the fixed reference denominator. Invalid candidate support receives the metric floor, or equivalently contributes zero after all component scores are mapped to `[0, 1]`. It does not disappear from both numerator and denominator.

Map signed correlation-like values with `(q + 1) / 2` before applying the zero floor; NGF is already in `[0, 1]`. Keep both mapped and original raw values in debug output.

Target foreground may be recorded as a support/QC signal, but it must not hard-mask reference regions. Otherwise, a wrong candidate could improve its score by lacking the anatomy it fails to match.

### 6.5 Mask-normalized local statistics

For an overlapping Gaussian window `G`, local moments must be normalized by supported weight. Conceptually:

```text
mean(x) = G(referenceWeight × validity × x)
          / G(referenceWeight × validity)
```

Apply the corresponding normalization to second moments and covariance. Do not insert zeros into an ordinary convolution and treat them as observed intensities.

Dilate invalid and excluded regions by the radius of the local window and gradient stencil, or use exact weighted convolution support, so a lesion or padding edge cannot leak into adjacent SSIM/LNCC/NGF samples.

## 7. Perceptual score: two families, three resolutions

### 7.1 Resolution schedule

Use anti-aliased pyramids at:

- 256 px for fine internal structures;
- 128 px for medium-scale anatomy;
- 64 px for coarse layout.

The coarse search can initially use 128 and 64 px. The fixed fine shortlist uses all three.

This is a **multi-resolution pooled structural score**, not a claim to implement canonical MS-SSIM. The [multi-scale structural similarity paper](https://live.ece.utexas.edu/publications/2003/zw_asil2003_msssim.pdf) motivates comparing structure at multiple scales, but its calibrated exponents and natural-image quality setting should not be imported uncritically into longitudinal MRI matching.

### 7.2 Appearance-structure family

This family contains two related diagnostics.

#### Contrast-structure SSIM

Use overlapping Gaussian-window contrast and structure rather than the current non-overlapping blocks:

```text
CS(x, y) = (2 covariance(x, y) + C)
           / (variance(x) + variance(y) + C)
```

Omit the luminance term initially because absolute brightness is not the anatomy being matched.

#### Local normalized cross-correlation

LNCC compares local co-variation after subtracting local means and dividing by local contrast. It is useful for same-sequence images with additive or multiplicative intensity changes.

CS-SSIM and LNCC are strongly related covariance signals. They must not receive two independent majority votes. Pool them inside one appearance family.

### 7.3 Boundary-structure family

Use normalized gradient-field agreement as a separate family:

```text
NGF(x, y) = dot(grad(x), grad(y))²
            / ((|grad(x)|² + eta²) (|grad(y)|² + eta²))
```

The squared dot product tolerates contrast inversion while requiring boundaries to occupy the same place and direction.

Gate on the union of informative reference and target gradient magnitudes, not reference gradients alone. Target-only edges should count as disagreement. Retain the uniform ROI weight floor so a wrong candidate cannot hide an added boundary in an otherwise flat reference region.

### 7.4 Spatial pooling

For every metric and resolution:

1. calculate mask-normalized local values;
2. weight them by the fixed reference structural weights;
3. use the fixed reference denominator;
4. let missing candidate support contribute the component floor;
5. optionally narrow-winsorize only extreme local values;
6. record the weighted mean and lower-quartile diagnostic.

Aggressive trimming is not recommended. A wrong slice may differ in a small but important structure; discarding the low tail can hide the evidence needed to reject it.

### 7.5 Family rank fusion

Component values and scales are not calibrated to one another. Use tie-aware midranks inside a fixed candidate universe rather than a weighted sum that appears more calibrated than it is.

For one search stage:

1. compute raw CS, LNCC, and NGF values at each active resolution;
2. apply the fixed coverage treatment before ranking;
3. assign tie-aware percentile midranks for each metric-resolution channel;
4. omit a channel only when its mapped candidate range is below a fixed numerical tolerance, initially `1e-6`;
5. average CS/LNCC channel ranks into `appearanceRank`;
6. average NGF channel ranks into `boundaryRank`;
7. average the two family ranks into `perceptualRank`;
8. use expected slice position only to break an exact final tie.

Conceptually:

```text
appearanceRank(i) = mean(midrank(CS_s(i)), midrank(LNCC_s(i)) for active scales s)
boundaryRank(i)   = mean(midrank(NGF_s(i)) for active scales s)
perceptualRank(i) = mean(appearanceRank(i), boundaryRank(i))
```

If one family is entirely flat, use the other family and record the lack of consensus. If both are flat, keep the normalized-index prior rather than manufacturing certainty.

Ranks remove numeric-range dominance; they do **not** calibrate the metrics or make correlated signals independent. Retain raw values and raw winner/runner-up margins for debugging. Never compare a coarse-stage percentile directly with a fine-stage percentile because the candidate universes differ.

## 8. Deterministic search and shortlist

### 8.1 Exhaust the bounded window

Keep the current normalized-index seed and ±40-index window for the first perceptual implementation, but score every slice in that window. Remove `stopDecreaseStreak` from production selection.

This is intentionally narrower than searching the full stack:

- the current behavior is already generally plausible, so the next target is better discrimination among nearby slices;
- a full stack increases false-positive opportunities;
- fixed bounded search limits memory and makes the first change easier to reason about.

If one of the provisional top five peaks lies at a window boundary, extend that side once by one fixed 40-index block, clipped to the stack, and score the added candidates. Then recompute every coarse channel rank over the single unified candidate universe before final peak selection and non-maximum suppression. Reliable DICOM geometry can later replace the index window with physical overlap bounds.

### 8.2 Fixed two-stage scoring

| Stage | Candidate set | Work |
|---|---|---|
| Coarse | Every slice in the bounded window | rigid seed, bounded phase correction, 128/64 px score |
| Fine | Five separated local peaks plus each peak’s immediate neighbors | 256/128/64 px score |

Use a deterministic local-maximum rule and a fixed shortlist size of five:

1. collapse an equal-score plateau to the member nearest the normalized-index seed, then to the lower index;
2. order peaks by descending perceptual rank, then by distance to the seed, then by lower index;
3. apply non-maximum suppression with an initial radius of two indices;
4. if fewer than five local peaks survive, fill from the highest-ranked remaining candidates outside the same suppression radius;
5. add each selected peak’s in-range immediate neighbors and deduplicate by index.

Immediate neighbors protect against a coarse-resolution peak landing one slice away. The shortlist size and suppression radius are explicit initial hypotheses rather than calibrated optima.

The fine candidate set is fixed before fine ranks are computed. Do not add or remove candidates based on an uncalibrated “close score” threshold.

### 8.3 Memory discipline

- Keep only 128/64 coarse representations for the current bounded window.
- Discard full-resolution and warped candidate buffers after coarse scoring unless the candidate enters the shortlist.
- Retain 256 px data only for the fine candidate set.
- Use a small LRU or explicit byte budget for rendered captures.
- Prepare reference pyramids, gradients, ROI, and weights once.

Do not cache 512 px raw, warped, and pyramid buffers for hundreds of slices.

### 8.4 Role of the search prior

The normalized-index estimate determines where to search and breaks an exact tie. It should not add a large distance penalty that overrides a clear perceptual difference.

When reliable physical geometry becomes available, use it to define overlap and candidate separation in millimetres. Geometry remains a prior and ordering mechanism; aligned anatomy remains the final slice evidence.

## 9. Select the slice before the final affine

The first implementation should select the winning slice directly from the fixed fine perceptual score. Do not independently optimize rotation or scale for every candidate yet; per-candidate pose freedom can let a wrong slice improve itself differently from its neighbors.

After selection:

1. take the winning `T_i = Translate(δ_i) ∘ T_seed`;
2. prewarp the original winning candidate and its validity with `T_i`;
3. run the high-resolution affine registration with a fixed three-level pyramid as a **residual** transform on that prewarped image;
4. compose the returned residual moving-to-fixed affine with `T_i` using `StandardAffine2D` helpers;
5. apply the composed transform to panel settings.

This avoids synthesizing an Elastix initial-transform parameter object with the wrong center, direction, or resolution units. It also avoids restarting final registration from identity.

Validate the composition against the Elastix resampled output and the viewer transform. The parser must distinguish total transforms from residual transforms and preserve chain order.

Affine flexibility is acceptable at this point because slice depth has already been fixed. It should still be monitored for implausible determinant, shear, or anisotropic scale.

### 9.1 Final-affine optimizer and resolution

The steps above fix *which* slice is displayed and start the final refinement from the winning transform rather than identity. Two further levers make the final display transform itself more precise. They act only on the post-selection affine, so they are independent of the perceptual ranking and can land separately.

1. **Tune the Elastix parameter map instead of accepting the stock defaults.** The adapter caches `defaultParameterMap('affine')` unmodified (`frontend/src/utils/elastixRegistration.ts:290-305`), and its defaults favor speed over precision. Before caching each map, raise the precision-relevant fields:
   - `MaximumNumberOfIterations` — let the optimizer settle rather than stopping early;
   - `NumberOfSpatialSamples`, with `NewSamplesEveryIteration = "true"` — a denser, less noisy metric gradient so the final parameters land on the optimum instead of jittering around it;
   - `NumberOfHistogramBins` for the mutual-information metric — a sharper, better-localized minimum.
   Maps are cached per kind and resolution count (§4.3), so this cost is paid once. Treat the exact values as engineering hypotheses to inspect manually, consistent with the deferred-harness stance, and keep the stock defaults as a fallback. The same principle applies to the rigid seed map (§4.2) and any later rigid candidate map (§10).

2. **Recover the final transform above 256 px.** The final refinement registers at `ALIGNMENT_IMAGE_SIZE = 256` (`frontend/src/utils/imageCapture.ts:10`). Sub-pixel convergence at 256 px corresponds to coarser real-world displacement than at 512, and the fine structures that constrain rotation and scale are attenuated. Recover the residual affine of §9 at 384–512 px. The reference is already rendered at the 512 px slice-search size (`frontend/src/hooks/useAutoAlign.ts:216-227`), so the cheapest form is coarse-to-fine within the refinement: register the residual at 256, then refine at 512 initialized from the 256 result through the same residual-composition path.

Both levers trade compute for precision, so gate them on measured per-date registration time (§17). If runtime is tight, escalate to more iterations or the 512 px rung only when the 256 px residual result is weak, rather than applying them to every date.

## 10. Later layer: candidate-specific rigid refinement

Candidate-specific rigid refinement may correct a coarse ranking mistake, but it is not part of the first implementation.

Before adding it:

1. support rigid parameter maps in `elastixRegistration.ts`;
2. support returned rigid/Euler transforms in `elastixTransform.ts`;
3. cache maps by transform kind and resolution;
4. prewarp by seed + phase and register only a residual rigid correction;
5. compose and test residual/total transform direction;
6. apply the same transform freedom to every finalist;
7. perceptually re-score a fixed top three after registration.

Do not add bounded similarity until the bounds are explicit and enforceable in the actual parameter map. Do not use affine for candidate ranking.

## 11. Later layer: geometry-gated 2.5D context

A short slice slab can distinguish center slices that look alike in isolation, but only if neighbor order and physical offsets are trustworthy.

### 11.1 Geometry prerequisite

The current local API exposes series UID and count, while slice retrieval is ordered primarily by `InstanceNumber`. Before slab scoring, expose per-instance:

- Image Position Patient;
- Image Orientation Patient;
- projected slice coordinate along a consistent normal;
- pixel/slice spacing;
- a validation flag for monotonic order and orientation consistency.

Pair neighbors by signed physical offset. Do not assume equal index offsets represent equal anatomy, do not use `reverseSliceOrder` as anatomical direction, and skip slab scoring when geometry is unreliable.

### 11.2 Fixed slab evaluation

For each of the fixed top three center candidates, compare:

```text
reference: r at physical offsets −Δ, 0, +Δ
target:    t at physical offsets −Δ, 0, +Δ
```

Apply one shared candidate transform to all three pairs. Aggregate each **raw component** across offsets first, then rank the finalist set once. Do not average candidate-relative ranks computed from different slice pairs.

An initial uncalibrated hypothesis is:

```text
slab component = 0.50 × center + 0.25 × previous + 0.25 × next
```

These weights keep the user-selected center dominant. They are a starting choice to inspect manually, not a measured optimum.

When the geometry prerequisite is satisfied, run the three-slice slab for the fixed top three rather than introducing a “close enough” threshold. A five-slice adaptive escalation should wait until there is evidence and calibration for it.

## 12. Handling the exclusion region

The user’s exclusion rectangle should remove samples from perceptual scoring. It should not be mean-filled with a hard boundary that changes local statistics.

For the score:

- remove the exclusion from the fixed reference ROI;
- dilate it by the largest local-window/gradient radius, or use exact support normalization;
- keep its denominator semantics identical for every candidate.

For phase estimation:

- avoid multiplying both images by the same hard rectangle hole;
- use smooth inpainting or soft downweighting if the region materially affects translation.

For registration:

- prefer explicit fixed/moving masks if the pipeline becomes stable with them;
- otherwise prewarp the moving image first, then inpaint/downweight the same reference-space region;
- if operating on an unwarped moving image, map the exclusion through the inverse initial transform rather than applying reference coordinates directly.

## 13. Implementation shape

### 13.1 New focused module

Add:

```text
frontend/src/utils/perceptualSliceSimilarity.ts
```

Suggested types:

```ts
type PreparedPerceptualReference = {
  pyramids: Float32Array[];
  roiWeights: Float32Array[];
  sizes: number[];
  totalWeightByScale: number[];
};

type PerceptualComponents = {
  coverage: number;
  perScale: Array<{
    size: number;
    contrastStructure: number;
    lncc: number;
    ngf: number;
    lowerQuartile: number;
  }>;
};

type RankedSliceCandidate = {
  index: number;
  phase: PhaseCorrection;
  transform: StandardAffine2D;
  validity: Float32Array;
  components: PerceptualComponents;
  appearanceRank: number;
  boundaryRank: number;
  perceptualRank: number;
};
```

Suggested functions:

```ts
preparePerceptualReference(...)
scoreAlignedCandidate(...)
rankFixedCandidateSet(...)
scorePhysicalSlab(...) // later, geometry-gated
```

### 13.2 Existing modules to change

| File | Change |
|---|---|
| `frontend/src/utils/phaseCorrelation.ts` | Return signed bounded correction in sample-grid units, peak confidence, and safe wrap behavior |
| `frontend/src/utils/warpAffine.ts` | Return fractional validity from the same inverse mapping as the image warp |
| `frontend/src/utils/ssim.ts` | Add mask-normalized overlapping Gaussian CS/LNCC primitives, or move them to the new module |
| `frontend/src/utils/imageFeatures.ts` | Build stable source foreground and fixed reference ROI/structural weights |
| `frontend/src/utils/alignment.ts` | Replace early-stopped single-winner search with exhaustive bounded candidate collection and deterministic shortlist formation |
| `frontend/src/hooks/useAutoAlign.ts` | Orchestrate rigid seed, phase correction, coarse/fine perceptual ranking, and seeded final affine |
| `frontend/src/utils/alignmentSliceScoreStore.ts` | Record raw channels, family ranks, coverage, correction, and candidate set |
| `frontend/src/utils/elastixRegistration.ts` | Add transform kind, rigid map support, cache by kind + resolutions, and residual final-affine path; tune the cached parameter maps (iterations, spatial samples, MI histogram bins); allow the final residual affine to run at 384–512 px (§9.1) |
| `frontend/src/utils/elastixTransform.ts` | Parse/canonicalize rigid chains and test residual-versus-total composition |
| `frontend/src/utils/localApi.ts` and related types | Later: expose validated physical slice order/offsets for 2.5D |

### 13.3 Determinism and debug output

For every candidate, record:

- candidate index and distance from the seed;
- rigid seed transform;
- phase correction in phase and scoring units;
- phase peak and sidelobe ratio;
- weighted coverage;
- every raw metric at every scale;
- appearance, boundary, and final midranks;
- coarse/fine candidate-universe ID;
- whether the candidate was retained and why;
- final affine and composition order for the winner.

This makes manual disagreements inspectable without building a separate harness.

## 14. Phased delivery

### Phase 1 — Make candidate comparisons geometrically honest

1. Add rigid seed support and stop using affine before slice selection.
2. Return a signed, bounded phase correction with an explicit convention.
3. Compose `Translate(δ) ∘ T_seed` and rewarp the original candidate once.
4. Return fractional warp validity.
5. Build a fixed reference ROI/denominator and correct exclusion semantics.
6. Remove decrease-based early stopping while retaining the bounded window.

**Exit condition:** every candidate in the window has a safe rigid + translation transform, comparable coverage, and deterministic debug output.

### Phase 2 — Replace phase-peak selection with perceptual ranking

1. Implement mask-normalized overlapping CS and LNCC.
2. Tighten NGF to count both missing and target-only boundaries.
3. Compute 128/64 coarse channels.
4. Form the fixed five-peak-plus-neighbors shortlist.
5. Compute 256/128/64 fine channels.
6. Apply two-family tie-aware rank fusion within each fixed candidate set.
7. Select the slice by fine perceptual rank.

**Exit condition:** phase estimates translation only; aligned local structure selects the production slice.

### Phase 3 — Seed the final affine correctly

1. Prewarp the winning original image by rigid + residual translation.
2. Run final affine as a residual transform.
3. Compose it with the winning transform using tested `StandardAffine2D` direction/order.
4. Verify panel settings reproduce the registered output.

**Exit condition:** final display refinement preserves the selected depth and does not restart from identity.

### Phase 4 — Optional higher-accuracy layers

1. Add fixed-top-three residual rigid re-registration after adapter/parser support exists.
2. Expose validated physical slice geometry.
3. Add fixed-top-three three-slice slab scoring.
4. Tune the cached Elastix parameter maps (iterations, spatial samples, MI histogram bins).
5. Recover the final residual affine at 384–512 px via 256 → 512 coarse-to-fine, gated on per-date runtime.

These are separate follow-ups. They should not block the first perceptual ranking improvement.

## 15. Focused validation without a harness or golden set

This proposal does not require an evaluation platform first. It does require focused checks so transform or masking errors do not masquerade as accuracy improvements.

### 15.1 Deterministic unit cases

| Case | Expected behavior |
|---|---|
| Positive/negative translated copy | Correct phase sign and `Translate(δ) ∘ T_seed` composition |
| Non-identity rigid seed plus translation | One rewarp reproduces the known target alignment |
| Wrapped FFT peak outside allowed window | Not accepted as a small zero-padded correction |
| Shared hard mask boundary | Does not create a false zero-shift winner |
| Exact slice with brightness/contrast change | Remains structurally strong after normalization |
| Wrong slice with similar histogram | Loses on local structure/boundaries |
| Large shared black background | Does not raise similarity |
| Candidate cropped by the warp | Coverage falls and missing reference support lowers the score |
| Target lacks a reference structure | The missing region remains in the denominator |
| Target-only edge over flat reference | Boundary family penalizes it |
| High-contrast lesion in exclusion | Does not leak through local windows or gradient stencils |
| Perfect candidate after local score decreases | Is still evaluated within the bounded window |
| Tied component values | Tie-aware midranks are deterministic |
| Flat appearance or boundary family | Other family is used and lack of consensus is logged |
| Final residual affine composition | Viewer transform matches the Elastix-resampled output |

These are tests of pure functions and transform conventions, not a reusable golden-image harness.

### 15.2 Manual spot checks

Use a small number of representative local cases already used during development:

1. run the same reference slices before and after the change;
2. inspect the complete candidate curve and raw component values;
3. flicker or overlay the selected dates;
4. inspect internal landmarks, not only the outer head contour;
5. note whether a manual slice correction is still needed;
6. inspect every case where appearance and boundary families choose different winners;
7. confirm excluded pathology is not visible in local-score leakage around the rectangle.

This is engineering sanity evidence. It is not a golden corpus, calibrated metric, or clinical-validation claim.

### 15.3 Implementation acceptance criteria

- No affine deformation is used before slice depth is selected.
- Phase correction direction, units, bounds, and composition are explicit and tested.
- Each original candidate is interpolated once for final perceptual scoring.
- Every candidate in the bounded window is evaluated.
- Production slice choice is not based on phase-peak height.
- Missing target support lowers the score against a fixed reference denominator.
- Local statistics are mask-normalized; exclusions and invalid support do not leak into neighboring windows.
- CS/LNCC form one family; NGF forms a second family.
- Ranks are tie-aware and computed only within one fixed stage candidate set.
- Raw score margins remain available; rank distance is not presented as confidence.
- The final affine is residual to the winning rigid + translation transform.
- Existing debug mode explains the complete decision.

These criteria establish that the proposed algorithm was implemented faithfully. Without a golden set, they do not prove a population-level accuracy delta.

## 16. Alternatives not recommended first

### 16.1 Flip the runtime metric from phase to SSIM

This would compare structurally unaligned candidates and retain the current mask/block limitations. It would exchange one failure mode for another.

### 16.2 Keep the current affine seed

Resolution does not reduce affine flexibility. An affine estimated from a wrong seed slice can contaminate every later perceptual comparison.

### 16.3 Give CS-SSIM, LNCC, and NGF three equal votes

CS and LNCC are related covariance signals. Treating them as independent gives one failure family a two-to-one majority over boundaries.

### 16.4 Search the whole stack immediately

The current feature is already generally plausible. Exhausting the bounded neighborhood first targets adjacent-slice discrimination, controls false-positive opportunities, and keeps memory bounded. Physical geometry can expand or replace the window later.

### 16.5 Register every candidate with affine or similarity

Per-candidate deformation can let a wrong slice manufacture resemblance. The first version uses one shared rigid pose plus bounded residual translation; final affine runs only after slice selection.

### 16.6 Start with a learned perceptual embedding

Generic LPIPS, DINO, or natural-image encoders are not guaranteed to preserve subtle MRI differences between adjacent slices. A medical encoder adds model distribution, offline packaging, memory, and domain-validation work.

A learned metric is not permanently excluded, only deprioritized. Once the classical ranker is validated, an ONNX embedding — the app already runs `InferenceSession`s for the tumor/SVR paths — could re-rank only the fixed shortlisted candidates from §8.2, which bounds its cost to a handful of inferences per date. It stays gated on domain validation rather than being a first move.

### 16.7 Reintroduce MIND immediately

[MIND](https://pubmed.ncbi.nlm.nih.gov/22722056/) is relevant to multi-modal medical registration, but the current need is better same-sequence longitudinal discrimination. Correct pose, support, and local structure are more direct first changes.

### 16.8 Add CW-SSIM immediately

[CW-SSIM](https://pubmed.ncbi.nlm.nih.gov/19556195/) is designed to tolerate small translations and rotations. That is attractive, but residual translation should first be fixed explicitly. Adding a more invariant metric before fixing the transform convention can hide a correctable registration error.

### 16.9 Build a harness before changing the algorithm

A harness and golden set will eventually be useful for calibrating weights and quantifying accuracy. They are not prerequisites for correcting phase semantics, affine leakage, mask denominators, or structural scoring. The first implementation deliberately avoids threshold-heavy adaptive behavior.

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rigid seed estimated from wrong initial slice | Restrict its degrees of freedom; let every candidate receive bounded residual translation |
| Phase mask creates false zero-shift peak | Use soft apodization, no shared hard hole, allowed signed window, and wrap tests |
| Wrong candidate hides missing anatomy | Fixed reference ROI/denominator and explicit coverage treatment |
| Target-only structures are ignored | Uniform ROI weight floor and union-gradient gating |
| CS and LNCC dominate as duplicate signals | Pool them into one appearance family |
| Percentile ranks look like confidence | Keep raw margins; use ranks only for ordering fixed candidate sets |
| Fine scale becomes noise-sensitive | Retain 128/64 evidence and inspect family disagreement |
| Search misses a candidate outside ±40 | Fixed boundary extension now; physical-overlap bounds later |
| Full-resolution memory grows | Keep coarse data only for the bounded window and fine data only for the shortlist |
| Final affine restarts or composes backward | Residual prewarp design plus transform-chain tests |
| 2.5D pairs wrong neighbors | Require validated physical order/spacing; skip when unavailable |
| Many uncalibrated thresholds creep in | Fixed K, fixed resolutions, fixed window, fixed phase bound, diagnostic-only confidence initially |
| Tuned optimizer or 512 px final registration raises per-date time | Keep 256 as the coarse rung; escalate iterations or the 512 px rung only when the 256 px residual is weak; keep stock defaults as fallback; log and budget per-date registration time |

## 18. Recommended first implementation slice

The smallest coherent accuracy experiment is:

1. use a rigid shared seed rather than affine;
2. return a signed phase correction and search only a fixed allowed residual window;
3. compose `Translate(δ) ∘ T_seed` and rewarp each original candidate once;
4. return fractional warp validity;
5. score every slice in the existing ±40 window;
6. compute mask-normalized 128/64 appearance and boundary channels against a fixed reference denominator;
7. form a fixed five-peak-plus-neighbors shortlist;
8. fine-score that fixed set at 256/128/64;
9. rank two families with tie-aware midranks and select the slice;
10. run the final affine as a residual transform initialized from the winner.

The next increment is geometry-gated three-slice scoring. Candidate-specific rigid re-registration remains optional until the transform adapter and parser can support it without ambiguity.

## 19. Expected mechanism of improvement

This plan is intended to reduce “plausible but a few slices off” results through four mechanisms:

1. a wrong seed slice can no longer deform every candidate with shear or anisotropic scale;
2. the correct candidate’s residual translation is removed before local structure is compared;
3. fine internal anatomy and boundaries participate in selection instead of being collapsed into a 64×64 phase peak;
4. cropped, missing, or target-only anatomy cannot silently disappear from the comparison;
5. once the correct slice is fixed, its in-plane transform is recovered by a converged optimizer at higher resolution, tightening the final overlay.

The guiding principle is:

> Use rigid geometry to limit pose, phase correlation to estimate bounded translation, perceptual structure to rank aligned slices, and affine refinement only after depth is fixed.
