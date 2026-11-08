import { describe, expect, it } from 'vitest';
import {
  apduAuthenticate,
  apduGetUid,
  apduLoadKey,
  apduReadBinary,
  apduUpdateBinary,
  isSuccessSw,
  mifareKeyTypeByte,
  ntagGetVersion,
  ntagPwdAuth,
  ntagRead,
  ntagReadCnt,
  ntagReadSig,
  ntagWrite,
  splitResponse,
  swHex,
  swMeansDenied,
} from '../src/main/nfc/apdu';

const FF6 = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

describe('storage pseudo-APDU builders', () => {
  it('builds Get UID (FF CA 00 00 00)', () => {
    expect(Array.from(apduGetUid())).toEqual([0xff, 0xca, 0x00, 0x00, 0x00]);
  });

  it('builds Read Binary (FF B0 00 blk le)', () => {
    expect(Array.from(apduReadBinary(4, 16))).toEqual([0xff, 0xb0, 0x00, 0x04, 0x10]);
  });

  it('builds Update Binary (FF D6 00 blk Lc data)', () => {
    expect(Array.from(apduUpdateBinary(4, Uint8Array.from([1, 2, 3, 4])))).toEqual([0xff, 0xd6, 0x00, 0x04, 0x04, 1, 2, 3, 4]);
  });

  it('builds Load Key (FF 82 00 slot 06 key) and rejects non-6-byte keys', () => {
    expect(Array.from(apduLoadKey(0, FF6))).toEqual([0xff, 0x82, 0x00, 0x00, 0x06, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => apduLoadKey(0, Uint8Array.from([1, 2, 3]))).toThrow();
  });

  it('builds General Authenticate (FF 86 ...) with the right key-type byte', () => {
    expect(mifareKeyTypeByte('A')).toBe(0x60);
    expect(mifareKeyTypeByte('B')).toBe(0x61);
    expect(Array.from(apduAuthenticate(4, 'A', 0))).toEqual([0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, 0x04, 0x60, 0x00]);
    expect(Array.from(apduAuthenticate(7, 'B', 1))).toEqual([0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, 0x07, 0x61, 0x01]);
  });
});

describe('NTAG native command frames', () => {
  it('READ / WRITE / GET_VERSION / PWD_AUTH / counters / signature', () => {
    expect(Array.from(ntagRead(4))).toEqual([0x30, 0x04]);
    expect(Array.from(ntagWrite(4, Uint8Array.from([1, 2, 3, 4])))).toEqual([0xa2, 0x04, 1, 2, 3, 4]);
    expect(Array.from(ntagGetVersion())).toEqual([0x60]);
    expect(Array.from(ntagPwdAuth(Uint8Array.from([0x12, 0x34, 0x56, 0x78])))).toEqual([0x1b, 0x12, 0x34, 0x56, 0x78]);
    expect(Array.from(ntagReadCnt(2))).toEqual([0x39, 0x02]);
    expect(Array.from(ntagReadSig())).toEqual([0x3c, 0x00]);
  });

  it('rejects the wrong payload length', () => {
    expect(() => ntagWrite(4, Uint8Array.from([1, 2, 3]))).toThrow();
    expect(() => ntagPwdAuth(Uint8Array.from([1, 2, 3]))).toThrow();
  });
});

describe('status word interpretation', () => {
  it('splits data from SW1 SW2', () => {
    const { data, sw } = splitResponse(Uint8Array.from([0xde, 0xad, 0x90, 0x00]));
    expect(Array.from(data)).toEqual([0xde, 0xad]);
    expect(isSuccessSw(sw)).toBe(true);
    expect(swHex(sw)).toBe('9000');
  });

  it('treats a too-short response as a hard failure', () => {
    const { sw } = splitResponse(Uint8Array.from([0x00]));
    expect(isSuccessSw(sw)).toBe(false);
  });

  it('classifies denied status words (6982 / 6300)', () => {
    expect(swMeansDenied({ sw1: 0x69, sw2: 0x82 })).toBe(true);
    expect(swMeansDenied({ sw1: 0x63, sw2: 0x00 })).toBe(true);
    expect(swMeansDenied({ sw1: 0x6a, sw2: 0x82 })).toBe(false);
    expect(swMeansDenied({ sw1: 0x90, sw2: 0x00 })).toBe(false);
  });
});
