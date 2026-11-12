// The binary editor's write target + copy planning (owner: renderer-hex).
// 2026-11-12 UX audit WRITE-1 / FLOW-1 / FLOW-13 / WALK-1 / WALK-8 (decision D5),
// WRITE-16 (initialize per kind), WRITE-17 (disabled with a reason).
import { describe, expect, it } from 'vitest';
import { blankImage, planWrites } from '@shared/tag';
import { encodeAccessBits, mifareTrailerBlock, ntagPages } from '@shared/tags';
import type { CardInfo, ReaderStatus, TagImage } from '@shared/types';
import {
  displayLockedUnits,
  formatUnits,
  groupWarnings,
  initializeImage,
  isValidNtagPassword,
  keepReadOnlyUnits,
  mifareNdefBlocks,
  needsLockConfirmForWrites,
  planHexWrite,
  relationOf,
  writeReadiness,
} from '../src/renderer/src/views/hex/model';

const UID_A = '049AFB5CBD1E7F';
const UID_B = '04C32485E647A8';
const units = (p: { writes: { unit: number }[] }) => p.writes.map((w) => w.unit);

function card(uid: string, kind: CardInfo['kind'] = 'NTAG215'): CardInfo {
  return { readerName: 'Virtual', uid, atr: '', kind, kindSource: 'simulator', version: null, rawCommands: true, driver: 'acr122', detectedAt: 1 };
}

function reader(c: CardInfo | null, cardState: ReaderStatus['cardState'] = c ? 'ready' : 'absent'): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [{ name: 'Virtual', likelyContactless: true, cardPresent: !!c, inUse: false, atr: null, virtual: true }],
    selectedReader: null,
    activeReader: 'Virtual',
    activeReason: 'auto-virtual',
    driverMode: 'auto',
    card: c,
    cardState,
    cardError: null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: true, kind: 'NTAG215', present: !!c, uid: c?.uid ?? '' },
  };
}

/** Tag A as in the audit (WALK-1): p4 = 41 00 FE 00, p5 = 44. */
function tagA(): TagImage {
  const img = blankImage('NTAG215', UID_A);
  img.data.set([0x41, 0x00, 0xfe, 0x00], 4 * 4);
  img.data.set([0x44, 0x00, 0x00, 0x00], 5 * 4);
  return img;
}

describe('relationOf / writeReadiness (WRITE-1, WRITE-17)', () => {
  const src = { type: 'card' as const, uid: UID_A };

  it('same tag vs another tag vs file / new', () => {
    expect(relationOf(src, UID_A.toLowerCase())).toBe('same');
    expect(relationOf(src, UID_B)).toBe('other-card');
    expect(relationOf({ type: 'file', name: 'x.nfcdump' }, UID_B)).toBe('file');
    expect(relationOf({ type: 'new' }, UID_B)).toBe('new');
  });

  const base = { kind: 'NTAG215' as const, issueRunning: false, busyOp: null, passwordValid: true };

  it('is blocked with the reader reason when no tag is ready', () => {
    const r = writeReadiness({ ...base, source: src, reader: reader(null), samePlan: null });
    expect(r.block).toEqual({ type: 'op', block: 'absent' });
    const d = writeReadiness({ ...base, source: src, reader: reader(card(UID_A), 'detecting'), samePlan: null });
    expect(d.block).toEqual({ type: 'op', block: 'detecting' });
    const i = writeReadiness({ ...base, issueRunning: true, source: src, reader: reader(card(UID_A)), samePlan: null });
    expect(i.block).toEqual({ type: 'op', block: 'issuing' });
  });

  it('is blocked when the tag kind differs from the document', () => {
    const r = writeReadiness({ ...base, source: src, reader: reader(card(UID_B, 'NTAG213')), samePlan: null });
    expect(r.block).toEqual({ type: 'kind', cardKind: 'NTAG213', docKind: 'NTAG215' });
  });

  it('same tag without changes: nothing to write (disabled, not "press then refuse")', () => {
    const a = tagA();
    const samePlan = planHexWrite({ kind: 'NTAG215', mode: 'same', original: a, data: a.data, includeProtected: false });
    const r = writeReadiness({ ...base, source: src, reader: reader(card(UID_A)), samePlan });
    expect(r.relation).toBe('same');
    expect(r.block).toEqual({ type: 'nothing' });
  });

  it('same tag with only protected changes and protected writes off: says why', () => {
    const a = tagA();
    const data = new Uint8Array(a.data);
    data[ntagPages('NTAG215').cfg1 * 4] = 0x10; // NFC counter on (CFG1)
    const samePlan = planHexWrite({ kind: 'NTAG215', mode: 'same', original: a, data, includeProtected: false });
    const r = writeReadiness({ ...base, source: src, reader: reader(card(UID_A)), samePlan });
    expect(r.block).toEqual({ type: 'excluded', protectedN: 1, lockedN: 0, otherN: 0 });
  });

  it('another tag / file / new is writable (it becomes a copy)', () => {
    for (const source of [src, { type: 'file' as const, name: 'a.nfcdump' }, { type: 'new' as const }]) {
      const r = writeReadiness({ ...base, source, reader: reader(card(UID_B)), samePlan: null });
      expect(r.block).toBeNull();
      expect(r.relation).not.toBe('same');
    }
  });

  it('an invalid NTAG password blocks the write', () => {
    const r = writeReadiness({ ...base, passwordValid: false, source: src, reader: reader(card(UID_B)), samePlan: null });
    expect(r.block).toEqual({ type: 'password' });
  });
});

describe('planHexWrite copy mode (WALK-1 / FLOW-13 / WALK-8)', () => {
  it('regression WALK-1: copying A (edited) onto blank B writes ALL differing data pages, not only the edit', () => {
    const a = tagA();
    const data = new Uint8Array(a.data);
    data[6 * 4] = 0x99; // the operator's edit
    // The old code planned against A's original and wrote only page 6 to B.
    expect(units(planWrites('NTAG215', a, data, { includeProtected: false }))).toEqual([6]);

    const b = blankImage('NTAG215', UID_B);
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data, target: b, includeProtected: false });
    expect(hp.mode).toBe('copy');
    expect(units(hp.plan)).toEqual([4, 5, 6]);
    // The result on B equals the document's data area.
    const after = new Uint8Array(b.data);
    for (const w of hp.plan.writes) after.set(w.data, w.unit * 4);
    expect(Array.from(after.subarray(16, 4 * 130))).toEqual(Array.from(data.subarray(16, 4 * 130)));
  });

  it('regression WALK-8: a file opened unchanged still writes its content to a different tag', () => {
    const file = tagA(); // the document = the file, original === image
    const b = blankImage('NTAG215', UID_B);
    expect(units(planWrites('NTAG215', file, file.data, { includeProtected: false }))).toEqual([]); // old: "nothing to write"
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: file, data: file.data, target: b, includeProtected: false });
    expect(units(hp.plan)).toEqual([4, 5]);
  });

  it('never copies the UID pages, and never copies protected areas implicitly (I5)', () => {
    const a = tagA();
    const cfg1 = ntagPages('NTAG215').cfg1;
    a.data[cfg1 * 4] = 0x10; // A has the counter on; the operator did not edit it
    const b = blankImage('NTAG215', UID_B);
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data: a.data, target: b, includeProtected: true });
    expect(units(hp.plan)).toEqual([4, 5]);
    expect(hp.notCopied.protected).toEqual([cfg1]);
    // page 2 differs only in the UID check byte: not reported as "protected not copied"
    expect(hp.notCopied.protected).not.toContain(2);
  });

  it('copies a protected edit only when the operator made it and protected writes are on', () => {
    const a = tagA();
    const data = new Uint8Array(a.data);
    const cfg1 = ntagPages('NTAG215').cfg1;
    data[cfg1 * 4] = 0x10;
    const b = blankImage('NTAG215', UID_B);
    const off = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data, target: b, includeProtected: false });
    expect(units(off.plan)).not.toContain(cfg1);
    const on = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data, target: b, includeProtected: true });
    expect(units(on.plan)).toContain(cfg1);
    expect(on.reactivate).toBe(true);
  });

  it('does not copy pages the document never read (zero-filled), unless edited', () => {
    const a = tagA();
    a.unitStatus[20] = 'denied';
    const b = blankImage('NTAG215', UID_B);
    b.data[20 * 4] = 0x77; // B has data there; A's 00 is unknown, not "empty"
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data: a.data, target: b, includeProtected: false });
    expect(units(hp.plan)).not.toContain(20);
    expect(hp.notCopied.unread).toEqual([20]);
  });

  it("leaves out the target's locked pages", () => {
    const a = tagA();
    const b = blankImage('NTAG215', UID_B);
    b.data[2 * 4 + 2] = 0x20; // page 5 locked on B
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data: a.data, target: b, includeProtected: false });
    expect(units(hp.plan)).toEqual([4]);
    expect(hp.excluded.locked).toEqual([5]);
  });
});

describe('lock word only for what is written', () => {
  it('an excluded danger (unknown key A trailer) does not demand the lock word for a data write', () => {
    const base = blankImage('MIFARE_CLASSIC_1K', 'A1B2C3D4');
    const tr = mifareTrailerBlock(1);
    base.data.fill(0, tr * 16, tr * 16 + 6);
    const data = new Uint8Array(base.data);
    data.set(encodeAccessBits({ c: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [0, 1, 1]], gpb: 0x69 }), tr * 16 + 6);
    data[4 * 16] = 0x31; // plain data
    const hp = planHexWrite({ kind: 'MIFARE_CLASSIC_1K', mode: 'same', original: base, data, includeProtected: true });
    expect(units(hp.plan)).toEqual([4]);
    expect(hp.excluded.keyA).toEqual([tr]);
    expect(needsLockConfirmForWrites(hp.plan)).toBe(false);
    expect(groupWarnings(hp.plan).map((g) => g.code)).toEqual([]);
    expect(groupWarnings(hp.plan, { all: true }).map((g) => g.code)).toEqual(['KEY_A_UNKNOWN']);
  });

  it('groups UNREAD warnings into one entry with all units', () => {
    const base = blankImage('NTAG215', UID_A);
    for (const u of [20, 21, 22, 30]) base.unitStatus[u] = 'unread';
    const data = new Uint8Array(base.data);
    for (const u of [20, 21, 22, 30]) data[u * 4] = 1;
    const plan = planWrites('NTAG215', base, data, { includeProtected: false });
    const g = groupWarnings(plan);
    expect(g).toHaveLength(1);
    expect(g[0].units).toEqual([20, 21, 22, 30]);
    expect(formatUnits('NTAG215', g[0].units).text).toBe('20〜22, 30');
  });
});

describe('formatUnits', () => {
  it('compresses ranges and caps the list', () => {
    expect(formatUnits('NTAG213', [4, 5, 6, 10]).text).toBe('4〜6, 10');
    expect(formatUnits('NTAG213', [1, 3, 5, 7, 9, 11, 13, 15], { max: 3 })).toEqual({ text: '1, 3, 5', more: 5 });
    expect(formatUnits('NTAG213', [4, 5], { sep: '–' }).text).toBe('4–5');
  });
  it('uses FeliCa block names', () => {
    expect(formatUnits('FELICA_LITE_S', [3, 14, 15]).text).toBe('S_PAD3, REG, MC');
  });
});

describe('read-only cells (WRITE-7)', () => {
  it('locks shown for a document read from a tag, not for a file', () => {
    const a = tagA();
    a.data[2 * 4 + 2] = 0x10; // page 4 locked
    expect(displayLockedUnits({ type: 'card', uid: UID_A }, 'NTAG215', a)).toEqual([4]);
    expect(displayLockedUnits({ type: 'file', name: 'x' }, 'NTAG215', a)).toEqual([]);
  });

  it('keepReadOnlyUnits puts back UID, locked and (switch off) protected bytes', () => {
    const a = tagA();
    const next = new Uint8Array(a.data).fill(0xaa);
    const cfg0 = ntagPages('NTAG215').cfg0;
    const off = keepReadOnlyUnits('NTAG215', next, a.data, { locked: new Set([4]), protectedEditable: false });
    expect(off.changed).toBe(true);
    expect(off.data[0]).toBe(a.data[0]); // UID
    expect(off.data[4 * 4]).toBe(0x41); // locked page 4 kept
    expect(off.data[5 * 4]).toBe(0xaa); // page 5 editable
    expect(off.data[cfg0 * 4]).toBe(a.data[cfg0 * 4]); // protected kept
    const on = keepReadOnlyUnits('NTAG215', next, a.data, { locked: new Set(), protectedEditable: true });
    expect(on.data[cfg0 * 4]).toBe(0xaa);
    expect(on.data[0]).toBe(a.data[0]); // UID stays read-only regardless
  });
});

describe('initializeImage per kind (WRITE-16)', () => {
  it('FeliCa: clears S_PAD0..13 only (S_PAD0/3/7/11 too), keeps REG and MC', () => {
    const img = blankImage('FELICA_LITE_S', '0102030405060708');
    img.data.fill(0x55, 0, 15 * 16); // S_PAD0..13 + REG
    const out = initializeImage('FELICA_LITE_S', img.data);
    for (const u of [0, 3, 7, 11, 13]) expect(out[u * 16]).toBe(0);
    expect(out[14 * 16]).toBe(0x55); // REG kept
    expect(Array.from(out.subarray(15 * 16, 16 * 16))).toEqual(Array.from(img.data.subarray(15 * 16, 16 * 16))); // MC kept
  });

  it('NTAG: empty NDEF TLV, CC / config kept', () => {
    const img = tagA();
    const out = initializeImage('NTAG215', img.data);
    expect(Array.from(out.subarray(16, 20))).toEqual([0x03, 0x00, 0xfe, 0x00]);
    expect(out[20]).toBe(0);
    expect(Array.from(out.subarray(12, 16))).toEqual(Array.from(img.data.subarray(12, 16)));
  });

  it('MIFARE ndef: keeps MAD + trailers + non-NDEF sectors, empties the NDEF sectors', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', 'A1B2C3D4');
    // MAD1: sector 1 and 2 = NDEF (03 E1), sector 3 = another app (00 01)
    img.data.set([0x00, 0x01, 0x03, 0xe1, 0x03, 0xe1, 0x00, 0x01], 16 + 2 * 0); // CRC/info + sector1 + sector2 + sector3
    img.data.fill(0x42, 4 * 16, 7 * 16); // sector 1 data
    img.data.fill(0x43, 12 * 16, 15 * 16); // sector 3 data (not NDEF)
    expect(mifareNdefBlocks('MIFARE_CLASSIC_1K', img.data)).toEqual([4, 5, 6, 8, 9, 10]);
    const out = initializeImage('MIFARE_CLASSIC_1K', img.data, 'ndef');
    expect(Array.from(out.subarray(16, 48))).toEqual(Array.from(img.data.subarray(16, 48))); // MAD kept
    expect(Array.from(out.subarray(4 * 16, 4 * 16 + 4))).toEqual([0x03, 0x00, 0xfe, 0x00]);
    expect(out[5 * 16]).toBe(0);
    expect(out[12 * 16]).toBe(0x43); // non-NDEF sector untouched
    const tr = mifareTrailerBlock(1) * 16;
    expect(Array.from(out.subarray(tr, tr + 16))).toEqual(Array.from(img.data.subarray(tr, tr + 16)));
  });

  it('MIFARE zero: every data block cleared (MAD too), trailers kept', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', 'A1B2C3D4');
    img.data.fill(0x42, 16, 48);
    const out = initializeImage('MIFARE_CLASSIC_1K', img.data, 'zero');
    expect(out[16]).toBe(0);
    expect(out[0]).toBe(img.data[0]); // block 0
    const tr = mifareTrailerBlock(0) * 16;
    expect(out[tr]).toBe(0xff);
  });
});

describe('isValidNtagPassword', () => {
  it('accepts empty or 8 hex digits only', () => {
    expect(isValidNtagPassword('')).toBe(true);
    expect(isValidNtagPassword('ffffffff')).toBe(true);
    expect(isValidNtagPassword('FFFFFFF')).toBe(false);
    expect(isValidNtagPassword('FFFFFFFG')).toBe(false);
  });
});
