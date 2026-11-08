// NfcService public interface used by the IPC layer and the issue engine.
// CONTRACT FILE - frozen (integrator-owned). Implementation: ./service.ts
// (owner: agent "main-nfc"), exported as `createNfcService(deps)`.

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
  /** Diagnostic log line (no secrets). */
  log(line: string): void;
  /** Whether advanced mode is on (transmitApdu is refused otherwise). */
  isAdvancedMode(): boolean;
}

export interface NfcService {
  getStatus(): ReaderStatus;
  /** Status snapshots on every change. Returns unsubscribe. */
  onStatus(cb: (s: ReaderStatus) => void): () => void;

  refreshReaders(): Promise<void>;
  selectReader(name: string | null): Promise<void>;
  setDriverMode(mode: ReaderDriverMode): Promise<void>;
  setManualKind(kind: TagKind | null): Promise<void>;

  setSimulator(opts: { enabled: boolean; kind?: TagKind }): Promise<void>;
  simulatorTap(present: boolean): Promise<void>;
  simulatorNewTag(kind: TagKind): Promise<void>;

  /**
   * Read the whole tag on the active reader. Rejects OpError NO_READER / NO_CARD /
   * UNSUPPORTED_TAG / CARD_REMOVED / BUSY. Units that cannot be read (password /
   * missing key) are marked 'denied' instead of failing the whole read.
   */
  readTag(opts: ReadOptions): Promise<TagImage>;

  /**
   * Write units in order. Re-reads the UID first and rejects UID_MISMATCH when
   * req.expectedUid is set and differs. Rejects PROTECTED_UNIT when a protected
   * unit is present and !allowProtected; forbidden units (UID / block 0) always
   * rejected; MIFARE trailers with invalid access bits -> INVALID_ACCESS_BITS.
   */
  writeTag(req: WriteRequest): Promise<WriteResult>;

  /** Advanced mode only. */
  transmitApdu(apdu: Uint8Array): Promise<Uint8Array>;

  /** Resolve when a card is present and identified (immediately if already). Rejects CANCELLED on abort. */
  waitForCard(signal: AbortSignal): Promise<CardInfo>;
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
