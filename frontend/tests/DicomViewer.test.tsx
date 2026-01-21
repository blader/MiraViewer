import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DicomViewer } from '../src/components/DicomViewer';
import { getImageIdForInstance } from '../src/utils/localApi';

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
    resize: vi.fn(),
  },
}));

import cornerstone from 'cornerstone-core';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

// Mock getBoundingClientRect to return non-zero dimensions
beforeEach(() => {
  vi.clearAllMocks();

  Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    width: 500,
    height: 500,
    top: 0,
    left: 0,
    right: 500,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

describe('DicomViewer', () => {
  it('renders image override via img tag', async () => {
    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        imageUrlOverride="test.png"
      />
    );

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'test.png');
  });

  it('loads Cornerstone image when no override', async () => {
    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
      />
    );

    await waitFor(() => {
      expect(cornerstone.loadImage).toHaveBeenCalled();
    });
  });

  it('keeps previous visual settings until the new Cornerstone image is displayed (async swap)', async () => {
    const deferredImageId = createDeferred<string>();

    vi.mocked(getImageIdForInstance)
      .mockImplementationOnce(async () => 'miradb:old')
      .mockImplementationOnce(() => deferredImageId.promise);

    const { rerender } = render(
      <DicomViewer
        studyId="study"
        seriesUid="series-old"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        brightness={100}
        contrast={100}
        zoom={1}
        rotation={0}
      />
    );

    await waitFor(() => {
      expect(cornerstone.displayImage).toHaveBeenCalled();
    });

    const content = screen.getByLabelText('Slice 1');
    const wrapper = content.parentElement as HTMLElement;

    expect(wrapper.style.filter).toBe('brightness(1) contrast(1)');
    expect(wrapper.style.transform).toContain('scale(1)');
    expect(wrapper.style.transform).toContain('rotate(0deg)');

    // Swap to a new contentKey + new visual settings, but keep imageId stale by not resolving.
    rerender(
      <DicomViewer
        studyId="study"
        seriesUid="series-new"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        brightness={150}
        contrast={120}
        zoom={2}
        rotation={45}
      />
    );

    // The previous image should keep the previous filter/transform until the new image loads.
    expect(wrapper.style.filter).toBe('brightness(1) contrast(1)');
    expect(wrapper.style.transform).toContain('scale(1)');
    expect(wrapper.style.transform).toContain('rotate(0deg)');

    // Now allow the new imageId to resolve and be displayed.
    deferredImageId.resolve('miradb:new');

    await waitFor(() => {
      expect(wrapper.style.filter).toBe('brightness(1.5) contrast(1.2)');
      expect(wrapper.style.transform).toContain('scale(2)');
      expect(wrapper.style.transform).toContain('rotate(45deg)');
    });
  });
});
