// Card type from the ATR (shared/cardType.ts, 2026-11-14). ATRs: the NTAG / FeliCa ones are
// what the Sony PaSoRi gives (tests/nfc-service-readers.test.ts uses the same); the ID cards
// are from the public ATR list (https://pcsc-tools.apdu.fr/smartcard_list.txt) - the My
// Number card one was also read from a real card (2026-11-14). UIDs are fictional.
import { describe, expect, it } from 'vitest';
import { cardTypeFromAtr, isIso14443_4Atr } from '../src/shared/cardType';
import { hexToBytes } from '../src/shared/hex';

const atr = (s: string) => hexToBytes(s.replace(/\s+/g, ''));

describe('memory tags (PC/SC storage ATR)', () => {
  it('NTAG / Ultralight: ISO 14443 A, NFC Forum Type 2', () => {
    expect(cardTypeFromAtr(atr('3B 8F 80 01 80 4F 0C A0 00 00 03 06 03 00 03 00 00 00 00 68'), 7)).toEqual({
      radio: 'iso14443a',
      radioGuessed: false,
      form: 'memory',
      product: 'type2',
      productByAtr: false,
      nfcType: 2,
      atr: '3B8F8001804F0CA0000003060300030000000068',
    });
  });

  it('MIFARE Classic 1K / 4K / Mini, Ultralight C, Topaz', () => {
    const name = (nn: string) => cardTypeFromAtr(atr(`3B 8F 80 01 80 4F 0C A0 00 00 03 06 03 ${nn} 00 00 00 00 00`));
    expect(name('00 01')).toMatchObject({ product: 'mifareClassic1k', nfcType: null, radio: 'iso14443a' });
    expect(name('00 02')).toMatchObject({ product: 'mifareClassic4k' });
    expect(name('00 26')).toMatchObject({ product: 'mifareMini' });
    expect(name('00 3A')).toMatchObject({ product: 'ultralightC', nfcType: 2 });
    expect(name('00 30')).toMatchObject({ product: 'topaz', nfcType: 1 });
    // A card name this app has no source for: the standard is still known.
    expect(name('00 36')).toMatchObject({ product: null, radio: 'iso14443a', form: 'memory' });
  });

  it('FeliCa (standard 0x11): FeliCa, NFC Forum Type 3, whatever the card name', () => {
    expect(cardTypeFromAtr(atr('3B 8F 80 01 80 4F 0C A0 00 00 03 06 11 00 3B 00 00 00 00 42'))).toMatchObject({
      radio: 'felica',
      form: 'memory',
      product: 'felica',
      nfcType: 3,
    });
  });

  it('other standards: ISO 14443 B / ISO 15693', () => {
    expect(cardTypeFromAtr(atr('3B 8F 80 01 80 4F 0C A0 00 00 03 06 07 00 00 00 00 00 00 00'))).toMatchObject({ radio: 'iso14443b', form: 'memory' });
    expect(cardTypeFromAtr(atr('3B 8F 80 01 80 4F 0C A0 00 00 03 06 0B 00 00 00 00 00 00 00'))).toMatchObject({ radio: 'iso15693', form: 'memory' });
  });
});

describe('IC cards (ISO/IEC 14443-4 ATR)', () => {
  it('Japanese ID cards are named by their exact ATR (and the radio is a Type B guess)', () => {
    const cases: [string, string][] = [
      ['3B 88 80 01 00 00 05 E0 B3 81 A1 00 7F', 'mynumber'],
      ['3B 88 80 01 00 00 41 E0 B3 81 A1 00 3B', 'mynumber'],
      ['3B 88 80 01 00 4B 51 FF B3 81 D1 00 0F', 'mynumber'],
      ['3B 88 80 01 00 00 14 E0 B3 81 91 00 5E', 'juki'],
      ['3B 88 80 01 00 00 00 00 91 81 00 00 19', 'driverLicense'],
      ['3B 88 80 01 00 00 00 00 91 81 C1 00 D8', 'driverLicense'],
    ];
    for (const [a, product] of cases) {
      expect(cardTypeFromAtr(atr(a), 4), a).toMatchObject({ form: 'smartcard', product, productByAtr: true, radio: 'iso14443b', radioGuessed: true, nfcType: null });
    }
  });

  it('only the exact ATR names a card (one byte off = just "an IC card")', () => {
    expect(cardTypeFromAtr(atr('3B 88 80 01 00 00 05 E0 B3 81 A1 00 7E'))).toMatchObject({ form: 'smartcard', product: null, productByAtr: false });
  });

  it('Type A cards: ATS historical bytes (JCOP), ASCII text (a bank card), or a 7-byte UID', () => {
    expect(cardTypeFromAtr(atr('3B 88 80 01 00 73 C8 40 00 00 90 00 62'))).toMatchObject({ radio: 'iso14443a', radioGuessed: true, form: 'smartcard' });
    expect(cardTypeFromAtr(atr('3B 88 80 01 43 4C 61 69 72 65 20 36 0F'))).toMatchObject({ radio: 'iso14443a', radioGuessed: true });
    // A 7-byte UID settles it (a Type B PUPI is 4 bytes), even when the bytes look like Type B.
    expect(cardTypeFromAtr(atr('3B 88 80 01 00 00 05 E0 B3 81 A1 00 7F'), 7)).toMatchObject({ radio: 'iso14443a', radioGuessed: false, product: 'mynumber' });
    expect(cardTypeFromAtr(atr('3B 81 80 01 80 80'))).toMatchObject({ radio: 'iso14443a', radioGuessed: true, form: 'smartcard' });
  });
});

describe('nothing to go on', () => {
  it('empty / contact-card / garbage ATRs: unknown, never throws', () => {
    for (const a of ['', '3B 9F 95 81 31 FE 9F 00 66 46 53 05 23 00 25 71 DF 00 00 03 90 00 96', '00', '3B 8F 80']) {
      expect(cardTypeFromAtr(atr(a)), a).toMatchObject({ radio: 'unknown', form: 'unknown', product: null });
    }
  });

  it('isIso14443_4Atr: IC cards only (never a memory tag, never a contact card)', () => {
    expect(isIso14443_4Atr(atr('3B 88 80 01 00 00 05 E0 B3 81 A1 00 7F'))).toBe(true);
    expect(isIso14443_4Atr(atr('3B 81 80 01 80 80'))).toBe(true);
    expect(isIso14443_4Atr(atr('3B 8F 80 01 80 4F 0C A0 00 00 03 06 03 00 03 00 00 00 00 68'))).toBe(false);
    expect(isIso14443_4Atr(atr('3B 9F 95 81 31 FE 9F 00 66 46 53 05 23 00 25 71 DF 00 00 03 90 00 96'))).toBe(false);
    expect(isIso14443_4Atr(new Uint8Array(0))).toBe(false);
  });
});
