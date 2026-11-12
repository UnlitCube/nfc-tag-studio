// Pure logic for the "duplicate to another tag" flow. No React, no DOM.
// Owner: agent renderer-backup. Tested by tests/backup.test.ts.
//
// Invariant I1/I2: duplication copies ONLY the writable data area. The UID /
// manufacturer block and every protected unit (CC, lock, config, password,
// MIFARE sector trailers) are excluded, so a duplicate never reproduces a UID.
import type { TagImage, UnitWrite } from '@shared/types';
import type { TagKind } from '@shared/tags';
import { specFor, isProtectedUnit } from '@shared/tags';

export interface DataCopyPlan {
  kind: TagKind;
  /** Writable data-area units copied from the source, in address order. */
  writes: UnitWrite[];
  /** Data-area units skipped because they were not read on the source. */
  unreadUnits: number[];
  /**
   * Units intentionally excluded because they are not plain data (UID /
   * manufacturer block, CC, lock, config, password, sector trailers).
   */
  excludedUnits: number[];
  /** Total bytes across `writes`. */
  byteCount: number;
}

/**
 * Plan the units to write when copying `source`'s data area onto another tag.
 * `isProtectedUnit` already returns true for forbidden units (UID pages / block
 * 0), so those can never end up in `writes`.
 */
export function planDataCopy(source: TagImage): DataCopyPlan {
  const kind = source.kind;
  const spec = specFor(kind);
  const writes: UnitWrite[] = [];
  const unreadUnits: number[] = [];
  const excludedUnits: number[] = [];
  let byteCount = 0;
  for (let unit = 0; unit < spec.unitCount; unit++) {
    if (isProtectedUnit(kind, unit)) {
      excludedUnits.push(unit);
      continue;
    }
    if (source.unitStatus[unit] !== 'ok') {
      unreadUnits.push(unit);
      continue;
    }
    const off = unit * spec.unitSize;
    const bytes = source.data.slice(off, off + spec.unitSize);
    writes.push({ unit, data: bytes });
    byteCount += bytes.length;
  }
  return { kind, writes, unreadUnits, excludedUnits, byteCount };
}

/**
 * Writing the open document (a backup file / a tag read) onto the tag on the
 * reader. 2026-11-12 UX rework (WRITE-9 / FLOW-3 / FLOW-14):
 *  - 'restore': the target has the SAME UID as the document - put the backup
 *    back onto the tag it came from (this used to be refused as "same tag").
 *  - 'duplicate': another tag - copy the data area (the UID is never copied).
 * Only data-area units that DIFFER on the target are written (D5: planned from
 * the target's content). Units either side could not read are left out.
 */
export interface RestorePlan {
  mode: 'restore' | 'duplicate';
  /** Source and target are different tag kinds: nothing may be written. */
  kindMismatch: boolean;
  /** Data-area units to write (differ on the target, readable on both), in address order. */
  writes: UnitWrite[];
  /** Data-area units the target already holds identically (not written). */
  unchanged: number[];
  /** Data-area units the source could not read (excluded). */
  sourceUnread: number[];
  /** Data-area units the target could not read (excluded: writing them would fail without the password / key). */
  targetUnread: number[];
  /** Data-area units in total (writable, excluding UID / config / trailers). */
  dataUnits: number;
  /** Bytes across `writes`. */
  byteCount: number;
}

export function planRestore(source: TagImage, target: TagImage): RestorePlan {
  const mode = source.uid.toUpperCase() === target.uid.toUpperCase() ? 'restore' : 'duplicate';
  const empty: RestorePlan = {
    mode,
    kindMismatch: source.kind !== target.kind,
    writes: [],
    unchanged: [],
    sourceUnread: [],
    targetUnread: [],
    dataUnits: 0,
    byteCount: 0,
  };
  if (source.kind !== target.kind) return empty;
  const copy = planDataCopy(source);
  const spec = specFor(source.kind);
  const plan = { ...empty, sourceUnread: copy.unreadUnits, dataUnits: copy.writes.length + copy.unreadUnits.length };
  for (const w of copy.writes) {
    if (target.unitStatus[w.unit] !== 'ok') {
      plan.targetUnread.push(w.unit);
      continue;
    }
    const off = w.unit * spec.unitSize;
    let differs = false;
    for (let i = 0; i < w.data.length; i++) {
      if (target.data[off + i] !== w.data[i]) {
        differs = true;
        break;
      }
    }
    if (differs) {
      plan.writes.push(w);
      plan.byteCount += w.data.length;
    } else {
      plan.unchanged.push(w.unit);
    }
  }
  return plan;
}

/** Units in `plan.writes` whose bytes differ from `targetData`. */
export function changedAgainstTarget(plan: DataCopyPlan, targetData: Uint8Array): number[] {
  const spec = specFor(plan.kind);
  const changed: number[] = [];
  for (const w of plan.writes) {
    const off = w.unit * spec.unitSize;
    let differs = false;
    for (let i = 0; i < w.data.length; i++) {
      if (targetData[off + i] !== w.data[i]) {
        differs = true;
        break;
      }
    }
    if (differs) changed.push(w.unit);
  }
  return changed;
}
