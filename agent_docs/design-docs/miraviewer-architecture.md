# MiraViewer architecture and validation

This is the current developer guide. The [codebase audit](../exec-plans/active/2026-09-01-full-codebase-audit.md) records its pre-implementation findings; the [implementation ledger](../exec-plans/active/2026-09-02-full-codebase-audit-implementation.md) records changes, exact evidence and remaining acceptance gates. Older execution plans describe their own historical tasks, not the current application's complete behavior.

## Product and data ownership

MiraViewer is a client-side Vite/React/TypeScript application in `frontend/`. It compares locally imported DICOM acquisitions and supports native slices, physical alignment, reconstruction and annotation. HTTP serves the application and runtime assets; image parsing, calculation and storage happen in the browser. The offline Python launcher is a local static-file server, not an imaging backend.

Browser storage belongs to an origin and browser profile. `localhost`, `127.0.0.1`, different ports and different profiles have separate saved data. Clearing that origin's site data can remove scans and saved work. Keep original DICOM files and verified backups; a successful persistence request is not a backup.

The MRI database is the authority for imported source bytes and saved records. Accepted reconstruction provenance identifies the patient, examination, dataset revision, source SOPs and physical transforms. Display tone, source sampling, inferred detail and saved labels are distinct. A model proposal remains provisional until the selection owner validates support and hard marks and publishes it.

## Code map

Code-map paths below are relative to `frontend/src/`.

| Boundary                        | Main owners                                                                                                                                                                                 | Contract                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser database                | `db/schema.ts`, `db/db.ts`                                                                                                                                                                  | Studies, series, instances, panel settings, annotations, volume labels, derived frames and app state; schema version 7. Models use the separate `utils/segmentation/onnx/modelCache.ts` database.                                                                                                       |
| Import                          | `components/UploadModal.tsx`, `services/dicomIngestion.ts`, `services/archiveSafety.ts`                                                                                                     | Review local files, folders or ZIPs; admit displayable images and UID ownership; bounded ingestion batches and cancellation retain committed images.                                                                                                                                                    |
| Dataset/UI access               | `utils/localApi.ts`, `db/comparisonState.ts`, `db/comparisonIdentity.ts`, `db/panelSettings.ts`, `hooks/useComparisonData.ts`, `hooks/useComparisonFilters.ts`, `hooks/usePanelSettings.ts` | Read-only catalog/settings snapshots; explicit initialization and user writes own mutations. Verified source references bind settings to acquisitions. The ordering LRU is derived from storage and invalidated on mutation.                                                                            |
| Comparison shell                | `components/ComparisonMatrix.tsx`, `components/comparison/`                                                                                                                                 | Grid, overlay and 3D entrypoints, source context, filters and slice navigation.                                                                                                                                                                                                                         |
| DICOM display                   | `components/DicomViewer.tsx`, `utils/cornerstoneInit.ts`, `utils/decodedFrame.ts`                                                                                                           | `miradb:<SOP UID>` resolves stored bytes through Cornerstone/WADO. Processing may reuse decoded frames without inserting them into the browsing cache.                                                                                                                                                  |
| Alignment                       | `hooks/useAutoAlign.ts`, `utils/svr/runLongitudinalRegistration.ts`, `utils/alignmentScoringRunner.ts`, `utils/elastixRegistration.ts`                                                      | Accepted physical source geometry, worker-owned scoring, optional final refinement and the reachable single-frame/2D registration route.                                                                                                                                                                |
| Reconstruction/source admission | `components/Svr3DView.tsx`, `utils/svr/reconstructVolume.ts`, `utils/svr/acquisitionProvenance.ts`, `utils/svr/nativeVolume.ts`                                                             | Admit source identity and acquired support before native assembly or independent-acquisition reconstruction. Reuse accepted patient transforms for later crops.                                                                                                                                         |
| Native source access            | `utils/svr/nativeSourceContext.ts`                                                                                                                                                          | Retain immutable metadata and a completed acquisition-wide modality-intensity range with the accepted source. Each plan/load receives current memory measurements. No decoded acquisition is retained by this scalar cache.                                                                             |
| 3D display/editing              | `components/SvrVolume3DViewer.tsx`, `components/SvrSegmentationEditor.tsx`, `hooks/useSvrNativePlane.ts`, `hooks/useSvrSelection.ts`, `utils/svr/glRaymarch.ts`                             | Native planes, inferred detail and label overlays retain explicit coordinate/support ownership. Editing owns hard Add/Remove marks, undo/redo and publication.                                                                                                                                          |
| Learned proposal                | `utils/segmentation/interactiveSelection.ts`, `utils/segmentation/interactiveTrackingWorker.ts`, `utils/segmentation/interactiveTracking.worker.ts`, `utils/segmentation/efficientTam/`     | Verified EfficientTAM v2 assets, source-native prompts and fresh per-run tracking history. The accepted-source owner may retain an admitted idle runtime for 30 seconds. Cancellation, source/provider replacement and competing heavy work reclaim it; each correction has a separate message channel. |
| Heavy-operation preparation     | `components/svrImagingContext.ts`                                                                                                                                                           | One `operations.prepare(kind)` boundary quiesces the viewer, editor and accepted-source selection runtime and returns a retained-memory snapshot. Every heavy entry uses this boundary.                                                                                                                 |
| Optional custom model           | `hooks/useOnnxTumorSession.ts`, `utils/segmentation/onnx/`                                                                                                                                  | Verified uploaded-model manifests, source-grid inputs and output validation in a fresh module worker. Abort, 30-second initialization and 120-second execution deadlines terminate the worker. Provider-init failure may retry WASM only after the first worker has stopped.                            |
| Backup/restore                  | `components/ExportModal.tsx`, `services/exportBackup.ts`                                                                                                                                    | A versioned snapshot contains selected scans and saved work. Restore validates source relationships and payloads, then writes matching records and preferences. It can overwrite matching saved work.                                                                                                   |

## Display and alignment behavior

A pending slice keeps the previously accepted pixels and their source label visible. Lookup and decode have separate bounded waits. The mounted annotation subtree remains inert while pixels are pending; pan handlers and viewport focus remain stable. A failure names the requested slice and offers Retry. Retry reuses a still-pending decode and evicts only a settled failed decode. Annotations for a requested slice never attach interactively to retained old pixels. Overlay shortcuts accept the filmstrip's own date buttons, but leave other interactive controls, dialogs and consumed events alone.

Multi-frame alignment uses physical manifests and accepted patient-space transforms. Presented dates are a scheduling hint read before the next target, not part of request identity; flipping the overlay does not abort an in-flight registration. Optional final affine selection runs in a fresh final-ranking worker without initializing the legacy coarse search. Failure of optional final ranking preserves the accepted physical result, and the Elastix worker is disposed on every exit. The single-frame/2D path still uses its own scoring and ITK/Elastix registration. The old image-producing longitudinal runner is restricted to tests/browser acceptance for parity evidence; application callers use the pose-only estimate.

The 3D viewer defaults to **Exact source pixels**: nearest acquired samples, DICOM VOI window/inversion, an opaque section and no translucent tissue tint. An opaque nearer surface may occlude the section; an optional selection contour is separately identified. **Blend with anatomy** is an explicitly uncalibrated presentation option. Exact rays stop at the source section and can terminate at opaque foreground. Resident reformats prefer a valid DICOM display window and fall back to finite measured range. A failed native decode retains a previous same-source plane with an error notice; revoked ownership clears it. Invalid resident support produces a local notice, not a render exception. Sources more than 30 degrees from a cardinal plane are not mislabeled axial/coronal/sagittal.

Derived aligned frames are cached independently of original DICOMs. Eviction reads creation-ordered keys, and hydration narrows patient/revision/sequence/series before reading pixel payloads. Render admission still validates pixels, support and source provenance. `useApplyAlignmentResults.ts` preserves the user's reverse-slice preference when applying results.

For local alignment diagnostics, `localStorage.setItem('miraviewer:debug-alignment', '1')` enables detailed traces. Diagnostic output and fixtures may contain private context; keep them local and remove temporary tracing before shipping.

## Segmentation and resources

Auto-fill is available only when the accepted source supplies a compatible native proposal path. An independent-2D reconstruction remains brush-editable without exposing an incompatible Auto-fill control. Literal marks, categorical support and the saved label grid remain authoritative even when a model suggestion fails or is canceled.

Native assembly retains its 512 MiB policy. Learned and custom-model inference use a separate device-derived envelope: one quarter of reported device RAM, capped at 3 GiB, or 1.5 GiB when unknown. These are conservative admission policies, not available-RAM measurements or allocator limits. Custom admission reserves a 256 MiB runtime floor plus four times encoded model bytes, tensors, source copies and current retained owners/cache allowances. The initial 128 MiB floor undershot observed growth in the synthetic 128³/20 MiB renderer-memory run. Admission is measured on action, not on render; an earlier rejected estimate is advisory and may be retried after reclamation.

`interactiveAdmission.ts` measures complete literal-mark snapshots once. The same admitted runtime allowance travels to the worker owner; compressed prompts do not create a second estimate. Successful EfficientTAM jobs may retain compiled sessions for 30 seconds, while each correction gets fresh history and a message channel. Failure resets job state. `operations.prepare` releases that idle runtime before reconstruction, refinement, enhancement, model loading or custom inference. Custom workers are never retained. Full-volume anatomical quality and arbitrary-model memory guarantees are not established by synthetic acceptance tests.

## Source identity, settings and navigation

A comparison column's date string is display metadata, not durable ownership.
`getComparisonData` reads studies, acquisitions, index counts and app state in one
readonly IndexedDB transaction. It exposes all acquisitions. `initializeComparisonState`
runs explicitly on database open, accepted import and restore to initialize the selected
Series Instance UID under a Study UID/sequence key. The largest stack is an initial default;
importing a larger alternative does not silently change an existing choice. A stored
Study UID anchors patient selection when conservative grouping discovers a reused
patient identifier.

`db/panelSettings.ts` owns settings persistence. Canonical rows have explicit
Study/Series UID ownership, independent of date labels and patient-group keys.
Readonly hydration projects unambiguous legacy rows in memory. The first intentional
save materializes a canonical row and retains the original and its provenance.
Ambiguous settings require an explicit assignment in the Examinations
panel. Legacy volume-key migration is separate and remains an open audit item;
source-owned panel settings do not imply that every historical 3D key is migrated.

The content `dataset_revision` changes on import. The saved-work `dataset_token`
changes on restore and database recreation, not ordinary additive import. A settings
snapshot reads its token atomically with its rows and verifies source ownership once.
Each save uses that frozen verified source, checks the token and puts one row in a
two-store transaction (`app_state`, `panel_settings`); it does not scan studies again.
Failed hydration grants no write permission but permits ephemeral browsing and local
adjustments. Retry loads persisted settings without saving those defaults. Dates without
a selected source cannot write legacy rows. Replacement retires mounted callbacks/history, while stale queued or
cross-tab writes are rejected by the database check. Retry refreshes the catalog
before loading settings again. Unload only flushes pending progress and changed
automatic baselines needed to retain manual correction intent.

Overlay selection and comparison history store examination identity, deriving list
indices for display. Global wheel, slice playback and the footer use one reference:
the first full-stack Grid acquisition or a selected full-stack Overlay acquisition,
falling back to a localizer only when no full stack exists. The footer names
that reference and reports acquired slice ordinals, including offset/reverse mapping.
Acquisition/catalog refreshes preserve shared browsing progress; a patient/sequence
change or restored saved-work generation hydrates its saved progress.

## Run and validate

For a fresh checkout, run `git lfs install` and `git lfs pull`, then `cd frontend && npm ci`. Pinned public ONNX assets are LFS-managed; model verification explains unresolved pointers and never silently downloads replacements. Existing workspaces should preserve their active services and concurrent work.

| Command, from `frontend/`                                     | Purpose                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                 | Development server, fixed port 43124; an occupied port fails rather than selecting a new origin.                                               |
| `npm run lint`                                                | ESLint.                                                                                                                                        |
| `npm run test -- --maxWorkers=2`                              | Complete Vitest suite with bounded local concurrency. Optional private/diagnostic corpora may be skipped.                                      |
| `npm run test -- tests/dicomIngestion.test.ts --maxWorkers=2` | Example focused test.                                                                                                                          |
| `npm run check`                                               | Lint and Vitest using the repository's configured pool.                                                                                        |
| `npm run build`                                               | Verify pinned model assets, typecheck app/config/browser harness project references, build production output, then verify copied model assets. |
| `npm run build:browser`                                       | Build app plus acceptance-only probes with source/model fingerprints into `tmp/browser-dist`.                                                  |
| `npm run test:browser`                                        | Isolated built-app import, navigation, outline, reload and fresh-context restore.                                                              |
| `npm run test:gpu`                                            | Actual production-shader pixel checks; the receipt identifies the renderer.                                                                    |
| `npm run test:performance`                                    | Real worker responsiveness and large derived-frame storage boundary measurements.                                                              |
| `npm run test:inference`                                      | Real pinned model, synthetic multi-plane prompt snapshot, verified offline cache, cancel and fresh-worker recovery.                            |
| `npm run preview`                                             | Preview the production build.                                                                                                                  |
| `npm run package:zip`                                         | Build `release/MiraViewer.zip`, including the local HTTP launcher.                                                                             |

Browser checks require the Playwright Chromium installation (`npx playwright install chromium`). Run `build:browser` after source changes: the harness rejects stale output. It uses a disposable profile and strict port 43134, never an existing user's MRI origin. Scripts set `PLAYWRIGHT_HTML_OPEN=never` and a terminal reporter. For direct Playwright calls, preserve both settings. Receipts live under `tmp/browser-results`; preserve originals in ignored `artifacts/` before another run replaces temporary output. Only curated, path-scrubbed receipts and explicitly reviewed synthetic images belong in `agent_docs/evidence/`. `.baton/`, raw process traces and generated fixture directories remain local. Production/offline builds omit the probe entrypoint.

Use one heavyweight local build/test/model run at a time on shared workstations. Unit tests prove their exercised contracts, not real browser/GPU/model behavior. A SwiftShader pass is software pixel evidence. Synthetic model fixtures prove execution, lifecycle and measured output parity, not anatomical segmentation quality. Exact receipts and any skipped gates belong in the implementation ledger.

## Supported delivery paths and current limits

Development and Vite preview send cross-origin-isolation headers. The offline launcher serves a stable `http://127.0.0.1:43125/` origin with the required WASM MIME types and isolation headers. Keep that origin stable to retain access to saved scans. The Vercel configuration builds `frontend/dist`; matching hosted isolation headers still need work. Git LFS must be enabled in the Vercel project's Git settings (enabled and read back for MiraViewer on September 3). This applies to subsequent deployments, not the already deployed bundle. See [Vercel's Git LFS settings](https://vercel.com/docs/project-configuration/git-settings). Runtime assets are served from the application origin, including ORT/WASM, ITK pipelines and pinned model files.

Patient-scoped backups include only owned acquisition preferences and an owned selected-study anchor. Restore ignores foreign acquisition rows even in older backups. A live settings-writer token is never imported from a backup.

Full-backup restore currently admits at most **512 MiB of declared payloads**, while export can create a larger archive. Export and restore still materialize substantial data with JSZip. Keep original images, check backup capacity and verify restoration before relying on a backup. Streaming export and staged large restore remain open work; the guide does not imply they have been implemented.

Legacy volume-key migration, legacy geometry enrichment, warm native rendering and sparse edit persistence remain active audit work. The source-owned settings and acquisition picker have their own linked regression and browser evidence. The implementation ledger is the status authority; old plans and old test totals are historical evidence.

## Private fixtures

`Critical MRI Source Images (LLM Agent - do not delete)/` is protected local test data. Preserve it and keep identifiers, MRI pixels, derived patient artifacts and private benchmark media out of commits and public receipts. Repository browser checks use synthetic data.
