// Unit tests for the binary (hex) editor's pure logic (renderer-hex).
// Pure logic only - no DOM, no Electron, no reader. Validated against real
// factory frames from @shared/tags so the I1/I2 (UID read-only) guard is tested
// on actual NTAG / MIFARE memory images.
import { describe, expect, it } from 'vitest';
import { factoryImage, mifareTrailerBlock, specFor } from '@shared/tags';
import { blankImage, planWrites } from '@shared/tag';
import { hexToBytes } from '@shared/hex';
import {
  changedMask,
  changedUnitCount,
  effectiveIncludeProtected,
  fillRange,
  findBytes,
  incrementRange,
  needsLockConfirm,
  parseByteInput,
  parseIntInput,
  parsePattern,
  pasteBytes,
  rangeTouchesForbidden,
  readUint,
  regionKey,
  replaceBytes,
  restoreLockedBytes,
  selectionBounds,
  unitOfByte,
  writeUint,
} from '../src/renderer/src/views/hex/model';

const NTAG_UID = hexToBytes('04AABBCCDDEE80'); // 7 bytes
const MF_UID = hexToBytes('04AABBCC'); // 4 bytes

describe('readUint / writeUint', () => {
  const d = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);

  it('reads big- and little-endian', () => {
    expect(readUint(d, 0, 4, 'BE')).toBe(0x12345678n);
    expect(readUint(d, 0, 4, 'LE')).toBe(0x78563412n);
  });

  it('reads a sub-range', () => {
    expect(readUint(d, 1, 2, 'BE')).toBe(0x3456n);
    expect(readUint(d, 1, 2, 'LE')).toBe(0x5634n);
  });

  it('writes big- and little-endian without touching neighbours', () => {
    const be = writeUint(d, 0, 4, 0x0a0b0c0dn, 'BE');
    expect(Array.from(be)).toEqual([0x0a, 0x0b, 0x0c, 0x0d]);
    const le = writeUint(d, 0, 4, 0x0a0b0c0dn, 'LE');
    expect(Array.from(le)).toEqual([0x0d, 0x0c, 0x0b, 0x0a]);
    // original is not mutated
    expect(Array.from(d)).toEqual([0x12, 0x34, 0x56, 0x78]);
  });

  it('masks values wider than the range', () => {
    const out = writeUint(Uint8Array.from([0, 0]), 0, 2, 0x1ffffn, 'BE');
    expect(Array.from(out)).toEqual([0xff, 0xff]);
  });
});

describe('incrementRange', () => {
  it('increments and wraps a single byte', () => {
    expect(Array.from(incrementRange(Uint8Array.from([0xff]), 0, 1, 1n, 'BE'))).toEqual([0x00]);
    expect(Array.from(incrementRange(Uint8Array.from([0x00]), 0, 1, -1n, 'BE'))).toEqual([0xff]);
  });

  it('carries across bytes big-endian', () => {
    expect(Array.from(incrementRange(Uint8Array.from([0x00, 0xff]), 0, 2, 1n, 'BE'))).toEqual([0x01, 0x00]);
  });

  it('carries across bytes little-endian', () => {
    // LE bytes [FF,00] = value 0x00FF; +1 => 0x0100 => LE bytes [00,01]
    expect(Array.from(incrementRange(Uint8Array.from([0xff, 0x00]), 0, 2, 1n, 'LE'))).toEqual([0x00, 0x01]);
  });

  it('applies an arbitrary step', () => {
    expect(Array.from(incrementRange(Uint8Array.from([0x10]), 0, 1, 0x20n, 'BE'))).toEqual([0x30]);
  });
});

describe('fillRange / pasteBytes', () => {
  it('fills an inclusive range', () => {
    expect(Array.from(fillRange(Uint8Array.from([1, 2, 3, 4]), 1, 2, 0xff))).toEqual([1, 0xff, 0xff, 4]);
  });

  it('accepts reversed bounds and clamps', () => {
    expect(Array.from(fillRange(Uint8Array.from([1, 2, 3]), 5, 0, 0))).toEqual([0, 0, 0]);
  });

  it('pastes, truncating at the end', () => {
    expect(Array.from(pasteBytes(Uint8Array.from([1, 2, 3, 4]), 2, Uint8Array.from([0xaa, 0xbb, 0xcc])))).toEqual([1, 2, 0xaa, 0xbb]);
  });
});

describe('findBytes / replaceBytes', () => {
  it('finds non-overlapping occurrences', () => {
    expect(findBytes(Uint8Array.from([0xaa, 0xaa, 0xaa]), Uint8Array.from([0xaa, 0xaa]))).toEqual([0]);
    expect(findBytes(Uint8Array.from([1, 2, 1, 2, 1, 2]), Uint8Array.from([1, 2]))).toEqual([0, 2, 4]);
  });

  it('returns no matches for an empty needle', () => {
    expect(findBytes(Uint8Array.from([1, 2]), Uint8Array.from([]))).toEqual([]);
  });

  it('replaces all occurrences and reports the count', () => {
    const res = replaceBytes(Uint8Array.from([1, 2, 9, 1, 2]), Uint8Array.from([1, 2]), Uint8Array.from([7, 8]));
    expect(res.count).toBe(2);
    expect(Array.from(res.data)).toEqual([7, 8, 9, 7, 8]);
  });

  it('refuses a replacement of a different length', () => {
    expect(() => replaceBytes(Uint8Array.from([1, 2]), Uint8Array.from([1]), Uint8Array.from([1, 2]))).toThrow();
  });
});

describe('parsePattern / parseIntInput / parseByteInput', () => {
  it('parses hex patterns leniently', () => {
    expect(Array.from(parsePattern('E1 10 3E', 'hex'))).toEqual([0xe1, 0x10, 0x3e]);
    expect(Array.from(parsePattern('0x04:0xA2', 'hex'))).toEqual([0x04, 0xa2]);
  });

  it('parses ascii patterns as UTF-8', () => {
    expect(Array.from(parsePattern('AB', 'ascii'))).toEqual([0x41, 0x42]);
  });

  it('throws on odd hex', () => {
    expect(() => parsePattern('E1 1', 'hex')).toThrow();
  });

  it('parses integers in decimal / hex / binary with sign', () => {
    expect(parseIntInput('42')).toBe(42n);
    expect(parseIntInput('0x1A')).toBe(0x1an);
    expect(parseIntInput('0b101')).toBe(5n);
    expect(parseIntInput('-3')).toBe(-3n);
    expect(() => parseIntInput('zz')).toThrow();
  });

  it('parses a byte as hex', () => {
    expect(parseByteInput('FF')).toBe(255);
    expect(parseByteInput('0a')).toBe(10);
    expect(parseByteInput('0xA0')).toBe(160);
    expect(() => parseByteInput('256')).toThrow();
    expect(() => parseByteInput('zz')).toThrow();
  });
});

describe('restoreLockedBytes (I1/I2: UID read-only)', () => {
  it('reverts any edit to NTAG pages 0-1 (UID) but keeps user-area edits', () => {
    const img = factoryImage('NTAG215', NTAG_UID);
    const edited = new Uint8Array(img);
    edited[0] ^= 0xff; // page 0 (UID) byte 0
    edited[5] ^= 0xff; // page 1 (UID) byte 1
    edited[16] = 0x99; // page 4 (user data) byte 0
    const safe = restoreLockedBytes('NTAG215', edited, img);
    expect(safe[0]).toBe(img[0]); // UID restored
    expect(safe[5]).toBe(img[5]); // UID restored
    expect(safe[16]).toBe(0x99); // user edit preserved
  });

  it('reverts any edit to MIFARE block 0 (manufacturer/UID)', () => {
    const img = factoryImage('MIFARE_CLASSIC_1K', MF_UID);
    const edited = new Uint8Array(img);
    for (let i = 0; i < 16; i++) edited[i] ^= 0xff; // block 0
    edited[16] = 0x55; // block 1 (data)
    const safe = restoreLockedBytes('MIFARE_CLASSIC_1K', edited, img);
    for (let i = 0; i < 16; i++) expect(safe[i]).toBe(img[i]); // block 0 restored
    expect(safe[16]).toBe(0x55); // data edit preserved
  });
});

describe('rangeTouchesForbidden / regionKey / units', () => {
  it('flags ranges that touch a forbidden unit', () => {
    expect(rangeTouchesForbidden('NTAG213', 0, 3)).toBe(true); // includes pages 0-1
    expect(rangeTouchesForbidden('NTAG213', 16, 19)).toBe(false); // page 4
    expect(rangeTouchesForbidden('MIFARE_CLASSIC_1K', 0, 15)).toBe(true); // block 0
    expect(rangeTouchesForbidden('MIFARE_CLASSIC_1K', 16, 31)).toBe(false); // block 1
  });

  it('maps units to region keys', () => {
    expect(regionKey('NTAG213', 0)).toBe('uid');
    expect(regionKey('NTAG213', 4)).toBe('user');
    expect(regionKey('MIFARE_CLASSIC_1K', 0)).toBe('manufacturer');
    expect(regionKey('MIFARE_CLASSIC_1K', 1)).toBe('data');
    expect(regionKey('MIFARE_CLASSIC_1K', mifareTrailerBlock(0))).toBe('trailer');
  });

  it('computes the unit of a byte', () => {
    expect(unitOfByte('NTAG213', 17)).toBe(4);
    expect(unitOfByte('MIFARE_CLASSIC_1K', 33)).toBe(2);
  });
});

describe('selection + change accounting', () => {
  it('orders selection bounds', () => {
    expect(selectionBounds(10, 4)).toEqual({ lo: 4, hi: 10 });
    expect(selectionBounds(4, 10)).toEqual({ lo: 4, hi: 10 });
  });

  it('counts changed units and bytes', () => {
    const img = factoryImage('NTAG215', NTAG_UID);
    const edited = new Uint8Array(img);
    edited[16] = 0x11; // unit 4
    edited[17] = 0x22; // unit 4 (same unit)
    edited[24] = 0x33; // unit 6
    expect(changedUnitCount('NTAG215', edited, img)).toBe(2);
    const mask = changedMask(edited, img);
    expect(mask[16]).toBe(true);
    expect(mask[18]).toBe(false);
    expect(mask.filter(Boolean).length).toBe(3);
  });
});

describe('image size sanity', () => {
  it('builds full-size factory images', () => {
    expect(factoryImage('NTAG213', NTAG_UID).length).toBe(specFor('NTAG213').unitCount * 4);
    expect(factoryImage('MIFARE_CLASSIC_4K', MF_UID).length).toBe(specFor('MIFARE_CLASSIC_4K').unitCount * 16);
  });
});

// blankImage takes a UID string; NTAG213 config pages: dynLock 40, CFG0 41, PWD 43, PACK 44.
const NTAG_UID_STR = '04AABBCCDDEE80';
const MF_UID_STR = '04AABBCC';

describe('effectiveIncludeProtected (I5: advanced-mode gate)', () => {
  it('writes protected areas only while advanced mode is on AND the switch is on', () => {
    expect(effectiveIncludeProtected(true, true)).toBe(true);
    expect(effectiveIncludeProtected(true, false)).toBe(false);
    expect(effectiveIncludeProtected(false, false)).toBe(false);
  });

  it('disarms a remembered switch value when advanced mode is off (regression: stayed armed while hidden)', () => {
    // advanced OFF but the local switch is still true -> must resolve to false.
    expect(effectiveIncludeProtected(false, true)).toBe(false);
  });

  it('keeps protected units out of the write plan when the gate resolves to false', () => {
    const base = blankImage('NTAG213', NTAG_UID_STR);
    const edited = new Uint8Array(base.data);
    edited[41 * 4 + 3] = 0x10; // CFG0 (protected config page)

    // advanced OFF + switch ON: the armed-while-hidden case from the finding.
    const gatedOff = planWrites('NTAG213', base, edited, { includeProtected: effectiveIncludeProtected(false, true) });
    expect(gatedOff.protectedUnits).toContain(41);
    expect(gatedOff.writes.some((w) => w.unit === 41)).toBe(false);
    expect(needsLockConfirm(gatedOff)).toBe(false);

    // advanced ON + switch ON: protected write is planned and gated by a word.
    const gatedOn = planWrites('NTAG213', base, edited, { includeProtected: effectiveIncludeProtected(true, true) });
    expect(gatedOn.writes.some((w) => w.unit === 41)).toBe(true);
    expect(needsLockConfirm(gatedOn)).toBe(true);
  });
});

describe('needsLockConfirm (I5: irreversible writes need word input)', () => {
  it('requires the word when writing an NTAG dynamic lock page', () => {
    const base = blankImage('NTAG213', NTAG_UID_STR);
    const edited = new Uint8Array(base.data);
    edited[40 * 4] = 0xff; // dynamic lock page 40 - sets lock bits (LOCK_IRREVERSIBLE)
    const plan = planWrites('NTAG213', base, edited, { includeProtected: true });
    expect(plan.warnings.some((w) => w.code === 'LOCK_IRREVERSIBLE' && w.severity === 'danger')).toBe(true);
    expect(needsLockConfirm(plan)).toBe(true);
  });

  it('requires the word when writing a config page (CFGLCK) or a MIFARE sector trailer', () => {
    const ntag = blankImage('NTAG213', NTAG_UID_STR);
    const ntagEdited = new Uint8Array(ntag.data);
    ntagEdited[41 * 4 + 3] = 0x10; // CFG0 (CONFIG)
    expect(needsLockConfirm(planWrites('NTAG213', ntag, ntagEdited, { includeProtected: true }))).toBe(true);

    const mf = blankImage('MIFARE_CLASSIC_1K', MF_UID_STR);
    const trailer = mifareTrailerBlock(0);
    const mfEdited = new Uint8Array(mf.data);
    mfEdited[trailer * 16] = 0x00; // change key A, keep the (valid) access bits -> TRAILER
    const mfPlan = planWrites('MIFARE_CLASSIC_1K', mf, mfEdited, { includeProtected: true });
    expect(mfPlan.writes.some((w) => w.unit === trailer)).toBe(true);
    expect(needsLockConfirm(mfPlan)).toBe(true);
  });

  it('requires the word when an edit clears an OTP bit (danger), even mixed with a plain write', () => {
    const base = blankImage('NTAG213', NTAG_UID_STR); // CC = E1 10 12 00
    const edited = new Uint8Array(base.data);
    edited[3 * 4 + 2] = 0x00; // clears a set CC bit -> CC_OTP danger
    edited[4 * 4] = 0x99; // ordinary user page so the plan has something to write
    const plan = planWrites('NTAG213', base, edited, { includeProtected: false });
    expect(plan.warnings.some((w) => w.code === 'CC_OTP' && w.severity === 'danger')).toBe(true);
    expect(needsLockConfirm(plan)).toBe(true);
  });

  it('does NOT require the word for an ordinary user-data write', () => {
    const base = blankImage('NTAG213', NTAG_UID_STR);
    const edited = new Uint8Array(base.data);
    edited[5 * 4] = 0x42; // user page 5 only
    const plan = planWrites('NTAG213', base, edited, { includeProtected: false });
    expect(plan.writes.some((w) => w.unit === 5)).toBe(true);
    expect(needsLockConfirm(plan)).toBe(false);
  });
});
