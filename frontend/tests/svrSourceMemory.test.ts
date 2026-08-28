import { describe, expect, it } from 'vitest';
import { DEFAULT_SVR_PARAMS } from '../src/types/svr';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { estimateSvrSourceMemory } from '../src/utils/svr/sourceMemory';

function manifest(rows = 4, columns = 4, count = 2): SeriesFrameManifest {
  return {
    seriesUid: 'source',
    patientKey: 'patient',
    studyUid: 'study',
    frameOfReferenceUid: 'frame',
    geometryReliable: true,
    ordering: 'physical',
    frames: Array.from({ length: count }, (_, index) => ({
      seriesInstanceUid: 'source',
      sopInstanceUid: `source-${index}`,
      studyInstanceUid: 'study',
      instanceNumber: index,
      frameOfReferenceUid: 'frame',
      rows,
      columns,
      imagePositionPatient: `0\\0\\${index}`,
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      sliceThickness: 1,
    })),
  };
}
const params = {
  ...DEFAULT_SVR_PARAMS,
  sliceDownsampleMode: 'fixed' as const,
  sliceDownsampleMaxSize: 2,
  seriesRegistrationMode: 'none' as const,
  maxVolumeDim: 64,
};

describe('shared SVR source-copy memory authority', () => {
  it('counts each admitted frame geometry instead of assuming the first frame size', () => {
    const source = manifest();
    source.frames[1]!.columns = 8;
    const plan = estimateSvrSourceMemory([source], params, {
      cacheInfo: { cacheSizeInBytes: 32, maximumSizeInBytes: 1024 },
    });
    expect(plan.sourceBytes).toBe((2 * 2 + 1 * 2) * 5);
    expect(plan.decodedSourceCacheBytes).toBe(32 + (4 * 4 + 4 * 8) * 4);
  });

  it('budgets source pixels at native pitch after inverse-mapping the accepted regional pose', () => {
    const source = manifest(100, 100, 4);
    const transform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, translationMm: [100, 100, 100] as const };
    const plan = estimateSvrSourceMemory([source], params, {
      roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [150, 150, 101], max: [152, 152, 102] } },
      acceptedSourceTransforms: { source: transform },
      cacheInfo: { cacheSizeInBytes: 0, maximumSizeInBytes: 32 * 1024 * 1024 },
    });
    expect(plan.sourceBytes).toBe(4 * 7 * 7 * 5);
    expect(plan.decodedSourceCacheBytes).toBe(4 * 100 * 100 * 4);
  });

  it('never shrinks measured cache residency to a smaller configured cap or invents free missing telemetry', () => {
    const source = manifest();
    expect(
      estimateSvrSourceMemory([source], params, { cacheInfo: { cacheSizeInBytes: 1024, maximumSizeInBytes: 512 } })
        .decodedSourceCacheBytes,
    ).toBe(1024);
    expect(estimateSvrSourceMemory([source], params).decodedSourceCacheBytes).toBe(256 * 1024 * 1024);
    expect(
      estimateSvrSourceMemory([source], params, { cacheInfo: { cacheSizeInBytes: NaN, maximumSizeInBytes: Infinity } })
        .decodedSourceCacheBytes,
    ).toBe(256 * 1024 * 1024);
  });
});
