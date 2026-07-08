# Trim plan (transient execution checklist)

Anchor: merge-base a0c40d9 vs HEAD (b9e2cf0). Baseline: 99 files, +20,680 / −609.

## Pass 1 — ranked PR-wide cuts (all verified behavior-preserving)

### Dead subgraph elimination (verified zero external importers)
1. Delete `frontend/src/components/SvrModal.tsx` (~790) — no importers; live path is
   Svr3DView → SvrVolume3DViewer.
2. Delete `frontend/src/components/SvrVolume3DModal.tsx` (~37) — only importer is
   SvrModal (dead).
3. Delete `frontend/src/services/svrHarness.ts` (~86) — zero references anywhere.
4. Remove the unreachable harness-capture machinery from `SvrVolume3DViewer.tsx`:
   `rgbaToPngBlob`, `pendingCapture3dRef`, the draw() readback block, the
   `useImperativeHandle` (capture3dPng/applyHarnessPreset) and the forwardRef wrapper —
   no caller passes a ref (Svr3DView renders it plain).
5. Remove `previews` from the SVR result path: only consumers were SvrModal + svrHarness
   (both dead). Delete `volumePreview.ts` (~109), the generateVolumePreviews call +
   progress step in `reconstructVolume.ts`, and the `previews` field/type in `types/svr.ts`.
6. Delete the dead exported `rigidAlignSeriesInRoi` (+ JSDoc) at the tail of
   `rigidRegistration.ts` (~213 lines) — superseded by the live local version in
   `svrComputeCore.ts`; zero importers. Prune any imports orphaned by the cut.

### Top DRY opportunities (same rule in 2+ places)
7. `quantileSorted` triplicated: keep the `svrUtils.ts` export; replace identical local
   copies in `svrComputeCore.ts` and `Svr3DView.tsx` with imports.
8. `formatMiB` duplicated: keep the `svrUtils.ts` export; replace the identical local
   arrow in `svrComputeCore.ts`.

### Deferred to next pass (need full reads first)
- Full-diff read of Svr3DView.tsx, TumorSegmentationOverlaySeedGrow.tsx,
  regionGrow3D_v2.ts, phaseCorrelation.ts, ssim.ts, alignment.ts, useAutoAlign.ts,
  comparison components, GroundTruthPolygonOverlay.tsx for cross-file duplication
  (sampling/stats helpers, polygon remap logic, canvas overlay scaffolding).

## Validation per pass
prettier on touched files; eslint; npm run check (vitest); tsc -b --force; vite build.

## Pass 1 results
(to fill after re-measurement)
