// Value resolution + byte encode/decode for a data schema, and the mapping
// between schema bytes and a tag image (raw data area or an NDEF record).
//
// Pure TypeScript: no Node, no DOM (TextEncoder/TextDecoder allowed via ../hex).

import {
  bytesEqual,
  bytesToHex,
  bytesToUintBE,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  uintToBcd,
  uintToBytesBE,
  utf8ToBytes,
} from '../hex';
import { isMifare, isNtag, mifareIsTrailer, ntagConfigPagesFor, specFor, isForbiddenUnit, isProtectedUnit } from '../tags';
import type { TagKind } from '../tags';
import type { TagImage, UnitWrite } from '../types';
import type { NdefRecordDraft } from '../ndef/types';
import { buildMifareNdefWrites, buildType2UserArea, decodeMessage, encodeDrafts, extractMifareNdef, scanType2Tlvs } from '../ndef';
import { checksum } from './checksum';
import { SchemaValueError } from './errors';
import type { DataSchema, DateFormat, IssueContext, SchemaField, SchemaIssue } from './types';

// ---------------------------------------------------------------------------
// Date helpers (local-time parts, so a Date built with new Date(y,mo-1,d,...)
// round-trips regardless of the host timezone).
// ---------------------------------------------------------------------------

interface DateParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const p4 = (n: number): string => String(n).padStart(4, '0');

function partsFromDate(date: Date): DateParts {
  return {
    y: date.getFullYear(),
    mo: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    mi: date.getMinutes(),
    s: date.getSeconds(),
  };
}

function dateFromParts(p: DateParts): Date {
  return new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
}

function isoFull(p: DateParts): string {
  return `${p4(p.y)}-${p2(p.mo)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`;
}

function parseDateParts(fieldId: string, value: string): DateParts {
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(v);
  if (!m) throw new SchemaValueError(fieldId, `日付として解釈できません: ${value}`);
  return {
    y: +m[1],
    mo: +m[2],
    d: +m[3],
    h: m[4] ? +m[4] : 0,
    mi: m[5] ? +m[5] : 0,
    s: m[6] ? +m[6] : 0,
  };
}

/** Digit string a date format produces (unix32 is handled separately). */
function dateDigits(p: DateParts, fmt: DateFormat): string {
  switch (fmt) {
    case 'YYYYMMDD':
      return p4(p.y) + p2(p.mo) + p2(p.d);
    case 'YYMMDD':
      return p2(p.y % 100) + p2(p.mo) + p2(p.d);
    case 'YYYYMMDDhhmm':
      return p4(p.y) + p2(p.mo) + p2(p.d) + p2(p.h) + p2(p.mi);
    case 'unix32':
      return '';
  }
}

function partsFromDigits(fieldId: string, digits: string, fmt: DateFormat): DateParts {
  const need = fmt === 'YYYYMMDD' ? 8 : fmt === 'YYMMDD' ? 6 : fmt === 'YYYYMMDDhhmm' ? 12 : 0;
  if (digits.length < need) throw new SchemaValueError(fieldId, `日付の桁数が足りません: ${digits}`);
  if (fmt === 'YYMMDD') {
    return { y: 2000 + +digits.slice(0, 2), mo: +digits.slice(2, 4), d: +digits.slice(4, 6), h: 0, mi: 0, s: 0 };
  }
  const p: DateParts = { y: +digits.slice(0, 4), mo: +digits.slice(4, 6), d: +digits.slice(6, 8), h: 0, mi: 0, s: 0 };
  if (fmt === 'YYYYMMDDhhmm') {
    p.h = +digits.slice(8, 10);
    p.mi = +digits.slice(10, 12);
  }
  return p;
}

function isoFromParts(p: DateParts, fmt: DateFormat): string {
  if (fmt === 'YYYYMMDDhhmm') return `${p4(p.y)}-${p2(p.mo)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}`;
  if (fmt === 'unix32') return isoFull(p);
  return `${p4(p.y)}-${p2(p.mo)}-${p2(p.d)}`;
}

// ---------------------------------------------------------------------------
// Per-field encode / decode
// ---------------------------------------------------------------------------

const isDigits = (s: string): boolean => /^[0-9]+$/.test(s);

/** Apply the field's `digits` zero-padding to a numeric value (display + ascii). */
function applyDigits(field: SchemaField, raw: string): string {
  if (field.digits && field.digits > 0 && isDigits(raw)) return raw.padStart(field.digits, '0');
  return raw;
}

function padByteOf(field: SchemaField): number {
  return field.pad === 'space' ? 0x20 : 0x00;
}

function encodeUint(field: SchemaField, value: string): Uint8Array {
  if (!isDigits(value)) throw new SchemaValueError(field.id, `整数として解釈できません: ${value}`);
  let bytes: Uint8Array;
  try {
    bytes = uintToBytesBE(BigInt(value), field.length);
  } catch {
    throw new SchemaValueError(field.id, `値 ${value} は ${field.length} バイトに収まりません`);
  }
  if (field.endian === 'le') bytes = Uint8Array.from(bytes).reverse();
  return bytes;
}

function decodeUint(field: SchemaField, bytes: Uint8Array): string {
  const be = field.endian === 'le' ? Uint8Array.from(bytes).reverse() : bytes;
  let s = bytesToUintBE(be).toString();
  if (field.digits && field.digits > 0) s = s.padStart(field.digits, '0');
  return s;
}

function encodeBcd(field: SchemaField, value: string): Uint8Array {
  if (!isDigits(value)) throw new SchemaValueError(field.id, `数字として解釈できません: ${value}`);
  try {
    return uintToBcd(BigInt(value), field.length);
  } catch {
    throw new SchemaValueError(field.id, `BCD ${field.length} バイトに ${value} は収まりません`);
  }
}

function decodeBcd(field: SchemaField, bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += ((b >> 4) & 0x0f).toString(16) + (b & 0x0f).toString(16);
  s = s.replace(/^0+(?=.)/, '');
  if (field.digits && field.digits > 0 && isDigits(s)) s = s.padStart(field.digits, '0');
  return s;
}

function encodeAscii(field: SchemaField, value: string): Uint8Array {
  if (value.length > field.length) throw new SchemaValueError(field.id, `ASCII ${field.length} 文字に収まりません: 「${value}」`);
  const out = new Uint8Array(field.length).fill(padByteOf(field));
  const start = field.align === 'right' ? field.length - value.length : 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) throw new SchemaValueError(field.id, `ASCII の範囲外の文字です: 「${value[i]}」`);
    out[start + i] = code;
  }
  return out;
}

function decodeAscii(field: SchemaField, bytes: Uint8Array): string {
  const pad = padByteOf(field);
  let s = 0;
  let e = bytes.length;
  if (field.align === 'right') while (s < e && bytes[s] === pad) s++;
  else while (e > s && bytes[e - 1] === pad) e--;
  let out = '';
  for (let i = s; i < e; i++) {
    const b = bytes[i];
    if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
  }
  return out;
}

function encodeUtf8(field: SchemaField, value: string): Uint8Array {
  const enc = utf8ToBytes(value);
  if (enc.length > field.length) throw new SchemaValueError(field.id, `UTF-8 ${field.length} バイトに収まりません: 「${value}」`);
  const out = new Uint8Array(field.length).fill(padByteOf(field));
  out.set(enc, 0);
  return out;
}

function decodeUtf8(field: SchemaField, bytes: Uint8Array): string {
  const pad = padByteOf(field);
  let e = bytes.length;
  while (e > 0 && bytes[e - 1] === pad) e--;
  return bytesToUtf8(bytes.subarray(0, e));
}

function encodeHex(field: SchemaField, value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(value);
  } catch {
    throw new SchemaValueError(field.id, `16進数として解釈できません: ${value}`);
  }
  if (bytes.length !== field.length) {
    throw new SchemaValueError(field.id, `hex は ${field.length} バイト必要です（${bytes.length} バイト）`);
  }
  return bytes;
}

function encodeDate(field: SchemaField, value: string): Uint8Array {
  const fmt = field.dateFormat ?? 'YYYYMMDD';
  const parts = parseDateParts(field.id, value);
  let bytes: Uint8Array;
  if (fmt === 'unix32') {
    const sec = Math.floor(dateFromParts(parts).getTime() / 1000);
    if (sec < 0) throw new SchemaValueError(field.id, `1970 年より前の日付は unix32 で表せません: ${value}`);
    bytes = uintToBytesBE(BigInt(sec), 4);
  } else {
    const digits = dateDigits(parts, fmt);
    bytes = (field.dateEncoding ?? 'bcd') === 'ascii' ? asciiFromDigits(digits) : uintToBcd(BigInt(digits), digits.length / 2);
  }
  if (bytes.length !== field.length) {
    throw new SchemaValueError(field.id, `date の長さが合いません（${bytes.length} バイト、定義は ${field.length}）`);
  }
  return bytes;
}

function asciiFromDigits(digits: string): Uint8Array {
  const out = new Uint8Array(digits.length);
  for (let i = 0; i < digits.length; i++) out[i] = digits.charCodeAt(i);
  return out;
}

function decodeDate(field: SchemaField, bytes: Uint8Array): string {
  const fmt = field.dateFormat ?? 'YYYYMMDD';
  if (fmt === 'unix32') {
    const sec = Number(bytesToUintBE(bytes));
    return isoFromParts(partsFromDate(new Date(sec * 1000)), fmt);
  }
  let digits: string;
  if ((field.dateEncoding ?? 'bcd') === 'ascii') {
    digits = '';
    for (const b of bytes) digits += String.fromCharCode(b);
  } else {
    digits = '';
    for (const b of bytes) digits += ((b >> 4) & 0x0f).toString(16) + (b & 0x0f).toString(16);
  }
  return isoFromParts(partsFromDigits(field.id, digits, fmt), fmt);
}

/** Encode one non-checksum field's value into exactly field.length bytes. */
function encodeField(field: SchemaField, value: string): Uint8Array {
  switch (field.type) {
    case 'uint':
      return encodeUint(field, value);
    case 'bcd':
      return encodeBcd(field, value);
    case 'ascii':
      return encodeAscii(field, value);
    case 'utf8':
      return encodeUtf8(field, value);
    case 'hex':
      return encodeHex(field, value);
    case 'date':
      return encodeDate(field, value);
    case 'checksum':
      throw new SchemaValueError(field.id, 'checksum は個別に符号化できません');
  }
}

/** Decode one non-checksum field's bytes back to a display string. */
function decodeField(field: SchemaField, bytes: Uint8Array): string {
  switch (field.type) {
    case 'uint':
      return decodeUint(field, bytes);
    case 'bcd':
      return decodeBcd(field, bytes);
    case 'ascii':
      return decodeAscii(field, bytes);
    case 'utf8':
      return decodeUtf8(field, bytes);
    case 'hex':
      return bytesToHex(bytes);
    case 'date':
      return decodeDate(field, bytes);
    case 'checksum':
      return bytesToHex(bytes);
  }
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/** Resolve one field's logical value from the issue context (pre type formatting). */
function resolveSource(field: SchemaField, ctx: IssueContext): string {
  const src = field.source;
  switch (src.kind) {
    case 'fixed':
      return src.value;
    case 'input':
      return ctx.inputs[field.id] ?? src.defaultValue;
    case 'sequence':
      if (ctx.seq === null) throw new SchemaValueError(field.id, '連番（seq）が指定されていません');
      return String(ctx.seq + src.offset);
    case 'csv': {
      if (!ctx.row) throw new SchemaValueError(field.id, 'CSV の行が指定されていません');
      const v = ctx.row[src.column];
      if (v === undefined) throw new SchemaValueError(field.id, `CSV に列がありません: ${src.column}`);
      return v;
    }
    case 'now':
      return isoFull(partsFromDate(ctx.now));
    case 'uid': {
      if (!ctx.uid) throw new SchemaValueError(field.id, 'UID が読み取れていません');
      const hex = ctx.uid.toUpperCase();
      return src.part === 'last4' ? hex.slice(-4) : hex;
    }
    case 'computed':
      throw new SchemaValueError(field.id, 'computed ソースは checksum 専用です');
  }
}

const displayChecksum = (algo: string, bytes: Uint8Array): string =>
  algo === 'luhn' ? String.fromCharCode(bytes[0]) : bytesToHex(bytes);

function gatherOverBytes(fieldId: string, fields: SchemaField[], source: Uint8Array, over: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const id of over) {
    const rf = fields.find((f) => f.id === id);
    if (!rf) throw new SchemaValueError(fieldId, `チェックサムの参照先がありません: ${id}`);
    parts.push(source.subarray(rf.offset, rf.offset + rf.length));
  }
  return concatBytes(...parts);
}

/**
 * Build the schema-area bytes and the display values. In strict mode a bad value
 * throws SchemaValueError; otherwise the field is left zero and still recorded.
 */
function buildArea(schema: DataSchema, ctx: IssueContext, strict: boolean): { bytes: Uint8Array; values: Record<string, string> } {
  const area = new Uint8Array(schema.size);
  const values: Record<string, string> = {};

  for (const f of schema.fields) {
    if (f.type === 'checksum') continue;
    let raw: string;
    try {
      raw = resolveSource(f, ctx);
    } catch (e) {
      if (strict) throw e;
      values[f.id] = '';
      continue;
    }
    const disp = applyDigits(f, raw);
    values[f.id] = disp;
    try {
      const b = encodeField(f, disp);
      area.set(b.subarray(0, Math.min(b.length, schema.size - f.offset)), f.offset);
    } catch (e) {
      if (strict) throw e;
    }
  }

  for (const f of schema.fields) {
    if (f.type !== 'checksum') continue;
    try {
      const cfg = f.checksum;
      if (!cfg) throw new SchemaValueError(f.id, 'checksum の設定がありません');
      const over = gatherOverBytes(f.id, schema.fields, area, cfg.over);
      const cbytes = checksum(cfg.algo, over);
      if (cbytes.length !== f.length) throw new SchemaValueError(f.id, `checksum の長さが合いません（${cbytes.length} / ${f.length}）`);
      area.set(cbytes, f.offset);
      values[f.id] = displayChecksum(cfg.algo, cbytes);
    } catch (e) {
      if (strict) throw e;
      values[f.id] = '';
    }
  }

  return { bytes: area, values };
}

/** Field id -> value as display text, resolved from sources. Lenient (never throws). */
export function renderValues(schema: DataSchema, ctx: IssueContext): Record<string, string> {
  return buildArea(schema, ctx, false).values;
}

/** Schema-area bytes (length = schema.size) + rendered values. Throws SchemaValueError. */
export function encodeSchema(schema: DataSchema, ctx: IssueContext): { bytes: Uint8Array; values: Record<string, string> } {
  return buildArea(schema, ctx, true);
}

/** Decode schema-area bytes back to display values (checksum mismatches -> issues). */
export function decodeSchema(schema: DataSchema, bytes: Uint8Array): { values: Record<string, string>; issues: SchemaIssue[] } {
  const values: Record<string, string> = {};
  const issues: SchemaIssue[] = [];
  for (const f of schema.fields) {
    if (f.type === 'checksum') continue;
    const slot = bytes.subarray(f.offset, f.offset + f.length);
    try {
      values[f.id] = decodeField(f, slot);
    } catch {
      values[f.id] = bytesToHex(slot);
    }
  }
  for (const f of schema.fields) {
    if (f.type !== 'checksum') continue;
    const cfg = f.checksum;
    const stored = bytes.subarray(f.offset, f.offset + f.length);
    values[f.id] = cfg ? displayChecksum(cfg.algo, stored) : bytesToHex(stored);
    if (!cfg) continue;
    try {
      const over = gatherOverBytes(f.id, schema.fields, bytes, cfg.over);
      const calc = checksum(cfg.algo, over);
      if (!bytesEqual(calc, Uint8Array.from(stored))) {
        issues.push({ field: f.id, severity: 'warning', code: 'VALUE', message: `チェックサムが一致しません（${f.label}）` });
      }
    } catch {
      /* missing reference already surfaces in validateSchema */
    }
  }
  return { values, issues };
}

// ---------------------------------------------------------------------------
// Raw data-area <-> tag image
// ---------------------------------------------------------------------------

/** Data units (page/block) in byte order from startUnit. MIFARE skips block 0 + trailers. */
export function* rawDataUnits(kind: TagKind, startUnit: number): Generator<number> {
  const spec = specFor(kind);
  for (let u = startUnit; u < spec.unitCount; u++) {
    if (isMifare(kind) && (u === 0 || mifareIsTrailer(u))) continue;
    yield u;
  }
}

function ntagUserLast(kind: TagKind): number {
  return ntagConfigPagesFor(specFor(kind).userBytes).userLast;
}

/** Extract the schema area from a tag image (raw bytes or the first matching NDEF record). */
export function schemaAreaFromImage(schema: DataSchema, img: TagImage): Uint8Array | null {
  const kind = img.kind;
  const spec = specFor(kind);
  if (schema.area.mode === 'raw') {
    const out = new Uint8Array(schema.size);
    let idx = 0;
    for (const u of rawDataUnits(kind, schema.area.startUnit)) {
      if (idx >= schema.size) break;
      const base = u * spec.unitSize;
      const n = Math.min(spec.unitSize, schema.size - idx);
      out.set(img.data.subarray(base, base + n), idx);
      idx += n;
    }
    if (idx < schema.size) return null;
    return out;
  }

  let message: Uint8Array | null;
  if (isNtag(kind)) {
    const userArea = img.data.subarray(spec.userStartUnit * spec.unitSize, (ntagUserLast(kind) + 1) * spec.unitSize);
    message = scanType2Tlvs(userArea).ndef;
  } else {
    message = extractMifareNdef(kind, img.data);
  }
  if (!message) return null;
  let records;
  try {
    records = decodeMessage(message);
  } catch {
    return null;
  }
  const tnf = schema.area.recordType === 'mime' ? 2 : 4;
  for (const r of records) {
    if (r.tnf === tnf && bytesToUtf8(r.type) === schema.area.type) return Uint8Array.from(r.payload);
  }
  return null;
}

/** Unit writes that put the encoded schema `area` onto a tag whose current image is `data`. */
export function buildSchemaWrites(schema: DataSchema, kind: TagKind, data: Uint8Array, area: Uint8Array): UnitWrite[] {
  const spec = specFor(kind);
  if (schema.area.mode === 'raw') {
    const start = schema.area.startUnit;
    if (isForbiddenUnit(kind, start) || isProtectedUnit(kind, start)) {
      throw new SchemaValueError('_area', `保護された領域から始まっています（${spec.unit === 'page' ? 'ページ' : 'ブロック'} ${start}）`);
    }
    const writes: UnitWrite[] = [];
    let idx = 0;
    for (const u of rawDataUnits(kind, start)) {
      if (idx >= area.length) break;
      if (isForbiddenUnit(kind, u) || isProtectedUnit(kind, u)) {
        throw new SchemaValueError('_area', `保護された領域には書き込めません（${spec.unit === 'page' ? 'ページ' : 'ブロック'} ${u}）`);
      }
      const base = u * spec.unitSize;
      const cur = Uint8Array.from(data.subarray(base, base + spec.unitSize));
      const next = Uint8Array.from(cur);
      const n = Math.min(spec.unitSize, area.length - idx);
      next.set(area.subarray(idx, idx + n), 0);
      if (!bytesEqual(next, cur)) writes.push({ unit: u, data: next });
      idx += n;
    }
    if (idx < area.length) throw new SchemaValueError('_area', 'データ領域に収まりません');
    return writes;
  }

  const draft: NdefRecordDraft =
    schema.area.recordType === 'mime'
      ? { kind: 'mime', mimeType: schema.area.type, payloadText: '', payloadHex: bytesToHex(area) }
      : { kind: 'external', domainType: schema.area.type, payloadText: '', payloadHex: bytesToHex(area) };
  const message = encodeDrafts([draft]);

  if (isNtag(kind)) {
    const userArea = buildType2UserArea(kind, message);
    const writes: UnitWrite[] = [];
    const pages = spec.userBytes / spec.unitSize;
    for (let i = 0; i < pages; i++) {
      const u = spec.userStartUnit + i;
      const base = u * spec.unitSize;
      const cur = Uint8Array.from(data.subarray(base, base + spec.unitSize));
      const next = Uint8Array.from(userArea.subarray(i * spec.unitSize, (i + 1) * spec.unitSize));
      if (!bytesEqual(next, cur)) writes.push({ unit: u, data: next });
    }
    return writes;
  }
  return buildMifareNdefWrites(kind, data, message);
}
