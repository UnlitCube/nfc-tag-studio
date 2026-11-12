// Shell / home view models (owner: shell-ui, SHELL-HOME). 2026-11-12 UX audit:
// the status bar and home must describe the ACTIVE reader (never readers[0]),
// must not show "service stopped" just because no reader is plugged in, must keep
// "tag on the reader" and "open document" apart, and global shortcuts must not
// double-handle keys a view already handled.
import { describe, it, expect } from 'vitest';
import type { CardInfo, ReaderInfo, ReaderStatus, TagImage } from '../src/shared/types';
import type { TagKind } from '../src/shared/tags';
import { imageSize, specFor } from '../src/shared/tags';
import type { TagDoc } from '../src/renderer/src/store/app';
import {
  cardFamily,
  deniedHelp,
  docOnReader,
  docSummary,
  errorFollowUp,
  passwordAuthSupport,
  readerProblem,
  statusReader,
  statusReaderTone,
  tagGuide,
  unreadableCounts,
  ndefRecordCount,
} from '../src/renderer/src/components/shell/readerModel';
import { shortcutAction } from '../src/renderer/src/components/shell/useShortcuts';
import { nextResolveTrip, nextReturnView } from '../src/renderer/src/components/shell/navHistory';
import type { ResolveTrip } from '../src/renderer/src/components/shell/navHistory';
import { helpContent, resolveHelpTopic, HELP_TOPICS } from '../src/renderer/src/views/help/helpContent';
import { isNotNfcDevice, needsNotNfcConfirm, readerOptions } from '../src/renderer/src/views/settings/readerOptions';
import { translate } from '../src/renderer/src/i18n';
import type { MsgKey } from '../src/renderer/src/i18n';

// ---------------------------------------------------------------------------
// fixtures (fictional names / UIDs)
// ---------------------------------------------------------------------------

const TOKEN: ReaderInfo = { name: 'FS USB Token 0', likelyContactless: false, cardPresent: false, inUse: false, atr: null, virtual: false };
const PASORI: ReaderInfo = { name: 'Sony FeliCa Port/PaSoRi 3.0 0', likelyContactless: true, cardPresent: false, inUse: false, atr: null, virtual: false };
const VIRTUAL: ReaderInfo = { name: 'NFC Tag Studio Virtual NFC Reader', likelyContactless: true, cardPresent: true, inUse: false, atr: null, virtual: true };

function status(p: Partial<ReaderStatus> = {}): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [],
    selectedReader: null,
    activeReader: null,
    activeReason: 'none',
    driverMode: 'auto',
    card: null,
    cardState: 'no-reader',
    cardError: null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: false, kind: 'NTAG215', present: false, uid: '04AABBCCDDEEFF' },
    ...p,
  };
}

function card(uid: string, kind: TagKind | null = 'NTAG215', readerName = PASORI.name, atr = ''): CardInfo {
  return { readerName, uid, atr, kind, kindSource: kind ? 'cc' : null, version: null, rawCommands: false, driver: 'storage', detectedAt: 1 };
}

function image(kind: TagKind, uid: string): TagImage {
  const spec = specFor(kind);
  return { kind, uid, data: new Uint8Array(imageSize(kind)), unitStatus: Array.from({ length: spec.unitCount }, () => 'ok' as const), readAt: 1 };
}

function doc(img: TagImage, source: TagDoc['source']): TagDoc {
  return { image: { ...img, data: new Uint8Array(img.data) }, original: { ...img, data: new Uint8Array(img.data), unitStatus: [...img.unitStatus] }, source, revision: 1 };
}

const ja = (key: MsgKey, vars?: Record<string, string | number>) => translate('ja', key, vars);

// PaSoRi in use while a USB token is listed FIRST (the dev PC's real order).
const pasoriActive = (p: Partial<ReaderStatus> = {}) =>
  status({ readers: [TOKEN, PASORI], activeReader: PASORI.name, activeReason: 'auto-first', cardState: 'absent', ...p });

// ---------------------------------------------------------------------------

describe('readerProblem / statusReader (CARD-7, CARD-8, CARD-14, FIRST-5, FIRST-20)', () => {
  it('uses the active reader, not readers[0] (a USB token listed first is not reported)', () => {
    const s = pasoriActive();
    expect(readerProblem(s)).toBeNull();
    const r = statusReader(s, { ready: true, initError: null });
    expect(r).toEqual({ kind: 'reader', name: PASORI.name, fixed: false, inUse: false });
    expect(statusReaderTone(r)).toBe('ok');
  });

  it('no reader plugged in + service "unavailable" = "connect a reader", not a red service error', () => {
    const s = status({ service: 'unavailable', readers: [] });
    expect(readerProblem(s)).toEqual({ kind: 'connect' });
    const r = statusReader(s, { ready: true, initError: null });
    expect(statusReaderTone(r)).toBe('warn');
    expect(statusReaderTone(r)).not.toBe('danger');
  });

  it('before the first status / on init failure: neutral "starting" / "failed to start", never "service stopped"', () => {
    expect(statusReader(null, { ready: false, initError: null })).toEqual({ kind: 'starting' });
    expect(statusReader(null, { ready: true, initError: 'preload missing' })).toEqual({ kind: 'init-failed' });
    expect(statusReaderTone({ kind: 'starting' })).toBe('neutral');
    expect(statusReaderTone({ kind: 'init-failed' })).toBe('neutral');
  });

  it('only non-NFC devices -> tokens-only (lists them), not "place a tag"', () => {
    const s = status({ readers: [TOKEN], cardState: 'no-reader' });
    expect(readerProblem(s)).toEqual({ kind: 'tokens-only', names: [TOKEN.name] });
  });

  it('selected reader missing -> selected-missing with its name (D1: no silent switch)', () => {
    const s = status({ readers: [PASORI], selectedReader: 'ACS ACR122 0', activeReason: 'selected-missing', cardState: 'no-reader' });
    expect(readerProblem(s)).toEqual({ kind: 'selected-missing', name: 'ACS ACR122 0' });
  });

  it('a real service error is danger', () => {
    const s = status({ service: 'error', serviceMessage: 'x' });
    expect(readerProblem(s)).toEqual({ kind: 'service-error', message: 'x' });
    expect(statusReaderTone(statusReader(s, { ready: true, initError: null }))).toBe('danger');
  });

  it('virtual reader active and "in use by another app" are reported', () => {
    const v = status({ readers: [PASORI, VIRTUAL], activeReader: VIRTUAL.name, activeReason: 'auto-virtual', cardState: 'ready' });
    expect(statusReader(v, { ready: true, initError: null })).toEqual({ kind: 'virtual', inUse: false });
    const busy = pasoriActive({ readers: [TOKEN, { ...PASORI, inUse: true }] });
    const r = statusReader(busy, { ready: true, initError: null });
    expect(r).toMatchObject({ kind: 'reader', inUse: true });
    expect(statusReaderTone(r)).toBe('warn');
  });
});

describe('tagGuide (FIRST-1..4, CARD-3, CARD-9, CARD-12, FLOW-10)', () => {
  const ops = { issueRunning: false, busyOp: null };

  it('one state per cardState, never "place a tag" while a tag is present but unidentified', () => {
    expect(tagGuide(pasoriActive({ cardState: 'absent' }), null, ops).kind).toBe('place');
    expect(tagGuide(pasoriActive({ cardState: 'detecting' }), null, ops)).toEqual({ kind: 'detecting', retrying: false });
    // an attempt already failed: the home screen asks to hold the tag still in the middle
    expect(tagGuide(pasoriActive({ cardState: 'detecting', cardRetrying: true }), null, ops)).toEqual({ kind: 'detecting', retrying: true });
    expect(tagGuide(pasoriActive({ cardState: 'error', cardError: 'READER_IN_USE' }), null, ops)).toEqual({ kind: 'error', error: 'READER_IN_USE' });
    expect(tagGuide(pasoriActive({ cardState: 'error' }), null, ops)).toEqual({ kind: 'error', error: 'CARD_UNRESPONSIVE' });
    const unsup = tagGuide(pasoriActive({ cardState: 'unsupported', card: card('04A1', null), cardError: 'UNSUPPORTED_TAG' }), null, ops);
    expect(unsup.kind).toBe('unsupported');
  });

  it('ready + no document -> ready-new; same UID -> ready-same; other UID / file -> ready-other', () => {
    const s = pasoriActive({ cardState: 'ready', card: card('04B2C3D4E5F601') });
    expect(tagGuide(s, null, ops).kind).toBe('ready-new');
    const same = doc(image('NTAG215', '04B2C3D4E5F601'), { type: 'card', uid: '04b2c3d4e5f601' });
    expect(tagGuide(s, same, ops).kind).toBe('ready-same');
    const other = doc(image('NTAG215', '04999999999999'), { type: 'card', uid: '04999999999999' });
    expect(tagGuide(s, other, ops)).toMatchObject({ kind: 'ready-other', docSource: 'card', docUid: '04999999999999', dirty: false });
    const file = doc(image('NTAG215', '04B2C3D4E5F601'), { type: 'file', name: 'a.nfcdump', token: null, format: 'project' });
    expect(tagGuide(s, file, ops)).toMatchObject({ kind: 'ready-other', docSource: 'file' });
    file.image.data[16] = 0x42;
    expect(tagGuide(s, file, ops)).toMatchObject({ dirty: true });
  });

  it('reading / writing / batch issue win over the card state', () => {
    const s = pasoriActive({ cardState: 'ready', card: card('04B2C3D4E5F601') });
    expect(tagGuide(s, null, { issueRunning: false, busyOp: 'read' }).kind).toBe('reading');
    expect(tagGuide(s, null, { issueRunning: false, busyOp: null, localReading: true }).kind).toBe('reading');
    expect(tagGuide({ ...s, busy: { op: 'write', startedAt: 1 } }, null, ops).kind).toBe('writing');
    expect(tagGuide(s, null, { issueRunning: true, busyOp: null }).kind).toBe('issuing');
    // identify is not "busy": the detecting state already says it
    expect(tagGuide({ ...s, cardState: 'detecting', busy: { op: 'identify', startedAt: 1 } }, null, ops).kind).toBe('detecting');
  });

  it('no reader -> the problem; virtual reader on without a tag -> "place the virtual tag"', () => {
    expect(tagGuide(status({ readers: [] }), null, ops)).toEqual({ kind: 'no-reader', problem: { kind: 'connect' } });
    const sim = status({ readers: [], simulator: { enabled: true, kind: 'NTAG213', present: false, uid: '04' } });
    expect(tagGuide(sim, null, ops)).toEqual({ kind: 'place', virtual: true });
  });

  it('cardFamily reads the PC/SC storage ATR (FeliCa / Type 2)', () => {
    expect(cardFamily(card('01', null, PASORI.name, '3B8F8001804F0CA0000003061100000000008A'))).toBe('felica');
    expect(cardFamily(card('04', null, PASORI.name, '3B8F8001804F0CA0000003060300030000000068'))).toBe('type2');
    expect(cardFamily(card('04', null, PASORI.name, ''))).toBeNull();
  });
});

describe('docSummary / docOnReader (FIRST-3, FIRST-22, WALK-18)', () => {
  it('splits "needs key/password" from "could not be read"', () => {
    const img = image('NTAG213', '04112233445566');
    img.unitStatus[10] = 'denied';
    img.unitStatus[11] = 'denied';
    img.unitStatus[12] = 'unread';
    img.unitStatus[13] = 'error';
    expect(unreadableCounts(img)).toEqual({ denied: 2, unread: 2 });
  });

  it('FeliCa: IDm label, no NDEF; NTAG: UID label + NDEF from the ORIGINAL (not the unsaved edits)', () => {
    const f = docSummary(doc(image('FELICA_LITE_S', '012E4C0011223344'), { type: 'card', uid: '012E4C0011223344' }), null);
    expect(f.idLabel).toBe('idm');
    expect(f.ndefApplicable).toBe(false);
    expect(f.ndefRecords).toBeNull();
    const n = doc(image('NTAG215', '04112233445566'), { type: 'card', uid: '04112233445566' });
    n.image.data[20] = 0x99; // unsaved edit
    const sn = docSummary(n, null);
    expect(sn.idLabel).toBe('uid');
    expect(sn.ndefApplicable).toBe(true);
    expect(sn.ndefRecords).toBe(0);
    expect(sn.dirty).toBe(1);
    expect(sn.unit).toBe('page');
  });

  it('NDEF count reads like the NDEF editor: an erased message (empty record only) is 0, unreadable is unknown', () => {
    const withCc = () => {
      const img = image('NTAG215', '04112233445566');
      img.data.set([0xe1, 0x10, 0x3e, 0x00], 12); // CC
      return img;
    };
    const blank = withCc();
    const erased = withCc();
    erased.data.set([0x03, 0x03, 0xd0, 0x00, 0x00, 0xfe], 16); // what "NDEF を消去" writes
    const text = withCc(); // one well-known text record "hi" (lang "en")
    text.data.set([0x03, 0x09, 0xd1, 0x01, 0x05, 0x54, 0x02, 0x65, 0x6e, 0x68, 0x69, 0xfe], 16);
    const locked = withCc();
    locked.data.set(text.data);
    locked.unitStatus[4] = 'denied';
    expect(ndefRecordCount(blank)).toBe(0);
    expect(ndefRecordCount(erased)).toBe(0);
    expect(ndefRecordCount(text)).toBe(1);
    expect(ndefRecordCount(locked)).toBeNull();
    expect(ndefRecordCount(image('FELICA_LITE_S', '012E4C0011223344'))).toBeNull();
  });

  it('where the document\'s tag is: on the reader / another tag / not on the reader / n.a. for files', () => {
    const d = doc(image('NTAG215', '04112233445566'), { type: 'card', uid: '04112233445566' });
    expect(docOnReader(d, pasoriActive({ cardState: 'ready', card: card('04112233445566') }))).toBe('on-reader');
    expect(docOnReader(d, pasoriActive({ cardState: 'ready', card: card('04FFFFFFFFFFFF') }))).toBe('other-tag');
    expect(docOnReader(d, pasoriActive({ cardState: 'absent' }))).toBe('not-on-reader');
    const f = doc(image('NTAG215', '04112233445566'), { type: 'new' });
    expect(docOnReader(f, pasoriActive())).toBe('not-applicable');
  });
});

describe('shortcuts (WRITE-19, FIRST-8)', () => {
  const base = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, defaultPrevented: false, typing: false, hasDoc: true, view: 'hex' as const };

  it('a key the view already handled (defaultPrevented) is ignored: one Ctrl+Z = one undo', () => {
    expect(shortcutAction(base)).toBe('undo');
    expect(shortcutAction({ ...base, defaultPrevented: true })).toBeNull();
  });

  it('redo, typing, busy, no document, F1', () => {
    expect(shortcutAction({ ...base, shiftKey: true })).toBe('redo');
    expect(shortcutAction({ ...base, key: 'y' })).toBe('redo');
    expect(shortcutAction({ ...base, typing: true })).toBeNull();
    expect(shortcutAction({ ...base, busy: true })).toBeNull();
    expect(shortcutAction({ ...base, hasDoc: false })).toBeNull();
    expect(shortcutAction({ ...base, key: 'F1', ctrlKey: false })).toBe('help');
  });

  it('R-WRITE-6: Ctrl+Z / Ctrl+Y only undo / redo the document while the binary editor is on screen', () => {
    // Before the fix every screen returned 'undo': a Ctrl+Z on NDEF / backup silently undid a hidden binary edit.
    for (const view of ['ndef', 'backup', 'home', 'log', 'settings', 'issue', 'keys', 'schema', 'help'] as const) {
      expect(shortcutAction({ ...base, view }), view).toBeNull();
      expect(shortcutAction({ ...base, view, key: 'y' }), view).toBeNull();
      expect(shortcutAction({ ...base, view, shiftKey: true }), view).toBeNull();
      // F1 stays global
      expect(shortcutAction({ ...base, view, key: 'F1', ctrlKey: false }), view).toBe('help');
    }
    expect(shortcutAction({ ...base, view: 'hex' })).toBe('undo');
    expect(shortcutAction({ ...base, view: 'hex', key: 'y' })).toBe('redo');
  });

  it('help returns to the last non-help screen', () => {
    expect(nextReturnView('home', 'hex')).toBe('hex');
    expect(nextReturnView('hex', 'help')).toBe('hex');
    expect(nextReturnView('hex', 'settings')).toBe('settings');
  });

  it('R-UX-9: a resolve trip lasts on its target (and through help), and ends when the operator moves on', () => {
    const trip: ResolveTrip = { target: 'keys', returnTo: 'home', reread: true, reason: 'mifare-keys' };
    expect(nextResolveTrip(trip, 'keys')).toBe(trip);
    expect(nextResolveTrip(trip, 'help')).toBe(trip); // a side visit to help keeps "back to Read"
    expect(nextResolveTrip(trip, 'home')).toBeNull(); // went back
    expect(nextResolveTrip(trip, 'ndef')).toBeNull(); // went elsewhere: no stale "back" later
    expect(nextResolveTrip(null, 'keys')).toBeNull();
  });

  it('every screen\'s helpTopic resolves to a help section', () => {
    for (const id of ['read', 'hex', 'ndef', 'backup', 'schema', 'log', 'keys', 'reader', 'start']) {
      expect(resolveHelpTopic(id), id).not.toBeNull();
    }
    expect(resolveHelpTopic('keys')).toBe('mifare');
    expect(resolveHelpTopic('nope')).toBeNull();
    for (const id of HELP_TOPICS) expect(ja(`help.topic.${id}` as MsgKey)).not.toBe(`help.topic.${id}`);
  });
});

describe('settings reader options (CARD-14)', () => {
  it('a selected but disconnected reader stays visible as "(not connected) name"', () => {
    const opts = readerOptions(ja, status({ readers: [TOKEN, PASORI] }), 'ACS ACR122 0');
    expect(opts.map((o) => o.value)).toEqual(['', PASORI.name, TOKEN.name, 'ACS ACR122 0']);
    expect(opts[3].label).toBe(ja('settings.reader.missingOption', { name: 'ACS ACR122 0' }));
    expect(opts[2].label).toBe(ja('settings.reader.notNfcOption', { name: TOKEN.name }));
  });

  it('a connected selection is not duplicated; the virtual reader is not offered', () => {
    const opts = readerOptions(ja, status({ readers: [PASORI, VIRTUAL] }), PASORI.name);
    expect(opts.map((o) => o.value)).toEqual(['', PASORI.name]);
  });

  it('D10 / R-UX-7: a device not detected as an NFC reader stays selectable, labelled as such, and choosing it asks first', () => {
    const s = status({ readers: [TOKEN, PASORI, VIRTUAL] });
    const opt = readerOptions(ja, s, null).find((o) => o.value === TOKEN.name)!;
    expect(opt.label).toBe(`${TOKEN.name}（NFC リーダーと判定できません）`);
    expect(translate('en', 'settings.reader.notNfcOption', { name: 'X' })).toBe('X (not detected as an NFC reader)');
    expect(needsNotNfcConfirm(s, TOKEN.name, null)).toBe(true);
    expect(needsNotNfcConfirm(s, TOKEN.name, TOKEN.name)).toBe(false); // already selected: no second ask
    expect(needsNotNfcConfirm(s, PASORI.name, null)).toBe(false);
    expect(needsNotNfcConfirm(s, VIRTUAL.name, null)).toBe(false);
    expect(needsNotNfcConfirm(s, null, TOKEN.name)).toBe(false); // back to automatic
    expect(needsNotNfcConfirm(s, 'ACS ACR122 0', null)).toBe(false); // not connected: nothing to warn about
    expect(isNotNfcDevice(s, TOKEN.name)).toBe(true);
    expect(isNotNfcDevice(s, PASORI.name)).toBe(false);
    expect(isNotNfcDevice(null, TOKEN.name)).toBe(false);
  });

  it('D10: help and the settings hint no longer say a non-NFC device is "never used" - automatic selection does not use it, Settings can', () => {
    const readerHelp = helpContent('ja').reader.flatMap((b) => [...(b.body ?? []), ...(b.list ?? [])]).join('\n');
    expect(readerHelp).toContain('自動選択では使いません');
    expect(readerHelp).toContain('判定されないときだけ');
    expect(readerHelp).not.toContain('使いません（自動選択でも選びません）');
    expect(ja('settings.reader.autoHint')).toContain('判定されないときだけ');
    expect(ja('home.tokensOnly.body')).toContain('自動選択では使いません');
  });
});

describe('R-UX-1 / D11: password pages depend on the reader', () => {
  it('passwordAuthSupport: raw commands = yes, storage = no, no tag = unknown (unless the transport is forced to storage)', () => {
    expect(passwordAuthSupport(pasoriActive({ cardState: 'ready', card: card('04B2C3D4E5F601') }))).toBe('no');
    expect(passwordAuthSupport(pasoriActive({ cardState: 'ready', card: { ...card('04B2C3D4E5F601'), rawCommands: true, driver: 'acr122' } }))).toBe('yes');
    expect(passwordAuthSupport(pasoriActive({ cardState: 'absent' }))).toBe('unknown');
    expect(passwordAuthSupport(pasoriActive({ cardState: 'absent', driverMode: 'storage' }))).toBe('no');
    expect(passwordAuthSupport(null)).toBe('unknown');
  });

  it('home says a storage-only reader cannot read password pages, instead of promising "enter the password"', () => {
    const s = pasoriActive({ cardState: 'ready', card: card('04B2C3D4E5F601') });
    expect(deniedHelp('NTAG213', s, true)).toEqual({ kind: 'ntag', auth: 'no' });
    expect(ja('home.doc.deniedHint.ntagStorage')).toContain('パスワードが分かっていても読めません');
    expect(ja('home.doc.deniedHint.ntagUnknown')).toContain('ストレージ方式');
    expect(deniedHelp('FELICA_LITE_S', s, true)).toEqual({ kind: 'other' });
  });

  it('a protected tag that cannot be identified is not told to "re-place it" (R-MAIN-4 makes it ACCESS_DENIED)', () => {
    expect(errorFollowUp('ACCESS_DENIED')).toBe('protected');
    expect(errorFollowUp('READER_NO_AUTH')).toBe('none');
    expect(errorFollowUp('CARD_UNRESPONSIVE')).toBe('retry');
    expect(errorFollowUp('READER_IN_USE')).toBe('retry');
  });
});

describe('R-UX-4 / D9: MIFARE sectors the automatic read could not open', () => {
  it('home offers "read with registered keys" and says the automatic read tries only the standard keys', () => {
    expect(deniedHelp('MIFARE_CLASSIC_1K', null, true)).toEqual({ kind: 'mifare', autoRead: true });
    expect(deniedHelp('MIFARE_CLASSIC_4K', null, false)).toEqual({ kind: 'mifare', autoRead: false });
    expect(ja('home.doc.deniedHint.mifare')).toContain('標準の鍵だけ');
    expect(ja('home.doc.deniedAction.readWithKeys')).toBe('登録した鍵で読み取る');
    const mifareHelp = helpContent('ja').mifare.flatMap((b) => b.list ?? []).join('\n');
    expect(mifareHelp).toContain('自動読み取り');
    expect(mifareHelp).toContain('標準の鍵だけ');
  });
});

describe('R-UX-9: the resolve trip renders "back to Read" on its target screen only (server-side render)', () => {
  async function render(view: 'keys' | 'hex' | 'settings'): Promise<string> {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { appStoreApi } = await import('../src/renderer/src/store/app');
    const { ResolveReturn } = await import('../src/renderer/src/components/shell/ResolveReturn');
    const saved = appStoreApi.getInitialState;
    appStoreApi.getInitialState = () => appStoreApi.getState();
    try {
      return renderToStaticMarkup(createElement(ResolveReturn, { view }));
    } finally {
      appStoreApi.getInitialState = saved;
    }
  }

  it('home -> keys: "back" and "back and read again" on the keys screen, nothing elsewhere; the trip ends when it is used', async () => {
    const { useAppStore } = await import('../src/renderer/src/store/app');
    const nav = await import('../src/renderer/src/components/shell/navHistory');
    const stop = nav.startNavHistory();
    try {
      useAppStore.setState({ view: 'home', reader: pasoriActive({ cardState: 'ready', card: card('04B2C3D4E5F601') }) });
      expect(await render('keys')).toBe(''); // no trip: nothing
      nav.goResolve('keys', { returnTo: 'home', reason: 'mifare-keys', reread: true });
      expect(useAppStore.getState().view).toBe('keys');
      const html = await render('keys');
      expect(html).toContain('data-testid="resolve-return"');
      expect(html).toContain(ja('shell.return.back', { name: ja('shell.nav.home') }));
      expect(html).toContain(ja('shell.return.backAndRead', { name: ja('shell.nav.home') }));
      expect(await render('hex')).toBe(''); // only on the target
      useAppStore.getState().setView('help'); // a side visit keeps it
      useAppStore.getState().setView('keys');
      expect(await render('keys')).toContain('data-testid="resolve-return"');
      useAppStore.getState().setView('home'); // went back: the trip is over
      useAppStore.getState().setView('keys');
      expect(await render('keys')).toBe('');
    } finally {
      nav.endResolveTrip();
      stop();
      useAppStore.setState({ view: 'home', reader: null });
    }
  });

  it('home -> binary editor (password): "back" only, no "read again" (the password read happens there)', async () => {
    const { useAppStore } = await import('../src/renderer/src/store/app');
    const nav = await import('../src/renderer/src/components/shell/navHistory');
    const stop = nav.startNavHistory();
    try {
      nav.goResolve('hex', { returnTo: 'home', reason: 'ntag-password' });
      const html = await render('hex');
      expect(html).toContain('data-reason="ntag-password"');
      expect(html).not.toContain('data-testid="resolve-back-read"');
    } finally {
      nav.endResolveTrip();
      stop();
      useAppStore.setState({ view: 'home' });
    }
  });
});

describe('R-UX-11: texts name only what exists', () => {
  it('advanced mode does not promise an APDU console (there is none)', () => {
    expect(ja('settings.advanced.hint')).not.toMatch(/APDU/);
    expect(translate('en', 'settings.advanced.hint')).not.toMatch(/APDU/);
  });
});

describe('passwordAuthSupport with no tag uses activeDriver (D11)', () => {
  it('storage = no, raw transport = yes, before any tag is placed', () => {
    expect(passwordAuthSupport(pasoriActive({ cardState: 'absent', activeDriver: 'storage' }))).toBe('no');
    expect(passwordAuthSupport(pasoriActive({ cardState: 'absent', activeDriver: 'acr122' }))).toBe('yes');
  });
});
