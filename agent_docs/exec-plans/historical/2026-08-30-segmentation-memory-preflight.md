# Boundary-suggestion prompt planning and memory admission

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

Current implementation: the initial prompt repair below is now supplemented by exact query-blocked attention in the v2 model. The follow-up section records the rejected alternatives, measured MRI parity, final admission accounting and remaining live-browser limitation. Earlier measurements are retained as historical evidence, not presented as measurements of the later 6,734 MiB case.

## Outcome and scope

The reported approximately 3,262 MiB rejection was caused in part by charging every literal brush voxel as a simultaneous model prompt. The saved browser case now estimates 2,821.7 MiB, within the unchanged 3,072 MiB application budget. Reapplying the old formula to the same live ownership measurements gives 3,260.7 MiB: a 439.0 MiB reduction in the estimate, not a measured reduction in RAM consumption. The small difference from the reported warning reflects a different live ownership snapshot.

This change corrects prompt grouping and admission accounting, preserves all user marks, and explains the remaining estimate. It does not raise memory limits, downsample MRI input, discard conditioning planes, change the inference provider, or establish a new anatomical gold standard. Existing unrelated worktree changes are preserved.

## Root causes and implementation

1. **Wrong connectivity grid.** Mapping coarse brush centers to the finer native grid before grouping could fragment one connected stroke into many isolated prompts. `planTrackingPrompts` now groups on the owning editing grid, selects an actual marked voxel nearest each component's physical centroid, then maps that representative exactly to its native plane. This never fills gaps or dilates hard marks. Ties use the owning editing-grid index, deliberately stable before mapping. Native frame order is restored after signed/permuted mapping.
2. **Wrong decoder concurrency.** Each decoder invocation handles one frame's compressed prompts, not every mark across every frame. Admission now uses `maximumFramePrompts` for dynamic decoder attention. The full literal count still pays for linear mapping/component scratch. Every marked plane still contributes to temporal memory.
3. **Misleading limit description.** The budget is MiraViewer's safety policy, not a browser-reported hard limit. The error now distinguishes estimates from measurements, explains the application cap, and does not suggest buying more RAM or deleting marks. An accessible, collapsed-by-default disclosure shows phase peaks, the tracking breakdown, marked-slice count, busiest-frame prompts, and literal marks retained.

The same deterministic planner is called before native allocation and again after loading the exact planned crop. There is no separate heuristic count or externally supplied stale prompt plan. The inference adapter still validates **every** literal mark against actual native intensity/support before constructing its worker, including marks not chosen as representatives. The crop owner continues to guarantee the planned physical grid.

Structured error details are transient hook state, never persisted with MRI annotations. A retry, cancellation, new owner, or unrelated stroke error cannot retain stale memory details. Existing selection publication, hard-mark enforcement, connected-component processing, history, and cancellation remain authoritative.

## Safety accounting retained

- The operation budget remains one quarter of reported device RAM, capped at 3,072 MiB; unknown RAM retains the existing 1,536 MiB policy.
- The fixed 1,024 MiB model/runtime reserve remains unchanged and explicitly conservative.
- Source preparation, inference and publication are separate phases. Admission takes their **maximum**, not their sum.
- Live MRI/viewer/history/cache owners, native crop and output mask, conditioning state, packed temporal memory, temporal attention, working buffers and publication scratch remain included.
- WASM remains the explicit validated provider; this change introduces no provider fallback.

## Real-browser validation

The existing local application and imported MRI database were used in an owned Chrome tab. The saved case had 1,006 foreground marks, no background marks, and 24 marked native sections. Actual worker inputs were 197 × 85 pixels over 512 native sections, with one anchor prompt, 23 additional marked frames, and a maximum of two prompts on a frame. These counts matched preflight.

For the error-layout test only, `navigator.deviceMemory` was temporarily overridden in the owned tab so the real admission guard rejected before model startup. It was then restored. Retrying under the ordinary 3,072 MiB budget passed all source/crop/inference admission checks and ran the actual WASM model. Six preparation frames and eight decoder passes were observed before an intentional UI cancellation. No provisional mask was published. SHA-256 readback confirmed the saved mask, foreground marks and background marks were all byte-identical before and after.

Two canonical source captures were individually inspected at original resolution and immediately reported. The expanded disclosure passed desktop layout checks, including 1600 × 1000: readable aligned values, restrained existing typography/colors, no overlapping text or clipping, and MRI panels remaining below the scrollable explanation. These are static error-layout checks, not frame-rate or anatomical validation.

Private evidence: `frontend/tmp/segmentation-golden/memory-preflight-20260830/` contains the browser receipt, source captures, test reports and scoped cleanup audit. Temporary worker observation, RAM override and viewport override were removed. The owned tab was closed; stale-owned IDs were absent; both preexisting MiraViewer tabs remained open. Other external tabs changed independently during the batch; no external tab was closed by this agent. Primary Chrome was not restarted.

## Saved-corpus replay

Production planners were also run against four saved annotation snapshots from one examination, using hash-pinned actual raw values/support at every literal mark. Two snapshots share the same overview marks; they are not independent examinations. Non-mark backing cells were NaN/unsupported, not fabricated finite MRI values. This replay validates prompts and geometry, **not** full-context inference.

| Saved state | Literal marks | Actual prompts before → after | Marked planes | Decoder reserve before → after |
| --- | ---: | ---: | ---: | ---: |
| Overview, both saved snapshots | 54 | 10 → 2 | 1 | 19.52 → 2.82 MiB |
| Native transferred selection | 216 | 4 → 4 | 2 | 75.76 → 2.82 MiB |
| Native correction | 227 | 21 → 21 | 21 | 79.81 → 2.51 MiB |

The old reserve column uses the old **global literal-count** formula; it is not measured attention allocation for the actual old prompt count. Both native-detail controls have identical old/new canonical prompt-coordinate hashes. Every literal mark and marked frame set is unchanged. Full historical admission peaks cannot be reconstructed because the corresponding live retained/cache/source-load owners were not saved.

Private replay and source/code hashes: `frontend/tmp/segmentation-golden/validation-20260830/prompt-admission-replay-20260830/receipt.json`.

## Automated verification

Regression coverage includes all three planes, coarse anisotropic grids, nonzero phase, axis permutations/reversals, disconnected Add/Remove components, negative-only frames, orthogonal last-stroke changes, unchanged literal bytes, invalid nonrepresentative marks, exact admission/worker count agreement, phase sums, budget rejection, typed error details, retry, undo/redo, cancellation and stale-owner isolation.

Focused algorithm/admission tests: 219 passed. Hook/editor tests: 126 passed. Workspace integration: 50 passed after adding the new required prompt-count field to two exact-request expectations. The final complete suite passed **3,088 tests, zero failures, with 54 opt-in tests skipped** (3,142 total); its receipt is `frontend/tmp/segmentation-golden/memory-preflight-20260830/final-tests.json`. TypeScript and production build passed; model assets verified. Whole-tree ESLint, affected-file formatting and `git diff --check` passed. A separate bounded source audit found no concrete blockers in the new prompt, admission or error-state paths.

## Limits and delivery

This does not measure total process/ORT/GPU peak memory or guarantee execution under arbitrary OS pressure. The broad runtime reserve and many-plane temporal attention remain substantial; no measured runtime speedup is claimed. The live test deliberately stopped before a full learned correction to preserve the user's saved draft. Broader full-corpus anatomical acceptance and prior native-correction gates remain open, as documented in the existing segmentation acceptance plan. The existing large-bundle build warning remains. No commit, push or merge is performed by this task.

## Follow-up: the 6,734 MiB warning

The later reported 6,734 MiB rejection is a separate case, not the previously measured 3,260.7 MiB case above. Its expanded ownership breakdown has not been retrieved: the Chrome connection inventories tabs but repeatedly times out when attaching. No browser was restarted, closed, or replaced. The user was asked for the expanded breakdown and permission for the documented temporary-window connection recovery. The current primary browser and imported database remain untouched.

The first repair fixed prompt grouping but left a structural cost: every marked section contributes a spatial memory to every subsequent section's attention. Changing the last editing plane can greatly increase the number of occupied marked sections without adding many literal marks. In the saved correction used below, changing planes and adding eleven Remove marks changes the relevant count from two axial sections to twenty-one coronal sections. Native-detail transfer can also increase the categorical footprint. This is evidence for a scaling mechanism, not proof of the unavailable live case's exact composition.

### Architecture decision and falsifier

Required invariants are unchanged native samples/resolution, all literal Add/Remove marks, every marked-section preparation and cached output, unchanged cancellation/publication ownership, and the existing memory safety cap. A lower estimate alone is not success.

The first experiment used the upstream nearest-conditioning selection primitive. All marked sections stayed stored and were prepared; only the conditions consulted by each attention step were limited. Four- and eight-condition variants both failed the predeclared criterion of no worsening of frozen definite-inside/outside sparse-core scores. Both lost 213 of 1,038 definite-inside voxels, with an empty selection on the saved Remove-only correction section and a visible notch in the orthogonal view. Neither variant is accepted. Their production controller changes were reversed exactly to the prior source hash, preserving earlier unrelated pruning fixes.

The replacement experiment splits cross-attention query rows into blocks of 64 while each row still consults **all** keys, values, marked sections and eligible object pointers. Softmax normalizes over keys independently for each query, so splitting query rows preserves the intended mathematical operation. This is different from discarding conditions, splitting softmax across incomplete key sets, reducing native resolution or changing weights. Float32 kernel behavior and optimized buffer lifetimes still require direct tests.

The private derived ONNX graph changes only four `MatMul → Softmax → MatMul` triplets into query slices, the same operations over full keys/values, and row concatenation. All 109 original initializers, 2,601 untouched nodes, graph inputs/outputs, projections, scaling, positional encoding, self-attention and residual/MLP operations are preserved. The official ONNX checker passes both graphs. Static branch order alone is **not** proof of memory reuse: full projected/transformed key/value buffers remain and must be charged in admission.

### Controlled MRI comparison

The experiment uses hash-pinned actual MRI samples, 216 saved Add marks and eleven saved Remove marks, 21 marked coronal sections, and all 105 sections of the saved editor's tracking extent. Both policies use the same 92 × 105 × 121 native regional grid and fixed source range. This is a regional policy comparison, not the original full 80-mm context, whole-acquisition acceptance, or a live-browser run. Raw inputs, support and independently frozen sparse references are not changed to fit predictions.

The original all-conditioning comparator is a controlled counterfactual of the same controller, not a different deployed commit. Serial, one-thread WASM runs use the same pinned graph weights and provider. Timings are observations on a shared machine, not a clean whole-application performance benchmark. Unknown and explicitly uncertain reference areas remain unscored. The baseline already selects 45 of 358 sampled definite-outside voxels, so matching it cannot establish absolute anatomical accuracy.

| Variant | Inside hits / 1,038 | Outside selections / 358 | WASM high-water | Elapsed | Disposition |
| --- | ---: | ---: | ---: | ---: | --- |
| Original all-conditioning | 1,038 | 45 | 506.75 MiB | 429.24 s | Comparator, not anatomical ground truth |
| Nearest four conditions | 825 | 19 | 293.19 MiB | 250.36 s | Rejected: lost required coverage |
| Nearest eight conditions | 825 | 21 | 351.88 MiB | 375.01 s | Rejected: same coverage loss |
| All conditions, exact 64-query blocks | 1,038 | 45 | 351.88 MiB | 488.32 s | Accepted for memory reduction with exact output preservation |

All three preserve literal hard marks after the production hard-mark/connectivity postprocessing; this is necessary but insufficient to preserve the intervening object. Axial, coronal and sagittal source/baseline/four-condition rasters were individually inspected at original resolution and immediately reported. These scientific rasters are not app screenshots. No browser resources were opened for this artifact batch.

Private evidence remains ignored under `frontend/tmp/segmentation-golden/bounded-conditioning-20260831/`. Graph derivation and probes are under `frontend/tmp/segmentation-golden/validation-20260830/exact-query-chunks-v1/`. The first 21-section-equivalent synthetic graph probe produced byte-identical 262,144-element Float32 output, with observed WASM high-water reduced from 335.50 to 257.00 MiB. A 140-section-equivalent query-blocked graph probe completed twice with finite, repeatable output at 1,257.75 MiB WASM high-water. These are graph-only probes, not MRI, total process memory or browser admission measurements.

The complete query-blocked MRI run produced **byte-identical raw and final binary masks** to the all-conditioning baseline, not merely equal sparse scores. All 227 hard marks and 105 output sections are retained, with the same graph-call counts and full 27,792-token peak attention input. Final selected-voxel count is 96,779 in both runs. This validates the all-conditioning path without relying on the rejected nearest-section approximations.

Observed MRI-run WASM high-water fell 30.56%, from 506.75 to 351.875 MiB. Node maximum RSS fell from 1,321,200 to 1,118,224 KiB. The candidate took 13.8% longer in this shared-machine run; **no speedup is claimed**. All three current axial/coronal/sagittal comparison rasters were individually inspected at original resolution, immediately reported, and passed only the output-preservation criterion. The visible baseline extensions remain unchanged; no anatomical acceptance is inferred. No browser resources were opened for either scientific-raster batch, and no user browser or database was closed, restarted or written by these experiments.

### Final implementation and admission

The shipped model is `efficienttam-tiny512-onnx-v2`, under `models/efficienttam-tiny512-v2`. The original v1 files are preserved privately outside `public/`; there is only one shipped eight-file model bundle. The new attention graph adds 60,973 bytes. Its exact source/output hashes and query dimensions are bound in the manifest and deterministic derivation script. Other model graphs, positional constants and original weights are unchanged. Attribution explicitly records the modification. The existing `model-id:asset-hash` cache identity prevents old attention bytes from satisfying the new model request.

The controller is restored to its exact pre-experiment source (`1d656076…`); it still uses every conditioning section. There is no nearest-section mode, fallback classifier, new worker protocol, change to hard-mark enforcement, or new approximate reconstruction. Cancellation still terminates the owned worker, and publication still waits for the complete result and existing owner checks.

Admission derives its attention workspace from the same manifest contract: 64 query rows, four layers, one head, 256 projected channels, and a six-buffer projection allowance. The combined allowance is **8,192 bytes per memory token**. It includes all-layer score/softmax blocks plus full-key projection/rotary workspace; these are operational allowances, not claims that those tensors peak simultaneously. Graph-order liveness including retained WASM input copies reaches approximately 6.52 full projected buffers on the large probe. The combined eight-buffer allowance and unchanged 1,024 MiB fixed runtime reserve leave headroom. Optimizer ordering, arena reuse and process pressure prevent treating this as a universal guaranteed peak; revalidate if the graph, provider or scheduling changes.

All marked-section native/low-logit/memory/pointer state, full packed inputs, literal-mark scratch, native source/display owners and publication scratch remain charged. No count is capped or discarded. The source, tracking and publication phase maximum and 3,072 MiB application cap are unchanged. Synthetic same-input regression examples are:

- 140 conditioned sections and 4,480 literal marks: old estimate rounds to 6,335 MiB; new estimate is 2,816.398 MiB, displayed as **2,817 MiB**, and admits.
- 512 conditioned sections and 16,384 marks: new estimate remains **6,123 MiB**, and correctly rejects. Query blocking does not make arbitrarily large retained state or full-key buffers free.

Neither example is the unavailable 6,734 MiB browser state. The separate limited-source-region warning is also unchanged: lower computation cost does not establish that an existing suggested selection covers the full source anatomy.

### Reproducibility repair and final verification

A fresh full export exposed an existing host-dependent encoder bug. The pinned upstream implementation checks `torch.mps.is_available()` to choose absolute-position interpolation, even when this exporter explicitly builds a CPU model. On this Mac it exported `linear` instead of the approved `cubic`; all other files matched. The integrity guard correctly failed without changing pins. The failed export is preserved.

The exporter now scopes the MPS availability probe to false only during CPU construction/export and restores the exact original callable on success or failure. No upstream file or encoder graph is rewritten, and no approved pin is relaxed. A second complete export from the original checkpoint reproduced **all eight approved v2 files byte-for-byte**. Seventeen standard-library exporter tests cover source/output guards, positive-MPS hosts, nested scopes, exceptions, restoration and checked derivation.

Final verification: **3,122 Vitest tests passed, zero failed, 54 opt-in tests skipped** (3,176 total); whole-tree ESLint, affected-file formatting, TypeScript/production build and `git diff --check` passed. The production build and fresh export independently pass the eight-file/hash/size allowlist. The running preview serves the exact new attention hash over HTTP 200. The existing large-JavaScript-bundle build warning remains.

The Node four-thread diagnostic could not initialize its WASM backend (`fetch failed`), so the numerical and memory measurements here are explicitly one-thread WASM, not four-thread/browser measurements. The existing Chrome tab-attachment failure still prevents reading and rerunning the user's exact 6,734 MiB case. No primary browser was stopped to work around it. Live-browser admission under that exact ownership snapshot, full-native/full-corpus anatomy and browser performance remain unverified. No commit, push or merge was performed.

Final private evidence index: `frontend/tmp/segmentation-golden/validation-20260830/exact-query-chunks-v1/final-receipt.json`, with the MRI outputs/comparisons in the regional run directory above, `full-tests-v2.json`, `build-v2.log`, and `production-export-v2-cpu.log`. All MRI media, masks and correction snapshots remain local and ignored.
