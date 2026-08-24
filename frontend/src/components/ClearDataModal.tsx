import { useId, useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, Trash2 } from 'lucide-react';
import { deleteAllStoredMriData } from '../db/db';
import { deleteModelCache } from '../utils/segmentation/onnx/modelCache';
import { isOwnedStorageKey, OWNED_COOKIE_NAMES } from '../utils/storageKeys';
import { AccessibleDialog } from './ui/AccessibleDialog';

interface ClearDataModalProps {
  onClose: () => void;
  /** Called after data is cleared (typically to reload the app). */
  onReset: () => void;
}

function deleteCookie(name: string) {
  // Clear at the root path.
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function clearAppLocalStorage() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !isOwnedStorageKey(key)) continue;
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) {
      throw new Error('Some application settings could not be removed from local storage');
    }
  }
}

export function ClearDataModal({ onClose, onReset }: ClearDataModalProps) {
  const confirmationId = useId();
  const [status, setStatus] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const canConfirm = confirmText.trim().toUpperCase() === 'CLEAR';
  const canClear = canConfirm && status !== 'clearing';

  const handleClear = async () => {
    if (!canClear) return;

    setStatus('clearing');
    setErrorMessage(null);

    try {
      const onBlocked = () => setErrorMessage('Waiting for other MiraViewer tabs to close before deleting local data…');
      await deleteModelCache({ onBlocked });
      await deleteAllStoredMriData({ onBlocked });
      clearAppLocalStorage();
      for (const name of OWNED_COOKIE_NAMES) deleteCookie(name);

      setStatus('success');

      // Give the UI a brief moment to render the success state.
      setTimeout(() => {
        onReset();
      }, 250);
    } catch (e) {
      setStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Failed to clear data');
    }
  };

  return (
    <AccessibleDialog
      title="Clear all local data"
      description="Permanently remove scans and saved work from this browser."
      onClose={() => {
        if (status !== 'clearing') onClose();
      }}
      closeOnBackdrop={status !== 'clearing'}
      closeOnEscape={status !== 'clearing'}
    >
      <div className="px-5 py-6 sm:px-7">
        {status === 'success' ? (
          <div className="flex items-start gap-3 py-4" role="status">
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--evidence)]" aria-hidden="true" />
            <div>
              <h4 className="mb-1 font-medium text-[var(--text-primary)]">Data cleared</h4>
              <p className="text-sm text-[var(--text-secondary)]">Reloading…</p>
            </div>
          </div>
        ) : (
          <>
            <div className="border-l-2 border-[var(--danger)] pl-4">
              <p className="mb-2 font-[family-name:var(--font-mono)] text-[0.68rem] tracking-[0.13em] text-[var(--danger)]">
                PERMANENT REMOVAL
              </p>
              <div className="space-y-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                <p>
                  This will permanently delete <span className="text-[var(--text-primary)]">all</span> MRI data stored
                  on this device for MiraViewer, including DICOM files, annotations, derived alignments, saved settings,
                  and uploaded models.
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  Export a backup ZIP first if you might need this data later.
                </p>
              </div>
            </div>

            <div className="mt-6">
              <label htmlFor={confirmationId} className="text-xs text-[var(--text-secondary)]">
                Type CLEAR to confirm
              </label>
              <input
                id={confirmationId}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={status === 'clearing'}
                className="mt-2 min-h-11 w-full rounded-[3px] border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 font-[family-name:var(--font-mono)] text-sm tracking-[0.08em] text-[var(--text-primary)]"
                placeholder="CLEAR"
              />
            </div>

            {errorMessage && (
              <div
                role={status === 'error' ? 'alert' : 'status'}
                className={`mt-4 flex items-center gap-2 rounded-[3px] border px-3 py-2 text-sm ${status === 'error' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}
              >
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {errorMessage}
              </div>
            )}

            <div className="mt-7 flex flex-wrap justify-end gap-2 border-t border-[var(--border-color)] pt-5">
              <button
                type="button"
                onClick={onClose}
                disabled={status === 'clearing'}
                className="min-h-11 rounded-[3px] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={!canClear}
                className="flex min-h-11 items-center gap-2 rounded-[3px] bg-[var(--danger)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === 'clearing' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Clearing…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Clear all data
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </AccessibleDialog>
  );
}
