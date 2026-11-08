// Service wiring: settings, key store, NFC service, issue engine, IPC handlers.
// STUB written by the integrator for the toolchain check.
// Owner: agent "main-app" - replace with the real implementation.

import type { BrowserWindow } from 'electron';

export async function startServices(getWindow: () => BrowserWindow | null): Promise<void> {
  void getWindow;
}

export async function stopServices(): Promise<void> {
  // nothing yet
}
