import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentResult } from '../src/types/api';
import type { DerivedAlignmentFrameRow } from '../src/db/schema';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';

const storage = vi.hoisted(() => ({
  load: vi.fn<(patientKey: string, datasetRevision?: number) => Promise<DerivedAlignmentFrameRow[]>>(),
  save: vi.fn<(row: DerivedAlignmentFrameRow) => Promise<void>>(),
}));

vi.mock('../src/utils/localApi', () => ({
  loadDerivedAlignmentFrames: storage.load,
  MAX_DERIVED_ALIGNMENT_FRAMES: 32,
  saveDerivedAlignmentFrame: storage.save,
}));

import {
  clearDerivedAlignmentFrame,
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrame,
  getDerivedAlignmentFrameByImageId,
  hydrateDerivedAlignmentFrames,
  persistDerivedAlignmentFrame,
  retainDerivedAlignmentReference,
  setDerivedAlignmentFrame,
  subscribeToDerivedAlignmentFrames,
} from '../src/utils/derivedAlignmentFrame';

function result(outcome: AlignmentResult['outcome'] = 'aligned'): AlignmentResult {
  const outputGrid = buildOutputPlaneGrid({
    sopInstanceUid: 'reference-frame',
    frameOfReferenceUid: 'reference-frame-space',
    rows: 2,
    columns: 2,
    imagePositionPatient: '0\\0\\0',
    imageOrientationPatient: '1\\0\\0\\0\\1\\0',
    pixelSpacing: '0.4\\0.8',
  });
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
    outputGrid,
    outcome,
    derivedFrame: {
      pixels: new Float32Array([1, 2, 3, 4]),
      valid: new Uint8Array([1, 0, 1, 1]),
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
      outputGrid,
      contributingSourceSopInstanceUids: ['native-frame'],
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

  it('delivers a frame update once when a synchronous viewer re-subscribes during notification', () => {
    let unsubscribe = () => undefined;
    const listener = vi.fn(() => {
      if (listener.mock.calls.length >= 5) return;
      unsubscribe();
      unsubscribe = subscribeToDerivedAlignmentFrames(listener);
    });
    unsubscribe = subscribeToDerivedAlignmentFrames(listener);

    try {
      setDerivedAlignmentFrame(result());
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('preserves patient, sequence, and dataset ownership alongside a displayed derived plane', async () => {
    setDerivedAlignmentFrame(result());

    expect(getDerivedAlignmentFrame('target-series', 12)).toMatchObject({
      patientKey: 'verified-patient',
      sequenceId: 'verified-sequence',
      datasetRevision: 7,
    });

    await persistDerivedAlignmentFrame(result());
    const saved = storage.save.mock.calls[0]![0] as DerivedAlignmentFrameRow;
    clearDerivedAlignmentFrames();
    storage.load.mockResolvedValue([saved]);
    await hydrateDerivedAlignmentFrames('verified-patient', 7, 'verified-sequence', new Set(['target-series']));

    expect(getDerivedAlignmentFrame('target-series', 12)).toMatchObject({
      patientKey: 'verified-patient',
      sequenceId: 'verified-sequence',
      datasetRevision: 7,
    });
  });

  it('clears only one replaced target series while preserving the selected reference and other examinations', () => {
    const selected = result();
    selected.seriesUid = 'selected-reference';
    selected.bestSliceIndex = 3;
    setDerivedAlignmentFrame(selected);

    const firstTarget = result();
    firstTarget.bestSliceIndex = 11;
    setDerivedAlignmentFrame(firstTarget);
    setDerivedAlignmentFrame(result());

    const listener = vi.fn();
    const unsubscribe = subscribeToDerivedAlignmentFrames(listener);
    clearDerivedAlignmentFrame('target-series');

    expect(getDerivedAlignmentFrame('target-series', 11)).toBeNull();
    expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
    expect(getDerivedAlignmentFrame('selected-reference', 3)).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('atomically replaces a stale target slice without exposing an intermediate native-image flash', () => {
    const first = result();
    first.bestSliceIndex = 11;
    setDerivedAlignmentFrame(first);
    const observed: Array<{ previous: boolean; current: boolean }> = [];
    const unsubscribe = subscribeToDerivedAlignmentFrames(() => {
      observed.push({
        previous: getDerivedAlignmentFrame('target-series', 11) !== null,
        current: getDerivedAlignmentFrame('target-series', 12) !== null,
      });
    });

    setDerivedAlignmentFrame(result());

    expect(getDerivedAlignmentFrame('target-series', 11)).toBeNull();
    expect(getDerivedAlignmentFrame('target-series', 12)).not.toBeNull();
    expect(observed).toEqual([{ previous: false, current: true }]);
    unsubscribe();
  });

  it('can invalidate exactly one target slice without clearing an unrelated examination', () => {
    const other = result();
    other.seriesUid = 'other-examination';
    setDerivedAlignmentFrame(other);
    setDerivedAlignmentFrame(result());

    clearDerivedAlignmentFrame('target-series', 12);

    expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
    expect(getDerivedAlignmentFrame('other-examination', 12)).not.toBeNull();
  });

  it('never evicts an active selected reference when newly registered targets exceed the bounded cache', () => {
    const selected = result();
    selected.seriesUid = 'selected-reference';
    selected.bestSliceIndex = 3;
    setDerivedAlignmentFrame(selected);
    const frame = getDerivedAlignmentFrame('selected-reference', 3)!;
    const release = retainDerivedAlignmentReference(frame);

    for (let index = 0; index < 40; index++) {
      const target = result();
      target.seriesUid = `replacement-${index}`;
      setDerivedAlignmentFrame(target);
    }

    expect(getDerivedAlignmentFrame('selected-reference', 3)).toBe(frame);
    expect(getDerivedAlignmentFrame('replacement-39', 12)).not.toBeNull();
    expect(getDerivedAlignmentFrame('replacement-0', 12)).toBeNull();
    release();

    const replacement = result();
    replacement.seriesUid = 'replacement-after-release';
    setDerivedAlignmentFrame(replacement);
    expect(getDerivedAlignmentFrame('selected-reference', 3)).toBeNull();
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
        outputGrid: expect.objectContaining({ rowSpacingMm: 0.4, columnSpacingMm: 0.8 }),
        contributingSourceSopInstanceUids: ['native-frame'],
      }),
    );
    expect(Array.from(storage.save.mock.calls[0]![0].valid!)).toEqual([1, 0, 1, 1]);
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
      outputGrid: expect.objectContaining({ rowSpacingMm: 0.4, columnSpacingMm: 0.8 }),
      contributingSourceSopInstanceUids: ['native-frame'],
    });
    expect(Array.from(getDerivedAlignmentFrame('target-series', 12)!.valid!)).toEqual([1, 0, 1, 1]);
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
