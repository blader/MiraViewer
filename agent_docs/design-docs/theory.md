# Theory: Align All Click Regression

## Problem

The rectangle-selection overlay owns both viewer click suppression and the “Align All” action buttons. After a drag, it marks the next click for suppression so the underlying viewer does not interpret the completed drag as a normal image click. That suppression ran during capture and did not distinguish viewer clicks from clicks on the overlay's own action buttons.

## Operating Theory

Because React capture handlers run before the target button's click handler, a stale `didDragRef` could prevent the action button's handler from ever seeing the first click. The alignment pipeline was therefore not the initial failure point: the action callback itself was blocked at the event boundary.

## Strategy

Keep viewer-click suppression for genuine post-drag clicks, but exempt elements marked with `data-drag-rect-action-button`. Clear the stale drag flag while allowing the event to continue to the target button. Cover the exact sequence in a component test: draw a valid rectangle, click “Align All” once, and assert its callback runs once.

## Key Discoveries

The action buttons already carried a marker used by pointer-down capture to avoid starting a new selection, so the same marker is the correct contract for click capture. The focused regression test passes, the full frontend suite passes with 153 tests across 44 files, and the running dev server reports no TypeScript or ESLint errors.
