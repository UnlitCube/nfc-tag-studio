// The real PC/SC backend (PcscConnection, poll loop) and the real NfcService over
// a fake Winscard: koffi / winscard.dll never load and no APDU reaches hardware.
// Regression tests for the 2026-11-12 adversarial review (round 2):
//   R-MAIN-2  closing the app mid-write waits for the write (no half-written tag)
//   R-MAIN-8  a connection whose card left is still SCardDisconnect-ed (no handle leak)

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, ReaderState, Winscard } from '../src/main/nfc/pcsc/winscard';
import { SCARD_S_SUCCESS, SCARD_STATE_CHANGED, SCARD_STATE_EMPTY, SCARD_STATE_PRESENT, SCARD_W_REMOVED_CARD } from '../src/main/nfc/pcsc/pure';
import { hexToBytes } from '../src/shared/hex';

const hoist = vi.hoisted(() => ({ winscard: null as unknown }));
vi.mock('../src/main/nfc/pcsc/winscard', () => ({
  loadWinscard: () => {
    if (!hoist.winscard) throw new Error('fake winscard not configured');
    return hoist.winscard;
  },
}));

import { createPcscBackend } from '../src/main/nfc/pcsc';
import { createNfcService } from '../src/main/nfc/service';

const PASORI = 'Sony FeliCa Port/PaSoRi 3.0 0';
const TYPE2_ATR = hexToBytes('3B8F8001804F0CA0000003060300030000000068');
const UID = [0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];

/** An NTAG215 on a storage reader, answering FF CA / FF B0 / FF D6. */
class FakeWinscard implements Winscard {
  readerNames: string[] = [PASORI];
  atr: Uint8Array | null = TYPE2_ATR;
  transmitDelayMs = 0;
  removedFromNow = false;
  connects = 0;
  disconnects = 0;
  readonly pages = new Map<number, string>();
  establishContext() {
    return { rv: SCARD_S_SUCCESS, ctx: 1 as Handle };
  }
  releaseContext() {
    return SCARD_S_SUCCESS;
  }
  cancel() {
    return SCARD_S_SUCCESS;
  }
  listReaders() {
    return { rv: SCARD_S_SUCCESS, names: [...this.readerNames] };
  }
  getStatusChange(_c: Handle, _t: number, names: string[]): { rv: number; states: ReaderState[] } {
    return {
      rv: SCARD_S_SUCCESS,
      states: names.map((name) => {
        const present = this.atr !== null;
        return {
          name,
          eventState: ((present ? SCARD_STATE_PRESENT : SCARD_STATE_EMPTY) | SCARD_STATE_CHANGED) >>> 0,
          atr: present ? this.atr! : new Uint8Array(0),
        };
      }),
    };
  }
  connect() {
    this.connects++;
    return { rv: SCARD_S_SUCCESS, hCard: 7 as Handle, activeProtocol: 2 };
  }
  transmit(_h: Handle, apdu: Uint8Array) {
    if (this.transmitDelayMs > 0) {
      const end = Date.now() + this.transmitDelayMs;
      while (Date.now() < end) {
        // a blocking native call
      }
    }
    if (this.removedFromNow) return { rv: SCARD_W_REMOVED_CARD, resp: new Uint8Array(0) };
    if (apdu[1] === 0xca) return { rv: 0, resp: Uint8Array.from([...UID, 0x90, 0x00]) };
    if (apdu[1] === 0xb0) {
      const out = new Uint8Array(16);
      if (apdu[3] === 3) out.set([0xe1, 0x10, 0x3e, 0x00]); // NTAG215 CC
      return { rv: 0, resp: Uint8Array.from([...out, 0x90, 0x00]) };
    }
    if (apdu[1] === 0xd6) {
      this.pages.set(apdu[3], Buffer.from(apdu.subarray(5)).toString('hex'));
      return { rv: 0, resp: Uint8Array.from([0x90, 0x00]) };
    }
    return { rv: 0, resp: Uint8Array.from([0x6a, 0x81]) };
  }
  disconnect() {
    this.disconnects++;
    return SCARD_S_SUCCESS;
  }
  unload() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deps = () => ({ resolveKeys: () => [], allKeyIds: () => [], log: () => undefined, isAdvancedMode: () => false });

afterEach(() => {
  hoist.winscard = null;
});

describe('a connection whose card left is still released (R-MAIN-8)', () => {
  it('disconnect() after SCARD_W_REMOVED_CARD calls SCardDisconnect once', async () => {
    const fake = new FakeWinscard();
    hoist.winscard = fake;
    const b = createPcscBackend(() => undefined);
    await b.start(() => undefined);
    await sleep(10);
    const c = await b.connect(PASORI);
    fake.removedFromNow = true;
    await expect(c.transmit(Uint8Array.from([0xff, 0xca, 0, 0, 0]))).rejects.toMatchObject({ code: 'CARD_REMOVED' });
    // no further APDU goes out on that handle
    await expect(c.transmit(Uint8Array.from([0xff, 0xca, 0, 0, 0]))).rejects.toMatchObject({ code: 'CARD_REMOVED' });
    await c.disconnect();
    await c.disconnect(); // idempotent
    await b.stop();
    expect(fake.connects).toBe(1);
    expect(fake.disconnects).toBe(1);
  });
});

describe('closing the app mid-write lets the write finish (R-MAIN-2)', () => {
  it('dispose() during a 40-page write waits: every page is written, nothing aborted', async () => {
    const fake = new FakeWinscard();
    hoist.winscard = fake;
    const svc = createNfcService(deps());
    for (let i = 0; i < 100 && svc.getStatus().cardState !== 'ready'; i++) await sleep(20);
    expect(svc.getStatus().cardState).toBe('ready');
    fake.transmitDelayMs = 5;
    const writes = Array.from({ length: 40 }, (_, i) => ({ unit: 4 + i, data: Uint8Array.from([1, 2, 3, i]) }));
    const p = svc.writeTag({ kind: 'NTAG215', expectedUid: '04112233445566', writes, allowProtected: false, verify: false });
    await sleep(60); // the window is closed here, in the middle of the write
    const d = svc.dispose();
    const res = await p;
    await d;
    expect(res).toMatchObject({ aborted: null, failed: [], notAttempted: [] });
    expect(res.written).toHaveLength(40);
    expect(fake.pages.size).toBe(40);
  }, 10_000);

  it('an operation that had not started when dispose() was called is not started (CANCELLED, nothing sent)', async () => {
    const fake = new FakeWinscard();
    hoist.winscard = fake;
    const svc = createNfcService(deps());
    for (let i = 0; i < 100 && svc.getStatus().cardState !== 'ready'; i++) await sleep(20);
    fake.transmitDelayMs = 5;
    const writes = Array.from({ length: 20 }, (_, i) => ({ unit: 4 + i, data: Uint8Array.from([9, 9, 9, i]) }));
    const first = svc.writeTag({ kind: 'NTAG215', expectedUid: '04112233445566', writes, allowProtected: false, verify: false });
    const queued = svc.writeTag({ kind: 'NTAG215', expectedUid: '04112233445566', writes: [{ unit: 30, data: Uint8Array.from([7, 7, 7, 7]) }], allowProtected: false, verify: false });
    await sleep(30);
    const d = svc.dispose();
    await expect(first).resolves.toMatchObject({ aborted: null });
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    await d;
    expect(fake.pages.get(30)).not.toBe('07070707');
  }, 10_000);
});
