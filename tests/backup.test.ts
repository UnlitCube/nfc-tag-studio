// Unit tests for the renderer-backup pure logic (duplicate planning + key form
// validation). Owner: agent renderer-backup. Pure logic only - no DOM, no React,
// no reader hardware. Run with: npx vitest run tests/backup
import { describe, expect, it } from 'vitest';
import { factoryImage, isProtectedUnit, mifareIsTrailer, specFor } from '@shared/tags';
import { bytesToHex } from '@shared/hex';
import type { TagKind } from '@shared/tags';
import type { TagImage, UnitStatus } from '@shared/types';
import { changedAgainstTarget, planDataCopy } from '../src/renderer/src/views/backup/duplicate';
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
