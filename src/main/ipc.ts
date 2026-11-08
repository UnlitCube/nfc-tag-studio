// IPC handler registration. Integrator-owned.
// Registers one ipcMain.handle per INVOKE_CHANNELS entry, wrapping the result in
// an Envelope so main never rejects across the bridge (errors carry a localized
// message + code; the renderer's lib/api.ts unwraps them).
import { ipcMain, BrowserWindow, app, shell } from 'electron';
import { INVOKE_CHANNELS } from '@shared/api';
import type { AppInfo, Envelope, FileFilter, IssueState } from '@shared/api';
import type {
  AppSettings,
  IssueJob,
  MifareKeyEntry,
  ReadOptions,
  ReaderDriverMode,
  ReaderStatus,
  TagImage,
  WriteRequest,
  WriteResult,
} from '@shared/types';
import type { TagKind } from '@shared/tags';
import { bytesToHex, hexToBytes } from '@shared/hex';
import type { NfcService } from './nfc/contract';
import type { SettingsService } from './services/settings';
import type { KeyStore } from './services/keystore';
import type { IssueLog } from './services/issuelog';
import type { FileService } from './services/files';
import type { IssueEngine } from './issue/engine';
import { OpError } from './errors';
import { toErrorPayload } from './errors';

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  nfc: NfcService;
  settings: SettingsService;
  keys: KeyStore;
  issueLog: IssueLog;
  files: FileService;
  issue: IssueEngine;
  isAdvancedMode: () => boolean;
}

type Handlers = {
  [K in keyof typeof INVOKE_CHANNELS]: (...args: any[]) => Promise<unknown> | unknown;
};

export function registerIpc(deps: IpcDeps): () => void {
  const lang = () => deps.settings.get().language;

  const handlers: Handlers = {
    // --- app ---
    getAppInfo: (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }),
    openExternal: async (url: string) => {
      if (!/^https?:\/\//i.test(url)) throw new OpError('INVALID_INPUT', 'refused non-http url');
      await shell.openExternal(url);
    },

    // --- settings ---
    getSettings: (): AppSettings => deps.settings.get(),
    saveSettings: (next: AppSettings) => deps.settings.save(next),

    // --- reader ---
    getReaderStatus: (): ReaderStatus => deps.nfc.getStatus(),
    refreshReaders: () => deps.nfc.refreshReaders(),
    selectReader: (name: string | null) => deps.nfc.selectReader(name),
    setDriverMode: (mode: ReaderDriverMode) => deps.nfc.setDriverMode(mode),
    setManualKind: (kind: TagKind | null) => deps.nfc.setManualKind(kind),

    // --- simulator ---
    setSimulator: (opts: { enabled: boolean; kind?: TagKind }) => deps.nfc.setSimulator(opts),
    simulatorTap: (present: boolean) => deps.nfc.simulatorTap(present),
    simulatorNewTag: (kind: TagKind) => deps.nfc.simulatorNewTag(kind),

    // --- tag ops ---
    readTag: (opts: ReadOptions): Promise<TagImage> => {
      if (deps.issue.getState().running) throw new OpError('BUSY');
      return deps.nfc.readTag(opts ?? {});
    },
    writeTag: (req: WriteRequest): Promise<WriteResult> => {
      if (deps.issue.getState().running) throw new OpError('BUSY');
      return deps.nfc.writeTag(req);
    },
    transmitApdu: async (apduHex: string): Promise<string> => {
      if (!deps.isAdvancedMode()) throw new OpError('ACCESS_DENIED', 'advanced mode off');
      if (deps.issue.getState().running) throw new OpError('BUSY');
      const resp = await deps.nfc.transmitApdu(hexToBytes(apduHex));
      return bytesToHex(resp);
    },

    // --- keys ---
    listKeys: (): MifareKeyEntry[] => deps.keys.list(),
    addKey: (input: { label: string; keyHex: string }) => deps.keys.add(input),
    removeKey: (id: string) => deps.keys.remove(id),

    // --- issue ---
    startIssue: (job: IssueJob) => {
      deps.issue.start(job);
    },
    stopIssue: () => {
      deps.issue.stop();
    },
    getIssueState: (): IssueState => deps.issue.getState(),
    listIssueLog: (query: { limit?: number; jobId?: string }) => deps.issueLog.list(query ?? {}),
    clearIssueLog: () => deps.issueLog.clear(),

    // --- files ---
    openFile: (opts: { title?: string; filters: FileFilter[] }) => deps.files.open(deps.getWindow, opts),
    saveFile: (opts: { title?: string; defaultName: string; filters: FileFilter[]; bytes: Uint8Array }) =>
      deps.files.save(deps.getWindow, opts),
    revealFile: (token: string) => deps.files.reveal(token),
  };

  const registered: string[] = [];
  for (const [method, channel] of Object.entries(INVOKE_CHANNELS) as [keyof typeof INVOKE_CHANNELS, string][]) {
    const handler = handlers[method];
    ipcMain.handle(channel, async (_e, ...args): Promise<Envelope<unknown>> => {
      try {
        const value = await handler(...args);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: toErrorPayload(err, lang()) };
      }
    });
    registered.push(channel);
  }

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
  };
}
