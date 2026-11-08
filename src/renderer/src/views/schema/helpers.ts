// Pure helpers for the schema designer (no React, no DOM). Kept framework-free so
// they can be unit-tested directly (tests/renderer-schema/*). Owner: renderer-schema.
//
// The heavy lifting (validate / encode / serialize) lives in @shared/schema and is
// called from the view; these helpers only build and manipulate the in-memory
// DataSchema the GUI edits.
import type { TagKind } from '@shared/tags';
import { specFor } from '@shared/tags';
import type {
  ChecksumAlgo,
  DataSchema,
  DateFormat,
  FieldSource,
  FieldType,
  IssueContext,
  SchemaArea,
  SchemaField,
} from '@shared/schema/types';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '@shared/schema/types';

export const FIELD_TYPES: FieldType[] = ['uint', 'bcd', 'ascii', 'utf8', 'hex', 'date', 'checksum'];

/** Source kinds the operator can pick in the GUI. 'computed' is implicit for checksum fields. */
export const PICKABLE_SOURCES: Exclude<FieldSource['kind'], 'computed'>[] = [
  'fixed',
  'input',
  'sequence',
  'csv',
  'now',
  'uid',
];

export const DATE_FORMATS: DateFormat[] = ['YYYYMMDD', 'YYMMDD', 'YYYYMMDDhhmm', 'unix32'];
export const CHECKSUM_ALGOS: ChecksumAlgo[] = ['xor8', 'sum8', 'crc16-ccitt', 'crc32', 'luhn'];

/** Background CSS variables cycled to colour fields in the memory map (tokens only). */
const FIELD_COLOR_VARS = [
  '--accent-soft',
  '--info-soft',
  '--ok-soft',
  '--warn-soft',
  '--region-cc',
  '--region-config',
  '--region-dynlock',
  '--region-password',
];

/** `var(--token)` background for field #i in the memory map. */
export function fieldColorVar(i: number): string {
  return `var(${FIELD_COLOR_VARS[((i % FIELD_COLOR_VARS.length) + FIELD_COLOR_VARS.length) % FIELD_COLOR_VARS.length]})`;
}

export function defaultLengthForType(type: FieldType): number {
  switch (type) {
    case 'uint':
      return 2;
    case 'bcd':
      return 3;
    case 'ascii':
      return 8;
    case 'utf8':
      return 16;
    case 'hex':
      return 4;
    case 'date':
      return 4;
    case 'checksum':
      return 1;
  }
}

/** A fresh source object of the given kind with sensible defaults. */
export function makeSource(kind: FieldSource['kind']): FieldSource {
  switch (kind) {
    case 'fixed':
      return { kind: 'fixed', value: '' };
    case 'input':
      return { kind: 'input', defaultValue: '' };
    case 'sequence':
      return { kind: 'sequence', offset: 0 };
    case 'csv':
      return { kind: 'csv', column: '' };
    case 'now':
      return { kind: 'now' };
    case 'uid':
      return { kind: 'uid', part: 'full' };
    case 'computed':
      return { kind: 'computed' };
  }
}

export function defaultSourceForType(type: FieldType): FieldSource {
  if (type === 'checksum') return { kind: 'computed' };
  if (type === 'date') return { kind: 'now' };
  return { kind: 'fixed', value: '' };
}

/** Turn a label into a valid field id ([a-z][a-z0-9_]*), falling back when empty. */
export function slugifyId(label: string, fallback = 'field'): string {
  const s = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1');
  return s || fallback;
}

/** Ensure `base` does not collide with `existing`, appending _2, _3, ... if needed. */
export function uniqueFieldId(base: string, existing: Iterable<string>): string {
  const set = new Set(existing);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** First free byte offset after all current fields. */
export function suggestOffset(fields: SchemaField[]): number {
  let max = 0;
  for (const f of fields) max = Math.max(max, f.offset + f.length);
  return max;
}

/** Total bytes a layout occupies (>= max(offset+length)). */
export function computeSize(fields: SchemaField[]): number {
  return suggestOffset(fields);
}

/** Immutable move of an array item from -> to. Returns a copy unchanged on bad indices. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice();
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy;
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** Build a new field with type-appropriate defaults. */
export function makeField(opts: {
  id: string;
  label: string;
  type?: FieldType;
  source?: FieldSource;
  offset: number;
  length?: number;
  digits?: number;
}): SchemaField {
  const type = opts.type ?? 'ascii';
  const field: SchemaField = {
    id: opts.id,
    label: opts.label,
    type,
    offset: opts.offset,
    length: opts.length ?? defaultLengthForType(type),
    source: opts.source ?? defaultSourceForType(type),
  };
  applyTypeDefaults(field, type);
  if (opts.digits !== undefined) field.digits = opts.digits;
  return field;
}

function applyTypeDefaults(field: SchemaField, type: FieldType): void {
  if (type === 'uint') field.endian = field.endian ?? 'be';
  if (type === 'ascii') {
    field.pad = field.pad ?? 'zero';
    field.align = field.align ?? 'left';
  }
  if (type === 'utf8') field.pad = field.pad ?? 'zero';
  if (type === 'date') {
    field.dateFormat = field.dateFormat ?? 'YYYYMMDD';
    field.dateEncoding = field.dateEncoding ?? 'bcd';
  }
  if (type === 'checksum') field.checksum = field.checksum ?? { algo: 'xor8', over: [] };
}

/** Change a field's type, dropping options that no longer apply and fixing the source. */
export function retypeField(f: SchemaField, type: FieldType): SchemaField {
  const next: SchemaField = {
    id: f.id,
    label: f.label,
    type,
    offset: f.offset,
    length: f.length,
    source: f.source,
  };
  if (f.description !== undefined) next.description = f.description;
  // Carry over still-relevant options.
  if (type === 'uint' || type === 'ascii') {
    if (f.endian !== undefined) next.endian = f.endian;
    if (f.digits !== undefined) next.digits = f.digits;
  }
  if (type === 'ascii' || type === 'utf8') {
    if (f.pad !== undefined) next.pad = f.pad;
  }
  if (type === 'ascii') {
    if (f.align !== undefined) next.align = f.align;
  }
  if (type === 'date') {
    if (f.dateFormat !== undefined) next.dateFormat = f.dateFormat;
    if (f.dateEncoding !== undefined) next.dateEncoding = f.dateEncoding;
  }
  if (type === 'checksum') {
    next.checksum = f.checksum ?? { algo: 'xor8', over: [] };
    next.source = { kind: 'computed' };
  } else if (f.source.kind === 'computed') {
    next.source = { kind: 'fixed', value: '' };
  }
  applyTypeDefaults(next, type);
  return next;
}

/** Replace a field's source kind (no-op when trying to set 'computed' on a non-checksum field). */
export function withSourceKind(f: SchemaField, kind: FieldSource['kind']): SchemaField {
  if (kind === 'computed' && f.type !== 'checksum') return f;
  return { ...f, source: makeSource(kind) };
}

/** Insert or replace a schema in a list, keyed by id. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

/** A blank schema targeting one tag kind, raw mode starting at the first user unit. */
export function createEmptySchema(opts: { id: string; name: string; kind: TagKind; nowIso: string }): DataSchema {
  const spec = specFor(opts.kind);
  const area: SchemaArea = { mode: 'raw', startUnit: spec.userStartUnit };
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: opts.id,
    name: opts.name,
    description: '',
    tagKinds: [opts.kind],
    area,
    size: 0,
    fields: [],
    createdAt: opts.nowIso,
    updatedAt: opts.nowIso,
  };
}

/** Loose structural check used as a fallback when the schema engine is unavailable. */
export function isDataSchemaLike(value: unknown): value is DataSchema {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.format === SCHEMA_FORMAT && Array.isArray(v.fields) && typeof v.id === 'string' && Array.isArray(v.tagKinds);
}

/** Byte -> owning field index map (last writer wins), plus the set of overlapping byte offsets. */
export function buildByteMap(fields: SchemaField[], size: number): { map: number[]; overlaps: Set<number> } {
  const map = new Array<number>(Math.max(0, size)).fill(-1);
  const count = new Array<number>(Math.max(0, size)).fill(0);
  fields.forEach((f, idx) => {
    const end = Math.min(f.offset + f.length, size);
    for (let b = Math.max(0, f.offset); b < end; b++) {
      map[b] = idx;
      count[b]++;
    }
  });
  const overlaps = new Set<number>();
  for (let b = 0; b < size; b++) if (count[b] > 1) overlaps.add(b);
  return { map, overlaps };
}

/** A UID-shaped hex string of the right length for a tag kind, for previews. */
export function sampleUidHex(kind: TagKind | undefined): string {
  const bytes = kind ? specFor(kind).uidBytes : 7;
  const pat = ['04', 'A2', 'B3', 'C4', 'D5', 'E6', 'F7', '11', '22', '33'];
  return Array.from({ length: bytes }, (_, i) => pat[i % pat.length]).join('');
}

function sampleForField(f: SchemaField): string {
  switch (f.type) {
    case 'uint':
    case 'bcd':
      return '1';
    case 'ascii':
      return 'A';
    case 'utf8':
      return 'サンプル';
    case 'hex':
      return '00'.repeat(Math.max(1, f.length));
    case 'date':
    case 'checksum':
      return '';
  }
}

/** A representative IssueContext for the live preview (sequence = 1 by default). */
export function sampleContext(schema: DataSchema, now: Date = new Date(2026, 10, 9, 9, 0, 0), seq = 1): IssueContext {
  const inputs: Record<string, string> = {};
  const row: Record<string, string> = {};
  let hasCsv = false;
  for (const f of schema.fields) {
    if (f.source.kind === 'input') inputs[f.id] = f.source.defaultValue || sampleForField(f);
    if (f.source.kind === 'csv') {
      hasCsv = true;
      row[f.source.column || f.id] = sampleForField(f);
    }
  }
  return {
    seq,
    row: hasCsv ? row : null,
    inputs,
    uid: sampleUidHex(schema.tagKinds[0]),
    now,
  };
}
