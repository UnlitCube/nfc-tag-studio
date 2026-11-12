// Pure view models for the shell (status bar) and the home screen: what to say
// about the reader, the tag on it and the open document. No React, no store
// access (the callers pass the state in), so tests/shell-home.test.ts can cover
// every branch. Owner: shell-ui (SHELL-HOME).
//
// Rules (2026-11-12 UX audit CARD-1/3/7/8/14, FIRST-1..5, FIRST-20, FIRST-22):
//  - Everything is about the ACTIVE reader (ReaderStatus.activeReader), never readers[0].
//  - "No reader yet" is not "the service is broken": on Windows the smart card
//    service starts when a reader is plugged in, so 'unavailable' with no readers
//    is shown as "connect a reader", not as a red service error.
//  - The tag on the reader and the open document are different things and are
//    never mixed in one display.
import type { CardInfo, ErrorCode, ReaderInfo, ReaderStatus, TagImage } from '@shared/types';
import type { TagKind } from '@shared/tags';
import { isFelica, isMifare, isNtag, kindHintFromAtr, specFor } from '@shared/tags';
import { hexToBytes } from '@shared/hex';
import { readImageNdef } from '../../views/ndef/ndefPages';
import type { DocSource, TagDoc } from '../../store/app';
import { dirtyUnits } from '../../store/app';

/** The reader read/write actually use (same rule as lib/readerState.activeReaderInfo). */
function activeOf(s: ReaderStatus): ReaderInfo | null {
  if (!s.activeReader) return null;
  return s.readers.find((r) => r.name === s.activeReader) ?? null;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Why there is no usable reader (null = there is one). */
export type ReaderProblem =
  /** Status not received yet (app starting). */
  | { kind: 'starting' }
  /** The reader chosen in settings is not connected (D1: no silent switch). */
  | { kind: 'selected-missing'; name: string }
  /** Nothing connected (or the service has not started because nothing is connected). */
  | { kind: 'connect' }
  /** Only non-NFC PC/SC devices (USB tokens, contact readers) are connected. */
  | { kind: 'tokens-only'; names: string[] }
  /** The smart card service answered with an error (not just "no reader"). */
  | { kind: 'service-error'; message: string | null };

export function readerProblem(s: ReaderStatus | null): ReaderProblem | null {
  if (!s) return { kind: 'starting' };
  if (s.activeReason === 'selected-missing') {
    return { kind: 'selected-missing', name: s.selectedReader ?? s.activeReader ?? '' };
  }
  if (activeOf(s)) return null;
  if (s.service === 'error') return { kind: 'service-error', message: s.serviceMessage };
  const real = s.readers.filter((r) => !r.virtual);
  const nonNfc = real.filter((r) => !r.likelyContactless);
  if (real.length > 0 && nonNfc.length === real.length) return { kind: 'tokens-only', names: nonNfc.map((r) => r.name) };
  return { kind: 'connect' };
}

/** The reader item of the status bar. */
export type StatusReader =
  | { kind: 'starting' }
  | { kind: 'init-failed' }
  | { kind: 'virtual'; inUse: boolean }
  | { kind: 'reader'; name: string; fixed: boolean; inUse: boolean }
  | { kind: 'problem'; problem: ReaderProblem };

export function statusReader(s: ReaderStatus | null, app: { ready: boolean; initError: string | null }): StatusReader {
  if (app.initError) return { kind: 'init-failed' };
  if (!app.ready || !s) return { kind: 'starting' };
  const problem = readerProblem(s);
  if (problem) return { kind: 'problem', problem };
  const active = activeOf(s)!;
  if (active.virtual) return { kind: 'virtual', inUse: active.inUse };
  return { kind: 'reader', name: active.name, fixed: s.activeReason === 'selected', inUse: active.inUse };
}

export type StatusTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info';

export function statusReaderTone(r: StatusReader): StatusTone {
  switch (r.kind) {
    case 'starting':
    case 'init-failed':
      return 'neutral';
    case 'virtual':
      return r.inUse ? 'warn' : 'accent';
    case 'reader':
      return r.inUse ? 'warn' : 'ok';
    case 'problem':
      return r.problem.kind === 'service-error' ? 'danger' : r.problem.kind === 'starting' ? 'neutral' : 'warn';
  }
}

// ---------------------------------------------------------------------------
// Tag on the reader
// ---------------------------------------------------------------------------

/** Family detected from the ATR, for "unsupported" explanations. */
export type CardFamily = 'type2' | 'felica' | 'mifare' | null;

export function cardFamily(card: CardInfo | null): CardFamily {
  if (!card || !card.atr) return null;
  try {
    const h = kindHintFromAtr(hexToBytes(card.atr));
    if (h === 'TYPE2') return 'type2';
    if (h === 'FELICA') return 'felica';
    if (h === 'MIFARE_CLASSIC_1K' || h === 'MIFARE_CLASSIC_4K') return 'mifare';
    return null;
  } catch {
    return null;
  }
}

/** The UID label: FeliCa calls it IDm. */
export function idLabelKind(kind: TagKind | null | undefined): 'uid' | 'idm' {
  return kind && isFelica(kind) ? 'idm' : 'uid';
}

/** What the "tag on the reader" panel of the home screen explains. */
export type TagGuide =
  | { kind: 'no-reader'; problem: ReaderProblem }
  | { kind: 'issuing' }
  | { kind: 'reading' }
  | { kind: 'writing' }
  | { kind: 'busy' }
  | { kind: 'place'; virtual: boolean }
  | { kind: 'detecting' }
  | { kind: 'unsupported'; family: CardFamily; error: ErrorCode | null }
  | { kind: 'error'; error: ErrorCode }
  /** A supported tag is ready and no document is open. */
  | { kind: 'ready-new'; card: CardInfo }
  /** The open document was read from this very tag. */
  | { kind: 'ready-same'; card: CardInfo }
  /** A document is open, but it is not from this tag (another tag, a file or a new document). */
  | { kind: 'ready-other'; card: CardInfo; docSource: DocSource['type']; docUid: string | null; dirty: boolean };

export function tagGuide(
  s: ReaderStatus | null,
  doc: TagDoc | null,
  ops: { issueRunning: boolean; busyOp: null | 'read' | 'write'; localReading?: boolean },
): TagGuide {
  const problem = readerProblem(s);
  // The virtual reader is on but holds no tag (and no real reader): say "place the virtual tag".
  if (problem && problem.kind === 'connect' && s?.simulator.enabled) return { kind: 'place', virtual: true };
  if (problem) return { kind: 'no-reader', problem };
  const st = s!;
  if (ops.issueRunning) return { kind: 'issuing' };
  if (ops.busyOp === 'read' || ops.localReading || st.busy?.op === 'read') return { kind: 'reading' };
  if (ops.busyOp === 'write' || st.busy?.op === 'write') return { kind: 'writing' };
  if (st.busy && st.busy.op !== 'identify') return { kind: 'busy' };
  switch (st.cardState) {
    case 'no-reader':
      return { kind: 'no-reader', problem: { kind: 'connect' } };
    case 'absent':
      return { kind: 'place', virtual: !!activeOf(st)?.virtual };
    case 'detecting':
      return { kind: 'detecting' };
    case 'unsupported':
      return { kind: 'unsupported', family: cardFamily(st.card), error: st.cardError };
    case 'error':
      return { kind: 'error', error: st.cardError ?? 'CARD_UNRESPONSIVE' };
    case 'ready':
      break;
  }
  const card = st.card;
  if (!card || !card.kind) return { kind: 'unsupported', family: cardFamily(card), error: st.cardError };
  if (!doc) return { kind: 'ready-new', card };
  if (doc.source.type === 'card' && doc.source.uid.toUpperCase() === card.uid.toUpperCase()) return { kind: 'ready-same', card };
  return {
    kind: 'ready-other',
    card,
    docSource: doc.source.type,
    docUid: doc.source.type === 'card' ? doc.source.uid : null,
    dirty: dirtyUnits(doc).length > 0,
  };
}

/**
 * The line under "cannot read the tag" on home. Re-placing does not help a tag
 * whose memory is protected (ACCESS_DENIED - e.g. a password-protected NTAG on a
 * storage-only reader, review R-MAIN-4 / R-UX-1), and READER_NO_AUTH already
 * says what to do.
 */
export function errorFollowUp(error: ErrorCode): 'protected' | 'retry' | 'none' {
  if (error === 'ACCESS_DENIED') return 'protected';
  if (error === 'READER_NO_AUTH') return 'none';
  return 'retry';
}

// ---------------------------------------------------------------------------
// Password auth / keys (2026-11-12 review R-UX-1, R-UX-4; D9, D11)
// ---------------------------------------------------------------------------

/**
 * Can the reader in use authenticate with an NTAG password (PWD_AUTH)?
 * Only readers with raw commands (ACR122U / transparent) can; a storage-only
 * reader (Sony PaSoRi) cannot - it refuses protected pages with 63 00 even with
 * the right password (CLAUDE.md, measured 2026-11-12). Known from the tag on the
 * active reader (CardInfo.rawCommands) or from a forced "storage" transport;
 * 'unknown' while no tag is on the reader.
 */
export type AuthSupport = 'yes' | 'no' | 'unknown';

export function passwordAuthSupport(s: ReaderStatus | null): AuthSupport {
  const card = s?.card ?? null;
  if (card) return card.rawCommands ? 'yes' : 'no';
  // No tag: the transport main resolved for the active reader (D11).
  if (s?.activeDriver) return s.activeDriver === 'storage' ? 'no' : 'yes';
  if (s?.driverMode === 'storage') return 'no';
  return 'unknown';
}

/** What the home screen says about pages / sectors that needed a password or key. */
export type DeniedHelp =
  /** NTAG password pages: by the reader's ability to authenticate. */
  | { kind: 'ntag'; auth: AuthSupport }
  /** MIFARE sectors: the automatic read tries only the public standard keys (D9). */
  | { kind: 'mifare'; autoRead: boolean }
  | { kind: 'other' };

export function deniedHelp(kind: TagKind, s: ReaderStatus | null, autoRead: boolean): DeniedHelp {
  if (isNtag(kind)) return { kind: 'ntag', auth: passwordAuthSupport(s) };
  if (isMifare(kind)) return { kind: 'mifare', autoRead };
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------
// Open document
// ---------------------------------------------------------------------------

/**
 * NDEF record count of an image (null = cannot tell: FeliCa, unreadable NDEF
 * pages / sectors, or not a valid message). Same reading as the NDEF editor
 * (views/ndef/ndefPages.readImageNdef): a message of only empty records
 * (D0 00 00, what "NDEF を消去" writes) counts as 0, not as 1 record.
 */
export function ndefRecordCount(image: TagImage): number | null {
  try {
    const r = readImageNdef(image);
    if (r.state === 'records') return r.drafts.filter((d) => d.kind !== 'empty').length;
    if (r.state === 'empty' || r.state === 'none') return 0;
    return null;
  } catch {
    return null;
  }
}

/** Units that could not be read, split by reason (FIRST-22): denied = key/password needed, unread = read error. */
export function unreadableCounts(image: TagImage): { denied: number; unread: number } {
  let denied = 0;
  let unread = 0;
  for (const s of image.unitStatus) {
    if (s === 'denied') denied++;
    else if (s === 'unread' || s === 'error') unread++;
  }
  return { denied, unread };
}

/** Where the document's tag is relative to the reader (card-sourced documents only). */
export type DocOnReader = 'on-reader' | 'other-tag' | 'not-on-reader' | 'not-applicable';

export function docOnReader(doc: TagDoc, s: ReaderStatus | null): DocOnReader {
  if (doc.source.type !== 'card') return 'not-applicable';
  const card = s?.card ?? null;
  const ready = !!s && (s.cardState === 'ready' || s.cardState === 'unsupported') && !!card;
  if (!ready) return 'not-on-reader';
  return card!.uid.toUpperCase() === doc.source.uid.toUpperCase() ? 'on-reader' : 'other-tag';
}

export interface DocSummary {
  kind: TagKind;
  uid: string;
  idLabel: 'uid' | 'idm';
  unit: 'page' | 'block';
  userBytes: number;
  /** NDEF records of what was read / opened (doc.original), null = not applicable / unknown. */
  ndefRecords: number | null;
  ndefApplicable: boolean;
  counter: number | null;
  dirty: number;
  denied: number;
  unread: number;
  onReader: DocOnReader;
}

export function docSummary(doc: TagDoc, s: ReaderStatus | null): DocSummary {
  const kind = doc.image.kind;
  const spec = specFor(kind);
  const { denied, unread } = unreadableCounts(doc.original);
  return {
    kind,
    uid: doc.image.uid,
    idLabel: idLabelKind(kind),
    unit: spec.unit,
    userBytes: spec.userBytes,
    ndefRecords: ndefRecordCount(doc.original),
    ndefApplicable: !isFelica(kind),
    counter: doc.original.ntag?.counter ?? null,
    dirty: dirtyUnits(doc).length,
    denied,
    unread,
    onReader: docOnReader(doc, s),
  };
}
