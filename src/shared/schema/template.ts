// Placeholder expansion for NDEF record drafts and free text used in issuing.
//
// Supported placeholders:
//   {{seq}}  {{seq:6}}            sequence counter (optionally zero-padded)
//   {{uid}}  {{uid:last4}}        read-only UID (hex), or its last 4 hex chars
//   {{date}} {{date:YYYY-MM-DD}}  write date (default YYYYMMDD)
//   {{time:hhmm}}                 write time
//   {{csv:column}}               value from the assigned CSV row
//   {{input:name}}               value typed once per issue job
//
// Pure TypeScript: no Node, no DOM.

import type { NdefRecordDraft } from '../ndef/types';
import { SchemaValueError } from './errors';
import type { IssueContext } from './types';

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

const p2 = (n: number): string => String(n).padStart(2, '0');
const p4 = (n: number): string => String(n).padStart(4, '0');

/** Format a date against a token pattern (YYYY, YY, MM, DD, hh, mm, ss). */
function formatDateTime(date: Date, pattern: string): string {
  const map: Record<string, string> = {
    YYYY: p4(date.getFullYear()),
    YY: p2(date.getFullYear() % 100),
    MM: p2(date.getMonth() + 1),
    DD: p2(date.getDate()),
    hh: p2(date.getHours()),
    mm: p2(date.getMinutes()),
    ss: p2(date.getSeconds()),
  };
  return pattern.replace(/YYYY|YY|MM|DD|hh|mm|ss/g, (t) => map[t]);
}

function resolvePlaceholder(token: string, ctx: IssueContext): string {
  const colon = token.indexOf(':');
  const name = colon === -1 ? token : token.slice(0, colon);
  const arg = colon === -1 ? '' : token.slice(colon + 1);
  switch (name) {
    case 'seq': {
      if (ctx.seq === null) throw new SchemaValueError('_template', '連番（seq）が指定されていません');
      const s = String(ctx.seq);
      const width = arg ? parseInt(arg, 10) : 0;
      return Number.isFinite(width) && width > 0 ? s.padStart(width, '0') : s;
    }
    case 'uid': {
      if (!ctx.uid) throw new SchemaValueError('_template', 'UID が読み取れていません');
      const hex = ctx.uid.toUpperCase();
      return arg === 'last4' ? hex.slice(-4) : hex;
    }
    case 'date':
      return formatDateTime(ctx.now, arg || 'YYYYMMDD');
    case 'time':
      return formatDateTime(ctx.now, arg || 'hhmm');
    case 'csv': {
      if (!ctx.row) throw new SchemaValueError('_template', 'CSV の行が指定されていません');
      return ctx.row[arg] ?? '';
    }
    case 'input':
      return ctx.inputs[arg] ?? '';
    default:
      throw new SchemaValueError('_template', `未対応のプレースホルダです: {{${token}}}`);
  }
}

/** Expand every {{...}} placeholder in `text`. Unknown placeholders throw SchemaValueError. */
export function expandTemplate(text: string, ctx: IssueContext): string {
  return text.replace(PLACEHOLDER, (_m, token: string) => resolvePlaceholder(token.trim(), ctx));
}

/** Placeholder tokens used in a text, in first-seen order (e.g. ["seq", "csv:社員番号"]). */
export function listPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const token = m[1].trim();
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** Expand placeholders in every text field of an NDEF record draft. */
export function expandDraft(draft: NdefRecordDraft, ctx: IssueContext): NdefRecordDraft {
  const ex = (s: string): string => expandTemplate(s, ctx);
  switch (draft.kind) {
    case 'uri':
      return { ...draft, uri: ex(draft.uri) };
    case 'text':
      return { ...draft, text: ex(draft.text) };
    case 'wifi':
      return { ...draft, ssid: ex(draft.ssid), password: ex(draft.password) };
    case 'vcard': {
      const f = draft.fields;
      return {
        ...draft,
        fields: {
          ...f,
          name: ex(f.name),
          org: f.org === undefined ? undefined : ex(f.org),
          title: f.title === undefined ? undefined : ex(f.title),
          tel: f.tel === undefined ? undefined : ex(f.tel),
          email: f.email === undefined ? undefined : ex(f.email),
          url: f.url === undefined ? undefined : ex(f.url),
          address: f.address === undefined ? undefined : ex(f.address),
          note: f.note === undefined ? undefined : ex(f.note),
        },
      };
    }
    case 'mime':
      return { ...draft, mimeType: ex(draft.mimeType), payloadText: ex(draft.payloadText) };
    case 'aar':
      return { ...draft, packageName: ex(draft.packageName) };
    case 'external':
      return { ...draft, domainType: ex(draft.domainType), payloadText: ex(draft.payloadText) };
    case 'smartposter':
      return { ...draft, uri: ex(draft.uri), title: ex(draft.title) };
    case 'raw':
      return { ...draft };
    case 'empty':
      return { ...draft };
  }
}
