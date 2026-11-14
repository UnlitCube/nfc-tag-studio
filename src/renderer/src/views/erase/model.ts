// Erase screen ("消去", 2026-11-13): what erasing a tag writes. Pure (no React / store).
//
// Two ranges:
//  - 'ndef': the NDEF message becomes empty (the tag stays NDEF-formatted). Same
//    plan as the NDEF editor's "NDEF を消去" (planNdefWrite with no records).
//  - 'all' : the whole data area goes back to what a blank tag holds - the same
//    content as the binary editor's "データ領域を初期化" in its 'zero' mode
//    (initializeImage): NTAG user pages -> empty NDEF TLV + 00 (factory state),
//    MIFARE data blocks -> 00 (never block 0 / sector trailers), FeliCa Lite-S
//    S_PAD0..13 -> 00 (never REG / MC).
// Never the UID, lock bits, configuration, password or keys (I1 / I5): the plan is
// planWrites with protected writes off, so protected / forbidden units are not
// written and units locked on the tag are left out (reported as excluded).
import { specFor } from '@shared/tags';
import type { TagKind } from '@shared/tags';
import type { TagImage, UnitWrite } from '@shared/types';
import { encodeDrafts } from '@shared/ndef';
import { initializeImage, planHexWrite } from '../hex/model';
import type { HexWritePlan } from '../hex/model';
import { planNdefWrite, readImageNdef, supportsNdef } from '../ndef/ndefPages';
import type { ImageNdef, NdefWritePlan } from '../ndef/ndefPages';

export type EraseMode = 'ndef' | 'all';

/** The ranges a tag offers. FeliCa Lite-S has no NDEF mapping: only 'all'. */
export function eraseModes(kind: TagKind): EraseMode[] {
  return supportsNdef(kind) ? ['ndef', 'all'] : ['all'];
}

export type ErasePlan =
  | {
      ok: true;
      mode: EraseMode;
      /** Units whose bytes change; empty = the tag is already erased in this range. */
      writes: UnitWrite[];
      /** Units of the range left out (locked on the tag, ...). Empty for 'ndef' (planNdefWrite refuses instead). */
      excluded: HexWritePlan['excluded'];
    }
  | { ok: false; mode: 'ndef'; ndef: Extract<NdefWritePlan, { ok: false }> };

const NONE: HexWritePlan['excluded'] = { protected: [], locked: [], keyA: [], invalid: [], otp: [] };

export function planErase(target: TagImage, mode: EraseMode): ErasePlan {
  if (mode === 'ndef') {
    // Already an empty NDEF (03 00 FE, D0 00 00, ...): nothing to write. Without this, an empty
    // NDEF in another encoding would be rewritten every time.
    if (readImageNdef(target).state === 'empty') return { ok: true, mode, writes: [], excluded: NONE };
    const p = planNdefWrite(target, encodeDrafts([]));
    if (!p.ok) return { ok: false, mode, ndef: p };
    return { ok: true, mode, writes: p.writes, excluded: NONE };
  }
  const data = initializeImage(target.kind, target.data, 'zero');
  // Units that were not read (no key / password, cut off) are never erased: their content is
  // unknown and the sector may not even open. Reads zero-fill them, but do not rely on that.
  const size = specFor(target.kind).unitSize;
  target.unitStatus.forEach((s, u) => {
    if (s !== 'ok') data.set(target.data.subarray(u * size, (u + 1) * size), u * size);
  });
  const hp = planHexWrite({ kind: target.kind, mode: 'same', original: target, data, includeProtected: false });
  return { ok: true, mode, writes: hp.plan.writes, excluded: hp.excluded };
}

/** What the tag holds now, for the summary ('unsupported' for FeliCa Lite-S). */
export function currentNdef(target: TagImage): ImageNdef {
  return readImageNdef(target);
}

/** Units the erase cannot reach because they were not read (missing key / password). */
export function unreadUnits(target: TagImage): number[] {
  const out: number[] = [];
  target.unitStatus.forEach((s, u) => {
    if (s === 'denied') out.push(u);
  });
  return out;
}

/** The read was cut off (the tag moved): erasing from such a picture is not allowed. */
export function readInterrupted(target: TagImage): boolean {
  return target.unitStatus.some((s) => s === 'error');
}
