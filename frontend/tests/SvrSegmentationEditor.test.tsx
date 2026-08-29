import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrSegmentationEditor } from '../src/components/SvrSegmentationEditor';
import { SvrImagingContext } from '../src/components/svrImagingContext';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { SeededVolumeWorker } from '../src/utils/segmentation/seededVolumeWorker';
import { paint, proposedRegion, setAutoFill } from './helpers/selectionInteraction';
import { deferred } from './helpers/deferred';

type EditorProps = ComponentProps<typeof SvrSegmentationEditor>;
type ImagingProps = NonNullable<ComponentProps<typeof SvrImagingContext.Provider>['value']>;
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
  imaging: Partial<Pick<ImagingProps, 'volume' | 'refineRegion' | 'busy'>> = {},
) {
  const source = imaging.volume ?? volume();
  const changed = vi.fn<EditorProps['onChange']>();
  const show3D = vi.fn();
  const retryStorage = vi.fn();
  function Workspace() {
    const [labels, setLabels] = useState(initial);
    const [cursor, setCursor] = useState({ x: 6, y: 6, z: 6 });
    const [visualizationMode, setVisualizationMode] = useState<EditorProps['visualizationMode']>('anatomy');
    const [windowRange, setWindowRange] = useState<[number, number]>([0, 1]);
    const [cutaway, setCutaway] = useState(false);
    return (
      <SvrImagingContext.Provider value={{ ...imaging, volume: source, labels }}>
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
  return { ...render(<Workspace />), source, changed, show3D, retryStorage };
}

beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Focused SVR tissue-selection workflow', () => {
  it('opens in 3D and enters an explicit editing workspace without remounting the source planes', () => {
    const { container, changed } = setup();
    const grid = container.querySelector('.svr-selection-grid');
    const canvases = [...container.querySelectorAll('canvas')];
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
    expect([...container.querySelectorAll('canvas')]).toEqual(canvases);
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
    const { source, changed } = setup(null, {}, { volume: nativeOverview(), refineRegion });
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
    const prepareMemory = refineRegion.mock.lastCall![1] as () => number;
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
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    const dispose = vi.spyOn(SeededVolumeWorker.prototype, 'dispose');
    const refineRegion = vi.fn();
    const { changed } = setup(draft(), {}, { volume: nativeOverview(), refineRegion });
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
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(refineRegion.mock.lastCall![0]).toBe(changed.mock.lastCall![0]);
    expect(dispose).not.toHaveBeenCalled();
    const current = changed.mock.lastCall![0];
    const writes = changed.mock.calls.length;
    expect(refineRegion.mock.lastCall![1]()).toBeGreaterThan(0);
    expect(dispose).toHaveBeenCalledOnce();
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
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    const canvases = [...container.querySelectorAll('canvas')];
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo selection edit' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(screen.getByRole('button', { name: 'Redo selection edit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.getByText('No tissue selected')).toBeInTheDocument();
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
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(changed.mock.lastCall![0]).toMatchObject({ data: initial.data, reviewState: 'reviewed' });
    expect(run).not.toHaveBeenCalled();
  });

  it('auto-fills only after a new stroke and undoes the stroke and its filled boundary together', async () => {
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion([at(5, 6), at(6, 6)]));
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

  it.each(['draft', 'reviewed'] as const)(
    'does not run auto-fill on restoring, browsing, or reopening a %s selection',
    (reviewState) => {
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
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
    const run = vi
      .spyOn(SeededVolumeWorker.prototype, 'run')
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
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry boundary' })).not.toBeInTheDocument());
    expect(changed.mock.lastCall![0]!.data[at(5, 6)]).toBe(1);
    expect(changed.mock.lastCall![0]!.data[at(6, 6)]).toBe(1);
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
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    const { changed } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    paint();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![1]!.signal!;
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
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select tissue' }));
    paint();
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![1]!.signal!;
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
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    const dispose = vi.spyOn(SeededVolumeWorker.prototype, 'dispose');
    const { container, changed, show3D } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    setAutoFill(true);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![1]!.signal!;
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(signal.aborted).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
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
      completion.resolve({
        indices: Uint32Array.of(at(6, 6)),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
        boundaryCount: 0,
        domainVoxels: 1728,
      }),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('3D scene')).toHaveAttribute('data-running', 'false');
  });

  it('cancels a running suggestion when leaving the editor without accepting its late result or restarting on re-entry', async () => {
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    const { changed } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    setAutoFill(true);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![1]!.signal!;
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
    const axial = screen.getByRole('application', { name: /axial reconstructed slice/i });
    axial.focus();
    fireEvent.keyDown(axial, { key: '2' });
    expect(axial).toHaveFocus();
    fireEvent.keyDown(axial, { key: 'Escape' });
    expect(container.querySelector('.svr-selection-grid')).not.toHaveAttribute('data-expanded');
    fireEvent.keyDown(axial, { key: '2' });
    expect(coronal).toHaveFocus();
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
    vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.of(at(5, 6), at(6, 6)),
      bounds: { min: { x: 1, y: 1, z: 1 }, max: { x: 11, y: 11, z: 11 } },
      boundaryCount: 1,
      domainVoxels: 1331,
    });
    const { changed } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    setAutoFill(false);
    setAutoFill(true);
    await screen.findByText(/selection reaches the search boundary/i);
    fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: 'Escape' });
    expect(screen.getByText(/selection reaches the search boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/memory-limited region/i)).toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
  });
});
