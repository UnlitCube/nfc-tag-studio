// NDEF view: take the NDEF of a tag (or an NDEF file / from scratch), compose the
// records, preview the bytes, write them to the tag on the reader, or hand them
// to batch issue as a template. Owner: agent "renderer-ndef".
//
// 2026-11-12 UX rework (WRITE-12 / FLOW-4 / FLOW-5 / FLOW-9 / FIRST-14 / WALK-5 / FLOW-16):
//  - When the screen is shown and the open document is a tag read, its NDEF is
//    taken over automatically (never over records the operator is editing - then
//    a callout offers it instead). "Read from tag" really reads the tag.
//  - The origin of the records is always shown (tag + time / file / new).
//  - Writing ALWAYS goes to the tag on the reader and is planned from THAT tag's
//    content, read right before writing (MIFARE: its own MAD; NTAG: its own CC).
//    The confirmation names the tag (kind + UID) and what it holds now.
//  - Zero records cannot be "written"; clearing is the separate "Erase NDEF".
//  - Disabled buttons say why (tagOpBlock + useOpBlockText). The write result
//    stays on screen (LastWriteCallout).
//  - Keep-alive (App): the records, origin and saved-file row survive switching
//    screens; nothing here re-initialises on mount.
//
// 2026-11-12 second round (E2E-UX-3/5/6, D9, D13): the erase confirmation's button
// says "erase"; one "read this tag" in the "tag to write" card (not a second one
// from TagOnReader); new text records take the display language (editor); an
// unreadable MIFARE NDEF says that "Read from tag" tries the registered keys
// (automatic reading tries only the standard keys); a write that cannot be
// planned is shown in the card, not also as a toast over the buttons.
//
// Invariant (I1): the UID is read-only. Only the NDEF data area is written.
import './ndef.css';
import { useEffect, useMemo, useState } from 'react';
import { Binary, Download, Eraser, FileCode2, FilePlus, FolderOpen, Nfc, PenLine, Send, Tag, Upload } from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, isFelica, isMifare, isNtag, specFor } from '@shared/tags';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { decodeToDrafts, encodeDrafts } from '@shared/ndef';
import type { WriteRequest } from '@shared/types';
import { FILE_FILTERS } from '@shared/api';
import { Badge, Button, Callout, Card, EmptyState, Field, KeyValue, Page, PageHeader, Select } from '../../components/ui';
import { ExitButton } from '../../components/ExitButton';
import { TagOnReader, useOpBlockText } from '../../components/TagOnReader';
import { LastWriteCallout } from '../../components/LastWriteCallout';
import { useT } from '../../i18n';
import type { TFunc } from '../../i18n';
import { isDocDirty, useAppStore } from '../../store/app';
import type { TagDoc } from '../../store/app';
import { api, errorText } from '../../lib/api';
import { readCurrentTag, readTarget, writeWithConfirm } from '../../lib/ops';
import { isCardReady, tagOpBlock } from '../../lib/readerState';
import { useViewActive } from '../../lib/viewActive';
import { beep } from '../../lib/sound';
import { fileStamp, formatUid, kindLabel } from '../../lib/format';
import { whenLabel } from '../backup/dumpMeta';
import { NdefRecordsEditor } from './NdefRecordsEditor';
import { bytesToHex, nominalCapacity, planNdefWrite, readImageNdef, supportsNdef } from './ndefPages';
import type { ImageNdef, NdefWritePlan } from './ndefPages';

/** Where the records on screen came from. */
type Origin =
  | { type: 'none' }
  /** The open document (a tag read / a dump file / a new document). */
  | {
      type: 'doc';
      source: 'card' | 'file' | 'new';
      uid: string;
      kind: TagKind;
      at: number;
      name: string | null;
      dirty: boolean;
      state: ImageNdef['state'];
      count: number;
    }
  /** An .ndef file. */
  | { type: 'file'; name: string }
  /** Started from scratch. */
  | { type: 'new' }
  /** Just written to this tag (the open document was another tag / a file and was kept). */
  | { type: 'written'; uid: string; kind: TagKind; at: number };

type Busy = null | 'read' | 'write' | 'erase' | 'file';

/**
 * Identity of one state of the open document. doc.revision alone is not enough:
 * it restarts at 1 when a document is opened after the previous one was closed.
 */
function docKey(d: TagDoc): string {
  return `${d.revision}|${d.image.readAt}|${d.image.uid}`;
}

function docLabel(t: TFunc, doc: TagDoc, lang: 'ja' | 'en'): string {
  const { image, source } = doc;
  if (source.type === 'card') {
    return t('ndef.origin.tag', { uid: formatUid(image.uid), kind: kindLabel(image.kind), when: whenLabel(image.readAt, lang) });
  }
  if (source.type === 'file') return t('ndef.origin.docFile', { name: source.name });
  return t('ndef.origin.docNew', { kind: kindLabel(image.kind) });
}

function stateLabel(t: TFunc, state: ImageNdef['state'], count: number): string {
  switch (state) {
    case 'records':
      return t('ndef.state.records', { n: count });
    case 'empty':
      return t('ndef.state.empty');
    case 'none':
      return t('ndef.state.none');
    case 'unreadable':
      return t('ndef.state.unreadable');
    case 'invalid':
      return t('ndef.state.invalid');
    case 'unsupported':
      return t('ndef.felicaTitle');
  }
}

/** Why an NDEF write cannot be planned on this tag (also used by the erase screen). */
export function planErrorText(t: TFunc, plan: Extract<NdefWritePlan, { ok: false }>): string {
  switch (plan.reason) {
    case 'unsupported-kind':
      return t('ndef.plan.unsupported');
    case 'not-formatted':
      return isNtag(plan.kind) ? t('ndef.plan.notFormattedNtag') : t('ndef.plan.notFormattedMifare');
    case 'too-large':
      return t('ndef.plan.tooLarge', { bytes: plan.messageBytes, cap: plan.capacity ?? 0 });
    case 'unreadable':
      return t('ndef.plan.unreadable');
    case 'password':
      return t('ndef.plan.password');
    case 'locked':
      return t('ndef.plan.locked');
  }
}

function existingLine(t: TFunc, existing: ImageNdef): string {
  switch (existing.state) {
    case 'records':
      return t('ndef.confirmExisting.records', { n: existing.drafts.length });
    case 'empty':
      return t('ndef.confirmExisting.empty');
    case 'none':
      return t('ndef.confirmExisting.none');
    default:
      return t('ndef.confirmExisting.invalid');
  }
}

export function NdefView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  // D15: this screen's own read result (a tag read here, or handed over by the read screen).
  const doc = useAppStore((s) => s.pageDocs.ndef);
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const setView = useAppStore((s) => s.setView);
  const handoffTo = useAppStore((s) => s.handoffTo);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);
  const setUnsavedDraft = useAppStore((s) => s.setUnsavedDraft);
  const closePageDoc = useAppStore((s) => s.closePageDoc);
  const setLastWrite = useAppStore((s) => s.setLastWrite);
  const active = useViewActive();
  const opText = useOpBlockText();

  const [records, setRecords] = useState<NdefRecordDraft[]>([]);
  const [origin, setOrigin] = useState<Origin>({ type: 'none' });
  /** The operator changed the records since they were taken over. */
  const [edited, setEdited] = useState(false);
  /** docKey() of the document the records were last taken from (the automatic take-over runs once per document state). */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<TagKind>('NTAG213');
  const [busy, setBusy] = useState<Busy>(null);
  const [lastSaved, setLastSaved] = useState<{ token: string; name: string } | null>(null);
  /** Why the last write could not be planned on this tag (kept on screen, not only a toast). */
  const [planIssue, setPlanIssue] = useState<{ uid: string; text: string } | null>(null);

  const card = isCardReady(reader) ? reader!.card! : null;
  const cardKind: TagKind | null = card?.kind ?? null;
  const block = tagOpBlock(reader, { issueRunning, busyOp });
  const locked = busy !== null;

  // ---- taking records over --------------------------------------------------

  function takeFromDoc(d: TagDoc, notify: boolean) {
    setLoadedKey(docKey(d));
    const r = readImageNdef(d.image);
    if (r.state === 'unsupported') return; // FeliCa: the callout explains; keep what is on screen
    const drafts = r.state === 'records' ? r.drafts : [];
    setRecords(drafts);
    setEdited(false);
    setNewKind(d.image.kind);
    setOrigin({
      type: 'doc',
      source: d.source.type,
      uid: d.image.uid,
      kind: d.image.kind,
      at: d.image.readAt,
      name: d.source.type === 'file' ? d.source.name : null,
      dirty: isDocDirty(d),
      state: r.state,
      count: drafts.length,
    });
    if (!notify) return;
    if (r.state === 'records') toast({ tone: 'ok', title: t('ndef.loaded', { n: drafts.length }) });
    else if (r.state === 'unreadable') toast({ tone: 'warn', title: t('ndef.loadedUnreadable') });
    else if (r.state === 'invalid') toast({ tone: 'warn', title: t('ndef.loadedInvalid') });
    else toast({ tone: 'info', title: t('ndef.loadedEmpty') });
  }

  // Automatic take-over (WRITE-12 / FIRST-14): when this screen is shown and the
  // open document is a tag read the records were not taken from yet - but never
  // over records being edited, a file or a fresh start the operator chose.
  const autoAllowed = !edited && (origin.type === 'none' || origin.type === 'doc' || origin.type === 'written');
  useEffect(() => {
    if (!active || !doc || doc.source.type !== 'card') return;
    if (loadedKey === docKey(doc) || !supportsNdef(doc.image.kind) || !autoAllowed) return;
    takeFromDoc(doc, false);
    // takeFromDoc only reads its argument and stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc, autoAllowed, loadedKey]);

  // Closing the window must not silently drop records being composed (WALK-13).
  const hasDraft = edited && records.length > 0;
  useEffect(() => {
    setUnsavedDraft('ndef', hasDraft);
  }, [hasDraft, setUnsavedDraft]);

  const docPending =
    !!doc && doc.source.type === 'card' && supportsNdef(doc.image.kind) && loadedKey !== docKey(doc) && !autoAllowed;
  const docIsOrigin = !!doc && origin.type === 'doc' && loadedKey === docKey(doc) && !edited;

  /** Ask before throwing away records the operator is editing. */
  async function okToReplace(): Promise<boolean> {
    if (!edited || records.length === 0) return true;
    return confirm({
      title: t('ndef.replace.title'),
      message: t('ndef.replace.body', { n: records.length }),
      details: [t('ndef.replace.detail')],
      confirmLabel: t('ndef.replace.ok'),
      cancelLabel: t('common.cancel'),
      tone: 'warn',
    });
  }

  function editRecords(next: NdefRecordDraft[]) {
    setRecords(next);
    setEdited(true);
  }

  async function readFromTag() {
    if (!(await okToReplace())) return;
    setBusy('read');
    try {
      const img = await readCurrentTag({}, { into: 'ndef' });
      const d = useAppStore.getState().pageDocs.ndef;
      // readCurrentTag already said "read"; the origin card shows what the NDEF holds.
      if (img && d && d.image.uid === img.uid) takeFromDoc(d, false);
    } finally {
      setBusy(null);
    }
  }

  async function takeOpenDoc() {
    const d = useAppStore.getState().pageDocs.ndef;
    if (!d || !(await okToReplace())) return;
    takeFromDoc(d, true);
  }

  async function openNdefFile() {
    setBusy('file');
    try {
      const res = await api.openFile({ title: t('ndef.openFile'), filters: [{ name: t('ndef.filter'), extensions: [...FILE_FILTERS.ndef.extensions] }] });
      if (!res) return;
      let drafts: NdefRecordDraft[];
      try {
        drafts = decodeToDrafts(res.bytes);
      } catch {
        toast({ tone: 'danger', title: t('ndef.fileFailed'), detail: t('ndef.fileFailedBody') });
        return;
      }
      if (!(await okToReplace())) return;
      setRecords(drafts);
      setEdited(false);
      setOrigin({ type: 'file', name: res.name });
      toast({ tone: 'ok', title: t('ndef.fileLoaded', { name: res.name }) });
    } catch (e) {
      toastError(e, t('ndef.fileFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function startNew() {
    if (!(await okToReplace())) return;
    setRecords([]);
    setEdited(false);
    setOrigin({ type: 'new' });
  }

  async function saveNdefFile() {
    let bytes: Uint8Array;
    try {
      bytes = encodeDrafts(records);
    } catch (e) {
      toastError(e, t('ndef.encodeFailed'));
      return;
    }
    setBusy('file');
    try {
      const res = await api.saveFile({
        title: t('ndef.saveFile'),
        defaultName: `ndef-${fileStamp()}.ndef`,
        filters: [{ name: t('ndef.filter'), extensions: [...FILE_FILTERS.ndef.extensions] }],
        bytes,
      });
      if (res) {
        setLastSaved({ token: res.token, name: res.name });
        // The records are kept in that file now: not "unsaved", and not replaced by an automatic take-over.
        setOrigin({ type: 'file', name: res.name });
        setEdited(false);
        toast({ tone: 'ok', title: t('ndef.saved'), detail: t('ndef.savedAs', { name: res.name }) });
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  /**
   * D14: back to the start of this screen (the entry). Asks before dropping records
   * being composed. When the records came from the open document (a tag read) that
   * document is closed too - "back to before reading" - unless it holds unsaved
   * binary edits (they belong to the binary editor and stay). The same placement
   * is not read again automatically (autoRead: one read per placement), and
   * loadedKey keeps the closed / kept document from being taken over again.
   */
  async function exitEditor() {
    if (locked) return;
    if (edited && records.length > 0) {
      const ok = await confirm({
        title: t('ndef.exit.title'),
        message: t('ndef.exit.body', { n: records.length }),
        confirmLabel: t('ndef.exit.ok'),
        cancelLabel: t('ndef.exit.keep'),
        tone: 'warn',
      });
      if (!ok) return;
    }
    // The tag read on this screen goes too ("back to before reading"). Other screens keep theirs (D15).
    if (useAppStore.getState().pageDocs.ndef) closePageDoc('ndef');
    setRecords([]);
    setEdited(false);
    setOrigin({ type: 'none' });
    setPlanIssue(null);
    setLastSaved(null);
    // Only this screen's own write result (D15: another screen's stays there).
    if (useAppStore.getState().lastWrite?.view === 'ndef') setLastWrite(null);
  }

  function sendToIssue() {
    if (records.length === 0) {
      toast({ tone: 'info', title: t('ndef.nothingToSend') });
      return;
    }
    handoffTo('issue', { kind: 'issue-ndef', records });
  }

  // ---- writing -------------------------------------------------------------

  const preview = useMemo(() => {
    try {
      const msg = encodeDrafts(records);
      return { hex: bytesToHex(msg), len: msg.length, error: null as string | null };
    } catch (e) {
      return { hex: '', len: 0, error: errorText(e).message };
    }
  }, [records]);

  // Capacity: the tag on the reader when there is one (the write follows it), else the operator's pick.
  const capacityKind: TagKind = cardKind && supportsNdef(cardKind) ? cardKind : newKind;
  const cardCap = cardKind ? nominalCapacity(cardKind) : null;
  const overBy = cardCap !== null && !preview.error && preview.len > cardCap ? preview.len - cardCap : 0;
  const cardIsFelica = !!cardKind && isFelica(cardKind);

  const originUid =
    origin.type === 'doc' && origin.source !== 'new' ? origin.uid : origin.type === 'written' ? origin.uid : null;
  const otherTag = !!card && !!originUid && card.uid.toUpperCase() !== originUid.toUpperCase();

  const writeWhy: string | null = block
    ? opText(block)
    : cardIsFelica
      ? t('ndef.target.felica')
      : preview.error
        ? t('ndef.why.encode')
        : records.length === 0
          ? t('ndef.why.noRecords')
          : overBy > 0
            ? t('ndef.why.tooLarge', { kind: kindLabel(cardKind), over: overBy })
            : null;
  const eraseWhy: string | null = block ? opText(block) : cardIsFelica ? t('ndef.target.felica') : null;
  const readWhy: string | null = block ? opText(block) : null;

  async function writeToTag(erase: boolean) {
    let message: Uint8Array;
    try {
      message = encodeDrafts(erase ? [] : records);
    } catch (e) {
      toastError(e, t('ndef.encodeFailed'));
      return;
    }
    setPlanIssue(null);
    // After writing, writeWithConfirm reads the tag again and opens it as the
    // document when that loses nothing (unwritten binary edits stay pending).
    setBusy(erase ? 'erase' : 'write');
    try {
      // D5 / FLOW-5: plan from the tag that is actually on the reader.
      const target = await readTarget({});
      if (!target) return;
      const plan = planNdefWrite(target, message);
      if (!plan.ok) {
        // Shown in the "tag to write" card right above the buttons (stays); no toast
        // over the buttons as well (D13).
        setPlanIssue({ uid: target.uid, text: planErrorText(t, plan) });
        beep('error');
        return;
      }
      if (plan.writes.length === 0) {
        toast({ tone: 'info', title: t('ndef.plan.same') });
        return;
      }
      const uid = formatUid(target.uid);
      const kind = kindLabel(target.kind);
      const details: string[] = [];
      if (!erase) details.push(t('ndef.confirmRecords', { n: records.length, bytes: message.length }));
      details.push(existingLine(t, plan.existing));
      details.push(t(specFor(target.kind).unit === 'page' ? 'ndef.confirmPages' : 'ndef.confirmBlocks', { n: plan.writes.length }));
      const other = !!originUid && originUid.toUpperCase() !== target.uid.toUpperCase();
      const req: WriteRequest = {
        kind: target.kind,
        expectedUid: target.uid,
        writes: plan.writes,
        allowProtected: false,
        verify: true,
      };
      const res = await writeWithConfirm(req, {
        title: erase ? t('ndef.eraseTitle') : t('ndef.confirmTitle'),
        message: erase ? t('ndef.eraseMessage', { uid, kind }) : t('ndef.confirmMessage', { uid, kind }),
        // E2E-UX-5: the button of the erase confirmation says "erase", not "write to tag".
        confirmLabel: erase ? t('ndef.eraseConfirm') : undefined,
        details,
        dangerous: erase,
        target: { kind: target.kind, uid: target.uid, other },
        // NDEF records, not a copy of the open document: it is never replaced by another tag for this (R-WRITE-1).
        docCopy: false,
        // D15: this screen's own read result words the confirmation; the binary editor's document is never touched.
        doc: 'ndef',
        refresh: false,
        // These are NDEF pages, not edits of the open document: nothing to keep pending.
        keepUnitsOnFailure: [],
        successTitle: erase ? t('ndef.erased') : t('ndef.written'),
      });
      const fullyOk =
        !!res && res.failed.length === 0 && !res.aborted && res.mismatched.length === 0 && res.verified !== false;
      if (!fullyOk) return;
      // The records on screen are now what this tag holds (erasing: none - unless records were being composed).
      if (erase) {
        if (edited) return;
        setRecords([]);
      }
      setOrigin({ type: 'written', uid: target.uid, kind: target.kind, at: Date.now() });
      setEdited(false);
    } finally {
      setBusy(null);
    }
  }

  // ---- render --------------------------------------------------------------

  const docIsFelica = !!doc && isFelica(doc.image.kind);
  const showPlanIssue = !!planIssue && (!card || card.uid === planIssue.uid);

  const originText =
    origin.type === 'doc'
      ? origin.source === 'card'
        ? t('ndef.origin.tag', { uid: formatUid(origin.uid), kind: kindLabel(origin.kind), when: whenLabel(origin.at, lang) })
        : origin.source === 'file'
          ? t('ndef.origin.docFile', { name: origin.name ?? '' })
          : t('ndef.origin.docNew', { kind: kindLabel(origin.kind) })
      : origin.type === 'file'
        ? t('ndef.origin.file', { name: origin.name })
        : origin.type === 'new'
          ? t('ndef.origin.new')
          : origin.type === 'written'
            ? t('ndef.origin.written', { uid: formatUid(origin.uid), kind: kindLabel(origin.kind), when: whenLabel(origin.at, lang) })
            : t('ndef.origin.none');

  return (
    <Page>
      {/* R-UX-9: no screen-changing button at the top of the page; "use for batch
          issuing" lives with the records it hands over (records card below). */}
      <PageHeader title={t('ndef.title')} subtitle={t('ndef.subtitle')} helpTopic="ndef" />

      <Callout tone="info" icon={Nfc}>
        {t('ndef.uidNote')}
      </Callout>

      {origin.type === 'none' ? (
        <Card>
          <div data-testid="ndef-entry">
            <EmptyState icon={FileCode2} title={t('ndef.entry.title')}>
              <p className="muted">{t('ndef.entry.body')}</p>
              <div className="stack ndef-entry">
                {/* This screen has its own "read" button right below: not a second one. */}
                <TagOnReader readThis={false} />
                {docIsFelica ? (
                  <Callout tone="warn" title={t('ndef.felicaTitle')}>
                    <div>{t('ndef.felicaBody')}</div>
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <Button size="sm" icon={Binary} onClick={() => setView('hex')}>
                        {t('ndef.openHex')}
                      </Button>
                    </div>
                  </Callout>
                ) : null}
                <div className="row">
                  <Button
                    variant="primary"
                    icon={Nfc}
                    loading={busy === 'read'}
                    disabled={!!readWhy || locked}
                    onClick={() => void readFromTag()}
                    data-testid="ndef-read-tag"
                  >
                    {t('ndef.readTag')}
                  </Button>
                  {doc && supportsNdef(doc.image.kind) ? (
                    <Button icon={Download} disabled={locked} onClick={() => void takeOpenDoc()} data-testid="ndef-import-doc">
                      {t('ndef.importDoc')}
                    </Button>
                  ) : null}
                  <Button icon={Upload} loading={busy === 'file'} disabled={locked} onClick={() => void openNdefFile()}>
                    {t('ndef.openFile')}
                  </Button>
                  <Button icon={FilePlus} disabled={locked} onClick={() => void startNew()} data-testid="ndef-start-new">
                    {t('ndef.startNew')}
                  </Button>
                </div>
                {readWhy ? <div className="muted small">{readWhy}</div> : null}
                <div className="muted small">{t('ndef.origin.hint')}</div>
              </div>
            </EmptyState>
          </div>
        </Card>
      ) : (
        <>
        <Card title={t('ndef.origin.title')} icon={Tag}>
          <div className="stack">
            <KeyValue
              items={[
                [
                  t('ndef.origin.label'),
                  <span key="o" data-testid="ndef-origin">
                    {originText} {edited ? <Badge tone="warn">{t('ndef.origin.edited')}</Badge> : null}
                  </span>,
                ],
                ...(origin.type === 'doc'
                  ? ([[t('ndef.origin.contents'), stateLabel(t, origin.state, origin.count)]] as [string, string][])
                  : []),
              ]}
            />
            {origin.type === 'doc' && origin.dirty ? <div className="muted small">{t('ndef.origin.docDirty')}</div> : null}
            {/* D9: automatic reading tries only the standard keys; "Read from tag" tries the registered ones too. */}
            {origin.type === 'doc' && origin.state === 'unreadable' && isMifare(origin.kind) && !!doc && loadedKey === docKey(doc) && doc.standardKeysOnly ? (
              <div className="muted small" data-testid="ndef-mifare-keys-hint">
                {t('ndef.origin.mifareKeysHint')}
              </div>
            ) : null}

            {docPending && doc ? (
              <Callout tone="info" title={t('ndef.pending.title')}>
                <div>{t('ndef.pending.body', { what: docLabel(t, doc, lang) })}</div>
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Button size="sm" icon={Download} onClick={() => void takeOpenDoc()} disabled={locked}>
                    {t('ndef.pending.action')}
                  </Button>
                </div>
              </Callout>
            ) : null}

            {docIsFelica ? (
              <Callout tone="warn" title={t('ndef.felicaTitle')}>
                <div>{t('ndef.felicaBody')}</div>
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Button size="sm" icon={Binary} onClick={() => setView('hex')}>
                    {t('ndef.openHex')}
                  </Button>
                </div>
              </Callout>
            ) : null}

            <div className="row">
              <Button
                variant={records.length === 0 ? 'primary' : 'secondary'}
                icon={Nfc}
                loading={busy === 'read'}
                disabled={!!readWhy || locked}
                onClick={() => void readFromTag()}
                data-testid="ndef-read-tag"
              >
                {t('ndef.readTag')}
              </Button>
              {doc && supportsNdef(doc.image.kind) && !docIsOrigin && !docPending ? (
                <Button icon={Download} disabled={locked} onClick={() => void takeOpenDoc()}>
                  {t('ndef.importDoc')}
                </Button>
              ) : null}
              <Button icon={Upload} loading={busy === 'file'} disabled={locked} onClick={() => void openNdefFile()}>
                {t('ndef.openFile')}
              </Button>
              <Button icon={FilePlus} disabled={locked} onClick={() => void startNew()}>
                {t('ndef.startNew')}
              </Button>
            </div>
            {readWhy ? <div className="muted small">{readWhy}</div> : null}
            <div className="muted small">{t('ndef.origin.hint')}</div>
          </div>
        </Card>

        <Card
          title={t('ndef.records')}
          actions={
            <div className="row">
              <Badge tone="accent">{t('ndef.recordsCount', { n: records.length })}</Badge>
              <Button size="sm" icon={Download} disabled={records.length === 0 || !!preview.error || locked} onClick={() => void saveNdefFile()}>
                {t('ndef.saveFile')}
              </Button>
              <Button size="sm" icon={Send} onClick={sendToIssue} disabled={records.length === 0 || locked}>
                {t('ndef.sendToIssue')}
              </Button>
            </div>
          }
        >
          <div className="stack">
            {lastSaved ? (
              <div className="row">
                <span className="muted small">{t('ndef.savedAs', { name: lastSaved.name })}</span>
                <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => api.revealFile(lastSaved.token).catch(toastError)}>
                  {t('ndef.reveal')}
                </Button>
              </div>
            ) : null}
            <NdefRecordsEditor records={records} onChange={editRecords} capacityKind={capacityKind} readOnly={locked} />
            {cardKind && supportsNdef(cardKind) ? (
              <div className="muted small">{t('ndef.capacityFromCard', { kind: kindLabel(cardKind) })}</div>
            ) : (
              <Field label={t('ndef.capacityKind')} hint={t('ndef.capacityKindHint')}>
                <Select<TagKind>
                  value={newKind}
                  onChange={setNewKind}
                  options={TAG_KINDS.filter((k) => supportsNdef(k)).map((k) => ({ value: k, label: kindLabel(k) }))}
                />
              </Field>
            )}
          </div>
        </Card>

        <Card title={t('ndef.preview')}>
          <div className="stack">
            <div className="muted small">{t('ndef.previewHint')}</div>
            {preview.error ? (
              <Callout tone="warn">{t('ndef.previewError')}</Callout>
            ) : (
              <>
                <div>
                  <Badge tone="accent">{t('ndef.messageBytes', { n: preview.len })}</Badge>
                </div>
                <pre className="ndef-preview">{preview.hex}</pre>
              </>
            )}
          </div>
        </Card>

        <Card title={t('ndef.target.title')} icon={PenLine}>
          <div className="stack">
            <div className="muted">{t('ndef.target.body')}</div>
            {/* This card has its own "read this tag" (below, asks before replacing edited records): not a second one. */}
            <TagOnReader compact readThis={false} />
            {otherTag && card && originUid ? (
              <Callout tone="info">
                <div>{t('ndef.target.other', { a: formatUid(originUid), b: formatUid(card.uid) })}</div>
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Button size="sm" icon={Nfc} disabled={!!readWhy || locked} onClick={() => void readFromTag()}>
                    {t('ndef.target.readThis')}
                  </Button>
                </div>
              </Callout>
            ) : null}
            {cardIsFelica ? <Callout tone="warn">{t('ndef.target.felica')}</Callout> : null}
            {showPlanIssue && planIssue ? (
              <Callout tone="warn" title={t('ndef.plan.title')}>
                {planIssue.text}
              </Callout>
            ) : null}
            <LastWriteCallout />
            <div className="ndef-actions">
              <Button
                icon={Eraser}
                loading={busy === 'erase'}
                disabled={!!eraseWhy || locked}
                onClick={() => void writeToTag(true)}
                data-testid="ndef-erase"
              >
                {t('ndef.erase')}
              </Button>
              <span className="grow" />
              {/* D14: back to the start, right next to the main action on every tag screen. */}
              <ExitButton dirty={hasDraft} disabled={locked} onExit={() => void exitEditor()} testId="ndef-exit" />
              <Button
                icon={PenLine}
                variant="primary"
                loading={busy === 'write'}
                disabled={!!writeWhy || locked}
                onClick={() => void writeToTag(false)}
                data-testid="ndef-write"
              >
                {t('ndef.writeToTag')}
              </Button>
            </div>
            {writeWhy ? (
              <div className="muted small ndef-why" data-testid="ndef-write-why">
                {writeWhy}
              </div>
            ) : null}
          </div>
        </Card>
        </>
      )}
    </Page>
  );
}
