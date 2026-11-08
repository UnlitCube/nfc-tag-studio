// NDEF model shared by the codec (src/shared/ndef/*) and the NDEF editor UI.
// CONTRACT FILE - frozen. Change only via the integrator.

/** Type Name Format (3 bits). */
export type Tnf = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const TNF = {
  EMPTY: 0,
  WELL_KNOWN: 1,
  MIME: 2,
  ABSOLUTE_URI: 3,
  EXTERNAL: 4,
  UNKNOWN: 5,
  UNCHANGED: 6,
  RESERVED: 7,
} as const;

/** A record as it exists on the wire (after decoding, before interpretation). */
export interface NdefRecordRaw {
  tnf: Tnf;
  type: Uint8Array;
  id: Uint8Array;
  payload: Uint8Array;
}

export type WifiAuth = 'open' | 'wpa-personal' | 'wpa2-personal' | 'wpa-wpa2-personal' | 'wpa3-personal';
export type WifiEncryption = 'none' | 'tkip' | 'aes' | 'aes-tkip';

export interface VcardFields {
  /** Formatted name (FN). Required for a valid vCard. */
  name: string;
  org?: string;
  title?: string;
  tel?: string;
  email?: string;
  url?: string;
  address?: string;
  note?: string;
}

/**
 * Editor-level record. String fields may contain issue placeholders
 * ({{seq}}, {{seq:6}}, {{uid}}, {{date:YYYYMMDD}}, {{csv:col}}, {{input:name}}),
 * which the issue engine expands before encoding.
 */
export type NdefRecordDraft =
  | { kind: 'uri'; uri: string }
  | { kind: 'text'; text: string; lang: string; encoding: 'utf8' | 'utf16' }
  | {
      kind: 'wifi';
      ssid: string;
      auth: WifiAuth;
      encryption: WifiEncryption;
      password: string;
      hidden: boolean;
    }
  | { kind: 'vcard'; fields: VcardFields }
  /** payload is text (payloadText) or bytes (payloadHex); exactly one is used, payloadHex wins when non-empty. */
  | { kind: 'mime'; mimeType: string; payloadText: string; payloadHex: string }
  /** Android Application Record (external type "android.com:pkg"). */
  | { kind: 'aar'; packageName: string }
  /** NFC Forum external type, e.g. "example.com:employee". */
  | { kind: 'external'; domainType: string; payloadText: string; payloadHex: string }
  | { kind: 'smartposter'; uri: string; title: string; lang: string }
  /** Anything else, round-tripped byte-exact. */
  | { kind: 'raw'; tnf: Tnf; typeHex: string; idHex: string; payloadHex: string }
  | { kind: 'empty' };

export type NdefRecordKind = NdefRecordDraft['kind'];

/** Thrown by the codec for malformed input. `offset` points into the input bytes when known. */
export class NdefError extends Error {
  readonly offset: number | null;
  constructor(message: string, offset: number | null = null) {
    super(message);
    this.name = 'NdefError';
    this.offset = offset;
  }
}

/** Result of scanning a Type 2 tag's user area for TLV blocks. */
export interface Type2TlvScan {
  /** NDEF message bytes (V of the first NDEF TLV) or null when there is none. */
  ndef: Uint8Array | null;
  /** Byte offset (within the scanned area) where the NDEF TLV starts, or null. */
  ndefTlvOffset: number | null;
  /** Byte offset of the terminator TLV (0xFE), or null. */
  terminatorOffset: number | null;
  /** Every TLV found, in order (for display in the hex view). */
  tlvs: { tag: number; offset: number; length: number; valueOffset: number }[];
  /** True when the area holds no NDEF and is all zero / only NULL TLVs (a blank tag). */
  blank: boolean;
}
