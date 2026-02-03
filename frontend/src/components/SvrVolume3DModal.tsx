import { X } from 'lucide-react';
import type { SvrVolume } from '../types/svr';
import { SvrVolume3DViewer } from './SvrVolume3DViewer';

export type SvrVolume3DModalProps = {
  volume: SvrVolume;
  onClose: () => void;
};

export function SvrVolume3DModal({ volume, onClose }: SvrVolume3DModalProps) {
  const [nx, ny, nz] = volume.dims;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[1200px] max-w-[96vw] h-[80vh] max-h-[96vh] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)]">SVR 3D Viewer</div>
            <div className="text-[10px] text-[var(--text-tertiary)] truncate">
              {nx}×{ny}×{nz}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <SvrVolume3DViewer volume={volume} />
        </div>
      </div>
    </div>
  );
}
