// NTAG21x configuration, lock state and password/counter write builders.
// Bit layouts follow the NXP NTAG213/215/216 data sheet (CFG0 / CFG1, static +
// dynamic lock bytes). See docs/research/ntag-mifare.md.
// Pure TypeScript: no Node, no DOM.

import { hexToBytes } from '../hex';
import { type TagKind, ntagPages } from '../tags';
import type { UnitWrite } from '../types';

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

const CONF: NtagConfig['mirror']['conf'][] = ['none', 'uid', 'counter', 'both'];

// CFG1 byte 0 (ACCESS) bit masks.
const PROT = 0x80;
const CFGLCK = 0x40;
const RFUI_CFG1 = 0x20;
const NFC_CNT_EN = 0x10;
const NFC_CNT_PWD = 0x08;
const AUTHLIM = 0x07;
// CFG0 byte 0: RFUI bits (3, 1, 0) preserved on write.
const RFUI_CFG0 = 0x0b;
const STRG_MOD = 0x04; // CFG0 byte 0 bit 2

function cfgBytes(data: Uint8Array, page: number): Uint8Array {
  return data.slice(page * 4, page * 4 + 4);
}

export function readNtagConfig(kind: TagKind, data: Uint8Array): NtagConfig {
  const p = ntagPages(kind);
  const c0 = cfgBytes(data, p.cfg0);
  const c1 = cfgBytes(data, p.cfg1);
  const access = c1[0];
  return {
    mirror: { conf: CONF[(c0[0] >> 6) & 0x3], byte: (c0[0] >> 4) & 0x3, page: c0[2] },
    strongModulation: (c0[0] & STRG_MOD) !== 0,
    auth0: c0[3],
    prot: (access & PROT) !== 0,
    cfgLock: (access & CFGLCK) !== 0,
    counterEnabled: (access & NFC_CNT_EN) !== 0,
    counterPwdProtected: (access & NFC_CNT_PWD) !== 0,
    authLimit: access & AUTHLIM,
  };
}

/** CFG0 + CFG1 unit writes for `cfg` (keeps RFUI bytes from data). */
export function buildNtagConfigWrites(kind: TagKind, data: Uint8Array, cfg: NtagConfig): UnitWrite[] {
  const p = ntagPages(kind);
  const c0 = cfgBytes(data, p.cfg0);
  const c1 = cfgBytes(data, p.cfg1);
  const confBits = Math.max(0, CONF.indexOf(cfg.mirror.conf)) & 0x3;
  c0[0] = (((confBits << 6) | ((cfg.mirror.byte & 0x3) << 4) | (cfg.strongModulation ? STRG_MOD : 0)) | (c0[0] & RFUI_CFG0)) & 0xff;
  c0[2] = cfg.mirror.page & 0xff;
  c0[3] = cfg.auth0 & 0xff;
  c1[0] =
    ((cfg.prot ? PROT : 0) |
      (cfg.cfgLock ? CFGLCK : 0) |
      (c1[0] & RFUI_CFG1) |
      (cfg.counterEnabled ? NFC_CNT_EN : 0) |
      (cfg.counterPwdProtected ? NFC_CNT_PWD : 0) |
      (cfg.authLimit & AUTHLIM)) &
    0xff;
  // Safe write order within one (unauthenticated) pass. Writes apply in array
  // order and this builder emits no PWD_AUTH between them (DESIGN §3.1).
  //   - Arming password protection (the new AUTH0 covers the config pages) must
  //     put CFG0/AUTH0 LAST, like buildNtagPasswordWrites. Otherwise the later
  //     CFG1 write lands on an already-protected page and is rejected, leaving a
  //     half-applied, lock-out-prone state (AUTH0 set, PROT/AUTHLIM not).
  //   - Setting CFGLCK irreversibly locks CFG0+CFG1, so CFG1 must come LAST;
  //     otherwise the trailing CFG0 write is rejected.
  // Both at once cannot complete in a single pass (either order leaves one write
  // blocked), so reject it rather than emit a tag-bricking sequence.
  const cfg0Write: UnitWrite = { unit: p.cfg0, data: c0 };
  const cfg1Write: UnitWrite = { unit: p.cfg1, data: c1 };
  // After writing CFG0, CFG1 (page p.cfg1) is protected iff auth0 <= p.cfg1.
  const armsAuth0 = cfg.auth0 <= p.cfg1;
  if (armsAuth0 && cfg.cfgLock) {
    throw new Error('AUTH0 保護の有効化と CFGLCK は同時に書き込めません。別々に適用してください');
  }
  return armsAuth0 ? [cfg1Write, cfg0Write] : [cfg0Write, cfg1Write];
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
  const p = ntagPages(kind);
  const l0 = data[2 * 4 + 2]; // static lock byte 0
  const l1 = data[2 * 4 + 3]; // static lock byte 1
  const locked = new Set<number>();
  const ccLocked = (l0 & 0x08) !== 0;
  if (ccLocked) locked.add(3);
  for (let bit = 4; bit <= 7; bit++) if (l0 & (1 << bit)) locked.add(bit); // pages 4-7
  for (let bit = 0; bit <= 7; bit++) if (l1 & (1 << bit)) locked.add(8 + bit); // pages 8-15
  let blockLocked = (l0 & 0x07) !== 0;

  // Dynamic lock: bytes 0-2 of the dynamic-lock page. NTAG213 locks one page per
  // bit (pages 16-39); NTAG215/216 lock in blocks of 16 pages from page 16.
  const dynOff = p.dynLock * 4;
  const dyn = [data[dynOff], data[dynOff + 1], data[dynOff + 2]];
  const gran = kind === 'NTAG213' ? 1 : 16;
  for (let byteIdx = 0; byteIdx < 3; byteIdx++) {
    for (let bit = 0; bit < 8; bit++) {
      if (dyn[byteIdx] & (1 << bit)) {
        const first = 16 + (byteIdx * 8 + bit) * gran;
        for (let pg = first; pg < first + gran && pg <= p.userLast; pg++) locked.add(pg);
      }
    }
  }
  if ((data[dynOff + 3] & 0x07) !== 0) blockLocked = true; // dynamic block-lock bits

  return { lockedPages: Array.from(locked).sort((a, b) => a - b), ccLocked, blockLocked };
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
  const p = ntagPages(kind);
  const pwd = hexToBytes(opts.password);
  if (pwd.length !== 4) throw new Error('PWD は 4 バイト（16 進 8 桁）で指定します');
  const pack = hexToBytes(opts.pack);
  if (pack.length !== 2) throw new Error('PACK は 2 バイト（16 進 4 桁）で指定します');
  if (!Number.isInteger(opts.auth0) || opts.auth0 < 0 || opts.auth0 > 0xff) throw new Error('AUTH0 は 0〜255 です');
  if (!Number.isInteger(opts.authLimit) || opts.authLimit < 0 || opts.authLimit > 7) throw new Error('AUTHLIM は 0〜7 です');

  const packPage = cfgBytes(data, p.pack);
  packPage[0] = pack[0];
  packPage[1] = pack[1];

  const c1 = cfgBytes(data, p.cfg1);
  c1[0] = ((opts.protectRead ? PROT : 0) | (c1[0] & (CFGLCK | RFUI_CFG1 | NFC_CNT_EN | NFC_CNT_PWD)) | (opts.authLimit & AUTHLIM)) & 0xff;

  const c0 = cfgBytes(data, p.cfg0);
  c0[3] = opts.auth0 & 0xff;

  return [
    { unit: p.pwd, data: Uint8Array.from(pwd) },
    { unit: p.pack, data: packPage },
    { unit: p.cfg1, data: c1 },
    { unit: p.cfg0, data: c0 },
  ];
}

/** Disable protection (AUTH0 = 0xFF). Caller must authenticate with the current password. */
export function buildNtagRemovePasswordWrites(kind: TagKind, data: Uint8Array): UnitWrite[] {
  const p = ntagPages(kind);
  const c0 = cfgBytes(data, p.cfg0);
  c0[3] = 0xff;
  return [{ unit: p.cfg0, data: c0 }];
}

/** Enable/disable the NFC counter (CFG1 NFC_CNT_EN). */
export function buildNtagCounterWrites(kind: TagKind, data: Uint8Array, enabled: boolean): UnitWrite[] {
  const p = ntagPages(kind);
  const c1 = cfgBytes(data, p.cfg1);
  c1[0] = enabled ? (c1[0] | NFC_CNT_EN) & 0xff : c1[0] & ~NFC_CNT_EN & 0xff;
  return [{ unit: p.cfg1, data: c1 }];
}

/** IRREVERSIBLE: set static + dynamic lock bits so the user area becomes read-only forever. */
export function buildNtagLockUserAreaWrites(kind: TagKind, data: Uint8Array): UnitWrite[] {
  const p = ntagPages(kind);
  // Static lock page (page 2): keep BCC1 + internal (bytes 0,1), set both lock bytes.
  const page2 = data.slice(2 * 4, 2 * 4 + 4);
  page2[2] = 0xff;
  page2[3] = 0xff;
  // Dynamic lock page: set lock bytes 0-2, keep byte 3 (BL / RFUI).
  const dyn = cfgBytes(data, p.dynLock);
  dyn[0] = 0xff;
  dyn[1] = 0xff;
  dyn[2] = 0xff;
  return [
    { unit: 2, data: page2 },
    { unit: p.dynLock, data: dyn },
  ];
}
