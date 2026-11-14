// Full reset screen ("完全初期化", 2026-11-14, menu "タグの読み取り・編集"). Owner: renderer-core.
// Same flow as the erase screen (D14): entry (no controls before the tag is read; never
// reads by itself) -> what goes back to the factory state and what cannot (with the
// reason) -> [Close] + [Reset]. Resetting re-reads the tag first and refuses another tag
// or changed content; the confirmation names the tag and asks for a typed word; it needs
// advanced mode (protected areas: settings, password, keys - I5). The plan is
// views/factory/model.ts.
import { useMemo, useState } from 'react';
import { Lock, Nfc, RotateCcw, Settings, ShieldAlert, Tag } from 'lucide-react';
import { specFor } from '@shared/tags';
import type { TagImage, WriteRequest } from '@shared/types';
import type { LanguageSetting } from '@shared/types';
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
import { planFactoryReset } from './model';
import type { FactoryArea, FactoryIssue, FactoryPlan } from './model';
import '../erase/erase.css';

function areaText(t: TFunc, img: TagImage, lang: LanguageSetting, area: FactoryArea, units: number[]): string {
  switch (area) {
    case 'data':
      return t('factory.area.data', { count: unitCount(img.kind, units.length, lang) });
    case 'cc':
      return t('factory.area.cc');
    case 'config':
      return t('factory.area.config');
    case 'password':
      return t('factory.area.password');
    case 'trailers':
      return t('factory.area.trailers', { n: units.length });
    case 'mc':
      return t('factory.area.mc');
    case 'reg':
      return t('factory.area.reg');
  }
}

function issueText(t: TFunc, img: TagImage, lang: LanguageSetting, i: FactoryIssue): string {
  switch (i.code) {
    case 'lock-bits':
      return t('factory.issue.lockBits');
    case 'locked-units':
      return t('factory.issue.lockedUnits', { list: i.units.join(', ') });
    case 'cfg-lock':
      return t('factory.issue.cfgLock');
    case 'cc-otp':
      return t('factory.issue.ccOtp');
    case 'counter':
      return t('factory.issue.counter');
    case 'unread':
      return t('factory.issue.unread', { count: unitCount(img.kind, i.units.length, lang) });
    case 'felica-write-protect':
      return t('factory.issue.felicaWp', { list: i.blocks.map((b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`).join(', ') });
    case 'felica-read-protect':
      return t('factory.issue.felicaRp');
    case 'felica-system-ro':
      return t('factory.issue.felicaSys');
  }
}

function sameContent(a: TagImage, b: TagImage): boolean {
  if (a.uid.toUpperCase() !== b.uid.toUpperCase() || a.kind !== b.kind || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

export function FactoryView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const advanced = useAppStore((s) => s.settings.advancedMode);
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const toast = useAppStore((s) => s.toast);
  const setView = useAppStore((s) => s.setView);
  const setLastWrite = useAppStore((s) => s.setLastWrite);
  const opText = useOpBlockText();

  /** The tag read on this screen (its own: never another screen's document). */
  const [target, setTarget] = useState<TagImage | null>(null);
  const [busy, setBusy] = useState<null | 'read' | 'reset'>(null);

  const block = tagOpBlock(reader, { issueRunning, busyOp });
  const locked = busy !== null;
  const card = isCardReady(reader) ? reader!.card! : null;
  const plan: FactoryPlan | null = useMemo(() => (target ? planFactoryReset(target) : null), [target]);
  const otherOnReader = !!target && !!card && card.uid.toUpperCase() !== target.uid.toUpperCase();

  const readWhy = block ? opText(block) : null;
  const runWhy: string | null = !target || !plan
    ? null
    : block
      ? opText(block)
      : otherOnReader
        ? t('factory.why.otherTag')
        : plan.block === 'interrupted'
          ? t('factory.why.incomplete')
          : plan.block
            ? t('factory.why.block')
            : !advanced
              ? t('factory.why.advanced')
              : plan.writes.length === 0
                ? t('factory.already')
                : null;

  /** Clear this screen's own write result only (D15: another screen's stays there). */
  function clearOwnResult() {
    if (useAppStore.getState().lastWrite?.view === 'factory') setLastWrite(null);
  }

  async function read() {
    if (locked) return;
    setBusy('read');
    try {
      const img = await readTarget({});
      if (!img) return;
      setTarget(img);
      clearOwnResult();
    } finally {
      setBusy(null);
    }
  }

  function exit() {
    if (locked) return;
    setTarget(null);
    clearOwnResult();
  }

  async function reset() {
    if (!target || locked || runWhy) return;
    setBusy('reset');
    try {
      const fresh = await readTarget({});
      if (!fresh) return;
      if (fresh.uid.toUpperCase() !== target.uid.toUpperCase()) {
        toast({ tone: 'warn', title: t('factory.why.otherTag') });
        return;
      }
      if (!sameContent(fresh, target)) {
        setTarget(fresh);
        toast({ tone: 'warn', title: t('factory.changed') });
        return;
      }
      const p = planFactoryReset(fresh);
      if (p.block || p.writes.length === 0) return;
      const isPage = specFor(fresh.kind).unit === 'page';
      const details = [t(isPage ? 'factory.writes.pages' : 'factory.writes.blocks', { n: p.writes.length })];
      for (const a of p.areas) details.push(areaText(t, fresh, lang, a.area, a.units));
      for (const i of p.issues) details.push(issueText(t, fresh, lang, i));
      const req: WriteRequest = { kind: fresh.kind, expectedUid: fresh.uid, writes: p.writes, allowProtected: true, verify: true };
      const res = await writeWithConfirm(req, {
        title: t('factory.cf.title'),
        message: t('factory.cf.message', { uid: formatUid(fresh.uid), kind: kindLabel(fresh.kind) }),
        confirmLabel: t('factory.run'),
        details,
        dangerous: true,
        typeToConfirm: t('factory.cf.word'),
        target: { kind: fresh.kind, uid: fresh.uid, other: false },
        reactivateAfter: p.reactivate,
        // D15: no document (this screen reads its own target; another screen's document is never touched).
        doc: null,
        docCopy: false,
        keepUnitsOnFailure: [],
        successTitle: t('factory.done'),
      });
      if (!res) return;
      const after = await readTarget({});
      if (after && after.uid.toUpperCase() === fresh.uid.toUpperCase()) setTarget(after);
    } finally {
      setBusy(null);
    }
  }

  const isPage = target ? specFor(target.kind).unit === 'page' : true;

  return (
    <Page>
      <PageHeader title={t('factory.title')} subtitle={t('factory.subtitle')} helpTopic="factory" />
      <div className="stack-lg">
        <Callout tone="danger" icon={ShieldAlert}>
          {t('factory.scope')}
        </Callout>
        {!advanced ? (
          <Callout tone="info" icon={Lock}>
            <div>{t('factory.advanced')}</div>
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Button size="sm" icon={Settings} onClick={() => setView('settings')} data-testid="factory-open-settings">
                {t('factory.openSettings')}
              </Button>
            </div>
          </Callout>
        ) : null}

        {!target || !plan ? (
          <Card>
            <div data-testid="factory-entry">
              <EmptyState icon={RotateCcw} title={t('factory.entry.title')}>
                <p className="muted">{t('factory.entry.body')}</p>
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
                      data-testid="factory-read"
                    >
                      {t('factory.read')}
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
              title={t('factory.tag.title')}
              icon={Tag}
              actions={
                <Button size="sm" icon={Nfc} loading={busy === 'read'} disabled={!!readWhy || locked} onClick={() => void read()} data-testid="factory-reread">
                  {t('factory.reread')}
                </Button>
              }
            >
              <div className="stack" data-testid="factory-tag">
                <KeyValue
                  items={[
                    [t('factory.tag.kind'), kindLabel(target.kind)],
                    [idName(target.kind), <span key="uid" className="mono" data-testid="factory-uid">{formatUid(target.uid)}</span>],
                    [t('factory.tag.readAt'), whenLabel(target.readAt, lang)],
                  ]}
                />
                <TagOnReader compact readThis={false} />
                {otherOnReader && card ? (
                  <Callout tone="warn">{t('factory.otherTag', { now: formatUid(card.uid), read: formatUid(target.uid) })}</Callout>
                ) : null}
                {plan.block === 'password' ? (
                  <Callout tone="danger" title={t('factory.why.block')}>
                    <span data-testid="factory-block">{t('factory.block.password')}</span>
                  </Callout>
                ) : null}
                {plan.block === 'interrupted' ? (
                  <Callout tone="warn">
                    <span data-testid="factory-block">{t('factory.block.interrupted')}</span>
                  </Callout>
                ) : null}
              </div>
            </Card>

            {!plan.block ? (
              <>
                <Card title={t('factory.restore.title')} icon={RotateCcw}>
                  <div className="stack" data-testid="factory-restore">
                    {plan.alreadyFactory ? <Callout tone="ok">{t('factory.already')}</Callout> : null}
                    <ul className="erase-list">
                      {plan.areas.map((a) => (
                        <li key={a.area} data-area={a.area}>
                          {areaText(t, target, lang, a.area, a.units)}
                        </li>
                      ))}
                    </ul>
                    <div>
                      <Badge tone="neutral">{t(isPage ? 'factory.writes.pages' : 'factory.writes.blocks', { n: plan.writes.length })}</Badge>
                    </div>
                  </div>
                </Card>
                <Card title={t('factory.cannot.title')} icon={Lock}>
                  <div data-testid="factory-cannot">
                    {plan.issues.length === 0 ? (
                      <p className="muted">{t('factory.cannot.none')}</p>
                    ) : (
                      <ul className="erase-list">
                        {plan.issues.map((i, k) => (
                          <li key={k} data-issue={i.code}>
                            {issueText(t, target, lang, i)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Card>
              </>
            ) : null}

            <div className="erase-run">
              <LastWriteCallout />
              <div className="row">
                <span className="muted small grow" data-testid="factory-why">
                  {runWhy ?? ''}
                </span>
                {/* D14: back to the start, right next to the main action on every tag screen (nothing is unsaved here). */}
                <ExitButton dirty={false} disabled={locked} onExit={exit} testId="factory-exit" />
                <Button
                  variant="danger"
                  icon={RotateCcw}
                  loading={busy === 'reset'}
                  disabled={!!runWhy || locked}
                  onClick={(e) => {
                    if (e.detail > 1) return;
                    void reset();
                  }}
                  data-testid="factory-run"
                >
                  {t('factory.run')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
