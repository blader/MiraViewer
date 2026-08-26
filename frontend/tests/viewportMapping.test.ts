import { describe, expect, test } from 'vitest';
import {
  containRectPx,
  imageGridTranslationToPanelPan,
  imageNormToViewerNorm,
  panelPanToImageGridTranslation,
  viewerNormToImageNorm,
} from '../src/utils/viewportMapping';
import { affineAboutCenterToPanelGeometry, panelGeometryToAffineAboutCenter } from '../src/utils/panelTransform';

describe('canonical image and viewport coordinates', () => {
  const view = { w: 1000, h: 500 };
  const image = { w: 512, h: 512 };

  test('converts letterboxed lesion selections into image coordinates', () => {
    expect(containRectPx(view, image)).toEqual({ dx: 250, dy: 0, dw: 500, dh: 500 });
    expect(viewerNormToImageNorm({ x: 0.3, y: 0.25 }, view, image)).toEqual({ x: 0.1, y: 0.25 });
    expect(viewerNormToImageNorm({ x: 0.35, y: 0.5 }, view, image)).toEqual({ x: 0.2, y: 0.5 });
  });

  test('reprojects the same image point after viewport aspect changes', () => {
    const source = { x: 0, y: 0.5 };
    const authored = imageNormToViewerNorm(source, view, image);
    const portrait = { w: 500, h: 1000 };

    expect(authored).toEqual({ x: 0.25, y: 0.5 });
    expect(imageNormToViewerNorm(viewerNormToImageNorm(authored, view, image), portrait, image)).toEqual({
      x: 0,
      y: 0.5,
    });
  });

  test('converts alignment-grid translation into viewport-normalized panel pan', () => {
    expect(imageGridTranslationToPanelPan({ x: 25.6, y: 25.6 }, 256, view, image)).toEqual({ x: 0.05, y: 0.1 });
    expect(panelPanToImageGridTranslation({ x: 0.05, y: 0.1 }, 256, view, image)).toEqual({ x: 25.6, y: 25.6 });
  });

  test('panel transforms retain the contained-image conversion in both directions', () => {
    const geometry = {
      zoom: 1,
      rotation: 0,
      panX: 0.05,
      panY: 0.1,
      affine00: 1,
      affine01: 0,
      affine10: 0,
      affine11: 1,
    };
    const mapping = { viewportSize: { width: 1000, height: 500 }, imageSize: { width: 512, height: 512 } };
    const affine = panelGeometryToAffineAboutCenter(geometry, 256, mapping);

    expect(affine.t.x).toBeCloseTo(25.6);
    expect(affine.t.y).toBeCloseTo(25.6);

    const roundTrip = affineAboutCenterToPanelGeometry({ A: affine.A, translatePx: affine.t }, 256, mapping);
    expect(roundTrip.panX).toBeCloseTo(geometry.panX);
    expect(roundTrip.panY).toBeCloseTo(geometry.panY);
  });
});
