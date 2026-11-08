// Unit tests for the schema designer's pure helpers. Owner: renderer-schema.
// Scope-run with: npx vitest run tests/renderer-schema
// These exercise only framework-free logic in views/schema/helpers.ts; they do not
// touch the (separately owned) @shared/schema engine, React, or the DOM.
import { describe, expect, it } from 'vitest';
import {
  buildByteMap,
  computeSize,
  createEmptySchema,
  defaultLengthForType,
  defaultSourceForType,
  fieldColorVar,
  isDataSchemaLike,
  makeField,
  makeSource,
  moveItem,
  retypeField,
  sampleContext,
  sampleUidHex,
  slugifyId,
  suggestOffset,
  uniqueFieldId,
  upsertById,
  withSourceKind,
} from '../../src/renderer/src/views/schema/helpers';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '../../src/shared/schema/types';
import type { SchemaField } from '../../src/shared/schema/types';

function field(partial: Partial<SchemaField> & Pick<SchemaField, 'id' | 'offset' | 'length'>): SchemaField {
  return makeField({
    id: partial.id,
    label: partial.label ?? partial.id,
    type: partial.type,
    source: partial.source,
    offset: partial.offset,
    length: partial.length,
  });
}

describe('defaultLengthForType', () => {
  it('gives a sensible default per type', () => {
    expect(defaultLengthForType('uint')).toBe(2);
    expect(defaultLengthForType('checksum')).toBe(1);
    expect(defaultLengthForType('ascii')).toBe(8);
  });
});

describe('makeSource / defaultSourceForType', () => {
  it('builds each source shape', () => {
    expect(makeSource('sequence')).toEqual({ kind: 'sequence', offset: 0 });
    expect(makeSource('uid')).toEqual({ kind: 'uid', part: 'full' });
    expect(makeSource('fixed')).toEqual({ kind: 'fixed', value: '' });
    expect(makeSource('csv')).toEqual({ kind: 'csv', column: '' });
  });
  it('defaults checksum fields to computed and dates to now', () => {
    expect(defaultSourceForType('checksum')).toEqual({ kind: 'computed' });
    expect(defaultSourceForType('date')).toEqual({ kind: 'now' });
    expect(defaultSourceForType('uint')).toEqual({ kind: 'fixed', value: '' });
  });
});

describe('slugifyId', () => {
  it('normalises ascii labels', () => {
    expect(slugifyId('Employee ID')).toBe('employee_id');
    expect(slugifyId('社員ID')).toBe('id');
  });
  it('falls back when nothing usable remains', () => {
    expect(slugifyId('社員番号')).toBe('field');
    expect(slugifyId('')).toBe('field');
  });
  it('prefixes a leading digit so the id starts with a letter', () => {
    expect(slugifyId('1st')).toBe('f1st');
  });
});

describe('uniqueFieldId', () => {
  it('returns the base when free', () => {
    expect(uniqueFieldId('seq', ['a', 'b'])).toBe('seq');
  });
  it('suffixes on collision', () => {
    expect(uniqueFieldId('seq', ['seq'])).toBe('seq_2');
    expect(uniqueFieldId('seq', ['seq', 'seq_2'])).toBe('seq_3');
  });
});

describe('suggestOffset / computeSize', () => {
  it('is the max end offset of all fields', () => {
    const fields = [field({ id: 'a', offset: 0, length: 4 }), field({ id: 'b', offset: 4, length: 2 })];
    expect(suggestOffset(fields)).toBe(6);
    expect(computeSize(fields)).toBe(6);
  });
  it('is 0 for an empty layout', () => {
    expect(suggestOffset([])).toBe(0);
  });
});

describe('moveItem', () => {
  it('reorders immutably', () => {
    const a = ['x', 'y', 'z'];
    expect(moveItem(a, 0, 2)).toEqual(['y', 'z', 'x']);
    expect(a).toEqual(['x', 'y', 'z']);
  });
  it('is a no-op copy on bad indices', () => {
    expect(moveItem(['x', 'y'], 0, 0)).toEqual(['x', 'y']);
    expect(moveItem(['x', 'y'], -1, 5)).toEqual(['x', 'y']);
  });
});

describe('makeField', () => {
  it('sets endian for uint', () => {
    const f = makeField({ id: 'n', label: 'n', type: 'uint', offset: 0 });
    expect(f.endian).toBe('be');
    expect(f.length).toBe(2);
  });
  it('sets pad/align for ascii and a checksum body for checksum', () => {
    const a = makeField({ id: 't', label: 't', type: 'ascii', offset: 0 });
    expect(a.pad).toBe('zero');
    expect(a.align).toBe('left');
    const c = makeField({ id: 'c', label: 'c', type: 'checksum', offset: 0 });
    expect(c.checksum).toEqual({ algo: 'xor8', over: [] });
    expect(c.source).toEqual({ kind: 'computed' });
  });
});

describe('retypeField', () => {
  it('forces computed source on checksum and restores a fixed source when leaving checksum', () => {
    const c = makeField({ id: 'c', label: 'c', type: 'checksum', offset: 0 });
    expect(c.source.kind).toBe('computed');
    const back = retypeField(c, 'uint');
    expect(back.source).toEqual({ kind: 'fixed', value: '' });
    expect(back.endian).toBe('be');
    expect(back.checksum).toBeUndefined();
  });
  it('drops ascii-only options when switching to uint', () => {
    const a = makeField({ id: 'a', label: 'a', type: 'ascii', offset: 0 });
    const u = retypeField(a, 'uint');
    expect(u.align).toBeUndefined();
    expect(u.pad).toBeUndefined();
  });
});

describe('withSourceKind', () => {
  it('replaces the source object', () => {
    const f = makeField({ id: 'a', label: 'a', type: 'uint', offset: 0 });
    expect(withSourceKind(f, 'sequence').source).toEqual({ kind: 'sequence', offset: 0 });
  });
  it('refuses computed on a non-checksum field', () => {
    const f = makeField({ id: 'a', label: 'a', type: 'uint', offset: 0 });
    expect(withSourceKind(f, 'computed')).toBe(f);
  });
});

describe('upsertById', () => {
  it('appends new items and replaces matching ids', () => {
    const list = [{ id: 'a', v: 1 }];
    expect(upsertById(list, { id: 'b', v: 2 })).toHaveLength(2);
    expect(upsertById(list, { id: 'a', v: 9 })).toEqual([{ id: 'a', v: 9 }]);
  });
});

describe('createEmptySchema', () => {
  it('builds a valid empty schema at the first user unit', () => {
    const s = createEmptySchema({ id: 's1', name: '社員証', kind: 'NTAG213', nowIso: '2026-11-09T00:00:00.000Z' });
    expect(s.format).toBe(SCHEMA_FORMAT);
    expect(s.version).toBe(SCHEMA_VERSION);
    expect(s.area).toEqual({ mode: 'raw', startUnit: 4 });
    expect(s.fields).toEqual([]);
    expect(s.tagKinds).toEqual(['NTAG213']);
  });
  it('starts a MIFARE schema at block 1 (block 0 is the forbidden UID block)', () => {
    const s = createEmptySchema({ id: 's2', name: 'x', kind: 'MIFARE_CLASSIC_1K', nowIso: 'now' });
    expect(s.area).toEqual({ mode: 'raw', startUnit: 1 });
  });
});

describe('isDataSchemaLike', () => {
  it('accepts a schema-shaped object and rejects junk', () => {
    const s = createEmptySchema({ id: 's', name: 'n', kind: 'NTAG215', nowIso: 'now' });
    expect(isDataSchemaLike(s)).toBe(true);
    expect(isDataSchemaLike({ format: 'nope', fields: [] })).toBe(false);
    expect(isDataSchemaLike(null)).toBe(false);
    expect(isDataSchemaLike(42)).toBe(false);
  });
});

describe('buildByteMap', () => {
  it('maps bytes to the owning field index', () => {
    const fields = [field({ id: 'a', offset: 0, length: 2 }), field({ id: 'b', offset: 2, length: 2 })];
    const { map, overlaps } = buildByteMap(fields, 4);
    expect(map).toEqual([0, 0, 1, 1]);
    expect(overlaps.size).toBe(0);
  });
  it('flags overlapping bytes', () => {
    const fields = [field({ id: 'a', offset: 0, length: 3 }), field({ id: 'b', offset: 2, length: 2 })];
    const { overlaps } = buildByteMap(fields, 4);
    expect(overlaps.has(2)).toBe(true);
    expect(overlaps.has(1)).toBe(false);
  });
});

describe('fieldColorVar', () => {
  it('returns a token-backed var() and cycles', () => {
    expect(fieldColorVar(0)).toBe('var(--accent-soft)');
    expect(fieldColorVar(0)).toBe(fieldColorVar(8));
    expect(fieldColorVar(1)).not.toBe(fieldColorVar(0));
  });
});

describe('sampleUidHex', () => {
  it('matches the uid byte length of the kind', () => {
    expect(sampleUidHex('NTAG213')).toHaveLength(14); // 7 bytes
    expect(sampleUidHex('MIFARE_CLASSIC_1K')).toHaveLength(8); // 4 bytes
  });
});

describe('sampleContext', () => {
  it('fills inputs from input defaults and a csv row, with seq=1', () => {
    const s = createEmptySchema({ id: 's', name: 'n', kind: 'NTAG213', nowIso: 'now' });
    s.fields = [
      makeField({ id: 'dept', label: '部署', type: 'ascii', source: { kind: 'input', defaultValue: 'SALES' }, offset: 0 }),
      makeField({ id: 'name', label: '氏名', type: 'utf8', source: { kind: 'csv', column: '氏名' }, offset: 8 }),
      makeField({ id: 'sn', label: '連番', type: 'uint', source: { kind: 'sequence', offset: 0 }, offset: 24 }),
    ];
    const ctx = sampleContext(s);
    expect(ctx.seq).toBe(1);
    expect(ctx.inputs.dept).toBe('SALES');
    expect(ctx.row).not.toBeNull();
    expect(ctx.row?.['氏名']).toBeDefined();
    expect(ctx.uid).toHaveLength(14);
  });
  it('leaves row null when there are no csv fields', () => {
    const s = createEmptySchema({ id: 's', name: 'n', kind: 'NTAG213', nowIso: 'now' });
    expect(sampleContext(s).row).toBeNull();
  });
});
