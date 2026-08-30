import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateGoldenSection,
  goldenCrossPlaneConflicts,
  goldenSectionFailures,
  rasterizeGoldenSection,
  type GoldenSection,
  type GoldenVolumeSection,
} from './helpers/segmentationGolden';

const rectangle = (left: number, top: number, right: number, bottom: number) =>
  [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ] as const;
const definition = (overrides: Partial<GoldenSection> = {}): GoldenSection => ({
  columns: 10,
  rows: 10,
  origin: [0, 0],
  spacingMm: [1, 1],
  polygons: [rectangle(2.5, 2.5, 6.5, 6.5)],
  boundaryUncertaintyMm: 0,
  auditMarginMm: 1,
  ...overrides,
});

describe('source-first segmentation golden evaluator', () => {
  it('independently rasterizes native cell centers and gives an exact cell-boundary mask full overlap', () => {
    const golden = rasterizeGoldenSection(definition());
    const expected = Uint8Array.from({ length: 100 }, (_, index) =>
      Number(index % 10 >= 3 && index % 10 <= 6 && Math.floor(index / 10) >= 3 && Math.floor(index / 10) <= 6),
    );
    expect(golden.target).toEqual(expected);
    const result = evaluateGoldenSection(golden, expected);
    expect(result.full).toEqual({
      truePositive: 16,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 84,
      precision: 1,
      recall: 1,
      specificity: 1,
      dice: 1,
      iou: 1,
    });
    expect(result.boundaryMm.maximum).toBe(0);
    expect(goldenSectionFailures(result)).toEqual([]);
  });

  it('measures the uncertainty band in physical millimeters, not pixels', () => {
    const golden = rasterizeGoldenSection(definition({ spacingMm: [2, 0.5], boundaryUncertaintyMm: 0.6 }));
    expect(golden.confidence[4 * 10 + 3]).toBe(1);
    expect(golden.confidence[3 * 10 + 4]).toBe(0);
    expect(golden.confidence[4 * 10 + 2]).toBe(2);
    expect(golden.excluded.boundaryUncertainty).toBeGreaterThan(0);
    expect(evaluateGoldenSection(golden, golden.target).areaMm2PerPixel).toBe(1);
  });

  it('does not invent an uncertain interior seam between overlapping human polygons', () => {
    const golden = rasterizeGoldenSection(
      definition({
        polygons: [rectangle(1.5, 1.5, 5.5, 6.5), rectangle(4.5, 1.5, 8.5, 6.5)],
        boundaryUncertaintyMm: 0.7,
      }),
    );
    expect(golden.confidence[4 * 10 + 4]).toBe(1);
    expect(golden.confidence[4 * 10 + 5]).toBe(1);
    expect(golden.target.reduce((sum, value) => sum + value, 0)).toBe(35);
  });

  it('preserves heterogeneous interiors and only removes explicitly authored holes', () => {
    const golden = rasterizeGoldenSection(
      definition({ polygons: [rectangle(1.5, 1.5, 8.5, 8.5)], holes: [rectangle(3.5, 3.5, 5.5, 5.5)] }),
    );
    expect(golden.target[4 * 10 + 4]).toBe(0);
    expect(golden.confidence[4 * 10 + 4]).toBe(2);
    const mask = golden.target.slice();
    for (const index of [44, 45, 54, 55]) mask[index] = 1;
    expect(evaluateGoldenSection(golden, mask).full.falsePositive).toBe(4);
    expect(golden.target.reduce((sum, value) => sum + value, 0)).toBe(45);
  });

  it('excludes and separately reports source-reviewed ambiguous areas rather than relabeling them outside', () => {
    const golden = rasterizeGoldenSection(definition({ uncertainPolygons: [rectangle(5.5, 2.5, 7.5, 6.5)] }));
    const mask = golden.target.slice();
    mask[4 * 10 + 6] = 0;
    mask[4 * 10 + 7] = 1;
    const result = evaluateGoldenSection(golden, mask);
    expect(result.excluded.explicitUncertainty).toBe(8);
    expect(result.full.recall).toBe(1);
    expect(result.full.precision).toBe(1);
    expect(result.selectedUncertain).toBe(4);
  });

  it('fails missing interior and tissue leakage even when outside specificity looks excellent', () => {
    const golden = rasterizeGoldenSection(definition({ columns: 100, rows: 100 }));
    const mask = golden.target.slice();
    mask[4 * 100 + 4] = 0;
    mask[5 * 100 + 7] = 1;
    const result = evaluateGoldenSection(golden, mask);
    expect(result.full.specificity).toBeGreaterThan(0.999);
    expect(result.full.recall).toBe(15 / 16);
    expect(result.full.precision).toBe(15 / 16);
    expect(goldenSectionFailures(result)).toContain('definite-inside recall');
    expect(goldenSectionFailures(result)).toContain('full-section confident precision');
  });

  it('hard-fails an exterior island that would pass high average overlap scores', () => {
    const golden = rasterizeGoldenSection(
      definition({ columns: 60, rows: 60, polygons: [rectangle(19.5, 19.5, 49.5, 49.5)] }),
    );
    const mask = golden.target.slice();
    mask[0] = 1;
    const result = evaluateGoldenSection(golden, mask);
    expect(result.full.precision).toBeGreaterThan(0.998);
    expect(result.tight.precision).toBe(1);
    expect(result.outsideAuditSelected).toBe(1);
    expect(goldenSectionFailures(result)).toEqual(['selection beyond the frozen audit region']);
  });

  it('does not invent tissue truth at unavailable samples and rejects selection there', () => {
    const valid = new Uint8Array(100).fill(1);
    valid[44] = 0;
    const golden = rasterizeGoldenSection(definition({ valid }));
    expect(golden.confidence[44]).toBe(0);
    const result = evaluateGoldenSection(golden, golden.target);
    expect(result.excluded.unsupported).toBe(1);
    expect(result.unsupportedSelected).toBe(1);
    expect(goldenSectionFailures(result)).toContain('selected unavailable source samples');
  });

  it('reports semantic unknowns across the audit border without hiding a nearby definite exterior island', () => {
    const golden = rasterizeGoldenSection(definition({ uncertainPolygons: [rectangle(6.5, 2.5, 9.5, 6.5)] }));
    const mask = golden.target.slice();
    mask[4 * 10 + 8] = 1;
    const unknown = evaluateGoldenSection(golden, mask);
    expect(unknown.outsideAuditSelected).toBe(1);
    expect(unknown.outsideAuditDefiniteSelected).toBe(0);
    expect(unknown.selectedExplicitUncertainty).toBe(1);
    expect(goldenSectionFailures(unknown)).toEqual([]);
    mask[8] = 1;
    const leaked = evaluateGoldenSection(golden, mask);
    expect(leaked.outsideAuditSelected).toBe(2);
    expect(leaked.outsideAuditDefiniteSelected).toBe(1);
    expect(goldenSectionFailures(leaked)).toContain('selection beyond the frozen audit region');
  });

  it('handles explicitly reviewed empty-target sections without claiming a positive Dice score', () => {
    expect(() => rasterizeGoldenSection(definition({ polygons: [] }))).toThrow(/explicitly reviewed/);
    const golden = rasterizeGoldenSection(definition({ polygons: [], auditBounds: { min: [1, 1], max: [8, 8] } }));
    const result = evaluateGoldenSection(golden, new Uint8Array(100));
    expect(result.full.recall).toBeNull();
    expect(result.full.dice).toBeNull();
    expect(result.full.specificity).toBe(1);
    expect(result.boundaryMm.maximum).toBeNull();
    expect(goldenSectionFailures(result)).toEqual([]);
    const wrong = new Uint8Array(100);
    wrong[44] = 1;
    expect(goldenSectionFailures(evaluateGoldenSection(golden, wrong))).toContain('full-section confident precision');
  });

  it.each(['boundary band', 'explicit unknown', 'unavailable'] as const)(
    'does not accept an unscorable positive target hidden by %s',
    (reason) => {
      const golden = rasterizeGoldenSection(
        definition({
          polygons: [rectangle(3.5, 3.5, 4.5, 4.5)],
          boundaryUncertaintyMm: reason === 'boundary band' ? 1 : 0,
          uncertainPolygons: reason === 'explicit unknown' ? [rectangle(2.5, 2.5, 5.5, 5.5)] : [],
          valid: reason === 'unavailable' ? new Uint8Array(100) : undefined,
        }),
      );
      const result = evaluateGoldenSection(golden, new Uint8Array(100));
      expect(result.full.recall).toBeNull();
      expect(goldenSectionFailures(result).some((failure) => failure.includes('unscorable'))).toBe(true);
    },
  );

  it.each(['explicit unknown', 'unavailable', 'outside grid'] as const)(
    'does not accept an empty negative control with no acquired audited evidence: %s',
    (reason) => {
      const golden = rasterizeGoldenSection(
        definition({
          polygons: [],
          auditBounds: reason === 'outside grid' ? { min: [20, 20], max: [30, 30] } : { min: [1, 1], max: [8, 8] },
          uncertainPolygons: reason === 'explicit unknown' ? [rectangle(-0.5, -0.5, 9.5, 9.5)] : [],
          valid: reason === 'unavailable' ? new Uint8Array(100) : undefined,
        }),
      );
      expect(
        goldenSectionFailures(evaluateGoldenSection(golden, new Uint8Array(100))).some((failure) =>
          failure.includes('unscorable'),
        ),
      ).toBe(true);
    },
  );

  it.each(['explicit unknown', 'unavailable'] as const)(
    'does not invent an anatomical boundary around an %s interior sample',
    (reason) => {
      const valid = new Uint8Array(100).fill(1);
      if (reason === 'unavailable') valid[44] = 0;
      const golden = rasterizeGoldenSection(
        definition({
          valid,
          uncertainPolygons: reason === 'explicit unknown' ? [rectangle(3.5, 3.5, 4.5, 4.5)] : [],
        }),
      );
      const mask = golden.target.slice();
      mask[44] = 0;
      const result = evaluateGoldenSection(golden, mask);
      expect(result.full.precision).toBe(1);
      expect(result.full.recall).toBe(1);
      expect(goldenSectionFailures(result)).toEqual([]);
      expect(result.boundaryMm.maximum).toBe(0);
    },
  );

  it('never uses unknown candidate edges as nearest targets for known reference boundaries', () => {
    const golden = rasterizeGoldenSection(definition({ uncertainPolygons: [rectangle(4.5, -0.5, 9.5, 9.5)] }));
    const first = new Uint8Array(100);
    first[43] = 1;
    const changedOnlyInUnknown = first.slice();
    changedOnlyInUnknown[45] = 1;
    const before = evaluateGoldenSection(golden, first);
    const after = evaluateGoldenSection(golden, changedOnlyInUnknown);
    expect(after.full).toEqual(before.full);
    expect(after.boundaryMm).toEqual(before.boundaryMm);
  });

  it('never uses unknown reference edges as nearest targets for known candidate boundaries', () => {
    const section = definition({ uncertainPolygons: [rectangle(4.5, -0.5, 9.5, 9.5)] });
    const mask = new Uint8Array(100);
    mask[44] = 1;
    const before = evaluateGoldenSection(rasterizeGoldenSection(section), mask);
    const after = evaluateGoldenSection(
      rasterizeGoldenSection({ ...section, holes: [rectangle(4.6, 3.1, 5.5, 5.9)] }),
      mask,
    );
    expect(after.full).toEqual(before.full);
    expect(after.boundaryMm).toEqual(before.boundaryMm);
  });

  it('does not turn the edge of acquired coverage into an anatomical contour', () => {
    const golden = rasterizeGoldenSection(definition({ polygons: [rectangle(-5.5, 2.5, 6.5, 6.5)] }));
    const result = evaluateGoldenSection(golden, golden.target);
    expect(result.full.recall).toBe(1);
    expect(result.boundaryMm.samples).toBeGreaterThan(0);
    expect(result.boundaryMm.maximum).toBe(0);
  });

  it('reports physical boundary displacement independently of overlap and scales with physical spacing', () => {
    const shifted = Uint8Array.from({ length: 100 }, (_, index) =>
      Number(index % 10 >= 4 && index % 10 <= 7 && Math.floor(index / 10) >= 3 && Math.floor(index / 10) <= 6),
    );
    for (const spacing of [1, 2]) {
      const result = evaluateGoldenSection(
        rasterizeGoldenSection(definition({ spacingMm: [spacing, spacing] })),
        shifted,
      );
      expect(result.boundaryMm.maximum).toBeCloseTo(spacing, 10);
      expect(result.full.recall).toBe(0.75);
      expect(result.full.dice).toBe(0.75);
    }
  });

  it('preserves absolute source coordinates and never mutates annotations, support, or the candidate', () => {
    const raw = definition({
      origin: [160, 70],
      polygons: [rectangle(162.5, 72.5, 166.5, 76.5)],
      valid: new Uint8Array(100).fill(1),
    });
    const saved = JSON.stringify(raw);
    const golden = rasterizeGoldenSection(raw);
    const mask = golden.target.slice(),
      before = mask.slice();
    evaluateGoldenSection(golden, mask);
    expect(JSON.stringify(raw)).toBe(saved);
    expect(mask).toEqual(before);
    expect(golden.target).toEqual(rasterizeGoldenSection(definition()).target);
  });

  it('rejects malformed geometry and nonbinary or misregistered masks', () => {
    for (const invalid of [
      { spacingMm: [0, 1] },
      { boundaryUncertaintyMm: -1 },
      { columns: 1.5 },
      {
        polygons: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        ],
      },
      { valid: new Uint8Array(2) },
    ] as Partial<GoldenSection>[])
      expect(() => rasterizeGoldenSection(definition(invalid))).toThrow();
    const golden = rasterizeGoldenSection(definition());
    expect(() => evaluateGoldenSection(golden, new Uint8Array(99))).toThrow(/match/);
    expect(() => evaluateGoldenSection(golden, new Uint8Array(100).fill(2))).toThrow(/binary/);
  });

  it('rejects cross-plane contradictory labels at the same acquired voxel before candidate evaluation', () => {
    const axial: GoldenVolumeSection = {
      id: 'axial',
      sourceGrid: 'original-native',
      fixedAxis: 2,
      fixedIndex: 4,
      acrossAxis: 0,
      verticalAxis: 1,
      golden: rasterizeGoldenSection(definition()),
    };
    const coronal: GoldenVolumeSection = {
      id: 'coronal',
      sourceGrid: 'original-native',
      fixedAxis: 1,
      fixedIndex: 4,
      acrossAxis: 0,
      verticalAxis: 2,
      golden: rasterizeGoldenSection(definition()),
    };
    expect(goldenCrossPlaneConflicts([axial, coronal])).toEqual([]);
    const wrong = {
      ...coronal,
      golden: rasterizeGoldenSection(definition({ polygons: [rectangle(5.5, 2.5, 8.5, 6.5)] })),
    };
    expect(goldenCrossPlaneConflicts([axial, wrong]).map((conflict) => conflict.voxel)).toEqual([
      [3, 4, 4],
      [4, 4, 4],
      [5, 4, 4],
      [7, 4, 4],
      [8, 4, 4],
    ]);
    const uncertain = {
      ...wrong,
      golden: rasterizeGoldenSection(
        definition({ polygons: [rectangle(5.5, 2.5, 8.5, 6.5)], uncertainPolygons: [rectangle(2.5, 3.5, 8.5, 4.5)] }),
      ),
    };
    expect(goldenCrossPlaneConflicts([axial, uncertain])).toEqual([]);
    expect(goldenCrossPlaneConflicts([axial, { ...wrong, sourceGrid: 'different-acquisition' }])).toEqual([]);
    expect(() => goldenCrossPlaneConflicts([{ ...axial, fixedIndex: 4.5 }])).toThrow(/exact coordinates/);
  });
});

const privateCorpus = process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DIR;
const privateArtifactUrl = (name: string) => pathToFileURL(resolve('tmp/segmentation-golden', name)).href;

describe.skipIf(!privateCorpus)('private source-first segmentation benchmark', () => {
  it('prepares or evaluates explicitly requested pinned native MRI artifacts', async () => {
    // These legacy routes imported frozen engineering outlines without an authority admission boundary.
    // Preserve their artifacts, but do not turn disputed/unclassified labels into accuracy PASS/FAIL again.
    const legacyReferenceActions = [
      'TINY512_ANCHOR',
      'MVS_THRESHOLD_DIAGNOSTIC',
      'BASELINE_RECHECK',
      'DERIVED_DOMAIN',
      'DERIVED_RESULTS',
      'VOLUME_RESULTS',
      'CORRECTION_DRAFT',
      'ORTHOGONAL_RESULTS',
      'SCRIBBLE_RESULTS',
      'BOUNDARY',
      'SOLVER',
      'SCORE',
    ];
    if (legacyReferenceActions.some((action) => process.env[`MIRAVIEWER_SEGMENTATION_GOLDEN_${action}`]))
      throw new Error(
        'Legacy anatomical gate blocked: private engineering references are disputed or unclassified. ' +
          'Use scoped binary regression for user-approved examples; anatomy evaluation requires separately reviewed authority.',
      );
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_TINY512_TRACKING === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('medsam2-pilot/trackingReadback.ts'));
      const result = producer.reviewTiny512Tracking();
      expect(result.invariants.endorsedAnchorByteIdentical).toBe(true);
      expect(result.invariants.missingOriginalForeground).toBe(0);
      expect(result.invariants.unsupportedSelected).toBe(0);
      expect(result.invariants.maskLogitDisagreements).toBe(0);
      expect(result.invariants.squareCropDisagreements).toBe(0);
      expect(result.invariants.all63FramesCovered).toBe(true);
      expect(result.invariants.sourceUnchanged).toBe(true);
      expect(result.invariants.rawMaskUnchanged).toBe(true);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_TINY512_ANCHOR === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('medsam2-pilot/scorePointAnchor.ts'));
      const result = producer.scoreTiny512PointAnchor();
      expect(result.failures).toEqual([]);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_MVS_THRESHOLD_DIAGNOSTIC === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('multiverseg-pilot/thresholdDiagnostic.ts'));
      const result = producer.diagnoseMvsThresholds();
      expect(result.halfIdentical).toBe(true);
      expect(result.sourceAndProbabilityUnchanged).toBe(true);
      expect(result.originalHalfMaskUnchanged).toBe(true);
      expect(result.outcomes).toHaveLength(18);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_BASELINE_RECHECK === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('rescoreBaselines.ts'));
      const result = producer.rescoreAcceptedNativeBaselines();
      expect(result.allInformative).toBe(true);
      expect(result.allOverlapUnchanged).toBe(true);
      expect(result.allInvariantsPreserved).toBe(true);
      return;
    }
    if (process.env.MIRAVIEWER_FASTSAM_SOURCE_EXPORT === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('fastsamSourceExport.ts'));
      const result = await producer.exportFastSamFullSource(privateCorpus);
      expect(result.allFullSourcePlanesMatchIndependentDecodedHashes).toBe(true);
      expect(result.foregroundComponents).toHaveLength(2);
      return;
    }
    if (
      process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DERIVED_PLAN === '1' ||
      process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DERIVED_DOMAIN === '1' ||
      process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DERIVED_RESULTS
    ) {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('derivedAxialDomain.ts'));
      if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DERIVED_RESULTS) {
        const result = producer.scoreDerivedAxialMaskReceipt(
          process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DERIVED_RESULTS,
        );
        expect(result.failedCases).toEqual([]);
      } else if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DERIVED_DOMAIN === '1') {
        const result = await producer.validateDerivedAxialDomain(privateCorpus);
        expect(result.provenance.independentNativePixelsEqual).toBe(true);
        expect(result.failures).toEqual([]);
      } else {
        const result = producer.planDerivedAxialDomain();
        expect(result.receipt.exactNativeForegroundMatchesOriginal).toBe(true);
        expect(result.receipt.profiles).toHaveLength(3);
      }
      return;
    }
    if (
      process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_VOLUME_RESULTS ||
      process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_CORRECTION_DRAFT === '1'
    ) {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('volumePromptScore.ts'));
      if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_CORRECTION_DRAFT === '1') {
        const draft = producer.prepareCoronalCorrectionDraft();
        expect(draft.originalVariantsPreserved).toBe(true);
        expect(draft.newVoxelCount).toBeGreaterThan(0);
      }
      if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_VOLUME_RESULTS) {
        const result = producer.scoreNativeVolumePromptReceipt(
          process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_VOLUME_RESULTS,
        );
        expect(result.failedCases).toEqual([]);
      }
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_ORTHOGONAL_RESULTS) {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('orthogonalPromptScore.ts'));
      if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_ORTHOGONAL_AGGREGATE === '1') {
        const result = producer.scoreOrthogonalAggregateReceipt(
          process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_ORTHOGONAL_RESULTS,
        );
        expect(result.failedCases).toEqual([]);
      } else {
        const result = producer.scoreOrthogonalPromptReceipt(
          process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_ORTHOGONAL_RESULTS,
          process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_VARIANTS,
        );
        expect(result.failures).toEqual([]);
      }
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_VOLUME_EXPORT === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('scribblePromptVolumeExport.ts'));
      const result = await producer.exportScribblePromptVolumes(privateCorpus);
      expect(result.outputs).toHaveLength(2);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_SCRIBBLE_RESULTS) {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('scribblePromptScore.ts'));
      const results = producer.scoreScribblePromptReceipt(
        process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_SCRIBBLE_RESULTS,
        process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_VARIANTS?.split(','),
      );
      expect(results.failedCases).toEqual([]);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_SCRIBBLE_EXPORT === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('scribblePromptExport.ts'));
      const outputs = await producer.exportScribblePromptPilot(privateCorpus);
      expect(outputs).toHaveLength(2);
      expect(outputs.every((output: { sourceUnchanged: boolean }) => output.sourceUnchanged)).toBe(true);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_BOUNDARY === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('boundaryDiagnostic.ts'));
      const result = producer.diagnoseNativeBoundaryDistances();
      expect(
        result.reports.every(
          (report: { independentDistancesMatchReceipt: boolean }) => report.independentDistancesMatchReceipt,
        ),
      ).toBe(true);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_SOLVER) {
      if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_ORIGINAL_EXPERIMENT === '1') {
        const producer = await import(/* @vite-ignore */ privateArtifactUrl('originalExperiment.ts'));
        const result = await producer.runOriginalGoldenExperiment(privateCorpus);
        expect(result.failures).toEqual([]);
        return;
      }
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('experiment.ts'));
      const result = await producer.runStoredGoldenExperiment(privateCorpus);
      expect(result.failures).toEqual([]);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_DOMAINS === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('nativeDomains.ts'));
      const result = await producer.prepareNativeMarkedDomains(privateCorpus);
      expect(result.variants.every((variant: { domainVoxels: number }) => variant.domainVoxels <= 2_000_000)).toBe(
        true,
      );
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_OVERLAYS === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('overlays.ts'));
      expect(producer.renderUpdatedDevelopmentDrafts().length).toBeGreaterThan(0);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_AUDIT === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('evaluate.ts'));
      const result = producer.auditDevelopmentGolden();
      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.conflicts).toEqual([]);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_SCORE === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('evaluate.ts'));
      const result = producer.scoreFrozenBaselineGolden();
      expect(result.outcomes.length).toBeGreaterThan(0);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_METADATA === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('metadata.ts'));
      expect(producer.inspectGoldenSourceMetadata(privateCorpus)).toHaveLength(4);
      return;
    }
    if (process.env.MIRAVIEWER_SEGMENTATION_GOLDEN_ORIGINAL === '1') {
      const producer = await import(/* @vite-ignore */ privateArtifactUrl('original.ts'));
      const results = await producer.prepareOriginalGoldenReview(privateCorpus);
      expect(results[0].originalSourceUnchanged).toBe(true);
      return;
    }
    const producer = await import(/* @vite-ignore */ privateArtifactUrl('prepare.ts'));
    const results = await producer.prepareGoldenSourceReview(privateCorpus);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result: { originalSourceUnchanged: boolean }) => result.originalSourceUnchanged)).toBe(true);
  }, 240_000);
});
