// Pure helpers for the batch-issue (量産) view. No React / DOM imports, so the
// logic is unit-testable in a Node environment (tests/issue-*.test.ts).
// Owner: renderer-issue.
import type { DataSchema, IssueContext, SchemaField } from '@shared/schema/types';
import type {
  ErrorCode,
  IssueEvent,
  IssueJob,
  IssueLogEntry,
  IssueTemplate,
  LanguageSetting,
  ReaderStatus,
  UnitStatus,
} from '@shared/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import type { TagKind } from '@shared/tags';
import { factoryImage, isMifare, isNtag, isProtectedUnit, specFor } from '@shared/tags';
import { ERROR_MESSAGES } from '@shared/errorMessages';
import { SchemaValueError, buildSchemaWrites, encodeSchema, expandDraft } from '@shared/schema';
import { encodeDrafts, type2Capacity } from '@shared/ndef';

export interface Sequence {
  start: number;
  step: number;
  next: number;
}

export interface PreviewSlot {
  index: number;
  seq: number;
  rowIndex: number | null;
}

/**
 * The first `count` tags a job would issue: each tag's sequence value and (when a
 * CSV is loaded) the row index it draws from. Stops early when the CSV rows are
 * exhausted or the job's success limit is reached. Pure.
 */
export function previewSlots(args: {
  sequence: Sequence;
  /** Number of CSV rows, or null when no CSV is loaded. */
  rowCount: number | null;
  /** The job's starting rowIndex (normally 0). */
  rowStart: number;
  /** Stop after this many successful tags, or null for unlimited. */
  limit: number | null;
  /** How many preview slots to produce. */
  count: number;
}): PreviewSlot[] {
  const { sequence, rowCount, rowStart, limit, count } = args;
  const cap = limit != null ? Math.min(count, Math.max(0, limit)) : count;
  const out: PreviewSlot[] = [];
  for (let i = 0; i < cap; i++) {
    let rowIndex: number | null = null;
    if (rowCount != null) {
      rowIndex = rowStart + i;
      if (rowIndex >= rowCount) break; // rows exhausted
    }
    out.push({ index: i, seq: sequence.next + i * sequence.step, rowIndex });
  }
  return out;
}

/** Schema fields whose value is typed once per job (source "input"). */
export function schemaInputFields(schema: DataSchema): SchemaField[] {
  return schema.fields.filter((f) => f.source.kind === 'input');
}

/** CSV column names a schema references (source "csv"), first-seen order, deduped. */
export function schemaCsvColumns(schema: DataSchema): string[] {
  const cols: string[] = [];
  for (const f of schema.fields) {
    if (f.source.kind === 'csv' && !cols.includes(f.source.column)) cols.push(f.source.column);
  }
  return cols;
}

/** True when any field draws from the job's incrementing sequence counter. */
export function schemaUsesSequence(schema: DataSchema): boolean {
  return schema.fields.some((f) => f.source.kind === 'sequence');
}

/**
 * Writable data units of a tag kind, for duplicate (image) mode. Never includes
 * the UID, CC, lock/config, MIFARE block 0 or sector trailers — invariant I1:
 * the UID is never copied, only the data area.
 */
export function duplicateUnits(kind: TagKind): number[] {
  const out: number[] = [];
  const n = specFor(kind).unitCount;
  for (let u = 0; u < n; u++) if (!isProtectedUnit(kind, u)) out.push(u);
  return out;
}

/**
 * Bytes actually written when duplicating a source tag's data area: the number of
 * writable (non-protected) units times the unit size. This is strictly less than
 * imageSize(kind), which counts the whole tag including the UID / CC / config /
 * trailers that are never copied (invariant I1). Pure.
 */
export function duplicateSize(kind: TagKind): number {
  return duplicateUnits(kind).length * specFor(kind).unitSize;
}

/** Parse a user-typed integer. Returns null for anything that is not a whole number. */
export function parseIntInput(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** A short one-line summary of an NDEF record draft (no secrets: Wi-Fi password is not shown). */
export function summarizeDraft(r: NdefRecordDraft): string {
  switch (r.kind) {
    case 'uri':
      return r.uri;
    case 'text':
      return r.text;
    case 'wifi':
      return `Wi-Fi: ${r.ssid}`;
    case 'vcard':
      return r.fields.name;
    case 'mime':
      return r.mimeType;
    case 'aar':
      return r.packageName;
    case 'external':
      return r.domainType;
    case 'smartposter':
      return r.uri;
    case 'raw':
      return `raw (TNF ${r.tnf})`;
    case 'empty':
      return 'empty';
  }
}

// ---------------------------------------------------------------------------
// Live status (big-status panel while issuing)
// ---------------------------------------------------------------------------

/**
 * What the big-status panel shows (2026-11-12 UX audit ISSUE-1/5/8):
 *  - clear:   a tag was already on the reader at start - take it off first (it is never written)
 *  - waiting: place a tag (keep it there until the sound)
 *  - reading: tag detected, being checked - do not move it
 *  - writing: being written - do not move it
 *  - success / skipped / error: the result of the tag just handled
 *  - remove:  waiting for that tag to be taken off; the panel KEEPS its result (see issueResult)
 */
export type IssuePhase =
  | 'idle'
  | 'clear'
  | 'waiting'
  | 'reading'
  | 'writing'
  | 'success'
  | 'skipped'
  | 'error'
  | 'remove'
  | 'stopped';
export type BigStatusTone = 'ok' | 'danger' | 'warn' | 'accent' | 'neutral';
export type IssueOutcome = 'ok' | 'skipped' | 'error';

/** Map the latest issue event to the phase the big-status panel shows. Pure. */
export function issuePhase(last: IssueEvent | null): IssuePhase {
  if (!last) return 'idle';
  switch (last.type) {
    case 'clear-reader':
      return 'clear';
    case 'started':
    case 'waiting':
      return 'waiting';
    case 'reading':
      return 'reading';
    case 'writing':
      return 'writing';
    case 'success':
      return 'success';
    case 'skipped':
      return 'skipped';
    case 'error':
      return 'error';
    case 'remove-card':
      return 'remove';
    case 'stopped':
      return 'stopped';
  }
}

const OUTCOME_TONE: Record<IssueOutcome, BigStatusTone> = { ok: 'ok', skipped: 'warn', error: 'danger' };

/**
 * The big-status colour tone for a phase. For 'remove' pass the outcome of the
 * tag being taken off, so the result keeps its colour (green / yellow / red)
 * until the next tag is placed. Pure.
 */
export function phaseTone(phase: IssuePhase, outcome?: IssueOutcome | null): BigStatusTone {
  switch (phase) {
    case 'success':
      return 'ok';
    case 'error':
      return 'danger';
    case 'skipped':
      return 'warn';
    case 'remove':
      return outcome ? OUTCOME_TONE[outcome] : 'warn';
    case 'clear':
      return 'warn';
    case 'reading':
    case 'writing':
    case 'waiting':
      return 'accent';
    case 'stopped':
    case 'idle':
      return 'neutral';
  }
}

/** The result of the tag just handled, as the running panel shows it. */
export interface IssueShownResult {
  outcome: IssueOutcome;
  uid: string | null;
  kind: TagKind | null;
  seq: number | null;
  values: Record<string, string>;
  /** Skip reason (outcome 'skipped'). */
  reason: 'duplicate' | 'not-blank' | 'wrong-kind' | 'source' | null;
  /** Engine message (may be an ErrorCode; localize with issueMessageCode). */
  message: string | null;
  /** The tag was partly written: putting the SAME tag back rewrites the same number. */
  partial: boolean;
}

/** Minimal shape of the store's newest issueRecent item (store/app.ts IssueResultItem). */
export interface RecentLike {
  outcome: IssueOutcome;
  uid: string | null;
  partial: boolean;
}

/**
 * The result to keep on screen for the latest event: the result events
 * themselves, and 'remove-card' (which carries the outcome of the tag being
 * taken off). The 'error' -> 'remove-card' pair arrives within the same tick, so
 * the panel may never render the 'error' event: `partial` for a remove-card is
 * taken from the newest store item when it is the same tag. Null otherwise. Pure.
 */
export function issueResult(last: IssueEvent | null, newest?: RecentLike | null): IssueShownResult | null {
  if (!last) return null;
  switch (last.type) {
    case 'success':
      return fromEntry('ok', last.entry, null, null, false);
    case 'skipped':
      return fromEntry('skipped', last.entry, last.reason, last.entry.message, false);
    case 'error':
      return fromEntry('error', last.entry, null, last.message, last.partial);
    case 'remove-card': {
      const partial =
        last.outcome === 'error' &&
        !!newest &&
        newest.outcome === 'error' &&
        newest.partial &&
        (newest.uid == null || newest.uid.toUpperCase() === last.uid.toUpperCase());
      const r = fromEntry(last.outcome, last.entry, null, last.message, partial);
      if (!r.uid) r.uid = last.uid;
      if (last.outcome === 'skipped') r.reason = skipReasonFromMessage(last.message);
      return r;
    }
    default:
      return null;
  }
}

function fromEntry(
  outcome: IssueOutcome,
  entry: IssueLogEntry | null,
  reason: IssueShownResult['reason'],
  message: string | null,
  partial: boolean,
): IssueShownResult {
  return {
    outcome,
    uid: entry?.uid ?? null,
    kind: entry?.kind ?? null,
    seq: outcome === 'ok' || outcome === 'error' ? (entry?.seq ?? null) : null,
    values: entry?.values ?? {},
    reason,
    message: message ?? entry?.message ?? null,
    partial,
  };
}

const SKIP_REASONS = ['duplicate', 'not-blank', 'wrong-kind', 'source'] as const;

/** A remove-card for a skipped tag may carry the skip reason id as its message. */
function skipReasonFromMessage(message: string | null): IssueShownResult['reason'] {
  return SKIP_REASONS.find((r) => r === message) ?? null;
}

/**
 * When an engine / log message is an ErrorCode ("CARD_REMOVED") or starts with
 * one ("CARD_REMOVED: detail" - the OpError message form), return the code so the
 * view shows errorMessage(code, lang) instead of the raw code (ISSUE-9). Pure.
 */
export function issueMessageCode(message: string | null | undefined): ErrorCode | null {
  if (!message) return null;
  const m = /^([A-Z][A-Z_]+)(?::|$)/.exec(message.trim());
  if (!m) return null;
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, m[1]) ? (m[1] as ErrorCode) : null;
}

const LANGS: readonly LanguageSetting[] = ['ja', 'en'];

/**
 * The ErrorCode behind an engine / store message: a raw code ("CARD_REMOVED",
 * "CODE: detail"), or a sentence that starts with that code's errorMessage in
 * either language (the engine composes "<errorMessage(code)> <note>"). The
 * longest matching message wins. Null for other text. Pure.
 */
export function messageErrorCode(message: string | null | undefined): ErrorCode | null {
  const raw = issueMessageCode(message);
  if (raw) return raw;
  if (!message) return null;
  const m = message.trim();
  let best: ErrorCode | null = null;
  let bestLen = 0;
  for (const code of Object.keys(ERROR_MESSAGES) as ErrorCode[]) {
    for (const lang of LANGS) {
      const text = ERROR_MESSAGES[code][lang];
      if (text.length > bestLen && m.startsWith(text)) {
        best = code;
        bestLen = text.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// What to do after a failed tag (R-ISSUE-10) and why a run stopped (R-ISSUE-9)
// ---------------------------------------------------------------------------

/**
 * The next step after a failed tag:
 *  - retry-same:  a passing failure (taken off too early, no answer, a read glitch):
 *                 take it off and place the SAME tag again
 *  - use-another: placing this tag again fails the same way (protected, needs a
 *                 password / key, unsupported, cannot be laid out): place ANOTHER tag
 *  - partial:     half-written: put the same tag back to rewrite the same number
 *  - none:        no tag was involved (a CSV row / the template); nothing to do with a tag
 */
export type ErrorAdvice = 'retry-same' | 'use-another' | 'partial' | 'none';

/** Failures that repeat on the same tag. Everything else is worth one more try. */
const USE_ANOTHER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'ACCESS_DENIED',
  'AUTH_FAILED',
  'UNSUPPORTED_TAG',
  'PROTECTED_UNIT',
  'FORBIDDEN_UNIT',
  'KIND_MISMATCH',
  'INVALID_ACCESS_BITS',
  'READER_NO_AUTH',
]);

/**
 * The engine's own "this tag cannot take the data" texts (main/issue/messages.ts
 * tagBuild / tagBuildNoDetail) end with "place another tag". Locked by a unit test
 * against the engine's texts (tests/issue-model.test.ts) until the error event
 * carries the advice itself (contract request).
 */
const USE_ANOTHER_PHRASES = ['別のタグを置いて', 'Place another tag'];

/** Pure: which next step the running panel shows under a failed tag's reason. */
export function errorAdvice(r: { message: string | null; partial: boolean; uid: string | null }): ErrorAdvice {
  if (r.partial) return 'partial';
  if (!r.uid) return 'none';
  const code = messageErrorCode(r.message);
  if (code) return USE_ANOTHER_CODES.has(code) ? 'use-another' : 'retry-same';
  if (r.message && USE_ANOTHER_PHRASES.some((p) => r.message!.includes(p))) return 'use-another';
  return 'retry-same';
}

/** Stops caused by the reader / PC/SC: "check the reader and the tag" helps only for these. */
const READER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['NO_SERVICE', 'NO_READER', 'READER_IN_USE', 'NO_CARD', 'CARD_UNRESPONSIVE']);

/**
 * Why a run stopped on an error, from its message (R-ISSUE-9):
 *  - reader:  the reader / service went away (engine waitFailed, NO_READER, ...)
 *  - other:   the template / CSV / a tag - the message itself says what to fix
 *  - unknown: no message (keep the generic "check the reader and the tag")
 * Pure.
 */
export function stopCauseKind(message: string | null | undefined): 'reader' | 'other' | 'unknown' {
  if (!message || !message.trim()) return 'unknown';
  const code = messageErrorCode(message);
  if (code) return READER_CODES.has(code) ? 'reader' : 'other';
  // engine waitFailed: "リーダーの状態を確かめられなくなった…" / "…the reader state could not be checked"
  return /リーダー|\breaders?\b/i.test(message) ? 'reader' : 'other';
}

/**
 * The message of the error that stopped the last run: the store's own summary
 * message when it has one, else the newest result (the engine emits the stopping
 * 'error' right before 'stopped', and issueRecent keeps it until the next start).
 * Null when the run did not stop on an error. Pure.
 */
export function stopCauseMessage(
  run: { reason: LastRunLike['reason']; message?: string | null } | null,
  recent: readonly { outcome: IssueOutcome; message: string | null }[],
): string | null {
  if (!run || run.reason !== 'error') return null;
  if (run.message) return run.message;
  const head = recent[0];
  return head && head.outcome === 'error' ? head.message : null;
}

/** The run's sounds play only when the job asked for them AND sounds are on in Settings (store/app.ts). Pure. */
export function issueSoundOn(jobSound: boolean | null | undefined, globalSound: boolean): boolean {
  return jobSound !== false && globalSound;
}

// ---------------------------------------------------------------------------
// Reader capability for NTAG passwords (R-UX-1 / D11)
// ---------------------------------------------------------------------------

/**
 * Can the active reader send NTAG password authentication (PWD_AUTH)?
 *  - raw:     yes (ACR122U / transparent readers, the virtual reader)
 *  - storage: no (storage-only readers such as Sony PaSoRi): a password-protected
 *             tag can never be rewritten (or read, with read protection) on it
 *  - unknown: no tag on a real reader in automatic mode - main resolves the
 *             transport from the reader name, which the renderer does not see
 * The tag on the active reader tells it for sure (CardInfo.rawCommands). Pure.
 */
export type ReaderAuth = 'raw' | 'storage' | 'unknown';

export function readerAuth(r: ReaderStatus | null): ReaderAuth {
  if (!r || !r.activeReader) return 'unknown';
  if (r.card && r.card.readerName === r.activeReader) return r.card.rawCommands ? 'raw' : 'storage';
  // No tag: the transport main resolved for the active reader (D11).
  if (r.activeDriver) return r.activeDriver === 'storage' ? 'storage' : 'raw';
  if (r.driverMode === 'storage') return 'storage';
  if (r.driverMode === 'acr122' || r.driverMode === 'transparent') return 'raw';
  const active = r.readers.find((x) => x.name === r.activeReader);
  return active?.virtual ? 'raw' : 'unknown';
}

/** The password and its confirmation are the same hex value (case does not matter). Pure. */
export function ntagPasswordsMatch(password: string, confirmation: string): boolean {
  return password.trim().toUpperCase() === confirmation.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Resume after a stop (ISSUE-3/7)
// ---------------------------------------------------------------------------

export interface LastRunLike {
  reason: 'user' | 'limit' | 'rows-exhausted' | 'error';
  issued: number;
  job: IssueJob | null;
}

export interface ResumePlan {
  /** Same job id: the engine's per-job duplicate check and the log keep one job. */
  id: string;
  name: string;
  /** Sequence value the next tag receives. */
  next: number;
  /** CSV row index (0-based) the next tag draws from. */
  rowIndex: number;
  /** Success limit for the resumed run (the remainder of the original limit), or null. */
  limit: number | null;
  /** Tags issued by this job so far, across every resumed run. */
  issuedTotal: number;
}

/**
 * Values for "resume" after a run stopped, or null when there is nothing to
 * resume (no job / every CSV row issued). `carried`: tags issued by earlier runs
 * of the same job (before the last one). `limit`: the success limit typed in the
 * form now (null = unlimited). A run that stopped AT its limit resumes with a
 * fresh limit (the next batch); a run stopped early resumes with the remainder.
 * `rowCount`: rows of the CSV loaded now (null = none); `rowStart`: the form's
 * start row (0-based), used when the stopped job had no CSV. Pure.
 */
export function resumePlan(
  last: LastRunLike | null,
  args: { carried: number; limit: number | null; rowCount: number | null; rowStart?: number },
): ResumePlan | null {
  if (!last || !last.job) return null;
  const j = last.job;
  const issuedTotal = args.carried + last.issued;
  if (j.rows && args.rowCount == null) return null; // the CSV the job used is no longer loaded
  const rowIndex = j.rows ? j.rowIndex : Math.max(0, args.rowStart ?? 0);
  if (args.rowCount != null && rowIndex >= args.rowCount) return null; // every row issued
  let limit = args.limit;
  if (limit != null && last.reason !== 'limit') {
    limit = Math.max(0, limit - issuedTotal);
    if (limit === 0) return null;
  }
  return { id: j.id, name: j.name, next: j.sequence.next, rowIndex, limit, issuedTotal };
}

// ---------------------------------------------------------------------------
// Duplicate (image) mode (ISSUE-12)
// ---------------------------------------------------------------------------

/**
 * Units copied from a source image: the writable data units (duplicateUnits)
 * that were actually read ('ok'). Units the source could not read (password /
 * key / error) are zero-filled in the image and must NOT be written over the
 * target's data. Pure.
 */
export function duplicatePlan(kind: TagKind, unitStatus: readonly UnitStatus[]): { units: number[]; unread: number[] } {
  const units: number[] = [];
  const unread: number[] = [];
  for (const u of duplicateUnits(kind)) {
    if ((unitStatus[u] ?? 'unread') === 'ok') units.push(u);
    else unread.push(u);
  }
  return { units, unread };
}

// ---------------------------------------------------------------------------
// CSV / template check before starting (ISSUE-4)
// ---------------------------------------------------------------------------

export type RowProblem =
  /** `row`: 1-based CSV data row (header not counted); null = the template itself (no CSV). */
  | { row: number | null; type: 'too-big'; bytes: number; cap: number }
  | { row: number | null; type: 'value'; fieldId: string | null; message: string };

/** A placeholder UID of the kind's length, so {{uid}} / uid fields encode at their real size. */
export function dummyUid(kind: TagKind): string {
  return '0'.repeat(specFor(kind).uidBytes * 2);
}

/**
 * Try to build the data for every tag the job would issue (each CSV row from
 * `rowStart`, or one tag when there is no CSV) and report the rows that cannot
 * be written: values that do not fit the schema, NDEF messages larger than the
 * NTAG's capacity. A bad row would otherwise fail on every tag placed (the
 * engine does not skip it). Duplicate mode has nothing to check. Pure.
 */
export function findBadRows(a: {
  template: IssueTemplate;
  kind: TagKind;
  rows: Record<string, string>[] | null;
  rowStart: number;
  next: number;
  step: number;
  now: Date;
  /** How many problems to return in `first` (the count covers every row). */
  max?: number;
}): { count: number; first: RowProblem[] } {
  const max = a.max ?? 5;
  const first: RowProblem[] = [];
  let count = 0;
  if (a.template.type === 'image') return { count, first };
  const uid = dummyUid(a.kind);
  const indices: (number | null)[] = [];
  if (a.rows) for (let i = Math.max(0, a.rowStart); i < a.rows.length; i++) indices.push(i);
  else indices.push(null);
  let n = 0;
  for (const i of indices) {
    const ctx: IssueContext = {
      seq: a.next + n * a.step,
      row: i != null && a.rows ? (a.rows[i] ?? null) : null,
      inputs: a.template.type === 'schema' ? a.template.inputs : {},
      uid,
      now: a.now,
    };
    n += 1;
    const p = checkOne(a.template, a.kind, ctx, i == null ? null : i + 1);
    if (p) {
      count += 1;
      if (first.length < max) first.push(p);
    }
  }
  return { count, first };
}

function checkOne(tpl: IssueTemplate, kind: TagKind, ctx: IssueContext, row: number | null): RowProblem | null {
  try {
    if (tpl.type === 'schema') {
      const { bytes } = encodeSchema(tpl.schema, ctx);
      if (tpl.schema.area.mode === 'ndef' && isNtag(kind)) {
        buildSchemaWrites(tpl.schema, kind, factoryImage(kind, new Uint8Array(specFor(kind).uidBytes)), bytes);
      }
      return null;
    }
    if (tpl.type === 'ndef') {
      const message = encodeDrafts(tpl.records.map((r) => expandDraft(r, ctx)));
      if (isNtag(kind)) {
        const cap = type2Capacity(kind);
        if (message.length > cap) return { row, type: 'too-big', bytes: message.length, cap };
      }
      return null;
    }
    return null;
  } catch (err) {
    const fieldId = err instanceof SchemaValueError && !err.fieldId.startsWith('_') ? err.fieldId : null;
    return { row, type: 'value', fieldId, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Checks before starting (ISSUE-5/10): what stops the start button (block),
// what the operator must know (warn / info). The view maps codes to i18n.
// ---------------------------------------------------------------------------

export type StartCheckCode =
  // reader
  | 'service'
  | 'no-reader'
  | 'selected-missing'
  | 'busy'
  // template / values
  | 'no-schema'
  | 'no-ndef'
  | 'no-image'
  | 'image-empty'
  | 'ndef-kind'
  | 'bad-seq'
  | 'bad-limit'
  | 'bad-row-start'
  | 'no-rows-left'
  | 'csv-needed'
  | 'csv-missing-cols'
  | 'bad-rows'
  | 'no-keys'
  | 'bad-password'
  | 'password-mismatch'
  /** The virtual reader hides a tag on a real reader: say which one to use first (R-ISSUE-6). */
  | 'virtual-ignored'
  // warnings / information
  | 'ndef-mifare'
  | 'protect-storage'
  | 'protect-reader-unknown'
  | 'virtual'
  | 'kind-differs'
  | 'tag-on-reader'
  | 'source-on-reader';

export interface StartCheck {
  level: 'block' | 'warn' | 'info';
  code: StartCheckCode;
  vars?: Record<string, string | number>;
}

export interface StartCheckInput {
  reader: ReaderStatus | null;
  /** Renderer-side single-tag operation in flight (store busyOp). */
  busyOp: string | null;
  template: 'schema' | 'ndef' | 'image';
  /** The template has its content (a schema chosen, NDEF records, a duplicate source). */
  templateReady: boolean;
  kind: TagKind;
  seqOk: boolean;
  limitOk: boolean;
  /** Loaded CSV, or null. */
  csv: { header: string[]; rowCount: number } | null;
  /** 0-based start row parsed from the form; null = invalid input. */
  rowStart: number | null;
  /** CSV columns the schema reads (schema templates). */
  csvColumns: string[];
  badRows: { count: number } | null;
  /** MIFARE keys selected (count). */
  mifareKeys: number;
  /** NTAG password protection is on and its password / PACK are not valid hex. */
  badPassword: boolean;
  /** NTAG password protection is on (advanced mode, NTAG job). */
  protect?: boolean;
  /** The password and its confirmation differ (R-UX-2). */
  passwordMismatch?: boolean;
  /** Can the active reader authenticate with an NTAG password (readerAuth)? */
  readerAuth?: ReaderAuth;
  /** Duplicate mode: the source tag's UID. */
  sourceUid: string | null;
  /** Duplicate mode: how many data units the source could read (null = not duplicate mode). */
  imageUnits?: number | null;
}

/** Ordered checks: blocks first, then warnings, then information. Pure. */
export function startChecks(i: StartCheckInput): StartCheck[] {
  const out: StartCheck[] = [];
  const r = i.reader;

  // --- reader ---
  if (!r || r.service === 'unavailable' || r.service === 'error') {
    out.push({ level: 'block', code: 'service' });
  } else if (r.activeReason === 'selected-missing') {
    out.push({ level: 'block', code: 'selected-missing', vars: { name: r.selectedReader ?? '' } });
  } else if (!r.activeReader || r.cardState === 'no-reader') {
    out.push({ level: 'block', code: 'no-reader' });
  }
  if (i.busyOp || (r?.busy && (r.busy.op === 'read' || r.busy.op === 'write' || r.busy.op === 'format'))) {
    out.push({ level: 'block', code: 'busy' });
  }

  // --- template ---
  if (!i.templateReady) {
    out.push({ level: 'block', code: i.template === 'schema' ? 'no-schema' : i.template === 'ndef' ? 'no-ndef' : 'no-image' });
  } else if (i.template === 'image' && i.imageUnits === 0) {
    out.push({ level: 'block', code: 'image-empty' });
  }
  if (i.template === 'ndef' && !isNtag(i.kind) && !isMifare(i.kind)) {
    out.push({ level: 'block', code: 'ndef-kind' });
  }
  if (!i.seqOk) out.push({ level: 'block', code: 'bad-seq' });
  if (!i.limitOk) out.push({ level: 'block', code: 'bad-limit' });
  if (i.csv) {
    if (i.rowStart == null || i.rowStart < 0) out.push({ level: 'block', code: 'bad-row-start' });
    else if (i.rowStart >= i.csv.rowCount) out.push({ level: 'block', code: 'no-rows-left', vars: { rows: i.csv.rowCount } });
    const missing = i.csvColumns.filter((c) => !i.csv!.header.includes(c));
    if (missing.length > 0) out.push({ level: 'block', code: 'csv-missing-cols', vars: { cols: missing.join(', ') } });
  } else if (i.template === 'schema' && i.csvColumns.length > 0) {
    out.push({ level: 'block', code: 'csv-needed', vars: { cols: i.csvColumns.join(', ') } });
  }
  if (i.badRows && i.badRows.count > 0 && i.templateReady) {
    out.push({ level: 'block', code: 'bad-rows', vars: { n: i.badRows.count } });
  }
  if (isMifare(i.kind) && i.mifareKeys === 0) out.push({ level: 'block', code: 'no-keys' });
  if (i.badPassword) out.push({ level: 'block', code: 'bad-password' });
  else if (i.passwordMismatch) out.push({ level: 'block', code: 'password-mismatch' });
  // A real tag on a real reader while the virtual reader wins: the operator most
  // likely means the real tag, and the run would write only virtual tags. Make
  // them choose first (turn the virtual reader off, or take the real tag off)
  // instead of starting on a warning (R-ISSUE-6).
  if (r?.ignoredRealReader) out.push({ level: 'block', code: 'virtual-ignored', vars: { name: r.ignoredRealReader } });

  // --- warnings ---
  if (i.template === 'ndef' && isMifare(i.kind)) out.push({ level: 'warn', code: 'ndef-mifare' });
  // D11: protecting on a storage reader leaves tags this reader can never rewrite.
  if (i.protect && i.readerAuth === 'storage') out.push({ level: 'warn', code: 'protect-storage' });
  if (r) {
    const active = r.activeReader ? r.readers.find((x) => x.name === r.activeReader) : undefined;
    if (!r.ignoredRealReader && active?.virtual) out.push({ level: 'warn', code: 'virtual' });
    const tagOn = r.cardState === 'detecting' || r.cardState === 'ready' || r.cardState === 'unsupported' || r.cardState === 'error';
    if (r.cardState === 'ready' && r.card?.kind && r.card.kind !== i.kind) {
      out.push({ level: 'warn', code: 'kind-differs', vars: { cardKind: r.card.kind, kind: i.kind } });
    }
    if (tagOn) {
      const uid = r.card?.uid ?? '';
      const isSource = !!uid && !!i.sourceUid && uid.toUpperCase() === i.sourceUid.toUpperCase();
      out.push({ level: 'info', code: isSource ? 'source-on-reader' : 'tag-on-reader', vars: { uid } });
    }
  }
  if (i.protect && i.readerAuth === 'unknown') out.push({ level: 'info', code: 'protect-reader-unknown' });
  return out;
}

/** NTAG password: 8 hex digits; PACK: 4 hex digits. Pure. */
export function validNtagSecret(password: string, pack: string): boolean {
  return /^[0-9a-fA-F]{8}$/.test(password.trim()) && /^[0-9a-fA-F]{4}$/.test(pack.trim());
}

/** "2026-11-12 14:05" (local time) for the default job name (ISSUE-16). Pure. */
export function jobStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
