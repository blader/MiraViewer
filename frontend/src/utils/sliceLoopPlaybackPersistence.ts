import { readCookieJson, readLocalStorageJson, writeCookieJson, writeLocalStorageJson } from './persistence';
import { clamp01 } from './math';
import { PLAYBACK_STORAGE_KEY_PREFIX, PLAYBACK_COOKIE_NAME_V2 } from './storageKeys';

export type PersistedSliceLoopPlaybackSettings = {
  loopStart: number;
  loopEnd: number;
  loopSpeed: 1 | 2 | 4;
};

type PersistedSliceLoopPlaybackCookieV2 = {
  bySeq: Record<string, (PersistedSliceLoopPlaybackSettings & { updatedAt?: number }) | undefined>;
};

function ensureLoopBounds(start: number, end: number): [number, number] {
  const minGap = 0.01;
  const s = clamp01(start);
  let e = clamp01(end);
  if (e - s < minGap) {
    e = clamp01(s + minGap);
  }
  return [s, e];
}

function makePlaybackStorageKey(seqId: string): string {
  return `${PLAYBACK_STORAGE_KEY_PREFIX}${encodeURIComponent(seqId)}`;
}

function parsePersistedPlaybackValue(value: unknown): PersistedSliceLoopPlaybackSettings | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const sRaw = obj.loopStart;
  const eRaw = obj.loopEnd;
  if (typeof sRaw !== 'number' || !Number.isFinite(sRaw) || typeof eRaw !== 'number' || !Number.isFinite(eRaw)) {
    return null;
  }

  const [loopStart, loopEnd] = ensureLoopBounds(sRaw, eRaw);

  const sp = obj.loopSpeed;
  const loopSpeed: 1 | 2 | 4 = sp === 2 || sp === 4 ? sp : 1;

  return { loopStart, loopEnd, loopSpeed };
}

function readPersistedSliceLoopPlaybackSettingsFromCookieV2(seqId: string): PersistedSliceLoopPlaybackSettings | null {
  const parsed = readCookieJson(PLAYBACK_COOKIE_NAME_V2);
  if (!parsed || typeof parsed !== 'object') return null;

  const bySeq = (parsed as Record<string, unknown>).bySeq;
  if (!bySeq || typeof bySeq !== 'object') return null;

  const entry = (bySeq as Record<string, unknown>)[seqId];
  return parsePersistedPlaybackValue(entry);
}

function writePersistedSliceLoopPlaybackSettingsToCookieV2(seqId: string, settings: PersistedSliceLoopPlaybackSettings) {
  try {
    const existing = readCookieJson(PLAYBACK_COOKIE_NAME_V2);

    let cookieObj: PersistedSliceLoopPlaybackCookieV2 = { bySeq: {} };

    if (existing && typeof existing === 'object') {
      const bySeq = (existing as Record<string, unknown>).bySeq;
      if (bySeq && typeof bySeq === 'object') {
        cookieObj = { bySeq: bySeq as PersistedSliceLoopPlaybackCookieV2['bySeq'] };
      }
    }

    cookieObj.bySeq[seqId] = { ...settings, updatedAt: Date.now() };

    // Prune to keep cookie size reasonable.
    const entries = Object.entries(cookieObj.bySeq)
      .map(([k, v]) => {
        const ts = typeof v?.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
        return [k, ts] as const;
      })
      .sort((a, b) => b[1] - a[1]);

    const MAX_COOKIE_ENTRIES = 25;
    if (entries.length > MAX_COOKIE_ENTRIES) {
      const keep = new Set(entries.slice(0, MAX_COOKIE_ENTRIES).map(([k]) => k));
      for (const key of Object.keys(cookieObj.bySeq)) {
        if (!keep.has(key)) {
          delete cookieObj.bySeq[key];
        }
      }
    }

    writeCookieJson(PLAYBACK_COOKIE_NAME_V2, cookieObj);
  } catch {
    // Ignore blocked cookies.
  }
}

export function readPersistedSliceLoopPlaybackSettingsForSeq(seqId: string): PersistedSliceLoopPlaybackSettings | null {
  // Prefer localStorage (origin-scoped) per sequence.
  const fromLocal = readLocalStorageJson(makePlaybackStorageKey(seqId));
  const localParsed = parsePersistedPlaybackValue(fromLocal);
  if (localParsed) return localParsed;

  // Fallback to cookie (shared across ports on the same host).
  const fromCookie = readPersistedSliceLoopPlaybackSettingsFromCookieV2(seqId);
  if (fromCookie) return fromCookie;

  return null;
}

export function writePersistedSliceLoopPlaybackSettingsForSeq(seqId: string, settings: PersistedSliceLoopPlaybackSettings) {
  try {
    writeLocalStorageJson(makePlaybackStorageKey(seqId), settings);
  } catch {
    // Ignore quota/blocked storage.
  }

  writePersistedSliceLoopPlaybackSettingsToCookieV2(seqId, settings);
}
