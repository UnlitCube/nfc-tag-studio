// Checksum / CRC algorithms over encoded field bytes.
//
// Pure TypeScript: no Node, no DOM.

import type { ChecksumAlgo } from './types';

/** Number of bytes a checksum algorithm produces. */
export function checksumWidth(algo: ChecksumAlgo): number {
  switch (algo) {
    case 'xor8':
    case 'sum8':
    case 'luhn':
      return 1;
    case 'crc16-ccitt':
      return 2;
    case 'crc32':
      return 4;
  }
}

function xor8(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v ^= b;
  return v & 0xff;
}

function sum8(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = (v + b) & 0xff;
  return v & 0xff;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. */
function crc16ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** CRC-32/IEEE (reflected): poly 0xEDB88320, init 0xFFFFFFFF, final xor 0xFFFFFFFF. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Luhn check digit. The input bytes are read as ASCII text; the decimal digits
 * (0x30-0x39) among them form the payload, and the single check digit that makes
 * the whole string Luhn-valid is returned as one ASCII byte.
 */
function luhnDigit(bytes: Uint8Array): number {
  const digits: number[] = [];
  for (const b of bytes) if (b >= 0x30 && b <= 0x39) digits.push(b - 0x30);
  let sum = 0;
  let dbl = true; // the position just left of the (future) check digit doubles
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  const check = (10 - (sum % 10)) % 10;
  return 0x30 + check;
}

/**
 * Checksum bytes:
 *  xor8 / sum8   -> 1 byte
 *  crc16-ccitt   -> 2 bytes big-endian (0x1021, init 0xFFFF)
 *  crc32         -> 4 bytes big-endian (IEEE)
 *  luhn          -> 1 ASCII digit
 */
export function checksum(algo: ChecksumAlgo, bytes: Uint8Array): Uint8Array {
  switch (algo) {
    case 'xor8':
      return Uint8Array.from([xor8(bytes)]);
    case 'sum8':
      return Uint8Array.from([sum8(bytes)]);
    case 'crc16-ccitt': {
      const v = crc16ccitt(bytes);
      return Uint8Array.from([(v >> 8) & 0xff, v & 0xff]);
    }
    case 'crc32': {
      const v = crc32(bytes);
      return Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
    }
    case 'luhn':
      return Uint8Array.from([luhnDigit(bytes)]);
  }
}
