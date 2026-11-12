// Read / landing screen. Owner: agent "shell-ui".
//
// Two panels that are never mixed (2026-11-12 UX audit FIRST-3, FLOW-10):
//  - "Tag on the reader": the live state of the ACTIVE reader's tag and what to
//    do now (place it / checking / ready [Read] / unsupported / unreadable /
//    no reader + how to fix it).
//  - "Open document": what was read or opened (source, type, UID/IDm, capacity,
//    NDEF, unsaved changes) and where to use it.
// The virtual reader lives in a collapsed "Try it (no hardware)" section.
//
// 2026-11-12 review (round 2):
//  - R-UX-9: buttons that go to another screen to fix a prerequisite (register a
//    MIFARE key, enter the NTAG password, choose the reader) start a resolve trip
//    (navHistory.goResolve) so the target screen offers "back to Read".
//  - R-UX-1 / D11: what to do about password pages depends on the reader - a
//    storage-only reader (Sony PaSoRi) cannot authenticate at all.
//  - R-UX-4 / D9: the automatic read tries only the public standard keys; MIFARE
//    sectors it could not open get "Read with registered keys" (a manual read).
//  - E2E-UX-9: starting the trial no longer scrolls down to the virtual-reader
//    panel (that cut off the "using the virtual reader" note and the document).
import { Fragment, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Archive,
  Binary,
  CheckCircle2,
  CircleHelp,
  FileCode2,
  FileText,
  FolderOpen,
  Loader2,
  Nfc,
  RefreshCw,
  ScanLine,
  Settings as SettingsIcon,
  Stamp,
  Usb,
  X,
  KeyRound,
} from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, specFor } from '@shared/tags';
import { importDump } from '@shared/tag';
import { errorMessage } from '@shared/errorMessages';
import { Badge, Button, Callout, Card, EmptyState, Field, KeyValue, Page, PageHeader, Segmented, Select, Switch } from '../../components/ui';
import { TagOnReader, useOpBlockText } from '../../components/TagOnReader';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { dumpOpenFilters } from '../../lib/fileFilters';
import { api } from '../../lib/api';
import { readCurrentTag } from '../../lib/ops';
import { activeReaderInfo, tagOpBlock } from '../../lib/readerState';
import { formatDateTime, formatUid, kindLabel } from '../../lib/format';
import { deniedHelp, docSummary, errorFollowUp, tagGuide } from '../../components/shell/readerModel';
import type { CardFamily, ReaderProblem, TagGuide } from '../../components/shell/readerModel';
import { useReaderActions } from '../../components/shell/readerActions';
import { goResolve } from '../../components/shell/navHistory';
import './home.css';

type GuideTone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

/** UID / IDm that wraps only between bytes (WALK-18), never inside one. */
export function UidText({ uid }: { uid: string }) {
  const parts = formatUid(uid).split(':');
  return (
    <span className="mono home-uid" data-testid="uid-text">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <>
              :<wbr />
            </>
          ) : null}
          {p}
        </Fragment>
      ))}
    </span>
  );
}

const FAMILY_KEY: Record<Exclude<CardFamily, null>, MsgKey> = {
  type2: 'home.family.type2',
  felica: 'home.family.felica',
  mifare: 'home.family.mifare',
};

export function HomeView() {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const doc = useAppStore((s) => s.doc);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const setView = useAppStore((s) => s.setView);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const openImage = useAppStore((s) => s.openImage);
  const closeDoc = useAppStore((s) => s.closeDoc);
  const guardDiscard = useAppStore((s) => s.guardDiscard);
  const actions = useReaderActions();

  const [localReading, setLocalReading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [simOpen, setSimOpen] = useState<boolean | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // While a confirmation is open (e.g. "discard unsaved changes?") nothing is read yet:
  // do not say "reading - keep the tag on the reader".
  const asking = useAppStore((s) => s.dialogs.length > 0);
  const guide = tagGuide(reader, doc, { issueRunning, busyOp: asking ? null : busyOp, localReading: localReading && !asking });
  const active = activeReaderInfo(reader);
  const simEnabled = !!reader?.simulator.enabled;

  async function onRead() {
    setLocalReading(true);
    try {
      await readCurrentTag();
    } finally {
      setLocalReading(false);
    }
  }

  async function onOpenFile() {
    if (!(await guardDiscard())) return;
    setOpening(true);
    try {
      const res = await api.openFile({ title: t('home.openFile.title'), filters: dumpOpenFilters(t) });
      if (!res) return;
      let parsed: ReturnType<typeof importDump>;
      try {
        parsed = importDump(res.name, res.bytes);
      } catch {
        toast({ tone: 'danger', title: t('home.openFile.failed'), detail: t('file.openFailed.body', { name: res.name }) });
        return;
      }
      openImage(parsed.image, { type: 'file', name: res.name, token: res.token, format: parsed.format });
      toast({ tone: 'ok', title: t('home.openFile.opened', { name: res.name }), detail: parsed.note ? t('home.openFile.note', { note: parsed.note }) : undefined });
      setView('hex');
    } catch (err) {
      toastError(err);
    } finally {
      setOpening(false);
    }
  }

  async function onCloseDoc() {
    if (await guardDiscard()) closeDoc();
  }

  async function startTrial() {
    await actions.startTrial();
    setSimOpen(true);
    // E2E-UX-9: stay at the top - the "using the virtual reader" note and the
    // document read from the virtual tag appear there. Scrolling down to the
    // (now open) virtual-reader panel cut both off.
    requestAnimationFrame(() => gridRef.current?.closest('.page')?.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  return (
    <Page>
      <PageHeader title={t('home.title')} subtitle={t('home.subtitle')} helpTopic="read" />

      {active?.virtual ? (
        <div data-testid="home-sim-active">
          <Callout tone="info" title={t('home.sim.activeTitle')}>
            <div className="stack">
              <span>{t('home.sim.activeBody')}</span>
              <div className="row">
                <Button size="sm" onClick={() => void actions.stopTrial()}>
                  {t('home.sim.turnOff')}
                </Button>
              </div>
            </div>
          </Callout>
        </div>
      ) : null}

      <div className="home-grid" ref={gridRef}>
        <section className="home-panel" data-testid="home-tag" data-guide={guide.kind}>
          <Card title={t('home.tagPanel')} icon={Nfc}>
            <div className="stack">
              {/* The guide below has its own "Read this tag" button (no second one in TagOnReader). */}
              {reader ? <TagOnReader readThis={false} /> : null}
              <TagGuideBlock guide={guide} onRead={onRead} onTrial={startTrial} />
            </div>
          </Card>
        </section>

        <section className="home-panel" data-testid="home-doc">
          <Card title={t('home.docPanel')} icon={FileText}>
            <DocPanel opening={opening} onOpenFile={onOpenFile} onCloseDoc={onCloseDoc} />
          </Card>
        </section>
      </div>

      <SimulatorPanel open={simOpen ?? simEnabled} onToggle={setSimOpen} />

      <Callout tone="info">{t('home.uidNote')}</Callout>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Tag on the reader: what to do now
// ---------------------------------------------------------------------------

function GuideFrame({
  tone,
  icon: Icon,
  spin,
  title,
  children,
  testId,
}: {
  tone: GuideTone;
  icon: LucideIcon;
  spin?: boolean;
  title: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="home-guide" data-tone={tone} data-testid={testId ?? 'home-guide'}>
      <span className="home-guide-icon">
        <Icon size={22} aria-hidden className={spin ? 'spin' : undefined} />
      </span>
      <div className="grow stack">
        <div className="home-guide-title" role="status">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function TroubleList() {
  const t = useT();
  return (
    <details className="home-details" data-testid="home-trouble">
      <summary>{t('home.trouble.title')}</summary>
      <ul className="home-list">
        <li>{t('home.trouble.unplug')}</li>
        <li>{t('home.trouble.port')}</li>
        <li>{t('home.trouble.driver')}</li>
        <li>{t('home.trouble.service')}</li>
      </ul>
    </details>
  );
}

function NoReaderGuide({ problem, onTrial }: { problem: ReaderProblem; onTrial: () => void }) {
  const t = useT();
  const setView = useAppStore((s) => s.setView);
  const actions = useReaderActions();
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      await actions.refresh();
    } finally {
      setBusy(false);
    }
  }

  const fixButtons = (
    <div className="row home-actions">
      <Button icon={RefreshCw} onClick={refresh} loading={busy} data-testid="home-refresh">
        {t('home.action.refresh')}
      </Button>
      <Button icon={Nfc} onClick={onTrial} data-testid="home-try-sim">
        {t('home.action.trySim')}
      </Button>
      <Button variant="ghost" icon={CircleHelp} onClick={() => setView('help', { helpTopic: 'reader' })}>
        {t('home.action.openHelp')}
      </Button>
    </div>
  );

  switch (problem.kind) {
    case 'starting':
      return <GuideFrame tone="neutral" icon={Loader2} spin title={t('home.starting.title')} />;
    case 'selected-missing':
      return (
        <GuideFrame tone="warn" icon={Usb} title={t('home.selectedMissing.title')} testId="home-guide">
          <p>{t('home.selectedMissing.body', { name: problem.name })}</p>
          <div className="row home-actions">
            <Button variant="primary" onClick={() => void actions.backToAuto()} data-testid="home-back-to-auto">
              {t('home.action.backToAuto')}
            </Button>
            <Button icon={RefreshCw} onClick={refresh} loading={busy}>
              {t('home.action.refresh')}
            </Button>
          </div>
        </GuideFrame>
      );
    case 'tokens-only':
      return (
        <GuideFrame tone="warn" icon={Usb} title={t('home.tokensOnly.title')}>
          <p>{t('home.tokensOnly.body', { names: problem.names.join(' / ') })}</p>
          <p className="muted small">{t('home.connect.simHint')}</p>
          {fixButtons}
          {/* D10: only for a real NFC reader whose name is not recognised. */}
          <div className="stack-tight">
            <span className="small muted">{t('home.tokensOnly.selectHint')}</span>
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                icon={SettingsIcon}
                onClick={() => goResolve('settings', { returnTo: 'home', reason: 'reader-select' })}
                data-testid="home-tokens-to-settings"
              >
                {t('home.tokensOnly.toSettings')}
              </Button>
            </div>
          </div>
          <TroubleList />
        </GuideFrame>
      );
    case 'service-error':
      return (
        <GuideFrame tone="danger" icon={Usb} title={t('home.serviceError.title')}>
          <p>{t('home.serviceError.body')}</p>
          {problem.message ? <p className="muted small">{t('home.serviceError.detail', { message: problem.message })}</p> : null}
          {fixButtons}
          <TroubleList />
        </GuideFrame>
      );
    case 'connect':
      return (
        <GuideFrame tone="neutral" icon={Usb} title={t('home.connect.title')}>
          <p>{t('home.connect.body')}</p>
          <p className="muted small">{t('home.connect.simHint')}</p>
          {fixButtons}
          <TroubleList />
        </GuideFrame>
      );
  }
}

function ManualKind({ current }: { current: TagKind | null }) {
  const t = useT();
  const toastError = useAppStore((s) => s.toastError);
  const [kind, setKind] = useState<TagKind>(current ?? 'NTAG215');
  return (
    <details className="home-details" data-testid="home-manual-kind">
      <summary>{t('home.manualKind.summary')}</summary>
      <div className="stack home-details-body">
        <p className="small">{t('home.manualKind.body')}</p>
        <div className="row">
          <Field label={t('home.manualKind.label')}>
            <Select<TagKind> value={kind} onChange={setKind} options={TAG_KINDS.map((k) => ({ value: k, label: specFor(k).displayName }))} />
          </Field>
        </div>
        <div className="row">
          <Button size="sm" onClick={() => void api.setManualKind(kind).catch(toastError)}>
            {t('home.manualKind.apply')}
          </Button>
        </div>
      </div>
    </details>
  );
}

function ManualKindActive({ kind }: { kind: TagKind }) {
  const t = useT();
  const toastError = useAppStore((s) => s.toastError);
  return (
    <div className="row small">
      <Badge tone="warn">{t('home.manualKind.active', { kind: kindLabel(kind) })}</Badge>
      <Button size="sm" variant="ghost" onClick={() => void api.setManualKind(null).catch(toastError)}>
        {t('home.manualKind.reset')}
      </Button>
    </div>
  );
}

function TagGuideBlock({ guide, onRead, onTrial }: { guide: TagGuide; onRead: () => void; onTrial: () => void }) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const autoRead = useAppStore((s) => s.settings.autoRead);
  const lang = useAppStore((s) => s.settings.language);
  const blockText = useOpBlockText();
  const block = tagOpBlock(reader, { issueRunning, busyOp });

  const readButton = (label: MsgKey, primary: boolean) => (
    <div className="stack home-actions">
      <div className="row">
        <Button variant={primary ? 'primary' : 'secondary'} size={primary ? 'lg' : 'md'} icon={ScanLine} onClick={onRead} disabled={block !== null} data-testid="home-read">
          {t(label)}
        </Button>
      </div>
      {block ? <span className="small muted" data-testid="home-read-blocked">{blockText(block)}</span> : null}
    </div>
  );

  switch (guide.kind) {
    case 'no-reader':
      return <NoReaderGuide problem={guide.problem} onTrial={onTrial} />;
    case 'issuing':
      return (
        <GuideFrame tone="info" icon={Stamp} title={t('home.issuing.title')}>
          <p>{t('home.issuing.body')}</p>
        </GuideFrame>
      );
    case 'reading':
      return (
        <GuideFrame tone="info" icon={Loader2} spin title={t('home.reading.title')}>
          <p>{t('home.reading.body')}</p>
        </GuideFrame>
      );
    case 'writing':
      return (
        <GuideFrame tone="info" icon={Loader2} spin title={t('home.writing.title')}>
          <p>{t('home.writing.body')}</p>
        </GuideFrame>
      );
    case 'busy':
      return <GuideFrame tone="info" icon={Loader2} spin title={t('home.busy.title')} />;
    case 'place':
      return (
        <GuideFrame tone="neutral" icon={ScanLine} title={t('home.place.title')}>
          <p>{t('home.place.body')}</p>
          <p className="home-emph">{guide.virtual ? t('home.place.virtual') : autoRead ? t('home.place.auto') : t('home.place.manual')}</p>
        </GuideFrame>
      );
    case 'detecting':
      return (
        <GuideFrame tone="info" icon={Loader2} spin title={t('home.detecting.title')}>
          <p>{t(guide.retrying ? 'home.detecting.retry' : 'home.detecting.body')}</p>
        </GuideFrame>
      );
    case 'unsupported':
      return (
        <GuideFrame tone="warn" icon={AlertTriangle} title={t('home.unsupported.title')}>
          <p>{t('home.unsupported.body')}</p>
          {guide.family ? <p className="small muted">{t('home.unsupported.family', { family: t(FAMILY_KEY[guide.family]) })}</p> : null}
          {reader?.card ? <ManualKind current={reader.card.kind} /> : null}
        </GuideFrame>
      );
    case 'error':
      return (
        <GuideFrame tone="danger" icon={AlertTriangle} title={t('home.error.title')}>
          <p>{errorMessage(guide.error, lang)}</p>
          {errorFollowUp(guide.error) === 'retry' ? <p className="small muted">{t('home.error.retryHint')}</p> : null}
          {errorFollowUp(guide.error) === 'protected' ? (
            <p className="small muted" data-testid="home-error-protected">
              {t('home.error.protectedHint')}
            </p>
          ) : null}
        </GuideFrame>
      );
    case 'ready-new':
      return (
        <GuideFrame tone="ok" icon={CheckCircle2} title={t('home.readyNew.title', { kind: kindLabel(guide.card.kind) })}>
          <p>{t('home.readyNew.body')}</p>
          {guide.card.kindSource === 'manual' && guide.card.kind ? <ManualKindActive kind={guide.card.kind} /> : null}
          {readButton('home.read', true)}
        </GuideFrame>
      );
    case 'ready-same':
      return (
        <GuideFrame tone="ok" icon={CheckCircle2} title={t('home.readySame.title')}>
          <p>{t('home.readySame.body')}</p>
          {guide.card.kindSource === 'manual' && guide.card.kind ? <ManualKindActive kind={guide.card.kind} /> : null}
          {readButton('home.readAgain', false)}
        </GuideFrame>
      );
    case 'ready-other': {
      const body =
        guide.docSource === 'card'
          ? t('home.readyOther.bodyCard', { uid: formatUid(guide.card.uid), docUid: formatUid(guide.docUid ?? '') })
          : guide.docSource === 'file'
            ? t('home.readyOther.bodyFile')
            : t('home.readyOther.bodyNew');
      return (
        <GuideFrame tone="warn" icon={AlertTriangle} title={t('home.readyOther.title')}>
          <p>{body}</p>
          {guide.dirty ? <p className="small">{t('home.readyOther.dirty')}</p> : null}
          {guide.card.kindSource === 'manual' && guide.card.kind ? <ManualKindActive kind={guide.card.kind} /> : null}
          {readButton('home.readThis', true)}
        </GuideFrame>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Open document
// ---------------------------------------------------------------------------

/**
 * What to do about pages / sectors that needed a password or key.
 *  - NTAG (R-UX-1, D11): a storage-only reader (Sony PaSoRi) cannot authenticate,
 *    so "enter the password in the binary editor" would be a false promise there.
 *  - MIFARE (R-UX-4, D9): the automatic read tries only the public standard keys;
 *    "Read with registered keys" is a manual read (every registered key), and
 *    "Register a MIFARE key" goes to the keys screen with a way back.
 */
function DeniedHint({ kind }: { kind: TagKind }) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const autoRead = useAppStore((s) => s.settings.autoRead !== false);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const setView = useAppStore((s) => s.setView);
  const blockText = useOpBlockText();
  const [reading, setReading] = useState(false);
  const help = deniedHelp(kind, reader, autoRead);

  if (help.kind === 'ntag') {
    if (help.auth === 'no') {
      return (
        <>
          <span className="small" data-testid="home-denied-hint" data-auth="no">
            {t('home.doc.deniedHint.ntagStorage')}
          </span>
          <div className="row">
            <Button size="sm" variant="ghost" icon={CircleHelp} onClick={() => setView('help', { helpTopic: 'reader' })} data-testid="home-denied-help">
              {t('home.doc.deniedAction.readerHelp')}
            </Button>
          </div>
        </>
      );
    }
    return (
      <>
        <span className="small" data-testid="home-denied-hint" data-auth={help.auth}>
          {t(help.auth === 'yes' ? 'home.doc.deniedHint.ntag' : 'home.doc.deniedHint.ntagUnknown')}
        </span>
        <div className="row">
          <Button
            size="sm"
            icon={KeyRound}
            onClick={() => goResolve('hex', { returnTo: 'home', reason: 'ntag-password' })}
            data-testid="home-denied-to-hex"
          >
            {t('home.doc.deniedAction.ntag')}
          </Button>
        </div>
      </>
    );
  }

  if (help.kind === 'mifare') {
    const block = tagOpBlock(reader, { issueRunning, busyOp });
    const readWithKeys = async () => {
      setReading(true);
      try {
        // A manual read tries every registered key (D9).
        await readCurrentTag();
      } finally {
        setReading(false);
      }
    };
    return (
      <>
        <span className="small" data-testid="home-denied-hint">
          {t(help.autoRead ? 'home.doc.deniedHint.mifare' : 'home.doc.deniedHint.mifareManual')}
        </span>
        <div className="row">
          <Button size="sm" variant="primary" icon={ScanLine} onClick={readWithKeys} loading={reading} disabled={block !== null} data-testid="home-denied-read-keys">
            {t('home.doc.deniedAction.readWithKeys')}
          </Button>
          <Button
            size="sm"
            icon={KeyRound}
            onClick={() => goResolve('keys', { returnTo: 'home', reason: 'mifare-keys', reread: true })}
            data-testid="home-denied-to-keys"
          >
            {t('home.doc.deniedAction.mifare')}
          </Button>
        </div>
        {block ? <span className="small muted">{blockText(block)}</span> : null}
      </>
    );
  }

  return null;
}

function DocPanel({ opening, onOpenFile, onCloseDoc }: { opening: boolean; onOpenFile: () => void; onCloseDoc: () => void }) {
  const t = useT();
  const doc = useAppStore((s) => s.doc);
  const reader = useAppStore((s) => s.reader);
  const lang = useAppStore((s) => s.settings.language);
  const setView = useAppStore((s) => s.setView);
  const busyOp = useAppStore((s) => s.busyOp);

  const openButton = (
    <Button icon={FolderOpen} onClick={onOpenFile} loading={opening} disabled={busyOp !== null} data-testid="home-open-file">
      {t('home.openFile')}
    </Button>
  );

  if (!doc) {
    return (
      <EmptyState icon={FileText} title={t('home.doc.emptyTitle')} action={openButton}>
        {t('home.doc.emptyBody')}
      </EmptyState>
    );
  }

  const s = docSummary(doc, reader);
  const pages = s.unit === 'page';
  const source =
    doc.source.type === 'card'
      ? t('home.doc.sourceCard', { time: formatDateTime(doc.original.readAt, lang) })
      : doc.source.type === 'file'
        ? t('home.doc.sourceFile', { name: doc.source.name })
        : t('home.doc.sourceNew');

  const items: [ReactNode, ReactNode][] = [
    [t('home.doc.source'), <span key="src" data-testid="home-doc-source">{source}</span>],
    [t('home.doc.kind'), kindLabel(s.kind)],
    [t(s.idLabel === 'idm' ? 'home.idm' : 'home.uid'), <UidText key="uid" uid={s.uid} />],
    [t('home.doc.capacity'), t('common.bytes', { n: s.userBytes })],
  ];
  if (s.ndefApplicable) {
    const ndef =
      s.ndefRecords == null ? t('home.doc.ndefUnknown') : s.ndefRecords === 0 ? t('home.doc.ndefNone') : t('home.doc.ndefRecords', { n: s.ndefRecords });
    items.push([
      t('home.doc.ndef'),
      <span key="ndef" className="stack-tight">
        <span>{ndef}</span>
        {s.dirty > 0 ? <span className="small muted">{t('home.doc.ndefOriginal')}</span> : null}
      </span>,
    ]);
  }
  if (s.counter != null) items.push([t('home.doc.counter'), String(s.counter)]);
  items.push([
    t('home.doc.unsaved'),
    s.dirty > 0 ? (
      <Badge key="dirty" tone="warn">
        {t(pages ? 'home.doc.unsavedPages' : 'home.doc.unsavedBlocks', { n: s.dirty })}
      </Badge>
    ) : (
      t('home.doc.unsavedNone')
    ),
  ]);
  if (s.onReader !== 'not-applicable') {
    const where =
      s.onReader === 'on-reader' ? t('home.doc.onReader.on') : s.onReader === 'other-tag' ? t('home.doc.onReader.other') : t('home.doc.onReader.none');
    items.push([t('home.doc.onReader'), <span key="where" data-testid="home-doc-on-reader" data-where={s.onReader}>{where}</span>]);
  }

  return (
    <div className="stack" data-testid="home-doc-body">
      <KeyValue items={items} />
      {s.denied > 0 ? (
        <Callout tone="warn">
          <div className="stack" data-testid="home-denied">
            <span>{t(pages ? 'home.doc.deniedPages' : 'home.doc.deniedBlocks', { n: s.denied })}</span>
            {/* WRITE-18: say how to read them. R-UX-1 / R-UX-4: by reader and by key set. */}
            <DeniedHint kind={s.kind} />
          </div>
        </Callout>
      ) : null}
      {s.unread > 0 ? <Callout tone="warn">{t(pages ? 'home.doc.unreadPages' : 'home.doc.unreadBlocks', { n: s.unread })}</Callout> : null}
      {!s.ndefApplicable ? <p className="small muted">{t('home.doc.felicaNote')}</p> : null}
      <div className="row home-doc-actions">
        <Button icon={Binary} onClick={() => setView('hex')} data-testid="home-to-hex">
          {t('home.doc.toHex')}
        </Button>
        {s.ndefApplicable ? (
          <Button icon={FileCode2} onClick={() => setView('ndef')} data-testid="home-to-ndef">
            {t('home.doc.toNdef')}
          </Button>
        ) : null}
        <Button icon={Archive} onClick={() => setView('backup')} data-testid="home-to-backup">
          {t('home.doc.toBackup')}
        </Button>
      </div>
      <div className="row home-doc-actions">
        {openButton}
        <Button variant="ghost" icon={X} onClick={onCloseDoc} disabled={busyOp !== null} data-testid="home-close-doc">
          {t('home.doc.close')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Try it (no hardware): the virtual reader
// ---------------------------------------------------------------------------

function SimulatorPanel({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const toastError = useAppStore((s) => s.toastError);
  const actions = useReaderActions();
  const sim = reader?.simulator;
  const enabled = !!sim?.enabled;

  async function setEnabled(v: boolean) {
    if (v) await actions.startTrial();
    else await actions.stopTrial();
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
    <details
      className={`card home-sim${enabled ? ' is-on' : ''}`}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) onToggle(next);
      }}
      data-testid="home-sim"
    >
      <summary className="home-sim-summary">
        <Nfc size={16} aria-hidden />
        <span className="grow">{t('home.sim.title')}</span>
        {enabled ? <Badge tone="accent">{t('home.sim.on')}</Badge> : null}
      </summary>
      <div className="card-body stack">
        <p className="muted small">{t('home.sim.body')}</p>
        <Switch checked={enabled} onChange={(v) => void setEnabled(v)} label={t('home.sim.enable')} />
        {enabled ? (
          <>
            <Field label={t('home.sim.kind')}>
              <Select<TagKind>
                value={sim?.kind ?? 'NTAG215'}
                onChange={(k) => void setKind(k)}
                options={TAG_KINDS.map((k) => ({ value: k, label: specFor(k).displayName }))}
              />
            </Field>
            <div className="row">
              <Segmented<'on' | 'off'>
                ariaLabel={t('home.sim.tapLabel')}
                value={sim?.present ? 'on' : 'off'}
                onChange={(v) => void tap(v === 'on')}
                options={[
                  { value: 'on', label: t('home.sim.tapOn') },
                  { value: 'off', label: t('home.sim.tapOff') },
                ]}
              />
              <Button size="sm" onClick={() => void setKind(sim?.kind ?? 'NTAG215')}>
                {t('home.sim.newTag')}
              </Button>
            </div>
            <Badge tone={sim?.present ? 'ok' : 'neutral'}>{sim?.present ? t('home.sim.present') : t('home.sim.absent')}</Badge>
          </>
        ) : null}
      </div>
    </details>
  );
}
