# Saved work follows its source, not the latest import

## Result

A reviewed selection on a synthetic **36 × 36 × 24** source now reopens after an unrelated import and after a complete backup is restored in a fresh browser context. The normal application recovered an older native key without writing it, preserved literal Add/Remove marks and reviewed state, saved subsequent edits under the stable key, and kept the original record. Clear remained cleared after reload instead of recovering the retained original again.

Selective backups also preserve unresolved legacy panel-setting ownership. Omitting another acquisition from a backup no longer makes a previously ambiguous setting eligible for automatic assignment. Re-exporting the subset retains that decision; no omitted patient's identifiers are added to the backup.

The [acceptance receipt](acceptance.json) records **3,254 passing unit tests, zero failures, 54 existing optional skips**, TypeScript, zero-warning full lint, a normal production build and **10 passing normal-app workflows in 50.4 seconds**. This is the pre-reduction acceptance checkpoint. TurboVac reduction and final-head publication/merge clearance have their own later evidence; this report does not claim them in advance.

## Reconstruct the original failures

Start with one acquired source, paint Add and Remove marks, and mark the selection reviewed. Import an unrelated examination, then reopen the unchanged source. The old label address included the patient grouping and global dataset revision. Native reconstruction also embedded that revision in its fingerprint. The label row still existed, but the viewer asked for a different key.

An independent production-constructor regression held pixels, support and geometry fixed. Changing only the dataset revision changed `native-v1-702a1fb5` to `native-v1-924ab03e`. The retained pre-change failure and captured first fingerprint are the compatibility oracle; the new implementation does not generate both sides of that assertion.

For settings, start with two possible owners of a legacy date-based row and export only one. Previously, restored hydration saw only that owner and automatically assigned a row whose original ownership was unresolved. A real ZIP round trip, followed by a second export/restore, now checks that the ambiguity survives.

## Design and invariants

### Durable identity versus live operation state

The version-2 selection key contains the Study/Series UIDs, frame of reference, exact output dimensions, spacing, origin, direction and reconstruction fingerprint. It omits the patient-group display identity and global import revision. Native fingerprints retain contributing SOP identities, ordered inputs, physical output geometry and the registered transform without including that operation epoch. Independent-2D reconstruction fingerprints were already independent of the global revision and are unchanged.

Live source admission and cancellation still verify the current dataset revision. Saved-work tokens still retire old writers after restore/recreation, and per-record revisions still reject competing saves. This is separation of ownership, not removal of stale-work checks.

The existing immutable DICOM SOP-identity contract remains the source authority. These keys are not cryptographic attestations of pixel bytes deliberately replaced under a reused SOP UID. No whole-acquisition pixel scan, alias registry, database-open payload migration or new object store was added.

### Readonly exact recovery

`selectionMigration.ts` owns source/grid equivalence. `db/volumeSegmentations.ts` checks the live selected patient, owning study and revision in the same readonly snapshot as the label heads. Discovery scans the owning study's metadata; it reads chunks only for the selected exact match.

Automatic recovery requires one candidate with verified key/row geometry, source SOPs, source kinds, registered transforms and study-owned historical patient aliases. Native-v1 fingerprints are recomputed using the candidate's original revision and the accepted current source/grid. Exact recovery does not use the looser coordinate tolerance of an explicitly requested cross-grid draft transfer.

Unknown geometry, changed sources and multiple equivalent legacy records do not authorize automatic assignment. Original records remain stored. Incomplete historical volumes retain the old key format rather than inventing provenance. Ordinary cross-grid transfer remains a separate draft operation with its existing dataset and registration guards.

### Save, retry and Clear

The first intentional edit of recovered work writes a full canonical checkpoint, even when the edit itself is sparse. One transaction verifies that the canonical target is still absent, the legacy origin's revision and timestamp are unchanged, the saved-work token still matches and the study still belongs to the active patient. The origin is never overwritten or deleted.

After that commit, ordinary sparse writes use the canonical record's revision. A failed first copy retains the origin guard for an explicit Retry. Clear commits an empty checkpoint; zero label chunks represent it without allocating a full empty mask in the storage API. Its presence prevents a subsequent reopen from falling back to the legacy record.

### One legacy-settings policy

`db/panelSettings.ts` owns the candidate/automatic-assignment decision used by hydration and selective export. Optional per-date `assignmentRequired` metadata records unresolved ownership when other candidates are omitted. Malformed ambiguity metadata cannot authorize automatic assignment. Known unambiguous settings still project without a write, and the existing explicit assignment action remains the resolution path.

## What was verified

| Boundary            | Evidence                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native identity     | Same source, pixels, support and geometry survive an unrelated revision; replacing a source SOP changes the fingerprint                                                                                              |
| Legacy recovery     | Dense and chunked rows recover readonly across patient regrouping; reviewed labels and literal marks match                                                                                                           |
| Unsafe equivalence  | Changed source, transform, origin, dimensions, spacing, classification, fingerprint, ownership or hard-mark evidence does not auto-project                                                                           |
| Ambiguity           | Two equivalent legacy candidates remain unassigned; original records remain unchanged                                                                                                                                |
| Atomic first edit   | Sparse first edit retains unchanged original voxels; changed/deleted legacy origin, competing canonical target and replaced dataset reject stale publication                                                         |
| Retry               | Real viewer preserves unsaved edits and the original-record guard through a failed first save, then uses the committed canonical revision                                                                            |
| Clear               | Empty canonical checkpoint survives reopen while the retained legacy selection remains intact                                                                                                                        |
| Selective backup    | Ambiguous panel settings remain unresolved through two actual ZIP round trips; unambiguous settings still restore normally                                                                                           |
| Actual application  | Browser revision 24 → 48 after unrelated import, then 49 after fresh-context restore; 13 selected voxels and 13 Add/13 Remove marks recover, a subsequent edit saves 26 selected voxels, and Clear reopens with zero |
| Broader regressions | Ten normal-production workflows cover metadata recovery, custom-model lifecycle, annotations/backups, acquisition choice, date collisions, and cold/warm alignment                                                   |

The exact physical ZIP, generated scans, failed attempts, original captures and full raw receipts remain local and protected. Only synthetic, path-scrubbed evidence is published here.

## Provenance and limitations

The acceptance app fingerprint is `198bfb1734151c2db23b3faf59ebc6f7168ed66445503c2e7084494ffa348460`. The final TypeScript/lint/browser source fingerprint is `ee77808482d06c711ac37e27fdc287f10a07868cf3250e77e78941f935c19580`. The full unit run used `f89c153fadf3e86f0caa650a0d59a65d42aea14a56a54b9aee183d53f9ffb800`, before a browser-fixture-only lint correction; application inputs were identical. Receipts identify the uncommitted candidate's parent HEAD rather than pretending it was the implementation commit. No source changed during a recorded check.

The browser used installed, headed Chrome **152.0.7977.82** at `http://127.0.0.1:43134/`, isolated contexts and a normal production bundle with no acceptance-only probes. The unchanged production bundle was reused after the browser-fixture lint correction; its original manifest was retained and the later run truthfully reports a different full-source hash but matching application/model hashes.

The first focused runs exposed cross-realm typed-array assertions in the new tests. The final assertions compare literal label/mark values; storage behavior was not changed to force them through. TypeScript required a narrowed visible-row binding. Lint then found unused fixture fields; fixture validation now reads those fields. The original full-suite wrapper refused to overwrite an older lint log, so lint ran separately under a fresh filename. All unsuccessful receipts are retained.

An older application build does not understand new version-2 keys. Refresh older tabs before editing; preserving a legacy original is not a promise that an old build displays later canonical edits. No migration guesses an owner or registration for unverifiable historical work. This report makes no anatomical-accuracy, motion, general performance or universal memory-bound claim. The larger audit's warm-rendering, startup/host-parity and CI/release requirements remain open.

## Static captures and lifecycle

The [recovered selection](durable-grid-recovered-desktop.png), [fresh-context restored selection](durable-grid-restored-desktop.png) and [cleared/reopened view](durable-grid-cleared-reopened.png) were each inspected individually at original detail. Status labels, visible controls, typography, pane composition and distinct Add/Remove colors passed. Lower panes extend below the captured viewport, so this is not full-page layout sign-off. The complete browser run produced byte-identical images. Other workflow captures remain retained without a new aesthetic verdict. Storybook was not used.

The final scoped audit checked **29 current/prior task receipts** and found no owned browser, server or temporary profile. Port 43134 was free. User and other-worktree browser state was preserved. Generated bundles, private MRI, canonical models, marks, authored harnesses and raw receipts were not deleted.

## Reproduce

From `frontend/`:

```sh
npm run test -- tests/svrSourceAdmission.test.ts tests/svrSelectionMigration.test.ts tests/SvrVolume3DViewer.test.tsx tests/localApi.test.ts tests/exportBackup.test.ts --maxWorkers=2
npm run build:browser
PLAYWRIGHT_HTML_OPEN=never npm run test:browser -- --grep 'keeps exact source-bound selections' --reporter=line
```

The retained normal-production run used the same checked-in workflow with a separate output directory and headed-Chrome wrapper. Do not point tests at a user's MRI origin or browser profile.
