import { describe, expect, it } from 'vitest';
import {
  buildType2UserArea,
  defaultCc,
  NdefError,
  scanType2Tlvs,
  type2Capacity,
  wrapNdefTlv,
} from '@shared/ndef';
import { bytesToHex } from '@shared/hex';
import { specFor } from '@shared/tags';

const hex = (b: Uint8Array): string => bytesToHex(b);

describe('wrapNdefTlv', () => {
  it('uses the 1-byte length form below 255', () => {
    expect(hex(wrapNdefTlv(Uint8Array.from([0x01, 0x02, 0x03])))).toBe('0303010203FE');
  });

  it('uses the 1-byte form at exactly 254', () => {
    const msg = new Uint8Array(254).fill(0xaa);
    const tlv = wrapNdefTlv(msg);
    expect(tlv[0]).toBe(0x03);
    expect(tlv[1]).toBe(0xfe); // length 254
    expect(tlv.length).toBe(254 + 3); // tag + len + terminator
    expect(tlv[tlv.length - 1]).toBe(0xfe); // terminator
  });

  it('switches to the 3-byte form (FF hi lo) at 255', () => {
    const tlv = wrapNdefTlv(new Uint8Array(255).fill(0xbb));
    expect(hex(tlv.slice(0, 4))).toBe('03FF00FF');
    expect(tlv.length).toBe(255 + 5);
    expect(tlv[tlv.length - 1]).toBe(0xfe);
  });

  it('encodes a 300-byte length as FF 01 2C', () => {
    const tlv = wrapNdefTlv(new Uint8Array(300));
    expect(hex(tlv.slice(0, 4))).toBe('03FF012C');
  });
});

describe('scanType2Tlvs', () => {
  it('finds an NDEF TLV and its offsets', () => {
    const area = Uint8Array.from([0x03, 0x03, 0x01, 0x02, 0x03, 0xfe, 0x00, 0x00]);
    const scan = scanType2Tlvs(area);
    expect(hex(scan.ndef!)).toBe('010203');
    expect(scan.ndefTlvOffset).toBe(0);
    expect(scan.terminatorOffset).toBe(5);
    expect(scan.blank).toBe(false);
    expect(scan.tlvs.map((t) => t.tag)).toEqual([0x03, 0xfe]);
  });

  it('treats an all-zero area as blank', () => {
    const scan = scanType2Tlvs(new Uint8Array(32));
    expect(scan.ndef).toBeNull();
    expect(scan.blank).toBe(true);
  });

  it('reads a factory empty NDEF (03 00 FE) as a non-null empty message', () => {
    const area = Uint8Array.from([0x03, 0x00, 0xfe, 0x00, 0x00]);
    const scan = scanType2Tlvs(area);
    expect(scan.ndef).not.toBeNull();
    expect(scan.ndef!.length).toBe(0);
    expect(scan.blank).toBe(false);
  });

  it('skips NULL padding and records lock/memory control TLVs before the NDEF', () => {
    // 00 (null) 01 03 AABBCC (lock) 03 02 D1 00 (ndef) FE
    const area = Uint8Array.from([
      0x00, 0x01, 0x03, 0xaa, 0xbb, 0xcc, 0x03, 0x02, 0xd1, 0x00, 0xfe,
    ]);
    const scan = scanType2Tlvs(area);
    expect(scan.tlvs.map((t) => t.tag)).toEqual([0x01, 0x03, 0xfe]);
    expect(hex(scan.ndef!)).toBe('D100');
    expect(scan.ndefTlvOffset).toBe(6);
  });

  it('parses a 3-byte length NDEF TLV', () => {
    const msg = new Uint8Array(300).fill(0x5a);
    const area = wrapNdefTlv(msg);
    const scan = scanType2Tlvs(area);
    expect(scan.ndef!.length).toBe(300);
  });
});

describe('type2Capacity', () => {
  it('matches the CC-declared NDEF area minus TLV overhead', () => {
    expect(type2Capacity('NTAG213')).toBe(141); // 144 - 3
    expect(type2Capacity('NTAG215')).toBe(491); // 496 - 5
    expect(type2Capacity('NTAG216')).toBe(867); // 872 - 5
  });

  it('throws for a non-Type-2 (MIFARE) kind', () => {
    expect(() => type2Capacity('MIFARE_CLASSIC_1K')).toThrow(NdefError);
  });
});

describe('buildType2UserArea', () => {
  it('returns exactly userBytes with the TLV at the start, rest zero', () => {
    const area = buildType2UserArea('NTAG213', Uint8Array.from([0xaa, 0xbb]));
    expect(area.length).toBe(specFor('NTAG213').userBytes); // 144
    expect(hex(area.slice(0, 5))).toBe('0302AABBFE');
    expect(area.slice(5).every((b) => b === 0)).toBe(true);
  });

  it('fills an NTAG213 exactly at capacity (141 bytes)', () => {
    const area = buildType2UserArea('NTAG213', new Uint8Array(141).fill(0x11));
    expect(area.length).toBe(144);
    expect(area[143]).toBe(0xfe); // terminator at the last byte
  });

  it('throws when the message exceeds capacity', () => {
    expect(() => buildType2UserArea('NTAG213', new Uint8Array(142))).toThrow(NdefError);
  });

  it('throws for a non-NTAG kind', () => {
    expect(() => buildType2UserArea('MIFARE_CLASSIC_1K', new Uint8Array(1))).toThrow(NdefError);
  });
});

describe('defaultCc', () => {
  it('encodes E1 10 <size/8> 00 for each NTAG', () => {
    expect(hex(defaultCc('NTAG213'))).toBe('E1101200'); // 144/8 = 18 = 0x12
    expect(hex(defaultCc('NTAG215'))).toBe('E1103E00'); // 496/8 = 62 = 0x3E
    expect(hex(defaultCc('NTAG216'))).toBe('E1106D00'); // 872/8 = 109 = 0x6D
  });

  it('throws for a non-NTAG kind', () => {
    expect(() => defaultCc('MIFARE_CLASSIC_4K')).toThrow(NdefError);
  });
});
