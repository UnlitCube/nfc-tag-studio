// i18n gate. Owner: agent "shell-ui".
// defineMessages already enforces ja/en key parity at COMPILE time; these runtime
// checks catch what types can't: duplicate keys across feature dictionaries and
// mismatched {placeholder} sets between ja and en.
import { describe, it, expect } from 'vitest';
import { dictionaries, dictionaryParts } from '../src/renderer/src/i18n';
import shell from '../src/renderer/src/i18n/shell';
import { HELP_TOPICS, helpContent } from '../src/renderer/src/views/help/helpContent';

function placeholders(s: string): string[] {
  return (s.match(/\{(\w+)\}/g) ?? []).sort();
}

// ---------------------------------------------------------------------------
// D7 terms (2026-11-12 UX rework). Words NOT to show in the Japanese UI, with the
// word to use instead. 1 state = 1 word, so a first-time user is not left
// wondering whether 「読み込む」 and 「読み取る」 are different operations.
// ---------------------------------------------------------------------------
const BANNED_JA: { re: RegExp; use: string }[] = [
  { re: /読み込/u, use: 'タグからは「読み取る」、ファイルは「開く」' },
  { re: /かざ/u, use: '「置く」（リーダーの上に置く）' },
  { re: /タグ(を|が)外/u, use: '「離す」（リーダーから離す）' },
  { re: /単位/u, use: '「ページ」「ブロック」（内部の言葉の「単位」を画面に出さない）' },
  // 「スマートカード サービス」「スマートカードリーダー」は Windows / 機器の名前なので許す。
  { re: /(?<!スマート)カード/u, use: '「タグ」' },
  { re: /\.\.\./u, use: '「…」（U+2026）' },
  { re: /�/u, use: '（置換文字。文字化け）' },
];

function bannedHits(entries: [string, string][]): string[] {
  const hits: string[] = [];
  for (const [key, text] of entries) {
    for (const b of BANNED_JA) if (b.re.test(text)) hits.push(`${key}: /${b.re.source}/ -> ${b.use} | ${text}`);
  }
  return hits;
}

function helpTexts(lang: 'ja' | 'en'): [string, string][] {
  const out: [string, string][] = [];
  const content = helpContent(lang);
  for (const id of HELP_TOPICS) {
    content[id].forEach((block, i) => {
      const parts = [block.heading, ...(block.body ?? []), ...(block.list ?? []), block.note?.text].filter((x): x is string => !!x);
      parts.forEach((p, j) => out.push([`help.${id}[${i}.${j}]`, p]));
    });
  }
  return out;
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

describe('D7 terms (Japanese UI)', () => {
  it('the check can fail (negative control)', () => {
    expect(bannedHits([['x', 'タグをかざしてください']]).length).toBe(1);
    expect(bannedHits([['x', 'まだ読み込んでいません']]).length).toBe(1);
    expect(bannedHits([['x', '3 単位を書き込みました']]).length).toBe(1);
    expect(bannedHits([['x', 'カードを置いてください']]).length).toBe(1);
    expect(bannedHits([['x', '処理中...']]).length).toBe(1);
    // allowed
    expect(bannedHits([['x', 'スマートカード サービスに接続できません']])).toEqual([]);
    expect(bannedHits([['x', 'テンプレートを外す']])).toEqual([]);
    expect(bannedHits([['x', 'タグをリーダーの上に置いてください']])).toEqual([]);
  });

  it('shell (home / status bar / nav / settings / help / first-run guide) uses only D7 terms', () => {
    expect(bannedHits(Object.entries(shell.ja))).toEqual([]);
    expect(bannedHits(helpTexts('ja'))).toEqual([]);
  });

  it('help content: every topic has text in both languages and the same structure', () => {
    const ja = helpContent('ja');
    const en = helpContent('en');
    for (const id of HELP_TOPICS) {
      expect(ja[id].length, id).toBeGreaterThan(0);
      expect(en[id].map((b) => [!!b.heading, b.body?.length ?? 0, b.list?.length ?? 0, b.note?.tone ?? null]), id).toEqual(
        ja[id].map((b) => [!!b.heading, b.body?.length ?? 0, b.list?.length ?? 0, b.note?.tone ?? null]),
      );
    }
  });

  // Every feature dictionary. Owned by the integrator to fix: when this fails, the
  // listed keys (in another feature's i18n/<feature>.ts) need the word on the right.
  it('every Japanese message in the app uses only D7 terms', () => {
    expect(bannedHits(Object.entries(dictionaries.ja))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D12 (2026-11-12, E2E-UX-10): English names the same concept with the same
// words. 「未書き込みの変更」 is "Unsaved changes" everywhere (the status bar and
// the nav already said so while the binary editor said "Unwritten changes").
// ---------------------------------------------------------------------------
const BANNED_EN: { re: RegExp; use: string }[] = [{ re: /\bunwritten\b/i, use: '"unsaved" ("Unsaved changes", D12)' }];

function bannedHitsEn(entries: [string, string][]): string[] {
  const hits: string[] = [];
  for (const [key, text] of entries) {
    for (const b of BANNED_EN) if (b.re.test(text)) hits.push(`${key}: /${b.re.source}/ -> ${b.use} | ${text}`);
  }
  return hits;
}

describe('D12 terms (English UI)', () => {
  it('the check can fail (negative control)', () => {
    expect(bannedHitsEn([['x', 'Unwritten changes: 3 pages']]).length).toBe(1);
    expect(bannedHitsEn([['x', 'Unsaved changes: 3 pages']])).toEqual([]);
  });

  it('shell (home / status bar / nav / settings / help) says "Unsaved changes"', () => {
    expect(bannedHitsEn(Object.entries(shell.en))).toEqual([]);
    expect(bannedHitsEn(helpTexts('en'))).toEqual([]);
  });

  // Every feature dictionary (integrator to fix in the listed feature's i18n file).
  it('every English message in the app says "Unsaved changes", never "Unwritten changes"', () => {
    expect(bannedHitsEn(Object.entries(dictionaries.en))).toEqual([]);
  });
});
