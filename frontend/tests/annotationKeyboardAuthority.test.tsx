import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroundTruthPolygonOverlay } from '../src/components/GroundTruthPolygonOverlay';
import { AccessibleDialog } from '../src/components/ui/AccessibleDialog';
import { usePanelSettings } from '../src/hooks/usePanelSettings';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

vi.mock('../src/utils/localApi', () => ({
  getPanelSettings: vi.fn(async () => ({})),
  savePanelSettings: vi.fn(async () => undefined),
  getSopInstanceUidForInstanceIndex: vi.fn(async () => 'synthetic-instance'),
  getTumorGroundTruthForInstance: vi.fn(async () => null),
  saveTumorGroundTruth: vi.fn(async () => undefined),
  deleteTumorGroundTruth: vi.fn(async () => undefined),
}));

const examination = '2035-01-10T12:00:00';
const imageSize = { w: 400, h: 400 };

function AnnotationWorkspace({
  onAnnotationClose,
  onDialogClose,
}: {
  onAnnotationClose: () => void;
  onDialogClose?: () => void;
}) {
  const { panelSettings, updatePanelSetting } = usePanelSettings(
    'synthetic-sequence',
    examination,
    'synthetic-patient',
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const settings = panelSettings.get(examination);

  return (
    <>
      <output aria-label="Synthetic viewer zoom">{settings ? settings.zoom : 'loading'}</output>
      <button type="button" onClick={() => updatePanelSetting(examination, { zoom: 2 })}>
        Change viewer geometry
      </button>
      <input aria-label="Synthetic text input" />
      <select aria-label="Synthetic sequence selector">
        <option>Sequence</option>
      </select>
      <textarea aria-label="Synthetic note area" />
      <div aria-label="Synthetic editable note" contentEditable role="textbox" suppressContentEditableWarning>
        Synthetic note
      </div>
      <button type="button" onClick={() => setDialogOpen(true)}>
        Open synthetic dialog
      </button>
      <div data-testid="annotation-host">
        <GroundTruthPolygonOverlay
          enabled
          onRequestClose={onAnnotationClose}
          comboId="synthetic-sequence"
          dateIso={examination}
          studyId="synthetic-study"
          seriesUid="synthetic-series"
          effectiveInstanceIndex={0}
          viewerTransform={DEFAULT_PANEL_SETTINGS}
          imageSize={imageSize}
        />
      </div>
      {dialogOpen ? (
        <AccessibleDialog
          title="Synthetic dialog"
          onClose={() => {
            onDialogClose?.();
            setDialogOpen(false);
          }}
        >
          <button type="button">Synthetic dialog action</button>
        </AccessibleDialog>
      ) : null}
    </>
  );
}

function addDraftPoints() {
  const overlay = screen.getByTestId('annotation-host').firstElementChild as HTMLElement;
  fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, isPrimary: true, clientX: 40, clientY: 60 });
  fireEvent.pointerDown(overlay, { pointerId: 2, button: 0, isPrimary: true, clientX: 160, clientY: 180 });
  return () => overlay.querySelectorAll('svg.pointer-events-none circle').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 400,
    top: 0,
    left: 0,
    right: 400,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clinical annotation keyboard ownership', () => {
  it('lets an active polygon draft own undo without also mutating viewer geometry', async () => {
    render(<AnnotationWorkspace onAnnotationClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Change viewer geometry' }));
    const draftPointCount = addDraftPoints();
    expect(draftPointCount()).toBe(2);
    expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('2');

    const firstUndo = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(firstUndo);
    });

    expect(firstUndo.defaultPrevented).toBe(true);
    expect(draftPointCount()).toBe(1);
    expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('2');

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    expect(draftPointCount()).toBe(0);
    expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('2');

    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('1');
  });

  it.each([
    ['Synthetic text input', 'Backspace', {}],
    ['Synthetic text input', 'Escape', {}],
    ['Synthetic sequence selector', 'Delete', {}],
    ['Synthetic note area', 'z', { metaKey: true }],
    ['Synthetic editable note', 'z', { ctrlKey: true }],
  ])('leaves focused %s keyboard editing under its native authority', async (label, key, modifiers) => {
    const onAnnotationClose = vi.fn();
    render(<AnnotationWorkspace onAnnotationClose={onAnnotationClose} />);
    await waitFor(() => expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Change viewer geometry' }));
    const draftPointCount = addDraftPoints();
    const editor = screen.getByLabelText(label);
    editor.focus();

    fireEvent.keyDown(editor, { key, ...modifiers, bubbles: true, cancelable: true });

    expect(draftPointCount()).toBe(2);
    expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('2');
    expect(onAnnotationClose).not.toHaveBeenCalled();
  });

  it('preserves real modal shortcut authority and closes only the dialog on Escape', async () => {
    const onAnnotationClose = vi.fn();
    const onDialogClose = vi.fn();
    render(<AnnotationWorkspace onAnnotationClose={onAnnotationClose} onDialogClose={onDialogClose} />);
    await waitFor(() => expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Change viewer geometry' }));
    const draftPointCount = addDraftPoints();
    fireEvent.click(screen.getByRole('button', { name: 'Open synthetic dialog' }));

    const modalAction = screen.getByRole('button', { name: 'Synthetic dialog action' });
    modalAction.focus();
    fireEvent.keyDown(modalAction, { key: 'z', metaKey: true, bubbles: true, cancelable: true });

    expect(draftPointCount()).toBe(2);
    expect(screen.getByLabelText('Synthetic viewer zoom')).toHaveTextContent('2');
    expect(onAnnotationClose).not.toHaveBeenCalled();

    fireEvent.keyDown(modalAction, { key: 'Escape', bubbles: true, cancelable: true });

    expect(onDialogClose).toHaveBeenCalledOnce();
    expect(onAnnotationClose).not.toHaveBeenCalled();
    expect(draftPointCount()).toBe(2);
    expect(screen.queryByRole('dialog', { name: 'Synthetic dialog' })).not.toBeInTheDocument();
  });
});
