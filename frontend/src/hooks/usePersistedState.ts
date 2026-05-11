import { useEffect, useState } from 'react';
import { readLocalStorageJson, writeLocalStorageJson } from '../utils/persistence';

/**
 * Like useState, but reads the initial value from localStorage and writes it back on change.
 *
 * `validate` is called on the raw stored value (which is `unknown`); return `null` to fall back
 * to `defaultValue`, or return the validated `T` to use it.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  validate: (raw: unknown) => T | null,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readLocalStorageJson(key);
    return raw === null ? defaultValue : validate(raw) ?? defaultValue;
  });

  useEffect(() => {
    writeLocalStorageJson(key, value);
  }, [key, value]);

  return [value, setValue];
}
