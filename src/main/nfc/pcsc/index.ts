// PC/SC reader backend (koffi -> winscard.dll / PCSC.framework / libpcsclite.so.1).
// Owner: agent "main-pcsc". Signature createPcscBackend(log) is frozen.
//
// This wires the pure helpers (./pure.ts) to the native binding (./winscard.ts)
// into the ReaderBackend contract. It is a dumb APDU pipe: it never writes a UID
// and knows nothing of magic-card backdoors (I1/I2). It must never throw
// synchronously and must keep the app alive when the card service or the native
// library is missing (emit a 'service' event and retry).

import type { BackendEvent, CardConnection, ReaderBackend } from '../backend';
import type { ReaderInfo } from '@shared/types';
import { OpError } from '../../errors';
import { loadWinscard, type Handle, type Winscard } from './winscard';
import {
  isOk,
  isRemovedCardRv,
  isServiceUnavailableRv,
  isNoReadersRv,
  opErrorForPcsc,
  pcscErrorCode,
  readerInfoFrom,
  readerListEqual,
  rvName,
  normalizeRv,
  SCARD_E_NO_SMARTCARD,
  SCARD_E_UNKNOWN_READER,
  SCARD_E_READER_UNAVAILABLE,
} from './pure';

const POLL_INTERVAL_MS = 600;
const RETRY_INTERVAL_MS = 3000;

type ServiceState = 'ok' | 'unavailable' | 'error';

interface PrevState {
  present: boolean;
  atr: Uint8Array;
}

export function createPcscBackend(log: (line: string) => void): ReaderBackend {
  let listener: ((e: BackendEvent) => void) | null = null;
  let running = false;
  let loopDone: Promise<void> = Promise.resolve();

  let native: Winscard | null = null;
  let ctx: Handle | null = null;

  let lastReaders: ReaderInfo[] | null = null;
  let lastService: { state: ServiceState; message: string | null } | null = null;
  let prev = new Map<string, PrevState>();

  const connections = new Set<PcscConnection>();
  let wake: (() => void) | null = null;

  function emit(e: BackendEvent): void {
    try {
      listener?.(e);
    } catch (err) {
      log(`pcsc: listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function emitService(state: ServiceState, message: string | null): void {
    if (lastService && lastService.state === state && lastService.message === message) return;
    lastService = { state, message };
    emit({ type: 'service', state, message });
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

  /** Drop the native context (keeps the library loaded for the next attempt). */
  function teardownContext(): void {
    if (native && ctx != null) {
      try {
        native.releaseContext(ctx);
      } catch {
        // ignore
      }
    }
    ctx = null;
    lastReaders = null;
    prev = new Map();
  }

  function emitReadersIfChanged(infos: ReaderInfo[]): void {
    if (lastReaders && readerListEqual(lastReaders, infos)) return;
    lastReaders = infos;
    emit({ type: 'readers', readers: infos });
  }

  function diffPresence(infos: ReaderInfo[], states: { name: string; atr: Uint8Array }[]): void {
    const atrByName = new Map(states.map((s) => [s.name, s.atr]));
    const next = new Map<string, PrevState>();
    for (const info of infos) {
      const atr = atrByName.get(info.name) ?? new Uint8Array(0);
      next.set(info.name, { present: info.cardPresent, atr });
      const before = prev.get(info.name);
      if (info.cardPresent && (!before || !before.present)) {
        emit({ type: 'card-inserted', reader: info.name, atr });
      } else if (!info.cardPresent && before && before.present) {
        emit({ type: 'card-removed', reader: info.name });
      }
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
      native = loadWinscard(); // throws -> caught by loop -> service unavailable
    }
    if (ctx == null) {
      const r = native.establishContext();
      if (!isOk(r.rv)) {
        if (isServiceUnavailableRv(r.rv)) {
          emitService('unavailable', `PC/SC service unavailable (${rvName(r.rv)})`);
        } else {
          emitService('error', `SCardEstablishContext failed (${rvName(r.rv)})`);
        }
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
      teardownContext();
      if (isServiceUnavailableRv(list.rv)) {
        emitService('unavailable', `PC/SC service unavailable (${rvName(list.rv)})`);
      } else {
        log(`pcsc: SCardListReaders -> ${rvName(list.rv)} (dropping context)`);
        emitService('error', `SCardListReaders failed (${rvName(list.rv)})`);
      }
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
        // states regardless of rv, which would fire spurious card-removed).
        teardownContext();
        if (isServiceUnavailableRv(sc.rv)) {
          emitService('unavailable', `PC/SC service unavailable (${rvName(sc.rv)})`);
        } else {
          log(`pcsc: SCardGetStatusChange -> ${rvName(sc.rv)} (dropping context)`);
          emitService('error', `SCardGetStatusChange failed (${rvName(sc.rv)})`);
        }
        return 'retry';
      }
      states = sc.states;
    }

    const infos: ReaderInfo[] =
      states.length === names.length
        ? states.map((s) => readerInfoFrom(s.name, s.eventState, s.atr))
        : names.map((name) => readerInfoFrom(name, 0, null));

    emitService('ok', null);
    emitReadersIfChanged(infos);
    diffPresence(infos, states.length === names.length ? states : infos.map((i) => ({ name: i.name, atr: new Uint8Array(0) })));
    return 'ok';
  }

  async function loop(): Promise<void> {
    while (running) {
      let outcome: 'ok' | 'retry' = 'ok';
      try {
        outcome = await pollOnce();
      } catch (err) {
        // Native library missing / failed to load, or an unexpected fault.
        teardownContext();
        native = null;
        emitService('unavailable', nativeLoadMessage(err));
        outcome = 'retry';
      }
      if (!running) break;
      await delay(outcome === 'retry' ? RETRY_INTERVAL_MS : POLL_INTERVAL_MS);
    }
    // Final cleanup once the loop stops.
    teardownContext();
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
    const conn = new PcscConnection(native, c.hCard, readerName, atr, c.activeProtocol, (self) => {
      connections.delete(self);
    });
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

/** One connected card. transmit() is serialized; disconnect() is idempotent. */
class PcscConnection implements CardConnection {
  readonly readerName: string;
  readonly atr: Uint8Array;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

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
    const run = this.chain.then(() => this.doTransmit(apdu));
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
      throw new OpError('CARD_REMOVED');
    }
    throw opErrorForPcsc(result.rv);
  }

  async disconnect(): Promise<void> {
    if (this.closed) {
      this.onClose(this);
      return;
    }
    this.closed = true;
    try {
      this.native.disconnect(this.hCard);
    } catch {
      // ignore - releasing is best-effort
    }
    this.onClose(this);
  }
}
