// planWrites regressions found by the 2026-11-12 UX audit (owner: renderer-hex).
// WALK-2: FeliCa S_PAD3/7/11 + MC were treated as MIFARE sector trailers.
// WRITE-15: a MIFARE trailer edited in the grid wrote key A as the read-back 00.
// WRITE-7: locked pages were planned (PaSoRi then fakes 90 00 and only verify notices).
// Each case was run against the old plan.ts first and failed there.
import { describe, expect, it } from 'vitest';
import { blankImage, planWrites } from '@shared/tag';
import { lockedUnitsOf } from '@shared/tag/plan';
import { encodeAccessBits, mifareTrailerBlock, ntagPages } from '@shared/tags';
import type { TagImage, UnitWrite } from '@shared/types';

const NTAG_UID = '04A1B2C3D4E5F6';
const MF_UID = 'A1B2C3D4';
const FELICA_IDM = '0102030405060708';
const units = (ws: UnitWrite[]) => ws.map((w) => w.unit);

function felicaEdit(unit: number): { base: TagImage; edited: Uint8Array } {
  const base = blankImage('FELICA_LITE_S', FELICA_IDM);
  const edited = new Uint8Array(base.data);
  edited[unit * 16] = 0x5a;
  return { base, edited };
}

describe('planWrites: FeliCa Lite-S is not MIFARE (WALK-2)', () => {
  for (const unit of [3, 7, 11]) {
    it(`writes S_PAD${unit} like any other user block`, () => {
      const { base, edited } = felicaEdit(unit);
      const plan = planWrites('FELICA_LITE_S', base, edited, { includeProtected: false });
      expect(units(plan.writes)).toEqual([unit]);
      expect(plan.forbiddenUnits).toEqual([]);
      expect(plan.warnings.some((w) => w.code === 'ACCESS_BITS_INVALID' || w.code === 'TRAILER')).toBe(false);
    });
  }

  it('treats an MC (unit 15) edit as a FeliCa MC change, never as a sector trailer', () => {
    const { base, edited } = felicaEdit(15);
    edited[15 * 16] = 0xff; // keep byte 0, change byte 3 instead
    edited[15 * 16 + 3] = 0x00;
    const off = planWrites('FELICA_LITE_S', base, edited, { includeProtected: false });
    expect(off.protectedUnits).toEqual([15]);
    expect(off.forbiddenUnits).toEqual([]);
    expect(off.writes).toEqual([]);

    const on = planWrites('FELICA_LITE_S', base, edited, { includeProtected: true });
    expect(units(on.writes)).toEqual([15]);
    expect(on.warnings.map((w) => w.code)).toEqual(['FELICA_MC']);
  });

  it('marks an MC edit that sets a write-protect bit as danger (irreversible)', () => {
    const base = blankImage('FELICA_LITE_S', FELICA_IDM);
    const edited = new Uint8Array(base.data);
    edited[15 * 16 + 8] = 0x01; // write-protect S_PAD0
    edited[15 * 16 + 10] = 0x01;
    const plan = planWrites('FELICA_LITE_S', base, edited, { includeProtected: true });
    expect(plan.warnings.find((w) => w.code === 'FELICA_MC')?.severity).toBe('danger');
  });
});

describe('planWrites: MIFARE trailer key A read back as 00 (WRITE-15)', () => {
  /** A trailer as a real card returns it: key A hidden (00), access bits + key B visible. */
  function realReadTrailer(): { base: TagImage; trailer: number } {
    const base = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    const trailer = mifareTrailerBlock(1); // block 7
    base.data.fill(0x00, trailer * 16, trailer * 16 + 6);
    return { base, trailer };
  }

  it('does not write a trailer whose key A is still the unknown 00..00 (would change key A to 000000000000)', () => {
    const { base, trailer } = realReadTrailer();
    const edited = new Uint8Array(base.data);
    // read-only preset for the data blocks, typed straight into the grid
    edited.set(encodeAccessBits({ c: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0, 1]], gpb: 0x69 }), trailer * 16 + 6);
    const plan = planWrites('MIFARE_CLASSIC_1K', base, edited, { includeProtected: true });
    expect(units(plan.writes)).not.toContain(trailer);
    expect(plan.forbiddenUnits).toContain(trailer);
    expect(plan.warnings.some((w) => w.unit === trailer && w.code === 'KEY_A_UNKNOWN' && w.severity === 'danger')).toBe(true);
  });

  it('still writes a trailer when the operator entered key A', () => {
    const { base, trailer } = realReadTrailer();
    const edited = new Uint8Array(base.data);
    edited.fill(0xff, trailer * 16, trailer * 16 + 6);
    const plan = planWrites('MIFARE_CLASSIC_1K', base, edited, { includeProtected: true });
    expect(units(plan.writes)).toContain(trailer);
    expect(plan.warnings.some((w) => w.unit === trailer && w.code === 'TRAILER')).toBe(true);
  });
});

describe('planWrites: locked pages are excluded (WRITE-7)', () => {
  it('NTAG213: a static lock bit (page 5) keeps page 5 out of the plan', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    base.data[2 * 4 + 2] = 0x20; // LOCK0 bit 5 -> page 5 locked
    const edited = new Uint8Array(base.data);
    edited[5 * 4] = 0x41;
    edited[6 * 4] = 0x42;
    const plan = planWrites('NTAG213', base, edited, { includeProtected: false });
    expect(units(plan.writes)).toEqual([6]);
    expect(plan.forbiddenUnits).toEqual([5]);
    expect(plan.warnings.some((w) => w.unit === 5 && w.code === 'LOCKED')).toBe(true);
  });

  it('NTAG213: a dynamic lock bit locks two pages (16-17)', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    base.data[ntagPages('NTAG213').dynLock * 4] = 0x01;
    expect(lockedUnitsOf('NTAG213', base)).toEqual([16, 17]);
    const edited = new Uint8Array(base.data);
    edited[16 * 4] = 1;
    edited[17 * 4] = 1;
    edited[18 * 4] = 1;
    expect(units(planWrites('NTAG213', base, edited, { includeProtected: false }).writes)).toEqual([18]);
  });

  it('FeliCa: a write-protected block (MC mask) is excluded', () => {
    const base = blankImage('FELICA_LITE_S', FELICA_IDM);
    base.data[15 * 16 + 8] = 0x04; // S_PAD2 read-only
    base.data[15 * 16 + 10] = 0x04;
    expect(lockedUnitsOf('FELICA_LITE_S', base)).toEqual([2]);
    const edited = new Uint8Array(base.data);
    edited[2 * 16] = 9;
    edited[1 * 16] = 9;
    const plan = planWrites('FELICA_LITE_S', base, edited, { includeProtected: false });
    expect(units(plan.writes)).toEqual([1]);
    expect(plan.warnings.some((w) => w.unit === 2 && w.code === 'LOCKED')).toBe(true);
  });

  it('MIFARE: data blocks whose access bits say "never write" are excluded', () => {
    const base = blankImage('MIFARE_CLASSIC_1K', MF_UID);
    const trailer = mifareTrailerBlock(1); // sector 1 = blocks 4..7
    base.data.set(encodeAccessBits({ c: [[0, 1, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]], gpb: 0x69 }), trailer * 16 + 6);
    expect(lockedUnitsOf('MIFARE_CLASSIC_1K', base)).toEqual([4]);
    const edited = new Uint8Array(base.data);
    edited[4 * 16] = 1;
    edited[5 * 16] = 1;
    expect(units(planWrites('MIFARE_CLASSIC_1K', base, edited, { includeProtected: false }).writes)).toEqual([5]);
  });

  it('honours extra opts.lockedUnits', () => {
    const base = blankImage('NTAG215', NTAG_UID);
    const edited = new Uint8Array(base.data);
    edited[8 * 4] = 1;
    edited[9 * 4] = 1;
    const plan = planWrites('NTAG215', base, edited, { includeProtected: false, lockedUnits: [9] });
    expect(units(plan.writes)).toEqual([8]);
  });

  it('a factory image has no locked units', () => {
    for (const [kind, uid] of [
      ['NTAG213', NTAG_UID],
      ['NTAG216', NTAG_UID],
      ['MIFARE_CLASSIC_4K', MF_UID],
      ['FELICA_LITE_S', FELICA_IDM],
    ] as const) {
      expect(lockedUnitsOf(kind, blankImage(kind, uid))).toEqual([]);
    }
  });
});

describe('planWrites: lock bytes go after the data they lock', () => {
  it('writes the data page before the static lock page that would lock it', () => {
    const base = blankImage('NTAG213', NTAG_UID);
    const edited = new Uint8Array(base.data);
    edited[5 * 4] = 0x41; // data on page 5
    edited[2 * 4 + 2] = 0x20; // and lock page 5 in the same write
    const plan = planWrites('NTAG213', base, edited, { includeProtected: true });
    expect(units(plan.writes)).toEqual([5, 2]);
  });
});
