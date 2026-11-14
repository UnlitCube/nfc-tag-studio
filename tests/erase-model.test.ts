// Erase screen planner (src/renderer/src/views/erase/model.ts, 2026-11-13).
// What erasing writes - and never writes: the UID / manufacturer block, lock bits,
// configuration, passwords, MIFARE sector trailers, FeliCa REG / MC (I1 / I5) -
// and that units locked on the tag are left out instead of "erased" in vain.
import { describe, expect, it } from 'vitest';
import { blankImage } from '../src/shared/tag/image';
import { encodeDrafts } from '../src/shared/ndef';
import { isForbiddenUnit, isProtectedUnit, specFor } from '../src/shared/tags';
import type { TagKind } from '../src/shared/tags';
import type { TagImage, UnitWrite } from '../src/shared/types';
import { eraseModes, planErase, readInterrupted, unreadUnits } from '../src/renderer/src/views/erase/model';
import { planNdefWrite, readImageNdef } from '../src/renderer/src/views/ndef/ndefPages';
import { initializeImage } from '../src/renderer/src/views/hex/model';

const UID: Record<TagKind, string> = {
  NTAG213: '04A1B2C3D4E5F6',
  NTAG215: '04A1B2C3D4E5F7',
  NTAG216: '04A1B2C3D4E5F8',
  MIFARE_CLASSIC_1K: '0A1B2C3D',
  MIFARE_CLASSIC_4K: '0A1B2C3E',
  FELICA_LITE_S: '0102030405060708',
};

function apply(img: TagImage, writes: UnitWrite[]): TagImage {
  const size = specFor(img.kind).unitSize;
  const data = new Uint8Array(img.data);
  for (const w of writes) data.set(w.data, w.unit * size);
  return { ...img, data, unitStatus: [...img.unitStatus] };
}

/** A blank tag with a URL record written the way the NDEF editor writes it. */
function withUrl(kind: TagKind): TagImage {
  const blank = blankImage(kind, UID[kind]);
  const p = planNdefWrite(blank, encodeDrafts([{ kind: 'uri', uri: 'https://example.com/erase-test' }]));
  if (!p.ok) throw new Error(`cannot plan NDEF on ${kind}: ${p.reason}`);
  return apply(blank, p.writes);
}

describe('eraseModes', () => {
  it('NTAG and MIFARE offer "empty the NDEF" and "the whole data area"; FeliCa Lite-S only the latter', () => {
    expect(eraseModes('NTAG215')).toEqual(['ndef', 'all']);
    expect(eraseModes('MIFARE_CLASSIC_1K')).toEqual(['ndef', 'all']);
    expect(eraseModes('FELICA_LITE_S')).toEqual(['all']);
  });
});

describe('planErase on NTAG', () => {
  it('a blank tag is already erased in both ranges (nothing to write)', () => {
    const blank = blankImage('NTAG215', UID.NTAG215);
    expect(readImageNdef(blank).state).toBe('empty');
    for (const m of ['ndef', 'all'] as const) {
      const p = planErase(blank, m);
      expect(p.ok && p.writes.length, m).toBe(0);
    }
  });

  it('"empty the NDEF" leaves an empty NDEF and writes only user pages', () => {
    const tag = withUrl('NTAG215');
    expect(readImageNdef(tag).state).toBe('records');
    const p = planErase(tag, 'ndef');
    if (!p.ok) throw new Error('plan failed');
    expect(p.writes.length).toBeGreaterThan(0);
    for (const w of p.writes) expect(w.unit).toBeGreaterThanOrEqual(specFor('NTAG215').userStartUnit);
    const after = apply(tag, p.writes);
    expect(['empty', 'none']).toContain(readImageNdef(after).state);
    expect(after.data.subarray(0, 16)).toEqual(tag.data.subarray(0, 16)); // UID / lock / CC untouched
  });

  it('"the whole data area" returns the user memory to the factory content and touches nothing else', () => {
    const tag = withUrl('NTAG213');
    // some data far into the user area as well
    tag.data.set([0xde, 0xad, 0xbe, 0xef], 30 * 4);
    const p = planErase(tag, 'all');
    if (!p.ok) throw new Error('plan failed');
    for (const w of p.writes) {
      expect(isForbiddenUnit('NTAG213', w.unit), `page ${w.unit}`).toBe(false);
      expect(isProtectedUnit('NTAG213', w.unit), `page ${w.unit}`).toBe(false);
    }
    const after = apply(tag, p.writes);
    expect(after.data).toEqual(initializeImage('NTAG213', tag.data, 'zero'));
    // The NDEF write replaced the factory Lock Control TLV at page 4 (the NDEF writer starts there),
    // so the erase leaves an empty NDEF at page 4 and 00 after it.
    const us = specFor('NTAG213').userStartUnit * 4;
    expect([...after.data.slice(us, us + 4)]).toEqual([0x03, 0x00, 0xfe, 0x00]);
    expect(after.data.slice(us + 4, us + specFor('NTAG213').userBytes).every((x) => x === 0)).toBe(true);
  });

  it('keeps the Lock Control TLV a real NTAG213 ships with (01 03 A0 0C 34) and empties the NDEF after it', () => {
    // Factory content of the NTAG213 on the Sony PaSoRi (2026-11-14): pages 4-5 = 01 03 A0 0C | 34 03 00 FE.
    const factory = blankImage('NTAG213', UID.NTAG213);
    factory.data.fill(0, 16, 16 + specFor('NTAG213').userBytes);
    factory.data.set([0x01, 0x03, 0xa0, 0x0c, 0x34, 0x03, 0x00, 0xfe], 16);
    // A URL written after the TLV, plus data further in.
    const used = { ...factory, data: new Uint8Array(factory.data) };
    used.data.set([0x34, 0x03, 0x0a, 0xd1, 0x01, 0x06, 0x55, 0x04, 0x61, 0x2e, 0x6a, 0x70, 0xfe], 20);
    used.data.set([0xde, 0xad, 0xbe, 0xef], 25 * 4);
    const p = planErase(used, 'all');
    if (!p.ok) throw new Error('plan failed');
    expect(p.writes.map((w) => w.unit)).not.toContain(4); // 01 03 A0 0C: unchanged, not rewritten
    expect(apply(used, p.writes).data).toEqual(factory.data);
    // Already factory: nothing to write.
    const again = planErase(factory, 'all');
    expect(again.ok && again.writes.length).toBe(0);
  });

  it('a page locked on the tag is left out and reported, not "erased" in vain', () => {
    const tag = withUrl('NTAG213');
    tag.data.set([0x11, 0x22, 0x33, 0x44], 5 * 4);
    tag.data[2 * 4 + 2] |= 0x20; // static lock byte 0, bit 5: page 5 is read-only
    const p = planErase(tag, 'all');
    if (!p.ok) throw new Error('plan failed');
    expect(p.writes.map((w) => w.unit)).not.toContain(5);
    expect(p.excluded.locked).toContain(5);
  });
});

/** A factory MIFARE Classic 1K (not NDEF-formatted) with data in sectors 1-3. */
function mifareWithData(): TagImage {
  const tag = blankImage('MIFARE_CLASSIC_1K', UID.MIFARE_CLASSIC_1K);
  for (const b of [4, 5, 13, 14]) tag.data.set(new Uint8Array(16).fill(0x33), b * 16);
  return tag;
}

describe('planErase on MIFARE Classic', () => {
  it('"empty the NDEF" is refused on a tag that is not NDEF-formatted (the screen shows why)', () => {
    const p = planErase(mifareWithData(), 'ndef');
    expect(p.ok).toBe(false);
  });

  it('"the whole data area" never writes block 0 or a sector trailer', () => {
    const tag = mifareWithData();
    tag.data.set(new Uint8Array(16).fill(0x5a), 9 * 16); // data in sector 2
    const p = planErase(tag, 'all');
    if (!p.ok) throw new Error('plan failed');
    expect(p.writes.length).toBeGreaterThan(0);
    for (const w of p.writes) {
      expect(w.unit, 'block 0').not.toBe(0);
      expect(w.unit % 4, `block ${w.unit} is a trailer`).not.toBe(3);
      expect([...w.data].every((b) => b === 0)).toBe(true);
    }
    expect(p.writes.map((w) => w.unit)).toContain(9);
  });

  it('blocks that were not read (no key) are not written', () => {
    const tag = mifareWithData();
    // Sector 3 without its key. Real reads zero-fill such blocks; the fixture keeps data in block 13
    // so the planner cannot pass by relying on that.
    for (const b of [12, 13, 14, 15]) tag.unitStatus[b] = 'denied';
    expect(unreadUnits(tag)).toEqual([12, 13, 14, 15]);
    const p = planErase(tag, 'all');
    if (!p.ok) throw new Error('plan failed');
    for (const w of p.writes) expect([12, 13, 14, 15]).not.toContain(w.unit);
  });
});

describe('planErase on FeliCa Lite-S', () => {
  it('erases S_PAD0..13 only (never REG / MC)', () => {
    const tag = blankImage('FELICA_LITE_S', UID.FELICA_LITE_S);
    for (let u = 0; u < 16; u++) tag.data[u * 16] = 0x42;
    const p = planErase(tag, 'all');
    if (!p.ok) throw new Error('plan failed');
    const units = p.writes.map((w) => w.unit);
    expect(Math.max(...units)).toBeLessThanOrEqual(13);
    expect(units).toEqual(expect.arrayContaining([0, 13]));
  });
});

describe('read state', () => {
  it('an interrupted read is recognised (erasing from it is refused by the screen)', () => {
    const tag = blankImage('NTAG215', UID.NTAG215);
    expect(readInterrupted(tag)).toBe(false);
    tag.unitStatus[40] = 'error';
    expect(readInterrupted(tag)).toBe(true);
  });
});
