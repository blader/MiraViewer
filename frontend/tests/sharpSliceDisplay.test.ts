import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import type { SharpSliceWorkerRequest, SharpSliceWorkerResponse } from '../src/utils/sharpSliceDisplay.worker';
import type { requestSharpSliceDisplay as RequestSharpSliceDisplay } from '../src/utils/sharpSliceDisplay';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import type * as SvrUtilities from '../src/utils/svr/svrUtils';

const deps = vi.hoisted(() => ({
  revision: vi.fn(),
  manifest: vi.fn(),
  decode: vi.fn(),
  envelope: vi.fn(),
}));
vi.mock('../src/utils/localApi', () => ({ getDatasetRevision: deps.revision, getSeriesFrameManifest: deps.manifest }));
vi.mock('../src/utils/svr/longitudinalFrames', () => ({
  decodeLongitudinalReferenceFrame: deps.decode,
  selectDenseLongitudinalSourceEnvelope: deps.envelope,
}));
vi.mock('../src/utils/svr/svrUtils', async (original) => ({
  ...(await original<typeof SvrUtilities>()),
  yieldToMain: async () => {},
}));

const size = 8;

function manifest(reference = false): SeriesFrameManifest {
  const seriesUid = reference ? 'reference-series' : 'target-series';
  const studyUid = reference ? 'reference-study' : 'target-study';
  return {
    seriesUid,
    studyUid,
    patientKey: 'patient',
    frameOfReferenceUid: 'space',
    ordering: 'physical',
    geometryReliable: true,
    sliceSpacingMm: 1,
    frames: Array.from({ length: reference ? 1 : 8 }, (_, i) => ({
      sopInstanceUid: `${seriesUid}-${i}`,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: studyUid,
      instanceNumber: i,
      rows: size,
      columns: size,
      frameOfReferenceUid: 'space',
      imagePositionPatient: `0\\0\\${reference ? 3.5 : i}`,
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      physicalSlicePosition: reference ? 3.5 : i,
      sliceThickness: 1,
      spacingBetweenSlices: 1,
    })),
  };
}

function frame(): DerivedAlignmentFrame {
  return {
    imageId: 'miraderived:accepted',
    runId: 'accepted',
    registrationId: 'fixed-pose',
    seriesUid: 'target-series',
    instanceIndex: 3,
    patientKey: 'patient',
    sequenceId: 'FLAIR',
    datasetRevision: 7,
    rows: size,
    columns: size,
    pixels: Float32Array.from({ length: size * size }, (_, i) => i + 10),
    valid: Uint8Array.from({ length: size * size }, (_, i) => (i === 0 ? 0 : 1)),
    sourceImageId: 'miradb:target-series-3',
    targetStudyUid: 'target-study',
    targetSopInstanceUid: 'target-series-3',
    referenceSeriesUid: 'reference-series',
    referenceStudyUid: 'reference-study',
    referenceSopInstanceUid: 'reference-series-0',
    referenceFrameIndex: 0,
    referenceFrameOfReferenceUid: 'space',
    targetFrameOfReferenceUid: 'space',
    outputGrid: buildOutputPlaneGrid(manifest(true).frames[0]!),
    rigidTransform: [0, 0, 0, 0, 0, 0],
    rotationCenterMm: [3.5, 3.5, 3.5],
  };
}

function decoded(source: SeriesFrameManifest, index: number): SvrReconstructionSlice {
  const instance = source.frames[index]!;
  const geometry = getSliceGeometryFromInstance(instance);
  return {
    pixels: new Float32Array(instance.rows * instance.columns).fill(index),
    valid: new Uint8Array(instance.rows * instance.columns).fill(1),
    dsRows: instance.rows,
    dsCols: instance.columns,
    ippMm: geometry.ippMm,
    rowDir: geometry.rowDir,
    colDir: geometry.colDir,
    normalDir: geometry.normalDir,
    rowSpacingDsMm: geometry.rowSpacingMm,
    colSpacingDsMm: geometry.colSpacingMm,
    sliceThicknessMm: 1,
    spacingBetweenSlicesMm: 1,
    sopInstanceUid: instance.sopInstanceUid,
    frameOfReferenceUid: 'space',
  };
}

function response(request: SharpSliceWorkerRequest): SharpSliceWorkerResponse {
  return {
    type: 'image',
    image: {
      pixels: Float32Array.from(request.input.baselinePixels),
      valid: request.input.baselineValid
        ? Uint8Array.from(request.input.baselineValid)
        : new Uint8Array(size * size).fill(1),
      rows: size,
      columns: size,
      stats: {
        method: 'Bounded cubic interpolation',
        durationMs: 10,
      },
    },
  };
}

class MockWorker {
  static instances: MockWorker[] = [];
  static handle: (worker: MockWorker, request: SharpSliceWorkerRequest) => void;
  onmessage: ((event: MessageEvent<SharpSliceWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request?: SharpSliceWorkerRequest;
  terminate = vi.fn();
  postMessage = vi.fn((request: SharpSliceWorkerRequest, transfer: ArrayBuffer[]) => {
    this.request = structuredClone(request, { transfer });
    queueMicrotask(() => MockWorker.handle(this, this.request!));
  });
  constructor() {
    MockWorker.instances.push(this);
  }
  reply(data: SharpSliceWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<SharpSliceWorkerResponse>);
  }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt++) await Promise.resolve();
  expect(predicate(), 'expected asynchronous service phase').toBe(true);
}

let requestSharpSliceDisplay: typeof RequestSharpSliceDisplay;
let target: SeriesFrameManifest;
let reference: SeriesFrameManifest;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  target = manifest();
  reference = manifest(true);
  deps.revision.mockResolvedValue(7);
  deps.manifest.mockImplementation(async (uid: string) => (uid === target.seriesUid ? target : reference));
  deps.decode.mockImplementation(async (source: SeriesFrameManifest, index: number) => decoded(source, index));
  deps.envelope.mockReturnValue({ sourceIndices: [2, 3, 4, 5] });
  MockWorker.instances = [];
  MockWorker.handle = (worker, request) => worker.reply(response(request));
  vi.stubGlobal('Worker', MockWorker);
  ({ requestSharpSliceDisplay } = await import('../src/utils/sharpSliceDisplay'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bounded sharp-slice display worker lifecycle', () => {
  it('serializes display workers and transfers only private decoded or copied buffers, without fitting a model', async () => {
    const original = frame();
    const pixels = original.pixels.slice();
    const support = original.valid!.slice();
    await requestSharpSliceDisplay(original);
    await requestSharpSliceDisplay({ ...original, imageId: 'miraderived:next' });
    expect(MockWorker.instances.map((worker) => worker.request!.type)).toEqual(['render', 'render']);
    for (const worker of MockWorker.instances) {
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.onmessage).toBeNull();
      const transferred = worker.postMessage.mock.calls[0]![1];
      expect(new Set(transferred).size).toBe(transferred.length);
      expect(transferred).not.toContain(original.pixels.buffer);
      expect(transferred).not.toContain(original.valid!.buffer);
    }
    expect(original.pixels).toEqual(pixels);
    expect(original.valid).toEqual(support);
    const rendering = MockWorker.instances[0]!.request!;
    expect(rendering.type).toBe('render');
    if (rendering.type === 'render') {
      expect(rendering.input.outputGrid).toEqual(original.outputGrid);
      expect(rendering.input.targetToReference).toEqual({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
    }
  });

  it('rejects fewer than four native context images without decoding or changing the baseline', async () => {
    target.frames = target.frames.slice(0, 3);
    const original = frame();
    original.instanceIndex = 1;
    original.targetSopInstanceUid = 'target-series-1';
    original.sourceImageId = 'miradb:target-series-1';
    await expect(requestSharpSliceDisplay(original)).rejects.toThrow('at least four');
    expect(deps.decode).not.toHaveBeenCalled();
  });

  it('cancels queued and active owners and admits the next request without concurrent workers', async () => {
    MockWorker.handle = () => {};
    const firstAbort = new AbortController();
    const first = requestSharpSliceDisplay(frame(), { signal: firstAbort.signal });
    const firstRejected = expect(first).rejects.toThrow(/cancelled/i);
    await until(() => MockWorker.instances.length === 1);
    const queuedAbort = new AbortController();
    const queued = requestSharpSliceDisplay(frame(), { signal: queuedAbort.signal });
    const queuedRejected = expect(queued).rejects.toThrow(/cancelled/i);
    queuedAbort.abort();
    await queuedRejected;
    expect(MockWorker.instances).toHaveLength(1);
    const next = requestSharpSliceDisplay(frame());
    MockWorker.handle = (worker, request) => {
      expect(MockWorker.instances.slice(0, -1).every((previous) => previous.terminate.mock.calls.length === 1)).toBe(
        true,
      );
      worker.reply(response(request));
    };
    firstAbort.abort();
    await firstRejected;
    await next;
    expect(MockWorker.instances).toHaveLength(2);
    expect(MockWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('aborts a stalled revision read and releases the queue', async () => {
    deps.revision.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = requestSharpSliceDisplay(frame(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(/cancelled/i);
    await until(() => deps.revision.mock.calls.length === 1);
    controller.abort();
    await rejected;
    await requestSharpSliceDisplay(frame());
    expect(MockWorker.instances).toHaveLength(1);
  });

  it('does not start another native decode while an abandoned uncancellable source load is still running', async () => {
    let resolveLoad!: (value: SvrReconstructionSlice) => void;
    deps.decode.mockImplementationOnce(
      () =>
        new Promise<SvrReconstructionSlice>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = requestSharpSliceDisplay(frame(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(/cancelled/i);
    await until(() => deps.decode.mock.calls.length === 1);
    controller.abort();
    await rejected;
    const next = requestSharpSliceDisplay(frame());
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(deps.decode).toHaveBeenCalledTimes(1);
    resolveLoad(decoded(target, 0));
    await next;
    expect(MockWorker.instances).toHaveLength(1);
  });

  it.each(['error', 'messageerror', 'malformed', 'transfer'] as const)(
    'terminates and releases on %s failure',
    async (failure) => {
      MockWorker.handle = (worker) => {
        if (failure === 'error') worker.onerror?.({ message: 'worker failed' } as ErrorEvent);
        if (failure === 'messageerror') worker.onmessageerror?.();
        if (failure === 'malformed') worker.reply({ type: 'nonsense' } as unknown as SharpSliceWorkerResponse);
      };
      if (failure === 'transfer') {
        // A clone failure exercises postMessage's synchronous cleanup path.
        const clone = globalThis.structuredClone;
        vi.stubGlobal('structuredClone', () => {
          throw new Error('transfer failed');
        });
        await expect(requestSharpSliceDisplay(frame())).rejects.toThrow('transfer failed');
        vi.stubGlobal('structuredClone', clone);
      } else await expect(requestSharpSliceDisplay(frame())).rejects.toThrow();
      expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
      MockWorker.handle = (worker, request) => worker.reply(response(request));
      await expect(requestSharpSliceDisplay(frame())).resolves.toMatchObject({ rows: size });
    },
  );

  it('times out a hung worker without leaking the permit or handlers', async () => {
    vi.useFakeTimers();
    MockWorker.handle = () => {};
    const pending = requestSharpSliceDisplay(frame());
    const rejected = expect(pending).rejects.toThrow('one-minute limit');
    await until(() => MockWorker.instances.length === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances[0]!.onmessage).toBeNull();
  });

  it.each(['patient', 'source', 'reference', 'revision'] as const)(
    'rejects stale or mismatched %s identity before decoding',
    async (change) => {
      const original = frame();
      if (change === 'patient') target.patientKey = 'other-patient';
      if (change === 'source') original.sourceImageId = 'miradb:unrelated';
      if (change === 'reference') original.referenceSopInstanceUid = 'unrelated';
      if (change === 'revision') deps.revision.mockResolvedValue(8);
      await expect(requestSharpSliceDisplay(original)).rejects.toThrow();
      expect(deps.decode).not.toHaveBeenCalled();
      expect(MockWorker.instances).toHaveLength(0);
    },
  );

  it('rejects dataset changes during reconstruction', async () => {
    MockWorker.handle = (worker, request) => {
      if (request.type === 'render') deps.revision.mockResolvedValue(8);
      worker.reply(response(request));
    };
    await expect(requestSharpSliceDisplay(frame())).rejects.toThrow('MRI data changed');
    expect(MockWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it.each(['nonfinite', 'support', 'shape'] as const)(
    'rejects malformed synthesized %s without modifying the original',
    async (change) => {
      const original = frame();
      const before = original.pixels.slice();
      MockWorker.handle = (worker, request) => {
        const result = response(request);
        if (result.type === 'image') {
          if (change === 'nonfinite') result.image.pixels[10] = NaN;
          if (change === 'support') result.image.valid[0] = 1;
          if (change === 'shape') result.image.rows = 9;
        }
        worker.reply(result);
      };
      await expect(requestSharpSliceDisplay(original)).rejects.toThrow();
      expect(original.pixels).toEqual(before);
    },
  );

  it('rejects a larger later native frame before decoding instead of silently reducing its detail', async () => {
    target.frames[4]!.rows = target.frames[4]!.columns = 16;
    await expect(requestSharpSliceDisplay(frame())).rejects.toThrow('native dimensions');
    expect(deps.decode).not.toHaveBeenCalled();
  });

  it('rejects over-budget native context before decoding or launching a worker', async () => {
    target.frames.forEach((source) => {
      source.rows = source.columns = 2048;
    });
    await expect(requestSharpSliceDisplay(frame())).rejects.toThrow('memory budget');
    expect(deps.decode).not.toHaveBeenCalled();
    expect(MockWorker.instances).toHaveLength(0);
  });
});
