// Editor draft <-> wire record (NdefRecordRaw). Pure TypeScript.
//
// Design invariant reminder: NDEF records carry data only. Nothing here reads or
// writes a tag UID - the UID is fixed at manufacture and read-only.

import { bytesEqual, bytesToHex, bytesToUtf8, concatBytes, hexToBytes, utf8ToBytes } from '../hex';
import { encodeMessage, decodeMessage } from './message';
import { encodeWifi, decodeWifi } from './wifi';
import { buildVcard, parseVcard } from './vcard';
import { NdefError, TNF } from './types';
import type { NdefRecordDraft, NdefRecordRaw, Tnf } from './types';

const EMPTY = new Uint8Array(0);
const TYPE_U = Uint8Array.from([0x55]); // 'U'
const TYPE_T = Uint8Array.from([0x54]); // 'T'
const TYPE_SP = Uint8Array.from([0x53, 0x70]); // 'Sp'
const WIFI_MIME = 'application/vnd.wfa.wsc';
const AAR_TYPE = 'android.com:pkg';

/**
 * URI identifier codes 0x00-0x23 (NFC Forum URI RTD). Index = code.
 * 0x00 = "" (no prefix), 0x01 = "http://www.", 0x02 = "https://www.", ...
 */
export const URI_PREFIXES: readonly string[] = [
  '', // 0x00
  'http://www.', // 0x01
  'https://www.', // 0x02
  'http://', // 0x03
  'https://', // 0x04
  'tel:', // 0x05
  'mailto:', // 0x06
  'ftp://anonymous:anonymous@', // 0x07
  'ftp://ftp.', // 0x08
  'ftps://', // 0x09
  'sftp://', // 0x0A
  'smb://', // 0x0B
  'nfs://', // 0x0C
  'ftp://', // 0x0D
  'dav://', // 0x0E
  'news:', // 0x0F
  'telnet://', // 0x10
  'imap:', // 0x11
  'rtsp://', // 0x12
  'urn:', // 0x13
  'pop:', // 0x14
  'sip:', // 0x15
  'sips:', // 0x16
  'tftp:', // 0x17
  'btspp://', // 0x18
  'btl2cap://', // 0x19
  'btgoep://', // 0x1A
  'tcpobex://', // 0x1B
  'irdaobex://', // 0x1C
  'file://', // 0x1D
  'urn:epc:id:', // 0x1E
  'urn:epc:tag:', // 0x1F
  'urn:epc:pat:', // 0x20
  'urn:epc:raw:', // 0x21
  'urn:epc:', // 0x22
  'urn:nfc:', // 0x23
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asciiOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function typeEquals(type: Uint8Array, ascii: Uint8Array): boolean {
  return bytesEqual(type, ascii);
}

function hexToBytesSafe(hex: string, label: string): Uint8Array {
  try {
    return hexToBytes(hex);
  } catch (e) {
    throw new NdefError(`${label}の 16 進数が不正です: ${(e as Error).message}`);
  }
}

/** Whether a byte run round-trips cleanly as printable UTF-8 text (no control chars). */
function looksText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const s = bytesToUtf8(bytes);
  if (s.includes('�')) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return bytesEqual(utf8ToBytes(s), bytes);
}

function payloadTextOrHex(payload: Uint8Array): { payloadText: string; payloadHex: string } {
  if (looksText(payload)) return { payloadText: bytesToUtf8(payload), payloadHex: '' };
  return { payloadText: '', payloadHex: bytesToHex(payload) };
}

function toRawDraft(raw: NdefRecordRaw): NdefRecordDraft {
  return {
    kind: 'raw',
    tnf: raw.tnf,
    typeHex: bytesToHex(raw.type),
    idHex: bytesToHex(raw.id),
    payloadHex: bytesToHex(raw.payload),
  };
}

// ---------------------------------------------------------------------------
// URI
// ---------------------------------------------------------------------------

function encodeUriPayload(uri: string): Uint8Array {
  let bestCode = 0;
  let bestLen = 0;
  for (let c = 1; c < URI_PREFIXES.length; c++) {
    const p = URI_PREFIXES[c];
    if (p.length > bestLen && uri.startsWith(p)) {
      bestLen = p.length;
      bestCode = c;
    }
  }
  return concatBytes([bestCode], utf8ToBytes(uri.slice(bestLen)));
}

function decodeUriString(payload: Uint8Array): string {
  if (payload.length === 0) return '';
  const code = payload[0];
  const prefix = code < URI_PREFIXES.length ? URI_PREFIXES[code] : '';
  return prefix + bytesToUtf8(payload.slice(1));
}

// ---------------------------------------------------------------------------
// Text (RTD "T")
// ---------------------------------------------------------------------------

function utf16beToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 * i] = (c >> 8) & 0xff;
    out[2 * i + 1] = c & 0xff;
  }
  return out;
}

function bytesToUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    s += String.fromCharCode(c);
  }
  return s;
}

function encodeTextPayload(text: string, lang: string, encoding: 'utf8' | 'utf16'): Uint8Array {
  const langBytes = utf8ToBytes(lang);
  if (langBytes.length > 63) throw new NdefError('言語コードが長すぎます（最大 63 バイト）');
  const status = (encoding === 'utf16' ? 0x80 : 0x00) | (langBytes.length & 0x3f);
  const textBytes =
    encoding === 'utf16' ? concatBytes([0xfe, 0xff], utf16beToBytes(text)) : utf8ToBytes(text);
  return concatBytes([status], langBytes, textBytes);
}

function decodeTextDraft(payload: Uint8Array): Extract<NdefRecordDraft, { kind: 'text' }> {
  if (payload.length === 0) return { kind: 'text', text: '', lang: '', encoding: 'utf8' };
  const status = payload[0];
  const utf16 = (status & 0x80) !== 0;
  const langLen = status & 0x3f;
  const lang = bytesToUtf8(payload.slice(1, 1 + langLen));
  const textBytes = payload.slice(1 + langLen);
  let text: string;
  if (utf16) {
    if (textBytes.length >= 2 && textBytes[0] === 0xff && textBytes[1] === 0xfe) {
      text = bytesToUtf16(textBytes.slice(2), true);
    } else if (textBytes.length >= 2 && textBytes[0] === 0xfe && textBytes[1] === 0xff) {
      text = bytesToUtf16(textBytes.slice(2), false);
    } else {
      text = bytesToUtf16(textBytes, false); // default to big-endian per RTD
    }
  } else {
    text = bytesToUtf8(textBytes);
  }
  return { kind: 'text', text, lang, encoding: utf16 ? 'utf16' : 'utf8' };
}

// ---------------------------------------------------------------------------
// Smart Poster (RTD "Sp")
// ---------------------------------------------------------------------------

function encodeSmartPoster(uri: string, title: string, lang: string): Uint8Array {
  const records: NdefRecordRaw[] = [{ tnf: TNF.WELL_KNOWN, type: TYPE_U, id: EMPTY, payload: encodeUriPayload(uri) }];
  if (title !== '') {
    records.push({ tnf: TNF.WELL_KNOWN, type: TYPE_T, id: EMPTY, payload: encodeTextPayload(title, lang, 'utf8') });
  }
  return encodeMessage(records);
}

function decodeSmartPosterDraft(payload: Uint8Array): Extract<NdefRecordDraft, { kind: 'smartposter' }> {
  const inner = decodeMessage(payload);
  let uri = '';
  let title = '';
  let lang = '';
  for (const r of inner) {
    if (r.tnf !== TNF.WELL_KNOWN) continue;
    if (typeEquals(r.type, TYPE_U)) {
      uri = decodeUriString(r.payload);
    } else if (typeEquals(r.type, TYPE_T)) {
      const t = decodeTextDraft(r.payload);
      title = t.text;
      lang = t.lang;
    }
  }
  return { kind: 'smartposter', uri, title, lang };
}

// ---------------------------------------------------------------------------
// encodeDraft / decodeRaw
// ---------------------------------------------------------------------------

/** Editor draft -> wire record. Throws NdefError (Japanese message) on invalid input. */
export function encodeDraft(draft: NdefRecordDraft): NdefRecordRaw {
  switch (draft.kind) {
    case 'empty':
      return { tnf: TNF.EMPTY, type: EMPTY, id: EMPTY, payload: EMPTY };
    case 'uri':
      return { tnf: TNF.WELL_KNOWN, type: TYPE_U, id: EMPTY, payload: encodeUriPayload(draft.uri) };
    case 'text':
      return {
        tnf: TNF.WELL_KNOWN,
        type: TYPE_T,
        id: EMPTY,
        payload: encodeTextPayload(draft.text, draft.lang, draft.encoding),
      };
    case 'wifi':
      return { tnf: TNF.MIME, type: utf8ToBytes(WIFI_MIME), id: EMPTY, payload: encodeWifi(draft) };
    case 'vcard':
      return { tnf: TNF.MIME, type: utf8ToBytes('text/vcard'), id: EMPTY, payload: utf8ToBytes(buildVcard(draft.fields)) };
    case 'mime': {
      if (draft.mimeType.trim() === '') throw new NdefError('MIME タイプを入力してください');
      const payload = draft.payloadHex.trim() !== '' ? hexToBytesSafe(draft.payloadHex, 'ペイロード') : utf8ToBytes(draft.payloadText);
      return { tnf: TNF.MIME, type: utf8ToBytes(draft.mimeType), id: EMPTY, payload };
    }
    case 'aar':
      if (draft.packageName.trim() === '') throw new NdefError('パッケージ名を入力してください');
      return { tnf: TNF.EXTERNAL, type: utf8ToBytes(AAR_TYPE), id: EMPTY, payload: utf8ToBytes(draft.packageName) };
    case 'external': {
      if (!draft.domainType.includes(':')) throw new NdefError('外部タイプは「ドメイン:名前」の形式で入力してください');
      const payload = draft.payloadHex.trim() !== '' ? hexToBytesSafe(draft.payloadHex, 'ペイロード') : utf8ToBytes(draft.payloadText);
      return { tnf: TNF.EXTERNAL, type: utf8ToBytes(draft.domainType), id: EMPTY, payload };
    }
    case 'smartposter':
      return {
        tnf: TNF.WELL_KNOWN,
        type: TYPE_SP,
        id: EMPTY,
        payload: encodeSmartPoster(draft.uri, draft.title, draft.lang),
      };
    case 'raw': {
      if (draft.tnf < 0 || draft.tnf > 7) throw new NdefError('TNF は 0〜7 の範囲で指定してください');
      const type = hexToBytesSafe(draft.typeHex, '型');
      const id = hexToBytesSafe(draft.idHex, 'ID');
      const payload = hexToBytesSafe(draft.payloadHex, 'ペイロード');
      if (type.length > 255) throw new NdefError('型が長すぎます（最大 255 バイト）');
      if (id.length > 255) throw new NdefError('ID が長すぎます（最大 255 バイト）');
      return { tnf: draft.tnf as Tnf, type, id, payload };
    }
    default: {
      const never: never = draft;
      throw new NdefError(`未知のレコード種別です: ${JSON.stringify(never)}`);
    }
  }
}

/** Wire record -> editor draft (best effort; anything unrecognised becomes kind 'raw'). */
export function decodeRaw(raw: NdefRecordRaw): NdefRecordDraft {
  const { tnf, type, payload } = raw;
  if (tnf === TNF.EMPTY) return { kind: 'empty' };

  if (tnf === TNF.WELL_KNOWN) {
    if (typeEquals(type, TYPE_U)) return { kind: 'uri', uri: decodeUriString(payload) };
    if (typeEquals(type, TYPE_T)) return decodeTextDraft(payload);
    if (typeEquals(type, TYPE_SP)) {
      try {
        return decodeSmartPosterDraft(payload);
      } catch {
        return toRawDraft(raw);
      }
    }
    return toRawDraft(raw);
  }

  if (tnf === TNF.MIME) {
    const mime = asciiOf(type);
    if (mime === WIFI_MIME) {
      try {
        return decodeWifi(payload);
      } catch {
        return toRawDraft(raw);
      }
    }
    if (mime === 'text/vcard' || mime === 'text/x-vcard') {
      try {
        return { kind: 'vcard', fields: parseVcard(bytesToUtf8(payload)) };
      } catch {
        return toRawDraft(raw);
      }
    }
    const pt = payloadTextOrHex(payload);
    return { kind: 'mime', mimeType: mime, payloadText: pt.payloadText, payloadHex: pt.payloadHex };
  }

  if (tnf === TNF.EXTERNAL) {
    const t = asciiOf(type);
    if (t.toLowerCase() === AAR_TYPE) return { kind: 'aar', packageName: bytesToUtf8(payload) };
    const pt = payloadTextOrHex(payload);
    return { kind: 'external', domainType: t, payloadText: pt.payloadText, payloadHex: pt.payloadHex };
  }

  return toRawDraft(raw);
}

// ---------------------------------------------------------------------------
// describeDraft / emptyDraft
// ---------------------------------------------------------------------------

function tnfName(tnf: Tnf): string {
  return (
    (['EMPTY', 'Well-Known', 'MIME', 'Absolute URI', 'External', 'Unknown', 'Unchanged', 'Reserved'] as const)[tnf] ??
    `TNF ${tnf}`
  );
}

/** One-line human summary of a draft for lists and logs. */
export function describeDraft(draft: NdefRecordDraft, lang: 'ja' | 'en'): string {
  const ja = lang === 'ja';
  switch (draft.kind) {
    case 'uri':
      return `URI: ${draft.uri || (ja ? '（空）' : '(empty)')}`;
    case 'text':
      return ja ? `テキスト（${draft.lang}）: ${draft.text}` : `Text (${draft.lang}): ${draft.text}`;
    case 'wifi':
      return ja ? `Wi-Fi: ${draft.ssid}` : `Wi-Fi: ${draft.ssid}`;
    case 'vcard':
      return ja ? `連絡先: ${draft.fields.name}` : `Contact: ${draft.fields.name}`;
    case 'mime':
      return ja ? `MIME（${draft.mimeType}）` : `MIME (${draft.mimeType})`;
    case 'aar':
      return ja ? `Android アプリ: ${draft.packageName}` : `Android app: ${draft.packageName}`;
    case 'external':
      return ja ? `外部タイプ: ${draft.domainType}` : `External type: ${draft.domainType}`;
    case 'smartposter':
      return ja ? `スマートポスター: ${draft.uri}` : `Smart Poster: ${draft.uri}`;
    case 'raw': {
      const bytes = draft.payloadHex.replace(/[^0-9a-fA-F]/g, '').length / 2;
      return ja
        ? `RAW（${tnfName(draft.tnf)}・${bytes} バイト）`
        : `RAW (${tnfName(draft.tnf)}, ${bytes} bytes)`;
    }
    case 'empty':
      return ja ? '空レコード' : 'Empty record';
    default: {
      const never: never = draft;
      return String(never);
    }
  }
}

/** A sensible empty draft of the given kind (for the editor's "add record" menu). */
export function emptyDraft(kind: NdefRecordDraft['kind']): NdefRecordDraft {
  switch (kind) {
    case 'uri':
      return { kind: 'uri', uri: '' };
    case 'text':
      return { kind: 'text', text: '', lang: 'en', encoding: 'utf8' };
    case 'wifi':
      return { kind: 'wifi', ssid: '', auth: 'wpa2-personal', encryption: 'aes', password: '', hidden: false };
    case 'vcard':
      return { kind: 'vcard', fields: { name: '' } };
    case 'mime':
      return { kind: 'mime', mimeType: 'text/plain', payloadText: '', payloadHex: '' };
    case 'aar':
      return { kind: 'aar', packageName: '' };
    case 'external':
      return { kind: 'external', domainType: 'example.com:type', payloadText: '', payloadHex: '' };
    case 'smartposter':
      return { kind: 'smartposter', uri: '', title: '', lang: 'en' };
    case 'raw':
      return { kind: 'raw', tnf: TNF.UNKNOWN, typeHex: '', idHex: '', payloadHex: '' };
    case 'empty':
      return { kind: 'empty' };
    default: {
      const never: never = kind;
      throw new NdefError(`未知のレコード種別です: ${String(never)}`);
    }
  }
}
