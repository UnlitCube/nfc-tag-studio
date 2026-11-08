// PC/SC reader backend (koffi -> winscard.dll / PCSC.framework / libpcsclite.so.1).
// STUB with frozen signature. Owner: agent "main-pcsc".
import type { ReaderBackend } from '../backend';

/**
 * Create the PC/SC backend. Must never throw synchronously and must keep main
 * alive when the native library or the service is missing (emit a 'service'
 * event with state 'unavailable' and retry periodically).
 */
export function createPcscBackend(log: (line: string) => void): ReaderBackend {
  void log;
  return {
    id: 'pcsc',
    async start(listener) {
      listener({ type: 'service', state: 'unavailable', message: 'pcsc backend not implemented' });
    },
    async stop() {},
    async refresh() {},
    readers() {
      return [];
    },
    async connect() {
      throw new Error('pcsc backend not implemented');
    },
  };
}
