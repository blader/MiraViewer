import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { DicomViewer, type DicomViewerHandle } from '../src/components/DicomViewer';

vi.mock('../src/utils/localApi', () => ({
  getImageIdForInstance: vi.fn().mockResolvedValue('miradb:inst-1'),
}));

vi.mock('cornerstone-core', () => ({
  default: {
    enable: vi.fn(),
    disable: vi.fn(),
    loadImage: vi.fn().mockResolvedValue({}),
    displayImage: vi.fn(),
    getDefaultViewportForImage: vi.fn().mockReturnValue({}),
  },
}));

describe('DicomViewer interactions', () => {
  beforeEach(() => {
    // Mock canvas context and toBlob
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      scale: vi.fn(),
      fillRect: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      set filter(_v: string) {},
      get filter() { return ''; },
    });
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    });
  });

  it('captures visible PNG from img override', async () => {
    const ref = React.createRef<DicomViewerHandle>();
    render(
      <DicomViewer
        ref={ref}
        studyId="s"
        seriesUid="u"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        imageUrlOverride="test.png"
      />
    );

    const img = await screen.findByRole('img');
    const viewport = document.querySelector('.cursor-crosshair') as HTMLElement;
    Object.defineProperty(viewport, 'clientWidth', { value: 200 });
    Object.defineProperty(viewport, 'clientHeight', { value: 200 });
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 256 });
    Object.defineProperty(img, 'naturalHeight', { value: 256 });

    const blob = await ref.current!.captureVisiblePng();
    expect(blob).toBeInstanceOf(Blob);
  });

  it('click sets pan and double-click resets pan', async () => {
    const onPanChange = vi.fn();
    const { container } = render(
      <DicomViewer
        studyId="s"
        seriesUid="u"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        onPanChange={onPanChange}
        panX={0}
        panY={0}
        imageUrlOverride="test.png"
      />
    );

    const viewport = container.querySelector('.cursor-crosshair') as HTMLElement;
    Object.defineProperty(viewport, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    });

    fireEvent.click(viewport, { clientX: 50, clientY: 50 });
    await waitFor(() => {
      expect(onPanChange).toHaveBeenCalled();
    });

    fireEvent.doubleClick(viewport);
    expect(onPanChange).toHaveBeenCalledWith(0, 0);
  });
});
