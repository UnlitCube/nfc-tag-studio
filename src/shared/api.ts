// IPC contract between main and renderer. CONTRACT FILE - frozen.
//
// - Every invoke channel returns an Envelope (main never rejects). The preload
//   passes envelopes through (window.nfcBridge: BridgeApi) and the renderer's
//   lib/api.ts unwraps them into AppError, so the UI never shows
//   "Error invoking remote method ..." and keeps the error code.
// - Push channels (main -> renderer) deliver full snapshots.
// - The renderer never passes file paths: main shows the dialogs and hands back
//   opaque tokens for files it opened/saved.

import type { TagKind } from './tags';
import type {
  AppErrorPayload,
  AppSettings,
  ErrorCode,
  IssueEvent,
  IssueJob,
  IssueLogEntry,
  MifareKeyEntry,
  ReadOptions,
  ReaderDriverMode,
  ReaderStatus,
  TagImage,
  WriteRequest,
  WriteResult,
} from './types';

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload };

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface FileOpenResult {
  /** Opaque handle main can use for revealFile(). */
  token: string;
  /** Base name only (no directory). */
  name: string;
  bytes: Uint8Array;
}

export interface FileSaveResult {
  token: string;
  name: string;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface IssueState {
  running: boolean;
  job: IssueJob | null;
  issued: number;
  last: IssueEvent | null;
}

/** Shape of `window.nfc` exposed by the preload. */
export interface NfcApi {
  // --- app ---
  getAppInfo(): Promise<AppInfo>;
  /** Opens http(s) URLs in the OS browser. Other schemes are refused. */
  openExternal(url: string): Promise<void>;

  // --- settings ---
  getSettings(): Promise<AppSettings>;
  /** Persists and returns the stored settings (main may normalise values). */
  saveSettings(next: AppSettings): Promise<AppSettings>;
  onSettings(cb: (s: AppSettings) => void): () => void;

  // --- reader ---
  getReaderStatus(): Promise<ReaderStatus>;
  onReaderStatus(cb: (s: ReaderStatus) => void): () => void;
  refreshReaders(): Promise<void>;
  /** null = automatic selection. */
  selectReader(name: string | null): Promise<void>;
  setDriverMode(mode: ReaderDriverMode): Promise<void>;
  /** Override the detected tag kind for the current card (null = use detection). */
  setManualKind(kind: TagKind | null): Promise<void>;

  // --- simulator (virtual reader + virtual tag, for trying the app and tests) ---
  setSimulator(opts: { enabled: boolean; kind?: TagKind }): Promise<void>;
  /** Put the virtual tag on (true) / take it off (false) the virtual reader. */
  simulatorTap(present: boolean): Promise<void>;
  /** Replace the virtual tag with a fresh blank tag of `kind` (new random UID). */
  simulatorNewTag(kind: TagKind): Promise<void>;

  // --- tag operations ---
  readTag(opts: ReadOptions): Promise<TagImage>;
  writeTag(req: WriteRequest): Promise<WriteResult>;
  /** Advanced mode only: send one APDU (hex) to the current card, returns response hex incl. SW. */
  transmitApdu(apduHex: string): Promise<string>;

  // --- MIFARE keys (operator-owned) ---
  listKeys(): Promise<MifareKeyEntry[]>;
  addKey(input: { label: string; keyHex: string }): Promise<MifareKeyEntry>;
  removeKey(id: string): Promise<void>;

  // --- issue (batch provisioning) ---
  startIssue(job: IssueJob): Promise<void>;
  stopIssue(): Promise<void>;
  getIssueState(): Promise<IssueState>;
  onIssueEvent(cb: (e: IssueEvent) => void): () => void;
  listIssueLog(query: { limit?: number; jobId?: string }): Promise<IssueLogEntry[]>;
  clearIssueLog(): Promise<void>;

  // --- files ---
  openFile(opts: { title?: string; filters: FileFilter[] }): Promise<FileOpenResult | null>;
  saveFile(opts: { title?: string; defaultName: string; filters: FileFilter[]; bytes: Uint8Array }): Promise<FileSaveResult | null>;
  revealFile(token: string): Promise<void>;
}

/**
 * What the preload actually exposes as `window.nfcBridge`: every invoke method
 * resolves with the raw Envelope (Errors thrown across contextBridge lose their
 * custom fields, so unwrapping happens in the renderer: src/renderer/src/lib/api.ts
 * turns this into an `NfcApi` that throws AppError). Subscriptions are unchanged.
 */
export type BridgeApi = {
  [K in keyof NfcApi]: NfcApi[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<Envelope<R>>
    : NfcApi[K];
};

/** Invoke channels. Key = NfcApi method name. */
export const INVOKE_CHANNELS = {
  getAppInfo: 'app:getInfo',
  openExternal: 'app:openExternal',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getReaderStatus: 'reader:getStatus',
  refreshReaders: 'reader:refresh',
  selectReader: 'reader:select',
  setDriverMode: 'reader:setDriverMode',
  setManualKind: 'reader:setManualKind',
  setSimulator: 'sim:set',
  simulatorTap: 'sim:tap',
  simulatorNewTag: 'sim:newTag',
  readTag: 'tag:read',
  writeTag: 'tag:write',
  transmitApdu: 'tag:transmitApdu',
  listKeys: 'keys:list',
  addKey: 'keys:add',
  removeKey: 'keys:remove',
  startIssue: 'issue:start',
  stopIssue: 'issue:stop',
  getIssueState: 'issue:getState',
  listIssueLog: 'issue:listLog',
  clearIssueLog: 'issue:clearLog',
  openFile: 'file:open',
  saveFile: 'file:save',
  revealFile: 'file:reveal',
} as const satisfies Partial<Record<keyof NfcApi, string>>;

// Compile-time guard: every non-subscription NfcApi method has an invoke channel.
type InvokeKeys = { [K in keyof NfcApi]: K extends `on${string}` ? never : K }[keyof NfcApi];
type MissingChannels = Exclude<InvokeKeys, keyof typeof INVOKE_CHANNELS>;
export const CHANNELS_COMPLETE: [MissingChannels] extends [never] ? true : MissingChannels = true;

/** Push channels (main -> renderer). */
export const PUSH_CHANNELS = {
  settings: 'push:settings',
  readerStatus: 'push:readerStatus',
  issueEvent: 'push:issueEvent',
} as const;

/** Error type thrown by the preload for a failed envelope. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.name = 'AppError';
    this.code = payload.code;
    this.detail = payload.detail;
  }
}

/** Standard file filters (labels are Japanese; the renderer may pass translated ones). */
export const FILE_FILTERS = {
  project: { name: 'NFC Tag Studio ダンプ', extensions: ['nfcdump'] },
  bin: { name: 'バイナリダンプ', extensions: ['bin', 'dump', 'mfd'] },
  flipper: { name: 'Flipper NFC', extensions: ['nfc'] },
  schema: { name: 'データスキーマ', extensions: ['nfcschema'] },
  ndef: { name: 'NDEF メッセージ', extensions: ['ndef'] },
  csv: { name: 'CSV', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json'] },
} as const satisfies Record<string, FileFilter>;
