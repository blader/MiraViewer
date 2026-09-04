# CTO architectural review: working tree on `blader/siqi-chen/segmentation-sampled-plane-pruning`

> Historical review input. See the [remediation ledger](2026-09-02-full-codebase-audit-implementation.md) for current status. Workstation paths were redacted; the original is preserved in ignored local authoring evidence.

**Reviewed:** 2026-09-03. **Revision:** working tree against HEAD `5f0efa4` (which equals `origin/main`; no commits ahead, no open pull request on this branch). **Scope:** 158 tracked changes (69 production files, +3,205/−5,761 production lines) plus 88 untracked paths, including 7 untracked production files (580 lines), the EfficientTAM v2 model directory, a Playwright browser harness, 16 planning documents, and 36 MB of receipts and synthetic fixtures under `artifacts/`. Read-only review: nothing in the tree was modified.

**Method.** Full lint, typecheck, unit suite, and production build were run on this tree (see Appendix A). Four independent subsystem passes (segmentation/inference, SVR native plane and 3D viewer, viewer/settings/storage, alignment) read every changed production file in their boundary and followed live callers into unchanged code. Each CONFIRMED finding below was re-verified in the source by the root reviewer. A second-opinion pass by an independent model was asked to refute the ten highest-leverage diagnoses; its verdicts are recorded per finding under "Second opinion".

## Verdict

This tree is a substantial, mostly well-reasoned consolidation: it deletes 5.7 k lines of unreachable segmentation code, moves alignment scoring and custom-model inference off the main thread, gives panel settings a stable source-owned identity, makes derived-frame bookkeeping key-only, and adds a real built-app acceptance harness. Request identity, cancellation fencing, and late-result protection are consistently correct across all four boundaries; that is the hardest part and it holds.

It is **not mergeable as is**, for four reasons that are architectural rather than cosmetic:

1. **Ownership verification was placed in the wrong boundary.** Patient/series ownership is now re-proven inside every settings write and every read, so reads became writers, every settings commit (each pan release, each zoom tick) opens a four-store readwrite transaction with a full studies scan, and a single failed read locks the 2D stage (Findings 1, 5).
2. **The 3D MRI plane has no exact display path while part of the UI still promises original pixels** (Finding 2). The exact path was deleted along with its pixel tests.
3. **Custom-model admission merged two unrelated budgets** and now rejects ordinary volumes HEAD admitted; the second opinion puts the new ceiling near 70³ (Finding 3).
4. **The tree is not a coherent PR.** It mixes at least three sessions' work (v2 memory preflight, the September audit implementation, the recovery baton), carries private absolute paths in 23 files, replaces 75 MB of tracked model binaries without LFS, and ships process logs as documentation. The ledger and architecture guide contradict the code in both directions (Finding 9).

The good news is that the fixes are small and local. The three P0 correctness items are each a one-boundary change; the structural items (heavy-operation ownership, read/write separation) delete concepts rather than add them.

## Architecture as it actually is

**Storage and identity.** `getComparisonData` (`frontend/src/utils/localApi.ts:163`) reads studies, series, index counts, and app state in one IndexedDB transaction, anchors the selected patient by Study UID, exposes every acquisition per date (`series_candidates`) and the chosen one (`series_map`), and persists the choice under `acquisition:<studyUid>:<comboId>`. A `dataset_token` (`db.ts:204`) is minted after open and rotated only by restore. `db/panelSettings.ts` owns settings rows keyed by `source:<seriesUid>` with explicit Study/Series UID ownership; unambiguous legacy `<patient>::<combo>` rows are migrated in place during hydration and ambiguous ones are surfaced for manual assignment. `usePanelSettings` carries a `SettingsOwner {patientKey, sequenceId, datasetToken, sourcesKey}`; `settingsReady` gates the stage, navigation, and all writers.

**Display.** `DicomViewer` lost its imperative capture handle and gained separate bounded waits for lookup and decode with a retry path (`utils/imageLoadDeadline.ts`). While `displayedContentKey !== contentKey` it hides overlays and pan. Overlay navigation now stores examination identity (Study UID) and derives indices.

**Alignment.** `useVisibleAlignment` builds a `requestKey` from reference geometry, viewport, output mode, generation, and the target list; any key change aborts and reschedules. `useAutoAlign` is the single engine: one `AbortController` per run, controller-identity guards on every publish, and `physicalRegistrationsRef` as the sole accepted-pose authority. Cold targets go through a pose-only `estimate` worker call (no discarded coarse pixels), native dense presentation, optional elastix residual, and a fresh scoring worker for final ranking. Coverage-only reverse scoring is numerically identical to the old full score (asserted in `tests/perceptualSliceSimilarity.test.ts:108`).

**SVR native plane and 3D.** One anatomical cursor drives an acquired-source plane (`useSvrNativePlane`, single-flight `NativeFrameCache`, 32 MiB LRU) or a resident-grid reformat (`makeVolumePlaneData`). Request identity `{volume, source, frame, frameIndex}` is memoized and late results are dropped. Source-context metadata is a frozen `structuredClone` retained for the accepted-source lifetime; the acquisition-wide intensity range survives corrections. The GPU binding re-uploads only on `image` identity change. Retained-memory accounting for admission flows through three ref registries.

**Segmentation.** `useSvrSelection` owns marks, undo/redo, and publication. `Svr3DView` owns a per-accepted-source `selectionOwner` with one `InteractiveTrackingWorker` whose compiled ORT sessions survive a successful job for 30 s (`interactiveTrackingWorker.ts:274`). Each job gets a fresh `MessageChannel`, request id, and tracking history; any error, cancel, source/provider change, reconstruction, refinement, enhancement, or custom-model run terminates the worker. Custom ONNX inference runs in a one-shot Worker (`customModelWorker.ts:104`) with init/run deadlines and termination-owned cancellation. The v2 EfficientTAM attention graph processes 64 query rows per chunk; the manifest's `queryChunking` block is cross-checked by the exporter and by unit tests, and `npm run build` verifies the copied assets.

## Findings

Ranked by user harm, then architectural leverage. Labels: **CONFIRMED** = statically demonstrated on a reachable production path and re-verified by the root reviewer; **PLAUSIBLE** = reachable but the counterexample depends on timing or data not reproduced here; **QUESTION** = a contract decision the authors should make explicit.

### P0: incorrect or blocking user-visible outcomes

#### 1. A settings read failure now locks out viewing, not just editing. CONFIRMED, introduced

- **Contract.** Saved work must survive failures; viewing scans should not depend on viewer-settings availability (AGENTS.md).
- **Path.** `getPanelSettingsSnapshot` throws on ownership mismatch (`frontend/src/db/panelSettings.ts:81`, `:138`), on `DatasetReplacedError`, or on any IndexedDB error → `usePanelSettings.ts:435` catch reports the failure and leaves `settingsOwner` null → `settingsReady` false (`:101`) → `ComparisonStage` receives `inert` (`ComparisonMatrix.tsx:56-60`) and `interactionBlocked` reaches `SliceLoopNavigator` and `useComparisonWorkspaceNavigation` (`:183`, `:438`).
- **Counterexample.** A `QuotaExceededError` during hydration, or a second tab that observed a restore. Images render but wheel, pan, zoom, overlay, and keyboard are dead until "Retry settings" succeeds. Header mode/date controls and the 3D view stay usable, so this is a 2D-stage lockout. HEAD degraded to defaults (with a silent-overwrite risk); this tree flipped to lockout.
- **Cause.** "Can I write" and "can I browse" were collapsed into one flag. `canWrite()` (`:107`) already expresses the write gate on its own.
- **Fix.** Keep the stage interactive; on read failure render defaults as ephemeral (not registered as baseline or saved) and leave only the writer disabled. Drop the `inert` and the `interactionBlocked || settingsReady === false` couplings.
- **Proof.** A `usePanelSettings` test where the snapshot rejects, asserting `settingsReady` false, `canWrite()` false, and navigation still enabled.
- **Second opinion.** AGREE. Confirms the catch at `usePanelSettings.ts:435` installs no defaults and grants no owner, and that HEAD's catch installed defaults and then set an owner.

#### 2. The 3D MRI plane has no exact display path, and the UI copy is inconsistent about it. CONFIRMED, introduced

- **Contract.** The plane is the fidelity anchor. Provenance copy: "MRI plane shows original pixels" (`SvrVolume3DViewer.tsx:2506`); settings copy: "The MRI cross-section is blended into the complete model" and "original pixels stay unchanged" (`:2769-2772`). Window/level controls on the plane imply a calibrated mapping.
- **Path.** `glRaymarch.ts:812` returns `vec4(color, 0.7)` for the section; `:1066-1072` composites `accum = context + (1 − contextAlpha) · (section.rgb · 0.7 + 0.3 · accum_far)` with `contextAlpha = min(frontAlpha, 0.22)`.
- **Counterexample.** A plane pixel with windowed value 1.0 and nothing behind it renders at 0.7; a black plane pixel over bright far tissue renders non-black; up to 22 % of foreground tissue is added on top. No window/level setting can produce the requested mapping on screen.
- **Cause.** The previous exact mode (cutaway at `t0`, `outColor = nativeSection`) was deleted together with its `Cutaway` uniform, and the section was made translucent so the full model stays visible. The only remaining opaque path is `cutSurface` (`glRaymarch.ts:716`, `:862`), which shows interpolated volume samples, not acquired pixels, and `sectionMode` makes it mutually exclusive with the MRI slice (`SvrVolume3DViewer.tsx:862`). So no exact source-pixel path remains. The GPU pixel tests that guarded this (`native-cutaway pixel tests` in `tests/svrNativePlane.test.tsx`) were deleted, not replaced.
- **Fix.** Keep the blended composite as a presentation mode but restore an exact path: when the ray reaches the section before any opaque sample, emit `section.rgb` unblended (section alpha 1.0 and terminate at `nativeT`). Alternatively change the copy to say "blended into the model" and remove the calibration implication from the window sliders. The first option is the one that matches the product contract.
- **Proof.** A `test:gpu` probe rendering a known-value plane facing the camera and asserting the framebuffer equals `windowed(value)` exactly.
- **Second opinion.** PARTIAL. Agrees that screen luminance is never the calibrated windowed value and that no exact acquired-pixel path exists; notes the settings dialog does disclose blending and that "original pixels" is accurate as buffer provenance. The residual defect is that the provenance line and the window controls imply exact display while nothing delivers it. Decide the contract, then make copy, shader, and test agree.

#### 3. Custom-model admission merged two unrelated budgets and now rejects volumes HEAD admitted. CONFIRMED, introduced

- **Contract.** An uploaded model that fits should run; the ledger describes the change as "conservative model-session admission" (F13), not a capability reduction.
- **Path.** `useOnnxTumorSession.ts:161-196` adds `customModelRuntimeBytes` (128 MiB + 4 × model bytes, `customModelWorker.ts:39`), `getRetainedBytes()`, and `retainedDerivedAlignmentBytes()` into `retainedBytes`, doubles preprocessing to 8 B/voxel plus support (charged as model tensors, `customModelWorker.ts:44`), still charges the full Cornerstone cache *capacity* (256 MiB default) rather than usage, and compares against the unchanged 512 MiB `SVR_MEMORY_BUDGET_BYTES` (`svrMemoryPlan.ts:2`). HEAD (`git show HEAD:frontend/src/hooks/useOnnxTumorSession.ts` lines 222-260) had none of the new fixed terms.
- **Counterexample.** Fixed charges before any voxel: 256 MiB cache capacity + 128 MiB floor + 4 × model (208 MiB for a 20 MiB model) + at least 32 MiB native-plane allowance (`nativeVolume.ts:49`), leaving about 16 MiB of the 512 MiB budget. The subsystem pass estimated the admitted volume at about 102³; the second opinion, adding the native-plane term, puts it at roughly 70–74³ before editor, derived-frame, and source-plane extras. HEAD admitted roughly 177–185³. A supported native 128³ volume is about 590 MiB under the new accounting and is rejected.
- **Cause.** The 512 MiB budget belongs to the native assembler. A model-runtime allowance was bolted onto it, and cache capacity is charged for a worker that never inserts into the cache.
- **Fix.** Give custom inference its own device-derived envelope like `interactiveSelectionBudgetBytes`, or drop the cache-capacity charge and replace the 4× multiple with a measured allowance.
- **Proof.** A unit test asserting a 128³ / 20 MB case is admitted, plus a browser receipt of actual worker peak for calibration.
- **Second opinion.** PARTIAL, in the direction of *worse*: the accounting terms are as described, preprocessing is charged as tensors rather than retained bytes, and the admitted size is roughly 70–74³, not 102³. The diagnosis understated the regression.

#### 4. `imagePending` unmounts overlays and toggles pan capability on every slice change. CONFIRMED, introduced

- **Contract.** A pending slice keeps previous pixels visible; annotation drafts and saved overlays should not be destroyed by navigation.
- **Path.** `DicomViewer.tsx:609` renders `{children && !imagePending ? … }` and `:438` sets `onPanChange` to `undefined` while pending. `imagePending` (`:362`) is true from the moment `contentKey` changes until the new image reports.
- **Counterexample.** With the polygon tool open, a stray wheel tick unmounts `GroundTruthPolygonOverlay` (its `draftPoints` state is destroyed, not reset), the saved-segmentation overlay refetches from IndexedDB on remount, a `Suspense` fallback flashes, and `canPan` flips `tabIndex`/cursor each step.
- **Cause.** Mount/unmount is being used as the "not yet consistent" signal instead of a prop.
- **Fix.** Keep children mounted; pass `pending` (or `aria-busy` and `pointer-events: none`) and let overlays decide. Keep `onPanChange` bound and ignore updates while pending.
- **Proof.** An overlay test asserting component identity and draft state persist across a slice change.
- **Second opinion.** AGREE.

### P1: root causes with several manifestations

#### 5. Settings ownership is verified at the wrong boundary: reads became writers and writes became O(studies). CONFIRMED, introduced

Two manifestations, one cause.

- **Reads write.** `getComparisonData` opens `readwrite` (`localApi.ts:167`) and puts patient anchors and acquisition choices on every load including background reloads (`:195`, `:198`, `:261`). `getPanelSettingsSnapshot` opens `readwrite` on four stores (`panelSettings.ts:54`) and `store.put`s migrated legacy rows (`:118-128`). Hydration is no longer idempotent or retry-safe under quota failure, two hydrations serialize on a wide lock, and the migration decision depends on whatever `sources` the caller passed.
- **Writes re-prove ownership.** `savePanelSettings` (`panelSettings.ts:146-199`) opens a four-store readwrite transaction and runs `studies.getAll()`, `series.get`, and `getPatientIdentityKeys` per call. `updatePanelSetting` (`usePanelSettings.ts:529`) calls it synchronously with no debounce. Pan drags preview locally and commit once on `pointerup` (`DicomViewer.tsx:94-101`), so a pan costs one such transaction per gesture; Cmd+wheel zoom commits per wheel event (`:381-386`), so a zoom costs one per tick. At HEAD each write was one get and one put on one store (`git show HEAD:frontend/src/utils/localApi.ts` lines 330-352). Every write now contends with any concurrent import writing the same stores. Ledger F3 ("keep small edits small") is still pending; this moves the wrong direction.
- **Cause.** Ownership (series → study → patient) is already proven once at hydration (`panelSettings.ts:74-83`). Re-proving it on every read and write means the hook has no trusted owner to bind to.
- **Fix.** Make both snapshot reads `readonly`. Bind the verified `SeriesRef` into `SettingsOwner` at hydration and let writes check only the dataset token plus a put on `panel_settings`. Move legacy migration and the "largest stack default" write into one explicit, versioned, idempotent step (F12 already plans "versioned idempotent stored-geometry enrichment"; this belongs there), or migrate lazily on first save for that source.
- **Proof.** `localApi.test.ts` asserting read paths open readonly transactions; a zoom test counting IndexedDB transactions and stores per wheel tick.
- **Second opinion.** PARTIAL on both halves. Reads: agrees both nominal reads are writers, but notes the puts are guarded by changed/missing state and migration records `legacyOrigin`, so they are operationally idempotent even though not readonly. Writes: agrees the per-write cost and four-store scope; corrected the trigger from per-`pointermove` to per-release for pan and per-event for Cmd+wheel zoom (incorporated above).

#### 6. Heavy-operation admission has three registries, two divergent "quiesce" routines, four reclaim call sites, and one estimate computed twice. CONFIRMED, introduced

- **Evidence.** `registerEditingMemory` (`SvrVolume3DViewer.tsx:399`), `enhancementDisplayRef`, and `viewerMemory` (`:742`) each sum bytes for admission. `runOnnxSegmentation` (`:710`) releases the selection runtime, cancels enhancement, then `prepareHeavyOperation`; `viewerMemory.prepare` (`:735-741`) cancels ONNX and enhancement but does **not** release the selection runtime. Idle-runtime reclaim happens separately in `startReconstruction`, `refineRegion`, `loadEnhancementSource` (`Svr3DView.tsx:1271`, `:1296`, `:1348`) and in the ONNX handlers. `useSvrReconstruction.run` grew to five positional parameters with `undefined` passed at the call site, and `retainedDerivedAlignmentBytes()` is now always charged (`useSvrReconstruction.ts:151`) where it was refinement-only, a quiet tightening for first reconstructions. Admission uses `literalMarkCount = foreground + background` (`interactiveSelectionContext.ts:127`) but the worker wrapper re-estimates the same job from compressed prompt-point count (`interactiveTrackingWorker.ts:204-218`) and stores that as `retainedBytes`, which the next admission consumes (`Svr3DView.tsx:1477`, `:1495`, `:1519`). One fact, two authors, off by roughly (literal − prompts) KiB.
- **Why it matters.** Correct today only because every call site happens to agree. The next owner added (native-plane cache growth during the 30 s idle window is already unfenced) will be missed by one of the lists.
- **Fix.** One heavy-operation owner in the imaging context: `prepare(kind)` cancels every other owner, disposes the idle selection runtime, and returns the retained-bytes snapshot. Reconstruct, refine, ONNX run, and enhancement call it instead of assembling lists. `admit()` passes its estimate into `run()` and the wrapper's re-estimate is deleted. Three concepts become one.
- **Proof.** A viewer test asserting that every heavy entry point releases the idle selection runtime and that the retained figure equals the admitted figure.
- **Second opinion.** Not submitted for refutation (structural, not a claimed defect); evidence is the cited call sites.

#### 7. Presentation order is encoded in alignment request identity, so overlay flips abort offscreen registrations. PLAUSIBLE, introduced

- **Path.** `ComparisonMatrix.tsx` passes `presentedDates = [overlaySelectedDate, overlayCompareDate]`; `useVisibleAlignment.ts:118` folds `targetDates.filter(presented)` into `requestKey`; the effect cleanup calls `abort()` on any key change (`:167`).
- **Counterexample.** Five dates enabled; the user flips the overlay compare date while an offscreen cold `runLongitudinalEstimate` (up to 120 s) is running. Each flip changes `compareTargetIndex`, changes the key, aborts the offscreen registration, and restarts it after the warm replays. Accepted models survive in `physicalRegistrationsRef`, so only in-flight work is lost, but under rapid browsing an offscreen date can restart indefinitely. HEAD did not include presentation in the key.
- **Fix.** Keep `requestKey` free of `presentedDates`; pass the presented set through a ref read at scheduling points (the engine reads `presented` only at `useAutoAlign.ts:282` and `:381`).
- **Proof.** `useVisibleAlignment.test.tsx` case asserting a presented-only change does not call `abort` while a cold target is mid-registration.
- **Second opinion.** AGREE. Changing the compare target aborts the whole active run, including offscreen work, then schedules a replacement.

#### 8. Default window for native-domain volumes changed from the DICOM VOI to full min–max. PLAUSIBLE, introduced, possibly intended

- **Path.** `volumeDisplay.ts:15` `defaultVolumeWindow` prefers `intensityRange` over `displayWindow` for `native-3d` / `source-stack`, while its comment says "without replacing the declared source VOI". `SvrVolume3DViewer.tsx:888` `nativeSharesVolumeWindow` then makes the primary source's plane inherit it instead of `nativeDisplayWindow(image, frame)` (`nativePlane.ts:224`).
- **Effect.** Lower default contrast on 3D shading and on the plane; the plane and the 2D Cornerstone viewer show different tone for the same instance.
- **Fix.** Prefer `displayWindow` when finite, fall back to `intensityRange`; keep the sharing.
- **Proof.** A unit test on a native-3d volume with `displayWindow` set asserting the initial `windowRange` equals it.
- **Second opinion.** AGREE. HEAD defaulted the volume to `displayWindow` (`HEAD:SvrVolume3DViewer.tsx:728-730`); the 2D viewer still asks Cornerstone for the source viewport (`DicomViewer.tsx:871`).

#### 9. The documentation contradicts the code in both directions. CONFIRMED

- `agent_docs/design-docs/miraviewer-architecture.md:28` says the accepted-source owner retains an idle runtime for 30 s; `:48` says "Model-session reuse is not yet implemented." Code: reuse **is** implemented (`interactiveTrackingWorker.ts:159-233`, `:274-287`).
- `:29` says custom-model execution is "main-realm"; ledger row F13 is "Pending" and its final checkpoint describes the worker design as the *next* change. Code: custom inference already runs in a terminated-per-operation worker (`useOnnxTumorSession.ts:348`, `customModelWorker.ts:104`).
- Ledger F1 says "final-only scoring on the existing worker". Code: `scoreFinalAffineInWorker` spawns a *new* module worker per final ranking and terminates it (`alignmentScoringRunner.ts:207-221`).
- AGENTS.md names the ledger as the status authority. Both documents must be corrected before merge or the next reader re-implements or "fixes" shipped behavior.
- **Second opinion.** AGREE on both contradictions, citing `TRACKING_IDLE_MS = 30_000` and the worker launch in `customModelWorker.ts:101`.

#### 10. Dataset token minting after open. REFUTED as a race; retained as a note

- The subsystem pass suspected that two tabs opening the upgraded database simultaneously could each mint a token (`db.ts:204-210`). **Second opinion: DISAGREE**, and on re-examination it is right: the existence check and the put run inside one `app_state` readwrite transaction, and IndexedDB serializes overlapping readwrite transactions on the same store across connections, so the second connection observes the first committed token. No two-token loser exists. Minting inside `upgrade` would still be the more obvious home for a one-time initialization, but it is not a correctness fix.

#### 11. Resident-reformat layout validation throws during render. PLAUSIBLE, introduced

- `volumePlaneLayout` (`nativePlane.ts:76`) throws on a support/data length mismatch; it is called from `makeVolumePlaneData` inside `useMemo` at `SvrVolume3DViewer.tsx:872-877` with no `try`. An inconsistent volume crashes the viewer subtree instead of producing the existing `svr-native-error` notice that acquired planes use.
- **Fix.** Compute in the hook and return `{plane: null, error}` like the acquired path.
- **Second opinion.** AGREE; the resident path hardcodes `error: null` so the existing notice at `SvrVolume3DViewer.tsx:3110` can never receive this error.

### P2: contained defects and cleanup

12. **Two live write formats for panel settings.** `savePanelSettings` writes legacy `<patient>::<combo>` rows whenever `source` is undefined (`panelSettings.ts:181`), which the hook does for any enabled date lacking a series in the current sequence (the progress debounce targets the newest enabled date). The file header calls the legacy API "read-only compatibility" (`:40`). Those rows are never surfaced and are exported. Fix: refuse to write when there is no source.
13. **Per-patient backup exports every patient's acquisition choices.** `exportBackup.ts:319` exports all of `app_state`; this tree adds `acquisition:<studyUid>:…` and `selected_patient_study_uid` rows, so a single-patient backup carries other patients' Study UIDs and restore re-puts them. Filter by owned studies on export and skip foreign `acquisition:` rows on restore.
14. **Keyboard ownership on focused filmstrip buttons.** `useOverlayNavigation.ts:205-212` ignores 1–9/Space/arrows when focus is inside any button, and the old `target.blur()` on Space is gone. Keyboard users who Tab to a date button lose hold-to-compare. Exempt the navigation's own controls.
15. **`navigationReference = columns[0]` is a hidden authority.** `useComparisonWorkspaceNavigation.ts:137-148` derives loop bounds and slice numbers from the first visible column. If that column is a single-frame localizer, playback is disabled although other columns are full stacks. Prefer the alignment reference date when one exists.
16. **Retry after a timed-out load double-decodes.** `waitForBoundedOperation` rejects after 30 s but the Cornerstone load continues; retry removes the still-pending load object (`DicomViewer.tsx:950-951`) and starts a second decode under exactly the slow conditions that caused the timeout.
17. **A failed frame load blanks the previously good plane.** `useSvrNativePlane.ts:67` returns `null` when the latest settled record is an error, dropping the on-screen plane, mask, and geometry. Keep `{plane: previous, error}`.
18. **Elastix worker orphaned when optional final ranking fails.** `useAutoAlign.ts:1141` drops `sharedWebWorker` without terminating it (pre-existing, exposed). Route it through the `finally` disposal at `:2324`.
19. **`runLongitudinalRegistration` (image-producing) has no production consumer**; only `tests/browser/alignmentProbe.ts:31` uses it. Delete or mark test-only once the parity receipt is recorded.
20. **Worker state after a failed tracking job is not reset** (`interactiveTracking.worker.ts:157-161`); safe only because the parent always terminates on error. One `finally`.
21. **Plane-enabled ray march has no front early-out.** `glRaymarch.ts:1043-1055` marches all `n` steps and the termination test inspects only far `aAccum`, so an opaque foreground never terminates the ray; the translucent section means the far segment is always needed. Structural cost up to 2× samples per pixel at the same `u_steps`, unmeasured. Resolving Finding 2 with an opaque section restores the early-out.
22. **`nativeSourcePlane` tie test rejects only exact equality** (`nativePlane.ts:63`); a 44° oblique source is labeled as its nearest plane.
23. **`useOnnxTumorSession.preflight` remeasures the Cornerstone cache on every relevant render for an advisory number** the action remeasures anyway. Compute on demand.
24. **Independent-2D reconstructions lose Auto-fill** (`useSvrSelection.ts:212-217`). Intended per F8/F10 and explained in the UI, but it is a capability change and belongs in the PR description, not a refactor note.

## What checks out

- Cancel and late-result fencing in every boundary: controller identity in `useAutoAlign`, `operation.current === owner && !aborted && generation` in `useOnnxTumorSession.ts:311`, `assertCurrent()` after every await in `Svr3DView.proposeSelection`, `active` guards in `useSvrNativePlane`, `activeRequestKey` filtering in `useComparisonAlignment`.
- Coverage-only reverse scoring is exactly the old coverage term (`perceptualSliceSimilarity.ts:499-528` vs `:696-739`); no transform-selection change. `estimate` drops nothing the caller used (`useAutoAlign.ts:865` already deferred presentation validation).
- DB v7 upgrade (`db.ts:187-194`) is index-only; old derived rows carry all four keyed fields; key-only pruning and key cursors are real payload-read savings. `getComparisonData` counts via index only.
- `NativeFrameCache` single-flight queue, `retain()`, and `evictFor` are correct; `createNativeSourceContext` frozen clone is metadata-only and `reconstructVolumeMultiPlane` validates provenance by value.
- v2 asset pins: `queryChunking` is cross-checked by the exporter (`export-efficient-tam.py:119-134`), by `tests/efficientTamAssets.test.ts` and `efficientTamDerivation.test.ts`, and by `npm run build` on the copied directory (passed here).
- Custom-model worker protocol: volume clone accounted, labels transferred and validated, WASM retry only after an init failure in an already-terminated worker.
- Deleted modules (`TumorSegmentationOverlaySeedGrow`, `costDistanceGrow2d`, `marchingSquares`, `seededVolume*`, `segmentTumor`, `stats`, `base64`, `useWheelNavigation`) have no live consumer at HEAD or in the tree.
- The Playwright harness is correctly isolated: disposable profile, strict port 43134, source and manifest fingerprint check before every run (`scripts/build-browser.mjs`, `tests/browser/checkBuild.ts`), probe entrypoint excluded from normal and offline builds (`vite.config.ts` `browser-test` mode).

## Target design

Three ownership changes remove most of the mechanism above:

1. **One settings owner, proven once.** Hydration is a `readonly` snapshot that returns `{token, settings, verifiedSources, legacyCandidates}`. The hook binds `verifiedSources` into its owner. Writes check the token and put one row. Migration is an explicit versioned step (with F12). `usePanelSettings`'s five owner-tracking concepts (`settingsOwner`, `writableOwnerRef`, `replacement` + `replacementVersionRef`, `loadAttempt`, `pendingBaselineDatesRef`) collapse to `owner: {key, status: 'loading' | 'ready' | 'failed' | 'replaced'}` with `canWrite = status === 'ready' && key === currentKey`. Browsing never depends on `status`.
2. **One heavy-operation owner.** `imagingContext.prepare(kind)` is the only place that cancels competing owners, disposes the idle selection runtime, and returns retained bytes. `viewerMemory`, `registerEditingMemory`, per-callsite `releaseSelectionRuntime()`, and the wrapper's duplicate estimate disappear.
3. **One exact plane path.** The section shader has an exact mode (alpha 1.0, terminate at `nativeT`) and a blended presentation mode. The pixel test that asserts exactness is restored. Default windows come from the DICOM VOI.

Everything else in the P2 list is a local edit inside an existing owner.

## Ordered improvement plan

Each item is independently verifiable. Dependencies are noted.

| # | Change | Boundary | Depends on | Acceptance evidence |
| --- | --- | --- | --- | --- |
| A | Separate browse-ready from write-ready; drop `inert` and the `interactionBlocked` coupling (F1) | `usePanelSettings.ts`, `ComparisonMatrix.tsx` | none | Hook test: snapshot rejects → navigation enabled, `canWrite()` false |
| B | Make `getComparisonData` and `getPanelSettingsSnapshot` readonly; move acquisition-default and legacy migration into an explicit idempotent step (F5) | `localApi.ts`, `panelSettings.ts` | A | `localApi.test.ts` readonly assertion; migration test with two import batches |
| C | Bind verified `SeriesRef` into the owner; writes do token check + one put (F5) | `panelSettings.ts`, `usePanelSettings.ts` | B | Pan test counting one single-store transaction per write |
| D | Restore exact section rendering and its pixel test; VOI default window (F2, F8, F21) | `glRaymarch.ts`, `volumeDisplay.ts`, `SvrVolume3DViewer.tsx` | none | `test:gpu` exact-pixel probe; window default unit test |
| E | Separate custom-model envelope from the assembler budget (F3) | `useOnnxTumorSession.ts`, `customModelWorker.ts` | none | 128³ / 20 MB admitted; browser peak receipt |
| F | Keep overlays mounted while pending (F4) | `DicomViewer.tsx`, overlays | none | Overlay identity persists across slice change |
| G | Single heavy-operation owner; delete duplicate estimate (F6) | `svrImagingContext.ts`, `Svr3DView.tsx`, `SvrVolume3DViewer.tsx` | none | Every heavy entry releases idle runtime; retained == admitted |
| H | Presented set via ref, not request key (F7) | `useVisibleAlignment.ts` | none | Presented-only change does not abort |
| I | Resident-plane errors soft (F11) | `nativePlane.ts`, `SvrVolume3DViewer.tsx` | none | Wrong-length support → notice, not an error boundary |
| J | P2 items 12–20, 22, 23 | various | A–C for 12 | Focused tests per item |
| K | Correct the architecture guide and ledger rows F1, F13; describe the Auto-fill capability change (F9, F24) | docs | after A–I land | Reviewer read-through against code |

## Verification strategy

- Unit: the focused tests named per item, then the whole suite (`npm run test -- --maxWorkers=2`), which passed on this tree (Appendix A).
- Browser: `npm run build:browser` then `test:browser`, `test:gpu` for item D, `test:performance` for items C and G. The harness rejects stale builds, so run it after each tranche, not once.
- Measurement to add, not assert: settled-frame time with the plane on/off (F21); IndexedDB transactions per pan gesture (F5); custom-model worker peak vs estimate (F3); interactive-selection estimate vs measured high-water per receipt (the chunked-attention allowance in `interactiveAdmission.ts:33-38` charges all four layers' score blocks and six projection buffers per token; whether that is calibrated against the user's 6,734 MiB case remains the open acceptance item from the recovery baton).

## PR hygiene and scope boundaries

These do not change the architectural verdict but block a clean merge:

- **No pull request exists** and HEAD equals `origin/main`; everything is uncommitted. The tree mixes the v2 memory-preflight work (August 30), the September 2 audit implementation, and the September 1 recovery baton. Split by ownership boundary: storage/settings identity, alignment, 3D plane, segmentation runtime, browser harness. Each is reviewable alone; together they are not.
- **Private paths.** 23 untracked files under `agent_docs/`, `.baton/`, and `artifacts/` contain `/Users/<local-user>` absolute paths; `.baton/` also carries session identifiers. Artifacts are labeled synthetic and no patient identifiers were found in receipts, but `.baton/` should not be committed and receipts should be path-scrubbed.
- **Binary churn.** `frontend/public/models/efficienttam-tiny512-v1` (75 MB, tracked, no LFS) is deleted and v2 (75 MB) is added untracked. The repository pack is under 1 MB today; this PR would make it 150 MB of history. Decide on LFS or an out-of-repo asset fetch before committing v2.
- **Process logs as docs.** 16 planning documents are untracked; several are session narratives (turbovac reports, PR bodies, cleanup pauses). Keep the architecture guide and one ledger; move the rest out or under a clearly historical directory.
- **`artifacts/`** adds 36 MB including 252 synthetic DICOM fixture files. Receipts that justify decisions belong in the PR; fixtures belong in a generator script (one already exists: `scripts/generate-custom-model-fixtures.mjs`).
- **`tests/browser/*.ts` are typechecked by no tsconfig** (`tsconfig.app.json` includes `src`; `tsconfig.node.json` includes only `vite.config.ts`). ESLint parses them without type information. Add a `tsconfig.browser-tests.json` reference or accept that the harness is only checked at Playwright runtime.

Out of scope for this review: anatomical quality of the v2 model, the 512 MiB restore cap (documented, unchanged), and the offline launcher.

## Appendix A: validation runs on this tree

| Check | Result |
| --- | --- |
| `npx eslint .` | exit 0 |
| `npx tsc -b` | exit 0 |
| `npx vitest run --maxWorkers=2` | 167 files passed, 6 skipped; 3,154 tests passed, 54 skipped; 120 s |
| `npm run build` (includes v2 asset verification before and after) | exit 0; 8 files, 75,078,803 bytes verified in `dist/models/efficienttam-tiny512-v2` |

The ledger's last recorded run reported two timeout failures; none reproduced here. Browser, GPU, performance, and inference projects were not run in this review.

## Appendix B: second opinion

An independent model (Codex, `gpt-5.6-sol`, high reasoning) was asked to refute eleven diagnoses against the code with no prior context. Tally: AGREE on Findings 1, 4, 7, 8, 9 (both contradictions), 11, and the overlay-abort claim; PARTIAL on Findings 2, 3, and both halves of 5 (corrections incorporated in the text); DISAGREE on the dataset-token race (Finding 10, now recorded as refuted). The raw transcript is kept outside the repository.
