// Page / block wording for messages (2026-11-12 UX audit FLOW-16 / FIRST-12):
// the screen never says "unit"; it says ページ (NTAG) or ブロック (MIFARE /
// FeliCa), and lists numbers the way the binary editor labels its rows (FeliCa
// uses the real block number, e.g. MC = 0x88). Owner: renderer-core.
import type { LanguageSetting } from '@shared/types';
import type { TagKind } from '@shared/tags';
import { felicaBlockOfUnit, isFelica, specFor } from '@shared/tags';
import { translate } from '../i18n';

/** Label of one unit index as the binary editor shows it ("16", FeliCa "0x88"). */
export function unitLabel(kind: TagKind, unit: number): string {
  if (isFelica(kind)) return '0x' + felicaBlockOfUnit(kind, unit).toString(16).toUpperCase().padStart(2, '0');
  return String(unit);
}

/** "3 ページ" / "3 pages" / "1 block". */
export function unitCount(kind: TagKind, n: number, lang: LanguageSetting): string {
  const u = specFor(kind).unit;
  const key = u === 'page' ? (n === 1 ? 'unit.count.page.one' : 'unit.count.page.many') : n === 1 ? 'unit.count.block.one' : 'unit.count.block.many';
  return translate(lang, key, { n });
}

/**
 * Sorted, de-duplicated runs: [16,17,18,20] -> [[16,18],[20,20]]. Runs follow
 * unit indices (contiguous in the grid), so a FeliCa run 0x0D..0x88 is fine.
 */
export function unitRuns(units: Iterable<number>): [number, number][] {
  const sorted = [...new Set(units)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const u of sorted) {
    const last = runs[runs.length - 1];
    if (last && u === last[1] + 1) last[1] = u;
    else runs.push([u, u]);
  }
  return runs;
}

/** At most this many list items (single numbers or ranges) before "ほか N か所". */
const MAX_ITEMS = 8;

/**
 * "ページ 16・17" / "pages 16, 17" / "ページ 40〜225" / "ブロック 0x0D・0x88".
 * Runs of 3+ become a range; long lists end with "ほか N か所".
 */
export function unitList(kind: TagKind, units: Iterable<number>, lang: LanguageSetting): string {
  const runs = unitRuns(units);
  const items: string[] = [];
  let total = 0;
  for (const [a, b] of runs) {
    const len = b - a + 1;
    total += len;
    if (len >= 3) items.push(translate(lang, 'unit.list.range', { from: unitLabel(kind, a), to: unitLabel(kind, b) }));
    else for (let u = a; u <= b; u++) items.push(unitLabel(kind, u));
  }
  const sep = translate(lang, 'unit.list.sep');
  let list = items.slice(0, MAX_ITEMS).join(sep);
  if (items.length > MAX_ITEMS) list = translate(lang, 'unit.list.more', { list, n: items.length - MAX_ITEMS });
  const u = specFor(kind).unit;
  const key = u === 'page' ? (total === 1 ? 'unit.list.page.one' : 'unit.list.page.many') : total === 1 ? 'unit.list.block.one' : 'unit.list.block.many';
  return translate(lang, key, { list });
}
