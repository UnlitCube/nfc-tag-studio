// Erase screen ("消去", 2026-11-13, menu "タグの読み取り・編集"). Owner: renderer-core.
//
// The same flow as every tag screen (D14):
//   1. entry: nothing but the tag on the reader and [Read tag] - no erase controls
//      before the tag was read (the erase range is chosen against what is ON it);
//   2. after reading: what the tag holds, the range to erase (NDEF only / the whole
//      data area), and at the bottom [Close] (back to 1) + [Erase] (danger);
//   3. erasing re-reads the tag first and refuses when it is another tag or its
//      content changed since step 2 (the plan the operator saw must be the one
//      written); the confirmation names the tag (kind + UID); the write is
//      verified; the result stays (LastWriteCallout) and the summary is re-read.
// Placing a tag never reads it here by itself (not in AUTO_READ_VIEWS): erasing
// starts only from an explicit read. The read does not replace the open document.
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Eraser, Lock, Nfc, Tag } from 'lucide-react';
import { isFelica, isMifare, isNtag, specFor } from '@shared/tags';
import type { TagImage, WriteRequest } from '@shared/types';
import { Badge, Button, Callout, Card, EmptyState, KeyValue, Page, PageHeader } from '../../components/ui';
import { TagOnReader, useOpBlockText } from '../../components/TagOnReader';
import { LastWriteCallout } from '../../components/LastWriteCallout';
import { ExitButton } from '../../components/ExitButton';
import { useT } from '../../i18n';
import type { TFunc } from '../../i18n';
import { useAppStore } from '../../store/app';
import { readTarget, writeWithConfirm } from '../../lib/ops';
import { isCardReady, tagOpBlock } from '../../lib/readerState';
import { formatUid, idName, kindLabel } from '../../lib/format';
import { unitCount } from '../../lib/units';
import { whenLabel } from '../backup/dumpMeta';
import { planErrorText } from '../ndef/NdefView';
import type { ImageNdef } from '../ndef/ndefPages';
import { currentNdef, eraseModes, planErase, readInterrupted, unreadUnits } from './model';
import type { EraseMode, ErasePlan } from './model';
import './erase.css';

function ndefLabel(t: TFunc, n: ImageNdef): string {
  switch (n.state) {
    case 'records':
      return t('erase.ndef.records', { n: n.drafts.length });
    case 'empty':
      return t('erase.ndef.empty');
    case 'none':
      return t('erase.ndef.none');
    case 'unreadable':
      return t('erase.ndef.unreadable');
    case 'invalid':
      return t('erase.ndef.invalid');
    case 'unsupported':
      return t('erase.ndef.unsupported');
  }
}

function allDesc(t: TFunc, img: TagImage): string {
  if (isFelica(img.kind)) return t('erase.mode.allDescFelica');
  if (isMifare(img.kind)) return t('erase.mode.allDescMifare');
  return t('erase.mode.allDescNtag');
}

/** Same bytes in every unit (the tag did not change between the read and the erase). */
function sameContent(a: TagImage, b: TagImage): boolean {
  if (a.uid.toUpperCase() !== b.uid.toUpperCase() || a.kind !== b.kind || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

export function EraseView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const toast = useAppStore((s) => s.toast);
  const setLastWrite = useAppStore((s) => s.setLastWrite);
  const opText = useOpBlockText();

  /** The tag read on this screen (not the open document: erasing never replaces it). */
  const [target, setTarget] = useState<TagImage | null>(null);
  const [mode, setMode] = useState<EraseMode>('ndef');
  const [busy, setBusy] = useState<null | 'read' | 'erase'>(null);

  const block = tagOpBlock(reader, { issueRunning, busyOp });
  const locked = busy !== null;
  const card = isCardReady(reader) ? reader!.card! : null;
  const modes = target ? eraseModes(target.kind) : [];
  const activeMode: EraseMode = modes.includes(mode) ? mode : 'all';
  const plans = useMemo(() => {
    const m = new Map<EraseMode, ErasePlan>();
    if (target) for (const md of eraseModes(target.kind)) m.set(md, planErase(target, md));
    return m;
  }, [target]);
  const plan = plans.get(activeMode) ?? null;
  const interrupted = !!target && readInterrupted(target);
  const unread = target ? unreadUnits(target) : [];
  const otherOnReader = !!target && !!card && card.uid.toUpperCase() !== target.uid.toUpperCase();

  const readWhy = block ? opText(block) : null;
  const eraseWhy: string | null = !target
    ? null
    : block
      ? opText(block)
      : otherOnReader
        ? t('erase.why.otherTag')
        : interrupted
          ? t('erase.why.incomplete')
          : !plan || !plan.ok
            ? t('erase.why.plan')
            : plan.writes.length === 0
              ? t('erase.why.nothing')
              : null;

  /** Clear this screen's own write result only (D15: another screen's stays there). */
  function clearOwnResult() {
    if (useAppStore.getState().lastWrite?.view === 'erase') setLastWrite(null);
  }

  async function read() {
    if (locked) return;
    setBusy('read');
    try {
      const img = await readTarget({});
      if (!img) return;
      setTarget(img);
      clearOwnResult();
      // Default range: NDEF only when the tag holds an NDEF with content (the lighter erase), else the whole data area.
      const nd = currentNdef(img).state;
      setMode(eraseModes(img.kind).includes('ndef') && (nd === 'records' || nd === 'invalid') ? 'ndef' : 'all');
    } finally {
      setBusy(null);
    }
  }

  function exit() {
    if (locked) return;
    setTarget(null);
    clearOwnResult();
  }

  async function erase() {
    if (!target || locked || eraseWhy) return;
    setBusy('erase');
    try {
      // Plan from what is on the reader NOW, and only if it is what the operator looked at.
      const fresh = await readTarget({});
      if (!fresh) return;
      if (fresh.uid.toUpperCase() !== target.uid.toUpperCase()) {
        toast({ tone: 'warn', title: t('erase.why.otherTag') });
        return;
      }
      if (!sameContent(fresh, target)) {
        setTarget(fresh);
        toast({ tone: 'warn', title: t('erase.changed') });
        return;
      }
      const p = planErase(fresh, activeMode);
      if (!p.ok || p.writes.length === 0) return;
      const isPage = specFor(fresh.kind).unit === 'page';
      const details = [t(isPage ? 'erase.mode.pages' : 'erase.mode.blocks', { n: p.writes.length })];
      if (p.excluded.locked.length) details.push(t('erase.mode.locked', { list: p.excluded.locked.join(', ') }));
      const uid = formatUid(fresh.uid);
      const kind = kindLabel(fresh.kind);
      const req: WriteRequest = { kind: fresh.kind, expectedUid: fresh.uid, writes: p.writes, allowProtected: false, verify: true };
      const res = await writeWithConfirm(req, {
        title: t('erase.cf.title'),
        message: t(activeMode === 'ndef' ? 'erase.cf.msgNdef' : 'erase.cf.msgAll', { uid, kind }),
        confirmLabel: t('erase.run'),
        details,
        dangerous: true,
        target: { kind: fresh.kind, uid: fresh.uid, other: false },
        // D15: no document (this screen reads its own target; another screen's document is never touched).
        doc: null,
        docCopy: false,
        keepUnitsOnFailure: [],
        successTitle: t('erase.done'),
      });
      if (!res) return;
      // Show what the tag holds now (the result stays below).
      const after = await readTarget({});
      if (after && after.uid.toUpperCase() === fresh.uid.toUpperCase()) setTarget(after);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page>
      <PageHeader title={t('erase.title')} subtitle={t('erase.subtitle')} helpTopic="erase" />
      <div className="stack-lg">
        <Callout tone="warn" icon={Lock}>
          {t('erase.scope')}
        </Callout>

        {!target ? (
          <Card>
            <div data-testid="erase-entry">
              <EmptyState icon={Eraser} title={t('erase.entry.title')}>
                <p className="muted">{t('erase.entry.body')}</p>
                <div className="stack erase-entry">
                  <TagOnReader readThis={false} />
                  <div className="row">
                    <Button
                      variant="primary"
                      icon={Nfc}
                      loading={busy === 'read'}
                      disabled={!!readWhy || locked}
                      onClick={(e) => {
                        if (e.detail > 1) return;
                        void read();
                      }}
                      data-testid="erase-read"
                    >
                      {t('erase.read')}
                    </Button>
                  </div>
                  {readWhy ? <div className="muted small">{readWhy}</div> : null}
                </div>
              </EmptyState>
            </div>
          </Card>
        ) : (
          <>
            <Card
              title={t('erase.tag.title')}
              icon={Tag}
              actions={
                <Button size="sm" icon={Nfc} loading={busy === 'read'} disabled={!!readWhy || locked} onClick={() => void read()} data-testid="erase-reread">
                  {t('erase.reread')}
                </Button>
              }
            >
              <div className="stack" data-testid="erase-tag">
                <KeyValue
                  items={[
                    [t('erase.tag.kind'), kindLabel(target.kind)],
                    [idName(target.kind), <span key="uid" className="mono" data-testid="erase-uid">{formatUid(target.uid)}</span>],
                    [t('erase.tag.readAt'), whenLabel(target.readAt, lang)],
                    ...(isNtag(target.kind) || isMifare(target.kind)
                      ? ([[t('erase.tag.ndef'), <span key="ndef" data-testid="erase-ndef">{ndefLabel(t, currentNdef(target))}</span>]] as [string, ReactNode][])
                      : []),
                    ...(unread.length > 0 ? ([[t('erase.tag.denied'), unitCount(target.kind, unread.length, lang)]] as [string, string][]) : []),
                  ]}
                />
                {unread.length > 0 ? <div className="muted small">{t('erase.deniedNote')}</div> : null}
                {interrupted ? <Callout tone="warn">{t('erase.incomplete')}</Callout> : null}
                <TagOnReader compact readThis={false} />
                {otherOnReader && card ? (
                  <Callout tone="warn">{t('erase.otherTag', { now: formatUid(card.uid), read: formatUid(target.uid) })}</Callout>
                ) : null}
              </div>
            </Card>

            <Card title={t('erase.mode.title')} icon={Eraser}>
              <div className="erase-modes" role="radiogroup" aria-label={t('erase.mode.title')}>
                {modes.map((md) => {
                  const p = plans.get(md)!;
                  const isPage = specFor(target.kind).unit === 'page';
                  return (
                    <label key={md} className={`erase-mode${activeMode === md ? ' is-selected' : ''}`} data-testid={`erase-mode-${md}`}>
                      <input type="radio" name="erase-mode" value={md} checked={activeMode === md} disabled={locked} onChange={() => setMode(md)} />
                      <span className="erase-mode-text">
                        <strong>{t(md === 'ndef' ? 'erase.mode.ndef' : 'erase.mode.all')}</strong>
                        <span className="muted small">{md === 'ndef' ? t('erase.mode.ndefDesc') : allDesc(t, target)}</span>
                        <span className="small">
                          {!p.ok ? (
                            <Badge tone="warn">{planErrorText(t, p.ndef)}</Badge>
                          ) : p.writes.length === 0 ? (
                            <Badge tone="ok">{t('erase.mode.already')}</Badge>
                          ) : (
                            <Badge tone="neutral">{t(isPage ? 'erase.mode.pages' : 'erase.mode.blocks', { n: p.writes.length })}</Badge>
                          )}
                          {p.ok && p.excluded.locked.length > 0 ? (
                            <span className="muted"> {t('erase.mode.locked', { list: p.excluded.locked.join(', ') })}</span>
                          ) : null}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </Card>

            <div className="erase-run">
              <LastWriteCallout />
              <div className="row">
                <span className="muted small grow" data-testid="erase-why">
                  {eraseWhy ?? ''}
                </span>
                {/* D14: back to the start, right next to the main action on every tag screen (nothing is unsaved here). */}
                <ExitButton dirty={false} disabled={locked} onExit={exit} testId="erase-exit" />
                <Button
                  variant="danger"
                  icon={Eraser}
                  loading={busy === 'erase'}
                  disabled={!!eraseWhy || locked}
                  onClick={(e) => {
                    if (e.detail > 1) return;
                    void erase();
                  }}
                  data-testid="erase-run"
                >
                  {t('erase.run')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
