# SVR Performance Optimization Plan

Branch: `blader/siqi-chen/bring-in-new-images`
Date: 2026-06-09 (executed 2026-06-09 → 2026-06-10)
Status: complete — T1–T13 executed and PASSed independent adversarial review
(claude-opus-4-8, max effort, full-plan context); T14 deferred pending a real
ONNX model file. All work uncommitted in the working tree.

## Goal

Make the SVR feature (reconstruction → 3D raymarched viewer → tumor segmentation)
faster and lighter on memory without changing its visual output at rest or its
algorithmic results. Three axes, in priority order:

1. **FPS** in the 3D viewer (fragment cost dominates: `pixels × steps × bandwidth`).
2. **Memory pressure** (the same volume currently exists as 3–5 simultaneous
   copies; reconstruction preflight converts every saved byte into finer voxels).
3. **Main-thread responsiveness** during reconstruction and interactive
   segmentation.

## Invariants (anti-patterns to avoid)

- **No visual regression at rest.** Settled (non-interacting) frames must render
  with the same quality as today: same step count, same shading math. Quality
  reduction is allowed only *during* active interaction, and must restore on
  settle.
- **No algorithmic output change.** Reconstruction, registration, and
  segmentation must produce numerically identical (or provably equivalent)
  results. Buffer-lifetime and loop-shape changes only.
- **No new behavior flags or UI.** These are internal optimizations.
- **Offline ZIP distribution keeps working.** This app ships as a
  download-and-run static ZIP; anything requiring server headers
  (COOP/COEP for WASM threads) must degrade gracefully when
  `crossOriginIsolated` is false.
- **Keep the GPU-budget LOD and reconstruction preflight guardrails intact** —
  update their math when peak formulas change, don't bypass them.
- `npm run check` (eslint + vitest) green after every task.

## Review gate (validation discipline)

Every task below passes an independent adversarial review before it is marked
done. The reviewer is a fresh `claude --model claude-opus-4-8 --effort max
--output-format json` subprocess with no context from the executing session. It
receives this full plan file (by path) plus the task's stated intent and
acceptance criteria, and is instructed to assume the work failed both checks
until it finds evidence otherwise in the repo itself:

- (a) Did the work achieve the task's stated intent?
- (b) Does the work advance this plan's overall goal without violating an
  invariant above (e.g., quality loss at rest, changed algorithm output,
  broken offline distribution)?

The review verdict must be binary with cited file/line evidence. On failure,
close the gaps and dispatch a fresh review. Record the model the CLI actually
resolved to (via `modelUsage` in the JSON output) in the task log below. If
`claude-opus-4-8 --effort max` cannot run, the gate stays unchecked and the
blocker is recorded — no silent downgrade.

## Tasks

### P0 — FPS quick wins (small diffs, large frame-cost multipliers)

**T1. GL context + shader micro-fixes** — `SvrVolume3DViewer.tsx:1533`,
`glRaymarch.ts:146`
- `antialias: false` (MSAA is pure waste on a fullscreen-quad raymarcher; no
  geometry edges exist), `powerPreference: 'high-performance'` (dual-GPU
  laptops currently may pick the integrated chip).
- Hoist `transpose(u_rot)` out of the fragment shader: pass the inverse
  rotation as a uniform computed once per frame in JS.
- Accept: context options changed; shader receives precomputed inverse; visual
  output identical; check green.

**T2. Adaptive render resolution** — `SvrVolume3DViewer.tsx:1729-1747`
- Cap DPR at 1.5 for the 3D canvas; render at ~0.5× scale while the user is
  actively rotating/zooming (pointer drag or wheel), restore full resolution
  one frame after interaction ends.
- Accept: canvas backing-store size drops during drag and restores on settle;
  settled frame is byte-identical in size to a capped-DPR frame; check green.

**T3. Interaction-time step reduction with jittered ray start** —
`glRaymarch.ts`, `SvrVolume3DViewer.tsx:484,1786`
- Keep 256 steps at rest. During interaction, drop to ~96 steps and add a
  per-pixel interleaved-gradient-noise jitter to the ray start (`t += jitter *
  dt`) so banding becomes imperceptible noise.
- Accept: `u_steps` (and a new jitter toggle/uniform) varies with interaction
  state; settled frames unchanged; check green.

**T4. R16F volume texture format** — `glRaymarch.ts:15-39`,
`SvrVolume3DViewer.tsx` upload path, `renderLod.ts` byte estimates
- Switch the primary 3D texture from R32F to R16F: half the bandwidth and GPU
  memory, and half-float is linearly filterable in core WebGL2 (R32F linear
  needs `OES_texture_float_linear` and currently silently degrades to NEAREST
  where missing). Requires converting the Float32Array to Float16 bits
  (Uint16Array) on upload. Keep the R8 fallback. Update `renderLod.ts` byte
  estimates so the GPU budget math stays honest.
- Accept: texture allocated as R16F with LINEAR filtering; LOD budget
  estimates updated; render visually equivalent (16-bit mantissa ≫ display
  precision for normalized data); check green.

### P1 — Memory lifetime fixes (heap peak ↓, some convert to resolution ↑)

**T5. Reconstruction peak reduction** — `reconstructVolume.ts:998-1029,
1216-1246, 717-1270`, `reconstructionCore.ts:195-310`
- Release the slice stack (`allSlices.length = 0`) as soon as the solver no
  longer needs it, instead of holding until function return.
- **Execution findings (2026-06-09), verified against the code:** the other
  planned sub-items were based on stale analysis and are NOT executed:
  - "Null coarse before upsample" is a provable no-op: the coarse volume is
    the *source* being read throughout `resampleVolumeToGridTrilinear`, so it
    must stay alive for the whole call; the existing `coarse = null`
    immediately after (line ~1246) is already optimal.
  - "Reuse refinement scratch" already exists on this branch:
    `reconstructVolumeFromSlices` reuses `weight` as the refinement `updateW`
    (`reconstructionCore.ts:258-261`). The remaining 3×nvox peak during
    refinement (volume + update + updateW) is algorithmically required — the
    volume must stay readable for forward projection while both accumulators
    fill, and the per-voxel robust weights change every iteration so they
    cannot be precomputed.
  - `estimatePeakBytes` (3 arrays when iterating, 2 otherwise) is therefore
    already accurate; changing it would make the preflight dishonest. The
    "smaller formula buys resolution" idea from the audit does not survive
    contact with the code.
  - `useSvrReconstruction.run()` already drops the previous result before a
    re-run (no double-retention), and `rigidAlignSeriesInRoi`'s per-series
    reference volumes are loop-scoped (GC-eligible each iteration).
- Accept (amended): slice stack released post-solve; reconstruction tests pass
  unchanged; check green.

**T6. ONNX + segmentation memory hygiene** — `tumorSegmentation.ts:40-56`,
`ortLoader.ts:28-34`, `useOnnxTumorSession.ts`, `SvrVolume3DViewer.tsx:1039`,
`vite.config.ts`
- Drop the logits tensor reference immediately after `logitsToLabels`
  (delete from the outputs map; call `dispose()` if present) so the ~`nvox ×
  classes × 4`-byte tensor is GC-eligible right away.
- Enable threaded+SIMD WASM only when safe: `numThreads =
  crossOriginIsolated ? hardwareConcurrency : 1`, and add COOP/COEP headers to
  the Vite dev/preview servers so local dev gets the fast path. Offline ZIP
  (no headers) keeps today's single-threaded behavior.
- **Execution findings (2026-06-09):** the `growOverlayRef` unmount-nulling
  sub-item is a no-op and was not executed: the viewer already nulls the ref
  on every volume change, React releases fiber refs on unmount, and
  `workLabels` is *shared* with `generatedLabels` state (it becomes the label
  volume, not a duplicate of it), so the audit's "77 MB retained copy" claim
  was wrong. Additionally executed here: removed the dead post-extraction
  references (`onnxSegRunIdRef` etc.) that broke `tsc -b` at HEAD by moving
  volume-change segmentation invalidation into `useOnnxTumorSession`, which
  owns that state.
- Accept (amended): logits released promptly; ONNX thread count conditional on
  `crossOriginIsolated` with COOP/COEP on dev/preview servers; viewer ONNX
  type errors fixed; check green.

### P2 — Render/update path (interactive segmentation smoothness)

**T7. Render-on-demand RAF** — `SvrVolume3DViewer.tsx:1729-1841`
- Replace the free-running `requestAnimationFrame` loop with a dirty-flag
  scheduler: redraw on rotation/zoom/param/label-texture changes and on the
  settle frame from T2/T3. Idle viewer = zero GPU work.
- Accept: no RAF scheduled when idle (verifiable by instrumenting `draw`
  call count); all interactions still repaint; check green.

**T8. Label texture: dirty-region uploads + cached downsample + memoized
palette** — `SvrVolume3DViewer.tsx:1924-1973`, `renderLod.ts:309-341`
- Track a dirty bounding box for label edits (brush, grow preview) and upload
  only that sub-region via `texSubImage3D` instead of the full volume.
- Cache the downsampled label buffer; recompute only the dirty region instead
  of the full volume on every change.
- Memoize `buildRgbaPalette256` by `labels.meta`.
- Accept: brush stroke / grow tick uploads bytes proportional to the edit, not
  the volume; check green.

**T9. Slice inspector effect split + slice caching** —
`SvrVolume3DViewer.tsx:1264-1512`
- Split the single 250-line effect: (1) extract+downsample the slice (deps:
  volume, inspectIndex, inspectPlane), (2) composite labels/overlays (deps:
  labels, labelMix, labelsEnabled, seed/ROI). Cache the extracted slice between
  label-only updates.
- Accept: label-only changes do not re-extract the slice (instrumentable);
  rendering output unchanged; check green.

### P3 — CPU hot loops (reconstruction + interactive grow)

**T10. Reconstruction inner-loop tightening** — `trilinear.ts`,
`rigidRegistration.ts:265-312,470-487`, `reconstructionCore.ts:394`,
`reconstructVolume.ts:813-847`
- Hoist `nx`/`nx*ny` strides in trilinear sample/splat; inline the 8 splat
  writes.
- Reuse the two `RigidParams` probe objects across the coordinate-descent loop
  instead of spreading fresh ones per parameter per iteration.
- Preallocate registration sample buffers (no `push` + `Float32Array.from`).
- Yield tuning, amended after inspection: the real culprit was the yield
  *primitive* — `setTimeout(0)` chains hit the browser's nested-timer ~4ms
  clamp, which is why callers yielded sparsely. `yieldToMain` now prefers
  `scheduler.yield`, falling back to a clamp-exempt MessageChannel macrotask;
  refinement yields on a ~16ms wall-clock budget instead of an 8-slice stride;
  registration yields every ~5 evals (was 25).
- **Execution finding (2026-06-09):** the histogram-matching quantile remap is
  NOT optimized — it is doubly gated behind debug mode plus a
  `miraviewer:svr-histmatch` localStorage flag and runs once at load;
  optimizing a debug-only path is churn without user value.
- Accept (amended): registration/reconstruction tests pass with identical
  numeric output; check green.

**T11. Interactive grow loop tightening** — `costDistanceGrow2d.ts:62,
576-665`, `TumorSegmentationOverlaySeedGrow.tsx:495-573,668-692`
- Replace the plain-`Array` min-heap with a typed-array heap (Uint32 indices +
  Float64 distances so comparisons stay bit-identical), capacity-hinted by ROI
  area with geometric growth.
- Cache the edge-clearance BFS in a WeakMap keyed by the captured gray buffer
  (mirroring the existing `gradientCache` pattern) + dims + ROI, so
  tension-slider re-grows over the same capture skip the O(ROI) BFS. (The BFS
  output depends only on gray/dims/ROI; surfaceTension gates and scales the
  derived penalty, not the field.)
- **Execution finding (2026-06-09):** the "sorted-distance slider path"
  sub-item was already implemented on this branch — `areaThresholdsRef` gives
  O(1) slider→threshold and the recompute is already RAF-throttled
  (`TumorSegmentationOverlaySeedGrow.tsx:509-518,587`); the remaining per-move
  O(ROI) mask + marching-squares pass is irreducible if a contour is the
  output. No change made there.
- Also fixed here: the pre-existing `RobustStats` missing-type-import that
  broke `tsc -b` at HEAD (the type existed in `utils/stats.ts` but was never
  imported). `tsc -b` is now fully clean for the first time on this branch.
- Accept (amended): grow tests pass with identical output; BFS skipped on
  tension-only re-grows for the same capture; check green.

### P4 — Large lifts (sequenced last; each is its own review cycle)

**T12. Web Worker for SVR reconstruction** — `useSvrReconstruction.ts`,
`reconstructVolume.ts` (worker entry), transfer via `Transferable`
- Move `reconstructVolumeMultiPlane` into a dedicated worker; post progress
  messages; transfer the result volume back without copying. Cornerstone
  decode stays on the main thread (DOM dependency) — pass decoded slice
  buffers in as transferables.
- Accept: UI interactive during reconstruction; identical results; abort
  still works; check green.

**T13. Occupancy-grid empty-space skipping in the raymarcher** —
`glRaymarch.ts`, upload path
- Build a coarse (e.g., 1/8-res) max-value grid at volume upload; in the
  shader, skip blocks whose max < threshold floor. Combine with the existing
  early-ray termination.
- Accept: identical image for non-skipped content (max-grid is conservative);
  measurable step-count reduction; check green.
- **Execution notes (2026-06-10):** implemented as an 8³-block max grid,
  dilated over 3×3×3 neighbor cells (covers trilinear cross-block reach),
  ceil-quantized to u8 with +1 quantum headroom (covers R16F round-to-nearest).
  Shader reads cells via `texelFetch` (exact integer mapping, immune to the
  occupancy-grid padding mismatch a filtered `texture()` lookup would have)
  and leaps to the cell exit via per-axis positive distances (NaN-free for
  axis-aligned rays). The radial threshold ramp is handled by a per-cell
  threshold floor: `thr_floor = u_thr · saturate(r − 2·|cellSize_tc|)`, a
  Lipschitz bound on r's variation across one cell. Shader compile+link and
  all new uniform locations verified in real Chromium WebGL2 via a Playwright
  one-off. Conservativeness pinned by `tests/svrOccupancyGrid.test.ts`.

**T14. Sliding-window ONNX inference** — `tumorSegmentation.ts`,
`useOnnxTumorSession.ts`
- Patch-based inference (e.g., 128³ windows with overlap-blend) caps logits
  memory at patch size regardless of volume dims, replacing the preflight
  hard-block for large volumes. **Deferred-by-default:** requires the actual
  model's input-shape flexibility to be validated against a real ONNX file,
  which is not in the repo. Documented here as the follow-on; not executed in
  this pass unless a model file is available to test against.

## Execution order

T1 → T2 → T3 → T4 (single review for P0 batch) → T5 → T6 (review per task) →
T7 → T8 → T9 (review per task) → T10 → T11 (single review for P3 batch) →
T12 → T13 (review per task) → T14 deferred.

## Task log

| Task | Status | Review (model resolved / verdict) |
| ---- | ------ | --------------------------------- |
| T1   | done | claude-opus-4-8 (max effort) / PASS — transpose-flag inverse verified layout-agnostic; MSAA-off byte-identical for fullscreen triangle |
| T2   | done | claude-opus-4-8 (max effort) / PASS — note: DPR cap also applies at rest, explicitly mandated by the task |
| T3   | done | claude-opus-4-8 (max effort) / PASS — rest frames bit-identical (jitter×0); capture forces full quality |
| T4   | done | claude-opus-4-8 (max effort) / PASS — f16 conversion hand-verified incl. subnormals/Inf/NaN; budget conservative on u8 fallback |
| T5   | done (amended scope) | claude-opus-4-8 (max effort) / PASS — all recorded findings independently verified |
| T6   | done (amended scope) | claude-opus-4-8 (max effort) / PASS — COEP checked against all dev-server subsystems (same-origin); reviewer's "check red" caveat was a race with in-flight T8 edits, resolved by the post-T8/T9 green check |
| T7   | done (executed with P0 — same draw loop) | claude-opus-4-8 (max effort) / PASS — all 10 invalidation paths traced |
| T8   | done | claude-opus-4-8 (max effort) / PASS — dirty-marker single-consumption, texAllocated gating, conservative dst-range inversion, UNPACK reset, buffer-alternation safety all verified; no gaps |
| T9   | done | claude-opus-4-8 (max effort) / PASS — memo deps exact; palette nullability equivalence proven |
| T10  | done (amended scope) | claude-opus-4-8 (max effort) / PASS — integer-exactness of stride math, splat write order, probe-object minus-semantics all verified |
| T11  | done (amended scope) | claude-opus-4-8 (max effort) / PASS — heap fuzz-tested bit-identical (846k pops, 0 mismatches); BFS cache key proven to cover all inputs |
| T12  | done (via background agent) | claude-opus-4-8 (max effort) / PASS — verbatim-move verified against HEAD; worker bundle proven free of cornerstone/idb; bit-identical output test; abort/transfer/clone semantics all checked. Reviewer noted (non-blocking): `rigidRegistration.ts:536`'s exported `rigidAlignSeriesInRoi` is pre-existing dead code, candidate for a future compaction |
| T13  | done | claude-opus-4-8 (max effort) / PASS — conservativeness chain proven end-to-end (half-texel filter reach, Lipschitz threshold floor, leap containment, quantization headroom, GLSL legality, lifecycle) |
| T14  | deferred (needs model file) | — |
