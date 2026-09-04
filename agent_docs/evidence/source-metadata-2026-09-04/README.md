# Legacy DICOM metadata recovery

## Result

The normal production application opened a synthetic schema-6 database, recovered physical geometry for all **24 original DICOM images**, displayed the initial focus preview and 3D selection workspace, and preserved the images and saved work through reload and ZIP restoration into a fresh browser context. All original, upgraded and restored image hashes matched. Metadata enrichment did not change the dataset revision or saved-work token; complete restoration deliberately creates a new saved-work token.

After reduction, all **nine normal-app browser workflows passed in 46.5 seconds**. The complete default unit suite passed **3,225 tests, zero failures and 54 existing optional skips**, with unchanged source. The [post-reduction receipt](post-reduction.json) records the final code commit, exact source fingerprints, checks, saved-work baseline and capture hashes. The earlier [round-trip receipt](round-trip.json), [workflow receipt](workflow.json) and [unit receipt](unit-suite.json) remain intact as pre-reduction evidence, not current-run totals.

This closes the audit's F12 metadata-upgrade requirement. It does not close the separate legacy volume-key migration, warm-rendering, startup/host-parity or CI/release work. Preserving an old label grid is not permission to remap it onto a different reconstructed grid.

## Why the change was needed

An older imported image could retain valid Image Position, Image Orientation and Pixel Spacing while lacking the later `physicalSlicePosition` cache field. The physical-position index then omitted it, and the manifest rejected its geometry before deriving that position. Reimport classified its SOP UID as an unchanged duplicate. A separate acquisition-metadata reader existed only in the 3D classification path, so it could not supply one shared recovery contract for physical alignment and reconstruction.

A focused regression first reproduced the missing-position rejection in the production data API. Its original failed log remains at `frontend/tmp/source-metadata-legacy-before.log`. The repaired test uses reversed instance numbers and valid stored patient-space coordinates, then verifies physical ordering, no header reads, unchanged original bytes, and retained settings and app state.

## One metadata owner

`services/dicomMetadata.ts` now owns extraction and conservative merging for both import and legacy recovery. It replaces the narrower acquisition-only service and the duplicated field extraction in ingestion. `db/instanceMetadata.ts` owns the transactional enrichment. The old hydration routine was removed from the otherwise pure acquisition classifier.

`getSeriesFrameManifest()` is the physical-source preparation boundary. It captures the source and dataset scope, enriches incomplete legacy rows, and reads the completed manifest again under that scope. Modern, completed rows retain their single-readonly-snapshot path. The existing database schema remains **10**; this change adds no new store or database-open scan of all image payloads.

The focus preview derives its ordering and geometry from those prepared manifests. It no longer keeps two independent database reads and four metadata/error state fields. Same-source refreshes can retain the accepted preview and focus box; patient/source replacement retires them immediately. A valid individual source remains inspectable when another selected source fails preparation or group compatibility, but the failed group cannot enable reconstruction or claim verified geometry.

Each instance records `metadataVersion: 1` after a completed attempt. This is a resume marker, **not a claim that its geometry is valid**. Existing completed rows determine what remains after interruption; there is no separate migration-job ledger.

### Geometry and resource rules

- Reuse valid stored geometry. Derive physical position from the validated orientation and patient-space position.
- Read the original stored header only when relevant source metadata is absent or invalid. Reads grow from 32 KiB to a maximum of **2 MiB per header**, stopping parsing at Pixel Data; no pixel decoding occurs.
- Commit at most **32 instances per batch**, with at most **four concurrent header reads**. The 3D workspace prepares contributing acquisitions sequentially instead of multiplying that limit across parallel manifests. Reconstruction already admits acquisitions sequentially; alignment forwards its existing cancellation and dataset scope.
- Verify the source SOP, series and study UIDs against the stored image before merging header metadata. Reject conflicting valid identity, dimensions or geometry; fill unknown cache values without replacing the original Blob.
- Recheck dataset token, revision, selected patient, source ownership and row identity before publication. A failed or canceled batch writes nothing; previously committed batches remain valid and invalidate the derived ordering cache.
- Require complete finite numeric components and exact vector lengths. Prefixes, hex values, empty DICOM components and extra axes are not silently accepted. Existing comma-separated or space-separated vector compatibility remains; this is not full DICOM conformance.

Unparseable or over-limit headers receive a completed-attempt marker with unknown metadata. Unknown geometry remains unavailable to physical admission, and parser exceptions are not used as patient-bearing UI diagnostics. Explicit reimport can complete legacy metadata using the normal ingestion path without adding another copy of an existing image.

### Reimport and recovery UX

An unchanged modern duplicate keeps its bounded identity-probe fast path and does not open a write transaction or require additional image-storage headroom. A legacy duplicate can enrich metadata through the existing atomic ingestion batch. Only newly stored images increment the dataset revision; metadata-only writes retain original Blob bytes and saved work.

The import dialog distinguishes **Existing scan metadata updated** from a new-image import and reports the metadata count. It refreshes the acquisition data after such an update, including after a later partial failure. Its footer now says that existing images are kept and missing metadata may be updated, rather than implying every duplicate was ignored.

## Acceptance evidence

| Boundary                                | Observed proof                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored geometry without its cache field | Physical ordering recovered despite reversed instance numbers; no Blob header reads; original bytes and settings unchanged                                                                   |
| Earlier database schema                 | Synthetic schema 6 upgraded through the normal app to schema 10; all 24 source frames obtained complete geometry and version markers                                                         |
| Physical admission                      | Initial focus preview checked before source-stack opening; the actual Select tissue action then exposes populated axial pixels before and after restoration                                  |
| Interrupted enrichment                  | Canceling a 35-frame operation during the next batch left exactly 32 completed markers; retry read only the remaining three headers                                                          |
| Stale or conflicting source             | Patient, dataset revision, token, frame metadata and swapped-UID cases rejected publication; mixed frame IDs rejected even if the first frame ID was absent                                  |
| Same-SOP reimport                       | Missing metadata repaired while preserving the original stored byte payload, label grid, literal marks, settings and token; repeated completed import had no metadata update                 |
| Exact source retention                  | Independent Node hashes of generated files matched the browser hashes of all original, upgraded and restored images                                                                          |
| Saved work                              | Source-owned zoom 1.25, pan X 0.12 and progress 11/23 retained; exact eight-byte legacy label hash, reviewed status, foreground mark 0, background mark 1 and last-stroke metadata preserved |
| Reopen and restore                      | Reload retained the completed metadata; actual ZIP export and explicit-consent restore into a fresh context retained the same source frames and saved work                                   |
| Browser regressions                     | Nine workflows passed, including custom-model cancellation/reopen, normal annotations/backups, acquisition switching, date collisions and cold/warm alignment                                |
| Default unit suite                      | 3,225 passed, zero failures, 54 existing optional skips                                                                                                                                      |

The retained legacy selection intentionally has a different 2 × 2 × 2 grid. Its preservation is a database/backup assertion, not an automatic attachment to the newly opened source volume. No tissue was painted or model-quality result inferred from these captures.

The final browser case navigates to slice 12 and waits for the resulting progress save **before** freezing its preservation baseline. That user action accounts for progress 11/23; lazy metadata preparation must leave the baseline unchanged. Metadata-only revision stays 7. Fresh-context restoration publishes revision 8 and a new token while retaining the exact source metadata and saved settings/labels.

## Provenance and attempts

The accepted run used installed, headed **Chrome 152.0.7977.82** at `http://127.0.0.1:43134/`, with disposable contexts and a normal production build that omits acceptance-only probes. It used generated images, not a private MRI fixture. The pinned public model manifest was verified; this metadata case did not run the medical segmentation model.

Final code commit: `164cb0989f560009c2b2c37ab3d908c9733e7736`. Source fingerprint: `9054411f36f270fb3c329df163b9538df1632a41ac3b670934352c25e24846ef`. Application fingerprint: `2131c232d2f75b669ed31fa34cfefa2a4a571f7346736ee18c81b70dccbc67c4`. The new normal production build and all nine workflows have `fullSourceMatch: true`; the source remained unchanged. TypeScript and zero-warning full lint used the same bytes immediately before the normal code commit. Subsequent publication edits only update documentation/evidence.

Before reduction, the accepted source fingerprint was `a98b2533a14d8a8301cbd3386c9cd8ae7de5235af5efbf28c2575ab14d2d44af`, with application fingerprint `5546d0ced083fb92f6c7dcf134c4c1a61b2b521a121958070f5690c1c9d1b27b`. That bundle was reused after correcting browser navigation and adding captures. The historical receipts deliberately report `fullSourceMatch: false`; application/model fingerprints matched and the original build manifest was not rewritten. Parent HEAD `76e64347f045b07a041a40af8e01d00373d838ce` identifies that uncommitted candidate's parent, not its implementation commit.

The first full unit run had nine failures: eight diagnostic expectations after validation moved earlier, and one fixture that represented invalid geometry using only the recoverable cache omission. The useful diagnostics were preserved at their shared owner; the invalid-source fixture now omits actual patient-position metadata. Earlier focused runs also exposed doubled DICOM separators in synthetic fixtures. Their intended coordinates and assertions were retained when the encoding was corrected. Failed receipts were preserved.

The first full browser run passed eight workflows but requested an editing canvas while still in the 3D browsing view. Its saved screenshot showed the loaded synthetic volume and the Select tissue action. The corrected test follows that action, retains the pixel/data assertions, and completes the round trip. A copied runner's earlier provenance list named the prior sparse-editing harness; that original record is retained with a correction note. Accepted runs hash and archive the actual source-metadata harness.

The reduction review added the previously unexercised initial focus interaction. Attempt 05 reproduced a genuine application defect: physical preparation repaired the stored rows and enabled Open 3D, but two independent preview reads retained stale geometry and showed a blank canvas with a missing-metadata error. Its pixel check found one grayscale level. Deriving the preview from prepared manifests removed that stale ownership. Attempt 06 passed the focused round trip; attempt 07 rebuilt the exact final code and passed all nine workflows. The existing component suite now covers same-source refresh/focus retention, identity replacement, and valid individual previews despite another source's read, geometry or frame-compatibility failure. Earlier failures remain preserved.

These corrections do not establish a historical speedup, a universal memory bound, anatomical quality or hardware motion performance. The four-reader and per-header limits are exercised implementation contracts, not an aggregate browser-RSS guarantee.

## Reduction record

Two full passes used `origin/main`, merge base `76e64347f045b07a041a40af8e01d00373d838ce`. Every changed file and modified-file diff was read in each pass, including the complete deleted service and the synthetic binary evidence. The final pass covered 37 paths: 34 text files totaling 22,470 lines and three PNGs. Truncated reads were repeated in complete portions. Per-file hashes, ranges and diff receipts remain in the ignored evidence archive referenced by [post-reduction.json](post-reduction.json).

The first pass removed the two preview loaders, centralized unchanged-merge detection in the metadata owner, removed unused ingestion tags and passthrough test mocks, and shared the actual-browser grayscale assertion. Runtime code lost 81 net lines; meaningful regression coverage added 73 net test lines. All comments and earlier evidence were retained. One normal commit contains the changes. The second complete pass found no further viable scope-preserving cuts and made no code changes.

| Reduction-window metric       | Before | After |
| ----------------------------- | -----: | ----: |
| Full PR insertions            |  3,112 | 3,239 |
| Full PR deletions             |    509 |   644 |
| Full PR churn                 |  3,621 | 3,883 |
| Non-comment source insertions |  1,281 | 1,404 |
| Non-comment source churn      |  1,774 | 2,028 |
| Comment-only additions        |     20 |    24 |
| Untracked code lines          |      0 |     0 |

This is **not an overall PR churn reduction**: full insertions grew 4.08%, deletions 26.52%, and churn 7.24%; non-comment source insertions/churn grew 9.60%/14.32%. The newly reproduced consumer defect and its regression coverage account for the wider diff despite the smaller runtime. Comment additions are moved, preserved comments. These measurements precede this final documentation/evidence refresh; tests count as source, while prose and JSON receipts count in full-PR metrics.

Keep the separately required read/commit ownership fences, the stored-geometry versus header decision, and display parsing versus strict physical admission. Removing those boundaries would change safety or compatibility. Rewriting unchanged numerical/worker algorithms or deleting legacy/cancellation tests would add unrelated scope or lose evidence. The final no-cut pass retained them. Focused checks passed 175 tests across five intended files, followed by the complete suite, TypeScript, lint, final build and actual-app acceptance above. A misspelled focused-test filter matched no file in run 03; run 04 explicitly ran the intended 35-test provenance suite rather than counting the missing filter as covered.

## Static captures and lifecycle

The [desktop repair summary](legacy-metadata-repair-desktop.png) and [mobile repair summary](legacy-metadata-repair-mobile.png) were individually inspected at original detail. Hierarchy, typography, contrast, wrapping, preservation wording and the visible Done action passed. The final browser run reproduced identical bytes.

The [initial focus preview](legacy-metadata-focus.png) was individually inspected at original detail after the final build. The synthetic grayscale image is visible at slice 12 of 24, the source rail and Open 3D action remain readable, and the earlier missing-metadata error is absent. This is static UI evidence, not an anatomical or motion verdict.

The [opened and restored selection view](legacy-metadata-selection.png) was separately captured and individually inspected in both contexts; the two source PNGs are byte-identical. The verdict covers the visible axial image and controls. Lower panes extend below the captured viewport, so this is not full-page layout sign-off. The [historical capture ledger](captures.json) preserves the earlier locations; [post-reduction.json](post-reduction.json) records all five individually inspected current captures and their scopes. Other workflow screenshots remain preserved but are not newly claimed as visually validated here. Storybook was not used.

The final scoped audit checked **27 current and earlier task receipts** and found no remaining owned browser, server or profile; port 43134 was free. User and other-worktree browsers were preserved. Raw ZIPs, unsuccessful attempts, original captures, generated DICOM inputs, authored harnesses and detailed receipts remain local under ignored `artifacts/` and `frontend/tmp/`; only curated synthetic evidence is published here.

## Reproduce

From `frontend/`:

```sh
npm run test -- tests/localApi.test.ts tests/dicomIngestion.test.ts tests/svrAcquisitionProvenance.test.ts tests/svrSourceAdmission.test.ts --maxWorkers=2
npm run build:browser
PLAYWRIGHT_HTML_OPEN=never npm run test:browser -- --grep 'metadata-only repair|upgrades a legacy database' --reporter=line
```

The normal production measurement above used a separate retained output and headed-Chrome wrapper; the standard repository command uses its configured browser build. Do not point either workflow at a user's existing MRI origin/profile. A header that cannot be safely recovered remains unavailable; deleting source scans is not the recovery procedure.
