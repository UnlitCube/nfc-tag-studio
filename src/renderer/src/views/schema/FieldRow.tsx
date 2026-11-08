// One editable field in the schema designer. Owner: renderer-schema.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, GripVertical, ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type {
  ChecksumAlgo,
  DateFormat,
  FieldSource,
  FieldType,
  SchemaField,
  SchemaIssue,
} from '@shared/schema/types';
import { IconButton, Select, TextInput } from '../../components/ui';
import type { MsgKey, TFunc } from '../../i18n';
import { CHECKSUM_ALGOS, DATE_FORMATS, FIELD_TYPES, PICKABLE_SOURCES } from './helpers';

const TYPE_LABEL: Record<FieldType, MsgKey> = {
  uint: 'schema.type.uint',
  bcd: 'schema.type.bcd',
  ascii: 'schema.type.ascii',
  utf8: 'schema.type.utf8',
  hex: 'schema.type.hex',
  date: 'schema.type.date',
  checksum: 'schema.type.checksum',
};

const SOURCE_LABEL: Record<FieldSource['kind'], MsgKey> = {
  fixed: 'schema.source.fixed',
  input: 'schema.source.input',
  sequence: 'schema.source.sequence',
  csv: 'schema.source.csv',
  now: 'schema.source.now',
  uid: 'schema.source.uid',
  computed: 'schema.source.computed',
};

const DATE_FORMAT_LABEL: Record<DateFormat, string> = {
  YYYYMMDD: 'YYYYMMDD',
  YYMMDD: 'YYMMDD',
  YYYYMMDDhhmm: 'YYYYMMDDhhmm',
  unix32: 'Unix (32bit)',
};

const CHECKSUM_LABEL: Record<ChecksumAlgo, string> = {
  xor8: 'XOR-8',
  sum8: 'SUM-8',
  'crc16-ccitt': 'CRC-16 CCITT',
  crc32: 'CRC-32',
  luhn: 'Luhn',
};

export interface FieldRowProps {
  field: SchemaField;
  index: number;
  count: number;
  allFields: SchemaField[];
  color: string;
  issues: SchemaIssue[];
  dragging: boolean;
  onChange: (patch: Partial<SchemaField>) => void;
  onType: (type: FieldType) => void;
  onSourceKind: (kind: FieldSource['kind']) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  t: TFunc;
}

function NumberCell({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="schema-cell schema-cell-num">
      <span className="schema-cell-label">{label}</span>
      <TextInput
        type="number"
        mono
        min={min}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    </label>
  );
}

export function FieldRow(props: FieldRowProps) {
  const { field: f, index, count, allFields, color, issues, dragging, t } = props;
  const [open, setOpen] = useState(false);

  const typeOptions = FIELD_TYPES.map((v) => ({ value: v, label: t(TYPE_LABEL[v]) }));
  const sourceOptions = PICKABLE_SOURCES.map((v) => ({ value: v, label: t(SOURCE_LABEL[v]) }));

  const hasOptions =
    f.type === 'uint' ||
    f.type === 'ascii' ||
    f.type === 'utf8' ||
    f.type === 'date' ||
    f.type === 'checksum';

  return (
    <div
      className={`schema-field${dragging ? ' is-dragging' : ''}${issues.some((i) => i.severity === 'error') ? ' has-error' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
    >
      <div className="schema-field-head">
        <span
          className="schema-drag"
          title={t('schema.field.drag')}
          draggable
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
        >
          <GripVertical size={16} aria-hidden />
        </span>
        <span className="schema-swatch" style={{ background: color }} aria-hidden />

        <div className="schema-row-grid">
          <label className="schema-cell schema-cell-wide">
            <span className="schema-cell-label">{t('schema.field.label')}</span>
            <TextInput value={f.label} onChange={(e) => props.onChange({ label: e.target.value })} />
          </label>
          <label className="schema-cell">
            <span className="schema-cell-label">{t('schema.field.id')}</span>
            <TextInput mono value={f.id} onChange={(e) => props.onChange({ id: e.target.value })} />
          </label>
          <label className="schema-cell">
            <span className="schema-cell-label">{t('schema.field.type')}</span>
            <Select value={f.type} options={typeOptions} onChange={(v) => props.onType(v)} />
          </label>
          <label className="schema-cell">
            <span className="schema-cell-label">{t('schema.field.source')}</span>
            {f.type === 'checksum' ? (
              <TextInput value={t('schema.source.computed')} readOnly disabled />
            ) : (
              <Select value={f.source.kind} options={sourceOptions} onChange={(v) => props.onSourceKind(v)} />
            )}
          </label>
          <NumberCell label={t('schema.field.offset')} value={f.offset} min={0} onChange={(n) => props.onChange({ offset: n })} />
          <NumberCell label={t('schema.field.length')} value={f.length} min={1} onChange={(n) => props.onChange({ length: n })} />
        </div>

        <div className="schema-field-actions">
          <IconButton icon={ArrowUp} label={t('schema.field.moveUp')} size="sm" disabled={index === 0} onClick={() => props.onMove(-1)} />
          <IconButton
            icon={ArrowDown}
            label={t('schema.field.moveDown')}
            size="sm"
            disabled={index === count - 1}
            onClick={() => props.onMove(1)}
          />
          <IconButton icon={Trash2} label={t('schema.field.remove')} size="sm" variant="danger" onClick={props.onRemove} />
        </div>
      </div>

      <SourceEditor field={f} onChange={props.onChange} t={t} />

      {hasOptions ? (
        <div className="schema-options">
          <button type="button" className="schema-options-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {t('schema.field.options')}
          </button>
          {open ? <OptionsEditor field={f} allFields={allFields} onChange={props.onChange} t={t} /> : null}
        </div>
      ) : null}

      {issues.length > 0 ? (
        <ul className="schema-field-issues">
          {issues.map((iss, k) => (
            <li key={k} className={iss.severity === 'error' ? 'is-error' : 'is-warn'}>
              <strong>{t(`schema.issue.${iss.code}` as MsgKey)}</strong> {iss.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SourceEditor({ field: f, onChange, t }: { field: SchemaField; onChange: (p: Partial<SchemaField>) => void; t: TFunc }) {
  const s = f.source;
  switch (s.kind) {
    case 'fixed':
      return (
        <InlineCell label={t('schema.source.fixedValue')}>
          <TextInput mono={f.type === 'hex'} value={s.value} onChange={(e) => onChange({ source: { kind: 'fixed', value: e.target.value } })} />
        </InlineCell>
      );
    case 'input':
      return (
        <InlineCell label={t('schema.source.inputDefault')}>
          <TextInput value={s.defaultValue} onChange={(e) => onChange({ source: { kind: 'input', defaultValue: e.target.value } })} />
        </InlineCell>
      );
    case 'sequence':
      return (
        <InlineCell label={t('schema.source.seqOffset')}>
          <TextInput
            type="number"
            mono
            value={s.offset}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ source: { kind: 'sequence', offset: Number.isFinite(n) ? n : 0 } });
            }}
          />
        </InlineCell>
      );
    case 'csv':
      return (
        <InlineCell label={t('schema.source.csvColumn')}>
          <TextInput value={s.column} onChange={(e) => onChange({ source: { kind: 'csv', column: e.target.value } })} />
        </InlineCell>
      );
    case 'uid':
      return (
        <div className="schema-source-row">
          <InlineCell label={t('schema.source.uidPart')}>
            <Select
              value={s.part}
              options={[
                { value: 'full', label: t('schema.source.uidFull') },
                { value: 'last4', label: t('schema.source.uidLast4') },
              ]}
              onChange={(v) => onChange({ source: { kind: 'uid', part: v } })}
            />
          </InlineCell>
          <p className="schema-uid-note small muted">{t('schema.source.uidReadonly')}</p>
        </div>
      );
    case 'now':
    case 'computed':
      return null;
  }
}

function OptionsEditor({
  field: f,
  allFields,
  onChange,
  t,
}: {
  field: SchemaField;
  allFields: SchemaField[];
  onChange: (p: Partial<SchemaField>) => void;
  t: TFunc;
}) {
  return (
    <div className="schema-options-grid">
      {f.type === 'uint' ? (
        <InlineCell label={t('schema.field.endian')}>
          <Select
            value={f.endian ?? 'be'}
            options={[
              { value: 'be', label: t('schema.endian.be') },
              { value: 'le', label: t('schema.endian.le') },
            ]}
            onChange={(v) => onChange({ endian: v })}
          />
        </InlineCell>
      ) : null}

      {f.type === 'ascii' || f.type === 'utf8' ? (
        <InlineCell label={t('schema.field.pad')}>
          <Select
            value={f.pad ?? 'zero'}
            options={[
              { value: 'zero', label: t('schema.pad.zero') },
              { value: 'space', label: t('schema.pad.space') },
            ]}
            onChange={(v) => onChange({ pad: v })}
          />
        </InlineCell>
      ) : null}

      {f.type === 'ascii' ? (
        <>
          <InlineCell label={t('schema.field.align')}>
            <Select
              value={f.align ?? 'left'}
              options={[
                { value: 'left', label: t('schema.align.left') },
                { value: 'right', label: t('schema.align.right') },
              ]}
              onChange={(v) => onChange({ align: v })}
            />
          </InlineCell>
          <InlineCell label={t('schema.field.digits')}>
            <TextInput
              type="number"
              mono
              min={0}
              value={f.digits ?? 0}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({ digits: Number.isFinite(n) && n > 0 ? n : undefined });
              }}
            />
          </InlineCell>
        </>
      ) : null}

      {f.type === 'date' ? (
        <>
          <InlineCell label={t('schema.field.dateFormat')}>
            <Select
              value={f.dateFormat ?? 'YYYYMMDD'}
              options={DATE_FORMATS.map((v) => ({ value: v, label: DATE_FORMAT_LABEL[v] }))}
              onChange={(v) => onChange({ dateFormat: v })}
            />
          </InlineCell>
          {f.dateFormat !== 'unix32' ? (
            <InlineCell label={t('schema.field.dateEncoding')}>
              <Select
                value={f.dateEncoding ?? 'bcd'}
                options={[
                  { value: 'bcd', label: t('schema.dateEnc.bcd') },
                  { value: 'ascii', label: t('schema.dateEnc.ascii') },
                ]}
                onChange={(v) => onChange({ dateEncoding: v })}
              />
            </InlineCell>
          ) : null}
        </>
      ) : null}

      {f.type === 'checksum' ? (
        <>
          <InlineCell label={t('schema.field.checksumAlgo')}>
            <Select
              value={f.checksum?.algo ?? 'xor8'}
              options={CHECKSUM_ALGOS.map((v) => ({ value: v, label: CHECKSUM_LABEL[v] }))}
              onChange={(v) => onChange({ checksum: { algo: v, over: f.checksum?.over ?? [] } })}
            />
          </InlineCell>
          <div className="schema-cell schema-cell-wide">
            <span className="schema-cell-label">{t('schema.field.checksumOver')}</span>
            <div className="schema-over">
              {allFields.filter((o) => o.id !== f.id && o.type !== 'checksum').map((o) => {
                const checked = (f.checksum?.over ?? []).includes(o.id);
                return (
                  <label key={o.id} className="schema-over-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const cur = new Set(f.checksum?.over ?? []);
                        if (e.target.checked) cur.add(o.id);
                        else cur.delete(o.id);
                        onChange({ checksum: { algo: f.checksum?.algo ?? 'xor8', over: [...cur] } });
                      }}
                    />
                    <span>{o.label || o.id}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function InlineCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="schema-cell">
      <span className="schema-cell-label">{label}</span>
      {children}
    </label>
  );
}
