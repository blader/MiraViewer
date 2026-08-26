import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  choosePerceptualWinner,
  normalizePerceptualSource,
  preparePerceptualReference,
  rankFixedCandidateSet,
  scoreAlignedCandidate,
} from '../src/utils/perceptualSliceSimilarity';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import {
  makeTissueLabelPhantom,
  REFERENCE_CONTRAST,
  relocateInternalStructures,
  renderTissueContrast,
} from './helpers/alignmentSynthetic';
import {
  decodeAlignmentCorpusFrame,
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
  prepareAlignmentPhysicalReference,
  runAlignmentPhysicalGoldenCase,
  writeAlignmentComparisonSheet,
  writeAlignmentContactSheet,
} from './helpers/alignmentRealCorpus';

const corpusDirectory = process.env.MIRAVIEWER_ALIGNMENT_CORPUS_DIR;
const runRealCorpus = corpusDirectory ? it : it.skip;
const runPhysicalGold = corpusDirectory && process.env.MIRAVIEWER_ALIGNMENT_PHYSICAL_GOLD === '1' ? it : it.skip;
const runCoronalProfile = corpusDirectory && process.env.MIRAVIEWER_ALIGNMENT_CORONAL_PROFILE === '1' ? it : it.skip;

const VISUALLY_REVIEWED_LANDMARKS = [
  { examinationOrdinal: 1, plane: 'AX', index: 100, tolerance: 2 },
  { examinationOrdinal: 2, plane: 'AX', index: 98, tolerance: 2 },
  { examinationOrdinal: 3, plane: 'AX', index: 96, tolerance: 2 },
  { examinationOrdinal: 4, plane: 'AX', index: 96, tolerance: 2 },
  { examinationOrdinal: 1, plane: 'COR', index: 110, tolerance: 2 },
  { examinationOrdinal: 1, plane: 'SAG', index: 150, tolerance: 3 },
] as const;

describe('private real-MRI alignment golden validation', () => {
  it('preserves the portable structural-golden distinction without private MRI source data', () => {
    const size = 64;
    const labels = makeTissueLabelPhantom(size);
    const reference = normalizePerceptualSource(renderTissueContrast(labels, REFERENCE_CONTRAST), size);
    const prepared = preparePerceptualReference(reference, size, { scales: [64, 32] });
    const wrong = normalizePerceptualSource(
      renderTissueContrast(relocateInternalStructures(labels, size), REFERENCE_CONTRAST),
      size,
    );
    const validity = new Float32Array(size * size).fill(1);
    const ranked = rankFixedCandidateSet(
      [
        { index: 4, components: scoreAlignedCandidate(prepared, reference, validity, size) },
        { index: 5, components: scoreAlignedCandidate(prepared, wrong, validity, size) },
      ],
      5,
    );

    expect(choosePerceptualWinner(ranked, 5).index).toBe(4);
    expect(ranked.find((candidate) => candidate.index === 4)?.structuralRank).toBeGreaterThan(
      ranked.find((candidate) => candidate.index === 5)?.structuralRank ?? 0,
    );
  });

  runCoronalProfile(
    'profiles an acquired coronal reference against an identical distinct-frame target',
    async () => {
      const started = performance.now();
      const series = inspectAlignmentCorpus(corpusDirectory!);
      console.log(
        '[alignment-coronal-profile-index] ' +
          JSON.stringify({
            indexedSeries: series.length,
            elapsedMilliseconds: Number((performance.now() - started).toFixed(1)),
          }),
      );
      const source = series.find((entry) => entry.examinationOrdinal === 1 && entry.plane === 'COR');
      if (!source) throw new Error('The protected reference examination has no coronal acquisition');
      const codec = loadAlignmentLosslessCodec();
      const referenceStarted = performance.now();
      const reference = await prepareAlignmentPhysicalReference(source, 110, codec);
      const target = { ...source, frameOfReferenceUid: 'alignment-profile-distinct-frame' };
      const targetSlices = reference.slices.map((slice) => ({
        ...slice,
        frameOfReferenceUid: target.frameOfReferenceUid,
      }));
      const outputGrid = buildOutputPlaneGrid(reference.manifest.frames[reference.frameIndex]!, {
        mode: 'native',
        frameOfReferenceUid: reference.manifest.frameOfReferenceUid,
      });
      console.log(
        '[alignment-coronal-profile-start] ' +
          JSON.stringify({
            indexedSeries: series.length,
            rows: source.rows,
            columns: source.columns,
            referenceDecodeMilliseconds: Number((performance.now() - referenceStarted).toFixed(1)),
            reusedTargetSlices: targetSlices.length,
            elapsedMilliseconds: Number((performance.now() - started).toFixed(1)),
          }),
      );
      const result = await runAlignmentPhysicalGoldenCase(reference, target, { outputGrid, targetSlices });
      console.log(
        '[alignment-coronal-profile-result] ' +
          JSON.stringify({
            ok: result.ok,
            coarseMilliseconds: Number(result.coarseMilliseconds.toFixed(1)),
            ...(result.nativeMilliseconds === undefined
              ? {}
              : { nativeMilliseconds: Number(result.nativeMilliseconds.toFixed(1)) }),
            ...(result.ok
              ? { selectedIndex: result.selectedIndex, coverage: Number(result.dense.coverage.toFixed(4)) }
              : { phase: result.phase, reason: result.failure.reason }),
          }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Math.abs(result.selectedIndex - reference.frameIndex)).toBeLessThanOrEqual(2);
      expect(result.dense.coverage).toBeGreaterThan(0.55);
    },
    120_000,
  );

  runRealCorpus(
    'inspects every acquired examination and optionally renders deidentified visual-review contact sheets',
    async () => {
      const series = inspectAlignmentCorpus(corpusDirectory!);
      const examinations = new Set(series.map((source) => source.studyUid));
      const planes = new Set(series.map((source) => source.plane));
      const axialExaminations = new Set(
        series.filter((source) => source.plane === 'AX').map((source) => source.studyUid),
      );

      expect(series.length).toBeGreaterThanOrEqual(3);
      expect(examinations.size).toBeGreaterThanOrEqual(2);
      expect(axialExaminations.size).toBeGreaterThanOrEqual(2);
      expect(planes.has('AX')).toBe(true);

      let decodedFrames = 0;
      let compressedFrames = 0;
      let sheetCount = 0;
      if (process.env.MIRAVIEWER_ALIGNMENT_CONTACT_SHEETS === '1') {
        const codec = loadAlignmentLosslessCodec();
        const output = resolve('tmp/alignment-golden');
        for (const source of series) {
          const sheet = await writeAlignmentContactSheet(output, source, codec);
          decodedFrames += sheet.decodedFrames;
          compressedFrames += sheet.compressedFrames;
          sheetCount++;
          const [first, last] = source.plane === 'AX' ? [80, 118] : source.plane === 'COR' ? [94, 128] : [132, 168];
          const focus = Array.from(
            { length: Math.floor((last - first) / 2) + 1 },
            (_, index) => first + index * 2,
          ).filter((index) => index < source.frames.length);
          for (const options of [
            { indices: focus, tileSize: 512, columns: 5, suffix: 'focus-native' },
            { indices: focus, cropSize: 192, tileSize: 256, columns: 6, suffix: 'focus-center' },
          ]) {
            const focused = await writeAlignmentContactSheet(output, source, codec, options);
            decodedFrames += focused.decodedFrames;
            compressedFrames += focused.compressedFrames;
            sheetCount++;
          }
        }
      }

      console.log(
        '[alignment-corpus] ' +
          JSON.stringify({
            examinations: examinations.size,
            series: series.length,
            acquiredPlanes: [...planes].sort(),
            longitudinalAxialExaminations: axialExaminations.size,
            acquiredFrames: series.reduce((count, source) => count + source.frames.length, 0),
            contactSheets: sheetCount,
            decodedFrames,
            compressedFrames,
          }),
      );
    },
    60_000,
  );

  runPhysicalGold(
    'aligns visually reviewed native tumor slices using the production physical 3D coarse and native paths',
    async () => {
      const series = inspectAlignmentCorpus(corpusDirectory!);
      const codec = loadAlignmentLosslessCodec();
      const reviewedReference = VISUALLY_REVIEWED_LANDMARKS[0];
      const referenceSeries = series.find(
        (source) => source.examinationOrdinal === reviewedReference.examinationOrdinal && source.plane === 'AX',
      );
      if (!referenceSeries) throw new Error('The visually reviewed reference examination has no axial acquisition');
      const preparedReference = await prepareAlignmentPhysicalReference(
        referenceSeries,
        reviewedReference.index,
        codec,
        {
          exclusion: { x: 0.36, y: 0.34, width: 0.28, height: 0.32 },
        },
      );
      const targets = VISUALLY_REVIEWED_LANDMARKS.filter(
        (landmark) =>
          landmark.plane === 'AX' &&
          landmark.examinationOrdinal !== reviewedReference.examinationOrdinal &&
          (!process.env.MIRAVIEWER_ALIGNMENT_GOLD_EXAMINATION ||
            process.env.MIRAVIEWER_ALIGNMENT_GOLD_EXAMINATION.split(',').includes(String(landmark.examinationOrdinal))),
      ).slice(0, Math.max(1, Number(process.env.MIRAVIEWER_ALIGNMENT_GOLD_LIMIT ?? 3)));
      const observedErrors: number[] = [];

      for (const reviewedTarget of targets) {
        const targetSeries = series.find(
          (source) => source.examinationOrdinal === reviewedTarget.examinationOrdinal && source.plane === 'AX',
        );
        if (!targetSeries) throw new Error('A visually reviewed target examination has no axial acquisition');
        expect(targetSeries.patientKey).toBe(referenceSeries.patientKey);
        const result = await runAlignmentPhysicalGoldenCase(preparedReference, targetSeries);
        const caseLabel =
          'E01-AX' +
          reviewedReference.index +
          '_E' +
          String(reviewedTarget.examinationOrdinal).padStart(2, '0') +
          '-AX' +
          reviewedTarget.index;
        if (!result.ok) {
          console.log(
            '[alignment-physical-failure] ' +
              JSON.stringify({
                case: caseLabel,
                phase: result.phase,
                reason: result.failure.reason,
                message: result.failure.message,
                coarseIndex: result.predictedIndex,
                coarseMilliseconds: Number(result.coarseMilliseconds.toFixed(1)),
                ...(result.nativeMilliseconds === undefined
                  ? {}
                  : { nativeMilliseconds: Number(result.nativeMilliseconds.toFixed(1)) }),
              }),
          );
          expect(result.ok).toBe(true);
          continue;
        }

        const { coarse, dense, predictedIndex, selectedIndex, coarseMilliseconds, nativeMilliseconds } = result;
        const error = Math.abs(selectedIndex - reviewedTarget.index);
        console.log(
          '[alignment-physical-gold] ' +
            JSON.stringify({
              case: caseLabel,
              expectedIndex: reviewedTarget.index,
              coarseIndex: predictedIndex,
              selectedIndex,
              absoluteIndexError: error,
              frameRelationship: coarse.provenance.frameRelationship,
              coarseMilliseconds: Number(coarseMilliseconds.toFixed(1)),
              nativeMilliseconds: Number(nativeMilliseconds.toFixed(1)),
              optimizedHypothesisCount: coarse.diagnostics.optimizedHypothesisCount,
              evaluatedCandidates: coarse.diagnostics.evaluatedCandidates,
              coarseScore: Number(coarse.score.toFixed(4)),
              nativeHeldOutScore: Number((dense.nativeRefinement?.heldOutScore ?? 0).toFixed(4)),
              nativeForwardScore: Number((dense.nativeRefinement?.heldOutForwardScore ?? 0).toFixed(4)),
              nativeReverseScore: Number((dense.nativeRefinement?.heldOutReverseScore ?? 0).toFixed(4)),
              coverage: Number(dense.coverage.toFixed(4)),
              inverseConsistencyErrorMm: Number((coarse.diagnostics.inverseConsistencyErrorMm ?? 0).toFixed(3)),
              nativeCandidatePoses: coarse.nativeCandidatePoses?.length ?? 1,
              sourceSlices:
                result.reference.sourceIndices.length +
                result.targetSourceIndices.length +
                result.nativeReferences.length +
                result.nativeTargetIndices.length,
            }),
        );

        if (process.env.MIRAVIEWER_ALIGNMENT_COMPARISON_SHEETS === '1') {
          const referenceFrame = referenceSeries.frames[reviewedReference.index]!;
          const reference = result.nativeReferences[result.nativeReferenceSliceIndex]!;
          const native = await Promise.all(
            [...new Set([reviewedTarget.index - 2, reviewedTarget.index, reviewedTarget.index + 2, selectedIndex])]
              .filter((index) => index >= 0 && index < targetSeries.frames.length)
              .map(async (index) => {
                const frame = targetSeries.frames[index]!;
                return {
                  label: 'E' + reviewedTarget.examinationOrdinal + ' NATIVE AX ' + index,
                  ...(await decodeAlignmentCorpusFrame(frame, codec)),
                  windowCenter: frame.windowCenter,
                  windowWidth: frame.windowWidth,
                };
              }),
          );
          writeAlignmentComparisonSheet(resolve('tmp/alignment-golden'), caseLabel.toLowerCase(), [
            {
              label: 'E01 REF AX ' + reviewedReference.index,
              pixels: reference.pixels,
              rows: reference.dsRows,
              columns: reference.dsCols,
              windowCenter: referenceFrame.windowCenter,
              windowWidth: referenceFrame.windowWidth,
            },
            ...native,
            {
              label: 'E' + reviewedTarget.examinationOrdinal + ' ALIGNED AX ' + selectedIndex,
              pixels: dense.pixels,
              valid: dense.valid,
              rows: dense.rows,
              columns: dense.cols,
              windowCenter: targetSeries.frames[reviewedTarget.index]!.windowCenter,
              windowWidth: targetSeries.frames[reviewedTarget.index]!.windowWidth,
            },
          ]);
        }

        expect(dense.rows).toBe(referenceSeries.rows);
        expect(dense.cols).toBe(referenceSeries.columns);
        expect(dense.valid.length).toBe(dense.pixels.length);
        expect(dense.coverage).toBeGreaterThan(0.55);
        observedErrors.push(error);
      }

      expect(observedErrors).toHaveLength(targets.length);
      expect(observedErrors.every((error, index) => error <= targets[index]!.tolerance)).toBe(true);
    },
    120_000,
  );
});
