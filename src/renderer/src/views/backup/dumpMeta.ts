// Pure helpers for the backup view (no React / DOM). Owner: agent renderer-backup.
// Tested by tests/backup.test.ts.
import { bytesToUtf8 } from '@shared/hex';
import type { TagImage, UnitStatus } from '@shared/types';

/** Metadata of a native dump (.nfcdump) that the shared importer does not hand back: note + when it was saved. */
export interface DumpMeta {
  note: string;
  /** ISO time the file was saved, or null when absent / not a valid date. */
  savedAt: string | null;
}

/**
 * Read the note and the save time of a native project dump (.nfcdump JSON).
 * Returns null for other formats or unparsable bytes (the importer reports those).
 */
export function readDumpMeta(bytes: Uint8Array): DumpMeta | null {
  let doc: unknown;
  try {
    doc = JSON.parse(bytesToUtf8(bytes));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const o = doc as { format?: unknown; note?: unknown; savedAt?: unknown };
  if (o.format !== 'nfc-tag-studio/dump') return null;
  const note = typeof o.note === 'string' ? o.note : '';
  const savedAt = typeof o.savedAt === 'string' && !Number.isNaN(Date.parse(o.savedAt)) ? o.savedAt : null;
  return { note, savedAt };
}

/** Counts of per-unit read status (for "N pages could not be read" warnings). */
export function unitStatusCounts(img: TagImage): Record<UnitStatus, number> {
  const c: Record<UnitStatus, number> = { ok: 0, unread: 0, denied: 0, error: 0 };
  for (const s of img.unitStatus) c[s] = (c[s] ?? 0) + 1;
  return c;
}

/**
 * Short time label: "14:02" when `ms` is today, else date + time
 * ("2026/11/10 14:02"). Used for "read at" / "saved at" next to a tag or file.
 */
export function whenLabel(ms: number, lang: 'ja' | 'en', now: number = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
