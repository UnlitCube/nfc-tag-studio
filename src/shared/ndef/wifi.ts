// Wi-Fi Simple Config (WPS) "Credential" codec for the MIME record
// "application/vnd.wfa.wsc". Pure TypeScript.
//
// WSC attributes are TLVs with a 2-byte big-endian type and 2-byte big-endian
// length. The Credential attribute (0x100E) wraps the network's sub-attributes.
//
// Note: the WPS Credential has no standard field for a "hidden SSID" flag, so the
// draft's `hidden` is not written and always decodes as false.

import { bytesToUtf8, concatBytes, utf8ToBytes } from '../hex';
import { NdefError } from './types';
import type { NdefRecordDraft, WifiAuth, WifiEncryption } from './types';

const ATTR_CREDENTIAL = 0x100e;
const ATTR_NETWORK_INDEX = 0x1026;
const ATTR_SSID = 0x1045;
const ATTR_AUTH_TYPE = 0x1003;
const ATTR_ENCRYPT_TYPE = 0x100f;
const ATTR_NETWORK_KEY = 0x1027;
const ATTR_MAC_ADDRESS = 0x1020;

// WPS authentication type bitmask values (2 bytes).
const AUTH_TO_WPS: Record<WifiAuth, number> = {
  open: 0x0001,
  'wpa-personal': 0x0002,
  'wpa2-personal': 0x0020,
  'wpa-wpa2-personal': 0x0022,
  'wpa3-personal': 0x0040,
};

// WPS encryption type bitmask values (2 bytes).
const ENC_TO_WPS: Record<WifiEncryption, number> = {
  none: 0x0001,
  tkip: 0x0004,
  aes: 0x0008,
  'aes-tkip': 0x000c,
};

function wpsToAuth(value: number): WifiAuth {
  for (const k of Object.keys(AUTH_TO_WPS) as WifiAuth[]) if (AUTH_TO_WPS[k] === value) return k;
  // WPA2 bit set -> treat as WPA2-personal, else fall back.
  if (value & 0x0020) return 'wpa2-personal';
  if (value & 0x0002) return 'wpa-personal';
  return 'wpa2-personal';
}

function wpsToEnc(value: number): WifiEncryption {
  for (const k of Object.keys(ENC_TO_WPS) as WifiEncryption[]) if (ENC_TO_WPS[k] === value) return k;
  if (value & 0x0008) return 'aes';
  if (value & 0x0004) return 'tkip';
  return 'aes';
}

function be16(value: number): Uint8Array {
  return Uint8Array.from([(value >> 8) & 0xff, value & 0xff]);
}

function attr(type: number, value: Uint8Array): Uint8Array {
  const head = Uint8Array.from([(type >> 8) & 0xff, type & 0xff, (value.length >> 8) & 0xff, value.length & 0xff]);
  return concatBytes(head, value);
}

interface WpsAttr {
  type: number;
  value: Uint8Array;
}

function parseAttrs(bytes: Uint8Array): WpsAttr[] {
  const out: WpsAttr[] = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const type = (bytes[i] << 8) | bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (i + 4 + len > bytes.length) break;
    out.push({ type, value: bytes.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

type WifiDraft = Extract<NdefRecordDraft, { kind: 'wifi' }>;

/** Wi-Fi draft -> WPS Credential payload bytes. */
export function encodeWifi(draft: WifiDraft): Uint8Array {
  if (draft.ssid === '') throw new NdefError('SSID を入力してください');
  const ssid = utf8ToBytes(draft.ssid);
  if (ssid.length > 32) throw new NdefError('SSID が長すぎます（最大 32 バイト）');
  const key = utf8ToBytes(draft.password);
  if (key.length > 64) throw new NdefError('パスワードが長すぎます（最大 64 バイト）');
  const sub = concatBytes(
    attr(ATTR_NETWORK_INDEX, Uint8Array.from([0x01])),
    attr(ATTR_SSID, ssid),
    attr(ATTR_AUTH_TYPE, be16(AUTH_TO_WPS[draft.auth])),
    attr(ATTR_ENCRYPT_TYPE, be16(ENC_TO_WPS[draft.encryption])),
    attr(ATTR_NETWORK_KEY, key),
    attr(ATTR_MAC_ADDRESS, new Uint8Array(6)),
  );
  return attr(ATTR_CREDENTIAL, sub);
}

/** WPS Credential payload bytes -> Wi-Fi draft. */
export function decodeWifi(payload: Uint8Array): WifiDraft {
  const top = parseAttrs(payload);
  const credential = top.find((a) => a.type === ATTR_CREDENTIAL);
  const sub = credential ? parseAttrs(credential.value) : top;
  const find = (t: number): Uint8Array | undefined => sub.find((a) => a.type === t)?.value;

  const ssidBytes = find(ATTR_SSID);
  if (!ssidBytes) throw new NdefError('Wi-Fi 設定（SSID）を解釈できません');
  const authBytes = find(ATTR_AUTH_TYPE);
  const encBytes = find(ATTR_ENCRYPT_TYPE);
  const keyBytes = find(ATTR_NETWORK_KEY);

  const authVal = authBytes && authBytes.length >= 2 ? (authBytes[0] << 8) | authBytes[1] : AUTH_TO_WPS['wpa2-personal'];
  const encVal = encBytes && encBytes.length >= 2 ? (encBytes[0] << 8) | encBytes[1] : ENC_TO_WPS.aes;

  return {
    kind: 'wifi',
    ssid: bytesToUtf8(ssidBytes),
    auth: wpsToAuth(authVal),
    encryption: wpsToEnc(encVal),
    password: keyBytes ? bytesToUtf8(keyBytes) : '',
    hidden: false,
  };
}
