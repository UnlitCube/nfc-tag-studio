// Read / landing screen. Owner: agent "shell-ui".
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Archive, Binary, CreditCard, FileCode2, FolderOpen, Nfc, ScanLine, Usb } from 'lucide-react';
import type { TagImage } from '@shared/types';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, specFor, isNtag } from '@shared/tags';
import { scanType2Tlvs, decodeMessage, extractMifareNdef } from '@shared/ndef';
import { Badge, Button, Callout, Card, EmptyState, Field, KeyValue, Page, PageHeader, Segmented, Select, Switch } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { readCurrentTag } from '../../lib/ops';
import { formatUid, kindLabel } from '../../lib/format';

function ndefRecordCount(image: TagImage): number | null {
  try {
    let message: Uint8Array | null = null;
    if (isNtag(image.kind)) {
      const spec = specFor(image.kind);
      const start = spec.userStartUnit * spec.unitSize;
      const area = image.data.subarray(start, start + spec.userBytes);
      message = scanType2Tlvs(area).ndef;
    } else {
      message = extractMifareNdef(image.kind, image.data);
    }
    if (!message) return 0;
    return decodeMessage(message).length;
  } catch {
    return null;
  }
}

export function HomeView() {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const doc = useAppStore((s) => s.doc);
  const setView = useAppStore((s) => s.setView);
  const toastError = useAppStore((s) => s.toastError);
  const sim = reader?.simulator;
  const card = reader?.card ?? null;
  const busy = !!reader?.busy;

  const active = reader?.readers.find((r) => r.name === (card?.readerName ?? reader?.selectedReader)) ?? reader?.readers[0] ?? null;
  const cardImage = doc && doc.source.type === 'card' ? doc.image : null;
  const ndefCount = useMemo(() => (cardImage ? ndefRecordCount(cardImage) : null), [cardImage]);

  async function onRead() {
    await readCurrentTag();
  }
  async function onOpenFile() {
    try {
      const res = await api.openFile({ filters: [{ name: 'NFC ダンプ', extensions: ['nfcdump', 'bin', 'dump', 'mfd', 'nfc'] }] });
      if (res) setView('backup');
    } catch (err) {
      toastError(err);
    }
  }

  const serviceDown = reader && (reader.service === 'unavailable' || reader.service === 'error');
  const hasRealReader = !!active && !active.virtual;
  const notContactless = hasRealReader && !active.likelyContactless;

  return (
    <Page>
      <PageHeader title={t('home.title')} subtitle={t('home.subtitle')} helpTopic="read" />

      {serviceDown ? (
        <Callout tone="danger" title={t('home.noServiceTitle')}>
          {t('home.noServiceBody')}
        </Callout>
      ) : null}
      {notContactless ? (
        <Callout tone="warn" title={t('home.notContactlessTitle')}>
          {t('home.notContactlessBody', { name: active!.name })}
        </Callout>
      ) : null}

      <div className="grid-2">
        {/* read / tag card */}
        <Card title={t('home.tag')} icon={CreditCard}>
          {!card && !cardImage ? (
            !hasRealReader && !sim?.enabled ? (
              <EmptyState icon={Usb} title={t('home.noReaderTitle')}>
                {t('home.noReaderBody')}
              </EmptyState>
            ) : (
              <EmptyState
                icon={ScanLine}
                title={t('home.placeTagTitle')}
                action={<Button variant="primary" icon={ScanLine} onClick={onRead} loading={busy} disabled={!card && !sim?.present}>{t('home.readNow')}</Button>}
              >
                {card ? t('home.placeTagBody') : t('tag.placeTag')}
              </EmptyState>
            )
          ) : (
            <div className="stack">
              <div className="row-between">
                <Badge tone="accent" icon={Nfc}>
                  {kindLabel(cardImage?.kind ?? card?.kind ?? null)}
                </Badge>
                <Button icon={ScanLine} onClick={onRead} loading={busy} disabled={!card && !sim?.present}>
                  {t('home.readNow')}
                </Button>
              </div>
              <KeyValue
                items={[
                  [t('home.uid'), <span className="mono" key="uid">{formatUid(cardImage?.uid ?? card?.uid ?? '')}</span>],
                  [t('home.kind'), kindLabel(cardImage?.kind ?? card?.kind ?? null)],
                  ...(cardImage
                    ? ([
                        [t('home.capacity'), t('common.bytes', { n: specFor(cardImage.kind).userBytes })],
                        [t('home.ndef'), ndefCount == null ? t('common.unknown') : ndefCount === 0 ? t('home.ndefNone') : t('home.ndefRecords', { n: ndefCount })],
                        ...(cardImage.ntag?.counter != null ? ([[t('home.counter'), String(cardImage.ntag.counter)]] as [string, string][]) : []),
                      ] as [ReactNode, ReactNode][])
                    : []),
                ]}
              />
              {cardImage && cardImage.unitStatus.some((s) => s !== 'ok') ? (
                <Callout tone="warn">{t('home.deniedNote', { n: cardImage.unitStatus.filter((s) => s !== 'ok').length })}</Callout>
              ) : null}
              {cardImage ? (
                <div className="row">
                  <span className="small muted">{t('home.quick')}:</span>
                  <Button size="sm" icon={FileCode2} onClick={() => setView('ndef')}>{t('home.toNdef')}</Button>
                  <Button size="sm" icon={Binary} onClick={() => setView('hex')}>{t('home.toHex')}</Button>
                  <Button size="sm" icon={Archive} onClick={() => setView('backup')}>{t('home.toBackup')}</Button>
                </div>
              ) : null}
            </div>
          )}
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Button icon={FolderOpen} onClick={onOpenFile}>{t('home.openFile')}</Button>
          </div>
        </Card>

        {/* simulator */}
        <SimulatorPanel />
      </div>

      <Callout tone="info" title={t('home.uid')}>
        {t('tag.uidReadonly')}
      </Callout>
    </Page>
  );
}

function SimulatorPanel() {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const toastError = useAppStore((s) => s.toastError);
  const sim = reader?.simulator;
  const enabled = !!sim?.enabled;

  async function setEnabled(v: boolean) {
    try {
      await api.setSimulator({ enabled: v, kind: sim?.kind });
      if (v) await api.simulatorTap(true);
    } catch (err) {
      toastError(err);
    }
  }
  async function setKind(kind: TagKind) {
    try {
      await api.simulatorNewTag(kind);
    } catch (err) {
      toastError(err);
    }
  }
  async function tap(present: boolean) {
    try {
      await api.simulatorTap(present);
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <Card title={t('home.sim.title')} icon={Nfc}>
      <div className="stack">
        <p className="muted small">{t('home.sim.body')}</p>
        <Switch checked={enabled} onChange={setEnabled} label={t('home.sim.enable')} />
        {enabled ? (
          <>
            <Field label={t('home.sim.kind')}>
              <Select<TagKind>
                value={sim?.kind ?? 'NTAG215'}
                onChange={setKind}
                options={TAG_KINDS.map((k) => ({ value: k, label: specFor(k).displayName }))}
              />
            </Field>
            <div className="row">
              <Segmented<'on' | 'off'>
                ariaLabel="virtual tag"
                value={sim?.present ? 'on' : 'off'}
                onChange={(v) => tap(v === 'on')}
                options={[
                  { value: 'on', label: t('home.sim.tapOn') },
                  { value: 'off', label: t('home.sim.tapOff') },
                ]}
              />
              <Button size="sm" onClick={() => setKind(sim?.kind ?? 'NTAG215')}>{t('home.sim.newTag')}</Button>
            </div>
            <Badge tone={sim?.present ? 'ok' : 'neutral'}>{sim?.present ? t('home.sim.present') : t('home.sim.absent')}</Badge>
          </>
        ) : null}
      </div>
    </Card>
  );
}
