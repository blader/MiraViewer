# SVR 3D Reconstruction, Volume Viewer & Tumor Segmentation
## Reverse-Engineered Product & Technical Specification

- **Branch:** `blader/siqi-chen/bring-in-new-images`
- **Base:** `main` (merge base `a0c40d9`)
- **Scope:** full merge-base-to-HEAD diff (`git diff a0c40d9...HEAD`) — 24 commits, 100 files, ~20,680 insertions / ~609 deletions. No PR exists yet; no hitchhiker commits detected (all 24 commits are branch-local SVR work).

---

## 1. Problem Statement

MiraViewer on `main` is a browser-only DICOM viewer for comparing MRI brain scans across dates, strictly in 2D: one slice at a time, per acquisition plane. Users (clinicians/caregivers tracking a brain tumor over time) could not:

1. **See anatomy in 3D.** Each MRI session produces several thick-slice 2D stacks (axial/coronal/sagittal). There was no way to fuse them into a single isotropic volume or view it volumetrically.
2. **Quantify a tumor.** No segmentation tooling existed — no way to outline a lesion on a slice, grow a 3D region from a seed, or run an ML model to get labeled tumor compartments and volume-in-mL numbers.
3. **Trust auto-alignment.** The existing cross-date auto-align used a coarse 128px mutual-information slice search that was frequently off by several slices and gave no way to inspect why.
4. **Keep the UI responsive at this scale.** Nothing on `main` performed minutes-long numeric solves or GPU volume rendering; naively adding them would freeze the main thread and burn GPU/RAM (volumes are hundreds of MiB).

Everything must keep working **fully offline in the browser** (IndexedDB-resident DICOMs, no server), which is the app's core constraint.

## 2. Solution Overview

Four cooperating subsystems, all client-side:

1. **SVR reconstruction** (`utils/svr/`): fuses multiple 2D DICOM series into one isotropic 3D `Float32Array` volume via PSF-aware iterative slice-to-volume reconstruction with robust loss, Laplacian regularization, multi-resolution bootstrapping, optional ROI restriction, and NCC-based ROI-rigid inter-series registration. The compute phase runs in a **dedicated Web Worker** with transferred buffers (inline fallback keeps tests/no-Worker environments on the identical code path).
2. **GPU 3D viewer** (`SvrVolume3DViewer` + `utils/svr/glRaymarch.ts`/`renderLod.ts`): a WebGL2 raymarcher with render-on-demand RAF (idle = zero GPU), interaction-time LOD (half-res / 96 steps / jittered rays), R16F volume textures with R8 fallback, occupancy-grid empty-space skipping, a GPU memory budget planner, an orthogonal slice inspector, and per-label voxel/mL metrics.
3. **Tumor segmentation**, three modalities sharing a BraTS-style label scheme:
   - *2D seed-grow* (`costDistanceGrow2d` + `marchingSquares`): cost-distance Dijkstra grow on the displayed slice with an area-target slider and surface-tension tuning; results persist to IndexedDB as re-projectable normalized polygons.
   - *3D region grow* (`regionGrow3D_v2` + `roiCube3d`): seeded tolerance-based grow inside a cube ROI drawn on the slice inspector, with live overlay preview and manual brush refinement.
   - *ONNX ML segmentation* (`segmentation/onnx/` + `useOnnxTumorSession`): user-supplied BraTS-style `.onnx` model cached in IndexedDB, run via onnxruntime-web (WebGPU preferred, threaded WASM when cross-origin-isolated), with a logits-memory preflight gate.
4. **Alignment overhaul** (`useAutoAlign` + `ssim`/`phaseCorrelation`/`imageFeatures`): slice search upgraded from 128px MI to 512px multi-metric scoring (phase correlation default; SSIM/LNCC/ZNCC/NGF/census available), foreground inclusion masks, a minimum search radius and window bounds to prevent early-stop misses, plus a hold-`Z` per-slice score debug overlay.

Key design properties: offline-first (ORT runtime assets vendored at build time), cancellable everywhere (AbortController + cooperative yields), memory-budgeted (preflights before allocation; caches bounded; buffers released/transferred), and bit-identical worker/inline compute paths.

## 3. Product Requirements

### 3.1 User-Facing Behavior

| # | Requirement | Evidence |
|---|---|---|
| R1 | A third top-level view mode "3D" (Box icon) joins Grid/Overlay and persists across reloads | `ComparisonMatrix.tsx`, `useOverlayNavigation.ts` |
| R2 | User picks a date + one series per plane (axial/coronal/sagittal grouping), optionally draws a square ROI on a slice preview, and runs reconstruction with live progress and cancel | `Svr3DView.tsx`, `useSvrReconstruction.ts` |
| R3 | Reconstruction never freezes the page; progress updates throttle to ≤10 Hz | worker + `yieldToMain`, hook throttle |
| R4 | The 3D viewer supports rotate/zoom, window/level, quality presets (auto/full/512…128), GPU budget control, and stays at zero GPU cost when idle | `SvrVolume3DViewer.tsx`, `renderLod.ts` |
| R5 | Slice inspector (left pane) shows axial/coronal/sagittal cuts; drag = cube ROI; click = seed for 3D grow; brush = manual label edits (locked during ONNX runs) | `SvrVolume3DViewer.tsx`, `roiCube3d.ts` |
| R6 | Labels render as a color overlay in both 3D and slice inspector; per-label voxel counts and total mL are displayed | `labelPalette.ts`, `labelMetrics` memo |
| R7 | User can upload an ONNX tumor model once; it is cached locally and sessions re-init offline; oversized volumes are blocked by default with an explicit unsafe override | `useOnnxTumorSession.ts`, `modelCache.ts` |
| R8 | In Grid/Overlay, dragging a rectangle now offers two actions: "Align All" (exclusion mask) and "Segment" (seed a 2D tumor grow) | `DragRectActionOverlay.tsx`, `GridCell.tsx`, `OverlayView.tsx`, `HelpModal.tsx` |
| R9 | 2D segmentations save per slice (polygon + threshold + grow metadata + authoring view transform) and re-project correctly under different pan/zoom/rotation/affine | `db/schema.ts`, `viewTransform.ts`, `TumorSavedSegmentationOverlay.tsx` |
| R10 | User can draw/edit/delete a manual ground-truth polygon per slice; it renders alongside algorithmic results | `GroundTruthPolygonOverlay.tsx` |
| R11 | Cmd+wheel zooms the hovered image; plain wheel navigates slices; pinch (ctrl-wheel) is ignored for slice nav | `DicomViewer.tsx`, `DicomViewer.test.tsx` |
| R12 | With debug alignment on, holding `Z` shows per-slice similarity scores (SSIM/LNCC/MI/NMI/phase/score) on each viewer | `alignmentSliceScoreStore.ts`, `DicomViewer.tsx` |
| R13 | Volume and metadata are downloadable (`.f32` + JSON) for external analysis | `Svr3DView.tsx` |
| R14 | "Unknown" sequences (no weight/sequence) are hidden from plane/sequence selectors | `useComparisonFilters.ts` |

### 3.2 Supported Workflows

1. Upload DICOMs → switch to 3D view → select series → (optional) draw ROI → reconstruct → inspect volume in 3D + slice inspector.
2. Reconstruct → draw cube ROI → click seed → live region-grow preview → adjust tolerance/label → brush-fix → read mL metrics.
3. Reconstruct → upload/init ONNX model → run segmentation → review BraTS labels (NCR/NET, edema, enhancing) → refine manually.
4. Grid/Overlay → drag rect on a tumor → "Segment" → tune area slider/surface tension → save polygon → toggle saved overlay on any date; optionally draw ground truth for comparison.
5. Drag rect over a tumor → "Align All" → improved phase-correlation slice search aligns all dates; hold `Z` to audit scores.

### 3.3 Scope Boundaries

- No server, no PHI leaves the browser; ONNX model is user-supplied (none bundled).
- 3D labels are session-only (not persisted); only 2D polygons/ground truth persist to IndexedDB.
- No NIfTI export at HEAD (an earlier commit had it; removed during compaction). `.f32` + JSON instead.
- `SvrModal.tsx`/`SvrVolume3DModal.tsx` (modal entry) and `svrHarness.ts` (A/B export ZIP) are present but **unwired** at HEAD — `Svr3DView` is the only live entry point.
- No multi-date 3D comparison; one reconstruction at a time.

## 4. Architecture

### 4.1 System Diagram

```
ComparisonMatrix (view mode: grid | overlay | svr3d)
 ├─ GridView/GridCell ─┬─ DicomViewer (capture, wheel/zoom, content-key wait)
 │                     ├─ DragRectActionOverlay ──> [Align All] | [Segment]
 │                     ├─ TumorSegmentationOverlaySeedGrow ──> costDistanceGrow2d ─> marchingSquares ─> polygon
 │                     ├─ TumorSavedSegmentationOverlay <── localApi <── IndexedDB(tumor_segmentations)
 │                     └─ GroundTruthPolygonOverlay <──────── IndexedDB(tumor_ground_truth)
 ├─ OverlayView (same overlay stack, single pane)
 └─ Svr3DView (series picker, ROI, progress, downloads)
      └─ useSvrReconstruction ─> reconstructVolumeMultiPlane (main thread: load/decode via cornerstone)
            └─ svrCompute.worker (transferred slice buffers)
                  └─ svrComputeCore: normalize ─> grid+memory preflight ─> bounds-center / ROI-rigid NCC align
                        ─> ROI crop ─> reconstructionCore (PSF splat ─> iterate: forward-project residuals,
                           robust loss, Laplacian, multi-res) ─> Float32 volume (transferred back)
            └─ volumePreview (axial/coronal/sagittal PNGs, main thread)
      └─ SvrVolume3DViewer
            ├─ renderLod: computeRenderPlan (GPU budget, f16/u8) ─> buildRenderVolumeTexData
            ├─ glRaymarch: WebGL2 program, R16F/R8 3D textures, occupancy max-grid skip,
            │              render-on-demand RAF + interaction LOD
            ├─ slice inspector: ROI cube (roiCube3d) / seed ─> regionGrow3D_v2 (live overlay) / brush
            └─ useOnnxTumorSession ─> modelCache(IndexedDB) ─> ortLoader (WebGPU→WASM, COOP/COEP threads)
                  ─> runTumorSegmentationOnnx ─> logitsToLabels ─> SvrLabelVolume (BraTS palette)

useAutoAlign ─> elastix seed affine (128px, exclusion feather) ─> 512px slice search
   (phaseCorrelation | ssim/lncc/zncc | ngf | census, foreground mask, window+min radius)
   ─> alignmentSliceScoreStore ─> DicomViewer hold-Z debug overlay
```

### 4.2 Data Lifecycle (SVR)

1. **Load (main thread):** sorted SOP UIDs from IndexedDB → cornerstone decode → per-slice geometry from IPP/IOP/PixelSpacing (`dicomGeometry`) → voxel-aware area-average downsample (`downsample`, `resample2d`) → intensity samples collected.
2. **Dispatch:** slim payload (slices, samples, series meta, params) posted to `svrCompute.worker` with pixel buffers in the transfer list; inline fallback if `Worker` is unavailable.
3. **Compute (worker):** robust percentile normalization → output grid selection with memory preflight (`maxVolumeDim` clamp) → inter-series registration (`bounds-center` or `roi-rigid` NCC coordinate descent with rotation/translation limits) → optional ROI slice cropping → initial PSF-weighted splat → N refinement iterations (forward-project, Huber/Tukey-weighted residual back-splat, optional Laplacian smoothing), multi-res coarse pass first → volume transferred back; slice stack released.
4. **Finalize (main thread):** orthogonal preview PNGs → `SvrResult` into React state → 3D viewer builds a budget-fitted render texture (possibly downsampled / u8) + occupancy grid → render-on-demand loop.
5. **Labels:** grow/brush edits mutate the label volume and patch only the dirty bbox of the GPU label texture through a persistent downsample cache; ONNX path disposes logits immediately after argmax.

## 5. Technical Design

### 5.1 Reconstruction solver (`reconstructionCore.ts`, `svrComputeCore.ts`)
- Forward model: slice-thickness PSF (`none`/`box`/`gaussian`), ≤7 symmetric samples along the slice normal; thickness from `SliceThickness`/`SpacingBetweenSlices` (newly ingested tags) with voxel-size fallback.
- Solver: SIRT-style iterative refinement with `stepSize`, robust loss (`huber` default, `robustDelta` 0.1), Laplacian weight 0.02, multi-resolution (2× coarse, 1 coarse iteration). Defaults in `DEFAULT_SVR_PARAMS` (1.0 mm target, 192 max dim, ROI-rigid registration).
- Hot path: `sampleTrilinear`/`splatTrilinearScaled` hand-optimized (single base index + stride offsets).
- Cancellation: `assertNotAborted` at every yield point; worker also hard-`terminate()`d on abort.

### 5.2 Worker protocol (`svrCompute.worker.ts`)
Single-shot worker; `run`/`abort` requests, `progress`/`done`/`error` responses; volume `Float32Array` transferred (not copied) both ways. Worker-safety contract documented in `svrComputeCore.ts` (no DOM/cornerstone/IndexedDB imports; `localStorage` guarded).

### 5.3 GPU rendering (`glRaymarch.ts`, `renderLod.ts`, viewer)
- R16F primary texture format (half bandwidth, linear-filterable in core WebGL2) with R8 fallback; CPU f32→f16 bit-twiddling converter.
- Occupancy max-grid (8³ blocks, 1-voxel dilation, one quantum of f16 headroom) enables empty-space skipping that provably never culls visible voxels (tested).
- `computeRenderPlan`: fits volume+label textures into a MiB budget by downsampling and/or switching to u8; presets auto/full/512/384/256/192/128.
- Render-on-demand: frames scheduled only on change; DPR cap; interaction mode renders at half resolution with 96 steps + jittered ray starts; settle timer restores full quality. Idle cost is zero.

### 5.4 Segmentation
- **2D grow:** Dijkstra over a cost field combining intensity statistics (robust μ/σ of seed region vs background), edge barriers (Sobel), directional penalties (high→low vs low→high), radial growth damping, and a cached edge-clearance BFS scaled by a "surface tension" slider; threshold slider is area-targeted; contour extracted by marching squares; monotonic nesting under slider increase is a tested invariant. Typed-array min-heap (fuzz-verified bit-identical to the object heap it replaced).
- **3D grow:** tolerance band around seed value, 6/26-connectivity, cube ROI as hard wall or soft prior (`outsideToleranceScale`), max-voxel cap, cooperative yields, sparse `Uint32Array` output.
- **ONNX:** `[1,1,Z,Y,X]` float tensor in; `[1,C,Z,Y,X]` logits → argmax → BraTS label map `[0,1,2,4]`; preflight blocks runs whose logits would exceed 384 MiB unless the user opts into "unsafe full-res"; WebGPU preferred, else WASM (≤8 threads when `crossOriginIsolated`, via COOP/COEP headers on dev/preview; offline ZIP stays single-threaded). Model blob cached in a separate IndexedDB (`miraviewer:model-cache`).

### 5.5 Persistence & schema
- IndexedDB `DB_VERSION` 2→4: new `tumor_segmentations` and `tumor_ground_truth` stores, indexed by series, SOP, and `[comboId, dateIso]`.
- Rows store polygons in **viewer-normalized coordinates plus the authoring `ViewerTransform` (zoom/rotation/pan/2×2 affine residual) and viewport size**; `viewTransform.ts`/`viewportMapping.ts` re-project between transforms (round-trip tested).
- `DicomInstance.spacingBetweenSlices` added (ingestion + export backup).
- New `usePersistedState` hook consolidates localStorage UI state (sidebars, view mode, grow-tuning per date/combo).

### 5.6 Alignment improvements
- Slice search at 512px (Cornerstone render element sized to max needed capture to avoid "fake 512" upsampling); metric selectable, default `phase` (masked, Hann-windowed 64px FFT phase correlation with precomputed reference spectrum and scratch reuse).
- Foreground inclusion mask (threshold ≥2% with min-coverage guard), exclusion rect honored end-to-end (now also feathered in elastix seed registration); seed translation scaled between registration and search resolutions; min search radius 5 + window radius 40 fix "off by ~5 slices" early stops.
- All candidate scores recorded to `alignmentSliceScoreStore` for the hold-`Z` overlay; `AlignmentProgress.bestMiSoFar` re-documented as metric-agnostic ("Score" in UI).

### 5.7 Memory hygiene
- Cornerstone image cache capped (default 256 MiB, localStorage-tunable) and inner WADO `fileImageId` decoded-image + dataset cache entries explicitly unloaded after wrapping.
- ONNX logits tensor disposed right after argmax; reconstruction slice stack released post-solve; worker buffers transferred, never copied.

### 5.8 Debug/observability
- `debugSvr.ts` (`miraviewer:debug-svr`, on by default in dev) gates structured `[svr]` step logs; debug-only resample kernel override (`miraviewer:svr-resample-kernel`); alignment debug config dump; render plan note strings surfaced in the viewer UI.

## 6. New Files

| File | Purpose |
|---|---|
| `components/Svr3DView.tsx` | Full-pane 3D mode: date/series pickers, ROI drawing on DICOM previews, run/cancel, downloads, hosts viewer |
| `components/SvrVolume3DViewer.tsx` | WebGL2 raymarch viewer: render-on-demand, LOD, slice inspector, ROI cube, seed grow, brush, label metrics |
| `components/SvrModal.tsx` / `SvrVolume3DModal.tsx` | Earlier modal-based entry points (currently unwired at HEAD) |
| `components/TumorSegmentationOverlaySeedGrow.tsx` | Interactive 2D seed-grow tool (slider, surface tension, save) |
| `components/TumorSavedSegmentationOverlay.tsx` | Read-only render of saved polygons, re-projected to current transform |
| `components/GroundTruthPolygonOverlay.tsx` | Manual ground-truth polygon draw/edit/delete tool |
| `components/comparison/GridCell.tsx` | Grid cell extracted from GridView; wires viewer + drag-rect actions + tumor/GT overlays |
| `hooks/useSvrReconstruction.ts` | Run/cancel/progress state machine around `reconstructVolumeMultiPlane` |
| `hooks/useOnnxTumorSession.ts` | ONNX model upload/cache/session/init/preflight/run/cancel state |
| `hooks/usePersistedState.ts` | Validated localStorage-backed `useState` |
| `services/svrHarness.ts` | Baseline-vs-high-detail A/B export ZIP builder (unreferenced at HEAD) |
| `types/svr.ts` | SVR params/result/ROI/label types + `DEFAULT_SVR_PARAMS` |
| `utils/svr/svrComputeCore.ts` | Worker-safe compute phase: normalize, grid preflight, registration, solve |
| `utils/svr/svrCompute.worker.ts` | Single-shot worker entry (run/abort; transferred buffers) |
| `utils/svr/reconstructVolume.ts` | Main-thread orchestrator: slice load/decode, worker dispatch + inline fallback, previews |
| `utils/svr/reconstructionCore.ts` | PSF forward model + iterative robust solver |
| `utils/svr/rigidRegistration.ts` | NCC coordinate-descent rigid registration (ROI-centered, limit-clamped) |
| `utils/svr/dicomGeometry.ts` | IPP/IOP/PixelSpacing parsing → slice axes/corners/geometry |
| `utils/svr/sliceRoiCrop.ts` | In-place crop of slices to ROI slab/bbox |
| `utils/svr/trilinear.ts` | Hot-path trilinear sample/splat |
| `utils/svr/resample2d.ts` | Area-average + Lanczos3 2D resampling |
| `utils/svr/downsample.ts` | Voxel-aware slice downsample sizing |
| `utils/svr/glRaymarch.ts` | Raymarch shaders, texture format choice, f16 conversion, occupancy grid |
| `utils/svr/renderLod.ts` | GPU budget planner, u8 conversion, nearest label downsample + dirty-region update |
| `utils/svr/volumePreview.ts` | Axial/coronal/sagittal PNG previews |
| `utils/svr/svrUtils.ts` | `assertNotAborted`, `yieldToMain` (scheduler.yield → MessageChannel → setTimeout), `formatMiB` |
| `utils/svr/vec3.ts` | Minimal vec3 math |
| `utils/segmentation/costDistanceGrow2d.ts` | 2D cost-distance Dijkstra grow + caches + slider mapping |
| `utils/segmentation/marchingSquares.ts` | Mask → largest closed contour polygon |
| `utils/segmentation/regionGrow3D_v2.ts` | Seeded 3D grow (tolerance, ROI prior, heap, sparse output) |
| `utils/segmentation/roiCube3d.ts` | 2D drag → mm-isotropic 3D cube ROI |
| `utils/segmentation/segmentTumor.ts` | Captured-PNG → grayscale decode helpers |
| `utils/segmentation/brats.ts` | BraTS label IDs/colors |
| `utils/segmentation/labelPalette.ts` | 256-entry RGBA palette for label textures |
| `utils/segmentation/onnx/ortLoader.ts` | Dev/prod ORT loading, thread config, session creation (WebGPU→WASM) |
| `utils/segmentation/onnx/tumorSegmentation.ts` | Tensor packing, session run, logits→labels |
| `utils/segmentation/onnx/logitsToLabels.ts` | Argmax over `[1,C,Z,Y,X]`/`[C,Z,Y,X]` logits |
| `utils/segmentation/onnx/modelCache.ts` | IndexedDB model blob cache |
| `utils/ssim.ts` | Block SSIM/LNCC + global ZNCC (masked) |
| `utils/phaseCorrelation.ts` | Masked, windowed FFT phase correlation with reusable reference/scratch |
| `utils/imageFeatures.ts` | Gradient magnitude, foreground inclusion masks |
| `utils/alignmentSliceScoreStore.ts` | In-memory per-slice score store for debug overlay |
| `utils/viewTransform.ts` / `utils/viewportMapping.ts` | Transform-aware polygon/point re-projection; contain-mapping |
| `utils/stats.ts` / `utils/grid3d.ts` | Shared robust stats/median/RNG; 3D index helpers |
| `utils/debugSvr.ts` | SVR debug logging gate |
| `.prettierrc.json` / `.prettierignore` | Repo formatting config |

## 7. Modified Files (Key Changes)

| File | Change |
|---|---|
| `ComparisonMatrix.tsx` | Adds `svr3d` view mode + Svr3DView wiring; sidebar state via `usePersistedState`; filters out Unknown sequences; surfaces alignment errors |
| `DicomViewer.tsx` | Cmd+wheel zoom, plain-wheel slice nav (replaces `useWheelNavigation` here), displayed-content-key tracking + `waitForDisplayedContentKey`, hold-`Z` slice-score debug overlay |
| `comparison/GridView.tsx` | Cell body extracted to `GridCell`; passes alignment/tumor plumbing |
| `comparison/OverlayView.tsx` | Adds Segment drag action + tumor/saved/GT overlays to single-pane view |
| `DragRectActionOverlay.tsx` | Generalized from single "Align All" to a multi-action API with base/screen mask spaces |
| `db/db.ts` / `db/schema.ts` | DB v4: tumor segmentation + ground-truth stores/indexes; `ViewerTransform`/polygon types; `spacingBetweenSlices` |
| `utils/localApi.ts` | CRUD for tumor segmentations/ground truth; sorted-UID helpers; drops dead exports/index fallback |
| `hooks/useAutoAlign.ts` | 512px multi-metric slice search, inclusion mask, search window + min radius, score recording, seed-scale fix |
| `utils/alignment.ts` | Multi-metric scoring plumbing (SSIM/LNCC/ZNCC/NGF/census/phase + debug MI/NMI), search bounds, yielding |
| `utils/elastixRegistration.ts` | Exclusion-rect feathering support in seed registration |
| `utils/mutualInformation.ts` | Doc/metric-agnostic cleanup; kept for debug comparison |
| `utils/cornerstoneInit.ts` | Image cache size cap (256 MiB default) + inner WADO imageId/dataset decache |
| `AlignmentControls.tsx` | "MI" → metric-agnostic "Score" label |
| `HelpModal.tsx` | Documents Cmd+wheel zoom and the two-action drag rectangle |
| `hooks/useComparisonFilters.ts` | Hides Unknown sequences from plane/sequence pickers |
| `hooks/useOverlayNavigation.ts` | Persists/restores `svr3d` view mode |
| `hooks/usePanelSettings.ts` | Generic defaults-driven validation; unload flush |
| `hooks/useGlobalSliceWheelNavigation.ts` | Comment updates for new wheel coexistence |
| `comparison/ComparisonFiltersSidebar.tsx` | Sequence list rendering tweaks for filtered sequences |
| `services/dicomIngestion.ts` / `services/exportBackup.ts` | Ingest + export `SpacingBetweenSlices`; guard non-positive thickness |
| `types/api.ts` | `bestMiSoFar` re-documented as generic slice-search score |
| `index.css` | Thin vertical tumor-slider styling |
| `vite.config.ts` | Vendors ORT `.mjs`/`.wasm` assets; COOP/COEP headers on dev/preview; excludes `onnxruntime-web` from prebundling; prettier formatting |
| `package.json` / `package-lock.json` | Adds `onnxruntime-web`; dev-deps `prettier`; prettier scripts |
| `.gitignore` | Ignores `.vercel/` |
| `tests/DicomViewer.test.tsx` / `tests/mutualInformation.test.ts` | Extended for wheel/zoom/async-swap; updated for metric changes |

## 8. Testing Strategy

**152 tests, all Vitest unit/component level** (no e2e). New/extended coverage:

- **Solver correctness:** `svrPhantom` (PSF-aware reconstruction reduces error on a synthetic phantom with thick slices); `svrComputeCore` (worker-extracted compute is bit-identical to a direct solver run; pre-aborted signal rejects with "SVR cancelled"); `svrGeometryInvariants` + `svrDicomGeometry` (world↔pixel round-trips incl. rotated axes); `svrTrilinear`, `svrResample2d`, `svrDownsample`, `svrSliceRoiCrop`.
- **Registration:** `svrRigidRegistration` (15 tests: Euler matrices, rigid point transforms, bounds centers, NCC scoring edge cases).
- **Rendering safety:** `svrOccupancyGrid` (conservativeness: dilated block max never exceeded, f16 headroom); `svrFloat16` (encode canonical/overflow/NaN, round-trip, 2-bytes/voxel budget); `svrRenderLod` (budget-driven u8 fallback, presets, dirty-region label update ≡ full rebuild, cancellation).
- **Segmentation:** `costDistanceGrow2d` (slider monotonicity/nested masks, barrier costs, directional asymmetry); `roiCube3d` (mm-isotropic depth, clamping, per-plane axes); `onnxLogitsToLabels` + `onnxTumorSegmentation` (tensor layout, label mapping, shape errors — mocked session); `labelPalette`.
- **Overlay math:** `viewTransform` (polygon re-projection round-trips between transforms).
- **Alignment:** `alignmentSliceSearch` (min-radius prevents early-stop misses; phase metric survives intensity remapping); `mutualInformation` updates.
- **UI behavior:** `DicomViewer` (Cmd+wheel zoom, plain-wheel nav, settings held until async image swap completes).
- Pre-existing suites (db, ingestion, hooks, persistence, etc.) still green; `fake-indexeddb` underpins DB tests; worker path falls back to the identical inline code path under Vitest.

**Not covered by automated tests:** WebGL rendering output, actual worker execution, real ONNX inference, the large interactive components (`Svr3DView`, `SvrVolume3DViewer`, seed-grow overlay UI).

## 9. Rollout Strategy

No feature flags. The 3D mode ships as an always-available third view toggle; everything else is opt-in by interaction (drag-rect "Segment", ONNX model upload). Soft gates: ONNX logits-memory preflight (override checkbox), GPU budget/quality presets, max-volume-dim clamp, debug behaviors via localStorage keys (`miraviewer:debug-svr`, `miraviewer:debug-alignment`, `miraviewer:cornerstone-cache-mib`, `miraviewer:svr-resample-kernel`). Offline ZIP distribution keeps working (vendored ORT assets; single-threaded WASM without COOP/COEP). Kill switch = don't enter the 3D view; 2D flows are unchanged except the alignment metric swap and wheel/zoom behavior.

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Minutes-long solve janks UI | Web Worker + transferred buffers; `scheduler.yield`/MessageChannel yields; 16 ms refinement budget |
| OOM on large volumes | Grid memory preflight, `maxVolumeDim` clamp, ONNX logits preflight, GPU budget planner, cache caps, buffer release/transfer |
| GPU drain / weak GPUs | Render-on-demand (idle=0), DPR cap, interaction LOD, R16F→R8 fallback, occupancy skipping |
| Wrong fusion from bad DICOM geometry | Geometry parse fallbacks, bounds-center/ROI-rigid registration with clamped transforms, debug logs, phantom tests |
| Alignment metric swap changes behavior | Metric configurable in code, MI/NMI retained for debug comparison, hold-`Z` score audit overlay, search-window guards + tests |
| Overlay drift across pan/zoom/rotation | Authoring transform + viewport persisted per polygon; re-projection round-trip tested |
| Worker/inline divergence | Single shared `computeSvrFromLoadedSlices`; bit-identical test |
| ONNX model trust/shape mismatch | User-supplied model, explicit shape validation, clear errors, cancellable session |
| Schema migration (DB v2→v4) | Additive stores only; upgrade guarded by `objectStoreNames` checks |
| Stale-looking UI during async slice loads | Content-key tracking + `waitForDisplayedContentKey`; tested |
| Dead-but-present modules confuse readers | `SvrModal`/`SvrVolume3DModal`/`svrHarness` unwired at HEAD; candidates for deletion or re-wiring |

## 11. Summary

- **24 commits**; ~**20,680 insertions / 609 deletions** across **100 files** (54 new source files, 22 new test files, 20 modified source files, config/lockfile).
- Adds three major capabilities to a previously 2D-only offline DICOM viewer: multi-series SVR reconstruction, a budget-aware GPU volume viewer, and interactive + ML tumor segmentation with persistent 2D annotations — plus an alignment-quality overhaul and a performance/memory pass (worker compute, render-on-demand, cache hygiene) that keeps the browser responsive at volume scale.
- 152/152 tests green; `tsc -b` clean; vite emits the SVR worker as its own chunk.
