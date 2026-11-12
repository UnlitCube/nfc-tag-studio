// Pure helpers over ReaderStatus so every screen shows the SAME reader / tag
// state (the reader main actually uses - never readers[0]). Integrator-owned
// (renderer-core). 2026-11-12 UX audit CARD-1/3/7, FIRST-5/19.
import type { ReaderInfo, ReaderStatus } from '@shared/types';

/** The reader read/write actually use, or null. */
export function activeReaderInfo(s: ReaderStatus | null): ReaderInfo | null {
  if (!s || !s.activeReader) return null;
  return s.readers.find((r) => r.name === s.activeReader) ?? null;
}

/** An identified, supported tag is on the active reader. */
export function isCardReady(s: ReaderStatus | null): boolean {
  return !!s && s.cardState === 'ready' && !!s.card && !!s.card.kind;
}

/** The identified tag on the active reader has this UID. */
export function isCardUid(s: ReaderStatus | null, uid: string | null | undefined): boolean {
  return !!uid && isCardReady(s) && s!.card!.uid.toUpperCase() === uid.toUpperCase();
}

/**
 * Why a single-tag read / write cannot start right now (null = it can). Screens
 * disable the button and show the localized reason + its fix instead of letting
 * the operator press and then refusing (business-app-ux: 押してから断らない).
 */
export type TagOpBlock =
  | 'service' // PC/SC unavailable
  | 'no-reader' // no usable reader / selected reader missing
  | 'absent' // no tag on the reader
  | 'detecting' // tag being identified
  | 'unsupported' // tag kind not supported
  | 'error' // tag present but unreadable (see cardError)
  | 'issuing' // batch issue running
  | 'busy'; // another single-tag op in flight

export function tagOpBlock(s: ReaderStatus | null, opts: { issueRunning: boolean; busyOp: string | null }): TagOpBlock | null {
  if (opts.issueRunning) return 'issuing';
  if (opts.busyOp || (s?.busy && s.busy.op !== 'identify')) return 'busy';
  if (!s) return 'service';
  if (s.cardState === 'no-reader') return s.service === 'unavailable' || s.service === 'error' ? 'service' : 'no-reader';
  if (s.cardState === 'absent') return 'absent';
  if (s.cardState === 'detecting') return 'detecting';
  if (s.cardState === 'unsupported') return 'unsupported';
  if (s.cardState === 'error') return 'error';
  return null;
}
