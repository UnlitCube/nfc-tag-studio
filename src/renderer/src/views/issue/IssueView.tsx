// Batch provisioning (量産) view. Owner: renderer-issue.
// Tap tags one after another; the issue engine (main) writes sequence numbers /
// CSV rows / a duplicated data area to each. The UID is read-only and is never
// duplicated - only the data area is written (invariant I1).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  Copy,
  Database,
  FileText,
  FileUp,
  Hash,
  Key,
  Nfc,
  Radio,
  Square,
  Wand2,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { IssueEvent, IssueOptions, IssuePreview, IssueTemplate, MifareKeyEntry } from '@shared/types';
import type { DataSchema, IssueContext } from '@shared/schema/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, isMifare, isNtag } from '@shared/tags';
import { FILE_FILTERS } from '@shared/api';
import { expandDraft, parseCsv, renderValues } from '@shared/schema';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Select,
  Tabs,
  TextInput,
} from '../../components/ui';
import type { SelectOption } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { beep } from '../../lib/sound';
import { formatUid, kindLabel, newId } from '../../lib/format';
import {
  duplicateSize,
  duplicateUnits,
  issuePhase,
  parseIntInput,
  phaseTone,
  previewSlots,
  schemaCsvColumns,
  schemaInputFields,
  schemaUsesSequence,
  summarizeDraft,
} from './model';
import type { IssuePhase } from './model';
import './issue.css';

type TemplateType = 'schema' | 'ndef' | 'image';
interface ImageSource {
  kind: TagKind;
  data: Uint8Array;
  uid: string;
}

const PHASE_ICON: Record<IssuePhase, LucideIcon> = {
  idle: Nfc,
  waiting: Radio,
  writing: Zap,
  success: BadgeCheck,
  skipped: Square,
  error: Square,
  remove: Nfc,
  stopped: Square,
};

export function IssueView() {
  const t = useT();
  const schemas = useAppStore((s) => s.settings.schemas);
  const defaultSound = useAppStore((s) => s.settings.sound);
  const issue = useAppStore((s) => s.issue);
  const takeHandoff = useAppStore((s) => s.takeHandoff);
  const setView = useAppStore((s) => s.setView);
  const toastError = useAppStore((s) => s.toastError);

  const [template, setTemplate] = useState<TemplateType>('schema');
  const [schemaId, setSchemaId] = useState<string>('');
  const [ndefRecords, setNdefRecords] = useState<NdefRecordDraft[] | null>(null);
  const [imageSource, setImageSource] = useState<ImageSource | null>(null);
  const [kind, setKind] = useState<TagKind>('NTAG213');
  const [name, setName] = useState('');

  const [startStr, setStartStr] = useState('1');
  const [stepStr, setStepStr] = useState('1');
  const [nextStr, setNextStr] = useState('1');
  const [limitStr, setLimitStr] = useState('');

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [csv, setCsv] = useState<{ name: string; header: string[]; rows: Record<string, string>[] } | null>(null);

  const [verify, setVerify] = useState(true);
  const [skipDup, setSkipDup] = useState(true);
  const [requireBlank, setRequireBlank] = useState(false);
  const [sound, setSound] = useState(defaultSound);
  const [protectOn, setProtectOn] = useState(false);
  const [ntagPwd, setNtagPwd] = useState('');
  const [ntagPack, setNtagPack] = useState('');
  const [protectRead, setProtectRead] = useState(false);
  const [keys, setKeys] = useState<MifareKeyEntry[]>([]);
  const [selectedKeyIds, setSelectedKeyIds] = useState<string[]>([]);

  const schema = useMemo(() => schemas.find((s) => s.id === schemaId) ?? null, [schemas, schemaId]);

  // Load the operator's MIFARE keys (labels + masked bytes only).
  useEffect(() => {
    let alive = true;
    api
      .listKeys()
      .then((k) => alive && setKeys(k))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Pick up a handoff from another view (NDEF editor, schema designer, backup).
  useEffect(() => {
    const hs = takeHandoff('issue-schema');
    if (hs) {
      setTemplate('schema');
      setSchemaId(hs.schemaId);
      return;
    }
    const hn = takeHandoff('issue-ndef');
    if (hn) {
      setTemplate('ndef');
      setNdefRecords(hn.records);
      return;
    }
    const hi = takeHandoff('issue-image');
    if (hi) {
      setTemplate('image');
      const doc = useAppStore.getState().doc;
      if (doc) setImageSource({ kind: doc.image.kind, data: doc.image.data, uid: doc.image.uid });
    }
  }, [takeHandoff]);

  // Default the schema selection to the first available one.
  useEffect(() => {
    if (template === 'schema' && !schemaId && schemas.length > 0) setSchemaId(schemas[0].id);
  }, [template, schemaId, schemas]);

  // Keep `kind` consistent with the selected template.
  useEffect(() => {
    if (template === 'schema' && schema && schema.tagKinds.length > 0 && !schema.tagKinds.includes(kind)) {
      setKind(schema.tagKinds[0]);
    }
    if (template === 'image' && imageSource) setKind(imageSource.kind);
  }, [template, schema, imageSource, kind]);

  // Feedback sound when the engine reports a result (per the job's sound option).
  const handledEvent = useRef<unknown>(null);
  useEffect(() => {
    const last = issue.last;
    if (!last || last === handledEvent.current) return;
    handledEvent.current = last;
    const soundOn = issue.job ? issue.job.options.sound : sound;
    if (!soundOn) return;
    if (last.type === 'success') beep('success');
    else if (last.type === 'error') beep('error');
  }, [issue.last, issue.job, sound]);

  const inputFields = schema ? schemaInputFields(schema) : [];
  const csvColumns = schema ? schemaCsvColumns(schema) : [];

  async function loadCsv() {
    try {
      const file = await api.openFile({ title: t('issue.csv.load'), filters: [FILE_FILTERS.csv] });
      if (!file) return;
      const text = new TextDecoder().decode(file.bytes);
      const parsed = parseCsv(text);
      setCsv({ name: file.name, header: parsed.header, rows: parsed.rows });
    } catch (err) {
      toastError(err);
    }
  }

  function buildTemplate(): IssueTemplate | null {
    if (template === 'schema') {
      if (!schema) {
        useAppStore.getState().toast({ tone: 'danger', title: t('issue.err.noSchema') });
        return null;
      }
      return { type: 'schema', schema, inputs };
    }
    if (template === 'ndef') {
      if (!ndefRecords || ndefRecords.length === 0) {
        useAppStore.getState().toast({ tone: 'danger', title: t('issue.err.noNdef') });
        return null;
      }
      return { type: 'ndef', records: ndefRecords };
    }
    if (!imageSource) {
      useAppStore.getState().toast({ tone: 'danger', title: t('issue.err.noImage') });
      return null;
    }
    return { type: 'image', kind: imageSource.kind, data: imageSource.data, units: duplicateUnits(imageSource.kind) };
  }

  async function onStart() {
    const start = parseIntInput(startStr);
    const step = parseIntInput(stepStr);
    const next = parseIntInput(nextStr);
    if (start === null || step === null || next === null) {
      useAppStore.getState().toast({ tone: 'danger', title: t('issue.err.badSeq') });
      return;
    }
    let limit: number | null = null;
    if (limitStr.trim() !== '') {
      limit = parseIntInput(limitStr);
      if (limit === null || limit <= 0) {
        useAppStore.getState().toast({ tone: 'danger', title: t('issue.err.badLimit') });
        return;
      }
    }
    const tpl = buildTemplate();
    if (!tpl) return;
    const effKind = tpl.type === 'image' ? tpl.kind : kind;
    const options: IssueOptions = {
      verify,
      skipDuplicateUid: skipDup,
      requireBlank,
      ntagProtect: isNtag(effKind) && protectOn && ntagPwd ? { password: ntagPwd, pack: ntagPack, protectRead } : null,
      mifareKeyIds: isMifare(effKind) ? selectedKeyIds : [],
      sound,
    };
    try {
      await api.startIssue({
        id: newId('job'),
        name: name.trim() || t('issue.title'),
        kind: effKind,
        template: tpl,
        sequence: { start, step, next },
        rows: csv ? csv.rows : null,
        rowIndex: 0,
        options,
        limit,
      });
    } catch (err) {
      toastError(err);
    }
  }

  async function onStop() {
    try {
      await api.stopIssue();
    } catch (err) {
      toastError(err);
    }
  }

  if (issue.running) {
    return <RunningPanel last={issue.last} issued={issue.issued} onStop={onStop} />;
  }

  // ---- configuration phase ----
  const kindOptions: SelectOption<TagKind>[] =
    template === 'schema' && schema && schema.tagKinds.length > 0
      ? schema.tagKinds.map((k) => ({ value: k, label: kindLabel(k) }))
      : TAG_KINDS.map((k) => ({ value: k, label: kindLabel(k) }));

  const seqValues: Record<string, string> = {};
  const templateItems = [
    { id: 'schema' as const, label: t('issue.template.schema'), icon: Database },
    { id: 'ndef' as const, label: t('issue.template.ndef'), icon: FileText },
    { id: 'image' as const, label: t('issue.template.image'), icon: Copy },
  ];

  const slots = previewSlots({
    sequence: { start: parseIntInput(startStr) ?? 0, step: parseIntInput(stepStr) ?? 1, next: parseIntInput(nextStr) ?? 0 },
    rowCount: csv ? csv.rows.length : null,
    rowStart: 0,
    limit: limitStr.trim() ? parseIntInput(limitStr) : null,
    count: 5,
  });

  function previewValuesFor(seq: number, rowIndex: number | null): { values: Record<string, string> | null; ok: boolean } {
    const ctx: IssueContext = {
      seq,
      row: csv && rowIndex != null ? (csv.rows[rowIndex] ?? null) : null,
      inputs,
      uid: null,
      now: new Date(),
    };
    try {
      if (template === 'schema' && schema) return { values: renderValues(schema, ctx), ok: true };
      if (template === 'ndef' && ndefRecords) {
        const out: Record<string, string> = {};
        ndefRecords.forEach((r, i) => {
          let summary: string;
          try {
            summary = summarizeDraft(expandDraft(r, ctx));
          } catch {
            summary = summarizeDraft(r);
          }
          out[`#${i + 1}`] = summary;
        });
        return { values: out, ok: true };
      }
    } catch {
      return { values: null, ok: false };
    }
    return { values: {}, ok: true };
  }

  const usesSeq = template === 'schema' ? (schema ? schemaUsesSequence(schema) : false) : true;

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-header">
          <div className="grow">
            <h1 className="page-title">{t('issue.title')}</h1>
            <p className="page-subtitle">{t('issue.subtitle')}</p>
          </div>
          <div className="row">
            <Button variant="primary" icon={Zap} onClick={onStart}>
              {t('issue.start')}
            </Button>
          </div>
        </header>

        <div className="stack-lg">
          <Callout tone="info" title={t('issue.uidNotice')} />

          <Card title={t('issue.template')} icon={Wand2}>
            <div className="stack">
              <Tabs items={templateItems} value={template} onChange={(v) => setTemplate(v)} />
              {template === 'schema' ? (
                <SchemaConfig
                  schemas={schemas}
                  schema={schema}
                  schemaId={schemaId}
                  onSelect={setSchemaId}
                  inputFields={inputFields}
                  csvColumns={csvColumns}
                  inputs={inputs}
                  setInputs={setInputs}
                  onCreate={() => setView('schema')}
                />
              ) : template === 'ndef' ? (
                <NdefConfig records={ndefRecords} onClear={() => setNdefRecords(null)} onOpen={() => setView('ndef')} />
              ) : (
                <ImageConfig source={imageSource} onOpen={() => setView('backup')} />
              )}
            </div>
          </Card>

          <div className="grid-2">
            <Card title={t('issue.sequence')} icon={Hash}>
              <div className="stack">
                {!usesSeq ? <div className="muted small">{t('issue.sequence.unused')}</div> : null}
                <div className="row">
                  <Field label={t('issue.sequence.start')} className="grow">
                    <TextInput value={startStr} mono inputMode="numeric" onChange={(e) => setStartStr(e.target.value)} />
                  </Field>
                  <Field label={t('issue.sequence.step')} className="grow">
                    <TextInput value={stepStr} mono inputMode="numeric" onChange={(e) => setStepStr(e.target.value)} />
                  </Field>
                  <Field label={t('issue.sequence.next')} className="grow">
                    <TextInput value={nextStr} mono inputMode="numeric" onChange={(e) => setNextStr(e.target.value)} />
                  </Field>
                </div>
                <div className="field-hint">{t('issue.sequence.help')}</div>
              </div>
            </Card>

            <Card title={t('issue.csv')} icon={FileUp}>
              <div className="stack">
                {csv ? (
                  <>
                    <div className="row-between">
                      <div>{t('issue.csv.loaded', { name: csv.name, rows: csv.rows.length, cols: csv.header.length })}</div>
                      <Button size="sm" variant="ghost" onClick={() => setCsv(null)}>
                        {t('issue.csv.clear')}
                      </Button>
                    </div>
                    <div className="muted small">{t('issue.csv.columns', { cols: csv.header.join(', ') })}</div>
                  </>
                ) : (
                  <>
                    <Button icon={FileUp} onClick={loadCsv}>
                      {t('issue.csv.load')}
                    </Button>
                    <div className="field-hint">{t('issue.csv.hint')}</div>
                  </>
                )}
              </div>
            </Card>
          </div>

          <Card title={t('issue.options')}>
            <div className="stack">
              <Field label={t('issue.name')}>
                <TextInput value={name} placeholder={t('issue.name.placeholder')} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div className="grid-2">
                <Field label={t('issue.kind')}>
                  <Select value={kind} options={kindOptions} onChange={setKind} disabled={template === 'image'} />
                </Field>
                <Field label={t('issue.limit')} hint={t('issue.limit.help')}>
                  <TextInput
                    value={limitStr}
                    mono
                    inputMode="numeric"
                    placeholder={t('issue.limit.placeholder')}
                    onChange={(e) => setLimitStr(e.target.value)}
                  />
                </Field>
              </div>
              <Checkbox checked={verify} onChange={setVerify} label={t('issue.opt.verify')} />
              <Checkbox checked={skipDup} onChange={setSkipDup} label={t('issue.opt.skipDup')} />
              <Checkbox checked={requireBlank} onChange={setRequireBlank} label={t('issue.opt.requireBlank')} />
              <Checkbox checked={sound} onChange={setSound} label={t('issue.opt.sound')} />

              {isNtag(kind) ? (
                <div className="stack">
                  <Checkbox checked={protectOn} onChange={setProtectOn} label={t('issue.opt.ntagProtect')} />
                  {protectOn ? (
                    <div className="grid-2">
                      <Field label={t('issue.opt.ntagPwd')}>
                        <TextInput
                          type="password"
                          mono
                          autoComplete="off"
                          value={ntagPwd}
                          onChange={(e) => setNtagPwd(e.target.value)}
                        />
                      </Field>
                      <Field label={t('issue.opt.ntagPack')}>
                        <TextInput type="password" mono autoComplete="off" value={ntagPack} onChange={(e) => setNtagPack(e.target.value)} />
                      </Field>
                      <Checkbox checked={protectRead} onChange={setProtectRead} label={t('issue.opt.protectRead')} />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {isMifare(kind) ? (
                <Field label={t('issue.opt.keys')} hint={t('issue.opt.keys.hint')}>
                  {keys.length === 0 ? (
                    <div className="muted small">{t('issue.opt.keys.none')}</div>
                  ) : (
                    <div className="issue-keylist">
                      {keys.map((k) => (
                        <Checkbox
                          key={k.id}
                          checked={selectedKeyIds.includes(k.id)}
                          onChange={(on) =>
                            setSelectedKeyIds((ids) => (on ? [...ids, k.id] : ids.filter((x) => x !== k.id)))
                          }
                          label={
                            <span className="row">
                              <Key size={14} aria-hidden />
                              {k.label}
                              <span className="muted mono small">{k.masked}</span>
                            </span>
                          }
                        />
                      ))}
                    </div>
                  )}
                </Field>
              ) : null}
            </div>
          </Card>

          <Card title={t('issue.preview')} icon={BadgeCheck} flush>
            {slots.length === 0 ? (
              <div className="card-body muted">{t('issue.preview.none')}</div>
            ) : template === 'image' ? (
              <div className="card-body muted">{t('issue.template.image.hint')}</div>
            ) : (
              <div className="issue-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {usesSeq ? <th>{t('issue.preview.seq')}</th> : null}
                      {csv ? <th>{t('issue.preview.row')}</th> : null}
                      <th>{t('log.col.values')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((slot) => {
                      const { values, ok } = previewValuesFor(slot.seq, slot.rowIndex);
                      return (
                        <tr key={slot.index}>
                          <td className="muted">{slot.index + 1}</td>
                          {usesSeq ? <td className="issue-seq">{slot.seq}</td> : null}
                          {csv ? <td className="issue-seq">{slot.rowIndex != null ? slot.rowIndex + 1 : '—'}</td> : null}
                          <td>
                            {!ok ? (
                              <span className="muted small">{t('issue.preview.unavailable')}</span>
                            ) : (
                              <ValuesInline values={values ?? seqValues} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ValuesInline({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <span className="muted small">—</span>;
  return (
    <span className="issue-values">
      {entries.map(([k, v]) => (
        <span key={k} className="issue-values-pair">
          <span className="issue-values-key">{k}</span>
          <span className="mono">{v}</span>
        </span>
      ))}
    </span>
  );
}

function SchemaConfig({
  schemas,
  schema,
  schemaId,
  onSelect,
  inputFields,
  csvColumns,
  inputs,
  setInputs,
  onCreate,
}: {
  schemas: DataSchema[];
  schema: DataSchema | null;
  schemaId: string;
  onSelect: (id: string) => void;
  inputFields: ReturnType<typeof schemaInputFields>;
  csvColumns: string[];
  inputs: Record<string, string>;
  setInputs: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  onCreate: () => void;
}) {
  const t = useT();
  if (schemas.length === 0) {
    return (
      <EmptyState icon={Database} title={t('issue.schema.none')} action={<Button icon={Wand2} onClick={onCreate}>{t('issue.schema.create')}</Button>} />
    );
  }
  const options: SelectOption<string>[] = schemas.map((s) => ({ value: s.id, label: s.name }));
  return (
    <div className="stack">
      <div className="muted small">{t('issue.template.schema.hint')}</div>
      <Field label={t('issue.schema.select')}>
        <Select value={schemaId} options={options} onChange={onSelect} />
      </Field>
      {csvColumns.length > 0 ? <Callout tone="info">{t('issue.schema.csvNeeded', { cols: csvColumns.join(', ') })}</Callout> : null}
      {schema && inputFields.length > 0 ? (
        <Field label={t('issue.schema.inputs')}>
          <div className="stack">
            {inputFields.map((f) => (
              <Field key={f.id} label={f.label}>
                <TextInput
                  value={inputs[f.id] ?? (f.source.kind === 'input' ? f.source.defaultValue : '')}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [f.id]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        </Field>
      ) : null}
    </div>
  );
}

function NdefConfig({ records, onClear, onOpen }: { records: NdefRecordDraft[] | null; onClear: () => void; onOpen: () => void }) {
  const t = useT();
  if (!records || records.length === 0) {
    return (
      <EmptyState icon={FileText} title={t('issue.ndef.fromEditor')} action={<Button icon={FileText} onClick={onOpen}>{t('issue.ndef.open')}</Button>} />
    );
  }
  return (
    <div className="stack">
      <div className="muted small">{t('issue.template.ndef.hint')}</div>
      <div className="row-between">
        <Badge tone="accent" icon={FileText}>
          {t('issue.ndef.records', { n: records.length })}
        </Badge>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t('issue.ndef.clear')}
        </Button>
      </div>
      <ul className="stack">
        {records.map((r, i) => (
          <li key={i} className="small">
            <span className="muted mono">#{i + 1}</span> {summarizeDraft(r)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImageConfig({ source, onOpen }: { source: ImageSource | null; onOpen: () => void }) {
  const t = useT();
  if (!source) {
    return <EmptyState icon={Copy} title={t('issue.image.none')} action={<Button icon={Database} onClick={onOpen}>{t('issue.image.open')}</Button>} />;
  }
  const units = duplicateUnits(source.kind).length;
  // bytes must be the data-area bytes that are actually copied (I1: the UID / CC /
  // config / trailers are never duplicated), not imageSize (the whole tag).
  const bytes = duplicateSize(source.kind);
  return (
    <div className="stack">
      <div className="muted small">{t('issue.template.image.hint')}</div>
      <Callout tone="ok" icon={Copy} title={t('issue.image.source')}>
        {t('issue.image.summary', { kind: kindLabel(source.kind), uid: formatUid(source.uid), units, bytes })}
      </Callout>
    </div>
  );
}

function RunningPanel({ last, issued, onStop }: { last: IssueEvent | null; issued: number; onStop: () => void }) {
  const t = useT();
  const phase = issuePhase(last);
  const tone = phaseTone(phase);
  const Icon = PHASE_ICON[phase];

  let title = t(`issue.status.${phase}` as 'issue.status.idle');
  let hint: string | null = null;
  if (last) {
    if (last.type === 'waiting') hint = t('issue.status.waiting.hint');
    else if (last.type === 'success') hint = t('issue.status.success.hint');
    else if (last.type === 'skipped') hint = t(`issue.skip.${last.reason}` as 'issue.skip.duplicate');
    else if (last.type === 'error') hint = last.message;
    else if (last.type === 'stopped') title = t(`issue.stopped.${last.reason}` as 'issue.stopped.user');
  }

  const next: IssuePreview | null =
    last && (last.type === 'waiting' || last.type === 'writing') ? last.next : null;

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-header">
          <div className="grow">
            <h1 className="page-title">{t('issue.running')}</h1>
            <p className="page-subtitle">{t('issue.subtitle')}</p>
          </div>
          <div className="row">
            <span className="issue-counter" title={t('issue.counter', { n: issued })}>
              <span className="issue-counter-num">{issued}</span>
              <span className="muted">{t('issue.issuedLabel')}</span>
            </span>
            <Button variant="danger" icon={Square} onClick={onStop}>
              {t('issue.stop')}
            </Button>
          </div>
        </header>

        <div className="stack-lg">
          <div className="big-status" data-tone={tone}>
            <Icon size={56} className="issue-big-icon" aria-hidden />
            <div className="big-status-title">{title}</div>
            {hint ? <div className="issue-status-sub">{hint}</div> : null}
          </div>

          {next ? (
            <Card title={t('issue.next')} icon={Nfc}>
              <dl className="issue-next-values">
                {next.seq != null ? (
                  <>
                    <dt>{t('issue.preview.seq')}</dt>
                    <dd>{next.seq}</dd>
                  </>
                ) : null}
                {Object.entries(next.values).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
