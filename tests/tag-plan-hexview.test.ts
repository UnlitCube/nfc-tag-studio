// Server-side render smoke of the binary editor (owner: renderer-hex). No DOM, no
// Electron, no reader: the store is filled with a document + a reader status and
// the view is rendered to HTML, so a render-time crash or a missing reason text
// is caught without launching the app. 2026-11-12 UX audit WRITE-1/17, WALK-2/18.
import { describe, expect, it, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankImage } from '@shared/tag';
import type { TagKind } from '@shared/tags';
import type { CardInfo, ReaderStatus, TagImage } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { useAppStore } from '../src/renderer/src/store/app';
import { HexView } from '../src/renderer/src/views/hex/HexView';

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
  // zustand renders the INITIAL state on the server (getServerSnapshot =
  // getInitialState): copy the live state into it so SSR shows what we set.
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  return renderToStaticMarkup(createElement(HexView));
}

function openCardDoc(img: TagImage) {
  useAppStore.getState().openImage(img, { type: 'card', uid: img.uid });
}

beforeEach(() => {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, language: 'ja' }, doc: null, reader: null, busyOp: null, lastWrite: null });
});

describe('HexView render', () => {
  it('entry: read is disabled with the reason when no tag is on the reader', () => {
    useAppStore.setState({ reader: reader(null) });
    const html = render();
    expect(html).toContain('data-testid="hex-read-reason"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="hex-read"|<button[^>]*data-testid="hex-read"[^>]*disabled/);
    expect(html).toContain('一瞬タッチするだけでは読めません');
  });

  it('same tag, no changes: the write button is disabled and says why', () => {
    openCardDoc(blankImage('NTAG215', UID_A));
    useAppStore.setState({ reader: reader(card(UID_A, 'NTAG215')) });
    const html = render();
    expect(html).toMatch(/data-testid="hex-write"[^>]*disabled|disabled[^>]*data-testid="hex-write"/);
    expect(html).toContain('未書き込みの変更はありません');
    expect(html).toContain('タグ 04:9A:FB:5C:BD:1E:7F から読み取り');
  });

  it('another tag on the reader: says it will be a copy onto that tag (WRITE-1)', () => {
    openCardDoc(blankImage('NTAG215', UID_A));
    const st = useAppStore.getState();
    const edited = new Uint8Array(st.doc!.image.data);
    edited[6 * 4] = 0x99;
    st.editDocData(edited);
    useAppStore.setState({ reader: reader(card(UID_B, 'NTAG215')) });
    const html = render();
    expect(html).toContain('別のタグです');
    expect(html).toContain('04:C3:24:85:E6:47:A8');
    expect(html).toContain('このタグを読み取る');
    expect(html).toContain('未書き込みの変更 1 ページ');
  });

  it('kind mismatch: disabled with the reason', () => {
    openCardDoc(blankImage('NTAG215', UID_A));
    useAppStore.setState({ reader: reader(card(UID_B, 'NTAG213')) });
    expect(render()).toContain('種類が違うため、書き込めません');
  });

  it('FeliCa: block names, IDm (not UID), and the flag editor gated', () => {
    openCardDoc(blankImage('FELICA_LITE_S', '0102030405060708'));
    useAppStore.setState({ reader: reader(card('0102030405060708', 'FELICA_LITE_S')) });
    const html = render();
    expect(html).toContain('S_PAD12');
    expect(html).toContain('IDm（製造番号）');
    expect(html).not.toContain('UID（製造番号）');
    expect(html).toContain('この設定は保護領域にあります');
  });

  it('MIFARE renders (trailers read-only while protected edits are off)', () => {
    openCardDoc(blankImage('MIFARE_CLASSIC_1K', 'A1B2C3D4'));
    useAppStore.setState({ reader: reader(null) });
    const html = render();
    expect(html).toContain('hx-cell');
    expect(html).toContain('保護領域です');
  });

  it('a file document: the source is the file', () => {
    useAppStore.getState().openImage(blankImage('NTAG213', UID_A), { type: 'file', name: 'backup.nfcdump', token: null, format: 'project' });
    useAppStore.setState({ reader: reader(card(UID_B, 'NTAG213')) });
    const html = render();
    expect(html).toContain('ファイル「backup.nfcdump」');
    expect(html).toContain('ファイルの内容を複製します');
  });
});
