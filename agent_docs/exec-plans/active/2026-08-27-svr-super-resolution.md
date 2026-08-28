# Local learned super-resolution for the selected MRI region

Status: **implemented and validated as an experimental display feature**, August 27, 2026. The user approved learned 2× three-dimensional intensity enhancement, a finer displayed surface, and original/enhanced comparison. The implementation, independent numerical tests, four-examination actual-app checks, and full regression results are recorded below. Real-image gains were modest, sometimes negligible; this is not validation of finer acquired resolution or clinical tumor accuracy. The earlier [native MRI implementation and evidence](2026-08-27-svr-segmentation-rethink.md) remains a separate result.

Try it at `http://localhost:43124/`: open 3D, mark the region, then choose **Enhance selection · 2×** above the 3D preview. Original/Enhanced, Strength, and About/Discard control the transient display result. The original MRI plane remains separately available. No pretrained download, model upload, or network inference is needed.

## Outcome and non-negotiable boundaries

Let the user inspect a more detailed rendering of the selected tissue while keeping the original MRI one action away. Enhancement is a separately labeled inference, not a replacement acquisition and not a new segmentation. It must run entirely in the browser, without uploading images, fetching a model, or requiring a Python/backend service.

- Infer a volume with twice as many samples along each of the three native-grid axes: eight output samples per source voxel, half the pitch, and the same physical voxel footprint.
- Start from original stored-pitch regional MRI, not an already subsampled overview. If native detail must be loaded first, make that preparation visible and cancellable.
- Learn from this examination's MRI context. Do not fuse dates, treat derived reformats as independent measurements, or use another examination's learned parameters.
- Preserve imported DICOM bytes, original intensity buffers, accepted registration, selection labels, both hard-mark classes, review state, undo/redo, and selected-tissue measurements.
- Enhanced intensities and the finer surface are display-only. They must never feed alignment, segmentation, model-assisted selection, measurement, or authoritative persistence as if they were acquired data.
- Keep the original MRI plane source-faithful, including its independent window and inversion. A visible source plane must not silently become an enhanced image.
- A canceled, failed, oversized, or stale operation leaves the accepted original result and annotations intact. Do not silently lower the native input pitch or call plain interpolation a successful learned result.

The enhancement does not establish finer acquired resolution. The audited originals already contain scanner-reconstructed samples finer than the nominal acquisition matrix sampling. Doubling their sample count is an additional inference, not proof that previously unseen tissue has been measured. No clinical tumor-boundary claim follows from a sharper image.

## Architecture decision

Use a small, examination-specific **3D anchored ridge residual model**, trained locally on synthetic coarse/native pairs from the original regional context. This is genuinely learned super-resolution: its coefficients are fitted to MRI examples, and it predicts eight subvoxel residuals from a three-dimensional neighborhood. It is **not** a pretrained CNN, diffusion model, or faithful implementation of a published MRI network.

The governing ownership remains simple:

1. The accepted native volume and saved categorical selection remain the authoritative evidence.
2. One cancellable worker fits and evaluates a derived intensity model using detached input copies.
3. One enhancement result contains only display intensities, geometry, footprint validity, and evaluation statistics.
4. The existing renderer compares that result with the original using the same camera, physical coordinates, window, and unchanged categorical selection.

The idea of learning from the input itself is motivated by [zero-shot internal learning](https://arxiv.org/abs/1712.06087); local patch-to-detail regression is motivated by [anchored neighborhood regression](https://openaccess.thecvf.com/content_iccv_2013/html/Timofte_Anchored_Neighborhood_Regression_2013_ICCV_paper.html). Those papers do not validate this new 3D implementation, its MRI degradation model, or its tumor fidelity. No pretrained weights or copied network implementation are required by the selected approach.

### Why a public pretrained model was not selected

A bounded, read-only review checked primary repositories, papers, source code, release metadata, and reported licenses. No weights were downloaded, and no MRI was sent to a service. The conclusion is not that browser MRI networks are impossible; a suitable, validated 3D FLAIR/tumor model was not ready to integrate within this implementation's constraints.

| Candidate                                                            | Verified availability and terms                                                                                                                                                                                                                                                                         | Fit and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ArSSR](https://github.com/iwuqing/ArSSR)                            | Three published PyTorch checkpoints, approximately 10.33–25.17 MB. No explicit repository license found; the current repository metadata reports no license.                                                                                                                                            | Real 3D arbitrary-scale inference, but the released model is HCP T1-weighted; the paper explicitly warns about other-sequence generalization. Export requires the 3D encoder, a five-dimensional `grid_sample`, and coordinate-conditioned decoder. No browser conversion or FLAIR/tumor validation was verified. [Paper](https://arxiv.org/pdf/2110.14476), [model code](https://github.com/iwuqing/ArSSR/blob/main/model.py).                                                                                                |
| [RAVEN](https://github.com/waadgo/raven)                             | Code reports MIT; the published [checkpoint archive](https://zenodo.org/records/21999063) reports CC-BY-4.0. Archive size 2,120,490,706 bytes; the primary checkpoint is 650,272,374 bytes according to its [manifest](https://github.com/waadgo/raven/blob/main/checkpoints/checkpoint_manifest.json). | Closest licensed 3D multi-contrast candidate found. Requires a dedicated inference export and preprocessing audit: its current instructions recommend FONDUE-denoised input and do not establish raw-input performance. Its [runtime notes](https://github.com/waadgo/raven/blob/main/inference/raven_v1_3/README.md) explicitly describe 25 missing newer-module keys during non-strict loading, percentile clipping, and nonlinear histogram matching. Inference-only weight size and browser performance remain unmeasured. |
| [PRETTIER](https://github.com/diagiraldo/PRETTIER)                   | Repository [GPL-3.0](https://github.com/diagiraldo/PRETTIER/blob/main/LICENSE); published fine-tuned checkpoints. The smallest listed ShuffleMixer has 410,579 parameters, about 1.64 MB of FP32 coefficients before checkpoint overhead.                                                               | Relevant T2-FLAIR/MS training, but its evaluated task is 6 mm to 1 mm through-plane recovery using 2D models and multi-plane output combination. The compact architecture has a 2D 4× head, not this native-volume 2× task. Conversion, exact checkpoint terms, licensing integration, and tumor-domain validation were not completed. [Method](https://pmc.ncbi.nlm.nih.gov/articles/PMC11534588/).                                                                                                                           |
| [BETACLARITY](https://huggingface.co/OdaxAI/betaclarity-betasr-onnx) | Published ONNX bundle tagged Apache-2.0; roughly 320 MB across the quantized UNet and two VQ-VAE graphs.                                                                                                                                                                                                | Its stated task is 2D 128×128 to 512×512 enhancement across modalities. A Python/CoreML demo is not proof of browser execution or cross-slice fidelity; the model card also contains non-commercial-research wording requiring clarification. It does not provide the requested learned 3D 2× mapping. [Repository](https://github.com/odaxai/BETACLARITY).                                                                                                                                                                    |
| [MR-DiffuSR](https://arxiv.org/html/2606.25255v1)                    | Paper available; no usable checkpoint, model license, or browser export was verified during the bounded search.                                                                                                                                                                                         | A 3D FLAIR approach, but it requires a co-registered high-resolution T1 reference and trains on 4×–10× thick-slice degradation. This is a materially different input contract.                                                                                                                                                                                                                                                                                                                                                 |

The current [ONNX Runtime WebGPU operator table](https://github.com/microsoft/onnxruntime/blob/main/js/web/docs/webgpu-operators.md) explicitly excludes Conv3D/ConvTranspose3D and lists GridSample only for opsets 16–19. That is a practical obstacle for these 3D networks, not a claim that WASM execution or custom GPU kernels are impossible. A production choice would need exact-version operator tests, an inference-only conversion, memory/latency measurements, and a same-domain fidelity study. None of those was demonstrated merely by finding a download link.

## Learned method

The equations and constants below describe the revised core in `frontend/src/utils/svr/superResolution.ts`, with shared contracts in `superResolutionTypes.ts`. This is the **33-feature, 16³-block revision**, not the initial 27-feature model used in private batch 319. Focused tests, broader numerical checks, and four-examination visual validation are complete within the limits recorded below. The initial model's misleading proxy result and the resulting correction are preserved in the historical evidence section below.

### 1. Native evidence and synthetic degradation

Let `H` be supported, finite, original-pitch MRI intensities in the selected region plus context. Define `D` as exact averaging of each non-overlapping 2×2×2 block:

```text
L[i] = D(H)[i] = (1 / 8) Σ_b H[2i + b],  b ∈ {0,1}³.
```

Only eligible complete supported blocks become training targets. Missing data, padding, and nonfinite values do not become zero-valued observations. This box-average degradation supplies internal training pairs; it is not asserted to reproduce the scanner's k-space, slice profile, or reconstruction kernel.

Let `U` be trilinear upsampling to the child centers. Make its baseline consistent with the parent block mean:

```text
Uc(L)[2i+b] = U(L)[2i+b] + L[i] - D(U(L))[i].
D(Uc(L)) = L.
```

Comparison against `Uc` isolates the learned residual from ordinary interpolation and the same mean-consistency correction. Comparing only against a coarser rendering or a differently windowed image would not demonstrate learning benefit.

### 2. Features, anchors, and local models

For a coarse center `i`, use its 3×3×3 neighborhood plus the six axial samples at distance two: 33 stencil positions. Estimate the local gradient and Hessian from the central neighborhood, then subtract the corresponding quadratic Taylor polynomial from every neighbor-minus-center difference. Divide by the RMS of the original central-neighborhood differences. There is **no bias/intercept feature**:

```text
s_i = RMS of the 26 original neighbor-center differences
Q_i(δ) = g_i · δ + 0.5 δᵀ H_i δ
x_i[δ] = (L[i+δ] - L[i] - Q_i(δ)) / s_i,  δ in the 33-position stencil
y_i[b] = (H[2i+b] - Uc(L)[2i+b]) / s_i.
```

Here `H_i` in `Q_i` denotes the local Hessian, while `H` in the target remains native MRI. A nonfinite or near-zero local scale makes a stencil ineligible for a learned correction; unsupported neighbors never become training observations. The feature map annihilates constant, linear, and quadratic intensity fields, apart from input rounding. This prevents the learned residual from reintroducing a scale-specific first-gradient sharpening gain. The center's feature is identically zero; retaining it keeps the stencil's direct geometry without adding another learned authority.

Six normalized gradient/curvature descriptors from the original local differences assign structure to at most eight k-means anchors. These descriptors select the expert; they do not bypass the high-order feature restriction. Anchors are learned using training blocks only. Each anchor has an eight-output ridge model. With feature columns in `X_a` and target columns in `Y_a`:

```text
W_a = Y_a X_aᵀ (X_a X_aᵀ + λ_a I)⁻¹
λ_a = 0.02 × max(1, trace(X_a X_aᵀ) / 33).
```

Accumulate and solve in Float64. The implementation must reject or safely handle insufficient samples and ill-conditioned/nonfinite systems, rather than publishing invalid intensities. Exact numerical floors and residual caps belong to the core and its tests, not independent UI tuning.

### 3. Spatially separated training, calibration, and evaluation

Deterministically assign 16×16×16 native blocks to training/calibration/held-out groups: flattened block ID modulo five assigns 0 to calibration, 1 to held-out, and 2–4 to training. The enlarged stencil has a 10×10×10 native bounding receptive field. Its complete features **and** targets must fit inside one assigned block; boundary-crossing stencils are excluded. Merely withholding target voxels while their neighbors enter training is not independent evaluation. The 60/20/20 assignment describes block roles, not a guarantee of exactly those sample fractions in cropped or sparsely supported data.

Sample caps are 16,384 training, 2,048 calibration, and 4,096 held-out centers; minimum counts are 128, 32, and 32 respectively, with at least two sampled spatial blocks in every group. The core requires at least 32 source voxels along every axis (`MIN_SR_CONTEXT_DIM`); that dimension floor alone does not establish sufficient textured support. Record both sample counts and independent spatial-block counts. Sparse support and too-small context must produce an actionable limitation, not a fabricated confidence statistic.

Use only calibration blocks to choose the global model strength `α` in the initial implementation range `[0.25, 1]`. Freeze anchors, coefficients, and strength before held-out evaluation. The held-out blocks must not fit the model, tune strength, select a favorable reported subset, or be recycled into training after evaluation.

### 4. Predict eight children with source consistency

At native resolution, apply the same local feature map and learned anchor model. Center the predicted eight residuals to zero mean and bound their magnitude using finite local evidence. Add the calibrated residual to the consistent interpolation baseline:

```text
r_i = bounded, zero-mean(s_i W_anchor(i) x_i)
E[2i+b] = Uc(H)[2i+b] + α r_i[b]
D(E)[i] = H[i], within recorded floating-point tolerance.
```

The block-mean constraint preserves the parent intensity under the chosen synthetic degradation; it does not prove that any individual inferred child is anatomically correct. Constant, noisy, anisotropic, thin-structure, and sharp-boundary cases need separate tests. No global histogram remapping or contrast change may be mistaken for recovered texture.

For native origin `o`, direction columns `d₀,d₁,d₂`, pitch `p`, and dimensions `n`, the enhanced grid is:

```text
n' = 2n
p' = p / 2
o' = o - (d₀ p₀ + d₁ p₁ + d₂ p₂) / 4.
```

The quarter-voxel origin shift places the eight children symmetrically inside each original cell, preserving its full physical footprint. The source direction is unchanged. Replicated validity denotes the original cell's supported footprint, **not newly acquired subvoxel evidence**.

### 5. Quantitative reporting and uncertainty

Report raw-intensity held-out `baselineMse` and `enhancedMse`, train/calibration/held-out sample and block counts, calibrated strength, elapsed time, and maximum block-mean consistency error. The held-out comparison is against native samples after synthetic degradation. There is no measured twice-native-resolution ground truth in this corpus.

The current core design reports negative held-out gain instead of silently discarding an unfavorable experiment. The UI must preserve that result honestly: a failed or inconclusive benefit test cannot be labeled a fidelity improvement or a confidence score. Original comparison remains available. A later change to gate publication on held-out performance would require an explicit policy and independent evaluation, not tuning on the reporting partition.

## Rendering and comparison contract

The renderer binding owns an R16F enhanced-intensity texture, nearest-sampled R8 footprint-validity texture, and a third R16F **native-original ROI** texture. The viewer publishes the original regional source and enhanced result together under one run scope. Original/Enhanced therefore compares the same native-pitch tissue context, not an enhanced native ROI against a coarser overview. Upload validates the two grids' exact 2× relationship, direction, half-pitch, quarter-voxel origin, full cell-edge footprint, and replicated validity. Do not silently fall back to R8 intensities or a lower-resolution enhancement when allocation fails. CPU held-out/consistency statistics describe Float32 model output, not a promise of identical half-float framebuffer values.

- Transform base texture coordinates through patient millimeters into the enhanced grid, including both grids' voxel-center conventions. A crop-origin shift is not registration.
- Normalize enhanced display intensities with the base volume's intensity range, window, and inversion, **without clamping to that range before upload**. A stride-sampled overview can miss a native extremum. Signed and above-one R16F samples remain available when widening the window; only shader windowing clips the displayed result. Values that cannot be represented as finite half-float fail explicitly rather than flattening detail. Preserve the base camera and physical focus when toggling Original/Enhanced.
- Apply inferred intensities only within the existing selected label region. Preserve original intensities outside it, and do not render invented data in unsupported source footprints.
- Keep the intensity and normal fields continuous through the regional context; mask final compositing rather than zeroing the MRI before computing texture or gradients. Reject interpolation neighborhoods containing unsupported contributing samples.
- Keep raw original-source image planes unchanged. Their controls and provenance remain distinguishable from inferred volume rendering.
- A finer surface uses the existing categorical mask's trilinear coverage at the 0.5 isovalue. Its analytic derivative is used **only for cut-edge antialiasing**, never as an MRI lighting normal: a binary mask's derivative has discontinuities at coarse cell boundaries and produced a visible grid in real-data validation. Both modes use the MRI intensity gradient for lighting. This is display interpolation, not a rewritten segmentation or a newly learned tumor boundary. No signed-distance volume or new measurement authority is introduced.
- Toggling enhancement or surface smoothing must not change the mask checksum, marks, selection volume, review state, or saved record. The original categorical contour remains the reference for reviewing any apparent surface difference.
- Clearing the result, replacing the volume, losing context, or disposing the viewer releases the enhanced textures. A late result cannot attach to a newer examination or selection.

## UX and reliability

The integrated action is **Enhance selection · 2×**, with progress through preparation/training/validation/enhancement, cancellation, and an immediate **Original / Enhanced · 2×** comparison. A 0–100% strength slider blends against the same native source. **Inferred detail—not acquired** remains visible near the enhanced state. About explains self-training, spatial test blocks, the synthetic held-out result, grid pitch, and how to discard the ephemeral enhancement.

Show a compact explanation that the model learned from the current MRI and that original masks/measurements are unchanged. Surface-detail and intensity-strength controls affect presentation only. A negative/insufficient held-out result should be readable without expanding a developer log. Avoid large parameter panels obscuring the anatomy.

Each request/result is bound to the current accepted volume and selection-buffer scope; each run has its own abort/controller identity and newly constructed worker. There is no persisted model or cross-examination weight cache. New source/selection changes invalidate pending work, and disposed workers cannot publish into their replacements. Cancellation works during native loading as well as fitting and prediction; only dedicated copies are transferred, never the caller's original buffers.

The output cap is **16,777,216 voxels**. Enhancement reserves `32 MiB + 104 × native-input-voxel-count` for worker copies, fitting scratch, output, upload staging, and GPU ownership, plus the accepted volume, decoded-image/native-plane caches, previous enhanced allocation, and retained selection buffers. The selection owner supplies the actual deduplicated backing-buffer sizes of its warm boundary worker, undo/redo patches, and current hard marks. This is conservative **512 MiB admission accounting**, not a measured operating-system peak or exact accounting for every JavaScript object. A selection exceeding admission fails before large allocation and retains the original; no hidden input downsampling is allowed. Larger tiled processing is future work.

An accepted volume at native pitch is not necessarily a sufficient training context: it may be a previously cropped focus region. The loader derives the full source extent from accepted geometry metadata, plans the selected region plus context there, and reuses the accepted crop only if it contains every planned cell footprint. Otherwise it reloads surrounding original pixels without publishing a new authoritative volume. At a true acquisition edge, the requested context shifts inward to use at least 32 actual samples when available; insufficient full-source dimensions remain an honest limitation, not synthesized padding. Source changes release obsolete selection-history/status, window/cursor settings, and loaded native-plane owners instead of merely hiding them.

The chosen MRI plane follows its series UID across native cropping and source-list reordering. It falls back to the new primary source when the chosen UID is absent, rather than retaining another examination's source or unexpectedly changing axial inspection to sagittal after refinement.

## Validation gates

The ledger below distinguishes completed checks, rejected experiments, and evidence limitations. Passing prior native-plane tests alone is not used to validate learned SR.

### Numerical and model tests

1. Independent continuous 3D phantoms: heterogeneous texture, bright/dark regions, sharp interfaces, thin structures, constant fields, and noise. Generate reference samples independently of the production upsampler; compare both intensity and gradient error against `Uc`, not only visual sharpness.
2. Train/calibration/test separation: prove complete receptive-field containment, disjoint spatial blocks, frozen held-out parameters, deterministic sampling, and reproducible results. Report negative results and insufficient-support cases.
3. Geometry: anisotropic pitch, oblique/reflected directions, nonzero origins, cropped contexts, and all eight child centers. Verify preserved physical voxel footprints and exact patient-coordinate correspondence.
4. Mean consistency: downsample each supported enhanced 2³ block and compare with its unchanged source intensity using an explicit scale-aware Float32 tolerance. Report the maximum error, including signed/high-dynamic-range values.
5. Support and bounds: padding holes, missing edges, NaN/Infinity, unowned geometry, invalid dimensions, output limits, memory rejection, and no unsupported inference. No label or mark mutation on any path.
6. Worker lifecycle: cancel in each phase, stalled native loading, repeated runs, replacement sources/selections, late completion/error, and source-array immutability. Verify resource cleanup and no stale publication.

### Renderer and UI tests

1. Original/enhanced toggling preserves camera, source plane, window, selection labels, marks, review state, and measurements; asymmetric geometry fixtures catch half-voxel shifts and transposed axes.
2. Same-window grayscale checks cover signed values, MONOCHROME1 inversion, width-one VOI, unsupported footprints, and Float16 texture precision separately from CPU model output.
3. GPU allocation/upload failure restores usable original rendering. Original/Enhanced toggling reuses the prepared regional textures without reloading or retraining; clearing enhancement releases them without reallocating unrelated source/mask textures.
4. Surface interpolation is display-only and reversible through Original/Enhanced; zero strength uses the original presentation. No renderer-derived mask is sent to saved labels, the grower, measurement, or optional model inference. Controlled shader ablations separately isolate surface and intensity changes during diagnosis; those overrides are not product controls.
5. Progress, cancellation, insufficient data, negative held-out gain, and oversized-region errors are actionable and preserve current work. Compact desktop and mobile controls remain usable.

### Private actual-app visual validation

Use isolated headed Chrome with the supplied MRI, never replace the user's browser database. Reuse the original source and reviewed test-region context where practical, but do not treat the earlier rejected automatic mask or a new algorithm's own output as a clinical golden truth.

Capture and individually inspect at original resolution: the matched Original/Enhanced region; raw source-plane context; axial/coronal/sagittal texture; thin and high-curvature boundaries; the rotated 3D endpoint; surface smoothing off/on; and compact desktop/mobile controls. Match camera and window before comparison. State whether each image shows acquired samples, interpolated display, or inferred intensities. A normalized comparison may assist review but cannot replace full actual-app inspection.

Measure native preparation, training, calibration/evaluation, enhancement, GPU upload, original/enhanced switching, and warm interaction separately. Record input/output dimensions and pitch, source support, held-out statistics, label/mark checksums, browser errors, peak planned allocations, and observed cache/GPU resources. Static screenshots do not prove sustained frame rate.

MRI-derived images, receipts, and logs stay ignored and local. No image is embedded in this plan or proposed for a pull request. A visual verdict must be written only after inspection; an automatically captured file remains unvalidated until then.

## Execution and evidence ledger

### Historical experiment 319: rejected, not current fidelity evidence

Private receipt: `frontend/tmp/private-tumor-segmentation-validation/319-super-resolution-receipt.json`. The first model used 27 low-order neighborhood/bias features and 12³ spatial blocks. It loaded a 53×83×65 native context at 0.6×0.4297×0.4297 mm and produced 106×166×130 inferred samples at half that pitch. The receipt recorded unchanged volume/label identity and source fingerprint. Preparation plus enhancement reached ready in approximately 970 ms, with approximately 232 ms in the core on that one local run; these are historical single-run timings, not a current performance guarantee.

Its synthetically degraded held-out MSE improved from 333.4793 to 192.8561, approximately 42.2%, over 1,616 held-out centers in 26 spatial blocks. Maximum source-cell mean error was 0.0000038147 raw intensity units. **This did not establish actual 2× fidelity.** Parent visual inspection rejected the result, and independent known-fine-grid phantoms showed roughly ninefold worse MSE than consistent interpolation despite the favorable proxy score.

The core investigation traced the mismatch to a learned first-gradient gain that did not transfer correctly from coarse-to-native training to native-to-finer prediction. The remedy changes the feature representation, not the reporting partition or the unchanged fine-grid oracle: 33 quadratic-subtracted features with no bias, a 10³ native receptive field, and 16³ spatial blocks. A separate rendering defect also left the selected cut surface gated by nearest labels; the revised renderer uses the continuous categorical isosurface and screen-space antialiasing there. Neither a smoother silhouette nor a better synthetic proxy is accepted alone as proof of recovered MRI detail.

### Revised model: independent fine-grid evidence

The revised core and worker have **39/39 focused tests** passing. They cover polynomial annihilation, source consistency, signed data, oblique geometry, acquired support, strictly isolated receptive fields, a deliberately negative held-out result, and defensive worker/cancellation behavior. Six independent fine-grid cases each compare 175,616 known reference samples. The native input is the exact block average of independently generated fine truth; it is not constructed with the production interpolator:

| Phantom                      | Consistent-interpolation MSE | Revised learned-output MSE |
| ---------------------------- | ---------------------------: | -------------------------: |
| Textured field, phase 0.31   |                    0.1544903 |                 0.00527245 |
| Textured field, phase 1.17   |                    0.1598073 |                 0.00542929 |
| Asymmetric smooth structures |                  0.003021144 |                0.000080706 |
| Oblique soft edge            |                  0.013187531 |                0.000015384 |
| Spatially varying frequency  |                  0.083451947 |                0.003568173 |
| Sharp oblique edge           |                   28.6795995 |                  6.3212087 |

These cases demonstrate actual finer-grid predictive benefit on the specified synthetic signals, not generalization to arbitrary MRI or tumors. The sharp-edge test independently checks all 262,144 output values are finite and verifies every source-cell mean, with maximum error 0.000000954 raw units. Its pointwise improvement does **not** imply uniformly improved weak-axis derivatives: neither independent child prediction nor hard anchor selection guarantees cross-cell derivative continuity. A separate null-space counterexample gives opposite fine checker patterns with the same native input: the algorithm cannot know which hidden pattern was present. Favorable synthetic scores must not be reported as recovered patient anatomy.

Final focused groups passed: core/worker **39**, enhancement lifecycle **24**, region/context **20**, viewer UI **53**, enhancement binding **31**, native planes **25**, occupancy **18**, source loader/view **26**, selection lifecycle **15**, and selection worker **13**. These groups overlap the full regression suite; they are not additional tests to add to its total. Worker faults include malformed envelopes/progress/results, invalid geometry/buffers, callback exceptions, timeouts, replacement, and late completion; each must terminate cleanly without detaching the caller's original data.

### Real-data rendering diagnosis and corrected checkpoint

All captures use the actual app at `http://localhost:43124/`, isolated headed installed Chrome, WebGL2 on ANGLE Metal / Apple M4 Max, and a newly imported private corpus copy. The marked ellipsoid is a deterministic workflow fixture near a reviewed source location, **not an expert tumor mask**. Patient data and all derived images remain under ignored `frontend/tmp/private-tumor-segmentation-validation/`.

| Batch | Evidence and bounded result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 321   | Corrected model on the 512-pixel-source examination: source 53×83×65 to 106×166×130; approximately 935 ms action-to-ready, 222 ms model work. Matched comparison passed for modest texture/outline improvement. Native-source/label identity, checksum, review state, and measurement remained unchanged; zero browser errors.                                                                                                                                                                                                                                              |
| 323   | 1024-pixel-source examination: source 45×125×125 to 90×250×250, approximately 2,424 ms action-to-ready and 445 ms model work. Cancel completed in approximately 12 ms. All source/selection invariants passed, but direct visual inspection **failed**: broad grid-like surface lighting and haze. UI screenshots not individually inspected remain captured-unvalidated.                                                                                                                                                                                                   |
| 324   | Same source, controlled diagnostic. A frontal cut had no broad interior grid; forcing the enhanced boundary branch off removed the grid from the volume without replacing the inferred MRI field. This isolated a display defect rather than justifying model retuning. Direct source inspections: `324q6-normalized-frontal-cut-comparison.png`, `324q3-enhanced-surface.png`, `324q4-diagnostic-enhanced-without-boundary-lighting.png`. The ablation is diagnostic only, not a shipped state.                                                                            |
| 326   | Removed only the categorical-gradient lighting override. `326q3-enhanced-surface.png` passed for eliminating the introduced grid. `326q6-normalized-frontal-cut-comparison.png` passed for a matched, non-clipped cut comparison: slightly crisper internal transitions, smoother outline, no obvious new ringing/grid. Both views used the existing window controls at the same full source range; product defaults were not changed. Improvements are modest; the underlying marked silhouette remains coarse. Zero browser errors and exact source/selection invariants. |

The 1024-source model is deterministic across these runs: held-out MSE 4,116.0117 → 2,550.5373 across 1,800 centers in 39 independent blocks; maximum source-cell mean error 0.00003052 raw units. This is a 38.0% reduction on the **synthetically reduced held-out task**, not a claim of 38% greater real MRI fidelity. Action-to-ready time varied approximately 2.4–3.3 seconds on this development machine; these single runs include source preparation/render scheduling and were not controlled throughput benchmarks.

A private CPU reproduction sampled 81,948 matched supported fine-grid quads per axis. Enhanced across-parent/within-parent gradient-energy ratios were 1.0072, 1.0040, and 0.9978, versus 1.7286, 1.2759, and 1.3303 for the mean-consistent interpolation baseline. Matched third-difference RMS fell from 59.291/10.181/12.262 to 31.945/4.845/5.813 raw units. The model reduced this baseline's block-boundary signature rather than explaining the much larger on-screen grid. Ordinary interpolation has less curvature on some axes, and aggregate metrics do not exclude every local artifact.

Every inspected batch completed a scoped current/stale browser-process and temporary-profile audit: **Cleanup: CLOSED**, user and other-worktree browsers preserved. Batches 320, 322, and 325 were blocked by stale development modules rather than accepted as evidence. The harness now compares served sourcemap source text against exact local source before opening Chrome. The repeated macOS refresh problem was traced to Chokidar choosing FSEvents before its polling environment override; the Vite config now explicitly disables FSEvents when polling is requested. This opt-in fix does not change production builds or ordinary watcher defaults.

### Final four-examination and workflow checks

The final corpus receipts use anonymous examination ordinals, not public patient identifiers. All four retained identical original-volume identity/hash, selection identity/hash, hard marks, review state, and measurement before/after enhancement, with **zero browser runtime errors**. Original/Enhanced comparisons used the same camera and window. Timings are observed single runs on this development machine, not a speedup or FPS claim.

| Corpus ordinal / batch     | Native input → enhanced dimensions | Action to ready | Model work | Synthetic held-out MSE, baseline → learned | Held-out spatial blocks |
| -------------------------- | ---------------------------------- | --------------: | ---------: | -----------------------------------------: | ----------------------: |
| 1 / 329                    | 51×69×55 → 102×138×110             |        1,221 ms |     142 ms |                        515.7685 → 244.0932 |                       6 |
| 9 / 328, native crop first | 44×125×125 → 88×250×250            |        2,177 ms |     420 ms |                    3,088.7729 → 1,942.0116 |                      39 |
| 15 / 330                   | 47×53×53 → 94×106×106              |          760 ms |     119 ms |                        281.0823 → 114.7384 |                       5 |
| 18 / 331                   | 53×83×65 → 106×166×130             |          754 ms |     215 ms |                        263.6331 → 109.0590 |                      12 |

Maximum source-cell mean error was at most **0.00003052 raw units**. Original/Enhanced switching took approximately **18–26 ms from input through the observed two-RAF checkpoint**; this is not a GPU-completion or sustained frame-rate measurement. Native-crop cancellation took approximately **9 ms** and left the reviewed selection unchanged.

Batch 327 initially failed presentation: loading native detail reset the selected axial source to the primary sagittal acquisition, so the subsequent face-slice action combined a sagittal camera with an axial cut. The series-UID selection fix produced batch 328's bounded pass. The accepted native crop was 39×117×113; enhancement privately reloaded a wider 44×125×125 context without replacing it or changing its 1.8483273 mL selection measurement.

Individually inspected final evidence, under the ignored private directory:

- `328h-normalized-original-enhanced-comparison.png`: full selected region and chosen orientation restored; reversible comparison passes. Coarse mask steps remain visible in both modes; dramatic detail gain is not demonstrated.
- `328g3-mobile-enhancement-controls.png`: 430×932 touch layout, 44 px comparison/strength targets, no horizontal overflow or overlapping controls, and a 404×410.5 px 3D canvas. Pass is limited to this visible preview, not off-screen editing tools or animation.
- `328f2-model-provenance.png`: readable inferred/acquired distinction, qualified held-out statistic, and discard control; main tissue remains visible.
- `329h-normalized-original-enhanced-comparison.png`: smoother outline without an obvious new lattice or halo; negligible texture gain in this relatively uniform section.
- `330h-normalized-original-enhanced-comparison.png`: same internal pattern with a less stair-stepped edge; deliberately wide contrast makes the image dark, limiting texture conclusions.
- `331h-normalized-original-enhanced-comparison.png`: preserved internal positions, smoother outline, and mildly clearer transitions without obvious new grid/ringing.

The last two batches include the final upload-range correction and native-plane lifetime cleanup. Earlier images establish their stated checkpoint only; no pixel-equivalence claim is made across later renderer changes. The range fix is independently covered by exact half-float decoding/window tests, including native 150/200 values with overview range 0–100 and window 0–200 producing 0.75/1.0 instead of both flattening to 0.5. Its real-data relevance is confirmed in batch 331: two native ROI values exceeded the overview maximum (935 versus 902). Inferred values can also exceed source extrema; they remain inferred and do not enter measurements.

These are functional/visual workflow fixtures, not expert-reviewed segmentation ground truth. Three-plane geometry, signed values, support boundaries, half-voxel footprints, and sharp-edge behavior additionally have numerical regression coverage. No claim of exhaustive patient-specific anatomical validation, smoother motion, or clinically reliable super-resolution is made.

### Final verification

- `npx vitest run --reporter=json --outputFile=tmp/svr-super-resolution-regression-final.json`: **1,434 passed, 0 failed, 11 skipped across 133 files**. Skips are existing opt-in private alignment/import/SVR corpus suites; they were not silently counted as passes. The actual-app MRI runs above separately exercise this enhancement workflow.
- `npm run lint`: pass.
- `npm run build`: pass, including the bundled 10.12 kB super-resolution worker. The existing large-main-chunk advisory remains; no build error or missing worker asset.
- Full offline React Doctor: **304 files analyzed, 0 errors, 0 warnings, no skipped checks**. `score` is null in offline JSON; this is not represented as a fetched numerical 100/100 score. Receipt: `frontend/tmp/svr-super-resolution-doctor-final.json`.
- Changed/new frontend source and tests pass Prettier; `git diff --check` passes.
- MRI source files, private raw excerpts, and derived captures remain ignored/local. No MRI files are tracked or staged, and no images were uploaded for inference.

| Stage                                                               | Current status                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public pretrained feasibility                                       | Complete, bounded read-only review; no weights downloaded or MRI uploaded. Findings above are availability/domain/runtime constraints, not a universal model ranking. |
| Shared SR types and initial limits                                  | Implemented and tested: 16,777,216 output-voxel cap, 32-voxel minimum context, and retained-owner admission.                                                          |
| Pure 3D model and worker                                            | Revised high-order model implemented; 39/39 focused core/worker tests passed. Six known-fine-grid cases and the null-space limitation are covered.                    |
| Native-region preparation and viewer controls                       | Native-context expansion, source-choice continuity, cancellation, ownership release, reversible controls, and mobile layout validated within the recorded scope.      |
| Enhanced texture binding and display-only surface                   | MRI-gradient lighting and range-preserving upload corrected; 74 focused binding/native-plane/occupancy tests pass, plus final actual-app comparisons.                 |
| Independent quantitative tests                                      | Six known-fine-grid cases pass; historical low-order failure preserved. Real-data seam diagnostics distinguish intensity inference from display artifacts.            |
| Private actual-app visual validation                                | Four-examination sweep complete with bounded findings above; every owned browser/profile cleaned up.                                                                  |
| Final full suite, lint, build, formatting, and offline React Doctor | Pass; exact counts, opt-in skips, and build advisory recorded above.                                                                                                  |

## Limits and next decisions

Internal learning assumes useful local patterns recur across scales. Scanner interpolation, noise, partial-volume effects, small context, and tumor heterogeneity can break that assumption. Synthetic held-out improvement is evidence about that prediction task, not proof of details beyond the acquired bandwidth. The stronger model output may be worse on an unseen structure even when its average held-out error improves.

Keep the current implementation experimental and the comparison reversible. Before claiming tumor fidelity, obtain expert review and independently acquired higher-resolution or otherwise justified reference data. A future pretrained-model track should retain the same source/mask boundaries and first demonstrate a licensed, exact-version browser conversion, appropriate FLAIR/pathology preprocessing, independent volumetric evaluation, and acceptable memory/latency. It should not inherit validation merely from a published paper or an attractive enhanced surface.
