import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, NdefError, TNF, type NdefRecordRaw } from '@shared/ndef';
import { bytesToHex } from '@shared/hex';

const hex = (b: Uint8Array): string => bytesToHex(b);
const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);

function raw(tnf: number, type: number[], payload: number[], id: number[] = []): NdefRecordRaw {
  return { tnf: tnf as NdefRecordRaw['tnf'], type: bytes(...type), id: bytes(...id), payload: bytes(...payload) };
}

describe('encodeMessage flags', () => {
  it('sets MB on the first and ME on the last record', () => {
    const msg = encodeMessage([raw(TNF.WELL_KNOWN, [0x54], [0x02, 0x65, 0x6e]), raw(TNF.WELL_KNOWN, [0x55], [0x00])]);
    expect(msg[0] & 0x80).toBe(0x80); // MB on first
    expect(msg[0] & 0x40).toBe(0x00); // ME not on first
    // find the second header: after first record (3 header + 1 type + 3 payload = 7 bytes)
    const secondHeader = msg[7];
    expect(secondHeader & 0x80).toBe(0x00);
    expect(secondHeader & 0x40).toBe(0x40); // ME on last
  });

  it('empty list yields D0 00 00', () => {
    expect(hex(encodeMessage([]))).toBe('D00000');
  });

  it('sets IL and the id length when an id is present', () => {
    const msg = encodeMessage([raw(TNF.EXTERNAL, [0x61], [0x01], [0xaa, 0xbb])]);
    expect(msg[0] & 0x08).toBe(0x08); // IL
    // header, typeLen, payloadLen(SR), idLen, type, id, payload
    // msg = [hdr][01][01][02][61][AA BB][01]
    expect(msg[3]).toBe(0x02); // id length
    expect(hex(msg.slice(4))).toBe('61AABB01');
  });
});

describe('SR / non-SR boundary (payload 255 vs 256)', () => {
  const p255 = new Array(255).fill(0x41);
  const p256 = new Array(256).fill(0x42);

  it('payload 255 uses the short form (SR set, 1-byte length)', () => {
    const msg = encodeMessage([raw(TNF.MIME, [0x74], p255)]);
    expect(msg[0] & 0x10).toBe(0x10); // SR
    expect(msg[2]).toBe(0xff); // 1-byte length = 255
    expect(decodeMessage(msg)[0].payload.length).toBe(255);
  });

  it('payload 256 uses the long form (SR clear, 4-byte length)', () => {
    const msg = encodeMessage([raw(TNF.MIME, [0x74], p256)]);
    expect(msg[0] & 0x10).toBe(0x00); // SR clear
    // header, typeLen, then 4-byte length 00 00 01 00
    expect(hex(msg.slice(2, 6))).toBe('00000100');
    const back = decodeMessage(msg)[0];
    expect(back.payload.length).toBe(256);
    expect(back.payload[0]).toBe(0x42);
  });

  it('round-trips both boundary records', () => {
    for (const p of [p255, p256]) {
      const r = raw(TNF.MIME, [0x74], p);
      const back = decodeMessage(encodeMessage([r]))[0];
      expect(hex(back.payload)).toBe(hex(r.payload));
    }
  });
});

describe('decodeMessage chunking (CF)', () => {
  it('reassembles a chunked record into one payload', () => {
    // Chunk 1: MB|CF|SR, TNF=UNKNOWN(5), typeLen 0, payloadLen 3, "ABC"
    // Chunk 2: ME|SR, TNF=UNCHANGED(6), typeLen 0, payloadLen 3, "DEF"
    const msg = bytes(0xb5, 0x00, 0x03, 0x41, 0x42, 0x43, 0x56, 0x00, 0x03, 0x44, 0x45, 0x46);
    const recs = decodeMessage(msg);
    expect(recs.length).toBe(1);
    expect(recs[0].tnf).toBe(TNF.UNKNOWN);
    expect(hex(recs[0].payload)).toBe('414243444546'); // ABCDEF
  });

  it('supports three chunks', () => {
    const msg = bytes(
      0xb5, 0x00, 0x01, 0x41, // chunk1 MB|CF|SR, "A"
      0x36, 0x00, 0x01, 0x42, // chunk2 CF|SR TNF6, "B"
      0x56, 0x00, 0x01, 0x43, // chunk3 ME|SR TNF6, "C"
    );
    expect(hex(decodeMessage(msg)[0].payload)).toBe('414243');
  });

  it('rejects a continuation chunk whose TNF is not UNCHANGED', () => {
    const msg = bytes(0xb5, 0x00, 0x01, 0x41, 0x51, 0x00, 0x01, 0x42); // second chunk TNF=1
    expect(() => decodeMessage(msg)).toThrow(NdefError);
  });
});

describe('decodeMessage error handling', () => {
  it('throws with an offset when the first record lacks MB', () => {
    const msg = bytes(0x51, 0x01, 0x01, 0x55, 0x00); // ME|SR TNF1 but no MB
    try {
      decodeMessage(msg);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NdefError);
      expect((e as NdefError).offset).toBe(0);
    }
  });

  it('throws when the message is truncated', () => {
    const msg = bytes(0xd1, 0x01, 0x05, 0x55, 0x01); // claims 5-byte payload, only 1 present
    expect(() => decodeMessage(msg)).toThrow(NdefError);
  });

  it('throws when no record sets ME', () => {
    const msg = bytes(0x91, 0x01, 0x01, 0x55, 0x00); // MB|SR, no ME, complete record
    expect(() => decodeMessage(msg)).toThrow(NdefError);
  });

  it('throws when there are bytes after the ME record', () => {
    const msg = bytes(0xd1, 0x01, 0x01, 0x55, 0x00, 0x99); // trailing 0x99
    expect(() => decodeMessage(msg)).toThrow(NdefError);
  });

  it('returns an empty list for empty input', () => {
    expect(decodeMessage(new Uint8Array(0))).toEqual([]);
  });
});

describe('encode/decode message round-trips', () => {
  it('preserves a multi-record message with ids', () => {
    const records = [
      raw(TNF.WELL_KNOWN, [0x54], [0x02, 0x65, 0x6e, 0x68, 0x69], [0x31]),
      raw(TNF.WELL_KNOWN, [0x55], [0x04, 0x78]),
      raw(TNF.EXTERNAL, [0x61, 0x3a, 0x62], new Array(300).fill(0x7a)),
    ];
    const back = decodeMessage(encodeMessage(records));
    expect(back.length).toBe(3);
    for (let i = 0; i < records.length; i++) {
      expect(back[i].tnf).toBe(records[i].tnf);
      expect(hex(back[i].type)).toBe(hex(records[i].type));
      expect(hex(back[i].id)).toBe(hex(records[i].id));
      expect(hex(back[i].payload)).toBe(hex(records[i].payload));
    }
  });
});
