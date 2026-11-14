// Full reset planner (src/renderer/src/views/factory/model.ts, 2026-11-14): what
// "put the tag back to the factory state" writes, in which order, and what it must
// never write (UID / block 0, lock bits, CFGLCK'd config, units locked or not read,
// FeliCa write protection) - reported instead as "cannot be restored".
import { describe, expect, it } from 'vitest';
import { blankImage } from '../src/shared/tag/image';
import { encodeDrafts } from '../src/shared/ndef';
import { ntagPages, specFor } from '../src/shared/tags';
import type { TagKind } from '../src/shared/tags';
import type { TagImage, UnitWrite } from '../src/shared/types';
import { planFactoryReset } from '../src/renderer/src/views/factory/model';
import { planNdefWrite } from '../src/renderer/src/views/ndef/ndefPages';

const UID: Partial<Record<TagKind, string>> = {
  NTAG213: '04A1B2C3D4E5F6',
  NTAG215: '04A1B2C3D4E5F7',
  MIFARE_CLASSIC_1K: '0A1B2C3D',
  FELICA_LITE_S: '0102030405060708',
};

function blank(kind: TagKind): TagImage {
  const img = blankImage(kind, UID[kind]!);
  // A real read returns 00 for PWD / PACK (NTAG) and key A (MIFARE): mimic that.
  if (kind.startsWith('NTAG')) {
    const p = ntagPages(kind);
    img.data.fill(0, p.pwd * 4, p.pwd * 4 + 4);
  }
  if (kind.startsWith('MIFARE')) for (let b = 3; b < 64; b += 4) img.data.fill(0, b * 16, b * 16 + 6);
  return img;
}

function apply(img: TagImage, writes: UnitWrite[]): Uint8Array {
  const size = specFor(img.kind).unitSize;
  const data = new Uint8Array(img.data);
  for (const w of writes) data.set(w.data, w.unit * size);
  return data;
}

const units = (ws: UnitWrite[]) => ws.map((w) => w.unit);

describe('NTAG21x', () => {
  const p = ntagPages('NTAG213');

  it('a factory tag: only PWD and PACK are written (they cannot be read back), nothing else changes', () => {
    const plan = planFactoryReset(blank('NTAG213'));
    expect(plan.block).toBeNull();
    expect(units(plan.writes)).toEqual([p.pwd, p.pack]);
    expect(plan.alreadyFactory).toBe(true);
    expect(plan.issues).toEqual([]);
  });

  it('a used tag goes back to the factory image, in the safe order (user pages, PWD, PACK, CFG1, CFG0)', () => {
    const tag = blank('NTAG213');
    const ndef = planNdefWrite(tag, encodeDrafts([{ kind: 'uri', uri: 'https://example.com/factory' }]));
    if (!ndef.ok) throw new Error('ndef');
    for (const w of ndef.writes) tag.data.set(w.data, w.unit * 4);
    tag.data[p.cfg1 * 4] |= 0x10; // NFC counter on
    tag.data[p.cfg0 * 4] = 0x44; // UID mirror on
    const plan = planFactoryReset(tag);
    expect(plan.block).toBeNull();
    const u = units(plan.writes);
    expect(u.slice(-4)).toEqual([p.pwd, p.pack, p.cfg1, p.cfg0]);
    for (const x of u.slice(0, -4)) expect(x).toBeGreaterThanOrEqual(4);
    expect(u).not.toContain(0);
    expect(u).not.toContain(1);
    expect(u).not.toContain(2);
    expect(u).not.toContain(p.dynLock);
    expect(apply(tag, plan.writes)).toEqual(blankImage('NTAG213', UID.NTAG213!).data);
    expect(plan.issues).toEqual([{ code: 'counter' }]);
    expect(plan.reactivate).toBe(true);
    expect(plan.alreadyFactory).toBe(false);
  });

  it('the NTAG213 Lock Control TLV of the factory content is written back when an NDEF write replaced it', () => {
    const tag = blank('NTAG213');
    tag.data.set([0x03, 0x00, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00], 16);
    const after = apply(tag, planFactoryReset(tag).writes);
    expect([...after.slice(16, 24)]).toEqual([0x01, 0x03, 0xa0, 0x0c, 0x34, 0x03, 0x00, 0xfe]);
  });

  it('password protection on: refused as a whole (the config cannot be written without PWD_AUTH)', () => {
    const tag = blank('NTAG213');
    tag.data[p.cfg0 * 4 + 3] = 0x10; // AUTH0 = page 16
    const plan = planFactoryReset(tag);
    expect(plan.block).toBe('password');
    expect(plan.writes).toEqual([]);
  });

  it('CFGLCK: the configuration is left alone and reported; PWD / PACK are still written', () => {
    const tag = blank('NTAG213');
    tag.data[p.cfg1 * 4] |= 0x40;
    tag.data[20] = 0x55;
    const plan = planFactoryReset(tag);
    expect(units(plan.writes)).not.toContain(p.cfg0);
    expect(units(plan.writes)).not.toContain(p.cfg1);
    expect(units(plan.writes)).toEqual(expect.arrayContaining([5, p.pwd, p.pack]));
    expect(plan.issues).toContainEqual({ code: 'cfg-lock' });
  });

  it('lock bits are never written; a locked page that differs is reported, not written', () => {
    const tag = blank('NTAG213');
    tag.data[2 * 4 + 2] |= 0x20; // static lock: page 5
    tag.data.set([0x11, 0x22, 0x33, 0x44], 5 * 4);
    const plan = planFactoryReset(tag);
    expect(units(plan.writes)).not.toContain(2);
    expect(units(plan.writes)).not.toContain(5);
    expect(plan.issues).toContainEqual({ code: 'lock-bits' });
    expect(plan.issues).toContainEqual({ code: 'locked-units', units: [5] });
  });

  it('CC: an unformatted CC goes back (only sets bits); a CC with extra bits cannot', () => {
    const blankCc = blank('NTAG215');
    blankCc.data.fill(0, 12, 16);
    const a = planFactoryReset(blankCc);
    expect(units(a.writes)).toContain(3);
    expect(a.areas.find((x) => x.area === 'cc')?.units).toEqual([3]);
    const readOnly = blank('NTAG215');
    readOnly.data[15] = 0x0f; // CC write access 0x0F (read-only)
    const b = planFactoryReset(readOnly);
    expect(units(b.writes)).not.toContain(3);
    expect(b.issues).toContainEqual({ code: 'cc-otp' });
  });

  it('an interrupted read is refused', () => {
    const tag = blank('NTAG215');
    tag.unitStatus[30] = 'error';
    expect(planFactoryReset(tag).block).toBe('interrupted');
  });
});

describe('MIFARE Classic', () => {
  it('data blocks 00 and every read sector trailer to the transport keys; block 0 and unread sectors untouched', () => {
    const tag = blank('MIFARE_CLASSIC_1K');
    tag.data.set(new Uint8Array(16).fill(0x5a), 4 * 16);
    tag.data.set([0x7f, 0x07, 0x88, 0x40], 7 * 16 + 6); // sector 1: other (valid) access bits
    for (const b of [12, 13, 14, 15]) tag.unitStatus[b] = 'denied'; // sector 3: no key
    const plan = planFactoryReset(tag);
    expect(plan.block).toBeNull();
    const u = units(plan.writes);
    expect(u).not.toContain(0);
    expect(u).toContain(4);
    for (const b of [12, 13, 14, 15]) expect(u).not.toContain(b);
    const trailers = plan.areas.find((a) => a.area === 'trailers')!.units;
    expect(trailers).toHaveLength(15); // 16 sectors minus the unread one
    const after = apply(tag, plan.writes);
    expect([...after.slice(7 * 16, 8 * 16)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x07, 0x80, 0x69, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(after.slice(4 * 16, 5 * 16).every((x) => x === 0)).toBe(true);
    expect(plan.issues).toContainEqual({ code: 'unread', units: [12, 13, 14, 15] });
    // A factory card: only the trailers (key A cannot be read back) are written.
    expect(planFactoryReset(blank('MIFARE_CLASSIC_1K')).alreadyFactory).toBe(true);
  });
});

describe('FeliCa Lite-S', () => {
  it('S_PAD / REG to 00 and MC to the factory value, keeping the protection masks; write-protected blocks reported', () => {
    const tag = blank('FELICA_LITE_S');
    for (let u = 0; u < 15; u++) tag.data[u * 16] = 0x42;
    tag.data[15 * 16 + 3] = 0x00; // MC[3] changed
    tag.data[15 * 16 + 8] = 0x20; // write-protect block 5 (MC[8:10])
    tag.data[15 * 16 + 10] = 0x20; // (duplicate MC[10:12])
    const plan = planFactoryReset(tag);
    const u = units(plan.writes);
    expect(u).toContain(0);
    expect(u).toContain(14); // REG
    expect(u).toContain(15); // MC
    expect(u).not.toContain(5);
    const after = apply(tag, plan.writes);
    expect([...after.slice(15 * 16, 15 * 16 + 5)]).toEqual([0xff, 0xff, 0xff, 0x01, 0x07]);
    expect(after[15 * 16 + 8]).toBe(0x20); // the mask is kept (cannot be undone)
    expect(plan.issues).toContainEqual({ code: 'felica-write-protect', blocks: [5] });
  });

  it('system blocks read-only (MC[2] = 00): MC is not written and that is reported', () => {
    const tag = blank('FELICA_LITE_S');
    tag.data[15 * 16 + 2] = 0x00;
    tag.data[16] = 0x01;
    const plan = planFactoryReset(tag);
    expect(units(plan.writes)).not.toContain(15);
    expect(plan.issues).toContainEqual({ code: 'felica-system-ro' });
  });
});
