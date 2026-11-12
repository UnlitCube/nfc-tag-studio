// Unit tests for the renderer-backup pure logic (duplicate planning + key form
// validation). Owner: agent renderer-backup. Pure logic only - no DOM, no React,
// no reader hardware. Run with: npx vitest run tests/backup
import { describe, expect, it } from 'vitest';
import { MIFARE_TRANSPORT_ACCESS, encodeAccessBits, factoryImage, isProtectedUnit, mifareIsTrailer, ntagPages, specFor } from '@shared/tags';
import { bytesToHex } from '@shared/hex';
import type { TagKind } from '@shared/tags';
import type { TagImage, UnitStatus } from '@shared/types';
import { importDump, parseProject, serializeProject } from '@shared/tag';
import { changedAgainstTarget, planDataCopy, planRestore } from '../src/renderer/src/views/backup/duplicate';
import { readDumpMeta, unitStatusCounts, whenLabel } from '../src/renderer/src/views/backup/dumpMeta';
import { dumpFileName, encodeDump, matchesSaved, savedSnapshot } from '../src/renderer/src/views/backup/saveDump';
import { normalizeKeyHex, validateKeyHex } from '../src/renderer/src/views/keys/keyform';

function makeImage(kind: TagKind, uidBytes: number[]): TagImage {
  const uid = Uint8Array.from(uidBytes);
  const data = factoryImage(kind, uid);
  const spec = specFor(kind);
  return {
    kind,
    uid: bytesToHex(uid),
    data,
    unitStatus: Array<UnitStatus>(spec.unitCount).fill('ok'),
    readAt: 0,
  };
}

const NTAG_UID = [0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
const MIFARE_UID = [0xa1, 0xb2, 0xc3, 0xd4];

describe('planDataCopy: data area only', () => {
  it('NTAG213 copies only the user pages (4..userLast)', () => {
    const img = makeImage('NTAG213', NTAG_UID);
    const plan = planDataCopy(img);
    // NTAG213: 144 user bytes = 36 pages, pages 4..39.
    expect(plan.writes.length).toBe(36);
    expect(plan.byteCount).toBe(144);
    expect(plan.writes[0].unit).toBe(4);
    expect(plan.writes[plan.writes.length - 1].unit).toBe(39);
    for (const w of plan.writes) {
      expect(isProtectedUnit('NTAG213', w.unit)).toBe(false);
      expect(w.data.length).toBe(4);
    }
    // UID pages / CC / config / lock / password are excluded.
    for (const u of [0, 1, 2, 3, 40, 41, 42, 43, 44]) {
      expect(plan.excludedUnits).toContain(u);
    }
  });

  it('MIFARE 1K copies only data blocks (no block 0, no trailers)', () => {
    const img = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    const plan = planDataCopy(img);
    // 64 blocks - 16 trailers - 1 manufacturer block = 47 data blocks.
    expect(plan.writes.length).toBe(47);
    expect(plan.byteCount).toBe(47 * 16);
    for (const w of plan.writes) {
      expect(w.unit).not.toBe(0);
      expect(mifareIsTrailer(w.unit)).toBe(false);
      expect(w.data.length).toBe(16);
    }
    expect(plan.excludedUnits).toContain(0);
    expect(plan.excludedUnits).toContain(3); // sector 0 trailer
  });

  it('never copies the UID / manufacturer unit (I1/I2)', () => {
    for (const img of [makeImage('NTAG215', NTAG_UID), makeImage('MIFARE_CLASSIC_4K', MIFARE_UID)]) {
      const plan = planDataCopy(img);
      // Block 0 / UID pages are forbidden and must never be written.
      expect(plan.writes.some((w) => w.unit === 0)).toBe(false);
      if (img.kind.startsWith('NTAG')) {
        expect(plan.writes.some((w) => w.unit <= 1)).toBe(false);
      }
    }
  });

  it('excludes units that were not read on the source', () => {
    const img = makeImage('NTAG213', NTAG_UID);
    img.unitStatus[6] = 'denied';
    img.unitStatus[7] = 'unread';
    const plan = planDataCopy(img);
    expect(plan.unreadUnits).toEqual([6, 7]);
    expect(plan.writes.some((w) => w.unit === 6 || w.unit === 7)).toBe(false);
    expect(plan.writes.length).toBe(34);
  });
});

describe('changedAgainstTarget', () => {
  it('reports only the data units whose bytes differ', () => {
    const src = makeImage('NTAG213', NTAG_UID);
    const target = makeImage('NTAG213', [0x04, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99]);
    // Change one user page in the source only.
    src.data[5 * 4] = 0xab;
    const plan = planDataCopy(src);
    const changed = changedAgainstTarget(plan, target.data);
    expect(changed).toContain(5);
    expect(changed).not.toContain(4); // identical NDEF TLV page
    expect(changed).not.toContain(6); // both zero
  });

  it('returns empty when source and target data areas match', () => {
    const src = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    // Different UID, same (factory) data area.
    const target = makeImage('MIFARE_CLASSIC_1K', [0x0f, 0x0e, 0x0d, 0x0c]);
    const plan = planDataCopy(src);
    expect(changedAgainstTarget(plan, target.data)).toEqual([]);
  });
});

describe('validateKeyHex / normalizeKeyHex', () => {
  it('accepts the three public standard keys', () => {
    for (const k of ['FFFFFFFFFFFF', 'A0A1A2A3A4A5', 'D3F7D3F7D3F7']) {
      const v = validateKeyHex(k);
      expect(v.ok).toBe(true);
      expect(v.value).toBe(k);
    }
  });

  it('upper-cases and strips separators', () => {
    expect(normalizeKeyHex('ff:ff-ff ff ff ff')).toBe('FFFFFFFFFFFF');
    const v = validateKeyHex('a0:a1:a2:a3:a4:a5');
    expect(v.ok).toBe(true);
    expect(v.value).toBe('A0A1A2A3A4A5');
  });

  it('rejects empty, wrong length and non-hex', () => {
    expect(validateKeyHex('').reason).toBe('empty');
    expect(validateKeyHex('   ').reason).toBe('empty');
    expect(validateKeyHex('FFFFFFFFFFF').reason).toBe('length'); // 11 digits
    expect(validateKeyHex('FFFFFFFFFFFFFF').reason).toBe('length'); // 14 digits
    expect(validateKeyHex('GGGGGGGGGGGG').reason).toBe('hex');
    expect(validateKeyHex('FFFFFFFFFFFG').reason).toBe('hex');
  });
});

// 2026-11-12 UX rework (WRITE-9 / FLOW-3): a backup can be put back on the SAME tag.
describe('planRestore: write the open document onto the tag on the reader', () => {
  it('restores the same tag (same UID): mode "restore", writes only the pages that differ', () => {
    // The backup (a file) of tag A ...
    const backup = makeImage('NTAG213', NTAG_UID);
    backup.data.set([0x03, 0x05, 0xd1, 0x01, 0x01, 0x55, 0x00, 0xfe], 4 * 4);
    // ... and tag A today, its contents overwritten by mistake.
    const tagA = makeImage('NTAG213', NTAG_UID);
    tagA.data.set([0x03, 0x00, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00], 4 * 4);
    tagA.data[20 * 4] = 0x99;
    const plan = planRestore(backup, tagA);
    expect(plan.mode).toBe('restore');
    expect(plan.kindMismatch).toBe(false);
    expect(plan.writes.map((w) => w.unit)).toEqual([4, 5, 20]);
    expect(plan.unchanged.length).toBe(36 - 3);
    expect(plan.dataUnits).toBe(36);
    // Writing the plan makes the data area equal to the backup.
    const after = new Uint8Array(tagA.data);
    for (const w of plan.writes) after.set(w.data, w.unit * 4);
    expect(bytesToHex(after.slice(16, 160))).toBe(bytesToHex(backup.data.slice(16, 160)));
  });

  it('nothing to write when the tag already holds the backup', () => {
    const backup = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    const plan = planRestore(backup, makeImage('MIFARE_CLASSIC_1K', MIFARE_UID));
    expect(plan.mode).toBe('restore');
    expect(plan.writes).toEqual([]);
  });

  it('another UID is a duplicate, never touching the UID / config / trailers (I1/I2)', () => {
    const src = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    for (let b = 1; b < 64; b++) if (!mifareIsTrailer(b)) src.data[b * 16] = 0x42;
    const plan = planRestore(src, makeImage('MIFARE_CLASSIC_1K', [0x0f, 0x0e, 0x0d, 0x0c]));
    expect(plan.mode).toBe('duplicate');
    expect(plan.writes.length).toBe(47);
    for (const w of plan.writes) expect(isProtectedUnit('MIFARE_CLASSIC_1K', w.unit)).toBe(false);
  });

  it('leaves out units the target could not read (no key) instead of failing half-way', () => {
    const src = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    src.data.fill(0x11, 4 * 16, 7 * 16); // sector 1
    src.data.fill(0x22, 8 * 16, 11 * 16); // sector 2
    const target = makeImage('MIFARE_CLASSIC_1K', [0x0f, 0x0e, 0x0d, 0x0c]);
    for (const b of [8, 9, 10]) target.unitStatus[b] = 'denied';
    const plan = planRestore(src, target);
    expect(plan.targetUnread).toEqual([8, 9, 10]);
    expect(plan.writes.map((w) => w.unit)).toEqual([4, 5, 6]);
  });

  it('leaves out units the backup could not read', () => {
    const src = makeImage('NTAG213', NTAG_UID);
    src.unitStatus[10] = 'denied';
    src.unitStatus[11] = 'error';
    const target = makeImage('NTAG213', NTAG_UID);
    target.data.fill(0x55, 10 * 4, 12 * 4);
    const plan = planRestore(src, target);
    expect(plan.sourceUnread).toEqual([10, 11]);
    expect(plan.writes.some((w) => w.unit === 10 || w.unit === 11)).toBe(false);
  });

  it('refuses a different kind', () => {
    const plan = planRestore(makeImage('NTAG213', NTAG_UID), makeImage('NTAG215', NTAG_UID));
    expect(plan.kindMismatch).toBe(true);
    expect(plan.writes).toEqual([]);
  });
});

// FLOW-15: the note of an opened .nfcdump is kept (shown, saved again) along with the save time.
describe('dump note and save time', () => {
  const savedAt = '2026-11-10T05:02:00.000Z';

  it('reads the note and the save time of a .nfcdump', () => {
    const bytes = serializeProject(makeImage('NTAG215', NTAG_UID), { note: '総務課 入室カード 原本', appVersion: '1.0.0', savedAt });
    expect(readDumpMeta(bytes)).toEqual({ note: '総務課 入室カード 原本', savedAt });
    expect(importDump('a.nfcdump', bytes).note).toBe('総務課 入室カード 原本');
  });

  it('keeps the note when an opened dump is saved again with the prefilled note', () => {
    const first = serializeProject(makeImage('NTAG213', NTAG_UID), { note: '原本', appVersion: '1.0.0', savedAt });
    const opened = importDump('a.nfcdump', first);
    // The view prefills the note field with opened.note and saves with it.
    const again = encodeDump(opened.image, 'project', { note: opened.note, appVersion: '1.0.0', savedAt: new Date().toISOString() });
    expect(again.ext).toBe('nfcdump');
    expect(parseProject(again.bytes).note).toBe('原本');
  });

  it('returns null for other formats and ignores an invalid save time', () => {
    expect(readDumpMeta(new Uint8Array(180))).toBeNull();
    expect(readDumpMeta(new TextEncoder().encode('{"format":"other"}'))).toBeNull();
    const bad = new TextEncoder().encode(JSON.stringify({ format: 'nfc-tag-studio/dump', note: 'x', savedAt: 'not a date' }));
    expect(readDumpMeta(bad)).toEqual({ note: 'x', savedAt: null });
  });
});

describe('encodeDump / dumpFileName / unitStatusCounts / whenLabel', () => {
  it('encodes each format with its filter and extension', () => {
    const img = makeImage('NTAG213', NTAG_UID);
    const meta = { note: '', appVersion: '1.0.0', savedAt: '2026-11-10T05:02:00.000Z' };
    expect(encodeDump(img, 'bin', meta).ext).toBe('bin');
    expect(encodeDump(img, 'bin', meta).bytes.length).toBe(180);
    expect(encodeDump(img, 'flipper', meta).ext).toBe('nfc');
    expect(dumpFileName(img, 'nfcdump', '20261112-140230')).toBe('NTAG213_' + img.uid + '_20261112-140230.nfcdump');
  });

  it('counts unreadable units by reason (an interrupted read is not "protected")', () => {
    const img = makeImage('NTAG213', NTAG_UID);
    img.unitStatus[5] = 'error';
    img.unitStatus[6] = 'denied';
    img.unitStatus[7] = 'denied';
    expect(unitStatusCounts(img)).toEqual({ ok: 42, unread: 0, denied: 2, error: 1 });
  });

  it('shows only the time for today and the date for other days', () => {
    const now = new Date(2026, 10, 12, 15, 0).getTime();
    const today = whenLabel(new Date(2026, 10, 12, 14, 2).getTime(), 'ja', now);
    expect(today).toContain('14');
    expect(today).not.toContain('2026');
    expect(whenLabel(new Date(2026, 10, 10, 14, 2).getTime(), 'ja', now)).toContain('2026');
  });
});

// 2026-11-12 review R-UX-3: the screens say "keys and passwords are not saved", but an
// edited image (key A typed into a trailer for the parameter editor, a PWD page edited)
// went into the file as it was. encodeDump is the one save path (backup + binary editor).
describe('R-UX-3: a saved file holds no key A / password', () => {
  const META = { note: '', appVersion: '1.0.0', savedAt: '2026-11-12T05:00:00.000Z' };
  const FORMATS = [
    ['project', 'a.nfcdump'],
    ['bin', 'a.bin'],
    ['flipper', 'a.nfc'],
  ] as const;
  const SECRET_A = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
  const KEY_B = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];

  function unit(img: TagImage, u: number): number[] {
    const size = specFor(img.kind).unitSize;
    return [...img.data.slice(u * size, (u + 1) * size)];
  }

  /** A trailer: key A | access bits (+GPB) | key B. */
  function setTrailer(img: TagImage, block: number, keyA: number[], access: Uint8Array, keyB: number[]) {
    img.data.set(keyA, block * 16);
    img.data.set(access, block * 16 + 6);
    img.data.set(keyB, block * 16 + 10);
  }

  // Trailer access condition 011 (key B is a key, never readable); data blocks 000.
  const KEY_B_SECRET_ACCESS = encodeAccessBits({ c: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 1, 1]], gpb: 0x69 });

  it('NTAG: the PWD and PACK pages are saved as 00 in every format; the data pages stay', () => {
    const img = makeImage('NTAG215', NTAG_UID);
    const p = ntagPages('NTAG215');
    img.data.set([0xde, 0xad, 0xbe, 0xef], p.pwd * 4);
    img.data.set([0x12, 0x34, 0x00, 0x00], p.pack * 4);
    img.data.set([0x01, 0x02, 0x03, 0x04], 10 * 4);
    for (const [format, name] of FORMATS) {
      const enc = encodeDump(img, format, META);
      const back = importDump(name, enc.bytes).image;
      expect(unit(back, p.pwd), `${format} PWD`).toEqual([0, 0, 0, 0]);
      expect(unit(back, p.pack), `${format} PACK`).toEqual([0, 0, 0, 0]);
      expect(unit(back, 10), `${format} page 10`).toEqual([1, 2, 3, 4]);
      expect(enc.redacted, format).toEqual([p.pwd, p.pack]);
    }
    // The open document itself is not changed by saving.
    expect(unit(img, p.pwd)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('MIFARE: key A is saved as 00; key B stays only where the access bits make it readable (data, not a key)', () => {
    const img = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    setTrailer(img, 7, SECRET_A, MIFARE_TRANSPORT_ACCESS, KEY_B); // sector 1: transport (key B readable)
    setTrailer(img, 11, SECRET_A, KEY_B_SECRET_ACCESS, KEY_B); // sector 2: key B is a real key
    setTrailer(img, 15, SECRET_A, Uint8Array.from([0, 0, 0, 0]), KEY_B); // sector 3: invalid access bits
    img.data.fill(0x42, 4 * 16, 5 * 16);
    for (const [format, name] of FORMATS) {
      const enc = encodeDump(img, format, META);
      const back = importDump(name, enc.bytes).image;
      for (let s = 0; s < 16; s++) expect(unit(back, s * 4 + 3).slice(0, 6), `${format} sector ${s} key A`).toEqual([0, 0, 0, 0, 0, 0]);
      expect(unit(back, 7).slice(6, 10), `${format} access bits kept`).toEqual([...MIFARE_TRANSPORT_ACCESS]);
      expect(unit(back, 7).slice(10), `${format} readable key B kept`).toEqual(KEY_B);
      expect(unit(back, 11).slice(10), `${format} secret key B`).toEqual([0, 0, 0, 0, 0, 0]);
      expect(unit(back, 15).slice(10), `${format} key B under invalid access bits`).toEqual([0, 0, 0, 0, 0, 0]);
      expect(unit(back, 4), `${format} data block`).toEqual(Array(16).fill(0x42));
      const text = bytesToHex(enc.bytes);
      expect(text.includes(bytesToHex(Uint8Array.from(SECRET_A))), `${format} raw key A`).toBe(false);
    }
  });

  it('a tag as read (key A / PWD already read back as 00) is saved byte for byte: nothing is reported as cleared', () => {
    const mf = makeImage('MIFARE_CLASSIC_1K', MIFARE_UID);
    for (let s = 0; s < 16; s++) mf.data.fill(0, (s * 4 + 3) * 16, (s * 4 + 3) * 16 + 6);
    const enc = encodeDump(mf, 'bin', META);
    expect(enc.redacted).toEqual([]);
    expect(bytesToHex(enc.bytes)).toBe(bytesToHex(mf.data));
    const nt = makeImage('NTAG213', NTAG_UID);
    nt.data.fill(0, ntagPages('NTAG213').pwd * 4, ntagPages('NTAG213').pwd * 4 + 4);
    expect(encodeDump(nt, 'project', META).redacted).toEqual([]);
  });

  it('FeliCa Lite-S has no key in the grid: saved as it is', () => {
    const img = makeImage('FELICA_LITE_S', [1, 2, 3, 4, 5, 6, 7, 8]);
    img.data.fill(0x5a, 0, 16);
    const enc = encodeDump(img, 'project', META);
    expect(enc.redacted).toEqual([]);
    expect(unit(importDump('a.nfcdump', enc.bytes).image, 0)).toEqual(Array(16).fill(0x5a));
  });
});

// 2026-11-12 E2E-UX-7: right after saving, opening that very file said "the open
// document has changed since it was saved" (only doc.revision was compared).
describe('E2E-UX-7: is the open document what was saved?', () => {
  const META = { note: '', appVersion: '1.0.0', savedAt: '2026-11-12T05:00:00.000Z' };

  it('the file opened right after saving matches (every format), even when a password was cleared on saving', () => {
    const img = makeImage('NTAG215', NTAG_UID);
    img.data.set([0xde, 0xad, 0xbe, 0xef], ntagPages('NTAG215').pwd * 4);
    img.unitStatus[20] = 'denied'; // .bin / Flipper do not record it
    const snap = savedSnapshot(img);
    for (const [format, name] of [
      ['project', 'a.nfcdump'],
      ['bin', 'a.bin'],
      ['flipper', 'a.nfc'],
    ] as const) {
      const opened = importDump(name, encodeDump(img, format, META).bytes).image;
      expect(matchesSaved(snap, [opened, opened]), format).toBe(true);
    }
  });

  it('an edit after saving, or another tag / file, does not match', () => {
    const img = makeImage('NTAG213', NTAG_UID);
    const snap = savedSnapshot(img);
    const edited = { ...img, data: new Uint8Array(img.data) };
    edited.data[10 * 4] = 0x99;
    expect(matchesSaved(snap, [edited, edited])).toBe(false);
    expect(matchesSaved(snap, [makeImage('NTAG213', [0x04, 1, 2, 3, 4, 5, 6])])).toBe(false);
    expect(matchesSaved(snap, [makeImage('NTAG215', NTAG_UID)])).toBe(false);
  });

  it('saving "as read" while there are unsaved edits still matches the document (its original is what was saved)', () => {
    const original = makeImage('NTAG213', NTAG_UID);
    const edited = { ...original, data: new Uint8Array(original.data) };
    edited.data[10 * 4] = 0x99;
    const snap = savedSnapshot(original);
    expect(matchesSaved(snap, [edited, original])).toBe(true);
  });
});
