// Data-schema model: describes how operator data (employee ID, name, dates ...)
// is laid out in a tag's writable data area. Built in the GUI designer, saved as
// JSON ("*.nfcschema.json"), used by the issue engine and the read view decoder.
// CONTRACT FILE - frozen. Change only via the integrator.

import type { TagKind } from '../tags';

export const SCHEMA_FORMAT = 'nfc-tag-studio/schema' as const;
export const SCHEMA_VERSION = 1 as const;

/**
 * Field encodings.
 *  uint     unsigned integer, `length` bytes, big/little endian
 *  bcd      packed BCD digits (2 digits per byte), right aligned, zero padded
 *  ascii    ASCII text (0x20-0x7E only), padded to `length`
 *  utf8     UTF-8 text, padded to `length` (must not split a multi-byte char)
 *  hex      fixed bytes given as hex text (exactly `length` bytes)
 *  date     a date, encoded per `dateFormat` + `dateEncoding`
 *  checksum computed over other fields' encoded bytes
 */
export type FieldType = 'uint' | 'bcd' | 'ascii' | 'utf8' | 'hex' | 'date' | 'checksum';

export type DateFormat = 'YYYYMMDD' | 'YYMMDD' | 'YYYYMMDDhhmm' | 'unix32';
export type ChecksumAlgo = 'xor8' | 'sum8' | 'crc16-ccitt' | 'crc32' | 'luhn';

/** Where a field's value comes from when issuing. */
export type FieldSource =
  /** Literal value. Text for ascii/utf8, decimal digits for uint/bcd, hex for hex, ISO date for date. */
  | { kind: 'fixed'; value: string }
  /** Typed by the operator once per issue job (e.g. 部署コード). */
  | { kind: 'input'; defaultValue: string }
  /** The job's sequence counter (+ optional offset). The core of incrementing IDs. */
  | { kind: 'sequence'; offset: number }
  /** Taken from the CSV row assigned to the tag. */
  | { kind: 'csv'; column: string }
  /** Current date/time at write. */
  | { kind: 'now' }
  /** A copy of (part of) the tag's read-only UID, as a reference inside the data. */
  | { kind: 'uid'; part: 'full' | 'last4' }
  /** Only for type 'checksum'. */
  | { kind: 'computed' };

export interface SchemaField {
  /** Stable key [a-z][a-z0-9_]*, used in placeholders and CSV/log columns. */
  id: string;
  /** Display label, e.g. "社員ID". */
  label: string;
  type: FieldType;
  /** Byte offset relative to the start of the schema area. */
  offset: number;
  /** Size in bytes. */
  length: number;
  source: FieldSource;
  /** uint only. Default 'be'. */
  endian?: 'be' | 'le';
  /** ascii/utf8 only. Padding byte: zero (0x00) or space (0x20). Default 'zero'. */
  pad?: 'zero' | 'space';
  /** ascii only. 'right' right-aligns (left-pads), useful for numbers. Default 'left'. */
  align?: 'left' | 'right';
  /** ascii + sequence/uint sources: zero-pad to this many digits. */
  digits?: number;
  /** date only. Default 'YYYYMMDD'. */
  dateFormat?: DateFormat;
  /** date only (not unix32). Default 'bcd'. */
  dateEncoding?: 'bcd' | 'ascii';
  /** checksum only. */
  checksum?: { algo: ChecksumAlgo; over: string[] };
  description?: string;
}

/**
 * Where the schema bytes live.
 *  raw:  directly in the data area starting at `startUnit` (NTAG page / MIFARE block).
 *        On MIFARE Classic the byte stream skips sector trailers and block 0
 *        automatically, so offsets are contiguous over data blocks only.
 *  ndef: as the payload of one NDEF record (MIME type or external type), so
 *        phones and NDEF readers still parse the tag. Written as a whole NDEF
 *        message (Type 2 TLV) to the user area.
 */
export type SchemaArea =
  | { mode: 'raw'; startUnit: number }
  | { mode: 'ndef'; recordType: 'mime' | 'external'; type: string };

export interface DataSchema {
  format: typeof SCHEMA_FORMAT;
  version: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  /** Tag kinds the layout was designed for. */
  tagKinds: TagKind[];
  area: SchemaArea;
  /** Total bytes the layout occupies (>= max(offset+length) over fields). */
  size: number;
  fields: SchemaField[];
  createdAt: string;
  updatedAt: string;
}

export interface SchemaIssue {
  /** Field id, or null for schema-level problems. */
  field: string | null;
  severity: 'error' | 'warning';
  code:
    | 'FORMAT'
    | 'ID_INVALID'
    | 'ID_DUPLICATE'
    | 'OVERLAP'
    | 'OUT_OF_RANGE'
    | 'TOO_LARGE_FOR_TAG'
    | 'LENGTH'
    | 'SOURCE_TYPE'
    | 'CHECKSUM_REF'
    | 'PROTECTED_AREA'
    | 'VALUE';
  message: string;
}

/** Context available when rendering one tag's values. */
export interface IssueContext {
  seq: number | null;
  row: Record<string, string> | null;
  inputs: Record<string, string>;
  /** Read-only UID of the tag being issued (hex). */
  uid: string | null;
  now: Date;
}
