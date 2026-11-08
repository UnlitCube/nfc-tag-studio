// NDEF message codec (record list <-> wire bytes). Operates on NdefRecordRaw
// (bytes as they appear on the tag), not editor drafts. Pure TypeScript.
//
// Message layout per NFC Forum NDEF spec:
//   header byte = MB ME CF SR IL TNF(3 bits)
//   TYPE LENGTH (1 byte)
//   PAYLOAD LENGTH (1 byte when SR, else 4 bytes big-endian)
//   ID LENGTH (1 byte, present only when IL)
//   TYPE, ID, PAYLOAD

import { concatBytes } from '../hex';
import { NdefError, TNF } from './types';
import type { NdefRecordRaw, Tnf } from './types';

const FLAG_MB = 0x80;
const FLAG_ME = 0x40;
const FLAG_CF = 0x20;
const FLAG_SR = 0x10;
const FLAG_IL = 0x08;

/** The canonical empty-record message: MB|ME|SR, TNF=EMPTY, no type/id/payload. */
const EMPTY_MESSAGE = Uint8Array.from([0xd0, 0x00, 0x00]);

/** Records -> NDEF message bytes (sets MB/ME, uses SR when payload < 256, IL when id present). */
export function encodeMessage(records: NdefRecordRaw[]): Uint8Array {
  if (records.length === 0) return EMPTY_MESSAGE.slice();
  const parts: Uint8Array[] = [];
  records.forEach((r, idx) => {
    const sr = r.payload.length < 256;
    const il = r.id.length > 0;
    let flags = r.tnf & 0x07;
    if (idx === 0) flags |= FLAG_MB;
    if (idx === records.length - 1) flags |= FLAG_ME;
    if (sr) flags |= FLAG_SR;
    if (il) flags |= FLAG_IL;
    const head: number[] = [flags, r.type.length & 0xff];
    if (sr) {
      head.push(r.payload.length & 0xff);
    } else {
      const n = r.payload.length >>> 0;
      head.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    }
    if (il) head.push(r.id.length & 0xff);
    parts.push(Uint8Array.from(head), r.type, r.id, r.payload);
  });
  return concatBytes(...parts);
}

/** NDEF message bytes -> records. Throws NdefError with offset on malformed input. Handles chunked records (CF). */
export function decodeMessage(bytes: Uint8Array): NdefRecordRaw[] {
  const out: NdefRecordRaw[] = [];
  if (bytes.length === 0) return out;
  let i = 0;
  let first = true;

  const need = (count: number, at: number, what: string): void => {
    if (i + count > bytes.length) throw new NdefError(`${what}の途中でメッセージが終わりました`, at);
  };

  while (i < bytes.length) {
    const recStart = i;
    const header = bytes[i];
    const mb = (header & FLAG_MB) !== 0;
    if (first && !mb) throw new NdefError('最初のレコードに MB フラグがありません', recStart);
    const tnf = (header & 0x07) as Tnf;
    const cf = (header & FLAG_CF) !== 0;
    const sr = (header & FLAG_SR) !== 0;
    const il = (header & FLAG_IL) !== 0;
    i += 1;

    need(1, recStart, '型長');
    const typeLen = bytes[i];
    i += 1;

    let payloadLen: number;
    if (sr) {
      need(1, recStart, 'ペイロード長');
      payloadLen = bytes[i];
      i += 1;
    } else {
      need(4, recStart, 'ペイロード長');
      payloadLen = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      i += 4;
    }

    let idLen = 0;
    if (il) {
      need(1, recStart, 'ID 長');
      idLen = bytes[i];
      i += 1;
    }

    need(typeLen, recStart, '型');
    const type = bytes.slice(i, i + typeLen);
    i += typeLen;

    need(idLen, recStart, 'ID');
    const id = bytes.slice(i, i + idLen);
    i += idLen;

    need(payloadLen, recStart, 'ペイロード');
    let payload: Uint8Array = bytes.slice(i, i + payloadLen);
    i += payloadLen;

    let closingMe = (header & FLAG_ME) !== 0;

    if (cf) {
      // Chunked record: gather continuation chunks (TNF=UNCHANGED, type length 0)
      // until a chunk without CF closes the group.
      const pieces: Uint8Array[] = [payload];
      for (;;) {
        if (i >= bytes.length) throw new NdefError('チャンクレコードが閉じていません', recStart);
        const chStart = i;
        const ch = bytes[i];
        const chCf = (ch & FLAG_CF) !== 0;
        const chSr = (ch & FLAG_SR) !== 0;
        const chIl = (ch & FLAG_IL) !== 0;
        const chMe = (ch & FLAG_ME) !== 0;
        if ((ch & 0x07) !== TNF.UNCHANGED) {
          throw new NdefError('継続チャンクの TNF が UNCHANGED (0x06) ではありません', chStart);
        }
        i += 1;
        need(1, chStart, '型長');
        const chTypeLen = bytes[i];
        i += 1;
        if (chTypeLen !== 0) throw new NdefError('継続チャンクに型があります', chStart);
        let chPayLen: number;
        if (chSr) {
          need(1, chStart, 'ペイロード長');
          chPayLen = bytes[i];
          i += 1;
        } else {
          need(4, chStart, 'ペイロード長');
          chPayLen = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
          i += 4;
        }
        if (chIl) {
          need(1, chStart, 'ID 長');
          i += 1 + bytes[i];
        }
        need(chPayLen, chStart, 'ペイロード');
        pieces.push(bytes.slice(i, i + chPayLen));
        i += chPayLen;
        if (!chCf) {
          closingMe = chMe;
          break;
        }
      }
      payload = concatBytes(...pieces);
    }

    out.push({ tnf, type, id, payload });
    first = false;

    if (closingMe) {
      if (i !== bytes.length) throw new NdefError('ME レコードの後に余分なバイトがあります', i);
      return out;
    }
  }

  throw new NdefError('ME フラグ（メッセージ終端）が見つかりません', bytes.length);
}
