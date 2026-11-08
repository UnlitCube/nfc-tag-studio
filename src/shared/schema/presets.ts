// Built-in starting points for the schema designer. Practical, valid layouts the
// operator can tweak. Ids follow [a-z][a-z0-9_]*; checksum lengths match the algo.
//
// Pure TypeScript: no Node, no DOM.

import { SCHEMA_FORMAT, SCHEMA_VERSION, type DataSchema } from './types';

/** Built-in presets: 社員証 ID / 勤怠タグ / 会員番号 / 資産タグ. */
export function schemaPresets(nowIso: string): DataSchema[] {
  const stamp = { createdAt: nowIso, updatedAt: nowIso };

  const employee: DataSchema = {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'preset-employee-id',
    name: '社員証 ID',
    description: '連番の社員 ID（8 桁）に Luhn チェックディジットを付けて、NTAG のユーザー領域に書き込みます。UID は複製しません。',
    tagKinds: ['NTAG213', 'NTAG215', 'NTAG216'],
    area: { mode: 'raw', startUnit: 4 },
    size: 9,
    fields: [
      { id: 'employee_id', label: '社員 ID', type: 'ascii', offset: 0, length: 8, source: { kind: 'sequence', offset: 1000 }, digits: 8, align: 'right' },
      { id: 'check', label: 'チェックディジット', type: 'checksum', offset: 8, length: 1, source: { kind: 'computed' }, checksum: { algo: 'luhn', over: ['employee_id'] } },
    ],
    ...stamp,
  };

  const attendance: DataSchema = {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'preset-attendance',
    name: '勤怠タグ',
    description: '社員番号（BCD 8 桁）と発行日（YYYYMMDD）を記録し、CRC-16 で保護します。',
    tagKinds: ['NTAG213', 'NTAG215', 'NTAG216'],
    area: { mode: 'raw', startUnit: 4 },
    size: 10,
    fields: [
      { id: 'emp_no', label: '社員番号', type: 'bcd', offset: 0, length: 4, source: { kind: 'sequence', offset: 1 } },
      { id: 'issued', label: '発行日', type: 'date', offset: 4, length: 4, source: { kind: 'now' }, dateFormat: 'YYYYMMDD', dateEncoding: 'bcd' },
      { id: 'crc', label: 'CRC-16', type: 'checksum', offset: 8, length: 2, source: { kind: 'computed' }, checksum: { algo: 'crc16-ccitt', over: ['emp_no', 'issued'] } },
    ],
    ...stamp,
  };

  const membership: DataSchema = {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'preset-membership',
    name: '会員番号',
    description: '組織コード（2 バイト）と連番の会員番号（4 バイト整数）に XOR チェックサムを付けます。',
    tagKinds: ['NTAG213', 'NTAG215', 'NTAG216'],
    area: { mode: 'raw', startUnit: 4 },
    size: 7,
    fields: [
      { id: 'org', label: '組織コード', type: 'uint', offset: 0, length: 2, source: { kind: 'fixed', value: '1' }, endian: 'be' },
      { id: 'member_no', label: '会員番号', type: 'uint', offset: 2, length: 4, source: { kind: 'sequence', offset: 1 }, endian: 'be' },
      { id: 'check', label: 'XOR チェック', type: 'checksum', offset: 6, length: 1, source: { kind: 'computed' }, checksum: { algo: 'xor8', over: ['org', 'member_no'] } },
    ],
    ...stamp,
  };

  const asset: DataSchema = {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'preset-asset',
    name: '資産タグ',
    description: '資産コード（接頭辞 + 連番 6 桁 + 部門）を MIFARE Classic のデータブロックに書き、CRC-32 で保護します。',
    tagKinds: ['MIFARE_CLASSIC_1K', 'MIFARE_CLASSIC_4K'],
    area: { mode: 'raw', startUnit: 1 },
    size: 16,
    fields: [
      { id: 'prefix', label: '接頭辞', type: 'ascii', offset: 0, length: 2, source: { kind: 'fixed', value: 'AS' } },
      { id: 'serial', label: '連番', type: 'ascii', offset: 2, length: 6, source: { kind: 'sequence', offset: 1 }, digits: 6, align: 'right' },
      { id: 'dept', label: '部門', type: 'ascii', offset: 8, length: 4, source: { kind: 'input', defaultValue: 'GEN' }, pad: 'space' },
      { id: 'crc', label: 'CRC-32', type: 'checksum', offset: 12, length: 4, source: { kind: 'computed' }, checksum: { algo: 'crc32', over: ['prefix', 'serial', 'dept'] } },
    ],
    ...stamp,
  };

  return [employee, attendance, membership, asset];
}
