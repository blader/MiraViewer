import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvrSegmentationEditor } from '../src/components/SvrSegmentationEditor';
import { SvrImagingContext } from '../src/components/svrImagingContext';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { SeededVolumeWorker } from '../src/utils/segmentation/seededVolumeWorker';

type EditorProps = ComponentProps<typeof SvrSegmentationEditor>;
type SelectionResult = Awaited<ReturnType<SeededVolumeWorker['run']>>;
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
) {
  const source = volume();
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
      <SvrImagingContext.Provider value={{ volume: source, labels }}>
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

function paint(x = 5, y = 6) {
  fireEvent.click(screen.getByRole('button', { name: 'Mark inside' }));
  fireEvent.change(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' }), {
    target: { value: '0.5' },
  });
  const canvas = screen.getByRole('application', { name: /axial reconstructed slice/i });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 320));
  const point = {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 40 + ((x + 0.5) * 320) / 12,
    clientY: ((y + 0.5) * 320) / 12,
  };
  fireEvent.pointerDown(canvas, point);
  fireEvent.pointerUp(canvas, point);
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
    expect(screen.getByRole('button', { name: 'Mark inside' })).toHaveAttribute('aria-pressed', 'true');
    for (const name of [
      'Suggest boundary',
      'Confirm selection',
      'Undo selection edit',
      'Redo selection edit',
      'Clear selection',
    ])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByText(/outside marks are optional/i)).toBeInTheDocument();
    expect(screen.getByText(/not automatic tumor detection/i)).not.toBeVisible();
    expect([...container.querySelectorAll('canvas')]).toEqual(canvases);
    expect(changed).not.toHaveBeenCalled();
  });

  it('shows brush size only for painting and keeps slice zoom in a collapsed settings disclosure', () => {
    setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Navigate' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark outside' }));
    expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toHaveValue('2');
    fireEvent.change(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' }), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark inside' }));
    expect(screen.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toHaveValue('3');
    const summary = screen.getByText('Slice settings', { selector: 'summary' });
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Zoom in slice views' })).not.toBeVisible();
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in slice views' }));
    expect(screen.getByRole('group', { name: 'Slice zoom' })).toHaveTextContent('1.5×');
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
      expect(screen.getByRole('button', { name: 'Navigate' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Navigate' })).toHaveAttribute('aria-pressed', 'true');
      for (const name of ['Mark inside', 'Mark outside']) expect(screen.getByRole('button', { name })).toBeDisabled();
      for (const name of ['Suggest boundary', 'Confirm selection']) {
        if (withSelection) expect(screen.getByRole('button', { name })).toBeDisabled();
        else expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
      expect(screen.queryByRole('slider', { name: 'Selection brush radius in millimeters' })).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('application', { name: /axial reconstructed slice/i }), { key: ']' });
      expect(screen.getByRole('spinbutton', { name: 'Axial slice' })).toHaveValue(8);
      expect(screen.getByText('Restoring saved selection.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'View in 3D' }));
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
    paint();
    expect(screen.getByRole('button', { name: 'Suggest boundary' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled();
    const marked = changed.mock.lastCall![0]!;
    expect(marked.reviewState).toBe('draft');
    expect(marked.seeds!.foreground).toEqual(Uint32Array.of(at(5, 6)));
    fireEvent.click(screen.getByRole('button', { name: 'View in 3D' }));
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
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Redo selection edit' }));
    expect(changed.mock.lastCall![0]!.data).toEqual(marked.data);
    expect(changed.mock.lastCall![0]!.seeds).toEqual(marked.seeds);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(changed.mock.lastCall![0]!.data.some(Boolean)).toBe(false);
    expect(screen.getByRole('button', { name: 'Undo selection edit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
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
    const confirm = screen.getByRole('button', { name: 'Confirm selection' });
    confirm.focus();
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    expect(changed.mock.lastCall![0]).toMatchObject({ data: initial.data, reviewState: 'reviewed' });
    expect(show3D).toHaveBeenCalledOnce();
    expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    expect(screen.getByText(/Reviewed selection ·/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm selection' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit selection' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeDisabled();
    paint(6, 6);
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled();
  });

  it('allows a restored mask without suggestion marks to be cleared or confirmed directly', () => {
    const initial = { ...draft(), seeds: undefined };
    const { changed } = setup(initial);
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Suggest boundary' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
    expect(changed.mock.lastCall![0]).toMatchObject({ data: initial.data, reviewState: 'reviewed' });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'button', full3D: true },
    { method: 'Escape', full3D: true },
    { method: 'Escape', full3D: false },
  ])('keeps cancellation ahead of navigation through $method (full 3D: $full3D)', async ({ method, full3D }) => {
    let complete!: (result: SelectionResult) => void;
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const dispose = vi.spyOn(SeededVolumeWorker.prototype, 'dispose');
    const { container, changed, show3D } = setup(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suggest boundary' }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const signal = run.mock.lastCall![1]!.signal!;
    if (full3D) fireEvent.click(screen.getByRole('button', { name: 'View in 3D' }));
    expect(signal.aborted).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('3D scene')).toHaveAttribute('data-running', 'true');
    expect(screen.getByRole('button', { name: 'Cancel suggestion' })).toBeEnabled();
    if (method === 'button') fireEvent.click(screen.getByRole('button', { name: 'Cancel suggestion' }));
    else
      fireEvent.keyDown(
        full3D ? screen.getByLabelText('3D scene') : screen.getByRole('spinbutton', { name: 'Axial slice' }),
        { key: 'Escape' },
      );
    expect(signal.aborted).toBe(true);
    if (full3D) expect(container.querySelector('.svr-selection-grid')).toHaveAttribute('data-expanded', 'volume');
    else expect(container.querySelector('.svr-selection-grid')).not.toHaveAttribute('data-expanded');
    expect(show3D).toHaveBeenCalledTimes(Number(full3D));
    await act(async () =>
      complete({
        indices: Uint32Array.of(at(6, 6)),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
        boundaryCount: 0,
        domainVoxels: 1728,
      }),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel suggestion' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('3D scene')).toHaveAttribute('data-running', 'false');
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
    fireEvent.click(screen.getByRole('button', { name: 'View in 3D' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Suggest boundary' }));
    await screen.findByText(/selection reaches the search boundary/i);
    fireEvent.click(screen.getByRole('button', { name: 'View in 3D' }));
    expect(screen.getByText(/selection reaches the search boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/memory-limited region/i)).toBeInTheDocument();
    expect(changed.mock.lastCall![0]!.reviewState).toBe('draft');
  });
});
