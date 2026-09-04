# Historical task: Align All click repair

This is a completed task record, not the current project intent or validation status. See the [current architecture and validation guide](design-docs/miraviewer-architecture.md) and [audit implementation ledger](exec-plans/active/2026-09-02-full-codebase-audit-implementation.md). Server state and test totals below describe that earlier task.

## User's Goal
Restore the broken “Align All” action in MiraViewer.

## Underlying Intent
Make the rectangle-based alignment workflow respond reliably when the user selects a region and clicks “Align All.”

## Scope
- **In scope**: Trace the action-button event path, fix the click regression, add focused coverage, run the frontend checks, and launch the repaired app.
- **Out of scope**: Reworking the alignment algorithm or modifying unrelated in-progress overlay changes.

## Done Criteria
The first click on “Align All” after drawing a rectangle reaches its action callback, the full frontend checks pass, and the fixed app is running locally.

## Active Alignment
Completed and aligned. The drag overlay no longer suppresses clicks targeting its action buttons. A focused drag-and-click regression test and the full 153-test frontend suite pass, and the dev server is running on port 43124.

## Tensions
The repo contains unrelated uncommitted polygon-rendering refactors; they were preserved and not changed as part of this fix.
