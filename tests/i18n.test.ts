// i18n gate. Owner: agent "shell-ui".
// defineMessages already enforces ja/en key parity at COMPILE time; these runtime
// checks catch what types can't: duplicate keys across feature dictionaries and
// mismatched {placeholder} sets between ja and en.
import { describe, it, expect } from 'vitest';
import { dictionaries, dictionaryParts } from '../src/renderer/src/i18n';

function placeholders(s: string): string[] {
  return (s.match(/\{(\w+)\}/g) ?? []).sort();
}

describe('i18n dictionaries', () => {
  it('ja and en have identical key sets', () => {
    const ja = Object.keys(dictionaries.ja).sort();
    const en = Object.keys(dictionaries.en).sort();
    expect(en).toEqual(ja);
  });

  it('no key is defined by two feature dictionaries', () => {
    const seen = new Map<string, number>();
    for (const part of dictionaryParts) {
      for (const key of Object.keys(part.ja)) {
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dups).toEqual([]);
  });

  it('ja and en use the same placeholders for each key', () => {
    const mismatched: string[] = [];
    for (const key of Object.keys(dictionaries.ja)) {
      const ja = placeholders(dictionaries.ja[key as keyof typeof dictionaries.ja]);
      const en = placeholders(dictionaries.en[key as keyof typeof dictionaries.en]);
      if (JSON.stringify(ja) !== JSON.stringify(en)) mismatched.push(`${key}: ja[${ja}] en[${en}]`);
    }
    expect(mismatched).toEqual([]);
  });

  it('no message is an empty string', () => {
    const empties = Object.entries(dictionaries.ja)
      .filter(([, v]) => v.trim() === '')
      .map(([k]) => k);
    expect(empties).toEqual([]);
  });
});
