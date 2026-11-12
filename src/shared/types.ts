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

/**
 * State of the tag on the ACTIVE reader (the one read/write use). The UI shows
 * this, never "readers[0]" (2026-11-12 UX audit CARD-1/3/7).
 *  - no-reader:   no usable reader (none connected, service down, or the selected reader is missing)
 *  - absent:      reader ready, no tag on it
 *  - detecting:   a tag was placed; identification in progress (incl. retries)
 *  - ready:       tag identified, `card` is set with a known kind
 *  - unsupported: tag present and answered, but its kind is not supported (`card` set, kind = null).
 *                 `card` can also be null here (PC/SC refused the tag before a UID was read).
 *  - error:       tag present but could not be identified after retries (`cardError` says why)
 */
export type CardState = 'no-reader' | 'absent' | 'detecting' | 'ready' | 'unsupported' | 'error';

/** Why `activeReader` is the active one. */
export type ActiveReaderReason =
  /** The operator selected this reader (settings). */
  | 'selected'
  /** The selected reader is not connected. Nothing works until it returns or selection goes back to auto. */
  | 'selected-missing'
  /** Auto: the virtual reader is enabled and has a tag, so it takes precedence over real readers. */
  | 'auto-virtual'
  /** Auto: the first likely-contactless reader that has a card. */
  | 'auto-card'
  /** Auto: the first likely-contactless reader (no card yet). */
  | 'auto-first'
  /** No usable reader. */
  | 'none';

export interface ReaderStatus {
  /**
   * PC/SC service state. On Windows, SCARD_E_NO_SERVICE / SERVICE_STOPPED (the
   * smart card service stops when no reader is plugged in) is 'no-readers', with
   * the rv name in serviceMessage. 'unavailable' = the PC/SC library is missing
   * (or pcscd is absent on Linux / macOS). 'error' = a real failure.
   */
  service: ServiceState;
  serviceMessage: string | null;
  readers: ReaderInfo[];
  /** Reader the operator selected. null = auto. (What is actually used: `activeReader`.) */
  selectedReader: string | null;
  /** The reader read/write actually use right now (null = none). */
  activeReader: string | null;
  activeReason: ActiveReaderReason;
  /**
   * The transport read/write use with `activeReader` (driverMode resolved against
   * the reader name), known even with no tag on it - so the UI can say "this
   * reader cannot authenticate with a password" (storage) before a tag is placed
   * (D11, R-UX-1). Always set by main; optional only so older fixtures compile.
   */
  activeDriver?: ResolvedDriver | null;
  driverMode: ReaderDriverMode;
  /**
   * The identified tag on the ACTIVE reader only (never a tag on another reader).
   * Set when cardState is 'ready' or 'unsupported', and for 'error' when the
   * UID was read but the kind could not be confirmed (kind = null, e.g. a
   * read-protected NTAG on a storage reader). null otherwise.
   */
  card: CardInfo | null;
  cardState: CardState;
  /** Why cardState is 'error' / 'unsupported' (e.g. CARD_UNRESPONSIVE, READER_IN_USE, UNSUPPORTED_TAG). null otherwise. */
  cardError: ErrorCode | null;
  /**
   * cardState is 'detecting' and an attempt already failed (retrying): the tag
   * answers poorly - at the edge of the reader, or still moving. The UI asks to
   * hold it still in the middle of the reader (2026-11-13 live check). Always
   * set by main; optional only so older fixtures compile.
   */
  cardRetrying?: boolean;
  /**
   * Name of a real contactless reader that currently holds a tag while the
   * virtual reader takes precedence ('auto-virtual'): that real tag is NOT used.
   * The UI must say so (CARD-1). null otherwise.
   */
  ignoredRealReader: string | null;
  /** Long-running operation in progress (read/write/issue/identify). */
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
  /** Units the tag refused / that failed, with the ErrorCode (never raw SW text). */
  failed: { unit: number; error: ErrorCode }[];
  /** null when verify=false. */
  verified: boolean | null;
  mismatched: number[];
  /**
   * Set when the write stopped early (e.g. CARD_REMOVED: the tag left the reader).
   * The tag is then only partly written; `notAttempted` lists the units not tried.
   */
  aborted: ErrorCode | null;
  notAttempted: number[];
}

// ---------------------------------------------------------------------------
// Issue (batch provisioning)
// ---------------------------------------------------------------------------

export type IssueTemplate =
  /** Bytes laid out by a data schema (e.g. employee ID at a fixed offset). */
  | { type: 'schema'; schema: DataSchema; inputs: Record<string, string> }
  /** NDEF records whose text fields may contain placeholders ({{seq}}, {{uid}} ...). */
  | { type: 'ndef'; records: NdefRecordDraft[] }
  /**
   * Duplicate mode: write the same data units (from a backup) to every tag.
   * `sourceUid`: the tag the image was read from - it is skipped (reason 'source'), not "issued".
   */
  | { type: 'image'; kind: TagKind; data: Uint8Array; units: number[]; sourceUid?: string | null };

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
  /** A tag was already on the reader when the run started: it must be removed first (never written implicitly). */
  | { type: 'clear-reader'; uid: string }
  | { type: 'waiting'; next: IssuePreview; issued: number }
  /** A tag was detected; reading / checking it (blank, duplicate, kind) before writing. */
  | { type: 'reading'; uid: string; next: IssuePreview }
  | { type: 'writing'; uid: string; next: IssuePreview }
  | { type: 'success'; entry: IssueLogEntry; issued: number }
  | { type: 'skipped'; entry: IssueLogEntry; reason: 'duplicate' | 'not-blank' | 'wrong-kind' | 'source' }
  /**
   * `partial`: some units were already written (the tag is half-written). The
   * same number is reserved for that UID: putting the SAME tag back retries it.
   */
  | { type: 'error'; entry: IssueLogEntry | null; message: string; partial: boolean }
  /**
   * Waiting for the tag to be removed. Carries the outcome of the tag just
   * handled so the UI keeps showing it (green / yellow / red) until the next tag.
   */
  | {
      type: 'remove-card';
      uid: string;
      outcome: 'ok' | 'skipped' | 'error';
      entry: IssueLogEntry | null;
      message: string | null;
    }
  /** `job`: the job state at stop (sequence.next / rowIndex) so the UI can offer "resume". */
  | { type: 'stopped'; reason: 'user' | 'limit' | 'rows-exhausted' | 'error'; issued: number; job: IssueJob | null };

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
  /**
   * Read a tag automatically when it is placed (home / binary / NDEF screens).
   * Never replaces unsaved edits or a document opened from a file.
   */
  autoRead: boolean;
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
  autoRead: true,
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
  | 'INTERNAL'
  /** Another application holds the reader (SCARD_E_SHARING_VIOLATION). */
  | 'READER_IN_USE'
  /** The tag does not answer (SCARD_W_UNRESPONSIVE_CARD / mute): re-place it. */
  | 'CARD_UNRESPONSIVE'
  /** The tag on the reader is a different kind than the data being written. */
  | 'KIND_MISMATCH'
  /** The operation needs advanced mode. */
  | 'ADVANCED_REQUIRED'
  /**
   * This reader cannot send password authentication (storage-only readers such
   * as Sony PaSoRi: no raw NFC-A commands). A password was given but could not be
   * used - never skip it silently (2026-11-12 review R-UX-1).
   */
  | 'READER_NO_AUTH'
  /** A write touched the UID / manufacturer block (never writable, I1/I2). */
  | 'FORBIDDEN_UNIT';

export interface AppErrorPayload {
  code: ErrorCode;
  /** User-facing message (Japanese or English per settings). */
  message: string;
  detail?: string;
}
