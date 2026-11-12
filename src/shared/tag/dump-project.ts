// Native project dump format (*.nfcdump, UTF-8 JSON). Pure TypeScript: no Node,
// no DOM (TextEncoder/TextDecoder allowed).

import { bytesToHex, hexToBytes, bytesToUtf8, utf8ToBytes } from '../hex';
import { type TagKind, TAG_KINDS, specFor, imageSize } from '../tags';
import type { TagImage, UnitStatus, NtagExtras, MifareSectorAccess } from '../types';
import { unitBytes } from './image';

const FORMAT = 'nfc-tag-studio/dump';
const VERSION = 1;

interface ProjectDoc {
  format: string;
  version: number;
  kind: TagKind;
  uid: string;
  unitSize: number;
  units: string[];
  unitStatus: UnitStatus[];
  ntag?: NtagExtras;
  mifare?: { sectors: MifareSectorAccess[] };
  note: string;
  savedAt: string;
  app: { name: string; version: string };
}

/**
 * Native format (*.nfcdump, UTF-8 JSON):
 * { format: "nfc-tag-studio/dump", version: 1, kind, uid, unitSize, units: ["hex", ...],
 *   unitStatus, ntag?, mifare?, note, savedAt, app: { name, version } }
 */
export function serializeProject(
  img: TagImage,
  meta: { note: string; appVersion: string; savedAt: string },
): Uint8Array {
  const spec = specFor(img.kind);
  const units: string[] = [];
  for (let u = 0; u < spec.unitCount; u++) units.push(bytesToHex(unitBytes(img.kind, img.data, u)));
  const doc: ProjectDoc = {
    format: FORMAT,
    version: VERSION,
    kind: img.kind,
    uid: img.uid,
    unitSize: spec.unitSize,
    units,
    unitStatus: img.unitStatus.slice(),
    note: meta.note,
    savedAt: meta.savedAt,
    app: { name: 'NFC Tag Studio', version: meta.appVersion },
  };
  if (img.ntag) doc.ntag = { ...img.ntag };
  if (img.mifare) doc.mifare = { sectors: img.mifare.sectors.map((s) => ({ ...s })) };
  return utf8ToBytes(JSON.stringify(doc, null, 2));
}

export function parseProject(bytes: Uint8Array): { image: TagImage; note: string } {
  let doc: ProjectDoc;
  try {
    doc = JSON.parse(bytesToUtf8(bytes)) as ProjectDoc;
  } catch {
    throw new Error('ダンプファイルを JSON として開けません');
  }
  if (!doc || doc.format !== FORMAT) throw new Error('NFC Tag Studio のダンプ（*.nfcdump）ではありません');
  if (!TAG_KINDS.includes(doc.kind)) throw new Error(`未知のタグ種類です: ${String(doc.kind)}`);
  const spec = specFor(doc.kind);
  if (!Array.isArray(doc.units) || doc.units.length !== spec.unitCount) {
    throw new Error('ユニット数がタグ種類と一致しません');
  }
  const data = new Uint8Array(imageSize(doc.kind));
  for (let u = 0; u < spec.unitCount; u++) {
    const b = hexToBytes(doc.units[u]);
    if (b.length !== spec.unitSize) throw new Error(`ユニット ${u} の長さが不正です`);
    data.set(b, u * spec.unitSize);
  }
  const unitStatus =
    Array.isArray(doc.unitStatus) && doc.unitStatus.length === spec.unitCount
      ? doc.unitStatus.slice()
      : (new Array(spec.unitCount).fill('ok') as UnitStatus[]);
  const image: TagImage = { kind: doc.kind, uid: doc.uid, data, unitStatus, readAt: Date.now() };
  if (doc.ntag) image.ntag = { ...doc.ntag };
  if (doc.mifare) image.mifare = { sectors: doc.mifare.sectors.map((s) => ({ ...s })) };
  return { image, note: typeof doc.note === 'string' ? doc.note : '' };
}
