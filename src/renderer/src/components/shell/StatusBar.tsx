// Bottom status bar: reader / tag / busy. Baseline by the integrator; owner: agent "shell-ui".
import { AlertTriangle, CircleDot, CreditCard, Loader2, Usb } from 'lucide-react';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { formatUid, kindLabel } from '../../lib/format';

export function StatusBar() {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const card = reader?.card ?? null;
  const active = reader?.readers.find((r) => r.name === (card?.readerName ?? reader?.selectedReader)) ?? reader?.readers[0] ?? null;

  let readerText = t('status.noReader');
  let tone: 'ok' | 'warn' | 'danger' = 'warn';
  if (!reader || reader.service === 'unavailable' || reader.service === 'error') {
    readerText = t('status.noService');
    tone = 'danger';
  } else if (active) {
    readerText = active.virtual ? t('status.simulator') : active.name;
    tone = active.likelyContactless || active.virtual ? 'ok' : 'warn';
  }

  return (
    <footer className="app-status" data-testid="statusbar">
      <span className={`status-item status-${tone}`} title={active?.name}>
        <Usb size={13} aria-hidden />
        {readerText}
        {active && !active.likelyContactless && !active.virtual ? (
          <span className="status-hint">
            <AlertTriangle size={12} aria-hidden /> {t('status.notContactless')}
          </span>
        ) : null}
      </span>
      <span className={`status-item ${card ? 'status-ok' : ''}`} data-testid="status-card">
        <CreditCard size={13} aria-hidden />
        {card ? `${kindLabel(card.kind)} · ${formatUid(card.uid)}` : t('status.noCard')}
      </span>
      <span className="grow" />
      {reader?.busy ? (
        <span className="status-item">
          <Loader2 size={13} className="spin" aria-hidden />
          {t('status.busy')}
        </span>
      ) : null}
      {reader?.simulator.enabled ? (
        <span className="status-item status-accent">
          <CircleDot size={13} aria-hidden />
          {t('status.simulator')}
        </span>
      ) : null}
    </footer>
  );
}
