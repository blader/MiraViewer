import { scoreFinalAffineInWorker } from '../../src/utils/alignmentScoringRunner';
import { selectFinalAffineProposal } from '../../src/utils/structuralAffineSelection';
import { runLongitudinalEstimate, runLongitudinalRegistration } from '../../src/utils/svr/runLongitudinalRegistration';
import { buildOutputPlaneGrid } from '../../src/utils/outputPlaneGrid';
import { makeStack } from '../helpers/longitudinalSynthetic';

export async function measureCoarseRegistration(output: 'image' | 'estimate') {
  const referenceSlices = makeStack({ frameUid: 'synthetic-reference' });
  const targetSlices = makeStack({ frameUid: 'synthetic-target', angleDeg: 18, offset: { x: 30, y: -20, z: 10 } });
  const reference = referenceSlices[9]!;
  const outputGrid = buildOutputPlaneGrid(
    {
      rows: reference.dsRows,
      columns: reference.dsCols,
      imagePositionPatient: `${reference.ippMm.x}\\${reference.ippMm.y}\\${reference.ippMm.z}`,
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
    },
    { mode: 'fixed-512' },
  );
  const input = {
    referenceSlices,
    targetSlices,
    referenceSliceIndex: 9,
    maxDimension: 32,
    maxSamples: 4000,
    outputGrid,
    deferPresentationValidation: true,
  };
  const started = performance.now();
  const result = await (output === 'image' ? runLongitudinalRegistration(input) : runLongitudinalEstimate(input));
  const elapsedMs = performance.now() - started;
  if (!result.ok) throw new Error(result.message);
  const imageFields = new Set([
    'pixels',
    'valid',
    'rows',
    'cols',
    'coverage',
    'outputGrid',
    'contributingSourceSopInstanceUids',
  ]);
  const evidence = Object.fromEntries(Object.entries(result).filter(([key]) => !imageFields.has(key)));
  const outputBytes =
    'pixels' in result
      ? (result.pixels as Float32Array).byteLength + ('valid' in result ? (result.valid as Uint8Array).byteLength : 0)
      : 0;
  return { output, elapsedMs, outputBytes, evidence };
}

function input(size: number): Parameters<typeof selectFinalAffineProposal>[0] {
  const texture = (x: number, y: number) =>
    0.5 +
    0.14 * Math.sin(x / 8) +
    0.12 * Math.cos(y / 6) +
    0.1 * Math.sin((x + y) / 4) +
    0.06 * Math.cos((x - 3 * y) / 11);
  return {
    size,
    scales: [size, size / 2, size / 4],
    normalizedReference: Float32Array.from({ length: size * size }, (_, i) => texture(i % size, Math.floor(i / size))),
    movingPixels: Float32Array.from({ length: size * size }, (_, i) =>
      texture((i % size) - 2, Math.floor(i / size) - 1),
    ),
    referenceValidity: new Float32Array(size * size).fill(1),
    movingValidity: new Float32Array(size * size).fill(1),
    winningWarp: { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, translateX: 0, translateY: 0 },
    optimizerProposals: [
      {
        kind: 'structure-elastix',
        residualMovingToFixed: { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, b: { x: -2, y: -1 } },
      },
    ],
  };
}

export async function measureFinalScoring(mode: 'inline' | 'worker') {
  const source = input(256);
  let framesWhileScoring = 0;
  let finished = false;
  let lastTick = performance.now();
  let largestTimerGapMs = 0;
  let workerStartedAt: number | undefined;
  const interval = setInterval(() => {
    const now = performance.now();
    largestTimerGapMs = Math.max(largestTimerGapMs, now - lastTick);
    lastTick = now;
  }, 4);
  let frameId = requestAnimationFrame(function tick() {
    if (!finished) framesWhileScoring++;
    frameId = requestAnimationFrame(tick);
  });
  const startedAt = performance.now();
  performance.mark(`probe-final-${mode}:start`);
  try {
    const selection =
      mode === 'inline'
        ? selectFinalAffineProposal(source)
        : await scoreFinalAffineInWorker(source, new AbortController().signal, () => {
            workerStartedAt = performance.now();
          });
    const elapsedMs = performance.now() - startedAt;
    performance.measure(`probe-final-${mode}`, `probe-final-${mode}:start`);
    finished = true;
    // Let the already scheduled heartbeat observe the synchronous task's delay.
    await new Promise((resolve) => setTimeout(resolve, 8));
    return {
      mode,
      size: source.size,
      elapsedMs,
      framesWhileScoring,
      largestTimerGapMs,
      workerStartupMs: workerStartedAt === undefined ? undefined : workerStartedAt - startedAt,
      ownedInputBytes:
        source.normalizedReference.byteLength +
        source.movingPixels.byteLength +
        source.referenceValidity!.byteLength +
        source.movingValidity!.byteLength,
      selection,
    };
  } finally {
    clearInterval(interval);
    cancelAnimationFrame(frameId);
  }
}

export async function cancelFinalScoring() {
  const source = input(512);
  const controller = new AbortController();
  let started = false;
  let cancelAt = 0;
  let published = false;
  let rejection = '';
  try {
    await scoreFinalAffineInWorker(source, controller.signal, () => {
      started = true;
      cancelAt = performance.now();
      controller.abort();
    });
    published = true;
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }
  return {
    started,
    published,
    rejection,
    cancelToReturnMs: performance.now() - cancelAt,
    ownedInputBytes:
      source.normalizedReference.byteLength +
      source.movingPixels.byteLength +
      source.referenceValidity!.byteLength +
      source.movingValidity!.byteLength,
  };
}
