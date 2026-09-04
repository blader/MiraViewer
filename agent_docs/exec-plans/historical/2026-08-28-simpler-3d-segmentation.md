# Simpler, source-aware 3D segmentation

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

## Retained implementation

This pass simplifies editing and improves its runtime, memory ownership, cancellation, and persistence. It does **not** ship a new boundary-classification model: the attempted replacements failed fixed accuracy checks. The original spatial competition remains, with output-preserving scratch reuse and lifecycle improvements. Automatic masks still need review and occasional Remove corrections.

The user-facing path is **Select tissue → Add / Remove → Done**, with Auto-fill after completed strokes. A native-overview-only **Use original detail** action brings the existing original-grid loading operation into the editing workflow rather than hiding it among window/level settings. It is not generated super-resolution, and transferred selections remain drafts for review.

Full regression and frozen-corpus equivalence checks passed; exact results and remaining gaps are recorded below. Live browser/GPU inspection is unavailable in this session; source-level MRI review is explicitly separate. No claim of improved automatic tumor-boundary accuracy is made.

## Contract

Make selecting a region in MiraViewer easier and improve its first boundary draft. The user should be able to paint what to keep, remove spillover, inspect the three linked MRI views, and finish. Explicit marks, source geometry, missing-data support, undo/redo, existing saved selections, original MRI texture, and the earlier Sharp slices implementation must remain intact.

This is an interactive engineering selection, not automatic tumor diagnosis. The supplied MRI corpus has no expert-annotated 3D tumor masks. Neither a plausible contour, a synthetic Dice score, nor a few manually chosen landmarks establishes clinical accuracy.

## Governing authority

- The acquired volume and its physical geometry own image values and support. The solver never writes source data or synthesizes MRI texture.
- Explicit Add/Remove marks own the corresponding voxels. Automatic proposals may change only unmarked tissue; publication also reapplies these constraints.
- Marks and returned proposals share the same finite, acquired-tissue predicate at publication. A malformed proposal cannot select NaN, infinity, missing support, or an out-of-range voxel.
- `useSvrSelection` owns edits, cancellation, and reversible history. Automatic work is initiated by an actual stroke, not by hydration, navigation, rendering, or undo.
- IndexedDB transactions own ordering and durable completion across viewer mounts. A component-local save queue is not a persistence boundary.
- The user explicitly finishes review. A computed boundary remains a draft.

## Findings and architectural checkpoint

### Segmentation

The original solver is a six-neighbor shortest-path partition. Both classes pay the same local squared-gradient cost plus physical path length. It does not compare the proposed tissue with the appearance of the user's marks. Interior texture accumulates cost; weak transitions and distance from the outer search shell can dominate the result.

The automatic negative seeds also start at the acquired exterior. In an MRI with acquired air surrounding the head, a strong air/tissue transition can prevent the negative class from competing inside the anatomy. An independently defined synthetic lesion then produces an almost whole-head selection.

The initial tests largely used sharply bounded objects within uniform tissue. They exercised marks, geometry, support, and several shape cases, but did not expose the air-entry failure or enough partial-volume boundaries.

Material alternatives evaluated:

1. Keep the original accumulated-gradient competition. Retains its good hard-mark behavior but does not address the demonstrated appearance/context failures.
2. Edge-bottleneck propagation. Regressed the textured/weak-boundary experiment; not selected.
3. Two independent appearance-aware paths. Improved every explicit-outside-mark case in the initial 16-case experiment. Separate distances are required: a single winning-label field is not a valid optimizer for class-dependent path costs.
4. Implicit context appearance plus soft negative sources. Addresses the air-entry failure without requiring a Remove stroke or inventing a fixed tumor radius. Initial variants underselected some textured partial-volume rims, so this is not accepted merely because the whole-head failure improves.

The adoption gate is retained source fidelity across noisy, weak, dark, heterogeneous/cystic, anisotropic, large, tiny, and air-surrounded fixtures, followed by a frozen real-MRI comparison. An algorithm that improves a proxy while visibly erasing intended tissue fails that gate. Unsupported voxels and explicit-mark violations are always failures.

### Reopened algorithm gate: appearance is not membership

The first full-corpus appearance-aware candidate was rejected, despite passing every existing synthetic quality threshold. Its SHA-256 was `fc6cd4ad9886a50b331353a689fe304c0a89baa9a138d4d140c1fe324f3cc6f7`. The previous `ce78818…` experiment was already rejected for losing unmarked appearances; adding a uniform-null test repaired that synthetic failure but did not establish the model's validity on the later examinations.

| Frozen two-stroke case | Original selected voxels | Rejected candidate | Held-out inside voxels retained, original → candidate |
| ---------------------- | -----------------------: | -----------------: | ----------------------------------------------------: |
| E1                     |                   91,390 |             67,718 |                                         84/84 → 84/84 |
| E2                     |                   54,623 |             21,879 |                                         20/20 → 10/20 |
| E3                     |                   49,867 |              5,973 |                                         20/20 → 16/20 |
| E4                     |                   75,483 |              4,460 |                                          20/20 → 9/20 |

These are not full-boundary accuracy scores. The E1 contour visibly improved and excluded all 45 evaluation-only near-boundary outside voxels, but E3 visibly fragmented the intended heterogeneous structure. One-pixel mark stability also deteriorated on E3 and E4. Supplying explicit outside marks restored the sparse inside probes yet enlarged E4's result from 45,026 to 267,791 voxels. All runs preserved hard marks, acquired support, and source bytes; those invariants alone do not prove a useful selection.

Architecture checkpoint before another implementation:

- **Failed outcome:** later-date interiors are erased while a synthetic suite and sparse outside probes look better. Source/contour/binary-mask sheets corroborate the failure.
- **Required invariants:** all prior hard-mark, geometry, support, cancellation, history, and source-fidelity contracts remain. The target includes heterogeneous interior, not only tissue resembling its brightest part.
- **Implicated assumption:** counts of brush samples are treated as representative tissue prevalence. Common unmarked appearances become negative evidence and can also change path costs throughout the entire region. A user marking an appearance does not authorize discarding it because it is common elsewhere.
- **Classification:** structural mismatch in the label model, not a reason to relax tests or tune to one date.
- **Alternatives:** a globally regularized conditional-field/random-walker formulation could couple the boundary more strongly, but introduces a larger numerical solver and still needs justified negative evidence. A smaller alternative keeps symmetric physical edge costs and uses appearance only to propose conservative outside starting points; marked appearances are exemplars rather than prevalence estimates.
- **Decision:** suspend adoption of the density-weighted path model. First inspect the actual mark/held-out intensity distributions, then test the smaller alternative against the same frozen cases.
- **Falsifier:** any repeat of the later-date interior loss, explicit-correction explosion, or existing synthetic accuracy regression rejects that alternative too. No new patient-specific thresholds, altered marks, or weakened oracles.
- **Retained work:** the simpler editor, synchronous history authority, persistence ordering, worker pacing, and corpus harness do not depend on accepting the rejected solver.

The smaller exemplar/symmetric-path experiment (`e5292fd5…`) repaired the demonstrated interior loss on all three later dates and made all explicitly corrected masks byte-identical to the original solver. It still leaked into adjacent tissue and failed the frozen weak-boundary and air-surrounded synthetic cases. Adding symmetric exemplar-gradient edges (`b3f5f556…`) improved some weak-boundary measurements but regressed textured and air-surrounded cases. Both remain private rejected experiments, not user-facing replacements.

The second architectural checkpoint identified a stronger causal problem: an inferred outside start with cost `foregroundDistance × affinity / (1 − affinity)` always beats the optimal foreground path when the affinity is below one half. Calling that start “soft” does not make its classification overridable by surrounding tissue. Changing the appearance histogram or sharpening its gradient cannot fix that authority mistake.

The final bounded proof used a spatially coupled field: explicit user marks stayed fixed, while inferred evidence was a finite contribution that surrounding tissue could outweigh. The screened harmonic formulation (`6ab8691b…`) converged numerically in all 20 tested fixtures and repaired the common-gray example, but failed 15 unchanged quality criteria. Weak-boundary inside-only recall fell to 0.402/0.462, and air-surrounded Dice was 0.381. Convergence was not accuracy. The proof stopped before a large-domain or native-MRI run; no further parameter search or replacement was promoted.

The failed accuracy targets remain intact in `frontend/tests/segmentationCandidateGates.test.ts`. They require an explicit candidate file and matching SHA-256. An enabled bad candidate genuinely fails the command; they are not expected-failure assertions or relaxed default tests. The retained baseline does not meet these proposed replacement-certification targets, so a passing ordinary regression suite must not be described as certification of tumor accuracy.

The default suite separately retains the generic common-gray characterization, including its residual rim false positives. Source-specific MRI masks and experimental implementations remain local. A larger neural-model integration is not part of this task.

### Editing experience

The old workflow separately exposed marks, suggestion, confirmation, and returning to 3D. A proposal could also arrive during another unfinished stroke; a stroke could outlive the label revision on which it started.

Implemented workflow:

- **Add / Remove / Browse**. Entering an editable selection activates Add.
- **Auto-fill** is initially on and waits 350 ms after a completed stroke. Rapid strokes replace the queued request. An explicit re-enable can update an existing draft; merely reopening it cannot.
- **Done** replaces competing suggestion/confirmation/navigation actions. It cannot finish during queued or running work.
- **Stop** cancels automatic work and switches to brush-only editing. Turning Auto-fill off makes edits exact, direct brush edits.
- A stroke and its automatic proposal are one undo step. Distinct strokes remain distinct history entries. Undo/redo do not trigger another automatic calculation.
- New paint pointer-down cancels older work before it can invalidate the new stroke. Label changes and lost pointer capture cancel unfinished painting, while ordinary browsing remains usable.
- Read-only, loading, and reconstruction states cannot submit suggestions through disabled controls.

The design retains the existing quiet palette and typography rather than introducing a separate visual language. MRI views retain their physical aspect ratio; fill remains restrained so the source texture is visible. Advanced window/level controls and non-native refinement remain in Slice settings.

Native overview sampling is now called out directly while editing a coarser native-source volume. Once a region exists, **Use original detail** invokes the existing bounded native-copy operation with the current labels. The action disappears at original sampling, is blocked during computation/read-only/loading states, and is not duplicated in advanced settings. The existing non-native reconstruction refinement stays in Slice settings. No automatic reconstruction, new review bypass, or hidden selection rewrite was added.

### Persistence

The viewer formerly delayed writes in a per-component promise chain. A newly mounted viewer could read before the previous component submitted its last queued write.

The new local API begins an IndexedDB transaction immediately after opening the database. Patient checking and label writing share one read/write transaction. Reads obtain labels and patient context in one read transaction. The viewer submits completed edits directly and lets transactions finish after unmount. No global mirror, cache, or second save ledger was added.

### Interactive work and memory

The worker yields according to elapsed work (approximately every 8 ms at existing cancellation checkpoints), not after every inexpensive scan chunk. Intermediate progress is limited to 20 updates per second; completion is always forwarded. This avoids unnecessary browser timers without changing any image value or segmentation decision. Worker identity and abort checks still reject superseded output.

Review also exposed an unbounded copy: the client sent the entire native volume and support backing buffers to the selection worker even when the solver used at most two million voxels. The corrected wrapper transfers only an owned copy of that exact native-grid domain, translating marks and returned indices while preserving physical spacing. Source/support transfer is capped at 10,000,000 bytes under the existing domain limit. Caller MRI arrays and marks are never detached. Tests compare the real solver on original and offset cropped domains, including anisotropic spacing and support holes, and require byte-identical output. This bounds the extra source copy; it does not establish a total-application memory guarantee or justify lowering the native source resolution.

The retained solver also reuses its future heap buffer for the earlier exterior flood and its label byte for missing-exterior visitation. Those phases do not overlap. This removes two typed-array allocations totaling five bytes per domain voxel—10,000,000 bytes at the cap—without changing seeds, path costs, normalization, tie-breaking, or selected geometry. This is allocation accounting, not a measured browser peak-memory or latency claim. Cancellation is checked immediately after yields, and even a small job reports terminal progress before publication.

## Evidence and privacy

All MRI source data, private masks, annotated images, and fitted per-request appearance data stay local. The resident corpus under `Critical MRI Source Images (LLM Agent - do not delete)` is read-only. Desktop FileProvider discovery/hydration is deliberately not repeated.

Private evidence directory: `frontend/tmp/segmentation-accuracy/` (ignored). Baseline core SHA-256: `8cc742ba8be8fb5d298f94e6281894f292ea192ce4f22ea6fb6d58e740a2dd2a`.

Retained core SHA-256: `7b3b946d874767825266be2e4796b6fc968e91576995447e7a8582284ad65a46`. The original core tests remain unchanged. The earlier Sharp slices source hashes and unrelated fixture generator were rechecked and preserved.

### Real-data validation design

- Four anonymized examinations, one patient. Axial stacks are available on all four dates; the first examination also has coronal and sagittal source series. Reformats must not be reported as independent acquisitions.
- Native source-grid crop around the visible central structure, approximately 80 mm in-plane and 51 axial slices. No downsampling or inverse reconstruction is used to make this test cheaper.
- Mark positions are chosen from source-only images before candidate masks are viewed. Both bright and darker parts of the central structure are represented on later dates.
- Inside-only, optional outside corrections, reduced mark coverage, and one-native-pixel mark shifts exercise the real algorithm.
- Source hashes, hard-mark preservation, acquired support, sparse held-out landmark coverage, selection extent, and perturbation overlap are measured. The latter are engineering diagnostics, not clinical Dice.
- Source/contour/binary-mask sheets are inspected individually at original resolution. Different intensity windows must be stated; comparisons use the same source window within an examination.

The first E1 baseline selected all 84 distant inside anchors and none of 168 distant outside anchors, yet visibly included a darker collar around the upper bright region on all three inspected slices. The sparse metric alone would have missed the failure. Additional evaluation-only near-boundary probes were therefore frozen: the inside-only baseline selected 45/45 outside-probe voxels, while the explicitly corrected baseline selected 0/45. These probes are never supplied to the solver.

### Final native-source results

Each crop contains `187 × 187 × 51 = 1,783,419` original-grid voxels, approximately `0.430 × 0.430 × 1.000 mm`. Four fixed mark variants were run on each of four examinations. Every final mask is byte-identical to its frozen original-solver mask; source and support fingerprints, explicit marks, geometry, and error contracts also match.

| Examination | Two inside strokes | With outside corrections | Upper stroke only | One-pixel inside shift |
| ----------- | -----------------: | -----------------------: | ----------------: | ---------------------: |
| E1          |             91,390 |                   76,278 |            87,497 |                 91,612 |
| E2          |             54,623 |                   35,749 |            18,626 |                 55,905 |
| E3          |             49,867 |                   29,459 |            19,489 |                 49,946 |
| E4          |             75,483 |                   45,026 |            44,332 |                 70,868 |

Cells are selected voxel counts, not accuracy scores. The reduced-mark results demonstrate that the existing solver still depends substantially on mark coverage. Outside corrections remove the tested sparse outside probes, but do not establish a correct complete boundary.

Native solver CPU times across the 16 runs were **0.962–1.137 seconds**, median **1.061 seconds**. These are direct solver timings, not browser interaction, decoding, worker transfer, GPU upload, or end-to-end latency. No comparable speedup or measured peak-memory gain is claimed. Scratch allocation accounting removes **8,917,095 bytes per tested crop**, while the source-copy bound is independent of the full native-volume size.

An independent deterministic equivalence check covered 100 small-domain cases: 80 valid inputs with identical indices, bounds, boundary counts, and domain sizes; 20 invalid inputs with identical error names and messages. Inputs remained unchanged. The root integration pass separately compared all 16 saved mask buffers and checked the final source hash.

Reproduction, from `frontend/`, requires the existing local baseline and frozen private annotations under `tmp/segmentation-accuracy/`:

```sh
MIRAVIEWER_SEGMENTATION_NATIVE_DIR='../Critical MRI Source Images (LLM Agent - do not delete)' \
MIRAVIEWER_SEGMENTATION_NATIVE_EXAMS=1,2,3,4 \
MIRAVIEWER_SEGMENTATION_NATIVE_CANDIDATE=1 \
MIRAVIEWER_SEGMENTATION_NATIVE_EQUIVALENT=1 \
MIRAVIEWER_SEGMENTATION_CANDIDATE_SHA=7b3b946d874767825266be2e4796b6fc968e91576995447e7a8582284ad65a46 \
npm run test -- tests/segmentationNativeCorpus.test.ts --maxWorkers=1 --no-file-parallelism
```

The private `final-equivalence-7b3b946d-tests.json`, `equivalence-fuzz-7b3b946d.json`, and `e1` through `e4-candidate-7b3b946d.json` receipts retain the detailed results. These files and MRI-derived images are not source-control artifacts.

### Source-image review

Canonical images were inspected individually at original resolution, with immediate path-specific reports. The final axial sheet `frontend/tmp/segmentation-accuracy/e3-candidate-7b3b946d-corrected.png` and its `-corrected-orthogonal.png` companion show matching original/current contours and preserved heterogeneous interior texture. The coronal and sagittal sections also reveal remaining protrusions above and below the central structure. These are **non-regression evidence, not an automatic-boundary accuracy pass**. The images are diagnostic comparison sheets, not screenshots of the updated editor; they cannot prove the UI's aesthetics, responsiveness, or GPU rendering.

### Browser boundary

The browser runtime reports no available browser, and the earlier repo-owned capture producer is explicitly disabled after the user's browser-shutdown report. No browser, profile, tab, or session is launched, closed, restarted, or cleaned up for this task. Direct MRI images can validate algorithm output; DOM tests cannot substitute for a live visual UI review. Live-browser UX and GPU-motion validation remain blocked unless an existing browser connection becomes available.

A read-only attempt to discover already-running desktop apps also failed with `Sky Computer Use native pipe startup failed`. It did not launch or operate a browser. This is an unavailable connection, not a claim that the application itself failed.

## Verification ledger

- Full regression: `npm run test -- --maxWorkers=2 --no-file-parallelism` — **1,861 passed, 51 skipped**, 146 passing test files, 140.23 seconds. Skips include private-corpus opt-ins and 22 explicit replacement-candidate certification targets; they are not passing accuracy tests. Existing asynchronous test `act` warnings remain visible and were not suppressed.
- Final editor/viewer/native-workflow/quiet-UI/hook focused checkpoint: **146/146 passed**, including the original-detail action and current-label transfer.
- Final core/wrapper/runtime checkpoint after simplifying the fixed 3D coordinate comparison: **35/35 passed**. No classifier or source-image changes occurred after the full regression run.
- Native MRI plus deterministic equivalence command: **13 runnable tests passed**, including all 16 native mask variants and the 100-case fuzz check. Five appearance/focus-only inspection modes were not enabled for this final run.
- TypeScript project references and Vite production build: passed. Vite still reports the pre-existing large main-bundle warning; this pass does not claim bundle-size optimization.
- ESLint: passed.
- Local React Doctor: **339 files scanned, no issues** with `--no-score`, telemetry disabled, and supply-chain checks disabled. External scoring was not used; this is not a numerical score claim.
- `git diff --check`: passed. MRI source and derived-evidence ignore rules verified. No MRI data was added to version control or uploaded.
- Existing preview responds on `http://localhost:43124/` and serves the new selection controls. This HTTP/source check is not live visual validation. No browser was launched, closed, or restarted.
- **Still blocked:** live editor visual/interaction inspection and representative browser/GPU performance. The absence of an accessible browser connection is not concealed by DOM tests or saved MRI images.
- **Not achieved:** a replacement automatic classifier with demonstrated improved accuracy. Every attempted replacement failed a frozen quality gate and was excluded from production.

## Next accuracy milestone

1. **Define and freeze the intended tissue boundary.** The user-facing tool can select arbitrary tissue, but an accuracy benchmark needs an explicit rule for mixed-intensity interior, surrounding tissue, and separate foci. Obtain reviewed 3D labels for representative native regions; sparse engineering landmarks remain useful failure detectors, not substitutes for complete labels.
2. **Separate development from held-out evaluation.** Freeze examinations, marks, perturbations, and targets before tuning. Add independent patients and acquisition patterns when authorized; several dates from one patient do not establish broad generalization. Keep the source data and labels private.
3. **Evaluate a genuinely different source of boundary information.** Do not continue replacing histogram formulas on the same failed implicit-outside assumption. Compare an explicit cross-plane contour-guided method and an interactive trained segmentation model as bounded prototypes. A trained model would require separate compatibility, licensing, local execution, memory, and source-fidelity evaluation; no model is installed or represented as clinically validated here.
4. **Keep correction simple.** Both prototypes must fit the current Add / Remove / Done workflow, preserve every explicit mark, remain undoable, and let a user browse or stop computation immediately. Any uncertainty display must help review actual boundary locations rather than add another settings panel.
5. **Require the frozen quality gates.** Preserve the existing 22 synthetic certification targets, native interior/support/hard-mark constraints, perturbation checks, and multi-plane visual review. Add whole-mask overlap, boundary-distance measurements in millimeters, and correction-effort measurements against the reviewed labels. Predeclare thresholds before evaluating a candidate; do not weaken them to promote a preferred method.
6. **Measure the actual browser outcome before adoption.** On the same frozen native regions, record cold/warm stroke-to-preview latency, cancellation, peak memory, and review-to-save correctness using an accessible existing session or a separately authorized isolated browser. Adopt only after both accuracy and interaction gates pass. The current runtime simplifications are useful independently and need not be replaced.

## Reference

The distinction between editable seed marks, automatic preview, and explicit review is also used in [3D Slicer's Segment Editor](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html#grow-from-seeds). This is workflow context, not a claim that MiraViewer implements Slicer's GrowCut or has equivalent validation.

The architectural alternatives have established formulations: [Grady's random-walker segmentation paper](https://pubmed.ncbi.nlm.nih.gov/17063682/) and [Criminisi, Sharp, and Blake's GeoS paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Criminisi_eccv2008.pdf). Their results do not establish MiraViewer's accuracy or performance; this task's decision is governed by its own frozen source tests and visual evidence.
