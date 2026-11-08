// Global renderer store (zustand). CONTRACT FILE - integrator-owned.
// Feature views keep their own local state; only cross-view state lives here:
// settings, reader status, issue state, the current tag document, toasts, dialogs.
import { create } from 'zustand';
import type { AppSettings, IssueEvent, ReaderStatus, TagImage } from '@shared/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { IssueState } from '@shared/api';
import { api, errorText } from '../lib/api';

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
  detail?: string;
  /** Default 4500 ms; 0 = sticky. danger toasts default to 8000 ms. */
  timeoutMs?: number;
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

  init(): Promise<void>;
  setView(view: ViewId, opts?: { helpTopic?: string | null }): void;
  /** Serialized read-modify-write of settings against main's latest copy. */
  saveSettings(update: (s: AppSettings) => AppSettings): Promise<void>;
  /** Open an image as the current document (image and original = the given image). */
  openImage(image: TagImage, source: DocSource): void;
  /** Replace the edited bytes of the current document (pushes undo history). */
  editDocData(data: Uint8Array): void;
  /** After a successful write: the written state becomes the new original. */
  commitDoc(image: TagImage): void;
  closeDoc(): void;
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

function cloneImage(img: TagImage): TagImage {
  return {
    ...img,
    data: new Uint8Array(img.data),
    unitStatus: [...img.unitStatus],
    ntag: img.ntag ? { ...img.ntag } : undefined,
    mifare: img.mifare ? { sectors: img.mifare.sectors.map((s) => ({ ...s })) } : undefined,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
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

  async init() {
    try {
      const [settings, reader, issue] = await Promise.all([api.getSettings(), api.getReaderStatus(), api.getIssueState()]);
      set({ settings, reader, issue, ready: true });
      api.onSettings((s) => set({ settings: s }));
      api.onReaderStatus((s) => set({ reader: s }));
      api.onIssueEvent((e: IssueEvent) => {
        set((st) => {
          const running = e.type !== 'stopped';
          const issued = 'issued' in e ? e.issued : st.issue.issued;
          const job = e.type === 'started' ? e.job : st.issue.job;
          return { issue: { running, job, issued, last: e } };
        });
      });
    } catch (err) {
      set({ initError: errorText(err).message, ready: true });
    }
  },

  setView(view, opts) {
    set({ view, helpTopic: opts?.helpTopic ?? (view === 'help' ? get().helpTopic : null) });
  },

  saveSettings(update) {
    settingsChain = settingsChain.then(async () => {
      try {
        const fresh = await api.getSettings();
        const saved = await api.saveSettings(update(fresh));
        set({ settings: saved });
      } catch (err) {
        get().toastError(err);
      }
    });
    return settingsChain;
  },

  openImage(image, source) {
    set((st) => ({
      doc: { image: cloneImage(image), original: cloneImage(image), source, revision: (st.doc?.revision ?? 0) + 1 },
      past: [],
      future: [],
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
    set({ doc: null, past: [], future: [] });
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
    set((st) => ({ toasts: [...st.toasts, { ...t, id }].slice(-5) }));
    const timeout = t.timeoutMs ?? (t.tone === 'danger' ? 8000 : 4500);
    if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout);
  },

  toastError(err, title) {
    const { message, detail } = errorText(err);
    get().toast({ tone: 'danger', title: title ?? message, detail: title ? message + (detail ? `\n${detail}` : '') : detail });
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
}));

/** True when the current document has unsaved edits relative to what was read/loaded. */
export function isDocDirty(doc: TagDoc | null): boolean {
  if (!doc) return false;
  const a = doc.image.data;
  const b = doc.original.data;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}
