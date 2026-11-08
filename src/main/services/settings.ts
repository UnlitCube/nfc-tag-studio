// Persistent app settings. Integrator-owned.
// Stored at userData/settings.json. Pushes the full settings on every change so
// the renderer's store stays in sync (store.saveSettings serialises updates).
import type { AppSettings } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { readJson, writeJson } from './storage';

const FILE = 'settings.json';

export interface SettingsService {
  get(): AppSettings;
  save(next: AppSettings): Promise<AppSettings>;
  onChange(cb: (s: AppSettings) => void): () => void;
}

function normalise(value: Partial<AppSettings> | null): AppSettings {
  const v = value ?? {};
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...v };
  // Guard enum-ish fields against corrupt files.
  if (!['system', 'light', 'dark'].includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  if (!['ja', 'en'].includes(merged.language)) merged.language = DEFAULT_SETTINGS.language;
  if (!['auto', 'acr122', 'transparent', 'storage'].includes(merged.driverMode)) merged.driverMode = 'auto';
  merged.savedJobs = Array.isArray(merged.savedJobs) ? merged.savedJobs : [];
  merged.schemas = Array.isArray(merged.schemas) ? merged.schemas : [];
  return merged;
}

export async function createSettingsService(): Promise<SettingsService> {
  let current = normalise(await readJson<Partial<AppSettings>>(FILE));
  const listeners = new Set<(s: AppSettings) => void>();

  return {
    get: () => current,
    async save(next) {
      current = normalise(next);
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
