// Pure-logic tests for the issue-log CSV + filtering helpers. No DOM.
import { describe, expect, it } from 'vitest';
import type { IssueLogEntry } from '@shared/types';
import { buildLogCsv, distinctJobs, valueColumns } from '../src/renderer/src/views/log/csv';

function entry(p: Partial<IssueLogEntry>): IssueLogEntry {
  return {
    id: 'e1',
    jobId: 'j1',
    jobName: 'Job 1',
    at: 0,
    uid: '04AABB',
    kind: 'NTAG213',
    seq: 1,
    values: {},
    result: 'ok',
    message: null,
    ...p,
  };
}

describe('distinctJobs', () => {
  it('keeps first-seen order and dedupes', () => {
    const r = distinctJobs([
      entry({ jobId: 'a', jobName: 'A' }),
      entry({ jobId: 'a', jobName: 'A' }),
      entry({ jobId: 'b', jobName: 'B' }),
    ]);
    expect(r).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
  });
});

describe('valueColumns', () => {
  it('unions keys across entries in first-seen order', () => {
    const r = valueColumns([entry({ values: { a: '1' } }), entry({ values: { a: '2', b: '3' } })]);
    expect(r).toEqual(['a', 'b']);
  });
});

describe('buildLogCsv', () => {
  const labels = { at: '時刻', job: 'ジョブ', uid: 'UID', kind: '種類', seq: '連番', result: '結果', message: '備考' };

  it('lays out fixed columns, then value columns, then message', () => {
    const { header, rows } = buildLogCsv(
      [
        entry({ at: 10, uid: 'AA', seq: 5, values: { emp: '001' }, result: 'ok' }),
        entry({ at: 20, uid: 'BB', kind: null, seq: null, values: {}, result: 'skipped', message: 'dup' }),
      ],
      labels,
      () => 'T',
    );
    expect(header).toEqual(['時刻', 'ジョブ', 'UID', '種類', '連番', '結果', 'emp', '備考']);
    expect(rows[0]).toEqual(['T', 'Job 1', 'AA', 'NTAG213', 5, 'ok', '001', '']);
    // null kind/seq become '', missing value key becomes '', message passes through
    expect(rows[1]).toEqual(['T', 'Job 1', 'BB', '', '', 'skipped', '', 'dup']);
  });

  it('never emits more columns than the header', () => {
    const { header, rows } = buildLogCsv([entry({ values: { a: '1', b: '2' } })], labels, () => 'T');
    expect(rows[0]).toHaveLength(header.length);
  });
});
