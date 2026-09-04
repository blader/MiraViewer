# Bulk DICOM import: UX, reliability, aesthetics, and performance improvement plan

> Historical plan/evidence. This preserves its original task and may include unfinished proposals. Current status belongs to the [implementation ledger](../active/2026-09-02-full-codebase-audit-implementation.md).

Date: 2026-08-24

Reviewed revision: `5c0491e1b8d27e502224438b58094e782e0f4c1f`

Status: evidence-backed proposal; implementation has not started

Scope: local DICOM image, folder, ZIP, and complete-backup intake in the existing browser application

## Executive decision

Treat import as a patient-safe, bounded, cancellable **acquisition intake operation**, not as a file-picker modal followed by independent writes.

The application already has valuable clinical and privacy foundations: local-only storage, SOP-instance deduplication, patient and geometry checks, explicit unsupported-multiframe handling, snapshot preservation, and an accessible shared dialog shell. However, the existing import architecture does not maintain those guarantees consistently under missing metadata, cancellation, large folders, ZIP corruption, snapshot sidecar failures, or partial completion.

The highest-priority findings are not hypothetical:

1. A production-path synthetic case accepts images from two different patients and two spatial frames after the first image establishes empty canonical metadata.
2. A malformed DICOM parser error can place parsed patient information and the complete image byte buffer into the browser console.
3. The Cancel control does not stop ordinary file imports; all subsequently scheduled images can still commit.
4. A representative 512-image sample from the supplied MRI corpus rejects six genuine orthogonal scout/localizer images while presenting the overall operation as a transient success.
5. A corrupted ZIP entry with the correct length is accepted because CRC verification is disabled.
6. A model-cache failure after a complete-backup restore leaves the primary medical database durably modified while the operation reports failure.
7. The full provided corpus contains 35,898 DICOM files totaling 6,999,291,884 bytes; a ZIP containing those images exceeds the current 4 GiB uncompressed safety limit by approximately 63%.
8. Every accepted image currently creates one four-store write transaction and one dataset notification. On the actual corpus, a per-file render coupled with the current full-selection size reduction could perform up to 1,288,666,404 file-size visits.

The proposed implementation order is therefore:

1. Lock down patient/frame ownership and eliminate patient-data-bearing logs.
2. Establish one authoritative import lifecycle, truthful cancellation, and durable partial outcomes.
3. Unify files, folders, directory fallbacks, drag/drop, and archives behind bounded source discovery.
4. Introduce measured, bounded parsing/admission/write batches while preserving existing dataset-revision semantics.
5. Repair ZIP integrity and scalable archive admission; make complete-backup restoration explicitly authorized and recoverable across its actual database boundaries.
6. Replace the generic upload box with a clinically legible **Acquisition Intake Console**.
7. Validate against the real protected corpus, adversarial synthetic data, actual supported browsers, and accessibility instrumentation.

No implementation phase should trade clinical correctness, offline operation, patient separation, original DICOM fidelity, or truthful completion for throughput.

## 1. Scope, authorization, and non-goals

### In scope

- First-run onboarding and every existing entry point that opens the import flow.
- Individual files, multiple files, extensionless DICOMs, nested folders, dragged files, dragged folders, raw DICOM ZIP archives, and MiraViewer backup ZIP files.
- Browser capability detection and an honest fallback when a folder API is unavailable.
- Discovery, preview, source classification, patient review, quota admission, parsing, deduplication, persistence, invalidation, cancellation, completion, retry, and recovery.
- Storage, patient, study, series, frame-of-reference, acquisition geometry, original bytes, derived artifacts, annotations, selected-patient state, and model-cache restore.
- Responsiveness, bounded memory, transaction count, archive integrity, duplicate replay, observable progress, keyboard/screen-reader support, mobile/touch sizing, and visual direction.
- Real-corpus validation that emits aggregate, de-identified results only.

### Out of scope

- Uploading medical data to any server or adding a network-backed import service.
- Changing diagnostic or registration algorithms except where intake must preserve their existing identity, geometry, and revision contracts.
- Silently supporting enhanced multiframe, arbitrary transfer syntaxes, encrypted archives, or heterogeneous stacks without an explicitly validated design.
- Treating one patient's corpus or one scanner vendor as proof of general clinical compatibility.
- Recording actual patient names, IDs, dates, UIDs, source paths, filenames, image pixels, or thumbnails in committed documentation, public diagnostics, screenshots, analytics, or benchmark output.
- Changing production code as part of this document-writing task.

## 2. Evidence quality and review methodology

This plan distinguishes five evidence classes:

- **Production-path reproduction:** the current production parser, ingestion, archive, or snapshot code was executed using synthetic DICOM data and isolated in-memory IndexedDB.
- **Protected-corpus measurement:** current production ingestion processed real user-authorized MRI bytes in isolated in-memory IndexedDB; only aggregate counters were retained.
- **Actual-product observation:** the running application was inspected on a separate, empty browser-storage origin containing no patient records.
- **Source-demonstrated invariant:** exact current implementation and tests establish a control-flow, ownership, or complexity issue.
- **Structural estimate:** a worst-case count derived from source and measured corpus cardinality; it is not presented as an observed browser runtime.

Node plus `fake-indexeddb` measurements are useful for relative work, transaction cardinality, and real-parser outcomes. They are **not** browser wall-clock, browser heap, user-perceived responsiveness, or disk-backed IndexedDB measurements. Single observations below are not percentiles.

### 2.1. Current protected-corpus inventory

The corpus was inspected read-only. No MRI file was copied into the repository and no patient-identifying values were emitted.

| Inventory measure                      |       Observed value |
| -------------------------------------- | -------------------: |
| Directories                            |                   35 |
| Total files                            |               35,917 |
| `.dcm` image files                     |               35,898 |
| Recognized non-image sidecars          |                   15 |
| Extensionless files                    |                    4 |
| Total DICOM bytes                      |        6,999,291,884 |
| Approximate DICOM payload              | 6,675 MiB / 6.52 GiB |
| Total corpus bytes                     |        7,001,410,247 |
| Median observed file size              |        149,642 bytes |
| Largest observed file                  |      3,338,054 bytes |
| Maximum observed directory depth       |                    2 |
| Observed symlinks / unreadable entries |                0 / 0 |

Corpus observations establish scale and concrete compatibility cases. They do not establish the behavior of deeper directory trees, symlink-like handles in every browser, multi-patient exports, other scanner vendors, or every DICOM transfer syntax.

### 2.2. Existing focused-test baseline

Command, run from `frontend/`:

```bash
npm run test -- tests/UploadModal.test.tsx tests/dicomIngestion.test.ts tests/storageIntegrity.test.ts tests/exportBackup.test.ts
```

Observed result:

```text
Test Files  4 passed (4)
Tests       49 passed (49)
```

`frontend/tests/UploadModal.test.tsx:21` contains only two mocked happy-path tests: ordinary file import and raw ZIP import. Thus a green baseline does not exercise cancellation, actual parent-component reload behavior, corrupt ZIP members, missing-to-present identity transitions, sidecar commit failure, folder fallback, mixed-orientation scouts, or partial visibility.

### 2.3. Real-corpus production-ingestion measurement

Method: enumerate the authorized corpus read-only; take the first 512 `.dcm` files in native traversal order; wrap their bytes in neutral synthetic filenames; run the current `processFiles` implementation and current DICOM parser against isolated `fake-indexeddb`; instrument `IDBDatabase.transaction` and `IDBObjectStore.put`; suppress source logs; report aggregate values only. Re-run the exact same files without clearing the isolated database.

| Measure                                      | First import |   Immediate duplicate replay |
| -------------------------------------------- | -----------: | ---------------------------: |
| Files presented                              |          512 |                          512 |
| Source bytes                                 |   91,475,776 |                   91,475,776 |
| Observed Node/fake-IDB duration              |       299 ms |                       140 ms |
| Images imported                              |          483 |                            0 |
| Existing-image duplicates                    |            0 |                          483 |
| Intentional Secondary Capture exclusions     |           17 |                           17 |
| Intentional non-displayable exclusions       |            6 |                            6 |
| Genuine MR images rejected                   |            6 |                            6 |
| Read/write IndexedDB transactions            |          489 |                          489 |
| `studies` puts                               |          483 |                            0 |
| `series` puts                                |          483 |                            0 |
| `instances` puts                             |          483 |                            0 |
| `app_state` puts                             |          483 |                            0 |
| Dataset revision after first pass            |          483 |                    unchanged |
| Approximate process RSS increase, first pass |       94 MiB | not independently attributed |

The six rejected images are genuine MR Image Storage objects belonging to one scout/localizer acquisition: three transition from its canonical coronal orientation to sagittal, and three transition from coronal to axial. They are not malformed images and are not Secondary Capture objects.

Duplicate replay consumed approximately 47% of the measured first-pass time and reacquired the same number of read/write locks despite writing nothing. This ratio is an environment-specific observation, not a promise that browser replay has the same ratio.

### 2.4. Synthetic production-path work measurements

Fresh, genuine synthetic single-frame DICOM images processed through the current production importer and isolated fake IndexedDB:

| Fresh images | Observed duration | Transactions | Store reads | Store writes | Full source reads | Progress calls | Mutation broadcasts |
| ------------ | ----------------: | -----------: | ----------: | -----------: | ----------------: | -------------: | ------------------: |
| 72           |           35.4 ms |           72 |         288 |          288 |                72 |             72 |                  72 |
| 288          |           83.3 ms |          288 |       1,152 |        1,152 |               288 |            288 |                 288 |
| 576          |          156.9 ms |          576 |       2,304 |        2,304 |               576 |            576 |                 576 |

Immediate replay of already-ingested synthetic files:

| Duplicate images | Observed duration | Full source reads | Read/write transactions | Writes |
| ---------------- | ----------------: | ----------------: | ----------------------: | -----: |
| 72               |            9.5 ms |                72 |                      72 |      0 |
| 288              |           29.5 ms |               288 |                     288 |      0 |
| 576              |           56.3 ms |               576 |                     576 |      0 |

Additional measured current-path costs:

- A one-series frame manifest required 29, 101, and 197 transactions for 24, 96, and 192 frames respectively: approximately `frameCount + 5` rather than a bounded series read.
- A three-series comparison summary required eight transactions, including three separate series-count operations.
- The current two-pass patient-key pattern required 20,400; 126,000; 502,000; and 2,004,000 patient-ID getter reads for 100, 250, 500, and 1,000 same-patient studies respectively: `2 × studyCount² + 4 × studyCount` in the measured harness.
- A production-equivalent selection-size reduction performed 65,536; 262,144; 1,048,576; and 4,194,304 size reads for 256, 512, 1,024, and 2,048 one-render-per-item updates respectively.
- A synthetic archive of 72 entries took approximately 2.31 ms to open, 16.88 ms to inflate, and 37.97 ms to ingest; 288 entries took approximately 2.39 ms, 47.13 ms, and 128.31 ms respectively. These are Node/fake-IDB component timings, not browser claims.
- A 96-image synthetic header probe read 98,304 bytes instead of 2,494,656 complete-file bytes, approximately 25.4× fewer bytes. However, the warm Node header probe took 3.01 ms versus 2.47 ms for full parsing. Reduced bytes do not automatically imply faster parsing.

For the actual 35,898-file corpus, current structural worst cases are:

- 35,898 four-store read/write transactions if all candidate frames are accepted.
- 143,592 store writes: one study, series, instance, and revision write per accepted image.
- 107,694 updates across the three current instance indexes, in addition to primary-key writes.
- 35,898 mutation publications and up to 35,898 progress publications.
- Up to `35,898 × 35,898 = 1,288,666,404` repeated size visits if every asynchronous progress update renders the modal. React batching can reduce actual renders; the formula is a structural upper bound, not an observed render count.

### 2.5. Actual-product visual and browser evidence

The live product was opened on an empty, isolated browser origin rather than on the user's existing patient-data-bearing application origin. Evidence contains no actual patient data:

- `artifacts/visual-validation/dicom-import-review-2026-08-24/empty-intake-state.jpg`
- `artifacts/visual-validation/dicom-import-review-2026-08-24/import-modal-idle.jpg`
- `artifacts/visual-validation/dicom-import-review-2026-08-24/import-folder-unsupported.jpg`

Measured at a 3029 × 1427 px actual browser viewport:

| Element                                 | Observed dimensions or behavior                     |
| --------------------------------------- | --------------------------------------------------- |
| Empty-state primary import action       | 384 × 52 px                                         |
| Empty-state header utility actions      | 36 × 36 px                                          |
| Import dialog                           | 576 × 455 px                                        |
| Apparent dashed drop surface            | 526 × 152 px; plain `DIV`; no role or tab stop      |
| Choose-files and choose-folder actions  | 38 px tall                                          |
| Cancel and Import footer actions        | 40 px tall                                          |
| Dialog close action                     | 40 × 40 px                                          |
| `window.showDirectoryPicker`            | unavailable in the reviewed browser                 |
| Folder action                           | still enabled despite unavailable folder API        |
| Immediate post-click folder observation | no visible error or alert in the captured DOM/frame |

The source intends to set an unsupported-folder error at `frontend/src/components/UploadModal.tsx:83`, so the immediate silent frame must be reconfirmed in a standard supported-browser matrix before claiming that the warning never appears. Regardless of timing, no real folder fallback exists in that branch.

The existing dark palette and typography are readable, but the small anonymous modal floats in a largely empty black field, the generic dashed box falsely suggests drop support, storage-risk text displaces the local-only privacy promise, and no source, patient, examination, storage, backup, or recovery manifest is visible.

## 3. Current architecture and ownership

```text
ComparisonMatrix
  ├── empty/header import entry points
  ├── UploadModal
  │     ├── File[] / ZIP / status / progress / AbortController state
  │     ├── showDirectoryPicker → eager recursive File[]
  │     ├── file selection → processFiles
  │     │     └── processDicomFile for every candidate
  │     │           └── parse whole file → 4-store write transaction
  │     └── ZIP selection → JSZip.loadAsync
  │           ├── raw archive → separate direct processDicomFile loop
  │           └── snapshot manifest → restoreSnapshot
  │                 ├── MiraViewerDB transaction
  │                 ├── separate model-cache database writes
  │                 └── localStorage writes
  └── onUploadComplete → useComparisonData.reload
        └── global loading branch unmounts the current modal
```

Current ownership boundaries:

- `frontend/src/components/UploadModal.tsx:14` owns UI selection, status, progress, a best-effort abort controller, ZIP classification, ZIP-entry orchestration, and the close timer.
- `frontend/src/services/dicomIngestion.ts:239` owns actual DICOM parsing, classification, metadata extraction, patient/geometry validation, storage, deduplication, dataset-revision mutation, and per-image invalidation.
- `frontend/src/services/archiveSafety.ts:20` opens and preflights archives after JSZip has loaded their compressed bytes.
- `frontend/src/services/exportBackup.ts:258` owns snapshot validation and the primary database transaction but writes model sidecars and preferences only after that commit.
- `frontend/src/db/db.ts:225` computes quota headroom from caller-supplied required bytes; it does not determine which candidates are genuinely new.
- `frontend/src/utils/localApi.ts:150` reconstructs comparison state after import; its current patient-key and series-count paths create separate scalability issues.
- `frontend/src/components/ComparisonMatrix.tsx:485` and `frontend/src/hooks/useComparisonData.ts:10` replace the entire interface during reload, including the modal that owns an active or recently completed operation.

The central design problem is split authority: the modal, file importer, archive importer, snapshot restore, quota preflight, and comparison reload each partially decide what the operation is doing and whether it finished successfully.

## 4. Existing capabilities that must be preserved

- All current acquisition data is processed and stored locally in the browser.
- Original DICOM bytes are retained as `Blob` values rather than lossy decoded pixel exports.
- IndexedDB provides durable patient/study/series/instance relationships and indexes for instance ordering.
- SOP-instance UIDs prevent ordinary duplicate image insertion.
- Existing checks reject known patient, issuer, study, series, frame-of-reference, orientation, dimensions, and spacing conflicts when both canonical and incoming values are already present.
- Secondary Capture and non-displayable objects are intentionally excluded from diagnostic comparison stacks.
- Enhanced multiframe objects are rejected explicitly rather than importing an incomplete stack.
- Archive entry count, declared size, expansion ratio, and traversal checks already exist, although admission occurs too late and CRC is not verified.
- Snapshot restoration preserves annotations, ground truth, volume labels, derived alignment frames, selected state, and locally cached models when every stage succeeds.
- Existing physical ordering, patient-space geometry, alignment-derived frame identity, and dataset-revision invalidation are correctness contracts.
- `AccessibleDialog` already supplies modal semantics, focus containment, background inertness, and focus restoration.
- Existing secondary text contrast is approximately 7.58:1 on the current panel; white primary-button text is approximately 5.17:1; the application already honors reduced-motion settings.

## 5. Prioritized findings and required decisions

### P0.1. Missing canonical metadata permits cross-patient and cross-frame contamination

**Evidence:** `frontend/src/services/dicomIngestion.ts:434`, `:439`, `:452`, `:497`, and `:498`.

Conflict checks execute only when the existing and incoming patient or frame fields are both nonempty. Parent upserts then use `{ ...incoming, ...existing }`, so an existing empty patient ID or undefined frame value permanently overrides later valid metadata.

Production-path synthetic result:

```json
{
  "outcomes": ["ingested", "ingested", "ingested"],
  "canonicalPatientIsMissing": true,
  "canonicalFrameIsMissing": true,
  "storedInstances": 3,
  "distinctNonemptyFrameCount": 2
}
```

The three inputs represent missing identity/frame, patient A/frame A, then patient B/frame B under reused study/series identities.

**Required change:** one field-aware canonical parent merger must bind trustworthy missing patient ID, issuer, frame, dimensions, spacing, and orientation exactly once; validate all incoming and already-staged records against the bound authority; and reject conflicting nonempty ownership before commit.

**Acceptance:** the missing → A → B sequence persists at most the missing and A records, binds the canonical fields to A, and rejects B without any cross-patient/frame commit. The same red/green sequence covers issuer, acquisition geometry, batch-local parents, and concurrent writers.

### P0.2. Parser errors can expose patient information and full image bytes

**Evidence:** `frontend/src/services/dicomIngestion.ts:264` logs the complete caught parser object at `:266`. The installed parser can throw an object containing a partially parsed dataset and its complete original byte array.

Production-path synthetic result:

```json
{
  "malformedErrorIncludesPatientMetadata": true,
  "loggedCompleteDicomBufferBytes": 391
}
```

**Required change:** log a sanitized category and deliberately normalized message only. Never log the raw error object, dataset, byte buffer, image, image path, original filename, patient identifier, UID, or inferred patient label.

**Acceptance:** adversarial malformed input with synthetic patient-like strings and pixels produces no such values in `console.error`, `console.warn`, thrown public messages, worker messages, browser instrumentation, or optional telemetry.

### P1.1. Cancel does not own ordinary file imports

**Evidence:** `frontend/src/components/UploadModal.tsx:146`, `:205`, `:258`, and `:379`; `frontend/src/services/dicomIngestion.ts:514` and `:528`.

An `AbortController` exists, but the ordinary file path passes no signal to `processFiles`, which loops until every file completes.

Production-path synthetic result:

```json
{
  "cancelRequestedAfter": 1,
  "abortSignalState": true,
  "processedAfterCancel": 3,
  "committedImages": 3,
  "datasetRevision": 3,
  "mutationNotifications": 3
}
```

ZIP cancellation is checked only between entries; folder discovery cannot be canceled; snapshot cancellation stops being checked after instance preparation.

**Required change:** route one `AbortSignal` through discovery, archive admission, decompression, worker parsing, candidate admission, commit boundaries, snapshot validation, and refresh. Define the exact noninterruptible transaction boundary rather than implying that a committed transaction can be rolled back.

**Acceptance:** after cancellation is acknowledged, no new candidate begins; at most an already-committing batch completes; committed images remain visible; stale work cannot publish a later success.

### P1.2. Valid heterogeneous scout acquisitions appear as successful partial data loss

**Evidence:** `frontend/src/services/dicomIngestion.ts:481` rejects an image when its row, column, or normal direction does not match the first image stored under the same `SeriesInstanceUID`.

The 512-image protected-corpus sample rejects six valid MR scout/localizer images from one series: three sagittal and three axial images in an otherwise coronal canonical stack. The parent modal enters `success` whenever at least one image was accepted; rejection counts are secondary text and are then hidden by application reload or an untracked two-second close timer.

**Required decision:** choose one explicit product policy:

1. Classify and visibly report heterogeneous localizer/scout images as intentionally excluded from diagnostic stacks; preserve aggregate evidence and explain why.
2. Preserve every supported image by introducing stable, geometry-homogeneous virtual acquisition-stack identities, with coordinated changes to manifests, indexes, `SeriesRef`, viewer lookup, annotations, snapshot compatibility, alignment, and SVR eligibility.

Phase one should implement option 1 unless a dedicated downstream identity design establishes option 2. Never silently merge orthogonal slices into one alignment/SVR stack, and never present real image rejection as uncomplicated success.

**Acceptance:** the same 512 protected files produce an explicit count and reason for all six scout images, or preserve all six in independently safe virtual stacks; no generic `db-error` or undisclosed green partial outcome remains.

### P1.3. Duplicate replay repeats full parsing and write-lock acquisition

**Evidence:** `frontend/src/services/dicomIngestion.ts:247` reads the complete file and parses it before the SOP lookup at `:424`; even the duplicate path opens a four-store `readwrite` transaction at `:420`.

On the protected 512-file sample, replay still took 140 ms and acquired 489 read/write transactions without writing a single row. On 576 synthetic duplicates, replay reread and re-locked all 576 images.

**Required change:** measure a bounded identity-header probe; consult existing SOP ownership through a read-only admission path; avoid full payload read and write-lock acquisition for proven existing instances; fall back safely when the prefix cannot establish transfer syntax and required identifiers.

**Acceptance:** all-duplicate replay performs zero blob writes, zero parent rewrites, zero dataset revisions, zero false quota failures, and no per-image read/write transactions. Report full-source bytes read separately from small identity-header bytes.

### P1.4. Every accepted image rewrites parents, revision state, and indexes

**Evidence:** `frontend/src/services/dicomIngestion.ts:420` through `:505` performs one transaction, four store reads, four puts, three instance-index updates, one revision bump, and one mutation callback per new image.

For 35,898 accepted images, the current shape implies 35,898 four-store transactions and 143,592 puts before considering index maintenance.

**Required change:** stage a bounded group of fully parsed, validated new images; open one four-store transaction; merge each affected parent once; insert each new instance; read and write dataset revision once; commit; then publish the genuinely affected series once.

**Contract caveat:** `frontend/tests/storageIntegrity.test.ts:556` asserts that two committed new images produce dataset revision `2`, and derived alignment state uses that revision. A batch that accepts `k` new images must write `nextRevision = previousRevision + k`, not `previousRevision + 1`, unless every existing consumer and test is intentionally migrated.

**Acceptance:** transactions scale with committed batches rather than frames; unchanged parent rewrites collapse; original blobs, SOP ownership, ordering, revision values, stale-frame rejection, and committed-series invalidation remain correct.

### P1.5. Modal progress can amplify selection work quadratically

**Evidence:** `frontend/src/components/UploadModal.tsx:250` recomputes `files.reduce(file.size)` on every render, while `:205` and `frontend/src/services/dicomIngestion.ts:545` publish per-file progress.

At the current corpus cardinality, the one-render-per-callback upper bound is `35,898² = 1,288,666,404` size accesses. React may batch updates; this is a code-derived upper bound, not a measured actual browser count.

**Required change:** compute immutable discovery totals exactly once; publish execution snapshots at a bounded cadence, approximately 5–10 Hz as an initial measurement hypothesis; always publish phase changes and terminal outcomes immediately.

**Acceptance:** size access remains linear in discovered candidates; progress publication is bounded by elapsed operation time rather than file count; the main thread remains responsive to Cancel and keyboard input.

### P1.6. Preflight charges duplicates and excluded objects as new storage

**Evidence:** `frontend/src/services/dicomIngestion.ts:518` preflights the sum of every selected file; `frontend/src/services/archiveSafety.ts:53` charges every archive entry before actual DICOM classification or duplicate admission.

Production-path synthetic result:

```json
{
  "duplicateRejectedByQuota": true,
  "additionalImageBytesRequired": 0
}
```

**Required change:** base quota admission on newly admissible instance blobs, required metadata/index overhead, bounded temporary archive/model storage, and a measured safety reserve. Existing SOPs and known excluded sidecars contribute no new durable image bytes.

**Acceptance:** a complete duplicate replay succeeds even when available quota is below the nominal selected-file total. A truly insufficient new-image batch fails before that batch mutates storage and states actual estimated required versus available space.

### P1.7. ZIP corruption is accepted when the member length is unchanged

**Evidence:** `frontend/src/services/archiveSafety.ts:20` uses `JSZip.loadAsync` with its default CRC checking disabled; `:57` checks only inflated length.

Production-path synthetic result:

```json
{
  "corruptedArchiveAccepted": true,
  "declaredLength": 4,
  "actualLength": 4,
  "contentChangedWithoutError": true
}
```

Some modern snapshots additionally validate a SHA-256 descriptor when both the hash and `crypto.subtle` are available. Raw image archives and legacy snapshots do not gain equivalent protection.

**Required change:** validate the relevant member's CRC while consuming its actual bytes, preserve snapshot SHA-256 verification, and make integrity failure a categorized per-item or whole-backup result as appropriate. Avoid an unbounded global `checkCRC32: true` prepass that decompresses the entire archive before useful work begins.

**Acceptance:** a single-bit corruption with unchanged size fails before image or backup commit; valid entries are not decompressed twice merely to establish integrity.

### P1.8. Archive memory admission is late and the real corpus exceeds its ceiling

**Evidence:** `frontend/src/services/archiveSafety.ts:20` loads the complete ZIP before inspecting entry counts and sizes; `:6` and `:48` impose a 4 GiB uncompressed ceiling.

JSZip's current browser loading path materializes compressed archive bytes before the application-level safety checks run. The real DICOM corpus alone is 6,999,291,884 bytes versus a 4,294,967,296-byte ceiling.

**Required change:** reject clearly excessive compressed inputs before complete loading. For true whole-corpus ZIP support, evaluate a browser-compatible random-access or streaming central-directory/member reader with bounded buffers, ZIP64 support, cancellation, per-entry CRC, and explicit decompression budgets.

**Acceptance:** either a valid full-corpus archive imports within a measured bounded-memory/quota envelope, or the interface explicitly states its actual supported ceiling before import starts. Raising the JSZip limit alone is not an acceptable scalability fix.

### P1.9. Complete-backup restoration is not atomic across its two databases

**Evidence:** `frontend/src/services/exportBackup.ts:402` commits the primary database at `:468`; cached models are stored afterward at `:470` in the separate database defined by `frontend/src/utils/segmentation/onnx/modelCache.ts:4`.

Production-path synthetic result:

```json
{
  "restoreFailed": true,
  "errorKind": "VersionError",
  "mainDatabaseCommittedInstances": 1,
  "mainDatabaseCommittedStudies": 1,
  "mainDatabaseRevision": 2
}
```

IndexedDB cannot execute one atomic transaction across separate database names.

**Required change:** preflight both databases and sidecars; stage model assets before visible primary commit where safe, or maintain an explicit durable recoverable checkpoint; distinguish pre-commit failure, committed-primary/pending-sidecar failure, and fully finalized success.

**Acceptance:** injected model-cache `VersionError`, quota failure, unexpected tab closure, and repair-on-reopen never report that no medical data changed after the primary database actually committed.

### P1.10. Failure isolation differs between ordinary files and ZIP members

**Evidence:** metadata extraction at `frontend/src/services/dicomIngestion.ts:270` through `:410` sits outside both local protected blocks. `processFiles` catches unexpected exceptions per file at `:528`; the raw ZIP loop calls `processDicomFile` directly from `frontend/src/components/UploadModal.tsx:178`.

Production-path synthetic result:

```json
{
  "directZipStyleCallThrows": true,
  "batchFileStyleContinues": true,
  "batchErrorCount": 2
}
```

**Required change:** route every source through the same bounded per-candidate classifier and error-isolation policy. Keep backup integrity atomic at its actual supported boundary; ordinary image imports should isolate one malformed member without discarding truthful prior committed outcomes.

**Acceptance:** the same malformed candidate produces the same sanitized error category in a file list, folder, dropped source, and image ZIP, and later valid candidates continue when policy allows.

### P1.11. Completion, reload, timers, and ownership are inconsistent

**Evidence:** `frontend/src/components/UploadModal.tsx:229` sets success, immediately invokes parent reload, then schedules an untracked two-second close. `frontend/src/hooks/useComparisonData.ts:12` sets global loading, and `frontend/src/components/ComparisonMatrix.tsx:485` unmounts the current modal. Cancellation and failure do not invoke the same reload path.

Consequences:

- Successful results may vanish before the user reads them.
- Images already committed before cancellation or failure may not appear without a later manual reload.
- An old close timer can close a newly reopened import dialog.
- Modal disposal does not prove the underlying import stopped.
- An all-duplicate no-op can trigger the same disruptive application reload as new image data.

**Required change:** make the operation survive ordinary UI redraws; refresh comparison state non-destructively when committed data genuinely changes; retain terminal results until explicit dismissal; cancel or invalidate stale callbacks on operation disposal.

**Acceptance:** success, partial success, cancellation, failure, modal reopen, Escape, and component unmount preserve exactly one coherent operation and truthful visible committed data.

### P2.1. Folder discovery is eager, serial, and browser-dependent

**Evidence:** `frontend/src/components/UploadModal.tsx:63` recursively constructs an entire `File[]`; `:79` supports only `showDirectoryPicker`; `:318` restricts the regular input to known filename extensions.

The actual reviewed browser exposes no `showDirectoryPicker` but presents an enabled folder action. Directory traversal has no progress, cancellation, bounded depth, entry policy, early sidecar filtering, relative provenance, or memory backpressure. The regular picker can hide valid extensionless acquisitions.

**Required change:** support capability-aware folder handles and a directory-input fallback where available; accept normal file lists and extensionless objects; normalize everything into lazy, cancellable candidates with relative source provenance retained locally only.

**Acceptance:** a 35,898-file folder shows immediate discovery feedback, can be canceled, and never requires one eagerly expanded `File[]`; unsupported browsers explain and offer their strongest real alternative.

### P2.2. Current preambleless-DICOM claim does not match parser behavior

**Evidence:** `frontend/src/services/dicomIngestion.ts:252` says a Part 10 preamble is optional but invokes `dicomParser.parseDicom(byteArray)` without an explicit transfer syntax at `:264`.

Production-path synthetic result:

```json
{
  "rawDatasetContainsValidPixels": true,
  "rawImportStatus": "error",
  "rawImportReason": "parse-error"
}
```

**Required decision:** either support a narrowly defined and safely established raw transfer syntax, with tests for ambiguity and compressed data, or present a truthful unsupported-raw-dataset outcome. Never guess ambiguous syntax merely to claim wider compatibility.

### P2.3. Post-import summary and manifest work scale poorly

**Evidence:** `frontend/src/db/patientIdentity.ts:14` scans all studies for each requested key; `frontend/src/utils/localApi.ts:155` and `:179` invoke that function in two study-wide passes; `:205` creates one count transaction per series; `:420` creates one image transaction per manifest frame.

**Required change:** derive conservative patient identities once from a grouped study pass, preserve the exact name-conflict isolation policy, use bounded cursor/index traversal for affected-series counts and metadata, and avoid loading image blobs when only metadata is required.

**Acceptance:** patient identity construction is linear in studies plus names, series counting is bounded rather than one unconstrained promise/transaction per series, and manifest construction reads ordered frame metadata without `frameCount` independent transactions.

### P2.4. The intake surface is generic, inaccessible, and ambiguous

**Evidence:** `frontend/src/components/UploadModal.tsx:300` uses a clickable non-focusable `div`; `:346` exposes visually small source buttons; `:362` presents non-semantic progress; `:371` displays errors without an alert role. Different application entry points use inconsistent “Load,” “Import,” “DICOM ZIP,” and folder labels.

The current surface does not explain local-only handling, patient/examination boundaries, storage headroom, folder capability, unsupported objects, duplicate behavior, backup side effects, cancellation semantics, or retained results.

**Required change:** build one deliberate, accessible Acquisition Intake Console with distinct source, review, execution, and result states, truthful backup consent, actual acquisition evidence, and a consistent clinical visual system.

**Acceptance:** every supported entry point leads to the same understandable workflow, keyboard/touch/screen-reader paths work, results persist, and no decorative content impersonates real medical findings.

## 6. Governing product and data contracts

### 6.1. Clinical and ownership invariants

1. IndexedDB remains the sole durable authority for committed medical image identity.
2. A committed SOP instance belongs to exactly one validated study and real DICOM series.
3. A study never combines incompatible nonempty patient IDs or identifier issuers.
4. Missing identity is never used as evidence that two unrelated patients match.
5. Missing canonical identity may be enriched only under an already established safe study boundary; once bound, it cannot silently change.
6. A diagnostic stack never mixes incompatible spatial frames, orientation normals, dimensions, calibrated spacing, or unsafe acquisition geometry.
7. Secondary Capture, non-displayable DICOM, enhanced multiframe, scout images, and malformed input receive distinct truthful classification rather than one generic error bucket.
8. Original retained DICOM bytes remain byte-for-byte unchanged.
9. Existing SOP ownership collisions across studies or series are rejected, even during concurrent operations.
10. Derived alignment and SVR state is invalidated by the same authoritative dataset-revision semantics already tested by the repository.
11. The final dataset revision advances by the exact number of successfully committed new image instances unless an intentionally migrated contract says otherwise.
12. Snapshot restore never claims cross-database atomicity that IndexedDB cannot provide.
13. No source path, patient identifier, UID, date, acquisition label, pixel buffer, or image is sent to a network or emitted to nonlocal diagnostics.
14. Already committed images are never described as uncommitted after cancellation, error, or partial restore.

### 6.2. Interaction invariants

1. There is at most one active intake operation per mounted application scope.
2. The operation owns its source, signal, queues, committed counters, and final outcome.
3. A source selection becomes immutable while execution is active.
4. Closing the visual surface cannot silently abandon a running writer.
5. Cancel means “stop admitting new work and safely resolve the current commit,” not “delete already imported medical images.”
6. Patients can always inspect whether scans, complete backups, annotations, models, or selected-patient context will change before authorizing an operation.
7. Discovery, archive verification, importing, restoring, cancellation, and finalization are visually distinguishable.
8. Terminal results remain available until the user explicitly dismisses or opens the imported examinations.
9. Every ordinary source type receives consistent duplicate, skip, malformed-file, cancellation, and partial-commit behavior.
10. Local processing and actual storage durability/headroom are visible throughout the workflow.

### 6.3. Performance invariants

- No full-corpus `File[]`, inflated ZIP-member array, or unbounded `Promise.all` is required for normal folder import.
- Every queue has an image-count limit and a byte limit.
- No parser or decompressor schedules more work after its operation is canceled.
- No write transaction remains open while awaiting worker responses, file reads, decompression, cryptographic hashing, or unrelated event-loop work.
- UI updates are time-bounded, not image-count-bounded.
- Parent writes, dataset-revision writes, notifications, and database transactions are proportional to changed parents and committed batches, not blindly to every submitted file.
- Patient grouping and selection-size accounting are linear in input cardinality apart from intentional sort operations.
- Optimization choices remain measurement-gated: worker count, header probing, batch size, ZIP engine, and metadata storage must not become speculative infrastructure.

## 7. Target architecture

```text
              ┌────────────────────────────────────────────┐
              │ Acquisition Intake Console                 │
              │ Source → Review → Execute → Results        │
              │ local-only trust rail / accessible status  │
              └──────────────────┬─────────────────────────┘
                                 │ immutable operation snapshot
                                 ▼
              ┌────────────────────────────────────────────┐
              │ ImportOperation                            │
              │ operationId · AbortSignal · source manifest│
              │ bounded queues · committed facts · outcome │
              └──────────────────┬─────────────────────────┘
                                 │
    ┌────────────────────────────┼────────────────────────────┐
    ▼                            ▼                            ▼
 File/folder/drop        DICOM ZIP source            Complete backup
 lazy candidates         bounded member reader       explicit consent
    └────────────────────────────┬─────────────────┘          │
                                 ▼                            │
                    admission / identity probe                │
                                 ▼                            │
                    bounded parser / integrity stage          │
                                 ▼                            │
                    canonical batch transaction               │
                                 │                            │
                                 ▼                            ▼
                    committed results + series invalidation   staged/recoverable restore
                                 └──────────────┬─────────────┘
                                                ▼
                                 nondestructive comparison refresh
```

The intended structure is compact:

- One operation coordinator, not independent file, folder, ZIP, and UI state machines.
- One canonical per-image identity/classification/validation path, not separate archive-specific writes.
- One batch writer, not many concurrent writers racing over the same stores.
- One authoritative committed-result stream, not optimistic UI counts plus a separate ingestion summary.
- One explicitly separate complete-backup mode because its restore semantics, side effects, and atomicity differ from ordinary image import.
- Existing database/index contracts remain authoritative; caches or queues are bounded transient accelerators only.

### 7.1. Suggested module boundaries

These are proposed responsibility boundaries, not a requirement to introduce every named file or abstraction:

- `frontend/src/services/import/importOperation.ts`: operation identity, phase transitions, cancellation, snapshots, and orchestration.
- `frontend/src/services/import/importSources.ts`: file-list, folder-handle, directory-input, dropped-source, and raw-archive candidate adapters.
- `frontend/src/services/import/importAdmission.ts`: bounded identity probe, canonical duplicate lookup, candidate classification, quota estimation, and patient review.
- `frontend/src/services/import/importBatchWriter.ts`: canonical parent enrichment, identity/geometry checks, one write transaction per admitted chunk, revision preservation, and post-commit notification.
- `frontend/src/services/archiveSafety.ts`: bounded archive admission, safe member paths, expansion limits, integrity, and cancellation.
- `frontend/src/services/exportBackup.ts`: explicit complete-backup validation, restore staging, real commit boundaries, and restart recovery.
- `frontend/src/components/UploadModal.tsx` or a deliberately renamed intake component: accessible source/review/progress/results rendering only.
- `frontend/src/hooks/useComparisonData.ts`: nondestructive refresh after actual committed changes.
- `frontend/src/utils/localApi.ts`: linear patient grouping and bounded comparison/manifest reads.

Prefer extending an existing module when a separate file would introduce indirection without a real ownership boundary. Do not add persistent operation tables, worker pools, caches, counters, or generation records until the relevant measured requirement justifies them.

### 7.2. Operation snapshot shape

An operation snapshot should expose stable, aggregate facts, not patient data copied into arbitrary diagnostics:

```ts
type ImportPhase =
  | "idle"
  | "discovering"
  | "reviewing"
  | "preflighting"
  | "importing"
  | "restoring"
  | "canceling"
  | "finalizing"
  | "completed"
  | "partial"
  | "canceled"
  | "failed";

type ImportSnapshot = {
  operationId: string;
  sourceKind: "files" | "folder" | "drop" | "image-archive" | "complete-backup";
  phase: ImportPhase;
  discoveredCandidates: number;
  discoveredBytes: number;
  admittedCandidates: number;
  processedCandidates: number;
  committedImages: number;
  duplicateImages: number;
  excludedImages: number;
  unsupportedImages: number;
  failedImages: number;
  committedBatches: number;
  affectedSeriesCount: number;
  availableBytes?: number;
  projectedAdditionalBytes?: number;
  discoveryComplete: boolean;
  commitInProgress: boolean;
  cancellationRequested: boolean;
  elapsedMs: number;
  issues: readonly SanitizedImportIssue[];
};
```

This example is a contract sketch, not an instruction to persist all fields. On-screen patient/examination preview belongs to an explicitly local, patient-aware view model; generic debug snapshots remain de-identified.

### 7.3. Lifecycle and legal transitions

```text
idle
  → discovering
  → reviewing
  → preflighting
  → importing | restoring
  → finalizing
  → completed | partial | canceled | failed

discovering | preflighting | importing | restoring
  → canceling
  → canceled | partial

already-committing restore/import
  → finalizing
  → completed | partial
```

Rules:

1. Only the active operation ID can publish progress, errors, or terminal state.
2. Source controls disable while discovery or execution owns the current signal.
3. Picker dismissal returns to the previous stable selection without starting a phantom operation.
4. `reviewing` occurs before durable mutation and before complete-backup consent.
5. `canceling` immediately prevents new queue admission and closes the source iterator.
6. An active IndexedDB transaction may be explicitly aborted only while it is still active and rollback is guaranteed; otherwise enter `finalizing` and explain the real noninterruptible boundary.
7. Committed counters advance only after `transaction.done` succeeds.
8. A failed transaction contributes zero image commits and publishes no series invalidation.
9. Terminal state is derived from durable commit facts and categorized exclusions/errors, not merely from the absence of an exception.
10. Operation cleanup invalidates scheduled callbacks, clears timers, releases queue references, and ensures an abandoned modal cannot close its replacement.

### 7.4. Operation ownership and application refresh

The operation must be owned by a scope that survives the modal's ordinary progress redraw and comparison refresh. Two acceptable minimal shapes are:

1. A `useImportOperation` hook mounted in `ComparisonMatrix`, with the modal observing it and `useComparisonData.reload` gaining a nondestructive refresh mode.
2. A small existing-service coordinator observed by the modal, provided cleanup and user-visible state remain bound to the current application instance.

Do not create a second independently authoritative persisted import log simply to make a component remount safe.

Refresh rules:

- Zero committed new images: retain existing comparison state; show all-duplicate or exclusion results without a full reload.
- One or more successful new batches: refresh after durable changes on a bounded cadence or once on operation completion, depending on measured reader cost.
- Cancellation after commits: refresh once and retain a cancellation result stating the committed count.
- Failure after commits: refresh once and retain a partial result with actionable recovery.
- Snapshot primary commit with sidecar failure: refresh the primary data and expose a durable repair-required state.
- A comparison refresh must not replace and unmount the currently visible intake results.

## 8. Source acquisition and bounded discovery

### 8.1. Canonical candidate contract

Normalize ordinary sources into a lightweight, lazy shape:

```ts
type ImportCandidate = {
  sourceKind: "file" | "folder-entry" | "dropped-entry" | "archive-entry";
  relativePath: string;
  declaredBytes?: number;
  open: (signal: AbortSignal) => Promise<Blob>;
  integrity?: {
    crc32?: number;
    sha256?: string;
  };
};
```

`relativePath` is available only to the local UI and local, bounded error details. It is never emitted to public metrics, logs, telemetry, screenshots, or committed benchmark fixtures.

Source adapters must:

1. Yield candidates progressively rather than returning an entire folder-sized array.
2. Check cancellation between directory handles, file reads, central-directory windows, and archive chunks.
3. Emit discovery counts and byte estimates as soon as work begins.
4. Apply early hidden/known-sidecar filtering without mistaking unknown extensions or extensionless DICOM for non-images.
5. Preserve deterministic relative order where possible without globally sorting or buffering an entire 35,898-file tree.
6. Enforce configurable depth, entry-count, compressed-byte, uncompressed-byte, and pending-byte limits with actionable outcomes.
7. Close iterators and release references after cancellation or an operation error.
8. Use one bounded queue so a slow writer naturally slows discovery and decompression.

### 8.2. Individual and multiple file selection

- Expose **Choose files** as a real labeled button.
- Allow ordinary multiple selection.
- Do not rely on an extension-only `accept` restriction that makes extensionless files impossible to select; use an unrestricted or explicitly broadened picker and classify contents safely afterward.
- Distinguish image archives from complete backups using validated content/manifest evidence, not the `.zip` suffix alone.
- Handle a selection containing both a ZIP and standalone DICOM files predictably:
  - Preferred: flatten each image archive into the same ordinary candidate operation and preserve deterministic source grouping.
  - Acceptable first phase: reject the mixed selection during review, before any mutation, with explicit instructions.
- A complete backup mixed with ordinary files must be separated into its own explicitly authorized restore operation.
- Re-selecting the same files after a terminal outcome should work without a stale input-value or operation-ID issue.

### 8.3. Folder selection and compatibility fallback

Capability order:

1. Use `showDirectoryPicker` when it is actually available in the current secure context and the user grants permission.
2. Otherwise, expose `<input type="file" webkitdirectory multiple>` when the running browser actually supports directory selection.
3. Otherwise, offer ordinary multi-file selection, ZIP import, or a precise unsupported-folder explanation.

Do not show an enabled “Choose folder” action that is incapable of opening any real folder mechanism. If capability depends on context, explain the actual requirement rather than claiming every browser supports the File System Access API.

Folder-specific behavior:

- Present `Scanning folder…` immediately after the user selects a directory.
- Show discovered files, candidate images, estimated bytes, and an indeterminate state while total count is still unknown.
- Prefer iterative traversal over recursive child-array spreads.
- Bound ancestry/depth and use an available handle-comparison mechanism only where the platform exposes one; do not claim unverified symlink semantics.
- Treat permission denial, revoked handles, empty folders, and unreadable files as distinct recoverable outcomes.
- Keep path provenance relative; never reveal the user's full absolute source path in public output.
- Begin bounded review/admission as soon as enough safe evidence exists instead of waiting silently for complete enumeration.

### 8.4. Drag and drop

Implement a real keyboard-operable drop region rather than styling an inert `div`:

- Use an accessible button-backed surface or a clearly named group containing actual source buttons.
- Add `dragenter`, `dragover`, `dragleave`, and `drop` handling with a stable active-target state.
- Normalize dropped `File` objects through the same file source adapter.
- Use directory handles or browser-specific directory entries only when supported; otherwise explain that the dropped folder must be chosen through the folder control.
- Reject links, HTML snippets, arbitrary text, and network-derived drag payloads without following remote URLs.
- Keep focus, pointer interaction, and visible hover/drop feedback equivalent.
- Never introduce a hidden server upload simply because an input is labeled “upload.”

### 8.5. Content recognition and unsupported input

Classification order:

1. Reject known hidden/system sidecars and explicitly unsupported archive nesting according to documented policy.
2. Recognize ZIP signatures and bounded archive metadata rather than trusting only filenames.
3. Recognize ordinary DICOM Part 10 content via safe header evidence.
4. Admit extensionless or unusual-extension DICOM when its content validates.
5. Handle raw preambleless datasets only when an explicitly supported transfer syntax can be established safely.
6. Classify malformed, non-displayable, Secondary Capture, enhanced-multiframe, and scout/localizer cases distinctly.

Absence of `DICM` alone is not proof of non-DICOM. Conversely, a plausible extension or four magic bytes alone is not proof that a file is safe, correctly encoded, or displayable.

## 9. Patient, study, series, and geometry admission

### 9.1. Field-aware canonical parent enrichment

Implement one canonical merge function that operates on persisted parents plus all accepted records already staged in the current batch.

For patient fields:

- An existing nonempty patient ID remains authoritative.
- A missing canonical ID can be bound to a trustworthy incoming ID under the same safely owned study.
- Once bound, a different nonempty ID is rejected.
- Identifier issuer is independently bound and checked; equal IDs from incompatible nonempty issuers do not merge.
- Missing names do not establish equivalence. Nonempty conflicting names follow an explicit conservative policy and are never used alone to override ID/issuer ownership.
- Missing identity in one study never joins another unrelated study solely because both are blank.

For study and series fields:

- `StudyInstanceUID` and real `SeriesInstanceUID` retain their original DICOM meaning.
- An existing series cannot be rebound to a different study.
- Missing descriptive metadata can be enriched without replacing established ownership.
- Blank or undefined prior values must not overwrite a valid later canonical value.
- Benign descriptive differences are classified separately from identity conflicts.

For spatial fields:

- Bind the first trustworthy frame-of-reference UID once; reject conflicting nonempty later values.
- Bind dimensions, calibrated pixel spacing, and reliable orientation once per geometry-homogeneous diagnostic stack.
- Apply the existing tolerance and patient-space validation rules consistently within a batch and across existing commits.
- If a field is unavailable, preserve uncertainty rather than inventing a default that implies a reliable patient-space transform.

### 9.2. Required identity transition tests

At minimum, validate:

1. Missing patient → patient A → patient B.
2. Missing issuer → issuer A → issuer B.
3. Missing frame → frame A → frame B.
4. Missing orientation → canonical orientation → orthogonal orientation.
5. Missing spacing → valid spacing → conflicting spacing.
6. Missing names, matching IDs, and conflicting nonempty names under the current conservative patient-grouping policy.
7. Same SOP UID under a different study.
8. Same SOP UID under a different series.
9. Two conflicting candidates in the same not-yet-committed batch.
10. A concurrent canonical writer inserting the same SOP after the read-only duplicate precheck.
11. Cancellation between parent staging and image insertion.
12. Aborted transaction leaving no orphaned study, series, instance, or revision change.

All fixtures use synthetic identities; public assertion output contains categories and counts only.

### 9.3. Heterogeneous scout/localizer policy

The supplied corpus establishes a real, valid DICOM series that contains multiple orthogonal scout orientations under one series UID. Therefore “every series UID is one planar volume” is an application assumption, not a universal DICOM property.

Recommended implementation sequence:

1. Detect that an otherwise valid MR frame conflicts only with the stack's geometry and carries recognizable scout/localizer metadata.
2. Return a named classification such as `excluded-localizer-orientation`, not `db-error`.
3. Include the category in review and retained terminal results.
4. Keep heterogeneous scouts out of auto-alignment and SVR inputs unless separated into reliable homogeneous stacks.
5. For heterogeneous non-scout acquisitions, surface a review-required geometry conflict rather than silently discarding the image.
6. Decide separately whether the product must preserve/view every scout image; if yes, design stable virtual stack identities before implementation.

If virtual stacks are approved, their stable identity must include the original real series UID and a validated geometry-group fingerprint. That change requires a coordinated migration of database lookup/indexes, frame manifests, selected series, Cornerstone image lookup, annotations, backup import/export, comparison matrices, alignment, and SVR. It must not overload or falsify the DICOM `SeriesInstanceUID` field itself.

## 10. Bounded parsing, duplicate admission, and durable batch writes

### 10.1. Candidate preparation

For every ordinary acquisition candidate:

1. Obtain only the smallest safe initial source/header window.
2. Classify obvious excluded sidecars without charging them as future medical storage.
3. If appropriate, establish SOP, study, and series identities from a supported bounded parse.
4. Batch read-only duplicate/ownership checks.
5. Fully parse only genuinely new candidates or candidates whose bounded identity is incomplete or unsafe.
6. Normalize and validate patient/study/series/frame metadata before opening a write transaction.
7. Verify archive-member CRC or required snapshot hashes before candidate admission.
8. Place fully prepared candidates into a count- and byte-bounded writer queue.
9. Recheck operation identity and cancellation at every boundary.

The original `File` or `Blob` should remain the persistence payload when practical. Whether additional Blob wrappers share backing bytes is browser-dependent; measure actual browser behavior before claiming a copy reduction.

### 10.2. Adaptive identity-header probing

The installed DICOM parser supports an `untilTag` option. A small, representative synthetic set yielded every required identity from a 1 KiB prefix and reduced bytes read by approximately 25.4×, but the warm Node CPU observation was slightly slower than whole-file parsing.

Therefore:

- Do not blindly add a second parse to every new image.
- Evaluate the protected corpus's actual header offsets, transfer syntaxes, encapsulated pixel placement, and duplicate rates without emitting tag contents.
- Use an adaptive bounded header window with a measured maximum and an immediate safe fallback.
- Enable header-first probing where duplicate likelihood, source latency, or large file size produces a verified browser benefit.
- Keep the persisted database—not a filename, path, size, hash guess, or in-memory set—as the final SOP ownership authority.
- Revalidate SOP, study, and series ownership inside the final transaction to prevent concurrent-writer races.
- Never assume that all required tags appear in the first 1 KiB or before every vendor-specific private element.
- Never guess raw preambleless transfer syntax or declare encapsulated pixel content valid from a prefix that cannot establish it.
- Avoid hashing an entire image solely to replace an existing reliable SOP identity.

Acceptance measurements should include complete-image bytes read, header bytes read, total parser invocations, cold new-image latency, warm duplicate latency, and mixed 0%/25%/50%/90%/100% duplicate workloads.

### 10.3. Canonical batch transaction algorithm

Pseudocode:

```text
prepared = collectWithin(countBudget, byteBudget, timeBudget, abortSignal)
if prepared is empty: return

check abortSignal before opening a transaction
open readwrite transaction: studies, series, instances, app_state
load current revision once

for each prepared candidate in deterministic order:
  read canonical persisted/staged SOP ownership
  if already present with equal study/series:
    record duplicate; do not rewrite parents or revision
    continue
  if present with conflicting ownership:
    record identity conflict; follow documented batch-failure policy
    continue or abort according to clinical severity

  enrich and validate canonical patient/study/series fields
  reject incompatible frame, dimensions, spacing, or diagnostic orientation
  stage changed parent records
  insert the original validated instance Blob
  increment staged-new-image count
  record affected series

write each changed study once
write each changed series once
if staged-new-image count > 0:
  write revision = previous revision + staged-new-image count

await transaction.done
advance committed counters only now
notify each genuinely affected series at most once for this batch
publish one bounded operation snapshot
```

IndexedDB-specific constraints:

- Complete source reads, parser work, worker messages, ZIP inflation, cryptographic hashing, and quota estimation before opening the transaction.
- Do not await unrelated promises while a transaction is active; browser transactions may auto-close.
- Keep one canonical write transaction in flight for overlapping stores.
- Ensure errors abort or settle the whole transaction before returning a terminal result.
- Do not publish a dataset mutation, patient preview, or successful image count before `transaction.done`.
- Resolve duplicate races using the actual transaction result, not an optimistic read-only precheck.
- Retain parent-child atomicity: no patient/study/series row should appear without the intended safely committed image unless the existing product contract explicitly permits it.
- Preserve the final historical revision value: `previousRevision + newlyCommittedImageCount`.
- If a batch contains several affected series, invalidate each changed series once after durable commit, or introduce one documented multi-series notification that preserves every existing consumer contract.

### 10.4. Selecting batch and queue budgets

Candidate starting points, to be verified rather than hard-coded as promises:

- 32–256 prepared images per commit.
- Approximately 8–32 MiB of prepared image payload per active batch.
- One active writer transaction.
- One small producer queue and one small prepared queue, each independently byte-bounded.
- 5–10 visible progress snapshots per second, with immediate phase and terminal updates.

For the actual 35,898-image corpus, a hypothetical constant batch of 128 new images implies approximately 281 write transactions instead of 35,898. If every batch additionally requires one separate bounded read-only duplicate transaction, the nominal total is approximately 562 transactions. These are arithmetic estimates; real heterogeneous payloads, abort latency, quota, transaction duration, browser limits, and competing workloads must determine the production policy.

Batch-size adjustment should prioritize:

1. Patient safety and transactional atomicity.
2. Cancellation responsiveness.
3. Main-thread input latency and paint stability.
4. Bounded peak live bytes.
5. Actual browser transaction throughput.

An unusually large image, archive entry, or low-memory device must shrink the byte batch independently of its nominal frame count.

### 10.5. Worker offload and backpressure

Do not start by adding an unbounded worker pool. First remove per-file write amplification and render amplification, then profile actual browsers.

If parsing or decompression remains a material main-thread bottleneck:

- Use a small adaptive worker count selected from measured throughput and input responsiveness.
- Preserve offline Vite build, static asset hosting, and downloadable ZIP operation.
- Avoid requirements for cross-origin isolation or server-only worker headers unless an already verified fallback exists.
- Transfer bounded `ArrayBuffer` ownership only when it actually avoids redundant copies and does not discard the original Blob required for persistence.
- Return normalized metadata or explicit safe parse failures, never arbitrary parser datasets containing patient data.
- Apply backpressure all the way to directory enumeration and ZIP-member inflation.
- Stop admitting worker jobs immediately when canceled.
- Terminate or drain worker tasks according to the real browser cancellation primitive available.
- Bound queued count, queued bytes, active workers, active inflate buffers, and outstanding worker messages.

Required browser metrics: main-thread long tasks, interaction-to-cancel acknowledgment, animation/presentation cadence, queue high-water bytes, worker count, archive inflation time, parsing time, writer commit time, and total completed-image throughput.

### 10.6. Correct incremental quota accounting

Represent a prospective batch as:

```text
new instance Blob bytes
+ estimated study/series/instance/index metadata overhead
+ bounded decompression/staging bytes
+ required backup model/annotation sidecars, where applicable
+ measured reserve/headroom
- already committed or duplicate payload bytes
```

Rules:

1. Preserve a meaningful reserve rather than filling browser storage to the absolute quota.
2. Treat `navigator.storage.estimate()` as an estimate; never advertise exact guaranteed availability.
3. Refresh the estimate between substantial committed chunks or when storage pressure changes.
4. Reject a new batch before its transaction if its worst safe incremental requirement exceeds available headroom.
5. Do not reject duplicate-only replays based on nominal selected-file size.
6. Filter known excluded files before charging durable image bytes.
7. Present estimated available and required capacity in human-readable units.
8. Distinguish nonpersistent storage risk from immediate quota exhaustion.
9. Detect and classify actual `QuotaExceededError` even when an earlier estimate looked sufficient.
10. A canceled or failed preparation releases its temporary reservations.

## 11. ZIP ingestion, integrity, and archive scalability

### 11.1. Immediate low-risk archive protections

Before adopting a new archive engine:

1. Enforce a reasonable compressed-file byte limit before calling any full-file `arrayBuffer` or `JSZip.loadAsync` path.
2. Expose an explicit `Preparing archive` stage and make its noninterruptible limitations visible.
3. Keep entry count, per-entry uncompressed size, total uncompressed size, expansion-ratio, and path traversal protections.
4. Validate each actually imported entry's CRC while reading that entry.
5. Preserve SHA-256 validation for snapshot descriptors.
6. Check cancellation before central-directory processing, before each member, during supported streaming inflate, and before database admission.
7. Classify one malformed raw-image member independently when later members remain safely processable.
8. Reject ambiguous, duplicated, encrypted, malformed, nested, or unsupported archive structures before unsafe mutation.
9. Apply quota only to genuinely admissible image/model content plus real bounded staging.
10. Disclose the real total-size ceiling during review rather than after a long apparent freeze.

Turning on a blanket eager JSZip CRC prepass is not sufficient if it decompresses every member before discovery, progress, or cancellation and duplicates later work.

### 11.2. Full-corpus archive design decision

The existing user corpus requires supporting at least 6.52 GiB of uncompressed MRI bytes if “archive the complete provided folder and import it” is a supported product flow.

Three honest choices exist:

1. **Bounded streaming ZIP support:** parse the end-of-central-directory and bounded central-directory windows via `Blob.slice`, support ZIP64 where required, stream one bounded member at a time, verify CRC while inflating, and pass admitted images into the existing bounded batch writer.
2. **Multiple-archive intake:** explicitly support user-selected archive segments that each remain within a documented safe limit, while retaining one coherent operation and duplicate/patient guarantees.
3. **Explicit unsupported ceiling:** state before import that large complete-corpus ZIPs are not supported and direct users to folder import instead.

Option 1 best satisfies a seamless bulk-import product but must be justified against dependency size, browser support, offline distribution, decompression APIs, ZIP64 behavior, cancellation, and maintenance burden.

Engine evaluation must test:

- Random-access central-directory reads from `Blob` without loading the entire archive.
- Valid ZIP64 central directories and large member offsets.
- Stored and deflated members.
- Browser availability of the required stream/decompression APIs or a vendored local fallback.
- Encrypted members and unsupported compression methods.
- Unicode path normalization, duplicate normalized paths, drive/absolute paths, backslash traversal, null characters, and symlink-like entries.
- Compression bombs based on declared sizes, actual emitted bytes, nesting, entry count, and expansion ratio.
- Incremental CRC verification during the only useful read.
- Early cancellation without retaining the full compressed payload.
- Local-only static/offline builds and release ZIP packaging.

### 11.3. Archive failure policy

For an ordinary image ZIP:

- Unsafe archive structure, path traversal, expansion bomb, unsupported encryption, or invalid central directory fails the operation before mutation.
- A corrupt image member produces an integrity failure and is not committed.
- If policy permits continuing after one corrupt member, terminal outcome must be `partial`, and later valid members must still use the common canonical image pipeline.
- Already committed earlier batches remain visible and are never silently rolled back by language implying all-or-nothing archive semantics.

For a complete backup:

- Any integrity, ownership, model, annotation, frame, or manifest failure before the visible commit prevents primary-data publication.
- Failures after the primary database commits enter an explicit recoverable finalization state.
- No unverified model, annotation, or derived frame becomes visible as trusted simply because its byte length matches.

## 12. Complete-backup consent, restore boundaries, and recovery

### 12.1. Separate image import from complete-backup restore

A complete MiraViewer backup is not merely a ZIP containing DICOM images. Depending on its manifest, it can affect:

- Patient and examination records.
- Series and original DICOM image blobs.
- Panel/viewer settings.
- Tumor segmentations and manual ground truth.
- Volume segmentation labels.
- Derived alignment frames, valid-support masks, and provenance.
- Local model-cache blobs.
- Owned local preference values.
- The selected patient and current comparison context.

Review must identify the actual validated manifest type and summarize present artifact categories before any write. The affirmative action should be labeled **Restore complete backup**, not merely **Import**.

### 12.2. Explicit restore consent

The review screen should state:

> Restore scans and saved MiraViewer work into this browser. This backup contains the listed annotations, viewing state, and local model assets. Matching records may be updated, and the selected patient may change.

Show only artifact categories actually present. If no model assets or annotations exist, do not imply they do. Present patient/examination details only inside the local application and according to the user's existing patient-visibility context.

Require a deliberate confirm action after source inspection and before any durable mutation. Do not disguise a complete restore as ordinary multi-image intake.

### 12.3. Honest primary/sidecar commit protocol

The two database names prevent one true IndexedDB transaction from covering both medical images and model sidecars.

Recommended minimum protocol:

1. Validate source structure, all required hashes/CRCs, patient ownership, frame geometry, annotation references, and sidecar availability before any visible commit.
2. Verify that the primary database and model-cache database can both open at their expected versions.
3. Compute bounded storage requirements for medical data, sidecars, and temporary staging.
4. Stage or prevalidate model blobs so an obvious `VersionError` or quota issue is detected before changing the primary database.
5. Record only the minimal durable recovery checkpoint required if a later sidecar repair cannot otherwise be resumed safely.
6. Commit the primary medical database transaction atomically within that one database.
7. Mark the operation as primary-committed; refresh visible medical data appropriately.
8. Finalize model-cache and owned local-preference sidecars.
9. Publish complete success only after every required sidecar finishes.
10. If sidecar finalization fails, preserve the committed primary state and expose a retryable **Restore needs finalization** outcome.
11. On reopen, detect only genuine unfinished restore checkpoints and offer repair or documented cleanup.

Never promise an impossible cross-database atomic rollback. Avoid adding a general durable operation ledger if a small targeted restore checkpoint is sufficient.

### 12.4. Snapshot memory and staged restore

The current restore inflates every instance into a `Map` before a large primary transaction. For large backups this can exhaust browser memory even when disk quota is sufficient.

Evaluate, in order:

1. Strictly bounded supported backup size with an upfront explanation.
2. Verified image/sidecar staging in temporary IndexedDB records or a temporary generation.
3. A final authoritative visibility switch only after all integrity, ownership, reference, and geometry validation completes.
4. Recovery cleanup after cancellation, tab close, quota failure, or invalid source data.

Any staged design must preserve:

- All-or-nothing authoritative visibility of core MRI state at its real boundary.
- Patient identity and selected-patient confirmation.
- Stable SOP/series ownership and original blob bytes.
- Annotation/frame references and valid-support mask fidelity.
- Correct current-dataset revision rebinding.
- Existing snapshot backward compatibility or a documented migration.
- Bounded temporary storage and recoverable interrupted staging.

### 12.5. Restore cancellation semantics

Expose three distinct user-facing conditions:

1. **Preparing restore:** cancellation is available; no primary image changes have committed.
2. **Saving verified changes:** the indivisible transaction may be unable to stop safely; replace the misleading Cancel action with an explicit **Finishing safely** state.
3. **Finalizing restored work:** sidecar completion may be retryable; never imply primary images were not restored if they already committed.

Poll cancellation during archive inspection, image verification, annotation/frame validation, model preparation, and immediately before starting the primary transaction.

## 13. Post-import comparison, patient grouping, and manifest performance

### 13.1. Linear conservative patient grouping

The existing `getPatientIdentityKey` behavior must remain clinically conservative:

- No patient ID: each study remains its own unknown identity.
- Patient ID plus issuer: the issuer participates in identity.
- Reused ID with conflicting nonempty normalized names: isolate by study.
- Matching nonempty identity/name evidence: group correctly.
- Blank names do not silently override established conflicts.

Compute an invocation-local grouping structure:

```text
base identity → normalized nonempty name set
study UID → resolved conservative patient identity
```

Build it once from current committed studies; then reuse it for patient summaries, requested patient selection, selected-study filtering, backup validation, and any current-operation review that requires the same grouping.

This is an ephemeral calculation scoped to current data, not a second persisted patient authority. Sorting patient summaries remains a legitimate `O(P log P)` presentation cost.

### 13.2. Bounded summary counts

Avoid launching one independent unbounded `countFromIndex` promise per series.

Prefer:

1. One explicit bounded read-only transaction over the needed stores.
2. One or more bounded cursor/index scans for affected series.
3. Reuse of already-loaded patient grouping and study data.
4. A changed-series refresh rather than rebuilding every patient and series after every committed image.

Persisted per-series counts should be added only if image ingestion, backup restore, image deletion, database migration, and every future writer can update them atomically. Otherwise, they become another competing source of truth.

### 13.3. Bounded frame manifests

`getSeriesFrameManifest` should not open one separate transaction per SOP UID.

Desired behavior:

- Read ordered instance keys and metadata through one bounded read-only transaction or cursor.
- Preserve exact SOP order, physical ordering, tie-break behavior, frame-of-reference validation, rows, columns, spacing, and image orientation.
- Do not load `fileBlob` payloads when only metadata is required, unless browser profiling proves the current IndexedDB value shape cannot avoid it without a justified schema/index change.
- Preserve geometry reliability and existing local order-cache invalidation semantics.
- Keep concurrent reader behavior correct if a new batch commits between manifest reads.
- Benchmark 24, 96, 192, and larger frame counts; transaction cardinality should not grow linearly with frame count.

## 14. Product experience: Acquisition Intake Console

### 14.1. Experience goal

The user should feel they are bringing real imaging into a private local clinical workstation, not uploading anonymous files to a generic cloud service.

The experience must answer, in order:

1. What can I import?
2. Does anything leave my device?
3. Which files, patients, examinations, or saved work have been discovered?
4. Do I have enough reliable local storage?
5. Is this ordinary image import or a complete backup restore?
6. What is happening right now?
7. What happens if I cancel?
8. What actually imported, what was excluded, and what needs attention?

### 14.2. Distinctive visual concept

Use a restrained **PACS-inspired Acquisition Intake Console**:

- A structured imaging chamber rather than a small generic dashed upload modal.
- A persistent local-privacy/provenance rail.
- A real-source acquisition-manifest ribbon showing only discovered facts.
- Disciplined clinical spacing, clear stage ownership, and instrument-like tabular counts.
- Deliberate differentiation between ordinary image intake and complete backup restoration.

The signature visual should be an actual discovered-acquisition manifest: exam count, source count, real series/orientation counts, image count, integrity, and storage. Before discovery, show an explicitly empty or neutral manifest frame. Never fabricate scan slices, fictional measurements, fake patient names, decorative pathology, or pseudo-clinical findings.

### 14.3. Suggested visual tokens

Preserve existing dark-mode identity while making the import surface more distinctive:

| Role                      | Suggested token           | Purpose                                              |
| ------------------------- | ------------------------- | ---------------------------------------------------- |
| Imaging chamber           | `#0A1016`                 | Deep surrounding canvas with subtle blue-black depth |
| Console surface           | `#111A22`                 | Primary intake panel                                 |
| Raised status rail        | `#18252D`                 | Trust, storage, and progress surfaces                |
| Structural divider        | `#30404B`                 | Restrained information boundaries                    |
| Instrument signal         | `#78D7DE`                 | Acquisition and verified-local indicators            |
| Main clinical text        | `#E9F1F2`                 | Readable primary labels                              |
| Existing affirmative blue | `#2563eb`                 | Primary choose/import/restore actions                |
| Muted amber               | existing semantic warning | Real storage, ambiguity, or partial-import concerns  |
| Muted emerald             | measured success token    | Actually verified or durably committed outcomes      |

All final combinations must be checked against actual rendered contrast; suggested tokens are aesthetic direction, not already validated accessible combinations.

Typography:

- Use locally available `SF Pro Display`, `Avenir Next`, or system equivalents for display headings.
- Keep the established system sans stack for ordinary body copy.
- Use `SFMono-Regular`, `ui-monospace`, or another locally available monospace for counts, byte totals, and operation timing.
- Avoid network-fetched fonts; the offline release must remain self-contained.
- Use 14–16 px body text and at least 12 px secondary utilities.
- Use tabular numerals for changing progress and storage figures.
- Prefer sentence case and calm, clinical labels over alarming all-caps warnings.

### 14.4. Composition and responsive layout

Desktop target:

- Increase the useful intake surface beyond the current 576 px generic card when review data benefits from a wider clinical panel; approximately 720–960 px is a design exploration range, not a fixed requirement.
- Use an obvious title/subtitle, trust rail, source selection region, acquisition preview, and stable action footer.
- Keep primary actions visually aligned and readable against the viewport rather than leaving a tiny anonymous card stranded in thousands of pixels of black space.
- Use restrained depth and hierarchy instead of decorative gradients or fabricated scan animations.

Tablet/mobile target:

- Collapse patient/exam preview and storage details into a readable single column.
- Wrap or stack folder/files/backup actions before they overlap.
- Keep the primary action and cancellation reachable without clipping.
- Allow the content area to scroll while preserving a visible title and outcome/action area.
- Respect safe-area insets and virtual keyboard behavior where relevant.
- Validate actual browser viewports at 320, 390, 768, 1,024, and 1,440 px widths.

Interaction target:

- Every source, footer, close, and touch-target control reaches at least 44 × 44 px.
- Distinguish disabled, focused, hover, busy, selected, warning, error, and verified states without relying on color alone.
- Preserve the existing globally visible focus treatment.
- Honor the existing reduced-motion setting; progress remains understandable without spinner animation.

### 14.5. Persistent trust and storage rail

Present a compact always-visible statement:

> Local processing · No network transfer

Accompany it with the real current browser storage state:

- **Persistent browser storage enabled** when the permission is actually confirmed.
- **Browser storage may be cleared** when persistence is unavailable or denied.
- Approximate available/used capacity when `navigator.storage.estimate()` provides credible values.
- A clear backup recommendation linked to the existing export workflow.

Do not render a generic alarming amber banner ahead of every source decision when a calmer contextual trust rail can communicate the same real risk. Distinguish nonpersistent storage from quota exhaustion and from an actually corrupted database.

### 14.6. Source-selection state

Title and subtitle:

```text
Import scans
Folders, DICOM images, image archives, or a MiraViewer backup.
```

Actions:

- **Choose folder** — only when a real supported folder mechanism exists.
- **Choose files** — supports multiple and extensionless acquisitions.
- **Choose backup** — clearly indicates complete-work restoration, not ordinary image import.
- **Drop files or a folder** — only when real corresponding drop handlers are implemented.

Below the source controls:

- Show supported ordinary input types in readable plain language.
- Mention that known sidecars are ignored and enhanced multiframe has an explicit current limitation, if relevant.
- Expose the existing selected source name locally without copying it into diagnostics.
- State browser-specific folder limitations only when they apply.

The import drop surface must no longer advertise an interaction that does not exist.

### 14.7. Discovery and review state

Discovery shows:

- Source kind and local-only provenance.
- Discovered candidate count and bytes.
- `Scanning…` while the total remains unknown.
- Early count of known sidecars and unsupported candidates.
- Cancel with immediate stage feedback.

Once sufficient evidence is available, review shows real values only:

- Number of apparent examinations and series.
- Number of distinct safely identified patients, with clear attention if more than one is present.
- Existing/current patient context when safely known.
- Supported new-image estimate and safe duplicate estimate.
- Excluded Secondary Capture, non-displayable, unsupported enhanced-multiframe, scout/localizer, or geometry-conflict categories.
- Projected additional browser storage and available headroom.
- Backup artifact categories and selected-patient impact when a complete backup is selected.

Avoid a full up-front parse solely to construct a beautiful manifest if that defeats progressive intake. Show uncertainty explicitly: “Still scanning,” “Duplicate count estimated,” or “Patient review available after header validation.”

### 14.8. Execution state

Use stage-appropriate headings:

```text
Scanning source
Checking image ownership and storage
Verifying archive integrity
Importing verified images
Restoring saved MiraViewer work
Finishing a safe database commit
```

The progress surface includes:

- Semantic progress bar when a real total is known.
- Indeterminate progress without a fake percentage when discovery is incomplete.
- Processed versus discovered/admitted counts.
- Durably committed image count.
- Duplicate, excluded, and failed counters when nonzero.
- Elapsed time and a remaining-time estimate only after enough stable evidence exists.
- Compact storage consumption and source summary.
- A real Cancel action while cancellation is possible.
- A nondeceptive **Finishing safely** state during an unavoidable final commit.

Do not announce every filename, patient label, UID, archive path, or every single progress increment to a screen reader. Announce meaningful stage transitions and bounded aggregate milestones.

### 14.9. Retained terminal results

Differentiate at least:

1. **Import complete:** all admitted images safely committed or recognized as intended duplicates/exclusions.
2. **Import completed with attention needed:** some valid candidates failed, conflicted, or were intentionally excluded under a policy requiring visibility.
3. **No new scans needed:** every safe candidate was already present.
4. **Import canceled:** include the count of images that already committed.
5. **Nothing was imported:** state why and expose the best recovery action.
6. **Backup restore needs finalization:** primary medical records committed but one recoverable sidecar phase did not.

Results remain visible until the user selects **Open imported examinations**, **Review issues**, **Retry failed items**, or **Done**, according to available state. There is no automatic two-second disappearance.

Bound local issue samples and preserve sanitized categories. Avoid storing an unbounded copy of 35,898 filenames just to display a result table.

## 15. Accessibility, input, and responsive requirements

### 15.1. Keyboard and focus ownership

- Every source action is a real focusable button with a meaningful accessible name.
- The drop area is focusable and keyboard-operable if it advertises click/activation behavior.
- Initial dialog focus lands on the primary source action or a context-appropriate review action, not reflexively on the close icon.
- Existing focus trap and background inertness remain intact.
- Escape follows the same truthful cancellation contract as the visible close control.
- During an active operation, an accessible close label explains whether the action cancels, hides, or cannot interrupt a final commit.
- On dismissal, focus returns to the actual control that launched import.
- Disabled controls expose real disabled semantics, not only dim color.
- Keyboard users can reach issue summaries, storage warnings, backup consent, retry, and final results without pointer-only hover affordances.

### 15.2. Screen-reader announcements

- Known-total progress exposes `role="progressbar"`, an accessible name, and accurate current/minimum/maximum values.
- Unknown-total discovery uses a meaningful busy/status announcement instead of a fabricated percentage.
- Phase changes and important aggregate milestones are communicated through a bounded polite live region.
- Fatal, actionable errors use an appropriate alert role without repeatedly announcing every transient state.
- Cancellation announces whether committed images remain.
- Backup consent announces the actual categories of saved work affected.
- Screen-reader messages avoid patient names, UIDs, filenames, and archive paths by default.
- Progress announcements are throttled, with immediate completion or error updates.

### 15.3. Pointer, touch, and reduced motion

- Source actions, close controls, cancel actions, and final primary actions meet the 44 × 44 px interaction-target target.
- The drop area has an equivalent button-driven path on devices that do not support dragging files.
- No critical action depends on hover, right-click, desktop modifiers, or a precise small pointer.
- Spinners, status transitions, and completion affordances respect `prefers-reduced-motion`.
- An import remains understandable when animation, pointer hover, or color perception is unavailable.
- Long filenames are truncated or wrapped without shifting the cancel control or causing horizontal overflow.

### 15.4. Responsive validation

Validate actual rendering at:

- 320 px: compact phone minimum.
- 390 px: common phone width.
- 768 px: tablet boundary.
- 1,024 px: compact laptop or landscape tablet.
- 1,440 px: ordinary clinical desktop.
- A wide desktop comparable to the observed 3029 px viewport.

At each width verify source selection, discovery, review, running progress, partial result, complete-backup consent, low-storage warning, and recoverable error states. Use only synthetic patient-free screenshots for committed or shared evidence.

## 16. Privacy, safety, and operational reliability

### 16.1. No-network and sensitive-output policy

The core privacy promise is that imported DICOM and backup contents never leave the user's device.

Instrument implementation tests to reject any import-triggered:

- `fetch` request containing image bytes or patient metadata.
- `XMLHttpRequest`, `sendBeacon`, analytics event, telemetry payload, or third-party error report containing import content.
- Network-based font, archive, parser, or worker asset that breaks the existing offline release.
- Raw parser exceptions that include datasets, pixel buffers, filenames, paths, UIDs, names, or dates.
- Public benchmark output or documentation containing real corpus metadata.

Do not mistake an intentional same-origin, already-packaged static worker script for uploading user data; validate actual request bodies and destinations rather than banning required local application assets.

On-screen patient/examination details may be necessary inside the local clinical application. They must not automatically propagate into console logs, analytics, screen-reader global announcements, screenshots, support reports, or saved public artifacts.

### 16.2. Cross-tab and concurrent writer behavior

One application instance should prevent overlapping imports in its own UI. Multiple browser tabs, however, can still access the same IndexedDB database.

Requirements:

- Final SOP/study/series ownership is always revalidated inside the authoritative transaction.
- Read-only prechecks and local in-memory duplicate sets are advisory only.
- Prefer a narrowly scoped browser lock if `navigator.locks` is available and measured to improve user experience.
- If locks are unavailable, rely on real IndexedDB transaction ordering and deterministic collision handling; do not claim exclusivity that the browser does not provide.
- Communicate blocked database upgrades, open competing tabs, and restore contention in actionable terms.
- Do not close, clear, or delete another tab's database connection or data without explicit user intent.
- Cross-tab dataset notifications or refresh may use an existing mechanism or a bounded broadcast if justified, but must not transmit patient identifiers.

### 16.3. Page close, app reload, and restart recovery

- A page unload may interrupt source discovery or worker preparation at any point.
- Do not claim asynchronous cleanup is guaranteed during `beforeunload`.
- Image batches that already committed remain authoritative after restart.
- Aborted in-flight transactions must leave no orphaned parent/image state.
- A plain file/folder import need not persist a second resumability ledger if re-selection plus canonical SOP deduplication provides safe restart behavior.
- A complete-backup operation may need a narrow durable checkpoint only when separate-database sidecar recovery cannot otherwise be made honest.
- A restarted application must distinguish complete primary data, incomplete restore finalization, and safely discardable temporary staging.
- Cleanup of staging must be idempotent, storage-bounded, and never delete user-owned existing images or models.

### 16.4. Browser storage and private-mode behavior

Classify separately:

- IndexedDB unavailable or blocked.
- Browser private/incognito storage restrictions.
- Persistent-storage permission denied.
- Estimated quota unavailable.
- Actual quota exceeded during a transaction.
- A competing tab blocking database migration.
- Model-cache database version/open failure.
- Underlying browser eviction risk.

Provide truthful recovery copy. Never suggest that an exported backup already exists unless one was actually created.

## 17. Failure taxonomy and user-facing outcomes

| Failure or result                               | Clinical/storage meaning                         | User-visible treatment                                   | Retry posture                              |
| ----------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------ |
| User dismissed picker                           | No operation started                             | Return to current source selection                       | Choose source again                        |
| Empty folder                                    | No source candidates                             | Explain the folder contained no usable files             | Choose another folder                      |
| Permission denied                               | Source unreadable                                | Explain permission and browser-specific recovery         | Grant permission/reselect                  |
| Unsupported folder API                          | Browser cannot select a directory directly       | Offer real directory fallback, files, or ZIP             | Change source mechanism                    |
| Hidden/system sidecar                           | Intentionally excluded, not an error             | Aggregate ignored-sidecar count                          | No retry required                          |
| Extensionless valid DICOM                       | Supported image candidate                        | Import normally                                          | No retry required                          |
| Non-displayable DICOM                           | Real object without renderable image data        | Aggregate named exclusion                                | No retry required                          |
| Secondary Capture                               | Intentionally excluded non-diagnostic screenshot | Aggregate named exclusion                                | No retry required                          |
| Unsupported enhanced multiframe                 | Real image type currently unsupported            | Explicit named limitation, not silent loss               | Future format support or different export  |
| Scout/localizer geometry                        | Valid MR outside a homogeneous diagnostic stack  | Explicit policy-driven exclusion or safe virtual stack   | Review policy/result                       |
| Conflicting patient/issuer                      | Unsafe ownership                                 | Reject before conflicting commit                         | Inspect source/patient selection           |
| Conflicting study/series/SOP                    | Unsafe DICOM identity                            | Reject conflicting candidate, preserve existing owner    | Inspect/export correct acquisition         |
| Conflicting frame or calibration                | Unsafe patient-space geometry                    | Named geometry conflict or explicit scout handling       | Review acquisition                         |
| All candidates are duplicates                   | No durable change                                | “No new scans needed”; no disruptive reload              | No retry required                          |
| Insufficient incremental quota                  | New data cannot safely commit                    | Explain approximate required and available storage       | Free space/export existing work            |
| Corrupt ZIP member / CRC                        | Bytes do not match archive integrity             | Do not import corrupt image; mark partial or fail backup | Recreate/reacquire archive                 |
| ZIP path traversal / bomb                       | Source structurally unsafe                       | Fail before mutation                                     | Obtain a safe archive                      |
| Unsupported compressed/encrypted ZIP            | Archive cannot be safely decoded                 | Explain the unsupported capability                       | Re-export unencrypted/supported ZIP        |
| Backup manifest/hash failure                    | Restore cannot be trusted                        | Fail before primary visible commit                       | Obtain an intact backup                    |
| Cancellation before commit                      | No new batch has committed                       | Canceled; state any earlier committed count              | Resume by reselecting source               |
| Cancellation during indivisible commit          | Transaction cannot safely be interrupted         | “Finishing safely”; then show actual committed count     | Resume only after terminal state           |
| Model finalization failure after primary commit | Medical data changed; sidecar incomplete         | “Restore needs finalization”; refresh data               | Retry finalization/repair                  |
| Raw preambleless unknown syntax                 | Format identity is not safely established        | Name unsupported/ambiguous raw format                    | Export standard Part 10 DICOM              |
| Unknown internal fault                          | Operation failed without exposing PHI            | Sanitized generic category plus bounded recovery         | Retry or inspect private local diagnostics |

## 18. Performance budgets and measurement gates

All numerical targets in this section are **proposed acceptance budgets**, not claims about the current browser or guaranteed performance across devices. Establish actual browser baselines before setting release-blocking thresholds.

### 18.1. Operation cardinality targets

| Metric                           | Current demonstrated shape               | Proposed acceptance shape                                |
| -------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| New-image write transactions     | `O(newImages)`                           | `O(committedBatches)`                                    |
| Study/series rewrites            | Up to once per image                     | Once per changed canonical parent per batch              |
| Dataset revision store writes    | Once per image                           | Once per nonempty committed batch                        |
| Final dataset revision value     | Previous revision + new images           | Unchanged exact contract: previous revision + new images |
| Mutation publication             | Once per image                           | At most once per affected series per committed batch     |
| All-duplicate image writes       | Zero                                     | Zero                                                     |
| All-duplicate write transactions | Once per candidate                       | Zero per-image read/write transactions                   |
| Full duplicate-image reads       | Once per candidate                       | Avoided when a safe bounded identity probe suffices      |
| Selection-size accesses          | `O(selection × renderedProgressUpdates)` | `O(selection)` per changed source                        |
| Visible progress updates         | Up to once per candidate                 | Bounded by elapsed time; terminal transition immediate   |
| Patient identity work            | Quadratic in study count                 | Linear plus legitimate presentation sorting              |
| Frame-manifest transactions      | `frameCount + 5` in measured cases       | Bounded independently of frame count                     |
| Folder `File` retention          | Entire selected tree                     | Bounded candidate/byte queues                            |

### 18.2. Proposed responsiveness thresholds

Initial browser-performance targets to confirm on the representative supported hardware:

- Discovery starts visibly within approximately 200 ms of folder selection, even when total enumeration continues.
- Cancel acknowledges visually within approximately 100 ms when the browser event loop is available.
- P95 Cancel-to-operation-settled time remains below approximately 250 ms for ordinary bounded batches on the measured reference device, excluding a documented already-committing database transaction.
- No new candidate or worker task begins after cancellation is acknowledged.
- Application-owned main-thread work avoids tasks over 50 ms where practical; instrument unavoidable browser/IndexedDB operations separately.
- The UI publishes ordinary progress approximately 5–10 times per second and publishes phase/terminal changes immediately.
- Affected comparison data becomes available without a full-screen destructive unmount of the current result panel.

These numbers are design gates to tune after collecting a reproducible cold/warm browser baseline. Slow storage, OS pressure, and browser-owned transaction commits can exceed them; truthful state is more important than inventing a latency guarantee.

### 18.3. Proposed bounded-memory thresholds

Measure and explicitly record:

- Pending discovered-candidate count.
- Pending estimated candidate bytes.
- Active decompression-buffer bytes.
- Prepared image-batch bytes.
- Worker in-flight transfer bytes.
- Snapshot staging bytes and durable staging records.
- Browser heap/RSS where a supported measurement mechanism exists.

Suggested initial tuning envelope:

- Prepared writer batch: approximately 8–32 MiB.
- Total application-owned transient queue/inflate/worker buffers: initially target no more than approximately 64–128 MiB on the reference desktop, adjusted for actual image size and device capability.
- No memory allocation proportional to the entire 6.52 GiB corpus for ordinary folder import.
- No full compressed-archive copy or all-member inflation for a claimed streaming whole-corpus ZIP implementation.

Browser Blob backing, IndexedDB internal caches, OS file mapping, and available heap APIs are implementation-specific. Report precisely which memory category was observed and do not claim total-process guarantees from a JavaScript queue counter.

### 18.4. Real-browser measurement protocol

Use a clean, dedicated non-user browser origin/profile and an isolated application database. Never clear, replace, or screenshot the user's existing patient-containing origin.

Collect:

1. Browser name/version and runtime/build mode.
2. Machine/device class, storage medium, approximate available memory, and current storage quota.
3. Source kind and candidate/image count.
4. Aggregate source bytes and duplicate ratio.
5. Wall time by discovery, review, archive admission, parse, integrity, write, refresh, and result stages.
6. IndexedDB transaction/commit count and measured transaction duration distribution.
7. Parent puts, instance puts, revision writes, affected-series notifications, and renderer publication counts.
8. Source bytes read versus safe header-only bytes read.
9. Peak application-owned queue bytes and a clearly identified browser memory measurement where available.
10. Main-thread long tasks, frame/presentation gaps, and input-to-cancel latency.
11. Durably committed images, duplicate count, named exclusions, errors, and patient-isolation checks.
12. Network destinations/request bodies, proving no user medical data was transmitted.

Run sufficient repetitions before reporting P50/P95. Compare equivalent browser, source, warm/cold cache, duplicate ratio, and build settings; never extrapolate a full-corpus wall time from Node/fake-IDB observations.

## 19. Phased implementation roadmap

### Phase 0 — Freeze baselines and create failing safety tests

Primary areas:

- `frontend/tests/dicomIngestion.test.ts`
- `frontend/tests/storageIntegrity.test.ts`
- `frontend/tests/UploadModal.test.tsx`
- `frontend/tests/exportBackup.test.ts`
- Focused synthetic import benchmark fixtures or existing test utilities

Tasks:

1. Add synthetic missing → valid → conflicting patient, issuer, frame, orientation, and spacing cases.
2. Add a parser failure fixture whose thrown object contains synthetic patient-like text and an image byte array; assert sanitized logging.
3. Add actual ordinary-file cancellation and committed-counter tests.
4. Add CRC-corrupted archive, model-cache-failure-after-primary-commit, and duplicate-under-low-quota cases.
5. Add a synthetic mixed-orientation scout/localizer acquisition matching the real-corpus shape without copying patient data.
6. Instrument bounded benchmark fixtures for transaction count, parent writes, revision values, full reads, source bytes, mutation calls, progress updates, and queue high-water marks.

Exit gate:

- Every currently reproduced defect has a deterministic failing production-boundary test.
- Existing 49 directly verified focused tests continue to define the unchanged baseline.
- No user MRI file, patient field, UID, source path, or actual pixel image is added to a committed fixture.

### Phase 1 — Close patient-safety and patient-data-leakage defects

Primary areas:

- `frontend/src/services/dicomIngestion.ts`
- `frontend/src/db/patientIdentity.ts`
- Relevant ingestion/storage tests

Tasks:

1. Replace broad parent-object spreads with one field-aware canonical merge.
2. Enrich missing trusted identity/issuer/frame/geometry fields safely.
3. Reject conflicting nonempty late metadata before a record is committed.
4. Validate batch-local canonical parents and concurrent ownership races.
5. Remove raw parser error objects from every console/error publication path.
6. Preserve existing selected-patient and conservative name-conflict behavior.

Exit gate:

- No missing → A → B sequence can combine distinct patients or frames.
- Parser faults disclose no patient text, UID, source path, raw dataset, or pixels.
- Existing legitimate metadata enrichment succeeds without destabilizing old records.

### Phase 2 — Establish one operation lifecycle and truthful terminal states

Primary areas:

- `frontend/src/components/UploadModal.tsx`
- `frontend/src/components/ComparisonMatrix.tsx`
- `frontend/src/hooks/useComparisonData.ts`
- Canonical ingestion operation coordinator

Tasks:

1. Introduce one operation ID, phase machine, source ownership, and abort signal.
2. Thread cancellation through ordinary file loops immediately, before deeper batching changes.
3. Disable source changes and prevent overlapping operation starts.
4. Track committed image counts separately from candidates merely parsed.
5. Classify complete, partial, duplicate-only, canceled, and failed outcomes.
6. Refresh actual committed data without replacing the import dialog with a global loading screen.
7. Remove unowned close timers or clear/guard them with operation identity.
8. Keep result panels visible until intentional dismissal.

Exit gate:

- Ordinary-file cancellation no longer commits the entire remaining selection.
- Partial commits are visible after cancellation and failure.
- A stale operation or timer cannot close, mutate, or report success for its replacement.
- All-duplicate outcomes do not trigger a disruptive no-change refresh.

### Phase 3 — Introduce progressive source discovery and browser fallback

Primary areas:

- Folder/file/drop source adapter module or existing component helpers
- `frontend/src/components/UploadModal.tsx`
- Browser-specific integration tests

Tasks:

1. Replace eager recursive folder arrays with a cancellable bounded async candidate iterator.
2. Add capability-aware `showDirectoryPicker` and directory-input fallback.
3. Admit extensionless valid DICOM through the ordinary file path.
4. Add real drag-and-drop handlers and keyboard-equivalent source actions.
5. Classify hidden/system sidecars early.
6. Add immediate discovery stage, aggregate counts, and cancellation.
7. Define deterministic mixed ZIP + DICOM behavior before any durable change.
8. Bound depth, pending candidate count, source bytes, and unreadable-file reporting.

Exit gate:

- A representative large folder becomes visibly active immediately and can be canceled.
- Browsers without `showDirectoryPicker` retain their strongest real supported folder/file path.
- Extensionless and mixed-source semantics are tested explicitly.
- No source control advertises an unavailable action.

### Phase 4 — Batch canonical writes without altering medical semantics

Primary areas:

- `frontend/src/services/dicomIngestion.ts`
- Canonical import batch writer
- `frontend/src/db/db.ts`
- `frontend/tests/storageIntegrity.test.ts`

Tasks:

1. Prepare count- and byte-bounded image batches outside transactions.
2. Validate canonical identity and geometry for existing and within-batch parents.
3. Insert admitted images through one transaction spanning the existing authoritative stores.
4. Write changed study/series parents only when effective canonical data changes.
5. Write dataset revision once as `previousRevision + newlyCommittedImageCount`.
6. Publish genuinely affected series only after durable commit.
7. Preserve all-or-none transaction behavior under quota, conflict, and injected failure.
8. Tune batch count/bytes against actual browser commit and Cancel latency.

Exit gate:

- Transaction counts scale with committed batches.
- Original image bytes, patient grouping, exact revision values, physical order, annotations, alignment, and SVR behavior remain unchanged.
- No aborted batch leaves orphaned data or premature notifications.

### Phase 5 — Repair duplicate and quota admission; remove UI amplification

Primary areas:

- Candidate admission/header probe
- `frontend/src/db/db.ts`
- `frontend/src/components/UploadModal.tsx`

Tasks:

1. Establish bounded read-only SOP admission checks.
2. Measure header-first parsing on the actual protected corpus before selecting thresholds.
3. Revalidate ownership inside the final write transaction.
4. Estimate incremental new storage instead of total nominal selected bytes.
5. Compute discovery byte totals once per changed source.
6. Throttle visible progress and preserve immediate terminal updates.
7. Track 0%, 25%, 50%, 90%, and 100% duplicate-ratio benchmarks.

Exit gate:

- Duplicate-only imports succeed under otherwise insufficient nominal quota.
- Safe duplicate replay avoids full payload reads when the measured header strategy is beneficial.
- Selection-size access is linear rather than quadratic.
- New-image cold import is not regressed by unconditional double parsing.

### Phase 6 — Secure and scale ZIP image archives

Primary areas:

- `frontend/src/services/archiveSafety.ts`
- Common image source adapter
- Corruption/adversarial archive tests

Tasks:

1. Add compressed-byte admission before eager archive loading.
2. Verify member CRC while consuming actual useful bytes.
3. Preserve entry, expansion, path, declared-size, and snapshot hash protections.
4. Route raw ZIP members through the same canonical per-candidate pipeline as ordinary files.
5. Make archive preparation and inflation progress/cancellation truthful.
6. Evaluate a bounded random-access/streaming ZIP engine against offline bundle and browser compatibility requirements.
7. Decide whether full-corpus 6.52 GiB ZIP import is supported, segmented, or explicitly rejected up front.

Exit gate:

- A same-size CRC-corrupted image is never committed.
- A malformed ZIP member does not bypass the shared failure-isolation policy.
- Expansion bombs, traversal, encrypted/unsupported members, and ZIP64 behavior have explicit tested outcomes.
- Any supported full-corpus archive avoids a whole-archive memory allocation.

### Phase 7 — Make complete-backup restoration explicit and recoverable

Primary areas:

- `frontend/src/services/exportBackup.ts`
- `frontend/src/utils/segmentation/onnx/modelCache.ts`
- Restore consent/recovery UI
- Snapshot integrity tests

Tasks:

1. Distinguish ordinary image archives from complete snapshots before the user authorizes mutation.
2. Present exact actual artifact categories and selected-patient implications.
3. Preflight primary and model databases, integrity, available quota, and sidecar readiness.
4. Bound verified image/model staging or reject unsupported oversized snapshots before allocation.
5. Define real primary-commit and model-sidecar recovery checkpoints.
6. Poll cancellation until the indivisible commit begins; expose **Finishing safely** thereafter.
7. Refresh committed primary images even when sidecar finalization fails.
8. Recover or clean up interrupted temporary staging safely on restart.

Exit gate:

- Injected model-cache `VersionError` never masquerades as an untouched primary database.
- Complete-backup consent occurs before mutation.
- Hash, annotation, derived-frame, local-model, and selected-patient fidelity survive round-trip restore.
- Cancellation and restart states reflect the actual committed database boundary.

### Phase 8 — Implement the Acquisition Intake Console

Primary areas:

- `frontend/src/components/UploadModal.tsx` or a deliberate intake component replacement
- `frontend/src/components/ui/AccessibleDialog.tsx` only where shared improvements are justified
- `frontend/src/index.css` and local design tokens
- Parent import entry points in `ComparisonMatrix`

Tasks:

1. Unify all entry-point terminology around scan import and complete backup restoration.
2. Implement the source → review → execute → results composition.
3. Add persistent local-processing and actual storage-status rails.
4. Build the real-data-only acquisition manifest and backup consent screen.
5. Add semantic progress, accessible errors, categorized exclusions, retained outcomes, and retry actions.
6. Ensure all controls meet 44 px touch targets and the right action receives initial focus.
7. Validate all layouts, high-contrast states, reduced motion, and real user flows.
8. Capture only patient-free actual-product screenshots for review.

Exit gate:

- The interface no longer resembles a generic cloud upload or advertises nonexistent drop/folder behavior.
- Every visible count or manifest label reflects actual discovered facts.
- Existing dark-mode readability, modal accessibility, and offline behavior are preserved or improved.
- Success and partial outcomes remain readable through parent data refresh.

### Phase 9 — Remove comparison/manifest read-side bottlenecks

Primary areas:

- `frontend/src/db/patientIdentity.ts`
- `frontend/src/utils/localApi.ts`
- Comparison-data and frame-manifest tests

Tasks:

1. Build invocation-local patient grouping in one pass.
2. Preserve unknown identity, issuer, conflicting-name, selected-patient, and backup grouping semantics.
3. Replace one independent series-count transaction per series with bounded read transactions/cursors.
4. Replace one independent manifest lookup per frame with bounded ordered metadata reads.
5. Benchmark 100, 250, 500, and 1,000 studies and 24, 96, 192, and larger frame manifests.
6. Confirm no extra blob payload reads occur when building metadata-only views.

Exit gate:

- Patient grouping no longer follows the measured `2M² + 4M` getter pattern.
- Frame-manifest transactions remain bounded independently of frame cardinality.
- Patient isolation, physical sorting, frame-of-reference checks, and selected-patient context remain exact.

### Phase 10 — Full protected-corpus and browser qualification

Primary areas:

- Dedicated isolated test origin/profile and browser instrumentation.
- Protected user corpus, read-only.
- Supported browser and viewport matrix.
- Existing full lint/test/build/offline-release commands.

Tasks:

1. Re-run the exact 512-image protected sample and account explicitly for every image/exclusion.
2. Validate the six genuine orthogonal scout images under the adopted explicit localizer policy.
3. Run representative larger folder/file subsets before attempting the complete 35,898-image corpus.
4. Measure cold import, duplicate replay, mixed duplicate ratios, low quota, mid-import cancellation, and restart behavior.
5. Validate archive, CRC failure, complete snapshot restore, annotation fidelity, and sidecar recovery.
6. Capture browser main-thread, queue, transaction, and memory measurements without patient identifiers.
7. Validate selected-patient isolation, alignment and SVR stale-revision behavior, and ordered frame manifests.
8. Run full repository checks, production build, and offline ZIP packaging.
9. Verify actual supported-browser folder APIs, drag/drop, keyboard, screen reader, touch sizes, narrow layouts, and reduced motion.
10. Ensure no actual user database, MRI source file, user browser tab, source path, patient identifier, or screenshot is destroyed or exposed.

Exit gate:

- All protected-corpus outcomes are explicitly categorized and clinically safe.
- Browser measurements demonstrate improvements relative to an apples-to-apples baseline.
- Offline operation and all existing storage/alignment/SVR contracts remain green.
- Every public evidence artifact is patient-free and aggregate only.

## 20. Detailed verification matrix

### 20.1. Source acquisition matrix

| Scenario                                   | Required outcome                                                     |
| ------------------------------------------ | -------------------------------------------------------------------- |
| One valid `.dcm` image                     | One committed image; one truthful result; original bytes retained    |
| Several valid DICOM images                 | Stable progressive discovery, bounded commits, exact final revision  |
| Extensionless valid Part 10 DICOM          | Selectable and imported without filename-based rejection             |
| Valid unusual-extension DICOM              | Safe content classification; imported if supported                   |
| Known text/image sidecars mixed with DICOM | Sidecars counted as intentional exclusions; no medical quota charged |
| Empty file selection                       | No phantom operation; recovery action remains available              |
| Selecting the same files twice             | Duplicate-only terminal outcome; no new revision or parent rewrite   |
| Native directory handle                    | Nested files discovered progressively and safely                     |
| Directory-input fallback                   | Same candidate, progress, and cancellation contract                  |
| Browser without any folder mechanism       | Folder action hidden/disabled with honest files/ZIP alternative      |
| Empty folder                               | Named empty-source outcome; no mutation                              |
| Permission-denied folder                   | Named permission outcome; no background retries                      |
| Revoked handle mid-scan                    | Bounded partial discovery and truthful retained outcome              |
| Very deep synthetic directory tree         | Depth policy terminates safely without stack overflow                |
| Oversized directory candidate count        | Configured limit and actionable user message                         |
| Folder cancellation during traversal       | Iterator closes; no new file handles or writes start                 |
| Dropped file list                          | Same canonical source pipeline as picker                             |
| Dropped folder on supported browser        | Same directory traversal and relative-path handling                  |
| Dropped folder on unsupported browser      | Explicit fallback, not a silent ignored drop                         |
| Dragged external URL or HTML               | Rejected without network access                                      |
| Mixed ordinary ZIP plus selected images    | Supported flattening or explicit pre-mutation rejection              |
| Complete backup plus ordinary files        | Explicitly separated restore operation and consent                   |

### 20.2. DICOM identity and fidelity matrix

| Scenario                                      | Required outcome                                             |
| --------------------------------------------- | ------------------------------------------------------------ |
| Identical SOP/study/series                    | Duplicate; no blob write or revision change                  |
| Same SOP with different study                 | Rejected ownership collision                                 |
| Same SOP with different real series           | Rejected ownership collision                                 |
| Existing study with missing patient ID        | Safely enrich first trustworthy same-study ID                |
| Enriched patient A followed by B              | Reject B; preserve A and prior safe records                  |
| Missing issuer followed by issuer A then B    | Bind A; reject B                                             |
| Matching ID with conflicting nonempty names   | Preserve documented conservative patient isolation           |
| Missing FoR followed by frame A then B        | Bind A; reject B                                             |
| Matching rows/columns/spacing/orientation     | Admit normally                                               |
| Conflicting rows/columns                      | Named geometry rejection                                     |
| Conflicting calibrated spacing                | Named geometry rejection                                     |
| Orthogonal valid scout/localizer frames       | Named exclusion or approved safe virtual stacks              |
| Orthogonal non-scout diagnostic images        | Review-required geometry conflict; never unsafe merge        |
| Missing required UIDs                         | Named exclusion without orphaned parents                     |
| Secondary Capture SOP class                   | Named intentional exclusion                                  |
| Non-displayable pixel object                  | Named intentional exclusion                                  |
| Enhanced multiframe image                     | Explicit unsupported outcome; no incomplete series           |
| Supported compressed transfer syntax          | Original bytes preserved; correct parser behavior            |
| Valid raw preambleless supported syntax       | Import only if explicitly implemented and verified           |
| Ambiguous preambleless transfer syntax        | Honest unsupported outcome; no unsafe guessed parse          |
| Malformed parser error with patient-like text | No sensitive data or pixel bytes in any public log           |
| Original DICOM Blob after storage             | Byte-identical to source                                     |
| Two competing operations racing on same SOP   | One canonical owner; deterministic duplicate/conflict result |

### 20.3. Cancellation and commit-boundary matrix

Test each cancellation source—footer button, header close, Escape, component disposal, and operation replacement—against:

1. Before source selection.
2. During native directory traversal.
3. During directory-input candidate iteration.
4. During ZIP central-directory admission.
5. While inflating a supported streamed member.
6. During header-only parsing.
7. During full DICOM parsing.
8. While waiting for the bounded writer queue.
9. Immediately before opening a write transaction.
10. While an abortable transaction is still active.
11. After a transaction has become effectively noninterruptible.
12. Immediately after `transaction.done` but before UI publication.
13. Between two committed batches.
14. During backup hash/model/frame verification.
15. Immediately before complete-backup primary commit.
16. After primary backup commit but before model finalization.
17. During nondestructive comparison refresh.
18. After terminal state, with a newly opened replacement dialog.

For every case assert:

- The active operation ID remains authoritative.
- No new work is admitted after acknowledgment.
- Committed and discarded counts reflect actual database state.
- No orphaned rows or premature dataset notifications remain.
- The final user-visible state matches the real transaction boundary.
- Stale callbacks cannot mutate a newer operation.

### 20.4. IndexedDB and quota matrix

| Scenario                                     | Required outcome                                                |
| -------------------------------------------- | --------------------------------------------------------------- |
| Single new-image batch                       | One canonical transaction and exact revision increment          |
| Several same-series batches                  | Parent rows written only when effective contents change         |
| Several patient/series groups                | Patient ownership validated within and across batches           |
| Empty batch after duplicate admission        | No write transaction, revision update, or notification          |
| Duplicate-only replay at low available quota | Success with zero incremental durable bytes                     |
| Mixed new/duplicate replay at low quota      | Charge only safe genuinely new payload plus overhead            |
| Quota failure before transaction             | Zero mutation for that batch                                    |
| Quota failure mid-transaction                | Transaction abort; no orphaned partial batch                    |
| Competing database write                     | Recheck ownership inside transaction                            |
| Open competing tab during upgrade            | Actionable blocked/open-tab explanation                         |
| Missing storage-estimate API                 | Honest unknown-capacity state; retain runtime error handling    |
| Nonpersistent browser storage                | Accurate warning without claiming imminent quota exhaustion     |
| Transaction failure after staging            | Temporary queue/reservation released                            |
| Aborted transaction                          | No committed-result publication and no mutation broadcast       |
| Committed `k` images                         | Final revision equals initial revision + `k`                    |
| Existing derived alignment frame             | Previous revision no longer accepted after committed new images |
| Same-series order cache                      | Invalidated once per changed series after commit                |

### 20.5. Archive adversarial matrix

Test:

- Valid stored ZIP member.
- Valid deflated ZIP member.
- Valid ZIP64 archive if whole-corpus archives are declared supported.
- Corrupted compressed payload with unchanged declared uncompressed length.
- Corrupted CRC field.
- Corrupted snapshot SHA-256 descriptor.
- Missing required snapshot hash under the documented version policy.
- Duplicate normalized member names.
- `../`, backslash traversal, absolute paths, drive-letter paths, and Unicode-normalization collisions.
- Hidden/system files and known irrelevant sidecars.
- Oversized compressed archive rejected before whole-file allocation.
- Oversized single member.
- Oversized declared total.
- Excessive member count.
- High declared or observed decompression expansion ratio.
- Mismatched central-directory and emitted member length.
- Unsupported compression method.
- Encrypted archive or password-required member.
- Nested archive under the chosen supported/unsupported policy.
- Corrupt member after a previously committed valid image batch.
- Archive cancellation during preparation, member inflation, and writer admission.
- Full 6.52 GiB real-corpus equivalent only if sufficient controlled test storage and the approved streaming design exist.

### 20.6. Complete-backup matrix

| Scenario                                 | Required outcome                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Valid complete backup                    | Original scans, settings, annotations, labels, frames, and models restore correctly |
| Backup without optional model assets     | No invented model warning; restore succeeds                                         |
| Backup with annotations/derived frames   | Ownership, geometry, masks, and dataset revision remain valid                       |
| Backup changes selected patient          | Explicit pre-commit disclosure and consent                                          |
| Conflicting existing patient identity    | Failure before unsafe visible mutation                                              |
| Orphaned annotation or derived frame     | Failure before primary commit                                                       |
| Corrupt image/model/hash                 | Failure before trusting the affected artifact                                       |
| Model database cannot open               | Detect before primary commit when possible                                          |
| Model sidecar fails after primary commit | Durable truthful repair-required result; primary data visible                       |
| Cancellation before primary commit       | No primary database changes                                                         |
| Cancellation during primary commit       | Honest noninterruptible finishing state                                             |
| Tab closure during staging               | Restart-safe cleanup without deleting existing user data                            |
| Tab closure after primary commit         | Restart identifies true sidecar finalization state                                  |
| Quota failure while staging              | Bounded cleanup and no unsafe authoritative switch                                  |
| Legacy supported backup manifest         | Existing backward compatibility preserved                                           |
| Unsupported newer manifest               | Explicit version message; no partial guessing                                       |

### 20.7. UX, accessibility, and visual matrix

For each source, discovery, review, execution, partial, complete, cancellation, and restore-repair state:

- Verify meaningful title, subtitle, and consistent import vocabulary.
- Verify visible local-only privacy/provenance status.
- Verify truthful available storage and persistence status.
- Verify keyboard reachability and focus order.
- Verify initial focus lands on the meaningful current action.
- Verify accessible role/name for the drop target and all buttons.
- Verify progress semantics, live announcements, and alert behavior.
- Verify no live-region announcement exposes filenames or patient identifiers.
- Verify every relevant coarse-pointer target reaches 44 × 44 px.
- Verify 320/390/768/1,024/1,440/wide desktop layouts.
- Verify source action wrapping, long text, and scroll containment.
- Verify reduced-motion behavior.
- Verify contrast on actual rendered palette combinations.
- Verify ordinary image import and complete-backup consent are unmistakably distinct.
- Verify completion remains visible through application data refresh.
- Verify patient-free screenshot capture in a dedicated isolated browser origin.

### 20.8. Regression and release commands

Run from `frontend/`:

```bash
npm run test -- tests/UploadModal.test.tsx tests/dicomIngestion.test.ts tests/storageIntegrity.test.ts tests/exportBackup.test.ts
npm run check
npm run build
npm run package:zip
```

Also run any new targeted source, operation, archive, worker, manifest, accessibility, browser-integration, and benchmark suites introduced by the implementation. Offline-release validation must open the packaged app through its existing local HTTP launcher and exercise at least one synthetic file import; a successful Vite development build alone is not offline-distribution proof.

## 21. Protected-corpus validation protocol

The corpus is protected user data. Treat it as read-only even when the user authorizes its use.

1. Do not move, rename, overwrite, prune, or delete source MRI files.
2. Prefer direct read-only access; do not create repository copies when synthetic fixtures and aggregate source reads are sufficient.
3. Run browser imports only against an isolated test origin/database, never the user's existing populated MiraViewer origin.
4. Verify adequate disk, memory, and browser storage before attempting the 6.52 GiB full corpus.
5. Begin with the known 512-file sample and record only aggregate counts.
6. Confirm the expected baseline composition:
   - 483 currently accepted MR images.
   - 17 intentional Secondary Capture exclusions.
   - 6 intentional non-displayable exclusions.
   - 6 genuine orthogonal scout/localizer MR images requiring an explicit policy outcome.
7. Preserve exact total accounting: every presented file is committed, duplicated, intentionally excluded, unsupported, failed with a named category, or not started because cancellation occurred.
8. Expand to medium representative subsets before a full-folder run.
9. Test duplicate replay without changing the test patient's ownership or selected state unexpectedly.
10. Test cancellation at measured batch boundaries and confirm actual stored counts afterward.
11. Test low-quota behavior without consuming or deleting unrelated user browser storage.
12. Only attempt a whole-corpus ZIP after selecting and validating its supported large-archive design.
13. Report aggregate counts, bytes, timings, transaction totals, phase latencies, and error categories only.
14. Never publish patient names, IDs, dates, real UIDs, accession numbers, filenames, full source paths, pixel arrays, source screenshots, or locally visible patient data.
15. Remove only explicitly agent-created isolated test resources after verification; never clear a user-owned database or origin.

The supplied corpus is excellent evidence for scale and its real scout/localizer incompatibility. It is not sufficient alone to certify all scanner vendors, patient-identity collisions, transfer syntaxes, pathological folder trees, browser engines, or backup versions; those require synthetic or independently approved fixtures.

## 22. Dependencies, sequencing, and review gates

Dependency order:

```text
Safety red tests
  → canonical patient/frame enrichment + sanitized diagnostics
  → single operation + cancellation + truthful results
  → bounded source discovery
  → canonical batch writer + unchanged revision semantics
  → measured duplicate/header/quota optimization
  → archive integrity / bounded streaming
  → explicit recoverable complete-backup restore
  → polished intake console + accessible outcomes
  → linear patient summaries / bounded manifests
  → protected-corpus browser qualification
```

UI design exploration and synthetic fixture construction can proceed in parallel with safety work. Production persistence changes must not bypass the earlier identity and revision gates. Large ZIP support and recoverable backup staging should remain independently reviewable because they introduce substantial resource and compatibility tradeoffs.

For each implementation slice require:

1. A failing test or measured baseline establishing the specific problem.
2. The smallest design that preserves existing ownership and medical invariants.
3. A passing targeted regression with an exact committed-state assertion.
4. Fresh performance evidence when the slice claims a speed or memory improvement.
5. No unrelated worktree changes or inclusion of protected user data.
6. Successful focused checks before proceeding to the next dependency.

## 23. Explicit tradeoffs and rejected approaches

### Rejected: increasing the 4 GiB archive constant alone

This would allow a larger JSZip payload without solving its eager compressed-byte materialization, memory admission, cancellation, integrity, or full-corpus resource envelope.

### Rejected: processing all images through unbounded `Promise.all`

Concurrent full-file reads and overlapping four-store write transactions multiply memory, increase contention, and weaken cancellation. A bounded producer/parser queue and one canonical writer are required.

### Rejected: treating an in-memory SOP set as the authority

An in-memory set cannot safely represent concurrent tabs, preexisting database state, persisted identity ownership, or committed transaction failures. It can be a bounded hint only when canonical IndexedDB revalidation remains mandatory.

### Rejected: reporting backup restore as atomically spanning two database names

The current primary medical database and separate model-cache database do not share one IndexedDB transaction. The design must acknowledge staging, commit, finalization, and repair as distinct facts.

### Rejected: changing revision semantics to one increment per batch

Existing tests and derived-frame consumers bind exact dataset revisions to committed image mutations. Reduce revision **writes** without changing the final revision **value**.

### Rejected: silently accepting mixed orthogonal scouts into one diagnostic stack

This would invalidate physical slice ordering, alignment, SVR, and patient-space assumptions. Use explicit named exclusion or fully designed geometry-homogeneous virtual stacks.

### Rejected: turning every valid-but-unwanted object into a generic success

Secondary Capture, non-displayable data, unsupported multiframe, valid scouts, corrupt members, and geometry conflicts have different meanings. Terminal classification must preserve those differences without frightening users over intentional exclusions.

### Rejected: unconditional full-archive CRC prevalidation

A global eager CRC pass can decompress every image twice and delay progress or cancellation. Verify each relevant member during the same bounded consumption used for import.

### Rejected: universal header-first double parsing without measurement

The synthetic probe reduced source bytes substantially but did not reduce warm Node CPU time. Use actual browser evidence and duplicate/source characteristics to justify the adaptive strategy.

### Rejected: introducing persistent series counts or resumability ledgers by default

Additional persisted authorities increase migration, restore, deletion, and invalidation complexity. Add them only when bounded existing-index traversal and canonical SOP deduplication cannot meet measured requirements.

### Rejected: cosmetic redesign before cancellation, privacy, and ownership fixes

A beautiful progress surface cannot compensate for continued background writes, cross-patient contamination, PHI-bearing parser logs, or false backup atomicity.

### Rejected: fictional medical visualizations

Decorative anatomy, fake scans, invented slice previews, fabricated patient metrics, or animated pseudo-analysis erode trust and can be confused with actual medical evidence. The visual signature must derive solely from real discovered acquisition facts.

### Rejected: presenting Node/fake-IDB timings as real-browser improvements

The current measurements identify architecture and relative work but exclude browser paint, real disk-backed commit behavior, browser quota pressure, and user interaction. Release performance claims require actual browser evidence.

## 24. Open product decisions and their safe defaults

1. **Should orthogonal scout/localizer images be viewable?**
   - Safe default: classify and explicitly report them as excluded from homogeneous diagnostic stacks.
   - Expanded choice: design stable virtual acquisition groups and update every downstream owner before preserving them as selectable stacks.

2. **Must one ZIP hold the entire 6.52 GiB supplied corpus?**
   - Safe default: document the current supported ceiling and direct large collections to folder import.
   - Expanded choice: approve a browser-compatible, offline-capable bounded ZIP64/streaming architecture and validate it end to end.

3. **Should complete backup restore merge or replace existing records?**
   - Safe default: preserve existing current merge/overwrite behavior only after explicit per-artifact consent and conflict preflight.
   - Expanded choice: expose a separately specified merge/replace mode with its own patient, annotation, quota, and recovery tests.

4. **How much patient detail belongs in the pre-import review?**
   - Safe default: show local patient/examination grouping only when established safely; never leak it into logs, screen-reader global announcements, or public artifacts.
   - Expanded choice: user-configurable privacy masking for shared-screen environments.

5. **Are raw preambleless DICOM datasets required?**
   - Safe default: explicitly disclose unsupported/ambiguous raw syntax.
   - Expanded choice: implement specific validated transfer-syntax detection with dedicated malformed and compressed-format tests.

6. **Can a ZIP mixed with ordinary files be processed in one operation?**
   - Safe default: reject mixed archive/file selection before mutation with clear instructions.
   - Expanded choice: flatten ordinary image archives through the same bounded candidate stream while keeping complete backups separate.

7. **Should new images appear during import or only after completion?**
   - Safe default: refresh committed data on bounded terminal or batch boundaries without unmounting the intake console.
   - Expanded choice: progressive per-series visibility after measuring read-side cost and preserving stable patient selection.

None of these open decisions blocks the immediate patient/frame, sanitized logging, cancellation, truthful outcome, and exact revision repairs.

## 25. Definition of done

The improvement effort is complete only when all of the following are true:

1. The missing → A → B identity/frame reproduction no longer permits unsafe patient or spatial mixing.
2. Malformed parser exceptions cannot leak patient-like strings, UIDs, filenames, source paths, raw datasets, or pixel bytes to public logs.
3. Files, folders, fallback directory inputs, supported drops, ordinary ZIPs, and complete backups follow one coherent documented operation contract.
4. Cancellation stops new work and reports the exact durable committed state.
5. No old timer, stale operation callback, modal unmount, or background refresh can mutate or close a newer import.
6. The actual application retains import results while refreshing newly committed comparison data.
7. The protected 512-file sample accounts explicitly for all 512 files, including its six real orthogonal scout/localizer images.
8. All-duplicate import succeeds under low incremental quota without new blob writes or image-by-image write-lock acquisition.
9. New-image transaction, parent-write, revision-write, notification, and visible-progress counts meet measured batch-scaled targets.
10. Final dataset revision exactly preserves the existing per-new-image increment semantics.
11. Archive CRC corruption, path traversal, unsafe expansion, malformed members, and unsupported archive modes have deterministic safe outcomes.
12. The complete-corpus ZIP ceiling or streaming capability is disclosed honestly and verified according to the approved product decision.
13. Complete-backup restoration requires explicit consent, preserves all supported saved work, and recovers truthfully from sidecar database failure.
14. Patient summary and frame-manifest construction no longer exhibit the identified quadratic/N+1 transaction shapes.
15. The Acquisition Intake Console clearly communicates local-only processing, source type, actual discovered images, storage, progress, exclusions, cancellation, and durable results.
16. All supported interaction states pass keyboard, screen-reader, reduced-motion, 44 px coarse-pointer, contrast, and responsive layout checks.
17. Real-browser protected-corpus measurements demonstrate improved throughput/responsiveness or lower resource use against comparable baselines; Node-only measurements are not substituted for browser evidence.
18. Existing alignment, SVR, annotations, original DICOM fidelity, patient separation, offline packaging, and downloadable release workflows remain correct.
19. Focused tests, full checks, production build, and offline release packaging pass.
20. No existing user worktree changes, protected MRI source files, live patient database, user browser tab, patient identifiers, or screenshots are damaged, copied into public artifacts, or exposed.

## Final recommendation

Prioritize patient ownership and sanitized diagnostics immediately, then make cancellation and partial outcomes honest before pursuing throughput or visual polish. The correct long-term architecture is one local-only, patient-aware, bounded acquisition pipeline with a single canonical writer and an explicit recoverable backup path. The interface should surface those real guarantees through a composed clinical intake console rather than hiding unsafe or incomplete operations behind a generic upload spinner.
