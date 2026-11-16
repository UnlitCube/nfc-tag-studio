// The home screen says what an unsupported card is, from its ATR (2026-11-14, request
// "カードの Type の識別機能"). Rendered on the server (no Electron, no reader). UIDs are fictional;
// the My Number card ATR is the real one (public ATR list, and a real card on a PaSoRi).
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CardInfo, ReaderStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { useAppStore } from '../src/renderer/src/store/app';
import { HomeView } from '../src/renderer/src/views/home/HomeView';
import { translate } from '../src/renderer/src/i18n';

const PASORI = 'Sony FeliCa Port/PaSoRi 3.0 0';

function card(uid: string, atr: string, kind: CardInfo['kind'] = null): CardInfo {
  return { readerName: PASORI, uid, atr, kind, kindSource: kind ? 'cc' : null, version: null, rawCommands: false, driver: 'storage', detectedAt: 1 };
}

function reader(c: CardInfo, state: ReaderStatus['cardState']): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [{ name: PASORI, likelyContactless: true, cardPresent: true, inUse: false, atr: c.atr, virtual: false }],
    selectedReader: null,
    activeReader: PASORI,
    activeReason: 'auto-card',
    driverMode: 'auto',
    card: c,
    cardState: state,
    cardError: state === 'unsupported' ? 'UNSUPPORTED_TAG' : null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: false, kind: 'NTAG215', present: false, uid: '' },
  };
}

function render(): string {
  // zustand renders the INITIAL state on the server: copy the live state into it.
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  return renderToStaticMarkup(createElement(HomeView));
}

const ja = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate('ja', k, v);

beforeEach(() => {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, language: 'ja' },
    view: 'home',
    doc: null,
    pageDocs: { home: null, ndef: null, backup: null },
    busyOp: null,
    lastWrite: null,
    dialogs: [],
    issue: { running: false, job: null, issued: 0, last: null },
  });
});

describe('home: what kind of card it is (from the ATR)', () => {
  it('a My Number card: "IC cards are not supported", the card / standard / type / ATR, no manual kind', () => {
    useAppStore.setState({ reader: reader(card('C0A1B2C3', '3B888001000005E0B381A1007F'), 'unsupported') });
    const html = render();
    expect(html).toContain(ja('cardType.title.smartcard'));
    expect(html).toContain(ja('cardType.why.smartcard'));
    expect(html).toContain('マイナンバーカード（ATR から推定）');
    expect(html).toContain('ISO/IEC 14443 Type B（推定）');
    expect(html).toContain('IC カード（ISO/IEC 14443-4）');
    expect(html).toContain('3B 88 80 01 00 00 05 E0 B3 81 A1 00 7F');
    expect(html).not.toContain('data-testid="home-manual-kind"');
    expect(html).not.toContain(ja('home.unsupported.body'));
  });

  it('another FeliCa product: the FeliCa reason; a memory tag of another kind: the plain reason and the manual kind', () => {
    useAppStore.setState({ reader: reader(card('0114B3A1C2D3E4F5', '3B8F8001804F0CA0000003061100000000008A'), 'unsupported') });
    let html = render();
    expect(html).toContain(ja('cardType.why.felica'));
    expect(html).toContain('FeliCa（JIS X 6319-4）・NFC Forum Type 3');

    useAppStore.setState({ reader: reader(card('04112233445566', '3B8F8001804F0CA00000030603003A0000000000'), 'unsupported') });
    html = render();
    expect(html).toContain(ja('home.unsupported.title'));
    expect(html).toContain(ja('home.unsupported.body'));
    expect(html).toContain('MIFARE Ultralight C');
    expect(html).toContain('data-testid="home-manual-kind"');
  });

  it('the status bar names it too ("マイナンバーカード・未対応")', async () => {
    const { StatusBar } = await import('../src/renderer/src/components/shell/StatusBar');
    useAppStore.setState({ ready: true, initError: null, reader: reader(card('C0A1B2C3', '3B888001000005E0B381A1007F'), 'unsupported') });
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(html).toContain('マイナンバーカード・未対応');
  });

  it('a supported tag gets its standard under "tag detected"', () => {
    useAppStore.setState({ reader: reader(card('04112233445566', '3B8F8001804F0CA0000003060300030000000068', 'NTAG215'), 'ready') });
    const html = render();
    expect(html).toContain('data-testid="home-card-standard"');
    expect(html).toContain('規格: ISO/IEC 14443 Type A・NFC Forum Type 2');
  });
});
