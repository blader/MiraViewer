# Align All Structure-First Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Align All choose the slice, residual in-plane translation, and final post-selection affine refinement with the most similar anatomy when direct intensity correspondence is weak, nonlinear, or misleading.

**Architecture:** Replace the current equal appearance/boundary vote with a structure-weighted score. A deterministic 2D adaptation of the Modality Independent Neighbourhood Descriptor (MIND) captures local anatomical layout, normalized gradient fields (NGF) retain shared boundary evidence, and direct CS-SSIM/LNCC appearance becomes a 20% supporting signal. Residual phase correction operates on structural edge energy instead of normalized intensity. After the winning slice is fixed, generate three residual-affine proposals—seed-only identity, the existing intensity/MI Elastix result, and an Elastix result estimated from scalar structural edge energy—then choose among them using only fixed-domain MIND+NGF evidence. The initial shared rigid seed, bounded candidate search, and shortlist remain unchanged.

**Tech stack:** React 19, TypeScript 5.9, Vitest 4, Cornerstone, ITK-Wasm/Elastix, browser-native typed arrays. No new runtime dependency or model asset.

## Global constraints

- Preserve the offline, browser-only architecture. Do not add a server, network call, model download, or new package.
- Do not build a benchmark harness or golden dataset in this change. Use deterministic generated phantoms and relational assertions.
- Keep Align All's product semantics: compare the selected sequence longitudinally across dates. Robustness to intensity differences must not silently broaden selection across unrelated sequence combinations.
- Structure receives the dominant aggregate influence: MIND and NGF together carry 80% of the active rank; CS-SSIM/LNCC carry 20%.
- Appearance may resolve a close structural decision. Even a maximum appearance-rank swing cannot overturn a structural-rank lead greater than `0.25`; smaller structural gaps may be overturned by design.
- Keep the shared pre-selection transform rigid plus bounded residual translation. Do not run affine registration per candidate.
- Keep final affine refinement strictly after the winning slice is selected. The selected slice receives exactly two Elastix residual-affine attempts: the current intensity/MI attempt and a structural-edge-energy attempt. Neither may influence slice selection.
- Keep the initial shared rigid registration and its Elastix objective unchanged.
- Do not replace or retune Elastix's affine parameter map in this change. Reuse the existing affine runner once on intensity and once on the scalar structural representation; MIND+NGF choose the final proposal outside Elastix.
- The selector synthesizes the winning rigid-plus-translation transform with an identity residual as the seed-only proposal; callers cannot omit or corrupt it. The selector must never return a proposal whose structural score is lower than seed-only by more than the numerical tie epsilon `1e-6`.
- Final affine selection uses only MIND and NGF, averaged as equal structural families after averaging each family across active scales. CS-SSIM, LNCC, MI, and NMI remain diagnostics and do not vote at this stage.
- Reject non-finite, singular, orientation-reversing, or excessively displaced residual affine proposals before structural scoring. Reuse the existing residual-translation budget as the geometric guard: maximum L-infinity displacement of any image corner under the residual must be at most `16 / 128 = 0.125` of the image width (`32` px at `256`). Do not add separate scale, shear, rotation, or translation thresholds.
- Score structural agreement on the fixed reference domain and compute candidate-independent reverse source-domain coverage. Forward coverage loss is already penalized by the fixed-denominator structural score, so the reverse guard targets only excess one-sided source loss: `sourceLoss = seed.sourceCoverage - proposal.sourceCoverage`, `forwardLoss = seed.forwardCoverage - proposal.forwardCoverage`, and the proposal is ineligible when `sourceLoss - forwardLoss > 1 / size + 1e-6`. Keep `min(forwardCoverage, sourceCoverage)` as a diagnostic, not the rejection predicate. This rejects a crop/zoom that keeps the fixed domain full while discarding moving anatomy, while admitting ordinary translations whose two directional losses are comparable. The one-pixel allowance absorbs bilinear/discrete boundary effects without making reverse appearance or reverse structural differences a vote.
- Preserve fixed reference-space weighting, shape-aware anatomical support, fractional warp validity, missing-support penalties, and lesion exclusion semantics.
- For final-affine scoring, expand the fixed lesion exclusion by the entire `0.125`-FOV residual budget before per-scale MIND-footprint dilation, so an admissible residual cannot move excluded pixels back into structural votes.
- Dilate the effective exclusion and validity footprint by the complete MIND patch-plus-offset radius. Descriptor samples may not see across excluded or invalid pixels.
- Process candidate descriptors serially and discard them after scoring. Do not cache descriptors for the whole search window.
- Keep stage-local rank universes. Never compare coarse percentiles directly with fine percentiles.
- Keep current cancellation and main-thread yielding behavior.
- Reuse the returned Elastix worker sequentially when an attempt succeeds. The registration adapter must terminate and invalidate its worker on every failed pipeline attempt; the hook then clears its local handle and reacquires. Check cancellation between attempts and before applying the selected proposal.
- Treat all constants in this plan as deterministic engineering defaults, not calibrated clinical thresholds.
- Do not restore the deleted `frontend/src/utils/mind.ts`. Its four-offset experimental metric was disconnected from production and did not implement the present fixed-domain/validity contract.
- Do not claim population-level accuracy from these tests. The acceptance claim is narrower: the production decision path now makes local structure primary and passes the specified regressions.

---

## Why this plan replaces the previous scoring direction

The prior proposal correctly separated pose estimation from slice selection, introduced a fixed anatomical domain, and replaced phase-peak selection with local scoring. It still makes three assumptions that are too intensity-heavy for the clarified goal:

1. residual phase correction consumes normalized intensities; and
2. rank fusion gives the CS-SSIM/LNCC appearance family the same vote as NGF; and
3. the single final affine result is estimated from intensity and applied unconditionally, even when it lowers structural agreement relative to the already-good rigid-plus-translation seed.

Percentile normalization removes display offset and scale, but it cannot make two scans structurally comparable when their tissue intensities have a nonlinear or nonfunctional relationship. The required invariant is instead:

> Corresponding anatomy should retain similar local spatial relationships even when its direct intensity values do not correspond.

MIND was designed around that invariant. It measures patch relationships inside each image separately, normalizes those relationships by local variation, and only then compares the descriptors across images. The original paper reports robustness to nonfunctional intensity relationships, noise, and bias fields: [Heinrich et al., Medical Image Analysis 2012](https://doi.org/10.1016/j.media.2012.05.008). NGF remains a useful independent boundary representation: [Haber and Modersitzki, Methods of Information in Medicine 2007](https://pubmed.ncbi.nlm.nih.gov/17492115/).

This plan does not make intensity irrelevant. CS-SSIM and LNCC remain useful when scans do preserve appearance. They become weak supporting evidence rather than half of the decision.

## Resulting data flow

```text
reference render
   |-- source normalization ------------------------------+
   |-- structural edge energy -> prepared phase FFT       |
   |-- fixed anatomical domain and weights                |
   `-- per-scale MIND descriptor + NGF gradients          |
                                                          |
candidate render                                           |
   |-- source normalization                               |
   |-- shared rigid seed warp                             |
   |-- structural edge energy -> bounded phase correction|
   |-- rewarp original normalized candidate once         |
   `-- per-scale candidate MIND + NGF + weak appearance --+
                                                          |
       MIND ranks -------+                                |
                         +-> structural rank (80%) --+     |
       NGF ranks --------+                           +-> perceptual rank
                                                     |     |
       CS/LNCC appearance rank (20%) ----------------+     |
                                                          |
coarse fixed-universe ranking -> fixed fine shortlist -----+
                                                          |
fine fixed-universe ranking -> winning slice
                                                          |
seed-only / intensity-affine / structural-affine proposals
                     |
fixed-domain MIND+NGF proposal selection
                     |
selected residual affine -> panel settings
```

## File map

| Path                                                 | Responsibility after this change                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/utils/mindDescriptor.ts`               | Dense 2D MIND adaptation, descriptor-footprint validity, and fixed-denominator descriptor agreement.                    |
| `frontend/src/utils/perceptualSliceSimilarity.ts`    | Prepare per-scale MIND/NGF/appearance references, score aligned candidates, and fuse structure-first ranks.             |
| `frontend/src/utils/imageFeatures.ts`                | Produce the scalar structural edge-energy image used by residual phase correction.                                      |
| `frontend/src/utils/structuralAffineSelection.ts`    | Score admissible final residual-affine proposals on original normalized pixels and choose by MIND+NGF with seed fallback. |
| `frontend/src/utils/elastixRegistration.ts`          | Run scalar rigid/affine attempts and terminate/invalidate the owned worker on every failed attempt so fallback work cannot reuse a poisoned cache. |
| `frontend/src/hooks/useAutoAlign.ts`                 | Wire structural phase inputs, stage scoring, debug provenance, shortlist selection, and final winner selection.         |
| `frontend/src/utils/alignmentSliceScoreStore.ts`     | Persist MIND, structural rank, family activity, and phase-input provenance for debugging.                               |
| `frontend/src/components/DicomViewer.tsx`            | Display the new structural diagnostics when alignment debugging is enabled.                                             |
| `frontend/tests/helpers/alignmentSynthetic.ts`       | Generate deterministic anatomy labels, contrast renderings, structural distractors, nonlinear remaps, translations, and independently sampled affine fixtures. |
| `frontend/tests/mindDescriptor.test.ts`              | Prove descriptor invariants and footprint behavior directly.                                                            |
| `frontend/tests/perceptualSliceSimilarity.test.ts`   | Prove structure-first ranking, fixed denominator, exclusions, and fallbacks.                                            |
| `frontend/tests/phaseCorrelation.test.ts`            | Prove structural phase correction under misleading intensity relationships.                                             |
| `frontend/tests/perceptualAlignmentPipeline.test.ts` | Exercise the pure normalization-to-ranking path across a known residual transform.                                      |
| `frontend/tests/structuralAffineSelection.test.ts`   | Prove final affine proposal scoring, seed-only non-regression, fixed-domain penalties, and deterministic tie behavior.    |
| `frontend/tests/useAutoAlign.test.tsx`               | Prove the production hook selects structurally and runs affine only after selection.                                    |
| `frontend/tests/DicomViewer.test.tsx`                | Extend the existing viewer tests to prove alignment-debug UI exposes the structural decision and flat-family states.    |

## Public and internal interfaces

Create the descriptor boundary in `frontend/src/utils/mindDescriptor.ts`:

```ts
export type MindOffset2D = Readonly<{ dx: number; dy: number }>;

export type MindDescriptor2D = {
  size: number;
  channelCount: number;
  patchRadius: number;
  offsets: readonly MindOffset2D[];
  footprintRadius: number;
  /** Pixel-major layout: values[pixelIndex * channelCount + channelIndex]. */
  values: Float32Array;
  /** One only where the complete patch-plus-offset footprint is inside the image. */
  validCenters: Uint8Array;
};

export type MindAgreement = {
  /** Fixed-reference-denominator agreement in [0, 1]; higher is better. */
  score: number;
  /** Observed mean absolute descriptor distance in [0, 1]; lower is better. */
  meanDistance: number;
  /** Fixed-reference-weighted valid support before division by the denominator. */
  coverageNumerator: number;
};

export function computeMindDescriptor2D(
  pixels: Float32Array,
  size: number,
): MindDescriptor2D;

export function scoreMindDescriptorAgreement(
  reference: MindDescriptor2D,
  candidate: MindDescriptor2D,
  referenceWeights: Float32Array,
  candidateValidity: Float32Array,
): MindAgreement;
```

Extend the perceptual component contracts in `frontend/src/utils/perceptualSliceSimilarity.ts`:

```ts
export type PerceptualScaleComponents = {
  size: number;
  mind: number;
  rawMindDistance?: number;
  contrastStructure: number;
  rawContrastStructure?: number;
  lncc: number;
  rawLncc?: number;
  ngf: number;
  rawNgf?: number;
  lowerQuartile: number;
};

export type RankedPerceptualCandidate<T extends PerceptualCandidate> = T & {
  mindRank: number;
  appearanceRank: number;
  boundaryRank: number;
  structuralRank: number;
  perceptualRank: number;
  mindActive: boolean;
  appearanceActive: boolean;
  boundaryActive: boolean;
  structuralActive: boolean;
};
```

Add one scalar phase representation in `frontend/src/utils/imageFeatures.ts`:

```ts
export function buildStructuralPhaseImageSquare(
  normalizedPixels: Float32Array,
  size: number,
): Float32Array;

export function erodeFractionalSupportSquare(
  support: Float32Array,
  size: number,
  radius: number,
): Float32Array;
```

The function returns robustly scaled central-difference gradient magnitude. It must preserve a zero canvas, remain finite, and return an all-zero array for a flat input.

Create the final proposal boundary in `frontend/src/utils/structuralAffineSelection.ts`:

```ts
export type FinalAffineProposalKind =
  | "seed-only"
  | "intensity-elastix"
  | "structure-elastix";

export type OptimizerFinalAffineProposal = {
  kind: Exclude<FinalAffineProposalKind, "seed-only">;
  /** Residual moving-to-fixed transform applied after winningWarp. */
  residualMovingToFixed: StandardAffine2D;
};

export type ScoredFinalAffineProposal = {
  kind: FinalAffineProposalKind;
  residualMovingToFixed: StandardAffine2D;
  eligible: true;
  /** residualMovingToFixed composed after the winning rigid-plus-phase warp. */
  totalMovingToFixed: StandardAffine2D;
  components: {
    forward: PerceptualComponents;
    sourceCoverage: number;
  };
  mindScore: number;
  ngfScore: number;
  structuralScore: number;
  bidirectionalCoverage: number;
  deformationMagnitude: number;
};

export type RejectedFinalAffineProposal = {
  kind: Exclude<FinalAffineProposalKind, "seed-only">;
  residualMovingToFixed: StandardAffine2D;
  eligible: false;
  rejectionReason:
    | "non-finite"
    | "singular"
    | "orientation-reversing"
    | "excessive-displacement"
    | "coverage-regression";
  structuralScore?: number;
  bidirectionalCoverage?: number;
  deformationMagnitude?: number;
};

export type FinalAffineSelection = {
  proposals: readonly (ScoredFinalAffineProposal | RejectedFinalAffineProposal)[];
  selected: ScoredFinalAffineProposal;
  fixedScoringExclusionRect?: ExclusionMask;
  sourceExclusionRect?: ExclusionMask;
};

export function selectFinalAffineProposal(options: {
  normalizedReference: Float32Array;
  movingPixels: Float32Array;
  size: number;
  scales: readonly number[];
  winningWarp: WarpTransform;
  fixedExclusionRect?: ExclusionMask;
  optimizerProposals: readonly OptimizerFinalAffineProposal[];
}): FinalAffineSelection;
```

The single selection operation validates each optimizer residual, synthesizes seed-only identity, prepares final-stage reference domains, scores all proposals, and chooses the winner before returning. Callers never receive an intermediate evaluation set that can omit, duplicate, or corrupt seed-only.

If an exclusion exists, build two proposal-independent domains:

1. **Fixed scoring exclusion:** expand the original fixed rectangle by exactly `0.125 * size` full-resolution pixels, then pass that expanded rectangle to `preparePerceptualReference(normalizedReference, size, { scales, exclusionRect })`. Its existing per-scale weight builder adds that scale's MIND footprint, so lesion pixels cannot move out of the excluded vote under any admissible residual or leak through a descriptor patch.
2. **Canonical moving-source exclusion:** compute `maximumMindFootprintAtFullResolution = max(scale.mind.footprintRadius * size / scale.size)` from a temporary prepared fixed reference, expand the original fixed rectangle by `0.125 * size + maximumMindFootprintAtFullResolution`, then inverse-map that one rectangle through `winningWarp`. Normalize `movingPixels` exactly once with this source exclusion and prepare the moving-source coverage reference with the same rectangle.

Do not union proposal-mapped rectangles: a bad proposal must not change seed normalization or exclude normal anatomy between disjoint boxes. Excluded pixel values may remain in normalized arrays, but expanded fixed weights plus descriptor-footprint dilation make them unable to vote in final forward MIND/NGF.

For each geometrically admissible proposal, warp the shared normalized moving slice into the fixed grid, call `scoreAlignedCandidate` with fractional validity, and derive `mindScore` and `ngfScore` by averaging each forward family over scales. Set `structuralScore = (mindScore + ngfScore) / 2`. Then inverse-warp `normalizedReference` into the moving grid, call `scoreAlignedCandidate` against the prepared moving-source reference, and use only its `coverage` as `sourceCoverage`; reverse MIND/NGF/appearance are not votes. Set `bidirectionalCoverage = min(forward.coverage, sourceCoverage)`. Do not multiply structural score by coverage again because the forward structural channels already retain missing support in their fixed denominator.

`deformationMagnitude` is the maximum L-infinity displacement of the four image corners under the residual divided by `size`. Unlike standard-affine `b`, this value is invariant to how a centered affine is represented. It is a deterministic tie-break, not an extra score, and never overrides a structural difference greater than `1e-6`.

## Fusion semantics

For each active resolution, compute stage-local percentile midranks for MIND, NGF, CS-SSIM, and LNCC. Then apply:

```ts
const STRUCTURAL_RANK_WEIGHT = 0.8;
const APPEARANCE_RANK_WEIGHT = 0.2;

mindRank = mean(active per-scale MIND ranks);
boundaryRank = mean(active per-scale NGF ranks);
structuralRank = mean(non-null mindRank, non-null boundaryRank);
appearanceRank = mean(active per-scale CS-SSIM ranks, active per-scale LNCC ranks);

if (structuralRank != null && appearanceRank != null) {
  perceptualRank =
    STRUCTURAL_RANK_WEIGHT * structuralRank +
    APPEARANCE_RANK_WEIGHT * appearanceRank;
} else if (structuralRank != null) {
  perceptualRank = structuralRank;
} else if (appearanceRank != null) {
  perceptualRank = appearanceRank;
} else {
  perceptualRank = normalizedIndexPriorRank;
}
```

This has three important consequences:

- Structure supplies four times the aggregate influence of appearance. Appearance can still resolve close structural ranks; it cannot overturn a structural-rank gap greater than `0.25`.
- If one structural channel is flat, the other still receives the full structural share.
- Appearance becomes the fallback only when no structural channel discriminates the fixed candidate set.

## Final affine proposal semantics

Final affine refinement is a proposal-and-gate stage, not a third slice-ranking family:

1. The **seed-only** proposal is synthesized internally as an identity residual after the winning rigid-plus-phase transform. It is always present and cannot fail.
2. The **intensity-Elastix** proposal is the existing affine call on the reference render and the winning slice prewarped by rigid-plus-phase.
3. The **structure-Elastix** proposal runs the same affine adapter on `buildStructuralPhaseImageSquare` outputs. Build candidate structure in source space after source-space exclusion inpainting, then prewarp it; never differentiate warped padding.
4. Score target-to-reference structure against the prepared fine reference. Independently compute reverse reference-to-target coverage against one prepared moving-source domain; reverse structural and appearance values do not vote.
5. Reject an optimizer proposal if its residual moves any corner by more than `0.125 * size`, or if its seed-relative reverse source-coverage loss exceeds its seed-relative forward-coverage loss by more than `1 / size + 1e-6`. Keep bidirectional coverage as a diagnostic. The size-aware one-pixel tolerance is only for directional coverage discretization; it does not change the structural-score epsilon.
6. Among eligible proposals, find the maximum `structuralScore`, restrict contenders to proposals within `1e-6` of that maximum, then prefer lower `deformationMagnitude` and deterministic kind order `seed-only`, `structure-elastix`, `intensity-elastix`. Do not encode the epsilon in a pairwise sort comparator; approximate equality is non-transitive.
7. Because seed-only participates in the same fixed-domain score, neither Elastix proposal may degrade the chosen structural score beyond the numerical tie epsilon. MI/NMI never override that gate.
8. After selection, warp the original raw winning render under the selected total target-to-reference transform for target histogram statistics and compute the reported MI/NMI from that selected resample. Do not report the structural-image Elastix NMI as if it measured raw-image agreement.

Elastix currently receives one scalar fixed image and one scalar moving image through the local ITK-Wasm adapter. This plan therefore uses scalar edge energy for the structural proposal and keeps multi-channel MIND outside Elastix as the authoritative gate. It does not add a multi-metric pipeline wrapper or a direct affine optimizer over MIND.

Strengthen the existing worker-lifecycle contract in `frontend/src/utils/elastixRegistration.ts`: the `register2DWithElastix` pipeline catch must call its existing `abortActiveWorker()` for every thrown pipeline/parameter-map error before rethrowing, not only timeout or abort. The runner owns the active worker at that point and is the only layer that can reliably evict an internally reacquired worker.

---

## Validation discipline and adversarial review gate

Every task below is incomplete until a fresh independent reviewer passes both intent checks:

1. **Task intent:** Did the implementation satisfy that task's acceptance criteria in behavior, not merely compile or make its new tests green?
2. **Plan intent:** Does the implementation make Align All structure-first without weakening the fixed-domain, validity, transform, cancellation, or offline constraints above?

Give the reviewer this complete plan file, not a summary, plus the current task's acceptance criteria. Instruct it to assume both intents failed and inspect the repository, diff, tests, and available runtime evidence directly. The reviewer must cite concrete evidence and return either `both intents satisfied` or explicit gaps. Record the actual model and reasoning level resolved by the review tool. If gaps are found, fix them and dispatch a fresh reviewer; do not continue the same review thread. If the opposite CLI is unavailable, disclose that the gate did not run and do not substitute self-review. When explicitly requested during execution, `$adversarial-execution` owns the runnable gate procedure.

## Execution prerequisite for the current dirty worktree

Several alignment files named below already contain uncommitted work. A path-scoped `git add` would stage the entire existing delta in that file, not only the current task's edits. Before executing Task 1, choose one safe mode:

1. establish an explicitly authorized baseline commit containing the existing alignment work; or
2. create an isolated worktree at that baseline and transfer only the intended alignment patch; or
3. execute without intermediate commits and hand back one reviewed scoped diff.

The commit commands below are conditional checkpoints. Run them only in mode 1 or 2 with a clean, known baseline. In mode 3, skip every commit step; never stage or discard the user's pre-existing changes merely to satisfy plan bookkeeping.

---

### Task 1: Add deterministic anatomy and contrast fixtures

**Intent:** Express the real failure mode without introducing a corpus, snapshot, or calibrated threshold: identical anatomy rendered through a misleading intensity relationship must be distinguishable from an intensity-favored wrong structure.

**Files:**

- Create: `frontend/tests/helpers/alignmentSynthetic.ts`
- Test: `frontend/tests/mindDescriptor.test.ts`

**Interfaces:**

- Produces: `makeTissueLabelPhantom`, `renderTissueContrast`, `relocateInternalStructures`, `remapForeground`, `translateZeroFilled`, and the independent affine fixture renderer `renderMovingFromFixed` for later tasks.
- Consumes: no production implementation.

**Acceptance criteria:**

- The phantom contains an outer head domain, paired orbital structures, thin connecting nerves, paired ventricular structures, and one asymmetric landmark.
- Contrast renderings may permute tissue brightness non-monotonically while leaving the zero canvas unchanged.
- The wrong-structure distractor preserves every label count, and therefore preserves the rendered histogram for a fixed lookup table.
- Every declared non-canvas label exists at 32, 64, 128, and 256 pixels; paired orbit and ventricular labels each form two connected components, and the landmark remains asymmetric.
- `NONFUNCTIONAL_CONTRAST` is demonstrably not one affine mapping of `REFERENCE_CONTRAST` across all tissue labels.
- Fixtures contain no randomness, files, DICOM data, or clinical claims.
- `renderMovingFromFixed` uses a test-owned bilinear sampler rather than production warp code, so affine recovery tests do not generate their input and evaluate it with the same implementation.

- [ ] **Step 1: Create the deterministic fixture helper**

Use integer labels so anatomy and appearance remain independently controllable:

```ts
export const Tissue = {
  canvas: 0,
  outer: 1,
  inner: 2,
  orbit: 3,
  nerve: 4,
  ventricle: 5,
  landmark: 6,
} as const;

export type TissueLabel = (typeof Tissue)[keyof typeof Tissue];
export type TissueContrast = Readonly<Record<TissueLabel, number>>;

export const REFERENCE_CONTRAST: TissueContrast = {
  0: 0,
  1: 0.18,
  2: 0.62,
  3: 0.86,
  4: 0.74,
  5: 0.28,
  6: 0.96,
};

export const NONFUNCTIONAL_CONTRAST: TissueContrast = {
  0: 0,
  1: 0.72,
  2: 0.24,
  3: 0.16,
  4: 0.88,
  5: 0.67,
  6: 0.36,
};

export function renderTissueContrast(
  labels: Uint8Array,
  contrast: TissueContrast,
): Float32Array {
  return Float32Array.from(labels, (label) => contrast[label as TissueLabel]);
}

export function remapForeground(
  pixels: Float32Array,
  remap: (value: number) => number,
): Float32Array {
  return Float32Array.from(pixels, (value) =>
    value === 0 ? 0 : Math.max(0.001, Math.min(1, remap(value))),
  );
}

export type SyntheticStandardAffine2D = Readonly<{
  A: Readonly<{
    m00: number;
    m01: number;
    m10: number;
    m11: number;
  }>;
  b: Readonly<{ x: number; y: number }>;
}>;

/**
 * Generate moving[m] = fixed[movingToFixed(m)]. A production moving-to-fixed
 * warp should therefore recover fixed when given the same transform.
 */
export function renderMovingFromFixed(
  fixed: Float32Array,
  size: number,
  movingToFixed: SyntheticStandardAffine2D,
): Float32Array {
  if (fixed.length !== size * size) throw new Error("fixed length mismatch");
  const moving = new Float32Array(fixed.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fixedX =
        movingToFixed.A.m00 * x +
        movingToFixed.A.m01 * y +
        movingToFixed.b.x;
      const fixedY =
        movingToFixed.A.m10 * x +
        movingToFixed.A.m11 * y +
        movingToFixed.b.y;
      moving[y * size + x] = bilinearZeroSample(fixed, size, fixedX, fixedY);
    }
  }
  return moving;
}
```

Implement `makeTissueLabelPhantom(size)` with normalized ellipse/segment predicates so it produces the same anatomy at 32, 64, 128, and 256 pixels. Implement `relocateInternalStructures(labels, size)` by swapping equal-sized orbit/ventricle/landmark regions without changing any label count. Implement `translateZeroFilled(input, size, dx, dy)` with integer source-to-target indexing and a zero-filled destination. Implement test-local `bilinearZeroSample` by accumulating the four in-bounds neighbors with their bilinear weights; out-of-bounds neighbors contribute zero. Do not import `warpAffine.ts`.

- [ ] **Step 2: Add fixture invariant tests before importing production code**

```ts
test("wrong-structure fixture preserves label counts and rendered histogram", () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const wrongLabels = relocateInternalStructures(labels, size);
  const reference = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const wrong = renderTissueContrast(wrongLabels, REFERENCE_CONTRAST);

  expect(Array.from(wrongLabels).sort()).toEqual(Array.from(labels).sort());
  expect(Array.from(wrong).sort()).toEqual(Array.from(reference).sort());
  expect(wrong).not.toEqual(reference);
});

test("nonfunctional contrast is not an affine remap of the reference", () => {
  const labels = makeTissueLabelPhantom(64);
  const reference = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const changed = renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST);

  const referenceA = REFERENCE_CONTRAST[1];
  const referenceB = REFERENCE_CONTRAST[2];
  const changedA = NONFUNCTIONAL_CONTRAST[1];
  const changedB = NONFUNCTIONAL_CONTRAST[2];
  const scale = (changedB - changedA) / (referenceB - referenceA);
  const offset = changedA - scale * referenceA;

  expect(changed).not.toEqual(reference);
  expect(
    changed.every((value, index) => reference[index] !== 0 || value === 0),
  ).toBe(true);
  expect(NONFUNCTIONAL_CONTRAST[3]).not.toBeCloseTo(
    scale * REFERENCE_CONTRAST[3] + offset,
    6,
  );
});

test.each([32, 64, 128, 256])(
  "phantom preserves its structural labels at %ipx",
  (size) => {
    const labels = makeTissueLabelPhantom(size);
    for (const label of [
      Tissue.outer,
      Tissue.inner,
      Tissue.orbit,
      Tissue.nerve,
      Tissue.ventricle,
      Tissue.landmark,
    ]) {
      expect(labels.includes(label)).toBe(true);
    }
    expect(countConnectedComponents(labels, size, Tissue.orbit)).toBe(2);
    expect(countConnectedComponents(labels, size, Tissue.ventricle)).toBe(2);
    expect(labelTouchesLabel(labels, size, Tissue.nerve, Tissue.orbit)).toBe(
      true,
    );
    expect(labelTouchesLabel(labels, size, Tissue.nerve, Tissue.inner)).toBe(
      true,
    );
    expect(
      normalizedLabelCentroid(labels, size, Tissue.landmark).x,
    ).toBeGreaterThan(0.5);
  },
);

test("remapping and translation preserve canvas and signed direction", () => {
  const pixels = new Float32Array([0, 0.25, 0.75, 1]);
  expect(Array.from(remapForeground(pixels, (value) => value * 2))).toEqual([
    0, 0.5, 1, 1,
  ]);

  const translated = translateZeroFilled(
    new Float32Array([1, 0, 0, 0]),
    2,
    1,
    1,
  );
  expect(Array.from(translated)).toEqual([0, 0, 0, 1]);
});

test("independent affine fixture renderer follows moving-to-fixed direction", () => {
  const fixed = new Float32Array([
    1, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ]);
  const moving = renderMovingFromFixed(fixed, 3, {
    A: { m00: 1, m01: 0, m10: 0, m11: 1 },
    b: { x: -1, y: 0 },
  });
  expect(Array.from(moving)).toEqual([
    0, 1, 0,
    0, 0, 0,
    0, 0, 0,
  ]);
});
```

`countConnectedComponents`, `labelTouchesLabel`, and `normalizedLabelCentroid` are test-only helpers in `alignmentSynthetic.ts`; implement four-neighbor flood fill, four-neighbor label contact, and normalized `(x / size, y / size)` centroids directly rather than importing production morphology code.

- [ ] **Step 3: Run the fixture-only tests**

Run:

```bash
cd frontend
npm run test -- tests/mindDescriptor.test.ts
```

Expected: fixture invariant tests pass at every declared resolution. No production behavior is claimed yet.

- [ ] **Step 4: Commit only the fixture scope when the execution prerequisite permits it**

```bash
git add frontend/tests/helpers/alignmentSynthetic.ts frontend/tests/mindDescriptor.test.ts
git commit -m "test: add structural alignment phantoms"
```

Do not stage unrelated dirty files.
Skip this checkpoint in execution mode 3.

---

### Task 2: Implement the dense 2D MIND adaptation

**Intent:** Produce a local-structure descriptor that can recognize the same spatial arrangement under nonfunctional tissue-intensity mappings, with explicit descriptor footprints and deterministic memory behavior.

**Files:**

- Create: `frontend/src/utils/mindDescriptor.ts`
- Modify: `frontend/src/utils/imageFeatures.ts`
- Modify: `frontend/tests/mindDescriptor.test.ts`
- Modify: `frontend/tests/imageFeatures.test.ts`

**Interfaces:**

- Consumes: normalized square `Float32Array` images and caller-owned reference weights/validity.
- Produces: `MindDescriptor2D`, `computeMindDescriptor2D`, `scoreMindDescriptorAgreement`, and the reusable `erodeFractionalSupportSquare` with the signatures defined above.

**Algorithm contract:**

1. Use a fixed ordered eight-neighbor 2D layout at one-pixel radius. This is an explicit 2D adaptation, not a claim of reproducing the paper's 3D six-neighbor topology.
2. Use a fixed separable Gaussian-like `3x3` patch kernel with normalized one-dimensional weights `[1, 2, 1] / 4`, preserving the paper's Gaussian-weighted patch-distance principle.
3. For each offset, form pointwise squared differences against the shifted image.
4. Aggregate each difference image with horizontal and vertical convolution using the fixed kernel.
5. Estimate local variation from the mean cardinal-channel patch distance.
6. Compute `exp(-patchDistance / max(localVariation, 1e-6))`.
7. Normalize each per-pixel descriptor so its maximum component is one.
8. Mark a center valid only when the complete patch-plus-offset footprint is in bounds.
9. Compare descriptors with mean absolute channel distance.
10. Erode fractional candidate validity with an allocation-bounded separable sliding-window minimum. Multiply agreement by this support and by both descriptors' `validCenters`, while retaining the fixed reference denominator.
11. Reject descriptor pairs whose size, ordered offsets, patch radius, or channel layout differ.

- [ ] **Step 1: Add failing descriptor behavior tests**

```ts
import {
  computeMindDescriptor2D,
  scoreMindDescriptorAgreement,
} from "../src/utils/mindDescriptor";

test("same anatomy under nonfunctional contrast beats an exact-histogram wrong structure", () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const referencePixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const matchingPixels = renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST);
  const wrongPixels = renderTissueContrast(
    relocateInternalStructures(labels, size),
    REFERENCE_CONTRAST,
  );
  const weights = Float32Array.from(labels, (label) =>
    label === Tissue.canvas ? 0 : 1,
  );
  const validity = new Float32Array(size * size).fill(1);

  const reference = computeMindDescriptor2D(referencePixels, size);
  const matching = scoreMindDescriptorAgreement(
    reference,
    computeMindDescriptor2D(matchingPixels, size),
    weights,
    validity,
  );
  const wrong = scoreMindDescriptorAgreement(
    reference,
    computeMindDescriptor2D(wrongPixels, size),
    weights,
    validity,
  );

  expect(matching.score).toBeGreaterThan(wrong.score);
  expect(matching.meanDistance).toBeLessThan(wrong.meanDistance);
});

test("descriptor agreement keeps invalid footprint in the fixed denominator", () => {
  const size = 64;
  const pixels = renderTissueContrast(
    makeTissueLabelPhantom(size),
    REFERENCE_CONTRAST,
  );
  const descriptor = computeMindDescriptor2D(pixels, size);
  const labels = makeTissueLabelPhantom(size);
  const weights = Float32Array.from(labels, (label) =>
    label === Tissue.canvas ? 0 : 1,
  );
  const full = new Float32Array(size * size).fill(1);
  const cropped = new Float32Array(size * size).fill(1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size / 2; x++) cropped[y * size + x] = 0;
  }

  const fullScore = scoreMindDescriptorAgreement(
    descriptor,
    descriptor,
    weights,
    full,
  );
  const croppedScore = scoreMindDescriptorAgreement(
    descriptor,
    descriptor,
    weights,
    cropped,
  );

  expect(fullScore.score).toBeGreaterThan(croppedScore.score);
  expect(fullScore.coverageNumerator).toBeGreaterThan(
    croppedScore.coverageNumerator,
  );
});

test("self agreement is exact and descriptor borders are explicitly invalid", () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const pixels = renderTissueContrast(labels, REFERENCE_CONTRAST);
  const descriptor = computeMindDescriptor2D(pixels, size);
  const weights = Float32Array.from(labels, (label) =>
    label === Tissue.canvas ? 0 : 1,
  );
  const validity = new Float32Array(size * size).fill(1);
  const self = scoreMindDescriptorAgreement(
    descriptor,
    descriptor,
    weights,
    validity,
  );

  expect(descriptor.footprintRadius).toBe(2);
  expect(descriptor.validCenters[0]).toBe(0);
  expect(descriptor.validCenters[2 * size + 2]).toBe(1);
  expect(self.score).toBeCloseTo(1, 6);
  expect(self.meanDistance).toBeCloseTo(0, 6);
});

test("fractional validity contributes once against the fixed denominator", () => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const descriptor = computeMindDescriptor2D(
    renderTissueContrast(labels, REFERENCE_CONTRAST),
    size,
  );
  const weights = Float32Array.from(labels, (label) =>
    label === Tissue.canvas ? 0 : 1,
  );
  const halfValidity = new Float32Array(size * size).fill(0.5);
  const score = scoreMindDescriptorAgreement(
    descriptor,
    descriptor,
    weights,
    halfValidity,
  );

  expect(score.score).toBeCloseTo(0.5, 6);
});

test("rejects incompatible lengths and descriptor layouts", () => {
  const descriptor = computeMindDescriptor2D(new Float32Array(64 * 64), 64);
  expect(() =>
    scoreMindDescriptorAgreement(
      descriptor,
      computeMindDescriptor2D(new Float32Array(32 * 32), 32),
      new Float32Array(64 * 64),
      new Float32Array(64 * 64),
    ),
  ).toThrow(/descriptor size/i);
  expect(() =>
    scoreMindDescriptorAgreement(
      descriptor,
      descriptor,
      new Float32Array(1),
      new Float32Array(64 * 64),
    ),
  ).toThrow(/weights/i);

  const reversedOffsets = {
    ...descriptor,
    offsets: [...descriptor.offsets].reverse(),
  };
  const wrongChannelCount = {
    ...descriptor,
    channelCount: descriptor.channelCount - 1,
  };
  const wrongFootprint = {
    ...descriptor,
    footprintRadius: descriptor.footprintRadius + 1,
  };
  const truncatedValues = {
    ...descriptor,
    values: descriptor.values.slice(1),
  };
  const truncatedCenters = {
    ...descriptor,
    validCenters: descriptor.validCenters.slice(1),
  };
  const weights = new Float32Array(64 * 64);
  const validity = new Float32Array(64 * 64).fill(1);

  for (const incompatible of [
    reversedOffsets,
    wrongChannelCount,
    wrongFootprint,
    truncatedValues,
    truncatedCenters,
  ]) {
    expect(() =>
      scoreMindDescriptorAgreement(descriptor, incompatible, weights, validity),
    ).toThrow(/descriptor (layout|length)/i);
  }
  expect(() =>
    scoreMindDescriptorAgreement(
      descriptor,
      descriptor,
      weights,
      new Float32Array(1),
    ),
  ).toThrow(/validity/i);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
cd frontend
npm run test -- tests/mindDescriptor.test.ts
```

Expected: fail because `../src/utils/mindDescriptor` does not exist.

- [ ] **Step 3: Implement descriptor construction**

Use channel-major scratch while constructing distances, then store the public descriptor pixel-major. Reuse one squared-difference buffer and one horizontal-convolution buffer across channels within a descriptor call.

```ts
const DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

const PATCH_KERNEL = [0.25, 0.5, 0.25] as const;

function defaultOffsets(): MindOffset2D[] {
  return DIRECTIONS.map(([dx, dy]) => ({ dx, dy }));
}

function sameDescriptorLayout(
  a: MindDescriptor2D,
  b: MindDescriptor2D,
): boolean {
  return (
    a.size === b.size &&
    a.channelCount === a.offsets.length &&
    b.channelCount === b.offsets.length &&
    a.channelCount === b.channelCount &&
    a.patchRadius === b.patchRadius &&
    a.footprintRadius === b.footprintRadius &&
    a.values.length === a.size * a.size * a.channelCount &&
    b.values.length === b.size * b.size * b.channelCount &&
    a.validCenters.length === a.size * a.size &&
    b.validCenters.length === b.size * b.size &&
    a.offsets.length === b.offsets.length &&
    a.offsets.every(
      (offset, index) =>
        offset.dx === b.offsets[index]?.dx &&
        offset.dy === b.offsets[index]?.dy,
    )
  );
}
```

Validate square lengths and nonzero sizes. Treat non-finite input samples as zero. Convolve the squared-difference field horizontally and vertically with `PATCH_KERNEL`, without reading across the image border. Set `patchRadius = 1`, derive `footprintRadius = patchRadius + max(abs(dx), abs(dy))`, and store a frozen copy of the ordered offsets in the descriptor. Normalize every valid descriptor by its maximum channel response; leave invalid centers zero.

- [ ] **Step 4: Implement linear-time fractional-support erosion**

Add `erodeFractionalSupportSquare` to `imageFeatures.ts`. Implement horizontal and vertical sliding-window minima with monotonic index deques, so work is `O(size²)` for any radius. Clamp non-finite inputs to zero and return a copy for radius zero. Add tests for radius zero, radius one, fractional values, flat arrays, and length mismatch.

- [ ] **Step 5: Implement fixed-denominator agreement**

First validate each descriptor's self-consistency, reject incompatible descriptor layouts, and require both `referenceWeights.length` and `candidateValidity.length` to equal `size²`. Erode `candidateValidity` once by the shared footprint radius. For each center with positive reference weight, retain that weight in `totalReferenceWeight`; set local support to zero unless both `reference.validCenters[index]` and `candidate.validCenters[index]` are one. Descriptor mismatch or invalid support contributes zero agreement without disappearing from the denominator.

```ts
const channelDistance = distanceSum / reference.channelCount;
const localAgreement = Math.max(0, Math.min(1, 1 - channelDistance));
const localValidity =
  reference.validCenters[index] && candidate.validCenters[index]
    ? erodedValidity[index]
    : 0;
agreementSum += referenceWeight * localValidity * localAgreement;
distanceSumObserved += referenceWeight * localValidity * channelDistance;
coverageNumerator += referenceWeight * localValidity;

return {
  score: totalReferenceWeight > 0 ? agreementSum / totalReferenceWeight : 0,
  meanDistance:
    coverageNumerator > 0 ? distanceSumObserved / coverageNumerator : 1,
  coverageNumerator,
};
```

- [ ] **Step 6: Run descriptor tests and static checks**

Run:

```bash
cd frontend
npm run test -- tests/mindDescriptor.test.ts tests/imageFeatures.test.ts
npx eslint src/utils/mindDescriptor.ts src/utils/imageFeatures.ts tests/mindDescriptor.test.ts tests/imageFeatures.test.ts tests/helpers/alignmentSynthetic.ts
```

Expected: all focused tests pass and ESLint exits zero.

- [ ] **Step 7: Commit the descriptor primitive when the execution prerequisite permits it**

```bash
git add frontend/src/utils/mindDescriptor.ts frontend/src/utils/imageFeatures.ts frontend/tests/mindDescriptor.test.ts frontend/tests/imageFeatures.test.ts
git commit -m "feat: add dense 2d mind descriptor"
```

Skip this checkpoint in execution mode 3.

---

### Task 3: Integrate MIND into fixed-domain perceptual scoring

**Intent:** Score MIND with exactly the same reference domain, exclusion, validity, coverage, and multi-scale semantics as the existing perceptual channels.

**Files:**

- Modify: `frontend/src/utils/perceptualSliceSimilarity.ts`
- Modify: `frontend/tests/perceptualSliceSimilarity.test.ts`

**Interfaces:**

- Consumes: `computeMindDescriptor2D` and `scoreMindDescriptorAgreement` from Task 2.
- Produces: `mind` and `rawMindDistance` in each `PerceptualScaleComponents` record.

**Acceptance criteria:**

- MIND is computed at every currently requested perceptual scale.
- The reference descriptor is prepared once per scale; only candidate descriptors are transient.
- Reference weights use `max(LOCAL_RADIUS + 1, mind.footprintRadius)` for both the outer safe border and exclusion dilation, preserving existing CS/LNCC/NGF safety.
- Missing or fractional target support lowers MIND against the fixed denominator.
- Existing CS-SSIM, LNCC, NGF, coverage, shape-aware domain, and exclusion tests remain green.

- [ ] **Step 1: Add failing integration tests**

```ts
test.each([
  [
    "nonfunctional LUT",
    (labels: Uint8Array) =>
      renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST),
  ],
  [
    "gamma remap",
    (labels: Uint8Array) =>
      remapForeground(
        renderTissueContrast(labels, REFERENCE_CONTRAST),
        (value) => value ** 2.2,
      ),
  ],
  [
    "sigmoid remap",
    (labels: Uint8Array) =>
      remapForeground(
        renderTissueContrast(labels, REFERENCE_CONTRAST),
        (value) => 1 / (1 + Math.exp(-10 * (value - 0.5))),
      ),
  ],
])(
  "MIND preserves matching local structure under %s",
  (_name, renderCandidate) => {
    const size = 64;
    const labels = makeTissueLabelPhantom(size);
    const reference = normalizePerceptualSource(
      renderTissueContrast(labels, REFERENCE_CONTRAST),
      size,
    );
    const matching = normalizePerceptualSource(renderCandidate(labels), size);
    const wrong = normalizePerceptualSource(
      renderTissueContrast(
        relocateInternalStructures(labels, size),
        REFERENCE_CONTRAST,
      ),
      size,
    );
    const validity = new Float32Array(size * size).fill(1);
    const prepared = preparePerceptualReference(reference, size, {
      scales: [64, 32],
    });

    const matchScore = scoreAlignedCandidate(
      prepared,
      matching,
      validity,
      size,
    );
    const wrongScore = scoreAlignedCandidate(prepared, wrong, validity, size);

    expect(matchScore.perScale.map((scale) => scale.size)).toEqual([64, 32]);
    expect(
      matchScore.perScale.every(
        (scale) =>
          Number.isFinite(scale.mind) && Number.isFinite(scale.rawMindDistance),
      ),
    ).toBe(true);
    expect(
      matchScore.perScale.every(
        (scale, index) => scale.mind > (wrongScore.perScale[index]?.mind ?? 1),
      ),
    ).toBe(true);
  },
);
```

Add one scale-level cross-check that computes `scoreMindDescriptorAgreement` directly from the prepared and candidate descriptors and requires the integrated `mind` value to match it. This prevents accidentally wiring NGF or another component into the MIND field.

Add a separate exclusion regression that changes only pixels inside the declared exclusion and asserts the MIND score is unchanged when weights are dilated by `max(LOCAL_RADIUS + 1, mind.footprintRadius)`. Keep the existing 64 px local-window leakage regression exact.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
cd frontend
npm run test -- tests/perceptualSliceSimilarity.test.ts
```

Expected: fail because `PerceptualScaleComponents` has no `mind` channel.

- [ ] **Step 3: Prepare reference descriptors per scale**

Extend `PreparedPerceptualScale`:

```ts
type PreparedPerceptualScale = {
  size: number;
  reference: Float32Array;
  weights: Float32Array;
  gradientX: Float32Array;
  gradientY: Float32Array;
  mind: MindDescriptor2D;
  totalWeight: number;
};
```

Compute the descriptor before weights and pass `safeBorder = Math.max(LOCAL_RADIUS + 1, mind.footprintRadius)` into `buildReferenceWeights`. Use the same maximum for the outer safe border and exclusion expansion. Do not change the shape-aware anatomical-domain construction.

- [ ] **Step 4: Score candidate descriptors once per scale**

After recovering conditional candidate intensity from fractional validity, compute one candidate descriptor and call:

```ts
const candidateMind = computeMindDescriptor2D(candidate, size);
const mindAgreement = scoreMindDescriptorAgreement(
  prepared.mind,
  candidateMind,
  prepared.weights,
  validity,
);
```

Return `mind: clamp01(mindAgreement.score)` and `rawMindDistance: mindAgreement.meanDistance`. Keep overall coverage computed once from the existing fixed reference weights; do not add MIND coverage a second time.

- [ ] **Step 5: Preserve the existing local lower-quartile meaning**

`MindAgreement` intentionally returns aggregates, not a per-center buffer. Leave `lowerQuartile` as the existing CS/LNCC/NGF local diagnostic and document that it does not include MIND. Do not invent an unavailable `mindContribution`, allocate a per-center MIND output only for this diagnostic, or turn the lower quartile into a ranking vote.

- [ ] **Step 6: Run perceptual and descriptor tests**

Run:

```bash
cd frontend
npm run test -- tests/mindDescriptor.test.ts tests/perceptualSliceSimilarity.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit the integrated channel when the execution prerequisite permits it**

```bash
git add frontend/src/utils/perceptualSliceSimilarity.ts frontend/tests/perceptualSliceSimilarity.test.ts
git commit -m "feat: score modality-independent slice structure"
```

Skip this checkpoint in execution mode 3.

---

### Task 4: Make structure primary in fixed-universe rank fusion

**Intent:** Give structural evidence four times the aggregate influence of appearance and make the exact boundary of that guarantee observable in tests.

**Files:**

- Modify: `frontend/src/utils/perceptualSliceSimilarity.ts`
- Modify: `frontend/src/hooks/useAutoAlign.ts`
- Modify: `frontend/tests/perceptualSliceSimilarity.test.ts`

**Interfaces:**

- Consumes: per-scale `mind`, `ngf`, `contrastStructure`, and `lncc` from Task 3.
- Produces: `mindRank`, `structuralRank`, activity flags, the 80/20 `perceptualRank` contract, and an exported `choosePerceptualWinner` used by both production and pure-pipeline tests.

**Acceptance criteria:**

- MIND and NGF each contribute one channel family inside `structuralRank`.
- CS-SSIM and LNCC remain pooled into one appearance family.
- Active structure receives 80% of the final rank whenever appearance is also active.
- A structural-rank lead greater than `0.25` survives even the maximum opposing appearance-rank swing; a smaller lead may be resolved by appearance.
- Flat channels are dropped before family averaging.
- Structural-only, appearance-only, and all-flat fallbacks are deterministic.
- Expected index affects only the all-flat fallback or an exact final tie.
- Winner selection sorts by descending `perceptualRank`, then seed distance, then ascending index through one shared exported helper.

- [ ] **Step 1: Replace the equal-vote regression with a structure-first regression**

```ts
test("two structural channels outweigh an appearance-favored distractor", () => {
  const ranked = rankFixedCandidateSet(
    [
      {
        index: 4,
        components: {
          coverage: 1,
          perScale: [
            {
              size: 64,
              mind: 0.9,
              contrastStructure: 0.2,
              lncc: 0.2,
              ngf: 0.9,
              lowerQuartile: 0.7,
            },
          ],
        },
      },
      {
        index: 5,
        components: {
          coverage: 1,
          perScale: [
            {
              size: 64,
              mind: 0.2,
              contrastStructure: 0.95,
              lncc: 0.95,
              ngf: 0.2,
              lowerQuartile: 0.3,
            },
          ],
        },
      },
    ],
    5,
  );

  expect(
    ranked.find((candidate) => candidate.index === 4)?.perceptualRank,
  ).toBeGreaterThan(
    ranked.find((candidate) => candidate.index === 5)?.perceptualRank ?? 0,
  );
});
```

Add tests where MIND is flat but NGF discriminates, both structural channels are flat but appearance discriminates, and all channels are flat so seed distance supplies the prior.

Add a ten-candidate counterexample around the weighting boundary. Build component values whose unique midranks produce:

```ts
const clearStructure = { structuralRank: 0.75, appearanceRank: 0.05 };
const appearanceFavored = { structuralRank: 0.45, appearanceRank: 0.95 };
expect(
  0.8 * clearStructure.structuralRank + 0.2 * clearStructure.appearanceRank,
).toBeGreaterThan(
  0.8 * appearanceFavored.structuralRank +
    0.2 * appearanceFavored.appearanceRank,
);

const closeStructure = { structuralRank: 0.55, appearanceRank: 0.05 };
const closeAppearanceFavored = { structuralRank: 0.45, appearanceRank: 0.95 };
expect(
  0.8 * closeStructure.structuralRank + 0.2 * closeStructure.appearanceRank,
).toBeLessThan(
  0.8 * closeAppearanceFavored.structuralRank +
    0.2 * closeAppearanceFavored.appearanceRank,
);
```

The production test must derive these relationships through `rankFixedCandidateSet` with ten candidates rather than testing only the arithmetic snippet. Assert numeric `mindRank`, `boundaryRank`, `structuralRank`, `appearanceRank`, activity flags, and final order. This prevents a future implementation from silently becoming lexicographic or equal-weighted.

Add a three-scale family-balance regression in which MIND discriminates at 256, 128, and 64 px while NGF discriminates only at 64 px. Assert `mindRank` is the mean of the three active MIND scale ranks, `boundaryRank` is the single active NGF rank, and `structuralRank === (mindRank + boundaryRank) / 2`. Three active MIND scales must not give MIND three times NGF's family weight. Assert `mindActive`, `boundaryActive`, and `structuralActive` are all true.

- [ ] **Step 2: Run the rank tests and verify red**

Run:

```bash
cd frontend
npm run test -- tests/perceptualSliceSimilarity.test.ts
```

Expected: the current equal appearance/boundary fusion fails the structural-majority assertion or the new type fields are absent.

- [ ] **Step 3: Implement family construction and weighted active fusion**

Collect scale-local MIND ranks separately from NGF ranks. First average active MIND scale ranks into `mindRank` and active NGF scale ranks into `boundaryRank`; then average the non-null family ranks into `structuralRank`. Do not flatten all active MIND and NGF scale channels into one array. Apply the top-level fusion formula in this plan's “Fusion semantics” section. Keep `CHANNEL_RANGE_EPSILON = 1e-6` and the existing tie-aware midrank implementation.

Use a helper that renormalizes only over active top-level families:

```ts
function fusePerceptualRanks(
  structuralRank: number | null,
  appearanceRank: number | null,
  priorRank: number,
): number {
  if (structuralRank != null && appearanceRank != null) {
    return 0.8 * structuralRank + 0.2 * appearanceRank;
  }
  return structuralRank ?? appearanceRank ?? priorRank;
}
```

Move the hook's current private winner comparator into this utility and export it:

```ts
export function choosePerceptualWinner<
  T extends { index: number; perceptualRank: number },
>(candidates: readonly T[], seedIndex: number): T {
  if (candidates.length === 0)
    throw new Error("Align All produced no fine slice candidates");
  return [...candidates].sort(
    (a, b) =>
      b.perceptualRank - a.perceptualRank ||
      Math.abs(a.index - seedIndex) - Math.abs(b.index - seedIndex) ||
      a.index - b.index,
  )[0];
}
```

Import this helper in `useAutoAlign.ts`; do not leave a second comparator there.

- [ ] **Step 4: Run all perceptual tests**

Run:

```bash
cd frontend
npm run test -- tests/mindDescriptor.test.ts tests/perceptualSliceSimilarity.test.ts
```

Expected: all tests pass, including existing validity, exclusion, histogram-distractor, and tie behavior.

- [ ] **Step 5: Commit rank fusion when the execution prerequisite permits it**

```bash
git add frontend/src/utils/perceptualSliceSimilarity.ts frontend/src/hooks/useAutoAlign.ts frontend/tests/perceptualSliceSimilarity.test.ts
git commit -m "feat: make alignment ranking structure first"
```

Skip this checkpoint in execution mode 3.

---

### Task 5: Estimate residual translation from structural edge energy

**Intent:** Prevent normalized-intensity phase correlation from applying a wrong residual translation before structural scoring.

**Files:**

- Modify: `frontend/src/utils/imageFeatures.ts`
- Modify: `frontend/src/hooks/useAutoAlign.ts`
- Modify: `frontend/tests/imageFeatures.test.ts`
- Modify: `frontend/tests/phaseCorrelation.test.ts`
- Create: `frontend/tests/perceptualAlignmentPipeline.test.ts`

**Interfaces:**

- Consumes: normalized and exclusion-inpainted images.
- Produces: `buildStructuralPhaseImageSquare`; prepared phase correlation now consumes that representation.
- Preserves: `PhaseCorrection`, its bounded signed semantics, zero-padded FFT, subpixel fit, and transform composition.

**Structural phase representation:**

1. Compute central-difference L1 gradient magnitude with the existing helper.
2. Find the 98th percentile of finite positive gradient magnitudes using a fixed 256-bin histogram.
3. Divide by that value and clamp to `[0, 1]`.
4. Preserve zeros and return all-zero output when no positive gradient exists.
5. Inpaint the lesion exclusion in each image's source space before taking gradients so the inpaint boundary cannot become a phase feature.
6. Compute the candidate structural representation in source space, then apply the rigid seed to that representation. Never differentiate `seedWarped.pixels`; doing so would turn validity-premultiplied warp padding into a false anatomical edge.
7. Recover conditional structural energy at fractional warp samples by dividing by geometric validity where validity exceeds `1e-6`.
8. Multiply source-local anatomical support by geometric validity eroded one pixel for the gradient stencil before phase preparation.

- [ ] **Step 1: Add focused edge-representation tests**

```ts
test("structural phase image preserves a boundary under exact polarity reversal", () => {
  const size = 64;
  const bright = new Float32Array(size * size);
  const dark = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bright[y * size + x] = x < size / 2 ? 0.2 : 0.8;
      dark[y * size + x] = x < size / 2 ? 0.8 : 0.2;
    }
  }

  const brightEdges = buildStructuralPhaseImageSquare(bright, size);
  const darkEdges = buildStructuralPhaseImageSquare(dark, size);

  expect(Array.from(darkEdges)).toEqual(Array.from(brightEdges));
  const correction = estimatePhaseCorrection(brightEdges, darkEdges, size, {
    fftSize: 128,
    maxCorrectionPx: 12,
  });
  expect(correction.correctionX).toBeCloseTo(0, 6);
  expect(correction.correctionY).toBeCloseTo(0, 6);
});

test.each([0, 0.5])(
  "flat input %f produces a neutral structural phase image",
  (value) => {
    expect(
      Array.from(
        buildStructuralPhaseImageSquare(
          new Float32Array(64 * 64).fill(value),
          64,
        ),
      ),
    ).toEqual(Array(64 * 64).fill(0));
  },
);
```

Add explicit non-finite handling: inject `NaN`, `Infinity`, and `-Infinity` into a small input and assert every output is finite.

- [ ] **Step 2: Add a failing known-translation regression**

```ts
test("structural phase finds a shifted match under a nonfunctional tissue LUT", () => {
  const size = 64;
  const dx = 7;
  const dy = -5;
  const labels = makeTissueLabelPhantom(size);
  const reference = buildStructuralPhaseImageSquare(
    normalizePerceptualSource(
      renderTissueContrast(labels, REFERENCE_CONTRAST),
      size,
    ),
    size,
  );
  const moving = buildStructuralPhaseImageSquare(
    normalizePerceptualSource(
      translateZeroFilled(
        renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST),
        size,
        dx,
        dy,
      ),
      size,
    ),
    size,
  );

  const correction = estimatePhaseCorrection(reference, moving, size, {
    fftSize: 128,
    maxCorrectionPx: 12,
  });

  expect(correction.correctionX).toBeCloseTo(-dx, 0);
  expect(correction.correctionY).toBeCloseTo(-dy, 0);
});
```

Add a signed-intensity counterexample using a foreground-preserving polarity reversal. Require raw intensity phase to miss the known displacement while structural phase recovers it. Add a cropped/off-frame candidate case with geometric validity support and require the structural correction to remain inside the configured bound without snapping to the artificial crop edge. Add an exclusion case in which a bright changing region is inpainted in source space and cannot move the phase peak.

- [ ] **Step 3: Run focused tests and verify red**

Run:

```bash
cd frontend
npm run test -- tests/imageFeatures.test.ts tests/phaseCorrelation.test.ts
```

Expected: fail because `buildStructuralPhaseImageSquare` is absent.

- [ ] **Step 4: Implement structural edge-energy normalization**

Add `buildStructuralPhaseImageSquare` beside `computeGradientMagnitudeL1Square`. Reuse the repository's fixed-bin quantile pattern rather than sorting a pixel copy. Do not alter `estimatePreparedPhaseCorrection` or make it search absolute signed peaks; its input representation is now polarity-independent. Reuse `erodeFractionalSupportSquare` from Task 2 for the one-pixel geometric-validity erosion.

- [ ] **Step 5: Wire structural phase inputs in the hook**

Reference path:

```ts
const inpaintedPhaseReference = inpaintExclusionRectSquare(
  normalizedReferenceCoarse,
  PHASE_SAMPLE_SIZE,
  coarseExclusionRect,
  6,
).pixels;
const phaseReferencePixels = buildStructuralPhaseImageSquare(
  inpaintedPhaseReference,
  PHASE_SAMPLE_SIZE,
);
```

Candidate path: compute structure before the seed warp, using the already mapped source-space exclusion.

```ts
const inpaintedPhaseSource = inpaintExclusionRectSquare(
  normalizedSource,
  PHASE_SAMPLE_SIZE,
  sourceNormalizationExclusion,
  6,
).pixels;
const structuralPhaseSource = buildStructuralPhaseImageSquare(
  inpaintedPhaseSource,
  PHASE_SAMPLE_SIZE,
);
const warpedStructuralPhase = warpGrayscaleAffineWithValidity(
  structuralPhaseSource,
  PHASE_SAMPLE_SIZE,
  seedWarpAtCoarse,
);
const erodedGeometricValidity = erodeFractionalSupportSquare(
  warpedStructuralPhase.validity,
  PHASE_SAMPLE_SIZE,
  1,
);
const phaseMovingPixels = new Float32Array(warpedStructuralPhase.pixels.length);
const phaseSupport = new Float32Array(warpedStructuralPhase.pixels.length);
for (let index = 0; index < phaseMovingPixels.length; index++) {
  const validity = warpedStructuralPhase.validity[index] ?? 0;
  const supportValidity = warpedSupport.validity[index] ?? 0;
  phaseMovingPixels[index] =
    validity > 1e-6 ? (warpedStructuralPhase.pixels[index] ?? 0) / validity : 0;
  const conditionalSupport =
    supportValidity > 1e-6
      ? (warpedSupport.pixels[index] ?? 0) / supportValidity
      : 0;
  phaseSupport[index] =
    conditionalSupport * (erodedGeometricValidity[index] ?? 0);
}
```

Keep source-local anatomical support semantics unchanged apart from intersecting geometric validity. A flat structural phase input must produce the existing neutral correction, not fall back silently to intensity phase.

Add a half-pixel translation regression with constant source support. At fractional boundary samples, assert `conditionalSupport` remains one while `phaseSupport` equals the once-eroded geometric validity. This test must fail if warped premultiplied support is multiplied by validity a second time.

- [ ] **Step 6: Add the pure production-path regression**

In `frontend/tests/perceptualAlignmentPipeline.test.ts`, mirror the production order:

```text
normalize source
-> shared rigid seed warp
-> structural phase correction
-> corrected warp of original normalized pixels with validity
-> scoreAlignedCandidate
-> rankFixedCandidateSet
-> choosePerceptualWinner
```

Use a nonfunctional-contrast true candidate with a known residual translation and a centered, exact-reference-histogram wrong-structure distractor. Put the distractor at the seed index. Assert:

```ts
expect(trueCandidate.phase.correctionX).toBeCloseTo(-dx, 0);
expect(trueCandidate.phase.correctionY).toBeCloseTo(-dy, 0);
expect(winner.index).toBe(trueCandidate.index);
expect(winner.structuralRank).toBeGreaterThan(distractor.structuralRank);
```

Add one case with a shared rigid seed of 4–6 degrees plus translation and a nonzero known residual correction. Let `T_seed` be the centered moving-to-fixed rigid transform and `T_residual` be a standard translation by `expectedCorrection`. Construct `T_total = composeStandardAffine2D(T_residual, T_seed)`, generate the moving fixture with the Task 1 test-owned `renderMovingFromFixed(fixed, size, T_total)`, and pass only `T_seed` into the production path. Assert phase recovers `expectedCorrection` in reference-grid coordinates and the structurally correct candidate wins. Do not hand a rotated seed to an unrotated moving fixture or generate moving data from only `T_seed`, which would prove a zero residual.

- [ ] **Step 7: Run phase and pure-pipeline tests**

Run:

```bash
cd frontend
npm run test -- \
  tests/imageFeatures.test.ts \
  tests/phaseCorrelation.test.ts \
  tests/perceptualAlignmentPipeline.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 8: Commit structural phase correction when the execution prerequisite permits it**

```bash
git add \
  frontend/src/utils/imageFeatures.ts \
  frontend/src/hooks/useAutoAlign.ts \
  frontend/tests/imageFeatures.test.ts \
  frontend/tests/phaseCorrelation.test.ts \
  frontend/tests/perceptualAlignmentPipeline.test.ts
git commit -m "feat: estimate alignment shift from structure"
```

Skip this checkpoint in execution mode 3.

---

### Task 6: Add a pure structure-first final affine selector

**Intent:** Make the final residual transform a structurally proven improvement over the winning rigid-plus-translation seed, rather than applying one intensity-derived affine unconditionally.

**Files:**

- Create: `frontend/src/utils/structuralAffineSelection.ts`
- Create: `frontend/tests/structuralAffineSelection.test.ts`

**Interfaces:**

- Consumes: `preparePerceptualReference`, `scoreAlignedCandidate`, `composeResidualWithWarpAtSize`, `warpGrayscaleAffineWithValidity`, and the proposal types defined above.
- Produces: the atomic `selectFinalAffineProposal` operation and `FinalAffineSelection` with the signatures defined above.

**Acceptance criteria:**

- Every admissible proposal is evaluated by warping the original normalized winning slice under its composed total transform, never by trusting an optimizer's resampled output or metric.
- MIND and NGF contribute equal family weight after each family is averaged across scales; appearance and MI/NMI cannot vote.
- The fixed reference denominator and fractional validity remain active. Reverse source-domain coverage rejects zoom/crop proposals that keep forward validity full while discarding moving anatomy.
- Seed-only identity is synthesized internally and cannot be supplied, omitted, duplicated, or mislabeled by the caller.
- Non-finite, singular, orientation-reversing, excessive-corner-displacement, and coverage-regressing proposals are retained as rejected diagnostics and never selected.
- Structural differences greater than `1e-6` dominate. Numerical ties prefer lower residual deformation, then `seed-only`, `structure-elastix`, `intensity-elastix`.
- Only aggregate scores and transforms are returned. Warped pixels, validity arrays, and candidate MIND descriptors are transient.

- [ ] **Step 1: Add failing proposal-selection tests**

Use `makeTissueLabelPhantom`, `renderTissueContrast`, `NONFUNCTIONAL_CONTRAST`, and the independent `renderMovingFromFixed` fixture from Task 1:

```ts
const IDENTITY_RESIDUAL: StandardAffine2D = {
  A: { m00: 1, m01: 0, m10: 0, m11: 1 },
  b: { x: 0, y: 0 },
};

function requireScored(
  proposals: readonly (
    | ScoredFinalAffineProposal
    | RejectedFinalAffineProposal
  )[],
  kind: FinalAffineProposalKind,
): ScoredFinalAffineProposal {
  const proposal = proposals.find((candidate) => candidate.kind === kind);
  expect(proposal?.eligible).toBe(true);
  if (!proposal?.eligible) throw new Error(`${kind} was not scored`);
  return proposal;
}
```

Add these independent behaviors:

```ts
test.each(["structure-elastix", "intensity-elastix"] as const)(
  "selects a correcting %s proposal under nonfunctional contrast",
  (correctiveKind) => {
  const size = 64;
  const labels = makeTissueLabelPhantom(size);
  const fixed = normalizePerceptualSource(
    renderTissueContrast(labels, REFERENCE_CONTRAST),
    size,
  );
  const knownResidual: StandardAffine2D = {
    A: { m00: 1.03, m01: 0.035, m10: -0.02, m11: 0.98 },
    b: { x: 2.5, y: -1.75 },
  };
  const movingPixels = renderMovingFromFixed(
    renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST),
    size,
    knownResidual,
  );
  const wrongKind =
    correctiveKind === "structure-elastix"
      ? "intensity-elastix"
      : "structure-elastix";
  const selection = selectFinalAffineProposal({
    normalizedReference: fixed,
    movingPixels,
    size,
    scales: [64, 32],
    winningWarp: {
      A: IDENTITY_RESIDUAL.A,
      translateX: 0,
      translateY: 0,
    },
    optimizerProposals: [
      {
        kind: wrongKind,
        residualMovingToFixed: {
          A: { m00: 0.96, m01: -0.04, m10: 0.02, m11: 1.04 },
          b: { x: -3, y: 2 },
        },
      },
      { kind: correctiveKind, residualMovingToFixed: knownResidual },
    ],
  });

  expect(selection.selected.kind).toBe(correctiveKind);
  },
);

test("keeps seed-only when an affine proposal lowers structural agreement", () => {
  const size = 64;
  const fixed = normalizePerceptualSource(
    renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST),
    size,
  );
  const selection = selectFinalAffineProposal({
    normalizedReference: fixed,
    movingPixels: fixed,
    size,
    scales: [64, 32],
    winningWarp: { A: IDENTITY_RESIDUAL.A, translateX: 0, translateY: 0 },
    optimizerProposals: [
      {
        kind: "intensity-elastix",
        residualMovingToFixed: {
          A: IDENTITY_RESIDUAL.A,
          b: { x: 6, y: -5 },
        },
      },
    ],
  });
  const seed = requireScored(selection.proposals, "seed-only");
  const intensity = requireScored(selection.proposals, "intensity-elastix");
  expect(seed.structuralScore).toBeGreaterThan(intensity.structuralScore);
  expect(selection.selected.kind).toBe("seed-only");
});

test("source-domain coverage rejects zoom that hides anatomy with full forward validity", () => {
  const size = 64;
  const fixed = normalizePerceptualSource(
    renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST),
    size,
  );
  const selection = selectFinalAffineProposal({
    normalizedReference: fixed,
    movingPixels: fixed,
    size,
    scales: [64, 32],
    winningWarp: { A: IDENTITY_RESIDUAL.A, translateX: 0, translateY: 0 },
    optimizerProposals: [
      {
        kind: "structure-elastix",
        residualMovingToFixed: {
          A: { m00: 1.2, m01: 0, m10: 0, m11: 1.2 },
          b: { x: -6.3, y: -6.3 },
        },
      },
    ],
  });
  const seed = requireScored(selection.proposals, "seed-only");
  const zoom = selection.proposals.find(
    (proposal) => proposal.kind === "structure-elastix",
  );
  expect(zoom).toMatchObject({
    eligible: false,
    rejectionReason: "coverage-regression",
  });
  if (!zoom || zoom.eligible) throw new Error("zoom proposal was not rejected");
  expect(zoom.bidirectionalCoverage).toBeLessThan(seed.bidirectionalCoverage);
});

test.each([
  [
    "non-finite",
    {
      A: { ...IDENTITY_RESIDUAL.A, m00: Number.NaN },
      b: { x: 0, y: 0 },
    },
  ],
  [
    "singular",
    { A: { m00: 1, m01: 0, m10: 0, m11: 0 }, b: { x: 0, y: 0 } },
  ],
  [
    "orientation-reversing",
    { A: { m00: -1, m01: 0, m10: 0, m11: 1 }, b: { x: 0, y: 0 } },
  ],
  [
    "excessive-displacement",
    { A: { m00: 1, m01: 0.4, m10: 0, m11: 1 }, b: { x: 0, y: 0 } },
  ],
] as const)("rejects %s optimizer residuals", (reason, residualMovingToFixed) => {
  const size = 64;
  const fixed = normalizePerceptualSource(
    renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST),
    size,
  );
  const selection = selectFinalAffineProposal({
    normalizedReference: fixed,
    movingPixels: fixed,
    size,
    scales: [64],
    winningWarp: { A: IDENTITY_RESIDUAL.A, translateX: 0, translateY: 0 },
    optimizerProposals: [
      { kind: "intensity-elastix", residualMovingToFixed },
    ],
  });
  expect(
    selection.proposals.find((proposal) => !proposal.eligible),
  ).toMatchObject({
    rejectionReason: reason,
  });
  expect(selection.selected.kind).toBe("seed-only");
});

test("exact structural ties retain the internally synthesized seed", () => {
  const size = 64;
  const fixed = normalizePerceptualSource(
    renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST),
    size,
  );
  const selection = selectFinalAffineProposal({
    normalizedReference: fixed,
    movingPixels: fixed,
    size,
    scales: [64],
    winningWarp: { A: IDENTITY_RESIDUAL.A, translateX: 0, translateY: 0 },
    optimizerProposals: [
      { kind: "intensity-elastix", residualMovingToFixed: IDENTITY_RESIDUAL },
      { kind: "structure-elastix", residualMovingToFixed: IDENTITY_RESIDUAL },
    ],
  });
  expect(selection.selected.kind).toBe("seed-only");
});
```

Add one non-vacuous exclusion regression at `size = 128`. Build a test image whose anatomical support and asymmetric internal boundaries lie entirely inside normalized `[0.25, 0.75]²`, put the changing high-contrast lesion only inside `{ x: 0.45, y: 0.45, width: 0.1, height: 0.1 }`, and include a residual x-translation of `0.124 * size`. The inset support guarantees both forward and reverse anatomical domains remain on-frame at the near-budget translation. Assert the translated proposal is `eligible: true` before comparing anything else. Then assert the returned `fixedScoringExclusionRect` contains the original rectangle expanded by `0.125` normalized units, `sourceExclusionRect` is identical before/after the lesion-value change, and the translated proposal's MIND, NGF, structural score, and bidirectional coverage remain unchanged to six decimal places. Also call the selector with and without the translated proposal and assert the seed score is identical; this proves proposal membership cannot change either normalization or scoring masks. Do not filter comparisons to only whatever proposals happen to remain eligible, do not mock `scoreAlignedCandidate`, and do not assert only that helper calls occurred.

- [ ] **Step 2: Run the focused test and verify red**

```bash
cd frontend
npm run test -- tests/structuralAffineSelection.test.ts
```

Expected: fail because `../src/utils/structuralAffineSelection` does not exist.

- [ ] **Step 3: Implement validation, scoring, and transient warping**

Validate square lengths, positive integer size, and at most one optimizer proposal of each non-seed kind. Synthesize seed-only identity inside the function. For each optimizer residual, reject non-finite values first, then reuse `invert2` as the singularity contract and check orientation:

```ts
const determinant = det2(proposal.residualMovingToFixed.A);
if (!allAffineValuesAreFinite(proposal.residualMovingToFixed)) {
  return { ...proposal, eligible: false, rejectionReason: "non-finite" };
}
try {
  invert2(proposal.residualMovingToFixed.A);
} catch {
  return { ...proposal, eligible: false, rejectionReason: "singular" };
}
if (determinant < 0) {
  return {
    ...proposal,
    eligible: false,
    rejectionReason: "orientation-reversing",
  };
}
```

For the residual alone, evaluate its displacement at `(0, 0)`, `(size - 1, 0)`, `(0, size - 1)`, and `(size - 1, size - 1)`. Reject when the maximum absolute x-or-y displacement is greater than `0.125 * size`. Store that normalized maximum as `deformationMagnitude`.

Compose each remaining residual with `winningWarp`. Prepare a temporary fixed reference at `scales` to derive `maximumMindFootprintAtFullResolution`. Build `fixedScoringExclusionRect` by expanding the user rectangle by `0.125 * size`, and prepare the authoritative final fixed reference with that expanded rectangle; its per-scale builder adds descriptor-footprint dilation. Separately build the canonical source exclusion by expanding the original fixed rectangle by `0.125 * size + maximumMindFootprintAtFullResolution` and inverse-mapping it through `winningWarp` only. Pass that rectangle to `normalizePerceptualSource` and return both rectangles in `FinalAffineSelection` diagnostics. Prepare the source-domain reference once with the same scale sizes and source rectangle. Optimizer proposal transforms must not participate in either exclusion construction.

For each proposal, convert its total standard affine about the image center, warp the shared normalized moving pixels, and call `scoreAlignedCandidate` against the fixed prepared reference. Average each forward family across `components.perScale` before averaging MIND with NGF. Invert the total, warp `normalizedReference` into the moving grid, and call `scoreAlignedCandidate` against the prepared moving source; retain only reverse `coverage`. Do not use appearance or multiply structural score by coverage. After seed is scored, set `coverageTolerance = 1 / size + 1e-6`, `sourceLoss = seed.components.sourceCoverage - proposal.components.sourceCoverage`, and `forwardLoss = seed.components.forward.coverage - proposal.components.forward.coverage`. Convert the optimizer proposal into a `coverage-regression` rejection only when `sourceLoss - forwardLoss > coverageTolerance`, retaining its aggregate diagnostics. Keep `bidirectionalCoverage = min(forwardCoverage, sourceCoverage)` for diagnostics. This isolates the reverse guard to anatomy hidden from the source domain; ordinary translation can lose comparable support in both directions and is already penalized by fixed-denominator forward structure. Drop both directional warp arrays before advancing to the next proposal.

- [ ] **Step 4: Implement the seed guarantee and deterministic comparator**

Within the atomic selection operation, require the synthesized seed-only proposal to remain eligible. Choose with a max-score contender set:

```ts
const FINAL_AFFINE_SCORE_EPSILON = 1e-6;
const KIND_ORDER: Record<FinalAffineProposalKind, number> = {
  "seed-only": 0,
  "structure-elastix": 1,
  "intensity-elastix": 2,
};

const eligible = proposals.filter(
  (proposal): proposal is ScoredFinalAffineProposal => proposal.eligible,
);
const maximumScore = Math.max(
  ...eligible.map((proposal) => proposal.structuralScore),
);
const contenders = eligible.filter(
  (proposal) =>
    maximumScore - proposal.structuralScore <= FINAL_AFFINE_SCORE_EPSILON,
);
const chosen = [...contenders].sort(
  (a, b) =>
    a.deformationMagnitude - b.deformationMagnitude ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
)[0];
```

Assert `chosen` exists and its score is not below the synthesized seed-only score by more than the epsilon. Throw an invariant error if either condition fails; do not silently substitute an arbitrary proposal.

- [ ] **Step 5: Run focused tests and lint**

```bash
cd frontend
npm run test -- tests/structuralAffineSelection.test.ts tests/perceptualSliceSimilarity.test.ts tests/alignmentTransform.test.ts
npx eslint src/utils/structuralAffineSelection.ts tests/structuralAffineSelection.test.ts
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit the pure selector when the execution prerequisite permits it**

```bash
git add frontend/src/utils/structuralAffineSelection.ts frontend/tests/structuralAffineSelection.test.ts
git commit -m "feat: gate final affine by structural agreement"
```

Skip this checkpoint in execution mode 3.

---

### Task 7: Generate and apply structure-first final affine proposals

**Intent:** Use the pure selector in the production post-slice stage so improved structural registration can refine cross-date translation, rotation, scale, and shear without allowing intensity-driven affine drift to degrade anatomy.

**Files:**

- Modify: `frontend/src/hooks/useAutoAlign.ts`
- Modify: `frontend/src/utils/alignmentSliceScoreStore.ts`
- Modify: `frontend/src/utils/elastixRegistration.ts`
- Modify: `frontend/tests/useAutoAlign.test.tsx`
- Modify: `frontend/tests/alignmentTransform.test.ts`
- Modify: `frontend/tests/elastixRegistration.test.ts`

**Interfaces:**

- Consumes: `buildStructuralPhaseImageSquare` and the atomic `selectFinalAffineProposal` operation.
- Produces: seed-only plus up to two successful optimizer proposals, a structurally selected total target-to-reference transform, selected-transform raw MI/NMI, and debug aggregates for generated, failed, rejected, and selected outcomes.

**Acceptance criteria:**

- The initial rigid seed, phase correction, coarse search, shortlist, and winning slice do not change as a consequence of this task.
- Both Elastix affine calls happen only after the winning fine score is recorded.
- The intensity call retains the existing raw reference/prewarped-moving inputs and options.
- The structural call receives reference and moving structural edge energy; candidate structure is computed in source space after source-space exclusion inpainting and only then prewarped.
- The worker returned by a successful intensity call is passed to the structural call. The adapter terminates and invalidates its active worker on every ordinary failed attempt; the hook clears its local handle so the next call reacquires. Cancellation between either call and proposal application discards the date result.
- Seed-only, intensity-Elastix, and structure-Elastix are scored from their transforms on the original normalized winning render. Optimizer resamples and metrics do not choose the transform.
- Panel geometry, target histogram statistics, and the result's `nmiScore` describe the selected transform, including when seed-only wins.
- Debug state records proposal kind, eligibility/rejection, MIND, NGF, structural score, deformation magnitude, and selected kind, but no image or descriptor arrays.
- A non-cancellation optimizer failure is recorded and omitted; the other optimizer is still attempted. One or both optimizer failures fall back to the best remaining proposal, ultimately seed-only. Selector/data invariant failures still fail the date.
- Every ordinary failed attempt—including an internally reacquired structural worker—is terminated and evicted inside the adapter before the next attempt or date; clearing only the hook-local variable is insufficient.

- [ ] **Step 1: Add a failing hook-level final-affine gate regression**

Extend the existing production-path test after its structural winning slice is established. Return two distinct optimizer transforms from the final-affine mock sequence: keep the intensity result structurally worse than seed-only and make the structural result improve the known residual. Seed-only is synthesized by the selector. Assert:

```ts
expect(mocks.registerAffine2DWithElastix).toHaveBeenCalledTimes(2);
expect(mocks.registerAffine2DWithElastix.mock.invocationCallOrder[0]).toBeGreaterThan(
  fineWinnerRecordedAt,
);
expect(mocks.registerAffine2DWithElastix.mock.invocationCallOrder[1]).toBeGreaterThan(
  mocks.registerAffine2DWithElastix.mock.invocationCallOrder[0] ?? 0,
);
expect(mocks.registerAffine2DWithElastix.mock.calls[1]?.[3]).toMatchObject({
  webWorker: intensityWorker,
});
expect(getAlignmentSliceScore("target-series", trueIndex)).toMatchObject({
  finalAffineSelected: "structure-elastix",
});
```

Keep each mock's `movingToFixed`, `A`, and `translatePx` coherent, but deliberately return `resampledMovingPixels` filled with `0.99` and optimizer `quality.nmi = 0.999` for the proposal that is not selected. Assert the resulting panel affine and pan equal the composition of the selected structural residual after `winningWarp`, not either optimizer resample. Independently warp the original winner under the selected total transform, mean-fill invalid support, and assert:

```ts
const expectedSelectedQuality = computeMutualInformation(
  referencePixels,
  expectedSelectedRawResample,
  {
    bins: 64,
    exclusionRect: reference.exclusionMask,
    imageWidth: ALIGNMENT_IMAGE_SIZE,
    imageHeight: ALIGNMENT_IMAGE_SIZE,
  },
);
expect(aligned[0]?.nmiScore).toBeCloseTo(expectedSelectedQuality.nmi, 8);
expect(aligned[0]?.nmiScore).not.toBeCloseTo(0.999, 3);
```

Compute `expectedSettings` with `computeAlignedSettings(referenceDisplayedStats, computeHistogramStats(expectedSelectedRawResample), trueIndex, targetSliceCount, currentProgress, expectedComposedGeometry)` and assert returned brightness, contrast, pan, rotation, zoom, and affine matrix match it. Also compute settings from the poisoned optimizer resample and assert at least brightness or contrast differs, proving histogram statistics came from the selected transform.

Add a second test in which both Elastix transforms worsen structure and assert `finalAffineSelected: "seed-only"`, seed-only panel geometry, selected-transform NMI, and selected-transform brightness/contrast. Use real structural scoring over deterministic rendered pixels; mock only the WASM registration boundary.

- [ ] **Step 2: Add cancellation and provenance regressions**

Update the existing cancellation test so cancellation during the second affine call yields no result and no settings application. Add table cases where the first, second, and both non-cancellation optimizer calls reject: the other call still runs, a failed proposal is absent from selector inputs, and both failures select seed-only with two `failed` diagnostics. In `elastixRegistration.test.ts`, make an ordinary pipeline failure occur on an internally acquired cached worker, start another registration, and assert the first worker was terminated, `getDefaultWebWorker` was called again, and the retry receives the new worker. Extend the hook case across two target dates: after both affine attempts fail on the first date, the second date must acquire a fresh worker rather than reuse either failure. Recursively inspect final proposal diagnostics and assert they contain no `Float32Array`. Keep the existing superseded-run state test green.

- [ ] **Step 3: Run the hook tests and verify red**

```bash
cd frontend
npm run test -- tests/useAutoAlign.test.tsx tests/alignmentTransform.test.ts
```

Expected: fail because production still makes one final affine call and applies it unconditionally.

- [ ] **Step 4: Build the two optimizer inputs after winner selection**

Retain the current intensity prewarp. Separately normalize the original winner with its mapped source-space exclusion, inpaint that source exclusion, call `buildStructuralPhaseImageSquare`, and warp the structural source by `winningWarp`. Build reference structure from the exclusion-inpainted `normalizedReferenceFine`. Fill invalid structural warp support with `fillInvalidWarpWithValidMean` before Elastix so padding does not become an optimizer edge.

First modify `register2DWithElastix` so every catch after worker ownership is established calls `abortActiveWorker()` before rethrowing; keep abort/timeout messages unchanged and avoid double invalidation branches. Then call `registerAffine2DWithElastix` first on intensity and then on structure with the current resolution, exclusion, and abort signal. Run `ensureNotAborted()` after each awaited attempt, including inside each catch before classifying it as a non-cancellation failure. A successful result updates `sharedWebWorker`; a failed attempt records `{ kind, status: 'failed', message }`, clears the now-invalid local handle, and does not create an optimizer proposal. Always attempt the structural call after a non-cancellation intensity failure so it reacquires through the adapter's invalidated cache. Do not catch errors from normalization, proposal scoring, selection, transform composition, or settings conversion.

- [ ] **Step 5: Score, select, and apply the proposal transform**

Build `optimizerProposals` only from successful results and pass them to:

```ts
const finalAffineSelection = selectFinalAffineProposal({
  normalizedReference: normalizedReferenceFine,
  movingPixels: bestRender.pixels,
  size: ALIGNMENT_IMAGE_SIZE,
  scales: finePerceptualReference.scales.map((scale) => scale.size),
  winningWarp,
  fixedExclusionRect: reference.exclusionMask ?? undefined,
  optimizerProposals,
});
const selectedProposal = finalAffineSelection.selected;
const deltaStd = selectedProposal.totalMovingToFixed;
```

The selector synthesizes seed-only and owns proposal-independent source normalization/exclusion. Do not normalize separately per proposal, pass optimizer resamples into scoring, or compose the selected residual with `winningWarp` a second time. Compose `refStd(deltaStd(target))` exactly as the existing path does.

Warp `bestRender.pixels` once under the selected total transform, fill invalid samples with the valid mean, and compute `targetStats` from that selected raw resample. Compute `nmiScore` with `computeMutualInformation(referencePixels, selectedRawResample, exclusion-aware options).nmi`. This is the reported selected-transform quality; keep each optimizer's own quality only in debug provenance.

- [ ] **Step 6: Store serializable proposal diagnostics**

Extend the winning slice record with:

```ts
finalAffineSelected?: FinalAffineProposalKind;
finalAffineStructuralScore?: number;
finalAffineSeedStructuralScore?: number;
finalAffineProposals?: Array<{
  kind: FinalAffineProposalKind;
  status: "failed" | "rejected" | "eligible" | "selected";
  rejectionReason?: string;
  failureMessage?: string;
  mindScore?: number;
  ngfScore?: number;
  structuralScore?: number;
  deformationMagnitude?: number;
  bidirectionalCoverage?: number;
}>;
```

Emit the same aggregates through `debugAlignmentLog('refine.proposals', ...)`. Keep optimizer MI/NMI under their proposal labels and selected-transform MI/NMI under `selectedQuality`.

- [ ] **Step 7: Run final-affine integration regressions**

```bash
cd frontend
npm run test -- \
  tests/structuralAffineSelection.test.ts \
  tests/useAutoAlign.test.tsx \
  tests/alignmentTransform.test.ts \
  tests/warpAffine.test.ts \
  tests/elastixRegistration.test.ts
```

Expected: both proposal calls, seed non-regression, structure selection, cancellation, transform composition, and adapter tests pass.

- [ ] **Step 8: Commit production final-affine gating when the execution prerequisite permits it**

```bash
git add \
  frontend/src/hooks/useAutoAlign.ts \
  frontend/src/utils/alignmentSliceScoreStore.ts \
  frontend/src/utils/elastixRegistration.ts \
  frontend/tests/useAutoAlign.test.tsx \
  frontend/tests/alignmentTransform.test.ts \
  frontend/tests/elastixRegistration.test.ts
git commit -m "feat: refine final affine from structural proposals"
```

Skip this checkpoint in execution mode 3.

---

### Task 8: Wire production diagnostics and end-to-end selection

**Intent:** Make the actual Align All winner follow the structure-first contract and leave enough provenance to explain the choice.

**Files:**

- Modify: `frontend/src/hooks/useAutoAlign.ts`
- Modify: `frontend/src/utils/alignmentSliceScoreStore.ts`
- Modify: `frontend/tests/useAutoAlign.test.tsx`

**Interfaces:**

- Consumes: the ranked fields from Task 4, structural phase input from Task 5, and selected final affine diagnostics from Task 7.
- Produces: coarse/fine debug snapshots containing MIND values, structural rank, activity flags, and `phaseInput: 'structural-edge-energy'`.

**Debug contract additions:**

```ts
type AlignmentSliceScoreMetrics = {
  // existing and legacy fields remain
  mind?: number;
  rawMindDistance?: number;
  mindRank?: number;
  structuralRank?: number;
  mindActive?: boolean;
  structuralActive?: boolean;
  phaseInput?: "structural-edge-energy";
};

type AlignmentPerceptualStageMetrics = {
  // existing fields remain
  mindRank: number;
  structuralRank: number;
  mindActive: boolean;
  structuralActive: boolean;
  phaseInput: "structural-edge-energy";
  perScale: Array<{
    size: number;
    mind: number;
    rawMindDistance?: number;
    contrastStructure: number;
    rawContrastStructure?: number;
    lncc: number;
    rawLncc?: number;
    ngf: number;
    rawNgf?: number;
    lowerQuartile: number;
  }>;
};
```

- [ ] **Step 1: Add the failing hook-level winner regression**

Extend the existing render mock to provide at least 21 target candidates so a five-peak shortlist plus immediate neighbors cannot fine-score the entire candidate universe:

- seed index: exact-reference histogram, relocated internal anatomy;
- true index away from seed: same labels under `NONFUNCTIONAL_CONTRAST`, translated by a known residual;
- remaining indices: missing or altered internal structures.

Use identity rigid and two identity final-affine mock results in this slice-selection test. Task 5's pure pipeline covers a geometrically consistent nonidentity shared rigid seed, while Tasks 6 and 7 cover nonidentity residual affine selection and composition. Do not combine slice selection and transform-oracle concerns in a mock whose `resampledMovingPixels` disagrees with its returned transform. Assert:

```ts
expect(aligned[0].bestSliceIndex).toBe(trueIndex);
expect(mocks.registerAffine2DWithElastix).toHaveBeenCalledTimes(2);
expect(getAlignmentSliceScore("target-series", trueIndex)).toMatchObject({
  selected: true,
  structuralActive: true,
  phaseInput: "structural-edge-energy",
  finalAffineSelected: "seed-only",
});
expect(
  getAlignmentSliceScore("target-series", trueIndex)?.fineStage?.structuralRank,
).toBeGreaterThan(
  getAlignmentSliceScore("target-series", seedIndex)?.fineStage
    ?.structuralRank ?? 0,
);
```

Also assert all bounded coarse slices were scored, only shortlisted slices received fine scoring, and both affine mock calls occurred after the winner's fine score was recorded.

Require at least one non-winning slice record to contain `coarseStage` with no `fineStage`. Account separately for the winner's extra 256 px render used by final refinement rather than counting every 256 px render as fine scoring.

Recursively inspect stored coarse/fine score records and assert no value is a `Float32Array`; only aggregate numbers and small transform objects may survive candidate scoring.

- [ ] **Step 2: Run the hook test and verify red**

Run:

```bash
cd frontend
npm run test -- tests/useAutoAlign.test.tsx
```

Expected: the structural winner itself may already be correct from Tasks 3–5, but the test fails on the still-missing MIND/structural diagnostics and `phaseInput` provenance. Task 8 exposes existing structure-first evidence; it must not reimplement or alter selection.

- [ ] **Step 3: Propagate structural metrics through debug storage**

Extend both stage snapshots and headline fields in `alignmentSliceScoreStore.ts`. Preserve legacy fields so old debug callers remain type-compatible. In `recordCandidateDebug`, store all new fields for coarse and fine candidates and keep the existing universe IDs and retention reasons.

Set headline `mind` to the arithmetic mean of the selected stage's per-scale MIND scores and `rawMindDistance` to the mean of its available per-scale raw distances. Extend the existing `averageMetric` helper's metric union to include `mind`; do not display an arbitrary first scale as the headline.

- [ ] **Step 4: Update progress and console diagnostics**

Replace `meanPerceptualComponents`, which currently averages CS/LNCC/NGF equally, with a function that averages the same 80/20 local family composition used by selection. This value remains progress-only. Include the following in the alignment configuration log:

```ts
{
  phaseInput: 'structural-edge-energy',
  rankFusion: { structural: 0.8, appearance: 0.2 },
  structuralFamilies: ['mind', 'ngf'],
  appearanceFamily: ['contrastStructure', 'lncc'],
}
```

- [ ] **Step 5: Run hook and transform regressions**

Run:

```bash
cd frontend
npm run test -- \
  tests/useAutoAlign.test.tsx \
  tests/alignmentTransform.test.ts \
  tests/warpAffine.test.ts
```

Expected: winner, call ordering, transform composition, and one-warp invariants all pass.

- [ ] **Step 6: Commit production wiring when the execution prerequisite permits it**

```bash
git add \
  frontend/src/hooks/useAutoAlign.ts \
  frontend/src/utils/alignmentSliceScoreStore.ts \
  frontend/tests/useAutoAlign.test.tsx
git commit -m "feat: select aligned slices by structural similarity"
```

Skip this checkpoint in execution mode 3.

---

### Task 9: Expose the structural and final-affine decisions in the debug overlay

**Intent:** Make the new decision inspectable without adding visible product UI outside the existing alignment-debug mode.

**Files:**

- Modify: `frontend/src/components/DicomViewer.tsx`
- Modify: `frontend/tests/DicomViewer.test.tsx`

**Interfaces:**

- Consumes: `AlignmentSliceScoreMetrics` from Tasks 7 and 8.
- Produces: debug-only labels for MIND, structural rank, family activity, structural phase provenance, and the selected final affine proposal.

**Acceptance criteria:**

- The overlay appears only when alignment debugging is enabled and `Z` is held, preserving current behavior.
- Active families show fixed-precision values.
- Flat MIND, structural, boundary, or appearance families say `flat` rather than displaying manufactured ranks.
- Existing legacy-score rendering remains available for old records.
- New records display the selected final affine proposal and its structural score; absent final-affine fields remain backward compatible.
- No new product control, layout, or always-visible text is introduced.

- [ ] **Step 1: Add the failing viewer regression**

Extend the existing `DicomViewer.test.tsx` mocks rather than creating a second viewer harness. Before rendering:

```ts
localStorage.setItem("miraviewer:debug-alignment", "1");
resetAlignmentSliceScoreStore({
  referenceSeriesUid: "reference-series",
  referenceSliceIndex: 10,
});
recordAlignmentSliceScore("series", 0, {
  ssim: 0.4,
  lncc: 0.3,
  zncc: 0.3,
  ngf: 0.8,
  census: 0,
  phase: 0.5,
  mi: 0,
  nmi: 0,
  score: 0.76,
  mind: 0.87,
  rawMindDistance: 0.13,
  mindRank: 0.9,
  structuralRank: 0.85,
  appearanceRank: 0.2,
  boundaryRank: 0.8,
  mindActive: true,
  structuralActive: true,
  appearanceActive: true,
  boundaryActive: true,
  phaseInput: "structural-edge-energy",
  finalAffineSelected: "structure-elastix",
  finalAffineStructuralScore: 0.91,
  finalAffineSeedStructuralScore: 0.74,
  perScale: [
    {
      size: 128,
      mind: 0.87,
      rawMindDistance: 0.13,
      contrastStructure: 0.4,
      lncc: 0.3,
      ngf: 0.8,
      lowerQuartile: 0.5,
    },
  ],
});
```

Render `DicomViewer` with `seriesUid="series"`, `instanceIndex={0}`, and an image override. Dispatch `fireEvent.keyDown(window, { key: 'z' })` and assert the overlay contains `MIND: 0.870000`, `Structural rank: 0.8500`, `Phase input: structural edge energy`, `Final affine: structure elastix`, and `Final affine structure: 0.910000 (seed 0.740000)`. Add a second record with false activity flags and absent final-affine fields; assert the corresponding rank labels contain `flat` and legacy rendering remains intact. Clear local storage and dispatch keyup in `afterEach`.

- [ ] **Step 2: Run the viewer test and verify red**

```bash
cd frontend
npm run test -- tests/DicomViewer.test.tsx
```

Expected: fail because the new structural labels are absent.

- [ ] **Step 3: Update the debug-only overlay**

When production perceptual diagnostics exist, display:

```text
MIND: <raw score>
MIND rank: <rank or flat>
NGF: <raw score>
Boundary rank: <rank or flat>
Structural rank: <rank or flat>
Appearance rank: <rank or flat>
Perceptual rank: <final rank>
Phase input: structural edge energy
Final affine: <seed only | intensity elastix | structure elastix>
Final affine structure: <selected score> (seed <seed score>)
```

Preserve the old fallback block for records without production perceptual fields.

- [ ] **Step 4: Run viewer and store-adjacent tests**

```bash
cd frontend
npm run test -- tests/DicomViewer.test.tsx tests/useAutoAlign.test.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Commit debug-overlay wiring when the execution prerequisite permits it**

```bash
git add frontend/src/components/DicomViewer.tsx frontend/tests/DicomViewer.test.tsx
git commit -m "feat: explain structure-first alignment scores"
```

Skip this checkpoint in execution mode 3.

---

### Task 10: Verify scope, performance, and representative behavior

**Intent:** Prove the implementation satisfies the plan without converting this change into a benchmark project or hiding unrelated workspace failures.

**Files:**

- Verify only; no new production file is expected.
- Update this plan's execution notes only if the executor is explicitly asked to record results.

**Acceptance criteria:**

- Focused structural tests pass.
- Full lint and unit tests pass.
- A production TypeScript/Vite build passes for the scoped implementation.
- Candidate descriptors are transient; retained descriptor arrays do not scale with the number of searched slices. Aggregate numeric candidate records may scale with the bounded window.
- Cancellation still interrupts capture/registration work, and coarse scoring still yields to the main thread.
- At least one representative local scan pair with visibly different tissue intensity ordering is inspected manually if an interactive browser is available.
- No claim exceeds the available evidence.

- [ ] **Step 1: Run the complete focused suite**

```bash
cd frontend
npm run test -- \
  tests/mindDescriptor.test.ts \
  tests/perceptualSliceSimilarity.test.ts \
  tests/imageFeatures.test.ts \
  tests/phaseCorrelation.test.ts \
  tests/perceptualAlignmentPipeline.test.ts \
  tests/structuralAffineSelection.test.ts \
  tests/useAutoAlign.test.tsx \
  tests/DicomViewer.test.tsx \
  tests/alignmentTransform.test.ts \
  tests/warpAffine.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository-wide checks**

```bash
cd frontend
npm run check
npm run build
```

Expected: both commands exit zero. If `npm run build` is blocked only by unrelated pre-existing dirty work, copy the scoped files over the same base commit in a detached temporary worktree and run the build there. Report the original failure and scoped-build result separately; do not modify or discard the user's unrelated files.

- [ ] **Step 3: Check formatting and diff hygiene**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; the status and stat contain only intended alignment files plus clearly identified pre-existing user changes.

- [ ] **Step 4: Inspect transient allocation behavior**

Inspect the implementation and the Tasks 7 and 8 stored-record assertions first: candidate descriptors must be block-local, and stored/returned candidate or proposal records must contain no descriptor/image `Float32Array`. If browser devtools are available, supplement that deterministic evidence with allocation sampling before and after a bounded Align All run. Expected evidence:

- one prepared reference descriptor per active scale remains during the run;
- candidate descriptor buffers become unreachable after each candidate score;
- retained coarse/fine candidate records contain aggregate numbers, not descriptor arrays;
- retained final-affine proposal records contain aggregate scores and transforms, not warped images or descriptors;
- a second run does not retain the previous run's descriptor buffers.

Also record `sliceSearchScoreMs`, `slicesChecked`, and the longest candidate-scoring task from a Performance trace. This plan sets no calibrated latency threshold, but the evidence must show the existing yield cadence still separates candidate batches and that one candidate does not create an unbounded long task. This is a bounded smoke check, not a performance harness.

- [ ] **Step 5: Perform a representative structural spot check when browser control is available**

Use existing local MRI data without committing it as a fixture:

1. choose one date pair where corresponding anatomy has visibly different tissue brightness ordering;
2. select a reference slice containing at least two internal landmarks;
3. run Align All with `localStorage.setItem('miraviewer:debug-alignment', '1')`;
4. inspect overlay/flicker at the selected slice;
5. confirm MIND and NGF jointly explain the selected candidate and that an appearance-favored distractor did not win;
6. record only the qualitative outcome and debug numbers, not patient pixels or identifiers.

If no interactive browser is available, report this exact manual check as pending. Automated success alone supports “structure-first logic implemented,” not “real-world accuracy proven.”

- [ ] **Step 6: Run the final adversarial review**

Give a fresh reviewer:

- this complete plan path;
- the full scoped diff;
- focused and full-suite outputs;
- build output;
- manual spot-check evidence or an explicit statement that it remains pending.

Require a binary answer to both task and plan intent. Fix all concrete gaps and repeat with a new reviewer until it returns `both intents satisfied`, or disclose the unavailable/manual blocker without marking the blocked criterion complete.

- [ ] **Step 7: Commit verification-only adjustments when the execution prerequisite permits it**

If verification required scoped test or diagnostic corrections, stage only those files and use:

```bash
git commit -m "test: verify structure-first alignment"
```

Skip this commit when verification changed no files or execution mode 3 is active.

---

## Explicit non-goals

- No curated DICOM corpus, golden slice indices, benchmark runner, or accuracy dashboard.
- No learned embedding, LPIPS/DINO-style natural-image metric, ONNX structural encoder, or training pipeline.
- No full 3D or 2.5D registration.
- No candidate-specific affine, similarity, or deformable registration before slice selection.
- No change to the initial Elastix rigid objective or to the stock Elastix affine parameter map. The added structural affine attempt changes its scalar input representation, then MIND+NGF gate all final proposals externally.
- No custom multi-metric Elastix wrapper, direct MIND optimizer, deformable final refinement, or third-party registration dependency.
- No cross-sequence series selection or metadata classifier.
- No adaptive metric weighting, learned confidence threshold, metric fallback cascade, or parameter tuning from the local scans. Seed-only is an explicit always-scored proposal, not an alternate metric path.
- No change to the user's manual brightness/contrast settings or `reverseSliceOrder` preference.
- No new visible product controls.

## Risks and fixed mitigations

| Risk                                                        | Mitigation in this plan                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIND resurrects old dead complexity                         | New focused module, production wiring, direct tests, and fixed-domain validity semantics; do not restore the deleted file.                                                       |
| MIND and NGF are correlated structural signals              | They form one structural rank before the 80/20 top-level fusion rather than masquerading as separately calibrated scores.                                                        |
| Different scans expose different edges                      | MIND supplies patch-layout evidence beyond NGF boundaries.                                                                                                                       |
| Direct appearance still favors the wrong slice              | Appearance is capped at 20%; tests cover both the guaranteed `>0.25` structural-gap case and the intentional close-rank override case.                                           |
| Descriptor reads excluded pathology or invalid warp padding | Expand exclusions and erode validity by the full descriptor footprint.                                                                                                           |
| Wrong candidate wins by disappearing outside the frame      | Keep the fixed reference denominator and fractional coverage penalty.                                                                                                            |
| Structural phase becomes flat                               | Return neutral correction; do not manufacture a shift or silently switch metrics. Compute candidate structure before warping so padding is not differentiated into a false edge. |
| Intensity affine degrades an already-good seed              | Score seed-only, intensity, and structural proposals on the same original normalized slice; MIND+NGF can always retain seed-only.                                              |
| Structural Elastix optimizes a scalar proxy, not MIND       | Treat it only as a proposal generator. The authoritative final gate rewarps original pixels and scores full MIND+NGF.                                                          |
| An affine wins by cropping, zooming, or reflecting anatomy  | Reject invalid/orientation-reversing matrices, enforce the derived `0.125`-FOV corner-displacement budget, and reject reverse source-coverage regression relative to seed-only.    |
| Final proposal diagnostics misstate image quality           | Recompute raw-image MI/NMI and histogram statistics under the selected transform; keep each optimizer metric clearly proposal-local.                                           |
| Two final affine attempts increase latency                  | Run only after one winning slice exists, reuse successful workers sequentially, retain no proposal image buffers, and preserve cancellation checks.                            |
| Candidate descriptor allocation causes memory growth        | Score serially, retain aggregates only, and verify unreachable candidate buffers.                                                                                                |
| Fine-scale noise destabilizes MIND                          | Keep multi-scale stage-local rank fusion; no single raw scale controls the winner.                                                                                               |
| Fixed 80/20 weighting looks calibrated                      | Label it an engineering default and make only relative behavioral claims until a later evaluation effort exists.                                                                 |
| Tests overfit one brightness inversion                      | Use label-preserving nonlinear LUTs, gamma/sigmoid remaps, exact-histogram structural distractors, missing anatomy, and known transforms.                                        |
| Green tests mask plan drift                                 | Enforce independent task- and plan-intent review with the full plan.                                                                                                             |

## Completion definition

This plan is complete only when all of the following are true:

- production residual translation uses structural edge energy;
- every perceptual scale reports MIND, NGF, and appearance diagnostics;
- structural rank controls 80% of the final candidate score whenever active, with the documented `0.25` guarantee boundary;
- final refinement synthesizes seed-only and attempts intensity-Elastix plus structural-Elastix residual proposals only after slice selection; ordinary optimizer failures are diagnostic and still leave seed-only valid;
- final affine selection uses fixed-domain MIND+NGF only, enforces the `0.125`-FOV residual-corner budget plus a seed-relative excess-source-loss guard with a one-pixel discretization tolerance, cannot score below seed-only beyond `1e-6`, and deterministically prefers less deformation on numerical ties;
- selected-transform panel geometry, raw-image MI/NMI, histogram statistics, and debug provenance all describe the same chosen transform;
- a structurally correct, intensity-disadvantaged candidate beats an exact-histogram wrong-structure distractor in primitive, pure-pipeline, and hook tests;
- fixed reference weighting, missing-support penalties, exclusions, cancellation, shortlist semantics, and final transform composition remain green;
- no new dependency, model, harness, golden dataset, or per-candidate affine is introduced;
- lint, tests, and a scoped production build pass;
- the independent reviewer confirms both task intent and plan intent with evidence;
- any unavailable representative browser check is reported as pending rather than converted into an unsupported accuracy claim.
