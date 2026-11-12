// renderer-core: store (doc guards, rebase / markWritten, issue results, error
// toasts) and lib/ops (read / write flows) against a fake window.nfcBridge.
// Owner: renderer-core. Runs in the node environment (no DOM, no React render).
//
// RC_OPS_UNDER_TEST (optional): path of an ops module to test instead of
// src/renderer/src/lib/ops.ts - used once to check that these tests FAIL on the
// pre-fix implementation (verification-discipline).
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IssueEvent, IssueJob, IssueLogEntry, ReaderStatus, TagImage, WriteRequest, WriteResult } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { INVOKE_CHANNELS } from '../src/shared/api';
import { errorMessage } from '../src/shared/errorMessages';
import { AppError } from '../src/renderer/src/lib/api';
import {
  dirtyUnits,
  errorToast,
  hasUnsavedWork,
  isDocDirty,
  issueEventUpdate,
  useAppStore,
  type DialogEntry,
  type IssueSlice,
} from '../src/renderer/src/store/app';
import { unitList, unitCount } from '../src/renderer/src/lib/units';
import { autoReadDecision, placementKey, type AutoReadInput } from '../src/renderer/src/lib/autoRead';

type OpsModule = typeof import('../src/renderer/src/lib/ops');
let ops: OpsModule;

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => unknown;
const handlers: Record<string, Handler> = {};
const calls: Record<string, unknown[][]> = {};

/** Throw this from a handler to make main answer with an error envelope. */
function mainError(code: string, detail?: string) {
  return { __envelopeError: { code, message: errorMessage(code as never, 'ja'), detail } };
}

function makeBridge() {
  const bridge: Record<string, unknown> = {};
  for (const name of Object.keys(INVOKE_CHANNELS)) {
    bridge[name] = async (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      try {
        const h = handlers[name];
        const value = h ? await h(...args) : undefined;
        return { ok: true, value };
      } catch (e) {
        const env = (e as { __envelopeError?: unknown }).__envelopeError;
        if (env) return { ok: false, error: env };
        return { ok: false, error: { code: 'INTERNAL', message: String(e) } };
      }
    };
  }
  bridge.onSettings = () => () => {};
  bridge.onReaderStatus = () => () => {};
  bridge.onIssueEvent = () => () => {};
  return bridge;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UID_A = '04A1B2C3D4E5F6';
const UID_B = '04B0B1B2B3B4B5';

function ntagImage(uid = UID_A, fill = 0): TagImage {
  const data = new Uint8Array(45 * 4).fill(fill);
  return { kind: 'NTAG213', uid, data, unitStatus: new Array(45).fill('ok'), readAt: 1 };
}

function page(n: number, ...bytes: number[]) {
  return { unit: n, data: Uint8Array.from(bytes.length ? bytes : [n, n, n, n]) };
}

/** Open `img` as a card document and edit the given pages (each page := [p,p,p,p] + 0x10). */
function openEdited(img: TagImage, pages: number[]) {
  const st = useAppStore.getState();
  st.openImage(img, { type: 'card', uid: img.uid });
  const data = new Uint8Array(img.data);
  for (const p of pages) data.set([p + 0x10, p + 0x10, p + 0x10, p + 0x10], p * 4);
  st.editDocData(data);
}

/** The write request the binary editor makes for the doc's dirty pages. */
function writesOfDoc(): WriteRequest {
  const doc = useAppStore.getState().doc!;
  const writes = dirtyUnits(doc).map((u) => ({ unit: u, data: doc.image.data.slice(u * 4, u * 4 + 4) }));
  return { kind: doc.image.kind, expectedUid: doc.image.uid, writes, allowProtected: false, verify: true };
}

/** The tag after applying `writes` to `base` (what a re-read would return). */
function applied(base: TagImage, writes: { unit: number; data: Uint8Array }[], uid = base.uid): TagImage {
  const img = ntagImage(uid);
  img.data.set(base.data);
  for (const w of writes) img.data.set(w.data, w.unit * 4);
  return img;
}

function result(req: WriteRequest, over: Partial<WriteResult> = {}): WriteResult {
  return {
    uid: req.expectedUid ?? UID_A,
    written: req.writes.map((w) => w.unit),
    failed: [],
    verified: req.verify ? true : null,
    mismatched: [],
    aborted: null,
    notAttempted: [],
    ...over,
  };
}

const seenDialogs: DialogEntry[] = [];
let dialogAnswer: (d: DialogEntry) => boolean = () => true;
let unsubscribeDialogs: (() => void) | null = null;

const initialState = useAppStore.getState();

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { nfcBridge: makeBridge() };
  ops = (await import(/* @vite-ignore */ process.env.RC_OPS_UNDER_TEST ?? '../src/renderer/src/lib/ops')) as OpsModule;
});

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  for (const k of Object.keys(calls)) delete calls[k];
  seenDialogs.length = 0;
  dialogAnswer = () => true;
  useAppStore.setState({ ...initialState, settings: { ...DEFAULT_SETTINGS, sound: false, language: 'ja' } }, true);
  // Answer confirm dialogs as they appear.
  unsubscribeDialogs = useAppStore.subscribe((s) => {
    const d = s.dialogs[0];
    if (d && !seenDialogs.includes(d)) {
      seenDialogs.push(d);
      queueMicrotask(() => useAppStore.getState().resolveDialog(d.id, dialogAnswer(d)));
    }
  });
});

afterEach(() => {
  unsubscribeDialogs?.();
});

// ---------------------------------------------------------------------------
// store: guardDiscard / rebaseDoc / markWritten
// ---------------------------------------------------------------------------

describe('guardDiscard', () => {
  it('passes without asking when there is no document or no edit', async () => {
    expect(await useAppStore.getState().guardDiscard()).toBe(true);
    useAppStore.getState().openImage(ntagImage(), { type: 'card', uid: UID_A });
    expect(await useAppStore.getState().guardDiscard()).toBe(true);
    expect(seenDialogs).toHaveLength(0);
  });

  it('asks with the number of changed pages and the document; resolves with the answer', async () => {
    openEdited(ntagImage(), [5, 6]);
    dialogAnswer = () => false;
    expect(await useAppStore.getState().guardDiscard()).toBe(false);
    expect(seenDialogs).toHaveLength(1);
    expect(seenDialogs[0].title).toBe('未書き込みの変更があります');
    expect(seenDialogs[0].message).toContain('2 ページ');
    expect(seenDialogs[0].target).toContain('04:A1:B2:C3:D4:E5:F6');
    expect(seenDialogs[0].confirmLabel).toBe('変更を破棄して続ける');
    dialogAnswer = () => true;
    expect(await useAppStore.getState().guardDiscard()).toBe(true);
  });
});

describe('rebaseDoc / markWritten', () => {
  it('rebaseDoc: original = readback, the kept units keep the edited bytes (still pending)', () => {
    openEdited(ntagImage(), [5, 6]);
    const readback = applied(ntagImage(), [page(5, 0x15, 0x15, 0x15, 0x15)]); // page 5 written, 6 not
    useAppStore.getState().rebaseDoc(readback, [6]);
    const doc = useAppStore.getState().doc!;
    expect(dirtyUnits(doc)).toEqual([6]);
    expect([...doc.image.data.slice(24, 28)]).toEqual([0x16, 0x16, 0x16, 0x16]);
    expect([...doc.original.data.slice(20, 24)]).toEqual([0x15, 0x15, 0x15, 0x15]);
    expect(doc.source).toEqual({ type: 'card', uid: UID_A });
  });

  it('markWritten folds the written units into original (the doc stops looking unsaved)', () => {
    openEdited(ntagImage(), [5]);
    const before = useAppStore.getState().doc!;
    useAppStore.getState().markWritten([{ unit: 5, data: before.image.data.slice(20, 24) }]);
    const doc = useAppStore.getState().doc!;
    expect(isDocDirty(doc)).toBe(false);
    expect(doc.image.data).toEqual(before.image.data);
  });

  it('unsaved work for the window close: doc edits or a screen draft (WALK-13)', () => {
    expect(hasUnsavedWork(useAppStore.getState())).toBe(false);
    useAppStore.getState().setUnsavedDraft('ndef', true);
    useAppStore.getState().setUnsavedDraft('ndef', true);
    expect(useAppStore.getState().unsavedDrafts).toEqual(['ndef']);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(true);
    useAppStore.getState().setUnsavedDraft('ndef', false);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(false);
    openEdited(ntagImage(), [5]);
    expect(hasUnsavedWork(useAppStore.getState())).toBe(true);
  });

  it('openImage clears the previous write result', () => {
    useAppStore.getState().setLastWrite({ at: 1, tone: 'ok', title: 'x', lines: [], uid: UID_A, kind: 'NTAG213', reactivate: false });
    useAppStore.getState().openImage(ntagImage(), { type: 'card', uid: UID_A });
    expect(useAppStore.getState().lastWrite).toBeNull();
  });
});

describe('appStoreApi (server-side render seam for view tests)', () => {
  it('pointing appStoreApi.getInitialState at the live state makes SSR show it', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { appStoreApi } = await import('../src/renderer/src/store/app');
    const V = () => createElement('i', null, useAppStore((s) => s.view));
    useAppStore.setState({ view: 'hex' });
    const saved = appStoreApi.getInitialState;
    try {
      expect(renderToStaticMarkup(createElement(V))).toBe('<i>home</i>');
      appStoreApi.getInitialState = () => appStoreApi.getState();
      expect(renderToStaticMarkup(createElement(V))).toBe('<i>hex</i>');
    } finally {
      appStoreApi.getInitialState = saved;
    }
  });
});

describe('errorToast (FIRST-9 / WALK-16)', () => {
  it('shows the localized message; code and raw detail only as folded technical info', () => {
    const err = new AppError({ code: 'NO_CARD', message: errorMessage('NO_CARD', 'ja'), detail: 'no tag on the virtual reader' });
    const t = errorToast(err, 'タグを読み取れませんでした');
    expect(t.title).toBe('タグを読み取れませんでした');
    expect(t.detail).toBe(errorMessage('NO_CARD', 'ja'));
    expect(t.detail).not.toContain('virtual reader');
    expect(t.technical).toBe('NO_CARD · no tag on the virtual reader');
  });
});

// ---------------------------------------------------------------------------
// lib/ops: readCurrentTag
// ---------------------------------------------------------------------------

describe('readCurrentTag', () => {
  it('asks before replacing unsaved edits and does not read when declined (WALK-4)', async () => {
    openEdited(ntagImage(), [5]);
    handlers.readTag = () => ntagImage(UID_B);
    dialogAnswer = () => false;
    expect(await ops.readCurrentTag()).toBeNull();
    expect(calls.readTag).toBeUndefined();
    expect(useAppStore.getState().doc!.image.uid).toBe(UID_A);
    expect(dirtyUnits(useAppStore.getState().doc)).toEqual([5]);
  });

  it('replaces the document after the operator agreed', async () => {
    openEdited(ntagImage(), [5]);
    handlers.readTag = () => ntagImage(UID_B);
    expect((await ops.readCurrentTag())?.uid).toBe(UID_B);
    expect(useAppStore.getState().doc!.source).toEqual({ type: 'card', uid: UID_B });
  });

  it('does not open an image with interrupted units unless the operator chooses to (CARD-4)', async () => {
    const img = ntagImage(UID_B);
    for (let p = 20; p < 45; p++) img.unitStatus[p] = 'error';
    handlers.readTag = () => img;
    dialogAnswer = () => false;
    expect(await ops.readCurrentTag()).toBeNull();
    expect(useAppStore.getState().doc).toBeNull();
    expect(seenDialogs.map((d) => d.title)).toContain('読み取りが途中で途切れました');
  });

  it('tells protected (denied) and interrupted (error) pages apart (FIRST-22)', () => {
    const img = ntagImage();
    img.unitStatus[41] = 'denied';
    img.unitStatus[42] = 'denied';
    img.unitStatus[10] = 'error';
    const lines = ops.readSummaryLines(img, 'ja');
    expect(lines.some((l) => l.startsWith('2 ページは保護されていて'))).toBe(true);
    expect(lines.some((l) => l.startsWith('1 ページは読み取りの途中で途切れました'))).toBe(true);
  });

  it('FeliCa says IDm, not UID', () => {
    const img: TagImage = { kind: 'FELICA_LITE_S', uid: '0123456789ABCDEF', data: new Uint8Array(16 * 16), unitStatus: new Array(16).fill('ok'), readAt: 1 };
    expect(ops.readSummaryLines(img, 'ja')[0]).toBe('FeliCa Lite-S · IDm 01:23:45:67:89:AB:CD:EF');
  });

  it('a second press while reading does nothing (one read only)', async () => {
    let release: (v: TagImage) => void = () => {};
    handlers.readTag = () => new Promise<TagImage>((r) => (release = r));
    const first = ops.readCurrentTag();
    const second = await ops.readCurrentTag();
    expect(second).toBeNull();
    await Promise.resolve();
    release(ntagImage());
    expect((await first)?.uid).toBe(UID_A);
    expect(calls.readTag).toHaveLength(1);
    expect(useAppStore.getState().busyOp).toBeNull();
  });

  it('refuses while batch issuing runs, before any dialog (ISSUE-11)', async () => {
    openEdited(ntagImage(), [5]);
    useAppStore.setState({ issue: { running: true, job: null, issued: 0, last: null } });
    expect(await ops.readCurrentTag()).toBeNull();
    expect(seenDialogs).toHaveLength(0);
    expect(calls.readTag).toBeUndefined();
  });

  it('a failed read shows the message, not the raw detail', async () => {
    handlers.readTag = () => {
      throw mainError('CARD_REMOVED', 'SCARD_W_REMOVED_CARD');
    };
    expect(await ops.readCurrentTag()).toBeNull();
    const toast = useAppStore.getState().toasts.at(-1)!;
    expect(toast.tone).toBe('danger');
    expect(toast.detail ?? '').not.toContain('SCARD_');
    expect(toast.technical).toContain('SCARD_W_REMOVED_CARD');
  });
});

// ---------------------------------------------------------------------------
// lib/ops: writeWithConfirm
// ---------------------------------------------------------------------------

const UI = { title: '書き込みます', message: 'テスト' };

describe('writeWithConfirm', () => {
  it('confirms with the target tag and a verb button; success commits and clears the edits', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(), req.writes);
    const res = await ops.writeWithConfirm(req, UI);
    expect(res).not.toBeNull();
    expect(seenDialogs[0].target).toBe('書き込み先: NTAG213 · UID 04:A1:B2:C3:D4:E5:F6');
    expect(seenDialogs[0].confirmLabel).toBe('タグに書き込む');
    expect(isDocDirty(useAppStore.getState().doc)).toBe(false);
    const lw = useAppStore.getState().lastWrite!;
    expect(lw.tone).toBe('ok');
    expect(lw.lines[0]).toContain('1 ページを書き込み');
    expect(lw.lines.join('')).not.toContain('単位');
  });

  it('partial failure keeps the unwritten edits pending and says which page and why (WRITE-4 / FLOW-7)', async () => {
    openEdited(ntagImage(), [5, 6]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req, { written: [5], failed: [{ unit: 6, error: 'WRITE_FAILED' }] });
    handlers.readTag = () => applied(ntagImage(), [req.writes[0]]);
    await ops.writeWithConfirm(req, UI);
    const doc = useAppStore.getState().doc!;
    expect(dirtyUnits(doc)).toEqual([6]);
    expect([...doc.image.data.slice(24, 28)]).toEqual([0x16, 0x16, 0x16, 0x16]);
    const lw = useAppStore.getState().lastWrite!;
    expect(lw.tone).toBe('danger');
    expect(lw.lines.join('\n')).toContain(`ページ 6: ${errorMessage('WRITE_FAILED', 'ja')}`);
    expect(lw.lines.join('\n')).not.toMatch(/WRITE_FAILED|#6/);
    expect(lw.lines).toContain('書き込めなかった変更は、未書き込みの変更として残してあります。');
  });

  it('verify mismatch (e.g. locked pages) keeps those edits pending', async () => {
    openEdited(ntagImage(), [16, 17]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req, { verified: false, mismatched: [16, 17] });
    handlers.readTag = () => ntagImage(); // the tag kept the old bytes
    await ops.writeWithConfirm(req, UI);
    expect(dirtyUnits(useAppStore.getState().doc)).toEqual([16, 17]);
    expect(useAppStore.getState().lastWrite!.lines[0]).toContain('ページ 16・17');
  });

  it('a write cut short by removing the tag says the tag is partly written and keeps the rest (WRITE-4 b)', async () => {
    openEdited(ntagImage(), [5, 6, 7]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req, { written: [5], aborted: 'CARD_REMOVED', notAttempted: [6, 7], verified: null });
    handlers.readTag = () => {
      throw mainError('NO_CARD');
    };
    await ops.writeWithConfirm(req, UI);
    const lw = useAppStore.getState().lastWrite!;
    expect(lw.title).toBe('書き込みの途中で止まりました');
    expect(lw.lines.join('\n')).toContain('一部だけ書き込まれた状態');
    // re-read failed: page 5 is known to be written; 6 and 7 stay pending.
    expect(dirtyUnits(useAppStore.getState().doc)).toEqual([6, 7]);
  });

  it('write OK but the re-read failed: written edits no longer look unsaved (WRITE-6 / WALK-6)', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req);
    handlers.readTag = () => {
      throw mainError('CARD_REMOVED');
    };
    await ops.writeWithConfirm(req, UI);
    expect(isDocDirty(useAppStore.getState().doc)).toBe(false);
    expect(useAppStore.getState().lastWrite!.lines.join('\n')).toContain('確認の読み取りができませんでした');
  });

  it('a re-read that returns a different tag never becomes the document', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req);
    handlers.readTag = () => ntagImage(UID_B, 0xee);
    await ops.writeWithConfirm(req, UI);
    const doc = useAppStore.getState().doc!;
    expect(doc.source).toEqual({ type: 'card', uid: UID_A });
    expect(doc.image.uid).toBe(UID_A);
    expect(doc.image.data[0]).toBe(0);
    expect(useAppStore.getState().lastWrite!.lines.join('\n')).toContain('04:B0:B1:B2:B3:B4:B5');
  });

  it('a double press writes once (WRITE-13)', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(), req.writes);
    const [a, b] = await Promise.all([ops.writeWithConfirm(req, UI), ops.writeWithConfirm(req, UI)]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    expect(calls.writeTag).toHaveLength(1);
    expect(seenDialogs).toHaveLength(1);
    expect(useAppStore.getState().busyOp).toBeNull();
  });

  it('NDEF-style content written to the same tag keeps an unrelated pending edit (FLOW-6)', async () => {
    openEdited(ntagImage(), [24]);
    const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_A, writes: [page(4, 0x03, 0x00, 0xfe, 0x00)], allowProtected: false, verify: true };
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(), req.writes);
    await ops.writeWithConfirm(req, UI);
    const doc = useAppStore.getState().doc!;
    expect(dirtyUnits(doc)).toEqual([24]);
    expect([...doc.original.data.slice(16, 20)]).toEqual([0x03, 0x00, 0xfe, 0x00]);
  });

  it('content written to ANOTHER tag leaves a document with unsaved edits as it is (FLOW-6)', async () => {
    openEdited(ntagImage(), [24]);
    const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_B, writes: [page(4, 0x03, 0x00, 0xfe, 0x00)], allowProtected: false, verify: true };
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(UID_B), req.writes);
    await ops.writeWithConfirm(req, { ...UI, target: { kind: 'NTAG213', uid: UID_B } });
    const doc = useAppStore.getState().doc!;
    expect(doc.source).toEqual({ type: 'card', uid: UID_A });
    expect(dirtyUnits(doc)).toEqual([24]);
    expect(useAppStore.getState().lastWrite!.lines.join('\n')).toContain('書き込む前のまま残してあります');
  });

  it('copying a file document onto a tag: warns in the confirmation, then the doc is that tag (D5)', async () => {
    const file = ntagImage(UID_A, 0);
    file.data.set([9, 9, 9, 9], 5 * 4);
    useAppStore.getState().openImage(file, { type: 'file', name: 'a.nfcdump', token: 't', format: 'project' });
    const target = ntagImage(UID_B);
    const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_B, writes: [page(5, 9, 9, 9, 9)], allowProtected: false, verify: true };
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(target, req.writes);
    // confirmBeforeWrite off: a copy onto a different tag is still confirmed.
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, confirmBeforeWrite: false } });
    await ops.writeWithConfirm(req, { ...UI, target: { kind: 'NTAG213', uid: UID_B, other: true } });
    expect(seenDialogs).toHaveLength(1);
    expect(seenDialogs[0].warning).toContain('a.nfcdump');
    expect(seenDialogs[0].tone).toBe('warn');
    const doc = useAppStore.getState().doc!;
    expect(doc.source).toEqual({ type: 'card', uid: UID_B });
    expect(isDocDirty(doc)).toBe(false);
  });

  it('confirmation wording: never "different tag" when the open document IS the target', () => {
    useAppStore.getState().openImage(ntagImage(UID_B), { type: 'card', uid: UID_B });
    const doc = useAppStore.getState().doc;
    const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_B, writes: [page(4, 3, 0, 0xfe, 0)], allowProtected: false, verify: true };
    // NDEF records read from another tag, written to the open tag B: the caller says "other".
    const said = ops.writeConfirmTexts(doc, req, { target: { kind: 'NTAG213', uid: UID_B, other: true } }, 'ja');
    expect(said.warning).toBe('読み取ったときとは別のタグへ書き込みます。書き込み先の UID を確かめてください。');
    expect(said.force).toBe(true);
    const plain = ops.writeConfirmTexts(doc, req, { target: { kind: 'NTAG213', uid: UID_B } }, 'ja');
    expect(plain.warning).toBeNull();
    // Content (not the document) written to another tag: warned, but not forced.
    const otherTag = ops.writeConfirmTexts(doc, { ...req, expectedUid: UID_A }, { target: { kind: 'NTAG213', uid: UID_A } }, 'ja');
    expect(otherTag.warning).toContain('04:B0:B1:B2:B3:B4:B5');
    expect(otherTag.force).toBe(false);
  });

  it('a refused write (UID_MISMATCH) keeps the edits and says nothing was written', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    handlers.writeTag = () => {
      throw mainError('UID_MISMATCH', 'expected 04A1 got 04B0');
    };
    expect(await ops.writeWithConfirm(req, UI)).toBeNull();
    expect(dirtyUnits(useAppStore.getState().doc)).toEqual([5]);
    const lw = useAppStore.getState().lastWrite!;
    expect(lw.tone).toBe('danger');
    expect(lw.lines).toContain('タグには何も書き込まれていません。未書き込みの変更は、そのまま残してあります。');
    expect(lw.lines.join('')).not.toContain('expected 04A1');
  });

  it('protection settings: the result asks to take the tag off and place it again (WRITE-14)', async () => {
    openEdited(ntagImage(), [41]);
    const req = { ...writesOfDoc(), allowProtected: true };
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(), req.writes);
    await ops.writeWithConfirm(req, { ...UI, reactivateAfter: true });
    expect(useAppStore.getState().lastWrite!.reactivate).toBe(true);
    expect(seenDialogs[0].details?.join('\n')).toContain('置き直すと有効になります');
  });

  it('nothing to write / batch issuing: no dialog', async () => {
    expect(await ops.writeWithConfirm({ kind: 'NTAG213', expectedUid: UID_A, writes: [], allowProtected: false, verify: true }, UI)).toBeNull();
    openEdited(ntagImage(), [5]);
    useAppStore.setState({ issue: { running: true, job: null, issued: 0, last: null } });
    expect(await ops.writeWithConfirm(writesOfDoc(), UI)).toBeNull();
    expect(seenDialogs).toHaveLength(0);
    expect(calls.writeTag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// units wording (FLOW-16)
// ---------------------------------------------------------------------------

describe('unit wording', () => {
  it('lists pages / blocks the way the editor labels them', () => {
    expect(unitList('NTAG213', [17, 16], 'ja')).toBe('ページ 16・17');
    expect(unitList('NTAG213', [40, 41, 42, 43], 'ja')).toBe('ページ 40〜43');
    expect(unitList('NTAG213', [5], 'en')).toBe('page 5');
    expect(unitList('NTAG213', [5, 9], 'en')).toBe('pages 5, 9');
    expect(unitList('FELICA_LITE_S', [13, 15], 'ja')).toBe('ブロック 0x0D・0x88');
    expect(unitList('NTAG213', [1, 3, 5, 7, 9, 11, 13, 15, 17, 19], 'ja')).toBe('ページ 1・3・5・7・9・11・13・15 ほか 2 か所');
    expect(unitCount('MIFARE_CLASSIC_1K', 1, 'en')).toBe('1 block');
    expect(unitCount('NTAG215', 3, 'ja')).toBe('3 ページ');
  });
});

// ---------------------------------------------------------------------------
// auto-read decision (D2)
// ---------------------------------------------------------------------------

function readerWith(state: ReaderStatus['cardState'], uid = UID_A, detectedAt = 1): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [],
    selectedReader: null,
    activeReader: 'R1',
    activeReason: 'auto-card',
    driverMode: 'auto',
    card:
      state === 'ready'
        ? { readerName: 'R1', uid, atr: '', kind: 'NTAG213', kindSource: 'version', version: null, rawCommands: true, driver: 'acr122', detectedAt }
        : null,
    cardState: state,
    cardError: null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: false, kind: 'NTAG213', present: false, uid: '' },
  };
}

function input(over: Partial<AutoReadInput>): AutoReadInput {
  return { enabled: true, view: 'home', reader: readerWith('ready'), issueRunning: false, busyOp: null, dialogsOpen: false, doc: null, handled: null, ...over };
}

describe('autoReadDecision', () => {
  it('reads a newly placed tag on the reading screens', () => {
    for (const view of ['home', 'hex', 'ndef'] as const) expect(autoReadDecision(input({ view })).read).toBe(true);
  });

  it('reads a placement once; the same tag refreshed by main (new detectedAt) is not a new placement', () => {
    const d = autoReadDecision(input({}));
    expect(d.read).toBe(true);
    expect(autoReadDecision(input({ handled: d.handled, reader: readerWith('ready', UID_A, 999) })).read).toBe(false);
  });

  it('taking the tag off and placing it again reads it again', () => {
    const first = autoReadDecision(input({}));
    const left = autoReadDecision(input({ handled: first.handled, reader: readerWith('absent') }));
    expect(left.handled).toBeNull();
    expect(autoReadDecision(input({ handled: left.handled })).read).toBe(true);
  });

  it('a re-check of the same tag (detecting / error) keeps the mark', () => {
    const first = autoReadDecision(input({}));
    const checking = autoReadDecision(input({ handled: first.handled, reader: readerWith('detecting') }));
    expect(checking.handled).toBe(first.handled);
    expect(autoReadDecision(input({ handled: checking.handled })).read).toBe(false);
  });

  it('never replaces unsaved edits or a file / new document', () => {
    openEdited(ntagImage(), [5]);
    expect(autoReadDecision(input({ doc: useAppStore.getState().doc, reader: readerWith('ready', UID_B) })).reason).toBe('dirty');
    useAppStore.getState().openImage(ntagImage(), { type: 'file', name: 'x', token: null, format: 'bin' });
    expect(autoReadDecision(input({ doc: useAppStore.getState().doc, reader: readerWith('ready', UID_B) })).reason).toBe('file-doc');
    useAppStore.getState().openImage(ntagImage(), { type: 'new' });
    expect(autoReadDecision(input({ doc: useAppStore.getState().doc })).read).toBe(false);
  });

  it('replaces a clean document of another tag', () => {
    useAppStore.getState().openImage(ntagImage(), { type: 'card', uid: UID_A });
    expect(autoReadDecision(input({ doc: useAppStore.getState().doc, reader: readerWith('ready', UID_B) })).read).toBe(true);
  });

  it('does not read on other screens, while busy / issuing / a dialog is open, or when turned off - and not later either', () => {
    for (const over of [{ view: 'settings' as const }, { busyOp: 'write' }, { issueRunning: true }, { dialogsOpen: true }, { enabled: false }]) {
      const d = autoReadDecision(input(over));
      expect(d.read).toBe(false);
      expect(d.handled).toBe(placementKey(readerWith('ready')));
      expect(autoReadDecision(input({ handled: d.handled })).read).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// shared components (server-side render smoke: states, reasons, fixes)
// ---------------------------------------------------------------------------

describe('TagOnReader / LastWriteCallout render', () => {
  async function renderWith(component: 'tag' | 'tagCompact' | 'last'): Promise<string> {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { appStoreApi } = await import('../src/renderer/src/store/app');
    const { TagOnReader } = await import('../src/renderer/src/components/TagOnReader');
    const { LastWriteCallout } = await import('../src/renderer/src/components/LastWriteCallout');
    const saved = appStoreApi.getInitialState;
    appStoreApi.getInitialState = () => appStoreApi.getState();
    try {
      const el =
        component === 'last' ? createElement(LastWriteCallout) : createElement(TagOnReader, { compact: component === 'tagCompact' });
      return renderToStaticMarkup(el);
    } finally {
      appStoreApi.getInitialState = saved;
    }
  }

  it('no tag: tells to place it and keep it there', async () => {
    useAppStore.setState({ reader: readerWith('absent') });
    const html = await renderWith('tag');
    expect(html).toContain('data-card-state="absent"');
    expect(html).toContain('改札のように一瞬タッチするだけでは読めません');
  });

  it('unreadable: says why (READER_IN_USE) and offers a retry', async () => {
    useAppStore.setState({ reader: { ...readerWith('error'), cardError: 'READER_IN_USE' } });
    const html = await renderWith('tag');
    expect(html).toContain(errorMessage('READER_IN_USE', 'ja'));
    expect(html).toContain('もう一度確認');
  });

  it('virtual reader in front of a real tag, selected reader missing, a different tag than the document', async () => {
    useAppStore.setState({ reader: { ...readerWith('ready', UID_B), ignoredRealReader: 'Sony PaSoRi 0' } });
    useAppStore.getState().openImage(ntagImage(UID_A), { type: 'card', uid: UID_A });
    let html = await renderWith('tag');
    expect(html).toContain('実機のリーダー「Sony PaSoRi 0」の上のタグは使われていません');
    expect(html).toContain('仮想リーダーをオフにする');
    expect(html).toContain('開いている文書とは別のタグが置かれています');
    expect(html).toContain('このタグを読み取る');
    useAppStore.setState({ reader: { ...readerWith('no-reader'), activeReason: 'selected-missing', selectedReader: 'ACS ACR122U 0' } });
    html = await renderWith('tagCompact');
    expect(html).toContain('自動選択に戻す');
  });

  it('the last write stays with the reactivation hint until dismissed', async () => {
    useAppStore.setState({
      lastWrite: { at: 0, tone: 'ok', title: 'タグに書き込みました', lines: ['1 ページを書き込みました'], uid: UID_A, kind: 'NTAG213', reactivate: true },
    });
    const html = await renderWith('last');
    expect(html).toContain('タグに書き込みました');
    expect(html).toContain('置き直してください');
    expect(html).toContain('UID 04:A1:B2:C3:D4:E5:F6');
    expect(html).toContain('aria-label="閉じる"');
  });
});

// ---------------------------------------------------------------------------
// batch issue results (ISSUE-1 / ISSUE-7, D6)
// ---------------------------------------------------------------------------

function entry(over: Partial<IssueLogEntry> = {}): IssueLogEntry {
  return { id: 'e', jobId: 'j', jobName: 'job', at: 1, uid: UID_A, kind: 'NTAG213', seq: 12, values: {}, result: 'ok', message: null, ...over };
}

const job = { id: 'j', name: 'job', kind: 'NTAG213', options: { sound: true } } as unknown as IssueJob;

function fold(events: IssueEvent[]): ReturnType<typeof issueEventUpdate>[] {
  let slice: IssueSlice = { issue: { running: false, job: null, issued: 0, last: null }, issueRecent: [], issueLastRun: null };
  const out: ReturnType<typeof issueEventUpdate>[] = [];
  for (const e of events) {
    const u = issueEventUpdate(slice, e, { now: 100, lang: 'ja' });
    out.push(u);
    slice = u;
  }
  return out;
}

describe('issueEventUpdate', () => {
  it('keeps each result (with sound) even though "remove the tag" follows at once', () => {
    const us = fold([
      { type: 'started', job },
      { type: 'writing', uid: UID_A, next: { seq: 12, rowIndex: null, values: {} } },
      { type: 'success', entry: entry(), issued: 1 },
      { type: 'remove-card', uid: UID_A, outcome: 'ok', entry: entry(), message: null },
      { type: 'skipped', entry: entry({ uid: UID_B, kind: 'NTAG215', seq: null, result: 'skipped' }), reason: 'wrong-kind' },
      { type: 'remove-card', uid: UID_B, outcome: 'skipped', entry: null, message: null },
    ]);
    expect(us.map((u) => u.sound)).toEqual([null, null, 'success', null, 'skip', null]);
    const last = us.at(-1)!;
    expect(last.issueRecent.map((r) => r.outcome)).toEqual(['skipped', 'ok']);
    expect(last.issueRecent[0].message).toBe('タグの種類が違います（置かれたタグ: NTAG215）');
    expect(last.issueRecent[1]).toMatchObject({ uid: UID_A, seq: 12 });
  });

  it('an error without a log entry gets the tag being written and a localized message', () => {
    const us = fold([
      { type: 'started', job },
      { type: 'writing', uid: UID_B, next: { seq: 7, rowIndex: null, values: {} } },
      { type: 'error', entry: null, message: 'CARD_REMOVED', partial: true },
    ]);
    const r = us.at(-1)!.issueRecent[0];
    expect(r).toMatchObject({ outcome: 'error', uid: UID_B, seq: 7, partial: true });
    expect(r.message).toBe(errorMessage('CARD_REMOVED', 'ja'));
    expect(us.at(-1)!.sound).toBe('error');
  });

  it('records an outcome reported only by remove-card, once', () => {
    const us = fold([
      { type: 'started', job },
      { type: 'writing', uid: UID_A, next: { seq: 1, rowIndex: null, values: {} } },
      { type: 'remove-card', uid: UID_A, outcome: 'ok', entry: entry({ seq: 1 }), message: null },
    ]);
    expect(us.at(-1)!.issueRecent).toHaveLength(1);
    expect(us.at(-1)!.sound).toBe('success');
  });

  it('a stop keeps the summary and tells every screen why (ISSUE-7)', () => {
    const us = fold([
      { type: 'started', job },
      { type: 'stopped', reason: 'limit', issued: 50, job },
    ]);
    const u = us.at(-1)!;
    expect(u.issue.running).toBe(false);
    expect(u.issueLastRun).toMatchObject({ reason: 'limit', issued: 50, endedAt: 100 });
    expect(u.toast?.title).toBe('上限の枚数に達したため、一括発行を終えました');
    expect(u.toast?.detail).toBe('発行した枚数: 50 枚');
  });

  it('keeps at most 20 results, newest first; a new run starts empty', () => {
    const many: IssueEvent[] = [{ type: 'started', job }];
    for (let i = 0; i < 25; i++) many.push({ type: 'success', entry: entry({ seq: i }), issued: i + 1 });
    let us = fold(many);
    expect(us.at(-1)!.issueRecent).toHaveLength(20);
    expect(us.at(-1)!.issueRecent[0].seq).toBe(24);
    us = fold([...many, { type: 'started', job }]);
    expect(us.at(-1)!.issueRecent).toHaveLength(0);
  });
});

// ===========================================================================
// 2026-11-12 review round 2 (R-WRITE-1/3/4/5, R-ISSUE-9, R-UX-4 / D9, D13,
// E2E-UX-1..5). Each case below failed on the round-1 implementation.
// ===========================================================================

function mifareImage(uid = UID_A, deniedSectors: number[] = [1]): TagImage {
  const data = new Uint8Array(64 * 16);
  const unitStatus = new Array(64).fill('ok') as TagImage['unitStatus'];
  for (const s of deniedSectors) for (let b = s * 4; b < s * 4 + 4; b++) unitStatus[b] = 'denied';
  return { kind: 'MIFARE_CLASSIC_1K', uid, data, unitStatus, readAt: 1 };
}

function mifareReader(uid = UID_A): ReaderStatus {
  const r = readerWith('ready', uid);
  return { ...r, card: { ...r.card!, kind: 'MIFARE_CLASSIC_1K', rawCommands: false, driver: 'storage' } };
}

const KEY_LIST = [
  { id: 'builtin-default', label: 'factory', masked: 'FF..FF', builtin: true },
  { id: 'builtin-mad', label: 'MAD', masked: 'A0..A5', builtin: true },
  { id: 'builtin-ndef', label: 'NDEF', masked: 'D3..F7', builtin: true },
  { id: 'user-1', label: 'office', masked: '12..34', builtin: false },
];
const STANDARD_IDS = ['builtin-default', 'builtin-mad', 'builtin-ndef'];

/** Tag A with "NDEF-like" content on pages 4-9 (what the NDEF screen re-encodes byte for byte). */
function tagWithContent(uid = UID_A): TagImage {
  const img = ntagImage(uid);
  for (let p = 4; p <= 9; p++) img.data.set([0x03 + p, p, 0xa0 + p, p], p * 4);
  return img;
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
}

function readKeyIds(n = 0): string[] | undefined {
  return (calls.readTag[n][0] as { mifareKeyIds?: string[] }).mifareKeyIds;
}

describe('R-WRITE-1: a write is a copy of the document only when the caller says so (or every edit is in it)', () => {
  function docAWithEdit30() {
    const a = tagWithContent(UID_A);
    useAppStore.getState().openImage(a, { type: 'card', uid: UID_A });
    const edited = new Uint8Array(a.data);
    edited.set([0x11, 0x22, 0x33, 0x44], 30 * 4);
    useAppStore.getState().editDocData(edited);
    const writes = [4, 5, 6, 7, 8, 9].map((p) => ({ unit: p, data: a.data.slice(p * 4, p * 4 + 4) }));
    const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_B, writes, allowProtected: false, verify: true };
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(UID_B), writes, UID_B);
    return req;
  }

  for (const docCopy of [undefined, false] as const) {
    it(`content equal to part of a document with another unsaved edit, written to tag B, keeps the document (docCopy ${String(docCopy)})`, async () => {
      const req = docAWithEdit30();
      expect(ops.isWriteFromDoc(useAppStore.getState().doc, req)).toBe(true); // byte-equal...
      await ops.writeWithConfirm(req, { ...UI, target: { kind: 'NTAG213', uid: UID_B, other: true }, keepUnitsOnFailure: [], docCopy });
      const doc = useAppStore.getState().doc!;
      expect(doc.source).toEqual({ type: 'card', uid: UID_A }); // ...but not a copy of the document
      expect(dirtyUnits(doc)).toEqual([30]);
      expect([...doc.image.data.slice(120, 124)]).toEqual([0x11, 0x22, 0x33, 0x44]);
      expect(useAppStore.getState().past.length).toBeGreaterThan(0); // undo still works
      // The confirmation never called it a copy of the document.
      expect(seenDialogs[0].warning).toBe('開いている文書のタグ（UID 04:A1:B2:C3:D4:E5:F6）とは別のタグへ書き込みます。');
      expect(useAppStore.getState().lastWrite!.lines.join('\n')).toContain('開いている文書（未書き込みの変更 1 ページ）は、書き込む前のまま残してあります。');
    });
  }

  it('docCopy: true - the document becomes tag B and the result names the edit it does not carry over', async () => {
    const req = docAWithEdit30();
    await ops.writeWithConfirm(req, { ...UI, target: { kind: 'NTAG213', uid: UID_B, other: true }, docCopy: true });
    const doc = useAppStore.getState().doc!;
    expect(doc.source).toEqual({ type: 'card', uid: UID_B });
    expect(seenDialogs[0].warning).toContain('別のタグへ書き込みます（複製）');
    expect(useAppStore.getState().lastWrite!.lines.join('\n')).toContain('ページ 30 の変更は書き込まれていません');
  });

  it('binary copy A -> B with a page left out (locked on B): kept as A unless the caller says copy; a copy says what it left out', async () => {
    const run = async (docCopy: boolean | undefined) => {
      useAppStore.setState({ ...initialState, settings: { ...DEFAULT_SETTINGS, sound: false, language: 'ja' } }, true);
      openEdited(ntagImage(UID_A), [10, 12]);
      const doc = useAppStore.getState().doc!;
      const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_B, writes: [{ unit: 10, data: doc.image.data.slice(40, 44) }], allowProtected: false, verify: true };
      handlers.writeTag = () => result(req);
      handlers.readTag = () => applied(ntagImage(UID_B), req.writes, UID_B);
      await ops.writeWithConfirm(req, { ...UI, dangerous: true, target: { kind: 'NTAG213', uid: UID_B, other: true }, docCopy });
      return useAppStore.getState();
    };
    let s = await run(undefined);
    expect(s.doc!.source).toEqual({ type: 'card', uid: UID_A });
    expect(dirtyUnits(s.doc)).toEqual([10, 12]);
    s = await run(true);
    expect(s.doc!.source).toEqual({ type: 'card', uid: UID_B });
    expect(s.lastWrite!.lines.join('\n')).toContain('ページ 12 の変更は書き込まれていません');
  });

  it('a file document copied onto a tag with docCopy: true still becomes that tag (D5)', async () => {
    const file = ntagImage(UID_A, 0);
    file.data.set([9, 9, 9, 9], 5 * 4);
    useAppStore.getState().openImage(file, { type: 'file', name: 'a.nfcdump', token: 't', format: 'project' });
    const req: WriteRequest = { kind: 'NTAG213', expectedUid: UID_B, writes: [page(5, 9, 9, 9, 9)], allowProtected: false, verify: true };
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(UID_B), req.writes, UID_B);
    await ops.writeWithConfirm(req, { ...UI, target: { kind: 'NTAG213', uid: UID_B, other: true }, docCopy: true });
    expect(useAppStore.getState().doc!.source).toEqual({ type: 'card', uid: UID_B });
    expect(seenDialogs[0].warning).toContain('a.nfcdump');
  });
});

describe('R-WRITE-3 (store side): a document opened while a write runs is left alone', () => {
  it('the file opened mid-write stays the document, untouched', async () => {
    openEdited(ntagImage(UID_A), [5]);
    const req = writesOfDoc();
    let release: (r: WriteResult) => void = () => {};
    handlers.writeTag = () => new Promise<WriteResult>((r) => (release = r));
    handlers.readTag = () => applied(ntagImage(UID_A), req.writes);
    const p = ops.writeWithConfirm(req, UI);
    await until(() => !!calls.writeTag);
    const fileC = ntagImage('04C0C1C2C3C4C5');
    fileC.data.set([7, 7, 7, 7], 20 * 4);
    useAppStore.getState().openImage(fileC, { type: 'file', name: 'c.nfcdump', token: 'tok', format: 'project' });
    release(result(req));
    await p;
    const doc = useAppStore.getState().doc!;
    expect(doc.source).toEqual({ type: 'file', name: 'c.nfcdump', token: 'tok', format: 'project' });
    expect(dirtyUnits(doc)).toEqual([]);
  });
});

describe('R-WRITE-4 / retry: the write result says what really happened', () => {
  it('every page written, the tag left during the verify read-back: "written (not verified)", not "partly written"', async () => {
    openEdited(ntagImage(), [5, 6, 7]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req, { aborted: 'CARD_REMOVED', verified: false });
    handlers.readTag = () => {
      throw mainError('NO_CARD');
    };
    await ops.writeWithConfirm(req, UI);
    const lw = useAppStore.getState().lastWrite!;
    expect(lw.tone).toBe('warn');
    expect(lw.title).toBe('書き込みました（照合の前にタグが離れました）');
    expect(lw.lines[0]).toBe('3 ページを書き込みました。照合はできていません。タグを置いて読み取ると確かめられます。');
    expect(lw.lines.join('\n')).not.toContain('一部だけ書き込まれた');
    expect(lw.retry).toBeFalsy();
    expect(isDocDirty(useAppStore.getState().doc)).toBe(false);
  });

  it('cut short mid-write: the result asks to write again (shown by LastWriteCallout, not baked into the lines)', async () => {
    openEdited(ntagImage(), [5, 6, 7]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req, { written: [5], aborted: 'CARD_REMOVED', notAttempted: [6, 7], verified: null });
    handlers.readTag = () => {
      throw mainError('NO_CARD');
    };
    await ops.writeWithConfirm(req, UI);
    const lw = useAppStore.getState().lastWrite!;
    expect(lw.retry).toBe(true);
    expect(lw.lines.join('\n')).not.toContain('もう一度書き込んでください');
  });

  it('READER_NO_AUTH / FORBIDDEN_UNIT are refused before writing: "nothing was written"', async () => {
    for (const code of ['READER_NO_AUTH', 'FORBIDDEN_UNIT']) {
      openEdited(ntagImage(), [5]);
      handlers.writeTag = () => {
        throw mainError(code);
      };
      await ops.writeWithConfirm(writesOfDoc(), UI);
      expect(useAppStore.getState().lastWrite!.lines).toContain('タグには何も書き込まれていません。未書き込みの変更は、そのまま残してあります。');
    }
  });
});

describe('D13 / E2E-UX-1/4/5: toasts and the confirmation', () => {
  it('a successful write shows no toast (the result stays in LastWriteCallout); a failure a short one', async () => {
    openEdited(ntagImage(), [5]);
    let req = writesOfDoc();
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(), req.writes);
    await ops.writeWithConfirm(req, UI);
    expect(useAppStore.getState().lastWrite!.tone).toBe('ok');
    expect(useAppStore.getState().toasts).toEqual([]);

    openEdited(ntagImage(), [5, 6]);
    req = writesOfDoc();
    handlers.writeTag = () => result(req, { written: [5], failed: [{ unit: 6, error: 'WRITE_FAILED' }] });
    handlers.readTag = () => applied(ntagImage(), [req.writes[0]]);
    await ops.writeWithConfirm(req, UI);
    const ts = useAppStore.getState().toasts;
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ tone: 'danger', title: '一部を書き込めませんでした' });
    expect(ts[0].detail).toBe(useAppStore.getState().lastWrite!.lines[0]);
    expect(ts[0].timeoutMs).toBeUndefined(); // not sticky: the callout keeps it
  });

  it('nothing says "writing" / "reading" while the confirmation is still open', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    const seen: Record<string, unknown> = {};
    dialogAnswer = () => {
      seen.dialog = useAppStore.getState().busyOp;
      return true;
    };
    handlers.writeTag = () => {
      seen.write = useAppStore.getState().busyOp;
      return result(req);
    };
    handlers.readTag = () => applied(ntagImage(), req.writes);
    await ops.writeWithConfirm(req, UI);
    expect(seen).toEqual({ dialog: null, write: 'write' });

    openEdited(ntagImage(), [5]);
    seen.dialog = 'unset';
    handlers.readTag = () => {
      seen.read = useAppStore.getState().busyOp;
      return ntagImage(UID_B);
    };
    await ops.readCurrentTag(); // guardDiscard asks first
    expect(seen.dialog).toBeNull();
    expect(seen.read).toBe('read');
    expect(useAppStore.getState().busyOp).toBeNull();
  });

  it('a second operation is refused while the first one still asks', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    unsubscribeDialogs?.();
    unsubscribeDialogs = null;
    const p = ops.writeWithConfirm(req, UI);
    await until(() => useAppStore.getState().dialogs.length > 0);
    const d = useAppStore.getState().dialogs[0];
    expect(await ops.readCurrentTag()).toBeNull();
    expect(await ops.readTarget()).toBeNull();
    expect(await ops.writeWithConfirm(req, UI)).toBeNull();
    expect(calls.readTag).toBeUndefined();
    useAppStore.getState().resolveDialog(d.id, false);
    expect(await p).toBeNull();
    expect(calls.writeTag).toBeUndefined();
  });

  it('the confirm button says what the operation does (confirmLabel)', async () => {
    openEdited(ntagImage(), [5]);
    const req = writesOfDoc();
    handlers.writeTag = () => result(req);
    handlers.readTag = () => applied(ntagImage(), req.writes);
    await ops.writeWithConfirm(req, { ...UI, confirmLabel: 'NDEF を消去する' });
    expect(seenDialogs[0].confirmLabel).toBe('NDEF を消去する');
  });

  it('the same toast again is shown once with a count; at most 3 at a time', () => {
    const st = useAppStore.getState();
    st.toast({ tone: 'ok', title: '読み取りました', detail: 'NTAG213' });
    st.toast({ tone: 'ok', title: '読み取りました', detail: 'NTAG213' });
    let ts = useAppStore.getState().toasts;
    expect(ts).toHaveLength(1);
    expect(ts[0].count).toBe(2);
    for (const n of [1, 2, 3, 4]) st.toast({ tone: 'info', title: `t${n}` });
    ts = useAppStore.getState().toasts;
    expect(ts.map((x) => x.title)).toEqual(['t2', 't3', 't4']);
  });

  it('placeToaster: moves above the buttons it would cover; stays put otherwise; goes to the top without room', async () => {
    const { placeToaster } = await import('../src/renderer/src/components/Overlays');
    const base = { width: 380, height: 80, right: 20, bottom: 44, viewportWidth: 1200, viewportHeight: 800, minTop: 16 };
    // Nothing in the way.
    expect(placeToaster({ ...base, avoid: [{ left: 100, top: 700, right: 300, bottom: 740 }] })).toEqual({ bottom: 44 });
    // The run bar's write button at the bottom right: the toasts sit above it (8 px gap).
    expect(placeToaster({ ...base, avoid: [{ left: 1000, top: 690, right: 1180, bottom: 730 }] })).toEqual({ bottom: 800 - 682 });
    // ...and above the write result on top of it.
    expect(
      placeToaster({
        ...base,
        avoid: [
          { left: 1000, top: 690, right: 1180, bottom: 730 },
          { left: 300, top: 600, right: 1180, bottom: 688 },
        ],
      }),
    ).toEqual({ bottom: 800 - 592 });
    // No room below the top: top right.
    expect(placeToaster({ ...base, avoid: [{ left: 0, top: 60, right: 1200, bottom: 780 }] })).toEqual({ top: 16 });
  });
});

describe('D9 / R-UX-4: the auto-read tries the public standard keys only', () => {
  it("auto-read: standard key ids only (never the operator's); the document offers the registered keys", async () => {
    handlers.listKeys = () => KEY_LIST;
    handlers.readTag = () => mifareImage();
    expect(await ops.readCurrentTag({}, { standardKeysOnly: true })).not.toBeNull();
    expect(readKeyIds()).toEqual(STANDARD_IDS);
    expect(useAppStore.getState().doc!.standardKeysOnly).toBe(true);
    expect(useAppStore.getState().toasts.at(-1)!.detail).toContain('「登録した鍵で読み取る」');
  });

  it('the key list cannot be fetched: still the standard keys (never "every key")', async () => {
    handlers.listKeys = () => {
      throw mainError('INTERNAL');
    };
    handlers.readTag = () => mifareImage();
    await ops.readCurrentTag({}, { standardKeysOnly: true });
    expect(readKeyIds()).toEqual(STANDARD_IDS);
  });

  it('a manual read names no keys (main tries every key) and the document is not marked', async () => {
    handlers.readTag = () => mifareImage();
    await ops.readCurrentTag();
    expect(readKeyIds()).toBeUndefined();
    expect(useAppStore.getState().doc!.standardKeysOnly).toBeUndefined();
  });

  it('placing a tag (autoReadStep) reads it with the standard keys', async () => {
    const { autoReadStep } = await import('../src/renderer/src/lib/autoRead');
    handlers.listKeys = () => KEY_LIST;
    handlers.readTag = () => mifareImage();
    useAppStore.setState({ reader: mifareReader(), view: 'home' });
    autoReadStep(null);
    await until(() => !!calls.readTag);
    expect(readKeyIds()).toEqual(STANDARD_IDS);
  });

  it('offersRegisteredKeys: only for the auto-read MIFARE document of the tag on the reader with closed sectors', async () => {
    const { offersRegisteredKeys } = await import('../src/renderer/src/components/TagOnReader');
    const st = useAppStore.getState();
    st.openImage(mifareImage(), { type: 'card', uid: UID_A }, { standardKeysOnly: true });
    expect(offersRegisteredKeys(useAppStore.getState().doc, UID_A)).toBe(true);
    expect(offersRegisteredKeys(useAppStore.getState().doc, UID_B)).toBe(false);
    st.openImage(mifareImage(), { type: 'card', uid: UID_A });
    expect(offersRegisteredKeys(useAppStore.getState().doc, UID_A)).toBe(false);
    st.openImage(mifareImage(UID_A, []), { type: 'card', uid: UID_A }, { standardKeysOnly: true });
    expect(offersRegisteredKeys(useAppStore.getState().doc, UID_A)).toBe(false);
  });
});

describe('TagOnReader readThis / keys, LastWriteCallout relation (E2E-UX-3, D9, R-WRITE-5)', () => {
  async function render(component: 'tag' | 'last', props: Record<string, unknown> = {}): Promise<string> {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { appStoreApi } = await import('../src/renderer/src/store/app');
    const { TagOnReader } = await import('../src/renderer/src/components/TagOnReader');
    const { LastWriteCallout } = await import('../src/renderer/src/components/LastWriteCallout');
    const saved = appStoreApi.getInitialState;
    appStoreApi.getInitialState = () => appStoreApi.getState();
    try {
      return renderToStaticMarkup(component === 'last' ? createElement(LastWriteCallout) : createElement(TagOnReader, props));
    } finally {
      appStoreApi.getInitialState = saved;
    }
  }

  it('readThis={false}: the note stays, the second "read this tag" button does not', async () => {
    useAppStore.setState({ reader: readerWith('ready', UID_B) });
    useAppStore.getState().openImage(ntagImage(UID_A), { type: 'card', uid: UID_A });
    expect(await render('tag', { compact: true })).toContain('このタグを読み取る');
    expect(await render('tag', { compact: true, readThis: false })).not.toContain('このタグを読み取る');
    const full = await render('tag', { readThis: false });
    expect(full).toContain('開いている文書とは別のタグが置かれています');
    expect(full).not.toContain('このタグを読み取る');
  });

  it('an auto-read MIFARE document with closed sectors offers "read with the registered keys"', async () => {
    useAppStore.setState({ reader: mifareReader(UID_A) });
    useAppStore.getState().openImage(mifareImage(), { type: 'card', uid: UID_A }, { standardKeysOnly: true });
    const html = await render('tag');
    expect(html).toContain('data-testid="tag-on-reader-keys"');
    expect(html).toContain('登録した鍵で読み取る');
    expect(await render('tag', { compact: true })).toContain('登録した鍵で読み取る');
  });

  const ok = (uid: string) => ({
    at: 0,
    tone: 'ok' as const,
    title: 'データ領域を複製しました',
    lines: ['1 ページを書き込みました'],
    uid,
    kind: 'NTAG213' as const,
    reactivate: false,
  });

  it('a result for another tag is folded as "previous write (another tag)"', async () => {
    useAppStore.getState().openImage(ntagImage(UID_A), { type: 'card', uid: UID_A });
    useAppStore.setState({ reader: readerWith('ready', UID_A), lastWrite: ok(UID_B) });
    const html = await render('last');
    expect(html).toContain('data-related="false"');
    expect(html).toContain('前回の書き込み（別のタグ UID 04:B0:B1:B2:B3:B4:B5）: データ領域を複製しました');
    useAppStore.setState({ reader: readerWith('ready', UID_B) });
    expect(await render('last')).not.toContain('data-related');
  });

  it('"write again" only for this document\'s / the placed tag, worded by whether it is placed', async () => {
    const failed = { ...ok(UID_A), tone: 'danger' as const, title: '書き込みの途中で止まりました', retry: true };
    useAppStore.getState().openImage(ntagImage(UID_A), { type: 'card', uid: UID_A });
    useAppStore.setState({ reader: readerWith('ready', UID_A), lastWrite: failed });
    expect(await render('last')).toContain('同じタグを置いたまま、もう一度書き込んでください。');
    useAppStore.setState({ reader: readerWith('absent') });
    expect(await render('last')).toContain('書き込み先のタグ（UID 04:A1:B2:C3:D4:E5:F6）をリーダーに置いて、もう一度書き込んでください。');
    useAppStore.getState().openImage(ntagImage(UID_B), { type: 'card', uid: UID_B });
    useAppStore.setState({ reader: readerWith('ready', UID_B), lastWrite: failed });
    expect(await render('last')).not.toContain('もう一度書き込んでください');
  });

  it('isStaleWriteResult: a success for another tag goes once a different tag is placed; failures stay', async () => {
    const { isStaleWriteResult } = await import('../src/renderer/src/lib/autoRead');
    expect(isStaleWriteResult(ok(UID_B), readerWith('ready', UID_A))).toBe(true);
    expect(isStaleWriteResult(ok(UID_B), readerWith('ready', UID_B))).toBe(false);
    expect(isStaleWriteResult(ok(UID_B), readerWith('absent'))).toBe(false);
    expect(isStaleWriteResult({ ...ok(UID_B), tone: 'danger' }, readerWith('ready', UID_A))).toBe(false);
  });
});

describe('R-ISSUE-9: why a run stopped with an error is kept', () => {
  const preview = { seq: 3, rowIndex: null, values: {} };
  const layout = 'データの配置が、タグの保護された領域（ロック・設定）に重なっています。データスキーマの開始位置を見直してください。発行を止めました。';

  it('a data / template error found before any tag: message kept, cause "data", told in the toast', () => {
    const u = fold([
      { type: 'started', job },
      { type: 'error', entry: entry({ uid: '', seq: null, result: 'error', message: layout }), message: layout, partial: false },
      { type: 'stopped', reason: 'error', issued: 0, job },
    ]).at(-1)!;
    expect(u.issueLastRun).toMatchObject({ reason: 'error', message: layout, cause: 'data' });
    expect(u.toast?.detail).toBe(`${layout}\n発行した枚数: 0 枚`);
  });

  it('waiting for a tag failed: cause "reader"; a reader ErrorCode: "reader"', () => {
    let u = fold([
      { type: 'started', job },
      { type: 'waiting', next: preview, issued: 0 },
      { type: 'error', entry: entry({ uid: '', result: 'error' }), message: 'リーダーの状態を確かめられなくなったため、発行を止めました。', partial: false },
      { type: 'stopped', reason: 'error', issued: 0, job },
    ]).at(-1)!;
    expect(u.issueLastRun?.cause).toBe('reader');
    u = fold([
      { type: 'started', job },
      { type: 'error', entry: null, message: 'NO_READER', partial: false },
      { type: 'stopped', reason: 'error', issued: 2, job },
    ]).at(-1)!;
    expect(u.issueLastRun).toMatchObject({ message: errorMessage('NO_READER', 'ja'), cause: 'reader' });
  });

  it('a tag error that stopped the run (error -> remove-card -> stopped): message kept, no reader guess', () => {
    const msg = '書き込む内容を作れませんでした。テンプレートの設定を確かめてください。発行を止めました。';
    const u = fold([
      { type: 'started', job },
      { type: 'reading', uid: UID_A, next: preview },
      { type: 'error', entry: entry({ result: 'error', message: msg }), message: msg, partial: false },
      { type: 'remove-card', uid: UID_A, outcome: 'error', entry: entry({ result: 'error', message: msg }), message: msg },
      { type: 'stopped', reason: 'error', issued: 0, job },
    ]).at(-1)!;
    expect(u.issueLastRun).toMatchObject({ message: msg, cause: 'other' });
  });

  it('other stops carry no message', () => {
    const u = fold([
      { type: 'started', job },
      { type: 'stopped', reason: 'user', issued: 1, job },
    ]).at(-1)!;
    expect(u.issueLastRun).toMatchObject({ message: null, cause: null });
    expect(u.toast?.detail).toBe('発行した枚数: 1 枚');
  });
});

describe('TagOnReader: an unreadable tag whose UID was read says which tag it is (R-MAIN-4)', () => {
  it('error state with a card (kind null) shows the UID', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { appStoreApi } = await import('../src/renderer/src/store/app');
    const { TagOnReader } = await import('../src/renderer/src/components/TagOnReader');
    const r = readerWith('ready', UID_A);
    useAppStore.setState({ reader: { ...r, cardState: 'error', cardError: 'ACCESS_DENIED', card: { ...r.card!, kind: null } } });
    const saved = appStoreApi.getInitialState;
    appStoreApi.getInitialState = () => appStoreApi.getState();
    try {
      const html = renderToStaticMarkup(createElement(TagOnReader));
      expect(html).toContain('読み取れません（UID 04:A1:B2:C3:D4:E5:F6）');
      expect(html).toContain(errorMessage('ACCESS_DENIED', 'ja'));
    } finally {
      appStoreApi.getInitialState = saved;
    }
  });
});
