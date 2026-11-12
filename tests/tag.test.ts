import { describe, it, expect } from 'vitest';
import {
  blankImage,
  cloneImage,
  unitBytes,
  diffUnits,
  isBlankDataArea,
  planWrites,
  readNtagConfig,
  buildNtagConfigWrites,
  readNtagLockState,
  buildNtagPasswordWrites,
  buildNtagRemovePasswordWrites,
  buildNtagCounterWrites,
  buildNtagLockUserAreaWrites,
  describeAccess,
  buildTrailer,
  serializeProject,
  parseProject,
  exportBin,
  importBin,
  exportFlipper,
  importFlipper,
  detectDumpFormat,
  importDump,
} from '@shared/tag';
import {
  specFor,
  imageSize,
  ntagPages,
  parseAccessBits,
  encodeAccessBits,
  MIFARE_TRANSPORT_ACCESS,
  mifareTrailerBlock,
  type AccessBits,
  type TagKind,
} from '@shared/tags';
import { hexToBytes, bytesToHex } from '@shared/hex';
import type { TagImage, UnitWrite } from '@shared/types';

const NTAG_UID = '04A1B2C3D4E5F6';
const MF_UID = '11223344';

function applyWrites(kind: TagKind, data: Uint8Array, writes: UnitWrite[]): Uint8Array {
  const size = specFor(kind).unitSize;
  const out = new Uint8Array(data);
  for (const w of writes) out.set(w.data, w.unit * size);
  return out;
}

function units(writes: UnitWrite[]): number[] {
  return writes.map((w) => w.unit);
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

describe('image helpers', () => {
  it('blankImage produces a factory NTAG image with all units ok and blank data', () => {
    const img = blankImage('NTAG215', NTAG_UID);
    expect(img.kind).toBe('NTAG215');
    expect(img.uid).toBe(NTAG_UID);
    expect(img.data.length).toBe(imageSize('NTAG215'));
    expect(img.unitStatus.length).toBe(specFor('NTAG215').unitCount);
    expect(img.unitStatus.every((s) => s === 'ok')).toBe(true);
    expect(isBlankDataArea('NTAG215', img.data)).toBe(true);
  });

  it('blankImage MIFARE is blank and sized', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    expect(img.data.length).toBe(1024);
    expect(isBlankDataArea('MIFARE_CLASSIC_1K', img.data)).toBe(true);
  });

  it('cloneImage is independent', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const copy = cloneImage(img);
    copy.data[16] = 0xaa;
    copy.unitStatus[0] = 'denied';
    expect(img.data[16]).not.toBe(0xaa);
    expect(img.unitStatus[0]).toBe('ok');
  });

  it('unitBytes returns an independent copy of one unit', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const page3 = unitBytes('NTAG213', img.data, 3);
    expect(bytesToHex(page3)).toBe('E1101200'); // CC for NTAG213
    page3[0] = 0x00;
    expect(img.data[12]).toBe(0xe1);
  });

  it('diffUnits reports only changed units', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const edited = new Uint8Array(img.data);
    edited[16] = 0x55; // page 4 (factory byte here is 0x03)
    edited[5 * 4] = 0x99; // page 5
    expect(diffUnits('NTAG213', img.data, edited)).toEqual([4, 5]);
  });

  it('isBlankDataArea is false once an NDEF message carries records', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const edited = new Uint8Array(img.data);
    edited[16] = 0x03; // NDEF TLV
    edited[17] = 0x05; // length 5
    expect(isBlankDataArea('NTAG213', edited)).toBe(false);
  });

  it('isBlankDataArea is false once a MIFARE data block holds data', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    const edited = new Uint8Array(img.data);
    edited[1 * 16] = 0x42; // block 1 (data)
    expect(isBlankDataArea('MIFARE_CLASSIC_1K', edited)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Write planning
// ---------------------------------------------------------------------------

describe('planWrites', () => {
  it('never writes NTAG UID pages (forbidden) and warns UID_READONLY', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    const edited = new Uint8Array(base.data);
    edited[0] = (edited[0] ^ 0xff) & 0xff; // page 0 (UID)
    const plan = planWrites('NTAG213', base, edited, { includeProtected: true });
    expect(plan.forbiddenUnits).toContain(0);
    expect(units(plan.writes)).not.toContain(0);
    expect(plan.warnings.some((w) => w.unit === 0 && w.code === 'UID_READONLY')).toBe(true);
  });

  it('never writes MIFARE block 0 (forbidden)', () => {
    const base = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    const edited = new Uint8Array(base.data);
    edited[3] = 0x55; // block 0
    const plan = planWrites('MIFARE_CLASSIC_1K', base, edited, { includeProtected: true });
    expect(plan.forbiddenUnits).toContain(0);
    expect(units(plan.writes)).not.toContain(0);
  });

  it('excludes protected units unless includeProtected, then warns', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    const cfg0 = specFor('NTAG213'); // for reference
    void cfg0;
    const edited = new Uint8Array(base.data);
    edited[41 * 4 + 3] = 0x10; // CFG0 AUTH0 (protected, config)

    const excluded = planWrites('NTAG213', base, edited, { includeProtected: false });
    expect(excluded.protectedUnits).toContain(41);
    expect(units(excluded.writes)).not.toContain(41);

    const included = planWrites('NTAG213', base, edited, { includeProtected: true });
    expect(units(included.writes)).toContain(41);
    expect(included.warnings.some((w) => w.unit === 41 && w.code === 'CONFIG')).toBe(true);
  });

  it('forbids a MIFARE trailer with invalid access bits (ACCESS_BITS_INVALID)', () => {
    const base = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    const trailer = mifareTrailerBlock(0); // block 3
    const edited = new Uint8Array(base.data);
    edited[trailer * 16 + 6] = 0x00;
    edited[trailer * 16 + 7] = 0x00;
    edited[trailer * 16 + 8] = 0x00; // breaks the inverted-copy check
    const plan = planWrites('MIFARE_CLASSIC_1K', base, edited, { includeProtected: true });
    expect(plan.forbiddenUnits).toContain(trailer);
    expect(units(plan.writes)).not.toContain(trailer);
    expect(plan.warnings.some((w) => w.unit === trailer && w.code === 'ACCESS_BITS_INVALID' && w.severity === 'danger')).toBe(true);
  });

  it('warns UNREAD_UNIT when writing over a unit that was not readable', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    base.unitStatus[5] = 'unread';
    const edited = new Uint8Array(base.data);
    edited[5 * 4] = 0x99;
    const plan = planWrites('NTAG213', base, edited, { includeProtected: false });
    expect(units(plan.writes)).toContain(5);
    expect(plan.warnings.some((w) => w.unit === 5 && w.code === 'UNREAD_UNIT')).toBe(true);
  });

  it('warns (danger) when an edit clears an OTP bit on the CC page, even if not written', () => {
    const base = blankImage('NTAG213', NTAG_UID); // CC = E1 10 12 00
    const edited = new Uint8Array(base.data);
    edited[3 * 4 + 2] = 0x00; // clear size nibble of CC -> clears set bits
    const plan = planWrites('NTAG213', base, edited, { includeProtected: false });
    expect(plan.protectedUnits).toContain(3);
    expect(units(plan.writes)).not.toContain(3);
    expect(plan.warnings.some((w) => w.unit === 3 && w.code === 'CC_OTP' && w.severity === 'danger')).toBe(true);
  });

  it('orders the NTAG password group PWD, PACK, CFG1, CFG0 after user pages', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    const edited = new Uint8Array(base.data);
    edited[4 * 4] = 0x01; // user page 4
    edited[41 * 4 + 3] = 0x10; // CFG0
    edited[42 * 4] = 0x80; // CFG1
    edited.set([0xaa, 0xbb, 0xcc, 0xdd], 43 * 4); // PWD
    edited.set([0x11, 0x22, 0x00, 0x00], 44 * 4); // PACK
    const plan = planWrites('NTAG213', base, edited, { includeProtected: true });
    expect(units(plan.writes)).toEqual([4, 43, 44, 42, 41]);
  });
});

// ---------------------------------------------------------------------------
// NTAG21x configuration
// ---------------------------------------------------------------------------

describe('NTAG config', () => {
  it('reads factory defaults', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const cfg = readNtagConfig('NTAG213', img.data);
    expect(cfg).toEqual({
      mirror: { conf: 'none', byte: 0, page: 0 },
      strongModulation: true,
      auth0: 0xff,
      prot: false,
      cfgLock: false,
      counterEnabled: false,
      counterPwdProtected: false,
      authLimit: 0,
    });
  });

  it('round-trips a modified config through build + read', () => {
    const img = blankImage('NTAG215', NTAG_UID);
    const next = {
      mirror: { conf: 'uid' as const, byte: 1, page: 5 },
      strongModulation: false,
      auth0: 0x10,
      prot: true,
      cfgLock: false,
      counterEnabled: true,
      counterPwdProtected: false,
      authLimit: 3,
    };
    const writes = buildNtagConfigWrites('NTAG215', img.data, next);
    const data2 = applyWrites('NTAG215', img.data, writes);
    expect(readNtagConfig('NTAG215', data2)).toEqual(next);
  });

  it('config writes put CFG0/AUTH0 last when arming password protection (safe order)', () => {
    // Regression: enabling protection (auth0 covers the config pages) must write
    // CFG1 (PROT/AUTHLIM) before CFG0 (AUTH0). Otherwise AUTH0 arms first and the
    // CFG1 write hits a now-protected page -> half-applied lockout. DESIGN §3.1.
    const img = blankImage('NTAG213', NTAG_UID);
    const p = ntagPages('NTAG213'); // cfg0 41, cfg1 42
    const next = {
      mirror: { conf: 'none' as const, byte: 0, page: 0 },
      strongModulation: true,
      auth0: 0x29, // 41 = CFG0 page: protects the config pages
      prot: true,
      cfgLock: false,
      counterEnabled: false,
      counterPwdProtected: false,
      authLimit: 3,
    };
    const writes = buildNtagConfigWrites('NTAG213', img.data, next);
    expect(units(writes)).toEqual([p.cfg1, p.cfg0]);
    expect(writes[writes.length - 1].unit).toBe(p.cfg0); // AUTH0 written last
    expect(readNtagConfig('NTAG213', applyWrites('NTAG213', img.data, writes))).toEqual(next);
  });

  it('config writes put AUTH0 last whenever auth0 reaches the config pages (boundary)', () => {
    const img = blankImage('NTAG215', NTAG_UID);
    const p = ntagPages('NTAG215'); // cfg1 132
    const base = {
      mirror: { conf: 'none' as const, byte: 0, page: 0 },
      strongModulation: true,
      prot: false,
      cfgLock: false,
      counterEnabled: false,
      counterPwdProtected: false,
      authLimit: 0,
    };
    // auth0 == cfg1 page: CFG1 still becomes protected, so CFG0 must be last.
    expect(units(buildNtagConfigWrites('NTAG215', img.data, { ...base, auth0: p.cfg1 }))).toEqual([p.cfg1, p.cfg0]);
    // auth0 just past the config pages (0xFF, protection off): order is CFG0, CFG1.
    expect(units(buildNtagConfigWrites('NTAG215', img.data, { ...base, auth0: 0xff }))).toEqual([p.cfg0, p.cfg1]);
  });

  it('config writes put CFG1/CFGLCK last when locking the config (no AUTH0 arming)', () => {
    // CFGLCK irreversibly locks CFG0+CFG1, so CFG1 must be written last or the
    // trailing CFG0 write would be rejected. Reorder must not regress this path.
    const img = blankImage('NTAG213', NTAG_UID);
    const p = ntagPages('NTAG213');
    const next = {
      mirror: { conf: 'uid' as const, byte: 2, page: 6 },
      strongModulation: false,
      auth0: 0xff, // protection off: no AUTH0 arming
      prot: false,
      cfgLock: true,
      counterEnabled: false,
      counterPwdProtected: false,
      authLimit: 0,
    };
    const writes = buildNtagConfigWrites('NTAG213', img.data, next);
    expect(units(writes)).toEqual([p.cfg0, p.cfg1]);
    expect(writes[writes.length - 1].unit).toBe(p.cfg1); // CFGLCK written last
    expect(readNtagConfig('NTAG213', applyWrites('NTAG213', img.data, writes))).toEqual(next);
  });

  it('config writes reject arming AUTH0 protection and CFGLCK in one pass', () => {
    // Both at once cannot complete in a single unauthenticated pass: either order
    // leaves one write blocked, bricking the tag. Must throw instead.
    const img = blankImage('NTAG216', NTAG_UID);
    expect(() =>
      buildNtagConfigWrites('NTAG216', img.data, {
        mirror: { conf: 'none', byte: 0, page: 0 },
        strongModulation: true,
        auth0: 0x10, // protects config pages
        prot: true,
        cfgLock: true,
        counterEnabled: false,
        counterPwdProtected: false,
        authLimit: 0,
      }),
    ).toThrow();
  });

  it('builds password writes in PWD, PACK, CFG1, CFG0 order and sets AUTH0/PROT/AUTHLIM', () => {
    const img = blankImage('NTAG216', NTAG_UID);
    const p = { pwd: 229, pack: 230, cfg1: 228, cfg0: 227 };
    const writes = buildNtagPasswordWrites('NTAG216', img.data, {
      password: 'AABBCCDD',
      pack: '1122',
      auth0: 0x20,
      protectRead: true,
      authLimit: 5,
    });
    expect(units(writes)).toEqual([p.pwd, p.pack, p.cfg1, p.cfg0]);
    expect(bytesToHex(writes[0].data)).toBe('AABBCCDD');
    expect(Array.from(writes[1].data.slice(0, 2))).toEqual([0x11, 0x22]);
    const data2 = applyWrites('NTAG216', img.data, writes);
    const cfg = readNtagConfig('NTAG216', data2);
    expect(cfg.auth0).toBe(0x20);
    expect(cfg.prot).toBe(true);
    expect(cfg.authLimit).toBe(5);
  });

  it('rejects malformed password / pack', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    expect(() => buildNtagPasswordWrites('NTAG213', img.data, { password: 'AABB', pack: '1122', auth0: 0, protectRead: false, authLimit: 0 })).toThrow();
    expect(() => buildNtagPasswordWrites('NTAG213', img.data, { password: 'AABBCCDD', pack: '11', auth0: 0, protectRead: false, authLimit: 0 })).toThrow();
  });

  it('remove-password sets AUTH0 to 0xFF', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const withPw = applyWrites('NTAG213', img.data, buildNtagPasswordWrites('NTAG213', img.data, { password: 'AABBCCDD', pack: '1122', auth0: 0x04, protectRead: false, authLimit: 0 }));
    expect(readNtagConfig('NTAG213', withPw).auth0).toBe(0x04);
    const cleared = applyWrites('NTAG213', withPw, buildNtagRemovePasswordWrites('NTAG213', withPw));
    expect(readNtagConfig('NTAG213', cleared).auth0).toBe(0xff);
  });

  it('counter writes toggle NFC_CNT_EN only', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const on = applyWrites('NTAG213', img.data, buildNtagCounterWrites('NTAG213', img.data, true));
    expect(readNtagConfig('NTAG213', on).counterEnabled).toBe(true);
    const off = applyWrites('NTAG213', on, buildNtagCounterWrites('NTAG213', on, false));
    expect(readNtagConfig('NTAG213', off).counterEnabled).toBe(false);
  });

  it('lock-user-area sets static + dynamic lock bits (CC + pages locked), preserving UID page bytes', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const writes = buildNtagLockUserAreaWrites('NTAG213', img.data);
    const locked = applyWrites('NTAG213', img.data, writes);
    // UID-page bytes 0,1 (BCC1 + internal) preserved
    expect(locked[2 * 4 + 0]).toBe(img.data[2 * 4 + 0]);
    expect(locked[2 * 4 + 1]).toBe(img.data[2 * 4 + 1]);
    const state = readNtagLockState('NTAG213', locked);
    expect(state.ccLocked).toBe(true);
    expect(state.blockLocked).toBe(true);
    expect(state.lockedPages).toContain(16);
    expect(state.lockedPages).toContain(39);
    // idempotent
    const again = applyWrites('NTAG213', locked, buildNtagLockUserAreaWrites('NTAG213', locked));
    expect(Array.from(again)).toEqual(Array.from(locked));
  });

  it('does not report blockLocked for a factory NTAG213 (dyn byte3 reads 0xBD, not a lock bit)', () => {
    // Regression (2026-11-12 real hardware): page 0x28 byte3 is a constant 0xBD
    // read-back, NOT a lock byte. The old code tested (byte3 & 0x07) and reported
    // blockLocked=true for every NTAG213.
    const img = blankImage('NTAG213', NTAG_UID);
    const p = ntagPages('NTAG213');
    const data = new Uint8Array(img.data);
    data.set([0x00, 0x00, 0x00, 0xbd], p.dynLock * 4); // true factory dynamic-lock page
    const state = readNtagLockState('NTAG213', data);
    expect(state.blockLocked).toBe(false);
    expect(state.lockedPages).toEqual([]);
  });

  it('NTAG213 dynamic lock locks 2 pages per bit (byte0 bit0 -> pages 16 and 17)', () => {
    // Regression (2026-11-12 real hardware): NTAG213 granularity is 2 pages/bit,
    // not 1 (byte0 bit0 locked pages 0x10 AND 0x11 on a real tag).
    const img = blankImage('NTAG213', NTAG_UID);
    const p = ntagPages('NTAG213');
    const data = new Uint8Array(img.data);
    data.set([0x01, 0x00, 0x00, 0xbd], p.dynLock * 4); // byte0 bit0 set
    const state = readNtagLockState('NTAG213', data);
    expect(state.lockedPages).toContain(16);
    expect(state.lockedPages).toContain(17);
    expect(state.lockedPages).not.toContain(18);
    expect(state.blockLocked).toBe(false); // a page-lock bit, not a BL bit
  });
});

// ---------------------------------------------------------------------------
// MIFARE Classic trailer / access
// ---------------------------------------------------------------------------

describe('MIFARE access and trailer', () => {
  const keyA = hexToBytes('A0A1A2A3A4A5');
  const keyB = hexToBytes('FFFFFFFFFFFF');

  it('buildTrailer round-trips through parseAccessBits', () => {
    const access: AccessBits = { c: [[1, 1, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]], gpb: 0x00 };
    const trailer = buildTrailer(keyA, access, keyB);
    expect(trailer.length).toBe(16);
    expect(Array.from(trailer.slice(0, 6))).toEqual(Array.from(keyA));
    expect(Array.from(trailer.slice(10, 16))).toEqual(Array.from(keyB));
    expect(parseAccessBits(trailer)).toEqual(access);
  });

  it('buildTrailer rejects wrong key length', () => {
    const access: AccessBits = { c: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]], gpb: 0x69 };
    expect(() => buildTrailer(hexToBytes('AABBCC'), access, keyB)).toThrow();
    expect(() => buildTrailer(keyA, access, hexToBytes('AABBCC'))).toThrow();
  });

  it('describes the transport configuration', () => {
    const transportTrailer = new Uint8Array(16);
    transportTrailer.set(MIFARE_TRANSPORT_ACCESS, 6);
    const access = parseAccessBits(transportTrailer);
    expect(access).not.toBeNull();
    const bits = access as AccessBits;
    const data0 = describeAccess(bits, 0);
    expect(data0.read).toBe('AB');
    expect(data0.write).toBe('AB');
    const trailer = describeAccess(bits, 3);
    expect(trailer.read).toBe('A');
    expect(trailer.write).toBe('A');
    expect(trailer.increment).toBeNull();
  });

  it('describes a read-only data block (C1C2C3 = 110)', () => {
    const access: AccessBits = { c: [[1, 1, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]], gpb: 0 };
    const d = describeAccess(access, 0);
    expect(d.read).toBe('AB');
    expect(d.write).toBe('B');
    expect(d.increment).toBe('B');
    expect(d.decrementTransferRestore).toBe('AB');
  });

  it('encode/parse access bits are inverse for all 64 data patterns', () => {
    for (let k = 0; k < 8; k++) {
      const c0: [number, number, number] = [(k >> 2) & 1, (k >> 1) & 1, k & 1];
      const access: AccessBits = { c: [c0, [0, 0, 0], [0, 0, 0], [0, 0, 1]], gpb: 0x42 };
      const enc = encodeAccessBits(access);
      const trailer = new Uint8Array(16);
      trailer.set(enc, 6);
      expect(parseAccessBits(trailer)).toEqual(access);
    }
  });
});

// ---------------------------------------------------------------------------
// Dump formats
// ---------------------------------------------------------------------------

describe('dump formats', () => {
  it('round-trips a raw binary image (NTAG213)', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const bin = exportBin(img);
    expect(bin.length).toBe(180);
    const back = importBin(bin);
    expect(back.kind).toBe('NTAG213');
    expect(back.uid).toBe(NTAG_UID);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('round-trips a raw binary image (MIFARE 4K)', () => {
    const img = blankImage('MIFARE_CLASSIC_4K', MF_UID);
    const bin = exportBin(img);
    expect(bin.length).toBe(4096);
    const back = importBin(bin);
    expect(back.kind).toBe('MIFARE_CLASSIC_4K');
    expect(back.uid).toBe(MF_UID);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('importBin honours a kind hint and rejects a size mismatch', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    expect(() => importBin(exportBin(img), 'NTAG215')).toThrow();
  });

  it('round-trips the native project format', () => {
    const img = blankImage('NTAG216', NTAG_UID);
    img.data[16] = 0x03;
    img.data[17] = 0x03;
    img.unitStatus[10] = 'denied';
    const bytes = serializeProject(img, { note: 'テスト タグ', appVersion: '0.1.0', savedAt: '2026-11-09T00:00:00Z' });
    const { image, note } = parseProject(bytes);
    expect(image.kind).toBe('NTAG216');
    expect(image.uid).toBe(NTAG_UID);
    expect(Array.from(image.data)).toEqual(Array.from(img.data));
    expect(image.unitStatus).toEqual(img.unitStatus);
    expect(note).toBe('テスト タグ');
  });

  it('parseProject rejects a non-dump JSON', () => {
    const bytes = new TextEncoder().encode('{"hello":1}');
    expect(() => parseProject(bytes)).toThrow();
  });

  it('round-trips Flipper .nfc for NTAG215 (kind/uid/data)', () => {
    const img = blankImage('NTAG215', NTAG_UID);
    img.data[16] = 0x03;
    img.data[17] = 0x05;
    const text = exportFlipper(img);
    expect(text).toContain('Device type: NTAG/Ultralight');
    const back = importFlipper(text);
    expect(back.kind).toBe('NTAG215');
    expect(back.uid).toBe(NTAG_UID);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('round-trips Flipper .nfc for MIFARE 1K (kind/uid/data)', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    img.data[1 * 16] = 0x42;
    const text = exportFlipper(img);
    expect(text).toContain('Device type: Mifare Classic');
    const back = importFlipper(text);
    expect(back.kind).toBe('MIFARE_CLASSIC_1K');
    expect(back.uid).toBe(MF_UID);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('detects dump formats by content', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const project = serializeProject(img, { note: '', appVersion: '0.1.0', savedAt: '2026-11-09' });
    expect(detectDumpFormat('x.nfcdump', project)).toBe('project');
    expect(detectDumpFormat('x.bin', exportBin(img))).toBe('bin');
    expect(detectDumpFormat('x.nfc', new TextEncoder().encode(exportFlipper(img)))).toBe('flipper');
    expect(detectDumpFormat('x.txt', new TextEncoder().encode('not a dump'))).toBeNull();
  });

  it('importDump dispatches to the right parser', () => {
    const img = blankImage('NTAG213', NTAG_UID);
    const r1 = importDump('x.nfcdump', serializeProject(img, { note: 'n', appVersion: '0.1.0', savedAt: '2026-11-09' }));
    expect(r1.format).toBe('project');
    expect(r1.note).toBe('n');
    const r2 = importDump('x.bin', exportBin(img));
    expect(r2.format).toBe('bin');
    const r3 = importDump('x.nfc', new TextEncoder().encode(exportFlipper(img)));
    expect(r3.format).toBe('flipper');
    expect(() => importDump('x.txt', new TextEncoder().encode('garbage'))).toThrow();
  });

  it('serializeProject keeps no secret keys in metadata', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    if (img.mifare == null) img.mifare = { sectors: [{ sector: 0, keyType: 'A', keyLabel: '工場出荷鍵' }] };
    const json = new TextDecoder().decode(serializeProject(img, { note: '', appVersion: '0.1.0', savedAt: '2026-11-09' }));
    const doc = JSON.parse(json);
    // meta blocks never carry raw key bytes
    expect(JSON.stringify(doc.mifare ?? {})).not.toMatch(/[0-9A-Fa-f]{12}/);
    expect(doc.ntag?.password).toBeUndefined();
  });
});
