// What kind of card is on the reader, from its ATR (2026-11-14, request "カードの Type の
// 識別機能"). Owner: shared-tag. DISPLAY ONLY: it decides nothing about reading or
// writing (main's identification does) and sends nothing to the card - the ATR and the
// UID length are all it looks at.
//
// Two ATR shapes (PC/SC Part 3; Microsoft "PC/SC interface for smart cards"):
//  - storage (memory) cards: 3B 8n 80 01 80 4F 0C A0 00 00 03 06 SS NN NN 00 00 00 00 TCK
//    SS = the standard, NN NN = the card name (tables 2 / 3 of the Part 3 supplement).
//  - ISO/IEC 14443-4 cards ("IC cards": ID cards, bank cards, passports, phones):
//    3B 8n 80 01 <historical bytes> TCK. Type A puts the ATS historical bytes there,
//    Type B the ATQB application data (4) + protocol info (3) + MBLI/CID (1). The ATR does
//    not say which, so the radio standard of an IC card is a guess (radioGuessed) unless
//    the UID length settles it (7 / 10 bytes = Type A; a Type B PUPI is 4 bytes).
// Japanese ID cards are named by their exact ATR, checked against the public ATR list
// https://pcsc-tools.apdu.fr/smartcard_list.txt (2026-11-14). The My Number card ATR was
// also read from a real card on a Sony PaSoRi (2026-11-14).
import { parseStorageAtr } from './tags';

/** The radio standard the card answers on. */
export type CardRadio = 'iso14443a' | 'iso14443b' | 'felica' | 'iso15693' | 'unknown';
/** A memory tag (PC/SC storage card) or an IC card (ISO/IEC 14443-4, a microprocessor card). */
export type CardForm = 'memory' | 'smartcard' | 'unknown';
export type CardProduct =
  | 'type2' // NTAG / MIFARE Ultralight family (PC/SC card name 0x0003)
  | 'ultralightC'
  | 'mifareClassic1k'
  | 'mifareClassic4k'
  | 'mifareMini'
  | 'topaz'
  | 'felica'
  | 'mynumber' // Japanese Individual Number Card (JPKI)
  | 'juki' // Basic Resident Registration Card
  | 'driverLicense'; // Japanese driving licence

export interface CardTypeInfo {
  radio: CardRadio;
  /** The radio standard is inferred from the historical bytes, not stated by the ATR. */
  radioGuessed: boolean;
  form: CardForm;
  product: CardProduct | null;
  /** The product is a known card named by its exact ATR (an ID card); it may be another card on the same chip. */
  productByAtr: boolean;
  /** NFC Forum tag type the product implements, when known. */
  nfcType: 1 | 2 | 3 | null;
  /** The ATR, uppercase hex without separators ('' when there is none). */
  atr: string;
}

/** Exact ATRs of Japanese ID cards (uppercase hex, TCK included). */
const KNOWN_ATRS: Readonly<Record<string, CardProduct>> = {
  '3B888001000005E0B381A1007F': 'mynumber',
  '3B888001000041E0B381A1003B': 'mynumber',
  '3B888001004B51FFB381D1000F': 'mynumber',
  '3B888001000014E0B38191005E': 'juki',
  '3B888001000000009181000019': 'driverLicense',
  '3B888001000000009181C100D8': 'driverLicense',
};

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/** 3B 8n 80 01 ... without the PC/SC storage RID: an ISO/IEC 14443-4 card (an IC card, never a memory tag). */
export function isIso14443_4Atr(atr: Uint8Array): boolean {
  if (atr.length < 5 || parseStorageAtr(atr)) return false;
  return atr[0] === 0x3b && (atr[1] & 0xf0) === 0x80 && atr[2] === 0x80 && atr[3] === 0x01;
}

/** PC/SC Part 3 standard byte -> radio (table 2: 01-03 ISO 14443 A, 05-07 ISO 14443 B, 09-0C ISO 15693, 11 FeliCa). */
function radioOfStandard(ss: number): CardRadio {
  if (ss >= 0x01 && ss <= 0x03) return 'iso14443a';
  if (ss >= 0x05 && ss <= 0x07) return 'iso14443b';
  if (ss >= 0x09 && ss <= 0x0c) return 'iso15693';
  if (ss === 0x11) return 'felica';
  return 'unknown';
}

/** PC/SC Part 3 card name -> product (only the names this app has a source for). */
function productOfCardName(name: number): CardProduct | null {
  switch (name) {
    case 0x0001:
      return 'mifareClassic1k';
    case 0x0002:
      return 'mifareClassic4k';
    case 0x0003:
      return 'type2';
    case 0x0026:
      return 'mifareMini';
    case 0x0030:
      return 'topaz';
    case 0x003a:
      return 'ultralightC';
    default:
      return null;
  }
}

function nfcTypeOf(p: CardProduct | null): 1 | 2 | 3 | null {
  if (p === 'type2' || p === 'ultralightC') return 2;
  if (p === 'topaz') return 1;
  if (p === 'felica') return 3;
  return null;
}

/**
 * Type B guess for an ISO 14443-4 ATR: 8 historical bytes whose 6th (ATQB protocol info,
 * 2nd byte) says "ISO/IEC 14443-4 compliant" (b1 = 1, b4 = 0). Historical bytes that are
 * all printable ASCII are an ATS text (Type A), e.g. a bank card's "CLaire 6".
 */
function looksTypeB(hist: Uint8Array): boolean {
  if (hist.length !== 8) return false;
  if (hist.every((b) => b >= 0x20 && b <= 0x7e)) return false;
  return (hist[5] & 0x09) === 0x01;
}

/**
 * The card type from the ATR (and the UID length, when known). Never throws; an empty or
 * unknown ATR gives radio / form 'unknown'.
 */
export function cardTypeFromAtr(atr: Uint8Array, uidLength?: number): CardTypeInfo {
  const hex = toHex(atr);
  const base: CardTypeInfo = { radio: 'unknown', radioGuessed: false, form: 'unknown', product: null, productByAtr: false, nfcType: null, atr: hex };

  const storage = parseStorageAtr(atr);
  if (storage) {
    const radio = radioOfStandard(storage.standard);
    const product = radio === 'felica' ? 'felica' : productOfCardName(storage.cardName);
    return { ...base, radio, form: 'memory', product, nfcType: nfcTypeOf(product) };
  }

  if (isIso14443_4Atr(atr)) {
    const hist = atr.slice(4, 4 + (atr[1] & 0x0f));
    const known = KNOWN_ATRS[hex] ?? null;
    let radio: CardRadio;
    let radioGuessed = true;
    if (uidLength === 7 || uidLength === 10) {
      radio = 'iso14443a';
      radioGuessed = false;
    } else {
      radio = looksTypeB(hist) ? 'iso14443b' : 'iso14443a';
    }
    return { ...base, radio, radioGuessed, form: 'smartcard', product: known, productByAtr: known !== null };
  }

  return base;
}
