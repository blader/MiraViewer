import type { AlignmentReference, AlignmentResult } from '../types/api';
import type { DerivedAlignmentFrameRow } from '../db/schema';
import { loadDerivedAlignmentFrames, MAX_DERIVED_ALIGNMENT_FRAMES, saveDerivedAlignmentFrame } from './localApi';
import { outputGridFingerprint, type OutputGridMode } from './outputPlaneGrid';

export type DerivedAlignmentReference = Pick<
  AlignmentReference,
  'seriesUid' | 'sliceIndex' | 'patientKey' | 'sequenceId' | 'datasetRevision'
> & { outputMode?: OutputGridMode; manualSliceOffset?: number };

export type DerivedAlignmentFrame = NonNullable<AlignmentResult['derivedFrame']> & {
  imageId: string;
  runId: string;
  seriesUid: string;
  instanceIndex: number;
  patientKey?: string;
  sequenceId?: string;
  datasetRevision?: number;
  registrationId?: string;
  /** Signed target-acquisition sampling correction; absent values mean zero. */
  manualSliceOffset?: number;
  /** The accepted packet shares these pixel buffers; replay never copies or re-registers anatomy. */
  acceptedResult?: AlignmentResult;
};

const MAX_DERIVED_ALIGNMENT_BYTES = 64 * 1024 * 1024;
const frames = new Map<string, DerivedAlignmentFrame>();
const listeners = new Set<() => void>();
let hydrationGeneration = 0;
let retainedReference: { frame: DerivedAlignmentFrame; token: symbol } | null = null;

function hasAutomaticIdentity(frame: DerivedAlignmentFrame): boolean {
  return Boolean(
    frame.registrationId?.trim() &&
    frame.patientKey &&
    frame.sequenceId &&
    Number.isSafeInteger(frame.datasetRevision) &&
    frame.datasetRevision! >= 0 &&
    frame.referenceSeriesUid &&
    ((Number.isSafeInteger(frame.referenceFrameIndex) && frame.referenceFrameIndex! >= 0) ||
      (frame.referenceSopInstanceUid && frame.outputGrid)),
  );
}

function key(frame: DerivedAlignmentFrame): string {
  return hasAutomaticIdentity(frame)
    ? JSON.stringify([
        frame.seriesUid,
        frame.registrationId,
        frame.patientKey,
        frame.sequenceId,
        frame.datasetRevision,
        frame.referenceSeriesUid,
        frame.referenceFrameIndex ?? null,
        frame.referenceSopInstanceUid ?? null,
        frame.outputGrid ? outputGridFingerprint(frame.outputGrid) : null,
        frame.manualSliceOffset ?? 0,
      ])
    : `${frame.seriesUid}:${frame.instanceIndex}`;
}

function sharesRegistration(first: DerivedAlignmentFrame, second: DerivedAlignmentFrame): boolean {
  return (
    hasAutomaticIdentity(first) &&
    hasAutomaticIdentity(second) &&
    first.registrationId === second.registrationId &&
    first.patientKey === second.patientKey &&
    first.sequenceId === second.sequenceId &&
    first.datasetRevision === second.datasetRevision &&
    first.referenceSeriesUid === second.referenceSeriesUid
  );
}

/** Raw alignment buffers remain resident independently of Cornerstone's decoded-image cache. */
export function retainedDerivedAlignmentBytes(): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const frame of frames.values()) {
    buffers.add(frame.pixels.buffer);
    if (frame.valid) buffers.add(frame.valid.buffer);
  }
  if (retainedReference) {
    buffers.add(retainedReference.frame.pixels.buffer);
    if (retainedReference.frame.valid) buffers.add(retainedReference.frame.valid.buffer);
  }
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) listener();
  }
}

/** Only results that passed live patient/sequence/revision validation may enter this display cache. */
export function setDerivedAlignmentFrame(result: AlignmentResult): void {
  if (
    !result.derivedFrame ||
    !result.runId ||
    result.outcome !== 'aligned' ||
    !Number.isFinite(result.manualSliceOffset ?? 0)
  ) {
    return;
  }
  const frame: DerivedAlignmentFrame = {
    ...result.derivedFrame,
    runId: result.runId,
    seriesUid: result.seriesUid,
    instanceIndex: result.bestSliceIndex,
    patientKey: result.patientKey,
    sequenceId: result.sequenceId,
    datasetRevision: result.datasetRevision,
    referenceSeriesUid: result.derivedFrame.referenceSeriesUid ?? result.referenceSeriesUid,
    registrationId: result.registrationId,
    manualSliceOffset: result.manualSliceOffset ?? 0,
    acceptedResult: result,
    imageId: `miraderived:${result.runId}:${result.seriesUid}:${result.bestSliceIndex}`,
  };
  if (hasAutomaticIdentity(frame)) frame.imageId = `miraderived:${encodeURIComponent(key(frame))}`;
  hydrationGeneration++;
  storeFrame(frame);
}

function storeFrame(frame: DerivedAlignmentFrame): void {
  for (const [frameKey, existing] of frames) {
    if (existing.seriesUid === frame.seriesUid && !sharesRegistration(existing, frame)) frames.delete(frameKey);
  }
  const frameKey = key(frame);
  frames.delete(frameKey);
  frames.set(frameKey, frame);
  while (frames.size > MAX_DERIVED_ALIGNMENT_FRAMES || retainedDerivedAlignmentBytes() > MAX_DERIVED_ALIGNMENT_BYTES) {
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
      displayTone: row.displayTone,
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
  let latest: DerivedAlignmentFrame | null = null;
  for (const frame of frames.values()) {
    if (frame.seriesUid === seriesUid && frame.instanceIndex === instanceIndex) latest = frame;
  }
  return latest;
}

/** Resolve a verified automatic plane, optionally holding the latest compatible plane while reslicing. */
export function getDerivedAlignmentFrameForReference(
  seriesUid: string,
  reference: DerivedAlignmentReference,
  allowPrevious = false,
): DerivedAlignmentFrame | null {
  if (
    !reference.patientKey ||
    !reference.sequenceId ||
    !Number.isSafeInteger(reference.datasetRevision) ||
    reference.datasetRevision! < 0 ||
    !Number.isSafeInteger(reference.sliceIndex) ||
    reference.sliceIndex < 0 ||
    !Number.isFinite(reference.manualSliceOffset ?? 0)
  ) {
    return null;
  }
  let exact: DerivedAlignmentFrame | null = null;
  let latest: DerivedAlignmentFrame | null = null;
  for (const frame of frames.values()) {
    if (
      !hasAutomaticIdentity(frame) ||
      frame.seriesUid !== seriesUid ||
      frame.patientKey !== reference.patientKey ||
      frame.sequenceId !== reference.sequenceId ||
      frame.datasetRevision !== reference.datasetRevision ||
      frame.referenceSeriesUid !== reference.seriesUid ||
      frame.outputGrid?.mode !== (reference.outputMode ?? 'native')
    ) {
      continue;
    }
    latest = frame;
    if (
      frame.referenceFrameIndex === reference.sliceIndex &&
      (frame.manualSliceOffset ?? 0) === (reference.manualSliceOffset ?? 0)
    ) {
      exact = frame;
    }
  }
  return exact ?? (allowPrevious ? latest : null);
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
  for (const [frameKey, frame] of frames) {
    if (frame.seriesUid !== seriesUid || (instanceIndex !== undefined && frame.instanceIndex !== instanceIndex))
      continue;
    frames.delete(frameKey);
    changed = true;
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
