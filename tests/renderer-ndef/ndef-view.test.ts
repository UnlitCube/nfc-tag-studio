// NDEF editor rendered on the server (no Electron, no reader). Owner:
// renderer-ndef-backup. 2026-11-12 second round (E2E-UX-3): the "tag to write"
// card has its own "read this tag" (it asks before replacing records being
// edited), so the shared tag line in that card must not add a second one
// (<TagOnReader readThis={false} />, contract of renderer-core).
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankImage } from '@shared/tag';
import type { TagKind } from '@shared/tags';
import type { CardInfo, ReaderStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { useAppStore } from '../../src/renderer/src/store/app';
import { NdefView } from '../../src/renderer/src/views/ndef/NdefView';
import { translate } from '../../src/renderer/src/i18n';

const UID_A = '049AFB5CBD1E7F';
const UID_B = '04C32485E647A8';

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

function render(): string {
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  return renderToStaticMarkup(createElement(NdefView));
}

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

describe('NdefView: one "read this tag" in the "tag to write" card (E2E-UX-3)', () => {
  it('another tag than the open document on the reader: the shared tag line adds no second read button', () => {
    useAppStore.getState().openImage(blankImage('NTAG215', UID_A), { type: 'card', uid: UID_A });
    useAppStore.setState({ reader: reader(card(UID_B, 'NTAG215')) });
    const html = render();
    // D14 (2026-11-13): the records' origin is set by an effect (not run on the
    // server), so this is the entry: no editing controls before the records come
    // from somewhere, and the entry's tag line adds no second read button either.
    expect(html).toContain('data-testid="ndef-entry"');
    expect(html).not.toContain('data-testid="ndef-write"');
    expect(html).not.toContain('ndef-record');
    expect(html).toContain('data-testid="ndef-read-tag"');
    expect(html).not.toContain(`>${translate('ja', 'reader.readThis')}<`);
  });
});
