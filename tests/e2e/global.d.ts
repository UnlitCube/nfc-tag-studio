// window.nfcBridge as the preload exposes it (for page.evaluate in the E2E).
import type { BridgeApi } from '../../src/shared/api';

declare global {
  interface Window {
    nfcBridge: BridgeApi;
  }
}

export {};
