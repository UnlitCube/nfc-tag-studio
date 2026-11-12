// NfcService public interface used by the IPC layer and the issue engine.
// CONTRACT FILE - frozen (integrator-owned). Implementation: ./service.ts
// (owner: agent "main-nfc"), exported as `createNfcService(deps, init?)`.

import type { TagKind } from '@shared/tags';
import type { CardInfo, ReadOptions, ReaderDriverMode, ReaderStatus, TagImage, WriteRequest, WriteResult } from '@shared/types';

/** A MIFARE key resolved from the key store. Never logged, never sent to the renderer. */
export interface ResolvedKey {
  id: string;
  label: string;
  /** 6 bytes. */
  key: Uint8Array;
}

export interface NfcServiceDeps {
  /** Resolve key ids to key bytes (unknown ids are skipped). */
  resolveKeys(ids: string[]): ResolvedKey[];
  /**
   * Every key id in the store, built-in public keys first. Used when a read /
   * write does not name keys (ReadOptions.mifareKeyIds undefined), so a factory
   * MIFARE card reads from the home / binary screens without extra steps.
   */
  allKeyIds(): string[];
  /** Diagnostic log line (no secrets). */
  log(line: string): void;
  /** Whether advanced mode is on (transmitApdu is refused otherwise). */
  isAdvancedMode(): boolean;
}

/**
 * Initial settings applied BEFORE the backends start, so the very first poll
 * already honours them (no APDU to a token the operator never selected: I6).
 */
export interface NfcServiceInit {
  driverMode?: ReaderDriverMode;
  preferredReader?: string | null;
  /**
   * false = do not start the PC/SC backend at all (E2E / CI: only the virtual
   * reader exists, so tests can never touch a real tag). Default true.
   */
  pcsc?: boolean;
}

export interface NfcService {
  getStatus(): ReaderStatus;
  /** Status snapshots on every change. Returns unsubscribe. */
  onStatus(cb: (s: ReaderStatus) => void): () => void;

  refreshReaders(): Promise<void>;
  /** Identify the tag on the active reader again (retry after cardState 'error' / 'unsupported'). */
  reidentify(): Promise<void>;
  selectReader(name: string | null): Promise<void>;
  setDriverMode(mode: ReaderDriverMode): Promise<void>;
  /** Applies to the tag on the reader now (or the next one placed); cleared when that tag leaves. */
  setManualKind(kind: TagKind | null): Promise<void>;

  setSimulator(opts: { enabled: boolean; kind?: TagKind }): Promise<void>;
  simulatorTap(present: boolean): Promise<void>;
  simulatorNewTag(kind: TagKind): Promise<void>;

  /**
   * Read the whole tag on the active reader. Rejects OpError NO_READER / NO_CARD /
   * UNSUPPORTED_TAG / CARD_REMOVED / BUSY / READER_IN_USE / CARD_UNRESPONSIVE /
   * ACCESS_DENIED (a protected tag that cannot even be identified, e.g. an NTAG
   * whose CC is read-protected on a storage reader) / READ_FAILED. Units that
   * cannot be read (password / missing key) are marked 'denied' instead of
   * failing the whole read. A tag that leaves the reader mid-read rejects
   * CARD_REMOVED (never a "successful" image with error units). A successful
   * read refreshes the active reader's card.
   */
  readTag(opts: ReadOptions): Promise<TagImage>;

  /**
   * Write units in order. Re-reads the UID first and rejects UID_MISMATCH when
   * req.expectedUid is set and differs; rejects KIND_MISMATCH when the tag's
   * identified kind differs from req.kind. Rejects PROTECTED_UNIT when a protected
   * unit is present and !allowProtected; forbidden units (UID / block 0) always
   * rejected; MIFARE trailers with invalid access bits -> INVALID_ACCESS_BITS.
   * A tag removed mid-write resolves with `aborted: 'CARD_REMOVED'` and the
   * untried units in `notAttempted` (written units stay in `written`); removed
   * during the read-back: aborted CARD_REMOVED, failed [], notAttempted [],
   * verified false (everything written, not verified). READ_FAILED before / during
   * the write is reported as WRITE_FAILED.
   */
  writeTag(req: WriteRequest): Promise<WriteResult>;

  /** Advanced mode only (else ADVANCED_REQUIRED). */
  transmitApdu(apdu: Uint8Array): Promise<Uint8Array>;

  /**
   * Resolve when a card is present and identified on the active reader
   * (immediately if already). `detectedAfter`: only a card detected after this
   * epoch-ms (a tag left on the reader from before does not count). Rejects
   * CANCELLED on abort.
   */
  waitForCard(signal: AbortSignal, opts?: { detectedAfter?: number }): Promise<CardInfo>;
  /** Resolve when the current card leaves the reader. Rejects CANCELLED on abort. */
  waitForRemoval(signal: AbortSignal): Promise<void>;

  /**
   * Mark the issue engine as running (status display only - it is NOT a lock;
   * readTag/writeTag still serialize through the service's internal mutex, and
   * the IPC layer refuses single-tag operations from the UI while issuing).
   */
  setBusy(op: 'issue' | null): void;

  dispose(): Promise<void>;
}
