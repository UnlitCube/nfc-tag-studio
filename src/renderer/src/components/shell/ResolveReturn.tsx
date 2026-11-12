// "Back to <screen>" after a resolve trip (2026-11-12 review R-UX-9,
// business-app-ux §5.3: a button that moves to another screen to fix a
// prerequisite always comes with a way back). Owner: shell-ui (SHELL-HOME).
//
// CONTRACT: <ResolveReturn view="<this screen's ViewId>" compact? />
//   Renders nothing unless the operator was sent to `view` by goResolve()
//   (components/shell/navHistory.ts). Place it at the LEFT of the screen's run
//   bar; a screen without a run bar puts it at the end of the card the trip is
//   about. `compact` = one row, no hint line (for a run bar).
//   testids: resolve-return (data-reason), resolve-back, resolve-back-read.
import { ArrowLeft, ScanLine } from 'lucide-react';
import { Button } from '../ui';
import { useAppStore } from '../../store/app';
import type { ViewId } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { readCurrentTag } from '../../lib/ops';
import { tagOpBlock } from '../../lib/readerState';
import { useOpBlockText } from '../TagOnReader';
import { navLabelKey } from './Sidebar';
import { useResolveTrip } from './navHistory';
import type { ResolveReason } from './navHistory';

const HINT: Record<ResolveReason, MsgKey> = {
  'mifare-keys': 'shell.return.hint.mifareKeys',
  'ntag-password': 'shell.return.hint.ntagPassword',
  'reader-select': 'shell.return.hint.readerSelect',
};

export function ResolveReturn({ view, compact = false }: { view: ViewId; compact?: boolean }) {
  const t = useT();
  const trip = useResolveTrip(view);
  const reader = useAppStore((s) => s.reader);
  const issueRunning = useAppStore((s) => s.issue.running);
  const busyOp = useAppStore((s) => s.busyOp);
  const setView = useAppStore((s) => s.setView);
  const blockText = useOpBlockText();
  if (!trip) return null;

  const name = t(navLabelKey(trip.returnTo));
  const hint = t(HINT[trip.reason], { name });
  const block = trip.reread ? tagOpBlock(reader, { issueRunning, busyOp }) : null;
  const returnTo = trip.returnTo;

  return (
    <div className={`resolve-return${compact ? ' is-compact' : ''}`} data-testid="resolve-return" data-reason={trip.reason}>
      <div className="row resolve-return-actions">
        <Button icon={ArrowLeft} size={compact ? 'sm' : 'md'} onClick={() => setView(returnTo)} title={compact ? hint : undefined} data-testid="resolve-back">
          {t('shell.return.back', { name })}
        </Button>
        {trip.reread ? (
          <Button
            variant="primary"
            icon={ScanLine}
            size={compact ? 'sm' : 'md'}
            disabled={block !== null}
            title={block ? blockText(block) : undefined}
            onClick={() => {
              setView(returnTo);
              // Manual read: tries every registered key (D9), unlike the automatic read.
              void readCurrentTag();
            }}
            data-testid="resolve-back-read"
          >
            {t('shell.return.backAndRead', { name })}
          </Button>
        ) : null}
      </div>
      {!compact ? <span className="small muted">{hint}</span> : null}
      {!compact && block ? (
        <span className="small muted" data-testid="resolve-blocked">
          {blockText(block)}
        </span>
      ) : null}
    </div>
  );
}
