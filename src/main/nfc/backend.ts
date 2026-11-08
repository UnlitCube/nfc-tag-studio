// Reader backend abstraction. CONTRACT FILE - frozen (integrator-owned).
// Implemented by the PC/SC backend (koffi -> winscard.dll / PCSC.framework /
// libpcsclite) and by the simulator (virtual reader + virtual tags). Everything
// above this layer (tag operations, issue engine) speaks APDUs only, so the
// simulator exercises the same code paths as real hardware.

import type { ReaderInfo } from '@shared/types';

export type BackendEvent =
  | { type: 'service'; state: 'ok' | 'unavailable' | 'error'; message: string | null }
  /** Full reader list snapshot (sent whenever it changes). */
  | { type: 'readers'; readers: ReaderInfo[] }
  | { type: 'card-inserted'; reader: string; atr: Uint8Array }
  | { type: 'card-removed'; reader: string };

export interface CardConnection {
  readonly readerName: string;
  readonly atr: Uint8Array;
  /**
   * Send one APDU, resolve with the full response INCLUDING SW1 SW2.
   * Rejects with OpError('CARD_REMOVED') when the card left the field,
   * OpError('READ_FAILED' | 'INTERNAL') for transport errors.
   */
  transmit(apdu: Uint8Array): Promise<Uint8Array>;
  /** Release the card. Idempotent. */
  disconnect(): Promise<void>;
}

export interface ReaderBackend {
  readonly id: 'pcsc' | 'simulator';
  /** Start monitoring. Events are delivered until stop(). Must not throw when the service is missing (emit 'service' instead). */
  start(listener: (e: BackendEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** Re-enumerate readers now. */
  refresh(): Promise<void>;
  /** Last known reader list. */
  readers(): ReaderInfo[];
  /** Connect (shared mode) to the card on `readerName`. Rejects OpError('NO_CARD') when empty. */
  connect(readerName: string): Promise<CardConnection>;
}
