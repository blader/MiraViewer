# Segmentation acceptance: current evidence and next experiment

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

## Objective and authority

Create visually grounded golden evaluations and make the real segmentation workflow work across the supplied MRI corpus. A good central section, model-port parity, passing synthetic tests, or a merged PR does not by itself establish a coherent editable 3D result.

The previous goal turn made verified progress: PR #10 merged, with its final tested tree preserved. This continuation starts from that tree, merge commit `5f0efa433b6c8b6672add9a30184ec1140b2b5a3`; new local branch: `blader/siqi-chen/segmentation-sampled-plane-pruning`.

Hard constraints remain: acquired samples and literal Add/Remove marks are authoritative; no private MRI, labels, screenshots or receipts are published; no primary-browser restart; no budget increase, silent classifier fallback, or partial-result publication. Independent anatomy, user-endorsed examples and output/lifecycle regressions remain separate authorities. The historical yellow reference set is quarantined, not silently promoted or replaced with the model output being tested.

## Coverage audit

| Case | Retained evidence | Missing acceptance |
| --- | --- | --- |
| E1 stored axial reformat | User endorsed the earlier EDGE1 AX102 example | Does not accept a different model or its whole volume |
| E1 original sagittal acquisition | Completed actual-editor prediction; source-only AX233/COR244/SAG151 sparse cores; undo/redo/reopen; matched display correction | Genuine learned correction; unresolved neighboring-region membership; native-grid boundary detail |
| E2 | Real-editor one-thread prediction, exact connected-mask pruning, browsing, cancellation, history and reload | Full 3D independent anatomical acceptance; actual learned correction rather than brush-only correction |
| E3 | User endorsed tiny512 AX96; native/Torch/web-WASM output parity across the frozen 63-plane context | Full-acquisition/editor outcome and unresolved extent beyond the approved section |
| E4 | Unchanged-model 65-plane proposal, inspected sections and saved-output geometry replay | Actual browser/editor model execution, full-acquisition outcome and correction quality |

The six historical polygon files cover 22 sections, but none currently satisfies the independent-anatomy admission contract with classification and pinned review evidence. E2/E4 are no longer untouched holdouts. Clinical labels are unavailable; no clinical-accuracy claim is intended.

The source metadata manifests already contain SHA-256 identities. Do not hash those identifiers a second time. Live study-date and series identities were matched to the saved pins before case admission. E1 is the oldest examination with original AX/COR/SAG sources; July is E4, not E1. An early July screenshot with `e1` in its filename is expressly excluded below.

## Source-review batch

Private artifacts: `frontend/tmp/segmentation-golden/validation-20260830/`. Real app: `http://localhost:43124/`, existing headed Chrome, primary PID 62569. The owned tab was `1997584324`. No annotation was painted, removed or predicted in this batch.

- E2's saved selection reopened in the current editor. The unscaled sagittal source crop shows complete anatomy with readable thin contours, heterogeneous interior and a stepped overview boundary. The 3D mode comparison confirms that Overlay displays the full MRI sheet, whereas Selection only isolates the target; the isolated preview remains soft and stepped. These are display observations, not independent anatomical acceptance.
- E1's correct original acquisition opened through the normal UI: original sagittal stack, canonical native grid 300×512×512, overview 300×256×256 at approximately 0.60×0.86×0.86 mm. The initial presumed AX232 correspondence was corrected by the later live geometry readback below: overview AX117 actually samples native AX233. This is not the stored axial reformat used by the earlier positive example.
- The E1 default display window clipped the central bright region to white. A source-only adjustment through the UI changed width/level from 668.1125/320.0725 to 1270.9675/633.93, exposing internal variation without changing acquired/model samples. The settled source is `e1-original-ax117-frozen-source.png`. This is a reproducible source-view setting, not a tuned classifier input or a newly accepted full boundary.

### Inspection integrity

Two inspection problems were caught before implementation:

1. The large whole-editor image appeared to have an opaque sagittal cutoff in the model's image display. The canonical file contained the missing tissue. Judgments from that large-image path were reopened; independently inspected, unscaled single-panel crops are the valid evidence. No product fix was made for the nonexistent cutoff.
2. The direct browser `clip` capture of the July source was geometrically inconsistent with its full-viewport capture and canvas geometry. `e1-ax102-source.png` is both misnamed (E4) and excluded from geometry evaluation. Full-viewport capture followed by a local unscaled crop produced a valid source image. Do not use direct clipped captures for verdicts without independent pixel validation.

The user's viewport height changed during the batch; final captures record the actual dimensions rather than assuming the original framing. Comparison artifacts must use actual source rectangles and no stretching. No viewport override was applied. Each verdict-bearing crop/comparison was inspected alone at original detail and immediately reported.

Cleanup is closed: no owned or stale-owned tab remains; Chrome and the original server remain live. The original E2 examination and 3D mode were restored. Seven of nine initial unrelated tabs remained at closeout; the other two were never targeted by any agent action. No claim is made that external browser activity stayed frozen. The private batch receipt preserves the exact ownership IDs, exclusions and closeout.

## Next algorithm experiment: sampled editing-plane separators

### Causal gap

The current optimization requires a unit tracking-axis stride, so E1's coarse axial overview disables it and requests all 512 native tracking planes. That restriction is stronger than the final mask contract requires. The required separator is an empty **editing** section, not every empty native frame.

### Smallest change and invariant

Retain the existing exact integer signed-permutation lattice, phase/drift checks, complete finite/support validation, one actual marked plane, hard marks, consumed acknowledgements, directional history isolation and final 26-connected-component authority. Remove only the unit-stride restriction.

For `nativeFrame = phase + stride × editingSection`, a candidate is eligible only when its inverse section index is an in-range integer. Every sampled voxel of that editing section must use the fully observed current native frame and be zero after support/literal-mark policy. Every 26-connected editing-grid path to the far side must cross that empty section, regardless of the nonzero integer stride. An empty **unsampled** native frame still cannot stop anything; `[1,0,1]` sampled as `[1,1]` remains the explicit counterexample.

Raw proposal coverage may differ; the final hard-marked connected selection must not. Unknown raw counts remain unknown, `contextLimited` remains explicit, and raw/default consumers retain full traversal.

### Forecast and falsifiers

Expect fewer model calls on E1 while retaining the exact final marked-component mask under full-versus-pruned replay. Do not forecast a wall-time speedup from call counts alone. Reject the change for any changed connected voxel, lost literal mark, stopped unsampled gap, hidden future invalid source, accepted spoofed coverage, cancellation leak or altered source samples.

Validation order: red regressions on the unchanged implementation; minimal production edit; focused equivalence/safety tests; actual E1 source/mark/prediction capture; then native multi-plane review and a genuine learned correction. The next holistic checkpoint is the first complete real-editor result, not another synthetic pass count.

## Completed sampled-stride experiment and E1 editor result

The production change removes only the unit tracking-stride restriction. All 87 focused interactive-selection tests pass. The red run exposed the expected eligibility failures; a subsequent 24-case immutability-assertion failure was independently reproduced **before inference** and traced to `structuredClone` returning cross-realm typed arrays. Same-realm `.slice()` snapshots fix the assertion without weakening the final whole-mark immutability comparison.

The frozen private E3 saved-output replay covers exact phase-1 strides 2 and 3. Delivered frames fell from 64 to 45 while final connected masks remained byte-identical (19,579 and 13,124 selected voxels); all 103 active Add marks and the previously endorsed 1,520-pixel anchor remained intact. The real saved empty native frame24 is unsampled and correctly does not stop either traversal; sampled empty frame19 does. This is transport/geometry replay, not new model inference, anatomical acceptance or a wall-time benchmark. Baseline receipt SHA: `a1d47302a7130600403b4be5d4642936d13e292b8fecb84c77a1d95103aa90ac`; candidate: `e3eeee8ea2f740363fa8d38f6ebc635bbaea5a47cf15b08611345c436627e597`.

The fresh **actual E1 browser run** completed in owned tab1997584387, using the original SAG acquisition and two source-guided Add clicks. It retained the full 512-native-section tracking context and fixed raw intensity range0–1247. Actual delivery was102 frames instead of the full traversal's513; certified endpoints were forward287 and reverse187. The unchanged one-thread WASM model phase took705.127 seconds (about11m45s) on the shared host. This remains too slow for comfortable interaction; do not convert work-count savings into an unmeasured wall-time speedup. The worker returned completion and terminated.

The saved draft has24,656 selected voxels, mask SHA `6d23f0f8ea929819cd236688d01de6a69c226ed20ebb652a0bf963495ac6221f`, all54 literal Add voxels intact, no Remove marks and no nonbinary values. Undo restored exactly54 marked voxels; redo restored the identical mask and mark hashes with no second model run. It remains explicitly unreviewed and context-limited.

### Correct native correspondence and independent sparse references

Production patient-coordinate transforms, applied to the actual stored editing geometry and pinned native geometry, measured phase[0,0,1] and stride[1,2,2] with errors below1e-13. Thus UI AX117→native233, COR123→native244 and SAG152→native151. Earlier native AX232/COR245 references cannot be silently snapped onto those samples.

The source-only lane exported new AX233/COR244 sections without viewing predictions. Root independently inspected the raw sections and all three outlined sparse-patch images, then froze `e1-source-review-20260830/root-sparse-adjudication.md` **before inspecting the fresh prediction**. Only small inset inside cores and separated lateral outside patches are accepted for the explicitly selected main bright body. The rounded neighbor, heterogeneous connection, lower margins and all unlisted voxels remain unknown; explicit uncertainty from any plane wins across intersections. A question about neighboring-region membership was sent to the user. These are engineering references, not clinical labels or complete anatomical gold.

The new separate test-only sparse evaluator supports exact signed integer sampling, unknown-by-default patches, cross-plane uncertainty precedence, and separate unsampled/acquired-support exclusions. It produces core counts, not contour distances or a whole-mask pass. Its35 synthetic tests and compatibility batch passed (124 passed,3 private opt-ins disabled). It does not bypass existing full-contour admission. Exporting two existing polygon primitives changes the old scorer hash; new sparse receipts must additionally pin the sparse helper itself.

### What the actual images show

- The matched, unscaled axial source/prediction comparison shows a close visible boundary around the marked main body with both marks retained. The rounded adjacent region is unselected. This supports the anchor result only.
- Coronal and sagittal views reveal an additional selected bright focus and a small fragment beyond the admitted core reference. Their complete membership remains unresolved; no whole-volume acceptance was granted.
- The3D preview fails the requested detail-review experience: Overlay is dominated by the full MRI sheet; Selection only isolates/enlarges the target but presents an opaque white, jagged cut plane over a soft-looking volume. The canonical small-panel images and matched comparison contain these defects; this is not the earlier large-image inspection corruption.

Canonical private evidence is in `frontend/tmp/segmentation-golden/validation-20260830/`, including `e1-live-axial-source-prediction-comparison.png`, `e1-live-coronal.png`, `e1-live-sagittal.png`, `e1-live-3d-mode-comparison.png`, the authoritative saved mask/state, exact native mapping, completed worker observation and batch receipt. Each judged image was inspected alone at original detail and immediately reported.

Cleanup closed: the owned tab and observer were removed, owned/stale-owned tab lists are empty, primary Chrome PID62569 and servers51292/77460 remain live. E2-only3D view was restored, while the new E1 draft remains saved. One unrelated external tab disappeared during the batch; it was never targeted. The user's viewport height changed externally; comparisons use actual equal framing, never stretched screenshots.

## Completed sparse evaluation and display ownership correction

The pinned E1 sparse evaluation found all **383/383 independently admitted inside samples** selected and **0/180 outside samples** selected. All three planes contribute, with global deduplication and explicit uncertainty precedence. There were 934 unsampled reference centers, not misses; 24,273 selected voxels remain anatomically unassessed. This is sparse-core consistency, not a full contour or whole-volume accuracy score. Root independently rehashed all 42 receipt bindings without a mismatch. Private receipt: `validation-20260830/sparse-core-evaluation/e1-v1/receipt.json`, SHA `0a5689f281a9039762cc206480950753a4d3b82fc9621cc7783614fe4e941489`.

Baseline batch 32 confirmed two window owners: changing the editor to width/level 1280.29/643.2525 left the native plane near 668/320.5. The latter clips real bright source cores. The fix reuses the existing volume window for its own primary native source; independent sources keep their own raw-unit window. Native defaults/reset use the measured loaded intensity range without changing the declared DICOM VOI, source samples, model inputs or annotations. No synchronization effect or new display mode was added.

Candidate batch 33 confirmed bidirectional control changes and both resets, plus independent-source override preservation after loading. The matched unscaled comparison `e1-shared-window-matched-comparison.png` uses equal 3454×1419 source captures and the same volume width/level. It reveals grayscale cut-surface texture where the old rendering was flat white. The calm controls and typography remain consistent, but the opaque cut surface, stepped boundary and soft volume still fail the requested overall detail-review experience. This does not establish an anatomical improvement.

The authoritative mask and mark hashes remain identical to the completed E1 result, all 54 inside marks remain selected, and the observer recorded zero inference jobs during the display checks. Both browser batches are closed: current/stale-owned tab sets empty, no original external tab missing, primary Chrome and both servers preserved. E2-only 3D view and the closed examination sidebar were restored. One independent-source loading transient shows placeholder slider bounds before pixels arrive; the settled override is correct, so this is a loading-state UX observation rather than lost saved contrast.

## Next algorithm checkpoint: multi-plane corrections

The tests-only baseline has 247 cases: 208 pass and 39 expected failures. Existing single-plane behavior remains green. New cases cover mirrored distant Add marks, negative-only outer correction fences, signed/coarse phase grids, exact connected-mask equality, unchanged complete conditioning preparation, final ACK/endpoints, and cancellation cleanup. The explicit counterexample is Add at frames 2 and 8 with an empty frame 3: stopping at 3 loses tissue connected to the future mark at 8, even if that literal voxel is restored afterward.

The bounded production experiment permits an empty editing-section separator only **after unchanged complete conditioning preparation** and strictly beyond every literal Add/Remove frame in that direction. It reuses the existing preparation extrema and acknowledgement protocol. The older E3 replay does not validate this extension; a genuine actual-editor learned correction is the next production-shaped proof. Preparation still spans the marks and may be expensive; no latency claim is made from fewer possible deliveries alone.

### Fidelity ownership checkpoint

`proposeInteractiveSelection` returns a categorical transfer of its native proposal onto the existing editing grid. The E1 overview is therefore still approximately 0.60×0.86×0.86 mm even though inference read 0.60×0.43×0.43 mm source samples. `Use original detail` loads the existing selected region at stored spacing and categorically transfers the current labels; it does not itself perform new boundary inference. A new mark can request inference on that finer grid through the existing path.

The first experiment is to exercise that existing native-detail/correction workflow, preserving literal marks and draft/history ownership. Do not add smoothing and call it recovered anatomical detail. Retaining a separate native model mask would change the final consumer: the current coarse-section pruning proof does not establish a completely empty native section, so it cannot be reused unchanged for a new native-grid authority. Such a redesign requires its own correctness proof, not a display-only patch.

## Remaining completion gates

- Freeze/review new source-grounded boundary evidence with explicit uncertainty; do not score disputed labels as accuracy.
- Complete E1 original-acquisition and E3/E4 real-editor evaluation, including whole visible extent, marks, and native/overview mapping.
- Exercise actual learned Add/Remove corrections on different planes, including negative-only correction; verify literal marks, cancellation, undo/redo, save/reopen and source switching.
- Close the cold packaged import/model gate through the supported browser path when available; the earlier chooser denial remains unverified, not a pass.
- Record retained source texture/geometry, observed runtime/resources and practical UX limits. Preserve the full objective until these outcomes, not merely their harnesses, are demonstrated.

## Batch 34: native detail and a real learned correction

The native-detail path loaded a separate 62×105×122 editing region at 0.60×0.4297×0.4297 mm, with full-native index origin [121,217,176]. The original overview remained separately saved. Categorical transfer produced exactly 98,624 selected voxels and 216 foreground voxels, preserving all 54 original marked centers. This is finer MRI sampling and transferred labels, not new boundary inference.

At matched full-native COR244 (editor COR28), root inspected a selected dark pocket beside the smaller bright focus and placed a 1 mm Remove click inside that pocket. The immediate edit excluded exactly 11 voxels, retained all 216 foreground marks, and was frozen before inference. Transferred mask SHA: `7375ab69501d46bdaedb9fa79ec633ade5672995ff7009f10d5cee3e1155e29e`; immediate edited mask SHA: `8283643aae54ebc5d97c84c673a3132918bd00f756a89ed43901b5b45c0938c9`; corrected mark SHA: `c0aa23433c8ebdabfaa7fa93dba7b56afc687c50c7faf9a3205b2b1a5effd169`.

The actual model request used full 512-plane coronal context, 134×187 source planes, anchor259, 20 additional marked planes, fixed source range0–1247, and one-thread WASM. All 47 conditioning-preparation planes completed. The saved native draft remained byte-identical to the immediate brush edit after the first 10 final outputs; no provisional result was published. Browsing COR28→29→28 did not restart or cancel the job.

The last trustworthy observation, before browser control failed, was at page time 2,013,339.745 ms: 62 final frames delivered, next source plane321 entering its encoder, forward direction, no acknowledged stop, no model error, and no terminal completion. Model start was224,743.765 ms, so this observation was about29m49s into model work. The learned correction result is **not completed or accepted** by this evidence.

The source/marked/native-detail captures were individually inspected and immediately reported. Native MRI loading exposes more source variation, but the categorically transferred boundary remains stepped. The small dark-pocket mark was correctly placed; no judgment about the adjacent bright focus was promoted to clinical truth. A header capture directly documents the unhelpful 30% preparation display. This is not proof that the worker was stalled.

### Measured cost and pending bounded fixes

The first 40 completed preparation planes took545.66 seconds plus10.18 seconds loading. Memory attention accounted for413.01 seconds (75.69%); encoder102.45 seconds, memory encoder16.36 seconds, decoder9.97 seconds, and source/normalization2.11 seconds. All conditioning memories are retained, so ordinary attention cost grows with them. However, later long outliers occurred at fixed or smaller input shapes; token growth does not explain those outliers. The shared 128 GiB host had roughly65.5 GiB occupied by compressed memory at one read; causality is not established. Dynamic admission already estimates conditioning-dependent attention workspace in addition to its fixed runtime allowance. No budget, model, provider or thread-count change was made.

Two small changes have red tests but are **not implemented** while batch34 remains open:

1. Forward completed preparation-plane progress through the existing numeric callback. Preserve zero provisional mask publication, monotonic final progress, and terminal coverage/release/transfer as the only path to1. The adapter currently ignores worker preparation messages and stays at its source-setup endpoint30%.
2. Stop after an actually observed frame strictly beyond the complete mapped editing-grid footprint, in addition to existing empty-section separators. Once every sample a direction can contribute to categorical transfer has been delivered, more native frames cannot change even the raw transferred editing mask. Keep all-mark fences, unchanged complete conditioning, source validation, signed/phase lattice checks and real ACK/endpoints. Interior unsampled holes do not qualify; this does not certify a complete native mask or a future enlarged editor. For the current coronal footprint217..321, conservative observed endpoints322/216 bound final deliveries to108 rather than513. The live run had not yet reached322 at the last trustworthy observation, so no actual out-of-domain traversal is claimed.

The implemented multi-mark-plane pruning passed273 focused tests before these new tests were added. The combined tests-only footprint/progress red run has193 cases:171 pass and22 expected failures (19 footprint,3 progress); all72 controller cases pass. Production remains frozen at the recorded batch34 hashes. No current whole-tree-green claim is made.

### Independent E3/E4 references and saved-output controls

Root individually reviewed six new source-only patch images and froze `e3-e4-source-review-20260830/root-adjudication.json`, SHA `c0b102aeb2ed93b72eca2c7a729dc378df725c7a74c45bca8559c82b0f1a659c`, before any fresh E3/E4 browser prediction. Accepted sections: E3 AX96/COR234/SAG258 and E4 AX96/COR231/SAG253. Only small inset cores and separated outside patches are accepted; explicit uncertain connections override labels, and everything else remains unknown. These are stored axial reformat samples, not independent acquisitions or clinical full contours.

Historical native controls hit30/30 E3 inside samples and19/19 E4 inside samples, with0/60 outside samples selected in each case. The same counts hold after current hard-mark/26-connected processing. E3 raw40,605→38,490 selected; E4 raw50,969→50,885. These are historical PyTorch controls, not new browser results; E3's legacy range1–2386 and E4's full-series range0–1278 are reported separately, not pooled as one preprocessing policy. All frozen inputs remain unchanged.

The E1 native before-states both hit1,038/1,038 inside samples and select0/241 represented outside samples;218 other outside references are not sampled by this ROI. Five native ROI planes beyond the available pinned source crop are separately unassessed, with no before-state selected voxels or marks there. The reusable private evaluator is `validation-20260830/sparse-core-evaluation/e1-native-v1/score-native-state.mjs`; it refuses changed geometry, changed corrected marks or output overwrite. It has not evaluated a completed correction.

### Browser recovery and lifecycle gate (historical blocker; resolved below)

**Cleanup: BLOCKED.** Owned tab1997584522 (`http://localhost:43124/`, MiraViewer) remains attributable to this batch. Chrome PID62569 and preview servers51292/77460 were reverified live. An explicit browser-connection loss was followed by supported reconnection; tab listing still finds the exact tab, but both attaching and claiming it time out and reset the tool session. The extension is installed/enabled and its native-host manifest validates. No primary-browser restart, external tab closure, model retry, source edit, or new browser window was performed.

The user approved the documented blank-window recovery with “Sure.” The supported `open-chrome-window.js --browser chrome` script opened one blank window in Profile1; fresh listing identifies its tab as1997584571 (`about:blank`, opened2026-08-30T09:13:03.788Z). The original Chrome PID remains62569. The fresh browser connection can list both tabs, but `tabs.get('1997584522')` still times out and resets the tool session. The documented recovery is exhausted; the next user action is to reinstall the Browser plugin in ChatGPT, leaving Chrome and its MRI data intact. If the owned validation job is still running, the user can click Stop in that tab. Both the validation tab and owned recovery blank window remain unclosed and must be audited after reconnection.

Do not assume job completion, cancellation, observer restoration, or tab cleanup. Recover the existing tab without navigation; inspect actual state, save the complete observation if available, and stop the owned test job if necessary. Preserve the native draft and original overview. Remove the private observer and scratch readback only after collecting them, restore E2-only3D/sidebar closed if possible, close only the owned validation/recovery tabs, and audit current/stale-owned resources before returning to implementation.

## Resumption after user closed the blocked tab

Fresh browser inventories confirm the old validation tab and recovery blank tab are absent. The old inference result was not read: closure is not proof of completion or cancellation. Private recovery receipt: `frontend/tmp/segmentation-golden/validation-20260830/e1-native-correction-recovery.json`. The saved native draft must be checked before another correction run. Primary Chrome and both local servers remain live.

The bounded footprint and preparation-progress changes are now implemented. All 299 focused selection/controller/worker/runtime tests pass, including the 22 previously failing footprint/progress cases. This establishes the categorical-transfer and lifecycle contracts in tests, not a completed actual-editor learned correction.

### Current requested feature: full-model MRI section browsing

The user asked to keep the complete 3D model visible, browse all three planes, and improve browsing speed. Implementation removes native half-space truncation, blends the section between separately accumulated near/far tissue, adds direct axial/coronal/sagittal controls, prefers accepted source images, and clearly names resident-grid fallbacks. Converted source frames use a 32 MiB LRU; same-size GPU textures are updated in place. Raw source values, categorical labels, support, patient-coordinate geometry and independent-source contrast remain authoritative.

Actual Apple M4 Max GPU execution passes 22 compositing checks, including opposite camera directions, opaque near tissue, far tissue influence, native signed-zero/VOI behavior, oblique support, and CPU-label projection independent of GPU label LOD. Actual E2 captures show the full model around sections in all three planes. They also expose soft overview texture, stepped categorical boundaries and conservative framing. These display limitations are not silently promoted to anatomical inaccuracies or repaired by changing labels.

The first real browsing trace exposed a temporary missing section while the next frame loads, even when returning to a cached image. The correction retains the last complete section at its true geometry, marks the requested frame as loading, and clears it on source/volume changes or current-load failure. A separate fault-injection review exposed partial GPU upload recovery using a stale identity; all upload identities now invalidate on failure. MRI section and optional interpolated cutaway share one mutually exclusive mode, preventing hidden cutaway state from clipping MRI mode.

Evidence is private under `frontend/tmp/segmentation-golden/whole-volume-slices-20260830/`. The first two batches are closed, with current/stale-owned tab sweeps clear and external tabs preserved. Verbose console tracing materially affects short measurements, so those times are diagnostic only. A quiet metadata-only timing run and new visual continuity checkpoint are pending. No current-head whole-suite, complete segmentation acceptance, new commit, push or merge is claimed. The explicitly requested TurboVac skill is unavailable in this session; its workflow remains blocked rather than silently substituted.

### Completed MRI browsing checkpoint

Quiet actual-browser profiling found hidden 2D segmentation canvases repainting during 3D browsing. Only visible slice children now mount; the parent owns unchanged marks/history/model work. The native selection mask now follows the **displayed** section, avoiding repeated projections/uploads while a different section is pending. Native validity conversion uses one typed allocation and an indexed loop. A separate overlay canvas keeps settled pixel density, removing the corner-label size jump during lower-resolution interaction rendering.

The final headed Chrome batch used the actual loaded E2 examination on Apple M4 Max at 1600×1000. All 22 GPU compositing probes pass on the final shader. Ordered before/during/after screenshots show the old section retained at its correct location, truthful loading text, the new section arriving, a fixed camera, and stable corner typography. Axial/coronal/sagittal and reverse-camera captures retain the full model. Reopening the editor restores its three visible slices; returning to 3D leaves zero hidden slice canvases. The optional cutaway reports GPU clip=1/native=0; returning to MRI reports clip=0/native=1. The saved selection stays Draft; no inference, brush stroke or confirmation was performed in these browsing batches.

Twelve warm, trusted next/previous clicks all reached the expected source frame. Input to observed matching GPU completion was p50 **95.37 ms**, maximum/p95-nearest-rank **126.83 ms**; all 35 observed draws kept the section enabled. All 12 requested frames reused converted images; observed cache use peaked at 22 MiB of its 32 MiB limit. Browsing made zero 3D texture uploads and zero 2D texture allocations. These are one-case warm-step measurements with RAF-polled GPU fences, not exact display presentation timestamps, a whole-corpus guarantee, or proof of 60 fps. The CPU profiles include setup overhead and different browser-generated wheel-event counts, so no percentage wall-time speedup is claimed.

Final receipts, source hashes, CPU profiles, monotonic capture times and cleanup audit are in the private evidence directory. Every judged screenshot was individually inspected at original detail and immediately reported. The eight final source images are `final-00-before.jpg` through `final-07-restored-3d.jpg`. Cleanup is CLOSED: current/stale-owned tab sweeps empty, all ten original external tabs preserved, instrumentation removed, and primary Chrome plus both local servers reverified alive.

Remaining limitations are explicit: overview texture is soft, categorical section contours are stepped, initial framing is conservative, and a face-on bright section can dominate shape inspection despite retaining both halves. Base-grid gradient shading also lacks the spacing normalization used by the refined path; it needs its own physically matched regression before correction. Three generic asynchronous-listener console errors were observed; their producer is not established, and no clean-console claim is made. The broader native learned-correction, E3/E4 editor, packaged/offline and anatomical acceptance gates above remain unfinished. This feature checkpoint does not close the overall segmentation goal or authorize merging unvalidated segmentation changes.

### Current-tree verification and delivery status

- Full test run: **3,042 passed, zero failed, 54 opt-in tests skipped** (3,096 total). Private machine-readable receipt: `frontend/tmp/segmentation-golden/whole-volume-slices-20260830/final-tests.json`. The first broad run found two stale tests requiring hidden canvases; their assertions now require removal and successful reopen, with mark/save/history checks preserved. No production change followed the final browser batch.
- Whole-tree ESLint passed; the last test-only update passed a focused lint rerun. TypeScript, production build, affected-file formatting and `git diff --check` passed. Model assets were verified before and after the build. Vite still warns about the existing large main bundle; packaged/offline workflow validation was not performed here.
- React Doctor is **not cleared**: 11 warnings, with its blocking command exiting before the score stage. Nine `async-await-in-loop` warnings are cooperative yield/cancellation points in `emptyEditingPlane`, `seedConnectedSelection` and `interactiveSelectionContext`, not independent asynchronous jobs that can safely be parallelized. Two warnings concern the editor component's size and the three-element `filter().map()` rendering expression. No rule/config suppression or cancellation weakening was introduced to obtain a score.
- Final source hashes in the browser receipt match the checked files. Browser instrumentation occurs only in ignored private artifacts, not production code. No source MRI, private screenshot or annotation was staged or published. No new commit, push, PR or merge was performed; TurboVac remains unavailable and the broader segmentation acceptance gate remains open.
