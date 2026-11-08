import { describe, expect, it } from 'vitest';
import {
  buildMifareNdefWrites,
  decodeToDrafts,
  encodeDrafts,
  extractMifareNdef,
  NdefError,
  wrapNdefTlv,
  type NdefRecordDraft,
} from '@shared/ndef';
import { imageSize, mifareIsTrailer } from '@shared/tags';

/** Build a MIFARE Classic image with the given sectors marked NDEF in the MAD. */
function madImage(kind: 'MIFARE_CLASSIC_1K' | 'MIFARE_CLASSIC_4K', ndefSectors: number[]): Uint8Array {
  const data = new Uint8Array(imageSize(kind));
  // MAD1 info byte (block 1, byte 1). CRC is not validated by the reader.
  data[17] = 0x01;
  for (const s of ndefSectors) {
    let off: number;
    if (s >= 1 && s <= 15) off = 16 + 2 * s;
    else off = 1024 + 2 * (s - 16); // MAD2
    data[off] = 0x03;
    data[off + 1] = 0xe1;
  }
  return data;
}

const sampleDraft: NdefRecordDraft = { kind: 'uri', uri: 'https://example.com' };

describe('extractMifareNdef', () => {
  it('reads an NDEF message from the sector 1 data blocks (1K, MAD1)', () => {
    const data = madImage('MIFARE_CLASSIC_1K', [1]);
    const msg = encodeDrafts([sampleDraft]);
    data.set(wrapNdefTlv(msg), 4 * 16); // sector 1, block 4
    const extracted = extractMifareNdef('MIFARE_CLASSIC_1K', data);
    expect(extracted).not.toBeNull();
    expect(decodeToDrafts(extracted!)).toEqual([sampleDraft]);
  });

  it('spans multiple NDEF sectors in MAD order', () => {
    const data = madImage('MIFARE_CLASSIC_1K', [1, 2]);
    // A message large enough to cross from sector 1 (blocks 4-6 = 48 B) into sector 2 (block 8).
    const big = encodeDrafts([{ kind: 'mime', mimeType: 'text/plain', payloadText: 'x'.repeat(80), payloadHex: '' }]);
    const tlv = wrapNdefTlv(big);
    // sector 1 data blocks are 4,5,6 (48 B), sector 2 data blocks are 8,9,10.
    data.set(tlv.slice(0, 48), 4 * 16);
    data.set(tlv.slice(48), 8 * 16);
    const extracted = extractMifareNdef('MIFARE_CLASSIC_1K', data);
    expect(extracted).not.toBeNull();
    expect(decodeToDrafts(extracted!)).toEqual([
      { kind: 'mime', mimeType: 'text/plain', payloadText: 'x'.repeat(80), payloadHex: '' },
    ]);
  });

  it('reads an NDEF sector mapped by MAD2 (4K, sector 17)', () => {
    const data = madImage('MIFARE_CLASSIC_4K', [17]);
    const msg = encodeDrafts([sampleDraft]);
    data.set(wrapNdefTlv(msg), 68 * 16); // sector 17, first block = 68
    const extracted = extractMifareNdef('MIFARE_CLASSIC_4K', data);
    expect(extracted).not.toBeNull();
    expect(decodeToDrafts(extracted!)).toEqual([sampleDraft]);
  });

  it('returns null when the MAD marks no NDEF sector', () => {
    expect(extractMifareNdef('MIFARE_CLASSIC_1K', madImage('MIFARE_CLASSIC_1K', []))).toBeNull();
  });

  it('returns null for an all-zero image', () => {
    expect(extractMifareNdef('MIFARE_CLASSIC_1K', new Uint8Array(imageSize('MIFARE_CLASSIC_1K')))).toBeNull();
  });
});

describe('buildMifareNdefWrites', () => {
  it('writes only NDEF data blocks, never the MAD or trailers', () => {
    const data = madImage('MIFARE_CLASSIC_1K', [1]);
    const msg = encodeDrafts([sampleDraft]);
    const writes = buildMifareNdefWrites('MIFARE_CLASSIC_1K', data, msg);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.data.length).toBe(16);
      expect(w.unit).toBeGreaterThanOrEqual(4); // not block 0 (manufacturer) nor the MAD sector
      expect(mifareIsTrailer(w.unit)).toBe(false); // never a sector trailer
    }
    // First write goes to the first data block of sector 1 (block 4).
    expect(writes[0].unit).toBe(4);
  });

  it('round-trips through extract', () => {
    const data = madImage('MIFARE_CLASSIC_1K', [1]);
    const msg = encodeDrafts([{ kind: 'text', text: 'hi', lang: 'en', encoding: 'utf8' }]);
    for (const w of buildMifareNdefWrites('MIFARE_CLASSIC_1K', data, msg)) {
      data.set(w.data, w.unit * 16);
    }
    expect(decodeToDrafts(extractMifareNdef('MIFARE_CLASSIC_1K', data)!)).toEqual([
      { kind: 'text', text: 'hi', lang: 'en', encoding: 'utf8' },
    ]);
  });

  it('throws when the card is not NDEF-formatted', () => {
    const data = madImage('MIFARE_CLASSIC_1K', []);
    expect(() => buildMifareNdefWrites('MIFARE_CLASSIC_1K', data, encodeDrafts([sampleDraft]))).toThrow(NdefError);
  });

  it('throws when the message does not fit the available NDEF blocks', () => {
    const data = madImage('MIFARE_CLASSIC_1K', [1]); // only 48 data bytes
    const tooBig = encodeDrafts([{ kind: 'mime', mimeType: 'text/plain', payloadText: 'z'.repeat(200), payloadHex: '' }]);
    expect(() => buildMifareNdefWrites('MIFARE_CLASSIC_1K', data, tooBig)).toThrow(NdefError);
  });
});
