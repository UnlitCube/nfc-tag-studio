// Reusable NDEF record list editor. Props are a CONTRACT (frozen): used by the
// NDEF view and by the issue view (NDEF templates with placeholders).
// Owner: agent "renderer-ndef".
import './ndef.css';
import { useCallback, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Binary,
  Boxes,
  ChevronDown,
  ChevronUp,
  Contact,
  Copy,
  FileCode,
  FileText,
  Link,
  Megaphone,
  Plus,
  Smartphone,
  Trash2,
  Type,
  Wifi,
} from 'lucide-react';
import type { TagKind } from '@shared/tags';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { describeDraft, emptyDraft, encodeDrafts, type2Capacity } from '@shared/ndef';
import { Button, Callout, IconButton } from '../../components/ui';
import { useT } from '../../i18n';
import type { MsgKey, TFunc } from '../../i18n';
import { useAppStore } from '../../store/app';
import { RecordForm } from './recordForms';
import type { InsertRegister } from './recordForms';

export interface NdefRecordsEditorProps {
  records: NdefRecordDraft[];
  onChange: (records: NdefRecordDraft[]) => void;
  /** Show placeholder helpers ({{seq}}, {{uid}}, {{date}}, {{csv:..}}, {{input:..}}) for issue templates. */
  allowPlaceholders?: boolean;
  /** Tag kind for the capacity meter (null/undefined = hide the meter). */
  capacityKind?: TagKind | null;
  readOnly?: boolean;
}

type RecordKind = NdefRecordDraft['kind'];

const KIND_ICON: Record<RecordKind, LucideIcon> = {
  uri: Link,
  text: Type,
  wifi: Wifi,
  vcard: Contact,
  mime: FileCode,
  aar: Smartphone,
  external: Boxes,
  smartposter: Megaphone,
  raw: Binary,
  empty: FileText,
};

/** Kinds offered by the "add record" menu (every kind except the empty record). */
const ADD_KINDS: RecordKind[] = ['uri', 'text', 'wifi', 'vcard', 'mime', 'aar', 'external', 'smartposter', 'raw'];

const PLACEHOLDERS: { token: string; key: MsgKey }[] = [
  { token: '{{seq}}', key: 'ndef.ph.seq' },
  { token: '{{seq:6}}', key: 'ndef.ph.seqPad' },
  { token: '{{uid}}', key: 'ndef.ph.uid' },
  { token: '{{date:YYYYMMDD}}', key: 'ndef.ph.date' },
  { token: '{{csv:col}}', key: 'ndef.ph.csv' },
  { token: '{{input:name}}', key: 'ndef.ph.input' },
];

function kindMsgKey(kind: RecordKind): MsgKey {
  return `ndef.kind.${kind}` as MsgKey;
}

function safeDescribe(draft: NdefRecordDraft, lang: 'ja' | 'en'): string {
  try {
    return describeDraft(draft, lang);
  } catch {
    return '';
  }
}

export function NdefRecordsEditor({ records, onChange, allowPlaceholders, capacityKind, readOnly = false }: NdefRecordsEditorProps) {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const [menuOpen, setMenuOpen] = useState(false);

  const insertRef = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; set: (v: string) => void } | null>(null);
  const register = useCallback<InsertRegister>(
    (set) => ({
      onFocus: (e) => {
        insertRef.current = { el: e.currentTarget, set };
      },
    }),
    [],
  );
  const insertToken = useCallback((token: string) => {
    const target = insertRef.current;
    if (!target) return;
    const el = target.el;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    target.set(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      try {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      } catch {
        /* selection not supported on this element */
      }
    });
  }, []);

  const addRecord = (kind: RecordKind) => {
    // E2E-UX-6: a new text record is in the display language (a Japanese screen writes Japanese).
    onChange([...records, emptyDraft(kind, { lang })]);
    setMenuOpen(false);
  };
  const updateAt = (index: number, next: NdefRecordDraft) => onChange(records.map((r, i) => (i === index ? next : r)));
  const removeAt = (index: number) => onChange(records.filter((_, i) => i !== index));
  const duplicateAt = (index: number) => {
    const copy = structuredClone(records[index]);
    onChange([...records.slice(0, index + 1), copy, ...records.slice(index + 1)]);
  };
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= records.length) return;
    const next = records.slice();
    [next[index], next[j]] = [next[j], next[index]];
    onChange(next);
  };

  return (
    <div className="stack">
      {capacityKind ? <CapacityMeter kind={capacityKind} records={records} t={t} /> : null}
      {allowPlaceholders && !readOnly ? <PlaceholderPanel insertToken={insertToken} t={t} /> : null}

      {records.length === 0 ? (
        <Callout tone="info">{t('ndef.empty')}</Callout>
      ) : (
        <div className="ndef-records">
          {records.map((record, index) => {
            const Icon = KIND_ICON[record.kind];
            const desc = safeDescribe(record, lang);
            return (
              <div className="ndef-record" key={index}>
                <div className="ndef-record-head">
                  <div className="ndef-record-title grow">
                    <span className="ndef-record-index" aria-hidden>
                      {index + 1}
                    </span>
                    <Icon size={15} aria-hidden />
                    <span>{t(kindMsgKey(record.kind))}</span>
                    {desc ? <span className="ndef-record-desc">{desc}</span> : null}
                  </div>
                  {!readOnly ? (
                    <div className="row">
                      <IconButton icon={ChevronUp} label={t('ndef.moveUp')} size="sm" disabled={index === 0} onClick={() => move(index, -1)} />
                      <IconButton
                        icon={ChevronDown}
                        label={t('ndef.moveDown')}
                        size="sm"
                        disabled={index === records.length - 1}
                        onClick={() => move(index, 1)}
                      />
                      <IconButton icon={Copy} label={t('ndef.duplicate')} size="sm" onClick={() => duplicateAt(index)} />
                      <IconButton icon={Trash2} label={t('ndef.remove')} size="sm" variant="danger" onClick={() => removeAt(index)} />
                    </div>
                  ) : null}
                </div>
                <div className="ndef-record-body">
                  <RecordForm draft={record} onChange={(next) => updateAt(index, next)} readOnly={readOnly} register={register} t={t} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!readOnly ? (
        <div className="ndef-add">
          <Button icon={Plus} onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-haspopup="menu">
            {t('ndef.add')}
          </Button>
          {menuOpen ? (
            <>
              <div className="ndef-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="ndef-menu" role="menu">
                {ADD_KINDS.map((kind) => {
                  const Icon = KIND_ICON[kind];
                  return (
                    <button key={kind} type="button" role="menuitem" className="ndef-menu-item" onClick={() => addRecord(kind)}>
                      <Icon size={16} aria-hidden />
                      {t(kindMsgKey(kind))}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CapacityMeter({ kind, records, t }: { kind: TagKind; records: NdefRecordDraft[]; t: TFunc }) {
  let used: number | null = null;
  try {
    used = encodeDrafts(records).length;
  } catch {
    used = null;
  }
  let total: number | null = null;
  try {
    total = type2Capacity(kind);
  } catch {
    total = null;
  }
  if (total == null || total <= 0) return null;

  const over = used != null && used > total;
  const pct = used == null ? 0 : Math.max(0, Math.min(100, (used / total) * 100));
  return (
    <div className="ndef-meter">
      <div className="ndef-meter-row">
        <span>{t('ndef.capacity')}</span>
        <span className={over ? 'badge badge-danger' : undefined}>
          {used == null ? '—' : t('ndef.capacityUsage', { used, total })}
        </span>
      </div>
      <div className="ndef-meter-track">
        <div className="ndef-meter-fill" data-over={over} style={{ width: `${pct}%` }} />
      </div>
      {over ? <div className="field-error">{t('ndef.overCapacity', { over: (used ?? 0) - total })}</div> : null}
    </div>
  );
}

function PlaceholderPanel({ insertToken, t }: { insertToken: (token: string) => void; t: TFunc }) {
  return (
    <Callout tone="info" title={t('ndef.placeholders')}>
      <div className="muted small" style={{ marginBottom: 'var(--space-2)' }}>
        {t('ndef.placeholdersHint')}
      </div>
      <div className="ndef-ph">
        {PLACEHOLDERS.map((p) => (
          <button key={p.token} type="button" className="ndef-chip" onClick={() => insertToken(p.token)}>
            {t(p.key)} <code>{p.token}</code>
          </button>
        ))}
      </div>
    </Callout>
  );
}
