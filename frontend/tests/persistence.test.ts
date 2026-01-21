import { describe, it, expect, beforeEach } from 'vitest';
import {
  safeJsonParse,
  readLocalStorageJson,
  writeLocalStorageJson,
  readCookie,
  writeCookie,
  readCookieJson,
  writeCookieJson,
} from '../src/utils/persistence';

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

describe('persistence utils', () => {
  it('safeJsonParse returns null on invalid JSON', () => {
    expect(safeJsonParse('{')).toBeNull();
  });

  it('readLocalStorageJson returns parsed JSON or null', () => {
    expect(readLocalStorageJson('missing')).toBeNull();

    writeLocalStorageJson('k1', { a: 1 });
    expect(readLocalStorageJson('k1')).toEqual({ a: 1 });

    localStorage.setItem('k2', '{');
    expect(readLocalStorageJson('k2')).toBeNull();
  });

  it('cookie helpers round-trip values', () => {
    expect(readCookie('missing')).toBeNull();

    writeCookie('plain', 'hello');
    expect(readCookie('plain')).toBe('hello');

    writeCookieJson('obj', { ok: true, n: 2 });
    expect(readCookieJson('obj')).toEqual({ ok: true, n: 2 });
  });
});
