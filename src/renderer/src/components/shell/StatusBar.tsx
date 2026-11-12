// Bottom status bar. Owner: agent "shell-ui".
// Shows the reader read/write ACTUALLY use (ReaderStatus.activeReader, never
// readers[0]), the state of the tag on it, "in use by another app", unsaved
// changes and the virtual reader (2026-11-12 UX audit CARD-7/11, FIRST-5/20).
// Starting up / no reader yet is not shown as a red "service stopped" (CARD-8).
// Text only: nothing here navigates (the left nav is the way to move).
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CircleDot, CreditCard, Loader2, PencilLine, Usb } from 'lucide-react';
import { useAppStore, dirtyUnits } from '../../store/app';
import { specFor } from '@shared/tags';
import { useT } from '../../i18n';
import type { TFunc } from '../../i18n';
import { formatUid, kindLabel } from '../../lib/format';
import { statusReader, statusReaderTone } from './readerModel';
import type { StatusReader, StatusTone } from './readerModel';

function readerText(t: TFunc, r: StatusReader): string {
  switch (r.kind) {
    case 'starting':
      return t('shell.status.starting');
    case 'init-failed':
      return t('shell.status.initFailed');
    case 'virtual':
      return t('shell.status.virtual');
    case 'reader':
      return t(r.fixed ? 'shell.status.readerFixed' : 'shell.status.readerAuto', { name: r.name });
    case 'problem':
      switch (r.problem.kind) {
        case 'starting':
          return t('shell.status.starting');
        case 'selected-missing':
          return t('shell.status.selectedMissing', { name: r.problem.name });
        case 'tokens-only':
          return t('shell.status.tokensOnly');
        case 'service-error':
          return t('shell.status.serviceError');
        case 'connect':
          return t('shell.status.connect');
      }
  }
}

function Item({ tone, icon: Icon, children, title, testId, spin }: { tone: StatusTone; icon: LucideIcon; children: string; title?: string; testId?: string; spin?: boolean }) {
  return (
    <span className={`status-item status-${tone}`} title={title ?? children} data-testid={testId}>
      <Icon size={13} aria-hidden className={spin ? 'spin' : undefined} />
      <span className="status-text">{children}</span>
    </span>
  );
}

export function StatusBar() {
  const t = useT();
  const ready = useAppStore((s) => s.ready);
  const initError = useAppStore((s) => s.initError);
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const issueRunning = useAppStore((s) => s.issue.running);
  const issued = useAppStore((s) => s.issue.issued);
  // While a confirmation is open (discard edits? write here?) nothing touches the
  // tag yet: do not say "reading / writing, keep the tag on the reader".
  const asking = useAppStore((s) => s.dialogs.length > 0);
  const doc = useAppStore((s) => s.doc);

  const r = statusReader(reader, { ready, initError });
  const tone = statusReaderTone(r);
  const rText = readerText(t, r);
  const readerTitle = r.kind === 'reader' ? t('shell.status.readerTitle', { name: r.name }) : rText;
  const inUse = (r.kind === 'reader' || r.kind === 'virtual') && r.inUse;

  // Tag on the ACTIVE reader.
  let cardItem: { tone: StatusTone; text: string } | null = null;
  if (reader && (r.kind === 'reader' || r.kind === 'virtual')) {
    const card = reader.card;
    switch (reader.cardState) {
      case 'absent':
        cardItem = { tone: 'neutral', text: t('shell.status.tagAbsent') };
        break;
      case 'detecting':
        cardItem = { tone: 'info', text: t('shell.status.tagDetecting') };
        break;
      case 'ready':
        if (card && card.kind) {
          const vars = { kind: kindLabel(card.kind), uid: formatUid(card.uid) };
          cardItem = { tone: 'ok', text: t(card.kindSource === 'manual' ? 'shell.status.cardManual' : 'shell.status.card', vars) };
        } else {
          cardItem = { tone: 'warn', text: t('shell.status.tagUnsupported') };
        }
        break;
      case 'unsupported':
        cardItem = { tone: 'warn', text: t('shell.status.tagUnsupported') };
        break;
      case 'error':
        cardItem = { tone: 'danger', text: t('shell.status.tagError') };
        break;
      case 'no-reader':
        cardItem = null;
        break;
    }
  }

  // What is running.
  let busyText: string | null = null;
  const uiOp = asking ? null : busyOp;
  if (uiOp === 'read' || reader?.busy?.op === 'read') busyText = t('shell.status.reading');
  else if (uiOp === 'write' || reader?.busy?.op === 'write') busyText = t('shell.status.writing');
  else if (issueRunning || reader?.busy?.op === 'issue') busyText = t('shell.status.issuing', { n: issued });
  else if (reader?.busy?.op === 'format') busyText = t('shell.status.formatting');

  const dirty = dirtyUnits(doc).length;
  const dirtyText =
    dirty > 0 && doc
      ? t(specFor(doc.image.kind).unit === 'page' ? 'shell.status.dirtyPages' : 'shell.status.dirtyBlocks', { n: dirty })
      : null;

  // The virtual reader is on but a real reader is in use (no virtual tag): say it is on.
  // When the virtual reader IS the active one, the left item already says so (WALK-17).
  const simOnNotActive = !!reader?.simulator.enabled && r.kind !== 'virtual';

  return (
    <footer className="app-status" data-testid="statusbar" aria-label={t('shell.status.label')}>
      <Item tone={tone} icon={Usb} title={readerTitle} testId="status-reader">
        {rText}
      </Item>
      {inUse ? (
        <Item tone="warn" icon={AlertTriangle} testId="status-in-use">
          {t('shell.status.inUse')}
        </Item>
      ) : null}
      {cardItem ? (
        <Item tone={cardItem.tone} icon={CreditCard} testId="status-card">
          {cardItem.text}
        </Item>
      ) : null}
      {reader?.ignoredRealReader ? (
        <Item tone="warn" icon={AlertTriangle} title={reader.ignoredRealReader} testId="status-ignored">
          {t('shell.status.ignored')}
        </Item>
      ) : null}
      <span className="grow" />
      {busyText ? (
        <Item tone="info" icon={Loader2} spin testId="status-busy">
          {busyText}
        </Item>
      ) : null}
      {dirtyText ? (
        <Item tone="warn" icon={PencilLine} testId="status-dirty">
          {dirtyText}
        </Item>
      ) : null}
      {simOnNotActive ? (
        <Item tone="accent" icon={CircleDot} testId="status-sim">
          {t('shell.status.simOn')}
        </Item>
      ) : null}
    </footer>
  );
}
