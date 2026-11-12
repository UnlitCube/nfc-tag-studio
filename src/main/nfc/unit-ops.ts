// Shared helpers for whole-tag reads and ordered unit writes. Owner: agent "main-nfc".
//
// 2026-11-12 UX audit CARD-4 / WRITE-4 / ISSUE-2: a tag that leaves the reader
// (or stops answering) in the middle of an operation must stop that operation:
//   - a read rejects (never a "successful" image whose missing units look like
//     password-protected areas),
//   - a write stops at once and reports `aborted` + the units it never tried,
//     instead of failing every remaining unit one by one.

import type { ErrorCode } from '@shared/types';
import { OpError } from '../errors';
import type { ReaderIo } from './driver';

/** Codes after which the tag is gone or the link to it is dead. */
const LINK_LOST: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['CARD_REMOVED', 'CARD_UNRESPONSIVE', 'NO_CARD', 'NO_READER', 'NO_SERVICE']);

/** The tag left the reader / stopped answering / the reader went away. */
export function isLinkLost(e: unknown): e is OpError {
  return e instanceof OpError && LINK_LOST.has(e.code);
}

/** The ErrorCode of anything thrown (OpError keeps its code). */
export function errorCodeOf(e: unknown, fallback: ErrorCode): ErrorCode {
  return e instanceof OpError ? e.code : fallback;
}

/**
 * Confirm the tag still answers (FF CA). Throws OpError CARD_REMOVED (or the
 * link-lost code) when it does not, so a whole-tag operation stops instead of
 * reporting the unit as merely unreadable.
 */
export async function ensureTagPresent(io: ReaderIo): Promise<void> {
  try {
    await io.getUid();
  } catch (e) {
    if (isLinkLost(e)) throw e;
    throw new OpError('CARD_REMOVED', 'tag stopped answering');
  }
}

/**
 * 2026-11-12 review R-MAIN-3: is a refusal real, or did the tag leave?
 *
 * A storage reader (Sony PaSoRi) may answer a command to a tag that has just
 * left with an error status word (63 00 - the same SW it uses for a
 * password-protected NTAG page) instead of a "card removed" PC/SC error. Then a
 * read "succeeds" with the rest of the tag marked 'denied', and a write reports
 * every remaining unit as "protected". FF CA (UID) cannot tell: many readers
 * return the UID they cached at activation without talking to the tag.
 *
 * So the guard re-reads something THIS tag already answered in this operation (a
 * real RF exchange, e.g. the CC page or a sector that opened): at the first
 * refusal (so a lifted tag stops the operation at once) and once more at the end
 * when there were refusals after that check. A probe that fails means the tag is
 * gone: OpError CARD_REMOVED. No probe (null) = the old behaviour (refusals are
 * taken at face value) - used where a probe could itself disturb the tag (raw
 * NTAG commands: a NAK sends the tag back to IDLE) or nothing is known to work.
 * NOTE: the SW / rv sequence a real PaSoRi gives while a tag is lifted is not
 * measured yet (2026-11-12); the guard only assumes "a present tag answers what
 * it answered a moment ago".
 */
export class PresenceGuard {
  private checked = false;
  private pending = false;

  constructor(private readonly probe: (() => Promise<boolean>) | null) {}

  /**
   * A unit was refused. `checkNow` false = only remember it (e.g. inside an open
   * MIFARE sector, where a probe would change the authenticated sector).
   */
  async refused(checkNow = true): Promise<void> {
    if (!this.probe) return;
    if (!this.checked && checkNow) {
      this.checked = true;
      this.pending = false;
      await this.run();
    } else {
      this.pending = true;
    }
  }

  /** End of the operation: confirm the tag is still there if units were refused since the last check. */
  async finish(): Promise<void> {
    if (!this.probe || !this.pending) return;
    this.pending = false;
    this.checked = true;
    await this.run();
  }

  private async run(): Promise<void> {
    let ok = false;
    try {
      ok = await this.probe!();
    } catch (e) {
      if (isLinkLost(e)) throw e;
      ok = false;
    }
    if (!ok) throw new OpError('CARD_REMOVED', 'tag stopped answering');
  }
}

export type ChunkResult = { status: 'ok'; data: Uint8Array } | { status: 'denied' } | { status: 'error' };

/**
 * Read one chunk of a whole-tag read.
 *  - ok:     the bytes
 *  - denied: the tag refused (password / key needed) - a normal outcome
 *  - error:  failed twice although the tag still answers (left to the caller to flag)
 * Throws when the tag left the reader (CARD_REMOVED, ...).
 */
export async function readChunk(io: ReaderIo, read: () => Promise<Uint8Array>): Promise<ChunkResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { status: 'ok', data: await read() };
    } catch (e) {
      if (isLinkLost(e)) throw e;
      if (e instanceof OpError && e.code === 'ACCESS_DENIED') return { status: 'denied' };
      // anything else: one more try (a tag that is still settling), then check it is there
    }
  }
  await ensureTagPresent(io);
  return { status: 'error' };
}

export interface UnitWriteOutcome {
  written: number[];
  /** Units the tag refused / that failed, by ErrorCode (never raw SW text). */
  failed: { unit: number; error: ErrorCode }[];
  /** Set when the write stopped early because the tag left / stopped answering. */
  aborted: ErrorCode | null;
  /** Units after the abort that were never tried. */
  notAttempted: number[];
}

/** A transport failure while writing is a write failure, not a "read failed". */
function writeErrorCode(e: unknown): ErrorCode {
  const code = errorCodeOf(e, 'WRITE_FAILED');
  return code === 'READ_FAILED' || code === 'INTERNAL' ? 'WRITE_FAILED' : code;
}

/**
 * Write units strictly in order. A unit that fails is recorded and the next one
 * is tried; when the tag leaves the reader the loop stops: the interrupted unit
 * is in `failed` (its outcome is unknown) and the rest are in `notAttempted`.
 * `onFailure` runs after a non-fatal failure (e.g. MIFARE drops its session).
 * `guard` (R-MAIN-3): a refused unit is checked against "the tag left" - at the
 * first refusal the loop stops at once when the tag is gone (that unit is in
 * `failed` with CARD_REMOVED, the rest in `notAttempted`); refusals after that
 * check are confirmed once at the end (gone -> `aborted` CARD_REMOVED, the
 * recorded units unchanged: which of them failed because the tag left is unknown).
 */
export async function runUnitWrites<W extends { unit: number }>(
  writes: readonly W[],
  writeOne: (w: W) => Promise<void>,
  onFailure?: () => void,
  guard?: PresenceGuard,
): Promise<UnitWriteOutcome> {
  const out: UnitWriteOutcome = { written: [], failed: [], aborted: null, notAttempted: [] };
  const stop = (i: number, code: ErrorCode): void => {
    out.aborted = code;
    out.notAttempted = writes.slice(i + 1).map((x) => x.unit);
  };
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i];
    try {
      await writeOne(w);
      out.written.push(w.unit);
    } catch (e) {
      const code = writeErrorCode(e);
      out.failed.push({ unit: w.unit, error: code });
      if (isLinkLost(e)) {
        stop(i, code);
        break;
      }
      onFailure?.();
      if (guard) {
        try {
          await guard.refused();
        } catch (g) {
          if (!isLinkLost(g)) throw g;
          // The refusal was the tag leaving: its outcome is unknown, like a unit cut mid-write.
          out.failed[out.failed.length - 1] = { unit: w.unit, error: g.code };
          stop(i, g.code);
          break;
        }
      }
    }
  }
  if (guard && out.aborted === null) {
    try {
      await guard.finish();
    } catch (g) {
      if (!isLinkLost(g)) throw g;
      out.aborted = g.code;
    }
  }
  return out;
}
