// Binary (hex) editor view. Owner: agent renderer-hex. Export name `HexView`
// is imported by App.tsx - keep it.
//
// Design invariant (I1/I2): the UID is read-only. Forbidden units (NTAG pages
// 0-1, MIFARE block 0) are shown but never editable, every edit is funnelled
// through restoreLockedBytes, and the write plan (shared/tag planWrites) excludes
// them. We only ever copy the DATA area - never the UID.
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
  Lock,
  Minus,
  PaintBucket,
  Plus,
  Redo2,
  RefreshCw,
  Replace,
  ScanLine,
  Search,
  ShieldAlert,
  Undo2,
  Upload,
} from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, isForbiddenUnit, isMifare, isNtag, isProtectedUnit, mifareDataBlocks, specFor } from '@shared/tags';
import { blankImage, importDump, planWrites } from '@shared/tag';
import { FILE_FILTERS } from '@shared/api';
import type { WriteRequest } from '@shared/types';
import { Button, Callout, Card, EmptyState, Field, IconButton, Page, PageHeader, Segmented, Select, Switch, TextInput } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { api } from '../../lib/api';
import { readCurrentTag, writeWithConfirm } from '../../lib/ops';
import { kindLabel } from '../../lib/format';
import {
  changedMask,
  changedUnitCount,
  effectiveIncludeProtected,
  fillRange,
  findBytes,
  incrementRange,
  needsLockConfirm,
  parseByteInput,
  parseIntInput,
  parsePattern,
  pasteBytes,
  rangeTouchesForbidden,
  readUint,
  regionKey,
  replaceBytes,
  restoreLockedBytes,
  selectionBounds,
  unitOfByte,
  writeUint,
} from './model';
import type { ByteMode, Endian } from './model';
import { perByteStructure } from './inspect';
import { UnitInspector } from './UnitInspector';
import './hex.css';

const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ');
const toHex2 = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');

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
};

function regionLabel(key: string): MsgKey {
  return REGION_MSG[key] ?? 'hex.region.data';
}

function randomUidHex(kind: TagKind): string {
  const n = specFor(kind).uidBytes;
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  b[0] = 0x04; // NXP manufacturer byte (display-only UID for a new document)
  return Array.from(b, toHex2).join('');
}

// ---------------------------------------------------------------------------
// Entry screen (no document open)
// ---------------------------------------------------------------------------

function HexEntry() {
  const t = useT();
  const openImage = useAppStore((s) => s.openImage);
  const toastError = useAppStore((s) => s.toastError);
  const [kind, setKind] = useState<TagKind>('NTAG215');

  const newBlank = () => {
    try {
      openImage(blankImage(kind, randomUidHex(kind)), { type: 'new' });
    } catch (err) {
      toastError(err);
    }
  };

  const openFile = async () => {
    try {
      const res = await api.openFile({ title: t('hex.open'), filters: [FILE_FILTERS.project, FILE_FILTERS.bin, FILE_FILTERS.flipper] });
      if (!res) return;
      const { image } = importDump(res.name, res.bytes);
      openImage(image, { type: 'file', name: res.name, token: res.token, format: 'dump' });
    } catch (err) {
      toastError(err, t('hex.openError'));
    }
  };

  return (
    <Page>
      <PageHeader title={t('hex.title')} subtitle={t('hex.subtitle')} helpTopic="hex" />
      <Card>
        <EmptyState icon={Binary} title={t('hex.empty.title')}>
          <p className="muted">{t('hex.empty.desc')}</p>
          <div className="hx-toolbar" style={{ justifyContent: 'center', marginTop: 'var(--space-3)' }}>
            <Field label={t('hex.chooseKind')} htmlFor="hex-kind">
              <Select id="hex-kind" value={kind} onChange={setKind} options={TAG_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
            </Field>
            <Button icon={FilePlus2} onClick={newBlank}>
              {t('hex.new')}
            </Button>
            <Button icon={FolderOpen} onClick={openFile}>
              {t('hex.open')}
            </Button>
            <Button icon={ScanLine} variant="primary" onClick={() => void readCurrentTag()}>
              {t('hex.read')}
            </Button>
          </div>
        </EmptyState>
      </Card>
      <Callout tone="info" title={t('tag.uid')}>
        {t('hex.uidNote')}
      </Callout>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Editor (document open)
// ---------------------------------------------------------------------------

function HexEditor() {
  const t = useT();
  const doc = useAppStore((s) => s.doc)!;
  const editDocData = useAppStore((s) => s.editDocData);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const canUndo = useAppStore((s) => s.past.length > 0);
  const canRedo = useAppStore((s) => s.future.length > 0);
  const reader = useAppStore((s) => s.reader);
  const advanced = useAppStore((s) => s.settings.advancedMode);
  const lang = useAppStore((s) => s.settings.language);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);
  const takeHandoff = useAppStore((s) => s.takeHandoff);

  const kind = doc.image.kind;
  const spec = specFor(kind);
  const data = doc.image.data;
  const original = doc.original.data;
  const unitSize = spec.unitSize;
  const total = data.length;

  const [cursor, setCursor] = useState(Math.min(spec.userStartUnit * unitSize, total - 1));
  const [anchor, setAnchor] = useState(Math.min(spec.userStartUnit * unitSize, total - 1));
  const [editMode, setEditMode] = useState<ByteMode>('hex');
  const [endian, setEndian] = useState<Endian>('BE');
  const [pending, setPending] = useState<{ index: number; high: number } | null>(null);
  const [clip, setClip] = useState<Uint8Array | null>(null);
  const [includeProtected, setIncludeProtected] = useState(false);
  // Bytes shown per grid row (a multiple of the unit size). Default 16 so a tall
  // 4-byte-per-page NTAG dump fits in far fewer rows.
  const rowByteOptions = unitSize >= 16 ? [16, 32, 48] : [4, 8, 16, 32];
  const [bytesPerRow, setBytesPerRow] = useState<number>(16);

  const [searchMode, setSearchMode] = useState<ByteMode>('hex');
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);

  const [stepText, setStepText] = useState('1');
  const [setValueText, setSetValueText] = useState('');
  const [fillText, setFillText] = useState('00');

  const gridRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);

  // Open at the handoff target, if any ("hex-goto" from another view).
  useEffect(() => {
    const h = takeHandoff('hex-goto');
    if (h) {
      const idx = Math.min(Math.max(0, h.unit * unitSize), total - 1);
      setCursor(idx);
      setAnchor(idx);
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cursor]);

  // I5: the "also write protected areas" switch exists only in advanced mode.
  // Disarm it when advanced mode is turned off so protected writes can never stay
  // enabled while the toggle is hidden and out of the operator's reach.
  useEffect(() => {
    if (!advanced) setIncludeProtected(false);
  }, [advanced]);

  const changed = useMemo(() => changedMask(data, original), [data, original]);
  const changedCount = useMemo(() => changedUnitCount(kind, data, original), [kind, data, original]);
  // Data-structure boundaries (NDEF / TLV spans) for the grid and the inspector.
  const struct = useMemo(() => perByteStructure(kind, data, lang), [kind, data, lang]);

  const { lo, hi } = selectionBounds(anchor, cursor);
  const selLen = hi - lo + 1;
  const selForbidden = rangeTouchesForbidden(kind, lo, hi);
  const value = readUint(data, lo, selLen, endian);

  // Single chokepoint: no edit can ever change a forbidden (UID / block 0) unit.
  const applyEdit = useCallback(
    (next: Uint8Array) => {
      editDocData(restoreLockedBytes(kind, next, original));
    },
    [editDocData, kind, original],
  );

  const clamp = (i: number) => Math.max(0, Math.min(i, total - 1));
  const isForbiddenAt = (i: number) => isForbiddenUnit(kind, unitOfByte(kind, i));
  const nextEditable = (from: number) => {
    let i = from + 1;
    while (i < total && isForbiddenAt(i)) i++;
    return i < total ? i : from;
  };

  const moveCursor = (to: number, extend: boolean) => {
    const c = clamp(to);
    setCursor(c);
    if (!extend) setAnchor(c);
    setPending(null);
  };

  const onCellDown = (bi: number, e: ReactMouseEvent) => {
    e.preventDefault();
    gridRef.current?.focus();
    setCursor(bi);
    if (!e.shiftKey) setAnchor(bi);
    setPending(null);
  };

  const typeHexDigit = (d: number) => {
    const next = new Uint8Array(data);
    if (pending && pending.index === cursor) {
      next[cursor] = (pending.high << 4) | d;
      applyEdit(next);
      setPending(null);
      const nc = nextEditable(cursor);
      setCursor(nc);
      setAnchor(nc);
    } else {
      next[cursor] = (d << 4) | (data[cursor] & 0x0f);
      applyEdit(next);
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
    setAnchor(start);
    setCursor(Math.min(total - 1, start + needle.length - 1));
    setPending(null);
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

  const onRevert = () => applyEdit(new Uint8Array(original));

  // Initialize / format: clear the DATA area to a blank state, keeping the UID,
  // CC and config/password pages. NTAG -> empty NDEF TLV (03 00 FE) + zeros;
  // MIFARE -> all data blocks zeroed (block 0 and sector trailers untouched).
  // Produces pending edits the operator reviews, then writes with "write to tag".
  const onInitialize = async () => {
    const ok = await confirm({
      title: t('hex.init.title'),
      message: t('hex.init.body'),
      details: [t('hex.init.keepsUid')],
      tone: 'warn',
      confirmLabel: t('hex.init.confirm'),
    });
    if (!ok) return;
    const next = new Uint8Array(data);
    if (isNtag(kind)) {
      const us = spec.userStartUnit * unitSize;
      for (let i = us; i < us + spec.userBytes; i++) next[i] = 0;
      next[us] = 0x03;
      next[us + 1] = 0x00;
      next[us + 2] = 0xfe;
    } else {
      for (const blk of mifareDataBlocks(kind)) for (let i = 0; i < unitSize; i++) next[blk * unitSize + i] = 0;
    }
    applyEdit(next);
    toast({ tone: 'ok', title: t('hex.init.done'), detail: t('hex.init.doneHint') });
  };

  const onWrite = async () => {
    const card = reader?.card ?? null;
    if (!card) {
      toast({ tone: 'warn', title: t('hex.write.needCard') });
      return;
    }
    if (card.kind && card.kind !== kind) {
      toast({ tone: 'warn', title: t('hex.write.kindMismatch', { reader: kindLabel(card.kind), doc: kindLabel(kind) }) });
      return;
    }
    // I5: protected areas may be written only in advanced mode; the stored switch
    // value is only honoured while advanced mode is on (it is also disarmed above).
    const allowProtected = effectiveIncludeProtected(advanced, includeProtected);
    let plan;
    try {
      plan = planWrites(kind, doc.original, data, { includeProtected: allowProtected });
    } catch (err) {
      toastError(err);
      return;
    }
    if (plan.writes.length === 0) {
      toast({ tone: 'info', title: t('hex.write.nothing') });
      return;
    }
    const details = [
      t('hex.write.units', { n: plan.writes.length }),
      ...(plan.protectedUnits.length ? [t('hex.write.protectedUnits', { n: plan.protectedUnits.length })] : []),
      ...(plan.forbiddenUnits.length ? [t('hex.write.forbiddenExcluded', { n: plan.forbiddenUnits.length })] : []),
      ...plan.warnings.map((w) => w.message),
    ];
    const req: WriteRequest = {
      kind,
      expectedUid: card.uid,
      writes: plan.writes,
      allowProtected,
      verify: true,
    };
    // I5: an irreversible protection write (lock bytes / CC-OTP / CFG / PWD /
    // sector trailer) must be gated behind typing a word, not a single OK click.
    const lockConfirm = needsLockConfirm(plan);
    await writeWithConfirm(req, {
      title: t('hex.write.title'),
      message: t('hex.write.message'),
      details,
      dangerous: allowProtected || plan.protectedUnits.length > 0,
      typeToConfirm: lockConfirm ? t('hex.write.lockWord') : undefined,
    });
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      doCopy();
      return;
    }
    if (mod && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      doPaste();
      return;
    }
    switch (e.key) {
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
        moveCursor(cursor - unitSize, e.shiftKey);
        return;
      case 'ArrowDown':
        e.preventDefault();
        moveCursor(cursor + unitSize, e.shiftKey);
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
    if (isForbiddenAt(cursor)) return;
    if (editMode === 'hex') {
      const d = hexDigit(e.key);
      if (d < 0) return;
      e.preventDefault();
      typeHexDigit(d);
    } else if (e.key.length === 1) {
      const code = e.key.charCodeAt(0);
      if (code >= 0x20 && code < 0x7f) {
        e.preventDefault();
        typeAscii(code);
      }
    }
  };

  const legendKeys = isMifare(kind) ? ['manufacturer', 'data', 'trailer'] : spec.regions.map((r) => r.id);
  const sourceLabel =
    doc.source.type === 'card'
      ? t('hex.source.card')
      : doc.source.type === 'file'
        ? t('hex.source.file', { name: doc.source.name })
        : t('hex.source.new');

  // Rows hold `bytesPerRow` bytes and may span several pages/blocks (so a tall
  // 4-byte-per-page NTAG dump can be shown 8/16/32 bytes per row). Region colour,
  // lock state and read status are per CELL (per its unit); a thin divider marks
  // each page/block boundary inside a row.
  const unitWord = spec.unit === 'page' ? t('hex.unit.page') : t('hex.unit.block');
  const rows = [];
  for (let rowStart = 0; rowStart < total; rowStart += bytesPerRow) {
    const rowEnd = Math.min(rowStart + bytesPerRow, total);
    const firstUnit = unitOfByte(kind, rowStart);
    const lastUnit = unitOfByte(kind, rowEnd - 1);
    let anyForbidden = false;
    let anyProtected = false;
    for (let u = firstUnit; u <= lastUnit; u++) {
      if (isForbiddenUnit(kind, u)) anyForbidden = true;
      else if (isProtectedUnit(kind, u)) anyProtected = true;
    }
    const addrLabel = firstUnit === lastUnit ? String(firstUnit) : `${firstUnit}–${lastUnit}`;
    const rowTitle = `${unitWord} ${addrLabel}`;

    const hexCells = [];
    const asciiCells = [];
    for (let bi = rowStart; bi < rowEnd; bi++) {
      const u = unitOfByte(kind, bi);
      const forbidden = isForbiddenUnit(kind, u);
      const prot = !forbidden && isProtectedUnit(kind, u);
      const status = doc.image.unitStatus[u];
      const denied = status === 'denied' || status === 'unread' || status === 'error';
      const rkey = regionKey(kind, u);
      const unitStart = bi % unitSize === 0 && bi !== rowStart;
      const sel = bi >= lo && bi <= hi;
      const isCursor = bi === cursor;
      const b = data[bi];
      const st = struct[bi];
      const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      hexCells.push(
        <span
          key={bi}
          ref={isCursor ? cursorRef : undefined}
          className={cx(
            'hx-cell',
            `region-${rkey}`,
            forbidden && 'forbidden',
            prot && 'protected',
            denied && 'denied',
            changed[bi] && 'changed',
            sel && 'sel',
            isCursor && 'cursor',
            st?.boundary && 'hx-bound',
            st?.inNdef && 'hx-ndef',
            st?.terminator && 'hx-term',
            unitStart && 'hx-unitstart',
          )}
          title={st?.label ?? rowTitle}
          onMouseDown={(e) => onCellDown(bi, e)}
        >
          {toHex2(b)}
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
        <span className="hx-addr" title={rowTitle}>
          {anyForbidden ? (
            <span className="hx-lock hx-lock-forbidden">
              <Lock size={12} aria-hidden />
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

  return (
    <Page>
      <PageHeader
        title={t('hex.title')}
        subtitle={sourceLabel}
        helpTopic="hex"
        actions={
          <>
            <IconButton icon={Undo2} label={t('hex.undo')} onClick={undo} disabled={!canUndo} />
            <IconButton icon={Redo2} label={t('hex.redo')} onClick={redo} disabled={!canRedo} />
            <Button icon={RefreshCw} onClick={() => void readCurrentTag()}>
              {t('hex.reread')}
            </Button>
            <Button icon={Upload} variant="primary" onClick={() => void onWrite()}>
              {t('hex.write')}
            </Button>
          </>
        }
      />

      <Callout tone="info" title={t('tag.uid')}>
        {t('hex.uidNote')}
      </Callout>

      {/* Increment toolbar - prominent, used heavily in the field for serial numbers. */}
      <div className="hx-inc">
        <div className="hx-inc-head">
          <Hash size={16} aria-hidden />
          {t('hex.inc.title')}
        </div>
        <div className="small muted">{t('hex.inc.hint')}</div>
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
        </div>
        {selForbidden ? (
          <div className="small hx-danger">{t('hex.inc.forbidden')}</div>
        ) : (
          <div className="hx-inc-row">
            <Button icon={Minus} onClick={() => incBy(-1n)}>
              {t('hex.inc.minus')}
            </Button>
            <Button icon={Plus} onClick={() => incBy(1n)}>
              {t('hex.inc.plus')}
            </Button>
            <label className="hx-inline-label">
              {t('hex.inc.step')}
              <span className="row">
                <TextInput mono value={stepText} onChange={(e) => setStepText(e.target.value)} />
                <Button size="sm" onClick={addStep}>
                  {t('hex.inc.add')}
                </Button>
              </span>
            </label>
            <label className="hx-inline-label">
              {t('hex.inc.setTo')}
              <span className="row">
                <TextInput mono value={setValueText} onChange={(e) => setSetValueText(e.target.value)} placeholder="0x…" />
                <Button size="sm" onClick={setVal}>
                  {t('hex.inc.set')}
                </Button>
              </span>
            </label>
          </div>
        )}
      </div>

      {/* Editing toolbar */}
      <div className="hx-toolbar">
        <label className="hx-inline-label">
          {t('hex.editMode')}
          <Segmented
            ariaLabel={t('hex.editMode')}
            value={editMode}
            onChange={setEditMode}
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
            onChange={(v) => setBytesPerRow(Number(v))}
            options={rowByteOptions.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </label>
        <Button size="sm" icon={Copy} onClick={doCopy}>
          {t('hex.copy')}
        </Button>
        <Button size="sm" icon={ClipboardPaste} onClick={doPaste} disabled={!clip}>
          {t('hex.paste')}
        </Button>
        <span className="grow" />
        {advanced ? <Switch checked={includeProtected} onChange={setIncludeProtected} label={t('hex.write.includeProtected')} /> : null}
        <Button size="sm" icon={Eraser} onClick={() => void onInitialize()}>
          {t('hex.init.title')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRevert} disabled={changedCount === 0}>
          {t('hex.revert')}
        </Button>
      </div>

      <div className="hx-editor">
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
          <span className="hx-legend-item">
            <ShieldAlert size={13} aria-hidden /> {t('hex.protected')}
          </span>
        </div>

        <div className="hx-grid" ref={gridRef} tabIndex={0} role="grid" aria-label={t('hex.title')} onKeyDown={onKeyDown}>
          {rows}
        </div>

        <div className="hx-status">
          <span>{kindLabel(kind)}</span>
          <span>
            {t('hex.cursor')}: {unitOfByte(kind, cursor)}:{cursor % unitSize}
          </span>
          {selLen > 1 ? <span>{t('hex.selection', { n: selLen })}</span> : null}
          <span>{changedCount > 0 ? t('hex.changed', { n: changedCount }) : t('hex.clean')}</span>
        </div>
      </div>

      {/* Byte/bit inspector + data-structure (NDEF/TLV) boundaries for the current unit. */}
      <UnitInspector
        kind={kind}
        data={data}
        unit={unitOfByte(kind, cursor)}
        onGoto={(byte) => {
          const c = clamp(byte);
          setCursor(c);
          setAnchor(c);
          setPending(null);
          gridRef.current?.focus();
        }}
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
            <Button size="sm" icon={Replace} onClick={replaceAll}>
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
              <Button size="sm" onClick={() => fillWith(0x00)}>
                00
              </Button>
              <Button size="sm" onClick={() => fillWith(0xff)}>
                FF
              </Button>
            </div>
            <Field label={t('hex.fill.custom')}>
              <span className="row">
                <TextInput mono value={fillText} onChange={(e) => setFillText(e.target.value)} placeholder="00" />
                <Button size="sm" onClick={fillCustom}>
                  {t('hex.fill.apply')}
                </Button>
              </span>
            </Field>
          </div>
        </Card>
      </div>
    </Page>
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

export function HexView() {
  const doc = useAppStore((s) => s.doc);
  if (!doc) return <HexEntry />;
  const key = doc.source.type === 'file' ? `file:${doc.source.name}` : doc.source.type === 'card' ? `card:${doc.image.uid}` : 'new';
  return <HexEditor key={key} />;
}
