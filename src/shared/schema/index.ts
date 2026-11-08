// Data schema engine - PUBLIC API (signatures frozen by the integrator).
// Owner: agent "shared-schema". Implement in this directory (e.g. codec.ts,
// validate.ts, template.ts, csv.ts, checksum.ts, presets.ts) and re-export from
// here. Do NOT change names/parameters/return types.
//
// Pure TypeScript: no Node, no DOM. May import ../ndef (encode/decode, Type 2 TLV)
// and ../tags / ../hex.

import type { TagKind } from '../tags';
import type { TagImage, UnitWrite } from '../types';
import type { NdefRecordDraft } from '../ndef/types';
import type { ChecksumAlgo, DataSchema, IssueContext, SchemaIssue } from './types';

export * from './types';

const NI = (fn: string): never => {
  throw new Error(`schema.${fn}: not implemented`);
};

/** Thrown by encodeSchema when a value cannot be encoded (Japanese message). */
export class SchemaValueError extends Error {
  readonly fieldId: string;
  constructor(fieldId: string, message: string) {
    super(message);
    this.name = 'SchemaValueError';
    this.fieldId = fieldId;
  }
}

// ---------------------------------------------------------------------------
// Schema documents
// ---------------------------------------------------------------------------

/** New empty schema (id generated from a counter/time-free seed is fine; caller may override). */
export function newSchema(init: { id: string; name: string; kind: TagKind; nowIso: string }): DataSchema {
  void init;
  return NI('newSchema');
}

/**
 * Validate an unknown value (parsed JSON or an in-memory schema). Returns the
 * normalised schema when there are no 'error' issues, else schema = null.
 * When `kind` is given, also checks the layout fits that tag and does not hit
 * protected units (raw mode).
 */
export function validateSchema(value: unknown, kind?: TagKind): { schema: DataSchema | null; issues: SchemaIssue[] } {
  void value;
  void kind;
  return NI('validateSchema');
}

/** Pretty JSON (UTF-8) for "*.nfcschema". */
export function serializeSchema(schema: DataSchema): Uint8Array {
  void schema;
  return NI('serializeSchema');
}

/** Parse "*.nfcschema" bytes (UTF-8 JSON, BOM tolerated) + validate. */
export function parseSchemaFile(bytes: Uint8Array): { schema: DataSchema | null; issues: SchemaIssue[] } {
  void bytes;
  return NI('parseSchemaFile');
}

/** Built-in starting points (e.g. 社員証 ID / 勤怠タグ / 会員番号 / 資産タグ). */
export function schemaPresets(nowIso: string): DataSchema[] {
  void nowIso;
  return NI('schemaPresets');
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** Field id -> value as display text, resolved from sources (before byte encoding). */
export function renderValues(schema: DataSchema, ctx: IssueContext): Record<string, string> {
  void schema;
  void ctx;
  return NI('renderValues');
}

/** Schema area bytes (length = schema.size) for one tag + the rendered values. Throws SchemaValueError. */
export function encodeSchema(schema: DataSchema, ctx: IssueContext): { bytes: Uint8Array; values: Record<string, string> } {
  void schema;
  void ctx;
  return NI('encodeSchema');
}

/** Decode schema area bytes back to display values (checksum mismatches reported as issues). */
export function decodeSchema(schema: DataSchema, bytes: Uint8Array): { values: Record<string, string>; issues: SchemaIssue[] } {
  void schema;
  void bytes;
  return NI('decodeSchema');
}

/**
 * Extract the schema area from a tag image.
 * raw:  `schema.size` bytes starting at area.startUnit (MIFARE: data blocks only, trailers skipped).
 * ndef: payload of the first NDEF record matching area.recordType/type (NTAG Type 2 TLV or MIFARE MAD NDEF).
 * Returns null when not present / not readable.
 */
export function schemaAreaFromImage(schema: DataSchema, img: TagImage): Uint8Array | null {
  void schema;
  void img;
  return NI('schemaAreaFromImage');
}

/**
 * Unit writes that put `area` (encoded schema bytes) onto a tag whose current
 * image bytes are `data`.
 * raw:  maps bytes onto units from area.startUnit (MIFARE: skipping block 0 + trailers),
 *       preserving bytes of partially covered units from `data`. Only changed units returned.
 * ndef: one NDEF record (mime/external) as the whole message -> Type 2 user area (NTAG)
 *       or buildMifareNdefWrites (MIFARE). Only changed units returned.
 * Never returns forbidden/protected units; throws SchemaValueError('_area', ...) when it would.
 */
export function buildSchemaWrites(schema: DataSchema, kind: TagKind, data: Uint8Array, area: Uint8Array): UnitWrite[] {
  void schema;
  void kind;
  void data;
  void area;
  return NI('buildSchemaWrites');
}

// ---------------------------------------------------------------------------
// Placeholders (issue templates for NDEF records)
// ---------------------------------------------------------------------------

/**
 * Supported placeholders:
 *   {{seq}}  {{seq:6}} (zero-pad 6)   {{uid}}  {{uid:last4}}
 *   {{date}} (YYYYMMDD)  {{date:YYYY-MM-DD}}  {{time:hhmm}}
 *   {{csv:column}}   {{input:name}}
 * Unknown placeholders throw SchemaValueError('_template', ...).
 */
export function expandTemplate(text: string, ctx: IssueContext): string {
  void text;
  void ctx;
  return NI('expandTemplate');
}

/** Expand placeholders in every text field of a draft. */
export function expandDraft(draft: NdefRecordDraft, ctx: IssueContext): NdefRecordDraft {
  void draft;
  void ctx;
  return NI('expandDraft');
}

/** Placeholder names used in a text, e.g. ["seq", "csv:社員番号"]. */
export function listPlaceholders(text: string): string[] {
  void text;
  return NI('listPlaceholders');
}

// ---------------------------------------------------------------------------
// CSV + checksums
// ---------------------------------------------------------------------------

/** RFC 4180 CSV (UTF-8, BOM tolerated, CRLF/LF, quoted fields). First row = header. */
export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  void text;
  return NI('parseCsv');
}

/** CSV text with CRLF line endings, quoting where needed. Caller prepends a BOM for Excel. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  void header;
  void rows;
  return NI('toCsv');
}

/** Checksum bytes: xor8/sum8 -> 1 byte, crc16-ccitt (0x1021, init 0xFFFF) -> 2 bytes BE, crc32 (IEEE) -> 4 bytes BE, luhn -> 1 ASCII digit. */
export function checksum(algo: ChecksumAlgo, bytes: Uint8Array): Uint8Array {
  void algo;
  void bytes;
  return NI('checksum');
}
