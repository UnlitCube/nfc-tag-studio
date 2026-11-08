// Service wiring. Integrator-owned.
// Builds the services + NFC service + issue engine, registers IPC, and pushes
// settings / reader status / issue events to the renderer.
import type { BrowserWindow } from 'electron';
import { PUSH_CHANNELS } from '@shared/api';
import type { IssueEvent, ReaderStatus } from '@shared/types';
import { bytesToHex } from '@shared/hex';
import { createSettingsService } from './services/settings';
import { createKeyStore } from './services/keystore';
import { createIssueLog } from './services/issuelog';
import { createFileService } from './services/files';
import { createNfcService } from './nfc/service';
import { createIssueEngine } from './issue/engine';
import { registerIpc } from './ipc';

let dispose: (() => void | Promise<void>)[] = [];

function send(getWindow: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export async function startServices(getWindow: () => BrowserWindow | null): Promise<void> {
  const logLine = (line: string) => console.log(`[nfc] ${line}`);

  const settings = await createSettingsService();
  const keys = await createKeyStore();
  const issueLog = await createIssueLog();
  const files = createFileService();

  const nfc = createNfcService({
    resolveKeys: (ids) => keys.resolve(ids),
    log: logLine,
    isAdvancedMode: () => settings.get().advancedMode,
  });

  // Apply the saved driver mode / preferred reader on startup.
  const initial = settings.get();
  await nfc.setDriverMode(initial.driverMode);
  if (initial.preferredReader) await nfc.selectReader(initial.preferredReader);

  const issue = createIssueEngine({
    nfc,
    log: issueLog,
    emit: (e: IssueEvent) => send(getWindow, PUSH_CHANNELS.issueEvent, e),
    newId: () => `log-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`,
    now: () => new Date(),
  });

  // Push subscriptions.
  const offStatus = nfc.onStatus((s: ReaderStatus) => send(getWindow, PUSH_CHANNELS.readerStatus, s));
  const offSettings = settings.onChange((s) => send(getWindow, PUSH_CHANNELS.settings, s));

  const unregister = registerIpc({
    getWindow,
    nfc,
    settings,
    keys,
    issueLog,
    files,
    issue,
    isAdvancedMode: () => settings.get().advancedMode,
  });

  dispose = [
    () => {
      issue.stop();
    },
    offStatus,
    offSettings,
    unregister,
    () => nfc.dispose(),
  ];
}

export async function stopServices(): Promise<void> {
  for (const d of dispose) {
    try {
      await d();
    } catch (err) {
      console.error('[quit] dispose failed', err);
    }
  }
  dispose = [];
}
