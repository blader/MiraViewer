import type { AlignmentResult } from '../types/api';
import type { DerivedAlignmentFrameRow } from '../db/schema';
import { loadDerivedAlignmentFrames, MAX_DERIVED_ALIGNMENT_FRAMES, saveDerivedAlignmentFrame } from './localApi';

export type DerivedAlignmentFrame = NonNullable<AlignmentResult['derivedFrame']> & {
  imageId: string;
  runId: string;
  seriesUid: string;
  instanceIndex: number;
  patientKey?: string;
  sequenceId?: string;
  datasetRevision?: number;
};

const frames = new Map<string, DerivedAlignmentFrame>();
const listeners = new Set<() => void>();
let hydrationGeneration = 0;
let retainedReference: { frame: DerivedAlignmentFrame; token: symbol } | null = null;

function key(seriesUid: string, instanceIndex: number): string {
  return `${seriesUid}:${instanceIndex}`;
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) listener();
  }
}

/** Only results that passed live patient/sequence/revision validation may enter this display cache. */
export function setDerivedAlignmentFrame(result: AlignmentResult): void {
  if (!result.derivedFrame || !result.runId || result.outcome !== 'aligned') return;
  const frame: DerivedAlignmentFrame = {
    ...result.derivedFrame,
    runId: result.runId,
    seriesUid: result.seriesUid,
    instanceIndex: result.bestSliceIndex,
    patientKey: result.patientKey,
    sequenceId: result.sequenceId,
    datasetRevision: result.datasetRevision,
    imageId: `miraderived:${result.runId}:${result.seriesUid}:${result.bestSliceIndex}`,
  };
  hydrationGeneration++;
  storeFrame(frame);
}

function storeFrame(frame: DerivedAlignmentFrame): void {
  for (const [frameKey, existing] of frames) {
    if (existing.seriesUid === frame.seriesUid) frames.delete(frameKey);
  }
  frames.set(key(frame.seriesUid, frame.instanceIndex), frame);
  while (frames.size > MAX_DERIVED_ALIGNMENT_FRAMES) {
    const oldest = Array.from(frames.entries()).find(([, candidate]) => candidate !== retainedReference?.frame)?.[0];
    if (oldest === undefined) break;
    frames.delete(oldest);
  }
  notify();
}

/** Keep the actively selected reference visible even when a new result reaches the bounded cache limit. */
export function retainDerivedAlignmentReference(frame: DerivedAlignmentFrame): () => void {
  const token = Symbol('alignment-reference');
  retainedReference = { frame, token };
  return () => {
    if (retainedReference?.token === token) retainedReference = null;
  };
}

/** Persist the same already-validated image shown to the user, never an unverified worker result. */
export async function persistDerivedAlignmentFrame(result: AlignmentResult): Promise<void> {
  const derived = result.derivedFrame;
  if (!derived || result.outcome !== 'aligned') return;
  if (!result.patientKey || !result.sequenceId || result.datasetRevision === undefined || !derived.targetStudyUid) {
    throw new Error(
      'The aligned plane cannot be saved without its verified patient, examination, sequence, and dataset identity',
    );
  }

  const { rigidTransform, rotationCenterMm, ...metadata } = derived;
  const row: DerivedAlignmentFrameRow = {
    ...metadata,
    id: `${result.patientKey}::${result.sequenceId}::${result.seriesUid}::${result.bestSliceIndex}`,
    patientKey: result.patientKey,
    datasetRevision: result.datasetRevision,
    sequenceId: result.sequenceId,
    targetStudyUid: derived.targetStudyUid,
    targetSeriesUid: result.seriesUid,
    targetFrameIndex: result.bestSliceIndex,
    referenceSeriesUid: derived.referenceSeriesUid ?? result.referenceSeriesUid,
    transform: rigidTransform,
    centerMm: rotationCenterMm,
    coverage: result.evidence?.coverage,
    score: result.evidence?.structuralScore,
    margin: result.evidence?.runnerUpGap,
    runId: result.runId,
    createdAt: Date.now(),
  };
  await saveDerivedAlignmentFrame(row);
}

/** Restore only frames whose owner and current physical source identities were validated by IndexedDB. */
export async function hydrateDerivedAlignmentFrames(
  patientKey: string,
  datasetRevision: number,
  sequenceId: string,
  activeSeriesUids: ReadonlySet<string>,
): Promise<void> {
  const generation = ++hydrationGeneration;
  const persisted = await loadDerivedAlignmentFrames(patientKey, datasetRevision);
  if (generation !== hydrationGeneration) return;
  for (const row of persisted) {
    if (row.sequenceId !== sequenceId || !activeSeriesUids.has(row.targetSeriesUid)) continue;
    const runId = row.runId ?? `restored-${row.id}`;
    storeFrame({
      pixels: row.pixels,
      valid: row.valid,
      rows: row.rows,
      columns: row.columns,
      sourceImageId: row.sourceImageId,
      referenceStudyUid: row.referenceStudyUid,
      referenceSeriesUid: row.referenceSeriesUid,
      referenceSopInstanceUid: row.referenceSopInstanceUid,
      referenceFrameIndex: row.referenceFrameIndex,
      referenceImagePositionPatient: row.referenceImagePositionPatient,
      referenceImageOrientationPatient: row.referenceImageOrientationPatient,
      referencePixelSpacing: row.referencePixelSpacing,
      referenceRows: row.referenceRows,
      referenceColumns: row.referenceColumns,
      targetStudyUid: row.targetStudyUid,
      targetSopInstanceUid: row.targetSopInstanceUid,
      referenceFrameOfReferenceUid: row.referenceFrameOfReferenceUid,
      targetFrameOfReferenceUid: row.targetFrameOfReferenceUid,
      rigidTransform:
        row.transform?.length === 6 ? (row.transform as [number, number, number, number, number, number]) : undefined,
      rotationCenterMm: row.centerMm,
      nativeSliceSpacingMm: row.nativeSliceSpacingMm,
      sourceFrameCount: row.sourceFrameCount,
      outputGrid: row.outputGrid,
      contributingSourceSopInstanceUids: row.contributingSourceSopInstanceUids,
      runId,
      seriesUid: row.targetSeriesUid,
      instanceIndex: row.targetFrameIndex,
      patientKey: row.patientKey,
      sequenceId: row.sequenceId,
      datasetRevision: row.datasetRevision,
      imageId: `miraderived:${runId}:${row.targetSeriesUid}:${row.targetFrameIndex}`,
    });
  }
}

export function getDerivedAlignmentFrame(seriesUid: string, instanceIndex: number): DerivedAlignmentFrame | null {
  return frames.get(key(seriesUid, instanceIndex)) ?? null;
}

export function getDerivedAlignmentFrameByImageId(imageId: string): DerivedAlignmentFrame | null {
  for (const frame of frames.values()) {
    if (frame.imageId === imageId) return frame;
  }
  return null;
}

/** Invalidate one target slice, or every old presentation for a replaced target series. */
export function clearDerivedAlignmentFrame(seriesUid: string, instanceIndex?: number): void {
  hydrationGeneration++;
  let changed = false;
  if (instanceIndex !== undefined) {
    changed = frames.delete(key(seriesUid, instanceIndex));
  } else {
    for (const [frameKey, frame] of frames) {
      if (frame.seriesUid !== seriesUid) continue;
      frames.delete(frameKey);
      changed = true;
    }
  }
  if (changed) notify();
}

export function clearDerivedAlignmentFrames(): void {
  hydrationGeneration++;
  retainedReference = null;
  if (frames.size === 0) return;
  frames.clear();
  notify();
}

export function subscribeToDerivedAlignmentFrames(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
