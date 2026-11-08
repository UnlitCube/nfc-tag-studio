// vCard 3.0 build/parse for the MIME record "text/vcard". Pure TypeScript.
// Only the fields the editor exposes (VcardFields) are handled; unknown
// properties are ignored on parse.

import { NdefError } from './types';
import type { VcardFields } from './types';

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function unesc(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      const n = value[i + 1];
      i += 1;
      if (n === 'n' || n === 'N') out += '\n';
      else out += n; // \\ , ; and any other escaped char -> literal
    } else {
      out += c;
    }
  }
  return out;
}

/** Split on separator characters that are not escaped by a backslash. */
function splitUnescaped(value: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      cur += c + value[i + 1];
      i += 1;
    } else if (c === sep) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/** VcardFields -> vCard 3.0 text (CRLF line endings). */
export function buildVcard(fields: VcardFields): string {
  if (!fields.name || fields.name.trim() === '') throw new NdefError('名前（FN）は必須です');
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(fields.name)}`, `N:${esc(fields.name)};;;;`];
  if (fields.org) lines.push(`ORG:${esc(fields.org)}`);
  if (fields.title) lines.push(`TITLE:${esc(fields.title)}`);
  if (fields.tel) lines.push(`TEL:${esc(fields.tel)}`);
  if (fields.email) lines.push(`EMAIL:${esc(fields.email)}`);
  if (fields.url) lines.push(`URL:${esc(fields.url)}`);
  if (fields.address) lines.push(`ADR:;;${esc(fields.address)};;;;`);
  if (fields.note) lines.push(`NOTE:${esc(fields.note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

/** vCard text -> VcardFields (best effort). */
export function parseVcard(text: string): VcardFields {
  const fields: VcardFields = { name: '' };
  const rawLines = text.split(/\r\n|\r|\n/);
  // Unfold: a line starting with a space/tab continues the previous one.
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const rawKey = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const key = rawKey.split(';')[0].trim().toUpperCase();
    switch (key) {
      case 'FN':
        fields.name = unesc(value);
        break;
      case 'N':
        if (fields.name === '') {
          const comps = splitUnescaped(value, ';').map(unesc).filter((c) => c !== '');
          fields.name = comps.join(' ');
        }
        break;
      case 'ORG':
        fields.org = unesc(value);
        break;
      case 'TITLE':
        fields.title = unesc(value);
        break;
      case 'TEL':
        fields.tel = unesc(value);
        break;
      case 'EMAIL':
        fields.email = unesc(value);
        break;
      case 'URL':
        fields.url = unesc(value);
        break;
      case 'ADR': {
        const comps = splitUnescaped(value, ';');
        const street = comps[2] ?? '';
        const addr = street !== '' ? unesc(street) : comps.map(unesc).filter((c) => c !== '').join(' ');
        if (addr !== '') fields.address = addr;
        break;
      }
      case 'NOTE':
        fields.note = unesc(value);
        break;
      default:
        break;
    }
  }
  return fields;
}
