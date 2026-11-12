// Encode a tag image as a dump file (pure; no React / DOM / IPC). Owner: agent
// renderer-backup. The one path for "save to file" so the backup screen and any
// other screen (e.g. the binary editor) write the same bytes and names.
//
// Keys and passwords are never part of a dump (I4). A tag as READ holds none
// (MIFARE key A reads back as 00, key B only where it is plain data; NTAG PWD /
// PACK read back as 00), but an EDITED image can: the parameter editor asks for
// key A in the trailer, a PWD page can be edited in advanced mode (review R-UX-3,
// 2026-11-12). So every save clears them first (redactSecrets):
//   - MIFARE Classic trailers: key A (bytes 0-5) -> 00 always; key B (10-15) -> 00
//     unless the access bits make it readable (000 / 001 / 010: then it is data,
//     never usable as a key, and real hardware hands it out on every read).
//     Invalid access bits: key B -> 00 too (cannot tell).
//   - NTAG21x: the PWD and PACK pages -> 00.
//   - FeliCa Lite-S: the editable grid holds no key (the card key is write-only).
// A file opened again and written back is safe: a trailer with key A 00 is left out
// of the write plan (KEY_A_UNKNOWN), and PWD / PACK read back as 00 on the tag too.
import { FILE_FILTERS } from '@shared/api';
import type { FileFilter } from '@shared/api';
import { utf8ToBytes } from '@shared/hex';
import { exportBin, exportFlipper, serializeProject } from '@shared/tag';
import { isMifare, isNtag, mifareIsTrailer, ntagPages, parseAccessBits, specFor } from '@shared/tags';
import type { AccessBits } from '@shared/tags';
import type { TagImage } from '@shared/types';

export type SaveFormat = 'project' | 'bin' | 'flipper';

export interface EncodedDump {
  bytes: Uint8Array;
  filter: FileFilter;
  ext: string;
  /** Units whose key / password bytes were cleared to 00 in the file (empty for a tag as read). */
  redacted: number[];
}

/** Key B of a trailer is plain data (readable) only in trailer access conditions 000, 001, 010. */
function keyBReadable(access: AccessBits): boolean {
  const [c1, c2, c3] = access.c[3];
  return c1 === 0 && !(c2 === 1 && c3 === 1);
}

/**
 * A copy of `img` with the key / password bytes cleared (see the header), plus the
 * units that changed. Returns `img` itself when nothing had to be cleared.
 */
export function redactSecrets(img: TagImage): { image: TagImage; redacted: number[] } {
  const spec = specFor(img.kind);
  const data = new Uint8Array(img.data);
  const redacted: number[] = [];
  const clear = (unit: number, from: number, to: number): boolean => {
    const off = unit * spec.unitSize;
    let changed = false;
    for (let i = off + from; i < off + to && i < data.length; i++) {
      if (data[i] !== 0) {
        data[i] = 0;
        changed = true;
      }
    }
    return changed;
  };
  if (isNtag(img.kind)) {
    const p = ntagPages(img.kind);
    for (const u of [p.pwd, p.pack]) if (clear(u, 0, spec.unitSize)) redacted.push(u);
  } else if (isMifare(img.kind)) {
    for (let b = 0; b < spec.unitCount; b++) {
      if (!mifareIsTrailer(b)) continue;
      let changed = clear(b, 0, 6);
      const access = parseAccessBits(data.subarray(b * 16, b * 16 + 16));
      if (!access || !keyBReadable(access)) changed = clear(b, 10, 16) || changed;
      if (changed) redacted.push(b);
    }
  }
  return { image: redacted.length > 0 ? { ...img, data } : img, redacted };
}

export function encodeDump(img: TagImage, format: SaveFormat, meta: { note: string; appVersion: string; savedAt: string }): EncodedDump {
  const { image, redacted } = redactSecrets(img);
  if (format === 'project') {
    return { bytes: serializeProject(image, meta), filter: FILE_FILTERS.project, ext: 'nfcdump', redacted };
  }
  if (format === 'bin') return { bytes: exportBin(image), filter: FILE_FILTERS.bin, ext: 'bin', redacted };
  return { bytes: utf8ToBytes(exportFlipper(image)), filter: FILE_FILTERS.flipper, ext: 'nfc', redacted };
}

/** Default file name: NTAG215_04A1B2C3D4E5F6_20261112-140230.nfcdump */
export function dumpFileName(img: TagImage, ext: string, stamp: string): string {
  return `${img.kind}_${img.uid}_${stamp}.${ext}`;
}

/** What a save put into the file, to tell later whether the open document is still that (E2E-UX-7). */
export interface SavedSnapshot {
  kind: TagImage['kind'];
  uid: string;
  /** The bytes as written to the file (keys / passwords cleared). */
  data: Uint8Array;
}

export function savedSnapshot(img: TagImage): SavedSnapshot {
  const { image } = redactSecrets(img);
  return { kind: image.kind, uid: image.uid.toUpperCase(), data: new Uint8Array(image.data) };
}

/**
 * Whether any of `images` (the open document's edited image and its original) holds
 * exactly what was saved. Compared by content, not by doc.revision: opening the
 * saved file again is the same content (E2E-UX-7). The read status is not compared
 * (.bin / Flipper files do not keep it; unreadable units are 00 either way).
 */
export function matchesSaved(snap: SavedSnapshot, images: TagImage[]): boolean {
  return images.some((img) => {
    if (img.kind !== snap.kind || img.uid.toUpperCase() !== snap.uid) return false;
    const { image } = redactSecrets(img);
    if (image.data.length !== snap.data.length) return false;
    for (let i = 0; i < snap.data.length; i++) if (image.data[i] !== snap.data[i]) return false;
    return true;
  });
}
