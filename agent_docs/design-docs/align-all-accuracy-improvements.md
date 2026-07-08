# Perceptual-Similarity-Driven Alignment for "Align All"

_Last updated: 2026-07-06_

## Scope

Align All already returns plausible results — the correct slice is roughly found and the affine lands close. This plan improves accuracy specifically by making the alignment **driven by how similar the slices actually look** (perceptual/structural similarity) rather than by a single translation-focused signal.

The core observation: the pipeline's slice-selection stage — the decision that most determines whether two dates line up through-plane — is currently driven by **phase correlation** (`SLICE_SEARCH_SCORE_METRIC = 'phase'`, `useAutoAlign.ts:55`). Phase correlation measures translational agreement of the dominant spectral structure; it is not a measure of whether two slices *depict the same anatomy in the same configuration*. That question — "do these look like the same slice?" — is exactly what a perceptual similarity metric answers, and it is what slice selection actually needs.

Key files:

- Slice search + metric fusion: `frontend/src/utils/alignment.ts` (`findBestMatchingSlice`, `computeMetrics`)
- Metric implementations: `frontend/src/utils/{ssim,phaseCorrelation,mutualInformation}.ts`
- Orchestrator: `frontend/src/hooks/useAutoAlign.ts`
- Elastix registration + transform candidate selection: `frontend/src/utils/{elastixRegistration,elastixTransform}.ts`
- Slice capture: `frontend/src/utils/cornerstoneSliceCapture.ts`

## What's already in place (and why it's underused)

The infrastructure for perceptual scoring largely exists but does not drive the result:

- `computeMetrics` (`alignment.ts:359`–`519`) can already compute SSIM, LNCC, ZNCC, NGF (normalized gradient field / edge-orientation agreement), Census, phase, and MI/NMI for every candidate slice. **Only one metric (`phase`) is used to pick `bestIndex`** (`alignment.ts:492`–`503`); the rest are computed only when the debug overlay is on.
- The SSIM that exists is a fast **block-based approximation**, not the classic perceptual metric — its own header says so (`ssim.ts:54`–`60`). There is no multi-scale SSIM, no learned perceptual metric.
- Phase correlation computes the full correlation surface but returns only the **peak value**, discarding the peak *location* (`phaseCorrelation.ts:404`–`415`). That discarded location is a free, high-quality translation estimate.
- The final affine is disambiguated among 4 forward/reverse/inverted candidates by **mean absolute pixel difference (MAD)** (`elastixTransform.ts:152`–`164`) — a pixelwise, non-perceptual measure.
- `onnxruntime-web` is already a dependency and the app already runs ONNX `InferenceSession`s (tumor/SVR — `useOnnxTumorSession.ts`, `SvrVolume3DViewer.tsx`), so a learned perceptual metric has architectural precedent.

## The design principle: separate "align" from "judge"

Phase correlation is good at *one* thing — finding the residual translation between two images quickly and robustly. It is poor as a *quality* score. So instead of using its peak value to select the slice, split the two roles:

1. **Align** each candidate to the reference (residual translation) using phase correlation's argmax — nearly free, already computed internally.
2. **Judge** the aligned pair with a **perceptual similarity metric**, and select the slice (and later, validate the transform) by that.

This is the backbone of the plan: phase for alignment, perceptual similarity for the decision.

---

## The plan

Three levels of "perceptual," cheapest first. Each is independently shippable; Levels 1→3 increase fidelity to human structural judgment at increasing compute cost. A cost-control cascade (below) lets the expensive levels stay on the hot path.

### Level 1 — Perceptual structural fusion from existing metrics _(ship first)_

Replace the single `phase` score for `bestIndex` selection with a **structure-forward fused score** built from metrics `computeMetrics` already produces:

- **SSIM structure term** — local structural agreement.
- **NGF** — edge-orientation agreement (`alignment.ts:387`–`413`); highly perceptual for MRI because tissue boundaries dominate perceived similarity, and it is intensity-invariant.
- **Gradient-magnitude similarity** — agreement of edge strength (a GMSD-style term; `computeGradientMagnitudeL1Square` already exists in `imageFeatures.ts:22`).

Fuse by rank or normalized weighted sum, weighting structure/gradient over raw intensity. Keep phase correlation, but repurpose it to **translationally align each candidate before scoring** (return its peak location from `computePhaseCorrelationSimilarity` and shift the candidate), so the perceptual score reflects same-anatomy similarity rather than residual pose.

**Why it increases accuracy:** slice selection starts optimizing "looks like the same anatomy" instead of "has a strong translational peak." Structure/edge terms are robust to the cross-scanner intensity differences that phase correlation is sensitive to.

**Effort:** small–medium (metrics exist; work is enabling them on the hot path, returning the phase shift, and tuning the fusion). **Risk:** low–medium — watch per-candidate cost (mitigated by the cascade).

### Level 2 — Proper multi-scale SSIM (MS-SSIM)

Implement true **MS-SSIM** (Gaussian-windowed SSIM combined across ~5 downsampled scales: contrast+structure at each scale, luminance at the coarsest) as the perceptual judge, replacing the block approximation for scoring. MS-SSIM is the standard perceptual image-quality metric and correlates far better with human structural judgment than block SSIM or phase.

- Pure JS/TS, no new dependency; reuse the existing area-average resampler (`resample2dAreaAverage`) for the scale pyramid.
- Multi-scale is a natural fit here: coarse scales capture gross anatomy match, fine scales capture boundary agreement — exactly the through-plane discrimination slice selection needs.

**Why:** the most faithful *classical* perceptual metric, and multi-scale gives a smoother, more unimodal score curve across slice index — which also makes peak detection and sub-slice interpolation more reliable.

**Effort:** medium. **Risk:** low (well-specified algorithm; validate against block SSIM on fixtures).

### Level 3 — Learned perceptual similarity (LPIPS-style) via ONNX

Use a small pretrained CNN feature extractor to score slices by **deep-feature distance** (LPIPS: cosine/L2 distance of normalized intermediate activations) — perceptual similarity in the modern learned sense, and the best match to human perception of "same structure."

- Bundle a compact model (e.g. a SqueezeNet/AlexNet-based LPIPS backbone, or a medical-imaging encoder) as an ONNX asset; run via the existing `onnxruntime-web` path used for tumor/SVR sessions.
- Apply it as a **re-ranker on the top-K candidate slices** (see cascade) so a handful of inferences per date decides the winner, keeping cost bounded.
- Also usable as the final reported similarity, which is far more meaningful for "does this look aligned" than NMI.

**Why:** learned features capture texture/structure similarity that hand-crafted metrics miss, and are naturally robust to intensity/contrast differences across timepoints.

**Effort:** medium–large (model selection, asset bundling, preprocessing parity, perf). **Risk:** medium — must validate the model transfers to grayscale MRI; keep Level 1/2 as the fallback if the model is unavailable or slow.

### Two-stage cascade (makes Levels 2–3 affordable)

Scoring MS-SSIM or ONNX features on every slice across the ±40 window for every date is too expensive. Instead:

1. **Shortlist** with a cheap score (phase or Level-1 fusion) across the search window → keep the top-K (~5) candidate slices.
2. **Decide** with the expensive perceptual metric (MS-SSIM or LPIPS) **only on those K**, each first translationally aligned via phase.

This bounds the perceptual metric to ~K evaluations per date while letting it make the final call.

### Inject perceptual similarity into the transform decision too

Beyond slice selection, two small perceptual upgrades to the in-plane result:

- **Re-rank Elastix transform candidates perceptually.** In `chooseBestElastixTransformCandidateAboutOrigin` (`elastixTransform.ts:131`–`171`), rank the forward/reverse/inverted candidates by SSIM/MS-SSIM against Elastix's resample instead of MAD. MAD can tie or mis-order near-degenerate conventions; a structural score disambiguates by appearance.
- **Perceptual final validation / neighbor selection.** After refinement, score the warped target vs. reference perceptually. Use it to pick among the sub-slice / ±1-neighbor hypotheses (each independently refined) — choose the one that *looks* most aligned — and report that perceptual score as the quality readout.

---

## Sequencing and payoff

| Step | Perceptual lever | Effort | Payoff |
|---|---|---|---|
| L1. Structural fusion + phase-as-aligner | slice selection | S–M | High |
| L2. MS-SSIM judge | slice selection | M | High |
| Cascade (shortlist → perceptual decide) | keeps L2/L3 affordable | S | Enabling |
| Elastix candidate re-rank (perceptual) | transform selection | S | Medium |
| Perceptual final validation / neighbor pick | slice + transform | M | Medium–High |
| L3. LPIPS via ONNX (re-ranker) | slice selection | M–L | High (ceiling) |

Do **L1 first** — it reuses metrics already computed and turns slice selection perceptual immediately. Add the **cascade** and **L2** together (MS-SSIM only pays off with the shortlist in place). The **Elastix candidate re-rank** and **perceptual final validation** are small and can slot in any time after L1. Treat **L3** as the accuracy ceiling once the classical perceptual path is validated.

## Pair with intensity normalization

Perceptual metrics with luminance/contrast terms (SSIM's first two terms) are partly intensity-sensitive, and slices currently render through Cornerstone's *default* window/level (`cornerstoneSliceCapture.ts:143`), so identical anatomy has different brightness across scans. Before perceptual scoring, normalize each slice's **foreground** intensity (subtract median, divide by a robust spread — IQR/MAD) over the existing inclusion mask (`useAutoAlign.ts:230`–`236`). MS-SSIM's structure term and NGF are already largely intensity-invariant, so this mainly protects the luminance/contrast contributions and the learned model's input distribution.

## How to know it actually got more accurate

A perceptual metric must be validated against *human* perception of alignment, or it's just a different proxy:

- **Fixtures:** a small multi-date benchmark from the local test data under `Critical MRI Source Images (LLM Agent - do not delete)/` plus DCS study copies, favoring slice-spacing/FOV mismatches (they stress through-plane selection hardest).
- **Human agreement:** for a handful of reference slices, have a human rank several candidate target slices by visual match; measure whether the perceptual score's ranking agrees with the human ranking better than phase correlation does. This is the metric that matters for a *perceptual* change.
- **Slice error:** where a ground-truth match is known, track `|bestIndex − trueIndex|` before/after each level.
- **Post-alignment perceptual score:** log MS-SSIM (and LPIPS, once present) of the final warped target vs. reference across the batch; track median and worst-case. Verbose per-stage logs already exist behind `localStorage['miraviewer:debug-alignment'] = '1'` (`useAutoAlign.ts:175`), and per-slice metric recording already exists (`recordAlignmentSliceScore`, `alignment.ts` / `alignmentSliceScoreStore`).
- **Runtime guardrail:** log per-date time; the cascade should keep L2/L3 within budget. If a level can't stay in budget, keep it as an opt-in "high-accuracy" mode.
- **Visual check:** spot-verify with the overlay / "hold to compare" mode (`components/comparison/OverlayView.tsx`).

## Supporting precision levers (secondary)

These are not perceptual-similarity changes but make whatever metric is chosen land more precisely; pursue after the perceptual slice-selection work:

- **Tune the Elastix affine parameter map** — it currently runs on stock `defaultParameterMap('affine')`, cached unmodified (`elastixRegistration.ts:290`–`306`). Raising `MaximumNumberOfIterations`, `NumberOfSpatialSamples`, and MI `NumberOfHistogramBins` sharpens where the optimizer converges. Highest precision-per-effort, low risk.
- **Multi-resolution refinement** — flip `REFINEMENT_REGISTRATION_RESOLUTIONS` from 1 → 3 (`useAutoAlign.ts:73`) for coarse-to-fine convergence.
- **Recover the final transform at 384/512 px** rather than 256 (`ALIGNMENT_IMAGE_SIZE`, `imageCapture.ts:10`); the 512 pixels are already rendered for the coarse search.
- **Anti-aliased capture** — replace the `drawImage` downscale (`cornerstoneSliceCapture.ts:182`) with area-average resampling so features (and thus perceptual scores) aren't aliased.

## Non-goals

- **Deformable/nonrigid registration** stays out: for cross-time comparison it can hide real anatomical change, which defeats the viewer's purpose. Keep the transform affine.
- **Failure detection / confidence gating** is a robustness concern, not accuracy — excluded here.
- The transform-recovery math is already exact (continuous parameter parsing, `elastixTransform.ts:25`–`91`); no accuracy is lost there.
