// Schema construction, normalisation and validation; schema file (de)serialisation.
//
// Pure TypeScript: no Node, no DOM (TextEncoder/TextDecoder allowed via ../hex).

import { bytesToUtf8, utf8ToBytes } from '../hex';
import { isForbiddenUnit, isProtectedUnit, specFor, TAG_KINDS } from '../tags';
import type { TagKind } from '../tags';
import { type2Capacity } from '../ndef';
import { checksumWidth } from './checksum';
import { rawDataUnits } from './codec';
import {
  SCHEMA_FORMAT,
  SCHEMA_VERSION,
  type ChecksumAlgo,
  type DataSchema,
  type DateFormat,
  type FieldSource,
  type FieldType,
  type SchemaArea,
  type SchemaField,
  type SchemaIssue,
} from './types';

const FIELD_TYPES: FieldType[] = ['uint', 'bcd', 'ascii', 'utf8', 'hex', 'date', 'checksum'];
const DATE_FORMATS: DateFormat[] = ['YYYYMMDD', 'YYMMDD', 'YYYYMMDDhhmm', 'unix32'];
const CHECKSUM_ALGOS: ChecksumAlgo[] = ['xor8', 'sum8', 'crc16-ccitt', 'crc32', 'luhn'];
const ID_RE = /^[a-z][a-z0-9_]*$/;

type Issues = SchemaIssue[];
const push = (issues: Issues, field: string | null, severity: 'error' | 'warning', code: SchemaIssue['code'], message: string): void => {
  issues.push({ field, severity, code, message });
};

/** New empty raw schema anchored at the kind's first user unit. */
export function newSchema(init: { id: string; name: string; kind: TagKind; nowIso: string }): DataSchema {
  const spec = specFor(init.kind);
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: init.id,
    name: init.name,
    description: '',
    tagKinds: [init.kind],
    area: { mode: 'raw', startUnit: spec.userStartUnit },
    size: 16,
    fields: [],
    createdAt: init.nowIso,
    updatedAt: init.nowIso,
  };
}

function normalizeSource(raw: unknown, id: string, issues: Issues): FieldSource | null {
  if (!raw || typeof raw !== 'object') {
    push(issues, id, 'error', 'FORMAT', `source がありません: ${id}`);
    return null;
  }
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case 'fixed':
      return { kind: 'fixed', value: typeof s.value === 'string' ? s.value : '' };
    case 'input':
      return { kind: 'input', defaultValue: typeof s.defaultValue === 'string' ? s.defaultValue : '' };
    case 'sequence':
      return { kind: 'sequence', offset: typeof s.offset === 'number' && Number.isInteger(s.offset) ? s.offset : 0 };
    case 'csv':
      return { kind: 'csv', column: typeof s.column === 'string' ? s.column : '' };
    case 'now':
      return { kind: 'now' };
    case 'uid':
      return { kind: 'uid', part: s.part === 'last4' ? 'last4' : 'full' };
    case 'computed':
      return { kind: 'computed' };
    default:
      push(issues, id, 'error', 'FORMAT', `source.kind が不正です: ${String(s.kind)}`);
      return null;
  }
}

/** Expected byte length for a date field, or null when it cannot be known. */
function dateByteLen(fmt: DateFormat, enc: 'bcd' | 'ascii'): number | null {
  if (fmt === 'unix32') return 4;
  const digits = fmt === 'YYYYMMDD' ? 8 : fmt === 'YYMMDD' ? 6 : 12;
  return enc === 'ascii' ? digits : digits / 2;
}

function checkSourceType(field: SchemaField, issues: Issues): void {
  const k = field.source.kind;
  const t = field.type;
  if (t === 'checksum') {
    if (k !== 'computed') push(issues, field.id, 'error', 'SOURCE_TYPE', `checksum は computed ソースにします: ${field.id}`);
    return;
  }
  if (k === 'computed') push(issues, field.id, 'error', 'SOURCE_TYPE', `computed は checksum 型専用です: ${field.id}`);
  if (k === 'now' && t !== 'date') push(issues, field.id, 'error', 'SOURCE_TYPE', `now ソースは date 型にします: ${field.id}`);
  if (k === 'sequence' && !(t === 'uint' || t === 'bcd' || t === 'ascii')) {
    push(issues, field.id, 'error', 'SOURCE_TYPE', `sequence ソースは uint/bcd/ascii 型にします: ${field.id}`);
  }
  if (k === 'uid' && !(t === 'hex' || t === 'ascii' || t === 'utf8')) {
    push(issues, field.id, 'error', 'SOURCE_TYPE', `uid ソースは hex/ascii/utf8 型にします: ${field.id}`);
  }
}

function checkFieldLength(field: SchemaField, issues: Issues): void {
  if (field.type === 'uint' && (field.length < 1 || field.length > 8)) {
    push(issues, field.id, 'error', 'LENGTH', `uint は 1..8 バイトです: ${field.id}`);
  }
  if (field.type === 'date') {
    const expected = dateByteLen(field.dateFormat ?? 'YYYYMMDD', field.dateEncoding ?? 'bcd');
    if (expected !== null && field.length !== expected) {
      push(issues, field.id, 'error', 'LENGTH', `date(${field.dateFormat ?? 'YYYYMMDD'}/${field.dateEncoding ?? 'bcd'}) は ${expected} バイトです（定義は ${field.length}）`);
    }
  }
}

function normalizeField(raw: unknown, index: number, issues: Issues): SchemaField | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(issues, null, 'error', 'FORMAT', `fields[${index}] がオブジェクトではありません`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  if (!id) {
    push(issues, null, 'error', 'FORMAT', `fields[${index}] に id がありません`);
    return null;
  }
  if (!ID_RE.test(id)) push(issues, id, 'error', 'ID_INVALID', `id は [a-z][a-z0-9_]* で指定します: ${id}`);

  const type = o.type;
  if (typeof type !== 'string' || !FIELD_TYPES.includes(type as FieldType)) {
    push(issues, id, 'error', 'FORMAT', `type が不正です: ${String(type)}`);
    return null;
  }
  const offset = typeof o.offset === 'number' && Number.isInteger(o.offset) ? o.offset : NaN;
  const length = typeof o.length === 'number' && Number.isInteger(o.length) ? o.length : NaN;
  if (!Number.isFinite(offset) || offset < 0) {
    push(issues, id, 'error', 'FORMAT', `offset が不正です: ${id}`);
    return null;
  }
  if (!Number.isFinite(length) || length <= 0) {
    push(issues, id, 'error', 'FORMAT', `length が不正です: ${id}`);
    return null;
  }
  const source = normalizeSource(o.source, id, issues);
  if (!source) return null;

  const field: SchemaField = { id, label: typeof o.label === 'string' ? o.label : id, type: type as FieldType, offset, length, source };
  if (o.endian === 'be' || o.endian === 'le') field.endian = o.endian;
  if (o.pad === 'zero' || o.pad === 'space') field.pad = o.pad;
  if (o.align === 'left' || o.align === 'right') field.align = o.align;
  if (typeof o.digits === 'number' && Number.isInteger(o.digits) && o.digits > 0) field.digits = o.digits;
  if (typeof o.dateFormat === 'string' && DATE_FORMATS.includes(o.dateFormat as DateFormat)) field.dateFormat = o.dateFormat as DateFormat;
  if (o.dateEncoding === 'bcd' || o.dateEncoding === 'ascii') field.dateEncoding = o.dateEncoding;
  if (typeof o.description === 'string') field.description = o.description;
  if (o.checksum && typeof o.checksum === 'object') {
    const c = o.checksum as Record<string, unknown>;
    if (typeof c.algo === 'string' && CHECKSUM_ALGOS.includes(c.algo as ChecksumAlgo) && Array.isArray(c.over) && c.over.every((x) => typeof x === 'string')) {
      field.checksum = { algo: c.algo as ChecksumAlgo, over: c.over as string[] };
    }
  }

  checkSourceType(field, issues);
  checkFieldLength(field, issues);
  return field;
}

function checkTagFit(kind: TagKind, area: SchemaArea, size: number, issues: Issues): void {
  const spec = specFor(kind);
  if (area.mode === 'raw') {
    if (isForbiddenUnit(kind, area.startUnit) || isProtectedUnit(kind, area.startUnit)) {
      push(issues, null, 'error', 'PROTECTED_AREA', `開始の${spec.unit === 'page' ? 'ページ' : 'ブロック'} ${area.startUnit} は書き込めない保護領域です`);
      return;
    }
    let idx = 0;
    let protectedHit = false;
    for (const u of rawDataUnits(kind, area.startUnit)) {
      if (idx >= size) break;
      if (isForbiddenUnit(kind, u) || isProtectedUnit(kind, u)) {
        protectedHit = true;
        break;
      }
      idx += spec.unitSize;
    }
    if (protectedHit) {
      push(issues, null, 'error', 'PROTECTED_AREA', `スキーマ領域が保護領域（設定ページ等）にかかります`);
    } else if (idx < size) {
      push(issues, null, 'error', 'TOO_LARGE_FOR_TAG', `${spec.displayName} のデータ領域に収まりません（${size} バイト）`);
    }
    return;
  }
  try {
    const cap = type2Capacity(kind);
    if (size > cap) push(issues, null, 'error', 'TOO_LARGE_FOR_TAG', `${spec.displayName} の NDEF 容量を超えています（${size} > ${cap}）`);
  } catch {
    /* ndef codec not available in this context - skip capacity check */
  }
}

/** Validate an unknown value (parsed JSON or an in-memory schema). */
export function validateSchema(value: unknown, kind?: TagKind): { schema: DataSchema | null; issues: SchemaIssue[] } {
  const issues: Issues = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    push(issues, null, 'error', 'FORMAT', 'スキーマがオブジェクトではありません');
    return { schema: null, issues };
  }
  const v = value as Record<string, unknown>;
  if (v.format !== SCHEMA_FORMAT) push(issues, null, 'error', 'FORMAT', `format が「${SCHEMA_FORMAT}」ではありません`);
  if (v.version !== SCHEMA_VERSION) push(issues, null, 'error', 'FORMAT', `version が ${SCHEMA_VERSION} ではありません`);
  if (issues.length > 0) return { schema: null, issues };

  const id = typeof v.id === 'string' ? v.id : '';
  const name = typeof v.name === 'string' ? v.name : '';
  const description = typeof v.description === 'string' ? v.description : '';
  const createdAt = typeof v.createdAt === 'string' ? v.createdAt : '';
  const updatedAt = typeof v.updatedAt === 'string' ? v.updatedAt : '';
  const tagKinds = Array.isArray(v.tagKinds) ? (v.tagKinds.filter((k) => TAG_KINDS.includes(k as TagKind)) as TagKind[]) : [];

  let area: SchemaArea | null = null;
  if (v.area && typeof v.area === 'object') {
    const a = v.area as Record<string, unknown>;
    if (a.mode === 'raw' && typeof a.startUnit === 'number' && Number.isInteger(a.startUnit) && a.startUnit >= 0) {
      area = { mode: 'raw', startUnit: a.startUnit };
    } else if (a.mode === 'ndef' && (a.recordType === 'mime' || a.recordType === 'external') && typeof a.type === 'string') {
      area = { mode: 'ndef', recordType: a.recordType, type: a.type };
    }
  }
  if (!area) push(issues, null, 'error', 'FORMAT', 'area（raw / ndef）が不正です');

  const size = typeof v.size === 'number' && Number.isInteger(v.size) && v.size > 0 ? v.size : 0;
  if (!size) push(issues, null, 'error', 'FORMAT', 'size が正の整数ではありません');

  const rawFields = Array.isArray(v.fields) ? v.fields : null;
  if (!rawFields) push(issues, null, 'error', 'FORMAT', 'fields が配列ではありません');

  const fields: SchemaField[] = [];
  if (rawFields) {
    for (let i = 0; i < rawFields.length; i++) {
      const nf = normalizeField(rawFields[i], i, issues);
      if (nf) fields.push(nf);
    }
  }

  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.id)) push(issues, f.id, 'error', 'ID_DUPLICATE', `フィールド id が重複しています: ${f.id}`);
    seen.add(f.id);
  }

  if (size) {
    for (const f of fields) {
      if (f.offset < 0 || f.offset + f.length > size) {
        push(issues, f.id, 'error', 'OUT_OF_RANGE', `フィールドがスキーマ範囲（0..${size}）を超えています: ${f.id}`);
      }
    }
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const a1 = fields[i].offset;
        const b1 = fields[i].offset + fields[i].length;
        const a2 = fields[j].offset;
        const b2 = fields[j].offset + fields[j].length;
        if (a1 < b2 && a2 < b1) push(issues, fields[i].id, 'error', 'OVERLAP', `フィールドが重なっています: ${fields[i].id} / ${fields[j].id}`);
      }
    }
  }

  const idset = new Set(fields.map((f) => f.id));
  for (const f of fields) {
    if (f.type !== 'checksum') continue;
    const cfg = f.checksum;
    if (!cfg || !Array.isArray(cfg.over) || cfg.over.length === 0) {
      push(issues, f.id, 'error', 'CHECKSUM_REF', `checksum の参照（over）が空です: ${f.id}`);
      continue;
    }
    for (const ref of cfg.over) {
      if (ref === f.id) push(issues, f.id, 'error', 'CHECKSUM_REF', `checksum が自分自身を参照しています: ${f.id}`);
      else if (!idset.has(ref)) push(issues, f.id, 'error', 'CHECKSUM_REF', `checksum の参照先がありません: ${ref}`);
    }
    const w = checksumWidth(cfg.algo);
    if (f.length !== w) push(issues, f.id, 'error', 'LENGTH', `${cfg.algo} は ${w} バイトです（定義は ${f.length}）`);
  }

  if (kind && area && size) checkTagFit(kind, area, size, issues);

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError || !area || !size) return { schema: null, issues };

  const schema: DataSchema = {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id,
    name,
    description,
    tagKinds,
    area,
    size,
    fields,
    createdAt,
    updatedAt,
  };
  return { schema, issues };
}

/** Pretty JSON (UTF-8) for "*.nfcschema". */
export function serializeSchema(schema: DataSchema): Uint8Array {
  return utf8ToBytes(JSON.stringify(schema, null, 2) + '\n');
}

/** Parse "*.nfcschema" bytes (UTF-8 JSON, BOM tolerated) + validate. */
export function parseSchemaFile(bytes: Uint8Array): { schema: DataSchema | null; issues: SchemaIssue[] } {
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(body));
  } catch {
    return { schema: null, issues: [{ field: null, severity: 'error', code: 'FORMAT', message: 'JSON として解釈できません' }] };
  }
  return validateSchema(parsed);
}
