import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeIntensityMatch } from '../src/utils/alignment';
import { computeCorrespondingDisplayStats, windowDisplayPixels } from '../src/utils/imageCapture';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import { normalizePerceptualSource } from '../src/utils/perceptualSliceSimilarity';
import {
  prepareAnatomicalPlaneLandmarks,
  scoreAnatomicalPlaneLandmarks,
} from '../src/utils/svr/anatomicalPlaneLandmarks';
import { resample2dAreaAverageWithValidity } from '../src/utils/svr/resample2d';
import {
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
  prepareAlignmentPhysicalReference,
  runAlignmentPhysicalGoldenCase,
  writeAlignmentComparisonSheet,
  writeAlignmentContactSheet,
  type AlignmentCorpusPlane,
  type AlignmentCorpusSeries,
  type AlignmentPhysicalGoldenSuccess,
} from './helpers/alignmentRealCorpus';

const REVIEWED_PROTECTED_AXIAL_LANDMARKS = [
  { examination: 1, sliceIndex: 100 },
  { examination: 2, sliceIndex: 98 },
  { examination: 3, sliceIndex: 96 },
  { examination: 4, sliceIndex: 96 },
] as const;

const REVIEWED_REFERENCE_LANDMARKS = [
  { examination: 1, plane: 'AX', sliceIndex: 100 },
  { examination: 1, plane: 'COR', sliceIndex: 110 },
  { examination: 1, plane: 'SAG', sliceIndex: 150 },
  { examination: 14, plane: 'AX', sliceIndex: 93 },
] as const;

const REVIEWED_DESKTOP_LANDMARKS = [
  { examination: 5, plane: 'AX', sliceIndex: 113, tolerance: 3 },
  { examination: 9, plane: 'AX', sliceIndex: 97, tolerance: 2 },
  { examination: 9, plane: 'COR', sliceIndex: 109, tolerance: 3 },
  { examination: 9, plane: 'SAG', sliceIndex: 136, tolerance: 4 },
  { examination: 13, plane: 'AX', sliceIndex: 80, tolerance: 3 },
  { examination: 15, plane: 'AX', sliceIndex: 91, tolerance: 2 },
  { examination: 15, plane: 'COR', sliceIndex: 103, tolerance: 3 },
  { examination: 15, plane: 'SAG', sliceIndex: 134, tolerance: 4 },
  { examination: 17, plane: 'AX', sliceIndex: 96, tolerance: 2 },
] as const;

const REVIEWED_EXTENSIONLESS_AXIAL = {
  reference: { examination: 18, plane: 'AX', sliceIndex: 78 },
  exclusion: { x: 0.445, y: 0.407, width: 0.116, height: 0.092 },
  targets: [
    { examination: 15, plane: 'AX', sliceIndex: 90, tolerance: 2 },
    { examination: 17, plane: 'AX', sliceIndex: 94, tolerance: 2 },
  ],
} as const;

const desktopRoot = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR;
const protectedRoot = process.env.MIRAVIEWER_ALIGNMENT_CORPUS_DIR;
const includeExtensionlessDicom = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_INCLUDE_EXTENSIONLESS === '1';
const runDesktopCorpus = desktopRoot && protectedRoot ? it : it.skip;
const DARK_ANATOMY_THRESHOLD = 0.12;

function longestPlane(series: AlignmentCorpusSeries[], plane: AlignmentCorpusPlane) {
  return series
    .filter((source) => source.plane === plane)
    .sort((left, right) => right.frames.length - left.frames.length)[0];
}

function representativeExaminations<T>(sources: T[], limit: number): T[] {
  if (sources.length <= limit) return sources;
  return Array.from(
    { length: limit },
    (_, index) => sources[Math.round((index * (sources.length - 1)) / (limit - 1))]!,
  );
}

function largestDarkComponent(pixels: Float32Array, validity: Float32Array, side: Uint8Array, columns: number): number {
  const visited = new Uint8Array(pixels.length);
  const queue = new Uint32Array(pixels.length);
  let largest = 0;
  for (let start = 0; start < pixels.length; start++) {
    if (visited[start] || !side[start] || validity[start]! < 0.5 || pixels[start]! >= DARK_ANATOMY_THRESHOLD) {
      continue;
    }
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++]!;
      const column = index % columns;
      for (const neighbor of [index - 1, index + 1, index - columns, index + columns]) {
        if (
          neighbor < 0 ||
          neighbor >= pixels.length ||
          Math.abs((neighbor % columns) - column) > 1 ||
          visited[neighbor] ||
          !side[neighbor] ||
          validity[neighbor]! < 0.5 ||
          pixels[neighbor]! >= DARK_ANATOMY_THRESHOLD
        ) {
          continue;
        }
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    largest = Math.max(largest, tail);
  }
  return largest;
}

function finalDerivedAnatomy(result: AlignmentPhysicalGoldenSuccess) {
  const reference = result.nativeReferences[result.nativeReferenceSliceIndex]!;
  const prepared = prepareAnatomicalPlaneLandmarks(
    {
      pixels: reference.pixels,
      rows: reference.dsRows,
      cols: reference.dsCols,
      valid: reference.valid,
      ippMm: reference.ippMm,
      rowDir: reference.rowDir,
      colDir: reference.colDir,
      rowSpacingDsMm: reference.rowSpacingDsMm,
      colSpacingDsMm: reference.colSpacingDsMm,
    },
    result.reference.exclusionMask,
  );
  if (!prepared?.bilateral) return undefined;

  const scaled = resample2dAreaAverageWithValidity(
    result.dense.pixels,
    result.dense.valid,
    result.dense.rows,
    result.dense.cols,
    prepared.size,
    prepared.size,
  );
  const normalized = normalizePerceptualSource(scaled.pixels, prepared.size, {
    exclusionRect: prepared.exclusionRect,
    validity: scaled.validity,
  });
  const sides = prepared.bilateral.sides.map((side, sideIndex) => {
    let referenceDark = 0;
    let candidateDark = 0;
    let sharedDark = 0;
    for (let index = 0; index < side.length; index++) {
      if (!side[index] || scaled.validity[index]! < 0.5) continue;
      const fixed = prepared.pixels[index]! < DARK_ANATOMY_THRESHOLD;
      const moving = normalized[index]! < DARK_ANATOMY_THRESHOLD;
      referenceDark += Number(fixed);
      candidateDark += Number(moving);
      sharedDark += Number(fixed && moving);
    }
    return {
      referenceArea: prepared.bilateral!.components[sideIndex]!.area,
      candidateArea: largestDarkComponent(normalized, scaled.validity, side, prepared.size),
      sharedDark,
      dice: Number(((2 * sharedDark) / Math.max(1, referenceDark + candidateDark)).toFixed(4)),
    };
  });
  return {
    score: Number(scoreAnatomicalPlaneLandmarks(prepared, result.dense).toFixed(4)),
    reliable: prepared.bilateral.reliable,
    sides,
  };
}

function renderDerivedComparison(result: AlignmentPhysicalGoldenSuccess, target: AlignmentCorpusSeries): void {
  const reference = result.nativeReferences[result.nativeReferenceSliceIndex]!;
  const referenceFrame = result.reference.series.frames[result.reference.frameIndex]!;
  const targetFrame = target.frames[result.selectedIndex]!;
  const sourcePosition = result.nativeTargetIndices.indexOf(result.selectedIndex);
  const acquired = result.nativeTargets[sourcePosition];
  if (!acquired) return;
  const referenceLabel = `E${String(result.reference.series.examinationOrdinal).padStart(2, '0')}`;
  const targetLabel = `E${String(target.examinationOrdinal).padStart(2, '0')}`;
  writeAlignmentComparisonSheet(
    resolve('tmp/alignment-golden'),
    `${referenceLabel.toLowerCase()}-${targetLabel.toLowerCase()}${target.plane === 'AX' ? '' : `-${target.plane.toLowerCase()}`}-final-derived-presentation`,
    [
      {
        label: `${referenceLabel} REFERENCE ${result.reference.frameIndex}`,
        pixels: reference.pixels,
        rows: reference.dsRows,
        columns: reference.dsCols,
        windowCenter: referenceFrame.windowCenter,
        windowWidth: referenceFrame.windowWidth,
      },
      {
        label: `${targetLabel} ACQUIRED ${result.selectedIndex}`,
        pixels: acquired.pixels,
        rows: acquired.dsRows,
        columns: acquired.dsCols,
        windowCenter: targetFrame.windowCenter,
        windowWidth: targetFrame.windowWidth,
      },
      {
        label: `${targetLabel} FINAL DERIVED ${result.selectedIndex}`,
        pixels: result.dense.pixels,
        valid: result.dense.valid,
        rows: result.dense.rows,
        columns: result.dense.cols,
        windowCenter: targetFrame.windowCenter,
        windowWidth: targetFrame.windowWidth,
      },
    ],
    3,
  );
}

describe('deidentified longitudinal MRI desktop gold', () => {
  it('keeps reviewed landmarks anonymous, bounded, and examination-specific', () => {
    expect(REVIEWED_PROTECTED_AXIAL_LANDMARKS.map(({ examination }) => examination)).toEqual([1, 2, 3, 4]);
    expect(
      REVIEWED_REFERENCE_LANDMARKS.filter(({ examination }) => examination === 1).map(({ plane }) => plane),
    ).toEqual(['AX', 'COR', 'SAG']);
    expect(REVIEWED_REFERENCE_LANDMARKS.find(({ examination }) => examination === 14)).toEqual({
      examination: 14,
      plane: 'AX',
      sliceIndex: 93,
    });
    expect(new Set(REVIEWED_DESKTOP_LANDMARKS.map(({ examination }) => examination))).toEqual(
      new Set([5, 9, 13, 15, 17]),
    );
    expect(new Set(REVIEWED_DESKTOP_LANDMARKS.map(({ plane }) => plane))).toEqual(new Set(['AX', 'COR', 'SAG']));
    expect(
      REVIEWED_DESKTOP_LANDMARKS.every(
        ({ sliceIndex, tolerance }) => Number.isSafeInteger(sliceIndex) && tolerance >= 2 && tolerance <= 4,
      ),
    ).toBe(true);
    expect(REVIEWED_EXTENSIONLESS_AXIAL.reference).toEqual({ examination: 18, plane: 'AX', sliceIndex: 78 });
    expect(
      REVIEWED_EXTENSIONLESS_AXIAL.targets.map(({ examination, sliceIndex }) => [examination, sliceIndex]),
    ).toEqual([
      [15, 90],
      [17, 94],
    ]);
  });

  runDesktopCorpus(
    'validates reviewed acquired and final-derived anatomy across anonymous same-patient MRI examinations',
    async () => {
      const focusedStudyOrdinals = new Set(
        [
          ...(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_STUDY_ORDINALS ?? '').split(','),
          ...(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_REFERENCE &&
          process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_TARGET
            ? [
                process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_REFERENCE,
                process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_TARGET,
              ]
            : []),
        ]
          .map(Number)
          .filter((ordinal) => Number.isSafeInteger(ordinal) && ordinal > 0),
      );
      const protectedSeries = inspectAlignmentCorpus(protectedRoot!);
      const protectedPatients = new Set(protectedSeries.map(({ patientKey }) => patientKey));
      expect(protectedPatients.size).toBe(1);
      const patientKey = protectedPatients.values().next().value as string;
      const protectedExaminations = new Map(
        protectedSeries.map(({ studyUid, examinationOrdinal }) => [studyUid, examinationOrdinal]),
      );
      const desktopSeries = inspectAlignmentCorpus(desktopRoot!, {
        ...(focusedStudyOrdinals.size ? { studyOrdinals: focusedStudyOrdinals } : {}),
        ...(includeExtensionlessDicom ? { includeExtensionlessDicom: true } : {}),
      }).filter((source) => source.patientKey === patientKey && /flair/i.test(source.contrast));
      const grouped = new Map<string, AlignmentCorpusSeries[]>();
      for (const source of desktopSeries) {
        const series = grouped.get(source.studyUid) ?? [];
        series.push(source);
        grouped.set(source.studyUid, series);
      }
      const examinations = Array.from(grouped.values())
        .map((series) => ({
          examination: series[0]!.examinationOrdinal,
          studyUid: series[0]!.studyUid,
          AX: longestPlane(series, 'AX'),
          COR: longestPlane(series, 'COR'),
          SAG: longestPlane(series, 'SAG'),
        }))
        .filter(({ AX, COR, SAG }) => AX && COR && SAG)
        .sort((left, right) => left.examination - right.examination);
      const additional = examinations.filter(({ studyUid }) => !protectedExaminations.has(studyUid));
      expect(examinations.length).toBeGreaterThanOrEqual(
        focusedStudyOrdinals.size || REVIEWED_PROTECTED_AXIAL_LANDMARKS.length,
      );
      if (!focusedStudyOrdinals.size) expect(additional.length).toBeGreaterThan(0);

      const referenceLandmarks = includeExtensionlessDicom
        ? [...REVIEWED_REFERENCE_LANDMARKS, REVIEWED_EXTENSIONLESS_AXIAL.reference]
        : REVIEWED_REFERENCE_LANDMARKS;
      const reviewed = new Map<string, AlignmentCorpusSeries>();
      for (const landmark of [...referenceLandmarks, ...REVIEWED_DESKTOP_LANDMARKS]) {
        if (focusedStudyOrdinals.size && !focusedStudyOrdinals.has(landmark.examination)) continue;
        const examination = examinations.find(({ examination }) => examination === landmark.examination);
        const source = examination?.[landmark.plane];
        expect(source).toBeDefined();
        expect(landmark.sliceIndex).toBeLessThan(source!.frames.length);
        reviewed.set(`${landmark.examination}:${landmark.plane}`, source!);
      }

      const requestedLimit = Number(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_AXIAL_LIMIT ?? 4);
      const representatives = representativeExaminations(
        additional.length ? additional : examinations,
        Number.isSafeInteger(requestedLimit) && requestedLimit > 1 ? requestedLimit : 4,
      );
      const requestedOrdinals = new Set(
        (process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_REVIEW_EXAMINATIONS ?? '')
          .split(',')
          .map(Number)
          .filter((ordinal) => Number.isSafeInteger(ordinal) && ordinal > 0),
      );
      const selectedExaminations = requestedOrdinals.size
        ? examinations.filter(({ examination }) => requestedOrdinals.has(examination))
        : representatives;
      const reviewSeries = selectedExaminations.map(({ AX }) => AX!);
      if (!requestedOrdinals.size) {
        const highResolution = examinations.find(({ SAG }) => Math.max(SAG!.rows, SAG!.columns) >= 1024);
        for (const ordinal of new Set([representatives.at(-1)!.examination, highResolution?.examination])) {
          const examination = examinations.find((source) => source.examination === ordinal);
          if (examination) reviewSeries.push(examination.COR!, examination.SAG!);
        }
      }

      const renderSheets = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_CONTACT_SHEETS === '1';
      const runPhysicalGold = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_PHYSICAL_GOLD === '1';
      const codec = renderSheets || runPhysicalGold ? loadAlignmentLosslessCodec() : undefined;
      let renderedSheets = 0;
      if (renderSheets) {
        for (const source of reviewSeries) {
          const center = Math.round(source.frames.length * (source.plane === 'AX' ? 0.45 : 0.5));
          const indices = Array.from({ length: 21 }, (_, index) => center + (index - 10) * 2).filter(
            (index) => index >= 0 && index < source.frames.length,
          );
          await writeAlignmentContactSheet(resolve('tmp/alignment-golden'), source, codec!, {
            indices,
            tileSize: 512,
            columns: 5,
            suffix: 'desktop-focus-native',
          });
          renderedSheets++;
        }
      }

      console.log(
        `[alignment-desktop] ${JSON.stringify({
          completeThreePlaneExaminations: examinations.length,
          additionalExaminations: additional.length,
          protectedMapping: examinations
            .filter(({ studyUid }) => protectedExaminations.has(studyUid))
            .map(({ examination, studyUid }) => ({
              protectedExamination: protectedExaminations.get(studyUid),
              desktopExamination: examination,
            })),
          reviewCohorts: reviewSeries.map(({ examinationOrdinal, plane, frames, rows, columns }) => ({
            examination: examinationOrdinal,
            plane,
            images: frames.length,
            dimensions: [rows, columns],
          })),
          renderedSheets,
        })}`,
      );
      if (!runPhysicalGold) return;

      const requestedCases = Number(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_LIMIT ?? Number.MAX_SAFE_INTEGER);
      const caseLimit = Number.isSafeInteger(requestedCases) && requestedCases > 0 ? requestedCases : 13;
      const references = [
        ...referenceLandmarks,
        ...REVIEWED_DESKTOP_LANDMARKS.filter(({ examination }) => examination === 9),
      ];
      const goldCases = new Set((process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_CASES ?? '').split(',').filter(Boolean));
      const failures: string[] = [];
      let caseCount = 0;

      for (const sourceLandmark of references) {
        if (caseCount >= caseLimit) break;
        if (
          (focusedStudyOrdinals.size > 0 && !focusedStudyOrdinals.has(sourceLandmark.examination)) ||
          (process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_REFERENCE &&
            sourceLandmark.examination !== Number(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_REFERENCE)) ||
          (process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_PLANE &&
            !process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_PLANE.split(',').includes(sourceLandmark.plane))
        ) {
          continue;
        }
        const reviewedTargets =
          sourceLandmark.examination === REVIEWED_EXTENSIONLESS_AXIAL.reference.examination
            ? REVIEWED_EXTENSIONLESS_AXIAL.targets
            : REVIEWED_DESKTOP_LANDMARKS;
        const targets = reviewedTargets.filter(
          (target) =>
            target.plane === sourceLandmark.plane &&
            (!focusedStudyOrdinals.size || focusedStudyOrdinals.has(target.examination)) &&
            (sourceLandmark.examination === 1
              ? target.examination !== 17
              : sourceLandmark.examination === 14 ||
                  sourceLandmark.examination === REVIEWED_EXTENSIONLESS_AXIAL.reference.examination
                ? target.examination === 15 || target.examination === 17
                : target.examination === 15) &&
            (!goldCases.size || goldCases.has(`${sourceLandmark.examination}:${target.examination}:${target.plane}`)) &&
            (!process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_TARGET ||
              target.examination === Number(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_GOLD_TARGET)),
        );
        if (!targets.length) continue;
        const source = reviewed.get(`${sourceLandmark.examination}:${sourceLandmark.plane}`)!;
        const reference = await prepareAlignmentPhysicalReference(source, sourceLandmark.sliceIndex, codec!, {
          exclusion:
            sourceLandmark.examination === REVIEWED_EXTENSIONLESS_AXIAL.reference.examination
              ? REVIEWED_EXTENSIONLESS_AXIAL.exclusion
              : { x: 0.36, y: 0.34, width: 0.28, height: 0.32 },
        });
        const outputGrid = buildOutputPlaneGrid(reference.manifest.frames[reference.frameIndex]!, {
          mode: 'native',
          ...(reference.manifest.frameOfReferenceUid
            ? { frameOfReferenceUid: reference.manifest.frameOfReferenceUid }
            : {}),
        });

        for (const targetLandmark of targets) {
          if (caseCount >= caseLimit) break;
          caseCount++;
          const target = reviewed.get(`${targetLandmark.examination}:${targetLandmark.plane}`)!;
          const caseLabel =
            `E${String(sourceLandmark.examination).padStart(2, '0')}-${sourceLandmark.plane}${sourceLandmark.sliceIndex}_` +
            `E${String(targetLandmark.examination).padStart(2, '0')}-${targetLandmark.plane}${targetLandmark.sliceIndex}`;
          const result = await runAlignmentPhysicalGoldenCase(reference, target, {
            outputGrid,
            ...(process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_TUMOR_FOCUS === '1'
              ? { alignmentFocus: 'tumor' as const }
              : {}),
          });
          if (!result.ok) {
            failures.push(`${caseLabel}: ${result.phase} ${result.failure.reason}`);
            console.log(
              `[alignment-desktop-physical-failure] ${JSON.stringify({ case: caseLabel, phase: result.phase })}`,
            );
            continue;
          }

          expect(result.dense.outputGrid).toEqual(outputGrid);
          expect([result.dense.rows, result.dense.cols]).toEqual([outputGrid.rows, outputGrid.columns]);
          expect(result.dense.valid.every((support) => support === 0 || support === 1)).toBe(true);

          const landmarkError = Math.abs(result.selectedIndex - targetLandmark.sliceIndex);
          if (landmarkError > targetLandmark.tolerance) {
            failures.push(
              `${caseLabel}: selected ${result.selectedIndex}, expected ${targetLandmark.sliceIndex} ± ${targetLandmark.tolerance}`,
            );
          }
          const anatomy = sourceLandmark.plane === 'AX' ? finalDerivedAnatomy(result) : undefined;
          if (sourceLandmark.examination === REVIEWED_EXTENSIONLESS_AXIAL.reference.examination) {
            const nativeReference = result.nativeReferences[result.nativeReferenceSliceIndex]!;
            const sourcePixels = resample2dAreaAverageWithValidity(
              nativeReference.pixels,
              nativeReference.valid ?? new Uint8Array(nativeReference.pixels.length).fill(1),
              nativeReference.dsRows,
              nativeReference.dsCols,
              256,
              256,
            );
            const targetPixels = resample2dAreaAverageWithValidity(
              result.dense.pixels,
              result.dense.valid,
              result.dense.rows,
              result.dense.cols,
              256,
              256,
            );
            const fixedDisplay = windowDisplayPixels(
              sourcePixels.pixels,
              reference.series.frames[reference.frameIndex],
            );
            const targetDisplay = windowDisplayPixels(targetPixels.pixels, target.frames[result.selectedIndex]);
            const displayStats =
              fixedDisplay && targetDisplay
                ? computeCorrespondingDisplayStats(fixedDisplay, targetDisplay, {
                    referenceValidity: sourcePixels.validity,
                    movingValidity: targetPixels.validity,
                    exclusionRect: REVIEWED_EXTENSIONLESS_AXIAL.exclusion,
                    columns: 256,
                  })
                : null;
            if (!displayStats) {
              failures.push(`${caseLabel}: the corresponding native display windows lack supported healthy anatomy`);
            } else {
              const match = computeIntensityMatch(displayStats.reference, displayStats.moving);
              const brightness = match.brightness / 100;
              const contrast = match.contrast / 100;
              const matchedMean = displayStats.moving.mean * brightness * contrast + 0.5 * (1 - contrast);
              const matchedDeviation = displayStats.moving.stddev * brightness * contrast;
              if (Math.abs(matchedMean - displayStats.reference.mean) > 0.015) {
                failures.push(`${caseLabel}: focused displayed tissue brightness no longer matches its reference`);
              }
              if (Math.abs(matchedDeviation - displayStats.reference.stddev) > 0.015) {
                failures.push(`${caseLabel}: focused displayed tissue contrast no longer matches its reference`);
              }
            }
            if (targetLandmark.examination === 17 && anatomy) {
              const referenceArea = anatomy.sides.reduce((sum, side) => sum + side.referenceArea, 0);
              const candidateArea = anatomy.sides.reduce((sum, side) => sum + side.candidateArea, 0);
              if (anatomy.score < 0.68 || candidateArea > referenceArea * 1.5) {
                failures.push(`${caseLabel}: anchor-preserving tilt no longer matches the reviewed local anatomy`);
              }
            }
          }
          if (sourceLandmark.examination === 14) {
            if (result.dense.coverage < 0.95) {
              failures.push(
                `${caseLabel}: final acquired anatomical support ${result.dense.coverage.toFixed(3)} < 0.950`,
              );
            }
          }
          if (
            sourceLandmark.plane === 'AX' &&
            (!anatomy ||
              (anatomy.reliable &&
                anatomy.sides.some(
                  ({ referenceArea, candidateArea, sharedDark }) =>
                    sharedDark === 0 || candidateArea < referenceArea * 0.35,
                )))
          ) {
            failures.push(`${caseLabel}: final derived presentation does not preserve both acquired orbital cavities`);
          }
          if (anatomy && !anatomy.reliable) {
            if (!(anatomy.score >= 0.3)) {
              failures.push(`${caseLabel}: final exclusion-safe local anatomy score ${anatomy.score} < 0.300`);
            }
            if (result.dense.coverage < 0.95) {
              failures.push(
                `${caseLabel}: final acquired anatomical support ${result.dense.coverage.toFixed(3)} < 0.950`,
              );
            }
          }
          if (process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_RENDER_RESULTS === '1') {
            renderDerivedComparison(result, target);
          }
          console.log(
            `[alignment-desktop-physical-gold] ${JSON.stringify({
              case: caseLabel,
              targetDimensions: [target.rows, target.columns],
              predictedIndex: result.predictedIndex,
              selectedIndex: result.selectedIndex,
              expectedIndex: targetLandmark.sliceIndex,
              tolerance: targetLandmark.tolerance,
              landmarkError,
              coverage: Number(result.dense.coverage.toFixed(4)),
              coarseMilliseconds: Number(result.coarseMilliseconds.toFixed(1)),
              nativeMilliseconds: Number(result.nativeMilliseconds.toFixed(1)),
              nativeReferenceFrames: result.nativeReferences.length,
              nativeTargetFrames: result.nativeTargets.length,
              ...(anatomy ? { derivedAnatomy: anatomy } : {}),
            })}`,
          );
        }
      }

      console.log(`[alignment-desktop-physical-summary] ${JSON.stringify({ cases: caseCount, failures })}`);
      expect(failures).toEqual([]);
    },
    300_000,
  );
});
