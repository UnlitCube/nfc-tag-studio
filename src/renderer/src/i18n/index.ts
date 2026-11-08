// i18n entry. Integrator-owned (hub): merges the feature dictionaries.
import { useCallback } from 'react';
import type { LanguageSetting } from '@shared/types';
import { useAppStore } from '../store/app';
import { interpolate } from './define';
import common from './common';
import shell from './shell';
import hex from './hex';
import ndef from './ndef';
import schema from './schema';
import issue from './issue';
import backup from './backup';

const parts = [common, shell, hex, ndef, schema, issue, backup] as const;

const ja = { ...common.ja, ...shell.ja, ...hex.ja, ...ndef.ja, ...schema.ja, ...issue.ja, ...backup.ja };
const en = { ...common.en, ...shell.en, ...hex.en, ...ndef.en, ...schema.en, ...issue.en, ...backup.en };

export type MsgKey = keyof typeof ja;
export type TFunc = (key: MsgKey, vars?: Record<string, string | number>) => string;

export const dictionaries: Record<LanguageSetting, Record<MsgKey, string>> = { ja, en };

/** For tests: every dictionary part, to check for duplicate keys across features. */
export const dictionaryParts = parts;

export function translate(lang: LanguageSetting, key: MsgKey, vars?: Record<string, string | number>): string {
  const s = dictionaries[lang][key] ?? dictionaries.ja[key] ?? String(key);
  return interpolate(s, vars);
}

/** React hook: t() bound to the current UI language. */
export function useT(): TFunc {
  const lang = useAppStore((s) => s.settings.language);
  return useCallback<TFunc>((key, vars) => translate(lang, key, vars), [lang]);
}

/** Outside React (event handlers in lib/, stores). */
export function tNow(key: MsgKey, vars?: Record<string, string | number>): string {
  return translate(useAppStore.getState().settings.language, key, vars);
}
