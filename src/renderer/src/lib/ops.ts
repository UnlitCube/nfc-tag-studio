// Tag operations shared by several views (read into the current document, write
// with confirmation + refresh). Integrator-owned (renderer-core).
//
// 2026-11-12 UX audit (WRITE-2/4/6/13/14, FLOW-6/7/16, FIRST-12/13/22, CARD-4, WALK-4/6):
//  - One single-tag operation at a time (store.busyOp): a second press, an
//    auto-read and a write cannot overlap; views disable their buttons with
//    lib/readerState.tagOpBlock().
//  - Reading never silently replaces unsaved edits (guardDiscard first) and
//    never opens an image with interrupted ('error') units without asking.
//  - Writing shows WHERE it writes (kind + UID, "different tag (copy)"), keeps
//    the result on screen (store.lastWrite) in plain words (pages / blocks and
//    the reason per ErrorCode), and never drops edits that were not written.
//
// 2026-11-12 review round 2 (R-WRITE-1/3/4, R-UX-4, D9, D13, E2E-UX-1/4/5):
//  - "The document is copied onto this tag" is said by the caller
//    (WriteUi.docCopy), not guessed from byte equality alone.
//  - The auto-read tries the public standard MIFARE keys only.
//  - busyOp is set once the operator confirmed (no "writing..." behind a dialog);
//    a write success shows no toast (the result stays in LastWriteCallout).
import type { ErrorCode, LanguageSetting, ReadOptions, TagImage, UnitStatus, UnitWrite, WriteRequest, WriteResult } from '@shared/types';
import { isMifare, isProtectedUnit, specFor } from '@shared/tags';
import type { TagKind } from '@shared/tags';
import { errorMessage } from '@shared/errorMessages';
import { AppError, api, errorText } from './api';
import { beep } from './sound';
import { formatUid, idName, kindLabel } from './format';
import { unitCount, unitList } from './units';
import { dirtyUnits, errorToast, useAppStore } from '../store/app';
import type { TagDoc, WriteOutcome } from '../store/app';
import { translate } from '../i18n';

function lang(): LanguageSetting {
  return useAppStore.getState().settings.language;
}

function tr(key: Parameters<typeof translate>[1], vars?: Record<string, string | number>): string {
  return translate(lang(), key, vars);
}

function sameUid(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toUpperCase() === b.toUpperCase();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface UnitStatusCounts {
  ok: number;
  denied: number;
  unread: number;
  error: number;
}

export function countUnitStatus(status: readonly UnitStatus[]): UnitStatusCounts {
  const c: UnitStatusCounts = { ok: 0, denied: 0, unread: 0, error: 0 };
  for (const s of status) c[s] = (c[s] ?? 0) + 1;
  return c;
}

/** Localized lines describing a read result: what it is, what could not be read and why (FIRST-22). */
export function readSummaryLines(img: TagImage, l: LanguageSetting): string[] {
  const c = countUnitStatus(img.unitStatus);
  const lines = [translate(l, 'op.read.summary', { kind: kindLabel(img.kind), idName: idName(img.kind), uid: formatUid(img.uid) })];
  if (c.denied) lines.push(translate(l, 'op.read.denied', { count: unitCount(img.kind, c.denied, l) }));
  if (c.error) lines.push(translate(l, 'op.read.error', { count: unitCount(img.kind, c.error, l) }));
  if (c.unread) lines.push(translate(l, 'op.read.unread', { count: unitCount(img.kind, c.unread, l) }));
  return lines;
}

/** Refuse (with a toast) while batch issuing runs - before any dialog (ISSUE-11). */
function refuseWhileIssuing(): boolean {
  const st = useAppStore.getState();
  if (!st.issue.running) return false;
  st.toast({ tone: 'info', title: tr('op.busy.issuing') });
  return true;
}

/**
 * The single-tag operation that has started, including while it still asks the
 * operator (discard edits? / the write confirmation). store.busyOp is set only
 * once the tag is actually being read / written, so no screen says "writing..."
 * behind a confirmation that is not answered yet (D13 / E2E-UX-4); this lock keeps
 * a second operation out during the question too.
 */
let pendingOp: 'read' | 'write' | null = null;

function tagOpRunning(): boolean {
  return pendingOp !== null || useAppStore.getState().busyOp !== null;
}

/** The public standard MIFARE keys built into the app (keystore BUILTIN; I3). Fallback when the key list cannot be fetched. */
const STANDARD_KEY_IDS_FALLBACK = ['builtin-default', 'builtin-mad', 'builtin-ndef'];

/**
 * Ids of the public standard MIFARE keys (D9): what the auto-read tries. Never
 * the operator's own keys - a card that merely gets placed (possibly a device
 * emulating one) must not get authentication attempts with them (review R-UX-4).
 */
export async function standardKeyIds(): Promise<string[]> {
  try {
    const ids = (await api.listKeys()).filter((k) => k.builtin).map((k) => k.id);
    return ids.length > 0 ? ids : STANDARD_KEY_IDS_FALLBACK;
  } catch {
    return STANDARD_KEY_IDS_FALLBACK;
  }
}

/** MIFARE sectors read as 'denied' in an image (0 for other kinds). */
export function deniedCount(img: TagImage): number {
  return countUnitStatus(img.unitStatus).denied;
}

/**
 * Read the tag on the reader into the current document. Returns null on failure
 * (toast shown) or when the operator declined to discard unsaved edits.
 * CONTRACT: `o.guard` (default true) asks guardDiscard() BEFORE reading; pass
 * false only when the caller already asked.
 * `o.standardKeysOnly` (the auto-read, D9): MIFARE sectors are tried with the
 * public standard keys only (opts.mifareKeyIds is replaced); the document is
 * marked so the screens can offer "read with the registered keys".
 *
 * Returns null without doing anything while another single-tag operation runs
 * (store.busyOp / a confirmation of one) - the views keep the button disabled
 * then (tagOpBlock).
 */
export async function readCurrentTag(opts: ReadOptions = {}, o: { guard?: boolean; standardKeysOnly?: boolean } = {}): Promise<TagImage | null> {
  const st = useAppStore.getState();
  if (tagOpRunning()) return null;
  if (refuseWhileIssuing()) return null;
  pendingOp = 'read';
  try {
    if (o.guard !== false && !(await st.guardDiscard())) return null;
    let img: TagImage;
    st.setBusyOp('read');
    try {
      const readOpts = o.standardKeysOnly ? { ...opts, mifareKeyIds: await standardKeyIds() } : opts;
      img = await api.readTag(readOpts);
    } catch (err) {
      st.toastError(err, tr('op.read.failed'));
      beep('error');
      return null;
    } finally {
      useAppStore.getState().setBusyOp(null);
    }
    const l = lang();
    const c = countUnitStatus(img.unitStatus);
    if (c.error > 0) {
      // CARD-4: zero-filled pages from an interrupted read must not become "the
      // tag's content" (and later a backup) without the operator knowing.
      beep('error');
      const open = await st.confirm({
        title: translate(l, 'op.read.incomplete.title'),
        message: translate(l, 'op.read.incomplete.message', { count: unitCount(img.kind, c.error, l) }),
        target: translate(l, 'op.read.summary', { kind: kindLabel(img.kind), idName: idName(img.kind), uid: formatUid(img.uid) }),
        confirmLabel: translate(l, 'op.read.incomplete.open'),
        cancelLabel: translate(l, 'op.read.incomplete.cancel'),
        tone: 'warn',
      });
      if (!open) {
        st.toast({ tone: 'warn', title: translate(l, 'op.read.incomplete.title'), detail: translate(l, 'op.read.notOpened') });
        return null;
      }
    }
    const standardOnly = !!o.standardKeysOnly && c.denied > 0 && isMifare(img.kind);
    useAppStore.getState().openImage(img, { type: 'card', uid: img.uid }, standardOnly ? { standardKeysOnly: true } : undefined);
    const lines = readSummaryLines(img, l);
    if (standardOnly) lines.push(translate(l, 'op.read.standardKeysOnly'));
    st.toast({
      tone: c.denied || c.error || c.unread ? 'warn' : 'ok',
      title: translate(l, 'toast.read'),
      detail: lines.join('\n'),
    });
    if (!c.error) beep('tap');
    return img;
  } finally {
    pendingOp = null;
    useAppStore.getState().setBusyOp(null);
  }
}

/**
 * Read the tag on the reader WITHOUT opening it as the document (the write
 * target: a backup restore, writing a file / new document to a tag, NDEF write
 * planning). Toasts and returns null on failure. CONTRACT.
 * Returns null without a toast while another single-tag operation runs.
 */
export async function readTarget(opts: ReadOptions = {}): Promise<TagImage | null> {
  const st = useAppStore.getState();
  if (tagOpRunning()) return null;
  if (refuseWhileIssuing()) return null;
  pendingOp = 'read';
  st.setBusyOp('read');
  try {
    return await api.readTag(opts);
  } catch (err) {
    st.toastError(err, tr('op.read.targetFailed'));
    beep('error');
    return null;
  } finally {
    pendingOp = null;
    useAppStore.getState().setBusyOp(null);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteUi {
  /** Confirmation title, e.g. "NDEF を書き込みます". */
  title: string;
  /** One-paragraph explanation. */
  message: string;
  details?: string[];
  /** Irreversible / protected: always confirm, danger styling. */
  dangerous?: boolean;
  /** Require typing this word (irreversible operations). */
  typeToConfirm?: string;
  /** Skip the confirmation even if settings.confirmBeforeWrite (e.g. confirmed elsewhere). */
  skipConfirm?: boolean;
  /**
   * Re-read the tag after writing and make it the current document (default true).
   * The document is only replaced when that loses nothing: unwritten edits stay
   * pending, and a document of a different tag / file with unsaved edits is kept
   * as it is (the result says so). Pass false to never touch the document (e.g.
   * duplicating the open document onto several other tags).
   */
  refresh?: boolean;
  /** ReadOptions for the refresh read. */
  readOptions?: ReadOptions;
  /**
   * The tag being written, shown in the confirmation (kind + UID) so the operator
   * sees WHERE it goes. CONTRACT (2026-11-12 FIRST-13). `other`: it is not the
   * tag the document was read from (copying a document / file onto it).
   * When `other` is omitted it is worked out from the document.
   */
  target?: { kind: TagKind; uid: string; other?: boolean };
  /** Protection settings are written: tell the operator to take the tag off and place it again (FeliCa MC / NTAG AUTH0). */
  reactivateAfter?: boolean;
  /**
   * After the write, keep these units as pending edits if they were not written
   * (default: the units of req.writes). Used by rebaseDoc on partial failure.
   */
  keepUnitsOnFailure?: number[];
  /** Title of the success result (default "タグに書き込みました"), e.g. "NDEF を書き込みました". */
  successTitle?: string;
  /**
   * The confirm button of the confirmation (default "タグに書き込む"): what the
   * operation does, e.g. "NDEF を消去する" (E2E-UX-5).
   */
  confirmLabel?: string;
  /**
   * The write copies the OPEN DOCUMENT onto a tag that is not the one it was read
   * from (binary editor "write to another tag", backup duplicate / restore of a
   * file): afterwards the document becomes that tag (refresh) and the
   * confirmation says "copy". Content of another kind (NDEF records, a flag
   * preset) passes false: the document is never replaced by it.
   * Omitted: worked out from the bytes, and then only when every unsaved edit of
   * the document is part of the write (review R-WRITE-1: never drop edits that
   * only happen to sit next to byte-equal content).
   * Edits a copy leaves out (e.g. pages locked on the target) are not kept in the
   * new document; the result says so ('dropped').
   */
  docCopy?: boolean;
}

/** Errors main raises BEFORE writing anything (the tag is untouched). */
const PRE_WRITE_CODES = new Set<ErrorCode>([
  'NO_SERVICE',
  'NO_READER',
  'NO_CARD',
  'UID_MISMATCH',
  'UNSUPPORTED_TAG',
  'KIND_MISMATCH',
  'BUSY',
  'READER_IN_USE',
  'ADVANCED_REQUIRED',
  'PROTECTED_UNIT',
  'FORBIDDEN_UNIT',
  'READER_NO_AUTH',
  'INVALID_ACCESS_BITS',
  'INVALID_INPUT',
  'CANCELLED',
]);

export interface WriteAnalysis {
  /** Units written and (if verified) confirmed. */
  okWritten: number[];
  /** Units of the request that are not in okWritten (failed, mismatched, not attempted, skipped). */
  notWritten: number[];
  failedByCode: [ErrorCode, number[]][];
  mismatched: number[];
  aborted: ErrorCode | null;
  notAttempted: number[];
  /** Everything requested was written and nothing reported a problem. */
  success: boolean;
}

/** Pure: classify a WriteResult against its request (tolerates a main that omits the newer fields). */
export function analyzeWrite(req: WriteRequest, res: WriteResult): WriteAnalysis {
  const failed = res.failed ?? [];
  const mismatched = res.mismatched ?? [];
  const aborted = res.aborted ?? null;
  const notAttempted = res.notAttempted ?? [];
  const bad = new Set<number>([...failed.map((f) => f.unit), ...mismatched, ...notAttempted]);
  const written = new Set(res.written ?? []);
  const okWritten = req.writes.map((w) => w.unit).filter((u) => written.has(u) && !bad.has(u));
  const ok = new Set(okWritten);
  const notWritten = req.writes.map((w) => w.unit).filter((u) => !ok.has(u));
  const groups = new Map<ErrorCode, number[]>();
  for (const f of failed) {
    const code = (f.error ?? 'WRITE_FAILED') as ErrorCode;
    groups.set(code, [...(groups.get(code) ?? []), f.unit]);
  }
  return {
    okWritten,
    notWritten,
    failedByCode: [...groups.entries()],
    mismatched,
    aborted,
    notAttempted,
    success: !aborted && failed.length === 0 && mismatched.length === 0 && res.verified !== false && notWritten.length === 0,
  };
}

function unitBytesEqual(doc: TagDoc, w: UnitWrite): boolean {
  const size = specFor(doc.image.kind).unitSize;
  if (w.data.length !== size) return false;
  const off = w.unit * size;
  if (off + size > doc.image.data.length) return false;
  for (let i = 0; i < size; i++) if (doc.image.data[off + i] !== w.data[i]) return false;
  return true;
}

/**
 * The write puts the document's own bytes onto the tag (binary editor, backup
 * restore / duplicate) - as opposed to other content (NDEF records, a flag
 * preset) written while some document happens to be open.
 * Byte equality only: used for the tag the document was read from. Whether the
 * document is COPIED onto another tag is isDocCopy().
 */
export function isWriteFromDoc(doc: TagDoc | null, req: WriteRequest): boolean {
  if (!doc || doc.image.kind !== req.kind || req.writes.length === 0) return false;
  // Protected units (MIFARE trailers, NTAG config) may be adjusted by the planner
  // (e.g. a key kept from the target), so the data units decide when there are any.
  const data = req.writes.filter((w) => !isProtectedUnit(req.kind, w.unit));
  return (data.length > 0 ? data : req.writes).every((w) => unitBytesEqual(doc, w));
}

/**
 * The write copies the open document onto ANOTHER tag (it becomes the document
 * afterwards). `docCopy` from the caller decides (WriteUi.docCopy); without it,
 * only when the bytes are the document's AND every unsaved edit is written -
 * content that merely equals part of a document with other unsaved edits (NDEF
 * records taken over from it) is not a copy (review R-WRITE-1).
 */
export function isDocCopy(doc: TagDoc | null, req: WriteRequest, docCopy?: boolean): boolean {
  if (!doc || doc.image.kind !== req.kind || req.writes.length === 0) return false;
  if (docCopy !== undefined) return docCopy;
  if (!isWriteFromDoc(doc, req)) return false;
  const units = new Set(req.writes.map((w) => w.unit));
  return dirtyUnits(doc).every((u) => units.has(u));
}

function unitEqualIn(a: TagImage, b: TagImage, unit: number): boolean {
  const size = specFor(a.kind).unitSize;
  if (a.data.length !== b.data.length) return false;
  for (let i = unit * size; i < (unit + 1) * size; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function sameSource(a: TagDoc['source'], b: TagDoc['source']): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'card' && b.type === 'card') return sameUid(a.uid, b.uid);
  if (a.type === 'file' && b.type === 'file') return a.name === b.name && a.token === b.token;
  return true;
}

/** Units whose edited bytes differ between two versions of the doc (edited while the write ran). */
function changedBetween(a: TagDoc | null, b: TagDoc | null): number[] {
  if (!a || !b || a.image.data.length !== b.image.data.length || a.image.kind !== b.image.kind) return [];
  const size = specFor(b.image.kind).unitSize;
  const out: number[] = [];
  for (let u = 0; u * size < b.image.data.length; u++) {
    for (let i = u * size; i < (u + 1) * size; i++) {
      if (a.image.data[i] !== b.image.data[i]) {
        out.push(u);
        break;
      }
    }
  }
  return out;
}

export type DocPlan =
  | { action: 'commit' }
  | { action: 'rebase'; keep: number[] }
  | { action: 'markWritten'; writes: UnitWrite[] }
  | { action: 'none' };

export type DocNote =
  | { key: 'kept' }
  | { key: 'rereadFailed' }
  | { key: 'rereadFailedMarked' }
  | { key: 'rereadFailedStale' }
  | { key: 'rereadOtherTag'; uid: string }
  | { key: 'docKept'; dirty: number }
  | { key: 'docKeptOther' }
  | { key: 'overwritten'; n: number }
  /** A copy replaced the document: these edits were not written and are not in the new document. */
  | { key: 'dropped'; units: number[] };

export interface DocPlanInput {
  /** The document when the write started. */
  docBefore: TagDoc | null;
  /** The document now (after the write and the re-read). */
  docNow: TagDoc | null;
  req: WriteRequest;
  res: WriteResult;
  refresh: boolean;
  /** The re-read image (null when not read or the read failed / was incomplete). */
  readback: TagImage | null;
  keepUnitsOnFailure?: number[];
  /** WriteUi.docCopy (see isDocCopy). */
  docCopy?: boolean;
}

/**
 * Pure: what to do with the current document after a write, so that
 *  - an edit that was not written is never lost (it stays pending),
 *  - a written edit stops looking "unsaved" even when the re-read failed (WRITE-6),
 *  - the doc is never replaced by a different tag's content (re-read UID differs),
 *  - a doc of another tag / a file with unsaved edits is left alone (FLOW-6),
 *  - the doc becomes the written tag only for a copy of the document
 *    (isDocCopy, review R-WRITE-1) - and a copy that leaves edits out says so,
 *  - a doc opened / replaced / closed while the write ran is left alone (R-WRITE-3).
 */
export function planDocAfterWrite(i: DocPlanInput): { plan: DocPlan; notes: DocNote[] } {
  const a = analyzeWrite(i.req, i.res);
  const ok = new Set(a.okWritten);
  const doc = i.docNow;
  const writtenUid = i.res.uid || i.req.expectedUid || '';
  const fromDoc = isWriteFromDoc(i.docBefore, i.req);
  const sameCard = !!doc && doc.source.type === 'card' && sameUid(doc.source.uid, writtenUid);
  const okWrites = i.req.writes.filter((w) => ok.has(w.unit));
  const editedDuring = changedBetween(i.docBefore, doc);
  const notes: DocNote[] = [];

  // Not the document this write was planned from (another one was opened, or it
  // was closed, while the write ran): never fold this write into it.
  const replacedDuring = i.docBefore ? !doc || !sameSource(i.docBefore.source, doc.source) : !!doc;
  if (replacedDuring) {
    if (doc) {
      const dirty = dirtyUnits(doc).length;
      notes.push(dirty > 0 ? { key: 'docKept', dirty } : { key: 'docKeptOther' });
    }
    return { plan: { action: 'none' }, notes };
  }

  if (!i.refresh) {
    if (sameCard && fromDoc && okWrites.length > 0) return { plan: { action: 'markWritten', writes: okWrites }, notes };
    return { plan: { action: 'none' }, notes };
  }

  if (!i.readback || !sameUid(i.readback.uid, writtenUid)) {
    if (i.readback) notes.push({ key: 'rereadOtherTag', uid: i.readback.uid });
    if (sameCard && fromDoc) {
      if (!i.readback) notes.push({ key: 'rereadFailedMarked' });
      return { plan: okWrites.length ? { action: 'markWritten', writes: okWrites } : { action: 'none' }, notes };
    }
    if (!i.readback) notes.push({ key: doc ? 'rereadFailedStale' : 'rereadFailed' });
    return { plan: { action: 'none' }, notes };
  }

  if (!doc) return { plan: { action: 'commit' }, notes };

  const keep = new Set<number>(editedDuring);
  const keepFailedOfDoc = () => {
    for (const u of a.notWritten) keep.add(u);
    for (const u of i.keepUnitsOnFailure ?? []) if (!ok.has(u)) keep.add(u);
  };

  if (sameCard) {
    for (const u of dirtyUnits(doc)) if (!ok.has(u)) keep.add(u);
    if (fromDoc) keepFailedOfDoc();
    else {
      const overwritten = dirtyUnits(i.docBefore).filter((u) => ok.has(u) && !editedDuring.includes(u)).length;
      if (overwritten > 0) notes.push({ key: 'overwritten', n: overwritten });
    }
    if (fromDoc && a.notWritten.some((u) => keep.has(u))) notes.push({ key: 'kept' });
    return { plan: keep.size ? { action: 'rebase', keep: [...keep].sort((x, y) => x - y) } : { action: 'commit' }, notes };
  }

  if (isDocCopy(i.docBefore, i.req, i.docCopy)) {
    // The document (a file, a new document or another tag) was copied onto this
    // tag: it now IS this tag, with whatever was not written still pending.
    keepFailedOfDoc();
    const readback = i.readback;
    // Edits that are neither on the tag now nor kept pending would vanish with the switch.
    const dropped = dirtyUnits(doc).filter((u) => !keep.has(u) && !ok.has(u) && !unitEqualIn(doc.image, readback, u));
    if (dropped.length > 0 && i.docCopy !== true) {
      // Only inferred to be a copy: keep the document (and its edits) rather than guess.
      notes.push({ key: 'docKept', dirty: dirtyUnits(doc).length });
      return { plan: { action: 'none' }, notes };
    }
    if (dropped.length > 0) notes.push({ key: 'dropped', units: dropped });
    if (a.notWritten.some((u) => keep.has(u))) notes.push({ key: 'kept' });
    return { plan: keep.size ? { action: 'rebase', keep: [...keep].sort((x, y) => x - y) } : { action: 'commit' }, notes };
  }

  // Other content written to a tag that is not the open document: leave the document.
  const dirty = dirtyUnits(doc).length;
  notes.push(dirty > 0 ? { key: 'docKept', dirty } : { key: 'docKeptOther' });
  return { plan: { action: 'none' }, notes };
}

function noteLine(n: DocNote, kind: TagKind, docKind: TagKind | null, l: LanguageSetting): string {
  switch (n.key) {
    case 'kept':
      return translate(l, 'op.write.kept');
    case 'rereadFailed':
      return translate(l, 'op.write.rereadFailed');
    case 'rereadFailedMarked':
      return translate(l, 'op.write.rereadFailedMarked');
    case 'rereadFailedStale':
      return translate(l, 'op.write.rereadFailedStale');
    case 'rereadOtherTag':
      return translate(l, 'op.write.rereadOtherTag', { idName: idName(kind), uid: formatUid(n.uid) });
    case 'docKept':
      return translate(l, 'op.write.docKept', { count: unitCount(docKind ?? kind, n.dirty, l) });
    case 'docKeptOther':
      return translate(l, 'op.write.docKeptOther');
    case 'overwritten':
      return translate(l, 'op.write.overwritten', { count: unitCount(docKind ?? kind, n.n, l) });
    case 'dropped':
      return translate(l, 'op.write.dropped', { units: unitList(docKind ?? kind, n.units, l) });
  }
}

/** Pure: the localized, persistent result of a write (WRITE-4 / FIRST-12 / FLOW-16). */
export function buildWriteOutcome(
  req: WriteRequest,
  res: WriteResult,
  notes: DocNote[],
  opts: { lang: LanguageSetting; now: number; reactivateAfter?: boolean; successTitle?: string; docKind?: TagKind | null },
): WriteOutcome {
  const l = opts.lang;
  const k = req.kind;
  const a = analyzeWrite(req, res);
  const lines: string[] = [];
  let tone: WriteOutcome['tone'];
  let title: string;
  const problems = () => {
    for (const [code, units] of a.failedByCode) {
      if (code === a.aborted && units.every((u) => a.notAttempted.includes(u))) continue;
      lines.push(translate(l, 'op.write.unitsReason', { units: unitList(k, units, l), reason: errorMessage(code, l) }));
    }
    if (a.mismatched.length) {
      lines.push(translate(l, 'op.write.unitsReason', { units: unitList(k, a.mismatched, l), reason: errorMessage('VERIFY_FAILED', l) }));
    } else if (res.verified === false && a.failedByCode.length === 0 && !a.aborted) {
      lines.push(errorMessage('VERIFY_FAILED', l));
    }
  };
  let retry = false;
  // Every page / block was written; the tag left during the verify read-back
  // (main: aborted, nothing failed or left out). Not "partly written" (R-WRITE-4).
  const writtenThenLeft =
    !!a.aborted &&
    a.notAttempted.length === 0 &&
    a.failedByCode.length === 0 &&
    a.mismatched.length === 0 &&
    a.okWritten.length === req.writes.length;
  if (writtenThenLeft) {
    tone = 'warn';
    title = translate(l, 'op.write.writtenUnverifiedTitle');
    lines.push(translate(l, 'op.write.writtenUnverified', { count: unitCount(k, a.okWritten.length, l) }));
  } else if (a.aborted) {
    tone = 'danger';
    title = translate(l, 'op.write.abortedTitle');
    lines.push(errorMessage(a.aborted, l));
    if (a.okWritten.length > 0) {
      const left = a.notAttempted.length || a.notWritten.length;
      lines.push(translate(l, 'op.write.partialState', { done: unitCount(k, a.okWritten.length, l), left: unitCount(k, left, l) }));
    } else {
      lines.push(translate(l, 'op.write.noneWritten'));
    }
    problems();
    retry = true;
  } else if (!a.success) {
    tone = 'danger';
    title = translate(l, a.okWritten.length > 0 ? 'op.write.partialTitle' : 'op.write.failedTitle');
    problems();
    lines.push(
      a.okWritten.length > 0
        ? translate(l, 'op.write.othersWritten', { count: unitCount(k, a.okWritten.length, l) })
        : translate(l, 'op.write.noneWritten'),
    );
  } else {
    title = opts.successTitle ?? translate(l, 'op.write.done');
    const n = unitCount(k, a.okWritten.length, l);
    lines.push(translate(l, res.verified ? 'op.write.doneVerified' : 'op.write.doneUnverified', { count: n }));
    const rereadFailed = notes.some((x) => x.key === 'rereadFailed' || x.key === 'rereadFailedMarked' || x.key === 'rereadFailedStale' || x.key === 'rereadOtherTag');
    tone = !res.verified && rereadFailed ? 'warn' : 'ok';
  }
  for (const n of notes) lines.push(noteLine(n, k, opts.docKind ?? null, l));
  return {
    at: opts.now,
    tone,
    title,
    lines,
    uid: res.uid || req.expectedUid || '',
    kind: k,
    reactivate: !!opts.reactivateAfter && a.okWritten.length > 0,
    ...(retry ? { retry: true } : {}),
  };
}

/**
 * Confirmation texts: where the data goes and whether it is a different tag
 * (FIRST-13 / D5). `force`: confirm even when settings.confirmBeforeWrite is off
 * (the open document - or content the caller says came from another tag - is
 * being copied onto a different tag: the last chance to catch a mixed-up tag).
 */
export function writeConfirmTexts(
  doc: TagDoc | null,
  req: WriteRequest,
  ui: Pick<WriteUi, 'target' | 'docCopy'>,
  l: LanguageSetting,
): { target: string; warning: string | null; force: boolean } {
  const t = ui.target ?? (req.expectedUid ? { kind: req.kind, uid: req.expectedUid } : null);
  const target = t
    ? translate(l, 'op.write.confirm.target', { kind: kindLabel(t.kind), idName: idName(t.kind), uid: formatUid(t.uid) })
    : translate(l, 'op.write.confirm.targetUnknown');
  if (!t) return { target, warning: null, force: false };
  const saidOther = ui.target?.other === true;
  const id = idName(req.kind);
  const generic = saidOther ? translate(l, 'op.write.confirm.other', { idName: id }) : null;
  if (!doc) return { target, warning: generic, force: saidOther };
  const docIsThisTag = doc.source.type === 'card' && sameUid(doc.source.uid, t.uid);
  // The caller knows best that the content comes from another tag (e.g. NDEF
  // records read from tag A written to tag B while B is the open document).
  if (docIsThisTag) return { target, warning: generic, force: saidOther };
  if (ui.target?.other === false) return { target, warning: null, force: false };
  const fromDoc = isDocCopy(doc, req, ui.docCopy);
  let warning: string | null = generic;
  if (doc.source.type === 'card') {
    warning = translate(l, fromDoc ? 'op.write.confirm.copyCard' : 'op.write.confirm.otherCard', { idName: id, uid: formatUid(doc.source.uid) });
  } else if (fromDoc) {
    warning =
      doc.source.type === 'file'
        ? translate(l, 'op.write.confirm.fromFile', { name: doc.source.name, idName: id })
        : translate(l, 'op.write.confirm.fromNew', { idName: id });
  }
  return { target, warning, force: !!warning && (saidOther || fromDoc) };
}

/** The toast of the previous write result (a new write replaces it). */
let lastWriteToast: number | null = null;

/**
 * D13: the result of a write stays in <LastWriteCallout /> next to the write
 * button, so a success shows no toast (it covered that very button - E2E-UX-1).
 * A failure / warning still gets a short toast (title + the first line) so it is
 * noticed even with the result scrolled away; the full text is in the callout.
 */
function showWriteToast(o: WriteOutcome, technical?: string) {
  const st = useAppStore.getState();
  if (lastWriteToast !== null) st.dismissToast(lastWriteToast);
  lastWriteToast = null;
  if (o.tone === 'ok') return;
  const before = new Set(useAppStore.getState().toasts.map((x) => x.id));
  st.toast({
    tone: o.tone,
    title: o.title,
    detail: o.lines[0],
    technical,
  });
  const added = useAppStore.getState().toasts.find((x) => !before.has(x.id));
  lastWriteToast = added ? added.id : null;
}

/**
 * Write units to the tag with the standard confirmation, sound and toasts.
 * Returns the result, or null when cancelled / failed (toast shown).
 *
 * - Returns null at once while another single-tag operation runs (busyOp, or one
 *   still asking) or batch issuing runs (toast) - before any dialog.
 * - busyOp = 'write' from the moment the operator confirmed until the document is
 *   updated: views lock editing and the read / write buttons (WRITE-13). Not
 *   while the confirmation is open: nothing says "writing" before the answer (D13).
 * - The result stays in store.lastWrite (<LastWriteCallout />); a success shows
 *   no toast (D13).
 */
export async function writeWithConfirm(req: WriteRequest, ui: WriteUi): Promise<WriteResult | null> {
  const st = useAppStore.getState();
  if (tagOpRunning()) return null;
  if (refuseWhileIssuing()) return null;
  if (req.writes.length === 0) {
    st.toast({ tone: 'info', title: tr('op.write.nothing') });
    return null;
  }
  pendingOp = 'write';
  try {
    const l = lang();
    const texts = writeConfirmTexts(useAppStore.getState().doc, req, ui, l);
    const mustConfirm = ui.dangerous || !!ui.typeToConfirm || (!ui.skipConfirm && (st.settings.confirmBeforeWrite || texts.force));
    if (mustConfirm) {
      const details = [...(ui.details ?? []), translate(l, 'op.write.confirm.keepPlaced')];
      if (ui.reactivateAfter) details.push(translate(l, 'op.write.confirm.reactivate'));
      const ok = await st.confirm({
        title: ui.title,
        message: ui.message,
        target: texts.target,
        warning: texts.warning ?? undefined,
        details,
        tone: ui.dangerous ? 'danger' : texts.warning ? 'warn' : 'default',
        typeToConfirm: ui.typeToConfirm,
        confirmLabel: ui.confirmLabel ?? translate(l, 'common.writeTag'),
      });
      if (!ok) return null;
    }
    useAppStore.getState().setBusyOp('write');

    const docBefore = useAppStore.getState().doc;
    let res: WriteResult;
    try {
      res = await api.writeTag(req);
    } catch (err) {
      beep('error');
      const code = err instanceof AppError ? err.code : null;
      const untouched = !!code && PRE_WRITE_CODES.has(code);
      const t = errorToast(err, translate(l, 'op.write.failedTitle'));
      const outcome: WriteOutcome = {
        at: Date.now(),
        tone: 'danger',
        title: translate(l, 'op.write.failedTitle'),
        lines: [errorText(err).message, translate(l, untouched ? 'op.write.thrownNothing' : 'op.write.thrownMaybe')],
        uid: ui.target?.uid ?? req.expectedUid ?? '',
        kind: req.kind,
        reactivate: false,
      };
      useAppStore.getState().setLastWrite(outcome);
      showWriteToast(outcome, t.technical);
      return null;
    }

    const a = analyzeWrite(req, res);
    beep(a.success ? 'success' : 'error');

    const refresh = ui.refresh !== false;
    let readback: TagImage | null = null;
    if (refresh) {
      try {
        const img = await api.readTag(ui.readOptions ?? { ntagPassword: req.ntagPassword, mifareKeyIds: req.mifareKeyIds });
        // An interrupted re-read is not a trustworthy picture of the tag (CARD-4).
        readback = countUnitStatus(img.unitStatus).error > 0 ? null : img;
      } catch {
        readback = null; // reported in the result below (WRITE-6 / FLOW-7)
      }
    }

    const s = useAppStore.getState();
    const { plan, notes } = planDocAfterWrite({
      docBefore,
      docNow: s.doc,
      req,
      res,
      refresh,
      readback,
      keepUnitsOnFailure: ui.keepUnitsOnFailure,
      docCopy: ui.docCopy,
    });
    if (plan.action === 'commit' && readback) s.commitDoc(readback);
    else if (plan.action === 'rebase' && readback) s.rebaseDoc(readback, plan.keep);
    else if (plan.action === 'markWritten') s.markWritten(plan.writes);

    const outcome = buildWriteOutcome(req, res, notes, {
      lang: l,
      now: Date.now(),
      reactivateAfter: ui.reactivateAfter,
      successTitle: ui.successTitle,
      docKind: docBefore?.image.kind ?? null,
    });
    useAppStore.getState().setLastWrite(outcome);
    showWriteToast(outcome);
    return res;
  } finally {
    pendingOp = null;
    useAppStore.getState().setBusyOp(null);
  }
}
