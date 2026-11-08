// Unit tests for the NDEF view's pure write-planning helpers.
// Owner: agent "renderer-ndef". Scoped so it never imports the React views or the
// (possibly still-stubbed) @shared/ndef codec - only pure logic in views/ndef.
import { describe, it, expect } from 'vitest';
import { bytesToHex, resolveWriteKind, userAreaToPages } from '../../src/renderer/src/views/ndef/ndefPages';

describe('bytesToHex', () => {
  it('formats an empty array as the empty string', () => {
    expect(bytesToHex(new Uint8Array())).toBe('');
  });

  it('pads each byte to two uppercase hex digits', () => {
    expect(bytesToHex(Uint8Array.from([0x03, 0x00, 0x0a, 0xff]))).toBe('03 00 0A FF');
  });

  it('renders the empty-NDEF TLV frame D0 00 00 wrapped as 03 03 D0 00 00 FE', () => {
    expect(bytesToHex(Uint8Array.from([0x03, 0x03, 0xd0, 0x00, 0x00, 0xfe]))).toBe('03 03 D0 00 00 FE');
  });
});

describe('userAreaToPages', () => {
  // A plausible NTAG213 user area (144 bytes): an NDEF TLV holding a short URI
  // record, followed by the terminator, the rest zero (as buildType2UserArea
  // produces). TLV = 03 09 | D1 01 05 55 04 61 2E 63 6F | FE  (12 bytes).
  const frame = [0x03, 0x09, 0xd1, 0x01, 0x05, 0x55, 0x04, 0x61, 0x2e, 0x63, 0x6f, 0xfe];
  const area = new Uint8Array(144);
  area.set(frame, 0);
  const tlvLen = frame.length; // 12

  it('writes only the pages that cover the TLV + terminator, starting at the first user page', () => {
    const writes = userAreaToPages(area, 4, tlvLen);
    expect(writes.map((w) => w.unit)).toEqual([4, 5, 6]);
  });

  it('never targets the UID/CC pages (first unit is the user start page, not < 4)', () => {
    const writes = userAreaToPages(area, 4, tlvLen);
    expect(Math.min(...writes.map((w) => w.unit))).toBe(4);
  });

  it('each page is exactly 4 bytes and reconstructs the covered area bytes', () => {
    const writes = userAreaToPages(area, 4, tlvLen);
    for (const w of writes) expect(w.data.length).toBe(4);
    const joined = new Uint8Array(writes.flatMap((w) => Array.from(w.data)));
    expect(Array.from(joined)).toEqual(Array.from(area.slice(0, writes.length * 4)));
    // the 12-byte frame is fully contained in the 3 written pages
    expect(Array.from(joined.slice(0, tlvLen))).toEqual(frame);
  });

  it('rounds a partial final page up and pads it from the (zero-filled) area', () => {
    // 6 bytes -> 2 pages (8 bytes); bytes 6..7 come from area and are zero here.
    const writes = userAreaToPages(area, 4, 6);
    expect(writes.map((w) => w.unit)).toEqual([4, 5]);
    expect(Array.from(writes[1].data)).toEqual([area[4], area[5], area[6], area[7]]);
  });

  it('maps startUnit through to the emitted unit indices (e.g. a different user start)', () => {
    const writes = userAreaToPages(area, 8, 8);
    expect(writes.map((w) => w.unit)).toEqual([8, 9]);
  });

  it('emits no writes for a non-positive length', () => {
    expect(userAreaToPages(area, 4, 0)).toEqual([]);
    expect(userAreaToPages(area, 4, -4)).toEqual([]);
  });
});

describe('resolveWriteKind (write-plan kind must follow the physical card)', () => {
  it('prefers the detected card kind over the operator pick (the NTAG213-on-reader bug)', () => {
    // Operator loaded a 213, switched source to "new" and picked NTAG216, then put
    // ~400 bytes of records (fits 216, busts 213). The card on the reader is a 213.
    const r = resolveWriteKind('NTAG216', 'NTAG213');
    expect(r.kind).toBe('NTAG213'); // capacity meter + plan follow the real chip
    expect(r.mismatch).toEqual({ selected: 'NTAG216', detected: 'NTAG213' });
  });

  it('reports no mismatch and keeps the kind when the pick matches the card', () => {
    const r = resolveWriteKind('NTAG216', 'NTAG216');
    expect(r.kind).toBe('NTAG216');
    expect(r.mismatch).toBeNull();
  });

  it('falls back to the operator pick only when the card kind is unknown/absent', () => {
    const r = resolveWriteKind('NTAG216', null);
    expect(r.kind).toBe('NTAG216');
    expect(r.mismatch).toBeNull();
  });

  it('flags a cross-family mismatch (NTAG pick vs MIFARE card on reader) so the caller refuses', () => {
    const r = resolveWriteKind('NTAG216', 'MIFARE_CLASSIC_1K');
    expect(r.kind).toBe('MIFARE_CLASSIC_1K');
    expect(r.mismatch).toEqual({ selected: 'NTAG216', detected: 'MIFARE_CLASSIC_1K' });
  });

  it('flags the reverse: a bigger card than the pick is still a mismatch (refuse, do not silently resize)', () => {
    const r = resolveWriteKind('NTAG213', 'NTAG216');
    expect(r.kind).toBe('NTAG216');
    expect(r.mismatch).toEqual({ selected: 'NTAG213', detected: 'NTAG216' });
  });
});
