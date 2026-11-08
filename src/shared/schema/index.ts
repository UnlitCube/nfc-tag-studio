// Data schema engine - PUBLIC API (signatures frozen by the integrator).
// Owner: agent "shared-schema". Implemented in this directory (codec.ts,
// validate.ts, template.ts, csv.ts, checksum.ts, presets.ts, errors.ts) and
// re-exported from here. The public names/parameters/return types are unchanged.
//
// Pure TypeScript: no Node, no DOM. May import ../ndef (encode/decode, Type 2 TLV)
// and ../tags / ../hex.

export * from './types';

/** Thrown by encodeSchema when a value cannot be encoded (Japanese message). */
export { SchemaValueError } from './errors';

// ---------------------------------------------------------------------------
// Schema documents
// ---------------------------------------------------------------------------

/** New empty schema (id generated from a counter/time-free seed is fine; caller may override). */
export { newSchema } from './validate';

/**
 * Validate an unknown value (parsed JSON or an in-memory schema). Returns the
 * normalised schema when there are no 'error' issues, else schema = null.
 * When `kind` is given, also checks the layout fits that tag and does not hit
 * protected units (raw mode).
 */
export { validateSchema } from './validate';

/** Pretty JSON (UTF-8) for "*.nfcschema". */
export { serializeSchema } from './validate';

/** Parse "*.nfcschema" bytes (UTF-8 JSON, BOM tolerated) + validate. */
export { parseSchemaFile } from './validate';

/** Built-in starting points (e.g. 社員証 ID / 勤怠タグ / 会員番号 / 資産タグ). */
export { schemaPresets } from './presets';

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** Field id -> value as display text, resolved from sources (before byte encoding). */
export { renderValues } from './codec';

/** Schema area bytes (length = schema.size) for one tag + the rendered values. Throws SchemaValueError. */
export { encodeSchema } from './codec';

/** Decode schema area bytes back to display values (checksum mismatches reported as issues). */
export { decodeSchema } from './codec';

/**
 * Extract the schema area from a tag image.
 * raw:  `schema.size` bytes starting at area.startUnit (MIFARE: data blocks only, trailers skipped).
 * ndef: payload of the first NDEF record matching area.recordType/type (NTAG Type 2 TLV or MIFARE MAD NDEF).
 * Returns null when not present / not readable.
 */
export { schemaAreaFromImage } from './codec';

/**
 * Unit writes that put `area` (encoded schema bytes) onto a tag whose current
 * image bytes are `data`.
 * raw:  maps bytes onto units from area.startUnit (MIFARE: skipping block 0 + trailers),
 *       preserving bytes of partially covered units from `data`. Only changed units returned.
 * ndef: one NDEF record (mime/external) as the whole message -> Type 2 user area (NTAG)
 *       or buildMifareNdefWrites (MIFARE). Only changed units returned.
 * Never returns forbidden/protected units; throws SchemaValueError('_area', ...) when it would.
 */
export { buildSchemaWrites } from './codec';

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
export { expandTemplate } from './template';

/** Expand placeholders in every text field of a draft. */
export { expandDraft } from './template';

/** Placeholder names used in a text, e.g. ["seq", "csv:社員番号"]. */
export { listPlaceholders } from './template';

// ---------------------------------------------------------------------------
// CSV + checksums
// ---------------------------------------------------------------------------

/** RFC 4180 CSV (UTF-8, BOM tolerated, CRLF/LF, quoted fields). First row = header. */
export { parseCsv } from './csv';

/** CSV text with CRLF line endings, quoting where needed. Caller prepends a BOM for Excel. */
export { toCsv } from './csv';

/** Checksum bytes: xor8/sum8 -> 1 byte, crc16-ccitt (0x1021, init 0xFFFF) -> 2 bytes BE, crc32 (IEEE) -> 4 bytes BE, luhn -> 1 ASCII digit. */
export { checksum } from './checksum';
