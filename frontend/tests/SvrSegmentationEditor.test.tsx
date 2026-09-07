import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrSegmentationEditor } from '../src/components/SvrSegmentationEditor';
import { createSvrImagingOperations, SvrImagingContext } from '../src/components/svrImagingContext';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import type { SelectionProposer, SelectionProposalResult } from '../src/utils/segmentation/selectionProposal';
import { paint, proposedRegion, testSelectionProposer } from './helpers/selectionInteraction';
import { deferred } from './helpers/deferred';

type EditorProps = ComponentProps<typeof SvrSegmentationEditor>;
type ImagingProps = NonNullable<ComponentProps<typeof SvrImagingContext.Provider>['value']>;
type ViewUpdate = Partial<Pick<EditorProps, 'cursor' | 'windowRange'>> & { labels?: SvrLabelVolume | null };
const at = (x: number, y: number) => (6 * 12 + y) * 12 + x;

function volume(): SvrVolume {
  return {
    data: new Float32Array(12 ** 3).fill(0.5),
    observedSupport: new Uint8Array(12 ** 3).fill(1),
    dims: [12, 12, 12],
    voxelSizeMm: [1, 1, 1],
    originMm: [0, 0, 0],
    boundsMm: { min: [0, 0, 0], max: [12, 12, 12] },
    displayWindow: [0, 1],
  };
}


function draft(): SvrLabelVolume {
  const data = new Uint8Array(12 ** 3);
  data[at(5, 6)] = 1;
  return {
    data,
    dims: [12, 12, 12],
    meta: SELECTION_LABEL_META,
    reviewState: 'draft',
    seeds: { foreground: Uint32Array.of(at(5, 6)), background: new Uint32Array() },
  };
}

function setup(
  initial: SvrLabelVolume | null = null,
  overrides: Partial<Pick<EditorProps, 'disabled' | 'disabledReason' | 'storageError' | 'selectionNotice'>> = {},
  imaging: Partial<Pick<ImagingProps, 'volume' | 'refineRegion' | 'busy' | 'proposeSelection'>> = {},
) {
  const source = imaging.volume ?? volume();
  const operations = createSvrImagingOperations();
  const changed = vi.fn<EditorProps['onChange']>();
  const show3D = vi.fn();
  const retryStorage = vi.fn();
  function Workspace({ view = {} }: { view?: ViewUpdate }) {
    const [savedLabels, setLabels] = useState(initial);
    const [savedCursor, setCursor] = useState({ x: 6, y: 6, z: 6 });
    const [visualizationMode, setVisualizationMode] = useState<EditorProps['visualizationMode']>('anatomy');
    const [savedWindow] = useState<[number, number]>([0, 1]);
    const labels = view.labels === undefined ? savedLabels : view.labels;
    const cursor = view.cursor ?? savedCursor;
    const windowRange = view.windowRange ?? savedWindow;
    return (
      <SvrImagingContext.Provider
        value={{ proposeSelection: testSelectionProposer, ...imaging, volume: source, labels, operations }}
      >
        <SvrSegmentationEditor
          {...overrides}
          onChange={(next, patch, previousData) => {
            changed(next, patch, previousData);
            setLabels(next);
          }}
          retryStorage={retryStorage}
          selectedVolumeMl={(labels?.data.reduce((count, value) => count + Number(Boolean(value)), 0) ?? 0) / 1000}
          visualizationMode={visualizationMode}
          onVisualizationModeChange={setVisualizationMode}
          cursor={cursor}
          setCursor={setCursor}
          windowRange={windowRange}
        >
          <canvas aria-label="3D scene" tabIndex={0} />
        </SvrSegmentationEditor>
      </SvrImagingContext.Provider>
    );
  }
  const rendered = render(<Workspace />);
  let view: ViewUpdate = {};
  return {
    ...rendered,
    source,
    operations,
    changed,
    show3D,
    retryStorage,
    updateView: (next: ViewUpdate) => {
      view = { ...view, ...next };
      rendered.rerender(<Workspace view={view} />);
    },
  };
}

function recordSlicePaints() {
  const images = new WeakMap<HTMLCanvasElement, ImageData>();
  const paints = vi.fn<(plane: string | undefined, image: ImageData) => void>();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, id: string) {
    if (id !== '2d') return null;
    return new Proxy(
      {
        createImageData: (width: number, height: number) =>
          ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
        putImageData: (image: ImageData) => images.set(this, image),
        drawImage: (source: HTMLCanvasElement) => paints(this.dataset.plane, images.get(source)!),
      },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
    );
  } as typeof HTMLCanvasElement.prototype.getContext);
  return paints;
}

beforeEach(() => {
  testSelectionProposer.mockReset();
});
beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});


describe('Focused SVR tissue-selection workflow', () => {

  it('does not paint hidden slices during 3D browsing and reopens with the latest cursor, contrast, and labels', () => {
    const paints = recordSlicePaints();
    const run = testSelectionProposer;
    const { container, source, changed, updateView } = setup();
    const original = source.data.slice();
    const scene = screen.getByLabelText('3D scene');
    expect(paints).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    const oldAxial = screen.getByRole('application', { name: /axial reconstructed slice/i });
    expect(new Set(paints.mock.calls.map(([plane]) => plane))).toEqual(new Set(['axial', 'coronal', 'sagittal']));
    fireEvent.keyDown(oldAxial, { key: 'Escape' });
    expect(oldAxial).not.toBeInTheDocument();
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(0);
    paints.mockClear();
    for (const z of [2, 5, 8]) act(() => updateView({ cursor: { x: 4, y: 5, z } }));
    const labels: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
      reviewState: 'reviewed',
    };
    labels.data[(8 * 12 + 3) * 12 + 2] = 1;
    const labelBefore = labels.data.slice();
    act(() => updateView({ windowRange: [0, 2], labels }));
    expect(paints).not.toHaveBeenCalled();
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(0);
    expect(screen.getByLabelText('3D scene')).toBe(scene);
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('application', { name: 'Axial reconstructed slice 9' })).not.toBe(oldAxial);
    expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(9);
    expect(screen.getByRole('spinbutton', { name: 'Coronal slice' })).toHaveValue(6);
    expect(screen.getByRole('spinbutton', { name: 'Sagittal slice' })).toHaveValue(5);
    const image = paints.mock.calls.filter(([plane]) => plane === 'axial').at(-1)![1];
    expect([...image.data.slice(0, 4)]).toEqual([64, 64, 64, 255]);
    const selected = (3 * 12 + 2) * 4;
    expect([...image.data.slice(selected, selected + 4)]).toEqual([99, 193, 180, 255]);
    expect(screen.getByLabelText('3D scene')).toBe(scene);
    expect(source.data).toEqual(original);
    expect(labels.data).toEqual(labelBefore);
    expect(changed).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('paints only the expanded source plane and remounts the others when all views return', () => {
    const paints = recordSlicePaints();
    const { container, changed, updateView } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    const axial = screen.getByRole('application', { name: /axial reconstructed slice/i });
    const coronal = screen.getByRole('application', { name: /coronal reconstructed slice/i });
    const sagittal = screen.getByRole('application', { name: /sagittal reconstructed slice/i });
    fireEvent.click(screen.getByRole('button', { name: 'Expand axial view' }));
    expect([...container.querySelectorAll('canvas[data-plane]')]).toEqual([axial]);
    expect(coronal).not.toBeInTheDocument();
    expect(sagittal).not.toBeInTheDocument();
    paints.mockClear();
    act(() => updateView({ cursor: { x: 4, y: 5, z: 8 }, windowRange: [0, 2] }));
    expect(paints).toHaveBeenCalled();
    expect(paints.mock.calls.every(([plane]) => plane === 'axial')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(3);
    expect(screen.getByRole('application', { name: 'Axial reconstructed slice 9' })).toBe(axial);
    expect(screen.getByRole('application', { name: 'Coronal reconstructed slice 6' })).not.toBe(coronal);
    expect(screen.getByRole('application', { name: 'Sagittal reconstructed slice 5' })).not.toBe(sagittal);
    for (const plane of ['coronal', 'sagittal']) {
      const image = paints.mock.calls.filter(([painted]) => painted === plane).at(-1)![1];
      expect([...image.data.slice(0, 4)]).toEqual([64, 64, 64, 255]);
    }
    expect(changed).not.toHaveBeenCalled();
  });










  it.each([false, true])(
    'keeps read-only inspection navigable while painting remains locked (selection: %s)',
    (withSelection) => {
      const { container, changed } = setup(withSelection ? draft() : null, {
        disabled: true,
        disabledReason: 'Restoring saved selection.',
      });
      expect(screen.getByRole('button', { name: '3D + slices' })).toBeEnabled();
      expect(screen.getByText('Restoring saved selection.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
      expect(container.querySelector('.svr-selection-grid')).not.toHaveAttribute('data-expanded');
      expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true');
      for (const name of ['Add', 'Erase']) expect(screen.getByRole('button', { name })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      expect(screen.queryByRole('slider', { name: 'Brush radius in millimeters' })).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: ']' });
      expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(8);
      expect(screen.getByText('Restoring saved selection.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '3D' }));
      expect(screen.getByRole('button', { name: '3D + slices' })).toBeEnabled();
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it('preserves drafts, marks, undo and redo across 3D viewing, including undoable clear', () => {
    const { container, changed, source } = setup(null, {}, { proposeSelection: undefined });
    const original = source.data.slice();
    const run = testSelectionProposer;
    const canvases = [...container.querySelectorAll('canvas')];
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    const firstAxial = screen.getByRole('application', { name: /axial reconstructed slice/i });
    paint();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    const marked = changed.mock.lastCall![0]!;
    expect(marked.reviewState).toBe('draft');
    expect(marked.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
    fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: 'Escape' });
    expect(changed.mock.lastCall![0]).toBe(marked);
    expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    expect([...container.querySelectorAll('canvas')]).toEqual(canvases);
    expect(firstAxial).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('application', { name: /axial reconstructed slice/i })).not.toBe(firstAxial);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Expand axial view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    expect(screen.queryByText(/Tumor ·/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
    fireEvent.click(screen.getByRole('button', { name: 'Clear tumor selection' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    expect(screen.queryByText(/Tumor ·/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
    expect(run).not.toHaveBeenCalled();
    expect(source.data).toEqual(original);
  });



  it('auto-fills only after a new stroke and undoes the stroke and its filled boundary together', async () => {
    const run = testSelectionProposer.mockResolvedValue(proposedRegion([at(5, 6), at(6, 6)]));
    const { changed, source } = setup();
    const original = source.data.slice();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(run).not.toHaveBeenCalled();
    paint();
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(0);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
    const filled = changed.mock.lastCall![0]!;
    expect(filled.data[at(6, 6)]).toBe(1);
    expect(filled.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
    expect(filled.reviewState).toBe('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(changed.mock.lastCall![0]!.seeds?.foreground.length ?? 0).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(filled.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(filled.seeds);
    expect(run).toHaveBeenCalledOnce();
    expect(source.data).toEqual(original);
  });

  it('uses the configured native proposer from the imaging workspace with the same brush and undo controls', async () => {
    const legacy = testSelectionProposer;
    const source = volume();
    const prediction = new Uint8Array(source.data.length);
    prediction[at(6, 6)] = 1;
    const proposeSelection = vi.fn<SelectionProposer>().mockResolvedValue({
      data: prediction,
      boundaryCount: 0,
      contextLimited: false,
    });
    const { changed } = setup(null, {}, { volume: source, proposeSelection });
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(proposeSelection).not.toHaveBeenCalled();
    paint();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await waitFor(() => expect(proposeSelection).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
    expect(legacy).not.toHaveBeenCalled();
    expect(proposeSelection.mock.calls[0]![0]).toMatchObject({
      volume: source,
      seeds: {
        foreground: Uint32Array.of(at(5, 6)),
        background: new Uint32Array(),
        lastStroke: { plane: 'axial', slice: 6 },
      },
      retainedBytes: 10,
    });
    const filled = changed.mock.lastCall![0]!;
    expect(filled.data[at(5, 6)]).toBe(1);
    expect(filled.data[at(6, 6)]).toBe(1);
    expect(prediction[at(5, 6)]).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(filled.data);
    expect(proposeSelection).toHaveBeenCalledOnce();
  });

  it('discloses a larger native prediction clipped by the current viewing region without replacing its volume', async () => {
    const source = volume();
    const prediction = new Uint8Array(source.data.length);
    prediction[at(6, 6)] = 1;
    const proposeSelection = vi.fn<SelectionProposer>().mockResolvedValue({
      data: prediction,
      boundaryCount: 0,
      contextLimited: false,
      clippedNativeVoxels: 152,
    });
    const { changed } = setup(null, {}, { volume: source, proposeSelection });
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    const warning = await screen.findByText(/only part of the predicted tissue is retained/i);
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveTextContent(/Enlarge or clear the focus region in Sources/i);
    expect(screen.queryByText(/initial prediction reached the edge/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/analyzed a limited source region/i)).not.toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.data.length).toBe(source.data.length);
    expect(changed.mock.lastCall![0]!.clippedNativeVoxels).toBe(152);
    expect(source.dims).toEqual([12, 12, 12]);
  });

  it('shows stored clipping evidence without running another prediction on reopen', () => {
    const proposeSelection = vi.fn<SelectionProposer>();
    setup({ ...draft(), clippedNativeVoxels: 152, reviewState: 'reviewed' }, {}, { proposeSelection });
    expect(screen.getByText(/only part of the predicted tissue is retained/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByText(/only part of the predicted tissue is retained/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByText(/only part of the predicted tissue is retained/i)).toBeVisible();
    expect(proposeSelection).not.toHaveBeenCalled();
  });


  it.each(['draft', 'reviewed'] as const)(
    'does not run auto-fill on restoring, browsing, or reopening a %s selection',
    (reviewState) => {
      const run = testSelectionProposer;
      const { changed } = setup({ ...draft(), reviewState });
      fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
      const axial = screen.getByRole('application', { name: /axial reconstructed slice/i });
      fireEvent.keyDown(axial, { key: ']' });
      fireEvent.keyDown(axial, { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
      expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
      expect(run).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it('offers a retry only after failure while preserving direct brush editing', async () => {
    const run = testSelectionProposer
      .mockRejectedValueOnce(new Error('Boundary worker unavailable'))
      .mockResolvedValue(proposedRegion([at(5, 6), at(6, 6)]));
    const { changed } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.queryByRole('button', { name: 'Retry auto-fill' })).not.toBeInTheDocument();
    paint(6, 6);
    await screen.findByText('Boundary worker unavailable');
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry auto-fill' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Retry auto-fill' })).not.toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(1);
  });

  it('discards an unfinished stroke when undo replaces its selection and preserves redo', () => {
    const { changed } = setup(null, {}, { proposeSelection: undefined });
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    const marked = changed.mock.lastCall![0]!;
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 214, clientY: 173 };
    fireEvent.pointerDown(canvas, point);
    fireEvent.keyDown(canvas, { key: 'z', metaKey: true });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    fireEvent.pointerUp(canvas, point);
    expect(changed).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
  });

  it('discards lost pointer capture without committing a mark or blocking the next stroke', () => {
    const { changed } = setup(null, {}, { proposeSelection: undefined });
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 160 };
    fireEvent.pointerDown(canvas, point);
    fireEvent.lostPointerCapture(canvas, point);
    fireEvent.pointerUp(canvas, point);
    expect(changed).not.toHaveBeenCalled();
    paint();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
  });

  it('cancels the previous proposal on brush-down so its late result cannot discard the new stroke', async () => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    const { changed } = setup();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![0]!.signal!;
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 214, clientY: 173 };
    fireEvent.pointerDown(canvas, point);
    expect(signal.aborted).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    await act(async () => completion.resolve(proposedRegion([at(5, 6), at(7, 6)])));
    fireEvent.pointerUp(canvas, point);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(7, 6)]).toBe(0);
  });

  it('keeps a Browse drag moving when a boundary finishes, without canceling the suggestion', async () => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    setup();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![0]!.signal!;
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
    const point = { pointerId: 1, button: 0, isPrimary: true, clientX: 214, clientY: 173 };
    fireEvent.pointerDown(canvas, point);
    expect(signal.aborted).toBe(false);
    await act(async () => completion.resolve(proposedRegion([at(5, 6), at(6, 6)])));
    fireEvent.pointerMove(canvas, { ...point, clientX: 240 });
    expect(screen.getByRole('spinbutton', { name: 'Sagittal slice' })).toHaveValue(8);
    fireEvent.pointerUp(canvas, { ...point, clientX: 240 });
    expect(run).toHaveBeenCalledOnce();
  });




  it('limits plane shortcuts to visible panes and expands without changing the selection', () => {
    const { container, changed } = setup(draft());
    const scene = screen.getByLabelText('3D scene');
    scene.focus();
    fireEvent.keyDown(scene, { key: '1' });
    expect(scene).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    fireEvent.keyDown(scene, { key: '2' });
    const coronal = screen.getByRole('application', { name: /coronal reconstructed slice/i });
    expect(coronal).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Expand axial view' }));
    expect(coronal).not.toBeInTheDocument();
    const axial = screen.getByRole('application', { name: /axial reconstructed slice/i });
    axial.focus();
    fireEvent.keyDown(axial, { key: '2' });
    expect(axial).toHaveFocus();
    fireEvent.keyDown(axial, { key: 'Escape' });
    expect(container.querySelector('.svr-selection-grid')).not.toHaveAttribute('data-expanded');
    fireEvent.keyDown(axial, { key: '2' });
    expect(screen.getByRole('application', { name: /coronal reconstructed slice/i })).toHaveFocus();
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps save failures and selection notices visible before and during editing', () => {
    const { retryStorage } = setup(draft(), { storageError: 'save', selectionNotice: 'A source-grid notice.' });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    expect(screen.getByText('A source-grid notice.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving' }));
    expect(retryStorage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
  });

  it('opens in 3D only and shows the slices with the brush ready on request', () => {
    const { container, changed } = setup(null, {}, { proposeSelection: undefined });
    const grid = container.querySelector('.svr-selection-grid');
    expect(grid).toHaveAttribute('data-expanded', 'volume');
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Brush tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(grid).not.toHaveAttribute('data-expanded');
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider', { name: 'Brush radius in millimeters' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(screen.queryByRole('slider', { name: 'Brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in slice views' }));
    expect(screen.getByRole('group', { name: 'Slice zoom' })).toHaveTextContent('1.5×');
    fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: 'Escape' });
    expect(grid).toHaveAttribute('data-expanded', 'volume');
    expect(screen.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
    expect(changed).not.toHaveBeenCalled();
  });

  it('paints tumor with the brush alone when no original source grid offers auto-fill', () => {
    const { changed } = setup(null, {}, { proposeSelection: undefined });
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    expect(testSelectionProposer).not.toHaveBeenCalled();
    expect(changed.mock.lastCall![0]!.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByText(/Tumor · /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each(['button', 'Escape'] as const)(
    'stops a running auto-fill through the %s and ignores its late result',
    async (method) => {
      const completion = deferred<SelectionProposalResult>();
      const run = testSelectionProposer.mockReturnValue(completion.promise);
      const { changed } = setup();
      fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
      paint();
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      const signal = run.mock.lastCall![0]!.signal!;
      expect(screen.getByRole('status')).toHaveTextContent(/Auto-filling/);
      if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      else fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Axial slice' }), { key: 'Escape' });
      expect(signal.aborted).toBe(true);
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      const marked = changed.mock.lastCall![0];
      await act(async () => completion.resolve(proposedRegion([at(5, 6), at(6, 6)])));
      expect(changed.mock.lastCall![0]).toBe(marked);
      expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(0);
    },
  );

  it('keeps a running auto-fill alive while viewing 3D only and applies its result', async () => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    const { changed, container } = setup();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![0]!.signal!;
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await act(async () => completion.resolve(proposedRegion([at(5, 6), at(6, 6)])));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('shows a saved selection without re-running auto-fill and toggles tumor-only display', () => {
    const run = testSelectionProposer;
    const { changed } = setup({ ...draft(), contextLimited: true });
    expect(screen.getByText(/Tumor · 0\.00 mL/)).toBeInTheDocument();
    expect(screen.getByText(/limited source region/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Tumor only' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Tumor only' }));
    expect(screen.getByRole('button', { name: 'Tumor only' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    expect(screen.getByRole('button', { name: 'Clear tumor selection' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(run).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('retains boundary and limited-context warnings after auto-fill and while viewing 3D', async () => {
    const run = testSelectionProposer.mockResolvedValue({
      ...proposedRegion(Uint32Array.of(at(5, 6), at(6, 6))),
      boundaryCount: 1,
      contextLimited: true,
    });
    const { changed } = setup();
    fireEvent.click(screen.getByRole('button', { name: '3D + slices' }));
    paint();
    await screen.findByText(/reached the edge/i);
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByText(/reached the edge/i)).toBeInTheDocument();
    expect(screen.getByText(/limited source region/i)).toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
    expect(run).toHaveBeenCalledOnce();
  });
});
