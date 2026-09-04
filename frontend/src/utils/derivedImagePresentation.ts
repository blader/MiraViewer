import type { DerivedAlignmentFramePresentation } from '../db/schema';
import type { DerivedAlignmentFrame } from './derivedAlignmentFrame';
import { applyAlignmentDisplayTone, validAlignmentDisplayTone } from './alignmentDisplayTone';
import { loadCornerstoneImage } from './decodedFrame';

/** Exact replays retain this payload, including calibration, while replacing request metadata. */
export function getDerivedAlignmentContent(
  frame: DerivedAlignmentFramePresentation & Pick<DerivedAlignmentFrame, 'acceptedResult'>,
): DerivedAlignmentFramePresentation {
  return frame.acceptedResult?.derivedFrame ?? frame;
}

export function sameDerivedAlignmentContent(
  first: DerivedAlignmentFrame | null,
  second: DerivedAlignmentFrame | null,
): boolean {
  if (first === second) return true;
  return Boolean(
    first &&
    second &&
    first.imageId === second.imageId &&
    first.seriesUid === second.seriesUid &&
    first.instanceIndex === second.instanceIndex &&
    first.patientKey === second.patientKey &&
    first.sequenceId === second.sequenceId &&
    first.datasetRevision === second.datasetRevision &&
    getDerivedAlignmentContent(first) === getDerivedAlignmentContent(second),
  );
}

export type DerivedImagePresentation = {
  imageId: string;
  rows: number;
  columns: number;
  height: number;
  width: number;
  slope: number;
  intercept: number;
  windowCenter: number;
  windowWidth: number;
  invert?: boolean;
  /** Provenance without making Cornerstone's raster cache an owner of raw alignment buffers. */
  derivedSource: WeakRef<DerivedAlignmentFramePresentation>;
  getPixelData: () => Uint16Array;
  [key: string]: unknown;
};

type DisplayReplacement = {
  pixels: Float32Array;
  valid: Uint8Array;
  rows: number;
  columns: number;
};

/** Display-only replacements share the original plane, support, and intensity calibration. */
export async function createDerivedImagePresentation(
  frame: DerivedAlignmentFramePresentation,
  imageId: string,
  replacement?: DisplayReplacement,
  signal?: AbortSignal,
): Promise<DerivedImagePresentation> {
  if (
    replacement &&
    (replacement.rows !== frame.rows ||
      replacement.columns !== frame.columns ||
      replacement.pixels.length !== frame.pixels.length ||
      replacement.valid.length !== frame.pixels.length)
  )
    throw new Error('The sharp slice does not match the original aligned plane');
  signal?.throwIfAborted();
  const source = await loadCornerstoneImage(frame.sourceImageId);
  signal?.throwIfAborted();
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let originalMinimum = minimum;
  let originalMaximum = maximum;
  for (let index = 0; index < frame.pixels.length; index++) {
    if (frame.valid && !frame.valid[index]) continue;
    const pixel = frame.pixels[index]!;
    if (!Number.isFinite(pixel)) continue;
    originalMinimum = Math.min(originalMinimum, pixel);
    originalMaximum = Math.max(originalMaximum, pixel);
    const predicted =
      replacement?.valid[index] && Number.isFinite(replacement.pixels[index]) ? replacement.pixels[index]! : pixel;
    minimum = Math.min(minimum, pixel, predicted);
    maximum = Math.max(maximum, pixel, predicted);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new Error('The derived registration frame contains no finite image samples');
  }

  const intensityRange = maximum - minimum;
  const intensityScale = intensityRange > 0 ? intensityRange / 65_534 : 1;
  const preserveSourceWindow =
    Number.isFinite(source.windowCenter) && Number.isFinite(source.windowWidth) && source.windowWidth > 0;
  const tone = frame.displayTone && validAlignmentDisplayTone(frame.displayTone) ? frame.displayTone : undefined;
  // The native reference is the display authority. DICOM windows can change on
  // every slice even though the scan-pair intensity calibration stays constant.
  const displayReference =
    tone?.referenceWindow && frame.referenceSopInstanceUid
      ? await loadCornerstoneImage(`miradb:${frame.referenceSopInstanceUid}`)
      : undefined;
  signal?.throwIfAborted();
  const presentationPixels = new Uint16Array(frame.pixels.length);
  for (let index = 0; index < frame.pixels.length; index++) {
    const original = frame.pixels[index]!;
    if ((frame.valid && !frame.valid[index]) || !Number.isFinite(original)) continue;
    // Unsupported predictions fall back to measured pixels, never holes or a larger footprint.
    const pixel =
      replacement?.valid[index] && Number.isFinite(replacement.pixels[index]) ? replacement.pixels[index]! : original;
    presentationPixels[index] = tone
      ? 1 + Math.round(applyAlignmentDisplayTone(pixel, tone, displayReference) * 65_534)
      : intensityRange > 0
        ? 1 + Math.round(Math.max(0, Math.min(1, (pixel - minimum) / intensityRange)) * 65_534)
        : 1;
  }

  return {
    ...source,
    imageId,
    derivedSource: new WeakRef(getDerivedAlignmentContent(frame)),
    rows: frame.rows,
    columns: frame.columns,
    height: frame.rows,
    width: frame.columns,
    ...(frame.outputGrid && {
      rowPixelSpacing: frame.outputGrid.rowSpacingMm,
      columnPixelSpacing: frame.outputGrid.columnSpacingMm,
      imagePositionPatient: frame.outputGrid.originMm,
      imageOrientationPatient: [...frame.outputGrid.rowDirection, ...frame.outputGrid.columnDirection],
    }),
    minPixelValue: 1,
    maxPixelValue: tone || intensityRange > 0 ? 65_535 : 1,
    // Even without DICOM VOI, toggling detail must not normalize the replacement's extrema.
    windowCenter: tone ? 32_768 : preserveSourceWindow ? source.windowCenter : (originalMinimum + originalMaximum) / 2,
    windowWidth: tone
      ? 65_534
      : preserveSourceWindow
        ? source.windowWidth
        : Math.max(1, originalMaximum - originalMinimum),
    slope: tone ? 1 : intensityScale,
    intercept: tone ? 0 : minimum - intensityScale,
    invert: displayReference ? displayReference.invert === true : source.invert,
    pixelPaddingValue: 0,
    pixelPaddingRangeLimit: 0,
    cachedLut: undefined,
    modalityLUT: undefined,
    voiLUT: undefined,
    sizeInBytes: presentationPixels.byteLength,
    getPixelData: () => presentationPixels,
  };
}
