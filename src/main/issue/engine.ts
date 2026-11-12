// Batch provisioning engine. Owner: main-app.
// Drives the "place a tag -> write the next value -> wait for removal -> repeat"
// loop used to issue many tags (employee IDs with an incrementing sequence,
// CSV rows, NDEF templates, or a duplicate image). It never touches a UID
// (invariant I1/I2) and never logs keys/passwords (I4).
//
// Behaviour fixed by the 2026-11-12 UX audit (ISSUE-1..5, 7..9, 12, 14, 15):
//  - A tag already on the reader when the run starts is never written: the
//    engine emits 'clear-reader' and waits until that tag is really gone (ISSUE-5).
//  - Each tag goes 'reading' -> 'writing' -> success/skipped/error, and the
//    outcome is repeated on 'remove-card' so the UI keeps it on screen (ISSUE-1/8).
//  - A tag left half-written (removed mid-write, or the read-back did not match)
//    keeps its number: the SAME tag placed again is rewritten with that number;
//    when ANOTHER tag takes the number instead, the reserved one is retired and
//    logged as "欠番" so no two tags carry the same number (ISSUE-2).
//  - A CSV row that cannot be encoded is logged and skipped before any tag is
//    used for it; without rows a template error stops the run (ISSUE-4).
//  - 'stopped' carries the reason and the job (sequence.next / rowIndex);
//    starting the same job id again continues from there (ISSUE-3/7).
//  - Duplicate UIDs are checked against the whole issue log (ISSUE-3).
//  - Every attempt is logged, with plain ja/en messages (ISSUE-9).
//  - A stop request never cuts a write; the current tag is finished first (ISSUE-15).
//
// And by the 2026-11-12 adversarial review (round 2):
//  - writeTag rejects only BEFORE the first unit is sent (contract), so an OpError
//    rejection never makes a tag "half-written" (R-MAIN-1). Only an exception that
//    is not an OpError (a bug) is treated as "may have written".
//  - Removal = "absent" lasting REMOVAL_SETTLE_MS without the reader / service
//    going away - also at the start (clear-reader) and also when the SAME tag is
//    detected again after a short drop-out (R-ISSUE-1/2). A tag on the reader at
//    start that is not identified yet gets its UID as soon as it is known (R-ISSUE-13).
//  - `issued` / `limit` count THIS run (the UI adds the earlier runs), so "resume"
//    issues exactly the remaining / next batch (R-ISSUE-3).
//  - The last run is saved (summary only, no secrets) and restored on the next
//    start of the app; a resumed job id never reuses a number found in the log (R-ISSUE-4).
//  - A number reserved for a half-written tag A is retired only once ANOTHER tag B
//    was actually written (B is built with the next number meanwhile). A B that
//    fails before writing leaves A's reservation alone (R-ISSUE-8). The retirement
//    is logged with A's values and announced on B's 'remove-card' message (R-ISSUE-5).
//    A CSV row of a retired tag goes to the next tag (the half-written one is unusable).
//  - A stop pressed while a tag is being checked is honoured before writing (R-ISSUE-7).
import type {
  CardInfo,
  ErrorCode,
  IssueEvent,
  IssueJob,
  IssueLogEntry,
  IssuePreview,
  LanguageSetting,
  ReaderStatus,
  TagImage,
  UnitWrite,
  WriteRequest,
  WriteResult,
} from '@shared/types';
import type { IssueState as ApiIssueState } from '@shared/api';
import type { IssueContext } from '@shared/schema/types';
import { factoryImage, isFelica, isMifare, isNtag, specFor, type TagKind } from '@shared/tags';
import { encodeSchema, buildSchemaWrites, expandDraft, SchemaValueError } from '@shared/schema';
import { encodeDrafts, buildType2UserArea, buildMifareNdefWrites, describeDraft, NdefError } from '@shared/ndef';
import { isBlankDataArea, buildNtagPasswordWrites } from '@shared/tag';
import { hexToBytes } from '@shared/hex';
import type { NfcService } from '../nfc/contract';
import { OpError } from '../errors';
import type { IssueLog } from '../services/issuelog';
import { codeText, detailFor, formatUidText, issueText, kindText } from './messages';
import { summarizeJob, type IssueStopReason, type SavedIssueRun } from './saved-run';

/** Where the last run is kept across app restarts (services/issuerun.ts). */
export interface IssueRunPersistence {
  get(): SavedIssueRun | null;
  save(run: SavedIssueRun): Promise<void> | void;
}

export interface IssueEngineDeps {
  nfc: NfcService;
  log: IssueLog;
  emit: (e: IssueEvent) => void;
  newId: () => string;
  now: () => Date;
  /** UI language for result messages (default 'ja'). */
  lang?: () => LanguageSetting;
  /**
   * How long "no tag" must last before a handled tag counts as removed (default
   * REMOVAL_SETTLE_MS). Tests pass 0. See waitForTagGone.
   */
  removalSettleMs?: number;
  /** Saves the last run (and restores it when the engine is created). Optional (tests). */
  runStore?: IssueRunPersistence;
}

export type IssueState = ApiIssueState;

export interface IssueEngine {
  start(job: IssueJob): void;
  /** Ask the run to stop. The tag being written is finished first. */
  stop(): void;
  /** stop() and wait (up to timeoutMs) until the run loop has ended - used on quit. */
  stopAndWait(timeoutMs?: number): Promise<void>;
  /**
   * running / job / issued (this run) / last event. Before any run in this
   * session, the run saved by an earlier session: last = its 'stopped' event with
   * the summary job, issued = that job's total over all its runs.
   */
  getState(): IssueState;
  /** Preview the value that the next tag will receive, without a card. */
  preview(job: IssueJob): IssuePreview;
}

/**
 * A PC/SC context that dies (service restart, sleep / resume, USB reset) reports
 * every tag "removed" and then the reader list empty; when it comes back the SAME
 * tag is "inserted" again. A tag at the edge of the field can also vanish for one
 * poll (300 ms) and come back. So "absent" only counts as a removal once it has
 * lasted a bit longer than one poll without the reader / service going away -
 * otherwise the issued tag, still on the reader, would get the next number
 * (with skipDuplicateUid off nothing else stops it). (2026-11-12 MAIN-NFC request)
 */
const REMOVAL_SETTLE_MS = 400;

/** Stop after this many CSV rows in a row could not be encoded (the template / CSV likely do not match). */
const MAX_BAD_ROW_STREAK = 5;

/**
 * writeTag rejections that every tag of this job would hit (the data, not the
 * tag): stop the run with the reason instead of failing tag after tag.
 */
const LAYOUT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['PROTECTED_UNIT', 'FORBIDDEN_UNIT', 'INVALID_ACCESS_BITS']);
const FATAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([...LAYOUT_CODES, 'ADVANCED_REQUIRED']);

type Outcome = 'ok' | 'skipped' | 'error';
interface TagResult {
  outcome: Outcome;
  entry: IssueLogEntry | null;
  message: string | null;
  /** Stop the run after this tag (a template error that every tag would hit). */
  fatal?: boolean;
  /** A half-written tag's number was retired while handling this tag (shown with its result). */
  voidNote?: string | null;
}

/** The number (and CSV row) a half-written tag keeps until the same tag comes back (or another tag takes it). */
interface Reservation {
  jobId: string;
  uid: string;
  seq: number | null;
  /** CSV row it holds (null = no CSV). */
  rowIndex: number | null;
  /** What was (partly) written to it - kept on the "欠番" record so the log tells who it was for. */
  values: Record<string, string>;
}

/** Thrown inside the run loop to stop with reason 'error' after the message was emitted. */
class StopRun extends Error {}

export function createIssueEngine(deps: IssueEngineDeps): IssueEngine {
  let job: IssueJob | null = null;
  let abort: AbortController | null = null;
  /** Tags issued in the current / last run (R-ISSUE-3: the limit counts this run). */
  let issued = 0;
  /** Tags this job id had issued before the current run (earlier runs, earlier sessions). */
  let base = 0;
  let last: IssueEvent | null = null;
  let running = false;
  let runPromise: Promise<void> | null = null;
  let reserved: Reservation | null = null;
  /** Progress of jobs run in this session, by id: a restart of the same id continues (ISSUE-3). `issued` = job total. */
  const progress = new Map<string, { next: number; rowIndex: number; issued: number }>();

  const L = (): LanguageSetting => deps.lang?.() ?? 'ja';

  // The run an earlier session ended with (R-ISSUE-4): offered as "resume".
  const restored = safeRestored();
  if (restored) {
    job = restored.job;
    issued = restored.total;
    last = { type: 'stopped', reason: restored.reason, issued: restored.total, job: restored.job };
    progress.set(restored.job.id, { next: restored.job.sequence.next, rowIndex: restored.job.rowIndex, issued: restored.total });
  }

  function emit(e: IssueEvent): void {
    last = e;
    deps.emit(e);
  }

  // --- values ------------------------------------------------------------------

  function placeholderUid(kind: TagKind): string {
    return isNtag(kind) ? '04000000000000' : isMifare(kind) ? '00000000' : '0000000000000000';
  }

  function contextFor(j: IssueJob, uid: string | null): IssueContext {
    const row = j.rows ? (j.rows[j.rowIndex] ?? null) : null;
    const inputs = j.template.type === 'schema' ? j.template.inputs : {};
    return { seq: j.sequence.next, row, inputs, uid, now: deps.now() };
  }

  function usesSequence(j: IssueJob): boolean {
    if (j.template.type === 'schema') return j.template.schema.fields.some((f) => f.source.kind === 'sequence');
    if (j.template.type === 'ndef') return JSON.stringify(j.template.records).includes('{{seq');
    return false;
  }

  function previewOf(j: IssueJob): IssuePreview {
    const lang = L();
    try {
      if (j.template.type === 'schema') {
        const { values } = encodeSchema(j.template.schema, contextFor(j, null));
        return { seq: j.sequence.next, rowIndex: j.rows ? j.rowIndex : null, values };
      }
      if (j.template.type === 'ndef') {
        const ctx = contextFor(j, null);
        const values: Record<string, string> = { seq: String(j.sequence.next) };
        if (ctx.row) Object.assign(values, ctx.row);
        return { seq: j.sequence.next, rowIndex: j.rows ? j.rowIndex : null, values };
      }
      return { seq: null, rowIndex: null, values: { [issueText('previewImageKey', lang)]: issueText('previewImageValue', lang) } };
    } catch (err) {
      const detail = detailFor(err instanceof Error ? err.message : String(err), lang) ?? codeText('INVALID_INPUT', lang);
      return { seq: j.sequence.next, rowIndex: j.rows ? j.rowIndex : null, values: { [issueText('previewErrorKey', lang)]: detail } };
    }
  }

  /** Build the unit writes for one tag + the display values for the log. Throws SchemaValueError / NdefError. */
  function buildWrites(j: IssueJob, kind: TagKind, uid: string, data: Uint8Array): { writes: UnitWrite[]; values: Record<string, string>; seq: number | null } {
    const ctx = contextFor(j, uid);
    if (j.template.type === 'schema') {
      const { bytes, values } = encodeSchema(j.template.schema, ctx);
      const writes = buildSchemaWrites(j.template.schema, kind, data, bytes);
      return { writes, values, seq: j.sequence.next };
    }
    if (j.template.type === 'ndef') {
      if (isFelica(kind)) throw new TemplateError('felicaNdef');
      const expanded = j.template.records.map((r) => expandDraft(r, ctx));
      const message = encodeDrafts(expanded);
      let writes: UnitWrite[];
      if (isNtag(kind)) {
        const area = buildType2UserArea(kind, message);
        writes = [];
        const spec = specFor(kind);
        // area starts at page 4; emit one write per changed page
        for (let i = 0; i < area.length; i += 4) {
          const page = 4 + i / 4;
          const cur = data.subarray(page * 4, page * 4 + 4);
          const next = area.subarray(i, i + 4);
          if (!cur || cur.length < 4 || !eq(cur, next)) writes.push({ unit: page, data: Uint8Array.from(next) });
          if (page >= spec.unitCount - 1) break;
        }
      } else {
        writes = buildMifareNdefWrites(kind, data, message);
      }
      // A readable description instead of the encoded bytes (which could carry e.g. a Wi-Fi password).
      const values: Record<string, string> = {
        seq: String(j.sequence.next),
        ndef: expanded.map((d) => describeDraft(d, L())).join(' / '),
      };
      if (ctx.row) Object.assign(values, ctx.row);
      return { writes, values, seq: j.sequence.next };
    }
    // image (duplicate): write the given units verbatim.
    const tpl = j.template;
    const unitSize = specFor(kind).unitSize;
    const writes: UnitWrite[] = tpl.units.map((unit) => ({ unit, data: tpl.data.subarray(unit * unitSize, unit * unitSize + unitSize) }));
    return { writes, values: {}, seq: null };
  }

  /**
   * Try to encode the next value before asking for a tag (no tag is used for a
   * bad row). Only the steps that do not depend on the tag's current contents.
   * Returns null when fine.
   */
  function preflight(j: IssueJob): { message: string; templateLevel: boolean } | null {
    const lang = L();
    if (j.template.type === 'image') return null;
    try {
      if (j.template.type === 'ndef' && isFelica(j.kind)) throw new TemplateError('felicaNdef');
      const blank = factoryImage(j.kind, hexToBytes(placeholderUid(j.kind)));
      if (j.template.type === 'schema') {
        const schema = j.template.schema;
        const { bytes } = encodeSchema(schema, contextFor(j, placeholderUid(j.kind)));
        // The raw layout does not depend on the tag's contents (an NDEF area on MIFARE does: MAD).
        if (schema.area.mode === 'raw' || isNtag(j.kind)) buildSchemaWrites(schema, j.kind, blank, bytes);
      } else {
        const ctx = contextFor(j, placeholderUid(j.kind));
        const message = encodeDrafts(j.template.records.map((r) => expandDraft(r, ctx)));
        if (isNtag(j.kind)) buildType2UserArea(j.kind, message);
      }
      return null;
    } catch (err) {
      return describeBuildError(j, err, lang);
    }
  }

  function describeBuildError(j: IssueJob, err: unknown, lang: LanguageSetting): { message: string; templateLevel: boolean } {
    if (err instanceof TemplateError) return { message: issueText(err.key, lang), templateLevel: true };
    if (err instanceof SchemaValueError) {
      if (err.fieldId === '_area') return { message: issueText('badLayout', lang), templateLevel: true };
      const field = j.template.type === 'schema' ? j.template.schema.fields.find((f) => f.id === err.fieldId) : undefined;
      const msg = detailFor(err.message, lang);
      const label = field?.label ?? (err.fieldId.startsWith('_') ? null : err.fieldId);
      const detail = label ? (lang === 'ja' ? `「${label}」${msg ? `: ${msg}` : ''}` : `"${label}"${msg ? `: ${msg}` : ''}`) : msg;
      if (err.fieldId === '_template') {
        // e.g. an unknown placeholder: every row fails alike, so stop at once.
        const message = detail ? issueText('badTemplate', lang, { detail }) : issueText('badTemplateNoDetail', lang);
        return { message, templateLevel: true };
      }
      return { message: buildText(j, detail, lang), templateLevel: false };
    }
    if (err instanceof NdefError) return { message: buildText(j, detailFor(err.message, lang), lang), templateLevel: false };
    if (err instanceof OpError) return { message: buildText(j, codeText(err.code, lang), lang), templateLevel: false };
    return { message: buildText(j, null, lang), templateLevel: false };
  }

  function buildText(j: IssueJob, detail: string | null, lang: LanguageSetting): string {
    if (j.rows) {
      const row = j.rowIndex + 1;
      return detail ? issueText('badRow', lang, { row, detail }) : issueText('badRowNoDetail', lang, { row });
    }
    return detail ? issueText('badTemplate', lang, { detail }) : issueText('badTemplateNoDetail', lang);
  }

  // --- log helpers ---------------------------------------------------------------

  function entryFor(j: IssueJob, card: { uid: string; kind: TagKind | null } | null, rest: Pick<IssueLogEntry, 'seq' | 'values' | 'result' | 'message'>): IssueLogEntry {
    return {
      id: deps.newId(),
      jobId: j.id,
      jobName: j.name,
      at: deps.now().getTime(),
      uid: card?.uid ?? '',
      kind: card?.kind ?? null,
      ...rest,
    };
  }

  async function append(entry: IssueLogEntry): Promise<void> {
    try {
      await deps.log.append(entry);
    } catch {
      // The log is best-effort (disk full etc.); the tag result is still shown.
    }
  }

  function rowValues(j: IssueJob): Record<string, string> {
    return j.rows ? { ...(j.rows[j.rowIndex] ?? {}) } : {};
  }

  /**
   * Give up the number reserved for a half-written tag: log it as "欠番" (with what
   * was written to it) and move the sequence on. Returns the notice to show, or null.
   * The CSV row is NOT consumed: the next tag gets it (the half-written tag is unusable).
   */
  async function retireReservation(j: IssueJob): Promise<string | null> {
    const r = reserved;
    reserved = null;
    if (!r || r.jobId !== j.id) return null;
    const lang = L();
    const uid = formatUidText(r.uid);
    const message =
      r.seq != null
        ? issueText('voidedSeq', lang, { seq: r.seq, uid })
        : r.rowIndex != null
          ? issueText('voidedRow', lang, { uid, row: r.rowIndex + 1 })
          : issueText('voidedNoSeq', lang, { uid });
    await append(entryFor(j, { uid: r.uid, kind: j.kind }, { seq: r.seq, values: { ...r.values }, result: 'skipped', message }));
    if (r.seq != null && j.sequence.next === r.seq) j.sequence.next += j.sequence.step;
    return message;
  }

  // --- persistence (R-ISSUE-4) ---------------------------------------------------------

  function safeRestored(): SavedIssueRun | null {
    try {
      return deps.runStore?.get() ?? null;
    } catch {
      return null;
    }
  }

  /** Save the run's current state (summary only). Never throws; resolves when written (or failed). */
  async function persist(j: IssueJob, reason: IssueStopReason): Promise<void> {
    if (!deps.runStore) return;
    try {
      await deps.runStore.save({
        version: 1,
        endedAt: deps.now().getTime(),
        reason,
        issued,
        total: base + issued,
        rowCount: j.rows ? j.rows.length : null,
        job: summarizeJob(j),
      });
    } catch {
      // best effort: a full disk must not break issuing
    }
  }

  /**
   * The highest number already used by this job id in the log (issued, half-written
   * or retired), so a resumed job never hands it out again - also after a restart
   * that lost the in-memory progress. null when none / not applicable.
   */
  function lastLoggedSeq(j: IssueJob): number | null {
    if (j.sequence.step === 0) return null;
    let entries: IssueLogEntry[];
    try {
      entries = deps.log.list({ jobId: j.id, limit: Number.MAX_SAFE_INTEGER });
    } catch {
      return null;
    }
    let best: number | null = null;
    for (const e of entries) {
      if (e.jobId !== j.id || typeof e.seq !== 'number' || !Number.isFinite(e.seq)) continue;
      if (best === null || (j.sequence.step > 0 ? e.seq > best : e.seq < best)) best = e.seq;
    }
    return best;
  }

  // --- reader waits -----------------------------------------------------------------

  /** Resolve with the first non-null value of pick(status), re-checked on every status push. */
  function waitStatus<T>(signal: AbortSignal, pick: (s: ReaderStatus) => T | null, pollMs = 1000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(new OpError('CANCELLED'));
      let settled = false;
      let off: (() => void) | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        off?.();
        if (timer) clearInterval(timer);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      const check = (s: ReaderStatus) => {
        let v: T | null;
        try {
          v = pick(s);
        } catch (err) {
          finish(() => reject(err));
          return;
        }
        if (v !== null) finish(() => resolve(v as T));
      };
      const onAbort = () => finish(() => reject(new OpError('CANCELLED')));
      signal.addEventListener('abort', onAbort, { once: true });
      off = deps.nfc.onStatus((s) => check(s));
      // belt and braces: a missed push must not leave the run stuck
      timer = setInterval(() => check(deps.nfc.getStatus()), pollMs);
      check(deps.nfc.getStatus());
    });
  }

  function cardStateOf(s: ReaderStatus): ReaderStatus['cardState'] {
    return s.cardState ?? (s.card ? 'ready' : 'absent');
  }

  /** The reader and the PC/SC service are there (a status that can say "absent" means it). */
  function readerUp(s: ReaderStatus): boolean {
    return s.service === 'ok' && cardStateOf(s) !== 'no-reader';
  }

  /**
   * Wait until the reader no longer holds the tag `uid` and return the
   * `detectedAfter` cutoff for the next waitForCard. `uid` null = a tag whose UID
   * is not known yet (identification still running / failed at start).
   *
   * Removal = "absent" for settleMs, with the reader and the service there the
   * whole time (DESIGN §3.1). In detail:
   *  - no reader / service down: the "absent" before it was not a removal (PC/SC
   *    context re-created, reader re-plugged) - start counting again;
   *  - a short drop-out (< settleMs) followed by a tag: wait for its UID. The SAME
   *    UID = the tag never left (no new number for it: R-ISSUE-2); another UID = a
   *    new tag (swapped quickly, ISSUE-14);
   *  - a tag that stays unidentified after a short drop-out is not a removal;
   *  - with `uid` null, the first UID seen without a real removal before it is that
   *    tag's UID: `onIdentified` is called (clear-reader shows it, R-ISSUE-13).
   */
  function waitForTagGone(signal: AbortSignal, uid: string | null, onIdentified?: (uid: string) => void): Promise<number> {
    const settleMs = Math.max(0, deps.removalSettleMs ?? REMOVAL_SETTLE_MS);
    let known = uid;
    /** When the current / last "absent" began (cutoff: a tag placed after it counts as new). */
    let absentAt: number | null = null;
    /** When that "absent" ended (something appeared); null while it lasts. */
    let absentEnd: number | null = null;
    return waitStatus(
      signal,
      (s) => {
        const now = Date.now();
        const state = cardStateOf(s);
        if (!readerUp(s)) {
          absentAt = null;
          absentEnd = null;
          return null;
        }
        if (state === 'absent') {
          if (absentAt === null || absentEnd !== null) {
            absentAt = now - 1;
            absentEnd = null;
          }
          return now - absentAt >= settleMs ? absentAt : null;
        }
        // Something is on the reader.
        if (absentAt !== null && absentEnd === null) absentEnd = now;
        const realRemoval = absentAt !== null && absentEnd !== null && absentEnd - absentAt >= settleMs;
        const seenUid = s.card?.uid || null;
        if (seenUid) {
          if (known === null) {
            if (realRemoval) return absentAt;
            known = seenUid;
            absentAt = null;
            absentEnd = null;
            onIdentified?.(seenUid);
            return null;
          }
          if (seenUid !== known) return realRemoval ? absentAt : (s.card?.detectedAt ?? now) - 1;
          absentAt = null; // still (or again) the same tag
          absentEnd = null;
          return null;
        }
        // detecting / not identified: a new tag only after a real removal.
        return realRemoval ? absentAt : null;
      },
      settleMs > 0 ? Math.max(50, Math.floor(settleMs / 4)) : 1000,
    );
  }

  // --- one tag ------------------------------------------------------------------------

  function keyIds(j: IssueJob): string[] | undefined {
    // undefined = the service tries every key in the store (built-in public keys first, I3)
    return j.options.mifareKeyIds && j.options.mifareKeyIds.length > 0 ? j.options.mifareKeyIds : undefined;
  }

  async function skip(j: IssueJob, card: CardInfo, reason: Extract<IssueEvent, { type: 'skipped' }>['reason'], message: string): Promise<TagResult> {
    const entry = entryFor(j, card, { seq: null, values: {}, result: 'skipped', message });
    await append(entry);
    emit({ type: 'skipped', entry, reason });
    return { outcome: 'skipped', entry, message };
  }

  async function fail(j: IssueJob, card: CardInfo | null, message: string, opts: { seq?: number | null; values?: Record<string, string>; partial?: boolean } = {}): Promise<TagResult> {
    const entry = entryFor(j, card, { seq: opts.seq ?? null, values: opts.values ?? {}, result: 'error', message });
    await append(entry);
    emit({ type: 'error', entry, message, partial: opts.partial ?? false });
    return { outcome: 'error', entry, message };
  }

  /** The error text for a failed write result (no codes, no page lists). */
  function writeFailureText(res: WriteResult, lang: LanguageSetting): string {
    if (res.aborted === 'CARD_REMOVED') return issueText('removedMidWrite', lang);
    if (res.aborted) return codeText(res.aborted, lang, 'WRITE_FAILED');
    if (res.failed.length > 0) return codeText(res.failed[0].error, lang, 'WRITE_FAILED');
    return codeText('VERIFY_FAILED', lang);
  }

  /** The text for a writeTag rejection (an OpError: nothing was written to this tag). */
  function rejectText(j: IssueJob, code: ErrorCode, halfWritten: boolean, lang: LanguageSetting): string {
    if (LAYOUT_CODES.has(code)) return issueText('protectedArea', lang);
    if (FATAL_CODES.has(code)) return issueText('fatalCode', lang, { detail: codeText(code, lang) });
    if (code === 'CARD_REMOVED' && !halfWritten) return issueText('removedBeforeWrite', lang);
    return `${codeText(code, lang, 'WRITE_FAILED')} ${halfWritten ? partialText(j, lang) : issueText('notWritten', lang)}`;
  }

  async function issueOne(j: IssueJob, card: CardInfo, signal: AbortSignal): Promise<TagResult> {
    const lang = L();
    const reservedHere = reserved !== null && reserved.jobId === j.id && reserved.uid === card.uid;
    /** A number (and row) reserved for ANOTHER, half-written tag. */
    const other = reserved !== null && reserved.jobId === j.id && !reservedHere ? reserved : null;

    // 1. the source tag of a duplicate job is never written
    if (j.template.type === 'image' && j.template.sourceUid && sameUid(j.template.sourceUid, card.uid)) {
      return skip(j, card, 'source', issueText('source', lang));
    }
    // 2. kind
    if (card.kind !== j.kind) {
      const message = card.kind
        ? issueText('wrongKind', lang, { actual: kindText(card.kind), expected: kindText(j.kind) })
        : issueText('unknownKind', lang, { expected: kindText(j.kind) });
      return skip(j, card, 'wrong-kind', message);
    }
    const kind = j.kind;
    // 3. duplicate UID: anywhere in the issue log, not only this job (ISSUE-3)
    if (j.options.skipDuplicateUid && !reservedHere && deps.log.issuedUids().has(card.uid)) {
      return skip(j, card, 'duplicate', issueText('duplicate', lang));
    }

    // 4. read (not needed to duplicate an image unless the tag must be blank / gets a password)
    const needImage = j.template.type !== 'image' || j.options.requireBlank || (j.options.ntagProtect != null && isNtag(kind));
    let image: TagImage | null = null;
    if (needImage) {
      try {
        image = await deps.nfc.readTag({ mifareKeyIds: keyIds(j) });
      } catch (err) {
        if (signal.aborted) throw new OpError('CANCELLED');
        const code = err instanceof OpError ? err.code : 'READ_FAILED';
        const message =
          code === 'CARD_REMOVED' ? issueText('removedBeforeWrite', lang) : `${codeText(code, lang, 'READ_FAILED')} ${issueText('notWritten', lang)}`;
        return fail(j, card, message);
      }
    }
    if (signal.aborted) throw new OpError('CANCELLED');

    // 5. blank only (a tag holding this job's reserved number is exempt: it is ours, half-written)
    if (j.options.requireBlank && !reservedHere && image && !isBlankDataArea(kind, image.data)) {
      return skip(j, card, 'not-blank', issueText('notBlank', lang));
    }

    // 6. the number this tag gets: a number reserved for another half-written tag is
    //    skipped, but only given up (retired) once THIS tag was actually written (R-ISSUE-8).
    const jt: IssueJob =
      other && other.seq != null && j.sequence.next === other.seq ? { ...j, sequence: { ...j.sequence, next: j.sequence.next + j.sequence.step } } : j;

    // 7. build
    let built: ReturnType<typeof buildWrites>;
    try {
      built = buildWrites(jt, kind, card.uid, image?.data ?? factoryImage(kind, hexToBytes(placeholderUidFor(kind, card.uid))));
    } catch (err) {
      if (err instanceof TemplateError || (err instanceof SchemaValueError && (err.fieldId === '_area' || err.fieldId === '_template'))) {
        const r = await fail(j, card, describeBuildError(j, err, lang).message);
        return { ...r, fatal: true };
      }
      // Depends on this tag (e.g. MIFARE not NDEF-formatted / too small): nothing written, try another tag.
      const detail = err instanceof Error ? detailFor(err.message, lang) : null;
      return fail(j, card, detail ? issueText('tagBuild', lang, { detail }) : issueText('tagBuildNoDetail', lang));
    }
    const { writes, values, seq } = built;

    // 8. optional NTAG password protection (protected pages -> allowProtected for these)
    const protectWrites: UnitWrite[] = [];
    if (j.options.ntagProtect && isNtag(kind) && image) {
      const p = j.options.ntagProtect;
      protectWrites.push(
        ...buildNtagPasswordWrites(kind, image.data, {
          password: p.password,
          pack: p.pack,
          auth0: 4,
          protectRead: p.protectRead,
          authLimit: 0,
        }),
      );
    }

    const req: WriteRequest = {
      kind,
      expectedUid: card.uid,
      writes: [...writes, ...protectWrites],
      allowProtected: protectWrites.length > 0,
      // Verify by default; always on a storage reader, which acknowledges writes to
      // locked pages with 90 00 without writing them (PaSoRi, 2026-11-12).
      verify: j.options.verify !== false || card.driver === 'storage',
      mifareKeyIds: keyIds(j),
    };

    // 9. write. A stop pressed while this tag was being checked is honoured here
    //    (R-ISSUE-7); from here on a stop waits for the write to finish.
    if (signal.aborted) throw new OpError('CANCELLED');
    emit({ type: 'writing', uid: card.uid, next: previewOf(jt) });
    let res: WriteResult;
    try {
      res = await deps.nfc.writeTag(req);
    } catch (err) {
      if (err instanceof OpError) {
        // Contract: writeTag rejects only before the first unit is sent (UID re-check,
        // connect, identify, unit checks). Nothing was written to this tag (R-MAIN-1);
        // a reservation for another tag stays as it is (R-ISSUE-8).
        const r = await fail(j, card, rejectText(j, err.code, reservedHere, lang), {
          seq: reservedHere ? seq : null,
          values,
          partial: reservedHere, // a reserved tag stays half-written until rewritten
        });
        return FATAL_CODES.has(err.code) ? { ...r, fatal: true } : r;
      }
      // Not an OpError = not part of the contract (a bug): it may have written
      // something, so treat the tag as half-written (a retired number is cheaper
      // than two tags with the same number).
      const voidNote = other ? await retireReservation(j) : null;
      reserve(j, card.uid, values);
      const message = `${codeText('WRITE_FAILED', lang)} ${partialText(j, lang)}`;
      const r = await fail(j, card, message, { seq, values, partial: true });
      return { ...r, voidNote };
    }

    const ok = (res.failed?.length ?? 0) === 0 && !res.aborted && res.verified !== false;
    if (!ok) {
      // Some units written (removed mid-write, or the read-back did not match) = half-written.
      const wrote = (res.written?.length ?? 0) > 0;
      // This tag now holds the next number: the other tag's reservation is given up.
      const voidNote = wrote && other ? await retireReservation(j) : null;
      if (wrote) reserve(j, card.uid, values);
      const halfWritten = wrote || reservedHere;
      const message = `${writeFailureText(res, lang)} ${halfWritten ? partialText(j, lang) : issueText('notWritten', lang)}`;
      const r = await fail(j, card, message, { seq: halfWritten ? seq : null, values, partial: halfWritten });
      return { ...r, voidNote };
    }

    // 10. success (the other tag's number is retired first: this tag carries the next one)
    const voidNote = other ? await retireReservation(j) : null;
    const entry = entryFor(j, card, { seq, values, result: 'ok', message: null });
    await append(entry);
    issued += 1;
    if (reservedHere) reserved = null;
    j.sequence.next += j.sequence.step;
    if (j.rows) j.rowIndex += 1;
    emit({ type: 'success', entry, issued });
    void persist(j, 'user'); // a crash / power loss still leaves "resume from here"
    return { outcome: 'ok', entry, message: null, voidNote };
  }

  function reserve(j: IssueJob, uid: string, values: Record<string, string>): void {
    reserved = { jobId: j.id, uid, seq: usesSequence(j) ? j.sequence.next : null, rowIndex: j.rows ? j.rowIndex : null, values: { ...values } };
  }

  function partialText(j: IssueJob, lang: LanguageSetting): string {
    return usesSequence(j) ? issueText('partialSeq', lang, { seq: j.sequence.next }) : issueText('partialNoSeq', lang);
  }

  // --- run loop ------------------------------------------------------------------------

  async function run(j: IssueJob, signal: AbortSignal): Promise<void> {
    let reason: IssueStopReason = 'user';
    emit({ type: 'started', job: structuredClone(j) });
    try {
      // A tag left on the reader (e.g. the sample read on the home screen) is never
      // written implicitly. The UI does not start without a reader; if the reader /
      // PC/SC context is away right now (being re-created), look once it is back.
      let initial = deps.nfc.getStatus();
      if (!readerUp(initial)) initial = await waitStatus(signal, (s) => (readerUp(s) ? s : null));
      let cutoff: number;
      if (cardStateOf(initial) === 'absent') {
        cutoff = Date.now() - 1;
      } else {
        const uid0 = initial.card?.uid || null;
        emit({ type: 'clear-reader', uid: uid0 ?? '' });
        cutoff = await waitForTagGone(signal, uid0, (uid) => emit({ type: 'clear-reader', uid }));
      }

      let badStreak = 0;
      let streakStart = j.rowIndex;
      for (;;) {
        if (signal.aborted) break;
        if (j.limit != null && issued >= j.limit) {
          reason = 'limit';
          break;
        }
        if (j.rows && j.rowIndex >= j.rows.length) {
          reason = 'rows-exhausted';
          break;
        }

        // Check the data first: a bad row never uses (or touches) a tag.
        const pre = preflight(j);
        if (pre) {
          await fail(j, null, pre.message, { values: rowValues(j) });
          if (!j.rows || pre.templateLevel) throw new StopRun();
          if (badStreak === 0) streakStart = j.rowIndex;
          badStreak += 1;
          j.rowIndex += 1;
          if (badStreak >= MAX_BAD_ROW_STREAK) {
            j.rowIndex = streakStart; // resume retries them (e.g. after fixing the CSV)
            await fail(j, null, issueText('badRowStreak', L(), { n: badStreak }));
            throw new StopRun();
          }
          continue;
        }
        badStreak = 0;

        emit({ type: 'waiting', next: previewOf(j), issued });
        let card: CardInfo;
        try {
          card = await deps.nfc.waitForCard(signal, { detectedAfter: cutoff });
        } catch (err) {
          if (signal.aborted) break;
          await fail(j, null, issueText('waitFailed', L()));
          void err;
          throw new StopRun();
        }
        emit({ type: 'reading', uid: card.uid, next: previewOf(j) });

        let result: TagResult;
        try {
          result = await issueOne(j, card, signal);
        } catch (err) {
          if (signal.aborted) break;
          const lang = L();
          result = await fail(j, card, `${codeText(err instanceof OpError ? err.code : 'INTERNAL', lang)} ${issueText('notWritten', lang)}`);
        }
        // The outcome stays on screen while waiting for the tag to leave (ISSUE-1);
        // a number retired for another tag is announced with it (R-ISSUE-5).
        const message = result.voidNote ? (result.message ? `${result.message} ${result.voidNote}` : result.voidNote) : result.message;
        if (result.fatal) {
          emit({ type: 'remove-card', uid: card.uid, outcome: result.outcome, entry: result.entry, message });
          throw new StopRun();
        }
        if (signal.aborted) break;

        emit({ type: 'remove-card', uid: card.uid, outcome: result.outcome, entry: result.entry, message });
        try {
          cutoff = await waitForTagGone(signal, card.uid);
        } catch {
          if (signal.aborted) break;
          throw new StopRun();
        }
      }
    } catch (err) {
      if (err instanceof StopRun) {
        reason = 'error'; // the reason was already emitted as an 'error' event
      } else if (signal.aborted) {
        reason = 'user';
      } else {
        // unexpected: say so instead of stopping silently
        reason = 'error';
        await fail(j, null, codeText(err instanceof OpError ? err.code : 'INTERNAL', L()));
      }
    } finally {
      // A half-written tag's number is never handed out again after a stop.
      if (reserved) await retireReservation(j);
      progress.set(j.id, { next: j.sequence.next, rowIndex: j.rowIndex, issued: base + issued });
      running = false;
      try {
        deps.nfc.setBusy(null);
      } catch {
        // ignore
      }
      emit({ type: 'stopped', reason, issued, job: structuredClone(j) });
      // Kept for the next start of the app (awaited: quitting waits for this run to end).
      await persist(j, reason);
    }
  }

  return {
    start(nextJob) {
      if (running) throw new OpError('BUSY');
      if (!nextJob || !nextJob.template || !nextJob.kind || !nextJob.sequence) throw new OpError('INVALID_INPUT', 'job');
      const j = structuredClone(nextJob);
      j.options = { ...j.options, mifareKeyIds: j.options?.mifareKeyIds ?? [] };
      j.rowIndex = Math.max(0, Math.floor(j.rowIndex || 0));
      // Same job id again = "resume": never go back to numbers / rows already used
      // (in this session, or found in the log after a restart: R-ISSUE-4).
      const prev = progress.get(j.id);
      const step = j.sequence.step;
      if (prev) {
        if ((step > 0 && j.sequence.next < prev.next) || (step < 0 && j.sequence.next > prev.next) || step === 0) {
          j.sequence.next = prev.next;
        }
        if (j.rowIndex < prev.rowIndex) j.rowIndex = prev.rowIndex;
      }
      const used = lastLoggedSeq(j);
      if (used !== null && ((step > 0 && j.sequence.next <= used) || (step < 0 && j.sequence.next >= used))) {
        j.sequence.next = used + step;
      }
      // What this job id already issued (earlier runs / sessions). `issued` and the
      // limit count THIS run (R-ISSUE-3): the UI passes the remaining / next batch.
      base = Math.max(prev?.issued ?? 0, safeIssuedCount(j.id));
      issued = 0;
      job = j;
      reserved = null;
      last = null;
      running = true;
      const controller = new AbortController();
      abort = controller;
      deps.nfc.setBusy('issue');
      runPromise = run(j, controller.signal).catch(() => {
        // run() handles its own errors; never leave an unhandled rejection
      });
    },
    stop() {
      if (running) abort?.abort();
    },
    async stopAndWait(timeoutMs = 5000) {
      if (running) abort?.abort();
      const p = runPromise;
      if (!p) return;
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      if (timer) clearTimeout(timer);
    },
    getState() {
      return { running, job, issued, last };
    },
    preview(j) {
      return previewOf(j);
    },
  };

  function safeIssuedCount(jobId: string): number {
    try {
      return deps.log.issuedUids(jobId).size;
    } catch {
      return 0;
    }
  }
}

/** A template problem every tag would hit (stop instead of failing each tag). */
class TemplateError extends Error {
  constructor(readonly key: 'felicaNdef') {
    super(key);
    this.name = 'TemplateError';
  }
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameUid(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return n(a) === n(b);
}

/** A UID of the right length for factoryImage (the real UID when it fits). */
function placeholderUidFor(kind: TagKind, uid: string): string {
  const want = isNtag(kind) ? 14 : isMifare(kind) ? 8 : 16;
  const h = uid.replace(/[^0-9a-fA-F]/g, '');
  return h.length === want ? h : '0'.repeat(want);
}
