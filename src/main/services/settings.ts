// Persistent app settings. Owner: main-app.
// Stored at userData/settings.json. Pushes the full settings on every change so
// the renderer's store stays in sync (store.saveSettings serialises updates).
import type { AppSettings } from '@shared/types';
import { readJson, writeJson } from './storage';
import { normaliseSettings } from './policy';

const FILE = 'settings.json';

export interface SettingsService {
  get(): AppSettings;
  save(next: AppSettings): Promise<AppSettings>;
  onChange(cb: (s: AppSettings) => void): () => void;
}

export async function createSettingsService(): Promise<SettingsService> {
  let current = normaliseSettings(await readJson<unknown>(FILE));
  const listeners = new Set<(s: AppSettings) => void>();

  return {
    get: () => current,
    async save(next) {
      current = normaliseSettings(next);
      await writeJson(FILE, current);
      for (const cb of listeners) cb(current);
      return current;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
