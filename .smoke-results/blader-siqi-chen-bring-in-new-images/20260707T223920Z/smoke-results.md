# Align All structure-first smoke results

## Run identity

- Candidate branch: `blader/siqi-chen/bring-in-new-images`
- Candidate commit: `560b547ad066fa4024401e88afce15714548850f`
- Candidate state: staged, unstaged, and untracked files included; initial porcelain-state digest `35f76ff3e52a9a430baeff4f6018e6c848a42f34d5e42b0b56c9c86b07d29704`
- Baseline: `origin/main` at `a0c40d9df6456089e8e07181e5443e7f3089d3ee`
- Owner: local Codex execution for the user
- Environment: local macOS browser app, candidate Vite server on `43124`, disposable baseline Vite server on `43125`

## Intended value

Align All should choose corresponding anatomy when scan intensities differ substantially, derive residual translation from structural edges, and apply a final affine only when fixed-domain MIND plus NGF show that it improves on the rigid-plus-translation seed. Failures of either optimizer must leave a valid seed fallback.

## Scenario plan

| Scenario | Value or risk | Interaction path | Final assertions | Planned evidence |
| --- | --- | --- | --- | --- |
| Representative cross-date MRI | Structure should outrank raw intensity | Open local app, load the same anonymized multi-date data in baseline and candidate, choose an internal-landmark reference slice, run Align All, inspect flicker and held-`Z` diagnostics | Candidate selects corresponding landmarks; MIND and NGF explain the choice; appearance-favored distractor does not win | Baseline/candidate screenshots, candidate video, debug scalar record |
| Optimizer degradation fallback | A plausible affine must not worsen a good seed | Run Align All on a date already close to reference | `seed-only` remains selected when both proposals reduce structural agreement | Debug overlay plus stored proposal aggregates |
| Failure and cancellation | A failed or cancelled registration must not apply stale settings | Fail either optimizer or cancel during the second attempt | Remaining proposal/seed completes on ordinary failure; cancelled date is discarded | Runtime state and diagnostics |
| Debug visibility | Diagnostics must remain non-product UI | Hold and release unmodified `Z` with debug enabled and disabled | Structural rows appear only for debug + held `Z`; legacy rows remain compatible | Baseline/candidate screenshots |

Pass criteria require settled behavior on the running product surface with identical representative input. Build, lint, and test results are supporting evidence only.

## Preflight evidence

- Complete focused structural suite after final-review fixes: **123/123 passed** across 10 files.
- Repository-wide `npm run check` after final-review fixes: **55/55 files and 292/292 tests passed**, including cancellation, worker recovery, malformed-output eviction/retry, scalar optimizer provenance, structural winner, seed fallback, selected-transform NMI/settings, shortlist, and debug-overlay cases.
- Candidate ordinary `npm run build`: blocked only by pre-existing unrelated missing `polygonToSvgPath` references in `TumorSegmentationOverlaySeedGrow.tsx` at lines 982, 983, and 985.
- Scoped candidate build in detached worktree `/tmp/miraviewer-align-build.tqhlYT/worktree`: **passed**, 1,944 modules transformed.
- Clean baseline build in detached worktree `/tmp/miraviewer-baseline-smoke.jYt8fu/worktree`: **passed**, 1,899 modules transformed.
- Baseline and candidate Vite roots both returned the application HTML successfully.
- `git diff --check`: passed.

## Runtime execution

### Browser readiness

The supported in-app browser backend was unavailable. The browser runtime exposed only a Chrome extension surface; the mandated in-app backend lookup returned `Browser is not available: iab`. The browser troubleshooting flow was followed once and confirmed no supported in-app surface. Per the browser-control contract, the run did not switch to an unrelated browser backend or source-code proxy.

### Baseline

- Classification: `fresh-incomplete`
- Build: passed.
- Server readiness: passed on `127.0.0.1:43125` with zero TypeScript watcher errors.
- Decisive product interaction: not reached because the supported interactive browser backend was unavailable.

### Candidate

- Classification: `fresh-incomplete` for behavior-level smoke evidence.
- Server readiness: passed on port `43124` from the full uncommitted candidate worktree.
- Automated behavior checks: passed as listed above.
- Decisive representative-data interaction, screenshot, video, reload/persistence, allocation trace, and longest-task capture: not reached because the supported interactive browser backend was unavailable.

No patient pixels or identifiers were captured or written to this report.

## Assertion-to-evidence mapping

| Assertion | Available evidence | Runtime artifact |
| --- | --- | --- |
| Structurally correct, intensity-disadvantaged slice wins | Primitive, pure-pipeline, and 21-candidate hook regressions | Pending supported browser |
| Structural residual translation is used | Phase-correlation and nonidentity pipeline regressions | Pending supported browser trace |
| Final affine cannot degrade seed | Pure selector and hook seed-fallback regressions | Pending held-`Z` overlay |
| Failed workers are evicted and retries reacquire | Adapter and two-date hook regressions | Pending runtime failure injection |
| Cancellation discards current date | Hook cancellation and superseded-run regressions | Pending runtime cancellation |
| Diagnostics are debug-only and scalar-only | Viewer and recursive store regressions | Pending screenshot/video |
| Descriptor buffers are transient | Code inspection plus recursive no-`Float32Array` assertions over all retained candidate/proposal records | Pending allocation sample |

## Remote checks

Not run. Publishing a temporary branch or PR was outside the user's requested local execution scope and was not authorized. No remote evidence is claimed.

## Verdict

**Pass with caveats.** The implementation, full local test suite, scoped production build, baseline build, and server readiness pass. The behavior-level browser smoke run is incomplete because the supported in-app browser backend was unavailable, so this run does not claim real-world MRI accuracy, visual alignment quality, persistence behavior, screenshots/video, or allocation-trace proof. Those checks remain pending on a supported interactive browser surface.

## Next action

When the in-app browser is available, repeat the four scenarios above with the same anonymized multi-date scan pair, capture baseline/candidate screenshots plus a candidate video, inspect the held-`Z` MIND/NGF/final-affine values, and record the performance/allocation trace without storing patient identifiers.

## Cleanup

The disposable baseline server was stopped and both temporary baseline/scoped-build worktrees were removed after their evidence was captured. The candidate Vite server predated this smoke run and was left running unchanged.
