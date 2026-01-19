import { useState } from 'react';
import { AlertCircle, CheckCircle, Loader2, Trash2, X } from 'lucide-react';
import { deleteAllStoredMriData } from '../db/db';

interface ClearDataModalProps {
  onClose: () => void;
  /** Called after data is cleared (typically to reload the app). */
  onReset: () => void;
}

const FILTERS_STORAGE_KEY = 'mira-filters-v2';
const PLAYBACK_STORAGE_KEY_PREFIX = 'miraviewer:slice-loop-playback:v2:';
const LEGACY_PLAYBACK_STORAGE_KEY = 'miraviewer:slice-loop-playback:v1';

const PLAYBACK_COOKIE_NAME_V2 = 'miraviewer_slice_loop_playback_v2';
const LEGACY_PLAYBACK_COOKIE_NAME = 'miraviewer_slice_loop_playback_v1';

function deleteCookie(name: string) {
  // Clear at the root path.
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function clearAppLocalStorage() {
  try {
    localStorage.removeItem(FILTERS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PLAYBACK_STORAGE_KEY);

    // Remove per-sequence playback keys.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(PLAYBACK_STORAGE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore quota / privacy mode / disabled storage.
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
      // 1) Delete IndexedDB data (actual MRI payloads + metadata + panel settings).
      await deleteAllStoredMriData();

      // 2) Clear localStorage/cookies (UI state + slice-loop playback state).
      clearAppLocalStorage();
      deleteCookie(PLAYBACK_COOKIE_NAME_V2);
      deleteCookie(LEGACY_PLAYBACK_COOKIE_NAME);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[520px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-red-400" />
            Clear all local data
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            disabled={status === 'clearing'}
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

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
                  this device for MiraViewer (DICOM files, metadata, and saved panel settings).
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

              {status === 'error' && errorMessage && (
                <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded-lg">
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
      </div>
    </div>
  );
}
