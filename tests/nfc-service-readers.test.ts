// NfcService against a fake PC/SC backend that lays out the readers measured on
// the dev PC (2026-11-12): [FS USB Token 0 (card present), Sony PaSoRi, YubiKey
// (card present)]. Regression tests for the 2026-11-12 UX audit:
//   CARD-1  status card = the tag read/write actually use (virtual vs real)
//   CARD-2  no APDU to USB tokens / YubiKeys; their failures never blank the tag
//   CARD-3  a failed identification is retried, then reported with a code
//   CARD-4  a tag lifted mid-read fails the read (no half image "success")
//   CARD-10 a swapped tag is noticed (card-changed -> UID check)
//   WRITE-4 / ISSUE-2  a tag lifted mid-write stops it: aborted + notAttempted
//   CARD-12 a FeliCa card that is not a Lite-S is "unsupported"
// No hardware: the PaSoRi's "tags" are simulator tags behind a storage-driver
// reader name, the tokens answer 6A 81 to everything (and must never be asked).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEvent, CardConnection, ReaderBackend } from '../src/main/nfc/backend';
import type { NfcService, NfcServiceDeps, ResolvedKey } from '../src/main/nfc/contract';
import type { ErrorCode, ReaderInfo, ReaderStatus, UnitWrite } from '../src/shared/types';
import type { TagKind } from '../src/shared/tags';
import { ntagPages } from '../src/shared/tags';
import { buildNtagPasswordWrites } from '../src/shared/tag';
import { OpError } from '../src/main/errors';
import { createSimulatorBackend, type SimulatorBackend } from '../src/main/nfc/simulator';
import { isLikelyContactlessReader, VIRTUAL_READER_NAME } from '../src/shared/reader';
import { bytesToHex, hexToBytes } from '../src/shared/hex';

const hoist = vi.hoisted(() => ({ backend: null as unknown }));

vi.mock('../src/main/nfc/pcsc', () => ({
  createPcscBackend: () => {
    if (!hoist.backend) throw new Error('fake PC/SC backend not configured');
    return hoist.backend;
  },
}));

// Imported after the mock is registered (vi.mock is hoisted).
import { atrSaysNotType2, createNfcService, IDENTIFY_RETRY_MS, IDENTIFY_SETTLE_MS, IDENTIFY_SLOW_RETRY_MS } from '../src/main/nfc/service';

const TOKEN = 'FS USB Token 0';
const PASORI = 'Sony FeliCa Port/PaSoRi 3.0 0';
const YUBI = 'Yubico YubiKey OTP+FIDO+CCID 0';
const ACR = 'ACS ACR122U PICC Interface 0';
const TOKEN_ATR = hexToBytes('3B9F958131FE9F006646530523002571DF000003900096');
const YUBI_ATR = hexToBytes('3BFD1300008131FE158073C021C057597562694B657940');
/** PC/SC Part 3 storage ATR of a FeliCa card (standard byte 0x11). */
const FELICA_ATR = hexToBytes('3B8F8001804F0CA0000003061100000000000000');

interface FakeReader {
  present: boolean;
  atr: Uint8Array | null;
  /** NFC tag behind this reader (simulator tag), or a custom APDU responder, or null = token (6A 81). */
  tag: SimulatorBackend | null;
  respond?: (apdu: Uint8Array) => Uint8Array;
}

/** Programmable PC/SC backend: presence, failures, APDU log. */
class FakePcsc implements ReaderBackend {
  readonly id = 'pcsc' as const;
  listener: ((e: BackendEvent) => void) | null = null;
  readonly order: string[] = [];
  readonly map = new Map<string, FakeReader>();
  readonly apdus: { reader: string; apdu: string }[] = [];
  readonly connects: string[] = [];
  /** Codes the next connect() calls on a reader throw, in order. */
  readonly failNext = new Map<string, ErrorCode[]>();
  /** Take the tag off `reader` once this many APDUs have gone to it (counted from now). */
  removeAfter: { reader: string; at: number } | null = null;

  add(name: string, r: Partial<FakeReader> = {}): void {
    this.order.push(name);
    this.map.set(name, { present: false, atr: null, tag: null, ...r });
  }

  async start(l: (e: BackendEvent) => void): Promise<void> {
    this.listener = l;
    l({ type: 'service', state: 'ok', message: null });
    l({ type: 'readers', readers: this.readers() });
    for (const name of this.order) {
      const r = this.map.get(name)!;
      if (r.present) l({ type: 'card-inserted', reader: name, atr: r.atr ?? new Uint8Array(0) });
    }
  }
  async stop(): Promise<void> {
    this.listener = null;
  }
  async refresh(): Promise<void> {}

  readers(): ReaderInfo[] {
    return this.order.map((name) => {
      const r = this.map.get(name)!;
      const atr = r.present ? r.atr : null;
      return {
        name,
        likelyContactless: isLikelyContactlessReader(name, atr),
        cardPresent: r.present,
        inUse: false,
        atr: atr ? bytesToHex(atr) : null,
        virtual: false,
      };
    });
  }

  async connect(name: string): Promise<CardConnection> {
    this.connects.push(name);
    const r = this.map.get(name);
    if (!r) throw new OpError('NO_READER');
    if (!r.present) throw new OpError('NO_CARD');
    const fail = this.failNext.get(name)?.shift();
    if (fail) throw new OpError(fail, 'SCARD_FAKE');
    const inner = r.tag ? await r.tag.connect(VIRTUAL_READER_NAME) : null;
    const fake = this;
    let sent = 0;
    return {
      readerName: name,
      atr: r.atr ?? new Uint8Array(0),
      async transmit(apdu: Uint8Array): Promise<Uint8Array> {
        fake.apdus.push({ reader: name, apdu: bytesToHex(apdu) });
        sent++;
        if (fake.removeAfter && fake.removeAfter.reader === name && sent > fake.removeAfter.at && r.tag) r.tag.present = false;
        if (r.respond) return r.respond(apdu);
        if (!inner) return Uint8Array.from([0x6a, 0x81]);
        return inner.transmit(apdu);
      },
      async disconnect(): Promise<void> {
        await inner?.disconnect();
      },
    };
  }

  private emit(e: BackendEvent): void {
    this.listener?.(e);
  }

  /** Put a fresh simulator tag of `kind` on `reader`. */
  async place(reader: string, kind: TagKind): Promise<SimulatorBackend> {
    const r = this.map.get(reader)!;
    const tag = await makeTag(kind);
    r.tag = tag.sim;
    r.atr = tag.atr;
    r.present = true;
    this.emit({ type: 'readers', readers: this.readers() });
    this.emit({ type: 'card-inserted', reader, atr: tag.atr });
    return tag.sim;
  }

  /** Put a card answering with `respond` (no simulator tag) on `reader`. */
  placeRaw(reader: string, atr: Uint8Array, respond: (apdu: Uint8Array) => Uint8Array): void {
    const r = this.map.get(reader)!;
    r.tag = null;
    r.respond = respond;
    r.atr = atr;
    r.present = true;
    this.emit({ type: 'readers', readers: this.readers() });
    this.emit({ type: 'card-inserted', reader, atr });
  }

  lift(reader: string): void {
    const r = this.map.get(reader)!;
    r.present = false;
    if (r.tag) r.tag.present = false;
    r.respond = undefined;
    this.emit({ type: 'readers', readers: this.readers() });
    this.emit({ type: 'card-removed', reader });
  }

  /** Replace the tag without the reader ever reporting "empty" (fast swap). */
  async swap(reader: string, kind: TagKind | null): Promise<void> {
    const r = this.map.get(reader)!;
    if (kind) {
      const tag = await makeTag(kind);
      r.tag = tag.sim;
      r.atr = tag.atr;
    }
    this.emit({ type: 'card-changed', reader, atr: r.atr ?? new Uint8Array(0) });
  }

  sentTo(reader: string): string[] {
    return this.apdus.filter((a) => a.reader === reader).map((a) => a.apdu);
  }
}

async function makeTag(kind: TagKind): Promise<{ sim: SimulatorBackend; atr: Uint8Array }> {
  const sim = createSimulatorBackend();
  sim.setEnabled(true, kind);
  sim.present = true;
  const c = await sim.connect(VIRTUAL_READER_NAME);
  const atr = c.atr;
  await c.disconnect();
  return { sim, atr };
}

const KEYS: Record<string, string> = { factory: 'FFFFFFFFFFFF' };
function deps(log: string[] = []): NfcServiceDeps {
  return {
    resolveKeys: (ids: string[]): ResolvedKey[] => ids.filter((id) => KEYS[id]).map((id) => ({ id, label: id, key: hexToBytes(KEYS[id]) })),
    allKeyIds: () => ['factory'],
    log: (l) => log.push(l),
    isAdvancedMode: () => false,
  };
}

function u(unit: number, hex: string): UnitWrite {
  return { unit, data: hexToBytes(hex) };
}

/** The dev PC's layout: token (card), PaSoRi (empty), YubiKey (card). */
function devPcLayout(): FakePcsc {
  const f = new FakePcsc();
  f.add(TOKEN, { present: true, atr: TOKEN_ATR });
  f.add(PASORI);
  f.add(YUBI, { present: true, atr: YUBI_ATR });
  return f;
}

let fake: FakePcsc;
let svc: NfcService;
let logs: string[];
let seen: ReaderStatus[];

async function startService(f: FakePcsc, init: Parameters<typeof createNfcService>[1] = {}): Promise<void> {
  fake = f;
  hoist.backend = f;
  logs = [];
  seen = [];
  svc = createNfcService(deps(logs), init);
  svc.onStatus((s) => seen.push(s));
  await vi.advanceTimersByTimeAsync(0);
}

/** Let the settle delay + one identification run. */
async function settle(ms = IDENTIFY_SETTLE_MS + 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await svc?.dispose();
  hoist.backend = null;
  vi.useRealTimers();
});

describe('which readers are identified (I6, CARD-2)', () => {
  it('starting with tags on the token, PaSoRi and YubiKey identifies only the PaSoRi', async () => {
    const f = devPcLayout();
    await f.place(PASORI, 'NTAG215'); // tag already on the PaSoRi at start-up
    await startService(f);
    await settle();

    expect(f.connects.filter((n) => n !== PASORI)).toEqual([]);
    expect(f.sentTo(TOKEN)).toEqual([]);
    expect(f.sentTo(YUBI)).toEqual([]);
    const s = svc.getStatus();
    expect(s).toMatchObject({ activeReader: PASORI, activeReason: 'auto-card', cardState: 'ready', cardError: null });
    expect(s.card).toMatchObject({ readerName: PASORI, kind: 'NTAG215', kindSource: 'cc', driver: 'storage' });

    const img = await svc.readTag({});
    expect(img.kind).toBe('NTAG215');
    expect(f.sentTo(TOKEN)).toEqual([]);
  });

  it('a token re-plugged later is still never probed, and the PaSoRi tag stays', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG213');
    await settle();
    f.lift(TOKEN);
    f.placeRaw(TOKEN, TOKEN_ATR, () => Uint8Array.from([0x6a, 0x81]));
    await settle(2000);
    expect(f.sentTo(TOKEN)).toEqual([]);
    expect(svc.getStatus()).toMatchObject({ cardState: 'ready', card: { readerName: PASORI, kind: 'NTAG213' } });
  });

  it("another contactless reader's failed identification never blanks the active tag", async () => {
    const f = devPcLayout();
    f.add(ACR);
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const before = svc.getStatus().card;
    expect(before?.readerName).toBe(PASORI);

    f.failNext.set(ACR, ['CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE']);
    await f.place(ACR, 'NTAG213');
    await settle(5000);
    expect(svc.getStatus()).toMatchObject({ activeReader: PASORI, cardState: 'ready', card: { uid: before!.uid } });
  });

  it('applies init.preferredReader before the first poll: an unselected reader is not probed', async () => {
    const f = devPcLayout();
    f.add(ACR);
    await f.place(ACR, 'NTAG213');
    await startService(f, { preferredReader: PASORI });
    await settle();
    expect(f.connects).toEqual([]);
    await f.place(PASORI, 'NTAG216');
    await settle();
    expect(f.connects.every((n) => n === PASORI)).toBe(true);
    expect(svc.getStatus()).toMatchObject({ activeReason: 'selected', card: { kind: 'NTAG216' } });
  });

  it('a selected reader that is missing is not replaced; other tags are not probed until auto (D1)', async () => {
    const f = devPcLayout();
    await startService(f, { preferredReader: 'Sony FeliCa Port/PaSoRi 3.0 1' });
    await f.place(PASORI, 'NTAG215');
    await settle();
    expect(svc.getStatus()).toMatchObject({ activeReader: null, activeReason: 'selected-missing', cardState: 'no-reader' });
    expect(f.connects).toEqual([]);

    await svc.selectReader(null);
    await settle(50);
    expect(svc.getStatus()).toMatchObject({ activeReader: PASORI, activeReason: 'auto-card', cardState: 'ready' });
  });
});

describe('identification retries and errors (CARD-3, FIRST-1, WALK-3)', () => {
  it('retries a failed identification while the tag stays, and shows "detecting" meanwhile', async () => {
    const f = devPcLayout();
    await startService(f);
    f.failNext.set(PASORI, ['READER_IN_USE']);
    await f.place(PASORI, 'NTAG215');
    expect(svc.getStatus().cardState).toBe('detecting');

    await settle(); // first attempt fails
    expect(svc.getStatus().cardState).toBe('detecting');
    expect(logs.some((l) => l.includes('READER_IN_USE') && l.includes('SCARD_FAKE'))).toBe(true);

    await vi.advanceTimersByTimeAsync(IDENTIFY_RETRY_MS[0] + 10);
    expect(svc.getStatus()).toMatchObject({ cardState: 'ready', card: { kind: 'NTAG215' } });
    expect(seen.some((s) => s.busy?.op === 'identify')).toBe(true);
  });

  it('after the retries it reports error + the code; reidentify() tries again', async () => {
    const f = devPcLayout();
    await startService(f);
    const tries = 1 + IDENTIFY_RETRY_MS.length + IDENTIFY_SLOW_RETRY_MS.length;
    f.failNext.set(PASORI, Array.from({ length: tries }, () => 'CARD_UNRESPONSIVE' as ErrorCode));
    await f.place(PASORI, 'NTAG213');
    await settle(IDENTIFY_SETTLE_MS + IDENTIFY_RETRY_MS.reduce((a, b) => a + b, 0) + 100);
    expect(f.connects.filter((n) => n === PASORI)).toHaveLength(1 + IDENTIFY_RETRY_MS.length);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'CARD_UNRESPONSIVE', card: null });

    // A few slow, quiet re-checks (R-MAIN-7) - the error stays shown meanwhile...
    await settle(IDENTIFY_SLOW_RETRY_MS.reduce((a, b) => a + b, 0) + 100);
    expect(f.connects.filter((n) => n === PASORI)).toHaveLength(tries);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'CARD_UNRESPONSIVE' });
    // ...and then nothing else retries on its own (no busy loop on a dead tag).
    await settle(60_000);
    expect(f.connects.filter((n) => n === PASORI)).toHaveLength(tries);

    const p = svc.reidentify();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(svc.getStatus()).toMatchObject({ cardState: 'ready', cardError: null, card: { kind: 'NTAG213' } });
  });

  it('refreshReaders() also retries a tag stuck in error', async () => {
    const f = devPcLayout();
    await startService(f);
    f.failNext.set(PASORI, ['READ_FAILED', 'READ_FAILED', 'READ_FAILED', 'READ_FAILED']);
    await f.place(PASORI, 'NTAG215');
    // the quick round only (before the first slow re-check of R-MAIN-7)
    await settle(IDENTIFY_SETTLE_MS + IDENTIFY_RETRY_MS.reduce((a, b) => a + b, 0) + 100);
    expect(svc.getStatus().cardState).toBe('error');
    await svc.refreshReaders();
    await settle(50);
    expect(svc.getStatus().cardState).toBe('ready');
  });

  it('removal is tracked by presence: waitForRemoval ends even when identification failed', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const removed = vi.fn();
    void svc.waitForRemoval(new AbortController().signal).then(removed);
    // the tag starts failing (e.g. moved half off the reader) and is then taken away
    f.failNext.set(PASORI, Array.from({ length: 1 + IDENTIFY_RETRY_MS.length + IDENTIFY_SLOW_RETRY_MS.length }, () => 'CARD_UNRESPONSIVE' as ErrorCode));
    const p = svc.reidentify();
    await settle(5000);
    await p;
    expect(svc.getStatus().cardState).toBe('error');
    expect(removed).not.toHaveBeenCalled();
    f.lift(PASORI);
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(svc.getStatus().cardState).toBe('absent');
  });
});

describe('the virtual reader and a real tag (CARD-1)', () => {
  it('status shows the tag read/write use, and names the real reader it hides', async () => {
    const f = devPcLayout();
    await startService(f);
    await svc.setSimulator({ enabled: true, kind: 'NTAG213' });
    await svc.simulatorTap(true);
    await settle(50);
    await f.place(PASORI, 'NTAG215');
    await settle();

    const s = svc.getStatus();
    expect(s).toMatchObject({ activeReader: VIRTUAL_READER_NAME, activeReason: 'auto-virtual', ignoredRealReader: PASORI });
    expect(s.card).toMatchObject({ readerName: VIRTUAL_READER_NAME, kind: 'NTAG213' });
    const img = await svc.readTag({});
    expect(img.uid).toBe(s.card!.uid); // the tag shown is the tag read

    // Turning the virtual reader off hands over to the real tag.
    await svc.setSimulator({ enabled: false });
    await settle(50);
    expect(svc.getStatus()).toMatchObject({ activeReader: PASORI, activeReason: 'auto-card', ignoredRealReader: null, card: { kind: 'NTAG215' } });
  });
});

describe('a tag lifted in the middle of an operation (CARD-4, WRITE-4, ISSUE-2)', () => {
  it('NTAG: lifting it mid-read fails the read with CARD_REMOVED', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    f.removeAfter = { reader: PASORI, at: 12 };
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'CARD_REMOVED' });
  });

  it('MIFARE: lifting it mid-read fails the read with CARD_REMOVED', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'MIFARE_CLASSIC_1K');
    await settle();
    expect(svc.getStatus().card?.kind).toBe('MIFARE_CLASSIC_1K');
    f.removeAfter = { reader: PASORI, at: 30 };
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'CARD_REMOVED' });
  });

  it('FeliCa: lifting it mid-read fails the read with CARD_REMOVED', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'FELICA_LITE_S');
    await settle();
    expect(svc.getStatus().card?.kind).toBe('FELICA_LITE_S');
    f.removeAfter = { reader: PASORI, at: 8 };
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'CARD_REMOVED' });
  });

  it('NTAG: lifting it mid-write stops at once: aborted + the untried pages', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const card = svc.getStatus().card!;
    const writes = Array.from({ length: 10 }, (_, i) => u(4 + i, '0A0B0C0D'));
    // getUid + CC read, then 3 pages, then the tag is gone
    f.removeAfter = { reader: PASORI, at: 2 + 3 };
    const res = await svc.writeTag({ kind: 'NTAG215', expectedUid: card.uid, writes, allowProtected: false, verify: true });
    expect(res.aborted).toBe('CARD_REMOVED');
    expect(res.written).toEqual([4, 5, 6]);
    expect(res.failed).toEqual([{ unit: 7, error: 'CARD_REMOVED' }]);
    expect(res.notAttempted).toEqual([8, 9, 10, 11, 12, 13]);
    expect(res.verified).toBe(false);
    // one APDU per page tried - no long tail of doomed page writes
    expect(f.sentTo(PASORI).filter((a) => a.startsWith('FFD6'))).toHaveLength(4);
  });

  it('NTAG: lifting it during the read-back reports "written but not verified"', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const card = svc.getStatus().card!;
    const writes = Array.from({ length: 4 }, (_, i) => u(4 + i, '01020304'));
    f.removeAfter = { reader: PASORI, at: 2 + writes.length + 1 };
    const res = await svc.writeTag({ kind: 'NTAG215', expectedUid: card.uid, writes, allowProtected: false, verify: true });
    expect(res).toMatchObject({ written: [4, 5, 6, 7], failed: [], notAttempted: [], aborted: 'CARD_REMOVED', verified: false, mismatched: [] });
  });

  it('FeliCa: lifting it mid-write is reported the same way (not a thrown error)', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'FELICA_LITE_S');
    await settle();
    const card = svc.getStatus().card!;
    const writes = Array.from({ length: 4 }, (_, i) => u(i, '00112233445566778899AABBCCDDEEFF'));
    // getUid + SYS_C probe, then 1 block, then gone
    f.removeAfter = { reader: PASORI, at: 2 + 1 };
    const res = await svc.writeTag({ kind: 'FELICA_LITE_S', expectedUid: card.uid, writes, allowProtected: false, verify: false });
    expect(res).toMatchObject({ written: [0], failed: [{ unit: 1, error: 'CARD_REMOVED' }], notAttempted: [2, 3], aborted: 'CARD_REMOVED' });
  });
});

describe('a tag replaced without the reader reporting "empty" (CARD-10, ISSUE-14, WALK-14)', () => {
  it('card-changed with another tag: the new tag is shown and removal waits end', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const a = svc.getStatus().card!;
    const removed = vi.fn();
    void svc.waitForRemoval(new AbortController().signal).then(removed);

    await f.swap(PASORI, 'NTAG215');
    // the old tag stays shown while the UID is checked (no flicker)
    expect(svc.getStatus().card?.uid).toBe(a.uid);
    await settle();
    const b = svc.getStatus().card!;
    expect(b.uid).not.toBe(a.uid);
    expect(b.detectedAt).toBeGreaterThan(a.detectedAt);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('card-changed with the same tag (counter noise): nothing changes, removal waits keep waiting', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const a = svc.getStatus().card!;
    const removed = vi.fn();
    void svc.waitForRemoval(new AbortController().signal).then(removed);

    await f.swap(PASORI, null);
    await settle();
    expect(svc.getStatus()).toMatchObject({ cardState: 'ready', card: { uid: a.uid, detectedAt: a.detectedAt } });
    expect(removed).not.toHaveBeenCalled();
  });

  it('a read that finds another UID than the one shown updates the status', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const a = svc.getStatus().card!;
    // swap behind the backend's back (no event at all)
    const r = f.map.get(PASORI)!;
    const tag = await makeTag('NTAG213');
    r.tag = tag.sim;
    r.atr = tag.atr;
    const img = await svc.readTag({});
    expect(img.kind).toBe('NTAG213');
    expect(svc.getStatus().card).toMatchObject({ uid: img.uid, kind: 'NTAG213' });
    expect(img.uid).not.toBe(a.uid);
  });
});

describe('FeliCa identification (CARD-12)', () => {
  it('a Lite-S on a storage reader is identified by its system code', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'FELICA_LITE_S');
    await settle();
    expect(svc.getStatus().card).toMatchObject({ kind: 'FELICA_LITE_S', driver: 'storage' });
    // SYS_C is read with FF B0 00 85 10
    expect(f.sentTo(PASORI)).toContain('FFB0008510');
    const img = await svc.readTag({});
    expect(img.unitStatus.every((s) => s === 'ok')).toBe(true);
  });

  it('another FeliCa product (e.g. a transit card) is unsupported, not "Lite-S"', async () => {
    const f = devPcLayout();
    await startService(f);
    const idm = hexToBytes('0114B3A1C2D3E4F5');
    f.placeRaw(PASORI, FELICA_ATR, (apdu) =>
      apdu[0] === 0xff && apdu[1] === 0xca ? Uint8Array.from([...idm, 0x90, 0x00]) : Uint8Array.from([0x6a, 0x81]),
    );
    await settle(IDENTIFY_SETTLE_MS + IDENTIFY_RETRY_MS.reduce((a, b) => a + b, 0) + 100);
    expect(svc.getStatus()).toMatchObject({ cardState: 'unsupported', cardError: 'UNSUPPORTED_TAG', card: { kind: null, uid: bytesToHex(idm) } });
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'UNSUPPORTED_TAG' });
  });
});

describe('service state (CARD-8)', () => {
  it('"service down because no reader is connected" is reported as no-readers', async () => {
    const f = new FakePcsc();
    await startService(f);
    f.listener?.({ type: 'service', state: 'unavailable', message: 'PC/SC service unavailable (SCARD_E_NO_SERVICE)', noReaders: true });
    expect(svc.getStatus()).toMatchObject({ service: 'no-readers', cardState: 'no-reader' });
    f.listener?.({ type: 'service', state: 'unavailable', message: 'PC/SC library unavailable: x' });
    expect(svc.getStatus().service).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// 2026-11-12 adversarial review, round 2 (R-MAIN-3/4/5/6/7, R-UX-1, R-WRITE-2)
// ---------------------------------------------------------------------------

/** PC/SC Part 3 storage ATR of an NFC Forum Type 2 tag (card name 0x0003). */
const TYPE2_ATR = hexToBytes('3B8F8001804F0CA0000003060300030000000068');
/** PC/SC Part 3 ATR of an ISO/IEC 14443-4 card (e.g. a DESFire / bank card / phone). */
const ISO4_ATR = hexToBytes('3B8180018080');
const UID7 = hexToBytes('04112233445566');

/**
 * Wrap the PaSoRi's connections: an optional per-APDU delay (the event loop is
 * free meanwhile, as with the real backend's yields), and "after N APDUs, answer
 * only `lostSw`" (a tag that left while the reader still answers with a status
 * word instead of a removed-card rv).
 */
function wrap(f: FakePcsc, opts: { delayMs?: number; lostAfter?: number | null; lostSw?: number[]; onlyWhen?: (apdu: Uint8Array) => boolean }) {
  const orig = f.connect.bind(f);
  const ctl = { count: 0, delayMs: opts.delayMs ?? 0, lostAfter: opts.lostAfter ?? null, lostSw: opts.lostSw ?? [0x63, 0x00] };
  f.connect = async (name: string) => {
    const c = await orig(name);
    if (name !== PASORI) return c;
    return {
      readerName: c.readerName,
      atr: c.atr,
      async transmit(apdu: Uint8Array) {
        if (ctl.delayMs > 0) await new Promise((r) => setTimeout(r, ctl.delayMs));
        ctl.count++;
        if (ctl.lostAfter !== null && ctl.count > ctl.lostAfter && (!opts.onlyWhen || opts.onlyWhen(apdu))) {
          f.apdus.push({ reader: name, apdu: bytesToHex(apdu) + '(lost)' });
          return Uint8Array.from(ctl.lostSw);
        }
        return c.transmit(apdu);
      },
      disconnect: () => c.disconnect(),
    };
  };
  return ctl;
}

const ALL_TRIES_MS = IDENTIFY_SETTLE_MS + IDENTIFY_RETRY_MS.reduce((a, b) => a + b, 0) + 100;

describe('identification that cannot confirm the kind is an error with a reason, not "unsupported" (R-MAIN-4)', () => {
  it('NTAG whose CC is read-protected on a storage reader (63 00): error ACCESS_DENIED, UID kept, logged', async () => {
    const f = devPcLayout();
    await startService(f);
    f.placeRaw(PASORI, TYPE2_ATR, (apdu) =>
      apdu[0] === 0xff && apdu[1] === 0xca ? Uint8Array.from([...UID7, 0x90, 0x00]) : Uint8Array.from([0x63, 0x00]),
    );
    await settle(ALL_TRIES_MS);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'ACCESS_DENIED', card: { uid: bytesToHex(UID7), kind: null } });
    expect(logs.some((l) => l.includes(PASORI) && l.includes('ACCESS_DENIED'))).toBe(true);
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // still not "unsupported" after the slow re-checks
    await settle(IDENTIFY_SLOW_RETRY_MS.reduce((a, b) => a + b, 0) + 100);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'ACCESS_DENIED' });
  });

  it('a real NTAG215 at the edge of the field (FF CA ok, FF B0 6F 00): error READ_FAILED, UID kept', async () => {
    const f = devPcLayout();
    await startService(f);
    wrap(f, { lostAfter: 0, lostSw: [0x6f, 0x00], onlyWhen: (a) => a[1] === 0xb0 });
    const sim = await f.place(PASORI, 'NTAG215');
    await settle(ALL_TRIES_MS);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'READ_FAILED', card: { uid: sim.state.uid, kind: null } });
  });

  it('an error tag is not handed to waitForCard (issue mode keeps waiting; the UI shows the reason)', async () => {
    const f = devPcLayout();
    await startService(f);
    f.placeRaw(PASORI, TYPE2_ATR, (apdu) =>
      apdu[0] === 0xff && apdu[1] === 0xca ? Uint8Array.from([...UID7, 0x90, 0x00]) : Uint8Array.from([0x63, 0x00]),
    );
    const got = vi.fn();
    const ac = new AbortController();
    void svc.waitForCard(ac.signal).then(got, () => undefined);
    await settle(ALL_TRIES_MS);
    expect(got).not.toHaveBeenCalled();
    ac.abort();
  });

  it('an ISO 14443-4 card (no Type 2 tag) is still "unsupported" after the retries', async () => {
    const f = devPcLayout();
    await startService(f);
    const uid = hexToBytes('08A1B2C3');
    f.placeRaw(PASORI, ISO4_ATR, (apdu) =>
      apdu[0] === 0xff && apdu[1] === 0xca ? Uint8Array.from([...uid, 0x90, 0x00]) : Uint8Array.from([0x6a, 0x81]),
    );
    await settle(IDENTIFY_SETTLE_MS + 50);
    expect(svc.getStatus().cardState).toBe('detecting'); // "probably unsupported" is retried first
    await settle(ALL_TRIES_MS);
    expect(svc.getStatus()).toMatchObject({ cardState: 'unsupported', cardError: 'UNSUPPORTED_TAG', card: { uid: bytesToHex(uid), kind: null } });
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'UNSUPPORTED_TAG' });
  });

  it('a FeliCa card that gives no usable answer (transport failure) is a read error, not "unsupported"', async () => {
    const f = devPcLayout();
    await startService(f);
    const idm = hexToBytes('0114B3A1C2D3E4F5');
    f.placeRaw(PASORI, FELICA_ATR, (apdu) => {
      if (apdu[0] === 0xff && apdu[1] === 0xca) return Uint8Array.from([...idm, 0x90, 0x00]);
      throw new OpError('READ_FAILED', 'SCARD_F_COMM_ERROR');
    });
    await settle(ALL_TRIES_MS);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'READ_FAILED', card: { uid: bytesToHex(idm), kind: null } });
  });

  it('atrSaysNotType2: only ATRs that name another family', () => {
    expect(atrSaysNotType2(TYPE2_ATR)).toBe(false);
    expect(atrSaysNotType2(new Uint8Array(0))).toBe(false);
    expect(atrSaysNotType2(TOKEN_ATR)).toBe(false);
    expect(atrSaysNotType2(ISO4_ATR)).toBe(true);
    // storage ATR with standard 0x07 (ISO 14443 B part 3)
    expect(atrSaysNotType2(hexToBytes('3B8F8001804F0CA0000003060700000000000000'))).toBe(true);
  });
});

describe('a tag that leaves while a storage reader answers 63 00 (R-MAIN-3)', () => {
  it('NTAG read: rejects CARD_REMOVED (not an image with "password" pages)', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    wrap(f, { lostAfter: 12 }); // getUid + CC + 10 chunks, then the tag is gone
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'CARD_REMOVED' });
    // stopped at the first refusal (+ the presence probe), not 24 more APDUs to nothing
    expect(f.sentTo(PASORI).filter((a) => a.endsWith('(lost)')).length).toBeLessThanOrEqual(4);
  });

  it('NTAG write: stops at once - aborted CARD_REMOVED, the untried pages listed', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const card = svc.getStatus().card!;
    wrap(f, { lostAfter: 2 + 3 });
    const writes = Array.from({ length: 10 }, (_, i) => u(4 + i, '0A0B0C0D'));
    const res = await svc.writeTag({ kind: 'NTAG215', expectedUid: card.uid, writes, allowProtected: false, verify: true });
    expect(res).toMatchObject({
      written: [4, 5, 6],
      failed: [{ unit: 7, error: 'CARD_REMOVED' }],
      aborted: 'CARD_REMOVED',
      notAttempted: [8, 9, 10, 11, 12, 13],
      verified: false,
    });
  });

  it('MIFARE read: rejects CARD_REMOVED (not "key needed" sectors)', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'MIFARE_CLASSIC_1K');
    await settle();
    let n = 0;
    const orig = f.connect.bind(f);
    f.connect = async (name: string) => {
      const c = await orig(name);
      return {
        readerName: c.readerName,
        atr: c.atr,
        async transmit(a: Uint8Array) {
          n++;
          // FF 82 (load key) is the reader's own command: 90 00 even without a tag
          if (n > 40) return a[1] === 0x82 ? Uint8Array.from([0x90, 0x00]) : Uint8Array.from([0x63, 0x00]);
          return c.transmit(a);
        },
        disconnect: () => c.disconnect(),
      };
    };
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'CARD_REMOVED' });
  });

  it('a really password-protected NTAG still reads with its protected pages "denied" (no false removal)', async () => {
    const f = devPcLayout();
    await startService(f);
    const sim = await f.place(PASORI, 'NTAG215');
    const p = ntagPages('NTAG215');
    // PWD, PROT (read protection), AUTH0 = 16 - stored on the tag (latched at the next session)
    sim.tag!.image.set(hexToBytes('12345678'), p.pwd * 4);
    sim.tag!.image[p.cfg1 * 4] |= 0x80;
    sim.tag!.image[p.cfg0 * 4 + 3] = 16;
    await settle();
    const img = await svc.readTag({});
    expect(img.unitStatus.slice(0, 16).every((s) => s === 'ok')).toBe(true);
    expect(img.unitStatus.slice(16).every((s) => s === 'denied')).toBe(true);
    // a write into the protected area is refused page by page, not "removed"
    const res = await svc.writeTag({
      kind: 'NTAG215',
      expectedUid: img.uid,
      writes: [u(15, '01020304'), u(16, '01020304'), u(17, '01020304')],
      allowProtected: false,
      verify: true,
    });
    expect(res).toMatchObject({ written: [15], failed: [{ unit: 16, error: 'ACCESS_DENIED' }, { unit: 17, error: 'ACCESS_DENIED' }], aborted: null, notAttempted: [] });
  });

  it('a MIFARE card with some sectors under an unknown key still reads (those sectors "denied")', async () => {
    const f = devPcLayout();
    await startService(f);
    const sim = await f.place(PASORI, 'MIFARE_CLASSIC_1K');
    // sectors 5 and 9: another Key A / Key B
    for (const s of [5, 9]) {
      const t = (s * 4 + 3) * 16;
      sim.tag!.image.set(hexToBytes('A1A2A3A4A5A6'), t);
      sim.tag!.image.set(hexToBytes('B1B2B3B4B5B6'), t + 10);
    }
    await settle();
    const img = await svc.readTag({});
    const denied = img.mifare!.sectors.filter((s) => s.keyType === null).map((s) => s.sector);
    expect(denied).toEqual([5, 9]);
  });
});

describe('a setting changed during a long read is not undone by the read (R-MAIN-5)', () => {
  function slowLink(f: FakePcsc): void {
    const orig = f.connect.bind(f);
    f.connect = async (name: string) => {
      const c = await orig(name);
      return {
        readerName: c.readerName,
        atr: c.atr,
        async transmit(a: Uint8Array) {
          await new Promise((r) => setTimeout(r, 10));
          return c.transmit(a);
        },
        disconnect: () => c.disconnect(),
      };
    };
  }

  it('setDriverMode mid-read: the status ends with the new driver', async () => {
    const f = devPcLayout();
    f.add(ACR);
    await startService(f);
    slowLink(f);
    await f.place(ACR, 'NTAG215');
    await settle(1000);
    expect(svc.getStatus().card).toMatchObject({ readerName: ACR, driver: 'acr122' });
    const p = svc.readTag({});
    await vi.advanceTimersByTimeAsync(50);
    await svc.setDriverMode('storage');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    await vi.advanceTimersByTimeAsync(3000);
    expect(svc.getStatus()).toMatchObject({ driverMode: 'storage', card: { driver: 'storage', rawCommands: false } });
  });

  it('setManualKind mid-read: the status ends with the manual kind', async () => {
    const f = devPcLayout();
    f.add(ACR);
    await startService(f);
    slowLink(f);
    await f.place(ACR, 'NTAG215');
    await settle(1000);
    const p = svc.readTag({});
    await vi.advanceTimersByTimeAsync(50);
    await svc.setManualKind('NTAG216');
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    await vi.advanceTimersByTimeAsync(3000);
    expect(svc.getStatus().card).toMatchObject({ kind: 'NTAG216', kindSource: 'manual' });
  });
});

describe('reidentify() waits for the identification it asked for (R-MAIN-6)', () => {
  it('refreshReaders + reidentify on a tag in error: resolves only once the result is known', async () => {
    const f = devPcLayout();
    await startService(f);
    f.failNext.set(PASORI, ['CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE']);
    await f.place(PASORI, 'NTAG215');
    await settle(ALL_TRIES_MS);
    expect(svc.getStatus().cardState).toBe('error');
    wrap(f, { delayMs: 30 });
    await svc.refreshReaders(); // retryFailed -> attempt #1 (slow link)
    await vi.advanceTimersByTimeAsync(1);
    let done = false;
    const p = svc.reidentify().then(() => {
      done = true;
    });
    for (let t = 0; t < 2000 && !done; t += 5) await vi.advanceTimersByTimeAsync(5);
    const at = svc.getStatus().cardState;
    await p;
    expect(done).toBe(true);
    expect(at).toBe('ready');
  });
});

describe('a tag that starts answering later is picked up without a click (R-MAIN-7)', () => {
  it('error (not answering) -> slid into place -> ready by the slow re-check, no presence change needed', async () => {
    const f = devPcLayout();
    await startService(f);
    f.failNext.set(PASORI, ['CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE']);
    await f.place(PASORI, 'NTAG215');
    await settle(ALL_TRIES_MS);
    expect(svc.getStatus()).toMatchObject({ cardState: 'error', cardError: 'CARD_UNRESPONSIVE' });
    const busyBefore = seen.filter((s) => s.busy?.op === 'identify').length;
    await settle(IDENTIFY_SLOW_RETRY_MS[0] + 50);
    expect(svc.getStatus()).toMatchObject({ cardState: 'ready', card: { kind: 'NTAG215' } });
    // quiet: no "identifying" flash in the status while re-checking in the background
    expect(seen.filter((s) => s.busy?.op === 'identify').length).toBe(busyBefore);
  });

  it('no slow re-check for a tag that is definitively unsupported, nor once the tag left', async () => {
    const f = devPcLayout();
    await startService(f);
    f.failNext.set(PASORI, ['UNSUPPORTED_TAG']);
    await f.place(PASORI, 'NTAG215');
    await settle(ALL_TRIES_MS + 20_000);
    expect(svc.getStatus().cardState).toBe('unsupported');
    expect(f.connects.filter((n) => n === PASORI)).toHaveLength(1);

    f.lift(PASORI);
    f.failNext.set(PASORI, ['CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE', 'CARD_UNRESPONSIVE']);
    await f.place(PASORI, 'NTAG215');
    await settle(ALL_TRIES_MS);
    const n = f.connects.length;
    f.lift(PASORI);
    await settle(30_000);
    expect(f.connects.length).toBe(n);
  });
});

describe('a password on a storage reader is refused, never skipped silently (D11, R-UX-1)', () => {
  it('readTag with ntagPassword on the PaSoRi: READER_NO_AUTH', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    await expect(svc.readTag({ ntagPassword: '12345678' })).rejects.toMatchObject({ code: 'READER_NO_AUTH' });
    // an empty password is "no password"
    await expect(svc.readTag({ ntagPassword: '' })).resolves.toMatchObject({ kind: 'NTAG215' });
  });

  it('writeTag with ntagPassword on the PaSoRi: READER_NO_AUTH before any APDU', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG215');
    await settle();
    const card = svc.getStatus().card!;
    const connects = f.connects.length;
    const sent = f.apdus.length;
    await expect(
      svc.writeTag({ kind: 'NTAG215', expectedUid: card.uid, writes: [u(4, '01020304')], allowProtected: false, verify: true, ntagPassword: '12345678' }),
    ).rejects.toMatchObject({ code: 'READER_NO_AUTH' });
    expect(f.connects.length).toBe(connects);
    expect(f.apdus.length).toBe(sent);
  });

  it('a password setup issued on the PaSoRi (verify always on) is reported as verified (R-WRITE-2)', async () => {
    const f = devPcLayout();
    await startService(f);
    await f.place(PASORI, 'NTAG213');
    await settle();
    const img = await svc.readTag({});
    const p = ntagPages('NTAG213');
    const writes = buildNtagPasswordWrites('NTAG213', img.data, { password: '12345678', pack: 'ABCD', auth0: 4, protectRead: true, authLimit: 0 });
    const res = await svc.writeTag({ kind: 'NTAG213', expectedUid: img.uid, writes: [u(4, '01020304'), ...writes], allowProtected: true, verify: true });
    expect(res).toMatchObject({ written: [4, p.pwd, p.pack, p.cfg1, p.cfg0], failed: [], verified: true, mismatched: [], aborted: null });
  });
});

describe('activeDriver: the transport of the active reader, known with no tag (D11)', () => {
  it('a PaSoRi with no tag reports storage; the virtual reader reports acr122', async () => {
    const f = devPcLayout();
    await startService(f);
    await settle();
    expect(svc.getStatus()).toMatchObject({ activeReader: PASORI, cardState: 'absent', card: null, activeDriver: 'storage' });

    await svc.setSimulator({ enabled: true, kind: 'NTAG215' });
    await svc.simulatorTap(true);
    await settle();
    expect(svc.getStatus()).toMatchObject({ activeReader: VIRTUAL_READER_NAME, activeDriver: 'acr122' });
  });
});
