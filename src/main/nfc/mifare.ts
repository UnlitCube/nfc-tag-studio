// MIFARE Classic read / write. Owner: agent "main-nfc".
//
// MIFARE always goes through the PC/SC storage pseudo-APDUs (load key +
// authenticate + read/update binary), which every contactless PC/SC reader
// implements, so the driver mode does not change this path.
//
// Invariant I3: a sector opens only with a key the operator holds (deps.resolveKeys).
// There is no key recovery, no brute force, no dictionary - each candidate key is
// tried as Key A then Key B, and a sector that no provided key opens is reported
// 'denied'. Key bytes never appear in logs or results (only the key's label).

import type { AccessBits, TagKind } from '@shared/tags';
import { mifareSectorBlockCount, mifareSectorCount, mifareSectorFirstBlock, mifareSectorOfBlock, parseAccessBits, specFor } from '@shared/tags';
import type { MifareSectorAccess, UnitStatus, UnitWrite } from '@shared/types';
import { OpError } from '../errors';
import type { MifareKeyType } from './apdu';
import type { ReaderIo } from './driver';
import type { ResolvedKey } from './contract';
import { PresenceGuard, readChunk, runUnitWrites, type UnitWriteOutcome } from './unit-ops';

/** Volatile reader key slot we reuse for every authentication. */
const SLOT = 0x00;

/**
 * Key B of a sector trailer is returned by the card (readable as data) only in
 * access conditions 000, 001 (transport) and 010; in every other condition it
 * reads back as 00. Key A is never readable in any condition. (MIFARE Classic
 * sector-trailer access-conditions table.)
 */
function trailerKeyBReadable(access: AccessBits): boolean {
  const [c1, c2, c3] = access.c[3];
  return c1 === 0 && !(c2 === 1 && c3 === 1);
}

/**
 * Mask a 16-byte MIFARE Classic sector-trailer read-back the way real hardware
 * does, returning a masked COPY:
 *   - Key A (bytes 0-5)  : never readable -> always 00.
 *   - access bits + GPB (bytes 6-9): always readable -> kept.
 *   - Key B (bytes 10-15): kept only when the access conditions make it readable,
 *                          otherwise 00.
 * Used by the simulator (so it behaves like hardware) AND by writeTag's verify
 * (so a trailer write is confirmed against the bytes that can actually be read
 * back, not the secret key bytes that always read 00 - which would otherwise make
 * verify always mismatch on real hardware). Only call this for trailer blocks.
 */
export function mifareTrailerReadbackMask(trailer: Uint8Array): Uint8Array {
  const out = trailer.slice();
  for (let i = 0; i < 6 && i < out.length; i++) out[i] = 0x00;
  const access = out.length >= 10 ? parseAccessBits(out) : null;
  if (!access || !trailerKeyBReadable(access)) {
    for (let i = 10; i < 16 && i < out.length; i++) out[i] = 0x00;
  }
  return out;
}

export interface MifareReadResult {
  data: Uint8Array;
  unitStatus: UnitStatus[];
  sectors: MifareSectorAccess[];
}

interface SectorOpener {
  sector: number;
  keyType: MifareKeyType;
  label: string;
  key: Uint8Array;
}

/** Try each key (as Key A then Key B) against a sector. Returns the opener or null. */
async function authSector(io: ReaderIo, sector: number, keys: ResolvedKey[]): Promise<SectorOpener | null> {
  const firstBlock = mifareSectorFirstBlock(sector);
  for (const k of keys) {
    await io.loadKey(SLOT, k.key);
    for (const keyType of ['A', 'B'] as MifareKeyType[]) {
      if (await io.authenticate(firstBlock, keyType, SLOT)) {
        return { sector, keyType, label: k.label, key: k.key };
      }
    }
  }
  return null;
}

/**
 * R-MAIN-3: "is the tag still there?" = open again a sector that THIS tag opened
 * in this operation, with the same key (an RF exchange; the key bytes stay in
 * main and are never logged, I3/I4). Nothing opened yet -> no check. The caller
 * re-authenticates the sector it works on afterwards.
 */
function mifareGuard(io: ReaderIo, last: () => SectorOpener | null, enabled: boolean): PresenceGuard {
  if (!enabled) return new PresenceGuard(null);
  return new PresenceGuard(async () => {
    const o = last();
    if (!o) return true; // nothing known to work: take the refusal at face value
    await io.loadKey(SLOT, o.key);
    return io.authenticate(mifareSectorFirstBlock(o.sector), o.keyType, SLOT);
  });
}

export interface MifareOpOptions {
  /** Check that the tag is still there when a sector / block is refused (R-MAIN-3). Default true. */
  checkPresence?: boolean;
}

/**
 * Read the whole MIFARE image, sector by sector. A sector no provided key opens
 * is 'denied'; a tag that leaves the reader rejects the whole read (CARD_REMOVED).
 */
export async function readMifare(io: ReaderIo, kind: TagKind, keys: ResolvedKey[], opts: MifareOpOptions = {}): Promise<MifareReadResult> {
  const spec = specFor(kind);
  const blocks = spec.unitCount;
  const data = new Uint8Array(blocks * 16);
  const unitStatus: UnitStatus[] = new Array(blocks).fill('unread');
  const sectorCount = mifareSectorCount(kind);
  const sectors: MifareSectorAccess[] = [];
  let lastOpened: SectorOpener | null = null;
  const guard = mifareGuard(io, () => lastOpened, opts.checkPresence !== false);

  for (let s = 0; s < sectorCount; s++) {
    const first = mifareSectorFirstBlock(s);
    const count = mifareSectorBlockCount(s);
    const auth = await authSector(io, s, keys);
    if (!auth) {
      sectors.push({ sector: s, keyType: null, keyLabel: null });
      for (let b = first; b < first + count; b++) unitStatus[b] = 'denied';
      // No key opened it: a key we do not hold, or the tag just left? (R-MAIN-3)
      await guard.refused();
      continue;
    }
    lastOpened = auth;
    sectors.push({ sector: s, keyType: auth.keyType, keyLabel: auth.label });
    for (let b = first; b < first + count; b++) {
      // Throws CARD_REMOVED (whole read fails) when the tag left the reader.
      const r = await readChunk(io, async () => {
        const bytes = await io.readBinary(b, 16);
        if (bytes.length < 16) throw new OpError('READ_FAILED', `block ${b}`);
        return bytes;
      });
      if (r.status === 'ok') data.set(r.data.subarray(0, 16), b * 16);
      unitStatus[b] = r.status;
      // Inside an open sector a probe would change the authenticated sector: check at the end.
      if (r.status !== 'ok') await guard.refused(false);
    }
  }
  await guard.finish();
  return { data, unitStatus, sectors };
}

/** Read one block (16 bytes), authenticating its sector first. */
export async function readMifareBlock(io: ReaderIo, block: number, keys: ResolvedKey[]): Promise<Uint8Array> {
  const sector = mifareSectorOfBlock(block);
  const auth = await authSector(io, sector, keys);
  if (!auth) throw new OpError('ACCESS_DENIED', `sector ${sector}`);
  const bytes = await io.readBinary(block, 16);
  if (bytes.length < 16) throw new OpError('READ_FAILED', `block ${block}`);
  return bytes.subarray(0, 16);
}

/**
 * Write blocks in order. Authenticates once per sector (re-authenticating after a
 * failure). Returns which blocks were written and which failed; a tag that leaves
 * the reader stops the loop (`aborted`, `notAttempted`).
 */
export async function writeMifare(io: ReaderIo, writes: UnitWrite[], keys: ResolvedKey[], opts: MifareOpOptions = {}): Promise<UnitWriteOutcome> {
  let authedSector = -1;
  let lastOpened: SectorOpener | null = null;
  return runUnitWrites(
    writes,
    async (w) => {
      const sector = mifareSectorOfBlock(w.unit);
      if (w.data.length !== 16) throw new OpError('WRITE_FAILED', `block ${w.unit} needs 16 bytes`);
      if (authedSector !== sector) {
        const auth = await authSector(io, sector, keys);
        if (!auth) throw new OpError('ACCESS_DENIED', `sector ${sector}`);
        authedSector = sector;
        lastOpened = auth;
      }
      await io.updateBinary(w.unit, w.data);
    },
    () => {
      authedSector = -1; // force a fresh authentication for the next block (also after a presence probe)
    },
    mifareGuard(io, () => lastOpened, opts.checkPresence !== false),
  );
}
