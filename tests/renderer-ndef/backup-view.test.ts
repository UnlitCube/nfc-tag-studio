// Backup / MIFARE keys screens rendered on the server (no Electron, no reader).
// Owner: renderer-ndef-backup. 2026-11-12 second round: R-WRITE-3 (open a file
// only when no single-tag operation runs), D9 / R-UX-4 (automatic reading tries
// only the standard keys - said on the keys screen and next to unread MIFARE
// sectors), R-UX-3 (key B note), E2E-UX-4 (no "busy" reason behind a confirmation).
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankImage } from '@shared/tag';
import type { TagKind } from '@shared/tags';
import type { CardInfo, ReaderStatus, TagImage } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { useAppStore } from '../../src/renderer/src/store/app';
import type { DialogEntry } from '../../src/renderer/src/store/app';
import { BackupView } from '../../src/renderer/src/views/backup/BackupView';
import { KeysView } from '../../src/renderer/src/views/keys/KeysView';
import { translate } from '../../src/renderer/src/i18n';

const UID_NTAG = '049AFB5CBD1E7F';
const UID_MF = 'A1B2C3D4';

function card(uid: string, kind: TagKind): CardInfo {
  return { readerName: 'Virtual', uid, atr: '', kind, kindSource: 'simulator', version: null, rawCommands: true, driver: 'acr122', detectedAt: 1 };
}

function reader(c: CardInfo | null): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [{ name: 'Virtual', likelyContactless: true, cardPresent: !!c, inUse: false, atr: null, virtual: true }],
    selectedReader: null,
    activeReader: 'Virtual',
    activeReason: 'auto-virtual',
    driverMode: 'auto',
    card: c,
    cardState: c ? 'ready' : 'absent',
    cardError: null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: true, kind: c?.kind ?? 'NTAG215', present: !!c, uid: c?.uid ?? '' },
  };
}

function render(view: FunctionComponent): string {
  // zustand renders the INITIAL state on the server: copy the live state into it.
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  return renderToStaticMarkup(createElement(view));
}

function openCardDoc(img: TagImage) {
  useAppStore.getState().openImage(img, { type: 'card', uid: img.uid });
}

/** Every <button ...> tag with the given data-testid. */
function buttons(html: string, testId: string): string[] {
  return [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(`data-testid="${testId}"`));
}

const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

const dialog = (): DialogEntry => ({ id: 1, title: 'x', message: 'y', resolve: () => {} });

beforeEach(() => {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, language: 'ja' },
    doc: null,
    reader: reader(null),
    busyOp: null,
    lastWrite: null,
    dialogs: [],
    issue: { running: false, job: null, issued: 0, last: null },
  });
});

describe('R-WRITE-3: "Open file" waits for a read / write started on another screen', () => {
  it('no document: disabled while store.busyOp is set or batch issue runs; enabled when idle', () => {
    expect(buttons(render(BackupView), 'backup-open').map(isDisabled)).toEqual([false]);
    useAppStore.setState({ busyOp: 'write' });
    expect(buttons(render(BackupView), 'backup-open').map(isDisabled)).toEqual([true]);
    useAppStore.setState({ busyOp: null, issue: { running: true, job: null, issued: 0, last: null } });
    expect(buttons(render(BackupView), 'backup-open').map(isDisabled)).toEqual([true]);
  });

  it('a document open (the binary editor is writing it): disabled', () => {
    openCardDoc(blankImage('NTAG215', UID_NTAG));
    useAppStore.setState({ reader: reader(card(UID_NTAG, 'NTAG215')) });
    expect(buttons(render(BackupView), 'backup-open').map(isDisabled)).toEqual([false]);
    useAppStore.setState({ busyOp: 'write' });
    expect(buttons(render(BackupView), 'backup-open').map(isDisabled)).toEqual([true]);
    useAppStore.setState({ busyOp: 'read' });
    expect(buttons(render(BackupView), 'backup-open').map(isDisabled)).toEqual([true]);
  });
});

describe('E2E-UX-4: the "busy" reason is not shown behind an open confirmation', () => {
  it('busy + a dialog open: buttons stay disabled, the reason line is empty; without the dialog it says busy', () => {
    openCardDoc(blankImage('NTAG215', UID_NTAG));
    useAppStore.setState({ reader: reader(card(UID_NTAG, 'NTAG215')), busyOp: 'write' });
    const busyText = translate('ja', 'op.block.busy');
    expect(render(BackupView)).toContain(busyText);
    useAppStore.setState({ dialogs: [dialog()] });
    const html = render(BackupView);
    expect(html).not.toContain(busyText);
    expect(buttons(html, 'backup-read-target').map(isDisabled)).toEqual([true]);
    expect(buttons(html, 'backup-open').map(isDisabled)).toEqual([true]);
  });
});

describe('D9 / R-UX-4: automatic reading tries only the standard keys (said where it matters)', () => {
  it('MIFARE sectors left unread by the automatic read point at "Read tag" (the registered keys); NTAG keeps the plain text', () => {
    const mf = blankImage('MIFARE_CLASSIC_1K', UID_MF);
    for (const b of [8, 9, 10, 11]) mf.unitStatus[b] = 'denied';
    useAppStore.getState().openImage(mf, { type: 'card', uid: mf.uid }, { standardKeysOnly: true });
    useAppStore.setState({ reader: reader(card(UID_MF, 'MIFARE_CLASSIC_1K')) });
    let html = render(BackupView);
    expect(html).toContain('標準の鍵だけを試しました');
    expect(html).toContain('「タグを読み取る」を押すと読めます');
    // R-UX-3: what happens to key B in a saved file is said for MIFARE only.
    expect(html).toContain(translate('ja', 'backup.save.keyBNote'));

    // Read by hand (every registered key tried): no hint about the automatic read.
    openCardDoc(mf);
    html = render(BackupView);
    expect(html).not.toContain('標準の鍵だけを試しました');
    expect(html).toContain('パスワードまたは鍵が必要です');

    const nt = blankImage('NTAG215', UID_NTAG);
    nt.unitStatus[20] = 'denied';
    openCardDoc(nt);
    useAppStore.setState({ reader: reader(card(UID_NTAG, 'NTAG215')) });
    html = render(BackupView);
    expect(html).not.toContain('標準の鍵だけを試します');
    expect(html).toContain('パスワードまたは鍵が必要です');
    expect(html).not.toContain(translate('ja', 'backup.save.keyBNote'));
  });

  it('the keys screen says it (ja and en)', () => {
    expect(render(KeysView)).toContain('自動読み取りでは、公開されている標準鍵だけを試します');
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, language: 'en' } });
    expect(render(KeysView)).toContain('Automatic reading (when a tag is placed) tries only the public standard keys');
  });

  it('the save card no longer claims "keys are never saved" without saying how (R-UX-3)', () => {
    openCardDoc(blankImage('NTAG215', UID_NTAG));
    const html = render(BackupView);
    expect(html).toContain('00 にして保存します');
  });
});
