// "The tag on the reader" - one shared component so every screen (home, binary,
// NDEF, backup) shows the same live state of the ACTIVE reader: which reader,
// whether a tag is on it, detecting / ready / unsupported / error, and the fix
// (retry, "turn the virtual reader off"...). Integrator-owned (renderer-core).
//
// CONTRACT (frozen props/exports; the implementation may be improved freely):
//   <TagOnReader compact? readThis? /> - live state + retry button. readThis
//                                        (default true): offer "read this tag"
//                                        for a tag that is not the open document;
//                                        a screen with its own such button passes
//                                        false (one button, not two - E2E-UX-3)
//   useOpBlockText()(block)            - localized reason a read/write button is disabled
//
// 2026-11-12 review round 2 (D9 / R-UX-4): a MIFARE document read by the auto-read
// (public standard keys only) with sectors it could not open offers "read with
// the registered keys" (a manual read: every key) while that tag is on the reader.
//
// 2026-11-12 UX audit CARD-1/3/9/14, FIRST-1/2/3/4: state of the reader main
// actually uses (never readers[0]); "placed but not read yet" is distinct from
// "read"; an unreadable tag says why and offers a retry; a tag ignored because
// the virtual reader takes precedence is called out; a missing selected reader
// offers "back to automatic".
import { useState } from 'react';
import { CircleAlert, KeyRound, Loader2, Nfc, RotateCw, ScanLine, ToggleLeft, Unplug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { errorMessage } from '@shared/errorMessages';
import { isMifare } from '@shared/tags';
import { useAppStore } from '../store/app';
import type { TagDoc } from '../store/app';
import { api } from '../lib/api';
import { activeReaderInfo, tagOpBlock, type TagOpBlock } from '../lib/readerState';
import { deniedCount, readCurrentTag } from '../lib/ops';
import { formatUid, idName, kindLabel } from '../lib/format';
import { useT } from '../i18n';
import { Badge, Button } from './ui';
import type { Tone } from './ui';

export function useOpBlockText(): (block: TagOpBlock) => string {
  const t = useT();
  return (block) => t(`op.block.${block}`);
}

function useAsyncAction(): [boolean, (fn: () => Promise<unknown>) => void] {
  const [running, setRunning] = useState(false);
  const toastError = useAppStore((s) => s.toastError);
  return [
    running,
    (fn) => {
      if (running) return;
      setRunning(true);
      fn()
        .catch((err) => toastError(err))
        .finally(() => setRunning(false));
    },
  ];
}

/**
 * Pure: the open document is the tag on the reader, read by the auto-read with
 * the standard MIFARE keys only, and some sectors stayed closed (D9).
 */
export function offersRegisteredKeys(doc: TagDoc | null, cardUid: string | null): boolean {
  if (!doc || !doc.standardKeysOnly || doc.source.type !== 'card' || !cardUid) return false;
  if (!isMifare(doc.image.kind)) return false;
  return doc.source.uid.toUpperCase() === cardUid.toUpperCase() && deniedCount(doc.original) > 0;
}

export function TagOnReader({ compact = false, readThis = true }: { compact?: boolean; readThis?: boolean }) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const lang = useAppStore((s) => s.settings.language);
  const doc = useAppStore((s) => s.doc);
  const issueRunning = useAppStore((s) => s.issue.running);
  const busyOp = useAppStore((s) => s.busyOp);
  const saveSettings = useAppStore((s) => s.saveSettings);
  // On the backup screen the tag on the reader is usually the write TARGET, and the
  // screen reads its source itself after asking "use this tag as the source?"
  // (FLOW-14). A one-click "read this tag" here silently replaced the source and
  // turned the duplicate into "nothing to write" (E2E 2026-11-12, e07 E7b).
  const onBackup = useAppStore((s) => s.view === 'backup');
  const [working, run] = useAsyncAction();

  const active = activeReaderInfo(reader);
  const card = reader?.card ?? null;
  const state = reader?.cardState ?? 'no-reader';
  const selectedMissing = reader?.activeReason === 'selected-missing';
  const serviceDown = !reader || reader.service === 'unavailable' || reader.service === 'error';

  const tone: Tone = state === 'ready' ? 'ok' : state === 'error' || state === 'unsupported' ? 'danger' : state === 'detecting' ? 'info' : 'neutral';
  const icon: LucideIcon = state === 'detecting' ? Loader2 : state === 'ready' ? Nfc : state === 'no-reader' ? Unplug : state === 'absent' ? ScanLine : CircleAlert;
  // An unreadable tag whose UID was read (e.g. a read-protected NTAG, R-MAIN-4):
  // say which tag it is, so it does not look like "nothing / a broken tag".
  const label =
    state === 'ready' && card
      ? t('reader.state.ready', { kind: kindLabel(card.kind), idName: idName(card.kind), uid: formatUid(card.uid) })
      : (state === 'error' || state === 'unsupported') && card?.uid
        ? t('reader.state.withUid', { state: t(`reader.state.${state}`), idName: idName(card.kind), uid: formatUid(card.uid) })
        : t(`reader.state.${state}`);

  const readerName = active ? (active.virtual ? t('reader.virtual') : active.name) : null;

  // Why the tag is not usable, in plain words (with the fix).
  let hint: string | null = null;
  if (state === 'no-reader') {
    hint = selectedMissing
      ? t('reader.selectedMissing', { name: reader?.selectedReader ?? '' })
      : errorMessage(serviceDown ? 'NO_SERVICE' : 'NO_READER', lang);
  } else if (state === 'absent') hint = t('reader.hint.absent');
  else if (state === 'detecting') hint = t(reader?.cardRetrying ? 'reader.hint.detectingRetry' : 'reader.hint.detecting');
  else if (state === 'unsupported') hint = reader?.cardError && reader.cardError !== 'UNSUPPORTED_TAG' ? errorMessage(reader.cardError, lang) : t('reader.hint.unsupported');
  else if (state === 'error') hint = reader?.cardError ? errorMessage(reader.cardError, lang) : t('reader.hint.error');

  const canRetry = state === 'error' || state === 'unsupported';
  // The tag on the reader is not the open document (FIRST-3 / CARD-1). Not while
  // batch issuing: every tag issued is "another tag", the note would only confuse.
  const otherTag =
    !issueRunning &&
    !onBackup &&
    state === 'ready' &&
    !!card &&
    !!doc &&
    !(doc.source.type === 'card' && doc.source.uid.toUpperCase() === card.uid.toUpperCase());
  const readBlock = tagOpBlock(reader, { issueRunning, busyOp });
  const withKeys = !issueRunning && !onBackup && state === 'ready' && offersRegisteredKeys(doc, card?.uid ?? null);

  const retryButton = canRetry ? (
    <Button size="sm" icon={RotateCw} loading={working} onClick={() => run(() => api.reidentify())}>
      {t('reader.retry')}
    </Button>
  ) : null;
  const autoButton = selectedMissing ? (
    <Button
      size="sm"
      loading={working}
      onClick={() =>
        run(async () => {
          // D1: going back to automatic is the operator's choice; keep it after a restart too.
          await saveSettings((s) => ({ ...s, preferredReader: null }));
          await api.selectReader(null);
        })
      }
    >
      {t('reader.useAuto')}
    </Button>
  ) : null;
  const virtualOffButton = reader?.ignoredRealReader ? (
    <Button size="sm" icon={ToggleLeft} loading={working} onClick={() => run(() => api.setSimulator({ enabled: false, kind: reader.simulator.kind }))}>
      {t('reader.turnOffVirtual')}
    </Button>
  ) : null;
  const readThisButton =
    otherTag && readThis ? (
      <Button size="sm" icon={ScanLine} disabled={readBlock !== null} onClick={() => void readCurrentTag()}>
        {t('reader.readThis')}
      </Button>
    ) : null;
  // A manual read: every registered key is tried (D9).
  const withKeysButton = withKeys ? (
    <Button
      size="sm"
      icon={KeyRound}
      disabled={readBlock !== null}
      title={compact ? t('reader.keysHint') : undefined}
      onClick={() => void readCurrentTag()}
      data-testid="tag-on-reader-read-keys"
    >
      {t('reader.readWithKeys')}
    </Button>
  ) : null;

  if (compact) {
    return (
      <div className="tag-on-reader tag-on-reader-compact" data-testid="tag-on-reader" data-card-state={state} data-active-reason={reader?.activeReason ?? 'none'}>
        <Badge tone={tone} icon={icon} title={[readerName ? t('reader.using', { name: readerName }) : null, hint].filter(Boolean).join('\n') || undefined}>
          {label}
        </Badge>
        {reader?.ignoredRealReader ? (
          <Badge tone="warn" icon={CircleAlert} title={t('reader.ignoredReal', { name: reader.ignoredRealReader })}>
            {t('reader.virtual')}
          </Badge>
        ) : null}
        {retryButton}
        {autoButton}
        {readThisButton}
        {withKeysButton}
      </div>
    );
  }

  return (
    <div
      className="tag-on-reader"
      data-testid="tag-on-reader"
      data-card-state={state}
      data-active-reason={reader?.activeReason ?? 'none'}
      role="status"
      aria-live="polite"
    >
      <div className="tag-on-reader-head">
        <Badge tone={tone} icon={icon}>
          {label}
        </Badge>
        {readerName ? <span className="small muted">{t('reader.using', { name: readerName })}</span> : null}
      </div>
      {hint ? <div className={`tag-on-reader-hint${state === 'error' || state === 'unsupported' || selectedMissing ? ' is-problem' : ''}`}>{hint}</div> : null}
      {retryButton || autoButton ? (
        <div className="row">
          {retryButton}
          {autoButton}
        </div>
      ) : null}
      {reader?.ignoredRealReader ? (
        <div className="tag-on-reader-note is-warn" data-testid="tag-on-reader-ignored">
          <CircleAlert size={14} aria-hidden />
          <span className="grow">{t('reader.ignoredReal', { name: reader.ignoredRealReader })}</span>
          {virtualOffButton}
        </div>
      ) : null}
      {otherTag ? (
        <div className="tag-on-reader-note" data-testid="tag-on-reader-other">
          <CircleAlert size={14} aria-hidden />
          <span className="grow">{t('reader.otherTag')}</span>
          {readThisButton}
        </div>
      ) : null}
      {withKeys ? (
        <div className="tag-on-reader-note is-warn" data-testid="tag-on-reader-keys">
          <KeyRound size={14} aria-hidden />
          <span className="grow">{t('reader.keysHint')}</span>
          {withKeysButton}
        </div>
      ) : null}
    </div>
  );
}
