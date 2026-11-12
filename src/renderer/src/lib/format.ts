// Display formatting helpers. Integrator-owned.
import type { TagKind } from '@shared/tags';
import { specFor } from '@shared/tags';

/** "04A2B3C4D5E6F7" -> "04:A2:B3:C4:D5:E6:F7" */
export function formatUid(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(':').toUpperCase();
}

/** What the read-only manufacturer id is called for this kind: FeliCa says IDm, the others UID. */
export function idName(kind: TagKind | null | undefined): 'UID' | 'IDm' {
  return kind === 'FELICA_LITE_S' ? 'IDm' : 'UID';
}

export function kindLabel(kind: TagKind | null | undefined): string {
  if (!kind) return '—';
  return specFor(kind).displayName;
}

/** Group hex for display: "E1103E00" -> "E1 10 3E 00". */
export function spacedHex(hex: string): string {
  return (hex.replace(/\s+/g, '').match(/.{1,2}/g) ?? []).join(' ').toUpperCase();
}

export function formatDateTime(ms: number, lang: 'ja' | 'en'): string {
  const d = new Date(ms);
  return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Local timestamp for file names: 20261108-153012 */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Random id for client-side objects (jobs, schemas, records). */
export function newId(prefix = 'id'): string {
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
