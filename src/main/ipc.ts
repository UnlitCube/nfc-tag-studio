// IPC handler registration. Owner: main-app.
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

/**
 * MIFARE keys: an empty list names no keys, the same as "not given". The service
 * then tries every key the operator holds (built-in public keys first, I3), so a
 * factory card reads the same from every screen (audit WRITE-3 / FLOW-2).
 */
function keyIdsOrDefault(ids: string[] | undefined): string[] | undefined {
  return Array.isArray(ids) && ids.length > 0 ? ids : undefined;
}

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
    // Not a data read/write: allowed while issuing too (it can unstick a tag the
    // issue run is waiting for).
    reidentify: () => deps.nfc.reidentify(),
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
      const o = opts ?? {};
      return deps.nfc.readTag({ ...o, mifareKeyIds: keyIdsOrDefault(o.mifareKeyIds) });
    },
    writeTag: (req: WriteRequest): Promise<WriteResult> => {
      if (deps.issue.getState().running) throw new OpError('BUSY');
      // Protected regions (lock / CC / config / trailers) are advanced-mode only (I5).
      if (req.allowProtected && !deps.isAdvancedMode()) throw new OpError('ADVANCED_REQUIRED', 'allowProtected');
      return deps.nfc.writeTag({ ...req, mifareKeyIds: keyIdsOrDefault(req.mifareKeyIds) });
    },
    transmitApdu: async (apduHex: string): Promise<string> => {
      if (!deps.isAdvancedMode()) throw new OpError('ADVANCED_REQUIRED', 'transmitApdu');
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
      // Password protection writes NTAG config / PWD pages (protected units): the
      // same advanced-mode gate as a single write with allowProtected (I5, R-UX-6).
      if (job?.options?.ntagProtect && !deps.isAdvancedMode()) throw new OpError('ADVANCED_REQUIRED', 'ntagProtect');
      deps.issue.start(job);
    },
    stopIssue: () => {
      deps.issue.stop();
    },
    getIssueState: (): IssueState => deps.issue.getState(),
    listIssueLog: (query: { limit?: number; jobId?: string }) => deps.issueLog.list(query ?? {}),
    clearIssueLog: () => {
      if (deps.issue.getState().running) throw new OpError('BUSY');
      return deps.issueLog.clear();
    },

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
        const payload = toErrorPayload(err, lang());
        // Diagnostics stay in the main log (detail never holds keys/passwords: I4).
        if (payload.code !== 'CANCELLED') console.warn(`[ipc] ${method} failed: ${payload.code}${payload.detail ? ` (${payload.detail})` : ''}`);
        return { ok: false, error: payload };
      }
    });
    registered.push(channel);
  }

  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel);
  };
}
