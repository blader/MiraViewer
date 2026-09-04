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
  getDerivedAlignmentFrameForReference,
  hydrateDerivedAlignmentFrames,
  persistDerivedAlignmentFrame,
  retainedDerivedAlignmentBytes,
  retainDerivedAlignmentReference,
  setDerivedAlignmentFrame,
  subscribeToDerivedAlignmentFrames,
  type DerivedAlignmentReference,
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

function automaticResult(referenceIndex: number, targetIndex = 12, size = 2): AlignmentResult {
  const base = result();
  const outputGrid = buildOutputPlaneGrid({
    sopInstanceUid: `reference-frame-${referenceIndex}`,
    frameOfReferenceUid: 'reference-frame-space',
    rows: size,
    columns: size,
    imagePositionPatient: `0\\0\\${referenceIndex}`,
    imageOrientationPatient: '1\\0\\0\\0\\1\\0',
    pixelSpacing: '0.4\\0.8',
  });
  return {
    ...base,
    registrationId: 'accepted-series-pose',
    runId: `run-${referenceIndex}`,
    bestSliceIndex: targetIndex,
    outputGrid,
    derivedFrame: {
      ...base.derivedFrame!,
      pixels: new Float32Array(size * size),
      valid: new Uint8Array(size * size).fill(1),
      rows: size,
      columns: size,
      sourceImageId: `miradb:native-frame-${targetIndex}`,
      targetSopInstanceUid: `native-frame-${targetIndex}`,
      referenceFrameIndex: referenceIndex,
      referenceSopInstanceUid: `reference-frame-${referenceIndex}`,
      outputGrid,
    },
  };
}

function reference(sliceIndex: number, overrides: Partial<DerivedAlignmentReference> = {}): DerivedAlignmentReference {
  return {
    seriesUid: 'reference-series',
    sliceIndex,
    patientKey: 'verified-patient',
    sequenceId: 'verified-sequence',
    datasetRevision: 7,
    ...overrides,
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

  it('retains automatic reference planes from the same verified registration without copying accepted pixels', () => {
    const first = automaticResult(3, 11);
    const second = automaticResult(4, 12);
    setDerivedAlignmentFrame(first);
    setDerivedAlignmentFrame(second);

    const cachedFirst = getDerivedAlignmentFrameForReference('target-series', reference(3));
    const cachedSecond = getDerivedAlignmentFrameForReference('target-series', reference(4));
    expect(cachedFirst?.acceptedResult).toBe(first);
    expect(cachedFirst?.pixels).toBe(first.derivedFrame!.pixels);
    expect(cachedFirst?.valid).toBe(first.derivedFrame!.valid);
    expect(cachedFirst?.registrationId).toBe('accepted-series-pose');
    expect(cachedSecond?.acceptedResult).toBe(second);
    expect(getDerivedAlignmentFrame('target-series', 11)).toBe(cachedFirst);
    expect(getDerivedAlignmentFrame('target-series', 12)).toBe(cachedSecond);
  });

  it('distinguishes different reference planes that map to the same nearest native target frame', () => {
    const first = automaticResult(3);
    const second = automaticResult(4);
    second.runId = first.runId;
    setDerivedAlignmentFrame(first);
    setDerivedAlignmentFrame(second);

    const cachedFirst = getDerivedAlignmentFrameForReference('target-series', reference(3));
    const cachedSecond = getDerivedAlignmentFrameForReference('target-series', reference(4));
    expect(cachedFirst).not.toBeNull();
    expect(cachedSecond).not.toBeNull();
    expect(cachedFirst?.imageId).not.toBe(cachedSecond?.imageId);
    expect(getDerivedAlignmentFrameByImageId(cachedFirst!.imageId)).toBe(cachedFirst);
    expect(getDerivedAlignmentFrameByImageId(cachedSecond!.imageId)).toBe(cachedSecond);
    expect(getDerivedAlignmentFrame('target-series', 12)).toBe(cachedSecond);

    // Reading an older exact plane is pure; it cannot change the latest stored native-index mapping.
    expect(getDerivedAlignmentFrameForReference('target-series', reference(3))).toBe(cachedFirst);
    expect(getDerivedAlignmentFrame('target-series', 12)).toBe(cachedSecond);
  });

  it('keeps the image identity stable when the same accepted plane is replayed in a new visible request', () => {
    const first = automaticResult(3);
    setDerivedAlignmentFrame(first);
    const imageId = getDerivedAlignmentFrameForReference('target-series', reference(3))!.imageId;
    const replay = { ...first, runId: 'new-visible-run', requestKey: 'new-visible-request' };

    setDerivedAlignmentFrame(replay);

    const cached = getDerivedAlignmentFrameForReference('target-series', reference(3));
    expect(cached?.imageId).toBe(imageId);
    expect(cached?.runId).toBe('new-visible-run');
    expect(cached?.acceptedResult).toBe(replay);
    expect(cached?.pixels).toBe(first.derivedFrame!.pixels);
    expect(getDerivedAlignmentFrameByImageId(imageId)).toBe(cached);
    expect(first.runId).toBe('run-3');
  });

  it('caches manual sampling corrections independently, including undo to the original plane', () => {
    const originals = [0, 1, -1].map((manualSliceOffset) => ({
      ...automaticResult(3, 12),
      manualSliceOffset,
    }));
    const imageIds = new Set<string>();
    for (const accepted of originals) {
      setDerivedAlignmentFrame(accepted);
      const cached = getDerivedAlignmentFrameForReference(
        'target-series',
        reference(3, {
          manualSliceOffset: accepted.manualSliceOffset,
        }),
      );
      expect(cached?.acceptedResult).toBe(accepted);
      expect(cached?.pixels).toBe(accepted.derivedFrame!.pixels);
      imageIds.add(cached!.imageId);
    }
    expect(imageIds.size).toBe(3);
    for (const manualSliceOffset of [1, -1, 0]) {
      const original = originals.find((candidate) => candidate.manualSliceOffset === manualSliceOffset)!;
      const cached = getDerivedAlignmentFrameForReference('target-series', reference(3, { manualSliceOffset }));
      expect(cached?.acceptedResult).toBe(original);
      expect(cached?.pixels).toBe(original.derivedFrame!.pixels);
    }
    expect(getDerivedAlignmentFrameForReference('target-series', reference(3))?.manualSliceOffset).toBe(0);
  });

  it('only holds a different correction while its exact physical plane is unavailable', () => {
    const accepted = { ...automaticResult(3), manualSliceOffset: 1 };
    setDerivedAlignmentFrame(accepted);
    const cached = getDerivedAlignmentFrameForReference('target-series', reference(3, { manualSliceOffset: 1 }));

    expect(getDerivedAlignmentFrameForReference('target-series', reference(3))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(3), true)).toBe(cached);
    expect(
      getDerivedAlignmentFrameForReference('target-series', reference(3, { manualSliceOffset: Number.NaN }), true),
    ).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not store a plane with an invalid sampling correction %s',
    (manualSliceOffset) => {
      setDerivedAlignmentFrame({ ...automaticResult(3), manualSliceOffset });
      expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
      expect(getDerivedAlignmentFrameForReference('target-series', reference(3), true)).toBeNull();
    },
  );

  it('prefers an exact reference plane and only holds the latest compatible plane when explicitly allowed', () => {
    setDerivedAlignmentFrame(automaticResult(3));
    const first = getDerivedAlignmentFrameForReference('target-series', reference(3));
    setDerivedAlignmentFrame(automaticResult(4));
    const latest = getDerivedAlignmentFrameForReference('target-series', reference(4));

    expect(getDerivedAlignmentFrameForReference('target-series', reference(3), true)).toBe(first);
    expect(getDerivedAlignmentFrameForReference('target-series', reference(5))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(5), true)).toBe(latest);
    expect(getDerivedAlignmentFrameForReference('other-series', reference(5), true)).toBeNull();
  });

  it.each([
    ['patient', { patientKey: 'another-patient' }],
    ['sequence', { sequenceId: 'another-sequence' }],
    ['revision', { datasetRevision: 8 }],
    ['reference series', { seriesUid: 'another-reference' }],
    ['output mode', { outputMode: 'fixed-512' as const }],
    ['missing patient', { patientKey: undefined }],
    ['missing sequence', { sequenceId: undefined }],
    ['missing revision', { datasetRevision: undefined }],
    ['invalid reference index', { sliceIndex: Number.NaN }],
  ])('never reuses exact or previous planes for an incompatible %s', (_name, overrides) => {
    setDerivedAlignmentFrame(automaticResult(3));
    const incompatible = reference(3, overrides);

    expect(getDerivedAlignmentFrameForReference('target-series', incompatible)).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', incompatible, true)).toBeNull();
  });

  it.each(['registrationId', 'patientKey', 'sequenceId', 'datasetRevision', 'referenceSeriesUid'] as const)(
    'invalidates previous automatic planes when %s changes, without clearing another target',
    (field) => {
      const first = automaticResult(3);
      setDerivedAlignmentFrame(first);
      const originalId = getDerivedAlignmentFrame('target-series', 12)!.imageId;
      const other = automaticResult(3);
      other.seriesUid = 'other-target';
      setDerivedAlignmentFrame(other);

      const replacement = automaticResult(3);
      if (field === 'datasetRevision') replacement.datasetRevision = 8;
      else replacement[field] = `changed-${field}`;
      if (field === 'referenceSeriesUid') replacement.derivedFrame!.referenceSeriesUid = replacement.referenceSeriesUid;
      setDerivedAlignmentFrame(replacement);

      expect(getDerivedAlignmentFrameByImageId(originalId)).toBeNull();
      expect(getDerivedAlignmentFrame('target-series', 12)?.acceptedResult).toBe(replacement);
      expect(getDerivedAlignmentFrame('target-series', 12)?.imageId).not.toBe(originalId);
      expect(getDerivedAlignmentFrame('other-target', 12)?.acceptedResult).toBe(other);
    },
  );

  it('does not retain or replay multiple planes without a nonempty verified automatic identity', () => {
    const first = automaticResult(3, 11);
    const legacy = automaticResult(4);
    legacy.registrationId = '';
    setDerivedAlignmentFrame(first);
    setDerivedAlignmentFrame(legacy);

    expect(getDerivedAlignmentFrame('target-series', 11)).toBeNull();
    expect(getDerivedAlignmentFrame('target-series', 12)?.acceptedResult).toBe(legacy);
    expect(getDerivedAlignmentFrameForReference('target-series', reference(4), true)).toBeNull();

    const unowned = automaticResult(5, 13);
    unowned.patientKey = undefined;
    setDerivedAlignmentFrame(unowned);
    expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(5), true)).toBeNull();
  });

  it('keeps output-grid modes separate even when they share a registration and reference index', () => {
    const native = automaticResult(3);
    setDerivedAlignmentFrame(native);
    const nativeFrame = getDerivedAlignmentFrameForReference('target-series', reference(3));
    const fixed = automaticResult(3, 12, 256);
    fixed.outputGrid = { ...fixed.outputGrid!, mode: 'fixed-256' };
    fixed.derivedFrame!.outputGrid = fixed.outputGrid;
    setDerivedAlignmentFrame(fixed);

    expect(getDerivedAlignmentFrameForReference('target-series', reference(3))).toBe(nativeFrame);
    expect(
      getDerivedAlignmentFrameForReference('target-series', reference(3, { outputMode: 'fixed-256' }))?.acceptedResult,
    ).toBe(fixed);
    expect(getDerivedAlignmentFrameForReference('target-series', reference(4), true)).toBe(nativeFrame);
    expect(
      getDerivedAlignmentFrameForReference('target-series', reference(4, { outputMode: 'fixed-512' }), true),
    ).toBeNull();
  });

  it('bounds multiple automatic reference planes and preserves the actively retained reference', () => {
    setDerivedAlignmentFrame(automaticResult(0));
    const retained = getDerivedAlignmentFrameForReference('target-series', reference(0))!;
    const release = retainDerivedAlignmentReference(retained);
    for (let index = 1; index <= 40; index++) setDerivedAlignmentFrame(automaticResult(index));

    expect(getDerivedAlignmentFrameForReference('target-series', reference(0))).toBe(retained);
    expect(getDerivedAlignmentFrameForReference('target-series', reference(9))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(10))).not.toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(40))).not.toBeNull();
    release();
    setDerivedAlignmentFrame(automaticResult(41));
    expect(getDerivedAlignmentFrameForReference('target-series', reference(0))).toBeNull();
  });

  it('evicts full-resolution planes above 64 MiB without evicting the actively retained reference', () => {
    // Each native 1024-square packet owns 4 MiB pixels and 1 MiB acquired support.
    setDerivedAlignmentFrame(automaticResult(0, 12, 1024));
    const retained = getDerivedAlignmentFrameForReference('target-series', reference(0))!;
    const release = retainDerivedAlignmentReference(retained);
    for (let index = 1; index < 14; index++) setDerivedAlignmentFrame(automaticResult(index, 12, 1024));

    expect(getDerivedAlignmentFrameForReference('target-series', reference(0))).toBe(retained);
    expect(getDerivedAlignmentFrameForReference('target-series', reference(1))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(2))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(3))).not.toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(13))).not.toBeNull();
    release();
  });

  it('counts shared pixel buffers once when enforcing the memory bound', () => {
    const shared = automaticResult(0, 12, 1024);
    setDerivedAlignmentFrame(shared);
    for (let index = 1; index < 20; index++) {
      const next = automaticResult(index);
      next.outputGrid = {
        ...shared.outputGrid!,
        originMm: [0, 0, index],
        referenceSopInstanceUid: next.derivedFrame!.referenceSopInstanceUid,
      };
      next.derivedFrame = {
        ...next.derivedFrame!,
        rows: shared.derivedFrame!.rows,
        columns: shared.derivedFrame!.columns,
        outputGrid: next.outputGrid,
        pixels: shared.derivedFrame!.pixels,
        valid: shared.derivedFrame!.valid,
      };
      setDerivedAlignmentFrame(next);
    }

    expect(getDerivedAlignmentFrameForReference('target-series', reference(0))?.acceptedResult).toBe(shared);
    expect(getDerivedAlignmentFrameForReference('target-series', reference(19))).not.toBeNull();
  });

  it('reports full unique backing buffers without mutating cached planes, their samples or their order', () => {
    expect(retainedDerivedAlignmentBytes()).toBe(0);
    const buffer = new ArrayBuffer(64);
    const first = automaticResult(0),
      second = automaticResult(1);
    first.derivedFrame!.pixels = new Float32Array(buffer, 16, 4);
    first.derivedFrame!.pixels.set([1, 2, 3, 4]);
    first.derivedFrame!.valid = new Uint8Array(buffer, 48, 4).fill(1);
    second.derivedFrame!.pixels = new Float32Array(buffer, 32, 4);
    second.derivedFrame!.pixels.set([5, 6, 7, 8]);
    second.derivedFrame!.valid = new Uint8Array(buffer, 60, 4).fill(1);
    const samples = new Uint8Array(buffer).slice();
    setDerivedAlignmentFrame(first);
    setDerivedAlignmentFrame(second);
    const cachedFirst = getDerivedAlignmentFrameForReference('target-series', reference(0))!;
    const cachedSecond = getDerivedAlignmentFrameForReference('target-series', reference(1))!;
    const release = retainDerivedAlignmentReference(cachedFirst);
    const listener = vi.fn();
    const unsubscribe = subscribeToDerivedAlignmentFrames(listener);
    try {
      for (let repeat = 0; repeat < 3; repeat++) expect(retainedDerivedAlignmentBytes()).toBe(64);
      expect(listener).not.toHaveBeenCalled();
      expect(new Uint8Array(buffer)).toEqual(samples);
      expect(getDerivedAlignmentFrameForReference('target-series', reference(0))).toBe(cachedFirst);
      expect(getDerivedAlignmentFrameForReference('target-series', reference(1))).toBe(cachedSecond);
      expect(getDerivedAlignmentFrame('target-series', 12)).toBe(cachedSecond);
      expect(cachedFirst.pixels).toBe(first.derivedFrame!.pixels);
      expect(cachedSecond.valid).toBe(second.derivedFrame!.valid);
      release();
      expect(retainedDerivedAlignmentBytes()).toBe(64);
    } finally {
      release();
      unsubscribe();
    }
  });

  it('counts a pinned reference after its cache entry is removed, until that reference is released', () => {
    setDerivedAlignmentFrame(automaticResult(0));
    const pinned = getDerivedAlignmentFrameForReference('target-series', reference(0))!;
    const release = retainDerivedAlignmentReference(pinned);
    const pinnedBytes = pinned.pixels.buffer.byteLength + pinned.valid!.buffer.byteLength;
    clearDerivedAlignmentFrame('target-series');
    expect(getDerivedAlignmentFrame('target-series', 12)).toBeNull();
    expect(retainedDerivedAlignmentBytes()).toBe(pinnedBytes);
    const other = { ...automaticResult(1), seriesUid: 'other-target' };
    setDerivedAlignmentFrame(other);
    const otherBytes = other.derivedFrame!.pixels.buffer.byteLength + other.derivedFrame!.valid!.buffer.byteLength;
    expect(retainedDerivedAlignmentBytes()).toBe(pinnedBytes + otherBytes);
    release();
    expect(retainedDerivedAlignmentBytes()).toBe(otherBytes);
    clearDerivedAlignmentFrame('other-target');
    expect(retainedDerivedAlignmentBytes()).toBe(0);
  });

  it('clears every reference mapping for one native index and notifies subscribers only once', () => {
    setDerivedAlignmentFrame(automaticResult(3, 12));
    setDerivedAlignmentFrame(automaticResult(4, 12));
    setDerivedAlignmentFrame(automaticResult(5, 13));
    const listener = vi.fn();
    const unsubscribe = subscribeToDerivedAlignmentFrames(listener);

    clearDerivedAlignmentFrame('target-series', 12);

    expect(getDerivedAlignmentFrameForReference('target-series', reference(3))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(4))).toBeNull();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(5))).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    clearDerivedAlignmentFrame('target-series');
    expect(getDerivedAlignmentFrameForReference('target-series', reference(5), true)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
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

    expect(storage.load).toHaveBeenCalledWith('verified-patient', 7, {
      sequenceId: 'verified-sequence',
      seriesUids: new Set(['target-series']),
    });
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

  it('restores persisted automatic presentations as legacy frames without inventing a reusable registration', async () => {
    await persistDerivedAlignmentFrame(automaticResult(3));
    const saved = storage.save.mock.calls[0]![0];
    expect(saved).not.toHaveProperty('registrationId');
    expect(saved).not.toHaveProperty('acceptedResult');
    storage.load.mockResolvedValue([saved]);

    await hydrateDerivedAlignmentFrames('verified-patient', 7, 'verified-sequence', new Set(['target-series']));

    expect(getDerivedAlignmentFrame('target-series', 12)?.referenceFrameIndex).toBe(3);
    expect(getDerivedAlignmentFrame('target-series', 12)?.registrationId).toBeUndefined();
    expect(getDerivedAlignmentFrame('target-series', 12)?.acceptedResult).toBeUndefined();
    expect(getDerivedAlignmentFrameForReference('target-series', reference(3), true)).toBeNull();
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
