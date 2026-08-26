import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import dicomParser from 'dicom-parser';
import type { ExclusionMask } from '../../src/types/api';
import { rasterizeImageExclusion, selectPhysicalTargetSlice } from '../../src/utils/alignmentGeometry';
import { parseSeriesDescription } from '../../src/utils/dicomSeriesParsing';
import type { SeriesFrameManifest } from '../../src/utils/localApi';
import type { OutputPlaneGrid } from '../../src/utils/outputPlaneGrid';
import { downsampledSliceOriginMm, getSliceGeometryFromInstance } from '../../src/utils/svr/dicomGeometry';
import { selectDenseLongitudinalSourceEnvelope } from '../../src/utils/svr/longitudinalFrames';
import {
  registerAndResliceLongitudinal,
  resliceDenseLongitudinalPlane,
  type DenseLongitudinalResliceResult,
  type LongitudinalRegistrationFailure,
  type LongitudinalRegistrationResult,
} from '../../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../../src/utils/svr/reconstructionCore';
import { resample2dAreaAverage } from '../../src/utils/svr/resample2d';
import { dot } from '../../src/utils/svr/vec3';

const HEADER_BYTES = 64 * 1024;
const JPEG_LOSSLESS_SYNTAXES = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);

type CorpusPixels = Int16Array | Uint16Array | Int8Array | Uint8Array;

type LosslessCodec = {
  external: { dicomParser: typeof dicomParser };
  wadouri: { getEncapsulatedImageFrame: (dataset: dicomParser.DataSet, frame: number) => Uint8Array };
  decodeImageFrame: (
    frame: {
      rows: number;
      columns: number;
      bitsAllocated: number;
      bitsStored: number;
      highBit: number;
      pixelRepresentation: number;
      samplesPerPixel: number;
      photometricInterpretation?: string;
    },
    transferSyntax: string,
    encoded: Uint8Array,
    decoderConfig: object,
    options: { preScale: { enabled: boolean } },
  ) => Promise<{ pixelData: CorpusPixels }>;
};

export type AlignmentCorpusPlane = 'AX' | 'COR' | 'SAG';

export type AlignmentCorpusFrame = {
  path: string;
  sopInstanceUid: string;
  positionMm: number;
  rows: number;
  columns: number;
  imagePositionPatient: string;
  imageOrientationPatient: string;
  pixelSpacing: string;
  sliceThickness?: number;
  spacingBetweenSlices?: number;
  windowCenter?: number;
  windowWidth?: number;
};

export type AlignmentCorpusSeries = {
  examinationOrdinal: number;
  plane: AlignmentCorpusPlane;
  patientKey: string;
  studyUid: string;
  seriesUid: string;
  frameOfReferenceUid: string;
  contrast: string;
  rows: number;
  columns: number;
  frames: AlignmentCorpusFrame[];
};

export type DecodedAlignmentFrame = {
  pixels: Float32Array;
  rows: number;
  columns: number;
  compressed: boolean;
  bitsStored: number;
  windowCenter?: number;
  windowWidth?: number;
};

function* walkCorpus(root: string): Generator<string> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dcm')) yield path;
    }
  }
}

function readHeader(path: string): dicomParser.DataSet {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    let length = 0;
    for (let requested = 32 * 1024; ; requested = Math.min(HEADER_BYTES, requested * 2)) {
      const remaining = requested - length;
      const bytesRead = readSync(descriptor, header, length, remaining, length);
      length += bytesRead;
      const exhausted = bytesRead < remaining || length >= HEADER_BYTES;
      let dataset: dicomParser.DataSet;
      try {
        dataset = dicomParser.parseDicom(new Uint8Array(header.buffer, header.byteOffset, length), {
          untilTag: 'x7fe00010',
        });
      } catch (error) {
        if (exhausted) throw error;
        continue;
      }

      const modality = dataset.string('x00080060');
      const completeMr = Boolean(
        dataset.elements.x00280010 &&
        dataset.elements.x00280011 &&
        dataset.elements.x00280030 &&
        (dataset.elements.x00281051 || dataset.elements.x7fe00010),
      );
      if ((modality && modality !== 'MR') || (modality === 'MR' && completeMr) || exhausted) return dataset;
    }
  } finally {
    closeSync(descriptor);
  }
}

export function inspectAlignmentCorpus(
  root: string,
  options: { studyOrdinals?: Iterable<number> } = {},
): AlignmentCorpusSeries[] {
  const series = new Map<string, AlignmentCorpusSeries>();
  const examinationDates = new Map<string, string>();
  const requestedOrdinals = new Set(options.studyOrdinals ?? []);
  let globalOrdinals: Map<string, number> | undefined;
  let files: Iterable<string> = walkCorpus(root);

  if (requestedOrdinals.size > 0) {
    const directories = new Map<string, string>();
    const studyDates = new Map<string, string>();
    for (const path of walkCorpus(root)) {
      const directory = dirname(path);
      if (directories.has(directory)) continue;
      let dataset: dicomParser.DataSet;
      try {
        dataset = readHeader(path);
      } catch {
        continue;
      }
      const studyUid = dataset.string('x0020000d')?.trim();
      if (dataset.string('x00080060') !== 'MR' || !studyUid) continue;
      directories.set(directory, studyUid);
      if (!studyDates.has(studyUid)) studyDates.set(studyUid, dataset.string('x00080020') ?? '');
    }
    globalOrdinals = new Map(
      [...studyDates]
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([studyUid], index) => [studyUid, index + 1]),
    );
    const selectedDirectories = [...directories].filter(([, studyUid]) =>
      requestedOrdinals.has(globalOrdinals!.get(studyUid)!),
    );
    files = (function* () {
      for (const [directory] of selectedDirectories) yield* walkCorpus(directory);
    })();
  }

  for (const path of files) {
    let dataset: dicomParser.DataSet;
    try {
      dataset = readHeader(path);
    } catch {
      continue;
    }
    if (dataset.string('x00080060') !== 'MR') continue;

    const studyUid = dataset.string('x0020000d')?.trim();
    const seriesUid = dataset.string('x0020000e')?.trim();
    const sopInstanceUid = dataset.string('x00080018')?.trim();
    const frameOfReferenceUid = dataset.string('x00200052')?.trim();
    const patientId = dataset.string('x00100020')?.trim();
    const rows = dataset.uint16('x00280010') ?? 0;
    const columns = dataset.uint16('x00280011') ?? 0;
    const imagePositionPatient = dataset.string('x00200032');
    const imageOrientationPatient = dataset.string('x00200037');
    const pixelSpacing = dataset.string('x00280030');
    if (
      !studyUid ||
      !seriesUid ||
      !sopInstanceUid ||
      !frameOfReferenceUid ||
      !patientId ||
      !rows ||
      !columns ||
      !imagePositionPatient ||
      !imageOrientationPatient ||
      !pixelSpacing
    ) {
      continue;
    }

    let geometry: ReturnType<typeof getSliceGeometryFromInstance>;
    try {
      geometry = getSliceGeometryFromInstance({
        rows,
        columns,
        imagePositionPatient,
        imageOrientationPatient,
        pixelSpacing,
      });
    } catch {
      continue;
    }
    const absoluteNormal = [
      Math.abs(geometry.normalDir.x),
      Math.abs(geometry.normalDir.y),
      Math.abs(geometry.normalDir.z),
    ];
    const plane: AlignmentCorpusPlane = (['SAG', 'COR', 'AX'] as const)[
      absoluteNormal.indexOf(Math.max(...absoluteNormal))
    ]!;
    const description = [dataset.string('x0008103e'), dataset.string('x00181030'), dataset.string('x00180024')]
      .filter(Boolean)
      .join(' | ');
    const parsedDescription = parseSeriesDescription(description);
    const identity = `${studyUid}\u0000${seriesUid}`;
    let source = series.get(identity);
    if (!source) {
      source = {
        examinationOrdinal: 0,
        plane,
        patientKey: `${dataset.string('x00100021')?.trim() ?? ''}\u0000${patientId}`,
        studyUid,
        seriesUid,
        frameOfReferenceUid,
        contrast: `${parsedDescription.weight ?? 'unknown'}:${parsedDescription.sequenceType ?? 'unknown'}`,
        rows,
        columns,
        frames: [],
      };
      series.set(identity, source);
      examinationDates.set(studyUid, dataset.string('x00080020') ?? '');
    }
    source.frames.push({
      path,
      sopInstanceUid,
      positionMm: dot(geometry.ippMm, geometry.normalDir),
      rows,
      columns,
      imagePositionPatient,
      imageOrientationPatient,
      pixelSpacing,
      sliceThickness: dataset.floatString('x00180050'),
      spacingBetweenSlices: dataset.floatString('x00180088'),
      windowCenter: dataset.floatString('x00281050'),
      windowWidth: dataset.floatString('x00281051'),
    });
  }

  const examinationOrdinals =
    globalOrdinals ??
    new Map(
      [...examinationDates]
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([uid], index) => [uid, index + 1]),
    );
  for (const source of series.values()) {
    source.examinationOrdinal = examinationOrdinals.get(source.studyUid)!;
    source.frames.sort((left, right) => left.positionMm - right.positionMm);
  }
  return [...series.values()].sort(
    (left, right) => left.examinationOrdinal - right.examinationOrdinal || left.plane.localeCompare(right.plane),
  );
}

export function loadAlignmentLosslessCodec(): LosslessCodec {
  const require = createRequire(import.meta.url);
  const codecPath =
    require.resolve('cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderNoWebWorkers.bundle.min.js');
  const previousScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', {
    configurable: true,
    value: { src: pathToFileURL(codecPath).href },
  });
  try {
    const imported = require(codecPath) as LosslessCodec | { default: LosslessCodec };
    const codec = 'default' in imported ? imported.default : imported;
    codec.external.dicomParser = dicomParser;
    return codec;
  } finally {
    if (previousScript) Object.defineProperty(document, 'currentScript', previousScript);
    else Reflect.deleteProperty(document, 'currentScript');
  }
}

export async function decodeAlignmentCorpusFrame(
  frame: AlignmentCorpusFrame,
  codec: LosslessCodec,
): Promise<DecodedAlignmentFrame> {
  const bytes = new Uint8Array(readFileSync(frame.path));
  const dataset = dicomParser.parseDicom(bytes);
  const bitsAllocated = dataset.uint16('x00280100') ?? 16;
  const bitsStored = dataset.uint16('x00280101') ?? bitsAllocated;
  const representation = dataset.uint16('x00280103') ?? 0;
  const transferSyntax = dataset.string('x00020010') ?? '';
  const compressed = JPEG_LOSSLESS_SYNTAXES.has(transferSyntax);
  const count = frame.rows * frame.columns;
  let decoded: ArrayLike<number>;

  if (compressed) {
    decoded = (
      await codec.decodeImageFrame(
        {
          rows: frame.rows,
          columns: frame.columns,
          bitsAllocated,
          bitsStored,
          highBit: dataset.uint16('x00280102') ?? bitsStored - 1,
          pixelRepresentation: representation,
          samplesPerPixel: dataset.uint16('x00280002') ?? 1,
          photometricInterpretation: dataset.string('x00280004'),
        },
        transferSyntax,
        codec.wadouri.getEncapsulatedImageFrame(dataset, 0),
        {},
        { preScale: { enabled: false } },
      )
    ).pixelData;
  } else {
    const element = dataset.elements.x7fe00010;
    if (!element || element.length < count * (bitsAllocated / 8)) {
      throw new Error('A protected MRI frame does not contain its declared source pixels');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataOffset, element.length);
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      values[index] =
        bitsAllocated === 8
          ? representation
            ? view.getInt8(index)
            : view.getUint8(index)
          : representation
            ? view.getInt16(index * 2, true)
            : view.getUint16(index * 2, true);
    }
    decoded = values;
  }

  if (decoded.length !== count) throw new Error('A protected MRI decoder returned an incomplete frame');
  const slope = dataset.floatString('x00281053') ?? 1;
  const intercept = dataset.floatString('x00281052') ?? 0;
  return {
    pixels: Float32Array.from(decoded, (value) => value * slope + intercept),
    rows: frame.rows,
    columns: frame.columns,
    compressed,
    bitsStored,
    windowCenter: dataset.floatString('x00281050'),
    windowWidth: dataset.floatString('x00281051'),
  };
}

export async function decodeAlignmentRegistrationSlice(
  series: AlignmentCorpusSeries,
  frameIndex: number,
  codec: LosslessCodec,
  size?: number,
): Promise<SvrReconstructionSlice> {
  const frame = series.frames[frameIndex];
  if (!frame) throw new Error('A reviewed registration frame exceeds its acquired series bounds');
  const decoded = await decodeAlignmentCorpusFrame(frame, codec);
  const geometry = getSliceGeometryFromInstance(frame);
  const rows = size ?? decoded.rows;
  const columns = size ?? decoded.columns;
  const pixels =
    rows === decoded.rows && columns === decoded.columns
      ? decoded.pixels
      : resample2dAreaAverage(decoded.pixels, decoded.rows, decoded.columns, rows, columns);

  return {
    pixels,
    valid: new Uint8Array(pixels.length).fill(1),
    dsRows: rows,
    dsCols: columns,
    ippMm: downsampledSliceOriginMm(geometry, rows, columns),
    rowDir: geometry.rowDir,
    colDir: geometry.colDir,
    normalDir: geometry.normalDir,
    rowSpacingDsMm: geometry.rowSpacingMm * (geometry.rows / rows),
    colSpacingDsMm: geometry.colSpacingMm * (geometry.cols / columns),
    sliceThicknessMm: frame.sliceThickness ?? null,
    spacingBetweenSlicesMm: frame.spacingBetweenSlices ?? null,
    frameOfReferenceUid: series.frameOfReferenceUid,
    sopInstanceUid: frame.sopInstanceUid,
  };
}

export function sampledRegistrationIndices(frameCount: number, samples: number, requiredIndex?: number): number[] {
  const indices = Array.from({ length: Math.min(samples, frameCount) }, (_, index) =>
    Math.round((index * (frameCount - 1)) / Math.max(1, samples - 1)),
  );
  if (requiredIndex !== undefined && !indices.includes(requiredIndex)) {
    let nearest = 0;
    for (let index = 1; index < indices.length; index++) {
      if (Math.abs(indices[index]! - requiredIndex) < Math.abs(indices[nearest]! - requiredIndex)) nearest = index;
    }
    indices[nearest] = requiredIndex;
  }
  return [...new Set(indices)].sort((left, right) => left - right);
}

export function alignmentCorpusManifest(series: AlignmentCorpusSeries): SeriesFrameManifest {
  return {
    patientKey: series.patientKey,
    studyUid: series.studyUid,
    seriesUid: series.seriesUid,
    frameOfReferenceUid: series.frameOfReferenceUid,
    ordering: 'physical',
    geometryReliable: true,
    frames: series.frames.map((frame, index) => ({
      sopInstanceUid: frame.sopInstanceUid,
      seriesInstanceUid: series.seriesUid,
      studyInstanceUid: series.studyUid,
      instanceNumber: index,
      frameOfReferenceUid: series.frameOfReferenceUid,
      rows: frame.rows,
      columns: frame.columns,
      imagePositionPatient: frame.imagePositionPatient,
      imageOrientationPatient: frame.imageOrientationPatient,
      pixelSpacing: frame.pixelSpacing,
      sliceThickness: frame.sliceThickness,
      spacingBetweenSlices: frame.spacingBetweenSlices,
      physicalSlicePosition: frame.positionMm,
    })),
  };
}

export type PreparedAlignmentPhysicalReference = {
  series: AlignmentCorpusSeries;
  frameIndex: number;
  codec: LosslessCodec;
  manifest: SeriesFrameManifest;
  sourceIndices: number[];
  slices: SvrReconstructionSlice[];
  selectedSliceIndex: number;
  maxDimension: number;
  maxSlices: number;
  exclusionMask?: Uint8Array;
  nativeSlabs: Map<
    number,
    Promise<{ slices: SvrReconstructionSlice[]; sourceIndices: number[]; selectedIndex: number }>
  >;
};

export async function prepareAlignmentPhysicalReference(
  series: AlignmentCorpusSeries,
  frameIndex: number,
  codec: LosslessCodec,
  options: { exclusion?: ExclusionMask; maxSlices?: number; maxDimension?: number } = {},
): Promise<PreparedAlignmentPhysicalReference> {
  if (!series.frames[frameIndex]) throw new Error('A physical golden reference is outside its acquired source series');
  const maxDimension = options.maxDimension ?? 96;
  const maxSlices = options.maxSlices ?? 48;
  const sourceIndices = sampledRegistrationIndices(series.frames.length, maxSlices, frameIndex);
  const slices = await Promise.all(
    sourceIndices.map((index) =>
      decodeAlignmentRegistrationSlice(
        series,
        index,
        codec,
        index === frameIndex ? Math.min(1024, Math.max(series.rows, series.columns)) : maxDimension,
      ),
    ),
  );
  const selectedSliceIndex = sourceIndices.indexOf(frameIndex);
  const selected = slices[selectedSliceIndex]!;
  return {
    series,
    frameIndex,
    codec,
    manifest: alignmentCorpusManifest(series),
    sourceIndices,
    slices,
    selectedSliceIndex,
    maxDimension,
    maxSlices,
    ...(options.exclusion
      ? { exclusionMask: rasterizeImageExclusion(options.exclusion, selected.dsRows, selected.dsCols) }
      : {}),
    nativeSlabs: new Map(),
  };
}

export type AlignmentPhysicalGoldenSuccess = {
  ok: true;
  coarse: LongitudinalRegistrationResult;
  dense: DenseLongitudinalResliceResult;
  reference: PreparedAlignmentPhysicalReference;
  targetManifest: SeriesFrameManifest;
  targetSourceIndices: number[];
  nativeTargetIndices: number[];
  nativeReferences: SvrReconstructionSlice[];
  nativeTargets: SvrReconstructionSlice[];
  nativeReferenceSliceIndex: number;
  predictedIndex: number;
  selectedIndex: number;
  coarseMilliseconds: number;
  nativeMilliseconds: number;
};

export type AlignmentPhysicalGoldenFailure = {
  ok: false;
  phase: 'coarse' | 'native';
  failure: LongitudinalRegistrationFailure;
  coarseMilliseconds: number;
  nativeMilliseconds?: number;
  predictedIndex?: number;
};

export async function runAlignmentPhysicalGoldenCase(
  reference: PreparedAlignmentPhysicalReference,
  target: AlignmentCorpusSeries,
  options: {
    outputGrid?: OutputPlaneGrid;
    targetSlices?: SvrReconstructionSlice[];
    alignmentFocus?: 'anatomy' | 'tumor';
  } = {},
): Promise<AlignmentPhysicalGoldenSuccess | AlignmentPhysicalGoldenFailure> {
  if (target.patientKey !== reference.series.patientKey) {
    throw new Error('Physical golden alignment must never combine different patients');
  }
  if (target.plane !== reference.series.plane) {
    throw new Error('Physical golden alignment requires matching acquired plane families');
  }
  const targetSourceIndices = options.targetSlices
    ? reference.sourceIndices
    : sampledRegistrationIndices(target.frames.length, reference.maxSlices);
  if (options.targetSlices && options.targetSlices.length !== targetSourceIndices.length) {
    throw new Error('Predecoded physical target slices must match their acquired source indices');
  }
  const targetSlices =
    options.targetSlices ??
    (await Promise.all(
      targetSourceIndices.map((index) =>
        decodeAlignmentRegistrationSlice(target, index, reference.codec, reference.maxDimension),
      ),
    ));
  const coarseStarted = performance.now();
  const coarse = await registerAndResliceLongitudinal({
    referenceSlices: reference.slices,
    targetSlices,
    referenceSliceIndex: reference.selectedSliceIndex,
    referenceExclusionMask: reference.exclusionMask,
    maxDimension: reference.maxDimension,
    maxSamples: 12_000,
    minCoverage: 0.55,
    deferPresentationValidation: true,
    ...(options.outputGrid ? { outputGrid: options.outputGrid } : {}),
  });
  const coarseMilliseconds = performance.now() - coarseStarted;
  if (!coarse.ok) return { ok: false, phase: 'coarse', failure: coarse, coarseMilliseconds };

  const targetManifest = alignmentCorpusManifest(target);
  const predictedIndex = selectPhysicalTargetSlice(reference.manifest, targetManifest, reference.frameIndex, {
    rigid: coarse.targetToReference,
    centerMm: coarse.centerMm,
    ...(options.outputGrid ? { outputGrid: options.outputGrid } : {}),
  });
  const selectedReference = reference.slices[reference.selectedSliceIndex]!;
  const bytesPerReferenceSlice =
    selectedReference.dsRows *
    selectedReference.dsCols *
    (Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT);
  const maximumReferenceRadius = Math.floor((Math.floor((32 * 1024 * 1024) / bytesPerReferenceSlice) - 1) / 2);
  if (maximumReferenceRadius < 1) {
    throw new Error('A native golden reference exceeds the production physical-slab memory budget');
  }
  const radius = Math.min((coarse.nativeCandidatePoses?.length ?? 0) > 1 ? 6 : 2, maximumReferenceRadius);
  let referenceSlab = reference.nativeSlabs.get(radius);
  if (!referenceSlab) {
    const first = Math.max(0, reference.frameIndex - radius);
    const last = Math.min(reference.series.frames.length - 1, reference.frameIndex + radius);
    const sourceIndices = Array.from({ length: last - first + 1 }, (_, index) => first + index);
    referenceSlab = Promise.all(
      sourceIndices.map((index) =>
        index === reference.frameIndex
          ? Promise.resolve(reference.slices[reference.selectedSliceIndex]!)
          : decodeAlignmentRegistrationSlice(reference.series, index, reference.codec),
      ),
    ).then((slices) => ({ slices, sourceIndices, selectedIndex: reference.frameIndex - first }));
    reference.nativeSlabs.set(radius, referenceSlab);
  }

  const nativeTargetDimension = Math.min(
    Math.max(selectedReference.dsRows, selectedReference.dsCols),
    Math.max(target.rows, target.columns),
  );
  const { sourceIndices: nativeTargetIndices } = selectDenseLongitudinalSourceEnvelope(
    targetManifest,
    selectedReference,
    coarse.targetToReference,
    coarse.centerMm,
    {
      maxSlices: 96,
      maxDimension: nativeTargetDimension,
      referenceManifest: reference.manifest,
      referenceSliceIndex: reference.frameIndex,
      ...(reference.exclusionMask ? { referenceExclusionMask: reference.exclusionMask } : {}),
      ...(coarse.nativeCandidatePoses ? { nativeCandidatePoses: coarse.nativeCandidatePoses } : {}),
      ...(options.alignmentFocus ? { alignmentFocus: options.alignmentFocus } : {}),
      ...(options.outputGrid ? { outputGrid: options.outputGrid } : {}),
    },
  );
  const [nativeReference, nativeTargets] = await Promise.all([
    referenceSlab,
    Promise.all(
      nativeTargetIndices.map((index) =>
        decodeAlignmentRegistrationSlice(target, index, reference.codec, nativeTargetDimension),
      ),
    ),
  ]);
  const nativeStarted = performance.now();
  const dense = resliceDenseLongitudinalPlane({
    targetSlices: nativeTargets,
    referencePlane: nativeReference.slices[nativeReference.selectedIndex]!,
    targetToReference: coarse.targetToReference,
    centerMm: coarse.centerMm,
    nativeReferenceSlices: nativeReference.slices,
    nativeReferenceSliceIndex: nativeReference.selectedIndex,
    nativeCandidatePoses: coarse.nativeCandidatePoses,
    referenceExclusionMask: reference.exclusionMask,
    minCoverage: 0.55,
    ...(options.alignmentFocus ? { alignmentFocus: options.alignmentFocus } : {}),
    ...(options.outputGrid ? { outputGrid: options.outputGrid } : {}),
  });
  const nativeMilliseconds = performance.now() - nativeStarted;
  if (!dense.ok) {
    return { ok: false, phase: 'native', failure: dense, coarseMilliseconds, nativeMilliseconds, predictedIndex };
  }
  return {
    ok: true,
    coarse,
    dense,
    reference,
    targetManifest,
    targetSourceIndices,
    nativeTargetIndices,
    nativeReferences: nativeReference.slices,
    nativeTargets,
    nativeReferenceSliceIndex: nativeReference.selectedIndex,
    predictedIndex,
    selectedIndex: selectPhysicalTargetSlice(reference.manifest, targetManifest, reference.frameIndex, {
      rigid: dense.targetToReference ?? coarse.targetToReference,
      centerMm: coarse.centerMm,
      ...(options.outputGrid ? { outputGrid: options.outputGrid } : {}),
    }),
    coarseMilliseconds,
    nativeMilliseconds,
  };
}

const FONT: Record<string, readonly string[]> = {
  E: ['111', '100', '110', '100', '111'],
  A: ['010', '101', '111', '101', '101'],
  X: ['101', '101', '010', '101', '101'],
  C: ['111', '100', '100', '100', '111'],
  D: ['110', '101', '101', '101', '110'],
  F: ['111', '100', '110', '100', '100'],
  I: ['111', '010', '010', '010', '111'],
  N: ['101', '111', '111', '111', '101'],
  O: ['111', '101', '101', '101', '111'],
  R: ['110', '101', '110', '101', '101'],
  S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'],
  V: ['101', '101', '101', '101', '010'],
  G: ['111', '100', '101', '101', '111'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

function paintLabel(buffer: Uint8Array, width: number, x: number, y: number, text: string): void {
  for (const character of text) {
    const glyph = FONT[character];
    if (!glyph) {
      x += 8;
      continue;
    }
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row]!.length; column++) {
        if (glyph[row]![column] !== '1') continue;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const index = ((y + row * 2 + dy) * width + x + column * 2 + dx) * 3;
            buffer[index] = 223;
            buffer[index + 1] = 225;
            buffer[index + 2] = 207;
          }
        }
      }
    }
    x += 9;
  }
}

function pngChunk(kind: string, bytes: Uint8Array): Buffer {
  const type = Buffer.from(kind);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])) >>> 0);
  return Buffer.concat([length, type, bytes, checksum]);
}

function writeRgbPng(path: string, width: number, height: number, pixels: Uint8Array): void {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    scanlines.set(pixels.subarray(row * width * 3, (row + 1) * width * 3), row * (width * 3 + 1) + 1);
  }
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(scanlines, { level: 3 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function windowedPixels(pixels: Float32Array, physicalWindow?: { center?: number; width?: number }): Uint8Array {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of pixels) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const validPhysicalWindow =
    typeof physicalWindow?.center === 'number' &&
    Number.isFinite(physicalWindow.center) &&
    typeof physicalWindow.width === 'number' &&
    Number.isFinite(physicalWindow.width) &&
    physicalWindow.width > 0;
  const lower = validPhysicalWindow ? physicalWindow.center! - physicalWindow.width! / 2 : minimum;
  const upper = validPhysicalWindow ? physicalWindow.center! + physicalWindow.width! / 2 : maximum;
  const range = Math.max(1e-6, upper - lower);
  return Uint8Array.from(pixels, (value) => {
    const normalized = Math.max(0, Math.min(1, (value - lower) / range));
    return Math.round(normalized * 255);
  });
}

export function writeAlignmentComparisonSheet(
  directory: string,
  name: string,
  tiles: ReadonlyArray<{
    label: string;
    pixels: Float32Array;
    rows: number;
    columns: number;
    valid?: Uint8Array;
    windowCenter?: number;
    windowWidth?: number;
  }>,
  columns = 5,
): string {
  mkdirSync(directory, { recursive: true });
  const size = 512;
  const labelHeight = 20;
  const width = columns * size;
  const height = Math.ceil(tiles.length / columns) * (size + labelHeight);
  const output = new Uint8Array(width * height * 3);

  for (const [tileIndex, tile] of tiles.entries()) {
    const source =
      tile.rows === size && tile.columns === size
        ? tile.pixels
        : resample2dAreaAverage(tile.pixels, tile.rows, tile.columns, size, size);
    const grayscale = windowedPixels(source, { center: tile.windowCenter, width: tile.windowWidth });
    const left = (tileIndex % columns) * size;
    const top = Math.floor(tileIndex / columns) * (size + labelHeight);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const sourceIndex = row * size + column;
        const value = tile.valid && !tile.valid[sourceIndex] ? 0 : grayscale[sourceIndex]!;
        const outputIndex = ((top + row) * width + left + column) * 3;
        output[outputIndex] = value;
        output[outputIndex + 1] = value;
        output[outputIndex + 2] = value;
      }
    }
    paintLabel(output, width, left + 8, top + size + 5, tile.label);
  }

  const path = join(directory, `${name}.png`);
  writeRgbPng(path, width, height, output);
  return path;
}

export function sampledAlignmentIndices(frameCount: number, samples = 30): number[] {
  const first = Math.max(0, Math.round(frameCount * 0.12));
  const last = Math.min(frameCount - 1, Math.round(frameCount * 0.88));
  return [
    ...new Set(
      Array.from({ length: Math.min(samples, last - first + 1) }, (_, index) =>
        Math.round(first + (index * (last - first)) / Math.max(1, samples - 1)),
      ),
    ),
  ];
}

export async function writeAlignmentContactSheet(
  directory: string,
  series: AlignmentCorpusSeries,
  codec: LosslessCodec,
  options: {
    indices?: readonly number[];
    tileSize?: number;
    cropSize?: number;
    columns?: number;
    suffix?: string;
  } = {},
): Promise<{ path: string; decodedFrames: number; compressedFrames: number }> {
  mkdirSync(directory, { recursive: true });
  const indices = options.indices?.length ? [...options.indices] : sampledAlignmentIndices(series.frames.length);
  const tile = options.tileSize ?? 256;
  const labelHeight = 20;
  const columns = options.columns ?? 6;
  const width = columns * tile;
  const height = Math.ceil(indices.length / columns) * (tile + labelHeight);
  const output = new Uint8Array(width * height * 3);
  let compressedFrames = 0;
  const selectedWindows = indices
    .map((index) => series.frames[index])
    .filter(
      (frame) =>
        typeof frame?.windowCenter === 'number' &&
        typeof frame.windowWidth === 'number' &&
        Number.isFinite(frame.windowCenter) &&
        Number.isFinite(frame.windowWidth) &&
        frame.windowWidth > 0,
    );
  const minimumWindow = Math.min(...selectedWindows.map((frame) => frame!.windowCenter! - frame!.windowWidth! / 2));
  const maximumWindow = Math.max(...selectedWindows.map((frame) => frame!.windowCenter! + frame!.windowWidth! / 2));
  const sharedWindow = selectedWindows.length
    ? { center: (minimumWindow + maximumWindow) / 2, width: maximumWindow - minimumWindow }
    : undefined;

  for (const [tileIndex, frameIndex] of indices.entries()) {
    const source = series.frames[frameIndex];
    if (!source) throw new Error('A reviewed golden index exceeds its acquired series bounds');
    const decoded = await decodeAlignmentCorpusFrame(source, codec);
    if (decoded.compressed) compressedFrames++;
    let sourcePixels = decoded.pixels;
    let sourceRows = decoded.rows;
    let sourceColumns = decoded.columns;
    if (options.cropSize) {
      const crop = Math.min(options.cropSize, decoded.rows, decoded.columns);
      const leftCrop = Math.floor((decoded.columns - crop) / 2);
      const topCrop = Math.floor((decoded.rows - crop) / 2);
      sourcePixels = new Float32Array(crop * crop);
      for (let row = 0; row < crop; row++) {
        sourcePixels.set(
          decoded.pixels.subarray(
            (topCrop + row) * decoded.columns + leftCrop,
            (topCrop + row) * decoded.columns + leftCrop + crop,
          ),
          row * crop,
        );
      }
      sourceRows = crop;
      sourceColumns = crop;
    }
    const thumbnail = resample2dAreaAverage(sourcePixels, sourceRows, sourceColumns, tile, tile);
    const grayscale = windowedPixels(
      thumbnail,
      sharedWindow ?? { center: decoded.windowCenter, width: decoded.windowWidth },
    );
    const left = (tileIndex % columns) * tile;
    const top = Math.floor(tileIndex / columns) * (tile + labelHeight);
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const value = grayscale[y * tile + x]!;
        const index = ((top + y) * width + left + x) * 3;
        output[index] = value;
        output[index + 1] = value;
        output[index + 2] = value;
      }
    }
    paintLabel(
      output,
      width,
      left + 8,
      top + tile + 5,
      `E${String(series.examinationOrdinal).padStart(2, '0')} ${series.plane} ${String(frameIndex).padStart(3, '0')}`,
    );
  }

  const suffix = options.suffix ?? 'contact';
  const path = join(
    directory,
    `e${String(series.examinationOrdinal).padStart(2, '0')}-${series.plane.toLowerCase()}-${suffix}.png`,
  );
  writeRgbPng(path, width, height, output);
  return { path, decodedFrames: indices.length, compressedFrames };
}
