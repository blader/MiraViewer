import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

const { getTumorSegmentationForInstance, getTumorGroundTruthForInstance, deleteTumorGroundTruth } = vi.hoisted(() => ({
  getTumorSegmentationForInstance: vi.fn(),
  getTumorGroundTruthForInstance: vi.fn(),
  deleteTumorGroundTruth: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getSopInstanceUidForInstanceIndex: vi.fn(async () => 'synthetic-instance'),
  getTumorSegmentationForInstance,
  getTumorGroundTruthForInstance,
  deleteTumorGroundTruth,
  saveTumorGroundTruth: vi.fn(),
}));

import { GroundTruthPolygonOverlay } from '../src/components/GroundTruthPolygonOverlay';
import { TumorSavedSegmentationOverlay } from '../src/components/TumorSavedSegmentationOverlay';

const polygon = {
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.3, y: 0.1 },
    { x: 0.2, y: 0.3 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('legacy annotation migration safety', () => {
  it('hides a legacy tumor polygon and visibly preserves it when the authored viewport is missing', async () => {
    getTumorSegmentationForInstance.mockResolvedValue({ polygon, meta: { viewTransform: DEFAULT_PANEL_SETTINGS } });
    const { container } = render(
      <TumorSavedSegmentationOverlay
        enabled
        seriesUid="synthetic-series"
        effectiveInstanceIndex={0}
        viewerTransform={DEFAULT_PANEL_SETTINGS}
        imageSize={{ w: 256, h: 128 }}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /original viewport or image dimensions are unavailable/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/stored annotation is preserved/i);
    expect(container.querySelector('path')).toBeNull();
    expect(deleteTumorGroundTruth).not.toHaveBeenCalled();
  });

  it('hides a legacy ground-truth polygon instead of reusing an unrelated current viewport', async () => {
    getTumorGroundTruthForInstance.mockResolvedValue({ polygon, viewTransform: DEFAULT_PANEL_SETTINGS });
    const { container } = render(
      <GroundTruthPolygonOverlay
        enabled
        onRequestClose={vi.fn()}
        comboId="synthetic-combo"
        dateIso="2025-01-01T00:00:00.000Z"
        studyId="synthetic-study"
        seriesUid="synthetic-series"
        effectiveInstanceIndex={0}
        viewerTransform={DEFAULT_PANEL_SETTINGS}
        imageSize={{ w: 256, h: 128 }}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /saved ground-truth annotation cannot be displayed safely/i,
    );
    expect(container.querySelector('svg.absolute path')).toBeNull();
    expect(deleteTumorGroundTruth).not.toHaveBeenCalled();
  });

  it('continues migrating legacy polygons when authored viewport and source dimensions are known', async () => {
    getTumorSegmentationForInstance.mockResolvedValue({
      polygon,
      meta: {
        viewportSize: { w: 1000, h: 500 },
        viewTransform: DEFAULT_PANEL_SETTINGS,
      },
    });
    const { container } = render(
      <TumorSavedSegmentationOverlay
        enabled
        seriesUid="synthetic-series"
        effectiveInstanceIndex={0}
        viewerTransform={DEFAULT_PANEL_SETTINGS}
        imageSize={{ w: 256, h: 128 }}
      />,
    );

    await waitFor(() => expect(container.querySelector('path')).not.toBeNull());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
