// Tag image helpers, write planning, NTAG config / MIFARE trailer codecs and dump
// file formats - PUBLIC API (signatures frozen by the integrator).
// Owner: agent "shared-tag". Implement in this directory (e.g. image.ts, plan.ts,
// ntag.ts, mifare.ts, dump-project.ts, dump-bin.ts, dump-flipper.ts) and re-export
// from here. Do NOT change names/parameters/return types.
//
// Pure TypeScript: no Node, no DOM. Basic layout facts live in ../tags.ts
// (integrator-owned) - build on them, do not duplicate.

import type { AccessBits, TagKind } from '../tags';
import type { TagImage, UnitWrite } from '../types';

const NI = (fn: string): never => {
  throw new Error(`tag.${fn}: not implemented`);
};

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/** Factory-fresh image wrapped as TagImage (all units 'ok'). uid = hex of 7 (NTAG) / 4 (MIFARE) bytes. */
export function blankImage(kind: TagKind, uid: string): TagImage {
  void kind;
  void uid;
  return NI('blankImage');
}

/** Deep copy. */
export function cloneImage(img: TagImage): TagImage {
  void img;
  return NI('cloneImage');
}

/** Bytes of one unit (copy). */
export function unitBytes(kind: TagKind, data: Uint8Array, unit: number): Uint8Array {
  void kind;
  void data;
  void unit;
  return NI('unitBytes');
}

/** Indices of units whose bytes differ between a and b (same kind/size). */
export function diffUnits(kind: TagKind, a: Uint8Array, b: Uint8Array): number[] {
  void kind;
  void a;
  void b;
  return NI('diffUnits');
}

/**
 * True when the writable data area carries no operator data:
 * NTAG - user area has no NDEF message with records (empty TLV 03 00 or all zero);
 * MIFARE - every readable data block (excluding block 0 and trailers) is all zero.
 */
export function isBlankDataArea(kind: TagKind, data: Uint8Array): boolean {
  void kind;
  void data;
  return NI('isBlankDataArea');
}

// ---------------------------------------------------------------------------
// Write planning
// ---------------------------------------------------------------------------

export type PlanWarningCode =
  | 'UID_READONLY'
  | 'CC_OTP'
  | 'LOCK_IRREVERSIBLE'
  | 'CONFIG'
  | 'PASSWORD'
  | 'TRAILER'
  | 'ACCESS_BITS_INVALID'
  | 'UNREAD_UNIT';

export interface PlanWarning {
  unit: number | null;
  code: PlanWarningCode;
  severity: 'info' | 'warn' | 'danger';
  /** Japanese message for the operator. */
  message: string;
}

export interface WritePlan {
  /** Units to write, in address order (password-related writes reordered safely: PWD, PACK, CFG1, CFG0). */
  writes: UnitWrite[];
  /** Changed units that are protected (included in writes only when includeProtected). */
  protectedUnits: number[];
  /** Changed units that can never be written (UID pages, block 0, invalid trailers). Never in writes. */
  forbiddenUnits: number[];
  warnings: PlanWarning[];
}

/**
 * Compare the image as read (`base`) with the edited bytes and plan the minimal
 * set of unit writes. Rules:
 * - forbidden units (isForbiddenUnit) are never written -> forbiddenUnits + UID_READONLY warning
 * - protected units only when includeProtected; each gets a warning (CC_OTP / LOCK_IRREVERSIBLE / CONFIG / PASSWORD / TRAILER)
 * - a MIFARE trailer whose access bits do not parse (parseAccessBits === null) is forbidden (ACCESS_BITS_INVALID, danger)
 * - units that were not readable in `base` (unitStatus !== 'ok') get UNREAD_UNIT warnings
 * - NTAG lock bytes / CC are OTP (bits only set): warn when an edit tries to clear a bit
 */
export function planWrites(kind: TagKind, base: TagImage, edited: Uint8Array, opts: { includeProtected: boolean }): WritePlan {
  void kind;
  void base;
  void edited;
  void opts;
  return NI('planWrites');
}

// ---------------------------------------------------------------------------
// NTAG21x configuration
// ---------------------------------------------------------------------------

export interface NtagConfig {
  mirror: { conf: 'none' | 'uid' | 'counter' | 'both'; byte: number; page: number };
  strongModulation: boolean;
  /** First page protected by the password (0xFF = protection off). */
  auth0: number;
  /** true = read and write protected, false = write protected only. */
  prot: boolean;
  /** Config pages permanently locked (irreversible). */
  cfgLock: boolean;
  counterEnabled: boolean;
  counterPwdProtected: boolean;
  /** 0 = unlimited negative PWD_AUTH attempts, else 2^authLimit. */
  authLimit: number;
}

export function readNtagConfig(kind: TagKind, data: Uint8Array): NtagConfig {
  void kind;
  void data;
  return NI('readNtagConfig');
}

/** CFG0 + CFG1 unit writes for `cfg` (keeps RFUI bytes from data). */
export function buildNtagConfigWrites(kind: TagKind, data: Uint8Array, cfg: NtagConfig): UnitWrite[] {
  void kind;
  void data;
  void cfg;
  return NI('buildNtagConfigWrites');
}

export interface NtagLockState {
  /** Pages locked by static or dynamic lock bits. */
  lockedPages: number[];
  /** CC page locked. */
  ccLocked: boolean;
  /** Static/dynamic block-lock bits set (lock bits themselves frozen). */
  blockLocked: boolean;
}

export function readNtagLockState(kind: TagKind, data: Uint8Array): NtagLockState {
  void kind;
  void data;
  return NI('readNtagLockState');
}

/**
 * Password protection setup. Returns writes in safe order: PWD, PACK, CFG1 (PROT,
 * AUTHLIM), CFG0 (AUTH0) last. password = 8 hex, pack = 4 hex.
 */
export function buildNtagPasswordWrites(
  kind: TagKind,
  data: Uint8Array,
  opts: { password: string; pack: string; auth0: number; protectRead: boolean; authLimit: number },
): UnitWrite[] {
  void kind;
  void data;
  void opts;
  return NI('buildNtagPasswordWrites');
}

/** Disable protection (AUTH0 = 0xFF). Caller must authenticate with the current password. */
export function buildNtagRemovePasswordWrites(kind: TagKind, data: Uint8Array): UnitWrite[] {
  void kind;
  void data;
  return NI('buildNtagRemovePasswordWrites');
}

/** Enable/disable the NFC counter (CFG1 NFC_CNT_EN). */
export function buildNtagCounterWrites(kind: TagKind, data: Uint8Array, enabled: boolean): UnitWrite[] {
  void kind;
  void data;
  void enabled;
  return NI('buildNtagCounterWrites');
}

/** IRREVERSIBLE: set static + dynamic lock bits so the user area becomes read-only forever. */
export function buildNtagLockUserAreaWrites(kind: TagKind, data: Uint8Array): UnitWrite[] {
  void kind;
  void data;
  return NI('buildNtagLockUserAreaWrites');
}

// ---------------------------------------------------------------------------
// MIFARE Classic
// ---------------------------------------------------------------------------

/** Plain-language access rights of one block group, derived from C1C2C3. */
export interface AccessDescription {
  read: 'never' | 'A' | 'B' | 'AB';
  write: 'never' | 'A' | 'B' | 'AB';
  /** For data blocks; null for trailer. */
  increment: 'never' | 'A' | 'B' | 'AB' | null;
  decrementTransferRestore: 'never' | 'A' | 'B' | 'AB' | null;
  /** Japanese one-liner. */
  summary: string;
}

/** Describe group i (0..2 data, 3 trailer) of decoded access bits. */
export function describeAccess(bits: AccessBits, group: 0 | 1 | 2 | 3): AccessDescription {
  void bits;
  void group;
  return NI('describeAccess');
}

/** Build a 16-byte sector trailer. Throws when keys are not 6 bytes. */
export function buildTrailer(keyA: Uint8Array, access: AccessBits, keyB: Uint8Array): Uint8Array {
  void keyA;
  void access;
  void keyB;
  return NI('buildTrailer');
}

// ---------------------------------------------------------------------------
// Dump file formats
// ---------------------------------------------------------------------------

export type DumpFormat = 'project' | 'bin' | 'flipper';

/**
 * Native format (*.nfcdump, UTF-8 JSON):
 * { format: "nfc-tag-studio/dump", version: 1, kind, uid, unitSize, units: ["hex", ...],
 *   unitStatus, ntag?, mifare?, note, savedAt, app: { name, version } }
 */
export function serializeProject(img: TagImage, meta: { note: string; appVersion: string; savedAt: string }): Uint8Array {
  void img;
  void meta;
  return NI('serializeProject');
}

export function parseProject(bytes: Uint8Array): { image: TagImage; note: string } {
  void bytes;
  return NI('parseProject');
}

/** Raw memory image (all units concatenated). */
export function exportBin(img: TagImage): Uint8Array {
  void img;
  return NI('exportBin');
}

/** Raw image -> TagImage. Kind from size (180/540/924/1024/4096) unless kindHint given; uid from the header. */
export function importBin(bytes: Uint8Array, kindHint?: TagKind): TagImage {
  void bytes;
  void kindHint;
  return NI('importBin');
}

/** Flipper Zero ".nfc" text (NTAG213/215/216 and MIFARE Classic 1K/4K). */
export function exportFlipper(img: TagImage): string {
  void img;
  return NI('exportFlipper');
}

export function importFlipper(text: string): TagImage {
  void text;
  return NI('importFlipper');
}

/** Detect by extension + content sniffing. */
export function detectDumpFormat(fileName: string, bytes: Uint8Array): DumpFormat | null {
  void fileName;
  void bytes;
  return NI('detectDumpFormat');
}

/** Detect + parse. Throws Error with a Japanese message when the file is not a supported dump. */
export function importDump(fileName: string, bytes: Uint8Array, kindHint?: TagKind): { image: TagImage; note: string; format: DumpFormat } {
  void fileName;
  void bytes;
  void kindHint;
  return NI('importDump');
}
