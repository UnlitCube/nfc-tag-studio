// Shared UI primitives. CONTRACT FILE - integrator-owned; props are frozen.
// Feature agents may add NEW components in their own folders, but must not
// change these signatures. Styling: styles/ui.css (tokens only).
import { forwardRef, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, CircleHelp, Info, Loader2, OctagonAlert, X } from 'lucide-react';
import { useAppStore } from '../store/app';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'lg' ? 18 : size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', variant !== 'secondary' && `btn-${variant}`, size !== 'md' && `btn-${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={iconSize} className="spin" aria-hidden /> : Icon ? <Icon size={iconSize} aria-hidden /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Accessible name; also shown as tooltip. */
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

export function IconButton({ icon: Icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', 'btn-icon', variant !== 'secondary' && `btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon size={size === 'sm' ? 14 : 16} aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('page', className)}>
      <div className="page-inner">{children}</div>
    </div>
  );
}

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Help topic id; renders a "?" button that opens the help view at that topic. */
  helpTopic?: string;
}

export function PageHeader({ title, subtitle, actions, helpTopic }: PageHeaderProps) {
  const setView = useAppStore((s) => s.setView);
  const lang = useAppStore((s) => s.settings.language);
  return (
    <header className="page-header">
      <div className="grow">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      <div className="row">
        {actions}
        {helpTopic ? (
          <IconButton
            icon={CircleHelp}
            label={lang === 'ja' ? 'この画面のヘルプ' : 'Help for this screen'}
            onClick={() => setView('help', { helpTopic })}
          />
        ) : null}
      </div>
    </header>
  );
}

export interface CardProps {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Remove body padding (tables, editors). */
  flush?: boolean;
}

export function Card({ title, icon: Icon, actions, footer, children, className, bodyClassName, flush }: CardProps) {
  return (
    <section className={cx('card', className)}>
      {title || actions ? (
        <div className="card-header">
          <h2 className="card-title">
            {Icon ? <Icon size={16} aria-hidden /> : null}
            {title}
          </h2>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {children !== undefined ? <div className={cx(!flush && 'card-body', bodyClassName)}>{children}</div> : null}
      {footer ? <div className="card-footer">{footer}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Short help text shown in a "?" bubble next to the label. */
  help?: string;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function Field({ label, hint, error, required, help, children, htmlFor, className }: FieldProps) {
  return (
    <div className={cx('field', className)}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden style={{ color: 'var(--danger)' }}>*</span> : null}
        {help ? <HelpTip text={help} /> : null}
      </label>
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }>(
  function TextInput({ className, mono, invalid, ...rest }, ref) {
    return <input ref={ref} className={cx('input', mono && 'mono', className)} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; invalid?: boolean }>(
  function TextArea({ className, mono, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cx('textarea', mono && 'mono', className)} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
}

export function Select<T extends string>({ value, options, onChange, className, ...rest }: SelectProps<T>) {
  return (
    <select className={cx('select', className)} value={value} onChange={(e) => onChange(e.target.value as T)} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className="switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

export function Badge({ tone = 'neutral', icon: Icon, children, title }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; title?: string }) {
  return (
    <span className={cx('badge', tone !== 'neutral' && `badge-${tone}`)} title={title}>
      {Icon ? <Icon size={12} aria-hidden /> : null}
      {children}
    </span>
  );
}

const CALLOUT_ICON: Record<'info' | 'warn' | 'danger' | 'ok', LucideIcon> = {
  info: Info,
  warn: AlertTriangle,
  danger: OctagonAlert,
  ok: CheckCircle2,
};

export function Callout({ tone = 'info', title, children, icon }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode; icon?: LucideIcon }) {
  const Icon = icon ?? CALLOUT_ICON[tone];
  return (
    <div className={cx('callout', `callout-${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={18} aria-hidden />
      <div className="grow">
        {title ? <div className="callout-title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
}

export function Tabs<T extends string>({ items, value, onChange }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" role="tab" className="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {Icon ? <Icon size={15} aria-hidden /> : null}
          {label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={26} aria-hidden />
      </div>
      <div className="empty-title">{title}</div>
      {children ? <div>{children}</div> : null}
      {action ? <div style={{ marginTop: 'var(--space-3)' }}>{action}</div> : null}
    </div>
  );
}

export function HelpTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="helptip"
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      aria-label={text}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <CircleHelp size={14} aria-hidden />
      {open ? (
        <span role="tooltip" id={id} className="helptip-bubble">
          {text}
        </span>
      ) : null}
    </span>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Modal (portal to document.body - ancestors with transform would break fixed)
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  /** Close on Escape / backdrop click (default true). */
  dismissible?: boolean;
}

export function Modal({ open, title, icon: Icon, onClose, children, footer, size = 'md', dismissible = true }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button.btn-primary, button');
      el?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, dismissible, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => dismissible && e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('modal', size === 'lg' && 'modal-lg')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header">
          <h2 className="modal-title" id={titleId}>
            {Icon ? <Icon size={18} aria-hidden /> : null}
            {title}
          </h2>
          {dismissible ? <IconButton icon={X} label="Close" size="sm" onClick={onClose} /> : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
