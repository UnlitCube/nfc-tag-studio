// Schema designer: build an ID layout in a GUI, validate it, preview the bytes,
// save it (settings or *.nfcschema file) and hand it to the issue view.
// Owner: agent "renderer-schema".
//
// Invariant reminder (I1/I2): a schema only ever describes the tag's DATA area.
// The UID is read-only; nothing here changes or clones a UID. The "UID copy"
// source merely places a reference copy of the read-only UID into the data.
import { useEffect, useMemo, useState } from 'react';
import { Database, FileDown, FileUp, Hash, ListPlus, Plus, Save, Send, Trash2 } from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, isNtag, specFor } from '@shared/tags';
import type { DataSchema, FieldSource, FieldType, SchemaArea, SchemaIssue } from '@shared/schema/types';
import { parseSchemaFile, schemaPresets, serializeSchema, validateSchema } from '@shared/schema';
import { FILE_FILTERS } from '@shared/api';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Page,
  PageHeader,
  Select,
  TextInput,
} from '../../components/ui';
import { useAppStore } from '../../store/app';
import { api } from '../../lib/api';
import { kindLabel, newId } from '../../lib/format';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import {
  computeSize,
  createEmptySchema,
  fieldColorVar,
  isDataSchemaLike,
  makeField,
  moveItem,
  retypeField,
  slugifyId,
  suggestOffset,
  uniqueFieldId,
  upsertById,
  withSourceKind,
} from './helpers';
import { FieldRow } from './FieldRow';
import { MemoryMap } from './MemoryMap';
import { SchemaPreview } from './SchemaPreview';
import './schema.css';

function cloneSchema(s: DataSchema): DataSchema {
  return JSON.parse(JSON.stringify(s)) as DataSchema;
}

export function SchemaView() {
  const t = useT();
  const savedSchemas = useAppStore((s) => s.settings.schemas);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const handoffTo = useAppStore((s) => s.handoffTo);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);
  const setUnsavedDraft = useAppStore((s) => s.setUnsavedDraft);

  const [extra, setExtra] = useState<DataSchema[]>([]);
  const [draft, setDraft] = useState<DataSchema | null>(null);
  const [baseline, setBaseline] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const primaryKind: TagKind = draft?.tagKinds[0] ?? 'NTAG213';
  const dirty = draft != null && JSON.stringify(draft) !== baseline;
  // Closing the window must not silently drop an unsaved schema (WALK-13).
  useEffect(() => {
    setUnsavedDraft('schema', dirty);
  }, [dirty, setUnsavedDraft]);

  const validation = useMemo(() => {
    if (!draft) return { available: true, issues: [] as SchemaIssue[] };
    try {
      return { available: true, issues: validateSchema(draft, primaryKind).issues };
    } catch {
      return { available: false, issues: [] as SchemaIssue[] };
    }
  }, [draft, primaryKind]);

  const issuesByField = useMemo(() => {
    const map = new Map<string, SchemaIssue[]>();
    for (const iss of validation.issues) {
      if (iss.field == null) continue;
      const list = map.get(iss.field) ?? [];
      list.push(iss);
      map.set(iss.field, list);
    }
    return map;
  }, [validation]);
  const schemaIssues = validation.issues.filter((i) => i.field == null);
  const errorCount = validation.issues.filter((i) => i.severity === 'error').length;
  const warnCount = validation.issues.filter((i) => i.severity === 'warning').length;

  // ---- schema list helpers -------------------------------------------------
  const combined: { schema: DataSchema; saved: boolean }[] = [
    ...savedSchemas.map((s) => ({ schema: s, saved: true })),
    ...extra.filter((e) => !savedSchemas.some((s) => s.id === e.id)).map((s) => ({ schema: s, saved: false })),
  ];

  function loadDraft(s: DataSchema) {
    const clone = cloneSchema(s);
    setDraft(clone);
    setBaseline(JSON.stringify(clone));
  }

  function patchDraft(updater: (d: DataSchema) => DataSchema) {
    setDraft((d) => {
      if (!d) return d;
      const next = updater(d);
      return { ...next, size: computeSize(next.fields) };
    });
  }

  // ---- field operations ----------------------------------------------------
  function addField(opts: { idBase: string; label: string; type?: FieldType; source?: FieldSource; length?: number }) {
    patchDraft((d) => {
      const id = uniqueFieldId(opts.idBase, d.fields.map((f) => f.id));
      const field = makeField({
        id,
        label: opts.label,
        type: opts.type,
        source: opts.source,
        length: opts.length,
        offset: suggestOffset(d.fields),
      });
      return { ...d, fields: [...d.fields, field] };
    });
  }

  const fieldHandlers = {
    change: (i: number, patch: Partial<DataSchema['fields'][number]>) =>
      patchDraft((d) => ({ ...d, fields: d.fields.map((f, k) => (k === i ? { ...f, ...patch } : f)) })),
    type: (i: number, type: FieldType) =>
      patchDraft((d) => ({ ...d, fields: d.fields.map((f, k) => (k === i ? retypeField(f, type) : f)) })),
    sourceKind: (i: number, kind: FieldSource['kind']) =>
      patchDraft((d) => ({ ...d, fields: d.fields.map((f, k) => (k === i ? withSourceKind(f, kind) : f)) })),
    move: (i: number, dir: -1 | 1) => patchDraft((d) => ({ ...d, fields: moveItem(d.fields, i, i + dir) })),
    remove: (i: number) => patchDraft((d) => ({ ...d, fields: d.fields.filter((_, k) => k !== i) })),
  };

  function onDragOver(i: number) {
    if (dragIndex == null || dragIndex === i) return;
    patchDraft((d) => ({ ...d, fields: moveItem(d.fields, dragIndex, i) }));
    setDragIndex(i);
  }

  // ---- area / meta ---------------------------------------------------------
  function setArea(area: SchemaArea) {
    patchDraft((d) => ({ ...d, area }));
  }
  function setMode(mode: 'raw' | 'ndef') {
    if (mode === 'raw') setArea({ mode: 'raw', startUnit: specFor(primaryKind).userStartUnit });
    else setArea({ mode: 'ndef', recordType: 'external', type: '' });
  }
  function toggleKind(kind: TagKind, on: boolean) {
    patchDraft((d) => {
      let kinds = on ? [...d.tagKinds, kind] : d.tagKinds.filter((k) => k !== kind);
      if (kinds.length === 0) kinds = [kind];
      // de-dup, keep order
      kinds = kinds.filter((k, i) => kinds.indexOf(k) === i);
      return { ...d, tagKinds: kinds };
    });
  }

  // ---- persistence ---------------------------------------------------------
  async function saveToSettings(): Promise<DataSchema | null> {
    if (!draft) return null;
    if (!draft.name.trim()) {
      toast({ tone: 'warn', title: t('schema.toast.needName') });
      return null;
    }
    const toSave: DataSchema = { ...draft, updatedAt: new Date().toISOString(), size: computeSize(draft.fields) };
    await saveSettings((s) => ({ ...s, schemas: upsertById(s.schemas, toSave) }));
    setExtra((list) => list.filter((e) => e.id !== toSave.id));
    setDraft(toSave);
    setBaseline(JSON.stringify(toSave));
    return toSave;
  }

  async function onSave() {
    const saved = await saveToSettings();
    if (saved) toast({ tone: 'ok', title: t('schema.toast.saved'), detail: saved.name });
  }

  async function onExport() {
    if (!draft) return;
    try {
      let bytes: Uint8Array;
      try {
        bytes = serializeSchema(draft);
      } catch {
        bytes = new TextEncoder().encode(`${JSON.stringify(draft, null, 2)}\n`);
      }
      const res = await api.saveFile({
        defaultName: `${slugifyId(draft.name, 'schema')}.nfcschema`,
        filters: [FILE_FILTERS.schema, FILE_FILTERS.json],
        bytes,
      });
      if (res) toast({ tone: 'ok', title: t('schema.toast.exported'), detail: res.name });
    } catch (err) {
      toastError(err);
    }
  }

  async function onImport() {
    try {
      const res = await api.openFile({ filters: [FILE_FILTERS.schema, FILE_FILTERS.json] });
      if (!res) return;
      let schema: DataSchema | null = null;
      try {
        schema = parseSchemaFile(res.bytes).schema;
      } catch {
        try {
          const obj = JSON.parse(new TextDecoder().decode(res.bytes));
          schema = isDataSchemaLike(obj) ? obj : null;
        } catch {
          schema = null;
        }
      }
      if (!schema) {
        toast({ tone: 'danger', title: t('schema.toast.importFailed'), detail: res.name });
        return;
      }
      setExtra((list) => upsertById(list, schema!));
      loadDraft(schema);
      toast({ tone: 'ok', title: t('schema.toast.imported'), detail: res.name });
    } catch (err) {
      toastError(err);
    }
  }

  async function onDelete(s: DataSchema, saved: boolean) {
    const ok = await confirm({
      title: t('schema.delete.title'),
      message: t('schema.delete.message'),
      tone: 'danger',
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    if (saved) await saveSettings((st) => ({ ...st, schemas: st.schemas.filter((x) => x.id !== s.id) }));
    setExtra((list) => list.filter((x) => x.id !== s.id));
    if (draft?.id === s.id) {
      setDraft(null);
      setBaseline('');
    }
  }

  async function onHandoff() {
    const saved = await saveToSettings();
    if (!saved) return;
    toast({ tone: 'ok', title: t('schema.toast.handoffSaved'), detail: saved.name });
    handoffTo('issue', { kind: 'issue-schema', schemaId: saved.id });
  }

  // ---- render --------------------------------------------------------------
  return (
    <Page>
      <PageHeader
        title={t('schema.title')}
        subtitle={t('schema.subtitle')}
        helpTopic="schema"
        actions={
          <>
            <Button icon={FileUp} onClick={onImport}>
              {t('schema.import')}
            </Button>
            <Button icon={Plus} variant="primary" onClick={() => setNewOpen(true)}>
              {t('schema.new')}
            </Button>
          </>
        }
      />

      <Callout tone="info">{t('schema.note')}</Callout>

      <div className="schema-layout">
        <aside className="schema-aside">
          <Card title={t('schema.list.title')} icon={Database} flush>
            {combined.length === 0 ? (
              <div className="card-body small muted">{t('schema.list.empty')}</div>
            ) : (
              <ul className="schema-list">
                {combined.map(({ schema: s, saved }) => (
                  <li key={s.id} className={draft?.id === s.id ? 'is-active' : undefined}>
                    <button type="button" className="schema-list-main" onClick={() => loadDraft(s)}>
                      <span className="schema-list-name">{s.name || s.id}</span>
                      <span className="schema-list-sub small muted">
                        {t('schema.list.fields', { n: s.fields.length })} · {kindLabel(s.tagKinds[0])}
                      </span>
                    </button>
                    <Badge tone={saved ? 'accent' : 'info'}>{saved ? t('schema.list.saved') : t('schema.list.file')}</Badge>
                    <IconButton icon={Trash2} label={t('common.delete')} size="sm" variant="danger" onClick={() => onDelete(s, saved)} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>

        <div className="schema-main">
          {!draft ? (
            <EmptyState
              icon={Database}
              title={t('schema.empty.title')}
              action={
                <Button icon={Plus} variant="primary" onClick={() => setNewOpen(true)}>
                  {t('schema.new')}
                </Button>
              }
            >
              {t('schema.empty.body')}
            </EmptyState>
          ) : (
            <div className="stack-lg">
              <div className="row-between schema-toolbar">
                <div className="row">
                  <strong>{draft.name || draft.id}</strong>
                  {dirty ? <Badge tone="warn">{t('schema.unsaved')}</Badge> : null}
                </div>
                <div className="row">
                  <Button icon={FileDown} onClick={onExport}>
                    {t('schema.export')}
                  </Button>
                  <Button icon={Save} onClick={onSave}>
                    {t('schema.save')}
                  </Button>
                  <Button icon={Send} variant="primary" onClick={onHandoff}>
                    {t('schema.toIssue')}
                  </Button>
                </div>
              </div>

              <Card title={t('schema.meta.title')}>
                <div className="stack">
                  <div className="grid-2">
                    <Field label={t('schema.meta.name')}>
                      <TextInput value={draft.name} onChange={(e) => patchDraft((d) => ({ ...d, name: e.target.value }))} />
                    </Field>
                    <Field label={t('schema.meta.description')}>
                      <TextInput value={draft.description} onChange={(e) => patchDraft((d) => ({ ...d, description: e.target.value }))} />
                    </Field>
                  </div>
                  <Field label={t('schema.meta.tagKinds')} hint={t('schema.meta.tagKindsHelp')}>
                    <div className="row">
                      {TAG_KINDS.map((k) => (
                        <Checkbox
                          key={k}
                          checked={draft.tagKinds.includes(k)}
                          onChange={(on) => toggleKind(k, on)}
                          label={kindLabel(k)}
                        />
                      ))}
                    </div>
                  </Field>
                </div>
              </Card>

              <Card title={t('schema.area.title')}>
                <AreaEditor area={draft.area} kind={primaryKind} onMode={setMode} onArea={setArea} t={t} />
              </Card>

              <Card
                title={t('schema.fields.title')}
                actions={
                  <>
                    <Button
                      size="sm"
                      icon={Hash}
                      onClick={() =>
                        addField({
                          idBase: 'employee_id',
                          label: t('schema.fields.seqLabel'),
                          type: 'uint',
                          source: { kind: 'sequence', offset: 0 },
                          length: 4,
                        })
                      }
                    >
                      {t('schema.fields.addSequence')}
                    </Button>
                    <Button size="sm" icon={ListPlus} onClick={() => addField({ idBase: 'field', label: '', type: 'ascii', source: { kind: 'input', defaultValue: '' } })}>
                      {t('schema.fields.add')}
                    </Button>
                  </>
                }
              >
                {draft.fields.length === 0 ? (
                  <p className="small muted">{t('schema.fields.empty')}</p>
                ) : (
                  <div className="schema-fields">
                    {draft.fields.map((f, i) => (
                      <FieldRow
                        key={f.id + i}
                        field={f}
                        index={i}
                        count={draft.fields.length}
                        allFields={draft.fields}
                        color={fieldColorVar(i)}
                        issues={issuesByField.get(f.id) ?? []}
                        dragging={dragIndex === i}
                        onChange={(patch) => fieldHandlers.change(i, patch)}
                        onType={(type) => fieldHandlers.type(i, type)}
                        onSourceKind={(kind) => fieldHandlers.sourceKind(i, kind)}
                        onMove={(dir) => fieldHandlers.move(i, dir)}
                        onRemove={() => fieldHandlers.remove(i)}
                        onDragStart={() => setDragIndex(i)}
                        onDragOver={() => onDragOver(i)}
                        onDrop={() => setDragIndex(null)}
                        onDragEnd={() => setDragIndex(null)}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </Card>

              <div className="grid-2">
                <Card title={t('schema.map.title')}>
                  <MemoryMap schema={draft} t={t} />
                </Card>
                <Card title={t('schema.preview.title')}>
                  <SchemaPreview schema={draft} t={t} />
                </Card>
              </div>

              <Card title={t('schema.validation.title')}>
                {!validation.available ? (
                  <Callout tone="warn">{t('schema.validation.unavailable')}</Callout>
                ) : validation.issues.length === 0 ? (
                  <Callout tone="ok">{t('schema.validation.ok')}</Callout>
                ) : (
                  <div className="stack">
                    <div className="small muted">{t('schema.validation.summary', { errors: errorCount, warnings: warnCount })}</div>
                    {schemaIssues.length > 0 ? (
                      <ul className="schema-field-issues">
                        {schemaIssues.map((iss, k) => (
                          <li key={k} className={iss.severity === 'error' ? 'is-error' : 'is-warn'}>
                            <strong>{t(`schema.issue.${iss.code}` as MsgKey)}</strong> {iss.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>

      {newOpen ? <NewSchemaDialog onClose={() => setNewOpen(false)} onCreate={(s) => { loadDraft(s); setNewOpen(false); }} t={t} /> : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Area editor
// ---------------------------------------------------------------------------
function AreaEditor({
  area,
  kind,
  onMode,
  onArea,
  t,
}: {
  area: SchemaArea;
  kind: TagKind;
  onMode: (mode: 'raw' | 'ndef') => void;
  onArea: (area: SchemaArea) => void;
  t: ReturnType<typeof useT>;
}) {
  const unitLabel = isNtag(kind) ? t('schema.area.page') : t('schema.area.block');
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label={t('schema.area.mode')}>
          <Select
            value={area.mode}
            options={[
              { value: 'raw', label: t('schema.area.raw') },
              { value: 'ndef', label: t('schema.area.ndef') },
            ]}
            onChange={(v) => onMode(v)}
          />
        </Field>
        {area.mode === 'raw' ? (
          <Field label={t('schema.area.startUnit', { unit: unitLabel })}>
            <TextInput
              type="number"
              mono
              min={specFor(kind).userStartUnit}
              value={area.startUnit}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onArea({ mode: 'raw', startUnit: Number.isFinite(n) ? n : specFor(kind).userStartUnit });
              }}
            />
          </Field>
        ) : (
          <Field label={t('schema.area.recordType')}>
            <Select
              value={area.recordType}
              options={[
                { value: 'mime', label: t('schema.area.mime') },
                { value: 'external', label: t('schema.area.external') },
              ]}
              onChange={(v) => onArea({ mode: 'ndef', recordType: v, type: area.type })}
            />
          </Field>
        )}
      </div>
      {area.mode === 'ndef' ? (
        <Field label={t('schema.area.type')}>
          <TextInput
            mono
            placeholder={area.recordType === 'mime' ? 'application/vnd.example' : 'example.com:employee'}
            value={area.type}
            onChange={(e) => onArea({ mode: 'ndef', recordType: area.recordType, type: e.target.value })}
          />
        </Field>
      ) : null}
      <p className="small muted">
        {area.mode === 'raw' ? t('schema.area.rawHelp', { unit: unitLabel }) : t('schema.area.ndefHelp')}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New-schema dialog
// ---------------------------------------------------------------------------
function NewSchemaDialog({
  onClose,
  onCreate,
  t,
}: {
  onClose: () => void;
  onCreate: (s: DataSchema) => void;
  t: ReturnType<typeof useT>;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TagKind>('NTAG213');
  const presets = useMemo(() => {
    try {
      return { ok: true as const, list: schemaPresets(new Date().toISOString()) };
    } catch {
      return { ok: false as const, list: [] as DataSchema[] };
    }
  }, []);

  function createBlank() {
    onCreate(
      createEmptySchema({
        id: newId('schema'),
        name: name.trim() || t('schema.newDialog.blank'),
        kind,
        nowIso: new Date().toISOString(),
      }),
    );
  }

  function createFromPreset(p: DataSchema) {
    const now = new Date().toISOString();
    onCreate({ ...JSON.parse(JSON.stringify(p)), id: newId('schema'), name: name.trim() || p.name, createdAt: now, updatedAt: now });
  }

  return (
    <Modal
      open
      title={t('schema.newDialog.title')}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('common.cancel')}</Button>}
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('schema.newDialog.name')}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Field label={t('schema.newDialog.kind')}>
            <Select value={kind} options={TAG_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} onChange={(v) => setKind(v)} />
          </Field>
        </div>
        <div className="field-label">{t('schema.newDialog.start')}</div>
        <div className="schema-start-list">
          <button type="button" className="schema-start" onClick={createBlank}>
            <Plus size={16} aria-hidden />
            <span>{t('schema.newDialog.blank')}</span>
          </button>
          {presets.list.map((p) => (
            <button type="button" className="schema-start" key={p.id} onClick={() => createFromPreset(p)}>
              <Database size={16} aria-hidden />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
        {!presets.ok ? <p className="small muted">{t('schema.newDialog.presetsUnavailable')}</p> : null}
      </div>
    </Modal>
  );
}
