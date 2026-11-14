// Backup / restore / duplicate view. Owner: agent renderer-backup.
//
// Reads as three cards, top to bottom (no step numbers - business-app-ux):
//   "Backup source"  - this screen's own document (D15): read a tag / open a file
//   "Save to a file" - write the source to .nfcdump / .bin / .nfc
//   "Write to a tag" - read the tag to write, then restore (same UID) or duplicate
//                      (another tag; only the data area, never the UID - I1/I2)
//
// 2026-11-12 UX rework (WRITE-9 / FLOW-3 / FLOW-14 / FLOW-15 / FLOW-16 / WRITE-11 /
// WALK-10 / CARD-4):
//  - A backup can be put back on the SAME tag ("restore"); before, same UID was refused.
//  - "Read tag" for the source asks before turning the tag on the reader (likely
//    the tag to write) into the source.
//  - Reading the tag to write gives the same toast + sound as any read.
//  - The write is planned from the tag to write, read again right before writing,
//    and only differing data units are written (D5).
//  - Unreadable (error / denied) units are warned before saving.
//  - An opened .nfcdump keeps its note and save time (shown; saved again).
//  - Results: the file name + "Show in folder"; write results stay on screen
//    (LastWriteCallout); open failures are localized.
//  - Keep-alive (App): the target, note and last saved file survive switching
//    screens; nothing here is re-initialised on mount.
//
// 2026-11-12 second round (R-UX-3 / R-WRITE-3 / R-UX-4 / E2E-UX-2/4/7):
//  - A saved file never holds key A / a password (encodeDump clears them); when
//    something was cleared, the saved result says so.
//  - "Open file" is locked while ANY single-tag operation runs (store.busyOp, not
//    only this screen's own) or batch issue runs, and checks again after the file
//    dialog: replacing the document mid-write mixed two documents.
//  - "Saved, but the document changed since" compares contents, so opening the
//    file just saved does not claim it changed.
//  - MIFARE sectors left unread: automatic reading tries only the standard keys
//    (D9); the warning points at "Read tag", which tries the registered keys too.
//  - The confirmation's button says what it does (restore / copy); the "busy"
//    reason is not shown behind an open confirmation; no toast for a save (the
//    saved result stays on screen).
//
// 2026-11-14 D15 (each screen keeps its own document): the source is
// store.pageDocs.backup - read here, opened from a file here, or copied from the
// home screen ("Open in backup"). It is never edited here, and the binary editor's
// document (with its edits) is neither read nor replaced. Edits are saved from the
// binary editor ("Save to file"), so the "as read / as edited" choice is gone.
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Copy, Download, FolderOpen, Lock, Nfc, RotateCcw, Save, ShieldCheck, Tag } from 'lucide-react';
import { Badge, Button, Callout, Card, EmptyState, Field, KeyValue, Page, PageHeader, TextInput } from '../../components/ui';
import { ExitButton } from '../../components/ExitButton';
import { TagOnReader, useOpBlockText } from '../../components/TagOnReader';
import { LastWriteCallout } from '../../components/LastWriteCallout';
import { useAppStore } from '../../store/app';
import type { TagDoc } from '../../store/app';
import { api } from '../../lib/api';
import { readCurrentTag, readTarget, writeWithConfirm } from '../../lib/ops';
import { isCardReady, isCardUid, tagOpBlock } from '../../lib/readerState';
import { beep } from '../../lib/sound';
import { fileStamp, formatDateTime, formatUid, kindLabel } from '../../lib/format';
import { useT } from '../../i18n';
import type { TFunc } from '../../i18n';
import { detectDumpFormat, importDump } from '@shared/tag';
import type { TagKind } from '@shared/tags';
import { isMifare, specFor } from '@shared/tags';
import type { TagImage, WriteRequest } from '@shared/types';
import { planRestore } from './duplicate';
import { readDumpMeta, unitStatusCounts, whenLabel } from './dumpMeta';
import { dumpFileName, encodeDump, matchesSaved, savedSnapshot } from './saveDump';
import { dumpOpenFilters, localDumpFilter } from '../../lib/fileFilters';
import type { SaveFormat, SavedSnapshot } from './saveDump';

type BusyKind = null | 'read' | 'open' | 'save' | 'target' | 'write';

function countText(t: TFunc, kind: TagKind, n: number): string {
  return t(specFor(kind).unit === 'page' ? 'backup.n.pages' : 'backup.n.blocks', { n });
}

function sourceLabelOf(t: TFunc, doc: TagDoc, lang: 'ja' | 'en'): string {
  if (doc.source.type === 'card') {
    return t('backup.source.fromCard', { uid: formatUid(doc.image.uid), when: whenLabel(doc.image.readAt, lang) });
  }
  if (doc.source.type === 'file') return t('backup.source.fromFile', { name: doc.source.name });
  return t('backup.source.fromNew');
}

/**
 * Warnings for units of `img` that could not be read (CARD-4: an interrupted read is
 * not "protected"). `standardKeysOnly`: a MIFARE document from the automatic read,
 * which tries only the standard keys (D9) - say that "Read tag" tries the registered
 * keys too.
 */
function UnreadWarnings({ img, t, standardKeysOnly = false }: { img: TagImage; t: TFunc; standardKeysOnly?: boolean }) {
  const c = unitStatusCounts(img);
  const deniedText = standardKeysOnly && isMifare(img.kind) ? 'backup.warn.deniedMifare' : 'backup.warn.denied';
  return (
    <>
      {c.error > 0 ? <Callout tone="warn">{t('backup.warn.error', { count: countText(t, img.kind, c.error) })}</Callout> : null}
      {c.denied + c.unread > 0 ? (
        <Callout tone="info">{t(deniedText, { count: countText(t, img.kind, c.denied + c.unread) })}</Callout>
      ) : null}
    </>
  );
}

export function BackupView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  /** D15: this screen's own document (never the binary editor's). */
  const doc = useAppStore((s) => s.pageDocs.backup);
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const openPageDoc = useAppStore((s) => s.openPageDoc);
  const closePageDoc = useAppStore((s) => s.closePageDoc);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const handoffTo = useAppStore((s) => s.handoffTo);
  const confirm = useAppStore((s) => s.confirm);
  /** A confirmation is open: the "busy" reason behind it would be premature (E2E-UX-4). */
  const dialogOpen = useAppStore((s) => s.dialogs.length > 0);
  const opText = useOpBlockText();

  const [appVersion, setAppVersion] = useState('');
  const [note, setNote] = useState('');
  /** The .nfcdump this view opened (its note and save time are shown while it is the open document). */
  const [opened, setOpened] = useState<{ token: string; name: string; note: string; savedAt: string | null } | null>(null);
  const [target, setTarget] = useState<TagImage | null>(null);
  /** The last file saved here: what went into it (to tell whether the document still is that) and how many units were cleared (keys). */
  const [lastSaved, setLastSaved] = useState<{ token: string; name: string; at: number; snap: SavedSnapshot; kind: TagKind; redacted: number } | null>(
    null,
  );
  const [busy, setBusy] = useState<BusyKind>(null);

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

  const block = tagOpBlock(reader, { issueRunning, busyOp });
  const locked = busy !== null;
  // R-WRITE-3: opening a file replaces the document. Not while another screen's
  // read / write (store.busyOp) or batch issue runs - that mixed two documents.
  const openLocked = locked || busyOp !== null || issueRunning;
  const card = isCardReady(reader) ? reader!.card! : null;
  const openedMeta = doc && doc.source.type === 'file' && opened && doc.source.token === opened.token ? opened : null;
  const sourceLabel = doc ? sourceLabelOf(t, doc, lang) : '';
  const plan = useMemo(() => (doc && target ? planRestore(doc.image, target) : null), [doc, target]);
  const targetOnReader = !!target && isCardUid(reader, target.uid);
  // E2E-UX-7: by content - the file just saved, opened again, is not "changed".
  const savedChanged = useMemo(
    () => (lastSaved && doc ? !matchesSaved(lastSaved.snap, [doc.image, doc.original]) : false),
    [lastSaved, doc],
  );

  /** Another single-tag operation / batch issue started while a dialog was open: do not replace the document. */
  function openInterrupted(): boolean {
    const st = useAppStore.getState();
    if (st.busyOp === null && !st.issue.running) return false;
    toast({ tone: 'warn', title: t('backup.open.busy') });
    return true;
  }

  // ---- source --------------------------------------------------------------

  async function handleReadSource() {
    // FLOW-14: the tag on the reader is often the tag to WRITE. Do not silently
    // turn it into the backup source.
    if (doc && card && card.uid.toUpperCase() !== doc.image.uid.toUpperCase()) {
      const uid = formatUid(card.uid);
      const ok = await confirm({
        title: t('backup.reread.title'),
        message: t('backup.reread.body', { src: sourceLabel, uid }),
        details: [t('backup.reread.detail', { uid })],
        confirmLabel: t('backup.reread.ok'),
        cancelLabel: t('common.cancel'),
        tone: 'warn',
      });
      if (!ok) return;
    }
    setBusy('read');
    try {
      const img = await readCurrentTag({}, { into: 'backup' });
      // The new source cannot also be the tag to write.
      if (img && target && target.uid.toUpperCase() === img.uid.toUpperCase()) setTarget(null);
    } finally {
      setBusy(null);
    }
  }

  async function handleOpen() {
    if (openInterrupted()) return;
    setBusy('open');
    try {
      const file = await api.openFile({
        title: t('backup.open.button'),
        filters: dumpOpenFilters(t),
      });
      if (!file) return;
      // The file dialog is not modal for the rest of the app: a write may have started meanwhile.
      if (openInterrupted()) return;
      const format = detectDumpFormat(file.name, file.bytes);
      if (!format) {
        toast({ tone: 'danger', title: t('backup.openFailed'), detail: t('backup.openFailed.format') });
        beep('error');
        return;
      }
      let imported: ReturnType<typeof importDump>;
      try {
        imported = importDump(file.name, file.bytes);
      } catch {
        toast({ tone: 'danger', title: t('backup.openFailed'), detail: t('backup.openFailed.broken') });
        beep('error');
        return;
      }
      // D15: replaces only this screen's source (never edited here: nothing to lose).
      openPageDoc('backup', imported.image, { type: 'file', name: file.name, token: file.token, format });
      const meta = format === 'project' ? readDumpMeta(file.bytes) : null;
      setOpened({ token: file.token, name: file.name, note: imported.note, savedAt: meta?.savedAt ?? null });
      // FLOW-15: keep the note of the backup (saving again keeps it).
      setNote(imported.note);
      toast({
        tone: 'ok',
        title: t('backup.opened'),
        detail: imported.note ? t('backup.openedNote', { name: file.name, note: imported.note }) : file.name,
      });
    } catch (err) {
      toastError(err, t('backup.openFailed'));
    } finally {
      setBusy(null);
    }
  }

  /**
   * D14: back to the start of this screen (no backup source). Closes this screen's
   * document (D15: never edited here, so nothing to ask) and forgets the tag read as
   * the write target and the saved / opened file shown here.
   */
  function handleExit() {
    if (locked) return;
    closePageDoc('backup');
    setTarget(null);
    setOpened(null);
    setNote('');
    setLastSaved(null);
  }

  // ---- save ------------------------------------------------------------------

  const saveImage: TagImage | null = doc ? doc.image : null;

  async function handleSave(format: SaveFormat) {
    if (!doc || !saveImage) return;
    const img = saveImage;
    setBusy('save');
    try {
      // R-UX-3: encodeDump clears key A / passwords; `redacted` = units that held some.
      const { bytes, filter, ext, redacted } = encodeDump(img, format, {
        note,
        appVersion: appVersion || '0.0.0',
        savedAt: new Date().toISOString(),
      });
      const res = await api.saveFile({ title: t('backup.save.title'), defaultName: dumpFileName(img, ext, fileStamp()), filters: [localDumpFilter(t, filter)], bytes });
      if (res) {
        // No toast: the saved result (file name + "Show in folder") stays in this card (D13 / E2E-UX-2).
        setLastSaved({ token: res.token, name: res.name, at: Date.now(), snap: savedSnapshot(img), kind: img.kind, redacted: redacted.length });
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  // ---- write to a tag -------------------------------------------------------

  async function handleReadTarget() {
    setBusy('target');
    try {
      const img = await readTarget({});
      if (img) {
        setTarget(img);
        toast({ tone: 'ok', title: t('backup.target.readOk'), detail: `${kindLabel(img.kind)} · ${formatUid(img.uid)}` });
        beep('tap');
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleWrite() {
    if (!doc || !target) return;
    setBusy('write');
    try {
      // D5: plan from what the tag holds right now.
      const fresh = await readTarget({});
      if (!fresh) return;
      setTarget(fresh);
      if (fresh.uid.toUpperCase() !== target.uid.toUpperCase()) {
        toast({ tone: 'warn', title: t('backup.target.changed', { uid: formatUid(fresh.uid) }) });
        return;
      }
      const p = planRestore(doc.image, fresh);
      if (p.kindMismatch) {
        toast({ tone: 'warn', title: t('backup.why.kind') });
        return;
      }
      if (p.writes.length === 0) {
        toast({ tone: 'info', title: t('backup.plan.same') });
        return;
      }
      const restore = p.mode === 'restore';
      const kind = fresh.kind;
      const uid = formatUid(fresh.uid);
      const details = [t('backup.write.detailCount', { count: countText(t, kind, p.writes.length) })];
      if (p.unchanged.length > 0) details.push(t('backup.write.detailUnchanged', { count: countText(t, kind, p.unchanged.length) }));
      if (p.sourceUnread.length > 0) details.push(t('backup.plan.sourceUnread', { count: countText(t, kind, p.sourceUnread.length) }));
      if (p.targetUnread.length > 0) details.push(t('backup.plan.targetUnread', { count: countText(t, kind, p.targetUnread.length) }));
      const req: WriteRequest = { kind, expectedUid: fresh.uid, writes: p.writes, allowProtected: false, verify: true };
      const res = await writeWithConfirm(req, {
        title: restore ? t('backup.restore.confirmTitle') : t('backup.dup.confirmTitle'),
        message: restore ? t('backup.restore.confirmBody', { uid, src: sourceLabel }) : t('backup.dup.confirmBody', { uid, src: sourceLabel }),
        // The button in the confirmation says what it does (the same words as the button pressed).
        confirmLabel: restore ? t('backup.restore.button') : t('backup.dup.button'),
        details,
        target: { kind, uid: fresh.uid, other: !restore },
        // D15: this screen's source words the confirmation ("copy of tag X" / "from the file");
        // it stays the source (the next tag is written from it too) and the binary editor's
        // document is never touched.
        doc: 'backup',
        docCopy: true,
        refresh: false,
        keepUnitsOnFailure: [],
        successTitle: restore ? t('backup.restore.done') : t('backup.dup.done'),
      });
      if (!res) return;
      try {
        setTarget(await api.readTag({}));
      } catch {
        /* the write result is already on screen */
      }
    } finally {
      setBusy(null);
    }
  }

  const writeWhy: string | null = !target
    ? t('backup.why.noTarget')
    : block
      ? opText(block)
      : !targetOnReader
        ? t('backup.why.stale')
        : plan?.kindMismatch
          ? t('backup.why.kind')
          : plan && plan.writes.length === 0
            ? t('backup.why.same')
            : null;
  const readWhy: string | null = block ? opText(block) : null;
  /** The reasons as shown: "busy" is not shown behind an open confirmation (nothing runs until it is confirmed). */
  const hideBusy = dialogOpen && block === 'busy';
  const readWhyText = hideBusy ? null : readWhy;
  const writeWhyText = hideBusy && writeWhy === readWhy ? null : writeWhy;

  // ---- render ----------------------------------------------------------------

  return (
    <Page>
      <PageHeader title={t('backup.title')} subtitle={t('backup.subtitle')} helpTopic="backup" />

      <div className="stack-lg">
        {/* Permanent read-only-UID notice (I1/I2). */}
        <Callout tone="warn" icon={Lock} title={t('backup.uidReadonlyTitle')}>
          {t('backup.uidReadonlyBody')}
        </Callout>

        {!doc ? (
          <Card>
            <EmptyState
              icon={Tag}
              title={t('backup.noDoc.title')}
              action={
                <div className="stack">
                  <div className="row">
                    <Button variant="primary" icon={Nfc} loading={busy === 'read'} disabled={!!readWhy || locked} onClick={() => void handleReadSource()}>
                      {t('backup.read')}
                    </Button>
                    <Button icon={FolderOpen} loading={busy === 'open'} disabled={openLocked} onClick={() => void handleOpen()} data-testid="backup-open">
                      {t('backup.open.button')}
                    </Button>
                  </div>
                  <TagOnReader compact readThis={false} />
                  {readWhyText ? <div className="muted small">{readWhyText}</div> : null}
                </div>
              }
            >
              <div>{t('backup.noDoc.body')}</div>
              <div className="muted small">{t('backup.placeHint')}</div>
            </EmptyState>
          </Card>
        ) : (
          <>
            {/* Backup source = the open document */}
            <Card
              title={t('backup.source.title')}
              icon={Tag}
              actions={
                <div className="row">
                  <Button icon={Nfc} size="sm" loading={busy === 'read'} disabled={!!readWhy || locked} onClick={() => void handleReadSource()}>
                    {t('backup.read')}
                  </Button>
                  <Button icon={FolderOpen} size="sm" loading={busy === 'open'} disabled={openLocked} onClick={() => void handleOpen()} data-testid="backup-open">
                    {t('backup.open.button')}
                  </Button>
                </div>
              }
            >
              <div className="stack">
                <KeyValue
                  items={[
                    [t('backup.source.origin'), <span key="o" data-testid="backup-source">{sourceLabel}</span>],
                    [t('tag.uid'), <span key="uid" className="mono">{formatUid(doc.image.uid)}</span>],
                    [t('tag.kind'), kindLabel(doc.image.kind)],
                    ...(openedMeta && openedMeta.note ? ([[t('backup.source.note'), openedMeta.note]] as [string, string][]) : []),
                    ...(openedMeta && openedMeta.savedAt
                      ? ([[t('backup.source.savedAt'), formatDateTime(Date.parse(openedMeta.savedAt), lang)]] as [string, string][])
                      : []),
                  ]}
                />
                <UnreadWarnings img={doc.image} t={t} standardKeysOnly={!!doc.standardKeysOnly} />
                {readWhyText ? <div className="muted small">{readWhyText}</div> : null}
              </div>
            </Card>

            {/* Save to a file */}
            <Card title={t('backup.save.title')} icon={Save}>
              <div className="stack">
                <p className="muted">{t('backup.save.body')}</p>
                {isMifare(doc.image.kind) ? <div className="muted small">{t('backup.save.keyBNote')}</div> : null}
                {saveImage && unitStatusCounts(saveImage).ok < saveImage.unitStatus.length ? (
                  <div className="muted small">{t('backup.save.deniedFormats')}</div>
                ) : null}
                <Field label={t('backup.save.note')} htmlFor="backup-note" hint={t('backup.save.noteHint')}>
                  <TextInput
                    id="backup-note"
                    value={note}
                    placeholder={t('backup.save.notePlaceholder')}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                  />
                </Field>
                <SaveRow
                  label={t('backup.save.project')}
                  desc={t('backup.save.projectDesc')}
                  button={t('backup.save.button')}
                  busy={busy === 'save'}
                  disabled={locked}
                  onClick={() => void handleSave('project')}
                />
                <SaveRow
                  label={t('backup.save.bin')}
                  desc={t('backup.save.binDesc')}
                  button={t('backup.save.button')}
                  busy={busy === 'save'}
                  disabled={locked}
                  onClick={() => void handleSave('bin')}
                />
                <SaveRow
                  label={t('backup.save.flipper')}
                  desc={t('backup.save.flipperDesc')}
                  button={t('backup.save.button')}
                  busy={busy === 'save'}
                  disabled={locked}
                  onClick={() => void handleSave('flipper')}
                />
                {lastSaved ? (
                  <Callout tone="ok" title={t('backup.saved')}>
                    <div className="row" data-testid="backup-saved">
                      <span>{t('backup.savedAs', { name: lastSaved.name, when: whenLabel(lastSaved.at, lang) })}</span>
                      <Button icon={FolderOpen} size="sm" variant="ghost" onClick={() => api.revealFile(lastSaved.token).catch(toastError)}>
                        {t('backup.reveal')}
                      </Button>
                    </div>
                    {lastSaved.redacted > 0 ? (
                      <div className="muted small" data-testid="backup-saved-redacted">
                        {t('backup.savedRedacted', { count: countText(t, lastSaved.kind, lastSaved.redacted) })}
                      </div>
                    ) : null}
                    {savedChanged ? <div className="muted small">{t('backup.savedChanged')}</div> : null}
                  </Callout>
                ) : null}
              </div>
            </Card>

            {/* Write to a tag: restore (same UID) or duplicate (another tag) */}
            <Card title={t('backup.write.title')} icon={Copy}>
              <div className="stack">
                <p className="muted">{t('backup.write.body')}</p>
                <Callout tone="info" icon={ShieldCheck} title={t('backup.uidReadonlyTitle')}>
                  {t('backup.dup.excludedNote')}
                </Callout>
                <div className="muted small">
                  {t('backup.write.howto')} {t('backup.placeHint')}
                </div>
                {/* The tag on the reader is usually the tag to WRITE: no one-click "read this tag" here (FLOW-14). */}
                <TagOnReader compact readThis={false} />
                <div className="row">
                  <Button icon={Nfc} loading={busy === 'target'} disabled={!!readWhy || locked} onClick={() => void handleReadTarget()} data-testid="backup-read-target">
                    {target ? t('backup.target.reread') : t('backup.target.read')}
                  </Button>
                  {readWhyText ? <span className="muted small">{readWhyText}</span> : null}
                </div>

                {!target || !plan ? (
                  <p className="muted small">{t('backup.target.none')}</p>
                ) : (
                  <div className="stack" data-testid="backup-target" data-mode={plan.mode}>
                    <KeyValue
                      items={[
                        [t('backup.target.label'), <span key="tuid" className="mono">{formatUid(target.uid)}</span>],
                        [t('tag.kind'), kindLabel(target.kind)],
                        [t('backup.target.readAt'), whenLabel(target.readAt, lang)],
                        [
                          t('backup.target.mode'),
                          <Badge key="m" tone={plan.mode === 'restore' ? 'info' : 'accent'}>
                            {plan.mode === 'restore' ? t('backup.mode.restore') : t('backup.mode.duplicate')}
                          </Badge>,
                        ],
                      ]}
                    />
                    {!targetOnReader ? <Callout tone="warn">{t('backup.target.stale', { uid: formatUid(target.uid) })}</Callout> : null}
                    {plan.kindMismatch ? (
                      <Callout tone="danger">
                        {t('backup.target.kindMismatch', { src: kindLabel(doc.image.kind), dst: kindLabel(target.kind) })}
                      </Callout>
                    ) : (
                      <>
                        {plan.writes.length > 0 ? (
                          <p>
                            {t('backup.plan.changed', {
                              count: countText(t, target.kind, plan.writes.length),
                              total: countText(t, target.kind, plan.dataUnits),
                            })}
                          </p>
                        ) : (
                          <Callout tone="ok">{t('backup.plan.same')}</Callout>
                        )}
                        {plan.sourceUnread.length > 0 ? (
                          <Callout tone="warn">{t('backup.plan.sourceUnread', { count: countText(t, target.kind, plan.sourceUnread.length) })}</Callout>
                        ) : null}
                        {plan.targetUnread.length > 0 ? (
                          <Callout tone="warn">{t('backup.plan.targetUnread', { count: countText(t, target.kind, plan.targetUnread.length) })}</Callout>
                        ) : null}
                      </>
                    )}
                  </div>
                )}

                <LastWriteCallout />

                <div className="row">
                  <span className="muted small grow backup-why" data-testid="backup-write-why">
                    {writeWhyText ?? ''}
                  </span>
                  {/* D14: back to the start, right next to the main action on every tag screen. */}
                  <ExitButton dirty={false} disabled={locked} onExit={handleExit} testId="backup-exit" />
                  <Button
                    variant="primary"
                    icon={plan?.mode === 'restore' ? RotateCcw : Copy}
                    loading={busy === 'write'}
                    disabled={!!writeWhy || locked}
                    onClick={() => void handleWrite()}
                    data-testid="backup-write"
                  >
                    {plan?.mode === 'restore' ? t('backup.restore.button') : t('backup.dup.button')}
                  </Button>
                </div>
              </div>
            </Card>

            {/* Many tags: always visible (FLOW-14) */}
            <Card title={t('backup.many.title')} icon={ArrowRight}>
              <div className="row-between">
                <p className="muted grow">{t('backup.many.body')}</p>
                <Button icon={ArrowRight} disabled={locked} onClick={() => handoffTo('issue', { kind: 'issue-image', image: doc.image })}>
                  {t('backup.many.button')}
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}

function SaveRow({
  label,
  desc,
  button,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  desc: string;
  button: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="row-between">
      <div className="grow">
        <div>{label}</div>
        <div className="muted small">{desc}</div>
      </div>
      <Button icon={Download} loading={busy} disabled={disabled} onClick={onClick} aria-label={`${button}: ${label}`}>
        {button}
      </Button>
    </div>
  );
}
