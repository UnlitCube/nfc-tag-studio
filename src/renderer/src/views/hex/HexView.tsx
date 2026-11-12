// Binary (hex) editor view. Owner: agent renderer-hex. Export name `HexView`
// is imported by App.tsx - keep it.
//
// Design invariant (I1/I2): the UID is read-only. Forbidden units (NTAG pages
// 0-1, MIFARE block 0) are shown but never editable, every edit is funnelled
// through restoreLockedBytes + keepReadOnlyUnits, and the write plan (shared/tag
// planWrites) excludes them. We only ever copy the DATA area - never the UID.
//
// 2026-11-12 UX rework (audit WRITE-1/5/7/10/11/13/15-20, FLOW-1/11/13,
// WALK-1/2/8-11/15/18, FIRST-19; decisions D3/D5/D7):
// - One document bar: where the document came from (tag UID + time / file /
//   new), unwritten changes, and every document action (read, open, new, save
//   to file, close). Replacing / closing asks guardDiscard first.
// - One run bar, fixed at the bottom: the tag on the reader, how it relates to
//   the document, the write button (disabled with the reason BEFORE pressing),
//   and the last write result.
// - The write goes to the right tag: the same tag -> the edits vs doc.original;
//   another tag / a file / a new document -> read the target first and plan the
//   difference against it ("write to a different tag (copy)").
// - Locked / protected cells are read-only (with the reason), so nothing is
//   shown as an edit that will then silently not be written.
//
// Second round (review R-UX-1/8/11/12, E2E-UX-3/4/8/10, decisions D9/D11/D12/D13):
// - Storage-only readers (PaSoRi) cannot send PWD_AUTH: the password field is
//   disabled with the reason and the password is never sent; the hint for
//   protected pages says so instead of "enter the password".
// - The password is bound to the tag it was entered for: another tag gets a
//   visible note (and a line in the write confirmation) before it is sent;
//   opening a file / a new document / closing forgets it.
// - NTAG page 2 bytes 0-1 (UID check byte) are read-only per byte.
// - MIFARE blocks not opened: [Read with registered keys] (auto-read tries only
//   the standard keys - D9).
// - One "Read this tag" in the run bar; "writing…" only after the confirmation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import {
  Binary,
  ClipboardPaste,
  Copy,
  Eraser,
  FilePlus2,
  FolderOpen,
  Hash,
  KeyRound,
  Lock,
  LockKeyhole,
  Minus,
  PaintBucket,
  Plus,
  Redo2,
  Replace,
  RotateCcw,
  Save,
  ScanLine,
  Search,
  ShieldAlert,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import type { TagKind } from '@shared/tags';
import {
  TAG_KINDS,
  felicaBlockOfUnit,
  isFelica,
  isForbiddenUnit,
  isMifare,
  isNtag,
  isProtectedUnit,
  specFor,
} from '@shared/tags';
import { felicaBlockName } from '@shared/felica';
import { blankImage, importDump } from '@shared/tag';
import type { PlanWarningCode } from '@shared/tag';
import type { TagImage, WriteRequest } from '@shared/types';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  HelpTip,
  IconButton,
  Modal,
  Page,
  PageHeader,
  Segmented,
  Select,
  Switch,
  TextInput,
} from '../../components/ui';
import { TagOnReader, useOpBlockText } from '../../components/TagOnReader';
import { ResolveReturn } from '../../components/shell/ResolveReturn';
import { LastWriteCallout } from '../../components/LastWriteCallout';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { api } from '../../lib/api';
import { readCurrentTag, readTarget, writeWithConfirm } from '../../lib/ops';
import { fileStamp, formatUid, kindLabel } from '../../lib/format';
import { dumpOpenFilters, localDumpFilter } from '../../lib/fileFilters';
import { dumpFileName, encodeDump } from '../backup/saveDump';
import { tagOpBlock } from '../../lib/readerState';
import { useViewActive } from '../../lib/viewActive';
import {
  byteReadOnlyReason,
  changedMask,
  changedUnitCount,
  deniedHint,
  displayLockedUnits,
  effectiveIncludeProtected,
  fillRange,
  findBytes,
  formatUnits,
  groupWarnings,
  incrementRange,
  initializeImage,
  isValidNtagPassword,
  keepReadOnlyUnits,
  mifareNdefBlocks,
  needsLockConfirmForWrites,
  ntagArmsWithoutPassword,
  parseByteInput,
  parseIntInput,
  parsePattern,
  passwordAuthUnavailable,
  pasteBytes,
  planHexWrite,
  rangeTouchesForbidden,
  readUint,
  regionKey,
  replaceBytes,
  restoreLockedBytes,
  selectionBounds,
  unitOfByte,
  writeReadiness,
  writeUint,
} from './model';
import type { ByteMode, DeniedHint, Endian, HexWritePlan, InitMode, ReadOnlyReason, WriteBlock } from './model';
import { perByteStructure } from './inspect';
import { UnitInspector } from './UnitInspector';
import { FlagEditor } from './FlagEditor';
import './hex.css';

const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ');
const toHex2 = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');
const sameUid = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

const REGION_MSG: Record<string, MsgKey> = {
  uid: 'hex.region.uid',
  manufacturer: 'hex.region.manufacturer',
  cc: 'hex.region.cc',
  user: 'hex.region.user',
  data: 'hex.region.data',
  dynlock: 'hex.region.dynlock',
  config: 'hex.region.config',
  password: 'hex.region.password',
  trailer: 'hex.region.trailer',
  reg: 'hex.region.reg',
  mc: 'hex.region.mc',
  system: 'hex.region.system',
};

function regionLabel(key: string): MsgKey {
  return REGION_MSG[key] ?? 'hex.region.data';
}

/** Confirmation line per plan warning code (grouped, with the units). */
const WARN_MSG: Record<PlanWarningCode, MsgKey> = {
  UID_READONLY: 'hex.warn.UID_READONLY',
  CC_OTP: 'hex.warn.CC_OTP',
  LOCK_IRREVERSIBLE: 'hex.warn.LOCK_IRREVERSIBLE',
  CONFIG: 'hex.warn.CONFIG',
  PASSWORD: 'hex.warn.PASSWORD',
  TRAILER: 'hex.warn.TRAILER',
  ACCESS_BITS_INVALID: 'hex.warn.ACCESS_BITS_INVALID',
  UNREAD_UNIT: 'hex.warn.UNREAD_UNIT',
  LOCKED: 'hex.warn.LOCKED',
  KEY_A_UNKNOWN: 'hex.warn.KEY_A_UNKNOWN',
  FELICA_MC: 'hex.warn.FELICA_MC',
};

const DENIED_MSG: Record<DeniedHint, MsgKey> = {
  ntagStorage: 'hex.denied.ntagStorage',
  ntagWrongPw: 'hex.denied.ntagWrongPw',
  ntagNoPw: 'hex.denied.ntagNoPw',
  ntag: 'hex.denied.ntag',
  mifare: 'hex.denied.mifare',
  other: 'hex.denied.other',
};

function randomUidHex(kind: TagKind): string {
  const n = specFor(kind).uidBytes;
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  b[0] = 0x04; // NXP manufacturer byte (display-only UID for a new document)
  return Array.from(b, toHex2).join('');
}

/** "UID" for NTAG / MIFARE, "IDm" for FeliCa (WALK-18: IDm is not called UID). */
const idNameOf = (kind: TagKind | null | undefined) => (kind && isFelica(kind) ? 'IDm' : 'UID');

// ---------------------------------------------------------------------------
// State shared by the entry screen and the editor. Lives in HexView (always
// mounted with keep-alive) so it survives the editor remounting for a new doc.
// ---------------------------------------------------------------------------

type Working = null | 'read' | 'target' | 'write';

interface HexPrefs {
  bytesPerRow: number;
  editMode: ByteMode;
  incOpen: boolean;
}

interface Shared {
  /** NTAG password for reads / writes. Memory only - never stored or logged (I4). */
  password: string;
  setPassword: (v: string) => void;
  /**
   * UID of the tag the password was entered for (the tag on the reader when it
   * was typed, or the first tag read with it). Another tag gets a visible note
   * before the password is sent to it (R-UX-12). Memory only.
   */
  pwUid: string | null;
  setPwUid: (v: string | null) => void;
  /** readAt of the last read that sent the password (tells "wrong password" from "read without it"). */
  pwReadAt: number | null;
  setPwReadAt: (v: number | null) => void;
  /** This view's own tag operation in flight (locks edits and the buttons). */
  working: Working;
  setWorking: (w: Working) => void;
  prefs: HexPrefs;
  setPrefs: (f: (p: HexPrefs) => HexPrefs) => void;
  appVersion: string;
}

export function HexView() {
  const doc = useAppStore((s) => s.doc);
  const [password, setPassword] = useState('');
  const [pwUid, setPwUid] = useState<string | null>(null);
  const [pwReadAt, setPwReadAt] = useState<number | null>(null);
  const [working, setWorking] = useState<Working>(null);
  const [prefs, setPrefsState] = useState<HexPrefs>({ bytesPerRow: 16, editMode: 'hex', incOpen: false });
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    let live = true;
    api
      .getAppInfo()
      .then((i) => live && setAppVersion(i.version))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const setPrefs = useCallback((f: (p: HexPrefs) => HexPrefs) => setPrefsState(f), []);
  const sh: Shared = { password, setPassword, pwUid, setPwUid, pwReadAt, setPwReadAt, working, setWorking, prefs, setPrefs, appVersion };
  if (!doc) return <HexEntry {...sh} />;
  const key = doc.source.type === 'file' ? `file:${doc.source.name}` : doc.source.type === 'card' ? `card:${doc.image.uid}` : `new:${doc.image.uid}`;
  return <HexEditor key={key} {...sh} />;
}

/** Read / open / new / close, shared by the entry screen and the document bar. */
function useDocActions(sh: Shared) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const issueRunning = useAppStore((s) => s.issue.running);
  const busyOp = useAppStore((s) => s.busyOp);
  const openImage = useAppStore((s) => s.openImage);
  const closeDoc = useAppStore((s) => s.closeDoc);
  const guardDiscard = useAppStore((s) => s.guardDiscard);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);

  /**
   * D11 / R-UX-1: a storage-only reader (PaSoRi...) cannot send PWD_AUTH. The
   * password field is disabled with the reason, and the password is not sent
   * (main would refuse the whole read / write with READER_NO_AUTH).
   */
  const noAuth = passwordAuthUnavailable(reader);
  /** The password that actually goes to the tag ('' = none). */
  const pwForTag = noAuth ? '' : sh.password;
  const pwValid = noAuth || isValidNtagPassword(sh.password);
  const readBlock = tagOpBlock(reader, { issueRunning, busyOp: busyOp ?? (sh.working ? 'busy' : null) });
  const card = reader?.card ?? null;
  const cardKind = card?.kind ?? null;
  /** The password goes only to an NTAG read. */
  const readOpts = () => (pwForTag && cardKind && isNtag(cardKind) ? { ntagPassword: pwForTag } : {});

  const read = async () => {
    if (sh.working || readBlock || !pwValid) return;
    sh.setWorking('read');
    try {
      const opts = readOpts();
      const img = await readCurrentTag(opts); // asks guardDiscard first (contract)
      if (img && opts.ntagPassword) {
        // The operator read THIS tag with the password: it is now "the tag of the password".
        sh.setPwReadAt(img.readAt);
        sh.setPwUid(img.uid);
      }
    } finally {
      sh.setWorking(null);
    }
  };

  /** Typing the password binds it to the tag on the reader at that moment (R-UX-12). */
  const changePassword = (v: string) => {
    sh.setPassword(v);
    sh.setPwUid(v ? (card?.uid ?? sh.pwUid) : null);
    if (!v) sh.setPwReadAt(null);
  };

  /** A document that is not a tag (file / new / closed): the password no longer belongs to anything. */
  const forgetPassword = () => {
    sh.setPassword('');
    sh.setPwUid(null);
    sh.setPwReadAt(null);
  };

  /** Shown next to the password field: what happens with it (R-UX-12). */
  const pwNote: { tone: 'warn' | 'muted'; text: string } | null =
    noAuth || !sh.password || !isValidNtagPassword(sh.password)
      ? null
      : card && sh.pwUid && !sameUid(card.uid, sh.pwUid)
        ? { tone: 'warn', text: t('hex.pw.otherTag', { uid: formatUid(card.uid) }) }
        : { tone: 'muted', text: t('hex.pw.willUse') };

  const openFile = async () => {
    if (sh.working) return;
    try {
      const res = await api.openFile({ title: t('hex.open'), filters: dumpOpenFilters(t) });
      if (!res) return;
      let parsed: ReturnType<typeof importDump>;
      try {
        parsed = importDump(res.name, res.bytes);
      } catch {
        // importDump's own message is Japanese-only and technical (FLOW-16).
        toast({ tone: 'danger', title: t('hex.openError'), detail: t('file.openFailed.body', { name: res.name }) });
        return;
      }
      const { image, format } = parsed;
      if (!(await guardDiscard())) return;
      openImage(image, { type: 'file', name: res.name, token: res.token, format });
      forgetPassword();
      toast({ tone: 'ok', title: t('hex.opened'), detail: res.name });
    } catch (err) {
      toastError(err, t('hex.openError'));
    }
  };

  const createNew = async (kind: TagKind) => {
    if (sh.working) return false;
    if (!(await guardDiscard())) return false;
    try {
      openImage(blankImage(kind, randomUidHex(kind)), { type: 'new' });
      forgetPassword();
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  };

  const close = async () => {
    if (sh.working) return;
    if (!(await guardDiscard())) return;
    closeDoc();
    forgetPassword();
  };

  return { read, openFile, createNew, close, readBlock, pwValid, noAuth, pwForTag, changePassword, pwNote };
}

function PasswordField({
  value,
  onChange,
  disabled,
  noAuth,
  note,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Storage-only reader: no password auth (the field is disabled with the reason). */
  noAuth: boolean;
  note: { tone: 'warn' | 'muted'; text: string } | null;
}) {
  const t = useT();
  const valid = noAuth || isValidNtagPassword(value);
  return (
    <div className="hx-pwbox">
      <Field label={t('hex.pw.label')} htmlFor="hex-ntag-pw" help={t('hex.pw.help')} error={valid ? undefined : t('hex.pw.invalid')} className="hx-pw">
        <TextInput
          id="hex-ntag-pw"
          type="password"
          mono
          autoComplete="off"
          spellCheck={false}
          maxLength={8}
          value={value}
          placeholder={t('hex.pw.placeholder')}
          disabled={disabled || noAuth}
          invalid={!valid}
          aria-describedby={noAuth || note ? 'hex-ntag-pw-note' : undefined}
          data-testid="hex-pw"
          onChange={(e) => onChange(e.target.value.trim())}
        />
      </Field>
      {noAuth ? (
        <p id="hex-ntag-pw-note" className="small hx-pw-note is-warn" data-testid="hex-pw-noauth">
          {t('hex.pw.noAuth')}
        </p>
      ) : note ? (
        <p id="hex-ntag-pw-note" className={cx('small hx-pw-note', note.tone === 'warn' ? 'is-warn' : 'muted')} data-testid="hex-pw-note">
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function NewDocModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (k: TagKind) => void }) {
  const t = useT();
  const [kind, setKind] = useState<TagKind>('NTAG215');
  return (
    <Modal
      open={open}
      title={t('hex.newDlg.title')}
      icon={FilePlus2}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('hex.cancel')}
          </Button>
          <Button variant="primary" icon={FilePlus2} onClick={() => onCreate(kind)}>
            {t('hex.newDlg.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{t('hex.newDlg.body')}</p>
        <Field label={t('hex.chooseKind')} htmlFor="hex-newdlg-kind">
          <Select id="hex-newdlg-kind" value={kind} onChange={setKind} options={TAG_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Entry screen (no document open)
// ---------------------------------------------------------------------------

function HexEntry(sh: Shared) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const actions = useDocActions(sh);
  const opText = useOpBlockText();
  const [kind, setKind] = useState<TagKind>('NTAG215');
  const cardKind = reader?.card?.kind ?? null;
  const showPw = !cardKind || isNtag(cardKind);
  const readReason = actions.readBlock ? opText(actions.readBlock) : !actions.pwValid ? t('hex.pw.invalid') : null;

  return (
    <Page>
      <PageHeader title={t('hex.title')} subtitle={t('hex.subtitle')} helpTopic="hex" />
      <Card>
        <EmptyState icon={Binary} title={t('hex.empty.title')}>
          <p className="muted">{t('hex.empty.desc')}</p>
          <div className="hx-entry">
            <div className="hx-entry-col">
              <TagOnReader />
              <p className="small muted">{t('hex.place')}</p>
              {showPw ? (
                <PasswordField value={sh.password} onChange={actions.changePassword} disabled={!!sh.working} noAuth={actions.noAuth} note={actions.pwNote} />
              ) : null}
              <div className="row">
                <Button
                  icon={ScanLine}
                  variant="primary"
                  data-testid="hex-read"
                  disabled={!!readReason}
                  loading={sh.working === 'read'}
                  onClick={(e) => {
                    if (e.detail > 1) return;
                    void actions.read();
                  }}
                >
                  {t('hex.read')}
                </Button>
              </div>
              {readReason ? (
                <span className="small muted" data-testid="hex-read-reason">
                  {readReason}
                </span>
              ) : null}
            </div>
            <div className="hx-entry-col">
              <div className="row">
                <Button icon={FolderOpen} onClick={() => void actions.openFile()} disabled={!!sh.working}>
                  {t('hex.open')}
                </Button>
              </div>
              <Field label={t('hex.chooseKind')} htmlFor="hex-entry-kind">
                <Select id="hex-entry-kind" value={kind} onChange={setKind} options={TAG_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
              </Field>
              <div className="row">
                <Button icon={FilePlus2} onClick={() => void actions.createNew(kind)} disabled={!!sh.working}>
                  {t('hex.new')}
                </Button>
              </div>
            </div>
          </div>
        </EmptyState>
      </Card>
      <p className="small muted hx-uidline">
        <Lock size={13} aria-hidden /> {t('hex.uidNote', { idName: 'UID' })}
      </p>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Editor (document open)
// ---------------------------------------------------------------------------

function HexEditor(sh: Shared) {
  const t = useT();
  const active = useViewActive();
  const doc = useAppStore((s) => s.doc)!;
  const editDocData = useAppStore((s) => s.editDocData);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const canUndo = useAppStore((s) => s.past.length > 0);
  const canRedo = useAppStore((s) => s.future.length > 0);
  const reader = useAppStore((s) => s.reader);
  const issueRunning = useAppStore((s) => s.issue.running);
  const busyOp = useAppStore((s) => s.busyOp);
  /** A confirmation (write / discard) is open: the operation has not started yet (D13). */
  const confirming = useAppStore((s) => s.dialogs.length > 0);
  const advanced = useAppStore((s) => s.settings.advancedMode);
  const lang = useAppStore((s) => s.settings.language);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);
  const takeHandoff = useAppStore((s) => s.takeHandoff);
  const hasGoto = useAppStore((s) => s.handoff?.kind === 'hex-goto');
  const actions = useDocActions(sh);
  const opText = useOpBlockText();

  const kind = doc.image.kind;
  const spec = specFor(kind);
  const data = doc.image.data;
  const original = doc.original.data;
  const unitSize = spec.unitSize;
  const total = data.length;
  const isPage = spec.unit === 'page';
  const idName = idNameOf(kind);
  const rangeSep = lang === 'ja' ? '〜' : '–';

  const { working, setWorking, prefs, setPrefs } = sh;
  const editMode = prefs.editMode;
  const rowByteOptions = unitSize >= 16 ? [16, 32, 48] : [4, 8, 16, 32];
  const bytesPerRow = rowByteOptions.includes(prefs.bytesPerRow) ? prefs.bytesPerRow : 16;

  const [cursor, setCursor] = useState(Math.min(spec.userStartUnit * unitSize, total - 1));
  const [anchor, setAnchor] = useState(Math.min(spec.userStartUnit * unitSize, total - 1));
  const [endian, setEndian] = useState<Endian>('BE');
  /** First hex digit typed into a byte, shown in the cell; the byte is committed as ONE undo step (WRITE-19). */
  const [pending, setPending] = useState<{ index: number; high: number } | null>(null);
  const [clip, setClip] = useState<Uint8Array | null>(null);
  const [includeProtected, setIncludeProtected] = useState(false);
  const [roNotice, setRoNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ revision: number; name: string } | null>(null);
  const [dialog, setDialog] = useState<null | 'new' | 'save' | 'init'>(null);
  const [pwOpen, setPwOpen] = useState(false);

  const [searchMode, setSearchMode] = useState<ByteMode>('hex');
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);

  const [stepText, setStepText] = useState('1');
  const [setValueText, setSetValueText] = useState('');
  const [fillText, setFillText] = useState('00');

  const gridRef = useRef<HTMLDivElement>(null);

  // keep-alive (D3): take the "open at this unit" handoff when the view is SHOWN,
  // not on mount (the view stays mounted while hidden).
  useEffect(() => {
    if (!active || !hasGoto) return;
    const h = takeHandoff('hex-goto');
    if (h) {
      const idx = Math.min(Math.max(0, h.unit * unitSize), total - 1);
      setCursor(idx);
      setAnchor(idx);
      setPending(null);
    }
  }, [active, hasGoto, takeHandoff, unitSize, total]);

  // Follow the cursor INSIDE the grid only (scrollIntoView also scrolled the page
  // and pushed the write button out of view - WALK-9).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const row = grid.children[Math.floor(cursor / bytesPerRow)] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (bottom > grid.scrollTop + grid.clientHeight) grid.scrollTop = bottom - grid.clientHeight;
  }, [cursor, bytesPerRow]);

  // I5: the "also edit/write protected areas" switch exists only in advanced mode.
  // Disarm it when advanced mode is turned off so protected writes can never stay
  // enabled while the toggle is hidden and out of the operator's reach.
  useEffect(() => {
    if (!advanced) setIncludeProtected(false);
  }, [advanced]);

  useEffect(() => {
    if (!roNotice) return;
    const id = setTimeout(() => setRoNotice(null), 4000);
    return () => clearTimeout(id);
  }, [roNotice]);

  const allowProtected = effectiveIncludeProtected(advanced, includeProtected);
  /** Edits are paused while this view (or anything else) reads / writes a tag (WRITE-13). */
  const lockedUi = working !== null || busyOp !== null || reader?.busy?.op === 'write';

  const lockedUnits = useMemo(() => displayLockedUnits(doc.source, kind, doc.original), [doc.source, kind, doc.original]);
  const lockedSet = useMemo(() => new Set(lockedUnits), [lockedUnits]);
  const roCtx = useMemo(() => ({ locked: lockedSet, protectedEditable: allowProtected }), [lockedSet, allowProtected]);

  const changed = useMemo(() => changedMask(data, original), [data, original]);
  const changedCount = useMemo(() => changedUnitCount(kind, data, original), [kind, data, original]);
  // Data-structure boundaries (NDEF / TLV spans) for the grid and the inspector.
  const struct = useMemo(() => perByteStructure(kind, data, lang), [kind, data, lang]);

  const samePlan = useMemo<HexWritePlan | null>(() => {
    try {
      return planHexWrite({ kind, mode: 'same', original: doc.original, data, includeProtected: allowProtected });
    } catch {
      return null;
    }
  }, [kind, doc.original, data, allowProtected]);

  const readiness = writeReadiness({
    source: doc.source,
    kind,
    reader,
    issueRunning,
    busyOp: busyOp ?? (working ? 'busy' : null),
    passwordValid: !isNtag(kind) || actions.pwValid,
    samePlan,
  });

  const { lo, hi } = selectionBounds(anchor, cursor);
  const selLen = hi - lo + 1;
  const selForbidden = rangeTouchesForbidden(kind, lo, hi);
  const value = readUint(data, lo, selLen, endian);

  // --- formatting helpers ----------------------------------------------------
  const rangeText = (units: number[]) => {
    const { text, more } = formatUnits(kind, units, { sep: rangeSep });
    return more ? t('hex.units.more', { list: text, n: more }) : text;
  };
  const unitsText = (units: number[]) => {
    const list = rangeText(units);
    return isFelica(kind) ? t('hex.units.names', { list }) : t(isPage ? 'hex.units.pages' : 'hex.units.blocks', { list });
  };
  const roText = (r: ReadOnlyReason) =>
    r === 'forbidden'
      ? t('hex.ro.forbidden', { idName })
      : r === 'uidCheck'
        ? t('hex.ro.uidCheck', { idName })
        : r === 'locked'
          ? t('hex.ro.locked')
          : t('hex.ro.protected');
  const unitName = (u: number) => (isFelica(kind) ? felicaBlockName(felicaBlockOfUnit(kind, u)) : String(u));

  // --- the single edit chokepoint --------------------------------------------
  // I1/I2: no edit can ever change a forbidden (UID / block 0) unit; locked units
  // and (switch off) protected units keep their bytes too, and the operator is
  // told so instead of the change silently not applying.
  const applyEdit = useCallback(
    (next: Uint8Array) => {
      if (lockedUi) {
        setRoNotice(t('hex.ro.busy'));
        return;
      }
      const res = keepReadOnlyUnits(kind, next, data, roCtx);
      if (res.changed) setRoNotice(t('hex.ro.partial', { idName }));
      // The I1/I2 chokepoint stays last: whatever happened above, the UID /
      // manufacturer bytes are the ones that were read.
      const out = restoreLockedBytes(kind, res.data, original);
      let same = out.length === data.length;
      for (let i = 0; same && i < data.length; i++) if (out[i] !== data[i]) same = false;
      if (!same) editDocData(out);
    },
    [lockedUi, kind, original, data, roCtx, editDocData, t, idName],
  );

  const clamp = (i: number) => Math.max(0, Math.min(i, total - 1));
  const roAt = (i: number) => byteReadOnlyReason(kind, i, roCtx);
  const nextEditable = (from: number) => {
    let i = from + 1;
    while (i < total && roAt(i)) i++;
    return i < total ? i : from;
  };

  /** Commit a half-typed byte (first hex digit only) before the cursor moves away. */
  const commitPending = () => {
    if (!pending) return;
    const next = new Uint8Array(data);
    next[pending.index] = (pending.high << 4) | (data[pending.index] & 0x0f);
    setPending(null);
    applyEdit(next);
  };

  const moveCursor = (to: number, extend: boolean) => {
    commitPending();
    const c = clamp(to);
    setCursor(c);
    if (!extend) setAnchor(c);
  };

  const onCellDown = (bi: number, e: ReactMouseEvent) => {
    e.preventDefault();
    gridRef.current?.focus();
    if (pending && pending.index !== bi) commitPending();
    setCursor(bi);
    if (!e.shiftKey) setAnchor(bi);
  };

  const typeHexDigit = (d: number) => {
    if (pending && pending.index === cursor) {
      const next = new Uint8Array(data);
      next[cursor] = (pending.high << 4) | d;
      setPending(null);
      applyEdit(next);
      const nc = nextEditable(cursor);
      setCursor(nc);
      setAnchor(nc);
    } else {
      commitPending();
      setPending({ index: cursor, high: d });
    }
  };

  const typeAscii = (code: number) => {
    const next = new Uint8Array(data);
    next[cursor] = code & 0xff;
    applyEdit(next);
    const nc = nextEditable(cursor);
    setCursor(nc);
    setAnchor(nc);
  };

  const doCopy = () => {
    const slice = data.slice(lo, hi + 1);
    setClip(slice);
    toast({ tone: 'ok', title: t('hex.copied', { n: slice.length }) });
  };

  const doPaste = () => {
    if (!clip || clip.length === 0) {
      toast({ tone: 'info', title: t('hex.pasteEmpty') });
      return;
    }
    applyEdit(pasteBytes(data, cursor, clip));
  };

  const incBy = (delta: bigint) => {
    if (selForbidden) {
      toast({ tone: 'warn', title: t('hex.inc.forbidden') });
      return;
    }
    applyEdit(incrementRange(data, lo, selLen, delta, endian));
  };

  const addStep = () => {
    try {
      incBy(parseIntInput(stepText));
    } catch {
      toast({ tone: 'warn', title: t('hex.inc.badNumber') });
    }
  };

  const setVal = () => {
    if (selForbidden) {
      toast({ tone: 'warn', title: t('hex.inc.forbidden') });
      return;
    }
    try {
      applyEdit(writeUint(data, lo, selLen, parseIntInput(setValueText), endian));
    } catch {
      toast({ tone: 'warn', title: t('hex.inc.badNumber') });
    }
  };

  const fillWith = (byte: number) => applyEdit(fillRange(data, lo, hi, byte));
  const fillCustom = () => {
    try {
      fillWith(parseByteInput(fillText));
    } catch {
      toast({ tone: 'warn', title: t('hex.inc.badNumber') });
    }
  };

  const needle = useMemo(() => {
    try {
      return parsePattern(findText, searchMode);
    } catch {
      return null;
    }
  }, [findText, searchMode]);
  const matches = useMemo(() => (needle && needle.length ? findBytes(data, needle) : []), [needle, data]);

  const gotoMatch = (idx: number) => {
    if (matches.length === 0 || !needle) return;
    const i = ((idx % matches.length) + matches.length) % matches.length;
    setMatchIdx(i);
    const start = matches[i];
    commitPending();
    setAnchor(start);
    setCursor(Math.min(total - 1, start + needle.length - 1));
  };

  const replaceAll = () => {
    if (!needle || needle.length === 0) {
      toast({ tone: 'warn', title: t('hex.find.invalid') });
      return;
    }
    let repl: Uint8Array;
    try {
      repl = parsePattern(replaceText, searchMode);
    } catch {
      toast({ tone: 'warn', title: t('hex.find.invalid') });
      return;
    }
    if (repl.length !== needle.length) {
      toast({ tone: 'warn', title: t('hex.find.lengthMismatch') });
      return;
    }
    const res = replaceBytes(data, needle, repl);
    if (res.count === 0) {
      toast({ tone: 'info', title: t('hex.find.none') });
      return;
    }
    applyEdit(res.data);
    toast({ tone: 'ok', title: t('hex.find.replaced', { n: res.count }) });
  };

  // Revert everything to what was read / opened (always safe; one undo step).
  const onRevert = () => {
    if (lockedUi) return;
    setPending(null);
    editDocData(restoreLockedBytes(kind, new Uint8Array(original), original));
  };

  // --- save to file (WRITE-11 / WALK-10 / FLOW-11) ---------------------------
  const onSave = async (format: 'project' | 'bin') => {
    const img: TagImage = { ...doc.image, data: new Uint8Array(data) };
    try {
      // Same bytes and names as the backup screen (views/backup/saveDump.ts).
      const { bytes, filter, ext, redacted } = encodeDump(img, format, { note: '', appVersion: sh.appVersion || '0.0.0', savedAt: new Date().toISOString() });
      const defaultName =
        doc.source.type === 'file'
          ? `${doc.source.name.replace(/\.[^.]+$/, '')}.${ext}`
          : doc.source.type === 'card'
            ? dumpFileName(img, ext, fileStamp())
            : `${kind}_new_${fileStamp()}.${ext}`;
      const res = await api.saveFile({
        title: t('hex.saveDlg.title'),
        defaultName,
        filters: [localDumpFilter(t, filter)],
        bytes,
      });
      if (!res) return;
      setSaved({ revision: useAppStore.getState().doc?.revision ?? doc.revision, name: res.name });
      setDialog(null);
      // A password / key typed into the document is never put into the file (I4): say so.
      const detail = redacted.length ? `${res.name}\n${t('hex.saved.redacted', { list: unitsText(redacted) })}` : res.name;
      toast({ tone: 'ok', title: t('hex.saved'), detail });
    } catch (err) {
      toastError(err, t('hex.saveError'));
    }
  };

  // --- initialize (WRITE-16) -------------------------------------------------
  const onInitialize = (mode: InitMode) => {
    setDialog(null);
    applyEdit(initializeImage(kind, data, mode));
    toast({ tone: 'ok', title: t('hex.init.done'), detail: t('hex.init.doneHint') });
  };

  // --- write (WRITE-1 / FLOW-1 / FLOW-13 / WALK-1 / WALK-8, D5) --------------
  const onWrite = async () => {
    if (lockedUi || readiness.block || !readiness.card || !readiness.relation) return;
    commitPending();
    // Not on a storage-only reader (D11): it cannot authenticate, main would refuse the write.
    const pw = isNtag(kind) && actions.pwForTag ? actions.pwForTag : undefined;
    const st0 = useAppStore.getState();
    const cur = st0.doc;
    if (!cur) return;
    const curData = cur.image.data;
    setWorking(readiness.relation === 'same' ? 'write' : 'target');
    try {
      let hp: HexWritePlan;
      let targetUid: string;
      /** What the plan is against (what is on the target tag). */
      let baseData: Uint8Array = cur.original.data;
      if (readiness.relation === 'same' && cur.source.type === 'card') {
        hp = planHexWrite({ kind, mode: 'same', original: cur.original, data: curData, includeProtected: allowProtected });
        targetUid = cur.source.uid;
      } else {
        // Read what is ON the target first and plan against it.
        const img = await readTarget(pw ? { ntagPassword: pw } : {});
        if (!img) return;
        if (img.kind !== kind) {
          toast({ tone: 'warn', title: t('hex.targetKind', { card: kindLabel(img.kind), doc: kindLabel(kind) }) });
          return;
        }
        targetUid = img.uid;
        const same = cur.source.type === 'card' && sameUid(cur.source.uid, img.uid);
        hp = same
          ? planHexWrite({ kind, mode: 'same', original: cur.original, data: curData, includeProtected: allowProtected })
          : planHexWrite({ kind, mode: 'copy', original: cur.original, data: curData, target: img, includeProtected: allowProtected });
        if (!same) baseData = img.data;
        setWorking('write');
      }
      if (hp.plan.writes.length === 0) {
        toast({ tone: 'info', title: hp.mode === 'copy' ? t('hex.copySame') : t('hex.block.nothing') });
        return;
      }
      const writeUnits = hp.plan.writes.map((w) => w.unit);
      const details: string[] = [
        t(isPage ? 'hex.cf.writesPages' : 'hex.cf.writesBlocks', { list: rangeText(writeUnits), n: writeUnits.length }),
      ];
      if (hp.excluded.locked.length) details.push(t('hex.excl.locked', { list: unitsText(hp.excluded.locked) }));
      if (hp.excluded.protected.length) details.push(t('hex.excl.protected', { list: unitsText(hp.excluded.protected) }));
      if (hp.excluded.keyA.length) details.push(t('hex.excl.keyA', { list: rangeText(hp.excluded.keyA) }));
      if (hp.excluded.invalid.length) details.push(t('hex.excl.invalid', { list: rangeText(hp.excluded.invalid) }));
      if (hp.excluded.otp.length) details.push(t('hex.excl.otp', { list: unitsText(hp.excluded.otp) }));
      if (hp.notCopied.protected.length) details.push(t('hex.cf.notCopiedProtected', { list: unitsText(hp.notCopied.protected) }));
      if (hp.notCopied.unread.length) details.push(t('hex.cf.notCopiedUnread', { list: unitsText(hp.notCopied.unread) }));
      for (const g of groupWarnings(hp.plan)) {
        details.push(t(WARN_MSG[g.code], { list: unitsText(g.units), idName }));
      }
      // R-UX-5: protection turned on (AUTH0) but no password written -> the tag is
      // "protected" by whatever PWD it has (FFFFFFFF from the factory).
      if (ntagArmsWithoutPassword(kind, baseData, hp.plan.writes)) details.push(t('hex.cf.pwUnset'));
      // R-UX-12: the password goes to a tag other than the one it was entered for.
      if (pw && sh.pwUid && !sameUid(sh.pwUid, targetUid)) details.push(t('hex.cf.pwOtherTag'));
      // (The "takes effect after re-placing the tag" line is added by writeWithConfirm
      // from reactivateAfter - not repeated here. E2E-UX-8.)

      // A copy: where the content comes from and that the UID is not copied are
      // in the confirmation's warning (op.write.confirm.*); the body only says
      // what is rewritten, so the dialog does not repeat itself (E2E-UX-8).
      const message = hp.mode === 'same' ? t('hex.cf.sameBody', { uid: formatUid(targetUid), idName }) : t('hex.cf.copyBody');

      const protectedWrite = hp.plan.writes.some((w) => isProtectedUnit(kind, w.unit));
      const req: WriteRequest = {
        kind,
        expectedUid: targetUid,
        writes: hp.plan.writes,
        allowProtected: allowProtected && protectedWrite,
        verify: true,
        ntagPassword: pw,
      };
      // Same tag: every pending change that is not written (excluded, failed)
      // stays pending. Copy: the defaults (the units of the write).
      const keepUnits =
        hp.mode === 'same'
          ? Array.from({ length: spec.unitCount }, (_, u) => u).filter((u) => {
              for (let i = u * unitSize; i < (u + 1) * unitSize; i++) if (curData[i] !== cur.original.data[i]) return true;
              return false;
            })
          : undefined;
      const readAtBefore = cur.original.readAt;
      const res = await writeWithConfirm(req, {
        title: hp.mode === 'same' ? t('hex.cf.sameTitle') : t('hex.cf.copyTitle'),
        message,
        details,
        // A copy overwrites a DIFFERENT tag than the one on screen: always confirm.
        dangerous: (allowProtected && protectedWrite) || hp.mode === 'copy',
        // I5: an irreversible protection write must be gated behind typing a word.
        typeToConfirm: needsLockConfirmForWrites(hp.plan) ? t('hex.write.lockWord') : undefined,
        target: { kind, uid: targetUid, other: hp.mode === 'copy' },
        reactivateAfter: hp.reactivate,
        keepUnitsOnFailure: keepUnits,
        readOptions: pw ? { ntagPassword: pw } : {},
      });
      const d = useAppStore.getState().doc;
      const nowThisTag = !!d && d.source.type === 'card' && sameUid(d.source.uid, targetUid);
      if (res && pw && nowThisTag && d!.original.readAt !== readAtBefore) {
        // Re-read with the password after the write: this document was read with it.
        sh.setPwReadAt(d!.original.readAt);
        sh.setPwUid(targetUid);
      }
      if (res && hp.mode === 'copy' && nowThisTag) {
        toast({ tone: 'info', title: t('hex.switched', { uid: formatUid(targetUid) }), detail: t('hex.switchedHint') });
      }
    } catch (err) {
      toastError(err);
    } finally {
      setWorking(null);
    }
  };

  // --- keyboard (grid) -------------------------------------------------------
  // Ctrl+Z / Ctrl+Y are handled here and preventDefault'ed; the global shortcut
  // ignores events that are already defaultPrevented (WRITE-19 agreement).
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && (key === 'z' || key === 'y')) {
      e.preventDefault();
      if (lockedUi) return;
      setPending(null);
      if (key === 'y' || e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === 'c') {
      e.preventDefault();
      doCopy();
      return;
    }
    if (mod && key === 'v') {
      e.preventDefault();
      doPaste();
      return;
    }
    switch (e.key) {
      case 'Escape':
        if (pending) {
          e.preventDefault();
          setPending(null);
        }
        return;
      case 'ArrowLeft':
        e.preventDefault();
        moveCursor(cursor - 1, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        moveCursor(cursor + 1, e.shiftKey);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveCursor(cursor - bytesPerRow, e.shiftKey);
        return;
      case 'ArrowDown':
        e.preventDefault();
        moveCursor(cursor + bytesPerRow, e.shiftKey);
        return;
      case 'Tab':
        e.preventDefault();
        moveCursor(cursor + (e.shiftKey ? -1 : 1), false);
        return;
      case 'Home':
        e.preventDefault();
        moveCursor(unitOfByte(kind, cursor) * unitSize, e.shiftKey);
        return;
      case 'End':
        e.preventDefault();
        moveCursor(unitOfByte(kind, cursor) * unitSize + unitSize - 1, e.shiftKey);
        return;
      default:
        break;
    }
    if (mod || e.altKey) return;
    const isInput = editMode === 'hex' ? hexDigit(e.key) >= 0 : e.key.length === 1 && e.key.charCodeAt(0) >= 0x20 && e.key.charCodeAt(0) < 0x7f;
    if (!isInput) return;
    e.preventDefault();
    if (lockedUi) {
      setRoNotice(t('hex.ro.busy'));
      return;
    }
    const ro = roAt(cursor);
    if (ro) {
      setRoNotice(roText(ro));
      return;
    }
    if (editMode === 'hex') typeHexDigit(hexDigit(e.key));
    else typeAscii(e.key.charCodeAt(0));
  };

  // --- labels ----------------------------------------------------------------
  const timeText = new Date(doc.original.readAt).toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  const sourceText =
    doc.source.type === 'card'
      ? t('hex.doc.fromCard', { uid: formatUid(doc.source.uid), time: timeText })
      : doc.source.type === 'file'
        ? t('hex.doc.fromFile', { name: doc.source.name })
        : t('hex.doc.fromNew', { kind: kindLabel(kind) });
  const revertLabel = doc.source.type === 'card' ? t('hex.revert.card') : doc.source.type === 'file' ? t('hex.revert.file') : t('hex.revert.new');
  const savedNow = saved && saved.revision === doc.revision ? saved : null;

  const deniedN = doc.source.type === 'card' ? doc.original.unitStatus.filter((s) => s !== 'ok').length : 0;
  // Why some pages / blocks could not be read, and the one button that helps
  // (null = none does: a storage-only reader cannot authenticate at all).
  //  - NTAG: storage reader (R-UX-1) / read WITH the password (wrong password) /
  //    password entered but this read did not use it (auto-read never sends it,
  //    R-UX-12) / no password yet.
  //  - MIFARE (D9): auto-read tries only the standard keys; the manual read tries
  //    every registered key.
  const hint = deniedHint({ kind, deniedN, noAuth: actions.noAuth, password: sh.password, pwReadAt: sh.pwReadAt, readAt: doc.original.readAt });
  const denied: { text: string; button: string | null } | null = hint
    ? {
        text: t(DENIED_MSG[hint], { n: deniedN }),
        button: hint === 'ntagStorage' ? null : hint === 'ntagNoPw' ? t('hex.denied.readWithPw') : hint === 'mifare' ? t('hex.denied.readWithKeys') : t('hex.denied.reread'),
      }
    : null;

  // exclusions of the pending edits (document read from a tag: they would go back to it)
  const exNotes: string[] = [];
  if (doc.source.type === 'card' && samePlan) {
    const ex = samePlan.excluded;
    if (ex.locked.length) exNotes.push(t('hex.excl.locked', { list: unitsText(ex.locked) }));
    if (ex.protected.length) exNotes.push(t('hex.excl.protected', { list: unitsText(ex.protected) }));
    if (ex.keyA.length) exNotes.push(t('hex.excl.keyA', { list: rangeText(ex.keyA) }));
    if (ex.invalid.length) exNotes.push(t('hex.excl.invalid', { list: rangeText(ex.invalid) }));
    if (ex.otp.length) exNotes.push(t('hex.excl.otp', { list: unitsText(ex.otp) }));
  }

  const blockText = (b: WriteBlock): string => {
    switch (b.type) {
      case 'op':
        return opText(b.block);
      case 'kind':
        return t('hex.block.kind', { card: kindLabel(b.cardKind), doc: kindLabel(b.docKind) });
      case 'password':
        return t('hex.block.password');
      case 'nothing':
        return t('hex.block.nothing');
      case 'excluded':
        return t('hex.block.excluded');
    }
  };

  const runState = (() => {
    // D13 / E2E-UX-4: nothing is read or written while a confirmation is open -
    // "writing… keep the tag on the reader" only once it has been accepted.
    if (working && confirming) return { text: t('hex.run.confirm'), tone: 'muted' as const };
    if (working === 'read') return { text: t('hex.run.reading'), tone: 'info' as const };
    if (working === 'target') return { text: t('hex.run.checking'), tone: 'info' as const };
    if (working === 'write') return { text: t('hex.run.writing'), tone: 'info' as const };
    if (readiness.block) return { text: blockText(readiness.block), tone: readiness.block.type === 'kind' || readiness.block.type === 'password' ? ('warn' as const) : ('muted' as const) };
    const c = readiness.card!;
    switch (readiness.relation) {
      case 'same':
        return { text: t('hex.rel.same', { uid: formatUid(c.uid) }), tone: 'ok' as const };
      case 'other-card':
        return { text: t('hex.rel.otherCard', { uid: formatUid(c.uid), docUid: doc.source.type === 'card' ? formatUid(doc.source.uid) : '' }), tone: 'warn' as const };
      case 'file':
        return { text: t('hex.rel.file', { uid: formatUid(c.uid) }), tone: 'warn' as const };
      default:
        return { text: t('hex.rel.new', { uid: formatUid(c.uid) }), tone: 'warn' as const };
    }
  })();
  const showReadThis = !working && !readiness.block && readiness.relation !== null && readiness.relation !== 'same';
  const showPlaceHint =
    (working !== null && !confirming) || (readiness.block?.type === 'op' && (readiness.block.block === 'absent' || readiness.block.block === 'detecting'));

  // --- grid rows -------------------------------------------------------------
  // Rows hold `bytesPerRow` bytes and may span several pages/blocks (so a tall
  // 4-byte-per-page NTAG dump can be shown 8/16/32 bytes per row). Region colour,
  // lock state and read status are per CELL (per its unit); a thin divider marks
  // each page/block boundary inside a row.
  const cursorKey = isPage ? 'hex.cursorPage' : 'hex.cursorBlock';
  const cursorUnit = unitOfByte(kind, cursor);
  const cursorRo = roAt(cursor);
  const rows = [];
  for (let rowStart = 0; rowStart < total; rowStart += bytesPerRow) {
    const rowEnd = Math.min(rowStart + bytesPerRow, total);
    const firstUnit = unitOfByte(kind, rowStart);
    const lastUnit = unitOfByte(kind, rowEnd - 1);
    let anyForbidden = false;
    let anyLocked = false;
    let anyProtected = false;
    for (let u = firstUnit; u <= lastUnit; u++) {
      if (isForbiddenUnit(kind, u)) anyForbidden = true;
      else if (lockedSet.has(u)) anyLocked = true;
      else if (isProtectedUnit(kind, u)) anyProtected = true;
    }
    // FeliCa: label rows by block name (S_PAD0, REG, MC) instead of unit index.
    const addrLabel = firstUnit === lastUnit ? unitName(firstUnit) : isFelica(kind) ? `${unitName(firstUnit)}…` : `${firstUnit}–${lastUnit}`;

    const hexCells = [];
    const asciiCells = [];
    for (let bi = rowStart; bi < rowEnd; bi++) {
      const u = unitOfByte(kind, bi);
      const ro = byteReadOnlyReason(kind, bi, roCtx);
      const forbidden = ro === 'forbidden' || ro === 'uidCheck';
      const locked = ro === 'locked';
      const prot = !forbidden && !locked && isProtectedUnit(kind, u);
      const status = doc.image.unitStatus[u];
      const denied = status === 'denied' || status === 'unread' || status === 'error';
      const rkey = regionKey(kind, u);
      const unitStart = bi % unitSize === 0 && bi !== rowStart;
      const sel = bi >= lo && bi <= hi;
      const isCursor = bi === cursor;
      const isPending = pending?.index === bi;
      const b = data[bi];
      const st = struct[bi];
      const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      hexCells.push(
        <span
          key={bi}
          className={cx(
            'hx-cell',
            `region-${rkey}`,
            forbidden && 'forbidden',
            locked && 'locked',
            prot && 'protected',
            ro && 'ro',
            denied && 'denied',
            changed[bi] && 'changed',
            sel && 'sel',
            isCursor && 'cursor',
            isPending && 'pending',
            st?.boundary && 'hx-bound',
            st?.inNdef && 'hx-ndef',
            st?.terminator && 'hx-term',
            unitStart && 'hx-unitstart',
          )}
          title={ro ? roText(ro) : (st?.label ?? addrLabel)}
          onMouseDown={(e) => onCellDown(bi, e)}
        >
          {isPending ? `${pending!.high.toString(16).toUpperCase()}_` : toHex2(b)}
        </span>,
      );
      asciiCells.push(
        <span
          key={bi}
          className={cx(
            'hx-achar',
            `region-${rkey}`,
            denied && 'denied',
            changed[bi] && 'changed',
            sel && 'sel',
            isCursor && 'cursor',
            unitStart && 'hx-unitstart',
          )}
          onMouseDown={(e) => onCellDown(bi, e)}
        >
          {ch}
        </span>,
      );
    }

    rows.push(
      <div key={rowStart} className="hx-row">
        <span className={cx('hx-addr', isFelica(kind) ? 'hx-addr-name' : firstUnit !== lastUnit && 'hx-addr-wide')} title={addrLabel}>
          {anyForbidden ? (
            <span className="hx-lock hx-lock-forbidden">
              <Lock size={12} aria-hidden />
            </span>
          ) : anyLocked ? (
            <span className="hx-lock hx-lock-locked">
              <LockKeyhole size={12} aria-hidden />
            </span>
          ) : anyProtected ? (
            <span className="hx-lock hx-lock-protected">
              <ShieldAlert size={12} aria-hidden />
            </span>
          ) : null}
          <span>{addrLabel}</span>
        </span>
        <span className="hx-cells">{hexCells}</span>
        <span className="hx-spacer" />
        <span className="hx-ascii">{asciiCells}</span>
      </div>,
    );
  }

  const legendKeys = isMifare(kind) ? ['manufacturer', 'data', 'trailer'] : spec.regions.map((r) => r.id);
  const cursorText = isFelica(kind)
    ? t('hex.cursorNamed', { name: unitName(cursorUnit), b: cursor % unitSize })
    : t(cursorKey, { u: cursorUnit, b: cursor % unitSize });
  const writeBusy = (working === 'write' || working === 'target') && !confirming;
  const writeDisabled = lockedUi || !!readiness.block;
  const mifareHasNdef = isMifare(kind) && mifareNdefBlocks(kind, data).length > 0;

  return (
    <Page className="hx-page">
      <PageHeader
        title={t('hex.title')}
        subtitle={t('hex.subtitle')}
        helpTopic="hex"
        actions={
          <>
            <IconButton icon={Undo2} label={t('hex.undo')} onClick={() => { setPending(null); undo(); }} disabled={!canUndo || lockedUi} />
            <IconButton icon={Redo2} label={t('hex.redo')} onClick={() => { setPending(null); redo(); }} disabled={!canRedo || lockedUi} />
          </>
        }
      />

      <div className="hx-top">
        {/* Document bar: where this came from + every document action, in one place. */}
        <div className="hx-docbar" data-testid="hex-docbar">
          <div className="hx-docbar-src">
            <strong className="hx-docbar-name" data-testid="hex-doc-source">
              {kindLabel(kind)} · {sourceText}
            </strong>
            <span className="row">
              {changedCount > 0 ? (
                <Badge tone="warn">{t(isPage ? 'hex.doc.dirtyPages' : 'hex.doc.dirtyBlocks', { n: changedCount })}</Badge>
              ) : (
                <Badge tone="neutral">{t('hex.doc.clean')}</Badge>
              )}
              {savedNow ? <Badge tone="info" icon={Save}>{t('hex.doc.saved', { name: savedNow.name })}</Badge> : null}
            </span>
          </div>
          <div className="hx-docbar-actions">
            <Button size="sm" icon={ScanLine} disabled={!!actions.readBlock || !actions.pwValid || lockedUi} loading={working === 'read'} title={actions.readBlock ? opText(actions.readBlock) : undefined} onClick={() => void actions.read()}>
              {t('hex.doc.read')}
            </Button>
            <Button size="sm" icon={FolderOpen} disabled={lockedUi} onClick={() => void actions.openFile()}>
              {t('hex.doc.open')}
            </Button>
            <Button size="sm" icon={FilePlus2} disabled={lockedUi} onClick={() => setDialog('new')}>
              {t('hex.doc.newBtn')}
            </Button>
            <Button size="sm" icon={Save} disabled={lockedUi} title={t('hex.doc.saveHint')} onClick={() => setDialog('save')}>
              {t('hex.doc.save')}
            </Button>
            {isNtag(kind) && !sh.password && deniedN === 0 ? (
              <Button size="sm" variant="ghost" icon={KeyRound} aria-expanded={pwOpen} onClick={() => setPwOpen((v) => !v)}>
                {t('hex.pw.toggle')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon={X} disabled={lockedUi} onClick={() => void actions.close()}>
              {t('hex.doc.close')}
            </Button>
          </div>
        </div>

        {isNtag(kind) && (pwOpen || sh.password || deniedN > 0) ? (
          <div className="hx-pwrow">
            <PasswordField value={sh.password} onChange={actions.changePassword} disabled={lockedUi} noAuth={actions.noAuth} note={actions.pwNote} />
          </div>
        ) : null}

        {denied ? (
          <Callout tone="warn">
            <div className="hx-inline-callout" data-testid="hex-denied">
              <span>{denied.text}</span>
              {denied.button ? (
                <Button size="sm" icon={isMifare(kind) ? KeyRound : ScanLine} disabled={!!actions.readBlock || !actions.pwValid || lockedUi} onClick={() => void actions.read()}>
                  {denied.button}
                </Button>
              ) : null}
            </div>
          </Callout>
        ) : null}

        {/* Editing toolbar (one row) */}
        <div className="hx-toolbar">
          <label className="hx-inline-label">
            {t('hex.editMode')}
            <Segmented
              ariaLabel={t('hex.editMode')}
              value={editMode}
              onChange={(v) => setPrefs((p) => ({ ...p, editMode: v }))}
              options={[
                { value: 'hex', label: t('hex.mode.hex') },
                { value: 'ascii', label: t('hex.mode.ascii') },
              ]}
            />
          </label>
          <label className="hx-inline-label">
            {t('hex.bytesPerRow')}
            <Segmented
              ariaLabel={t('hex.bytesPerRow')}
              value={String(bytesPerRow)}
              onChange={(v) => setPrefs((p) => ({ ...p, bytesPerRow: Number(v) }))}
              options={rowByteOptions.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </label>
          <Button size="sm" icon={Copy} onClick={doCopy}>
            {t('hex.copy')}
          </Button>
          <Button size="sm" icon={ClipboardPaste} onClick={doPaste} disabled={!clip || lockedUi}>
            {t('hex.paste')}
          </Button>
          <Button size="sm" icon={Hash} aria-expanded={prefs.incOpen} onClick={() => setPrefs((p) => ({ ...p, incOpen: !p.incOpen }))}>
            {t('hex.inc.toggle')}
          </Button>
          <span className="grow" />
          {advanced ? (
            <span className="row">
              <Switch checked={includeProtected} onChange={setIncludeProtected} disabled={lockedUi} label={t('hex.write.includeProtected')} />
              <HelpTip text={t('hex.write.includeProtectedHelp')} />
            </span>
          ) : null}
          <Button size="sm" icon={Eraser} disabled={lockedUi} onClick={() => setDialog('init')}>
            {t('hex.init.title')}
          </Button>
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={onRevert} disabled={changedCount === 0 || lockedUi}>
            {revertLabel}
          </Button>
        </div>

        {/* Sequence / number editing - folded away until needed (WALK-15). */}
        {prefs.incOpen ? (
          <div className="hx-inc">
            <div className="hx-inc-head">
              <Hash size={16} aria-hidden />
              {t('hex.inc.title')}
              <span className="small muted">{t('hex.inc.hint')}</span>
            </div>
            <div className="hx-inc-row">
              <label className="hx-inline-label">
                {t('hex.inc.width')}
                <span className="hx-inc-value">{t('hex.inc.widthBytes', { n: selLen })}</span>
              </label>
              <label className="hx-inline-label">
                {t('hex.inc.endian')}
                <Segmented
                  ariaLabel={t('hex.inc.endian')}
                  value={endian}
                  onChange={setEndian}
                  options={[
                    { value: 'BE', label: t('hex.inc.be') },
                    { value: 'LE', label: t('hex.inc.le') },
                  ]}
                />
              </label>
              <label className="hx-inline-label">
                {t('hex.inc.value')}
                <span className="hx-inc-value">
                  {value.toString()} / 0x{value.toString(16).toUpperCase().padStart(selLen * 2, '0')}
                </span>
              </label>
              {selForbidden ? (
                <span className="small hx-danger">{t('hex.inc.forbidden')}</span>
              ) : (
                <>
                  <Button size="sm" icon={Minus} disabled={lockedUi} onClick={() => incBy(-1n)}>
                    {t('hex.inc.minus')}
                  </Button>
                  <Button size="sm" icon={Plus} disabled={lockedUi} onClick={() => incBy(1n)}>
                    {t('hex.inc.plus')}
                  </Button>
                  <label className="hx-inline-label">
                    {t('hex.inc.step')}
                    <span className="row">
                      <TextInput mono value={stepText} onChange={(e) => setStepText(e.target.value)} />
                      <Button size="sm" disabled={lockedUi} onClick={addStep}>
                        {t('hex.inc.add')}
                      </Button>
                    </span>
                  </label>
                  <label className="hx-inline-label">
                    {t('hex.inc.setTo')}
                    <span className="row">
                      <TextInput mono value={setValueText} onChange={(e) => setSetValueText(e.target.value)} placeholder="0x…" />
                      <Button size="sm" disabled={lockedUi} onClick={setVal}>
                        {t('hex.inc.set')}
                      </Button>
                    </span>
                  </label>
                </>
              )}
            </div>
          </div>
        ) : null}

        <div className="hx-legend">
          {legendKeys.map((k) => (
            <span key={k} className="hx-legend-item">
              <span className={cx('hx-swatch', `region-${k}`)} />
              {t(regionLabel(k))}
            </span>
          ))}
          <span className="hx-legend-item">
            <Lock size={13} aria-hidden /> {t('hex.readonly')}
          </span>
          {lockedUnits.length ? (
            <span className="hx-legend-item">
              <LockKeyhole size={13} aria-hidden /> {t('hex.lockedLegend')}
            </span>
          ) : null}
          <span className="hx-legend-item">
            <ShieldAlert size={13} aria-hidden /> {t('hex.protected')}
          </span>
          <span className="hx-legend-item hx-uidline">{t('hex.uidNote', { idName })}</span>
        </div>
      </div>

      <div className="hx-editor">
        <div
          className={cx('hx-grid', lockedUi && 'hx-grid-busy')}
          ref={gridRef}
          tabIndex={0}
          role="grid"
          aria-label={t('hex.title')}
          aria-busy={lockedUi || undefined}
          aria-readonly={lockedUi || undefined}
          data-testid="hex-grid"
          onKeyDown={onKeyDown}
          onBlur={commitPending}
        >
          {rows}
        </div>

        <div className="hx-status">
          <span>{cursorText}</span>
          {selLen > 1 ? <span>{t('hex.selection', { n: selLen })}</span> : null}
          {cursorRo ? <span className="hx-ro-reason">{roText(cursorRo)}</span> : null}
          {roNotice ? (
            <span className="hx-ro-notice" role="status">
              {roNotice}
            </span>
          ) : null}
        </div>
      </div>

      {/* Byte/bit inspector + data-structure (NDEF/TLV) boundaries for the current unit. */}
      <UnitInspector
        kind={kind}
        data={data}
        unit={cursorUnit}
        onGoto={(byte) => {
          commitPending();
          const c = clamp(byte);
          setCursor(c);
          setAnchor(c);
          gridRef.current?.focus();
        }}
      />

      {/* Parameter / flag editor: edit config flags through labelled controls. */}
      <FlagEditor
        kind={kind}
        data={data}
        original={original}
        unit={cursorUnit}
        advanced={advanced}
        protectedEditable={allowProtected}
        onEnableProtected={() => setIncludeProtected(true)}
        passwordAuthUnavailable={actions.noAuth}
        busy={lockedUi}
        onApply={applyEdit}
        confirm={confirm}
      />

      <div className="hx-panelgrid">
        <Card
          title={
            <>
              <Search size={16} aria-hidden /> {t('hex.find.title')}
            </>
          }
        >
          <div className="stack">
            <Segmented
              ariaLabel={t('hex.editMode')}
              value={searchMode}
              onChange={setSearchMode}
              options={[
                { value: 'hex', label: t('hex.mode.hex') },
                { value: 'ascii', label: t('hex.mode.ascii') },
              ]}
            />
            <Field label={t('hex.find.pattern')}>
              <TextInput mono value={findText} onChange={(e) => setFindText(e.target.value)} placeholder={searchMode === 'hex' ? '04 A2' : 'abc'} />
            </Field>
            <div className="row">
              <Button size="sm" onClick={() => gotoMatch(matchIdx - 1)} disabled={matches.length === 0}>
                {t('hex.find.prev')}
              </Button>
              <Button size="sm" onClick={() => gotoMatch(matchIdx + 1)} disabled={matches.length === 0}>
                {t('hex.find.next')}
              </Button>
              <span className="small muted">
                {findText && matches.length === 0 ? t('hex.find.none') : t('hex.find.count', { n: matches.length })}
              </span>
            </div>
            <Field label={t('hex.find.replaceWith')}>
              <TextInput mono value={replaceText} onChange={(e) => setReplaceText(e.target.value)} />
            </Field>
            <Button size="sm" icon={Replace} onClick={replaceAll} disabled={lockedUi}>
              {t('hex.find.replaceAll')}
            </Button>
          </div>
        </Card>

        <Card
          title={
            <>
              <PaintBucket size={16} aria-hidden /> {t('hex.fill.title')}
            </>
          }
        >
          <div className="stack">
            <div className="small muted">{t('hex.fill.hint')}</div>
            <div className="row">
              <Button size="sm" disabled={lockedUi} onClick={() => fillWith(0x00)}>
                00
              </Button>
              <Button size="sm" disabled={lockedUi} onClick={() => fillWith(0xff)}>
                FF
              </Button>
            </div>
            <Field label={t('hex.fill.custom')}>
              <span className="row">
                <TextInput mono value={fillText} onChange={(e) => setFillText(e.target.value)} placeholder="00" />
                <Button size="sm" disabled={lockedUi} onClick={fillCustom}>
                  {t('hex.fill.apply')}
                </Button>
              </span>
            </Field>
          </div>
        </Card>
      </div>

      {/* Run bar: fixed at the bottom of the screen (WALK-9 / WRITE-17 / FIRST-19). */}
      <div className="hx-run" data-testid="hex-runbar">
        <LastWriteCallout />
        {exNotes.length ? (
          <ul className="hx-run-notes" data-testid="hex-excluded">
            {exNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
        <div className="hx-run-row">
          <div className="hx-run-state">
            {/* R-UX-9: the way back when the operator was sent here to enter a password. */}
            <ResolveReturn view="hex" compact />
            {/* readThis={false}: this bar has its own "Read this tag" (with the password) - E2E-UX-3. */}
            <TagOnReader compact readThis={false} />
            <span className={cx('hx-run-text', `tone-${runState.tone}`)} data-testid="hex-write-state" role="status">
              {runState.text}
            </span>
            {showReadThis ? (
              <Button size="sm" icon={ScanLine} disabled={!!actions.readBlock || !actions.pwValid || lockedUi} onClick={() => void actions.read()}>
                {t('hex.rel.readThis')}
              </Button>
            ) : null}
            {showPlaceHint ? <span className="small muted">{t('hex.placeShort')}</span> : null}
          </div>
          <div className="hx-run-main">
            {changedCount > 0 ? <span className="small muted">{t(isPage ? 'hex.doc.dirtyPages' : 'hex.doc.dirtyBlocks', { n: changedCount })}</span> : null}
            <Button
              icon={Upload}
              variant="primary"
              disabled={writeDisabled}
              loading={writeBusy}
              title={t('hex.doc.writeHint')}
              data-testid="hex-write"
              onClick={(e) => {
                if (e.detail > 1) return; // a double click is one write (WRITE-13)
                void onWrite();
              }}
            >
              {t('hex.write')}
            </Button>
          </div>
        </div>
      </div>

      <NewDocModal
        open={dialog === 'new'}
        onClose={() => setDialog(null)}
        onCreate={(k) => {
          setDialog(null);
          void actions.createNew(k);
        }}
      />
      <SaveModal
        open={dialog === 'save'}
        kind={kind}
        dirtyText={changedCount > 0 ? t(isPage ? 'hex.saveDlg.dirtyPages' : 'hex.saveDlg.dirtyBlocks', { n: changedCount }) : null}
        onClose={() => setDialog(null)}
        onSave={(f) => void onSave(f)}
      />
      <InitModal
        open={dialog === 'init'}
        kind={kind}
        idName={idName}
        mifareHasNdef={mifareHasNdef}
        onClose={() => setDialog(null)}
        onConfirm={onInitialize}
      />
    </Page>
  );
}

function SaveModal({
  open,
  kind,
  dirtyText,
  onClose,
  onSave,
}: {
  open: boolean;
  kind: TagKind;
  dirtyText: string | null;
  onClose: () => void;
  onSave: (f: 'project' | 'bin') => void;
}) {
  const t = useT();
  // FeliCa has no raw .bin layout that can be opened again (no size match): .nfcdump only.
  const formats: ('project' | 'bin')[] = isFelica(kind) ? ['project'] : ['project', 'bin'];
  const [format, setFormat] = useState<'project' | 'bin'>('project');
  const f = formats.includes(format) ? format : 'project';
  return (
    <Modal
      open={open}
      title={t('hex.saveDlg.title')}
      icon={Save}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('hex.cancel')}
          </Button>
          <Button variant="primary" icon={Save} onClick={() => onSave(f)}>
            {t('hex.saveDlg.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{t('hex.saveDlg.body')}</p>
        {dirtyText ? <Callout tone="warn">{dirtyText}</Callout> : null}
        <Field label={t('hex.saveDlg.format')} hint={f === 'project' ? t('hex.saveDlg.fmtProjectHelp') : t('hex.saveDlg.fmtBinHelp')}>
          <Segmented
            ariaLabel={t('hex.saveDlg.format')}
            value={f}
            onChange={setFormat}
            options={formats.map((v) => ({ value: v, label: v === 'project' ? t('hex.saveDlg.fmtProject') : t('hex.saveDlg.fmtBin') }))}
          />
        </Field>
      </div>
    </Modal>
  );
}

function InitModal({
  open,
  kind,
  idName,
  mifareHasNdef,
  onClose,
  onConfirm,
}: {
  open: boolean;
  kind: TagKind;
  idName: string;
  mifareHasNdef: boolean;
  onClose: () => void;
  onConfirm: (mode: InitMode) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<InitMode>('ndef');
  const m: InitMode = isMifare(kind) && !mifareHasNdef ? 'zero' : mode;
  const body = isNtag(kind)
    ? t('hex.init.bodyNtag')
    : isFelica(kind)
      ? t('hex.init.bodyFelica')
      : !mifareHasNdef
        ? t('hex.init.mifareNoNdef')
        : m === 'ndef'
          ? t('hex.init.bodyMifareNdef')
          : t('hex.init.bodyMifareZero');
  return (
    <Modal
      open={open}
      title={t('hex.init.dlgTitle')}
      icon={Eraser}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('hex.cancel')}
          </Button>
          <Button variant="primary" icon={Eraser} onClick={() => onConfirm(m)}>
            {t('hex.init.confirm')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {isMifare(kind) && mifareHasNdef ? (
          <Segmented
            ariaLabel={t('hex.init.dlgTitle')}
            value={m}
            onChange={setMode}
            options={[
              { value: 'ndef', label: t('hex.init.modeNdef') },
              { value: 'zero', label: t('hex.init.modeZero') },
            ]}
          />
        ) : null}
        <p>{body}</p>
        <p className="small muted">{t('hex.init.keepsUid', { idName })}</p>
        <Callout tone="info">{t('hex.init.pending')}</Callout>
      </div>
    </Modal>
  );
}

function hexDigit(k: string): number {
  if (k.length !== 1) return -1;
  const c = k.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  const lower = k.toLowerCase().charCodeAt(0);
  if (lower >= 97 && lower <= 102) return lower - 97 + 10; // a-f
  return -1;
}
