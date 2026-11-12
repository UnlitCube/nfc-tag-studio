// Global overlays: confirm dialogs (store.confirm) and toasts. Integrator-owned.
//
// 2026-11-12 UX audit FIRST-9 / FIRST-21 / WALK-16 / WRITE-13 / FIRST-13:
//  - A toast shows the plain message; diagnostics (error code, raw SW, PC/SC
//    result) are folded under "技術情報" and never shown inline.
//  - Errors are announced at once (role="alert"); others politely.
//  - The confirm dialog shows the target tag prominently and a warning box
//    ("別のタグへ書き込みます（複製）"), and the confirm button only reacts to a
//    deliberate click / key press: a key held down (auto-repeat) cannot confirm.
//
// 2026-11-12 review round 2 (D13 / E2E-UX-1 / E2E-UX-2):
//  - Toasts never cover the screen's main buttons: the toaster (bottom right)
//    moves up above every visible primary / danger button and [data-toast-avoid]
//    element (the write result) it would overlap - e.g. the binary editor's run
//    bar and the NDEF write card. A click on "write to tag" right after a read
//    used to land on the "read" toast for ~4.5 s.
//  - While a confirmation is open the toasts sit behind it (under the backdrop).
//  - The same toast raised again is shown once with a count (store.toast).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Nfc, OctagonAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/app';
import type { DialogEntry, Toast } from '../store/app';
import { useT } from '../i18n';
import { Button, Callout, Modal, TextInput } from './ui';

function ConfirmDialog({ d }: { d: DialogEntry }) {
  const t = useT();
  const resolve = useAppStore((s) => s.resolveDialog);
  const [typed, setTyped] = useState('');
  // Ignore KEYBOARD activation for a moment after opening: a second Enter / an
  // auto-repeating key from the press that opened the dialog must not confirm it
  // unseen (WRITE-13). Mouse clicks (event.detail >= 1) always work.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 350);
    return () => clearTimeout(id);
  }, []);
  const needsWord = !!d.typeToConfirm;
  const ok = !needsWord || typed.trim() === d.typeToConfirm;
  // Risky confirmations (discard edits, write to a different tag, irreversible)
  // start on Cancel: Enter alone never performs them.
  const focusCancel = !needsWord && (d.tone === 'danger' || d.tone === 'warn');
  const Icon: LucideIcon | undefined = d.tone === 'danger' ? OctagonAlert : d.tone === 'warn' ? AlertTriangle : undefined;
  return (
    <Modal
      open
      title={d.title}
      icon={Icon}
      onClose={() => resolve(d.id, false)}
      footer={
        <>
          <Button onClick={() => resolve(d.id, false)} data-autofocus={focusCancel || undefined} data-testid="confirm-cancel">
            {d.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={d.tone === 'danger' ? 'danger' : 'primary'}
            disabled={!ok}
            onClick={(e) => {
              if (e.detail === 0 && !armed) return;
              resolve(d.id, true);
            }}
            onKeyDown={(e) => {
              if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
            }}
            data-autofocus={(!needsWord && !focusCancel) || undefined}
            data-testid="confirm-ok"
          >
            {d.confirmLabel ?? t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {d.target ? (
          <div className="confirm-target" data-testid="confirm-target">
            <Nfc size={16} aria-hidden />
            <span>{d.target}</span>
          </div>
        ) : null}
        {d.warning ? <Callout tone={d.tone === 'danger' ? 'danger' : 'warn'}>{d.warning}</Callout> : null}
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{d.message}</p>
        {d.details && d.details.length > 0 ? (
          <ul className="confirm-details small muted">
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

function ToastItem({ x }: { x: Toast }) {
  const t = useT();
  const dismiss = useAppStore((s) => s.dismissToast);
  const Icon = TOAST_ICON[x.tone];
  return (
    <div className={`toast toast-${x.tone}`} role={x.tone === 'danger' ? 'alert' : 'status'} data-testid="toast" data-tone={x.tone}>
      <Icon size={18} aria-hidden />
      <div className="grow">
        <div className="toast-title">
          {x.title}
          {x.count && x.count > 1 ? <span className="toast-count">{t('toast.repeated', { n: x.count })}</span> : null}
        </div>
        {x.detail ? <div className="toast-detail">{x.detail}</div> : null}
        {x.technical ? (
          <details className="toast-technical">
            <summary>{t('common.technical')}</summary>
            <code>{x.technical}</code>
          </details>
        ) : null}
      </div>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={t('common.close')} title={t('common.close')} onClick={() => dismiss(x.id)}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Gap (px) kept between the toasts and what they avoid. */
const AVOID_GAP = 8;

/**
 * Pure: where the toaster goes so it covers none of `avoid` (viewport
 * coordinates). Starts at its normal place (`bottom` px above the viewport's
 * bottom edge, `right` px from the right edge) and moves up past every rectangle
 * it would overlap. Returns the CSS `bottom`, or `{ top }` when there is no room
 * below the top margin (then it sits at the top right).
 */
export function placeToaster(i: {
  width: number;
  height: number;
  right: number;
  bottom: number;
  viewportWidth: number;
  viewportHeight: number;
  avoid: readonly Rect[];
  /** Smallest distance from the top edge. */
  minTop: number;
}): { bottom: number } | { top: number } {
  if (i.height <= 0) return { bottom: i.bottom };
  const x2 = i.viewportWidth - i.right;
  const x1 = x2 - i.width;
  let edge = i.viewportHeight - i.bottom; // y of the toaster's bottom edge
  for (let guard = 0; guard < 50; guard++) {
    const top = edge - i.height;
    const hits = i.avoid.filter(
      (r) => r.right > x1 && r.left < x2 && r.bottom > top - AVOID_GAP && r.top < edge + AVOID_GAP && r.bottom > r.top && r.right > r.left,
    );
    if (hits.length === 0) break;
    edge = Math.min(...hits.map((r) => r.top)) - AVOID_GAP;
  }
  if (edge - i.height < i.minTop) return { top: i.minTop };
  return { bottom: Math.round(i.viewportHeight - edge) };
}

/** What the toaster must not cover on the screen that is shown. */
const AVOID_SELECTOR = ['.btn-primary', '.btn-danger', '[data-toast-avoid]']
  .map((s) => `.view-pane:not([hidden]) ${s}`)
  .join(', ');

function cssPx(name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

function Toaster() {
  const toasts = useAppStore((s) => s.toasts);
  const asking = useAppStore((s) => s.dialogs.length > 0);
  const view = useAppStore((s) => s.view);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || toasts.length === 0 || asking) return;
    const place = () => {
      const box = el.getBoundingClientRect();
      const avoid: Rect[] = [];
      for (const n of Array.from(document.querySelectorAll(AVOID_SELECTOR))) {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) avoid.push(r);
      }
      const p = placeToaster({
        width: box.width,
        height: box.height,
        right: cssPx('--space-5', 20),
        bottom: cssPx('--statusbar-h', 28) + cssPx('--space-4', 16),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        avoid,
        minTop: cssPx('--space-4', 16),
      });
      if ('top' in p) {
        el.style.top = `${p.top}px`;
        el.style.bottom = 'auto';
      } else {
        el.style.top = '';
        el.style.bottom = `${p.bottom}px`;
      }
    };
    place();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    // Layout changes without a scroll / resize (the run bar grows, a result appears).
    const timer = window.setInterval(place, 300);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.clearInterval(timer);
    };
  }, [toasts, asking, view]);

  return (
    <div ref={ref} className={`toaster${asking ? ' is-behind' : ''}`} data-testid="toaster">
      {toasts.map((x) => (
        <ToastItem key={x.id} x={x} />
      ))}
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
