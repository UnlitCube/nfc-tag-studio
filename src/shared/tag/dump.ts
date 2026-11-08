// Dump-format detection and the unified importer. Pure TypeScript: no Node, no DOM.

import { bytesToUtf8 } from '../hex';
import type { TagKind } from '../tags';
import type { TagImage } from '../types';
import { sniffText } from './_util';
import { binSizeKind, importBin } from './dump-bin';
import { parseProject } from './dump-project';
import { importFlipper } from './dump-flipper';

export type DumpFormat = 'project' | 'bin' | 'flipper';

/** Detect by extension + content sniffing. */
export function detectDumpFormat(fileName: string, bytes: Uint8Array): DumpFormat | null {
  const lower = fileName.toLowerCase();
  const head = sniffText(bytes, 64);
  if (head.startsWith('Filetype: Flipper NFC device') || (lower.endsWith('.nfc') && head.includes('Flipper'))) {
    return 'flipper';
  }
  const text = sniffText(bytes, 8192).trimStart();
  if (text.startsWith('{') && text.includes('nfc-tag-studio/dump')) return 'project';
  if (binSizeKind(bytes.length)) return 'bin';
  return null;
}

/** Detect + parse. Throws Error with a Japanese message when the file is not a supported dump. */
export function importDump(
  fileName: string,
  bytes: Uint8Array,
  kindHint?: TagKind,
): { image: TagImage; note: string; format: DumpFormat } {
  const format = detectDumpFormat(fileName, bytes);
  if (!format) throw new Error('対応していないダンプ形式です（project / bin / flipper のいずれでもありません）');
  if (format === 'project') {
    const { image, note } = parseProject(bytes);
    return { image, note, format };
  }
  if (format === 'flipper') {
    return { image: importFlipper(bytesToUtf8(bytes)), note: '', format };
  }
  return { image: importBin(bytes, kindHint), note: '', format };
}
