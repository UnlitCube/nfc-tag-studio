// RFC 4180 CSV reader/writer. UTF-8 text in/out; the caller handles BOM bytes for
// Excel on the write side and may pass a BOM-prefixed string on the read side.
//
// Pure TypeScript: no Node, no DOM.

/** Strip a leading UTF-8 BOM (U+FEFF) if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into header + rows. Quoted fields may contain commas, CR, LF and
 * escaped quotes (""). CRLF and LF line endings are both accepted. The first
 * non-empty logical record is the header; each row maps header name -> value.
 * Missing trailing columns become '' ; extra columns are dropped.
 */
export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const src = stripBom(text);
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let seenAny = false; // any char seen on the current record (to tell blank lines apart)

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    seenAny = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      seenAny = true;
    } else if (ch === ',') {
      seenAny = true;
      endField();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRecord();
    } else if (ch === '\n') {
      endRecord();
    } else {
      seenAny = true;
      field += ch;
    }
  }
  // Flush the last record unless the input ended exactly on a line break.
  if (seenAny || field.length > 0 || record.length > 0) {
    endRecord();
  }

  // Drop fully blank records (a single empty field and nothing else).
  const clean = records.filter((r) => !(r.length === 1 && r[0] === ''));
  if (clean.length === 0) return { header: [], rows: [] };

  const header = clean[0];
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < clean.length; r++) {
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = clean[r][c] ?? '';
    rows.push(row);
  }
  return { header, rows };
}

/** A field needs quoting when it contains a comma, double quote, CR or LF. */
function needsQuote(s: string): boolean {
  return s.includes(',') || s.includes('"') || s.includes('\r') || s.includes('\n');
}

function quoteField(value: string | number | null): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (needsQuote(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Render header + rows as CSV with CRLF line endings, quoting where required.
 * Numbers are stringified; null/undefined become empty fields. No trailing CRLF.
 * The caller prepends a BOM (﻿) when the target is Excel.
 */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const lines: string[] = [];
  lines.push(header.map(quoteField).join(','));
  for (const row of rows) lines.push(row.map(quoteField).join(','));
  return lines.join('\r\n');
}
