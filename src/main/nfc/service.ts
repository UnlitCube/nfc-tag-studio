// NfcService implementation: binds the PC/SC and simulator backends, tracks the
// tag on each reader, identifies cards, and serialises every read/write through
// one mutex. Owner: agent "main-nfc". Exported as createNfcService(deps, init?)
// (see ./contract.ts).
//
// 2026-11-12 UX audit (CARD-1/2/3/5/10, FIRST-1, ISSUE-5/6, WALK-3): the old
// service kept ONE `card` that any reader's identification overwrote, never
// retried a failed identification and identified USB tokens too. Now:
//   - every reader has its own slot {state, card, error, placedAt}; the status
//     shows only the ACTIVE reader's slot (the one read/write use), so a token or
//     a second reader can never blank or replace the tag the operator sees;
//   - only candidate readers are identified (the selected reader, or - in auto -
//     the virtual reader and likely-contactless real readers): no APDU reaches a
//     USB token / YubiKey unless the operator selected it (I6);
//   - a failed identification is retried while the tag stays on the reader
//     (300 -> 600 -> 1200 ms), then reported as 'error' with a code;
//   - a successful read / write refreshes the slot with what is really on the reader.
//
// 2026-11-12 adversarial review, round 2:
//   - R-MAIN-4: a tag whose kind cannot be confirmed (CC read-protected / badly
//     placed) is 'error' with the reason and its UID (card.kind null), never
//     "unsupported"; 'unsupported' only for an answer that says so;
//   - R-MAIN-7: after the quick retries, a few slow quiet re-checks (2.5/5/10 s);
//   - R-MAIN-5: a read / write does not cancel a re-identification that a setting
//     change asked for while it ran; R-MAIN-6: reidentify() waits for ITS round;
//   - R-MAIN-3: a refused unit on a storage reader is checked against "the tag left";
//   - R-MAIN-2: dispose() lets the operation in progress finish;
//   - R-WRITE-2: NTAG PWD / PACK are not compared by the write verify (they read 00);
//   - D11 / R-UX-1: a password on a storage reader -> READER_NO_AUTH (never skipped);
//   - R-UX-11: UID / manufacturer block -> FORBIDDEN_UNIT (not PROTECTED_UNIT).

import type { TagKind } from '@shared/tags';
import {
  isFelica,
  isForbiddenUnit,
  isMifare,
  isNtag,
  isProtectedUnit,
  kindFromCc,
  kindFromVersion,
  kindHintFromAtr,
  mifareIsTrailer,
  ntagPages,
  parseAccessBits,
  parseStorageAtr,
} from '@shared/tags';
import type {
  ActiveReaderReason,
  CardInfo,
  CardState,
  ErrorCode,
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
import type { NfcService, NfcServiceDeps, NfcServiceInit } from './contract';
import { createPcscBackend } from './pcsc';
import { createSimulatorBackend, type SimulatorBackend } from './simulator';
import { ReaderIo, resolveDriver, supportsRawCommands } from './driver';
import { ntagGetVersionBytes, readNtag, readNtagPage, writeNtagPages } from './ntag';
import { mifareTrailerReadbackMask, readMifare, readMifareBlock, writeMifare } from './mifare';
import { probeFelicaLiteS, readFelica, readFelicaBlock, writeFelica } from './felica';
import { errorCodeOf, isLinkLost, type UnitWriteOutcome } from './unit-ops';

/** Wait after a real tag is placed before talking to it (it is often still sliding into place). */
export const IDENTIFY_SETTLE_MS = 200;
/** Retry delays for a failed identification while the tag stays on the reader. */
export const IDENTIFY_RETRY_MS: readonly number[] = [300, 600, 1200];
/**
 * After the quick retries ended in 'error': a few slow, quiet re-checks while the
 * tag stays on a candidate reader (2026-11-12 review R-MAIN-7). A tag that was
 * half on the reader and is then slid into place - without the reader ever
 * reporting "empty" - is picked up without the operator pressing anything. The
 * status keeps showing the error meanwhile (no flicker, no "identify" busy).
 */
export const IDENTIFY_SLOW_RETRY_MS: readonly number[] = [2500, 5000, 10_000];
/** reidentify() resolves at the latest after this long. */
const SETTLE_TIMEOUT_MS = 10_000;
/**
 * dispose() waits at most this long for the read / write in progress (R-MAIN-2:
 * closing the window mid-write must not leave a half-written tag). A full
 * NTAG216 / MIFARE 4K write with verify on a slow storage reader takes a few seconds.
 */
export const DISPOSE_WAIT_MS = 15_000;

/** Promise-chain mutex: run() calls execute strictly one after another. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(
      () => fn(),
      () => fn(),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * The tag on one reader. No slot = no tag. 'idle' = a tag is present but the
 * reader is not a candidate, so it was not identified (e.g. a USB token).
 */
interface ReaderSlot {
  state: 'idle' | 'detecting' | 'ready' | 'unsupported' | 'error';
  card: CardInfo | null;
  error: ErrorCode | null;
  /** When this tag was placed (epoch ms). CardInfo.detectedAt carries it. */
  placedAt: number;
  /** Bumped when a different tag is on the reader; removal waiters key on it. */
  placement: number;
  /** Bumped to abandon a pending identification. */
  generation: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * A foreground identification round (first try + quick retries) of the CURRENT
   * generation has not concluded yet. reidentify() / settle waiters wait on this,
   * not on "some attempt is running": an abandoned older attempt finishing must
   * not end the wait for the newer one (2026-11-12 review R-MAIN-6). The slow
   * background re-checks of R-MAIN-7 never set it.
   */
  settling: boolean;
  /** Slow background re-checks done since the last (re)start of detection. */
  slow: number;
  /**
   * Re-checking after a possible swap (card-changed) or a setting change: the UID
   * that was on the reader. The old card stays shown until the check ends; the
   * same UID keeps the placement (nothing happened), another UID is a new tag.
   */
  confirmUid: string | null;
  /**
   * A re-check that ended in error: we no longer know which tag is there, but we
   * do not claim it changed either (issue mode must neither re-issue the same tag
   * nor miss a new one). The next UID read decides.
   */
  pendingUid: string | null;
  changedAt: number;
}

interface CardWaiter {
  resolve: (c: CardInfo) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
  detectedAfter: number;
}

interface RemovalWaiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
  reader: string;
  placement: number;
}

interface SettleWaiter {
  reader: string;
  slot: ReaderSlot;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Identified {
  kind: TagKind | null;
  source: KindSource | null;
  version: string | null;
  /** kind is null because a probe failed (not because the tag answered "something else"): retry. */
  unsure: ErrorCode | null;
}

const NOT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['UNSUPPORTED_TAG', 'NO_READER', 'NO_SERVICE', 'CANCELLED']);

/**
 * The ATR says the card is not an NFC Forum Type 2 tag (NTAG / Ultralight): a
 * PC/SC Part 3 storage ATR of another standard (ISO 14443-B, ISO 15693, ...), or
 * the Part 3 ATR of an ISO/IEC 14443-4 card (3B 8n 80 01 + historical bytes:
 * DESFire, bank cards, phones). An empty / unknown ATR says nothing.
 */
export function atrSaysNotType2(atr: Uint8Array): boolean {
  const p = parseStorageAtr(atr);
  if (p) return p.standard !== 0x03; // 0x03 = ISO/IEC 14443 A part 3 (Type 2, MIFARE)
  return atr.length >= 5 && atr[0] === 0x3b && (atr[1] & 0xf0) === 0x80 && atr[2] === 0x80 && atr[3] === 0x01;
}

/** PC/SC backend stand-in when PC/SC is disabled (E2E / CI: init.pcsc === false). */
function createDisabledPcscBackend(): ReaderBackend {
  return {
    id: 'pcsc',
    async start() {},
    async stop() {},
    async refresh() {},
    readers: () => [],
    async connect() {
      throw new OpError('NO_READER', 'PC/SC disabled');
    },
  };
}

export function createNfcService(deps: NfcServiceDeps, init: NfcServiceInit = {}): NfcService {
  const sim: SimulatorBackend = createSimulatorBackend();
  const pcscEnabled = init.pcsc !== false;
  // Never created (koffi never loaded, no PC/SC call) when disabled.
  const pcsc: ReaderBackend = pcscEnabled ? createPcscBackend(deps.log) : createDisabledPcscBackend();

  let pcscState: 'ok' | 'unavailable' | 'error' = pcscEnabled ? 'unavailable' : 'ok';
  let pcscMessage: string | null = null;
  let pcscNoReaders = false;
  // Initial settings are applied BEFORE the backends start (CARD-2): the very
  // first poll already honours the saved reader / driver.
  let selectedReader: string | null = init.preferredReader ?? null;
  let driverMode: ReaderDriverMode = init.driverMode ?? 'auto';
  /**
   * Operator override of the detected kind, for ONE tag: the one on the active
   * reader when it was set (or, when none was there, the next one placed). It ends
   * when that tag leaves, so a kind forced for one odd tag never lays out the
   * data of a later, different tag (WRITE-8).
   */
  let manual: { kind: TagKind; reader: string | null; placement: number | null } | null = null;
  let opBusy: ReaderStatus['busy'] = null;
  let issueBusy: ReaderStatus['busy'] = null;
  let disposed = false;

  const slots = new Map<string, ReaderSlot>();
  /** Placement ids are unique across slots, so a re-created slot never matches an old waiter. */
  let placementSeq = 0;
  const nextPlacement = (): number => ++placementSeq;
  const statusListeners = new Set<(s: ReaderStatus) => void>();
  const cardWaiters: CardWaiter[] = [];
  const removalWaiters: RemovalWaiter[] = [];
  const settleWaiters: SettleWaiter[] = [];
  const mutex = new Mutex();

  // --- readers & selection ----------------------------------------------------

  function allReaders(): ReaderInfo[] {
    return [...pcsc.readers(), ...sim.readers()];
  }

  function readerInfo(name: string): ReaderInfo | undefined {
    return allReaders().find((r) => r.name === name);
  }

  function resolveActive(readers: ReaderInfo[]): { name: string | null; reason: ActiveReaderReason; ignoredReal: string | null } {
    if (selectedReader) {
      // D1: a selected reader that is not connected is NOT silently replaced.
      return readers.some((r) => r.name === selectedReader)
        ? { name: selectedReader, reason: 'selected', ignoredReal: null }
        : { name: null, reason: 'selected-missing', ignoredReal: null };
    }
    // Auto. The virtual reader with a tag on it wins (the operator turned it on to
    // use it; keeps demos/tests deterministic). A real tag it hides is reported.
    const virtual = readers.find((r) => r.virtual);
    if (virtual && virtual.cardPresent) {
      const real = readers.find((r) => !r.virtual && r.likelyContactless && r.cardPresent);
      return { name: virtual.name, reason: 'auto-virtual', ignoredReal: real ? real.name : null };
    }
    const withCard = readers.find((r) => r.likelyContactless && r.cardPresent);
    if (withCard) return { name: withCard.name, reason: 'auto-card', ignoredReal: null };
    const first = readers.find((r) => r.likelyContactless);
    if (first) return { name: first.name, reason: 'auto-first', ignoredReal: null };
    return { name: null, reason: 'none', ignoredReal: null };
  }

  function activeReaderName(): string | null {
    return resolveActive(allReaders()).name;
  }

  function requireActiveReader(): string {
    const name = activeReaderName();
    if (!name) throw new OpError('NO_READER');
    return name;
  }

  /**
   * May this reader receive identification APDUs? (I6) Only the selected reader
   * when one is selected; otherwise the virtual reader and real readers that look
   * contactless. A USB token / YubiKey is never probed unless the operator chose it.
   */
  function isCandidate(name: string): boolean {
    if (selectedReader) return name === selectedReader;
    if (name === VIRTUAL_READER_NAME) return true;
    const info = pcsc.readers().find((r) => r.name === name);
    return !!info && info.likelyContactless;
  }

  function backendFor(name: string): ReaderBackend {
    return name === VIRTUAL_READER_NAME ? sim : pcsc;
  }

  // --- status ----------------------------------------------------------------

  function computeService(readers: ReaderInfo[]): ServiceState {
    if (pcscState === 'ok' || sim.state.enabled) return readers.length > 0 ? 'ok' : 'no-readers';
    // Windows starts SCardSvr only when a reader is connected (CARD-8).
    if (pcscState === 'unavailable' && pcscNoReaders) return 'no-readers';
    return pcscState;
  }

  function snapshot(): ReaderStatus {
    const readers = allReaders();
    const act = resolveActive(readers);
    let cardState: CardState = 'no-reader';
    let card: CardInfo | null = null;
    let cardError: ErrorCode | null = null;
    if (act.name) {
      const slot = slots.get(act.name);
      if (!slot) {
        // A reader that already reports a tag we have not been told about yet.
        cardState = readers.find((r) => r.name === act.name)?.cardPresent ? 'detecting' : 'absent';
      } else if (slot.state === 'ready' && slot.card) {
        cardState = 'ready';
        card = slot.card;
      } else if (slot.state === 'unsupported') {
        cardState = 'unsupported';
        card = slot.card;
        cardError = slot.error ?? 'UNSUPPORTED_TAG';
      } else if (slot.state === 'error') {
        cardState = 'error';
        // The UID when it was read but the kind could not be confirmed (kind null,
        // e.g. a read-protected NTAG on a storage reader): R-MAIN-4.
        card = slot.card;
        cardError = slot.error ?? 'READ_FAILED';
      } else {
        cardState = 'detecting';
      }
    }
    return {
      service: computeService(readers),
      serviceMessage: pcscMessage,
      readers,
      selectedReader,
      activeReader: act.name,
      activeReason: act.reason,
      activeDriver: act.name ? resolveDriver(act.name, driverMode) : null,
      driverMode,
      card,
      cardState,
      cardError,
      ignoredRealReader: act.ignoredReal,
      busy: issueBusy ?? opBusy,
      simulator: sim.state,
    };
  }

  function push(): void {
    if (disposed) return;
    const s = snapshot();
    settle(s);
    for (const cb of [...statusListeners]) {
      try {
        cb(s);
      } catch {
        // a listener must not break status delivery to the others
      }
    }
  }

  /** Resolve the waiters whose condition the new status meets. */
  function settle(s: ReaderStatus): void {
    if (s.card && (s.cardState === 'ready' || s.cardState === 'unsupported')) {
      const card = s.card;
      for (const w of [...cardWaiters]) {
        if (card.detectedAt < w.detectedAfter) continue;
        cardWaiters.splice(cardWaiters.indexOf(w), 1);
        w.signal.removeEventListener('abort', w.onAbort);
        w.resolve(card);
      }
    }
    for (const w of [...removalWaiters]) {
      const slot = slots.get(w.reader);
      if (slot && slot.placement === w.placement) continue;
      removalWaiters.splice(removalWaiters.indexOf(w), 1);
      w.signal.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
    for (const w of [...settleWaiters]) {
      const slot = slots.get(w.reader);
      if (slot === w.slot && slot.settling) continue;
      settleWaiters.splice(settleWaiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  // --- identification --------------------------------------------------------

  function manualKindFor(reader: string): TagKind | null {
    if (!manual) return null;
    if (manual.placement === null) return manual.kind; // not bound yet: the next tag
    const slot = slots.get(reader);
    return manual.reader === reader && slot !== undefined && slot.placement === manual.placement ? manual.kind : null;
  }

  /** A pending manual kind binds to the next tag placed on a candidate reader. */
  function bindManual(reader: string, slot: ReaderSlot): void {
    if (manual && manual.placement === null && isCandidate(reader)) {
      manual.reader = reader;
      manual.placement = slot.placement;
    }
  }

  async function identifyWith(io: ReaderIo, atrBytes: Uint8Array, uidBytes: Uint8Array, manualKind: TagKind | null): Promise<Identified> {
    if (manualKind) return { kind: manualKind, source: 'manual', version: null, unsure: null };

    const hint = kindHintFromAtr(atrBytes);
    if (hint === 'FELICA') {
      // A FeliCa ATR is shared by Suica, ID cards and Lite-S: confirm Lite-S by its
      // system code instead of assuming it (CARD-12). Not an ISO-A tag, so skip the
      // NTAG GET_VERSION / CC probes entirely.
      try {
        const r = await probeFelicaLiteS(io, uidBytes);
        if (r === 'lite-s') return { kind: 'FELICA_LITE_S', source: 'atr', version: null, unsure: null };
        if (r === 'other') return { kind: null, source: null, version: null, unsure: null };
        // 'refused': most likely another FeliCa product - retried, then unsupported.
        // 'unknown': no usable answer - retried, then a read error (R-MAIN-4).
        return { kind: null, source: null, version: null, unsure: r === 'refused' ? 'UNSUPPORTED_TAG' : 'READ_FAILED' };
      } catch (e) {
        if (isLinkLost(e)) throw e;
        return { kind: null, source: null, version: null, unsure: errorCodeOf(e, 'READ_FAILED') };
      }
    }

    let version: string | null = null;
    if (io.rawCommands) {
      const v = await ntagGetVersionBytes(io);
      if (v) {
        const k = kindFromVersion(v);
        if (k) return { kind: k, source: 'version', version: bytesToHex(v), unsure: null };
        version = bytesToHex(v);
      }
    }
    let unsure: ErrorCode | null = null;
    try {
      const cc = await io.readBinary(3, 4);
      const k = kindFromCc(cc.subarray(0, 4));
      if (k) return { kind: k, source: 'cc', version, unsure: null };
    } catch (e) {
      // The tag left: the whole identification / operation fails.
      if (isLinkLost(e)) throw e;
      // CC unreadable (e.g. a MIFARE sector 0 trailer, or a glitch) -> fall through
      unsure = errorCodeOf(e, 'READ_FAILED');
    }
    if (hint === 'MIFARE_CLASSIC_1K' || hint === 'MIFARE_CLASSIC_4K') return { kind: hint, source: 'atr', version, unsure: null };
    // R-MAIN-4: an unreadable CC on what may be an NTAG (read-protected, or badly
    // placed) is reported with its reason, never as "unsupported". Only a tag known
    // NOT to be an NFC Forum Type 2 tag - its ATR names another family, or GET_VERSION
    // answered with another product - is "probably unsupported" (retried first).
    if (unsure && (atrSaysNotType2(atrBytes) || version !== null)) unsure = 'UNSUPPORTED_TAG';
    return { kind: null, source: null, version, unsure };
  }

  function cardInfoOf(reader: string, uid: string, atr: Uint8Array, id: Identified, io: ReaderIo, detectedAt: number): CardInfo {
    return {
      readerName: reader,
      uid,
      atr: bytesToHex(atr),
      kind: id.kind,
      kindSource: id.source,
      version: id.version,
      rawCommands: io.rawCommands,
      driver: io.driver,
      detectedAt,
    };
  }

  async function identifyReader(reader: string, slot: ReaderSlot): Promise<{ card: CardInfo; unsure: ErrorCode | null }> {
    const conn = await backendFor(reader).connect(reader);
    try {
      const io = new ReaderIo(conn, resolveDriver(reader, driverMode));
      const uidBytes = await io.getUid();
      const id = await identifyWith(io, conn.atr, uidBytes, manualKindFor(reader));
      return { card: cardInfoOf(reader, bytesToHex(uidBytes), conn.atr, id, io, slot.placedAt), unsure: id.kind ? null : id.unsure };
    } finally {
      await conn.disconnect();
    }
  }

  function newSlot(now: number): ReaderSlot {
    return {
      state: 'detecting',
      card: null,
      error: null,
      placedAt: now,
      placement: 0,
      generation: 0,
      attempt: 0,
      timer: null,
      settling: false,
      slow: 0,
      confirmUid: null,
      pendingUid: null,
      changedAt: now,
    };
  }

  /**
   * The tag on `slot` turned out to be `uid`. If we knew (or half knew) another
   * tag there, a different tag was placed: new placement (ends removal waits,
   * counts as "detected" for waitForCard). Same UID: nothing happened.
   */
  function settleIdentity(slot: ReaderSlot, uid: string, changedAt: number): void {
    const ref = slot.confirmUid ?? slot.card?.uid ?? slot.pendingUid;
    if (ref !== null && ref !== uid) {
      slot.placement = nextPlacement();
      slot.placedAt = changedAt;
    }
    slot.confirmUid = null;
    slot.pendingUid = null;
  }

  function clearTimer(slot: ReaderSlot): void {
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
  }

  function settleDelay(reader: string): number {
    return reader === VIRTUAL_READER_NAME ? 0 : IDENTIFY_SETTLE_MS;
  }

  /** (Re)start identification of the tag on `reader`. `confirmUid` = quiet re-check. */
  function startDetection(reader: string, slot: ReaderSlot, delayMs: number, confirmUid: string | null): void {
    clearTimer(slot);
    slot.generation++;
    slot.attempt = 0;
    slot.slow = 0;
    slot.confirmUid = confirmUid;
    if (confirmUid) slot.changedAt = Date.now();
    if (!isCandidate(reader)) {
      slot.state = 'idle';
      slot.card = null;
      slot.error = null;
      slot.confirmUid = null;
      slot.settling = false;
      return;
    }
    if (!confirmUid || !slot.card) {
      // Nothing to keep showing while checking.
      slot.state = 'detecting';
      slot.card = null;
      slot.error = null;
    }
    slot.settling = true;
    scheduleAttempt(reader, slot, delayMs, false);
  }

  /** `quiet`: a slow background re-check (R-MAIN-7) - no 'identify' busy, no state flip. */
  function scheduleAttempt(reader: string, slot: ReaderSlot, delayMs: number, quiet: boolean): void {
    const gen = slot.generation;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void mutex
        .run(() => attemptIdentify(reader, slot, gen, quiet))
        .catch((e) => {
          deps.log(`identify "${reader}": unexpected ${e instanceof Error ? e.message : String(e)}`);
          // Never leave a reidentify() waiting on a round that died.
          if (slot.generation === gen && slot.timer === null) slot.settling = false;
        })
        .finally(() => push());
    }, delayMs);
  }

  /** The round of the current generation concluded with `state`. */
  function conclude(slot: ReaderSlot, state: ReaderSlot['state'], card: CardInfo | null, error: ErrorCode | null): void {
    slot.card = card ? { ...card, detectedAt: slot.placedAt } : null;
    slot.state = state;
    slot.error = error;
    slot.settling = false;
  }

  async function attemptIdentify(reader: string, slot: ReaderSlot, gen: number, quiet: boolean): Promise<void> {
    const current = () => !disposed && slots.get(reader) === slot && slot.generation === gen;
    if (!current()) return;
    if (!isCandidate(reader)) {
      slot.confirmUid = null;
      conclude(slot, 'idle', null, null);
      return;
    }
    if (!quiet) {
      opBusy = { op: 'identify', startedAt: Date.now() };
      push();
    }
    let result: { card: CardInfo; unsure: ErrorCode | null } | null = null;
    let error: ErrorCode | null = null;
    try {
      result = await identifyReader(reader, slot);
    } catch (e) {
      error = errorCodeOf(e, 'READ_FAILED');
      const detail = e instanceof OpError ? e.detail : e instanceof Error ? e.message : undefined;
      // I4: identification never involves keys / passwords; detail is a PC/SC rv name or a short diagnostic.
      deps.log(`identify "${reader}" attempt ${slot.attempt + 1}: ${error}${detail ? ` (${detail})` : ''}`);
    } finally {
      if (!quiet) opBusy = null;
    }
    if (!current()) return; // removed / replaced meanwhile

    slot.attempt++;
    const present = readerInfo(reader)?.cardPresent ?? false;
    if (result && (result.card.kind || result.unsure === null)) {
      // Identified, or a definitive answer (the tag answered: it is not a kind we
      // support, e.g. another FeliCa product).
      settleIdentity(slot, result.card.uid, slot.changedAt);
      conclude(slot, result.card.kind ? 'ready' : 'unsupported', result.card, result.card.kind ? null : 'UNSUPPORTED_TAG');
      return;
    }
    // Not concluded: the tag answered its UID but a probe failed (result.unsure),
    // or the connection itself failed (error).
    const code: ErrorCode = result?.unsure ?? error ?? 'READ_FAILED';
    const retryable = result !== null || !NOT_RETRYABLE.has(code);
    if (retryable && present && slot.attempt <= IDENTIFY_RETRY_MS.length) {
      if (slot.confirmUid && slot.state !== 'detecting') {
        // Could not confirm the tag quietly: stop showing the old one.
        slot.state = 'detecting';
        slot.card = null;
      }
      scheduleAttempt(reader, slot, IDENTIFY_RETRY_MS[slot.attempt - 1], false);
      return;
    }

    // Out of retries (or nothing to retry). A UID we read decides whether it is
    // still the tag we knew; without one we cannot tell: keep the placement,
    // decide on the next UID read.
    if (result) {
      settleIdentity(slot, result.card.uid, slot.changedAt);
    } else {
      if (slot.confirmUid) slot.pendingUid = slot.confirmUid;
      slot.confirmUid = null;
    }
    if (code === 'UNSUPPORTED_TAG') {
      // Definitive (PC/SC refused the card), or "probably unsupported" that persisted.
      conclude(slot, 'unsupported', result?.card ?? null, 'UNSUPPORTED_TAG');
      return;
    }
    // R-MAIN-4: 'error' with the reason (protected / unreadable / not answering)
    // and - when the UID was read - the tag (kind null), never "unsupported".
    if (result && (slot.slow === 0 || slot.error !== code)) {
      deps.log(`identify "${reader}": the tag answered but its type could not be confirmed (${code})`);
    }
    conclude(slot, 'error', result?.card ?? null, code);
    // R-MAIN-7: a few slow, quiet re-checks while the tag stays on this reader.
    if (retryable && present && slot.slow < IDENTIFY_SLOW_RETRY_MS.length) {
      scheduleAttempt(reader, slot, IDENTIFY_SLOW_RETRY_MS[slot.slow++], true);
    }
  }

  /** What the reader / slot looked like when a read / write started (R-MAIN-5). */
  interface OpStart {
    slot: ReaderSlot | undefined;
    generation: number;
  }

  function opStart(reader: string): OpStart {
    const slot = slots.get(reader);
    return { slot, generation: slot?.generation ?? -1 };
  }

  /**
   * A read / write just talked to the tag on `reader`: make the slot say what is
   * really there (CARD-10). A different UID than the slot's card = the tag was
   * replaced without a presence change -> a new placement.
   *
   * R-MAIN-5: when something happened while the operation ran - the tag left or
   * was replaced, or a setting change (driver mode, manual kind) asked for a new
   * identification - that newer request decides the status: the operation's
   * card (identified with the old settings) must not cancel it.
   */
  function noteCard(reader: string, card: CardInfo, start: OpStart): void {
    const now = Date.now();
    let slot = slots.get(reader);
    if (slot !== start.slot) return; // removed / re-inserted meanwhile: its own detection reports it
    if (slot && slot.generation !== start.generation) return; // a newer identification is pending
    if (!slot) {
      slot = newSlot(now);
      slot.placement = nextPlacement();
      slots.set(reader, slot);
      bindManual(reader, slot);
    } else {
      settleIdentity(slot, card.uid, now);
    }
    clearTimer(slot);
    slot.generation++;
    slot.attempt = 0;
    slot.slow = 0;
    conclude(slot, card.kind ? 'ready' : 'unsupported', card, card.kind ? null : 'UNSUPPORTED_TAG');
  }

  // --- backend events --------------------------------------------------------

  function onInserted(reader: string): void {
    const now = Date.now();
    let slot = slots.get(reader);
    if (!slot) {
      slot = newSlot(now);
      slots.set(reader, slot);
    }
    slot.placement = nextPlacement();
    slot.placedAt = now;
    slot.changedAt = now;
    slot.pendingUid = null;
    slot.card = null;
    bindManual(reader, slot);
    startDetection(reader, slot, settleDelay(reader), null);
  }

  function onRemoved(reader: string): void {
    const slot = slots.get(reader);
    if (!slot) return;
    clearTimer(slot);
    slot.generation++;
    slots.delete(reader);
    // The tag a manual kind was set for has left: the override ends with it.
    if (manual && manual.reader === reader && manual.placement === slot.placement) manual = null;
  }

  function onChanged(reader: string): void {
    const slot = slots.get(reader);
    if (!slot) {
      onInserted(reader);
      return;
    }
    const uid = slot.card?.uid ?? slot.pendingUid;
    if (uid && slot.state !== 'idle') {
      startDetection(reader, slot, settleDelay(reader), uid);
    } else {
      // No known tag to compare with: a new placement.
      onInserted(reader);
    }
  }

  /** Drop slots of readers that are gone; identify tags on readers that just became candidates. */
  function reconcile(): void {
    const present = new Set(allReaders().map((r) => r.name));
    for (const name of [...slots.keys()]) {
      if (!present.has(name)) onRemoved(name);
    }
    for (const [name, slot] of slots) {
      // The tag has been there a while: no settle delay.
      if (slot.state === 'idle' && isCandidate(name)) startDetection(name, slot, 0, null);
    }
  }

  function onBackendEvent(source: 'pcsc' | 'sim', e: BackendEvent): void {
    if (disposed) return;
    switch (e.type) {
      case 'service':
        if (source === 'pcsc') {
          pcscState = e.state;
          pcscMessage = e.message;
          pcscNoReaders = !!e.noReaders;
        }
        reconcile();
        break;
      case 'readers':
        reconcile();
        break;
      case 'card-inserted':
        onInserted(e.reader);
        break;
      case 'card-removed':
        onRemoved(e.reader);
        break;
      case 'card-changed':
        onChanged(e.reader);
        break;
    }
    push();
  }

  // --- waiters ---------------------------------------------------------------

  function waitForCard(signal: AbortSignal, opts?: { detectedAfter?: number }): Promise<CardInfo> {
    if (signal.aborted) return Promise.reject(new OpError('CANCELLED'));
    const detectedAfter = opts?.detectedAfter ?? 0;
    const s = snapshot();
    if (s.card && (s.cardState === 'ready' || s.cardState === 'unsupported') && s.card.detectedAt >= detectedAfter) {
      return Promise.resolve(s.card);
    }
    return new Promise<CardInfo>((resolve, reject) => {
      const w: CardWaiter = { resolve, reject, signal, onAbort: () => {}, detectedAfter };
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
    // "The current card" = the tag on the active reader, tracked by presence (not
    // by identification), so a failed identification cannot leave this hanging.
    const reader = activeReaderName();
    const slot = reader ? slots.get(reader) : undefined;
    if (!reader || !slot) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const w: RemovalWaiter = { resolve, reject, signal, onAbort: () => {}, reader, placement: slot.placement };
      w.onAbort = () => {
        const i = removalWaiters.indexOf(w);
        if (i >= 0) removalWaiters.splice(i, 1);
        reject(new OpError('CANCELLED'));
      };
      removalWaiters.push(w);
      signal.addEventListener('abort', w.onAbort, { once: true });
    });
  }

  function whenSettled(reader: string, slot: ReaderSlot): Promise<void> {
    if (slots.get(reader) !== slot || !slot.settling) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const w: SettleWaiter = {
        reader,
        slot,
        resolve,
        timer: setTimeout(() => {
          const i = settleWaiters.indexOf(w);
          if (i >= 0) settleWaiters.splice(i, 1);
          resolve();
        }, SETTLE_TIMEOUT_MS),
      };
      settleWaiters.push(w);
    });
  }

  // --- read / write ----------------------------------------------------------

  async function withOp<T>(op: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    opBusy = { op, startedAt: Date.now() };
    push();
    try {
      return await fn();
    } finally {
      opBusy = null;
      push();
    }
  }

  function keyIds(ids: string[] | undefined): string[] {
    if (ids !== undefined) return ids;
    // FLOW-2 / WRITE-3: no keys named -> every key in the store (the public
    // standard keys first, then the operator's own; I3).
    return typeof deps.allKeyIds === 'function' ? deps.allKeyIds() : [];
  }

  function validateWrites(req: WriteRequest): void {
    for (const w of req.writes) {
      // UID / manufacturer block: never writable, whatever is allowed (I1/I2). Its
      // own code, so the message never suggests a switch that would allow it (R-UX-11).
      if (isForbiddenUnit(req.kind, w.unit)) throw new OpError('FORBIDDEN_UNIT', `unit ${w.unit}`);
      if (isMifare(req.kind) && mifareIsTrailer(w.unit)) {
        if (w.data.length < 16 || parseAccessBits(w.data) === null) throw new OpError('INVALID_ACCESS_BITS', `block ${w.unit}`);
      }
      if (isProtectedUnit(req.kind, w.unit) && !req.allowProtected) throw new OpError('PROTECTED_UNIT', `unit ${w.unit}`);
    }
  }

  /** Shutting down: an operation that has not started yet is not started (nothing is sent). */
  function refuseIfDisposed(): void {
    if (disposed) throw new OpError('CANCELLED', 'shutting down');
  }

  /**
   * The "did the tag leave?" check for a whole-tag operation (R-MAIN-3). NTAG on a
   * storage reader: re-read the CC page, which the identification just read (raw
   * drivers: none - a refusal there is the tag's own NAK). A manually forced kind
   * proves nothing about what the tag answers, so FeliCa is not probed then;
   * MIFARE only ever re-opens a sector this tag opened in the same operation.
   */
  function presenceOptions(io: ReaderIo, id: Identified): { probePage: number | null; checkPresence: boolean } {
    return {
      probePage: !io.rawCommands && id.source === 'cc' ? 3 : null,
      checkPresence: id.source !== 'manual',
    };
  }

  function readTag(opts: ReadOptions): Promise<TagImage> {
    return mutex.run(async () => {
      refuseIfDisposed();
      const reader = requireActiveReader();
      const start = opStart(reader);
      return withOp('read', async () => {
        const conn = await backendFor(reader).connect(reader);
        try {
          const io = new ReaderIo(conn, resolveDriver(reader, driverMode));
          const uidBytes = await io.getUid();
          const uid = bytesToHex(uidBytes);
          const id = await identifyWith(io, conn.atr, uidBytes, manualKindFor(reader));
          const card = cardInfoOf(reader, uid, conn.atr, id, io, Date.now());
          const kind = id.kind;
          if (!kind) {
            // R-MAIN-4: a probe failed -> say why (protected / unreadable), the
            // same way the identification does; "unsupported" only for an answer
            // that says so (definitive, or "probably" - not marked on the status).
            if (id.unsure && id.unsure !== 'UNSUPPORTED_TAG') throw new OpError(id.unsure, 'could not identify the tag');
            if (id.unsure === null) noteCard(reader, card, start);
            throw new OpError('UNSUPPORTED_TAG');
          }
          const presence = presenceOptions(io, id);
          let image: TagImage;
          if (isNtag(kind)) {
            if (opts.ntagPassword && !io.rawCommands) {
              // D11 / R-UX-1: never skip the password silently on a storage reader.
              noteCard(reader, card, start);
              throw new OpError('READER_NO_AUTH', `driver ${io.driver}`);
            }
            const r = await readNtag(io, kind, { password: opts.ntagPassword, probePage: presence.probePage });
            image = { kind, uid, data: r.data, unitStatus: r.unitStatus, readAt: Date.now(), ntag: r.extras };
          } else if (isFelica(kind)) {
            const r = await readFelica(io, kind, uidBytes, { checkPresence: presence.checkPresence });
            image = { kind, uid, data: r.data, unitStatus: r.unitStatus, readAt: Date.now(), felica: r.info };
          } else {
            const keys = deps.resolveKeys(keyIds(opts.mifareKeyIds));
            const r = await readMifare(io, kind, keys);
            image = { kind, uid, data: r.data, unitStatus: r.unitStatus, readAt: Date.now(), mifare: { sectors: r.sectors } };
          }
          // What was just read is what is on the reader (CARD-10).
          noteCard(reader, card, start);
          return image;
        } finally {
          await conn.disconnect();
        }
      });
    });
  }

  /** NTAG PWD / PACK always read back as 00 (NTAG21x datasheet): nothing to compare (R-WRITE-2). */
  function unverifiable(kind: TagKind, unit: number): boolean {
    if (!isNtag(kind)) return false;
    const p = ntagPages(kind);
    return unit === p.pwd || unit === p.pack;
  }

  function writeTag(req: WriteRequest): Promise<WriteResult> {
    return mutex.run(async () => {
      refuseIfDisposed();
      // Refuse an invalid request before touching the tag.
      validateWrites(req);
      const reader = requireActiveReader();
      const driver = resolveDriver(reader, driverMode);
      if (req.ntagPassword && isNtag(req.kind) && !supportsRawCommands(driver)) {
        // D11 / R-UX-1: a storage reader cannot authenticate - refuse before any APDU.
        throw new OpError('READER_NO_AUTH', `driver ${driver}`);
      }
      const start = opStart(reader);
      return withOp('write', async () => {
        const conn = await backendFor(reader).connect(reader);
        try {
          const io = new ReaderIo(conn, driver);
          const uidBytes = await io.getUid();
          const uid = bytesToHex(uidBytes);
          // WRITE-8: the kind decides which pages are config / password / lock -
          // never lay out one model's data on another model.
          const id = await identifyWith(io, conn.atr, uidBytes, manualKindFor(reader));
          if (id.kind) noteCard(reader, cardInfoOf(reader, uid, conn.atr, id, io, Date.now()), start);
          if (req.expectedUid && uid !== req.expectedUid.toUpperCase()) throw new OpError('UID_MISMATCH');
          if (id.kind !== req.kind) {
            if (!id.kind && id.unsure) throw new OpError(id.unsure, 'could not identify the tag');
            throw new OpError('KIND_MISMATCH', `tag ${id.kind ?? 'unknown'}, data ${req.kind}`);
          }

          const presence = presenceOptions(io, id);
          let out: UnitWriteOutcome;
          if (isNtag(req.kind)) {
            out = await writeNtagPages(io, req.writes, { password: req.ntagPassword, probePage: presence.probePage });
          } else if (isFelica(req.kind)) {
            out = await writeFelica(io, req.kind, uidBytes, req.writes, { checkPresence: presence.checkPresence });
          } else {
            out = await writeMifare(io, req.writes, deps.resolveKeys(keyIds(req.mifareKeyIds)));
          }

          let aborted = out.aborted;
          let verified: boolean | null = null;
          const mismatched: number[] = [];
          if (req.verify) {
            verified = aborted === null;
            const keys = isMifare(req.kind) ? deps.resolveKeys(keyIds(req.mifareKeyIds)) : [];
            for (const w of aborted === null ? req.writes : []) {
              if (!out.written.includes(w.unit)) continue;
              if (unverifiable(req.kind, w.unit)) continue;
              try {
                const back = isNtag(req.kind)
                  ? await readNtagPage(io, w.unit)
                  : isFelica(req.kind)
                    ? await readFelicaBlock(io, req.kind, uidBytes, w.unit)
                    : await readMifareBlock(io, w.unit, keys);
                if (back === null) {
                  // unreadable (e.g. a write-only / protected FeliCa block) - skip verify
                  continue;
                }
                // A MIFARE sector trailer never reads its Key A back (and may hide
                // Key B): compare against what the card can actually return, so a
                // correct trailer write is not reported as a mismatch (I4: keys are
                // not read back / exposed anyway).
                const expected = isMifare(req.kind) && mifareIsTrailer(w.unit) ? mifareTrailerReadbackMask(w.data) : w.data;
                if (!bytesEqual(back, expected)) {
                  mismatched.push(w.unit);
                  verified = false;
                }
              } catch (e) {
                if (isLinkLost(e)) {
                  // Left during the read-back: everything was written, but it is
                  // not confirmed (ISSUE-2 tells this apart from a failed write).
                  aborted = e.code;
                  verified = false;
                  break;
                }
                mismatched.push(w.unit);
                verified = false;
              }
            }
          }
          return { uid, written: out.written, failed: out.failed, verified, mismatched, aborted, notAttempted: out.notAttempted };
        } catch (e) {
          // A transport failure before / while writing is a write failure for the operator.
          if (e instanceof OpError && e.code === 'READ_FAILED') throw new OpError('WRITE_FAILED', e.detail);
          throw e;
        } finally {
          await conn.disconnect();
        }
      });
    });
  }

  function transmitApdu(apdu: Uint8Array): Promise<Uint8Array> {
    if (!deps.isAdvancedMode()) return Promise.reject(new OpError('ADVANCED_REQUIRED', 'raw APDUs'));
    return mutex.run(async () => {
      refuseIfDisposed();
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

  /** Identify again the tags on candidate readers that ended in error / unsupported. */
  function retryFailed(): void {
    for (const [name, slot] of slots) {
      if ((slot.state === 'error' || slot.state === 'unsupported') && isCandidate(name)) {
        startDetection(name, slot, 0, slot.card?.uid ?? null);
      }
    }
  }

  /** Identify again (quietly) every identified tag, e.g. after the driver / kind setting changed. */
  function reidentifyAll(): void {
    for (const [name, slot] of slots) {
      if (slot.state === 'idle') continue;
      startDetection(name, slot, 0, slot.card?.uid ?? null);
    }
  }

  async function refreshReaders(): Promise<void> {
    await pcsc.refresh();
    await sim.refresh();
    // "Detect readers again" must also un-stick a tag whose identification failed (CARD-3).
    retryFailed();
    push();
  }

  async function reidentify(): Promise<void> {
    await pcsc.refresh();
    const reader = requireActiveReader();
    let slot = slots.get(reader);
    if (!slot) {
      if (!readerInfo(reader)?.cardPresent) throw new OpError('NO_CARD');
      onInserted(reader);
      slot = slots.get(reader);
      if (!slot) return;
    }
    startDetection(reader, slot, 0, slot.card?.uid ?? null);
    push();
    await whenSettled(reader, slot);
  }

  async function selectReader(name: string | null): Promise<void> {
    selectedReader = name;
    // The newly selected reader may hold a tag nobody identified yet.
    reconcile();
    push();
  }

  async function setDriverMode(mode: ReaderDriverMode): Promise<void> {
    if (mode === driverMode) return;
    driverMode = mode;
    reidentifyAll(); // rawCommands / driver / kind may change
    push();
  }

  async function setManualKind(kind: TagKind | null): Promise<void> {
    const before = manual;
    const reader = activeReaderName();
    const slot = reader ? slots.get(reader) : undefined;
    manual = kind ? { kind, reader: slot ? reader : null, placement: slot ? slot.placement : null } : null;
    // Re-identify the tag the override was / is about (quietly: same tag, same placement).
    const affected = new Set<string>();
    if (slot && reader) affected.add(reader);
    if (before?.reader) affected.add(before.reader);
    for (const name of affected) {
      const s = slots.get(name);
      if (s && s.state !== 'idle') startDetection(name, s, 0, s.card?.uid ?? null);
    }
    push();
  }

  async function setSimulator(opts: { enabled: boolean; kind?: TagKind }): Promise<void> {
    sim.setEnabled(opts.enabled, opts.kind);
    reconcile();
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
    issueBusy = op ? { op, startedAt: Date.now() } : null;
    push();
  }

  async function dispose(): Promise<void> {
    disposed = true; // queued identifications / operations not started yet now return at once
    for (const slot of slots.values()) clearTimer(slot);
    for (const w of settleWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
    // R-MAIN-2: let the read / write in progress finish before the readers are
    // closed (closing the window mid-write must not leave a half-written tag).
    const cap: { timer?: ReturnType<typeof setTimeout> } = {};
    await Promise.race([
      mutex.run(async () => {}),
      new Promise<void>((resolve) => {
        cap.timer = setTimeout(() => {
          deps.log(`dispose: the operation in progress did not finish within ${DISPOSE_WAIT_MS} ms; closing the readers anyway`);
          resolve();
        }, DISPOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(cap.timer);
    await pcsc.stop();
    await sim.stop();
    statusListeners.clear();
  }

  // Start both backends. Their start() sets the listener synchronously before the
  // first await, so events emitted by later control calls are not missed.
  void pcsc.start((e) => onBackendEvent('pcsc', e));
  void sim.start((e) => onBackendEvent('sim', e));

  return {
    getStatus: snapshot,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    refreshReaders,
    reidentify,
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
