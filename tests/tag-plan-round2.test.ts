// Binary editor, second round of the 2026-11-12 UX rework (owner: renderer-hex).
//  - R-UX-8:  NTAG page 2 bytes 0-1 (UID check byte BCC1 + internal) never edited
//             nor written; the static lock bytes are written as base|edit (OTP).
//  - R-UX-1:  storage-only readers (PaSoRi) cannot send PWD_AUTH: the password
//             field is disabled with the reason, the denied hint says so (D11).
//  - R-UX-12: which hint for pages a read could not open (wrong password / read
//             without it), D9: MIFARE "read with registered keys".
//  - R-UX-5:  turning NTAG password protection on asks for the password.
//  - R-UX-10: CFGLCK + AUTH0 over the config pages refused before the encoder.
//  - E2E-UX-3: one "Read this tag" in the run bar.
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { blankImage, buildNtagConfigWrites, planWrites, readNtagConfig } from '@shared/tag';
import { ntagPage2Effective } from '@shared/tag/plan';
import { ntagPages } from '@shared/tags';
import type { TagKind } from '@shared/tags';
import type { CardInfo, ReaderStatus, TagImage } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { useAppStore } from '../src/renderer/src/store/app';
import { HexView } from '../src/renderer/src/views/hex/HexView';
import { FlagEditor } from '../src/renderer/src/views/hex/FlagEditor';
import type { FlagEditorProps } from '../src/renderer/src/views/hex/FlagEditor';
import {
  byteReadOnlyReason,
  deniedHint,
  keepReadOnlyUnits,
  newNtagPasswordProblem,
  ntagArmsWithoutPassword,
  ntagCfgLockConflict,
  ntagPasswordEdited,
  ntagProtectionOn,
  passwordAuthUnavailable,
  planHexWrite,
  rangeTouchesForbidden,
  restoreLockedBytes,
  writeReadiness,
} from '../src/renderer/src/views/hex/model';

const UID_A = '049AFB5CBD1E7F';
const UID_B = '04C32485E647A8';
const units = (p: { writes: { unit: number }[] }) => p.writes.map((w) => w.unit);
const page = (data: Uint8Array, p: number) => Array.from(data.subarray(p * 4, p * 4 + 4));

function card(uid: string, kind: TagKind | null, raw = true): CardInfo {
  return {
    readerName: raw ? 'ACS ACR122U' : 'Sony FeliCa Port/PaSoRi 3.0',
    uid,
    atr: '',
    kind,
    kindSource: 'simulator',
    version: null,
    rawCommands: raw,
    driver: raw ? 'acr122' : 'storage',
    detectedAt: 1,
  };
}

function reader(c: CardInfo | null, driverMode: ReaderStatus['driverMode'] = 'auto'): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [{ name: c?.readerName ?? 'Reader', likelyContactless: true, cardPresent: !!c, inUse: false, atr: null, virtual: false }],
    selectedReader: null,
    activeReader: c?.readerName ?? 'Reader',
    activeReason: 'auto-only',
    driverMode,
    card: c,
    cardState: c ? 'ready' : 'absent',
    cardError: null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: false, kind: 'NTAG215', present: false, uid: '' },
  };
}

// ---------------------------------------------------------------------------
// R-UX-8: NTAG page 2 (BCC1 + internal + static lock bytes)
// ---------------------------------------------------------------------------

describe('NTAG page 2 in the write plan (R-UX-8)', () => {
  it('an edit of only the UID check byte is not written (and is not called a lock)', () => {
    const base = blankImage('NTAG215', UID_A);
    const edited = new Uint8Array(base.data);
    edited[8] ^= 0x01; // BCC1
    const plan = planWrites('NTAG215', base, edited, { includeProtected: true });
    expect(units(plan)).not.toContain(2);
    expect(plan.forbiddenUnits).toContain(2);
    expect(plan.warnings.some((w) => w.unit === 2 && w.code === 'UID_READONLY')).toBe(true);
    expect(plan.warnings.some((w) => w.unit === 2 && w.code === 'LOCK_IRREVERSIBLE')).toBe(false);
  });

  it('a lock-byte edit is written with bytes 0-1 as read and the lock bits OR-ed in', () => {
    const base = blankImage('NTAG215', UID_A);
    base.data[10] = 0x10; // a lock bit already set on the tag
    const edited = new Uint8Array(base.data);
    edited[8] ^= 0xff; // BCC1 changed too - must not reach the tag
    edited[10] = 0x20; // sets another bit, "clears" the existing one
    edited[11] = 0x01;
    const plan = planWrites('NTAG215', base, edited, { includeProtected: true });
    const w = plan.writes.find((x) => x.unit === 2);
    expect(w).toBeDefined();
    expect(Array.from(w!.data)).toEqual([base.data[8], base.data[9], 0x30, 0x01]);
    // what the tag will hold afterwards = what is written (the verify matches)
    expect(Array.from(ntagPage2Effective(base.data.subarray(8, 12), edited.subarray(8, 12)))).toEqual(Array.from(w!.data));
    // the attempt to clear a set bit is still called out as irreversible (danger)
    expect(plan.warnings.some((x) => x.unit === 2 && x.code === 'LOCK_IRREVERSIBLE' && x.severity === 'danger')).toBe(true);
  });

  it('only clearing a lock bit: nothing to write, and the binary editor says why', () => {
    const base = blankImage('NTAG215', UID_A);
    base.data[10] = 0x10;
    const edited = new Uint8Array(base.data);
    edited[10] = 0x00;
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'same', original: base, data: edited, includeProtected: true });
    expect(units(hp.plan)).toEqual([]);
    expect(hp.excluded.otp).toEqual([2]);
    const r = writeReadiness({
      source: { type: 'card', uid: UID_A },
      kind: 'NTAG215',
      reader: reader(card(UID_A, 'NTAG215')),
      issueRunning: false,
      busyOp: null,
      passwordValid: true,
      samePlan: hp,
    });
    expect(r.block?.type).toBe('excluded'); // not "there are no unsaved changes"
  });

  it('a copy writes the TARGET tag its own UID check bytes', () => {
    const a = blankImage('NTAG215', UID_A);
    const b = blankImage('NTAG215', UID_B);
    expect(a.data[8]).not.toBe(b.data[8]); // different UIDs -> different BCC1
    const data = new Uint8Array(a.data);
    data[10] = 0x08; // the operator sets a lock bit in the document
    const hp = planHexWrite({ kind: 'NTAG215', mode: 'copy', original: a, data, target: b, includeProtected: true });
    const w = hp.plan.writes.find((x) => x.unit === 2);
    expect(w).toBeDefined();
    expect(Array.from(w!.data)).toEqual([b.data[8], b.data[9], 0x08, b.data[11]]);
    expect(hp.plan.warnings.some((x) => x.code === 'UID_READONLY')).toBe(false);
  });
});

describe('NTAG page 2 in the grid (R-UX-8)', () => {
  const ctx = { locked: new Set<number>(), protectedEditable: true };

  it('bytes 0-1 of page 2 are read-only per byte; the lock bytes stay editable', () => {
    expect(byteReadOnlyReason('NTAG215', 8, ctx)).toBe('uidCheck');
    expect(byteReadOnlyReason('NTAG215', 9, ctx)).toBe('uidCheck');
    expect(byteReadOnlyReason('NTAG215', 10, ctx)).toBeNull();
    expect(byteReadOnlyReason('NTAG215', 0, ctx)).toBe('forbidden');
    expect(byteReadOnlyReason('NTAG215', 10, { ...ctx, protectedEditable: false })).toBe('protected');
    // MIFARE byte 8 is in block 0 (forbidden as a whole), not a "UID check byte"
    expect(byteReadOnlyReason('MIFARE_CLASSIC_1K', 8, ctx)).toBe('forbidden');
    expect(byteReadOnlyReason('FELICA_LITE_S', 8, ctx)).toBeNull();
  });

  it('no edit can change them, even with protected areas editable', () => {
    const img = blankImage('NTAG215', UID_A);
    const next = new Uint8Array(img.data);
    next.fill(0xaa, 8, 12);
    const kept = keepReadOnlyUnits('NTAG215', next, img.data, ctx);
    expect(kept.changed).toBe(true);
    expect(page(kept.data, 2)).toEqual([img.data[8], img.data[9], 0xaa, 0xaa]);
    const restored = restoreLockedBytes('NTAG215', next, img.data);
    expect(page(restored, 2)).toEqual([img.data[8], img.data[9], 0xaa, 0xaa]);
  });

  it('number editing over them is refused like the UID', () => {
    expect(rangeTouchesForbidden('NTAG215', 9, 10)).toBe(true);
    expect(rangeTouchesForbidden('NTAG215', 10, 11)).toBe(false);
    expect(rangeTouchesForbidden('MIFARE_CLASSIC_1K', 16, 17)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R-UX-1 / D11, R-UX-12, D9
// ---------------------------------------------------------------------------

describe('password auth vs the reader (R-UX-1 / D11)', () => {
  it('storage-only reader (no raw commands) cannot authenticate', () => {
    expect(passwordAuthUnavailable(reader(card(UID_A, 'NTAG215', false)))).toBe(true);
    expect(passwordAuthUnavailable(reader(card(UID_A, null, false)))).toBe(true); // read-protected NTAG: kind unknown
    expect(passwordAuthUnavailable(reader(card(UID_A, 'NTAG215', true)))).toBe(false);
  });

  it('with no tag: only an explicit "storage" driver setting tells', () => {
    expect(passwordAuthUnavailable(reader(null, 'storage'))).toBe(true);
    expect(passwordAuthUnavailable(reader(null, 'auto'))).toBe(false);
    expect(passwordAuthUnavailable(null)).toBe(false);
  });
});

describe('the hint for pages / blocks a read could not open (R-UX-1 / R-UX-12 / D9)', () => {
  const base = { kind: 'NTAG215' as TagKind, deniedN: 3, noAuth: false, password: '', pwReadAt: null, readAt: 100 };
  it('NTAG', () => {
    expect(deniedHint({ ...base, deniedN: 0 })).toBeNull();
    expect(deniedHint(base)).toBe('ntag');
    expect(deniedHint({ ...base, noAuth: true, password: '12345678' })).toBe('ntagStorage');
    expect(deniedHint({ ...base, password: '12345678', pwReadAt: 100 })).toBe('ntagWrongPw');
    // password entered, but this document was read without it (auto-read)
    expect(deniedHint({ ...base, password: '12345678', pwReadAt: 50 })).toBe('ntagNoPw');
    expect(deniedHint({ ...base, password: '12345678' })).toBe('ntagNoPw');
  });
  it('MIFARE / FeliCa', () => {
    expect(deniedHint({ ...base, kind: 'MIFARE_CLASSIC_1K' })).toBe('mifare');
    expect(deniedHint({ ...base, kind: 'FELICA_LITE_S' })).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// R-UX-5 / R-UX-10: NTAG password protection from the parameter editor
// ---------------------------------------------------------------------------

describe('NTAG password protection helpers (R-UX-5)', () => {
  it('AUTH0 inside the memory = protection on', () => {
    expect(ntagProtectionOn('NTAG215', 0xff)).toBe(false);
    expect(ntagProtectionOn('NTAG215', 135)).toBe(false); // past the last page (134)
    expect(ntagProtectionOn('NTAG215', 134)).toBe(true);
    expect(ntagProtectionOn('NTAG215', 4)).toBe(true);
    expect(ntagProtectionOn('MIFARE_CLASSIC_1K', 4)).toBe(false);
  });

  it('a password is being set when the PWD or PACK page differs from what was read', () => {
    const img = blankImage('NTAG215', UID_A);
    const p = ntagPages('NTAG215');
    const data = new Uint8Array(img.data);
    expect(ntagPasswordEdited('NTAG215', data, img.data)).toBe(false);
    data[p.pwd * 4] = 0x12;
    expect(ntagPasswordEdited('NTAG215', data, img.data)).toBe(true);
  });

  it('a write that turns protection on without a password is detected (write confirmation line)', () => {
    const img = blankImage('NTAG215', UID_A);
    const p = ntagPages('NTAG215');
    const armed = new Uint8Array(img.data);
    armed[p.cfg0 * 4 + 3] = 4;
    const plan = planWrites('NTAG215', img, armed, { includeProtected: true });
    expect(ntagArmsWithoutPassword('NTAG215', img.data, plan.writes)).toBe(true);
    // with the password page written: fine
    const withPw = new Uint8Array(armed);
    withPw.set([0x1a, 0x2b, 0x3c, 0x4d], p.pwd * 4);
    expect(ntagArmsWithoutPassword('NTAG215', img.data, planWrites('NTAG215', img, withPw, { includeProtected: true }).writes)).toBe(false);
    // already protected on the tag: the existing password stays - not this warning
    const prot = blankImage('NTAG215', UID_A);
    prot.data[p.cfg0 * 4 + 3] = 16;
    const moved = new Uint8Array(prot.data);
    moved[p.cfg0 * 4 + 3] = 4;
    expect(ntagArmsWithoutPassword('NTAG215', prot.data, planWrites('NTAG215', prot, moved, { includeProtected: true }).writes)).toBe(false);
  });

  it('the chosen password is checked (00000000 cannot be written, FFFFFFFF is no protection)', () => {
    expect(newNtagPasswordProblem('1A2B3C4D', '1a2b3c4d', '0000')).toBeNull();
    expect(newNtagPasswordProblem('1A2B3C', '1A2B3C', '0000')).toBe('pwdFormat');
    expect(newNtagPasswordProblem('00000000', '00000000', '0000')).toBe('pwdZero');
    expect(newNtagPasswordProblem('ffffffff', 'ffffffff', '0000')).toBe('pwdFactory');
    expect(newNtagPasswordProblem('1A2B3C4D', '1A2B3C4E', '0000')).toBe('mismatch');
    expect(newNtagPasswordProblem('1A2B3C4D', '1A2B3C4D', '00')).toBe('packFormat');
  });
});

describe('CFGLCK + AUTH0 over the config pages (R-UX-10)', () => {
  it('is refused before the encoder, for exactly the cases the encoder throws on', () => {
    const img = blankImage('NTAG215', UID_A);
    const cfg = readNtagConfig('NTAG215', img.data);
    const p = ntagPages('NTAG215');
    for (const auth0 of [0, 4, p.cfg0, p.cfg1, p.cfg1 + 1, p.pack, 0xff]) {
      for (const cfgLock of [false, true]) {
        const next = { ...cfg, auth0, cfgLock };
        let threw = false;
        try {
          buildNtagConfigWrites('NTAG215', img.data, next);
        } catch {
          threw = true;
        }
        expect(ntagCfgLockConflict('NTAG215', next), `auth0=${auth0} cfgLock=${cfgLock}`).toBe(threw);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Rendered (SSR, no DOM): HexView and FlagEditor
// ---------------------------------------------------------------------------

function syncStore() {
  // zustand renders the INITIAL state on the server: copy the live state into it.
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
}

function renderHex(): string {
  syncStore();
  return renderToStaticMarkup(createElement(HexView));
}

function openCardDoc(img: TagImage) {
  useAppStore.getState().openImage(img, { type: 'card', uid: img.uid });
}

beforeEach(() => {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, language: 'ja' }, doc: null, reader: null, busyOp: null, lastWrite: null });
});

describe('HexView render (second round)', () => {
  it('storage reader + password-protected pages: the field is disabled with the reason, no false "enter the password" (R-UX-1)', () => {
    const img = blankImage('NTAG215', UID_A);
    for (let u = 16; u < 135; u++) img.unitStatus[u] = 'denied';
    openCardDoc(img);
    useAppStore.setState({ reader: reader(card(UID_A, 'NTAG215', false)) });
    const html = renderHex();
    expect(html).toContain('data-testid="hex-pw-noauth"');
    expect(html).toMatch(/<input[^>]*disabled[^>]*data-testid="hex-pw"|<input[^>]*data-testid="hex-pw"[^>]*disabled/);
    expect(html).toContain('ストレージ方式）ではパスワード認証ができないため、ここでは読めません');
    expect(html).not.toContain('パスワードを入れて、もう一度読み取ってください');
    // no button that cannot help
    expect(html).toMatch(/data-testid="hex-denied"><span>[^<]*<\/span><\/div>/);
  });

  it('raw reader + password-protected pages: the field is usable and the hint asks for the password', () => {
    const img = blankImage('NTAG215', UID_A);
    for (let u = 16; u < 135; u++) img.unitStatus[u] = 'denied';
    openCardDoc(img);
    useAppStore.setState({ reader: reader(card(UID_A, 'NTAG215', true)) });
    const html = renderHex();
    expect(html).not.toContain('data-testid="hex-pw-noauth"');
    expect(html).not.toMatch(/<input[^>]*disabled[^>]*data-testid="hex-pw"|<input[^>]*data-testid="hex-pw"[^>]*disabled/);
    expect(html).toContain('上の欄にパスワードを入れて、もう一度読み取ってください');
  });

  it('MIFARE sectors not opened: offers "read with registered keys" and names the "MIFARE 鍵" screen (D9 / R-UX-11)', () => {
    const img = blankImage('MIFARE_CLASSIC_1K', 'A1B2C3D4');
    for (let b = 8; b < 12; b++) img.unitStatus[b] = 'denied';
    openCardDoc(img);
    useAppStore.setState({ reader: reader(card('A1B2C3D4', 'MIFARE_CLASSIC_1K')) });
    const html = renderHex();
    expect(html).toContain('登録した鍵で読み取る');
    expect(html).toContain('「MIFARE 鍵」');
    expect(html).not.toContain('鍵の管理');
  });

  it('another tag on the reader: ONE "read this tag" button in the run bar (E2E-UX-3)', () => {
    openCardDoc(blankImage('NTAG215', UID_A));
    const st = useAppStore.getState();
    const edited = new Uint8Array(st.doc!.image.data);
    edited[6 * 4] = 0x99;
    st.editDocData(edited);
    useAppStore.setState({ reader: reader(card(UID_B, 'NTAG215')) });
    const html = renderHex();
    expect(html.split('このタグを読み取る').length - 1).toBe(1);
  });

  it('page 2 bytes 0-1 are shown read-only with their own reason (R-UX-8)', () => {
    openCardDoc(blankImage('NTAG215', UID_A));
    useAppStore.setState({ reader: reader(card(UID_A, 'NTAG215')) });
    const html = renderHex();
    expect(html).toContain('検査バイト（BCC1）');
  });

  it('English: "Unsaved changes", never "Unwritten" (D12)', () => {
    openCardDoc(blankImage('NTAG215', UID_A));
    const st = useAppStore.getState();
    const edited = new Uint8Array(st.doc!.image.data);
    edited[6 * 4] = 0x99;
    st.editDocData(edited);
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, language: 'en' }, reader: reader(card(UID_A, 'NTAG215')) });
    const html = renderHex();
    expect(html).toContain('Unsaved changes: 1 pages');
    expect(html.toLowerCase()).not.toContain('unwritten');
  });
});

describe('FlagEditor render: deciding the password (R-UX-5)', () => {
  function flags(data: Uint8Array, original: Uint8Array, extra: Partial<FlagEditorProps> = {}): string {
    syncStore();
    const props: FlagEditorProps = {
      kind: 'NTAG215',
      data,
      original,
      unit: 4,
      advanced: true,
      protectedEditable: true,
      onEnableProtected: () => {},
      busy: false,
      onApply: () => {},
      confirm: async () => false,
      ...extra,
    };
    return renderToStaticMarkup(createElement(FlagEditor, props));
  }
  const p = ntagPages('NTAG215');

  it('protection turned on (AUTH0 typed in the grid) without a password: the password form is shown', () => {
    const img = blankImage('NTAG215', UID_A);
    const data = new Uint8Array(img.data);
    data[p.cfg0 * 4 + 3] = 4; // AUTH0 = 4
    const html = flags(data, img.data);
    expect(html).toContain('data-testid="flags-pw-panel"');
    expect(html).toContain('パスワードを決めてください');
    expect(html).toContain('FFFFFFFF');
    expect(html).not.toContain('ストレージ方式');
    // and on a storage reader it says the pages would be lost to this reader
    expect(flags(data, img.data, { passwordAuthUnavailable: true })).toContain('このリーダーでは二度と読み書きできなくなります');
  });

  it('password already decided (PWD page edited): no second form, it says the decided one is written', () => {
    const img = blankImage('NTAG215', UID_A);
    const data = new Uint8Array(img.data);
    data[p.cfg0 * 4 + 3] = 4;
    data.set([0x1a, 0x2b, 0x3c, 0x4d], p.pwd * 4);
    const html = flags(data, img.data);
    expect(html).not.toContain('data-testid="flags-pw-panel"');
    expect(html).toContain('data-testid="flags-pw-pending"');
  });

  it('a tag already protected: the password does not change (no form)', () => {
    const img = blankImage('NTAG215', UID_A);
    img.data[p.cfg0 * 4 + 3] = 16;
    const html = flags(new Uint8Array(img.data), img.data);
    expect(html).not.toContain('data-testid="flags-pw-panel"');
    expect(html).toContain('すでにパスワードで保護されています（ページ 16 以降）');
  });

  it('protection off: no form', () => {
    const img = blankImage('NTAG215', UID_A);
    expect(flags(new Uint8Array(img.data), img.data)).not.toContain('data-testid="flags-pw-panel"');
  });
});
