export type CookieSameSite = 'Lax' | 'Strict' | 'None';

export type CookieWriteOptions = {
  /** Default: 1 year */
  maxAgeSeconds?: number;
  /** Default: '/' */
  path?: string;
  /** Default: 'Lax' */
  sameSite?: CookieSameSite;
};

export function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readLocalStorageJson(key: string): unknown | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

export function writeLocalStorageJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/blocked storage.
  }
}

export function removeLocalStorageItem(key: string): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore quota/blocked storage.
  }
}

export function safeDecodeURIComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function safeEncodeURIComponent(raw: string): string {
  try {
    return encodeURIComponent(raw);
  } catch {
    // encodeURIComponent should not throw for normal strings, but be defensive.
    return raw;
  }
}

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;

  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);

    if (k === name) {
      return v;
    }
  }

  return null;
}

export function writeCookie(name: string, value: string, options?: CookieWriteOptions): void {
  if (typeof document === 'undefined') return;

  const maxAgeSeconds = options?.maxAgeSeconds ?? 60 * 60 * 24 * 365;
  const path = options?.path ?? '/';
  const sameSite = options?.sameSite ?? 'Lax';

  // Note: we intentionally omit Domain/Secure here.
  document.cookie = `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; SameSite=${sameSite}`;
}

export function readCookieJson(name: string): unknown | null {
  const raw = readCookie(name);
  if (raw === null) return null;

  const decoded = safeDecodeURIComponent(raw);
  if (decoded === null) return null;

  return safeJsonParse(decoded);
}

export function writeCookieJson(name: string, value: unknown, options?: CookieWriteOptions): void {
  const raw = JSON.stringify(value);
  writeCookie(name, safeEncodeURIComponent(raw), options);
}
