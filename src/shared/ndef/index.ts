// NDEF codec - PUBLIC API (signatures frozen by the integrator).
// Owner: agent "shared-ndef". Implement in this directory (split into modules as
// you like, e.g. record.ts / message.ts / tlv.ts / wifi.ts / vcard.ts / mifare.ts)
// and re-export from here. Do NOT change names/parameters/return types.
//
// Pure TypeScript: no Node, no DOM APIs (TextEncoder/TextDecoder are allowed).

import type { TagKind } from '../tags';
import type { UnitWrite } from '../types';
import type { NdefRecordDraft, NdefRecordRaw, Type2TlvScan } from './types';

export * from './types';

const NI = (fn: string): never => {
  throw new Error(`ndef.${fn}: not implemented`);
};

/**
 * URI identifier codes 0x00-0x23 (NFC Forum URI RTD). Index = code.
 * 0x00 = "" (no prefix), 0x01 = "http://www.", 0x02 = "https://www.", ...
 */
export const URI_PREFIXES: readonly string[] = [];

/** Editor draft -> wire record. Throws NdefError (Japanese message) on invalid input. */
export function encodeDraft(draft: NdefRecordDraft): NdefRecordRaw {
  void draft;
  return NI('encodeDraft');
}

/** Wire record -> editor draft (best effort; anything unrecognised becomes kind 'raw'). */
export function decodeRaw(raw: NdefRecordRaw): NdefRecordDraft {
  void raw;
  return NI('decodeRaw');
}

/** Records -> NDEF message bytes (sets MB/ME, uses SR when payload < 256, IL when id present). */
export function encodeMessage(records: NdefRecordRaw[]): Uint8Array {
  void records;
  return NI('encodeMessage');
}

/** NDEF message bytes -> records. Throws NdefError with offset on malformed input. Handles chunked records (CF). */
export function decodeMessage(bytes: Uint8Array): NdefRecordRaw[] {
  void bytes;
  return NI('decodeMessage');
}

/** Convenience: drafts -> message bytes. An empty list yields the empty-record message D0 00 00. */
export function encodeDrafts(drafts: NdefRecordDraft[]): Uint8Array {
  void drafts;
  return NI('encodeDrafts');
}

/** Convenience: message bytes -> drafts. */
export function decodeToDrafts(bytes: Uint8Array): NdefRecordDraft[] {
  void bytes;
  return NI('decodeToDrafts');
}

/** NDEF message -> NDEF TLV (03 L V, 3-byte length form FF hi lo when L >= 255) followed by terminator FE. */
export function wrapNdefTlv(message: Uint8Array): Uint8Array {
  void message;
  return NI('wrapNdefTlv');
}

/**
 * Scan a Type 2 user area (bytes from page 4) for TLVs: 00 NULL, 01 Lock Control,
 * 02 Memory Control, 03 NDEF, FD Proprietary, FE Terminator.
 */
export function scanType2Tlvs(area: Uint8Array): Type2TlvScan {
  void area;
  return NI('scanType2Tlvs');
}

/** Maximum NDEF message length (bytes) that fits a Type 2 tag of `kind`, accounting for TLV overhead + terminator. */
export function type2Capacity(kind: TagKind): number {
  void kind;
  return NI('type2Capacity');
}

/**
 * Full user area (exactly specFor(kind).userBytes bytes) holding `message` as an
 * NDEF TLV + terminator, rest zero. Throws NdefError when it does not fit.
 */
export function buildType2UserArea(kind: TagKind, message: Uint8Array): Uint8Array {
  void kind;
  void message;
  return NI('buildType2UserArea');
}

/** Default NTAG Capability Container (page 3): E1 10 <size/8> 00. */
export function defaultCc(kind: TagKind): Uint8Array {
  void kind;
  return NI('defaultCc');
}

/** One-line human summary of a draft for lists and logs. */
export function describeDraft(draft: NdefRecordDraft, lang: 'ja' | 'en'): string {
  void draft;
  void lang;
  return NI('describeDraft');
}

/** A sensible empty draft of the given kind (for the editor's "add record" menu). */
export function emptyDraft(kind: NdefRecordDraft['kind']): NdefRecordDraft {
  void kind;
  return NI('emptyDraft');
}

/**
 * MIFARE Classic NDEF (NFC Forum "MIFARE Classic as NFC Type MIFARE Classic Tag"):
 * read the MAD (sector 0; also sector 16 on 4K), collect data blocks of sectors
 * whose AID is 0x03E1, scan TLVs and return the NDEF message, or null.
 * `data` is a full image (unreadable sectors are zero).
 */
export function extractMifareNdef(kind: TagKind, data: Uint8Array): Uint8Array | null {
  void kind;
  void data;
  return NI('extractMifareNdef');
}

/**
 * Writes for putting `message` onto an ALREADY NDEF-formatted MIFARE Classic
 * card (MAD present). Only data blocks of NDEF sectors are written; trailers and
 * MAD are never touched. Throws NdefError when the card is not NDEF-formatted or
 * the message does not fit.
 */
export function buildMifareNdefWrites(kind: TagKind, data: Uint8Array, message: Uint8Array): UnitWrite[] {
  void kind;
  void data;
  void message;
  return NI('buildMifareNdefWrites');
}
