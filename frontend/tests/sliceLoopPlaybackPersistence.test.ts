import { describe, it, expect, beforeEach } from 'vitest';
import {
  readPersistedSliceLoopPlaybackSettingsForSeq,
  writePersistedSliceLoopPlaybackSettingsForSeq,
} from '../src/utils/sliceLoopPlaybackPersistence';

function clearAllCookies() {
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    if (!name) continue;
    document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

beforeEach(() => {
  localStorage.clear();
  clearAllCookies();
});

describe('sliceLoopPlaybackPersistence', () => {
  it('prefers per-sequence localStorage when present', () => {
    const seqId = 'axial-t1';

    writePersistedSliceLoopPlaybackSettingsForSeq(seqId, { loopStart: 0.2, loopEnd: 0.8, loopSpeed: 2 });

    const loaded = readPersistedSliceLoopPlaybackSettingsForSeq(seqId);
    expect(loaded).toEqual({ loopStart: 0.2, loopEnd: 0.8, loopSpeed: 2 });
  });

  it('falls back to cookie v2 when localStorage is absent', () => {
    const seqId = 'seq-cookie';

    // Simulate cookie v2 payload
    const cookieObj = {
      bySeq: {
        [seqId]: { loopStart: 0.1, loopEnd: 0.9, loopSpeed: 4, updatedAt: Date.now() },
      },
    };
    document.cookie = `miraviewer_slice_loop_playback_v2=${encodeURIComponent(JSON.stringify(cookieObj))}; Path=/`;

    const loaded = readPersistedSliceLoopPlaybackSettingsForSeq(seqId);
    expect(loaded).toEqual({ loopStart: 0.1, loopEnd: 0.9, loopSpeed: 4 });
  });

  it('migrates legacy global v1 localStorage into per-seq storage', () => {
    const seqId = 'seq-migrate';

    localStorage.setItem('miraviewer:slice-loop-playback:v1', JSON.stringify({ loopStart: 0.3, loopEnd: 0.7, loopSpeed: 2 }));

    const loaded = readPersistedSliceLoopPlaybackSettingsForSeq(seqId);
    expect(loaded).toEqual({ loopStart: 0.3, loopEnd: 0.7, loopSpeed: 2 });

    const perSeqKey = `miraviewer:slice-loop-playback:v2:${encodeURIComponent(seqId)}`;
    expect(localStorage.getItem(perSeqKey)).toBeTruthy();
  });
});
