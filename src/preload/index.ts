// Preload: typed bridge from the renderer to main. Integrator-owned.
// sandbox: true -> this file is bundled to CommonJS and may only use 'electron'.
// It exposes window.nfcBridge (BridgeApi): invoke methods resolve with raw
// Envelopes; the renderer (src/renderer/src/lib/api.ts) unwraps them.

import { contextBridge, ipcRenderer } from 'electron';
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '@shared/api';
import type { BridgeApi } from '@shared/api';

function invoker(channel: string) {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

function subscriber<T>(channel: string) {
  return (cb: (value: T) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const invokes = Object.fromEntries(
  Object.entries(INVOKE_CHANNELS).map(([method, channel]) => [method, invoker(channel)]),
);

const bridge = {
  ...invokes,
  onSettings: subscriber(PUSH_CHANNELS.settings),
  onReaderStatus: subscriber(PUSH_CHANNELS.readerStatus),
  onIssueEvent: subscriber(PUSH_CHANNELS.issueEvent),
} as unknown as BridgeApi;

contextBridge.exposeInMainWorld('nfcBridge', bridge);
