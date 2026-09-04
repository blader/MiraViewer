import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrSegmentationEditor } from '../src/components/SvrSegmentationEditor';
import { createSvrImagingOperations, SvrImagingContext } from '../src/components/svrImagingContext';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import type { SelectionProposer, SelectionProposalResult } from '../src/utils/segmentation/selectionProposal';
import {
  estimateInteractiveSelectionMemory,
  InteractiveSelectionMemoryError,
} from '../src/utils/segmentation/interactiveAdmission';
import { paint, proposedRegion, setAutoFill, testSelectionProposer } from './helpers/selectionInteraction';
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

function nativeOverview(): SvrVolume {
  return { ...volume(), nativeVoxelSizeMm: [0.5, 0.5, 1] };
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
    const [savedWindow, setWindowRange] = useState<[number, number]>([0, 1]);
    const [cutaway, setCutaway] = useState(false);
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
          setWindowRange={setWindowRange}
          cutaway={cutaway}
          setCutaway={setCutaway}
          onShow3D={show3D}
        >
          {(running) => <canvas aria-label="3D scene" tabIndex={0} data-running={running} />}
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

it('offers brush-only editing before marking when the accepted source has no learned proposal capability', () => {
  const { changed } = setup(null, {}, { proposeSelection: undefined });
  fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
  const automatic = screen.getByRole('checkbox', { name: 'Auto-fill' });
  expect(automatic).toBeDisabled();
  expect(automatic).not.toBeChecked();
  expect(screen.getByText(/Auto-fill requires an original native source grid/)).toBeVisible();
  paint();
  expect(testSelectionProposer).not.toHaveBeenCalled();
  expect(changed.mock.lastCall![0]!.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(changed.mock.lastCall![0]!.reviewState).toBe('reviewed');
  fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
  expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
});

describe('Focused SVR tissue-selection workflow', () => {
  it('opens in 3D and mounts source planes only when entering the editing workspace', () => {
    const { container, changed } = setup();
    const grid = container.querySelector('.svr-selection-grid');
    const canvases = [...container.querySelectorAll('canvas')];
    expect(canvases).toEqual([screen.getByLabelText('3D scene')]);
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(0);
    expect(grid).toHaveAttribute('data-expanded', 'volume');
    expect(screen.getByRole('heading', { name: '3D volume' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Selection tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Region visualization' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    expect(grid).not.toHaveAttribute('data-expanded');
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeChecked();
    for (const name of [
      'Suggest boundary',
      'Confirm selection',
      'Undo selection edit',
      'Redo selection edit',
      'Clear selection',
    ])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByText(/auto-fill follows your brush/i)).toBeInTheDocument();
    expect(screen.getByText(/not automatic tumor detection/i)).not.toBeVisible();
    expect(container.querySelectorAll('canvas[data-plane]')).toHaveLength(3);
    expect(screen.getByLabelText('3D scene')).toBe(canvases[0]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not paint hidden slices during 3D browsing and reopens with the latest cursor, contrast, and labels', () => {
    const paints = recordSlicePaints();
    const run = testSelectionProposer;
    const { container, source, changed, updateView } = setup();
    const original = source.data.slice();
    const scene = screen.getByLabelText('3D scene');
    expect(paints).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
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

  it('shows brush size only for painting and keeps slice zoom in a collapsed settings disclosure', () => {
    setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toHaveValue('2');
    fireEvent.change(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' }), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toHaveValue('3');
    const summary = screen.getByText('Slice settings', { selector: 'summary' });
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Zoom in slice views' })).not.toBeVisible();
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in slice views' }));
    expect(screen.getByRole('group', { name: 'Slice zoom' })).toHaveTextContent('1.5×');
  });

  it('shows one original-detail action outside advanced settings without making it a required review step', () => {
    const initial = draft();
    const refineRegion = vi.fn();
    const { changed, source, container } = setup(initial, {}, { volume: nativeOverview(), refineRegion });
    expect(screen.queryByRole('button', { name: 'Use original detail' })).not.toBeInTheDocument();
    expect(container.querySelector('.svr-selection-native-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    const action = screen.getByRole('button', { name: 'Use original detail' });
    expect(action).toBeVisible();
    expect(action).toBeEnabled();
    expect(action.closest('details')).toBeNull();
    expect(screen.getByText('1.00 mm overview')).toBeVisible();
    expect(screen.getByText(/original MRI samples, not inferred enhancement/)).toBeVisible();
    expect(screen.getByText('Slice settings', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    expect(screen.getAllByRole('button', { name: 'Use original detail' })).toHaveLength(1);
    expect(screen.getAllByText(/1\.00 mm overview/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load native detail' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refine region/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(changed.mock.lastCall![0]).toMatchObject({ data: initial.data, dims: source.dims, reviewState: 'reviewed' });
    expect(refineRegion).not.toHaveBeenCalled();
    expect(container.querySelector('.svr-selection-native-detail')).not.toBeInTheDocument();
  });

  it('offers original detail only after selecting tissue and forwards the current draft unchanged', () => {
    const refineRegion = vi.fn();
    const { source, changed, operations } = setup(null, {}, { volume: nativeOverview(), refineRegion });
    const original = source.data.slice();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    expect(screen.getByText('1.00 mm overview')).toBeVisible();
    expect(screen.getByText('Select a region to load its original detail.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use original detail' })).not.toBeInTheDocument();
    expect(refineRegion).not.toHaveBeenCalled();
    setAutoFill(false);
    paint(5, 6);
    const first = changed.mock.lastCall![0];
    paint(6, 6);
    const current = changed.mock.lastCall![0];
    const writes = changed.mock.calls.length;
    expect(current).not.toBe(first);
    expect(current!.reviewState).toBe('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Use original detail' }));
    expect(refineRegion).toHaveBeenCalledOnce();
    expect(refineRegion.mock.lastCall![0]).toBe(current);
    const prepareMemory = () => operations.prepare('refinement').retainedBytes;
    const retainedBuffers = new Set(
      changed.mock.calls.flatMap(([labels, patch]) => [
        labels!.seeds!.foreground.buffer,
        labels!.seeds!.background.buffer,
        patch!.indices.buffer,
        patch!.before.buffer,
        patch!.after.buffer,
      ]),
    );
    expect(prepareMemory).toEqual(expect.any(Function));
    expect(prepareMemory()).toBe([...retainedBuffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0));
    expect(changed).toHaveBeenCalledTimes(writes);
    expect(current!.reviewState).toBe('draft');
    expect(source.data).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(first!.data);
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(current!.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(current!.seeds);
  });

  it('keeps an already-native editor free of the overview row and redundant detail actions', () => {
    const refineRegion = vi.fn();
    const source: SvrVolume = { ...volume(), nativeVoxelSizeMm: [1, 1, 1] };
    const { container } = setup(draft(), {}, { volume: source, refineRegion });
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(container.querySelector('.svr-selection-native-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    for (const name of ['Use original detail', 'Load native detail', /Refine region/])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByText(/1\.00 mm stored samples/)).toBeVisible();
    expect(refineRegion).not.toHaveBeenCalled();
  });

  it('keeps non-native reconstruction refinement in Slice settings', () => {
    const initial = draft();
    const refineRegion = vi.fn();
    const { container } = setup(initial, {}, { refineRegion });
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(container.querySelector('.svr-selection-native-detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use original detail' })).not.toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Refine region · 0.50 mm' });
    expect(action).not.toBeVisible();
    fireEvent.click(screen.getByText('Slice settings', { selector: 'summary' }));
    expect(action).toBeVisible();
    expect(action).toBeEnabled();
    expect(action.closest('details')).toBe(
      screen.getByText('Slice settings', { selector: 'summary' }).closest('details'),
    );
    fireEvent.click(action);
    expect(refineRegion).toHaveBeenCalledExactlyOnceWith(initial);
  });

  it.each(['read-only', 'loading', 'busy'] as const)('locks original-detail loading while %s', (reason) => {
    const refineRegion = vi.fn();
    const disabled = reason !== 'busy';
    const { changed } = setup(
      draft(),
      { disabled, disabledReason: reason === 'loading' ? 'Restoring saved selection.' : 'Read-only selection.' },
      { volume: nativeOverview(), refineRegion, busy: reason === 'busy' },
    );
    fireEvent.click(screen.getByRole('button', { name: disabled ? 'View slices' : 'Edit selection' }));
    const action = screen.getByRole('button', { name: 'Use original detail' });
    expect(action).toBeVisible();
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(refineRegion).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('locks original-detail loading throughout queued and running auto-fill', async () => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    const refineRegion = vi.fn();
    const { changed, operations } = setup(draft(), {}, { volume: nativeOverview(), refineRegion });
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    paint(6, 6);
    const action = screen.getByRole('button', { name: 'Use original detail' });
    expect(action).toBeDisabled();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(action);
    expect(refineRegion).not.toHaveBeenCalled();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(refineRegion).not.toHaveBeenCalled();
    await act(async () => completion.resolve(proposedRegion([at(7, 6)])));
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    expect(refineRegion.mock.lastCall![0]).toBe(changed.mock.lastCall![0]);
    const current = changed.mock.lastCall![0];
    const writes = changed.mock.calls.length;
    expect(operations.prepare('refinement').retainedBytes).toBeGreaterThan(0);
    expect(changed).toHaveBeenCalledTimes(writes);
    expect(changed.mock.lastCall![0]).toBe(current);
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
  });

  it('explains when original-detail loading is unavailable without starting another operation', () => {
    const { changed } = setup(draft(), {}, { volume: nativeOverview() });
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    const action = screen.getByRole('button', { name: 'Use original detail' });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('title', 'Original-detail loading is unavailable in this view.');
    fireEvent.click(action);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it.each([false, true])(
    'keeps read-only inspection navigable while painting remains locked (selection: %s)',
    (withSelection) => {
      const { container, changed } = setup(withSelection ? draft() : null, {
        disabled: true,
        disabledReason: 'Restoring saved selection.',
      });
      expect(screen.getByRole('button', { name: 'View slices' })).toBeEnabled();
      expect(screen.getByText('Restoring saved selection.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'View slices' }));
      expect(container.querySelector('.svr-selection-grid')).not.toHaveAttribute('data-expanded');
      expect(screen.getByRole('button', { name: 'Browse' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'true');
      for (const name of ['Add', 'Remove']) expect(screen.getByRole('button', { name })).toBeDisabled();
      for (const name of ['Suggest boundary', 'Done']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
      expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeDisabled();
      expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: ']' });
      expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(8);
      expect(screen.getByText('Restoring saved selection.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Back to 3D' }));
      expect(screen.getByRole('button', { name: 'View slices' })).toBeEnabled();
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it('preserves drafts, marks, undo and redo across 3D viewing, including undoable clear', () => {
    const { container, changed, show3D, source } = setup();
    const original = source.data.slice();
    const run = testSelectionProposer;
    const canvases = [...container.querySelectorAll('canvas')];
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    const firstAxial = screen.getByRole('application', { name: /axial reconstructed slice/i });
    setAutoFill(false);
    paint();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    const marked = changed.mock.lastCall![0]!;
    expect(marked.reviewState).toBe('draft');
    expect(marked.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
    fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: 'Escape' });
    expect(show3D).toHaveBeenCalledOnce();
    expect(changed.mock.lastCall![0]).toBe(marked);
    expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    expect([...container.querySelectorAll('canvas')]).toEqual(canvases);
    expect(firstAxial).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('application', { name: /axial reconstructed slice/i })).not.toBe(firstAxial);
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Expand axial view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(screen.getByRole('button', { name: 'Redo selection edit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all views' }));
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
    expect(run).not.toHaveBeenCalled();
    expect(source.data).toEqual(original);
  });

  it('returns to 3D as reviewed only after explicit confirmation and makes later marks a draft', () => {
    const initial = draft();
    const { container, changed, show3D } = setup(initial);
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    const confirm = screen.getByRole('button', { name: 'Done' });
    confirm.focus();
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    expect(changed.mock.lastCall![0]).toMatchObject({ data: initial.data, reviewState: 'reviewed' });
    expect(show3D).toHaveBeenCalledOnce();
    expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit selection' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    setAutoFill(false);
    paint(6, 6);
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('allows a restored mask without suggestion marks to be cleared or confirmed directly', () => {
    const initial = { ...draft(), seeds: undefined };
    const { changed } = setup(initial);
    const run = testSelectionProposer;
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(changed.mock.lastCall![0]).toMatchObject({ data: initial.data, reviewState: 'reviewed' });
    expect(run).not.toHaveBeenCalled();
  });

  it('auto-fills only after a new stroke and undoes the stroke and its filled boundary together', async () => {
    const run = testSelectionProposer.mockResolvedValue(proposedRegion([at(5, 6), at(6, 6)]));
    const { changed, source } = setup();
    const original = source.data.slice();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    expect(run).not.toHaveBeenCalled();
    paint();
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(0);
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
    const filled = changed.mock.lastCall![0]!;
    expect(filled.data[at(6, 6)]).toBe(1);
    expect(filled.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
    expect(filled.reviewState).toBe('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(changed.mock.lastCall![0]!.seeds?.foreground.length ?? 0).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    expect(proposeSelection).not.toHaveBeenCalled();
    paint();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    await waitFor(() => expect(proposeSelection).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled());
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
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByText(/only part of the predicted tissue is retained/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText(/only part of the predicted tissue is retained/i)).toBeVisible();
    expect(proposeSelection).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])(
    'restores context evidence %s without inferring coverage or rerunning',
    (contextLimited) => {
      const proposeSelection = vi.fn<SelectionProposer>();
      setup({ ...draft(), ...(contextLimited !== undefined ? { contextLimited } : {}) }, {}, { proposeSelection });
      fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
      const warning = screen.queryByText(/limited source region/i);
      if (contextLimited) expect(warning).toBeVisible();
      else expect(warning).not.toBeInTheDocument();
      setAutoFill(false);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      if (contextLimited) expect(screen.getByText(/limited source region/i)).toBeVisible();
      expect(proposeSelection).not.toHaveBeenCalled();
    },
  );

  it.each(['draft', 'reviewed'] as const)(
    'does not run auto-fill on restoring, browsing, or reopening a %s selection',
    (reviewState) => {
      const run = testSelectionProposer;
      const { changed } = setup({ ...draft(), reviewState });
      fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
      const axial = screen.getByRole('application', { name: /axial reconstructed slice/i });
      fireEvent.keyDown(axial, { key: ']' });
      fireEvent.keyDown(axial, { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
      expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
      expect(run).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      if (reviewState === 'reviewed') {
        setAutoFill(false);
        setAutoFill(true);
        expect(run).not.toHaveBeenCalled();
      }
    },
  );

  it('offers a retry only after failure while preserving direct brush editing', async () => {
    const run = testSelectionProposer
      .mockRejectedValueOnce(new Error('Boundary worker unavailable'))
      .mockResolvedValue(proposedRegion([at(5, 6), at(6, 6)]));
    const { changed } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.queryByRole('button', { name: 'Retry boundary' })).not.toBeInTheDocument();
    setAutoFill(false);
    setAutoFill(true);
    await screen.findByText('Boundary worker unavailable');
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry boundary' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(changed).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    });
    expect(screen.queryByRole('button', { name: 'Retry boundary' })).not.toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(1);
  });

  it('keeps literal Add marks and exposes collapsed memory estimate details until an explicit successful retry', async () => {
    const source = volume();
    const original = source.data.slice();
    const counts = { conditioningFrames: 1, maximumFramePrompts: 2, literalMarkCount: 2 };
    const retainedBytes = source.data.byteLength + source.observedSupport!.byteLength;
    const estimate = estimateInteractiveSelectionMemory({
      retainedBytes,
      sourceLoadPeakBytes: retainedBytes,
      contextBytes: source.data.length * 5,
      editingVoxels: source.data.length,
      width: source.dims[0],
      height: source.dims[1],
      frameCount: source.dims[2],
      ...counts,
    });
    const error = new InteractiveSelectionMemoryError(estimate, 1024 * 1024 * 1024, counts);
    const prediction = new Uint8Array(source.data.length);
    prediction[at(7, 6)] = 1;
    const proposeSelection = vi
      .fn<SelectionProposer>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: prediction, boundaryCount: 0, contextLimited: false });
    const legacy = testSelectionProposer;
    const { changed } = setup(draft(), {}, { volume: source, proposeSelection });
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    paint(6, 6);
    const marked = changed.mock.lastCall![0]!;
    const dataBefore = marked.data.slice();
    const foreground = marked.seeds!.foreground.slice();
    const background = marked.seeds!.background.slice();
    const summary = await screen.findByText('Memory estimate details', { selector: 'summary' });
    const details = summary.closest('details')!;
    expect(screen.getByRole('alert')).toHaveTextContent(error.message);
    expect(screen.getByRole('alert')).toContainElement(details);
    expect(summary).toBeVisible();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('Preparing MRI samples')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry boundary' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.lastCall![0]).toBe(marked);
    expect(marked.data).toEqual(dataBefore);
    expect(marked.seeds!.foreground).toEqual(foreground);
    expect(marked.seeds!.background).toEqual(background);
    expect([...foreground]).toEqual([at(5, 6), at(6, 6)]);
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    for (const label of [
      'Preparing MRI samples',
      'Suggesting boundaries',
      'Saving the selection',
      'Existing MRI, viewers and history',
      'Native MRI region and output mask',
      'Model and runtime reserve',
      'Cross-slice tracking',
      'Busiest slice’s prompts',
      'Working buffers',
    ])
      expect(screen.getByText(label)).toBeVisible();
    expect(details).toHaveTextContent('only the largest counts toward the safety budget');
    expect(details).toHaveTextContent('1 marked slice · 2 maximum prompts per slice · 2 literal marks kept');
    expect(details).toHaveTextContent('estimates, not measured RAM usage');
    const mib = (bytes: number) =>
      `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
    for (const [label, bytes] of [
      ['Preparing MRI samples', estimate.sourcePeakBytes],
      ['Suggesting boundaries', estimate.trackingPeakBytes],
      ['Saving the selection', estimate.publicationPeakBytes],
      ['Model and runtime reserve', estimate.runtimeAllowanceBytes],
      ['Busiest slice’s prompts', estimate.promptAttentionBytes],
    ] as const)
      expect(screen.getByText(label).nextElementSibling).toHaveTextContent(mib(bytes));
    fireEvent.click(screen.getByRole('button', { name: 'Retry boundary' }));
    expect(screen.queryByText('Memory estimate details')).not.toBeInTheDocument();
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    const filled = changed.mock.lastCall![0]!;
    expect([at(5, 6), at(6, 6), at(7, 6)].map((index) => filled.data[index])).toEqual([1, 1, 1]);
    expect(filled.seeds).toBe(marked.seeds);
    expect(marked.data).toEqual(dataBefore);
    expect(marked.seeds!.foreground).toEqual(foreground);
    expect(marked.seeds!.background).toEqual(background);
    expect(proposeSelection).toHaveBeenCalledTimes(2);
    expect(legacy).not.toHaveBeenCalled();
    expect(source.data).toEqual(original);
  });

  it('discards an unfinished stroke when undo replaces its selection and preserves redo', () => {
    const { changed } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    setAutoFill(false);
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
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
  });

  it('discards lost pointer capture without committing a mark or blocking the next stroke', () => {
    const { changed } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    setAutoFill(false);
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
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
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
    setAutoFill(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(7, 6)]).toBe(0);
  });

  it('keeps a Browse drag moving when a boundary finishes, without canceling the suggestion', async () => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    paint();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![0]!.signal!;
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
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

  it.each(['button', 'Escape'] as const)('stops auto-fill before navigation through %s', async (method) => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    const { container, changed, show3D } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    setAutoFill(true);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![0]!.signal!;
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(signal.aborted).toBe(false);
    expect(screen.getByLabelText('3D scene')).toHaveAttribute('data-running', 'true');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    else fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Axial slice' }), { key: 'Escape' });
    expect(signal.aborted).toBe(true);
    expect(container.querySelector('.svr-selection-grid')).not.toHaveAttribute('data-expanded');
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(show3D).not.toHaveBeenCalled();
    await act(async () =>
      completion.resolve({ ...proposedRegion(Uint32Array.of(at(6, 6))), boundaryCount: 0, contextLimited: false }),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('3D scene')).toHaveAttribute('data-running', 'false');
  });

  it('cancels a running suggestion when leaving the editor without accepting its late result or restarting on re-entry', async () => {
    const completion = deferred<SelectionProposalResult>();
    const run = testSelectionProposer.mockReturnValue(completion.promise);
    const { changed } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    setAutoFill(true);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![0]!.signal!;
    fireEvent.click(screen.getByRole('button', { name: 'Expand 3D view' }));
    expect(signal.aborted).toBe(true);
    await act(async () => completion.resolve(proposedRegion([at(6, 6)])));
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('checkbox', { name: 'Auto-fill' })).toBeChecked();
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it.each(['draft', 'reviewed'] as const)(
    'steps back from editing without changing a %s selection and ignores idle 3D Escape',
    (reviewState) => {
      const initial = { ...draft(), reviewState };
      const original = initial.data.slice();
      const foreground = initial.seeds!.foreground.slice();
      const { container, changed, show3D } = setup(initial);
      const scene = screen.getByLabelText('3D scene');
      scene.focus();
      fireEvent.keyDown(scene, { key: 'Escape' });
      expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
      expect(scene).toHaveFocus();
      expect(show3D).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
      const axial = screen.getByRole('application', { name: /axial reconstructed slice/i });
      axial.focus();
      fireEvent.keyDown(axial, { key: 'Escape' });
      expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
      expect(screen.getByRole('button', { name: 'Edit selection' })).toHaveFocus();
      expect(show3D).toHaveBeenCalledOnce();
      expect(changed).not.toHaveBeenCalled();
      expect(initial.data).toEqual(original);
      expect(initial.seeds!.foreground).toEqual(foreground);
      expect(container.querySelector('.svr-selection-review-state')).toHaveAttribute(
        'data-reviewed',
        String(reviewState === 'reviewed'),
      );
      fireEvent.keyDown(screen.getByRole('button', { name: 'Edit selection' }), { key: 'Escape' });
      expect(show3D).toHaveBeenCalledOnce();
      expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    },
  );

  it('limits plane shortcuts to visible panes and expands without changing the selection', () => {
    const { container, changed } = setup(draft());
    const scene = screen.getByLabelText('3D scene');
    scene.focus();
    fireEvent.keyDown(scene, { key: '1' });
    expect(scene).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
  });

  it('retains boundary and limited-context warnings when viewing a suggested draft in 3D', async () => {
    const run = testSelectionProposer.mockResolvedValue({
      ...proposedRegion(Uint32Array.of(at(5, 6), at(6, 6))),
      boundaryCount: 1,
      contextLimited: true,
    });
    const { changed } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    setAutoFill(true);
    await screen.findByText(/initial prediction reached the edge/i);
    fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: 'Escape' });
    expect(screen.getByText(/initial prediction reached the edge/i)).toBeInTheDocument();
    expect(screen.getByText(/limited source region/i)).toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
    const savedDraft = changed.mock.lastCall![0];
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    expect(screen.getByText(/limited source region/i)).toBeVisible();
    expect(changed.mock.lastCall![0]).toBe(savedDraft);
    run.mockRejectedValueOnce(new Error('Retry could not complete'));
    setAutoFill(true);
    await screen.findByText('Retry could not complete');
    expect(screen.getByText(/limited source region/i)).toBeVisible();
    expect(changed.mock.lastCall![0]).toBe(savedDraft);
  });
});
