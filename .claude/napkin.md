# Napkin Runbook

## Curation Rules

- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)

1. **[2026-07-07] Keep copied DCS volumes out of source control**
   Do instead: store them under `DCS-volume-copy-<study>/`, keep that pattern ignored, and never stage DICOM files or bundled viewer media.
2. **[2026-03-28] Treat mounted imaging media as read-only**
   Do instead: copy out with `rsync -a` into a workspace-local folder and verify counts or top-level contents after transfer.
3. **[2026-05-10] Name repeated DCS copies by study folder**
   Do instead: when `/Volumes/DCS` is reused for a new disc, copy into `DCS-volume-copy-<top-level-study-folder>` before archive extraction.
4. **[2026-07-06] `npm run check` does not prove the production TypeScript build**
   Do instead: run both `npm run check` and `npm run build` from `frontend/`; if unrelated dirty work blocks the latter, overlay only the scoped files onto a detached clean worktree and build there without changing the user's files.
5. **[2026-07-07] Apply exclusion padding in the coordinate system that defines it**
   Do instead: expand a reference-space exclusion by reference pixels before inverse-mapping its corners; post-map source-axis padding under-covers the region when the seed is rotated.
6. **[2026-07-07] Keep similarity ROI shape-aware**
   Do instead: build the fixed reference domain from dilated, hole-filled anatomical support; a foreground bounding box gives shared black corner canvas positive similarity weight.

## Shell & Command Reliability

1. **[2026-03-28] Large volume size probes can stall**
   Do instead: inspect mount presence and top-level listing first; use resumable copy commands instead of waiting on full `du` when the user only needs a local copy.

## Domain Behavior Guardrails

1. **[2026-07-07] Align All is structure-first**
   Do instead: rank slice correspondence primarily from modality-independent local structure and shared boundaries; treat direct cross-scan intensity agreement only as supporting evidence.

## User Directives

1. **[2026-03-28] Keep copied data in the current workspace**
   Do instead: create a clearly named destination folder under the current repo/worktree unless the user specifies another path.
