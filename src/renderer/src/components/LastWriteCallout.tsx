// The result of the last single-tag write, kept on screen until dismissed (a
// toast vanishes in seconds; a failed / partial write must stay visible).
// Integrator-owned (renderer-core). CONTRACT: <LastWriteCallout /> takes no props
// and renders nothing when there is no result. Views that write (binary, NDEF,
// backup) place it near their write button.
//
// 2026-11-12 UX audit WRITE-4 / WRITE-14 / FIRST-12: which pages / blocks were
// not written and why (plain words, never ErrorCodes), whether the tag is only
// partly written, where the result went (kind + UID, time), and - after writing
// protection settings - "take the tag off and place it again" until dismissed.
//
// 2026-11-12 review R-WRITE-5: the result of a write to ANOTHER tag (neither the
// open document's tag nor the tag on the reader - e.g. a backup duplicate) is
// folded under "previous write (another tag UID ...)" instead of sitting next to
// this document's write button in full; "write again with the same tag" is shown
// only for the open document's / placed tag, worded by whether it is placed. A
// success for another tag is cleared when a different tag is placed
// (lib/autoRead isStaleWriteResult).
import { RefreshCw, X } from 'lucide-react';
import type { ReaderStatus } from '@shared/types';
import { useAppStore } from '../store/app';
import type { TagDoc, WriteOutcome } from '../store/app';
import { isCardUid } from '../lib/readerState';
import { formatDateTime, formatUid, idName, kindLabel } from '../lib/format';
import { useT } from '../i18n';
import { Callout, IconButton } from './ui';

export interface WriteResultRelation {
  /** The result is about the open document's tag or the tag on the reader. */
  related: boolean;
  /** The written tag is on the reader now. */
  placed: boolean;
}

/** Pure: how the last write result relates to what is on screen. */
export function writeResultRelation(last: WriteOutcome, doc: TagDoc | null, reader: ReaderStatus | null): WriteResultRelation {
  const placed = !!last.uid && isCardUid(reader, last.uid);
  const docTag = !!last.uid && !!doc && doc.source.type === 'card' && doc.source.uid.toUpperCase() === last.uid.toUpperCase();
  // A write whose target is unknown (thrown before the UID was known) belongs here.
  return { related: !last.uid || placed || docTag, placed };
}

export function LastWriteCallout() {
  const t = useT();
  const last = useAppStore((s) => s.lastWrite);
  const doc = useAppStore((s) => s.doc);
  const reader = useAppStore((s) => s.reader);
  const setLastWrite = useAppStore((s) => s.setLastWrite);
  const lang = useAppStore((s) => s.settings.language);
  if (!last) return null;
  const rel = writeResultRelation(last, doc, reader);
  const id = idName(last.kind);
  const uid = last.uid ? formatUid(last.uid) : '-';
  const retry = last.retry && rel.related ? (rel.placed || !last.uid ? t('op.write.retrySameTag') : t('op.write.retryPlace', { idName: id, uid })) : null;

  const body = (
    <div className="last-write-body">
      <ul className="last-write-lines">
        {last.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
        {retry ? <li data-testid="last-write-retry">{retry}</li> : null}
      </ul>
      {last.reactivate ? (
        <div className="last-write-reactivate" data-testid="last-write-reactivate">
          <RefreshCw size={14} aria-hidden />
          <span>{t('op.write.reactivate')}</span>
        </div>
      ) : null}
      <div className="last-write-meta small">
        {t('lastWrite.meta', {
          time: formatDateTime(last.at, lang),
          kind: kindLabel(last.kind),
          idName: id,
          uid,
        })}
      </div>
    </div>
  );

  // data-toast-avoid: toasts keep clear of this result (Overlays moves them above it).
  return (
    <div
      className={`last-write${rel.related ? '' : ' is-other'}`}
      data-testid="last-write"
      data-tone={last.tone}
      data-related={rel.related ? undefined : 'false'}
      data-reactivate={last.reactivate || undefined}
      data-toast-avoid=""
    >
      {rel.related ? (
        <Callout tone={last.tone} title={last.title}>
          {body}
        </Callout>
      ) : (
        <details className="last-write-other">
          <summary>{t('lastWrite.other', { idName: id, uid, title: last.title })}</summary>
          {body}
        </details>
      )}
      <IconButton className="last-write-close" icon={X} size="sm" label={t('common.close')} onClick={() => setLastWrite(null)} />
    </div>
  );
}
