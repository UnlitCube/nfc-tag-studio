// Issue log + last-run persistence in userData (Electron's app.getPath mocked to a
// temp folder). 2026-11-12 review round 2: R-ISSUE-12 (duplicate check must not
// forget issued UIDs when the bounded log rolls over), R-ISSUE-4 (the last run is
// kept across restarts, as a summary without secrets).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IssueJob, IssueLogEntry } from '../src/shared/types';

const env = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.dir } }));

const { createIssueLog, parseIssuedIndex } = await import('../src/main/services/issuelog');
const { createIssueRunStore } = await import('../src/main/services/issuerun');
const { parseSavedRun, summarizeJob } = await import('../src/main/issue/saved-run');

beforeEach(() => {
  env.dir = mkdtempSync(join(tmpdir(), 'nfcts-issuelog-'));
});
afterEach(() => {
  rmSync(env.dir, { recursive: true, force: true });
});

function entry(n: number, over: Partial<IssueLogEntry> = {}): IssueLogEntry {
  return {
    id: `e${n}`,
    jobId: 'job-a',
    jobName: 'a',
    at: n,
    uid: `04${n.toString(16).toUpperCase().padStart(12, '0')}`,
    kind: 'NTAG215',
    seq: n,
    values: {},
    result: 'ok',
    message: null,
    ...over,
  };
}

describe('issue log: issued UIDs survive the log rolling over (R-ISSUE-12)', () => {
  it('an issued UID is still known after the bounded log rolled over (and after a restart)', async () => {
    const log = await createIssueLog({ maxEntries: 10 }); // the app uses 5000
    const first = entry(1);
    await log.append(first);
    // later skipped / error records push the 'ok' record out of the bounded log
    for (let i = 0; i < 12; i++) {
      await log.append(entry(100 + i, { result: i % 2 ? 'skipped' : 'error', uid: `05${i.toString(16).padStart(12, '0')}`, seq: null }));
    }
    expect(log.list({ limit: 100000 }).some((e) => e.id === first.id)).toBe(false); // gone from the log ...
    expect(log.issuedUids().has(first.uid)).toBe(true); // ... but still "issued"
    expect(log.issuedUids('job-a').has(first.uid)).toBe(true);
    expect(log.issuedUids('job-b').has(first.uid)).toBe(false);

    const again = await createIssueLog({ maxEntries: 10 }); // app restart
    expect(again.issuedUids().has(first.uid)).toBe(true);
    expect(again.issuedUids('job-a').size).toBe(1);
  });

  it('a log written before the index existed builds the index on first start', async () => {
    writeFileSync(join(env.dir, 'issue-log.json'), JSON.stringify([entry(7), entry(8, { result: 'error' })]));
    const log = await createIssueLog();
    expect([...log.issuedUids()]).toEqual([entry(7).uid]);
    expect(readFileSync(join(env.dir, 'issued-uids.tsv'), 'utf8')).toContain(entry(7).uid);
  });

  it('clear() empties the log and the issued index together', async () => {
    const log = await createIssueLog();
    await log.append(entry(1));
    await log.clear();
    expect(log.issuedUids().size).toBe(0);
    const again = await createIssueLog();
    expect(again.issuedUids().size).toBe(0);
    expect(again.list({})).toEqual([]);
  });

  it('parses the index leniently (malformed lines are ignored)', () => {
    const idx = parseIssuedIndex('job-a\t04AA\n\ngarbage\njob-b\t04AA\r\njob-a\t\n');
    expect([...idx.keys()]).toEqual(['04AA']);
    expect([...idx.get('04AA')!]).toEqual(['job-a', 'job-b']);
  });
});

function sampleJob(): IssueJob {
  return {
    id: 'job-1',
    name: '社員証',
    kind: 'NTAG215',
    template: { type: 'ndef', records: [{ kind: 'text', text: 'WIFI pass s3cret {{csv:name}}', lang: 'ja', encoding: 'utf8' }] },
    sequence: { start: 1, step: 1, next: 51 },
    rows: [{ name: 'alice' }, { name: 'bob' }],
    rowIndex: 1,
    options: { verify: true, skipDuplicateUid: true, requireBlank: false, ntagProtect: { password: 'A1B2C3D4', pack: 'E5F6', protectRead: true }, mifareKeyIds: [], sound: true },
    limit: 100,
  };
}

describe('last issue run across restarts (R-ISSUE-4)', () => {
  it('is saved as a summary (no password, rows, records) and read back after a restart', async () => {
    const store = await createIssueRunStore();
    expect(store.get()).toBeNull();
    await store.save({ version: 1, endedAt: 1234, reason: 'user', issued: 20, total: 50, rowCount: 2, job: summarizeJob(sampleJob()) });
    const text = readFileSync(join(env.dir, 'issue-last-run.json'), 'utf8');
    for (const s of ['A1B2C3D4', 'E5F6', 'alice', 'bob', 's3cret']) expect(text).not.toContain(s);

    const after = await createIssueRunStore(); // app restart
    const run = after.get();
    expect(run?.reason).toBe('user');
    expect(run?.total).toBe(50);
    expect(run?.job.id).toBe('job-1');
    expect(run?.job.sequence.next).toBe(51);
    expect(run?.job.rowIndex).toBe(1);
    expect(run?.job.rows).toEqual([]); // needs the CSV again before "resume"
    expect(run?.job.options.ntagProtect).toBeNull();
    expect(run?.job.limit).toBe(100);
  });

  it('a corrupt or foreign file is ignored (no resume offered)', async () => {
    writeFileSync(join(env.dir, 'issue-last-run.json'), '{"version":1,"job":{"id":5}}');
    expect((await createIssueRunStore()).get()).toBeNull();
    writeFileSync(join(env.dir, 'issue-last-run.json'), 'not json');
    expect((await createIssueRunStore()).get()).toBeNull();
    expect(parseSavedRun(null)).toBeNull();
    expect(existsSync(join(env.dir, 'issue-last-run.json'))).toBe(true);
  });

  it('an image (duplicate) job keeps no image bytes', () => {
    const j = sampleJob();
    j.template = { type: 'image', kind: 'NTAG215', data: new Uint8Array(540).fill(7), units: [4, 5], sourceUid: '04AA' };
    const s = summarizeJob(j);
    expect(s.template.type).toBe('image');
    if (s.template.type === 'image') {
      expect(s.template.data.length).toBe(0);
      expect(s.template.units).toEqual([]);
    }
    const back = parseSavedRun(JSON.parse(JSON.stringify({ version: 1, endedAt: 1, reason: 'limit', issued: 1, total: 1, rowCount: null, job: s })));
    expect(back?.job.template.type).toBe('image');
  });
});
