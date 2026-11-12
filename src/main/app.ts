// Service wiring. Owner: main-app.
// Builds the services + NFC service + issue engine, registers IPC, and pushes
// settings / reader status / issue events to the renderer.
import { app, type BrowserWindow } from 'electron';
import { PUSH_CHANNELS } from '@shared/api';
import type { IssueEvent, LanguageSetting, ReaderStatus } from '@shared/types';
import { bytesToHex } from '@shared/hex';
import { createSettingsService, type SettingsService } from './services/settings';
import { createKeyStore } from './services/keystore';
import { createIssueLog } from './services/issuelog';
import { createIssueRunStore } from './services/issuerun';
import { createFileService } from './services/files';
import { pcscEnabled } from './services/policy';
import { createNfcService } from './nfc/service';
import { createIssueEngine, type IssueEngine } from './issue/engine';
import { registerIpc } from './ipc';

let dispose: (() => void | Promise<void>)[] = [];
let settingsRef: SettingsService | null = null;
let issueRef: IssueEngine | null = null;

function send(getWindow: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** The UI language (for main-process dialogs). 'ja' until the settings are loaded. */
export function uiLanguage(): LanguageSetting {
  return settingsRef?.get().language ?? 'ja';
}

/** True while a batch issue run is active (quit asks first). */
export function isIssuing(): boolean {
  return issueRef?.getState().running ?? false;
}

export async function startServices(getWindow: () => BrowserWindow | null): Promise<void> {
  const logLine = (line: string) => console.log(`[nfc] ${line}`);

  const settings = await createSettingsService();
  const keys = await createKeyStore();
  const issueLog = await createIssueLog();
  // The last issue run (summary only), offered as "resume" after a restart (R-ISSUE-4).
  const issueRuns = await createIssueRunStore();
  const files = createFileService();
  settingsRef = settings;

  // The saved driver mode / preferred reader are applied BEFORE the backends
  // start, so the very first poll already honours them (no APDU to a token the
  // operator never selected: I6, audit CARD-2).
  const initial = settings.get();
  const nfc = createNfcService(
    {
      resolveKeys: (ids) => keys.resolve(ids),
      // A read/write that names no keys tries every key the operator holds,
      // built-in public keys first (I3) - so a factory MIFARE card reads from the
      // home / binary screens too (audit WRITE-3 / FLOW-2).
      allKeyIds: () => keys.allIds(),
      log: logLine,
      isAdvancedMode: () => settings.get().advancedMode,
    },
    {
      driverMode: initial.driverMode,
      preferredReader: initial.preferredReader,
      // E2E / CI: NFCTS_NO_PCSC=1 = virtual reader only, never a real reader or tag
      // (ignored in a packaged build, D8).
      pcsc: pcscEnabled(process.env, app.isPackaged),
    },
  );

  const issue = createIssueEngine({
    nfc,
    log: issueLog,
    emit: (e: IssueEvent) => send(getWindow, PUSH_CHANNELS.issueEvent, e),
    newId: () => `log-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`,
    now: () => new Date(),
    lang: () => settings.get().language,
    runStore: issueRuns,
  });
  issueRef = issue;

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
    // Let the tag being written finish before the reader goes away (never leave
    // a half-written tag because the app was closed mid-write).
    () => issue.stopAndWait(5000),
    offStatus,
    offSettings,
    unregister,
    () => nfc.dispose(),
    () => {
      issueRef = null;
      settingsRef = null;
    },
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
