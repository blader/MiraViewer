import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import dicomParser from 'dicom-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDicomAcquisitionMetadata } from '../src/services/dicomAcquisitionMetadata';
import { buildOutputPlaneGrid, outputGridPixelToWorld } from '../src/utils/outputPlaneGrid';
import { renderSharpSlicePresentation } from '../src/utils/sharpSlicePresentation';
import { synthesizeSharpSlice } from '../src/utils/sharpSliceSynthesis';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import { resliceStackToReferencePlane } from '../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import { dot } from '../src/utils/svr/vec3';
import {
  decodeAlignmentCorpusFrame,
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
  writeAlignmentComparisonSheet,
  type AlignmentCorpusFrame,
  type AlignmentCorpusPlane,
  type AlignmentCorpusSeries,
} from './helpers/alignmentRealCorpus';
import {
  compareHeldOutPixels,
  cropCorpusPixels,
  interpolateCorpusBaseline,
  interpolationOvershoot,
  pixelFingerprint,
  retainedIntensityWindow,
  samplePhysicalCorpusPlane,
  type CorpusRegion,
  type NativeCorpusPlane,
} from './helpers/interSliceCorpus';

const runCorpus = process.env.MIRAVIEWER_SHARP_SLICE_CORPUS === '1';
const fullNativePresentation = process.env.MIRAVIEWER_SHARP_SLICE_FULL_PRESENTATION === '1';
const corpusRoot = process.env.MIRAVIEWER_SHARP_SLICE_CORPUS_DIR;
const outputDirectory = resolve('tmp/inter-slice-validation/bounded-cubic');
const algorithmPath = resolve('src/utils/sharpSliceSynthesis.ts');
const presentationPath = resolve('src/utils/sharpSlicePresentation.ts');
const reslicerPath = resolve('src/utils/svr/longitudinalRegistration.ts');
// Existing anonymous axial landmarks locate a neighborhood, not a certified tumor contour.
const axialLandmarks = new Map([
  [1, 100],
  [2, 98],
  [3, 96],
  [4, 96],
  [15, 91],
  [17, 96],
  [18, 78],
]);
const examinations = [...new Set((process.env.MIRAVIEWER_SHARP_SLICE_EXAMS ?? '1').split(',').map(Number))];
const planes = [
  ...new Set((process.env.MIRAVIEWER_SHARP_SLICE_PLANES ?? 'AX,COR,SAG').split(',')),
] as AlignmentCorpusPlane[];
const levels = [...new Set((process.env.MIRAVIEWER_SHARP_SLICE_LEVELS ?? '-2,0,2').split(',').map(Number))];
const lag = Number(process.env.MIRAVIEWER_SHARP_SLICE_LAG ?? '1');
const retainedOffsets = [...new Set(levels.flatMap((level) => [-3, -1, 1, 3].map((offset) => level + offset)))].sort(
  (first, second) => first - second,
);
const cases = examinations.flatMap((examination) => planes.map((plane) => ({ examination, plane })));

type Evidence = {
  fileHash: string;
  studyDateHash: string;
  kind: string;
  invert: boolean;
  padding?: [number, number];
  referencedSources: Set<string>;
};

function readEvidence(frame: AlignmentCorpusFrame): Evidence {
  try {
    const bytes = readFileSync(frame.path);
    const dataset = dicomParser.parseDicom(new Uint8Array(bytes), { untilTag: 'x7fe00010' });
    if (
      dataset.string('x00080018')?.trim() !== frame.sopInstanceUid ||
      dataset.uint16('x00280010') !== frame.rows ||
      dataset.uint16('x00280011') !== frame.columns
    )
      throw new Error('Native source identity or dimensions changed after inspection');
    const syntax = dataset.string('x00020010');
    if (
      !['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70'].includes(
        syntax ?? '',
      )
    )
      throw new Error('Unsupported native transfer syntax');
    const metadata = extractDicomAcquisitionMetadata(dataset);
    const derived = metadata.imageType.some((value) => ['DERIVED', 'REFORMATTED', 'MPR'].includes(value));
    const original = metadata.imageType[0] === 'ORIGINAL' && metadata.imageType[1] === 'PRIMARY';
    const references = new Set([...metadata.sourceSopInstanceUids, ...metadata.derivationSopInstanceUids]);
    const paddingTag = dataset.elements.x00280120;
    let padding: [number, number] | undefined;
    if (paddingTag) {
      const signed = dataset.uint16('x00280103') === 1;
      const read = (tag: string) => (signed ? dataset.int16(tag) : dataset.uint16(tag));
      const first = read('x00280120');
      const last = dataset.elements.x00280121 ? read('x00280121') : first;
      const slope = dataset.floatString('x00281053') ?? 1;
      const intercept = dataset.floatString('x00281052') ?? 0;
      if (first !== undefined && last !== undefined) {
        const values = [first * slope + intercept, last * slope + intercept].sort((a, b) => a - b);
        padding = [values[0]!, values[1]!];
      }
    }
    return {
      fileHash: pixelFingerprint(bytes),
      studyDateHash: pixelFingerprint(Buffer.from(dataset.string('x00080020') ?? 'unknown')),
      kind:
        original && (derived || references.size)
          ? 'conflicting'
          : derived
            ? 'derived-view'
            : original
              ? `original-${metadata.mrAcquisitionType ?? 'unknown'}`
              : 'unknown',
      invert: dataset.string('x00280004') === 'MONOCHROME1',
      padding,
      referencedSources: references,
    };
  } catch {
    // Parser and filesystem errors can embed patient tags or private source paths.
    throw new Error('Could not inspect an anonymous native MRI fixture safely');
  }
}

function uniqueFrames(series: AlignmentCorpusSeries) {
  const bySop = new Map<string, AlignmentCorpusFrame>();
  for (const frame of series.frames) {
    const previous = bySop.get(frame.sopInstanceUid);
    if (
      previous &&
      (previous.imagePositionPatient !== frame.imagePositionPatient ||
        previous.imageOrientationPatient !== frame.imageOrientationPatient ||
        previous.rows !== frame.rows ||
        previous.columns !== frame.columns)
    )
      throw new Error('A repeated source identity has conflicting physical geometry');
    if (!previous) bySop.set(frame.sopInstanceUid, frame);
  }
  const frames = [...bySop.values()].sort((first, second) => first.positionMm - second.positionMm);
  for (let index = 1; index < frames.length; index++) {
    if (frames[index]!.positionMm - frames[index - 1]!.positionMm < 1e-4)
      throw new Error('Different source identities share a physical plane; adjudicate duplicates before benchmarking');
  }
  return { frames, omittedDuplicateSops: series.frames.length - frames.length };
}

function sourceNeighborhood(sources: AlignmentCorpusSeries[], examination: number, plane: AlignmentCorpusPlane) {
  const candidates = sources
    .filter((source) => source.examinationOrdinal === examination && /flair/i.test(source.contrast))
    .sort((first, second) => second.frames.length - first.frames.length);
  const axial = candidates.find((source) => source.plane === 'AX');
  const landmark = axial?.frames[axialLandmarks.get(examination)!];
  if (!axial || !landmark) throw new Error('The reviewed anonymous axial FLAIR landmark is missing');
  const source = candidates.find(
    (candidate) =>
      candidate.plane === plane &&
      candidate.patientKey === axial.patientKey &&
      candidate.frameOfReferenceUid === axial.frameOfReferenceUid,
  );
  if (!source) throw new Error('The same-examination and same-coordinate-frame FLAIR source is missing');
  const grid = buildOutputPlaneGrid(landmark);
  const point = outputGridPixelToWorld(grid, (grid.rows - 1) * 0.453, (grid.columns - 1) * 0.503);
  const { frames, omittedDuplicateSops } = uniqueFrames(source);
  const firstGeometry = getSliceGeometryFromInstance(frames[0]!);
  const depth = dot(point, firstGeometry.normalDir);
  const center = frames.reduce(
    (nearest, frame, index) =>
      Math.abs(frame.positionMm - depth) < Math.abs(frames[nearest]!.positionMm - depth) ? index : nearest,
    0,
  );
  const radius = Math.max(...retainedOffsets.map(Math.abs)) * lag;
  if (center < radius || center + radius >= frames.length)
    throw new Error('The native landmark does not have the full retained and held-out neighborhood');
  const geometry = getSliceGeometryFromInstance(frames[center]!);
  const delta = { x: point.x - geometry.ippMm.x, y: point.y - geometry.ippMm.y, z: point.z - geometry.ippMm.z };
  const width = Math.min(128, source.columns),
    height = Math.min(128, source.rows);
  const region: CorpusRegion = {
    left: Math.max(
      0,
      Math.min(source.columns - width, Math.round(dot(delta, geometry.rowDir) / geometry.colSpacingMm - width / 2)),
    ),
    top: Math.max(
      0,
      Math.min(source.rows - height, Math.round(dot(delta, geometry.colDir) / geometry.rowSpacingMm - height / 2)),
    ),
    width,
    height,
  };
  return { source, frames, center, region, geometry, omittedDuplicateSops };
}

async function decodeNative(frame: AlignmentCorpusFrame, codec: ReturnType<typeof loadAlignmentLosslessCodec>) {
  const evidence = readEvidence(frame);
  let decoded: Awaited<ReturnType<typeof decodeAlignmentCorpusFrame>>;
  try {
    decoded = await decodeAlignmentCorpusFrame(frame, codec);
  } catch {
    throw new Error('Could not decode the anonymous native MRI fixture');
  }
  const valid = Uint8Array.from(decoded.pixels, (value) =>
    Number(Number.isFinite(value) && (!evidence.padding || value < evidence.padding[0] || value > evidence.padding[1])),
  );
  const plane: NativeCorpusPlane = { positionMm: frame.positionMm, pixels: decoded.pixels, valid };
  return { plane, evidence, pixelHash: pixelFingerprint(plane.pixels), supportHash: pixelFingerprint(valid) };
}

async function validatePhysicalPresentation(
  source: AlignmentCorpusSeries,
  frames: AlignmentCorpusFrame[],
  center: number,
  region: CorpusRegion,
  decodedByIndex: Map<number, Awaited<ReturnType<typeof decodeNative>>>,
  codec: ReturnType<typeof loadAlignmentLosslessCodec>,
  window: ReturnType<typeof retainedIntensityWindow>,
) {
  const indices = [-1, 0, 1, 2].map((offset) => center + offset);
  for (const index of indices)
    if (!decodedByIndex.has(index)) decodedByIndex.set(index, await decodeNative(frames[index]!, codec));
  const slices: SvrReconstructionSlice[] = indices.map((index) => {
    const frame = frames[index]!,
      geometry = getSliceGeometryFromInstance(frame);
    const decoded = decodedByIndex.get(index)!;
    return {
      ...geometry,
      pixels: decoded.plane.pixels,
      valid: decoded.plane.valid,
      dsRows: frame.rows,
      dsCols: frame.columns,
      rowSpacingDsMm: geometry.rowSpacingMm,
      colSpacingDsMm: geometry.colSpacingMm,
      sliceThicknessMm: frame.sliceThickness ?? null,
      spacingBetweenSlicesMm: frame.spacingBetweenSlices ?? null,
      frameOfReferenceUid: source.frameOfReferenceUid,
      sopInstanceUid: frame.sopInstanceUid,
    };
  });
  const native = slices[1]!,
    gap = frames[center + 1]!.positionMm - frames[center]!.positionMm;
  const sine = (0.64 * gap) / ((region.width - 1) * native.colSpacingDsMm),
    cosine = Math.sqrt(1 - sine * sine);
  const translationMm = [2.3, -1.1, 0.7] as const;
  const direction = {
    x: native.rowDir.x * cosine + native.normalDir.x * sine,
    y: native.rowDir.y * cosine + native.normalDir.y * sine,
    z: native.rowDir.z * cosine + native.normalDir.z * sine,
  };
  const origin = (['x', 'y', 'z'] as const).map(
    (axis, coordinate) =>
      native.ippMm[axis] +
      native.rowDir[axis] * region.left * native.colSpacingDsMm +
      native.colDir[axis] * region.top * native.rowSpacingDsMm +
      native.normalDir[axis] * 0.05 * gap +
      translationMm[coordinate]!,
  );
  const outputGrid = buildOutputPlaneGrid({
    rows: region.height,
    columns: region.width,
    imagePositionPatient: origin.join('\\'),
    imageOrientationPatient: [
      direction.x,
      direction.y,
      direction.z,
      native.colDir.x,
      native.colDir.y,
      native.colDir.z,
    ].join('\\'),
    pixelSpacing: `${native.rowSpacingDsMm}\\${native.colSpacingDsMm}`,
    sopInstanceUid: 'anonymous-oblique-output',
  });
  const targetToReference = { tx: translationMm[0], ty: translationMm[1], tz: translationMm[2], rx: 0, ry: 0, rz: 0 };
  const centerMm = { x: 0, y: 0, z: 0 };
  const baselineStarted = performance.now();
  const baseline = resliceStackToReferencePlane({
    targetSlices: slices,
    referenceSlice: native,
    outputGrid,
    targetToReference,
    centerMm,
  });
  const baselineDurationMs = performance.now() - baselineStarted;
  const baselineHash = pixelFingerprint(baseline.pixels),
    supportHash = pixelFingerprint(baseline.valid);
  const geometrySnapshot = JSON.stringify({ outputGrid, targetToReference, centerMm, indices });
  const started = performance.now();
  const rendered = await renderSharpSlicePresentation({
    slices,
    referencePlane: native,
    outputGrid,
    targetToReference,
    centerMm,
    baselinePixels: baseline.pixels,
    baselineValid: baseline.valid,
  });
  const durationMs = performance.now() - started;
  const oracle = (method: 'linear' | 'bounded-cubic') =>
    samplePhysicalCorpusPlane({ slices, grid: outputGrid, translationMm, method });
  const directLinear = oracle('linear'),
    directCubic = oracle('bounded-cubic');
  const metricOptions = {
    rows: outputGrid.rows,
    columns: outputGrid.columns,
    rowSpacingMm: outputGrid.rowSpacingMm,
    columnSpacingMm: outputGrid.columnSpacingMm,
    intensityRange: window.range,
  };
  const linearOracleError = compareHeldOutPixels({
    ...metricOptions,
    prediction: baseline,
    truth: directLinear,
    baselineSupport: directLinear.valid,
  });
  const cubicOracleError = compareHeldOutPixels({
    ...metricOptions,
    prediction: rendered,
    truth: directCubic,
    baselineSupport: directCubic.valid,
  });
  const allPixelMaximumError = rendered.pixels.reduce(
    (maximum, value, index) =>
      directCubic.valid[index] ? Math.max(maximum, Math.abs(value - directCubic.pixels[index]!)) : maximum,
    0,
  );
  expect(linearOracleError.missing).toBe(0);
  expect(cubicOracleError.missing).toBe(0);
  expect(linearOracleError.maximumAbsoluteError).toBeLessThan(Math.max(0.001, window.range * 1e-6));
  expect(cubicOracleError.maximumAbsoluteError).toBeLessThan(Math.max(0.001, window.range * 1e-6));
  expect(allPixelMaximumError).toBeLessThan(Math.max(0.001, window.range * 1e-6));
  expect(rendered.valid).toEqual(directCubic.valid);
  expect(rendered.valid).toEqual(baseline.valid);
  expect(rendered.rows).toBe(region.height);
  expect(rendered.columns).toBe(region.width);
  expect(pixelFingerprint(baseline.pixels)).toBe(baselineHash);
  expect(pixelFingerprint(baseline.valid)).toBe(supportHash);
  expect(JSON.stringify({ outputGrid, targetToReference, centerMm, indices })).toBe(geometrySnapshot);
  for (const index of indices) {
    const decoded = decodedByIndex.get(index)!;
    expect(pixelFingerprint(decoded.plane.pixels)).toBe(decoded.pixelHash);
    expect(pixelFingerprint(decoded.plane.valid!)).toBe(decoded.supportHash);
    expect(pixelFingerprint(readFileSync(frames[index]!.path))).toBe(decoded.evidence.fileHash);
  }
  const name = `e${source.examinationOrdinal}-${source.plane.toLowerCase()}-${center}-oblique037${region.width === source.columns && region.height === source.rows ? '-native' : ''}`;
  const image = writeAlignmentComparisonSheet(
    outputDirectory,
    name,
    [baseline, directCubic, rendered].map((candidate, index) => ({
      label: `${index === 0 ? 'ORDER1' : index === 1 ? 'DIRECT3' : 'RENDER3'} ${source.plane} ${center}`,
      pixels: cropCorpusPixels(
        candidate.pixels,
        region.width,
        { left: 0, top: 0, width: region.width, height: region.height },
        decodedByIndex.get(center)!.evidence.invert,
      ),
      rows: region.height,
      columns: region.width,
      windowCenter: decodedByIndex.get(center)!.evidence.invert ? -window.center : window.center,
      windowWidth: window.width,
    })),
    3,
  );
  return {
    interpretation:
      'Actual presentation wrapper on native MRI; no acquired ground truth exists at this oblique fractional plane. DIRECT3 is an independent mathematical oracle, not an acquired image.',
    centerFraction: 0.37,
    fractionalDepthRange: [0.05, 0.69],
    tiltDegrees: (Math.asin(sine) * 180) / Math.PI,
    nativeRows: region.height,
    nativeColumns: region.width,
    translationMm,
    sourceIndices: indices,
    durationMs,
    baselineDurationMs,
    timingScope: 'CPU presentation from decoded native buffers; excludes DICOM decoding, worker transfer and UI.',
    linearOracleError,
    cubicOracleError,
    allPixelMaximumError,
    comparisonImage: basename(image),
    sourceAndBaselineUnchanged: true,
  };
}

describe('independent held-out slice benchmark oracles', () => {
  it('evaluates physical linear and cubic interpolation without production kernels', () => {
    const sources = [-3, -1, 1, 3].map((positionMm) => ({
      positionMm,
      pixels: Float32Array.of(3, positionMm, positionMm ** 2, positionMm ** 3),
    }));
    expect([...interpolateCorpusBaseline(sources, 0.5, 'linear').pixels]).toEqual([3, 0.5, 1, 0.5]);
    expect([...interpolateCorpusBaseline(sources, 0.5, 'cubic').pixels]).toEqual([3, 0.5, 0.25, 0.125]);
    expect(interpolateCorpusBaseline(sources, 1, 'cubic').pixels).toEqual(sources[2]!.pixels);
    expect(interpolateCorpusBaseline(sources, 1, 'cubic').pixels).not.toBe(sources[2]!.pixels);
    expect(() => interpolateCorpusBaseline(sources, 4, 'linear')).toThrow(/context/);
  });

  it('uses actual nonuniform physical centers and never includes invalid context', () => {
    const sources = [-4, -1, 2, 5].map((positionMm) => ({
      positionMm,
      pixels: Float32Array.of(positionMm ** 3),
      valid: Uint8Array.of(1),
    }));
    expect(interpolateCorpusBaseline(sources, 0.5, 'cubic').pixels[0]).toBeCloseTo(0.125, 6);
    sources[0]!.valid[0] = 0;
    expect(interpolateCorpusBaseline(sources, 0.5, 'cubic').valid![0]).toBe(0);
    expect(interpolateCorpusBaseline(sources, 0.5, 'linear').valid![0]).toBe(1);
  });

  it('penalizes invented sharpness and missing support rather than rewarding either', () => {
    const truth = {
      positionMm: 0,
      pixels: Float32Array.from({ length: 64 }, (_, index) => (index % 8) ** 2 + Math.floor(index / 8)),
      valid: new Uint8Array(64).fill(1),
    };
    const options = {
      truth,
      baselineSupport: truth.valid,
      rows: 8,
      columns: 8,
      rowSpacingMm: 2,
      columnSpacingMm: 1,
      intensityRange: 56,
    };
    expect(compareHeldOutPixels({ ...options, prediction: truth })).toMatchObject({
      rmse: 0,
      gradientRelativeRmse: 0,
      sharpnessRatio: 1,
      missing: 0,
    });
    const amplified = { ...truth, pixels: Float32Array.from(truth.pixels, (value) => value * 2) };
    expect(compareHeldOutPixels({ ...options, prediction: amplified })).toMatchObject({
      gradientRelativeRmse: 1,
      sharpnessRatio: 2,
    });
    const missing = { ...truth, valid: truth.valid.slice() };
    missing.valid[27] = 0;
    expect(compareHeldOutPixels({ ...options, prediction: missing }).missing).toBe(1);
    expect(cropCorpusPixels(truth.pixels, 8, { left: 2, top: 3, width: 2, height: 2 })).toEqual(
      Float32Array.of(7, 12, 8, 13),
    );
  });

  it('independently projects translated physical source samples at a nonquarter fraction', () => {
    const slices: SvrReconstructionSlice[] = [-1, 0, 1, 2].map((z) => ({
      pixels: Float32Array.from({ length: 16 }, (_, index) => (index % 4) + 2 * Math.floor(index / 4) + z * z),
      dsRows: 4,
      dsCols: 4,
      ippMm: { x: 0, y: 0, z },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      normalDir: { x: 0, y: 0, z: 1 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
      sliceThicknessMm: 1,
      spacingBetweenSlicesMm: 1,
    }));
    const grid = buildOutputPlaneGrid({
      rows: 2,
      columns: 2,
      imagePositionPatient: '1.25\\-1.5\\3.37',
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
    });
    const options = { slices, grid, translationMm: [1, -2, 3] as const };
    const linear = samplePhysicalCorpusPlane({ ...options, method: 'linear' });
    const cubic = samplePhysicalCorpusPlane({ ...options, method: 'bounded-cubic' });
    expect(linear.pixels[0]).toBeCloseTo(1.62, 6);
    expect(cubic.pixels[0]).toBeCloseTo(1.3869, 6);
    expect(cubic.pixels[3]).toBeCloseTo(4.3869, 6);
    expect(cubic.valid).toEqual(Uint8Array.of(1, 1, 1, 1));
    const boundaryGrid = { ...grid, originMm: [-1e-8, 0, 0.37] as [number, number, number] };
    const boundary = samplePhysicalCorpusPlane({
      slices,
      grid: boundaryGrid,
      translationMm: [0, 0, 0],
      method: 'bounded-cubic',
    });
    expect(boundary.pixels[0]).toBeCloseTo(0.1369, 6);
    expect(boundary.valid[0]).toBe(1);
    boundaryGrid.originMm[0] = -0.001;
    expect(
      samplePhysicalCorpusPlane({ slices, grid: boundaryGrid, translationMm: [0, 0, 0], method: 'bounded-cubic' })
        .valid[0],
    ).toBe(0);
  });
});

describe.skipIf(!runCorpus)('sharp inter-slice display on held-out private MRI (not clinical accuracy)', () => {
  let sources: AlignmentCorpusSeries[];
  let codec: ReturnType<typeof loadAlignmentLosslessCodec>;
  let sourceSha256: {
    algorithm: string;
    presentation: string;
    reslicer: string;
    metrics: string;
    decoding: string;
    fixture: string;
  };

  beforeAll(() => {
    if (!corpusRoot) throw new Error('Set MIRAVIEWER_SHARP_SLICE_CORPUS_DIR to the private MRI corpus');
    if (
      examinations.some((examination) => !axialLandmarks.has(examination)) ||
      planes.some((plane) => !['AX', 'COR', 'SAG'].includes(plane))
    )
      throw new Error('Choose anonymous examinations 1,2,3,4,15,17,18 and planes AX,COR,SAG');
    if (
      !Number.isSafeInteger(lag) ||
      lag < 1 ||
      lag > 5 ||
      lag % 2 !== 1 ||
      levels.some((level) => !Number.isSafeInteger(level) || Math.abs(level) > 4 || level % 2 !== 0)
    )
      throw new Error('Use an odd source lag 1,3,5 and even held-out levels between -4 and 4');
    // E18 is untouched by default. Explicit EXAMS selection is required for the reserved confirmation cohort.
    sources = inspectAlignmentCorpus(corpusRoot, { studyOrdinals: examinations, includeExtensionlessDicom: true });
    codec = loadAlignmentLosslessCodec();
    sourceSha256 = {
      algorithm: pixelFingerprint(readFileSync(algorithmPath)),
      presentation: pixelFingerprint(readFileSync(presentationPath)),
      reslicer: pixelFingerprint(readFileSync(reslicerPath)),
      metrics: pixelFingerprint(readFileSync(resolve('tests/helpers/interSliceCorpus.ts'))),
      decoding: pixelFingerprint(readFileSync(resolve('tests/helpers/alignmentRealCorpus.ts'))),
      fixture: pixelFingerprint(readFileSync(resolve('tests/interSliceReconstructionCorpus.test.ts'))),
    };
  }, 60_000);

  it.each(cases)(
    'reconstructs withheld native planes in E$examination $plane',
    async ({ examination, plane }) => {
      const started = performance.now();
      const { source, frames, center, region, geometry, omittedDuplicateSops } = sourceNeighborhood(
        sources,
        examination,
        plane,
      );
      expect(
        Math.max(source.rows, source.columns),
        'Bound native fixtures without downsampling MRI',
      ).toBeLessThanOrEqual(1024);
      const retainedIndices = retainedOffsets.map((offset) => center + offset * lag);
      const withheldIndices = levels.map((level) => center + level * lag);
      const retainedSops = new Set(retainedIndices.map((index) => frames[index]!.sopInstanceUid));
      expect(withheldIndices.every((index) => !retainedSops.has(frames[index]!.sopInstanceUid))).toBe(true);
      const retained: Awaited<ReturnType<typeof decodeNative>>[] = [];
      for (const index of retainedIndices) retained.push(await decodeNative(frames[index]!, codec));
      const decodedByIndex = new Map(retainedIndices.map((index, offset) => [index, retained[offset]!]));
      const withheldSops = new Set(withheldIndices.map((index) => frames[index]!.sopInstanceUid));
      expect(
        retained.every(({ evidence }) => [...withheldSops].every((sop) => !evidence.referencedSources.has(sop))),
        'No retained derived frame may reference a withheld source image',
      ).toBe(true);
      expect(retained.every(({ evidence }) => evidence.kind !== 'conflicting')).toBe(true);
      expect(
        new Set(retained.map(({ pixelHash }) => pixelHash)).size,
        'Repeated pixel buffers cannot count as distinct source anatomy',
      ).toBe(retained.length);
      expect(new Set(retained.map(({ evidence }) => evidence.studyDateHash)).size).toBe(1);
      const stack = { rows: source.rows, columns: source.columns, slices: retained.map(({ plane }) => plane) };
      const physicalGeometry = [...retainedIndices, ...withheldIndices].map((index) =>
        getSliceGeometryFromInstance(frames[index]!),
      );
      for (const current of physicalGeometry) {
        expect(current.rows === source.rows && current.cols === source.columns).toBe(true);
        expect(current.rowSpacingMm).toBeCloseTo(geometry.rowSpacingMm, 6);
        expect(current.colSpacingMm).toBeCloseTo(geometry.colSpacingMm, 6);
        expect(dot(current.rowDir, geometry.rowDir)).toBeGreaterThan(0.999999);
        expect(dot(current.colDir, geometry.colDir)).toBeGreaterThan(0.999999);
        const delta = {
          x: current.ippMm.x - geometry.ippMm.x,
          y: current.ippMm.y - geometry.ippMm.y,
          z: current.ippMm.z - geometry.ippMm.z,
        };
        expect(Math.abs(dot(delta, geometry.rowDir))).toBeLessThan(geometry.colSpacingMm * 0.05);
        expect(Math.abs(dot(delta, geometry.colDir))).toBeLessThan(geometry.rowSpacingMm * 0.05);
      }
      const window = retainedIntensityWindow(stack.slices);
      // All predictions are fixed before a withheld pixel is decoded.
      const predictions = [];
      for (const index of withheldIndices) {
        const positionMm = frames[index]!.positionMm;
        const inferenceStarted = performance.now();
        const inferred = await synthesizeSharpSlice(stack, positionMm);
        predictions.push({
          index,
          inferred,
          inferenceMs: performance.now() - inferenceStarted,
          linear: interpolateCorpusBaseline(stack.slices, positionMm, 'linear'),
          cubic: interpolateCorpusBaseline(stack.slices, positionMm, 'cubic'),
        });
      }
      const first = retained[0]!.plane;
      const endpoint = await synthesizeSharpSlice(stack, first.positionMm);
      expect(endpoint.stats.exactSource).toBe(true);
      expect(pixelFingerprint(endpoint.pixels)).toBe(retained[0]!.pixelHash);
      expect(pixelFingerprint(endpoint.valid)).toBe(retained[0]!.supportHash);

      const receipts = [];
      for (const prediction of predictions) {
        const { index, inferred, linear, cubic, inferenceMs } = prediction;
        const truth = await decodeNative(frames[index]!, codec);
        decodedByIndex.set(index, truth);
        expect(
          retained.every(({ pixelHash }) => pixelHash !== truth.pixelHash),
          'Withheld truth must not duplicate a retained image',
        ).toBe(true);
        expect(truth.plane.pixels.buffer === inferred.pixels.buffer).toBe(false);
        expect(inferred.stats.exactSource).toBe(false);
        expect(inferred.stats.cubicPixels).toBeGreaterThan(0);
        expect(inferred.pixels).toHaveLength(source.rows * source.columns);
        expect(inferred.valid).toHaveLength(source.rows * source.columns);
        expect(inferred.pixels.every(Number.isFinite)).toBe(true);
        const predictionsByMethod = { linear, cubic, inferred: { ...inferred, positionMm: truth.plane.positionMm } };
        const measurements = Object.fromEntries(
          Object.entries(predictionsByMethod).map(([method, candidate]) => {
            const common = {
              prediction: candidate,
              truth: truth.plane,
              baselineSupport: cubic.valid!,
              rows: source.rows,
              columns: source.columns,
              rowSpacingMm: geometry.rowSpacingMm,
              columnSpacingMm: geometry.colSpacingMm,
              intensityRange: window.range,
            };
            const fullFrame = compareHeldOutPixels(common);
            const tumorNeighborhood = compareHeldOutPixels({ ...common, region });
            expect(fullFrame.missing, 'Synthesis may not hide difficult pixels behind missing support').toBe(0);
            expect(tumorNeighborhood.missing).toBe(0);
            return [
              method,
              { fullFrame, tumorNeighborhood, overshoot: interpolationOvershoot(candidate, stack.slices) },
            ];
          }),
        );
        const name = `e${examination}-${plane.toLowerCase()}-${index}-lag${lag}`;
        const displayed = [truth.plane, linear, cubic, predictionsByMethod.inferred];
        const labels = ['NATIVE', 'ORDER1', 'ORDER3', 'RENDER3'];
        const fullRegion = { left: 0, top: 0, width: source.columns, height: source.rows };
        const image = writeAlignmentComparisonSheet(
          outputDirectory,
          name,
          [fullRegion, region].flatMap((crop) =>
            displayed.map((candidate, method) => ({
              label: `E${examination} ${plane} ${index} ${labels[method]}`,
              pixels: cropCorpusPixels(candidate.pixels, source.columns, crop, truth.evidence.invert),
              rows: crop.height,
              columns: crop.width,
              windowCenter: truth.evidence.invert ? -window.center : window.center,
              windowWidth: window.width,
            })),
          ),
          4,
        );
        const errors = writeAlignmentComparisonSheet(
          outputDirectory,
          `${name}-errors`,
          displayed.slice(1).map((candidate, method) => ({
            label: `E${examination} ${plane} ERROR ${method === 2 ? 'RENDER3' : method === 1 ? '3' : '1'}`,
            pixels: cropCorpusPixels(
              Float32Array.from(candidate.pixels, (value, pixel) => Math.abs(value - truth.plane.pixels[pixel]!)),
              source.columns,
              region,
            ),
            rows: region.height,
            columns: region.width,
            windowCenter: window.range * 0.05,
            windowWidth: window.range * 0.1,
          })),
          3,
        );
        const neighborDistancesMm = retainedIndices.map((sourceIndex) =>
          Math.abs(frames[sourceIndex]!.positionMm - frames[index]!.positionMm),
        );
        const closest = neighborDistancesMm.indexOf(Math.min(...neighborDistancesMm));
        const thickness = frames[index]!.sliceThickness;
        const neighborThickness = frames[retainedIndices[closest]!]!.sliceThickness;
        const receipt = {
          candidate: 'bounded-cubic',
          examination: `E${examination}`,
          plane,
          sourceIndex: index,
          nominalTargetInputOverlapMm:
            thickness && neighborThickness
              ? Math.max(0, (thickness + neighborThickness) / 2 - neighborDistancesMm[closest]!)
              : null,
          nativeSliceThicknessMm: thickness ?? null,
          nearestRetainedCenterMm: neighborDistancesMm[closest],
          inferenceMs,
          measurements,
          synthesis: inferred.stats,
          comparisonImage: basename(image),
          errorImage: basename(errors),
        };
        receipts.push(receipt);
        expect(pixelFingerprint(truth.plane.pixels)).toBe(truth.pixelHash);
        expect(pixelFingerprint(truth.plane.valid!)).toBe(truth.supportHash);
        expect(pixelFingerprint(readFileSync(frames[index]!.path))).toBe(truth.evidence.fileHash);
        console.info('[sharp-slice-corpus]', JSON.stringify(receipt));
      }
      // Fractional display validation is separate from the sealed held-out predictions above.
      const presentation =
        examination === 1 && plane === 'AX' && lag === 1
          ? await validatePhysicalPresentation(source, frames, center, region, decodedByIndex, codec, window)
          : undefined;
      if (presentation) console.info('[sharp-slice-presentation-corpus]', JSON.stringify(presentation));
      const nativePresentation =
        presentation && fullNativePresentation
          ? await validatePhysicalPresentation(
              source,
              frames,
              center,
              { left: 0, top: 0, width: source.columns, height: source.rows },
              decodedByIndex,
              codec,
              window,
            )
          : undefined;
      if (nativePresentation)
        console.info('[sharp-slice-native-presentation-corpus]', JSON.stringify(nativePresentation));
      for (const [retainedIndex, decoded] of retained.entries()) {
        expect(pixelFingerprint(decoded.plane.pixels)).toBe(decoded.pixelHash);
        expect(pixelFingerprint(decoded.plane.valid!)).toBe(decoded.supportHash);
        expect(pixelFingerprint(readFileSync(frames[retainedIndices[retainedIndex]!]!.path))).toBe(
          decoded.evidence.fileHash,
        );
      }
      expect(stack.slices.map((slice) => slice.positionMm)).toEqual(
        retainedIndices.map((index) => frames[index]!.positionMm),
      );
      expect(pixelFingerprint(readFileSync(algorithmPath)), 'Do not change the algorithm during a benchmark').toBe(
        sourceSha256.algorithm,
      );
      expect(pixelFingerprint(readFileSync(presentationPath))).toBe(sourceSha256.presentation);
      expect(pixelFingerprint(readFileSync(reslicerPath))).toBe(sourceSha256.reslicer);
      const summary = {
        schema: 1,
        candidate: 'bounded-cubic',
        sourceSha256,
        examination: `E${examination}`,
        plane,
        cohort: [1, 15].includes(examination)
          ? 'development'
          : [3, 4, 18].includes(examination)
            ? 'reserved-confirmation'
            : 'confirmation',
        nativeRows: source.rows,
        nativeColumns: source.columns,
        nativeRowSpacingMm: geometry.rowSpacingMm,
        nativeColumnSpacingMm: geometry.colSpacingMm,
        retainedCenterSpacingsMm: stack.slices
          .slice(1)
          .map((slice, index) => slice.positionMm - stack.slices[index]!.positionMm),
        sourceIdentity: {
          studyHash: pixelFingerprint(Buffer.from(source.studyUid)),
          seriesHash: pixelFingerprint(Buffer.from(source.seriesUid)),
          studyDateHash: retained[0]!.evidence.studyDateHash,
        },
        nativeSourceHashes: [...decodedByIndex].map(([sourceIndex, decoded]) => ({
          sourceIndex,
          role: retainedIndices.includes(sourceIndex)
            ? 'retained'
            : withheldIndices.includes(sourceIndex)
              ? 'withheld'
              : 'presentation-only',
          dicomSha256: decoded.evidence.fileHash,
          pixelSha256: decoded.pixelHash,
          supportSha256: decoded.supportHash,
        })),
        sourceKinds: [...new Set(retained.map(({ evidence }) => evidence.kind))],
        omittedDuplicateSops,
        retainedSourceIndices: retainedIndices,
        withheldSourceIndices: withheldIndices,
        lag,
        region,
        inputWindow: window,
        sourceBuffersAndFilesUnchanged: true,
        heldOutPixelsDecodedAfterAllPredictions: true,
        elapsedMs: performance.now() - started,
        interpretation:
          'Omitted acquired-slice reconstruction, not clinical truth or independent multiplane detail. Sharpness ratio alone is not fidelity. Declared slice profiles can overlap; unknown PSF tails are not excluded.',
        receipts,
        presentation,
        nativePresentation,
      };
      writeFileSync(
        join(outputDirectory, `e${examination}-${plane.toLowerCase()}-lag${lag}.json`),
        JSON.stringify(summary, null, 2),
      );
    },
    180_000,
  );
});
