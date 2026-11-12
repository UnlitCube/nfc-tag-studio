// PC/SC reader backend (koffi -> winscard.dll / PCSC.framework / libpcsclite.so.1).
// Owner: agent "main-pcsc" / "main-nfc". Signature createPcscBackend(log) is frozen.
//
// This wires the pure helpers (./pure.ts) to the native binding (./winscard.ts)
// into the ReaderBackend contract. It is a dumb APDU pipe: it never writes a UID
// and knows nothing of magic-card backdoors (I1/I2). It must never throw
// synchronously and must keep the app alive when the card service or the native
// library is missing (emit a 'service' event and retry).
//
// It reports presence for EVERY reader (tokens included). Deciding which reader
// may receive APDUs is the service's job (I6): this layer only sends an APDU when
// the service calls connect() / transmit().

import type { BackendEvent, CardConnection, ReaderBackend } from '../backend';
import type { ReaderInfo } from '@shared/types';
import { OpError } from '../../errors';
import { loadWinscard, type Handle, type Winscard } from './winscard';
import {
  cardSwapSuspected,
  eventCountOf,
  isOk,
  isPresent,
  isRemovedCardRv,
  isServiceUnavailableRv,
  isNoReadersRv,
  opErrorForPcsc,
  pcscErrorCode,
  readerInfoFrom,
  readerListEqual,
  rvName,
  normalizeRv,
  serviceDownMeansNoReaders,
  SCARD_E_NO_SMARTCARD,
  SCARD_E_UNKNOWN_READER,
  SCARD_E_READER_UNAVAILABLE,
  SCARD_W_UNRESPONSIVE_CARD,
  effectiveInUse,
} from './pure';

/**
 * 2026-11-12 UX audit CARD-9: 600 ms missed short placements and made the app
 * feel slow to notice a tag. One poll is two cheap non-blocking calls
 * (SCardListReaders + SCardGetStatusChange with timeout 0).
 */
/** After our connection closes, an INUSE flag on that reader is still taken as ours for this long. */
const OWN_INUSE_GRACE_MS = 1000;
const POLL_INTERVAL_MS = 300;
const RETRY_INTERVAL_MS = 3000;
/**
 * The native calls are synchronous; a long read is a chain of already-resolved
 * promises that never returns to the event loop, so the window cannot repaint or
 * move ("not responding", CARD-13). Give the loop a turn this often.
 */
const YIELD_EVERY_MS = 40;

type ServiceState = 'ok' | 'unavailable' | 'error';

interface PrevState {
  present: boolean;
  atr: Uint8Array;
  /** Insertion/removal counter (dwEventState >>> 16), null when unknown. */
  events: number | null;
}

export function createPcscBackend(log: (line: string) => void): ReaderBackend {
  let listener: ((e: BackendEvent) => void) | null = null;
  let running = false;
  let loopDone: Promise<void> = Promise.resolve();

  let native: Winscard | null = null;
  let ctx: Handle | null = null;

  let lastReaders: ReaderInfo[] | null = null;
  let lastService: { state: ServiceState; message: string | null; noReaders: boolean } | null = null;
  let prev = new Map<string, PrevState>();

  const connections = new Set<PcscConnection>();
  /** Readers with one of OUR connections open: their counter is not judged meanwhile. */
  const openCount = new Map<string, number>();
  /** Readers whose next counter value is accepted silently (our own connection just closed). */
  const rebase = new Set<string>();
  /** Until when (epoch ms) an INUSE flag on a reader is still our own doing (just closed). */
  const ownUntil = new Map<string, number>();
  /** Consecutive polls with a foreign INUSE flag, per reader (effectiveInUse). */
  const inUseStreak = new Map<string, number>();

  function ours(name: string): boolean {
    return (openCount.get(name) ?? 0) > 0 || (ownUntil.get(name) ?? 0) > Date.now();
  }

  /** Hide our own (and momentary) INUSE: see effectiveInUse. */
  function withEffectiveInUse(infos: ReaderInfo[]): ReaderInfo[] {
    return infos.map((i) => {
      const r = effectiveInUse(i.inUse, ours(i.name), inUseStreak.get(i.name) ?? 0);
      inUseStreak.set(i.name, r.streak);
      return r.inUse === i.inUse ? i : { ...i, inUse: r.inUse };
    });
  }
  let wake: (() => void) | null = null;

  function emit(e: BackendEvent): void {
    try {
      listener?.(e);
    } catch (err) {
      log(`pcsc: listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function emitService(state: ServiceState, message: string | null, noReaders = false): void {
    if (lastService && lastService.state === state && lastService.message === message && lastService.noReaders === noReaders) return;
    lastService = { state, message, noReaders };
    emit({ type: 'service', state, message, noReaders });
  }

  function emitServiceDown(rv: number, call: string): void {
    if (isServiceUnavailableRv(rv)) {
      emitService('unavailable', `PC/SC service unavailable (${rvName(rv)})`, serviceDownMeansNoReaders(rv, process.platform));
    } else {
      log(`pcsc: ${call} -> ${rvName(rv)} (dropping context)`);
      emitService('error', `${call} failed (${rvName(rv)})`);
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  }

  /**
   * Drop the native context (keeps the library loaded for the next attempt).
   * `lost`: the context died under us (service restart, sleep / resume, USB
   * reset). We can no longer see the readers, so every tag we reported is
   * reported gone and the reader list emptied; the next successful poll reports
   * whatever is really there again (2026-11-12 UX audit CARD-6: before, the
   * service kept showing a tag that had been taken away during the outage).
   */
  function teardownContext(lost: boolean): void {
    if (native && ctx != null) {
      try {
        native.releaseContext(ctx);
      } catch {
        // ignore
      }
    }
    ctx = null;
    const before = prev;
    const hadReaders = !!lastReaders && lastReaders.length > 0;
    prev = new Map();
    lastReaders = null;
    rebase.clear();
    if (!lost) return;
    for (const [name, st] of before) {
      if (st.present) emit({ type: 'card-removed', reader: name });
    }
    if (hadReaders) emit({ type: 'readers', readers: [] });
  }

  function emitReadersIfChanged(infos: ReaderInfo[]): void {
    if (lastReaders && readerListEqual(lastReaders, infos)) return;
    lastReaders = infos;
    emit({ type: 'readers', readers: infos });
  }

  function diffPresence(infos: ReaderInfo[], states: { name: string; eventState: number | null; atr: Uint8Array }[]): void {
    const byName = new Map(states.map((s) => [s.name, s]));
    const next = new Map<string, PrevState>();
    for (const info of infos) {
      const st = byName.get(info.name);
      const atr = st?.atr ?? new Uint8Array(0);
      const events = st && st.eventState !== null ? eventCountOf(st.eventState) : null;
      const before = prev.get(info.name);
      let baseline: PrevState = { present: info.cardPresent, atr, events };
      if (info.cardPresent && (!before || !before.present)) {
        rebase.delete(info.name);
        emit({ type: 'card-inserted', reader: info.name, atr });
      } else if (!info.cardPresent && before && before.present) {
        rebase.delete(info.name);
        emit({ type: 'card-removed', reader: info.name });
      } else if (info.cardPresent && before && before.present) {
        if ((openCount.get(info.name) ?? 0) > 0) {
          // One of our connections is open: whatever the counter does now may be
          // our own doing - keep the old baseline and judge after it closes.
          baseline = before;
        } else if (rebase.delete(info.name)) {
          // Our connection just closed without seeing the card leave: accept.
        } else if (cardSwapSuspected(before, { atr, events })) {
          emit({ type: 'card-changed', reader: info.name, atr });
        }
      }
      next.set(info.name, baseline);
    }
    // Readers that disappeared while holding a card.
    for (const [name, before] of prev) {
      if (!next.has(name) && before.present) {
        emit({ type: 'card-removed', reader: name });
      }
    }
    prev = next;
  }

  async function pollOnce(): Promise<'ok' | 'retry'> {
    if (!native) {
      native = await loadWinscard(); // throws -> caught by loop -> service unavailable
    }
    if (ctx == null) {
      const r = native.establishContext();
      if (!isOk(r.rv)) {
        emitServiceDown(r.rv, 'SCardEstablishContext');
        return 'retry';
      }
      ctx = r.ctx;
    }

    const list = native.listReaders(ctx);
    if (!isOk(list.rv) && !isNoReadersRv(list.rv)) {
      // Non-ok and not "no readers": the context may be invalid (PC/SC service
      // restart, USB reader surprise-removal -> SCARD_E_INVALID_HANDLE, etc.).
      // Drop the context so the next poll rebuilds it from establishContext,
      // instead of looping forever on a dead handle while still reporting
      // "service ok / 0 readers". Only NO_READERS is a benign empty list.
      teardownContext(true);
      emitServiceDown(list.rv, 'SCardListReaders');
      return 'retry';
    }
    const names = list.names;

    let states: { name: string; eventState: number; atr: Uint8Array }[] = [];
    if (names.length > 0) {
      const sc = native.getStatusChange(ctx, 0, names);
      if (!isOk(sc.rv)) {
        // Same reasoning as listReaders: a non-ok status change (e.g. the
        // context went invalid under us) must drop the context and rebuild,
        // never be treated as "every reader is empty" (getStatusChange returns
        // states regardless of rv). The tags we reported are reported gone by
        // the teardown (we cannot see them any more) and re-detected on recovery.
        teardownContext(true);
        emitServiceDown(sc.rv, 'SCardGetStatusChange');
        return 'retry';
      }
      states = sc.states;
    }

    const complete = states.length === names.length;
    const infos: ReaderInfo[] = withEffectiveInUse(
      complete ? states.map((s) => readerInfoFrom(s.name, s.eventState, s.atr)) : names.map((name) => readerInfoFrom(name, 0, null)),
    );

    emitService('ok', null);
    emitReadersIfChanged(infos);
    diffPresence(infos, complete ? states : infos.map((i) => ({ name: i.name, eventState: null, atr: new Uint8Array(0) })));
    return 'ok';
  }

  async function loop(): Promise<void> {
    while (running) {
      let outcome: 'ok' | 'retry' = 'ok';
      try {
        outcome = await pollOnce();
      } catch (err) {
        // Native library missing / failed to load, or an unexpected fault.
        teardownContext(true);
        native = null;
        emitService('unavailable', nativeLoadMessage(err));
        outcome = 'retry';
      }
      if (!running) break;
      await delay(outcome === 'retry' ? RETRY_INTERVAL_MS : POLL_INTERVAL_MS);
    }
    // Final cleanup once the loop stops (no events: the app is shutting down).
    teardownContext(false);
  }

  /** Our connection on `reader` closed: take the reader's current counter as the new baseline. */
  function onConnectionClosed(conn: PcscConnection): void {
    connections.delete(conn);
    const name = conn.readerName;
    // Windows may keep INUSE set briefly after our handle closes: still ours.
    ownUntil.set(name, Date.now() + OWN_INUSE_GRACE_MS);
    const n = (openCount.get(name) ?? 1) - 1;
    if (n > 0) openCount.set(name, n);
    else openCount.delete(name);
    if (n > 0 || conn.lostCard) return; // the card left / stopped answering: let the counter speak
    const p = prev.get(name);
    if (!p || !p.present) return;
    if (native && ctx != null) {
      try {
        const sc = native.getStatusChange(ctx, 0, [name]);
        const st = isOk(sc.rv) ? sc.states.find((s) => s.name === name) : undefined;
        if (st && isPresent(st.eventState)) {
          prev.set(name, { present: true, atr: st.atr.length > 0 ? st.atr : p.atr, events: eventCountOf(st.eventState) });
          return;
        }
      } catch {
        // fall through to the lazy rebase
      }
    }
    rebase.add(name);
  }

  async function connect(readerName: string): Promise<CardConnection> {
    if (!native || ctx == null) {
      throw new OpError('NO_SERVICE');
    }
    const c = native.connect(ctx, readerName);
    if (!isOk(c.rv)) {
      const code = normalizeRv(c.rv);
      if (code === SCARD_E_NO_SMARTCARD) throw new OpError('NO_CARD');
      if (code === SCARD_E_UNKNOWN_READER || code === SCARD_E_READER_UNAVAILABLE) throw new OpError('NO_READER');
      throw new OpError(pcscErrorCode(c.rv), rvName(c.rv));
    }
    // Fetch the ATR for the connected card (fresh, fall back to last known).
    let atr = prev.get(readerName)?.atr ?? new Uint8Array(0);
    try {
      const sc = native.getStatusChange(ctx, 0, [readerName]);
      const st = sc.states.find((s) => s.name === readerName);
      if (st && st.atr.length > 0) atr = st.atr;
    } catch {
      // keep fallback
    }
    openCount.set(readerName, (openCount.get(readerName) ?? 0) + 1);
    const conn = new PcscConnection(native, c.hCard, readerName, atr, c.activeProtocol, onConnectionClosed);
    connections.add(conn);
    return conn;
  }

  return {
    id: 'pcsc',

    async start(l) {
      listener = l;
      if (running) return;
      running = true;
      loopDone = loop();
    },

    async stop() {
      running = false;
      if (wake) wake();
      // Release any open cards first.
      for (const conn of [...connections]) {
        try {
          await conn.disconnect();
        } catch {
          // ignore
        }
      }
      if (native && ctx != null) {
        try {
          native.cancel(ctx);
        } catch {
          // ignore
        }
      }
      await loopDone;
      lastService = null;
      listener = null;
    },

    async refresh() {
      if (wake) wake();
    },

    readers() {
      return lastReaders ?? [];
    },

    connect,
  };
}

function nativeLoadMessage(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  return `PC/SC library unavailable: ${base}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** One connected card. transmit() is serialized; disconnect() is idempotent. */
class PcscConnection implements CardConnection {
  readonly readerName: string;
  readonly atr: Uint8Array;
  /** A transmit saw the card leave / stop answering. */
  lostCard = false;
  /** No more APDUs go out on this handle (the card left, or disconnect() was called). */
  private closed = false;
  /**
   * SCardDisconnect was called. Separate from `closed`: a handle whose card left
   * still has to be released, or every tag lifted mid-operation leaks one card
   * handle for the life of the context (2026-11-12 review R-MAIN-8).
   */
  private released = false;
  private chain: Promise<unknown> = Promise.resolve();
  private lastYield = Date.now();

  constructor(
    private readonly native: Winscard,
    private readonly hCard: Handle,
    readerName: string,
    atr: Uint8Array,
    private readonly activeProtocol: number,
    private readonly onClose: (self: PcscConnection) => void,
  ) {
    this.readerName = readerName;
    this.atr = atr;
  }

  transmit(apdu: Uint8Array): Promise<Uint8Array> {
    const run = this.chain.then(async () => {
      if (Date.now() - this.lastYield >= YIELD_EVERY_MS) {
        await yieldToEventLoop();
        this.lastYield = Date.now();
      }
      return this.doTransmit(apdu);
    });
    // Keep the serialization chain alive even if this call rejects.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private doTransmit(apdu: Uint8Array): Uint8Array {
    if (this.closed) throw new OpError('CARD_REMOVED');
    let result: { rv: number; resp: Uint8Array };
    try {
      result = this.native.transmit(this.hCard, apdu, this.activeProtocol);
    } catch (err) {
      throw new OpError('READ_FAILED', err instanceof Error ? err.message : String(err));
    }
    if (isOk(result.rv)) return result.resp;
    if (isRemovedCardRv(result.rv)) {
      this.closed = true;
      this.lostCard = true;
      throw new OpError('CARD_REMOVED', rvName(result.rv));
    }
    if (normalizeRv(result.rv) === SCARD_W_UNRESPONSIVE_CARD) this.lostCard = true;
    throw opErrorForPcsc(result.rv);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (!this.released) {
      this.released = true;
      try {
        // SCARD_LEAVE_CARD; the rv is ignored (a removed card's handle returns an
        // error but is released all the same).
        this.native.disconnect(this.hCard);
      } catch {
        // ignore - releasing is best-effort
      }
    }
    this.finish();
  }

  private notified = false;
  private finish(): void {
    if (this.notified) return;
    this.notified = true;
    this.onClose(this);
  }
}
