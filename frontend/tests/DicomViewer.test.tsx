import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DicomViewer } from '../src/components/DicomViewer';

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

// Mock getBoundingClientRect to return non-zero dimensions
beforeEach(() => {
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
});
