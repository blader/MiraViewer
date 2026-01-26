# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Repo entrypoints
- This repo is primarily a single Vite + React + TypeScript app in `frontend/`.
- There is no backend: all DICOM data is stored locally in the browser (IndexedDB) and all processing/rendering happens client-side.

## Common commands (run from `frontend/`)

### Install
```bash
cd frontend
npm install
```

### Dev server
```bash
cd frontend
npm run dev
```
Notes:
- Dev server runs on a fixed port **43124** (see `frontend/scripts/dev.mjs` + `frontend/vite.config.ts`). If the port is taken by something else, `npm run dev` will fail rather than auto-increment.

### Lint
```bash
cd frontend
npm run lint
```

### Tests
```bash
cd frontend
npm run test
```
Run a single test file:
```bash
cd frontend
npm run test -- tests/dicomIngestion.test.ts
```

### “CI-style” check (lint + tests)
```bash
cd frontend
npm run check
```

### Production build
```bash
cd frontend
npm run build
```
This runs TypeScript project references (`tsc -b`) and then `vite build`.

### Preview production build locally
```bash
cd frontend
npm run preview
```

### Build the offline runnable ZIP
```bash
cd frontend
npm run package:zip
```
Output:
- `frontend/release/MiraViewer.zip`

## High-level architecture

### Data model + persistence (IndexedDB)
The browser database is the “source of truth” for all imported scans.
- Schema/types: `frontend/src/db/schema.ts`
- DB open/upgrade + indexes: `frontend/src/db/db.ts`
  - Object stores: `studies`, `series`, `instances`, `panel_settings`
  - Notable index: `instances` has `by-series-instanceNumber-uid` so code can fetch ordered SOPInstanceUIDs without reading Blob payloads.

App state that’s *not* MRI data is stored separately:
- LocalStorage keys/cookies are centralized in `frontend/src/utils/storageKeys.ts`.
- Filters/UI state are persisted via `frontend/src/utils/persistence.ts`.
- “Delete all data” flow lives in `frontend/src/components/ClearDataModal.tsx` (deletes IndexedDB + relevant localStorage/cookies).

### Import pipeline (DICOM ingestion)
- UI: `frontend/src/components/UploadModal.tsx`
- Ingestion logic: `frontend/src/services/dicomIngestion.ts`
  - Parses DICOM via `dicom-parser`.
  - Skips non-displayable DICOM objects early (no pixel data / missing required tags) to avoid broken slices and wasted IndexedDB space.
  - Dedupes by SOPInstanceUID before storing Blob payloads.

### “Local API” layer (data access for the UI)
Most UI components do not query IndexedDB directly; they call the local API functions:
- `frontend/src/utils/localApi.ts`
  - Aggregates `ComparisonData` used by the main UI (planes/dates/sequence-combos + `series_map`).
  - Provides `getImageIdForInstance(seriesUid, instanceIndex) -> "miradb:<sopInstanceUid>"`.
  - Uses a small in-memory LRU cache for per-series instance ordering (important for smooth scrolling).

### Rendering pipeline (Cornerstone)
Cornerstone is initialized once on app startup:
- Startup: `frontend/src/main.tsx` calls `initCornerstone()` and `initStoragePersistence()`.
- Cornerstone custom loader: `frontend/src/utils/cornerstoneInit.ts`
  - Registers a `miradb:` image loader that pulls the instance Blob from IndexedDB, then delegates parsing/rendering to `cornerstone-wado-image-loader`.

The viewer component:
- `frontend/src/components/DicomViewer.tsx`
  - Resolves `miradb:<uid>` via `getImageIdForInstance`.
  - Uses Cornerstone to display, but intentionally keeps the previous slice visible while the next slice loads to avoid “black flashes”.
  - Exposes an imperative handle to capture the currently visible viewport (`captureVisiblePng`) for downstream features (AI).

### Main UI (comparison matrix)
The whole app is currently a single-page experience:
- Root component: `frontend/src/App.tsx` → `frontend/src/components/ComparisonMatrix.tsx`
- `ComparisonMatrix` orchestrates:
  - Loading dataset summary: `frontend/src/hooks/useComparisonData.ts` (calls `getComparisonData()`)
  - Plane/sequence/date filtering + persistence: `frontend/src/hooks/useComparisonFilters.ts`
  - Per-date viewer settings + undo/redo + persistence: `frontend/src/hooks/usePanelSettings.ts`
  - Two view modes:
    - Grid: `frontend/src/components/comparison/GridView.tsx`
    - Overlay (toggle between dates / “hold to compare”): `frontend/src/components/comparison/OverlayView.tsx`
  - Global slice navigation + playback loop UI: `frontend/src/components/comparison/SliceLoopNavigator.tsx`

### Auto-alignment (Elastix / ITK-Wasm)
Auto-alignment is a client-side pipeline used to align all dates to a chosen reference slice.
- Orchestrator hook: `frontend/src/hooks/useAutoAlign.ts`
  - Renders slices to grayscale pixel buffers via offscreen Cornerstone rendering.
  - Coarse slice search uses mutual information; refinement uses elastix affine registration.
- Registration runner + worker/pipeline handling: `frontend/src/utils/elastixRegistration.ts`
  - Forces ITK/Elastix pipeline assets to be loaded from same-origin `dist/pipelines` (vendored during build).
  - Timeouts worker init / registrations so failures surface as actionable errors rather than “hanging”.
- Applying results to UI state: `frontend/src/hooks/useApplyAlignmentResults.ts`
  - Applies computed settings per-date while preserving the user’s `reverseSliceOrder` preference.

Debugging alignment:
- Set `localStorage.setItem('miraviewer:debug-alignment', '1')` to enable very verbose per-stage logs (see `frontend/src/utils/debugAlignment.ts`).

### AI annotation (currently feature-flagged off)
- Feature flag: `AI_ENABLED` in `frontend/src/utils/constants.ts` (defaults to `false`).
- Flow:
  - UI triggers `useAiAnnotation` (`frontend/src/hooks/useAiAnnotation.ts`).
  - Captures the viewer viewport via `DicomViewerHandle.captureVisiblePng()`.
  - Calls `runAcpAnnotateClient` (`frontend/src/utils/aiClient.ts`) which:
    - Calls Google’s Generative Language API from the browser.
    - Uses env vars like `VITE_GOOGLE_API_KEY` / `GOOGLE_API_KEY` (see `frontend/.env.example`).
    - Can override model names with `VITE_GEMINI_ANALYSIS_MODEL` and `VITE_NANO_BANANA_PRO_MODEL`.

## Offline runnable build (ZIP) structure
- `npm run package:zip` builds the Vite app and stages a runnable folder using templates in `frontend/distribution/`.
- The ZIP includes `run_miraviewer.py`, which serves the built files over a local HTTP server (avoids `file://` issues and sets correct MIME types for `.wasm` / `.zst`).

## Deployment (Vercel)
- Root `vercel.json` config:
  - Build command: `cd frontend && npm install && npm run build`
  - Output directory: `frontend/dist`

## Local test data
- `Critical MRI Source Images (LLM Agent - do not delete)/` contains MRI source image folders used for manual testing and should not be deleted.