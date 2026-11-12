// NDEF view: reading the NDEF of an image and planning a write against the tag
// being written. Owner: renderer-ndef (2026-11-12 UX rework: WRITE-12 / FLOW-4 /
// FLOW-5 / FLOW-9 / FIRST-14 / WALK-5). Pure logic only - no React, no reader.
import { describe, expect, it } from 'vitest';
import { encodeDrafts, wrapNdefTlv } from '@shared/ndef';
import type { NdefRecordDraft } from '@shared/ndef';
import { factoryImage, isProtectedUnit, mifareIsTrailer, ntagPages, specFor } from '@shared/tags';
import type { TagKind } from '@shared/tags';
import { bytesToHex as uidHex } from '@shared/hex';
import type { TagImage, UnitStatus, UnitWrite } from '@shared/types';
import { mifareNdefBlocks, planNdefWrite, readImageNdef, supportsNdef } from '../../src/renderer/src/views/ndef/ndefPages';

const NTAG_UID = [0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
const MF_UID = [0xa1, 0xb2, 0xc3, 0xd4];

function image(kind: TagKind, uidBytes = kind.startsWith('NTAG') ? NTAG_UID : MF_UID): TagImage {
  const uid = Uint8Array.from(uidBytes);
  return {
    kind,
    uid: uidHex(uid),
    data: factoryImage(kind, uid),
    unitStatus: Array<UnitStatus>(specFor(kind).unitCount).fill('ok'),
    readAt: 0,
  };
}

/** NTAG image whose user area starts with `bytes` (rest zero). */
function ntagWith(kind: TagKind, bytes: Uint8Array): TagImage {
  const img = image(kind);
  const spec = specFor(kind);
  img.data.fill(0, spec.userStartUnit * 4, spec.userStartUnit * 4 + spec.userBytes);
  img.data.set(bytes, spec.userStartUnit * 4);
  return img;
}

/** MIFARE image with `ndefSectors` marked NDEF (03 E1) in MAD1. */
function mifareWithMad(ndefSectors: number[]): TagImage {
  const img = image('MIFARE_CLASSIC_1K');
  img.data[17] = 0x01;
  for (const s of ndefSectors) img.data.set([0x03, 0xe1], 16 + 2 * s);
  return img;
}

function apply(img: TagImage, writes: UnitWrite[]): TagImage {
  const size = specFor(img.kind).unitSize;
  const data = new Uint8Array(img.data);
  for (const w of writes) data.set(w.data, w.unit * size);
  return { ...img, data, unitStatus: img.unitStatus.slice() };
}

const URL_A: NdefRecordDraft = { kind: 'uri', uri: 'https://example.com/a' };
const URL_B: NdefRecordDraft = { kind: 'uri', uri: 'https://example.com/flow-probe' };
const TEXT: NdefRecordDraft = { kind: 'text', text: 'hello', lang: 'ja', encoding: 'utf8' };

describe('readImageNdef (what the open document / a tag carries)', () => {
  it('returns the records of an NTAG that holds two URLs (they are not dropped on opening the NDEF editor)', () => {
    const img = ntagWith('NTAG213', wrapNdefTlv(encodeDrafts([URL_A, URL_B])));
    const r = readImageNdef(img);
    expect(r.state).toBe('records');
    if (r.state === 'records') expect(r.drafts).toEqual([URL_A, URL_B]);
  });

  it('reports a factory NTAG (03 00 FE) and an empty-record message (D0 00 00) as empty, not as records', () => {
    expect(readImageNdef(image('NTAG215')).state).toBe('empty');
    expect(readImageNdef(ntagWith('NTAG213', wrapNdefTlv(encodeDrafts([])))).state).toBe('empty');
  });

  it('reports an all-zero user area as no NDEF', () => {
    expect(readImageNdef(ntagWith('NTAG213', new Uint8Array(0))).state).toBe('none');
  });

  it('does not claim "no NDEF" when the NDEF pages could not be read (password)', () => {
    const img = ntagWith('NTAG213', wrapNdefTlv(encodeDrafts([URL_A])));
    img.unitStatus[4] = 'denied';
    img.data.fill(0, 16, 20);
    expect(readImageNdef(img).state).toBe('unreadable');
  });

  it('reports bytes that are not an NDEF message as invalid', () => {
    const img = ntagWith('NTAG213', Uint8Array.from([0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0xfe]));
    expect(readImageNdef(img).state).toBe('invalid');
  });

  it('MIFARE: follows the MAD; no NDEF sector = none; unreadable MAD / NDEF sector = unreadable', () => {
    const img = mifareWithMad([1]);
    img.data.set(wrapNdefTlv(encodeDrafts([TEXT])), 4 * 16);
    const r = readImageNdef(img);
    expect(r.state).toBe('records');
    if (r.state === 'records') expect(r.drafts).toEqual([TEXT]);

    expect(readImageNdef(image('MIFARE_CLASSIC_1K')).state).toBe('none');

    const madDenied = mifareWithMad([1]);
    madDenied.unitStatus[1] = 'denied';
    expect(readImageNdef(madDenied).state).toBe('unreadable');

    const sectorDenied = mifareWithMad([1]);
    sectorDenied.unitStatus[5] = 'denied';
    expect(readImageNdef(sectorDenied).state).toBe('unreadable');
  });

  it('FeliCa Lite-S is not handled by the NDEF editor', () => {
    const felica: TagImage = {
      kind: 'FELICA_LITE_S',
      uid: '0123456789ABCDEF',
      data: factoryImage('FELICA_LITE_S', new Uint8Array(8)),
      unitStatus: Array<UnitStatus>(specFor('FELICA_LITE_S').unitCount).fill('ok'),
      readAt: 0,
    };
    expect(supportsNdef('FELICA_LITE_S')).toBe(false);
    expect(readImageNdef(felica).state).toBe('unsupported');
    expect(planNdefWrite(felica, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'unsupported-kind' });
  });
});

describe('planNdefWrite: planned from the tag being written', () => {
  it('replaces the records the tag holds now and reports them as "existing"', () => {
    const target = ntagWith('NTAG213', wrapNdefTlv(encodeDrafts([URL_A, URL_B])));
    const plan = planNdefWrite(target, encodeDrafts([TEXT]));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.existing).toEqual({ state: 'records', drafts: [URL_A, URL_B] });
    const after = readImageNdef(apply(target, plan.writes));
    expect(after).toEqual({ state: 'records', drafts: [TEXT] });
  });

  it('clears the old NDEF bytes behind the new terminator (no "xample.com/flow-probe" left on the tag)', () => {
    // FLOW-4: before, writing an empty message wrote only the 2 pages of the new
    // TLV and the old URL bytes stayed on the tag after the terminator.
    const target = ntagWith('NTAG213', wrapNdefTlv(encodeDrafts([URL_B])));
    const plan = planNdefWrite(target, encodeDrafts([]));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const after = apply(target, plan.writes);
    const spec = specFor('NTAG213');
    const area = after.data.slice(spec.userStartUnit * 4, spec.userStartUnit * 4 + 144);
    expect(Array.from(area.slice(0, 6))).toEqual([0x03, 0x03, 0xd0, 0x00, 0x00, 0xfe]);
    expect(area.slice(6).every((b) => b === 0)).toBe(true);
    expect(readImageNdef(after).state).toBe('empty');
  });

  it('writes only the pages that change, and nothing when the tag already holds the same NDEF', () => {
    const target = ntagWith('NTAG215', wrapNdefTlv(encodeDrafts([URL_A, TEXT])));
    const same = planNdefWrite(target, encodeDrafts([URL_A, TEXT]));
    expect(same).toMatchObject({ ok: true, writes: [] });

    const changed = planNdefWrite(target, encodeDrafts([URL_A, { ...TEXT, text: 'hellp' }]));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.writes.length).toBe(1);
    expect(readImageNdef(apply(target, changed.writes))).toEqual({ state: 'records', drafts: [URL_A, { ...TEXT, text: 'hellp' }] });
  });

  it('never plans a UID / CC / lock / config page (I1/I2/I5)', () => {
    for (const kind of ['NTAG213', 'NTAG215', 'NTAG216'] as const) {
      const target = ntagWith(kind, new Uint8Array(0));
      target.data.fill(0xaa, 16, 16 + 64); // garbage in the user area to force many writes
      const plan = planNdefWrite(target, encodeDrafts([URL_A]));
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      expect(plan.writes.length).toBeGreaterThan(0);
      for (const w of plan.writes) {
        expect(isProtectedUnit(kind, w.unit)).toBe(false);
        expect(w.unit).toBeLessThanOrEqual(ntagPages(kind).userLast);
        expect(w.data.length).toBe(4);
      }
    }
  });

  it('follows the capacity of the tag being written (its CC), not the composer pick', () => {
    const big = encodeDrafts([{ kind: 'text', text: 'x'.repeat(200), lang: 'en', encoding: 'utf8' }]);
    expect(planNdefWrite(image('NTAG213'), big)).toMatchObject({ ok: false, reason: 'too-large', capacity: 141 });
    expect(planNdefWrite(image('NTAG215'), big).ok).toBe(true);
  });

  it('refuses when the new NDEF would land on pages this tag could not read; skips unreadable pages behind it', () => {
    const t1 = image('NTAG213');
    t1.unitStatus[4] = 'denied';
    expect(planNdefWrite(t1, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'unreadable' });

    const t2 = image('NTAG213');
    t2.unitStatus[30] = 'denied';
    const plan = planNdefWrite(t2, encodeDrafts([URL_A]));
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.writes.some((w) => w.unit === 30)).toBe(false);
  });

  it('refuses a password-protected (AUTH0) or locked page up front instead of failing half-way', () => {
    const pw = image('NTAG213');
    pw.data[ntagPages('NTAG213').cfg0 * 4 + 3] = 5; // AUTH0 = page 5
    expect(planNdefWrite(pw, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'password' });

    const locked = image('NTAG213');
    locked.data[2 * 4 + 2] = 0x10; // static lock: page 4
    expect(planNdefWrite(locked, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('NTAG without an NDEF capability container is not formatted', () => {
    const t = image('NTAG213');
    t.data.set([0, 0, 0, 0], 12);
    expect(planNdefWrite(t, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'not-formatted' });
  });
});

describe('planNdefWrite: MIFARE follows the MAD of the tag being written (FLOW-5)', () => {
  it('refuses a tag without an NDEF sector even when the open document (a file) has one', () => {
    // The document opened from a file is NDEF-formatted (sector 1) ...
    const fileDoc = mifareWithMad([1]);
    expect(mifareNdefBlocks('MIFARE_CLASSIC_1K', fileDoc.data)).toEqual([4, 5, 6]);
    // ... but the tag on the reader is not: nothing may be written to its sector 1.
    const target = image('MIFARE_CLASSIC_1K', [0x04, 0x9a, 0xfb, 0x5c]);
    target.data.fill(0x5a, 4 * 16, 7 * 16); // business data in sector 1
    expect(planNdefWrite(target, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'not-formatted' });
  });

  it('writes into the NDEF sector the target MAD names (sector 2 -> blocks 8..), never block 0 / MAD / trailers', () => {
    const target = mifareWithMad([2]);
    target.data.fill(0x77, 4 * 16, 7 * 16); // sector 1 is NOT NDEF: must stay untouched
    const plan = planNdefWrite(target, encodeDrafts([URL_A]));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.writes.length).toBeGreaterThan(0);
    for (const w of plan.writes) {
      expect([8, 9, 10]).toContain(w.unit);
      expect(mifareIsTrailer(w.unit)).toBe(false);
      expect(w.data.length).toBe(16);
    }
    const after = apply(target, plan.writes);
    expect(readImageNdef(after)).toEqual({ state: 'records', drafts: [URL_A] });
    expect(after.data.slice(4 * 16, 7 * 16).every((b) => b === 0x77)).toBe(true);
  });

  it('refuses when the target MAD or its NDEF sector cannot be read (no key)', () => {
    const noMad = mifareWithMad([1]);
    noMad.unitStatus[1] = 'denied';
    expect(planNdefWrite(noMad, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'unreadable' });

    const noKey = mifareWithMad([1]);
    noKey.unitStatus[4] = 'denied';
    expect(planNdefWrite(noKey, encodeDrafts([URL_A]))).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});
