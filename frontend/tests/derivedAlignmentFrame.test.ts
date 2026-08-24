import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentResult } from '../src/types/api';
import type { DerivedAlignmentFrameRow } from '../src/db/schema';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

const storage = vi.hoisted(() => ({
  load: vi.fn<(patientKey: string, datasetRevision?: number) => Promise<DerivedAlignmentFrameRow[]>>(),
  save: vi.fn<(row: DerivedAlignmentFrameRow) => Promise<void>>(),
}));

vi.mock('../src/utils/localApi', () => ({
  loadDerivedAlignmentFrames: storage.load,
  saveDerivedAlignmentFrame: storage.save,
}));

import {
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrame,
  getDerivedAlignmentFrameByImageId,
  hydrateDerivedAlignmentFrames,
  persistDerivedAlignmentFrame,
  setDerivedAlignmentFrame,
  subscribeToDerivedAlignmentFrames,
} from '../src/utils/derivedAlignmentFrame';

function result(outcome: AlignmentResult['outcome'] = 'aligned'): AlignmentResult {
  return {
    date: 'study-column',
    seriesUid: 'target-series',
    bestSliceIndex: 12,
    nmiScore: 1,
    computedSettings: DEFAULT_PANEL_SETTINGS,
    slicesChecked: 1,
    runId: 'verified-run',
    patientKey: 'verified-patient',
    sequenceId: 'verified-sequence',
    datasetRevision: 7,
    referenceSeriesUid: 'reference-series',
    outcome,
    derivedFrame: {
      pixels: new Float32Array([1, 2, 3, 4]),
      rows: 2,
      columns: 2,
      sourceImageId: 'miradb:native-frame',
      targetStudyUid: 'target-study',
      targetSopInstanceUid: 'native-frame',
      referenceStudyUid: 'reference-study',
      referenceSeriesUid: 'reference-series',
      referenceSopInstanceUid: 'reference-frame',
      referenceFrameOfReferenceUid: 'reference-frame-space',
      targetFrameOfReferenceUid: 'target-frame-space',
      nativeSliceSpacingMm: 1,
      sourceFrameCount: 5,
    },
  };
}

describe('verified derived alignment frame cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.load.mockResolvedValue([]);
    storage.save.mockResolvedValue();
  });
  afterEach(() => clearDerivedAlignmentFrames());

  it('binds derived pixels to their validated source series, native index, and producing run', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToDerivedAlignmentFrames(listener);

    setDerivedAlignmentFrame(result());
    const frame = getDerivedAlignmentFrame('target-series', 12);

    expect(frame?.imageId).toBe('miraderived:verified-run:target-series:12');
    expect(getDerivedAlignmentFrameByImageId(frame!.imageId)).toBe(frame);
    expect(getDerivedAlignmentFrame('other-series', 12)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('never exposes derived pixels for ambiguous or failed results', () => {
    setDerivedAlignmentFrame(result('ambiguous'));
    expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
  });

  it('persists the complete patient, dataset, source, frame, and physical provenance', async () => {
    await persistDerivedAlignmentFrame(result());

    expect(storage.save).toHaveBeenCalledWith(
      expect.objectContaining({
        patientKey: 'verified-patient',
        datasetRevision: 7,
        sequenceId: 'verified-sequence',
        targetStudyUid: 'target-study',
        targetSeriesUid: 'target-series',
        targetSopInstanceUid: 'native-frame',
        targetFrameIndex: 12,
        referenceStudyUid: 'reference-study',
        referenceSeriesUid: 'reference-series',
        referenceSopInstanceUid: 'reference-frame',
        referenceFrameOfReferenceUid: 'reference-frame-space',
        targetFrameOfReferenceUid: 'target-frame-space',
        nativeSliceSpacingMm: 1,
        sourceFrameCount: 5,
      }),
    );
  });

  it('restores only the active verified patient revision, sequence, and visible target series', async () => {
    await persistDerivedAlignmentFrame(result());
    const saved = storage.save.mock.calls[0]![0] as DerivedAlignmentFrameRow;
    storage.load.mockResolvedValue([
      saved,
      { ...saved, id: 'wrong-sequence', sequenceId: 'unrelated-sequence', targetFrameIndex: 11 },
      { ...saved, id: 'wrong-series', targetSeriesUid: 'unrelated-series' },
    ]);

    await hydrateDerivedAlignmentFrames('verified-patient', 7, 'verified-sequence', new Set(['target-series']));

    expect(storage.load).toHaveBeenCalledWith('verified-patient', 7);
    expect(getDerivedAlignmentFrame('target-series', 12)).toMatchObject({
      imageId: 'miraderived:verified-run:target-series:12',
      nativeSliceSpacingMm: 1,
      sourceFrameCount: 5,
    });
    expect(getDerivedAlignmentFrame('target-series', 11)).toBeNull();
    expect(getDerivedAlignmentFrame('unrelated-series', 12)).toBeNull();
  });

  it('discards an in-flight hydration after the active patient or run is cleared', async () => {
    await persistDerivedAlignmentFrame(result());
    const saved = storage.save.mock.calls[0]![0] as DerivedAlignmentFrameRow;
    let finish!: (rows: DerivedAlignmentFrameRow[]) => void;
    storage.load.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = hydrateDerivedAlignmentFrames(
      'verified-patient',
      7,
      'verified-sequence',
      new Set(['target-series']),
    );

    clearDerivedAlignmentFrames();
    finish([saved]);
    await pending;

    expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
  });

  it('fails visibly instead of saving derived anatomy without verified durable ownership', async () => {
    const unsafe = result();
    unsafe.patientKey = undefined;

    await expect(persistDerivedAlignmentFrame(unsafe)).rejects.toThrow('verified patient');
    expect(storage.save).not.toHaveBeenCalled();
  });
});
