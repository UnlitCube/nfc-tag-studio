// NfcService implementation: binds the PC/SC and simulator backends, tracks reader
// status, identifies cards, and serialises every read/write through one mutex.
// Owner: agent "main-nfc". Exported as createNfcService(deps) (see ./contract.ts).

import type { TagKind } from '@shared/tags';
import {
  isForbiddenUnit,
  isMifare,
  isNtag,
  isProtectedUnit,
  kindFromCc,
  kindFromVersion,
  kindHintFromAtr,
  mifareIsTrailer,
  parseAccessBits,
} from '@shared/tags';
import type {
  CardInfo,
  KindSource,
  ReadOptions,
  ReaderDriverMode,
  ReaderInfo,
  ReaderStatus,
  ServiceState,
  TagImage,
  WriteRequest,
  WriteResult,
} from '@shared/types';
import { bytesEqual, bytesToHex } from '@shared/hex';
import { VIRTUAL_READER_NAME } from '@shared/reader';
import { OpError } from '../errors';
import type { BackendEvent, ReaderBackend } from './backend';
import type { NfcService, NfcServiceDeps } from './contract';
import { createPcscBackend } from './pcsc';
import { createSimulatorBackend, type SimulatorBackend } from './simulator';
import { ReaderIo, resolveDriver } from './driver';
import { ntagGetVersionBytes, readNtag, readNtagPage, writeNtagPages } from './ntag';
import { mifareTrailerReadbackMask, readMifare, readMifareBlock, writeMifare } from './mifare';

/** Promise-chain mutex: run() calls execute strictly one after another. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn(), () => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export function createNfcService(deps: NfcServiceDeps): NfcService {
  const sim: SimulatorBackend = createSimulatorBackend();
  const pcsc: ReaderBackend = createPcscBackend(deps.log);

  let pcscState: 'ok' | 'unavailable' | 'error' = 'unavailable';
  let pcscMessage: string | null = null;
  let selectedReader: string | null = null;
  let driverMode: ReaderDriverMode = 'auto';
  let manualKind: TagKind | null = null;
  let card: CardInfo | null = null;
  let busy: ReaderStatus['busy'] = null;

  const statusListeners = new Set<(s: ReaderStatus) => void>();
  const cardWaiters: Waiter<CardInfo>[] = [];
  const removalWaiters: Waiter<void>[] = [];
  const mutex = new Mutex();

  // --- status ----------------------------------------------------------------

  function allReaders(): ReaderInfo[] {
    return [...pcsc.readers(), ...sim.readers()];
  }

  function computeService(): ServiceState {
    if (pcscState === 'ok' || sim.state.enabled) {
      return allReaders().length > 0 ? 'ok' : 'no-readers';
    }
    return pcscState;
  }

  function snapshot(): ReaderStatus {
    return {
      service: computeService(),
      serviceMessage: pcscMessage,
      readers: allReaders(),
      selectedReader,
      driverMode,
      card,
      busy,
      simulator: sim.state,
    };
  }

  function push(): void {
    const s = snapshot();
    for (const cb of [...statusListeners]) {
      try {
        cb(s);
      } catch {
        // a listener must not break status delivery to the others
      }
    }
  }

  // --- reader selection ------------------------------------------------------

  function activeReaderName(): string | null {
    if (selectedReader) return selectedReader;
    // Auto-selection. When the virtual reader is explicitly enabled AND has a tag
    // on it, prefer it even if a real reader is also connected: the operator
    // turned the simulator on to use it (and it keeps demos/tests deterministic
    // regardless of what hardware happens to be plugged in). To use a real reader
    // instead, select it explicitly.
    const simReader = sim.readers()[0];
    if (simReader && simReader.cardPresent) return simReader.name;
    const readers = allReaders();
    // else prefer a real contactless reader that already has a card.
    const withCard = readers.find((r) => r.likelyContactless && r.cardPresent);
    if (withCard) return withCard.name;
    const contactless = readers.find((r) => r.likelyContactless);
    return contactless ? contactless.name : null;
  }

  function requireActiveReader(): string {
    const name = activeReaderName();
    if (!name) throw new OpError('NO_READER');
    return name;
  }

  function backendFor(name: string): ReaderBackend {
    return name === VIRTUAL_READER_NAME ? sim : pcsc;
  }

  // --- card identification ---------------------------------------------------

  async function identifyWith(io: ReaderIo, atrBytes: Uint8Array): Promise<{ kind: TagKind | null; source: KindSource | null; version: string | null }> {
    let kind: TagKind | null = null;
    let source: KindSource | null = null;
    let version: string | null = null;

    if (manualKind) {
      kind = manualKind;
      source = 'manual';
    }
    if (!kind && io.rawCommands) {
      const v = await ntagGetVersionBytes(io);
      if (v) {
        const k = kindFromVersion(v);
        if (k) {
          kind = k;
          source = 'version';
          version = bytesToHex(v);
        }
      }
    }
    if (!kind) {
      try {
        const cc = await io.readBinary(3, 4);
        const k = kindFromCc(cc.subarray(0, 4));
        if (k) {
          kind = k;
          source = 'cc';
        }
      } catch {
        // CC unreadable (e.g. a locked MIFARE sector 0 trailer) -> fall through
      }
    }
    if (!kind) {
      const hint = kindHintFromAtr(atrBytes);
      if (hint === 'MIFARE_CLASSIC_1K' || hint === 'MIFARE_CLASSIC_4K') {
        kind = hint;
        source = 'atr';
      }
    }
    return { kind, source, version };
  }

  async function identifyReader(reader: string): Promise<CardInfo> {
    const conn = await backendFor(reader).connect(reader);
    try {
      const driver = resolveDriver(reader, driverMode);
      const io = new ReaderIo(conn, driver);
      const uid = bytesToHex(await io.getUid());
      const { kind, source, version } = await identifyWith(io, conn.atr);
      return {
        readerName: reader,
        uid,
        atr: bytesToHex(conn.atr),
        kind,
        kindSource: source,
        version,
        rawCommands: io.rawCommands,
        driver,
        detectedAt: Date.now(),
      };
    } finally {
      await conn.disconnect();
    }
  }

  function scheduleIdentify(reader: string): void {
    if (selectedReader && selectedReader !== reader) return;
    void mutex.run(async () => {
      try {
        card = await identifyReader(reader);
        resolveAll(cardWaiters, card);
      } catch {
        card = null;
      }
      push();
    });
  }

  // --- waiters ---------------------------------------------------------------

  function resolveAll<T>(list: Waiter<T>[], value: T): void {
    const ws = list.splice(0);
    for (const w of ws) {
      w.signal.removeEventListener('abort', w.onAbort);
      w.resolve(value);
    }
  }

  function waitForCard(signal: AbortSignal): Promise<CardInfo> {
    if (signal.aborted) return Promise.reject(new OpError('CANCELLED'));
    if (card) return Promise.resolve(card);
    return new Promise<CardInfo>((resolve, reject) => {
      const w: Waiter<CardInfo> = { resolve, reject, signal, onAbort: () => {} };
      w.onAbort = () => {
        const i = cardWaiters.indexOf(w);
        if (i >= 0) cardWaiters.splice(i, 1);
        reject(new OpError('CANCELLED'));
      };
      cardWaiters.push(w);
      signal.addEventListener('abort', w.onAbort, { once: true });
    });
  }

  function waitForRemoval(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new OpError('CANCELLED'));
    if (!card) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const w: Waiter<void> = { resolve, reject, signal, onAbort: () => {} };
      w.onAbort = () => {
        const i = removalWaiters.indexOf(w);
        if (i >= 0) removalWaiters.splice(i, 1);
        reject(new OpError('CANCELLED'));
      };
      removalWaiters.push(w);
      signal.addEventListener('abort', w.onAbort, { once: true });
    });
  }

  // --- backend events --------------------------------------------------------

  function onBackendEvent(e: BackendEvent): void {
    switch (e.type) {
      case 'service':
        pcscState = e.state;
        pcscMessage = e.message;
        push();
        break;
      case 'readers':
        push();
        break;
      case 'card-inserted':
        scheduleIdentify(e.reader);
        push();
        break;
      case 'card-removed':
        if (card && card.readerName === e.reader) {
          card = null;
          resolveAll(removalWaiters, undefined);
        }
        push();
        break;
    }
  }

  // --- read / write ----------------------------------------------------------

  function validateWrites(req: WriteRequest): void {
    for (const w of req.writes) {
      if (isForbiddenUnit(req.kind, w.unit)) throw new OpError('PROTECTED_UNIT', `unit ${w.unit}`);
      if (isMifare(req.kind) && mifareIsTrailer(w.unit)) {
        if (w.data.length < 16 || parseAccessBits(w.data) === null) throw new OpError('INVALID_ACCESS_BITS', `block ${w.unit}`);
      }
      if (isProtectedUnit(req.kind, w.unit) && !req.allowProtected) throw new OpError('PROTECTED_UNIT', `unit ${w.unit}`);
    }
  }

  function readTag(opts: ReadOptions): Promise<TagImage> {
    return mutex.run(async () => {
      const reader = requireActiveReader();
      const conn = await backendFor(reader).connect(reader);
      const prevBusy = busy;
      busy = { op: 'read', startedAt: Date.now() };
      push();
      try {
        const io = new ReaderIo(conn, resolveDriver(reader, driverMode));
        const uid = bytesToHex(await io.getUid());
        const { kind } = await identifyWith(io, conn.atr);
        if (!kind) throw new OpError('UNSUPPORTED_TAG');
        if (isNtag(kind)) {
          const r = await readNtag(io, kind, { password: opts.ntagPassword });
          return { kind, uid, data: r.data, unitStatus: r.unitStatus, readAt: Date.now(), ntag: r.extras };
        }
        const keys = deps.resolveKeys(opts.mifareKeyIds ?? []);
        const r = await readMifare(io, kind, keys);
        return { kind, uid, data: r.data, unitStatus: r.unitStatus, readAt: Date.now(), mifare: { sectors: r.sectors } };
      } finally {
        await conn.disconnect();
        busy = prevBusy;
        push();
      }
    });
  }

  function writeTag(req: WriteRequest): Promise<WriteResult> {
    return mutex.run(async () => {
      const reader = requireActiveReader();
      const conn = await backendFor(reader).connect(reader);
      const prevBusy = busy;
      busy = { op: 'write', startedAt: Date.now() };
      push();
      try {
        const io = new ReaderIo(conn, resolveDriver(reader, driverMode));
        const uid = bytesToHex(await io.getUid());
        if (req.expectedUid && uid !== req.expectedUid.toUpperCase()) throw new OpError('UID_MISMATCH');

        validateWrites(req);

        let written: number[];
        let failed: { unit: number; error: string }[];
        if (isNtag(req.kind)) {
          const r = await writeNtagPages(io, req.writes, { password: req.ntagPassword });
          written = r.written;
          failed = r.failed;
        } else {
          const keys = deps.resolveKeys(req.mifareKeyIds ?? []);
          const r = await writeMifare(io, req.writes, keys);
          written = r.written;
          failed = r.failed;
        }

        let verified: boolean | null = null;
        const mismatched: number[] = [];
        if (req.verify) {
          verified = true;
          const keys = isMifare(req.kind) ? deps.resolveKeys(req.mifareKeyIds ?? []) : [];
          for (const w of req.writes) {
            if (!written.includes(w.unit)) continue;
            try {
              const back = isNtag(req.kind) ? await readNtagPage(io, w.unit) : await readMifareBlock(io, w.unit, keys);
              // A MIFARE sector trailer never reads its Key A back (and may hide
              // Key B): compare against what the card can actually return, so a
              // correct trailer write is not reported as a mismatch (I4: keys are
              // not read back / exposed anyway).
              const expected = isMifare(req.kind) && mifareIsTrailer(w.unit) ? mifareTrailerReadbackMask(w.data) : w.data;
              if (!bytesEqual(back, expected)) {
                mismatched.push(w.unit);
                verified = false;
              }
            } catch {
              mismatched.push(w.unit);
              verified = false;
            }
          }
        }
        return { uid, written, failed, verified, mismatched };
      } finally {
        await conn.disconnect();
        busy = prevBusy;
        push();
      }
    });
  }

  function transmitApdu(apdu: Uint8Array): Promise<Uint8Array> {
    if (!deps.isAdvancedMode()) return Promise.reject(new OpError('ACCESS_DENIED', 'advanced mode required for raw APDUs'));
    return mutex.run(async () => {
      const reader = requireActiveReader();
      const conn = await backendFor(reader).connect(reader);
      try {
        return await conn.transmit(apdu);
      } finally {
        await conn.disconnect();
      }
    });
  }

  // --- control ---------------------------------------------------------------

  async function refreshReaders(): Promise<void> {
    await pcsc.refresh();
    await sim.refresh();
    push();
  }

  async function selectReader(name: string | null): Promise<void> {
    selectedReader = name;
    push();
  }

  async function setDriverMode(mode: ReaderDriverMode): Promise<void> {
    driverMode = mode;
    push();
  }

  async function setManualKind(kind: TagKind | null): Promise<void> {
    manualKind = kind;
    push();
  }

  async function setSimulator(opts: { enabled: boolean; kind?: TagKind }): Promise<void> {
    sim.setEnabled(opts.enabled, opts.kind);
    push();
  }

  async function simulatorTap(present: boolean): Promise<void> {
    sim.tap(present);
    push();
  }

  async function simulatorNewTag(kind: TagKind): Promise<void> {
    sim.newTag(kind);
    push();
  }

  function setBusy(op: 'issue' | null): void {
    busy = op ? { op, startedAt: Date.now() } : null;
    push();
  }

  async function dispose(): Promise<void> {
    await pcsc.stop();
    await sim.stop();
    statusListeners.clear();
  }

  // Start both backends. Their start() sets the listener synchronously before the
  // first await, so events emitted by later control calls are not missed.
  void pcsc.start(onBackendEvent);
  void sim.start(onBackendEvent);

  return {
    getStatus: snapshot,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    refreshReaders,
    selectReader,
    setDriverMode,
    setManualKind,
    setSimulator,
    simulatorTap,
    simulatorNewTag,
    readTag,
    writeTag,
    transmitApdu,
    waitForCard,
    waitForRemoval,
    setBusy,
    dispose,
  };
}
