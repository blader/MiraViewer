import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import dicomParser from 'dicom-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteAllStoredMriData } from '../src/db/db';
import { processDicomFile } from '../src/services/dicomIngestion';
import { DEFAULT_SVR_PARAMS, type SvrResult, type SvrRoi, type SvrSelectedSeries } from '../src/types/svr';
import { parseSeriesDescription } from '../src/utils/dicomSeriesParsing';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import { dot, type Vec3 } from '../src/utils/svr/vec3';
import { loadAlignmentLosslessCodec } from './helpers/alignmentRealCorpus';

const corpusMocks = vi.hoisted(() => ({ loadAndCacheImage: vi.fn() }));

vi.mock('cornerstone-core', () => ({
  default: {
    loadAndCacheImage: corpusMocks.loadAndCacheImage,
    loadImage: corpusMocks.loadAndCacheImage,
    imageCache: { getCacheInfo: () => ({}) },
  },
}));

import { reconstructVolumeMultiPlane } from '../src/utils/svr/reconstructVolume';

const corpusDirectory = process.env.MIRAVIEWER_SVR_CORPUS_DIR;
const runCorpus = corpusDirectory ? it : it.skip;
const HEADER_BYTES = 64 * 1024;
const MAX_SLICES_PER_SERIES = 24;
const DEFAULT_MAX_GROUPS = 12;
const MAX_REGISTERED_ROI_GROUPS = 3;
const INDEPENDENT_ORIENTATION_COSINE = Math.cos((10 * Math.PI) / 180);
const LITTLE_ENDIAN_TRANSFER_SYNTAXES = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);
const JPEG_LOSSLESS_TRANSFER_SYNTAXES = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);

type CorpusPixelData = Int16Array | Uint16Array | Int8Array | Uint8Array;

type CorpusFrame = {
  path: string;
  sopUid: string;
  positionMm: number;
};

type CorpusSeries = {
  patientKey: string;
  studyUid: string;
  seriesUid: string;
  frameUid: string;
  contrastKey: string;
  normal: Vec3;
  rowDirection: Vec3;
  columnDirection: Vec3;
  rows: number;
  columns: number;
  rowSpacingMm: number;
  columnSpacingMm: number;
  invalid: boolean;
  frames: CorpusFrame[];
};

type CorpusGroup = {
  patientKey: string;
  studyUid: string;
  frameUid: string;
  sources: CorpusSeries[];
};

type DecodedCorpusImage = {
  rows: number;
  columns: number;
  slope: number;
  intercept: number;
  pixelPaddingValue?: number;
  pixelPaddingRangeLimit?: number;
  getPixelData: () => CorpusPixelData;
};

type CorpusSummary = {
  filesScanned: number;
  parsedDicomFiles: number;
  magneticResonanceFrames: number;
  duplicateInstances: number;
  rejectedMissingIdentityOrGeometry: number;
  rejectedUnsupportedEncoding: number;
  rejectedCompressedTransferSyntax: number;
  rejectedEnhancedMultiframe: number;
  rejectedUnsupportedSampleFormat: number;
  sourceSeries: number;
  reliableSourceSeries: number;
  patientCount: number;
  studyCount: number;
  scannerVendorCount: number;
  eligibleMultiplaneGroups: number;
  evaluatedMultiplaneGroups: number;
  evaluatedThreeOrientationGroups: number;
  decodedRealSourceFrames: number;
  decodedLosslessCompressedFrames: number;
  productionSourceDecodes: number;
  reconstructedVolumes: number;
  registeredRoiReconstructions: number;
  totalOutputVoxels: number;
  totalAcquiredSupportVoxels: number;
  unsupportedNonzeroVoxels: number;
  minimumAcquiredSupportFraction: number;
  maximumReconstructionMilliseconds: number;
  maximumRegisteredRoiMilliseconds: number;
  totalElapsedMilliseconds: number;
};

function* walkCorpus(root: string): Generator<string> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) yield path;
    }
  }
}

function readDicomHeader(path: string): dicomParser.DataSet {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HEADER_BYTES);
    const length = readSync(descriptor, buffer, 0, HEADER_BYTES, 0);
    return dicomParser.parseDicom(new Uint8Array(buffer.buffer, buffer.byteOffset, length), {
      untilTag: 'x7fe00010',
    });
  } finally {
    closeSync(descriptor);
  }
}

function positiveUint16(dataset: dicomParser.DataSet, tag: string): number {
  const value = dataset.uint16(tag);
  return typeof value === 'number' && value > 0 ? value : 0;
}

function contrastFamily(dataset: dicomParser.DataSet): string {
  const description = [dataset.string('x0008103e'), dataset.string('x00181030'), dataset.string('x00180024')]
    .filter(Boolean)
    .join(' | ');
  const parsed = parseSeriesDescription(description);
  return `${parsed.weight ?? 'unclassified'}:${parsed.sequenceType ?? 'unclassified'}`;
}

function inspectCorpus(root: string, summary: CorpusSummary): CorpusGroup[] {
  const seriesByIdentity = new Map<string, CorpusSeries>();
  const seenSopUids = new Set<string>();
  const patientKeys = new Set<string>();
  const studyUids = new Set<string>();
  const scannerVendors = new Set<string>();

  for (const path of walkCorpus(root)) {
    summary.filesScanned++;

    let dataset: dicomParser.DataSet;
    try {
      dataset = readDicomHeader(path);
    } catch {
      continue;
    }

    summary.parsedDicomFiles++;
    if (dataset.string('x00080060') !== 'MR') continue;
    summary.magneticResonanceFrames++;

    const patientId = dataset.string('x00100020')?.trim();
    const patientIssuer = dataset.string('x00100021')?.trim() ?? '';
    const studyUid = dataset.string('x0020000d')?.trim();
    const seriesUid = dataset.string('x0020000e')?.trim();
    const sopUid = dataset.string('x00080018')?.trim();
    const frameUid = dataset.string('x00200052')?.trim();
    const rows = positiveUint16(dataset, 'x00280010');
    const columns = positiveUint16(dataset, 'x00280011');
    const orientation = dataset.string('x00200037');
    const position = dataset.string('x00200032');
    const pixelSpacing = dataset.string('x00280030');
    const transferSyntax = dataset.string('x00020010');
    const bitsAllocated = positiveUint16(dataset, 'x00280100');
    const samplesPerPixel = positiveUint16(dataset, 'x00280002') || 1;
    const numberOfFrames = Number(dataset.string('x00280008') ?? 1);

    if (
      !patientId ||
      !studyUid ||
      !seriesUid ||
      !sopUid ||
      !frameUid ||
      !rows ||
      !columns ||
      !orientation ||
      !position ||
      !pixelSpacing
    ) {
      summary.rejectedMissingIdentityOrGeometry++;
      continue;
    }

    if (
      !transferSyntax ||
      (!LITTLE_ENDIAN_TRANSFER_SYNTAXES.has(transferSyntax) && !JPEG_LOSSLESS_TRANSFER_SYNTAXES.has(transferSyntax))
    ) {
      summary.rejectedUnsupportedEncoding++;
      summary.rejectedCompressedTransferSyntax++;
      continue;
    }
    if (numberOfFrames !== 1) {
      summary.rejectedUnsupportedEncoding++;
      summary.rejectedEnhancedMultiframe++;
      continue;
    }
    if ((bitsAllocated !== 8 && bitsAllocated !== 16) || samplesPerPixel !== 1) {
      summary.rejectedUnsupportedEncoding++;
      summary.rejectedUnsupportedSampleFormat++;
      continue;
    }

    if (seenSopUids.has(sopUid)) {
      summary.duplicateInstances++;
      continue;
    }

    let geometry: ReturnType<typeof getSliceGeometryFromInstance>;
    try {
      geometry = getSliceGeometryFromInstance({
        rows,
        columns,
        imageOrientationPatient: orientation,
        imagePositionPatient: position,
        pixelSpacing,
      });
    } catch {
      summary.rejectedMissingIdentityOrGeometry++;
      continue;
    }

    seenSopUids.add(sopUid);
    const patientKey = `${patientIssuer}\u0000${patientId}`;
    patientKeys.add(patientKey);
    studyUids.add(studyUid);
    const vendor = dataset.string('x00080070')?.trim();
    if (vendor) scannerVendors.add(vendor);

    const seriesIdentity = `${studyUid}\u0000${seriesUid}`;
    let series = seriesByIdentity.get(seriesIdentity);
    if (!series) {
      series = {
        patientKey,
        studyUid,
        seriesUid,
        frameUid,
        contrastKey: contrastFamily(dataset),
        normal: geometry.normalDir,
        rowDirection: geometry.rowDir,
        columnDirection: geometry.colDir,
        rows,
        columns,
        rowSpacingMm: geometry.rowSpacingMm,
        columnSpacingMm: geometry.colSpacingMm,
        invalid: false,
        frames: [],
      };
      seriesByIdentity.set(seriesIdentity, series);
    }

    if (
      series.patientKey !== patientKey ||
      series.frameUid !== frameUid ||
      series.rows !== rows ||
      series.columns !== columns ||
      Math.abs(series.rowSpacingMm - geometry.rowSpacingMm) > 1e-6 ||
      Math.abs(series.columnSpacingMm - geometry.colSpacingMm) > 1e-6 ||
      dot(series.rowDirection, geometry.rowDir) < 0.999 ||
      dot(series.columnDirection, geometry.colDir) < 0.999 ||
      dot(series.normal, geometry.normalDir) < 0.999
    ) {
      series.invalid = true;
      continue;
    }

    series.frames.push({ path, sopUid, positionMm: dot(geometry.ippMm, series.normal) });
  }

  summary.sourceSeries = seriesByIdentity.size;
  summary.patientCount = patientKeys.size;
  summary.studyCount = studyUids.size;
  summary.scannerVendorCount = scannerVendors.size;

  const grouped = new Map<string, CorpusSeries[]>();
  for (const series of seriesByIdentity.values()) {
    if (series.invalid || series.frames.length < 2) continue;
    series.frames.sort((left, right) => left.positionMm - right.positionMm);
    if (
      series.frames.some((frame, index) => index > 0 && frame.positionMm <= series.frames[index - 1]!.positionMm + 1e-6)
    ) {
      continue;
    }

    summary.reliableSourceSeries++;
    const key = `${series.patientKey}\u0000${series.studyUid}\u0000${series.frameUid}\u0000${series.contrastKey}`;
    const existing = grouped.get(key);
    if (existing) existing.push(series);
    else grouped.set(key, [series]);
  }

  const eligible: CorpusGroup[] = [];
  for (const sourceSeries of grouped.values()) {
    sourceSeries.sort((left, right) => right.frames.length - left.frames.length);
    const independent: CorpusSeries[] = [];
    for (const series of sourceSeries) {
      if (independent.every((source) => Math.abs(dot(source.normal, series.normal)) < INDEPENDENT_ORIENTATION_COSINE)) {
        independent.push(series);
      }
      if (independent.length === 3) break;
    }

    if (independent.length >= 2) {
      const first = independent[0]!;
      eligible.push({
        patientKey: first.patientKey,
        studyUid: first.studyUid,
        frameUid: first.frameUid,
        sources: independent,
      });
    }
  }

  eligible.sort((left, right) => {
    const orientationDifference = right.sources.length - left.sources.length;
    if (orientationDifference) return orientationDifference;
    const leftFrames = left.sources.reduce((total, source) => total + source.frames.length, 0);
    const rightFrames = right.sources.reduce((total, source) => total + source.frames.length, 0);
    return rightFrames - leftFrames;
  });
  summary.eligibleMultiplaneGroups = eligible.length;
  return eligible;
}

function sampleFrames(frames: CorpusFrame[]): CorpusFrame[] {
  if (frames.length <= MAX_SLICES_PER_SERIES) return frames;
  return Array.from({ length: MAX_SLICES_PER_SERIES }, (_, index) => {
    const sourceIndex = Math.round((index * (frames.length - 1)) / (MAX_SLICES_PER_SERIES - 1));
    return frames[sourceIndex]!;
  });
}

async function readStoredPixels(
  bytes: Uint8Array,
  dataset: dicomParser.DataSet,
  codec: ReturnType<typeof loadAlignmentLosslessCodec>,
): Promise<DecodedCorpusImage> {
  const rows = positiveUint16(dataset, 'x00280010');
  const columns = positiveUint16(dataset, 'x00280011');
  const allocatedBits = positiveUint16(dataset, 'x00280100');
  const storedBits = positiveUint16(dataset, 'x00280101') || allocatedBits;
  const signed = dataset.uint16('x00280103') === 1;
  const pixelElement = dataset.elements.x7fe00010;
  const bytesPerPixel = allocatedBits / 8;
  const count = rows * columns;
  const transferSyntax = dataset.string('x00020010') ?? '';
  let pixels: CorpusPixelData;

  if (JPEG_LOSSLESS_TRANSFER_SYNTAXES.has(transferSyntax)) {
    if (!pixelElement) throw new Error('A compressed real MRI frame has no encapsulated pixel payload');
    const encoded = codec.wadouri.getEncapsulatedImageFrame(dataset, 0);
    const decoded = await codec.decodeImageFrame(
      {
        rows,
        columns,
        bitsAllocated: allocatedBits,
        bitsStored: storedBits,
        highBit: dataset.uint16('x00280102') ?? storedBits - 1,
        pixelRepresentation: dataset.uint16('x00280103') ?? 0,
        samplesPerPixel: positiveUint16(dataset, 'x00280002') || 1,
        photometricInterpretation: dataset.string('x00280004'),
      },
      transferSyntax,
      encoded,
      {},
      { preScale: { enabled: false } },
    );
    pixels = decoded.pixelData;
    if (pixels.length !== count) {
      throw new Error('The existing DICOM lossless codec returned an incomplete MRI image');
    }
  } else {
    if (!pixelElement || pixelElement.length < count * bytesPerPixel) {
      throw new Error('A selected real MRI frame does not contain its complete declared pixel payload');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (allocatedBits === 16) pixels = signed ? new Int16Array(count) : new Uint16Array(count);
    else pixels = signed ? new Int8Array(count) : new Uint8Array(count);

    const storedMask = storedBits < allocatedBits ? (1 << storedBits) - 1 : null;
    const signBit = 1 << (storedBits - 1);
    for (let index = 0; index < count; index++) {
      const offset = pixelElement.dataOffset + index * bytesPerPixel;
      let value = allocatedBits === 16 ? view.getUint16(offset, true) : view.getUint8(offset);
      if (storedMask !== null) value &= storedMask;
      if (signed && (value & signBit) !== 0) value -= 1 << storedBits;
      pixels[index] = value;
    }
  }

  const paddingValue = dataset.elements.x00280120
    ? signed
      ? dataset.int16('x00280120')
      : dataset.uint16('x00280120')
    : undefined;
  const paddingLimit = dataset.elements.x00280121
    ? signed
      ? dataset.int16('x00280121')
      : dataset.uint16('x00280121')
    : undefined;

  return {
    rows,
    columns,
    slope: dataset.floatString('x00281053') ?? 1,
    intercept: dataset.floatString('x00281052') ?? 0,
    pixelPaddingValue: paddingValue,
    pixelPaddingRangeLimit: paddingLimit,
    getPixelData: () => pixels,
  };
}

function chooseRepresentativeGroups(groups: CorpusGroup[], maxGroups: number): CorpusGroup[] {
  const selected: CorpusGroup[] = [];
  const coveredPatients = new Set<string>();
  const coveredStudies = new Set<string>();
  for (const group of groups) {
    if (selected.length >= maxGroups) break;
    if (coveredPatients.has(group.patientKey)) continue;
    selected.push(group);
    coveredPatients.add(group.patientKey);
    coveredStudies.add(group.studyUid);
  }
  for (const group of groups) {
    if (selected.length >= maxGroups) break;
    if (coveredStudies.has(group.studyUid)) continue;
    selected.push(group);
    coveredStudies.add(group.studyUid);
  }
  for (const group of groups) {
    if (selected.length >= maxGroups) break;
    if (!selected.includes(group)) selected.push(group);
  }
  return selected;
}

function validateReconstructedVolume(reconstructed: SvrResult, summary: CorpusSummary): void {
  const { data, observedSupport } = reconstructed.volume;
  expect(observedSupport, 'Production SVR must return acquired support for every real-MRI result').toBeDefined();
  expect(observedSupport).toHaveLength(data.length);
  expect(reconstructed.volume.acquiredOrientationCount).toBeGreaterThanOrEqual(2);
  expect(['declared', 'mixed', 'unknown']).toContain(reconstructed.volume.sliceProfileSource);
  expect(reconstructed.volume.reconstructionFingerprint).toBeTruthy();

  let supported = 0;
  let nonFiniteVoxelCount = 0;
  let outOfRangeVoxelCount = 0;
  for (let index = 0; index < data.length; index++) {
    const intensity = data[index]!;
    if (!Number.isFinite(intensity)) nonFiniteVoxelCount++;
    else if (intensity < 0 || intensity > 1) outOfRangeVoxelCount++;
    if (observedSupport![index]) supported++;
    else if (intensity !== 0) summary.unsupportedNonzeroVoxels++;
  }

  expect(nonFiniteVoxelCount).toBe(0);
  expect(outOfRangeVoxelCount).toBe(0);
  expect(supported).toBeGreaterThan(0);
  expect(reconstructed.volume.supportedVoxelCount).toBe(supported);
  summary.minimumAcquiredSupportFraction = Math.min(summary.minimumAcquiredSupportFraction, supported / data.length);
  summary.reconstructedVolumes++;
  summary.totalOutputVoxels += data.length;
  summary.totalAcquiredSupportVoxels += supported;
}

function centeredAnatomicalRoi(group: CorpusGroup, reconstructed: SvrResult): SvrRoi {
  const source = group.sources[0]!;
  const absX = Math.abs(source.normal.x);
  const absY = Math.abs(source.normal.y);
  const absZ = Math.abs(source.normal.z);
  const sourcePlane = absX >= absY && absX >= absZ ? 'sagittal' : absY >= absZ ? 'coronal' : 'axial';
  const bounds = reconstructed.volume.boundsMm;
  return {
    mode: 'cube',
    sourcePlane,
    sourceSeriesUid: source.seriesUid,
    boundsMm: {
      min: [0, 1, 2].map((axis) => bounds.min[axis]! + 0.3 * (bounds.max[axis]! - bounds.min[axis]!)) as [
        number,
        number,
        number,
      ],
      max: [0, 1, 2].map((axis) => bounds.max[axis]! - 0.3 * (bounds.max[axis]! - bounds.min[axis]!)) as [
        number,
        number,
        number,
      ],
    },
  };
}

async function evaluateGroup(
  group: CorpusGroup,
  summary: CorpusSummary,
  codec: ReturnType<typeof loadAlignmentLosslessCodec>,
  validateRegistration: boolean,
): Promise<void> {
  await deleteAllStoredMriData();
  const decodedImages = new Map<string, DecodedCorpusImage>();
  corpusMocks.loadAndCacheImage.mockImplementation(async (imageId: string) => {
    const image = decodedImages.get(imageId.slice('miradb:'.length));
    if (!image) throw new Error('An admitted real MRI source image was unavailable');
    summary.productionSourceDecodes++;
    return image;
  });

  const selectedSeries: SvrSelectedSeries[] = [];
  for (const [orientationIndex, source] of group.sources.entries()) {
    const frames = sampleFrames(source.frames);
    for (const frame of frames) {
      const bytes = new Uint8Array(readFileSync(frame.path));
      const dataset = dicomParser.parseDicom(bytes);
      decodedImages.set(frame.sopUid, await readStoredPixels(bytes, dataset, codec));
      const result = await processDicomFile(new File([bytes], 'validation-image.dcm', { type: 'application/dicom' }));
      if (result.status !== 'ingested') {
        throw new Error('A selected real MRI frame was rejected by the production DICOM ingestion pipeline');
      }
      summary.decodedRealSourceFrames++;
      if (JPEG_LOSSLESS_TRANSFER_SYNTAXES.has(dataset.string('x00020010') ?? '')) {
        summary.decodedLosslessCompressedFrames++;
      }
    }

    selectedSeries.push({
      seriesUid: source.seriesUid,
      studyId: group.studyUid,
      dateIso: 'corpus-validation',
      instanceCount: frames.length,
      label: `Orientation ${orientationIndex + 1}`,
    });
  }

  const baseParams = {
    ...DEFAULT_SVR_PARAMS,
    targetVoxelSizeMm: 2,
    maxVolumeDim: 80,
    sliceDownsampleMode: 'voxel-aware' as const,
    sliceDownsampleMaxSize: 64,
    iterations: 2,
  };
  const startedAt = performance.now();
  const reconstructed = await reconstructVolumeMultiPlane({
    selectedSeries,
    svrParams: { ...baseParams, seriesRegistrationMode: 'none' },
  });
  const elapsed = performance.now() - startedAt;
  summary.maximumReconstructionMilliseconds = Math.max(summary.maximumReconstructionMilliseconds, elapsed);
  validateReconstructedVolume(reconstructed, summary);

  if (validateRegistration) {
    let attemptedRegistration = false;
    const registeredAt = performance.now();
    const registered = await reconstructVolumeMultiPlane({
      selectedSeries,
      svrParams: {
        ...baseParams,
        seriesRegistrationMode: 'roi-rigid',
        roi: centeredAnatomicalRoi(group, reconstructed),
      },
      onProgress: (progress) => {
        if (progress.phase === 'initializing' && /ROI rigid align/i.test(progress.message)) {
          attemptedRegistration = true;
        }
      },
    });
    expect(attemptedRegistration).toBe(true);
    expect(registered.volume.data.length).toBeLessThan(reconstructed.volume.data.length);
    validateReconstructedVolume(registered, summary);
    summary.registeredRoiReconstructions++;
    summary.maximumRegisteredRoiMilliseconds = Math.max(
      summary.maximumRegisteredRoiMilliseconds,
      performance.now() - registeredAt,
    );
  }

  summary.evaluatedMultiplaneGroups++;
  if (group.sources.length === 3) summary.evaluatedThreeOrientationGroups++;
  await deleteAllStoredMriData();
}

describe('optional private real-MRI SVR corpus validation', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    await deleteAllStoredMriData();
  });

  runCorpus(
    'scans the supplied MRI corpus and reconstructs representative compatible multiplane examinations',
    async () => {
      const startedAt = performance.now();
      localStorage.setItem('miraviewer:debug-svr', '0');

      // Production logs contain source UIDs. Suppress every diagnostic channel while
      // protected images are resident; only the aggregate report below is published.
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const summary: CorpusSummary = {
        filesScanned: 0,
        parsedDicomFiles: 0,
        magneticResonanceFrames: 0,
        duplicateInstances: 0,
        rejectedMissingIdentityOrGeometry: 0,
        rejectedUnsupportedEncoding: 0,
        rejectedCompressedTransferSyntax: 0,
        rejectedEnhancedMultiframe: 0,
        rejectedUnsupportedSampleFormat: 0,
        sourceSeries: 0,
        reliableSourceSeries: 0,
        patientCount: 0,
        studyCount: 0,
        scannerVendorCount: 0,
        eligibleMultiplaneGroups: 0,
        evaluatedMultiplaneGroups: 0,
        evaluatedThreeOrientationGroups: 0,
        decodedRealSourceFrames: 0,
        decodedLosslessCompressedFrames: 0,
        productionSourceDecodes: 0,
        reconstructedVolumes: 0,
        registeredRoiReconstructions: 0,
        totalOutputVoxels: 0,
        totalAcquiredSupportVoxels: 0,
        unsupportedNonzeroVoxels: 0,
        minimumAcquiredSupportFraction: Number.POSITIVE_INFINITY,
        maximumReconstructionMilliseconds: 0,
        maximumRegisteredRoiMilliseconds: 0,
        totalElapsedMilliseconds: 0,
      };

      const codec = loadAlignmentLosslessCodec();
      const groups = inspectCorpus(corpusDirectory!, summary);
      const requestedGroups = Number(process.env.MIRAVIEWER_SVR_CORPUS_GROUPS ?? DEFAULT_MAX_GROUPS);
      const maxGroups =
        Number.isSafeInteger(requestedGroups) && requestedGroups > 0 ? requestedGroups : DEFAULT_MAX_GROUPS;
      const representative = chooseRepresentativeGroups(groups, maxGroups);

      expect(summary.filesScanned).toBeGreaterThan(0);
      expect(summary.magneticResonanceFrames).toBeGreaterThan(0);
      expect(
        representative.length,
        'The supplied corpus contains no verified compatible multiplane MRI examination',
      ).toBeGreaterThan(0);

      for (const [index, group] of representative.entries()) {
        await evaluateGroup(group, summary, codec, index < MAX_REGISTERED_ROI_GROUPS);
      }

      expect(summary.reconstructedVolumes).toBe(representative.length + summary.registeredRoiReconstructions);
      expect(summary.unsupportedNonzeroVoxels).toBe(0);
      summary.minimumAcquiredSupportFraction = Number(summary.minimumAcquiredSupportFraction.toFixed(6));
      summary.maximumReconstructionMilliseconds = Math.round(summary.maximumReconstructionMilliseconds);
      summary.maximumRegisteredRoiMilliseconds = Math.round(summary.maximumRegisteredRoiMilliseconds);
      summary.totalElapsedMilliseconds = Math.round(performance.now() - startedAt);

      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      console.log(`[svr-corpus] ${JSON.stringify(summary)}`);
    },
    300_000,
  );
});
