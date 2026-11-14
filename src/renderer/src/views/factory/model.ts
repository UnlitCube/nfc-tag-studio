// Full reset screen ("完全初期化", 2026-11-14): put a tag back to the state it was
// delivered in. Pure (no React / store). The target is the app's single definition
// of the factory content, factoryImage() in src/shared/tags.ts (the simulator uses
// the same one).
//
// What is written (protected areas included - main requires advanced mode, I5):
//   NTAG21x  user memory (NTAG213: Lock Control TLV + empty NDEF; 215/216: empty NDEF),
//            CC when the change only sets bits (it is one-time programmable),
//            CFG0 / CFG1 (password protection off, counter off, mirror off),
//            PWD FFFFFFFF and PACK 0000 - always: they read back as 00, so whether
//            they are already factory cannot be known.
//   MIFARE   data blocks 00 and every sector trailer = FFFFFFFFFFFF FF0780 69
//            FFFFFFFFFFFF (always written: key A reads back as 00).
//   FeliCa   S_PAD0..13 and REG 00, MC = FF FF FF 01 07 00.. except the protection
//   Lite-S   masks MC[6:12] (write protection cannot be undone; read protection is
//            left to the card's own tools).
// Never written: the UID / manufacturer block (I1), lock bits (one-way), CFGLCK'd
// configuration, units locked on the tag, units that were not read. Each is listed
// as "cannot be restored" with the reason. A tag whose password protection is on is
// refused as a whole (the config pages cannot be written without PWD_AUTH, which a
// storage reader such as the PaSoRi cannot send).
import { decodeFelicaMc } from '@shared/felica';
import { hexToBytes } from '@shared/hex';
import { readNtagConfig } from '@shared/tag/ntag';
import { lockedUnitsOf, planWrites } from '@shared/tag/plan';
import {
  factoryImage,
  isFelica,
  isMifare,
  isNtag,
  mifareSectorBlockCount,
  mifareSectorCount,
  mifareSectorFirstBlock,
  mifareTrailerBlock,
  ntagPages,
  specFor,
} from '@shared/tags';
import type { TagImage, UnitWrite } from '@shared/types';

export type FactoryArea = 'data' | 'cc' | 'config' | 'password' | 'trailers' | 'mc' | 'reg';

export type FactoryIssue =
  /** NTAG static / dynamic lock bits are set (one-way). */
  | { code: 'lock-bits' }
  /** Units the reset would change but that are locked on the tag. */
  | { code: 'locked-units'; units: number[] }
  /** NTAG CFGLCK: the configuration pages are locked for good. */
  | { code: 'cfg-lock' }
  /** NTAG CC has bits the factory CC does not (one-time programmable: cannot go back). */
  | { code: 'cc-otp' }
  /** NTAG NFC counter was enabled: it is switched off, but its value cannot be reset. */
  | { code: 'counter' }
  /** Units not read (key / password needed): left as they are. */
  | { code: 'unread'; units: number[] }
  /** FeliCa Lite-S blocks write-protected (latched, one-way). */
  | { code: 'felica-write-protect'; blocks: number[] }
  /** FeliCa Lite-S read protection is on (not removed here). */
  | { code: 'felica-read-protect' }
  /** FeliCa Lite-S system blocks are read-only (MC[2] = 00): MC cannot be written. */
  | { code: 'felica-system-ro' };

/** The whole reset is refused. */
export type FactoryBlock = 'interrupted' | 'password' | null;

export interface FactoryPlan {
  /** In the order they must be written (NTAG: user pages, CC, then PWD, PACK, CFG1, CFG0 last). */
  writes: UnitWrite[];
  /** Units written per area, for the summary. */
  areas: { area: FactoryArea; units: number[] }[];
  issues: FactoryIssue[];
  block: FactoryBlock;
  /** Units written every time because they read back as 00 (NTAG PWD / PACK, MIFARE trailers). */
  unknowable: number[];
  /** Everything that can be read is already factory (only the unknowable units are written). */
  alreadyFactory: boolean;
  /** Protection-related settings change: they take effect after the tag is placed again. */
  reactivate: boolean;
}

const EMPTY: FactoryPlan = { writes: [], areas: [], issues: [], block: null, unknowable: [], alreadyFactory: false, reactivate: false };

function unitOf(data: Uint8Array, unit: number, size: number): Uint8Array {
  return data.subarray(unit * size, (unit + 1) * size);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isOk(img: TagImage, unit: number): boolean {
  return img.unitStatus[unit] === 'ok';
}

export function planFactoryReset(target: TagImage): FactoryPlan {
  if (target.unitStatus.some((s) => s === 'error')) return { ...EMPTY, block: 'interrupted' };
  if (isNtag(target.kind)) return planNtag(target);
  if (isMifare(target.kind)) return planMifare(target);
  if (isFelica(target.kind)) return planFelica(target);
  return EMPTY;
}

function finish(
  target: TagImage,
  desired: Uint8Array,
  ordered: (planned: UnitWrite[]) => UnitWrite[],
  areaOf: (unit: number) => FactoryArea,
  unknowable: number[],
  issues: FactoryIssue[],
  reactivateUnits: number[],
  reportLocked: boolean,
): FactoryPlan {
  const plan = planWrites(target.kind, target, desired, { includeProtected: true });
  const writes = ordered(plan.writes);
  const changed: number[] = [];
  const size = specFor(target.kind).unitSize;
  for (let u = 0; u < target.unitStatus.length; u++) if (!same(unitOf(desired, u, size), unitOf(target.data, u, size))) changed.push(u);
  const locked = new Set(lockedUnitsOf(target.kind, target));
  const lockedChanged = changed.filter((u) => locked.has(u));
  if (reportLocked && lockedChanged.length) issues.push({ code: 'locked-units', units: lockedChanged });
  const byArea = new Map<FactoryArea, number[]>();
  for (const w of writes) {
    const a = areaOf(w.unit);
    byArea.set(a, [...(byArea.get(a) ?? []), w.unit]);
  }
  const unk = new Set(unknowable);
  return {
    writes,
    areas: [...byArea].map(([area, units]) => ({ area, units })),
    issues,
    block: null,
    unknowable,
    alreadyFactory: writes.every((w) => unk.has(w.unit)),
    reactivate: writes.some((w) => reactivateUnits.includes(w.unit)),
  };
}

// --- NTAG21x ---------------------------------------------------------------------

function planNtag(target: TagImage): FactoryPlan {
  const kind = target.kind;
  const spec = specFor(kind);
  const p = ntagPages(kind);
  const size = spec.unitSize;
  const fac = factoryImage(kind, hexToBytes(target.uid));
  // Password protection on (AUTH0 inside the memory), or the configuration not readable
  // (PROT read protection): the configuration cannot be written without PWD_AUTH.
  const cfgRead = isOk(target, p.cfg0) && isOk(target, p.cfg1);
  const cfg = readNtagConfig(kind, target.data);
  if (!cfgRead || cfg.auth0 < spec.unitCount) return { ...EMPTY, block: 'password' };

  const issues: FactoryIssue[] = [];
  const desired = new Uint8Array(target.data);
  const unread: number[] = [];
  // User memory.
  for (let u = spec.userStartUnit; u <= p.userLast; u++) {
    if (!isOk(target, u)) {
      unread.push(u);
      continue;
    }
    desired.set(unitOf(fac, u, size), u * size);
  }
  // CC (one-time programmable: writing ORs bits in, so only a subset of the factory bits can go back).
  const cc = unitOf(target.data, 3, size);
  const fcc = unitOf(fac, 3, size);
  if (!same(cc, fcc)) {
    if (cc.every((b, i) => (b & ~fcc[i] & 0xff) === 0)) desired.set(fcc, 3 * size);
    else issues.push({ code: 'cc-otp' });
  }
  // Lock bits: never written (one-way).
  const staticLock = target.data[2 * size + 2] | target.data[2 * size + 3];
  const dyn = unitOf(target.data, p.dynLock, size);
  if (staticLock !== 0 || dyn[0] !== 0 || dyn[1] !== 0 || dyn[2] !== 0) issues.push({ code: 'lock-bits' });
  // Configuration.
  if (cfg.cfgLock) issues.push({ code: 'cfg-lock' });
  else {
    desired.set(unitOf(fac, p.cfg0, size), p.cfg0 * size);
    desired.set(unitOf(fac, p.cfg1, size), p.cfg1 * size);
  }
  if (cfg.counterEnabled) issues.push({ code: 'counter' });
  // PWD / PACK: always (they read as 00; CFGLCK does not lock them).
  desired.set(unitOf(fac, p.pwd, size), p.pwd * size);
  desired.set(unitOf(fac, p.pack, size), p.pack * size);
  if (unread.length) issues.push({ code: 'unread', units: unread });

  const pwdWrite = { unit: p.pwd, data: new Uint8Array(unitOf(fac, p.pwd, size)) };
  const packWrite = { unit: p.pack, data: new Uint8Array(unitOf(fac, p.pack, size)) };
  const tail = new Set([p.pwd, p.pack, p.cfg0, p.cfg1]);
  const ordered = (planned: UnitWrite[]): UnitWrite[] => {
    const cfg1 = planned.find((w) => w.unit === p.cfg1);
    const cfg0 = planned.find((w) => w.unit === p.cfg0);
    // Password group last, AUTH0 (CFG0) the very last (same order as buildNtagPasswordWrites).
    return [...planned.filter((w) => !tail.has(w.unit)), pwdWrite, packWrite, ...(cfg1 ? [cfg1] : []), ...(cfg0 ? [cfg0] : [])];
  };
  const areaOf = (u: number): FactoryArea => (u === 3 ? 'cc' : u === p.cfg0 || u === p.cfg1 ? 'config' : u === p.pwd || u === p.pack ? 'password' : 'data');
  return finish(target, desired, ordered, areaOf, [p.pwd, p.pack], issues, [p.cfg0, p.cfg1], true);
}

// --- MIFARE Classic ----------------------------------------------------------------

function planMifare(target: TagImage): FactoryPlan {
  const kind = target.kind;
  const size = specFor(kind).unitSize;
  const fac = factoryImage(kind, hexToBytes(target.uid));
  const desired = new Uint8Array(target.data);
  const unread: number[] = [];
  const trailers: number[] = [];
  for (let s = 0; s < mifareSectorCount(kind); s++) {
    const first = mifareSectorFirstBlock(s);
    const count = mifareSectorBlockCount(s);
    const blocks = Array.from({ length: count }, (_, i) => first + i);
    // A sector that was not read (no key) is left as it is: its keys are unknown here.
    if (blocks.some((b) => !isOk(target, b))) {
      unread.push(...blocks.filter((b) => !isOk(target, b)));
      continue;
    }
    for (const b of blocks) {
      if (b === 0) continue; // manufacturer block (I1)
      desired.set(unitOf(fac, b, size), b * size);
    }
    trailers.push(mifareTrailerBlock(s));
  }
  const issues: FactoryIssue[] = unread.length ? [{ code: 'unread', units: unread }] : [];
  const trailerSet = new Set(trailers);
  // Key A reads back as 00: the trailer always differs from the factory one -> always written.
  return finish(target, desired, (w) => w, (u) => (trailerSet.has(u) ? 'trailers' : 'data'), trailers, issues, [], true);
}

// --- FeliCa Lite-S -------------------------------------------------------------------

function planFelica(target: TagImage): FactoryPlan {
  const kind = target.kind;
  const size = specFor(kind).unitSize;
  const fac = factoryImage(kind, hexToBytes(target.uid));
  const mcUnit = specFor(kind).unitCount - 1; // MC (block 0x88)
  const regUnit = mcUnit - 1; // REG (block 0x0E)
  const desired = new Uint8Array(target.data);
  const issues: FactoryIssue[] = [];
  const unread: number[] = [];
  for (let u = 0; u <= regUnit; u++) {
    if (!isOk(target, u)) unread.push(u);
    else desired.set(unitOf(fac, u, size), u * size);
  }
  if (!isOk(target, mcUnit)) unread.push(mcUnit);
  else {
    const mc = decodeFelicaMc(unitOf(target.data, mcUnit, size));
    const wp: number[] = [];
    mc.writable.forEach((w, b) => {
      if (!w) wp.push(b);
    });
    if (wp.length) issues.push({ code: 'felica-write-protect', blocks: wp });
    if (mc.readProtected.some(Boolean)) issues.push({ code: 'felica-read-protect' });
    if (!mc.systemBlocksWritable) issues.push({ code: 'felica-system-ro' });
    else {
      const next = new Uint8Array(unitOf(fac, mcUnit, size));
      next.set(unitOf(target.data, mcUnit, size).subarray(6, 12), 6); // keep the protection masks as they are
      desired.set(next, mcUnit * size);
    }
  }
  if (unread.length) issues.push({ code: 'unread', units: unread });
  const areaOf = (u: number): FactoryArea => (u === mcUnit ? 'mc' : u === regUnit ? 'reg' : 'data');
  // Write-protected blocks are reported as 'felica-write-protect' (not again as locked units).
  return finish(target, desired, (w) => w, areaOf, [], issues, [mcUnit], false);
}
