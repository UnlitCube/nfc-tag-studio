// Global overlays: confirm dialogs (store.confirm) and toasts. Integrator-owned.
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/app';
import type { DialogEntry, Toast } from '../store/app';
import { useT } from '../i18n';
import { Button, Modal, TextInput } from './ui';

function ConfirmDialog({ d }: { d: DialogEntry }) {
  const t = useT();
  const resolve = useAppStore((s) => s.resolveDialog);
  const [typed, setTyped] = useState('');
  const needsWord = !!d.typeToConfirm;
  const ok = !needsWord || typed.trim() === d.typeToConfirm;
  const Icon: LucideIcon | undefined = d.tone === 'danger' ? OctagonAlert : d.tone === 'warn' ? AlertTriangle : undefined;
  return (
    <Modal
      open
      title={d.title}
      icon={Icon}
      onClose={() => resolve(d.id, false)}
      footer={
        <>
          <Button onClick={() => resolve(d.id, false)}>{d.cancelLabel ?? t('common.cancel')}</Button>
          <Button variant={d.tone === 'danger' ? 'danger' : 'primary'} disabled={!ok} onClick={() => resolve(d.id, true)} data-autofocus={!needsWord || undefined}>
            {d.confirmLabel ?? t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p style={{ whiteSpace: 'pre-wrap' }}>{d.message}</p>
        {d.details && d.details.length > 0 ? (
          <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
            {d.details.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        ) : null}
        {needsWord ? (
          <div className="field">
            <label className="field-label">{t('confirm.typeToConfirm', { word: d.typeToConfirm ?? '' })}</label>
            <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus autoComplete="off" />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

const TOAST_ICON: Record<Toast['tone'], LucideIcon> = { ok: CheckCircle2, warn: AlertTriangle, danger: OctagonAlert, info: Info };

function Toaster() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((x) => {
        const Icon = TOAST_ICON[x.tone];
        return (
          <div key={x.id} className={`toast toast-${x.tone}`}>
            <Icon size={18} aria-hidden />
            <div className="grow">
              <div className="toast-title">{x.title}</div>
              {x.detail ? <div className="toast-detail" style={{ whiteSpace: 'pre-wrap' }}>{x.detail}</div> : null}
            </div>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close" onClick={() => dismiss(x.id)}>
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Overlays() {
  const dialogs = useAppStore((s) => s.dialogs);
  return (
    <>
      {dialogs.length > 0 ? <ConfirmDialog key={dialogs[0].id} d={dialogs[0]} /> : null}
      <Toaster />
    </>
  );
}
