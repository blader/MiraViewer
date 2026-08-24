import { describe, expect, it } from 'vitest';
import { selectPhysicalTargetSlice } from '../src/utils/alignmentGeometry';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';

function manifest(
  seriesUid: string,
  frames: SeriesFrameManifest['frames'],
  frameOfReferenceUid = 'shared-patient-space',
): SeriesFrameManifest {
  return {
    seriesUid,
    studyUid: `${seriesUid}-study`,
    patientKey: 'same-patient',
    frameOfReferenceUid,
    ordering: 'physical',
    geometryReliable: true,
    frames,
  };
}

describe('physical source-slice anchoring', () => {
  it('projects the output center onto the target normal despite an oblique 40 mm crop offset', () => {
    const angle = (18 * Math.PI) / 180;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const reference = manifest(
      'reference',
      [-1, 0, 1].map((depth) => ({
        sopInstanceUid: `reference-${depth}`,
        seriesInstanceUid: 'reference',
        studyInstanceUid: 'reference-study',
        instanceNumber: depth + 2,
        rows: 201,
        columns: 201,
        imagePositionPatient: `-100\\-100\\${depth}`,
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        pixelSpacing: '1\\1',
        physicalSlicePosition: depth,
      })),
    );
    const target = manifest(
      'target',
      Array.from({ length: 41 }, (_, index) => {
        const depth = index - 20;
        const tangentOffset = 40 - 100;
        return {
          sopInstanceUid: `target-${index}`,
          seriesInstanceUid: 'target',
          studyInstanceUid: 'target-study',
          instanceNumber: index,
          rows: 201,
          columns: 201,
          imagePositionPatient: `${tangentOffset * cosine - depth * sine}\\-100\\${tangentOffset * sine + depth * cosine}`,
          imageOrientationPatient: `${cosine}\\0\\${sine}\\0\\1\\0`,
          pixelSpacing: '1\\1',
          physicalSlicePosition: depth,
        };
      }),
    );

    expect(selectPhysicalTargetSlice(reference, target, 1)).toBe(20);
    const outputGrid = buildOutputPlaneGrid(reference.frames[1]!, {
      mode: 'fixed-256',
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    expect(
      selectPhysicalTargetSlice(reference, { ...target, frameOfReferenceUid: 'different-space' }, 1, {
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
        centerMm: { x: 0, y: 0, z: 0 },
        outputGrid,
      }),
    ).toBe(20);
  });
});
