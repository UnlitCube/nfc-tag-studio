// Global renderer store (zustand). CONTRACT FILE - integrator-owned.
// Feature views keep their own local state; only cross-view state lives here:
// settings, reader status, issue state, the current tag document, toasts, dialogs.
//
// The current document (doc) rules (2026-11-12 UX audit WRITE-2 / FLOW-6 / WALK-4):
//  - Every path that REPLACES or CLOSES the doc (read a tag, open a file, new
//    document, close) must `await guardDiscard()` first and stop when it returns
//    false. openImage / closeDoc themselves never ask (the caller owns that), so
//    the caller can ask once before a longer flow (e.g. before showing a file dialog).
//  - lib/ops.ts readCurrentTag() already asks (guard defaults to true).
//  - After a write, lib/ops.ts writeWithConfirm() decides between commitDoc /
//    rebaseDoc / markWritten so unwritten edits are never silently dropped.
import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import type { AppSettings, IssueEvent, IssueJob, LanguageSetting, ReaderStatus, TagImage, UnitWrite } from '@shared/types';
import type { TagKind } from '@shared/tags';
import { specFor } from '@shared/tags';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { ERROR_MESSAGES, errorMessage } from '@shared/errorMessages';
import type { ErrorCode } from '@shared/types';
import type { IssueState } from '@shared/api';
import { AppError, api, errorText } from '../lib/api';
import { beep } from '../lib/sound';
import { unitCount } from '../lib/units';
import { formatUid, idName, kindLabel } from '../lib/format';
import { translate } from '../i18n';

export type ViewId = 'home' | 'issue' | 'ndef' | 'schema' | 'hex' | 'backup' | 'log' | 'keys' | 'help' | 'settings';

export type DocSource =
  | { type: 'card'; uid: string }
  | { type: 'file'; name: string; token: string | null; format: string }
  | { type: 'new' };

/**
 * The "current document": a tag image read from a card or loaded from a file,
 * plus edits. `original` is what was read/loaded (base for diffs / write plans);
 * `image` is the edited state. Edits go through editDocData (undo/redo aware).
 */
export interface TagDoc {
  image: TagImage;
  original: TagImage;
  source: DocSource;
  /** Bumps on every change; use as a cheap dependency. */
  revision: number;
  /**
   * Read by the auto-read, which tries only the public standard MIFARE keys (D9 /
   * review R-UX-4): sectors denied here may open with the operator's registered
   * keys - <TagOnReader /> then offers "read with the registered keys".
   * Absent for every other read (a manual read tries every key).
   */
  standardKeysOnly?: boolean;
}

/** One-shot data passed from one view to another (e.g. "use these NDEF records as an issue template"). */
export type Handoff =
  | { kind: 'issue-ndef'; records: NdefRecordDraft[] }
  | { kind: 'issue-schema'; schemaId: string }
  /** Use the current document as the duplicate source in the issue view. */
  | { kind: 'issue-image' }
  /** Open the binary editor with the cursor at this unit. */
  | { kind: 'hex-goto'; unit: number };

export interface Toast {
  id: number;
  tone: 'ok' | 'warn' | 'danger' | 'info';
  title: string;
  /** Plain-language explanation / next step (localized). */
  detail?: string;
  /**
   * Diagnostic text (error code, raw SW / PC/SC result, block number) shown only
   * folded under "技術情報" - never inline, never secrets (I4). (FIRST-9 / WALK-16)
   */
  technical?: string;
  /** Default 4500 ms; 0 = sticky. danger toasts default to 8000 ms. */
  timeoutMs?: number;
  /**
   * How many times this same toast (tone + title + detail) was raised in a row:
   * a repeat replaces the shown one instead of stacking (D13). Set by the store.
   */
  count?: number;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Bullet points shown under the message (e.g. what will be written). */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'warn' | 'danger';
  /** When set, the operator must type this word to enable the confirm button (irreversible ops). */
  typeToConfirm?: string;
  /** Shown prominently above the message, e.g. the target tag "書き込み先: NTAG215 · UID 04:…". */
  target?: string;
  /** Shown as a warning box (e.g. "別のタグへ書き込みます（複製）"). */
  warning?: string;
}

/**
 * Result of the last single-tag write, kept on screen until dismissed (a toast
 * vanishes in seconds; a failed / partial write must stay visible). Lines are
 * already localized. (2026-11-12 UX audit WRITE-4 / FIRST-12)
 */
export interface WriteOutcome {
  at: number;
  tone: 'ok' | 'warn' | 'danger';
  title: string;
  /** What was / was not written and what to do next. */
  lines: string[];
  uid: string;
  kind: TagKind;
  /** Protection settings were written: they take effect only after the tag is taken off and placed again. */
  reactivate: boolean;
  /**
   * The tag is left partly written: "write again with the same tag". Not part of
   * `lines` - <LastWriteCallout /> shows it only while the result belongs to the
   * open document / the tag on the reader, worded by whether that tag is placed
   * (review R-WRITE-5).
   */
  retry?: boolean;
}

/** One tag handled by a batch-issue run (newest first in issueRecent). */
export interface IssueResultItem {
  at: number;
  outcome: 'ok' | 'skipped' | 'error';
  uid: string | null;
  seq: number | null;
  /** Localized reason / note. */
  message: string | null;
  /** The tag was partly written (put the same tag back to retry). */
  partial: boolean;
  /** outcome 'error': what the error is about (see IssueStopCause). */
  cause?: IssueStopCause;
}

/**
 * What an issue error is about, so the screen points at the right fix (review
 * R-ISSUE-9): 'reader' (the reader / its state: check the connection), 'data'
 * (the template / CSV, found before any tag was used), 'tag' (the tag that was
 * placed), 'other' (anything else - show the message only).
 */
export type IssueStopCause = 'reader' | 'data' | 'tag' | 'other';

/** Summary of the last finished batch-issue run (shown until the next run starts). */
export interface IssueRunSummary {
  reason: 'user' | 'limit' | 'rows-exhausted' | 'error';
  issued: number;
  endedAt: number;
  /** Job state at stop (sequence.next / rowIndex) for "resume". */
  job: IssueJob | null;
  /**
   * reason 'error': the localized reason the run stopped (the error reported just
   * before the stop), or null when main reported none. (review R-ISSUE-9)
   */
  message?: string | null;
  /** reason 'error': what the stop was about; null for the other reasons. */
  cause?: IssueStopCause | null;
}

export interface DialogEntry extends ConfirmRequest {
  id: number;
  resolve: (value: boolean) => void;
}

interface AppState {
  ready: boolean;
  initError: string | null;
  settings: AppSettings;
  reader: ReaderStatus | null;
  issue: IssueState;
  view: ViewId;
  /** Help topic to open when view === 'help'. */
  helpTopic: string | null;
  doc: TagDoc | null;
  past: Uint8Array[];
  future: Uint8Array[];
  toasts: Toast[];
  dialogs: DialogEntry[];
  handoff: Handoff | null;
  /** Renderer-side single-tag operation in flight: lock the UI (no edits, no second click). */
  busyOp: null | 'read' | 'write';
  lastWrite: WriteOutcome | null;
  /** Newest first, at most 20. */
  issueRecent: IssueResultItem[];
  issueLastRun: IssueRunSummary | null;
  /** The view that was on screen when help was opened (help can offer "back"). */
  viewBeforeHelp: ViewId | null;
  /**
   * Screens with unsaved work that is NOT the doc (an NDEF message being
   * composed, a schema draft...). Closing the window asks first while any is set.
   */
  unsavedDrafts: string[];

  init(): Promise<void>;
  /** Fold one batch-issue event into issue / issueRecent / issueLastRun, play its sound (D6). */
  applyIssueEvent(e: IssueEvent): void;
  setView(view: ViewId, opts?: { helpTopic?: string | null }): void;
  /** Serialized read-modify-write of settings against main's latest copy. */
  saveSettings(update: (s: AppSettings) => AppSettings): Promise<void>;
  /**
   * Open an image as the current document (image and original = the given image).
   * Does NOT ask: call `await guardDiscard()` first. Clears the last write result.
   * `opts.standardKeysOnly`: read with the public standard MIFARE keys only (auto-read, D9).
   */
  openImage(image: TagImage, source: DocSource, opts?: { standardKeysOnly?: boolean }): void;
  /** Replace the edited bytes of the current document (pushes undo history). */
  editDocData(data: Uint8Array): void;
  /** After a successful write: the written state becomes the new original. */
  commitDoc(image: TagImage): void;
  /** Close the current document. Does NOT ask: call `await guardDiscard()` first. */
  closeDoc(): void;
  /** Mark / unmark a screen's own unsaved draft (key = any stable id, e.g. 'ndef'). */
  setUnsavedDraft(key: string, unsaved: boolean): void;
  /**
   * Before replacing / closing the current document: if it has unsaved edits,
   * ask "discard N changed pages?" and resolve true only when the operator agrees
   * (or nothing is dirty). Every path that replaces the doc must call this first.
   */
  guardDiscard(): Promise<boolean>;
  /**
   * After a write where some units were NOT written (failed / mismatched /
   * aborted / excluded): original := readback, image := readback with the
   * keepUnits taken from the current edited image, so the unwritten edits stay
   * pending instead of vanishing.
   */
  rebaseDoc(readback: TagImage, keepUnits: number[]): void;
  /** The write succeeded but the re-read failed: fold the written units into original (they stop being "unsaved"). */
  markWritten(writes: UnitWrite[]): void;
  setBusyOp(op: null | 'read' | 'write'): void;
  setLastWrite(o: WriteOutcome | null): void;
  undo(): void;
  redo(): void;
  toast(t: Omit<Toast, 'id'>): void;
  /** Toast for a thrown error (AppError-aware). */
  toastError(err: unknown, title?: string): void;
  dismissToast(id: number): void;
  confirm(req: ConfirmRequest): Promise<boolean>;
  resolveDialog(id: number, value: boolean): void;
  /** Switch to `view` and leave `handoff` for it to pick up. */
  handoffTo(view: ViewId, handoff: Handoff): void;
  /** Return and clear the pending handoff if it has the given kind. */
  takeHandoff<K extends Handoff['kind']>(kind: K): Extract<Handoff, { kind: K }> | null;
}

let nextId = 1;
let settingsChain: Promise<void> = Promise.resolve();
const HISTORY_LIMIT = 100;
/** Toasts shown at once (older ones drop off; results that must stay live in LastWriteCallout). */
const TOAST_LIMIT = 3;

function sameToast(a: Omit<Toast, 'id'>, b: Omit<Toast, 'id'>): boolean {
  return a.tone === b.tone && a.title === b.title && (a.detail ?? '') === (b.detail ?? '') && (a.technical ?? '') === (b.technical ?? '');
}

function cloneImage(img: TagImage): TagImage {
  return {
    ...img,
    data: new Uint8Array(img.data),
    unitStatus: [...img.unitStatus],
    ntag: img.ntag ? { ...img.ntag } : undefined,
    mifare: img.mifare ? { sectors: img.mifare.sectors.map((s) => ({ ...s })) } : undefined,
  };
}

/**
 * The vanilla store behind useAppStore. Server-side render tests read
 * `getInitialState()` of THIS object (zustand's useStore), so such a test points
 * it at the live state: `appStoreApi.getInitialState = () => appStoreApi.getState()`.
 * (Patching useAppStore.getInitialState has no effect.)
 */
export let appStoreApi: StoreApi<AppState>;

export const useAppStore = create<AppState>((set, get, storeApi) => {
  appStoreApi = storeApi;
  return {
    ready: false,
    initError: null,
    settings: DEFAULT_SETTINGS,
    reader: null,
    issue: { running: false, job: null, issued: 0, last: null },
    view: 'home',
    helpTopic: null,
    doc: null,
    past: [],
    future: [],
    toasts: [],
    dialogs: [],
    handoff: null,
    busyOp: null,
    lastWrite: null,
    issueRecent: [],
    issueLastRun: null,
    viewBeforeHelp: null,
    unsavedDrafts: [],

    async init() {
      try {
        // Subscribe BEFORE the first fetch so no push is lost in between; a push that
        // arrives first wins over the (older) fetched snapshot.
        let pushedSettings = false;
        let pushedReader = false;
        api.onSettings((s) => {
          pushedSettings = true;
          set({ settings: { ...DEFAULT_SETTINGS, ...s } });
        });
        api.onReaderStatus((s) => {
          pushedReader = true;
          set({ reader: s });
        });
        api.onIssueEvent((e: IssueEvent) => get().applyIssueEvent(e));
        const [settings, reader, issue] = await Promise.all([api.getSettings(), api.getReaderStatus(), api.getIssueState()]);
        set((st) => ({
          settings: pushedSettings ? st.settings : { ...DEFAULT_SETTINGS, ...settings },
          reader: pushedReader ? st.reader : reader,
          // Events may already have updated the issue state; keep the newer one.
          issue: st.issue.last ? st.issue : issue,
          ready: true,
        }));
      } catch (err) {
        set({ initError: errorText(err).message, ready: true });
      }
    },

    applyIssueEvent(e) {
      const st = get();
      const u = issueEventUpdate(
        { issue: st.issue, issueRecent: st.issueRecent, issueLastRun: st.issueLastRun },
        e,
        { now: Date.now(), lang: st.settings.language },
      );
      set({ issue: u.issue, issueRecent: u.issueRecent, issueLastRun: u.issueLastRun });
      // D6: the store plays the per-tag sounds (IssueView does not), so they are heard
      // on every screen. job.options.sound gates them in addition to settings.sound.
      const jobSound = u.issue.job ? u.issue.job.options.sound : true;
      if (u.sound && jobSound) beep(u.sound);
      if (u.toast) get().toast(u.toast);
    },

    setView(view, opts) {
      const prev = get().view;
      set({
        view,
        helpTopic: opts?.helpTopic ?? (view === 'help' ? get().helpTopic : null),
        viewBeforeHelp: view === 'help' ? (prev === 'help' ? get().viewBeforeHelp : prev) : get().viewBeforeHelp,
      });
    },

    saveSettings(update) {
      settingsChain = settingsChain.then(async () => {
        try {
          const fresh = await api.getSettings();
          const saved = await api.saveSettings(update({ ...DEFAULT_SETTINGS, ...fresh }));
          set({ settings: { ...DEFAULT_SETTINGS, ...saved } });
        } catch (err) {
          get().toastError(err);
        }
      });
      return settingsChain;
    },

    openImage(image, source, opts) {
      set((st) => ({
        doc: {
          image: cloneImage(image),
          original: cloneImage(image),
          source,
          revision: (st.doc?.revision ?? 0) + 1,
          ...(opts?.standardKeysOnly ? { standardKeysOnly: true } : {}),
        },
        past: [],
        future: [],
        // The last write result belonged to the previous document.
        lastWrite: null,
      }));
    },

    editDocData(data) {
      const doc = get().doc;
      if (!doc) return;
      if (data.length !== doc.image.data.length) throw new Error('editDocData: size mismatch');
      set((st) => ({
        doc: { ...doc, image: { ...doc.image, data: new Uint8Array(data) }, revision: doc.revision + 1 },
        past: [...st.past, doc.image.data].slice(-HISTORY_LIMIT),
        future: [],
      }));
    },

    commitDoc(image) {
      const doc = get().doc;
      set({
        doc: {
          image: cloneImage(image),
          original: cloneImage(image),
          source: { type: 'card', uid: image.uid },
          revision: (doc?.revision ?? 0) + 1,
        },
        past: [],
        future: [],
      });
    },

    closeDoc() {
      set({ doc: null, past: [], future: [], lastWrite: null });
    },

    setUnsavedDraft(key, unsaved) {
      set((st) => {
        const has = st.unsavedDrafts.includes(key);
        if (unsaved === has) return {};
        return { unsavedDrafts: unsaved ? [...st.unsavedDrafts, key] : st.unsavedDrafts.filter((k) => k !== key) };
      });
    },

    async guardDiscard() {
      const doc = get().doc;
      const n = dirtyUnits(doc).length;
      if (!doc || n === 0) return true;
      const lang = get().settings.language;
      const kind = kindLabel(doc.image.kind);
      const docLine =
        doc.source.type === 'card'
          ? translate(lang, 'discard.doc.card', { kind, idName: idName(doc.image.kind), uid: formatUid(doc.source.uid) })
          : doc.source.type === 'file'
            ? translate(lang, 'discard.doc.file', { name: doc.source.name })
            : translate(lang, 'discard.doc.new', { kind });
      return get().confirm({
        title: translate(lang, 'discard.title'),
        message: translate(lang, 'discard.message', { count: unitCount(doc.image.kind, n, lang) }),
        target: docLine,
        details: [translate(lang, 'discard.keepHint')],
        confirmLabel: translate(lang, 'discard.confirm'),
        cancelLabel: translate(lang, 'common.cancel'),
        tone: 'warn',
      });
    },

    rebaseDoc(readback, keepUnits) {
      const doc = get().doc;
      const next = cloneImage(readback);
      if (doc && doc.image.data.length === next.data.length) {
        const size = specFor(next.kind).unitSize;
        for (const u of keepUnits) next.data.set(doc.image.data.subarray(u * size, (u + 1) * size), u * size);
      }
      set({
        doc: { image: next, original: cloneImage(readback), source: { type: 'card', uid: readback.uid }, revision: (doc?.revision ?? 0) + 1 },
        past: [],
        future: [],
      });
    },

    markWritten(writes) {
      const doc = get().doc;
      if (!doc) return;
      const original = cloneImage(doc.original);
      const size = specFor(original.kind).unitSize;
      for (const w of writes) if (w.data.length === size) original.data.set(w.data, w.unit * size);
      set({ doc: { ...doc, original, revision: doc.revision + 1 } });
    },

    setBusyOp(op) {
      set({ busyOp: op });
    },

    setLastWrite(o) {
      set({ lastWrite: o });
    },

    undo() {
      const { doc, past, future } = get();
      if (!doc || past.length === 0) return;
      const prev = past[past.length - 1];
      set({
        doc: { ...doc, image: { ...doc.image, data: prev }, revision: doc.revision + 1 },
        past: past.slice(0, -1),
        future: [doc.image.data, ...future].slice(0, HISTORY_LIMIT),
      });
    },

    redo() {
      const { doc, past, future } = get();
      if (!doc || future.length === 0) return;
      const nextData = future[0];
      set({
        doc: { ...doc, image: { ...doc.image, data: nextData }, revision: doc.revision + 1 },
        past: [...past, doc.image.data].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },

    toast(t) {
      const id = nextId++;
      set((st) => {
        // D13 / E2E-UX-2: the same message again (e.g. two "read" toasts) replaces
        // the shown one - counted, with a fresh timeout - instead of stacking.
        const same = st.toasts.find((x) => sameToast(x, t));
        const rest = same ? st.toasts.filter((x) => x !== same) : st.toasts;
        const count = same ? (same.count ?? 1) + 1 : undefined;
        return { toasts: [...rest, { ...t, id, ...(count ? { count } : {}) }].slice(-TOAST_LIMIT) };
      });
      const timeout = t.timeoutMs ?? (t.tone === 'danger' ? 8000 : 4500);
      if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout);
    },

    toastError(err, title) {
      get().toast(errorToast(err, title));
    },

    dismissToast(id) {
      set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }));
    },

    confirm(req) {
      return new Promise<boolean>((resolve) => {
        const id = nextId++;
        set((st) => ({ dialogs: [...st.dialogs, { ...req, id, resolve }] }));
      });
    },

    resolveDialog(id, value) {
      const d = get().dialogs.find((x) => x.id === id);
      if (!d) return;
      set((st) => ({ dialogs: st.dialogs.filter((x) => x.id !== id) }));
      d.resolve(value);
    },

    handoffTo(view, handoff) {
      set({ handoff, view, helpTopic: null });
    },

    takeHandoff(kind) {
      const h = get().handoff;
      if (!h || h.kind !== kind) return null;
      set({ handoff: null });
      return h as Extract<Handoff, { kind: typeof kind }>;
    },
  };
});

/** Units (pages / blocks) whose bytes differ between the edited image and the original. */
export function dirtyUnits(doc: TagDoc | null): number[] {
  if (!doc) return [];
  const a = doc.image.data;
  const b = doc.original.data;
  if (a.length !== b.length) return [0];
  const size = specFor(doc.image.kind).unitSize;
  const out: number[] = [];
  for (let u = 0; u * size < a.length; u++) {
    for (let i = u * size; i < (u + 1) * size; i++) {
      if (a[i] !== b[i]) {
        out.push(u);
        break;
      }
    }
  }
  return out;
}

/** True when the current document has unsaved edits relative to what was read/loaded. */
export function isDocDirty(doc: TagDoc | null): boolean {
  if (!doc) return false;
  const a = doc.image.data;
  const b = doc.original.data;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

/** Anything the window close must not throw away silently (WALK-13): doc edits or a screen draft. */
export function hasUnsavedWork(st: { doc: TagDoc | null; unsavedDrafts: string[] }): boolean {
  return isDocDirty(st.doc) || st.unsavedDrafts.length > 0;
}

/**
 * The toast for a thrown error: the localized message (what happened + what to
 * do) is shown; the error code and main's diagnostic detail (raw SW, PC/SC
 * result, English exception text) go to the folded "技術情報" only. (FIRST-9 / WALK-16)
 */
export function errorToast(err: unknown, title?: string): Omit<Toast, 'id'> {
  const { message, detail } = errorText(err);
  const code = err instanceof AppError ? err.code : null;
  const technical = [code, detail].filter((x): x is string => !!x && x.trim() !== '').join(' · ');
  return {
    tone: 'danger',
    title: title ?? message,
    detail: title && message && message !== title ? message : undefined,
    technical: technical || undefined,
  };
}

// ---------------------------------------------------------------------------
// Batch issue events -> per-tag results, last run summary, sound (ISSUE-1/7/11, D6)
// ---------------------------------------------------------------------------

const ISSUE_RECENT_LIMIT = 20;

export interface IssueSlice {
  issue: IssueState;
  issueRecent: IssueResultItem[];
  issueLastRun: IssueRunSummary | null;
}

export interface IssueUpdate extends IssueSlice {
  /** Sound for this event (the caller also checks job.options.sound; beep() checks settings.sound). */
  sound: 'success' | 'error' | 'skip' | null;
  /** A toast to show on any screen (run stopped), or null. */
  toast: Omit<Toast, 'id'> | null;
}

/** main may send an ErrorCode as the message; turn it into the user-facing sentence. */
export function localizeIssueMessage(message: string | null | undefined, lang: LanguageSetting): string | null {
  if (!message) return null;
  if (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, message)) return errorMessage(message as ErrorCode, lang);
  return message;
}

/** Errors about the reader (its connection / state), not the tag or the data. */
const READER_ERROR_CODES = new Set<ErrorCode>(['NO_SERVICE', 'NO_READER', 'READER_IN_USE', 'READER_NO_AUTH']);

/** The ErrorCode an issue message is (main sends the code or exactly its sentence), or null. */
function issueMessageCode(message: string | null | undefined, lang: LanguageSetting): ErrorCode | null {
  if (!message) return null;
  if (Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, message)) return message as ErrorCode;
  for (const code of Object.keys(ERROR_MESSAGES) as ErrorCode[]) {
    if (errorMessage(code, lang) === message) return code;
  }
  return null;
}

/**
 * Pure: what an issue 'error' event is about (R-ISSUE-9), from the event and the
 * one before it. The engine reports an error with no tag (entry.uid '') when the
 * data is checked BEFORE waiting for a tag (template / CSV row), or when waiting
 * for a tag failed (the event before is 'waiting': the reader).
 */
export function issueErrorCause(e: Extract<IssueEvent, { type: 'error' }>, before: IssueEvent | null, lang: LanguageSetting): IssueStopCause {
  const code = issueMessageCode(e.message, lang);
  const uid = e.entry?.uid ?? '';
  if (code && READER_ERROR_CODES.has(code)) return 'reader';
  if (!uid && before?.type === 'waiting') return 'reader';
  if (code) return uid ? 'tag' : 'other';
  return uid ? 'tag' : 'data';
}

function skipMessage(reason: 'duplicate' | 'not-blank' | 'wrong-kind' | 'source', kind: TagKind | null, lang: LanguageSetting): string {
  if (reason === 'wrong-kind') return translate(lang, 'issueResult.skip.wrong-kind', { kind: kindLabel(kind) });
  return translate(lang, `issueResult.skip.${reason}`);
}

/**
 * Why a run stopped with reason 'error': the error reported just before the stop
 * (directly, or through the remove-card of the tag it was about).
 */
function stopReasonOf(prev: IssueSlice, lang: LanguageSetting): { message: string | null; cause: IssueStopCause | null } {
  const last = prev.issue.last;
  const item = prev.issueRecent[0];
  const itemError = item && item.outcome === 'error' ? item : null;
  if (last?.type === 'error') {
    return {
      message: localizeIssueMessage(last.message, lang) ?? itemError?.message ?? null,
      cause: itemError?.cause ?? 'other',
    };
  }
  if (last?.type === 'remove-card') {
    if (last.outcome === 'error') {
      // A tag's error that stopped the run (a template that cannot be laid out) -
      // or the wait for that tag to leave failed. Show the message, no reader guess
      // unless the error itself was about the reader.
      return {
        message: localizeIssueMessage(last.message, lang) ?? itemError?.message ?? null,
        cause: itemError?.cause === 'reader' ? 'reader' : 'other',
      };
    }
    // The tag was handled; waiting for it to be taken off failed (the reader state).
    return { message: null, cause: 'reader' };
  }
  return { message: null, cause: 'other' };
}

/** Pure: fold one issue event into the store's issue slice. */
export function issueEventUpdate(prev: IssueSlice, e: IssueEvent, ctx: { now: number; lang: LanguageSetting }): IssueUpdate {
  const { now, lang } = ctx;
  const running = e.type !== 'stopped';
  const issued = 'issued' in e ? e.issued : e.type === 'started' ? 0 : prev.issue.issued;
  const job = e.type === 'started' ? e.job : e.type === 'stopped' ? (e.job ?? prev.issue.job) : prev.issue.job;
  let issueRecent = prev.issueRecent;
  let issueLastRun = prev.issueLastRun;
  let sound: IssueUpdate['sound'] = null;
  let toast: IssueUpdate['toast'] = null;
  const push = (item: Omit<IssueResultItem, 'at'>) => {
    issueRecent = [{ at: now, ...item }, ...issueRecent].slice(0, ISSUE_RECENT_LIMIT);
  };
  // The tag being handled when an error without a log entry arrives.
  const pending = prev.issue.last;
  const pendingUid = pending && (pending.type === 'reading' || pending.type === 'writing') ? pending.uid : null;
  const pendingSeq = pending && (pending.type === 'reading' || pending.type === 'writing') ? pending.next.seq : null;

  switch (e.type) {
    case 'started':
      issueRecent = [];
      issueLastRun = null;
      break;
    case 'success':
      push({ outcome: 'ok', uid: e.entry.uid, seq: e.entry.seq, message: null, partial: false });
      sound = 'success';
      break;
    case 'skipped':
      push({ outcome: 'skipped', uid: e.entry.uid, seq: e.entry.seq, message: skipMessage(e.reason, e.entry.kind, lang), partial: false });
      sound = 'skip';
      break;
    case 'error':
      push({
        outcome: 'error',
        uid: e.entry?.uid || pendingUid,
        seq: e.entry?.seq ?? pendingSeq,
        message: localizeIssueMessage(e.message, lang) ?? localizeIssueMessage(e.entry?.message, lang),
        partial: !!e.partial,
        cause: issueErrorCause(e, prev.issue.last, lang),
      });
      sound = 'error';
      break;
    case 'remove-card': {
      // Normally success / skipped / error came first and was already recorded.
      // If main reported the outcome only here, record it now (never twice).
      const recorded = pending && (pending.type === 'success' || pending.type === 'skipped' || pending.type === 'error');
      if (!recorded && e.outcome) {
        push({
          outcome: e.outcome,
          uid: e.entry?.uid ?? e.uid,
          seq: e.entry?.seq ?? null,
          message: localizeIssueMessage(e.message, lang),
          partial: false,
        });
        sound = e.outcome === 'ok' ? 'success' : e.outcome === 'skipped' ? 'skip' : 'error';
      }
      break;
    }
    case 'stopped': {
      // R-ISSUE-9: a fatal error arrives as error (-> remove-card) -> stopped in one
      // go and the running panel disappears with it, so keep WHY it stopped.
      const why = e.reason === 'error' ? stopReasonOf(prev, lang) : { message: null, cause: null };
      issueLastRun = { reason: e.reason, issued: e.issued, endedAt: now, job: e.job ?? null, message: why.message, cause: why.cause };
      const count = translate(lang, 'issueResult.stopped.detail', { n: e.issued });
      toast = {
        tone: e.reason === 'error' ? 'danger' : e.reason === 'user' ? 'info' : 'ok',
        title: translate(lang, `issueResult.stopped.${e.reason}`),
        detail: why.message ? `${why.message}\n${count}` : count,
      };
      break;
    }
    default:
      break;
  }
  return { issue: { running, job, issued, last: e }, issueRecent, issueLastRun, sound, toast };
}
