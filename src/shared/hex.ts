// Pure hex / byte helpers. No Node, no DOM - safe to import from main, preload,
// renderer and tests.

/** Parse a hex string (spaces, colons, dashes and 0x prefixes ignored) into bytes. */
export function hexToBytes(input: string): Uint8Array {
  const clean = input.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`16進数の桁数が奇数です（${clean.length} 桁）`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Bytes -> uppercase hex, optionally grouped with a separator. */
export function bytesToHex(bytes: Uint8Array | number[], sep = ''): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const parts: string[] = [];
  for (const b of arr) parts.push(b.toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(sep);
}

/** Render bytes as printable ASCII, non-printables shown as '.'. */
export function bytesToAscii(bytes: Uint8Array, dot = '.'): string {
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : dot;
  return s;
}

/** Encode a JS string as UTF-8 bytes without relying on TextEncoder availability. */
export function utf8ToBytes(str: string): Uint8Array {
  // TextEncoder exists in Node >=11 and all renderers, but keep a guard for odd hosts.
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Concatenate several byte chunks. */
export function concatBytes(...chunks: (Uint8Array | number[])[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : Uint8Array.from(c), off);
    off += c.length;
  }
  return out;
}

/** Deep equality for byte arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Big-endian unsigned integer -> fixed width bytes. Throws if the value overflows. */
export function uintToBytesBE(value: number | bigint, width: number): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) throw new Error('負の値は符号なしに変換できません');
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`値が ${width} バイトに収まりません`);
  return out;
}

/** Big-endian bytes -> bigint. */
export function bytesToUintBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Encode a non-negative integer as packed BCD of a given byte width. */
export function uintToBcd(value: number | bigint, width: number): Uint8Array {
  const digits = (typeof value === 'bigint' ? value : BigInt(Math.trunc(value))).toString();
  if (digits.length > width * 2) throw new Error(`BCD ${width} バイトに ${digits} は収まりません`);
  const padded = digits.padStart(width * 2, '0');
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    out[i] = (parseInt(padded[i * 2], 10) << 4) | parseInt(padded[i * 2 + 1], 10);
  }
  return out;
}
