import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { InstrumentDialog } from '../../hooks/useComparisonInstrumentUi';
import { AccessibleDialog } from '../ui/AccessibleDialog';

const loaders = {
  help: () => import('../HelpModal').then((module) => module.HelpModal),
  upload: () => import('../UploadModal').then((module) => module.UploadModal),
  export: () => import('../ExportModal').then((module) => module.ExportModal),
  clear: () => import('../ClearDataModal').then((module) => module.ClearDataModal),
};

type DialogProps = {
  onClose: () => void;
  onUploadComplete: () => Promise<void>;
  onReset: () => void;
};

export function ComparisonDialog({ dialog, ...props }: DialogProps & { dialog: Exclude<InstrumentDialog, null> }) {
  const [loaded, setLoaded] = useState<'loading' | 'failed' | { Dialog: ComponentType<DialogProps> }>('loading');

  useEffect(() => {
    let current = true;
    void loaders[dialog]().then(
      (Dialog) => {
        if (current) setLoaded({ Dialog });
      },
      () => {
        if (current) setLoaded('failed');
      },
    );
    return () => {
      current = false;
    };
  }, [dialog]);

  if (typeof loaded === 'object') return <loaded.Dialog {...props} />;
  return (
    <AccessibleDialog title={loaded === 'loading' ? 'Opening dialog' : 'Dialog unavailable'} onClose={props.onClose}>
      <div className="px-5 py-5 sm:px-7">
        <p role={loaded === 'loading' ? 'status' : 'alert'}>
          {loaded === 'loading'
            ? 'Loading…'
            : 'Could not load this dialog. Close this message and finish saving any current edits before reloading MiraViewer. Saved scans stay on this device.'}
        </p>
        {loaded === 'failed' && (
          <button type="button" className="instrument-context-button mt-4" onClick={() => window.location.reload()}>
            Reload MiraViewer
          </button>
        )}
      </div>
    </AccessibleDialog>
  );
}
