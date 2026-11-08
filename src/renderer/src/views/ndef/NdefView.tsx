// NDEF view: define/read an NDEF message for the current tag (or a file / new),
// preview the encoded bytes, write it to the tag's data area, or hand it to the
// batch-issue screen as a template. Owner: agent "renderer-ndef".
//
// Invariant (I1): the UID is read-only. This view only ever writes the user
// (data) area. Writing never changes or copies a UID - that is stated to the
// operator in ndef.uidNote and in the write confirmation.
import './ndef.css';
import { useMemo, useState } from 'react';
import { Download, FileText, Nfc, PenLine, Send, Upload } from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, isNtag, specFor } from '@shared/tags';
import type { NdefRecordDraft } from '@shared/ndef/types';
import {
  buildMifareNdefWrites,
  buildType2UserArea,
  decodeToDrafts,
  encodeDrafts,
  extractMifareNdef,
  scanType2Tlvs,
  wrapNdefTlv,
} from '@shared/ndef';
import type { UnitWrite, WriteRequest } from '@shared/types';
import { FILE_FILTERS } from '@shared/api';
import { Badge, Button, Callout, Card, EmptyState, Field, KeyValue, Page, PageHeader, Segmented, Select } from '../../components/ui';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/app';
import { api, errorText } from '../../lib/api';
import { writeWithConfirm } from '../../lib/ops';
import { fileStamp, formatUid, kindLabel } from '../../lib/format';
import { NdefRecordsEditor } from './NdefRecordsEditor';
import { bytesToHex, resolveWriteKind, userAreaToPages } from './ndefPages';

type SourceKind = 'card' | 'file' | 'new';

export function NdefView() {
  const t = useT();
  const doc = useAppStore((s) => s.doc);
  const reader = useAppStore((s) => s.reader);
  const setView = useAppStore((s) => s.setView);
  const handoffTo = useAppStore((s) => s.handoffTo);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);

  const [source, setSource] = useState<SourceKind>(doc ? 'card' : 'new');
  const [records, setRecords] = useState<NdefRecordDraft[]>([]);
  const [newKind, setNewKind] = useState<TagKind>('NTAG213');
  const [fileName, setFileName] = useState<string | null>(null);

  // The card physically on the reader (if any) and the UID the write will target.
  const card = reader?.card ?? null;
  const expectedUid =
    source === 'card' && doc && doc.source.type === 'card' ? doc.image.uid : (card?.uid ?? null);

  // What the operator is composing for. For "new"/"file" this is their pick; for
  // a loaded card it is the document's kind.
  const selectedKind: TagKind = source === 'card' && doc ? doc.image.kind : newKind;

  // The kind detected from the card on the reader, but only when it is the exact
  // card we would write to (same UID). Its layout is authoritative: main re-reads
  // only the UID before writing and judges forbidden/protected units by req.kind
  // (DESIGN §3.1), so the write kind must match the real chip - never the pick
  // from the dropdown (which could brick a smaller tag; see resolveWriteKind).
  const detectedKind: TagKind | null = card && expectedUid !== null && card.uid === expectedUid ? card.kind : null;

  // targetKind drives both the capacity meter and the write plan; kindMismatch is
  // set when the dropdown pick disagrees with the card on the reader.
  const { kind: targetKind, mismatch: kindMismatch } = resolveWriteKind(selectedKind, detectedKind);

  const preview = useMemo(() => {
    try {
      const msg = encodeDrafts(records);
      return { hex: bytesToHex(msg), len: msg.length, error: null as string | null };
    } catch (e) {
      return { hex: '', len: 0, error: errorText(e).message };
    }
  }, [records]);

  function loadFromTag() {
    if (!doc) return;
    const { kind, data } = doc.image;
    let message: Uint8Array | null = null;
    try {
      if (isNtag(kind)) {
        const spec = specFor(kind);
        const start = spec.userStartUnit * spec.unitSize;
        message = scanType2Tlvs(data.slice(start, start + spec.userBytes)).ndef;
      } else {
        message = extractMifareNdef(kind, data);
      }
    } catch (e) {
      toastError(e, t('ndef.loadFailed'));
      return;
    }
    if (!message) {
      setRecords([]);
      toast({ tone: 'info', title: t('ndef.loadedBlank') });
      return;
    }
    try {
      const drafts = decodeToDrafts(message);
      setRecords(drafts);
      toast({ tone: 'ok', title: t('ndef.loaded', { n: drafts.length }) });
    } catch (e) {
      toastError(e, t('ndef.loadFailed'));
    }
  }

  async function openFile() {
    try {
      const res = await api.openFile({ title: t('ndef.openFile'), filters: [FILE_FILTERS.ndef] });
      if (!res) return;
      const drafts = decodeToDrafts(res.bytes);
      setRecords(drafts);
      setFileName(res.name);
      toast({ tone: 'ok', title: t('ndef.fileLoaded', { name: res.name }) });
    } catch (e) {
      toastError(e, t('ndef.loadFailed'));
    }
  }

  async function saveFile() {
    let bytes: Uint8Array;
    try {
      bytes = encodeDrafts(records);
    } catch (e) {
      toastError(e, t('ndef.encodeFailed'));
      return;
    }
    try {
      const res = await api.saveFile({
        title: t('ndef.saveFile'),
        defaultName: `ndef-${fileStamp()}.ndef`,
        filters: [FILE_FILTERS.ndef],
        bytes,
      });
      if (res) toast({ tone: 'ok', title: t('toast.saved') });
    } catch (e) {
      toastError(e);
    }
  }

  function sendToIssue() {
    if (records.length === 0) {
      toast({ tone: 'info', title: t('ndef.nothingToSend') });
      return;
    }
    handoffTo('issue', { kind: 'issue-ndef', records });
  }

  async function writeToTag() {
    let message: Uint8Array;
    try {
      message = encodeDrafts(records);
    } catch (e) {
      toastError(e, t('ndef.encodeFailed'));
      return;
    }

    if (!expectedUid) {
      toast({ tone: 'warn', title: t('ndef.noTarget') });
      return;
    }
    // Safety (I1/I5): the physical chip owns its memory layout. If the card on the
    // reader is a different kind than the selected target, refuse rather than let
    // main plan the write against the wrong layout (which could permanently lock
    // or corrupt the tag). The capacity meter already reflects the real card.
    if (kindMismatch) {
      toast({
        tone: 'warn',
        title: t('ndef.kindMismatch.title'),
        detail: t('ndef.kindMismatch.body', {
          detected: kindLabel(kindMismatch.detected),
          selected: kindLabel(kindMismatch.selected),
        }),
      });
      return;
    }

    const kind = targetKind;

    let writes: UnitWrite[];
    let mifareKeyIds: string[] | undefined;
    try {
      if (isNtag(kind)) {
        const area = buildType2UserArea(kind, message);
        writes = userAreaToPages(area, specFor(kind).userStartUnit, wrapNdefTlv(message).length);
      } else {
        const image = source === 'card' && doc ? doc.image.data : null;
        if (!image) {
          toast({ tone: 'warn', title: t('ndef.needImage') });
          return;
        }
        writes = buildMifareNdefWrites(kind, image, message);
        mifareKeyIds = (await api.listKeys()).map((k) => k.id);
      }
    } catch (e) {
      toastError(e, isNtag(kind) ? t('ndef.encodeFailed') : t('ndef.mifareNotFormatted'));
      return;
    }

    const req: WriteRequest = {
      kind,
      expectedUid,
      writes,
      allowProtected: false,
      verify: true,
      mifareKeyIds,
    };
    await writeWithConfirm(req, {
      title: t('ndef.confirmTitle'),
      message: t('ndef.confirmMessage'),
      details: [t('ndef.confirmRecords', { n: records.length }), t('ndef.confirmBytes', { n: message.length })],
    });
  }

  return (
    <Page>
      <PageHeader
        title={t('ndef.title')}
        subtitle={t('ndef.subtitle')}
        helpTopic="ndef"
        actions={
          <Button icon={Send} onClick={sendToIssue} disabled={records.length === 0}>
            {t('ndef.sendToIssue')}
          </Button>
        }
      />

      <Callout tone="info" icon={Nfc}>
        {t('ndef.uidNote')}
      </Callout>

      <Card title={t('ndef.source')}>
        <div className="stack">
          <Segmented<SourceKind>
            ariaLabel={t('ndef.source')}
            value={source}
            onChange={setSource}
            options={[
              { value: 'card', label: t('ndef.source.card') },
              { value: 'file', label: t('ndef.source.file') },
              { value: 'new', label: t('ndef.source.new') },
            ]}
          />

          {source === 'card' ? (
            doc ? (
              <div className="stack">
                <KeyValue
                  items={[
                    [t('ndef.currentTag'), <span className="mono">{formatUid(doc.image.uid)}</span>],
                    [t('tag.kind'), kindLabel(doc.image.kind)],
                  ]}
                />
                <div className="row">
                  <Button icon={Download} onClick={loadFromTag}>
                    {t('ndef.loadFromTag')}
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={Nfc}
                title={t('ndef.noCard')}
                action={
                  <Button variant="primary" onClick={() => setView('home')}>
                    {t('ndef.goRead')}
                  </Button>
                }
              >
                {t('ndef.noCardHint')}
              </EmptyState>
            )
          ) : null}

          {source === 'file' ? (
            <div className="stack">
              <div className="muted small">{t('ndef.source.fileHint')}</div>
              <div className="row">
                <Button icon={Upload} onClick={openFile}>
                  {t('ndef.openFile')}
                </Button>
                <Button icon={Download} onClick={saveFile} disabled={records.length === 0}>
                  {t('ndef.saveFile')}
                </Button>
                {fileName ? <Badge icon={FileText}>{fileName}</Badge> : null}
              </div>
            </div>
          ) : null}

          {source !== 'card' ? (
            <Field label={t('ndef.targetKind')} hint={t('ndef.targetKindHint')}>
              <Select<TagKind>
                value={newKind}
                onChange={setNewKind}
                options={TAG_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
              />
            </Field>
          ) : null}
        </div>
      </Card>

      <Card title={t('ndef.records')}>
        <NdefRecordsEditor records={records} onChange={setRecords} capacityKind={targetKind} />
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

      {kindMismatch ? (
        <Callout tone="warn" title={t('ndef.kindMismatch.title')}>
          {t('ndef.kindMismatch.body', {
            detected: kindLabel(kindMismatch.detected),
            selected: kindLabel(kindMismatch.selected),
          })}
        </Callout>
      ) : null}

      <div className="ndef-actions">
        <Button icon={Send} onClick={sendToIssue} disabled={records.length === 0}>
          {t('ndef.sendToIssue')}
        </Button>
        <Button icon={PenLine} variant="primary" onClick={writeToTag}>
          {t('ndef.writeToTag')}
        </Button>
      </div>
    </Page>
  );
}
