import { describe, it, expect } from 'vitest';
import {
  checksum,
  encodeSchema,
  decodeSchema,
  renderValues,
  validateSchema,
  serializeSchema,
  parseSchemaFile,
  parseCsv,
  toCsv,
  expandTemplate,
  expandDraft,
  listPlaceholders,
  buildSchemaWrites,
  schemaAreaFromImage,
  schemaPresets,
  newSchema,
  SchemaValueError,
  SCHEMA_FORMAT,
  SCHEMA_VERSION,
} from '@shared/schema';
import type { DataSchema, IssueContext, SchemaField } from '@shared/schema';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/hex';
import { factoryImage, mifareIsTrailer } from '@shared/tags';
import type { TagImage } from '@shared/types';

// --- helpers ---------------------------------------------------------------

function schemaOf(fields: SchemaField[], size: number, area?: DataSchema['area']): DataSchema {
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 't',
    name: 't',
    description: '',
    tagKinds: ['NTAG213'],
    area: area ?? { mode: 'raw', startUnit: 4 },
    size,
    fields,
    createdAt: '',
    updatedAt: '',
  };
}

function ctx(over: Partial<IssueContext> = {}): IssueContext {
  return { seq: null, row: null, inputs: {}, uid: null, now: new Date(2026, 10, 9, 12, 34, 56), ...over };
}

function roundtrip(field: SchemaField, c: IssueContext = ctx()): string {
  const s = schemaOf([field], field.offset + field.length);
  const { bytes } = encodeSchema(s, c);
  return decodeSchema(s, bytes).values[field.id];
}

const bytesOf = (field: SchemaField, c: IssueContext = ctx()): number[] =>
  Array.from(encodeSchema(schemaOf([field], field.offset + field.length), c).bytes);

// --- checksums -------------------------------------------------------------

describe('checksum', () => {
  it('crc16-ccitt("123456789") = 0x29B1', () => {
    expect(Array.from(checksum('crc16-ccitt', utf8ToBytes('123456789')))).toEqual([0x29, 0xb1]);
  });
  it('crc32("123456789") = 0xCBF43926', () => {
    expect(Array.from(checksum('crc32', utf8ToBytes('123456789')))).toEqual([0xcb, 0xf4, 0x39, 0x26]);
  });
  it('xor8 / sum8', () => {
    expect(Array.from(checksum('xor8', Uint8Array.from([0x01, 0x02, 0x03])))).toEqual([0x00]);
    expect(Array.from(checksum('sum8', Uint8Array.from([0xff, 0x02])))).toEqual([0x01]);
  });
  it('luhn check digit of "7992739871" is "3"', () => {
    expect(checksum('luhn', utf8ToBytes('7992739871'))[0]).toBe('3'.charCodeAt(0));
  });
});

// --- type encode/decode round trips ---------------------------------------

describe('field encode -> decode round trip', () => {
  it('uint big-endian', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'uint', offset: 0, length: 4, source: { kind: 'fixed', value: '305419896' }, endian: 'be' };
    expect(bytesOf(f)).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(roundtrip(f)).toBe('305419896');
  });
  it('uint little-endian stores reversed but decodes the same', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'uint', offset: 0, length: 4, source: { kind: 'fixed', value: '305419896' }, endian: 'le' };
    expect(bytesOf(f)).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(roundtrip(f)).toBe('305419896');
  });
  it('bcd', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'bcd', offset: 0, length: 2, source: { kind: 'fixed', value: '1234' } };
    expect(bytesOf(f)).toEqual([0x12, 0x34]);
    expect(roundtrip(f)).toBe('1234');
  });
  it('ascii left and right aligned', () => {
    const left: SchemaField = { id: 'a', label: 'A', type: 'ascii', offset: 0, length: 4, source: { kind: 'fixed', value: 'AB' } };
    expect(bytesOf(left)).toEqual([0x41, 0x42, 0x00, 0x00]);
    expect(roundtrip(left)).toBe('AB');
    const right: SchemaField = { id: 'a', label: 'A', type: 'ascii', offset: 0, length: 4, align: 'right', source: { kind: 'fixed', value: '42' } };
    expect(bytesOf(right)).toEqual([0x00, 0x00, 0x34, 0x32]);
    expect(roundtrip(right)).toBe('42');
  });
  it('utf8 multibyte', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'utf8', offset: 0, length: 8, source: { kind: 'fixed', value: '日本' } };
    expect(roundtrip(f)).toBe('日本');
  });
  it('hex', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'hex', offset: 0, length: 3, source: { kind: 'fixed', value: '0A0B0C' } };
    expect(bytesOf(f)).toEqual([0x0a, 0x0b, 0x0c]);
    expect(roundtrip(f)).toBe('0A0B0C');
  });
  it('date YYYYMMDD (bcd)', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'date', offset: 0, length: 4, source: { kind: 'fixed', value: '2026-11-09' }, dateFormat: 'YYYYMMDD', dateEncoding: 'bcd' };
    expect(bytesOf(f)).toEqual([0x20, 0x26, 0x11, 0x09]);
    expect(roundtrip(f)).toBe('2026-11-09');
  });
  it('date YYMMDD (bcd)', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'date', offset: 0, length: 3, source: { kind: 'fixed', value: '2026-11-09' }, dateFormat: 'YYMMDD', dateEncoding: 'bcd' };
    expect(bytesOf(f)).toEqual([0x26, 0x11, 0x09]);
    expect(roundtrip(f)).toBe('2026-11-09');
  });
  it('date YYYYMMDDhhmm (ascii)', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'date', offset: 0, length: 12, source: { kind: 'fixed', value: '2026-11-09T12:34' }, dateFormat: 'YYYYMMDDhhmm', dateEncoding: 'ascii' };
    expect(roundtrip(f)).toBe('2026-11-09T12:34');
  });
  it('date unix32 round trips (timezone-stable)', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'date', offset: 0, length: 4, source: { kind: 'fixed', value: '2026-11-09T12:34:56' }, dateFormat: 'unix32' };
    expect(roundtrip(f)).toBe('2026-11-09T12:34:56');
  });
});

// --- sequence source -------------------------------------------------------

describe('sequence source', () => {
  it('produces an incrementing, zero-padded id per seq value', () => {
    const f: SchemaField = { id: 'id', label: 'ID', type: 'ascii', offset: 0, length: 6, source: { kind: 'sequence', offset: 0 }, digits: 6, align: 'right' };
    const s = schemaOf([f], 6);
    expect(encodeSchema(s, ctx({ seq: 1 })).values.id).toBe('000001');
    expect(encodeSchema(s, ctx({ seq: 2 })).values.id).toBe('000002');
    expect(encodeSchema(s, ctx({ seq: 42 })).values.id).toBe('000042');
    // offset applies on top of seq
    const g: SchemaField = { id: 'n', label: 'N', type: 'uint', offset: 0, length: 4, source: { kind: 'sequence', offset: 1000 } };
    expect(renderValues(schemaOf([g], 4), ctx({ seq: 7 })).n).toBe('1007');
  });
  it('renderValues is lenient when seq is missing; encodeSchema throws', () => {
    const f: SchemaField = { id: 'id', label: 'ID', type: 'uint', offset: 0, length: 4, source: { kind: 'sequence', offset: 0 } };
    expect(renderValues(schemaOf([f], 4), ctx()).id).toBe('');
    expect(() => encodeSchema(schemaOf([f], 4), ctx())).toThrow(SchemaValueError);
  });
});

// --- overflow --------------------------------------------------------------

describe('overflow throws SchemaValueError', () => {
  it('uint too large for its byte width', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'uint', offset: 0, length: 1, source: { kind: 'fixed', value: '999' } };
    try {
      encodeSchema(schemaOf([f], 1), ctx());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValueError);
      expect((e as SchemaValueError).fieldId).toBe('a');
    }
  });
  it('bcd too many digits', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'bcd', offset: 0, length: 2, source: { kind: 'fixed', value: '123456' } };
    expect(() => encodeSchema(schemaOf([f], 2), ctx())).toThrow(SchemaValueError);
  });
  it('ascii out of range char', () => {
    const f: SchemaField = { id: 'a', label: 'A', type: 'ascii', offset: 0, length: 4, source: { kind: 'fixed', value: '日' } };
    expect(() => encodeSchema(schemaOf([f], 4), ctx())).toThrow(SchemaValueError);
  });
});

// --- checksum field inside a schema ---------------------------------------

describe('checksum field', () => {
  it('computes crc16 over a data field and flags a mismatch on decode', () => {
    const s = schemaOf(
      [
        { id: 'data', label: 'D', type: 'ascii', offset: 0, length: 9, source: { kind: 'fixed', value: '123456789' } },
        { id: 'crc', label: 'C', type: 'checksum', offset: 9, length: 2, source: { kind: 'computed' }, checksum: { algo: 'crc16-ccitt', over: ['data'] } },
      ],
      11,
    );
    const { bytes, values } = encodeSchema(s, ctx());
    expect(Array.from(bytes.subarray(9, 11))).toEqual([0x29, 0xb1]);
    expect(values.crc).toBe('29B1');
    expect(decodeSchema(s, bytes).issues).toEqual([]);
    const bad = Uint8Array.from(bytes);
    bad[0] ^= 0xff;
    expect(decodeSchema(s, bad).issues.some((i) => i.code === 'VALUE')).toBe(true);
  });
});

// --- CSV -------------------------------------------------------------------

describe('CSV (RFC 4180)', () => {
  it('parses quoted fields, embedded commas, quotes and CRLF', () => {
    const text = 'name,note\r\n"Smith, John","a ""quoted"" line\r\nsecond"\r\nAlice,hi\r\n';
    const { header, rows } = parseCsv(text);
    expect(header).toEqual(['name', 'note']);
    expect(rows[0].name).toBe('Smith, John');
    expect(rows[0].note).toBe('a "quoted" line\r\nsecond');
    expect(rows[1]).toEqual({ name: 'Alice', note: 'hi' });
  });
  it('tolerates a BOM', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n').header).toEqual(['a', 'b']);
  });
  it('toCsv quotes where needed and round trips', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'z"q'], [1, null]])).toBe('a,b\r\n"x,y","z""q"\r\n1,');
    const rt = parseCsv(toCsv(['a', 'b'], [['x,y', 'z"q']]));
    expect(rt.rows[0]).toEqual({ a: 'x,y', b: 'z"q' });
  });
});

// --- placeholders ----------------------------------------------------------

describe('placeholders', () => {
  const c = ctx({ seq: 42, uid: '04A1B2C3D4E5F6', row: { col: 'R' }, inputs: { name: 'N' }, now: new Date(2026, 10, 9, 8, 5, 0) });
  it('expands every supported placeholder', () => {
    expect(expandTemplate('{{seq}}', c)).toBe('42');
    expect(expandTemplate('{{seq:6}}', c)).toBe('000042');
    expect(expandTemplate('{{uid}}', c)).toBe('04A1B2C3D4E5F6');
    expect(expandTemplate('id-{{uid:last4}}', c)).toBe('id-E5F6');
    expect(expandTemplate('{{date}}', c)).toBe('20261109');
    expect(expandTemplate('{{date:YYYY-MM-DD}}', c)).toBe('2026-11-09');
    expect(expandTemplate('{{time:hhmm}}', c)).toBe('0805');
    expect(expandTemplate('{{csv:col}}', c)).toBe('R');
    expect(expandTemplate('{{input:name}}', c)).toBe('N');
  });
  it('throws on an unknown placeholder', () => {
    expect(() => expandTemplate('{{bogus}}', c)).toThrow(SchemaValueError);
  });
  it('lists placeholders in first-seen order, deduped', () => {
    expect(listPlaceholders('{{seq}}-{{csv:col}}-{{seq}}')).toEqual(['seq', 'csv:col']);
  });
  it('expands text fields of a draft', () => {
    expect(expandDraft({ kind: 'uri', uri: 'https://x/{{seq:3}}' }, ctx({ seq: 7 }))).toEqual({ kind: 'uri', uri: 'https://x/007' });
  });
});

// --- MIFARE raw block crossing --------------------------------------------

describe('MIFARE raw area crosses a sector trailer', () => {
  it('buildSchemaWrites skips block 0 + trailers; schemaAreaFromImage reconstructs', () => {
    const kind = 'MIFARE_CLASSIC_1K' as const;
    const uid = hexToBytes('DEADBEEF');
    const data = factoryImage(kind, uid);
    const area = new Uint8Array(48);
    for (let i = 0; i < area.length; i++) area[i] = i & 0xff;
    const schema = schemaOf([], 48, { mode: 'raw', startUnit: 1 });

    expect(mifareIsTrailer(3)).toBe(true);
    const writes = buildSchemaWrites(schema, kind, data, area);
    expect(writes.map((w) => w.unit)).toEqual([1, 2, 4]);
    expect(Array.from(writes[0].data)).toEqual(Array.from(area.subarray(0, 16)));
    expect(Array.from(writes[1].data)).toEqual(Array.from(area.subarray(16, 32)));
    expect(Array.from(writes[2].data)).toEqual(Array.from(area.subarray(32, 48)));

    for (const w of writes) data.set(w.data, w.unit * 16);
    const img: TagImage = { kind, uid: bytesToHex(uid), data, unitStatus: [], readAt: 0 };
    const extracted = schemaAreaFromImage(schema, img);
    expect(extracted).not.toBeNull();
    expect(Array.from(extracted as Uint8Array)).toEqual(Array.from(area));
  });

  it('refuses to start in a protected unit', () => {
    const kind = 'MIFARE_CLASSIC_1K' as const;
    const data = factoryImage(kind, hexToBytes('01020304'));
    const schema = schemaOf([], 16, { mode: 'raw', startUnit: 3 }); // block 3 = trailer
    expect(() => buildSchemaWrites(schema, kind, data, new Uint8Array(16))).toThrow(SchemaValueError);
  });
});

// --- validateSchema --------------------------------------------------------

describe('validateSchema', () => {
  const base = (): Record<string, unknown> => ({
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 's1',
    name: 'n',
    description: '',
    tagKinds: ['NTAG213'],
    area: { mode: 'raw', startUnit: 4 },
    size: 8,
    fields: [{ id: 'a', label: 'A', type: 'uint', offset: 0, length: 4, source: { kind: 'fixed', value: '1' } }],
    createdAt: 'x',
    updatedAt: 'x',
  });
  const codesOf = (v: unknown, kind?: Parameters<typeof validateSchema>[1]) =>
    validateSchema(v, kind).issues.filter((i) => i.severity === 'error').map((i) => i.code);

  it('accepts a valid schema and normalises it', () => {
    const { schema, issues } = validateSchema(base());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(schema).not.toBeNull();
    expect(schema?.fields[0].id).toBe('a');
  });
  it('FORMAT on wrong format marker', () => {
    const v = base();
    v.format = 'nope';
    const { schema } = validateSchema(v);
    expect(codesOf(v)).toContain('FORMAT');
    expect(schema).toBeNull();
  });
  it('ID_INVALID on a non-conforming field id', () => {
    const v = base();
    (v.fields as Record<string, unknown>[])[0].id = 'Bad-Id';
    expect(codesOf(v)).toContain('ID_INVALID');
  });
  it('ID_DUPLICATE on repeated ids', () => {
    const v = base();
    v.fields = [
      { id: 'a', label: 'A', type: 'uint', offset: 0, length: 2, source: { kind: 'fixed', value: '1' } },
      { id: 'a', label: 'A2', type: 'uint', offset: 2, length: 2, source: { kind: 'fixed', value: '1' } },
    ];
    expect(codesOf(v)).toContain('ID_DUPLICATE');
  });
  it('OVERLAP on overlapping ranges', () => {
    const v = base();
    v.fields = [
      { id: 'a', label: 'A', type: 'uint', offset: 0, length: 4, source: { kind: 'fixed', value: '1' } },
      { id: 'b', label: 'B', type: 'uint', offset: 2, length: 4, source: { kind: 'fixed', value: '1' } },
    ];
    expect(codesOf(v)).toContain('OVERLAP');
  });
  it('OUT_OF_RANGE when a field exceeds size', () => {
    const v = base();
    v.size = 2;
    expect(codesOf(v)).toContain('OUT_OF_RANGE');
  });
  it('TOO_LARGE_FOR_TAG when raw area does not fit the tag', () => {
    const v = base();
    v.area = { mode: 'raw', startUnit: 1 };
    v.size = 800;
    v.fields = [{ id: 'a', label: 'A', type: 'hex', offset: 0, length: 4, source: { kind: 'fixed', value: '00000000' } }];
    expect(codesOf(v, 'MIFARE_CLASSIC_1K')).toContain('TOO_LARGE_FOR_TAG');
  });
  it('LENGTH when a checksum width is wrong', () => {
    const v = base();
    v.size = 6;
    v.fields = [
      { id: 'a', label: 'A', type: 'uint', offset: 0, length: 4, source: { kind: 'fixed', value: '1' } },
      { id: 'c', label: 'C', type: 'checksum', offset: 4, length: 1, source: { kind: 'computed' }, checksum: { algo: 'crc16-ccitt', over: ['a'] } },
    ];
    expect(codesOf(v)).toContain('LENGTH');
  });
  it('SOURCE_TYPE when source and type disagree', () => {
    const v = base();
    (v.fields as Record<string, unknown>[])[0].source = { kind: 'now' }; // now on a uint
    expect(codesOf(v)).toContain('SOURCE_TYPE');
  });
  it('CHECKSUM_REF for a missing reference', () => {
    const v = base();
    v.size = 1;
    v.fields = [{ id: 'c', label: 'C', type: 'checksum', offset: 0, length: 1, source: { kind: 'computed' }, checksum: { algo: 'xor8', over: ['ghost'] } }];
    expect(codesOf(v)).toContain('CHECKSUM_REF');
  });
  it('PROTECTED_AREA when raw area starts in a protected unit', () => {
    const v = base();
    v.area = { mode: 'raw', startUnit: 2 }; // NTAG page 2 is protected
    expect(codesOf(v, 'NTAG213')).toContain('PROTECTED_AREA');
  });
});

// --- serialize / parse -----------------------------------------------------

describe('serialize / parse', () => {
  it('round trips through *.nfcschema bytes, BOM tolerated', () => {
    const valid = schemaOf([{ id: 'a', label: 'A', type: 'uint', offset: 0, length: 4, source: { kind: 'fixed', value: '1' } }], 8);
    const bytes = serializeSchema(valid);
    const withBom = new Uint8Array(bytes.length + 3);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(bytes, 3);
    const { schema, issues } = parseSchemaFile(withBom);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(schema?.fields[0].id).toBe('a');
  });
  it('reports FORMAT on invalid JSON', () => {
    const { schema, issues } = parseSchemaFile(utf8ToBytes('{not json'));
    expect(schema).toBeNull();
    expect(issues[0].code).toBe('FORMAT');
  });
});

// --- presets + newSchema ---------------------------------------------------

describe('presets and newSchema', () => {
  it('every preset validates (and fits its first tag kind)', () => {
    for (const p of schemaPresets('2026-11-09T00:00:00Z')) {
      const { schema, issues } = validateSchema(p, p.tagKinds[0]);
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(schema).not.toBeNull();
    }
  });
  it('an employee-id preset encodes an incrementing id + luhn digit', () => {
    const employee = schemaPresets('2026-11-09')[0];
    const { values } = encodeSchema(employee, ctx({ seq: 0 })); // seq 0 + offset 1000 => 00001000
    expect(values.employee_id).toBe('00001000');
    expect(values.check).toMatch(/^[0-9]$/);
  });
  it('newSchema returns a valid empty raw schema', () => {
    const ns = newSchema({ id: 'x', name: 'New', kind: 'NTAG213', nowIso: '2026-11-09' });
    expect(ns.area).toEqual({ mode: 'raw', startUnit: 4 });
    expect(validateSchema(ns).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
