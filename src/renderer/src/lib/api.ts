// Renderer-side API: unwraps the preload's envelopes into an NfcApi that throws
// AppError (keeps the error code; message is already localized by main).
// Integrator-owned.
import { AppError } from '@shared/api';
import type { BridgeApi, Envelope, NfcApi } from '@shared/api';

declare global {
  interface Window {
    nfcBridge: BridgeApi;
  }
}

function unwrap<T>(env: Envelope<T>): T {
  if (env && typeof env === 'object' && 'ok' in env) {
    if (env.ok) return env.value;
    throw new AppError(env.error);
  }
  throw new AppError({ code: 'INTERNAL', message: 'Invalid response from main process' });
}

function makeApi(bridge: BridgeApi): NfcApi {
  if (!bridge) {
    throw new Error('window.nfcBridge is missing - the preload did not load');
  }
  const api: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(bridge)) {
    if (typeof fn !== 'function') continue;
    if (name.startsWith('on')) {
      api[name] = fn; // subscriptions pass through
    } else {
      api[name] = async (...args: unknown[]) => unwrap(await (fn as (...a: unknown[]) => Promise<Envelope<unknown>>)(...args));
    }
  }
  return api as unknown as NfcApi;
}

export const api: NfcApi = makeApi(window.nfcBridge);

export { AppError };

/** Message to show for anything thrown by api.* calls. */
export function errorText(err: unknown): { message: string; detail?: string } {
  if (err instanceof AppError) return { message: err.message, detail: err.detail };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}
