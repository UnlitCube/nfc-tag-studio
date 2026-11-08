// PC/SC backend tests.
//
// Two layers:
//  1. Construction-level checks that need no reader (createPcscBackend must never
//     throw synchronously, and its synchronous surface is safe anywhere).
//  2. Loop-level checks that drive start() -> pollOnce -> diffPresence with a fake
//     Winscard injected via vi.mock('./winscard'). The native library (koffi ->
//     winscard.dll) is never loaded here; only ./pure.ts and the state machine in
//     ./index.ts run. These guard the parts the integrator previously had to
//     verify by hand on real hardware: card insert/remove diffing, the service
//     state transitions, and recovery after the context is invalidated.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPcscBackend } from '../src/main/nfc/pcsc';
import type { BackendEvent, ReaderBackend } from '../src/main/nfc/backend';
import type { Handle, ReaderState, Winscard } from '../src/main/nfc/pcsc/winscard';
import {
  SCARD_S_SUCCESS,
  SCARD_E_NO_SERVICE,
  SCARD_E_INVALID_HANDLE,
  SCARD_STATE_PRESENT,
  SCARD_STATE_EMPTY,
  SCARD_STATE_CHANGED,
} from '../src/main/nfc/pcsc/pure';

// ---------------------------------------------------------------------------
// Fake native binding, injected in place of ./winscard (so koffi never loads).
// ---------------------------------------------------------------------------

const hoist = vi.hoisted(() => ({ winscard: null as Winscard | null }));

vi.mock('../src/main/nfc/pcsc/winscard', () => ({
  loadWinscard: (): Winscard => {
    if (!hoist.winscard) throw new Error('fake winscard not configured');
    return hoist.winscard;
  },
}));

/**
 * A programmable, hardware-free Winscard. Tests mutate its public fields between
 * polls (reader list, which readers hold a card, and the return code each call
 * yields) and then drive one poll with `poll()`.
 */
class FakeWinscard implements Winscard {
  establishCount = 0;
  releaseCount = 0;
  cancelCount = 0;

  establishRv: number = SCARD_S_SUCCESS;
  listRv: number = SCARD_S_SUCCESS;
  statusRv: number = SCARD_S_SUCCESS;

  readerNames: string[] = [];
  /** name -> ATR when a card is present on that reader. */
  private readonly cards = new Map<string, Uint8Array>();

  /** Put a card (with ATR) on a reader, or clear it with null. */
  setCard(name: string, atr: Uint8Array | null): void {
    if (atr) this.cards.set(name, atr);
    else this.cards.delete(name);
  }

  establishContext(): { rv: number; ctx: Handle } {
    this.establishCount++;
    if (this.establishRv !== SCARD_S_SUCCESS) return { rv: this.establishRv, ctx: 0 };
    return { rv: SCARD_S_SUCCESS, ctx: 1 };
  }

  releaseContext(_ctx: Handle): number {
    this.releaseCount++;
    return SCARD_S_SUCCESS;
  }

  cancel(_ctx: Handle): number {
    this.cancelCount++;
    return SCARD_S_SUCCESS;
  }

  listReaders(_ctx: Handle): { rv: number; names: string[] } {
    // Mirror the real binding: a non-zero rv yields an empty name list.
    if (this.listRv !== SCARD_S_SUCCESS) return { rv: this.listRv, names: [] };
    return { rv: SCARD_S_SUCCESS, names: [...this.readerNames] };
  }

  getStatusChange(_ctx: Handle, _timeoutMs: number, names: string[]): { rv: number; states: ReaderState[] } {
    if (this.statusRv !== SCARD_S_SUCCESS) {
      // The real binding returns states regardless of rv (eventState left 0),
      // which is exactly why index.ts must not trust them on a non-ok rv.
      return {
        rv: this.statusRv,
        states: names.map((name) => ({ name, eventState: 0, atr: new Uint8Array(0) })),
      };
    }
    const states: ReaderState[] = names.map((name) => {
      const atr = this.cards.get(name);
      const present = atr != null;
      const eventState = (present ? SCARD_STATE_PRESENT : SCARD_STATE_EMPTY) | SCARD_STATE_CHANGED;
      return { name, eventState, atr: present ? atr : new Uint8Array(0) };
    });
    return { rv: SCARD_S_SUCCESS, states };
  }

  connect(_ctx: Handle, _reader: string): { rv: number; hCard: Handle; activeProtocol: number } {
    return { rv: SCARD_S_SUCCESS, hCard: 1, activeProtocol: 2 };
  }

  transmit(_hCard: Handle, _apdu: Uint8Array, _proto: number): { rv: number; resp: Uint8Array } {
    return { rv: SCARD_S_SUCCESS, resp: new Uint8Array([0x90, 0x00]) };
  }

  disconnect(_hCard: Handle, _disposition?: number): number {
    return SCARD_S_SUCCESS;
  }

  unload(): void {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Construction-level checks (no reader, start() not called).
// ---------------------------------------------------------------------------

describe('createPcscBackend (no hardware)', () => {
  it('constructs without throwing and exposes the frozen surface', () => {
    const lines: string[] = [];
    const backend = createPcscBackend((l) => lines.push(l));
    expect(backend.id).toBe('pcsc');
    expect(typeof backend.start).toBe('function');
    expect(typeof backend.stop).toBe('function');
    expect(typeof backend.refresh).toBe('function');
    expect(typeof backend.connect).toBe('function');
    // No reader list until start() has polled.
    expect(backend.readers()).toEqual([]);
  });

  it('stop() before start() resolves without throwing', async () => {
    const backend = createPcscBackend(() => undefined);
    await expect(backend.stop()).resolves.toBeUndefined();
    await expect(backend.refresh()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Loop-level checks (fake Winscard injected; start() drives real pollOnce).
// ---------------------------------------------------------------------------

function events<T extends BackendEvent['type']>(
  evs: BackendEvent[],
  type: T,
): Extract<BackendEvent, { type: T }>[] {
  return evs.filter((e): e is Extract<BackendEvent, { type: T }> => e.type === type);
}

describe('createPcscBackend (fake Winscard loop)', () => {
  const READER = 'ACS ACR122U PICC Interface 0';
  let backend: ReaderBackend;
  let fake: FakeWinscard;
  let captured: BackendEvent[];

  beforeEach(() => {
    // Fake timers so the poll loop's setTimeout never fires on its own; polls are
    // driven deterministically through refresh() (which wakes the delay).
    vi.useFakeTimers();
    fake = new FakeWinscard();
    hoist.winscard = fake;
    captured = [];
    backend = createPcscBackend(() => undefined);
  });

  afterEach(async () => {
    await backend.stop();
    hoist.winscard = null;
    vi.useRealTimers();
  });

  /** Start monitoring; the first poll has run and emitted by the time this returns. */
  async function begin(): Promise<void> {
    await backend.start((e) => captured.push(e));
    await Promise.resolve();
  }

  /** Drive exactly one more poll, then let the loop re-park in its delay. */
  async function poll(): Promise<void> {
    await backend.refresh();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('start() with a card already present emits service ok, the reader list, and card-inserted', async () => {
    const atr = new Uint8Array([0x3b, 0x8f, 0x80, 0x01, 0x80, 0x4f, 0x0c, 0xa0]);
    fake.readerNames = [READER];
    fake.setCard(READER, atr);

    await begin();

    expect(events(captured, 'service').at(-1)).toMatchObject({ state: 'ok', message: null });
    expect(events(captured, 'readers').at(-1)?.readers.map((r) => r.name)).toEqual([READER]);

    const inserted = events(captured, 'card-inserted');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].reader).toBe(READER);
    expect(Array.from(inserted[0].atr)).toEqual(Array.from(atr));
  });

  it('diffs a card insertion then removal into card-inserted / card-removed', async () => {
    fake.readerNames = [READER];
    fake.setCard(READER, null); // reader present, no card

    await begin();
    expect(events(captured, 'card-inserted')).toHaveLength(0);
    expect(events(captured, 'card-removed')).toHaveLength(0);

    captured.length = 0;
    fake.setCard(READER, new Uint8Array([0x3b, 0x8f, 0x80, 0x01]));
    await poll();
    expect(events(captured, 'card-inserted').map((e) => e.reader)).toEqual([READER]);
    expect(events(captured, 'card-removed')).toHaveLength(0);

    captured.length = 0;
    fake.setCard(READER, null);
    await poll();
    expect(events(captured, 'card-removed').map((e) => e.reader)).toEqual([READER]);
    expect(events(captured, 'card-inserted')).toHaveLength(0);
  });

  it('recovers from a PC/SC "service unavailable" return and re-emits the reader list', async () => {
    fake.readerNames = [READER];
    fake.setCard(READER, null);

    await begin();
    const establishAfterStart = fake.establishCount;
    captured.length = 0;

    // Service goes away: listReaders returns SCARD_E_NO_SERVICE.
    fake.listRv = SCARD_E_NO_SERVICE;
    await poll();
    expect(events(captured, 'service').some((e) => e.state === 'unavailable')).toBe(true);

    // Service comes back.
    fake.listRv = SCARD_S_SUCCESS;
    await poll();
    expect(events(captured, 'service').at(-1)).toMatchObject({ state: 'ok' });
    // The context was torn down, so the reader list is re-emitted on recovery...
    expect(events(captured, 'readers').some((e) => e.readers.some((r) => r.name === READER))).toBe(true);
    // ...which means establishContext ran again.
    expect(fake.establishCount).toBeGreaterThan(establishAfterStart);
  });

  it('recovers when listReaders returns a context-fatal rv (SCARD_E_INVALID_HANDLE) [regression]', async () => {
    // Regression for the bug where a non-ok, non-NO_READERS listReaders rv was
    // logged and ignored: the stale context was never torn down, so the backend
    // sat forever on "service ok / 0 readers" and never re-established.
    fake.readerNames = [READER];
    fake.setCard(READER, null);

    await begin();
    expect(fake.establishCount).toBe(1);
    expect(fake.releaseCount).toBe(0);
    captured.length = 0;

    // The context goes invalid under us.
    fake.listRv = SCARD_E_INVALID_HANDLE;
    await poll();
    // The fix: the context is dropped (released) and the error surfaced, instead
    // of silently reporting "ok" with an empty reader list.
    expect(fake.releaseCount).toBeGreaterThanOrEqual(1);
    expect(events(captured, 'service').some((e) => e.state === 'error')).toBe(true);

    // Next poll re-establishes from scratch and the reader comes back.
    fake.listRv = SCARD_S_SUCCESS;
    await poll();
    expect(fake.establishCount).toBeGreaterThanOrEqual(2);
    expect(events(captured, 'readers').at(-1)?.readers.map((r) => r.name)).toEqual([READER]);
    expect(events(captured, 'service').at(-1)).toMatchObject({ state: 'ok' });
  });

  it('recovers when getStatusChange returns a context-fatal rv [regression]', async () => {
    // The same teardown-and-rebuild must happen on the getStatusChange branch;
    // otherwise the states it returns (eventState 0 regardless of rv) would be
    // read as "every reader empty" and fire spurious card-removed events.
    const atr = new Uint8Array([0x3b, 0x8f, 0x80, 0x01]);
    fake.readerNames = [READER];
    fake.setCard(READER, atr);

    await begin();
    expect(events(captured, 'card-inserted')).toHaveLength(1);
    const establishAfterStart = fake.establishCount;
    const releaseAfterStart = fake.releaseCount;
    captured.length = 0;

    fake.statusRv = SCARD_E_INVALID_HANDLE;
    await poll();
    expect(fake.releaseCount).toBeGreaterThan(releaseAfterStart);
    expect(events(captured, 'service').some((e) => e.state === 'error')).toBe(true);
    // The bogus "empty" states must NOT be turned into a card-removed.
    expect(events(captured, 'card-removed')).toHaveLength(0);

    fake.statusRv = SCARD_S_SUCCESS;
    await poll();
    expect(fake.establishCount).toBeGreaterThan(establishAfterStart);
    expect(events(captured, 'service').at(-1)).toMatchObject({ state: 'ok' });
  });

  it('keeps "no readers" (SCARD_E_NO_READERS_AVAILABLE) as a benign empty list, not a teardown', async () => {
    fake.readerNames = [READER];
    fake.setCard(READER, null);
    await begin();
    const establishAfterStart = fake.establishCount;
    captured.length = 0;

    // All readers unplugged -> the real binding returns NO_READERS with names=[].
    fake.listRv = 0x8010002e; // SCARD_E_NO_READERS_AVAILABLE
    await poll();

    // Service stays ok, reader list becomes empty, and the context is NOT dropped.
    expect(events(captured, 'service').every((e) => e.state === 'ok')).toBe(true);
    expect(events(captured, 'readers').at(-1)?.readers).toEqual([]);
    expect(fake.establishCount).toBe(establishAfterStart);
    expect(fake.releaseCount).toBe(0);
  });
});
