import { useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, Trash2 } from 'lucide-react';
import { deleteAllStoredMriData } from '../db/db';
import { deleteModelCache } from '../utils/segmentation/onnx/modelCache';
import { OWNED_COOKIE_NAMES, OWNED_EXACT_STORAGE_KEYS, OWNED_STORAGE_KEY_PREFIX } from '../utils/storageKeys';
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
  const ownedKeys = new Set<string>(OWNED_EXACT_STORAGE_KEYS);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(OWNED_STORAGE_KEY_PREFIX)) ownedKeys.add(key);
  }
  for (const key of ownedKeys) {
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) {
      throw new Error('Some application settings could not be removed from local storage');
    }
  }
}

export function ClearDataModal({ onClose, onReset }: ClearDataModalProps) {
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
      onClose={() => {
        if (status !== 'clearing') onClose();
      }}
      closeOnBackdrop={status !== 'clearing'}
      closeOnEscape={status !== 'clearing'}
    >
      <div className="p-6">
        {status === 'success' ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="w-12 h-12 rounded-full bg-green-500/20 text-green-500 flex items-center justify-center mb-3">
              <CheckCircle className="w-6 h-6" />
            </div>
            <h4 className="text-[var(--text-primary)] font-medium mb-1">Data cleared</h4>
            <p className="text-sm text-[var(--text-secondary)]">Reloading…</p>
          </div>
        ) : (
          <>
            <div className="text-sm text-[var(--text-secondary)] space-y-2">
              <p>
                This will permanently delete <span className="text-[var(--text-primary)]">all</span> MRI data stored on
                this device for MiraViewer, including DICOM files, annotations, derived alignments, saved settings, and
                uploaded models.
              </p>
              <p className="text-xs text-[var(--text-tertiary)]">
                Tip: export a backup ZIP first if you might need this data later.
              </p>
            </div>

            <div className="mt-4">
              <label className="text-xs text-[var(--text-secondary)]">Type CLEAR to confirm</label>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={status === 'clearing'}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]"
                placeholder="CLEAR"
              />
            </div>

            {errorMessage && (
              <div
                className={`mt-4 flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${status === 'error' ? 'text-red-400 bg-red-400/10' : 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]'}`}
              >
                <AlertCircle className="w-4 h-4 shrink-0" />
                {errorMessage}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={status === 'clearing'}
                className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleClear}
                disabled={!canClear}
                className="px-4 py-2 text-sm bg-red-500 text-white hover:bg-red-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {status === 'clearing' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Clearing…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
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
