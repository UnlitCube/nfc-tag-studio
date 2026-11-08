// Backup / restore / duplicate view. Owner: agent renderer-backup.
// Reads a tag (or a loaded dump) and saves it to a file, or copies ONLY the
// data area to another tag. The UID is never copied (invariant I1/I2); the UI
// says so permanently.
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Copy,
  Download,
  FolderOpen,
  Lock,
  RefreshCw,
  Save,
  ShieldCheck,
  Tag,
} from 'lucide-react';
import { Button, Callout, Card, EmptyState, Field, KeyValue, Page, PageHeader, TextInput } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { api } from '../../lib/api';
import { readCurrentTag, writeWithConfirm } from '../../lib/ops';
import { fileStamp, formatUid, kindLabel } from '../../lib/format';
import { useT } from '../../i18n';
import { FILE_FILTERS } from '@shared/api';
import { utf8ToBytes } from '@shared/hex';
import { diffUnits, exportBin, exportFlipper, importDump, serializeProject } from '@shared/tag';
import { isMifare } from '@shared/tags';
import type { TagImage, WriteRequest } from '@shared/types';
import { changedAgainstTarget, planDataCopy } from './duplicate';

type DumpFormat = 'project' | 'bin' | 'flipper';
type BusyKind = null | 'read' | 'open' | 'save' | 'target' | 'write';

export function BackupView() {
  const t = useT();
  const doc = useAppStore((s) => s.doc);
  const openImage = useAppStore((s) => s.openImage);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const handoffTo = useAppStore((s) => s.handoffTo);
  const issueRunning = useAppStore((s) => s.issue.running);

  const [appVersion, setAppVersion] = useState('');
  const [note, setNote] = useState('');
  const [keyIds, setKeyIds] = useState<string[]>([]);
  const [target, setTarget] = useState<TagImage | null>(null);
  const [lastSaved, setLastSaved] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);

  useEffect(() => {
    let live = true;
    api
      .getAppInfo()
      .then((i) => live && setAppVersion(i.version))
      .catch(() => {});
    api
      .listKeys()
      .then((ks) => live && setKeyIds(ks.map((k) => k.id)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const readOptions = useMemo(() => ({ mifareKeyIds: keyIds }), [keyIds]);

  const plan = useMemo(() => (doc ? planDataCopy(doc.image) : null), [doc]);

  const kindMismatch = !!(doc && target && doc.image.kind !== target.kind);
  const sameUid = !!(doc && target && doc.image.uid === target.uid);

  const changedUnits = useMemo(() => {
    if (!doc || !plan || !target || kindMismatch) return null;
    const dataUnits = new Set(plan.writes.map((w) => w.unit));
    try {
      return diffUnits(doc.image.kind, target.data, doc.image.data).filter((u) => dataUnits.has(u));
    } catch {
      // The shared diff helper is not available yet (parallel build): fall back
      // to the equivalent data-area comparison.
      return changedAgainstTarget(plan, target.data);
    }
  }, [doc, plan, target, kindMismatch]);

  async function handleRead() {
    setBusy('read');
    await readCurrentTag(readOptions);
    setTarget(null);
    setBusy(null);
  }

  async function handleOpen() {
    setBusy('open');
    try {
      const file = await api.openFile({
        title: t('backup.open.button'),
        filters: [FILE_FILTERS.project, FILE_FILTERS.bin, FILE_FILTERS.flipper],
      });
      if (file) {
        const { image, format } = importDump(file.name, file.bytes);
        openImage(image, { type: 'file', name: file.name, token: file.token, format });
        setTarget(null);
        toast({ tone: 'ok', title: t('backup.opened'), detail: file.name });
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleSave(format: DumpFormat) {
    if (!doc) return;
    const img = doc.image;
    setBusy('save');
    try {
      let bytes: Uint8Array;
      let filter;
      let ext: string;
      if (format === 'project') {
        bytes = serializeProject(img, { note, appVersion: appVersion || '0.0.0', savedAt: new Date().toISOString() });
        filter = FILE_FILTERS.project;
        ext = 'nfcdump';
      } else if (format === 'bin') {
        bytes = exportBin(img);
        filter = FILE_FILTERS.bin;
        ext = 'bin';
      } else {
        bytes = utf8ToBytes(exportFlipper(img));
        filter = FILE_FILTERS.flipper;
        ext = 'nfc';
      }
      const defaultName = `${img.kind}_${img.uid}_${fileStamp()}.${ext}`;
      const res = await api.saveFile({ title: t('backup.save.title'), defaultName, filters: [filter], bytes });
      if (res) {
        setLastSaved({ token: res.token, name: res.name });
        toast({ tone: 'ok', title: t('backup.saved'), detail: res.name });
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleReadTarget() {
    if (!doc) return;
    setBusy('target');
    try {
      const img = await api.readTag(readOptions);
      setTarget(img);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleDuplicate() {
    if (!doc || !target || !plan || kindMismatch || sameUid || plan.writes.length === 0) return;
    const kind = doc.image.kind;
    const req: WriteRequest = {
      kind,
      expectedUid: target.uid,
      writes: plan.writes,
      allowProtected: false,
      verify: true,
      mifareKeyIds: isMifare(kind) ? keyIds : undefined,
    };
    setBusy('write');
    const res = await writeWithConfirm(req, {
      title: t('backup.dup.confirmTitle'),
      message: t('backup.dup.confirmBody', { uid: formatUid(target.uid) }),
      details: [
        t('backup.dup.detailUnits', { units: plan.writes.length }),
        t('backup.dup.detailUid', { uid: formatUid(target.uid) }),
      ],
      refresh: false,
      readOptions,
    });
    setBusy(null);
    if (res) {
      try {
        const img = await api.readTag(readOptions);
        setTarget(img);
      } catch {
        /* the write result already informed the operator */
      }
    }
  }

  const sourceLabel =
    doc?.source.type === 'card'
      ? t('backup.source.fromCard')
      : doc?.source.type === 'file'
        ? t('backup.source.fromFile', { name: doc.source.name })
        : t('backup.source.fromNew');

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
                <div className="row">
                  <Button variant="primary" icon={Tag} loading={busy === 'read'} disabled={issueRunning} onClick={handleRead}>
                    {t('backup.read')}
                  </Button>
                  <Button icon={FolderOpen} loading={busy === 'open'} onClick={handleOpen}>
                    {t('backup.open.button')}
                  </Button>
                </div>
              }
            >
              {t('backup.noDoc.body')}
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card
              title={t('backup.source.title')}
              icon={Tag}
              actions={
                <div className="row">
                  <Button icon={RefreshCw} size="sm" loading={busy === 'read'} disabled={issueRunning} onClick={handleRead}>
                    {t('backup.source.reread')}
                  </Button>
                  <Button icon={FolderOpen} size="sm" loading={busy === 'open'} onClick={handleOpen}>
                    {t('backup.open.button')}
                  </Button>
                </div>
              }
            >
              <KeyValue
                items={[
                  [t('backup.source.origin'), sourceLabel],
                  [t('tag.uid'), <span key="uid" className="mono">{formatUid(doc.image.uid)}</span>],
                  [t('tag.kind'), kindLabel(doc.image.kind)],
                ]}
              />
            </Card>

            {/* Save to file */}
            <Card title={t('backup.save.title')} icon={Save}>
              <p className="muted">{t('backup.save.body')}</p>
              <Field label={t('backup.save.note')} htmlFor="backup-note">
                <TextInput
                  id="backup-note"
                  value={note}
                  placeholder={t('backup.save.notePlaceholder')}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                />
              </Field>
              <div className="stack">
                <SaveRow
                  label={t('backup.save.project')}
                  desc={t('backup.save.projectDesc')}
                  busy={busy === 'save'}
                  onClick={() => handleSave('project')}
                />
                <SaveRow
                  label={t('backup.save.bin')}
                  desc={t('backup.save.binDesc')}
                  busy={busy === 'save'}
                  onClick={() => handleSave('bin')}
                />
                <SaveRow
                  label={t('backup.save.flipper')}
                  desc={t('backup.save.flipperDesc')}
                  busy={busy === 'save'}
                  onClick={() => handleSave('flipper')}
                />
              </div>
              {lastSaved ? (
                <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                  <span className="muted small">{lastSaved.name}</span>
                  <Button icon={FolderOpen} size="sm" variant="ghost" onClick={() => api.revealFile(lastSaved.token).catch(toastError)}>
                    {t('backup.reveal')}
                  </Button>
                </div>
              ) : null}
            </Card>

            {/* Duplicate to another tag */}
            <Card title={t('backup.dup.title')} icon={Copy}>
              <p className="muted">{t('backup.dup.body')}</p>

              {/* Permanent "UID is not copied" notice inside the duplicate flow. */}
              <Callout tone="info" icon={ShieldCheck} title={t('backup.uidReadonlyTitle')}>
                {t('backup.dup.excludedNote')}
              </Callout>

              <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                <Button icon={Tag} loading={busy === 'target'} disabled={issueRunning} onClick={handleReadTarget}>
                  {target ? t('backup.dup.rereadTarget') : t('backup.dup.readTarget')}
                </Button>
              </div>

              {!target ? (
                <p className="muted small" style={{ marginTop: 'var(--space-3)' }}>
                  {t('backup.dup.noTarget')}
                </p>
              ) : (
                <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                  <KeyValue
                    items={[
                      [t('backup.dup.target'), <span key="tuid" className="mono">{formatUid(target.uid)}</span>],
                      [t('tag.kind'), kindLabel(target.kind)],
                    ]}
                  />

                  {kindMismatch ? (
                    <Callout tone="danger">{t('backup.dup.kindMismatch', { src: kindLabel(doc.image.kind), dst: kindLabel(target.kind) })}</Callout>
                  ) : sameUid ? (
                    <Callout tone="warn">{t('backup.dup.sameUid')}</Callout>
                  ) : (
                    <>
                      <p>
                        {plan ? t('backup.dup.willWrite', { units: plan.writes.length, bytes: plan.byteCount }) : null}
                        {changedUnits ? ' ' + t('backup.dup.changed', { changed: changedUnits.length }) : null}
                      </p>
                      {plan && plan.unreadUnits.length > 0 ? (
                        <Callout tone="warn">{t('backup.dup.unread', { count: plan.unreadUnits.length })}</Callout>
                      ) : null}
                    </>
                  )}

                  <div className="row">
                    <Button
                      variant="primary"
                      icon={Copy}
                      loading={busy === 'write'}
                      disabled={issueRunning || kindMismatch || sameUid || !plan || plan.writes.length === 0}
                      onClick={handleDuplicate}
                    >
                      {t('backup.dup.write')}
                    </Button>
                    <Button variant="secondary" icon={ArrowRight} onClick={() => handoffTo('issue', { kind: 'issue-image' })}>
                      {t('backup.dup.many')}
                    </Button>
                  </div>
                  <p className="muted small">{t('backup.dup.manyBody')}</p>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}

function SaveRow({ label, desc, busy, onClick }: { label: string; desc: string; busy: boolean; onClick: () => void }) {
  return (
    <div className="row-between">
      <div className="grow">
        <div>{label}</div>
        <div className="muted small">{desc}</div>
      </div>
      <Button icon={Download} loading={busy} onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}
