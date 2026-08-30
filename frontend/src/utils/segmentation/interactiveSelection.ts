import type { SvrVolume } from '../../types/svr';
import { transferSelectionAnnotations } from '../svr/annotationTransfer';
import { patientToVolumeVoxel, volumeVoxelToPatient } from '../svr/volumeGeometry';
import type { TrackingSourceRange } from './interactiveFrame';
import type { InteractiveTrackingProvider } from './efficientTam/model';
import { createInteractivePlaneReader, mapInteractiveMarks, mapInteractivePlane } from './interactiveGeometry';
import { collectTrackingPrompts } from './interactivePrompts';
import { InteractiveTrackingWorker } from './interactiveTrackingWorker';
import { SELECTION_LABEL_META, SLICE_AXES } from './selectionEditing';
import type { SelectionProposalRequest, SelectionProposalResult } from './selectionProposal';
import { prepareEmptyEditingPlanePruning } from './emptyEditingPlane';

type InteractiveSelectionSource = {
  /** Owned real source samples; context extent and runtime admission belong to the source owner. */
  nativeContext: SvrVolume;
  sourceRange: TrackingSourceRange;
  provider: InteractiveTrackingProvider;
  /** Opt-in consumer contract: hard marks and foreground-connected components determine the final mask. */
  retainMarkedComponents?: true;
};

function supported(volume: SvrVolume, index: number): boolean {
  return Number.isFinite(volume.data[index]) && (!volume.observedSupport || Boolean(volume.observedSupport[index]));
}

/** Whether some editing-grid centers are outside the actual context's categorical sampling domain. */
function limitsEditingGrid(context: SvrVolume, editing: SvrVolume): boolean {
  for (const x of [0, editing.dims[0] - 1])
    for (const y of [0, editing.dims[1] - 1])
      for (const z of [0, editing.dims[2] - 1]) {
        const point = patientToVolumeVoxel(context, volumeVoxelToPatient(editing, [x, y, z]));
        if (point.some((value, axis) => Math.round(value) < 0 || Math.round(value) >= context.dims[axis]!)) return true;
      }
  return false;
}

/**
 * A disposable model proposal on real native planes, returned on the existing editing grid.
 * Literal brush marks, publication and undo remain owned by the selection hook. No model
 * output is published before coverage is complete or unseen tails are certified
 * irrelevant to the explicitly requested connected selection. No classifier fallback is applied.
 */
export async function proposeInteractiveSelection(
  { nativeContext, sourceRange, provider, retainMarkedComponents }: InteractiveSelectionSource,
  { volume, seeds, signal, onProgress }: SelectionProposalRequest,
): Promise<SelectionProposalResult> {
  const abort = () => {
    if (signal.aborted) throw new DOMException('Interactive selection canceled.', 'AbortError');
  };
  abort();
  if (!seeds.lastStroke)
    throw new Error(
      'Add an inside or outside mark on a slice before suggesting a boundary; the editing plane is missing.',
    );
  const stroke = mapInteractivePlane(volume, nativeContext, seeds.lastStroke);
  const marks = {
    foreground: mapInteractiveMarks(volume, nativeContext, seeds.foreground),
    background: mapInteractiveMarks(volume, nativeContext, seeds.background),
  };
  const frames = collectTrackingPrompts(nativeContext, stroke.plane, marks);
  const anchor = frames
    .filter((frame) => frame.labels.includes(1))
    .sort((a, b) => Math.abs(a.index - stroke.slice) - Math.abs(b.index - stroke.slice) || a.index - b.index)[0];
  if (!anchor) throw new Error('Mark inside the tissue you want to select before suggesting a boundary.');
  const [nx, ny, nz] = nativeContext.dims;
  const reader = createInteractivePlaneReader(nativeContext, stroke.plane, {
    min: { x: 0, y: 0, z: 0 },
    max: { x: nx - 1, y: ny - 1, z: nz - 1 },
  });
  const certifyEmptyPlane =
    retainMarkedComponents === true && frames.length === 1
      ? await prepareEmptyEditingPlanePruning(nativeContext, volume, seeds, stroke.plane, anchor.index, signal)
      : null;
  abort();
  const axes = SLICE_AXES[stroke.plane];
  const strides = { x: 1, y: nx, z: nx * ny };
  const nativeData = new Uint8Array(nativeContext.data.length);
  const seen = new Uint8Array(reader.frameCount);
  const editingOffset = patientToVolumeVoxel(volume, nativeContext.originMm);
  const editingSteps = [0, 1, 2].map((axis) => {
    const point: [number, number, number] = [0, 0, 0];
    point[axis] = 1;
    return patientToVolumeVoxel(volume, volumeVoxelToPatient(nativeContext, point)).map(
      (value, index) => value - editingOffset[index]!,
    );
  });
  const axisIndex = { x: 0, y: 1, z: 2 };
  const columnStep = editingSteps[axisIndex[axes.column]]!,
    rowStep = editingSteps[axisIndex[axes.row]]!,
    frameStep = editingSteps[axisIndex[axes.slice]]!;
  let receivedFrames = 0;
  let boundaryCount = 0;
  let clippedNativeVoxels = 0;
  let forward = anchor.index - 1,
    reverse = anchor.index + 1,
    reversing = false,
    pruned = false;
  const barriers: { forward?: number; reverse?: number } = {};
  const worker = new InteractiveTrackingWorker();
  try {
    const result = await worker.run({
      width: reader.width,
      height: reader.height,
      frameCount: reader.frameCount,
      sourceRange,
      provider,
      anchorIndex: anchor.index,
      points: anchor.points,
      labels: anchor.labels,
      markedFrames: frames.filter((frame) => frame !== anchor),
      ...(certifyEmptyPlane ? { allowDirectionStop: true as const } : {}),
      signal,
      readFrame: reader.readFrame,
      async onFrame({ index, direction, initial, nativeLogits }) {
        abort();
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= reader.frameCount ||
          nativeLogits.length !== reader.width * reader.height ||
          !nativeLogits.every(Number.isFinite) ||
          (direction !== 1 && direction !== -1) ||
          initial !== (index === anchor.index) ||
          (seen[index] && (index !== anchor.index || seen[index] > 1))
        )
          throw new Error('Interactive selection returned an incomplete or repeated native plane.');
        const key = direction === 1 ? 'forward' : 'reverse';
        if (
          barriers[key] !== undefined ||
          (direction === 1
            ? reversing || index !== forward + 1
            : index !== reverse - 1 || (forward !== reader.frameCount - 1 && barriers.forward === undefined))
        )
          throw new Error('Interactive selection returned an out-of-order native plane.');
        if (direction === 1) forward = index;
        else {
          reversing = true;
          reverse = index;
        }
        // Both fresh directions return their anchor. Keep the first, without blending or voting.
        if (!seen[index])
          for (let row = 0; row < reader.height; row++)
            for (let column = 0; column < reader.width; column++) {
              const target = index * strides[axes.slice] + row * strides[axes.row] + column * strides[axes.column];
              if (nativeLogits[row * reader.width + column]! > 0 && supported(nativeContext, target)) {
                nativeData[target] = 1;
                // Count actual positive cells omitted by projection, not unused
                // context outside the editor. No per-voxel temporary arrays.
                const x = Math.round(
                  editingOffset[0] + column * columnStep[0]! + row * rowStep[0]! + index * frameStep[0]!,
                );
                const y = Math.round(
                  editingOffset[1] + column * columnStep[1]! + row * rowStep[1]! + index * frameStep[1]!,
                );
                const z = Math.round(
                  editingOffset[2] + column * columnStep[2]! + row * rowStep[2]! + index * frameStep[2]!,
                );
                if (
                  x < 0 ||
                  x >= volume.dims[0] ||
                  y < 0 ||
                  y >= volume.dims[1] ||
                  z < 0 ||
                  z >= volume.dims[2] ||
                  !supported(volume, (z * volume.dims[1] + y) * volume.dims[0] + x)
                )
                  clippedNativeVoxels++;
                if (
                  column === 0 ||
                  column === reader.width - 1 ||
                  row === 0 ||
                  row === reader.height - 1 ||
                  index === 0 ||
                  index === reader.frameCount - 1
                )
                  boundaryCount++;
              }
            }
        seen[index]!++;
        receivedFrames++;
        if (certifyEmptyPlane && (await certifyEmptyPlane(index, direction, nativeData))) {
          barriers[key] = index;
        }
        // Certified irrelevant work contributes to progress, never to observed coverage.
        const skipped =
          (barriers.forward === undefined ? 0 : reader.frameCount - 1 - barriers.forward) + (barriers.reverse ?? 0);
        onProgress((0.95 * (receivedFrames + skipped)) / (reader.frameCount + 1));
        if (barriers[key] === index) return 'stop-direction';
      },
    });
    abort();
    const endpoints = certifyEmptyPlane ? result.directionEndpoints : { forward: reader.frameCount - 1, reverse: 0 };
    if (
      !endpoints ||
      endpoints.forward !== forward ||
      endpoints.reverse !== reverse ||
      forward < anchor.index ||
      reverse > anchor.index ||
      (forward !== reader.frameCount - 1 && barriers.forward !== forward) ||
      (reverse !== 0 && barriers.reverse !== reverse) ||
      result.completedFrames !== forward - reverse + 2 ||
      receivedFrames !== result.completedFrames ||
      seen.some((count, index) => count !== (index < reverse || index > forward ? 0 : index === anchor.index ? 2 : 1))
    )
      throw new Error('Interactive selection ended before every native source plane was returned.');
    pruned = forward < reader.frameCount - 1 || reverse > 0;
  } finally {
    worker.dispose();
  }

  const transferred = await transferSelectionAnnotations(
    nativeContext,
    { data: nativeData, dims: nativeContext.dims, meta: SELECTION_LABEL_META },
    volume,
    {
      signal,
      sourceSupported: (index) => supported(nativeContext, index),
      targetSupported: (index) => supported(volume, index),
    },
  );
  abort();
  onProgress(1);
  return {
    data: transferred.data,
    ...(pruned ? {} : { boundaryCount, clippedNativeVoxels }),
    contextLimited: pruned || limitsEditingGrid(nativeContext, volume),
  };
}
