// Pure-logic tests for the batch-issue view helpers. Node environment, no DOM.
import { describe, expect, it } from 'vitest';
import type { DataSchema, SchemaField } from '@shared/schema/types';
import type { IssueEvent } from '@shared/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '@shared/schema/types';
import { imageSize, specFor, TAG_KINDS } from '@shared/tags';
import {
  duplicateSize,
  duplicateUnits,
  issuePhase,
  parseIntInput,
  phaseTone,
  previewSlots,
  schemaCsvColumns,
  schemaInputFields,
  schemaUsesSequence,
  summarizeDraft,
} from '../src/renderer/src/views/issue/model';

function field(id: string, source: SchemaField['source']): SchemaField {
  return { id, label: id, type: 'ascii', offset: 0, length: 4, source };
}

function schema(fields: SchemaField[]): DataSchema {
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 's1',
    name: 'test',
    description: '',
    tagKinds: ['NTAG213'],
    area: { mode: 'raw', startUnit: 4 },
    size: 16,
    fields,
    createdAt: '2026-11-09',
    updatedAt: '2026-11-09',
  };
}

describe('previewSlots', () => {
  it('increments by step from next', () => {
    const r = previewSlots({ sequence: { start: 1, step: 10, next: 100 }, rowCount: null, rowStart: 0, limit: null, count: 3 });
    expect(r.map((s) => s.seq)).toEqual([100, 110, 120]);
    expect(r.every((s) => s.rowIndex === null)).toBe(true);
  });

  it('caps at the success limit', () => {
    const r = previewSlots({ sequence: { start: 1, step: 1, next: 1 }, rowCount: null, rowStart: 0, limit: 2, count: 5 });
    expect(r).toHaveLength(2);
  });

  it('stops when CSV rows are exhausted', () => {
    const r = previewSlots({ sequence: { start: 1, step: 1, next: 1 }, rowCount: 2, rowStart: 0, limit: null, count: 5 });
    expect(r).toHaveLength(2);
    expect(r.map((s) => s.rowIndex)).toEqual([0, 1]);
  });

  it('honours a non-zero rowStart', () => {
    const r = previewSlots({ sequence: { start: 1, step: 1, next: 1 }, rowCount: 5, rowStart: 3, limit: null, count: 5 });
    expect(r.map((s) => s.rowIndex)).toEqual([3, 4]);
  });
});

describe('schema field helpers', () => {
  const s = schema([
    field('dept', { kind: 'input', defaultValue: 'A' }),
    field('emp', { kind: 'sequence', offset: 0 }),
    field('name', { kind: 'csv', column: '氏名' }),
    field('code', { kind: 'csv', column: '部署' }),
    field('name2', { kind: 'csv', column: '氏名' }),
    field('lit', { kind: 'fixed', value: 'X' }),
  ]);

  it('finds input fields', () => {
    expect(schemaInputFields(s).map((f) => f.id)).toEqual(['dept']);
  });

  it('lists CSV columns deduped, first-seen order', () => {
    expect(schemaCsvColumns(s)).toEqual(['氏名', '部署']);
  });

  it('detects sequence usage', () => {
    expect(schemaUsesSequence(s)).toBe(true);
    expect(schemaUsesSequence(schema([field('lit', { kind: 'fixed', value: 'X' })]))).toBe(false);
  });
});

describe('duplicateUnits', () => {
  it('NTAG213: only user pages 4..39 (never UID/CC/config)', () => {
    const u = duplicateUnits('NTAG213');
    expect(u[0]).toBe(4);
    expect(u[u.length - 1]).toBe(39);
    expect(u).toHaveLength(36);
    expect(u).not.toContain(0);
    expect(u).not.toContain(3);
  });

  it('MIFARE 1K: data blocks only (no block 0, no trailers)', () => {
    const u = duplicateUnits('MIFARE_CLASSIC_1K');
    expect(u).toHaveLength(47);
    expect(u).not.toContain(0);
    expect(u).not.toContain(3); // sector 0 trailer
    expect(u).not.toContain(63); // sector 15 trailer
  });
});

describe('duplicateSize', () => {
  // Regression: the batch "duplicate" summary must show the bytes actually copied
  // (data area only), not imageSize (the whole tag incl. the uncopied UID/CC/
  // config/trailers). I1: the UID is never duplicated.
  it('counts only the copied data-area bytes', () => {
    expect(duplicateSize('NTAG213')).toBe(144); // 36 pages * 4, not 180
    expect(duplicateSize('NTAG215')).toBe(504); // not 540
    expect(duplicateSize('NTAG216')).toBe(888); // not 924
    expect(duplicateSize('MIFARE_CLASSIC_1K')).toBe(752); // not 1024
    expect(duplicateSize('MIFARE_CLASSIC_4K')).toBe(3440); // not 4096
  });

  it('equals units * unitSize and is strictly below imageSize for every kind', () => {
    for (const kind of TAG_KINDS) {
      const spec = specFor(kind);
      expect(duplicateSize(kind)).toBe(duplicateUnits(kind).length * spec.unitSize);
      // The whole-tag imageSize would overcount by the protected (uncopied) units.
      expect(duplicateSize(kind)).toBeLessThan(imageSize(kind));
    }
  });
});

describe('parseIntInput', () => {
  it('parses integers incl. sign and surrounding space', () => {
    expect(parseIntInput('5')).toBe(5);
    expect(parseIntInput('  5 ')).toBe(5);
    expect(parseIntInput('-3')).toBe(-3);
    expect(parseIntInput('+2')).toBe(2);
  });
  it('rejects non-integers', () => {
    expect(parseIntInput('')).toBeNull();
    expect(parseIntInput('abc')).toBeNull();
    expect(parseIntInput('1.5')).toBeNull();
    expect(parseIntInput('99999999999999999999')).toBeNull();
  });
});

describe('summarizeDraft', () => {
  it('never leaks a Wi-Fi password', () => {
    const r: NdefRecordDraft = { kind: 'wifi', ssid: 'Net', auth: 'wpa2-personal', encryption: 'aes', password: 'secret', hidden: false };
    const s = summarizeDraft(r);
    expect(s).toBe('Wi-Fi: Net');
    expect(s).not.toContain('secret');
  });
  it('summarizes common kinds', () => {
    expect(summarizeDraft({ kind: 'uri', uri: 'https://x' })).toBe('https://x');
    expect(summarizeDraft({ kind: 'text', text: 'hi', lang: 'en', encoding: 'utf8' })).toBe('hi');
    expect(summarizeDraft({ kind: 'empty' })).toBe('empty');
  });
});

describe('phase mapping', () => {
  it('maps events to phases', () => {
    expect(issuePhase(null)).toBe('idle');
    expect(issuePhase({ type: 'waiting', next: { seq: 1, rowIndex: null, values: {} }, issued: 0 })).toBe('waiting');
    expect(issuePhase({ type: 'writing', uid: 'AA', next: { seq: 1, rowIndex: null, values: {} } })).toBe('writing');
    expect(issuePhase({ type: 'remove-card', uid: 'AA' })).toBe('remove');
    const stopped: IssueEvent = { type: 'stopped', reason: 'user', issued: 3 };
    expect(issuePhase(stopped)).toBe('stopped');
  });
  it('maps phases to tones', () => {
    expect(phaseTone('success')).toBe('ok');
    expect(phaseTone('error')).toBe('danger');
    expect(phaseTone('skipped')).toBe('warn');
    expect(phaseTone('writing')).toBe('accent');
    expect(phaseTone('idle')).toBe('neutral');
  });
});
