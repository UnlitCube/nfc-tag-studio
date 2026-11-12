// Pure, hardware-independent helpers for the PC/SC backend.
//
// Everything here is deterministic and free of `koffi`, Electron, native memory
// and DOM, so the unit tests exercise it without a reader. The parts that must
// touch winscard.dll / libpcsclite / PCSC.framework live in ./winscard.ts and
// are verified by the integrator on real hardware.
//
// Design invariant reminder (I1/I2): the backend only transmits APDUs; it never
// has a notion of writing a UID or of magic-card backdoors. It is a dumb pipe.

import type { ReaderInfo } from '@shared/types';
import type { ErrorCode } from '@shared/types';
import { bytesToHex } from '@shared/hex';
import { isLikelyContactlessReader } from '@shared/reader';
import { OpError } from '../../errors';

// ---------------------------------------------------------------------------
// PC/SC constants (shared by the Windows "W" API and pcsclite)
// ---------------------------------------------------------------------------

export const SCARD_SCOPE_SYSTEM = 2;

export const SCARD_SHARE_SHARED = 2;
export const SCARD_SHARE_EXCLUSIVE = 1;
export const SCARD_SHARE_DIRECT = 3;

export const SCARD_PROTOCOL_T0 = 1;
export const SCARD_PROTOCOL_T1 = 2;
export const SCARD_PROTOCOL_T0_OR_T1 = SCARD_PROTOCOL_T0 | SCARD_PROTOCOL_T1; // 3

export const SCARD_LEAVE_CARD = 0;

/** dwCurrentState / dwEventState bit flags (SCARD_STATE_*). */
export const SCARD_STATE_UNAWARE = 0x0000;
export const SCARD_STATE_IGNORE = 0x0001;
export const SCARD_STATE_CHANGED = 0x0002;
export const SCARD_STATE_UNKNOWN = 0x0004;
export const SCARD_STATE_UNAVAILABLE = 0x0008;
export const SCARD_STATE_EMPTY = 0x0010;
export const SCARD_STATE_PRESENT = 0x0020;
export const SCARD_STATE_ATRMATCH = 0x0040;
export const SCARD_STATE_EXCLUSIVE = 0x0080;
export const SCARD_STATE_INUSE = 0x0100;
export const SCARD_STATE_MUTE = 0x0200;
export const SCARD_STATE_UNPOWERED = 0x0400;

/** Max ATR length in a SCARD_READERSTATE (rgbAtr[36]). */
export const MAX_ATR_SIZE = 36;

/**
 * The pseudo-reader that reports reader add / remove through
 * SCardGetStatusChange. Backslashes are literal: \\?PnP?\Notification.
 */
export const PNP_NOTIFICATION = '\\\\?PnP?\\Notification';

// ---------------------------------------------------------------------------
// PC/SC return codes (SCARD_* HRESULT-style LONGs, as unsigned 32-bit)
// ---------------------------------------------------------------------------

export const SCARD_S_SUCCESS = 0x00000000;
export const SCARD_F_INTERNAL_ERROR = 0x80100001;
export const SCARD_E_CANCELLED = 0x80100002;
export const SCARD_E_INVALID_HANDLE = 0x80100003;
export const SCARD_E_INVALID_PARAMETER = 0x80100004;
export const SCARD_E_NO_MEMORY = 0x80100006;
export const SCARD_E_INSUFFICIENT_BUFFER = 0x80100008;
export const SCARD_E_UNKNOWN_READER = 0x80100009;
export const SCARD_E_TIMEOUT = 0x8010000a;
export const SCARD_E_SHARING_VIOLATION = 0x8010000b;
export const SCARD_E_NO_SMARTCARD = 0x8010000c;
export const SCARD_E_UNKNOWN_CARD = 0x8010000d;
export const SCARD_E_PROTO_MISMATCH = 0x8010000f;
export const SCARD_E_NOT_READY = 0x80100010;
export const SCARD_E_INVALID_VALUE = 0x80100011;
export const SCARD_E_SYSTEM_CANCELLED = 0x80100012;
export const SCARD_F_COMM_ERROR = 0x80100013;
export const SCARD_F_UNKNOWN_ERROR = 0x80100014;
export const SCARD_E_NOT_TRANSACTED = 0x80100016;
export const SCARD_E_READER_UNAVAILABLE = 0x80100017;
export const SCARD_E_NO_SERVICE = 0x8010001d;
export const SCARD_E_SERVICE_STOPPED = 0x8010001e;
export const SCARD_E_CARD_UNSUPPORTED = 0x8010001c;
export const SCARD_E_NO_READERS_AVAILABLE = 0x8010002e;
export const SCARD_E_COMM_DATA_LOST = 0x8010002f;
export const SCARD_W_UNSUPPORTED_CARD = 0x80100065;
export const SCARD_W_UNRESPONSIVE_CARD = 0x80100066;
export const SCARD_W_UNPOWERED_CARD = 0x80100067;
export const SCARD_W_RESET_CARD = 0x80100068;
export const SCARD_W_REMOVED_CARD = 0x80100069;

/** Normalise a koffi `long` return (signed 32-bit or 64-bit bigint) to u32. */
export function normalizeRv(rv: number | bigint): number {
  return Number(rv) >>> 0;
}

export function isOk(rv: number | bigint): boolean {
  return normalizeRv(rv) === SCARD_S_SUCCESS;
}

/** The PC/SC service itself is down / missing (not just "no readers"). */
export function isServiceUnavailableRv(rv: number | bigint): boolean {
  const c = normalizeRv(rv);
  return c === SCARD_E_NO_SERVICE || c === SCARD_E_SERVICE_STOPPED;
}

/**
 * The service is down only because no reader is connected. Windows 8+ starts
 * the Smart Card service (SCardSvr) when a reader is plugged in and stops it
 * after the last one is removed, so SCARD_E_NO_SERVICE / SERVICE_STOPPED is the
 * normal "no reader" state there - telling the operator "the service is stopped"
 * sends them to services.msc when they only need to plug the reader in
 * (2026-11-12 UX audit CARD-8). On Linux / macOS (pcscd) it does mean the
 * daemon is missing.
 */
export function serviceDownMeansNoReaders(rv: number | bigint, platform: string): boolean {
  return platform === 'win32' && isServiceUnavailableRv(rv);
}

/** No reader is connected (distinct from "no card on a reader"). */
export function isNoReadersRv(rv: number | bigint): boolean {
  const c = normalizeRv(rv);
  return c === SCARD_E_NO_READERS_AVAILABLE;
}

/** The card left the field / was reset mid-operation. */
export function isRemovedCardRv(rv: number | bigint): boolean {
  const c = normalizeRv(rv);
  return c === SCARD_W_REMOVED_CARD || c === SCARD_W_RESET_CARD || c === SCARD_W_UNPOWERED_CARD;
}

/** Human-readable name of a return code (for diagnostics; never secrets). */
export function rvName(rv: number | bigint): string {
  const c = normalizeRv(rv);
  return RV_NAMES[c] ?? `0x${c.toString(16).toUpperCase().padStart(8, '0')}`;
}

const RV_NAMES: Record<number, string> = {
  [SCARD_S_SUCCESS]: 'SCARD_S_SUCCESS',
  [SCARD_F_INTERNAL_ERROR]: 'SCARD_F_INTERNAL_ERROR',
  [SCARD_E_CANCELLED]: 'SCARD_E_CANCELLED',
  [SCARD_E_INVALID_HANDLE]: 'SCARD_E_INVALID_HANDLE',
  [SCARD_E_INVALID_PARAMETER]: 'SCARD_E_INVALID_PARAMETER',
  [SCARD_E_NO_MEMORY]: 'SCARD_E_NO_MEMORY',
  [SCARD_E_INSUFFICIENT_BUFFER]: 'SCARD_E_INSUFFICIENT_BUFFER',
  [SCARD_E_UNKNOWN_READER]: 'SCARD_E_UNKNOWN_READER',
  [SCARD_E_TIMEOUT]: 'SCARD_E_TIMEOUT',
  [SCARD_E_SHARING_VIOLATION]: 'SCARD_E_SHARING_VIOLATION',
  [SCARD_E_NO_SMARTCARD]: 'SCARD_E_NO_SMARTCARD',
  [SCARD_E_UNKNOWN_CARD]: 'SCARD_E_UNKNOWN_CARD',
  [SCARD_E_PROTO_MISMATCH]: 'SCARD_E_PROTO_MISMATCH',
  [SCARD_E_NOT_READY]: 'SCARD_E_NOT_READY',
  [SCARD_E_INVALID_VALUE]: 'SCARD_E_INVALID_VALUE',
  [SCARD_E_SYSTEM_CANCELLED]: 'SCARD_E_SYSTEM_CANCELLED',
  [SCARD_F_COMM_ERROR]: 'SCARD_F_COMM_ERROR',
  [SCARD_F_UNKNOWN_ERROR]: 'SCARD_F_UNKNOWN_ERROR',
  [SCARD_E_NOT_TRANSACTED]: 'SCARD_E_NOT_TRANSACTED',
  [SCARD_E_READER_UNAVAILABLE]: 'SCARD_E_READER_UNAVAILABLE',
  [SCARD_E_CARD_UNSUPPORTED]: 'SCARD_E_CARD_UNSUPPORTED',
  [SCARD_E_NO_SERVICE]: 'SCARD_E_NO_SERVICE',
  [SCARD_E_SERVICE_STOPPED]: 'SCARD_E_SERVICE_STOPPED',
  [SCARD_E_NO_READERS_AVAILABLE]: 'SCARD_E_NO_READERS_AVAILABLE',
  [SCARD_E_COMM_DATA_LOST]: 'SCARD_E_COMM_DATA_LOST',
  [SCARD_W_UNSUPPORTED_CARD]: 'SCARD_W_UNSUPPORTED_CARD',
  [SCARD_W_UNRESPONSIVE_CARD]: 'SCARD_W_UNRESPONSIVE_CARD',
  [SCARD_W_UNPOWERED_CARD]: 'SCARD_W_UNPOWERED_CARD',
  [SCARD_W_RESET_CARD]: 'SCARD_W_RESET_CARD',
  [SCARD_W_REMOVED_CARD]: 'SCARD_W_REMOVED_CARD',
};

/**
 * Map a PC/SC return code to an app ErrorCode (secrets never involved).
 * 2026-11-12 UX audit FIRST-10 / CARD-11: the code decides what the operator is
 * told to do, so
 *  - SHARING_VIOLATION = another application holds the reader -> READER_IN_USE
 *    ("close the other app"), not BUSY ("wait for this app's own operation");
 *  - UNRESPONSIVE_CARD = the tag does not answer (badly placed) -> CARD_UNRESPONSIVE
 *    ("re-place it"), not UNSUPPORTED_TAG (which made people throw good tags away).
 */
export function pcscErrorCode(rv: number | bigint): ErrorCode {
  const c = normalizeRv(rv);
  switch (c) {
    case SCARD_E_NO_SERVICE:
    case SCARD_E_SERVICE_STOPPED:
      return 'NO_SERVICE';
    case SCARD_E_NO_READERS_AVAILABLE:
    case SCARD_E_READER_UNAVAILABLE:
    case SCARD_E_UNKNOWN_READER:
      return 'NO_READER';
    case SCARD_E_NO_SMARTCARD:
    case SCARD_E_NOT_READY:
      return 'NO_CARD';
    case SCARD_W_REMOVED_CARD:
    case SCARD_W_RESET_CARD:
    case SCARD_W_UNPOWERED_CARD:
      return 'CARD_REMOVED';
    case SCARD_E_SHARING_VIOLATION:
      return 'READER_IN_USE';
    case SCARD_W_UNRESPONSIVE_CARD:
      return 'CARD_UNRESPONSIVE';
    case SCARD_E_CARD_UNSUPPORTED:
    case SCARD_W_UNSUPPORTED_CARD:
    case SCARD_E_UNKNOWN_CARD:
    case SCARD_E_PROTO_MISMATCH:
      return 'UNSUPPORTED_TAG';
    case SCARD_E_CANCELLED:
    case SCARD_E_SYSTEM_CANCELLED:
      return 'CANCELLED';
    case SCARD_E_TIMEOUT:
    case SCARD_F_COMM_ERROR:
    case SCARD_E_COMM_DATA_LOST:
    case SCARD_E_NOT_TRANSACTED:
      return 'READ_FAILED';
    case SCARD_E_INVALID_HANDLE:
    case SCARD_E_INVALID_PARAMETER:
    case SCARD_E_INVALID_VALUE:
    case SCARD_E_NO_MEMORY:
    case SCARD_F_INTERNAL_ERROR:
    case SCARD_F_UNKNOWN_ERROR:
      return 'INTERNAL';
    default:
      return 'INTERNAL';
  }
}

/** Build an OpError for a failed PC/SC call. `detail` carries only the code name. */
export function opErrorForPcsc(rv: number | bigint): OpError {
  return new OpError(pcscErrorCode(rv), rvName(rv));
}

// ---------------------------------------------------------------------------
// Reader-list (multi-string) parsing
// ---------------------------------------------------------------------------

/**
 * Parse a PC/SC multi-string of reader names. SCardListReadersW returns a
 * sequence of NUL-terminated UTF-16 strings ending in an extra NUL
 * ("R1\0R2\0\0"). `wchars` is the raw WCHAR buffer; `count` (optional) is the
 * valid wide-char length reported by pcchReaders. Empty names are dropped.
 */
export function parseReaderNamesW(wchars: Uint16Array | number[], count?: number): string[] {
  const n = count == null ? wchars.length : Math.min(count, wchars.length);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < n; i++) {
    const code = wchars[i];
    if (code === 0) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      } else {
        // Double NUL -> end of list.
        break;
      }
    } else {
      cur += String.fromCharCode(code);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Parse a PC/SC multi-string of reader names from a single-byte (ANSI / UTF-8)
 * buffer, as libpcsclite's SCardListReaders returns on Linux / macOS.
 */
export function parseReaderNamesA(bytes: Uint8Array | number[], count?: number): string[] {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const n = count == null ? arr.length : Math.min(count, arr.length);
  const out: string[] = [];
  let start = 0;
  let i = 0;
  for (; i < n; i++) {
    if (arr[i] === 0) {
      if (i > start) {
        out.push(utf8Slice(arr, start, i));
      } else {
        break; // double NUL
      }
      start = i + 1;
    }
  }
  if (i > start && start < n) out.push(utf8Slice(arr, start, Math.min(i, n)));
  return out;
}

function utf8Slice(bytes: Uint8Array, start: number, end: number): string {
  const sub = bytes.subarray(start, end);
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(sub);
  let s = '';
  for (const b of sub) s += String.fromCharCode(b);
  return s;
}

// ---------------------------------------------------------------------------
// ATR + status -> ReaderInfo
// ---------------------------------------------------------------------------

/** Slice the valid ATR bytes out of a fixed 36-byte rgbAtr buffer. */
export function extractAtr(rgbAtr: Uint8Array | number[], cbAtr: number): Uint8Array {
  const arr = rgbAtr instanceof Uint8Array ? rgbAtr : Uint8Array.from(rgbAtr);
  const len = Math.max(0, Math.min(cbAtr, arr.length, MAX_ATR_SIZE));
  return arr.slice(0, len);
}

/** A card is present on the reader, per dwEventState. */
export function isPresent(eventState: number): boolean {
  return (eventState & SCARD_STATE_PRESENT) !== 0;
}

/** Another process holds the reader (SCARD_STATE_INUSE). */
export function isInUse(eventState: number): boolean {
  return (eventState & SCARD_STATE_INUSE) !== 0;
}

/**
 * SCARD_STATE_INUSE as the UI should see it ("another app is using the reader").
 * Windows sets the flag for ANY open handle - our own read included - and for a
 * moment while its smart-card plug-and-play probes a newly placed card. On the
 * real PaSoRi (2026-11-13) the raw flag flashed the warning ~0.3 s after every
 * read of ours. So: never while / just after OUR connection holds the reader
 * (`ours`), and only once it lasted two polls in a row. Pure.
 */
export function effectiveInUse(raw: boolean, ours: boolean, prevStreak: number): { inUse: boolean; streak: number } {
  if (!raw || ours) return { inUse: false, streak: 0 };
  const streak = prevStreak + 1;
  return { inUse: streak >= 2, streak };
}

/**
 * Card insertion/removal counter carried in the upper 16 bits of dwEventState
 * (Windows and pcsc-lite convention; the dev PC's token reported 0x00010422).
 * A tag replaced by another between two polls keeps PRESENT set, so presence
 * alone misses the swap - the counter (or the ATR) still changes.
 * NOTE: not yet verified with a real swap on a PaSoRi; callers treat a change
 * only as "possibly swapped" and confirm by reading the UID.
 */
export function eventCountOf(eventState: number): number {
  return (eventState >>> 16) & 0xffff;
}

/** The tag may have been replaced while the reader kept reporting PRESENT. */
export function cardSwapSuspected(
  before: { atr: Uint8Array; events: number | null },
  now: { atr: Uint8Array; events: number | null },
): boolean {
  if (before.events !== null && now.events !== null && before.events !== now.events) return true;
  if (before.atr.length > 0 && now.atr.length > 0) {
    if (before.atr.length !== now.atr.length) return true;
    for (let i = 0; i < now.atr.length; i++) if (before.atr[i] !== now.atr[i]) return true;
  }
  return false;
}

/**
 * Build the ReaderInfo snapshot for one reader from its name, dwEventState and
 * the ATR of the present card (null / empty when no card). `likelyContactless`
 * reuses the shared heuristic so USB security tokens are not treated as NFC
 * readers (I6).
 */
export function readerInfoFrom(name: string, eventState: number, atr: Uint8Array | null): ReaderInfo {
  const present = isPresent(eventState);
  const atrBytes = present && atr && atr.length > 0 ? atr : null;
  return {
    name,
    likelyContactless: isLikelyContactlessReader(name, atrBytes),
    cardPresent: present,
    inUse: isInUse(eventState),
    atr: atrBytes ? bytesToHex(atrBytes) : null,
    virtual: false,
  };
}

/** Stable equality for a reader-list snapshot (to debounce 'readers' events). */
export function readerListEqual(a: ReaderInfo[], b: ReaderInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.likelyContactless !== y.likelyContactless ||
      x.cardPresent !== y.cardPresent ||
      x.inUse !== y.inUse ||
      x.atr !== y.atr ||
      x.virtual !== y.virtual
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// APDU response / status word
// ---------------------------------------------------------------------------

/** The trailing SW1 SW2 of a response as a 16-bit value (0 when too short). */
export function statusWord(resp: Uint8Array): number {
  if (resp.length < 2) return 0;
  return (resp[resp.length - 2] << 8) | resp[resp.length - 1];
}

/** True when the response ends in 90 00. */
export function isSuccessSw(resp: Uint8Array): boolean {
  return statusWord(resp) === 0x9000;
}
