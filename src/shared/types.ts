// Domain types shared by main, preload and renderer. CONTRACT FILE - frozen.
// Change only via the integrator (see docs/DESIGN.md "契約").
//
// Design invariant: a tag's UID is fixed at manufacture and read-only. This app
// edits the writable data area of tags the operator owns/manages. MIFARE Classic
// sectors are opened only with keys the operator holds (no key recovery).

import type { TagKind } from './tags';
import type { DataSchema } from './schema/types';
import type { NdefRecordDraft } from './ndef/types';

// ---------------------------------------------------------------------------
// Reader / card
// ---------------------------------------------------------------------------

/**
 * How raw NFC-A commands (GET_VERSION, PWD_AUTH, READ_CNT, READ_SIG, FAST_READ)
 * are tunnelled through the PC/SC reader.
 *  - auto:        choose by reader name / ATR
 *  - acr122:      PN53x "Direct Transmit"  FF 00 00 00 Lc D4 42 <cmd>
 *  - transparent: PC/SC 2.02 Part 3 transparent session  FF C2 ...
 *  - storage:     storage-card commands only (FF CA / FF B0 / FF D6 / FF 82 / FF 86);
 *                 no raw commands -> no password auth / counter / signature
 */
export type ReaderDriverMode = 'auto' | 'acr122' | 'transparent' | 'storage';
export type ResolvedDriver = Exclude<ReaderDriverMode, 'auto'>;

export interface ReaderInfo {
  name: string;
  /**
   * Heuristic: looks like a contactless (NFC) reader. False for USB security
   * tokens / contact smart-card readers (e.g. "FS USB Token", "YubiKey").
   */
  likelyContactless: boolean;
  cardPresent: boolean;
  /** Another process holds the reader (SCARD_STATE_INUSE). */
  inUse: boolean;
  /** ATR of the present card as uppercase hex, or null. */
  atr: string | null;
  /** True for the built-in virtual reader (simulator). */
  virtual: boolean;
}

export type KindSource = 'version' | 'cc' | 'atr' | 'manual' | 'simulator';

export interface CardInfo {
  readerName: string;
  /** Read-only manufacturer UID, uppercase hex without separators. */
  uid: string;
  atr: string;
  kind: TagKind | null;
  kindSource: KindSource | null;
  /** NTAG GET_VERSION response (8 bytes hex) when available. */
  version: string | null;
  /** Raw NFC-A commands usable with this reader/driver. */
  rawCommands: boolean;
  driver: ResolvedDriver;
  detectedAt: number;
}

export interface SimulatorState {
  enabled: boolean;
  kind: TagKind;
  /** A virtual tag is currently "on" the virtual reader. */
  present: boolean;
  uid: string;
}

export type ServiceState = 'ok' | 'no-readers' | 'unavailable' | 'error';

export interface ReaderStatus {
  /** PC/SC service state. 'unavailable' = SCardSvr stopped / library missing. */
  service: ServiceState;
  serviceMessage: string | null;
  readers: ReaderInfo[];
  /** Reader the app talks to. null = auto (first likely-contactless reader with a card). */
  selectedReader: string | null;
  driverMode: ReaderDriverMode;
  card: CardInfo | null;
  /** Long-running operation in progress (read/write/issue). */
  busy: null | { op: 'read' | 'write' | 'issue' | 'format' | 'identify'; startedAt: number };
  simulator: SimulatorState;
}

// ---------------------------------------------------------------------------
// Tag image (memory dump)
// ---------------------------------------------------------------------------

export type UnitStatus = 'ok' | 'unread' | 'denied' | 'error';

export interface NtagExtras {
  version: string | null;
  /** NFC counter (READ_CNT 02), null when unavailable/disabled. */
  counter: number | null;
  /** 32-byte originality signature hex (READ_SIG), display only. */
  signature: string | null;
}

export interface MifareSectorAccess {
  sector: number;
  /** Key that opened the sector (label only - never the key bytes). */
  keyType: 'A' | 'B' | null;
  keyLabel: string | null;
}

export interface TagImage {
  kind: TagKind;
  uid: string;
  /**
   * Full memory image: unitCount * unitSize bytes (TAG_SPECS). Units that could
   * not be read are zero-filled and marked in unitStatus.
   */
  data: Uint8Array;
  /** Per page (NTAG) / block (MIFARE) status, length = unitCount. */
  unitStatus: UnitStatus[];
  readAt: number;
  ntag?: NtagExtras;
  mifare?: { sectors: MifareSectorAccess[] };
  /** FeliCa Lite-S read-only system blocks (hex), for display. */
  felica?: { id: string | null; sysC: string | null; ckv: string | null };
}

// ---------------------------------------------------------------------------
// Credentials (operator-owned)
// ---------------------------------------------------------------------------

/** MIFARE Classic key the operator manages. keyHex never leaves main except on explicit reveal. */
export interface MifareKeyEntry {
  id: string;
  label: string;
  /** Masked for display, e.g. "FFFF••••••FF". */
  masked: string;
  /**
   * Public, standard keys shipped with the app (factory default FFFFFFFFFFFF,
   * NFC Forum MAD key A0A1A2A3A4A5, NFC Forum NDEF key D3F7D3F7D3F7).
   */
  builtin: boolean;
}

export interface ReadOptions {
  /** NTAG: 8 hex chars. Authenticates (PWD_AUTH) before reading protected pages. */
  ntagPassword?: string;
  /** MIFARE: key ids (from the key store) to try for each sector, in order. */
  mifareKeyIds?: string[];
}

export interface UnitWrite {
  /** Page (NTAG) or block (MIFARE) index. */
  unit: number;
  /** Exactly unitSize bytes. */
  data: Uint8Array;
}

/**
 * Units are written strictly in array order (order matters for NTAG password
 * setup: PWD, PACK, then CFG1, then CFG0/AUTH0 last).
 */
export interface WriteRequest {
  kind: TagKind;
  /**
   * The UID of the card the operator intends to write. main re-reads the UID
   * right before writing and refuses on mismatch. null only for issue mode,
   * which performs its own checks.
   */
  expectedUid: string | null;
  writes: UnitWrite[];
  /**
   * Permit writes to protected units (CC, lock bytes, NTAG config, MIFARE sector
   * trailers). The UI must obtain explicit confirmation first. Block 0 / UID
   * pages are never writable regardless.
   */
  allowProtected: boolean;
  /** Read back and compare after writing. */
  verify: boolean;
  ntagPassword?: string;
  mifareKeyIds?: string[];
}

export interface WriteResult {
  uid: string;
  written: number[];
  failed: { unit: number; error: string }[];
  /** null when verify=false. */
  verified: boolean | null;
  mismatched: number[];
}

// ---------------------------------------------------------------------------
// Issue (batch provisioning)
// ---------------------------------------------------------------------------

export type IssueTemplate =
  /** Bytes laid out by a data schema (e.g. employee ID at a fixed offset). */
  | { type: 'schema'; schema: DataSchema; inputs: Record<string, string> }
  /** NDEF records whose text fields may contain placeholders ({{seq}}, {{uid}} ...). */
  | { type: 'ndef'; records: NdefRecordDraft[] }
  /** Duplicate mode: write the same data units (from a backup) to every tag. */
  | { type: 'image'; kind: TagKind; data: Uint8Array; units: number[] };

export interface IssueOptions {
  verify: boolean;
  /** Do not issue a tag whose UID already appears in this job or the issue log. */
  skipDuplicateUid: boolean;
  /** Only write tags whose user area is empty/blank (protects issued cards). */
  requireBlank: boolean;
  /** NTAG: password-protect writes after issuing (null = no). */
  ntagProtect: null | { password: string; pack: string; protectRead: boolean };
  /** MIFARE: key ids to use for authentication. */
  mifareKeyIds: string[];
  /** Play sound on success/failure (renderer side). */
  sound: boolean;
}

export interface IssueJob {
  id: string;
  name: string;
  kind: TagKind;
  template: IssueTemplate;
  /** Sequence counter. `next` is the value the next tag receives. */
  sequence: { start: number; step: number; next: number };
  /** Optional per-tag rows (CSV import). Row `rowIndex` goes to the next tag. */
  rows: Record<string, string>[] | null;
  rowIndex: number;
  options: IssueOptions;
  /** Stop automatically after this many successful tags (null = unlimited). */
  limit: number | null;
}

export interface IssuePreview {
  seq: number | null;
  rowIndex: number | null;
  /** Field id/placeholder -> rendered value, for the operator to see before tapping. */
  values: Record<string, string>;
}

export interface IssueLogEntry {
  id: string;
  jobId: string;
  jobName: string;
  at: number;
  uid: string;
  kind: TagKind | null;
  seq: number | null;
  values: Record<string, string>;
  result: 'ok' | 'error' | 'skipped';
  message: string | null;
}

export type IssueEvent =
  | { type: 'started'; job: IssueJob }
  | { type: 'waiting'; next: IssuePreview; issued: number }
  | { type: 'writing'; uid: string; next: IssuePreview }
  | { type: 'success'; entry: IssueLogEntry; issued: number }
  | { type: 'skipped'; entry: IssueLogEntry; reason: 'duplicate' | 'not-blank' | 'wrong-kind' }
  | { type: 'error'; entry: IssueLogEntry | null; message: string }
  | { type: 'remove-card'; uid: string }
  | { type: 'stopped'; reason: 'user' | 'limit' | 'rows-exhausted' | 'error'; issued: number };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemeSetting = 'system' | 'light' | 'dark';
export type LanguageSetting = 'ja' | 'en';

export interface AppSettings {
  theme: ThemeSetting;
  language: LanguageSetting;
  sound: boolean;
  /** Show protected regions editing, raw APDU console, irreversible operations. */
  advancedMode: boolean;
  /** Ask before every write (single-tag writes; issue mode has its own start confirmation). */
  confirmBeforeWrite: boolean;
  driverMode: ReaderDriverMode;
  preferredReader: string | null;
  /** First-run guide already shown. */
  onboardingDone: boolean;
  /** Saved issue jobs (resume sequence after restart). */
  savedJobs: IssueJob[];
  /** Saved data schemas. */
  schemas: DataSchema[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'ja',
  sound: true,
  advancedMode: false,
  confirmBeforeWrite: true,
  driverMode: 'auto',
  preferredReader: null,
  onboardingDone: false,
  savedJobs: [],
  schemas: [],
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'NO_SERVICE'
  | 'NO_READER'
  | 'NO_CARD'
  | 'CARD_REMOVED'
  | 'UID_MISMATCH'
  | 'UNSUPPORTED_TAG'
  | 'AUTH_FAILED'
  | 'ACCESS_DENIED'
  | 'PROTECTED_UNIT'
  | 'INVALID_ACCESS_BITS'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'VERIFY_FAILED'
  | 'BUSY'
  | 'INVALID_INPUT'
  | 'FILE_ERROR'
  | 'CANCELLED'
  | 'INTERNAL';

export interface AppErrorPayload {
  code: ErrorCode;
  /** User-facing message (Japanese or English per settings). */
  message: string;
  detail?: string;
}
