# Streaming backups and staged restoration

## Result

The normal production application exported and restored a **2,173,276,563-byte ZIP (2.02 GiB)**. A fresh disk-backed browser profile recovered all 128 DICOM files, an 8 MiB label volume, literal Add/Remove marks, source-owned settings, derived pixels/support and 16 synthetic model payloads. A separate 40.60 MiB export through a native writable file also restored correctly.

Cancellation, a corrupted payload and a quota exception during final publication left the previous visible dataset unchanged. These are storage and lifecycle results, not anatomical, model-quality or hardware-rendering acceptance.

The [round-trip receipt](round-trip.json) contains the independently verified member hashes, exact recovered records, timing and resource summaries. The [unit receipt](unit-suite.json) identifies the later candidate tree and its complete default test run. All seven [normal-production browser workflows](workflow.json) also passed at that later fingerprint, including backup restoration, annotations, model controls and alignment recovery.

## What changed

The old export path retained every payload buffer in JSZip; restore held the decoded payloads and wrote the separate model cache before committing medical data. A failed restore could therefore replace a cached model without restoring its examination. Raising the aggregate limit would not repair either ownership boundary.

Schema 10 keeps models and operation-private restore staging in the existing MiraViewer database. The model API migrates legacy cached bytes and timestamps once, transactionally. The old cache is no longer a read-through authority; retained legacy bytes are not deleted by migration.

Export keeps the version-2 manifest and writes STORE ZIP members with incremental SHA-256/CRC and ZIP64 directory support. File output uses backpressured 64 KiB writes. Ordinary downloads assemble immutable Blob references instead of collecting every payload in JavaScript arrays. Derived images are read individually; the existing label reader can still materialize one selection during export.

Restore verifies a payload before staging it. Images and models are Blob-backed; labels become bounded batches of nonzero 4 KiB chunks. One final transaction publishes the scans, settings, annotations, labels, derived frames, models and saved-work token. It also removes its staging. Any failure aborts that transaction; cancellation is honored before publication, not partway through it.

A Web Lock serializes cooperating restores and allows abandoned lock-owned staging to be reclaimed. Contexts without Web Locks use a separate key namespace: another producer's uncoordinated staging is not deleted. Normal failure/cancellation removes only the current operation's rows. Abandoned staging from an unsupported context remains until explicit data clearing rather than risking another live producer.

## Evidence and provenance

| Check | Observed result |
| --- | --- |
| Physical large archive | 2,173,276,563 bytes; Python `zipfile` read every referenced member and checked CRC plus manifest SHA-256 |
| Referenced payload members | 147: 128 DICOM files, labels, derived pixels/support and 16 models |
| Source images | All recovered hashes matched the original generated DICOM buffers |
| Label volume | 256 × 256 × 128; exact recovered label hash and review state |
| Literal marks | Foreground `[0, 4096, 8388607]`, background `[1, 4097]`, last stroke axial/127; exact recovery |
| Settings | Source-owned zoom 1.25 and pan X 0.12, with the remaining settings preserved |
| Models | 16 × 128 MiB; every recovered byte checked against its independent constant-byte fixture; original timestamps preserved |
| Derived frame | Exact float-pixel/support hashes and source/reference identity |
| Native writable-file output | 42,570,083 bytes; independently checked and restored with the changed labels/settings/models |
| Export cancellation | No download; read activity settled in 314 ms, including the observer's 250 ms quiet window |
| Restore cancellation | 54 ms from click to canceled UI after staging had begun; previous records/token unchanged |
| Corruption | One physical byte flipped in a cloned model member; CRC rejection left previous records/token unchanged |
| Late quota failure | `QuotaExceededError` injected at the first model write in the final publication transaction, after medical/label writes had been submitted; complete rollback |
| Staging after each completed attempt | No current-operation rows remained |
| Browser errors | None in the completed run |
| Complete default unit suite | 3,209 passed, zero failed, 54 existing optional skips |
| Final production checks | TypeScript, full lint and isolated production build passed; seven browser workflows passed in 40.8 s with unchanged source |

The large run used installed, headed Chrome 152.0.7977.82 at `http://127.0.0.1:43134/`, with two separate disposable persistent profiles. Input bytes were generated; no private MRI, private weights or patient media were used. Models in this test are opaque synthetic byte payloads, not inference models.

The native-file route used a real Chromium OPFS `FileSystemWritableFileStream`. Only the OS picker was substituted with the generated file handle. This proves the application writer and native file close/readback path, not interaction with the operating system's save dialog.

The normal production build's application fingerprint was `04b60314aa9a36b39b4403cc35023a39df0ea43ca42774306c3b91d84bc33a25`. The runner also recorded the exact newer test-harness fingerprint and verified source stability for the run. The bundle was reused after test-only changes; it does not import the acceptance probes. The later unit candidate, including the cleanup namespace guard, has application fingerprint `7c7631bda4c3bb809dd8201e3ce3249a666b598fca792604143e186b561aa619`. Parent HEAD values in raw receipts identify the uncommitted candidate's parent, not a claim that the parent contained these changes.

### Resource measurement

The runner sampled the owned browser roots and descendants every 500 ms. **Peak observed aggregate RSS was 2,373.4 MiB (2.32 GiB)** during the two-browser fresh-profile restore. This sums shared pages across processes and includes browser/application overhead; it is not unique memory, a guaranteed instantaneous peak or a promise of the same result on every device.

| Phase | Elapsed time | Peak observed aggregate browser RSS |
| --- | --- | --- |
| Large ordinary export, including saving the download | 77.55 s | 1,351.8 MiB |
| Corrupt restore and cleanup | 4.86 s | 1,488.9 MiB |
| Late quota failure and rollback/cleanup | 105.78 s | 1,285.4 MiB |
| Native-file export | 3.35 s | 1,100.9 MiB |
| Fresh-profile large restore | 71.07 s | 2,373.4 MiB across both browser instances |

The 54 ms restore-cancel interval fell between RSS samples, so no phase-specific peak is claimed. The recorded large export used no Blob array-buffer read larger than 65,557 bytes. Restore observations reached 1 MiB array-buffer reads for labels and 2 MiB native stream chunks. Legacy compressed members and one materialized export selection remain per-entry memory costs, not aggregate archive buffers.

An earlier attempt used Playwright's default incognito-like context. Its database itself was memory-backed: aggregate RSS was already several GiB before export and peaked at 5,817.7 MiB after source replacement. That result is retained but is not used as the disk-backed resource estimate. The attempt also stopped on an incorrect populated-page selector before restoration. Correcting the producer, not changing product code, supplied the disk-backed measurement. See [Playwright's context contract](https://playwright.dev/docs/api/class-browsercontext) and [Chromium's in-memory IndexedDB predicate](https://chromium.googlesource.com/chromium/src/+/c0811f657d5ae8c42a9fb827e7e36e7e58a16bab/content/browser/indexed_db/instance/bucket_context.h).

## Static UI review

The [desktop export dialog](streaming-backup-export-desktop.png) and [mobile export dialog](streaming-backup-export-mobile.png) were individually inspected at original detail. Typography, spacing, wrapping and both export actions passed the static review. The [large-backup review](streaming-backup-restore-review.png) passed for its visible size, storage disclosure and saved-work inventory; consent is below that capture's scroll position and was exercised separately by the test. These are not animation or anatomical verdicts. Storybook was not used.

[Capture hashes and original locations](captures.json) preserve source provenance. The final workflow's desktop/mobile export captures were byte-identical to the preserved images and were individually re-inspected. Every temporary browser/profile and the strict-port server was closed after its batch. A final scoped audit of 19 current/prior task receipts found no remaining owned process or profile. User and other-worktree browsers were not touched.

## Reproduce and limits

From `frontend/`, the repository-owned case is:

```sh
npm run build:browser
PLAYWRIGHT_HTML_OPEN=never npm run test:performance -- --grep 'backup capacity streams' --reporter=line
```

This generates several GiB of synthetic artifacts and uses temporary disk-backed profiles. Python 3 supplies the independent ZIP verifier. The measured run instead used the retained normal-production builder and headed-Chrome/RSS wrapper; its exact launch configuration and raw samples remain with the local receipts. The standard command need not produce identical timing or RSS.

Individual files still have the existing 512 MiB limit. File count, metadata, offsets, expansion ratio, ownership and integrity checks remain. Restore requests headroom for staging and publication, plus the existing reserve. Final database publication and native file close are deliberately noninterruptible. The complete ZIP format remains version 2, including legacy numeric-key editing-mark compatibility.

This does not close the audit's separate legacy-volume-key, rolling-renderer, startup/host-parity, CI/release or legacy-geometry work. Keep originals and verify restoration before relying on a backup. Raw attempts, large ZIP inputs, failure traces, authored harnesses and original screenshots remain under ignored `artifacts/`; only the curated synthetic evidence is published here.
