// Flipper Zero ".nfc" text format (NTAG213/215/216 and MIFARE Classic 1K/4K).
// Compatible with Flipper "Filetype: Flipper NFC device" Version 4 for the fields
// that carry the memory image (Device type, UID, NTAG/Mifare type, Page/Block
// lines). Pure TypeScript: no Node, no DOM.

import { bytesToHex, hexToBytes } from '../hex';
import { type TagKind, isNtag, specFor } from '../tags';
import type { TagImage, UnitStatus } from '../types';
import { extractUid, extractUidBytes } from './_util';
import { unitBytes } from './image';

function hexSp(bytes: Uint8Array): string {
  return bytesToHex(bytes, ' ');
}

/** Standard GET_VERSION response per NTAG kind. */
function defaultVersion(kind: TagKind): Uint8Array {
  const storage = kind === 'NTAG213' ? 0x0f : kind === 'NTAG215' ? 0x11 : 0x13;
  return Uint8Array.from([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, storage, 0x03]);
}

function kindByPageCount(pages: number): TagKind | null {
  if (pages === 45) return 'NTAG213';
  if (pages === 135) return 'NTAG215';
  if (pages === 231) return 'NTAG216';
  return null;
}

/** Flipper Zero ".nfc" text (NTAG213/215/216 and MIFARE Classic 1K/4K). */
export function exportFlipper(img: TagImage): string {
  const spec = specFor(img.kind);
  const lines: string[] = ['Filetype: Flipper NFC device', 'Version: 4'];
  if (isNtag(img.kind)) {
    lines.push('Device type: NTAG/Ultralight');
    lines.push(`UID: ${hexSp(extractUidBytes(img.kind, img.data))}`);
    lines.push('ATQA: 00 44');
    lines.push('SAK: 00');
    lines.push('Data format version: 2');
    lines.push(`NTAG/Ultralight type: ${img.kind}`);
    const sig = img.ntag?.signature ? hexSp(hexToBytes(img.ntag.signature)) : hexSp(new Uint8Array(32));
    lines.push(`Signature: ${sig}`);
    const ver = img.ntag?.version ? hexSp(hexToBytes(img.ntag.version)) : hexSp(defaultVersion(img.kind));
    lines.push(`Mifare version: ${ver}`);
    const counter = img.ntag?.counter ?? 0;
    for (let i = 0; i < 3; i++) {
      lines.push(`Counter ${i}: ${i === 2 ? counter : 0}`);
      lines.push(`Tearing ${i}: 00`);
    }
    lines.push(`Pages total: ${spec.unitCount}`);
    lines.push(`Pages read: ${img.unitStatus.filter((s) => s === 'ok').length}`);
    for (let p = 0; p < spec.unitCount; p++) lines.push(`Page ${p}: ${hexSp(unitBytes(img.kind, img.data, p))}`);
    lines.push('Failed authentication attempts: 0');
  } else {
    const is1k = img.kind === 'MIFARE_CLASSIC_1K';
    lines.push('Device type: Mifare Classic');
    lines.push(`UID: ${hexSp(extractUidBytes(img.kind, img.data))}`);
    lines.push(`ATQA: ${is1k ? '00 04' : '00 02'}`);
    lines.push(`SAK: ${is1k ? '08' : '18'}`);
    lines.push(`Mifare Classic type: ${is1k ? '1K' : '4K'}`);
    lines.push('Data format version: 2');
    for (let b = 0; b < spec.unitCount; b++) lines.push(`Block ${b}: ${hexSp(unitBytes(img.kind, img.data, b))}`);
  }
  return lines.join('\n') + '\n';
}

export function importFlipper(text: string): TagImage {
  const meta = new Map<string, string>();
  const pages = new Map<number, Uint8Array>();
  const blocks = new Map<number, Uint8Array>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    const pm = /^Page (\d+)$/.exec(key);
    if (pm) {
      pages.set(Number(pm[1]), hexToBytes(val));
      continue;
    }
    const bm = /^Block (\d+)$/.exec(key);
    if (bm) {
      blocks.set(Number(bm[1]), hexToBytes(val));
      continue;
    }
    meta.set(key, val);
  }

  let kind: TagKind | null = null;
  const ntagType = meta.get('NTAG/Ultralight type');
  const mfType = meta.get('Mifare Classic type');
  if (ntagType && (ntagType === 'NTAG213' || ntagType === 'NTAG215' || ntagType === 'NTAG216')) {
    kind = ntagType;
  } else if (mfType) {
    kind = mfType === '1K' ? 'MIFARE_CLASSIC_1K' : mfType === '4K' ? 'MIFARE_CLASSIC_4K' : null;
  }
  if (!kind) {
    if (pages.size) kind = kindByPageCount(pages.size);
    else if (blocks.size) kind = blocks.size <= 64 ? 'MIFARE_CLASSIC_1K' : 'MIFARE_CLASSIC_4K';
  }
  if (!kind) throw new Error('Flipper NFC ファイルのタグ種類を判定できません');

  const spec = specFor(kind);
  const data = new Uint8Array(spec.unitCount * spec.unitSize);
  const unitStatus = new Array(spec.unitCount).fill('unread') as UnitStatus[];
  const src = isNtag(kind) ? pages : blocks;
  for (const [u, bytes] of src) {
    if (u >= 0 && u < spec.unitCount) {
      data.set(bytes.slice(0, spec.unitSize), u * spec.unitSize);
      unitStatus[u] = 'ok';
    }
  }

  const img: TagImage = { kind, uid: extractUid(kind, data), data, unitStatus, readAt: Date.now() };
  if (isNtag(kind)) {
    const sig = meta.get('Signature');
    const ver = meta.get('Mifare version');
    const counter = meta.get('Counter 2');
    img.ntag = {
      version: ver ? bytesToHex(hexToBytes(ver)) : null,
      counter: counter !== undefined && /^\d+$/.test(counter) ? Number(counter) : null,
      signature: sig ? bytesToHex(hexToBytes(sig)) : null,
    };
  }
  return img;
}
