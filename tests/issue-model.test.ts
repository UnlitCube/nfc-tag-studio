// Pure-logic tests for the batch-issue view helpers. Node environment, no DOM.
import { describe, expect, it } from 'vitest';
import type { DataSchema, SchemaField } from '@shared/schema/types';
import type { CardInfo, IssueEvent, IssueJob, IssueLogEntry, IssueTemplate, ReaderStatus, UnitStatus } from '@shared/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '@shared/schema/types';
import { imageSize, specFor, TAG_KINDS } from '@shared/tags';
import {
  dummyUid,
  duplicatePlan,
  duplicateSize,
  duplicateUnits,
  errorAdvice,
  findBadRows,
  issueMessageCode,
  issuePhase,
  issueResult,
  issueSoundOn,
  jobStamp,
  messageErrorCode,
  ntagPasswordsMatch,
  parseIntInput,
  phaseTone,
  previewSlots,
  readerAuth,
  resumePlan,
  schemaCsvColumns,
  schemaInputFields,
  schemaUsesSequence,
  startChecks,
  stopCauseKind,
  stopCauseMessage,
  summarizeDraft,
  validNtagSecret,
} from '../src/renderer/src/views/issue/model';
import type { StartCheckInput } from '../src/renderer/src/views/issue/model';
import { errorMessage } from '@shared/errorMessages';
import { DEFAULT_SETTINGS } from '@shared/types';
// The engine's own texts: the view classifies them (until the events carry the advice / cause).
import { issueText } from '../src/main/issue/messages';

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

// ---------------------------------------------------------------------------
// Running panel (2026-11-12 UX audit ISSUE-1/5/8)
// ---------------------------------------------------------------------------

const NEXT = { seq: 12, rowIndex: null, values: { seq: '12' } };

function entry(over: Partial<IssueLogEntry> = {}): IssueLogEntry {
  return {
    id: 'e1',
    jobId: 'job_1',
    jobName: 'J',
    at: 1,
    uid: '04AABBCCDDEEFF',
    kind: 'NTAG213',
    seq: 12,
    values: { seq: '12' },
    result: 'ok',
    message: null,
    ...over,
  };
}

function job(over: Partial<IssueJob> = {}): IssueJob {
  return {
    id: 'job_1',
    name: 'J',
    kind: 'NTAG213',
    template: { type: 'ndef', records: [] },
    sequence: { start: 1, step: 1, next: 31 },
    rows: null,
    rowIndex: 0,
    options: { verify: true, skipDuplicateUid: true, requireBlank: false, ntagProtect: null, mifareKeyIds: [], sound: true },
    limit: null,
    ...over,
  };
}

describe('issuePhase: one phase per step of place -> write -> take off', () => {
  it('maps every event type', () => {
    expect(issuePhase(null)).toBe('idle');
    expect(issuePhase({ type: 'started', job: job() })).toBe('waiting');
    expect(issuePhase({ type: 'clear-reader', uid: 'AA' })).toBe('clear');
    expect(issuePhase({ type: 'waiting', next: NEXT, issued: 0 })).toBe('waiting');
    expect(issuePhase({ type: 'reading', uid: 'AA', next: NEXT })).toBe('reading');
    expect(issuePhase({ type: 'writing', uid: 'AA', next: NEXT })).toBe('writing');
    expect(issuePhase({ type: 'success', entry: entry(), issued: 1 })).toBe('success');
    expect(issuePhase({ type: 'skipped', entry: entry({ result: 'skipped' }), reason: 'duplicate' })).toBe('skipped');
    expect(issuePhase({ type: 'error', entry: null, message: 'CARD_REMOVED', partial: false })).toBe('error');
    expect(issuePhase({ type: 'remove-card', uid: 'AA', outcome: 'ok', entry: entry(), message: null })).toBe('remove');
    const stopped: IssueEvent = { type: 'stopped', reason: 'user', issued: 3, job: null };
    expect(issuePhase(stopped)).toBe('stopped');
  });

  it('maps phases to tones', () => {
    expect(phaseTone('success')).toBe('ok');
    expect(phaseTone('error')).toBe('danger');
    expect(phaseTone('skipped')).toBe('warn');
    expect(phaseTone('clear')).toBe('warn');
    expect(phaseTone('reading')).toBe('accent');
    expect(phaseTone('writing')).toBe('accent');
    expect(phaseTone('waiting')).toBe('accent');
    expect(phaseTone('idle')).toBe('neutral');
  });

  // Regression ISSUE-1: "take the tag off" used to be yellow for every outcome,
  // so a failed / skipped tag looked the same as an issued one.
  it('keeps the colour of the result while waiting for the tag to be taken off', () => {
    expect(phaseTone('remove', 'ok')).toBe('ok');
    expect(phaseTone('remove', 'skipped')).toBe('warn');
    expect(phaseTone('remove', 'error')).toBe('danger');
  });
});

describe('issueResult: the result stays on screen through remove-card', () => {
  it('is null while placing / checking / writing', () => {
    expect(issueResult(null)).toBeNull();
    expect(issueResult({ type: 'waiting', next: NEXT, issued: 0 })).toBeNull();
    expect(issueResult({ type: 'clear-reader', uid: 'AA' })).toBeNull();
    expect(issueResult({ type: 'reading', uid: 'AA', next: NEXT })).toBeNull();
    expect(issueResult({ type: 'writing', uid: 'AA', next: NEXT })).toBeNull();
  });

  it('success carries the number written and the UID', () => {
    const r = issueResult({ type: 'success', entry: entry(), issued: 1 });
    expect(r).toMatchObject({ outcome: 'ok', seq: 12, uid: '04AABBCCDDEEFF', kind: 'NTAG213', partial: false });
  });

  it('skipped carries the reason (and no number: nothing was written)', () => {
    const r = issueResult({ type: 'skipped', entry: entry({ result: 'skipped', seq: null, kind: 'NTAG215' }), reason: 'wrong-kind' });
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'wrong-kind', kind: 'NTAG215', seq: null });
  });

  it('error carries partial and the message', () => {
    const r = issueResult({ type: 'error', entry: entry({ result: 'error' }), message: 'CARD_REMOVED', partial: true });
    expect(r).toMatchObject({ outcome: 'error', partial: true, message: 'CARD_REMOVED', seq: 12 });
  });

  // Regression ISSUE-1: the engine emits success/skipped/error and remove-card in
  // the same tick; the panel must show the result from remove-card alone.
  it('remove-card keeps outcome, number and message', () => {
    const ok = issueResult({ type: 'remove-card', uid: '04AABBCCDDEEFF', outcome: 'ok', entry: entry(), message: null });
    expect(ok).toMatchObject({ outcome: 'ok', seq: 12, uid: '04AABBCCDDEEFF' });
    const err = issueResult({ type: 'remove-card', uid: '04AA', outcome: 'error', entry: null, message: 'WRITE_FAILED' });
    expect(err).toMatchObject({ outcome: 'error', uid: '04AA', message: 'WRITE_FAILED', partial: false });
    const skip = issueResult({ type: 'remove-card', uid: '04AA', outcome: 'skipped', entry: entry({ result: 'skipped' }), message: 'duplicate' });
    expect(skip).toMatchObject({ outcome: 'skipped', reason: 'duplicate', seq: null });
  });

  it('remove-card takes "partly written" from the newest result of the same tag only', () => {
    const ev: IssueEvent = { type: 'remove-card', uid: '04aa', outcome: 'error', entry: null, message: 'CARD_REMOVED' };
    expect(issueResult(ev, { outcome: 'error', uid: '04AA', partial: true })?.partial).toBe(true);
    expect(issueResult(ev, { outcome: 'error', uid: '04BB', partial: true })?.partial).toBe(false);
    expect(issueResult(ev, { outcome: 'ok', uid: '04AA', partial: false })?.partial).toBe(false);
    expect(issueResult(ev, null)?.partial).toBe(false);
  });
});

describe('issueMessageCode (ISSUE-9: never show a raw code)', () => {
  it('recognises an ErrorCode, also in the OpError "CODE: detail" form', () => {
    expect(issueMessageCode('CARD_REMOVED')).toBe('CARD_REMOVED');
    expect(issueMessageCode('UID_MISMATCH: expected 04..')).toBe('UID_MISMATCH');
    expect(issueMessageCode(' KIND_MISMATCH ')).toBe('KIND_MISMATCH');
  });
  it('leaves ordinary text alone', () => {
    expect(issueMessageCode(null)).toBeNull();
    expect(issueMessageCode('')).toBeNull();
    expect(issueMessageCode('照合不一致')).toBeNull();
    expect(issueMessageCode('NOT_A_CODE')).toBeNull();
    expect(issueMessageCode('Writing failed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resume (ISSUE-3/7/13)
// ---------------------------------------------------------------------------

describe('resumePlan', () => {
  it('continues the same job at the engine\'s next value and row (not at 1)', () => {
    const p = resumePlan(
      { reason: 'user', issued: 30, job: job({ sequence: { start: 1, step: 1, next: 31 }, rows: [{}, {}, {}], rowIndex: 30 }) },
      { carried: 0, limit: null, rowCount: 40 },
    );
    expect(p).toEqual({ id: 'job_1', name: 'J', next: 31, rowIndex: 30, limit: null, issuedTotal: 30 });
  });

  it('nothing to resume without a job, or when every CSV row was issued', () => {
    expect(resumePlan(null, { carried: 0, limit: null, rowCount: null })).toBeNull();
    expect(resumePlan({ reason: 'error', issued: 0, job: null }, { carried: 0, limit: null, rowCount: null })).toBeNull();
    const done = { reason: 'rows-exhausted' as const, issued: 3, job: job({ rows: [{}, {}, {}], rowIndex: 3 }) };
    expect(resumePlan(done, { carried: 0, limit: null, rowCount: 3 })).toBeNull();
  });

  it('a job that used a CSV cannot resume once the CSV is removed', () => {
    const last = { reason: 'user' as const, issued: 2, job: job({ rows: [{}, {}, {}], rowIndex: 2 }) };
    expect(resumePlan(last, { carried: 0, limit: null, rowCount: null })).toBeNull();
  });

  it('a job without a CSV starts at the form\'s row when a CSV is loaded now', () => {
    const last = { reason: 'user' as const, issued: 2, job: job({ rows: null, rowIndex: 0 }) };
    expect(resumePlan(last, { carried: 0, limit: null, rowCount: 10, rowStart: 4 })?.rowIndex).toBe(4);
  });

  it('a run stopped early resumes with the rest of its limit; one that hit the limit starts the next batch', () => {
    const early = { reason: 'user' as const, issued: 30, job: job() };
    expect(resumePlan(early, { carried: 0, limit: 50, rowCount: null })?.limit).toBe(20);
    const atLimit = { reason: 'limit' as const, issued: 50, job: job() };
    expect(resumePlan(atLimit, { carried: 0, limit: 50, rowCount: null })?.limit).toBe(50);
    const used = { reason: 'error' as const, issued: 50, job: job() };
    expect(resumePlan(used, { carried: 0, limit: 50, rowCount: null })).toBeNull();
  });

  it('counts tags across resumed runs of the same job', () => {
    const p = resumePlan({ reason: 'user', issued: 5, job: job() }, { carried: 30, limit: 50, rowCount: null });
    expect(p?.issuedTotal).toBe(35);
    expect(p?.limit).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Duplicate mode (ISSUE-12)
// ---------------------------------------------------------------------------

describe('duplicatePlan', () => {
  it('copies only data units that were read; unread ones are listed, never written', () => {
    const status: UnitStatus[] = Array.from({ length: specFor('NTAG213').unitCount }, () => 'ok');
    status[10] = 'denied';
    status[11] = 'unread';
    const p = duplicatePlan('NTAG213', status);
    expect(p.units).not.toContain(10);
    expect(p.units).not.toContain(11);
    expect(p.unread).toEqual([10, 11]);
    expect(p.units).toHaveLength(36 - 2);
    // never UID / CC / config even when "ok" (I1)
    for (const u of [0, 1, 2, 3, 40, 41, 42, 43, 44]) expect(p.units).not.toContain(u);
  });
});

// ---------------------------------------------------------------------------
// CSV / template check before starting (ISSUE-4)
// ---------------------------------------------------------------------------

describe('findBadRows', () => {
  const s: DataSchema = {
    ...schema([{ id: 'name', label: '氏名', type: 'ascii', offset: 0, length: 4, source: { kind: 'csv', column: '氏名' } }]),
  };
  const tpl: IssueTemplate = { type: 'schema', schema: s, inputs: {} };

  it('reports each CSV row that does not fit, with its 1-based row number', () => {
    const rows = [{ 氏名: 'bob' }, { 氏名: 'alice' }, { 氏名: 'eve' }, { 氏名: 'mallory' }];
    const r = findBadRows({ template: tpl, kind: 'NTAG213', rows, rowStart: 0, next: 1, step: 1, now: new Date(0) });
    expect(r.count).toBe(2);
    expect(r.first.map((p) => p.row)).toEqual([2, 4]);
    expect(r.first[0]).toMatchObject({ type: 'value', fieldId: 'name' });
  });

  it('only checks the rows from the start row', () => {
    const rows = [{ 氏名: 'alice' }, { 氏名: 'bob' }];
    expect(findBadRows({ template: tpl, kind: 'NTAG213', rows, rowStart: 1, next: 1, step: 1, now: new Date(0) }).count).toBe(0);
  });

  it('caps the listed problems but counts them all', () => {
    const rows = Array.from({ length: 9 }, () => ({ 氏名: 'toolong' }));
    const r = findBadRows({ template: tpl, kind: 'NTAG213', rows, rowStart: 0, next: 1, step: 1, now: new Date(0), max: 3 });
    expect(r.count).toBe(9);
    expect(r.first).toHaveLength(3);
  });

  it('an NDEF message larger than the NTAG is reported (not tried on every tag)', () => {
    const big: IssueTemplate = { type: 'ndef', records: [{ kind: 'text', text: 'x'.repeat(200), lang: 'en', encoding: 'utf8' }] };
    const r = findBadRows({ template: big, kind: 'NTAG213', rows: null, rowStart: 0, next: 1, step: 1, now: new Date(0) });
    expect(r.count).toBe(1);
    expect(r.first[0]).toMatchObject({ row: null, type: 'too-big' });
    expect(findBadRows({ template: big, kind: 'NTAG216', rows: null, rowStart: 0, next: 1, step: 1, now: new Date(0) }).count).toBe(0);
  });

  it('{{uid}} is measured at the real UID length', () => {
    const uidTpl: IssueTemplate = { type: 'ndef', records: [{ kind: 'uri', uri: 'https://example.com/{{uid}}' }] };
    expect(findBadRows({ template: uidTpl, kind: 'NTAG213', rows: null, rowStart: 0, next: 1, step: 1, now: new Date(0) }).count).toBe(0);
  });

  it('duplicate mode has nothing to check', () => {
    const img: IssueTemplate = { type: 'image', kind: 'NTAG213', data: new Uint8Array(180), units: [4] };
    expect(findBadRows({ template: img, kind: 'NTAG213', rows: null, rowStart: 0, next: 1, step: 1, now: new Date(0) }).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Checks before starting (ISSUE-5/10)
// ---------------------------------------------------------------------------

function rs(over: Partial<ReaderStatus> = {}): ReaderStatus {
  return {
    service: 'ok',
    serviceMessage: null,
    readers: [{ name: 'R1', likelyContactless: true, cardPresent: false, inUse: false, atr: null, virtual: false }],
    selectedReader: null,
    activeReader: 'R1',
    activeReason: 'auto-first',
    driverMode: 'auto',
    card: null,
    cardState: 'absent',
    cardError: null,
    ignoredRealReader: null,
    busy: null,
    simulator: { enabled: false, kind: 'NTAG213', present: false, uid: '' },
    ...over,
  };
}

function card(over: Partial<CardInfo> = {}): CardInfo {
  return {
    readerName: 'R1',
    uid: '04AABBCCDDEEFF',
    atr: '3B',
    kind: 'NTAG213',
    kindSource: 'version',
    version: null,
    rawCommands: false,
    driver: 'storage',
    detectedAt: 1,
    ...over,
  };
}

const BASE: StartCheckInput = {
  reader: rs(),
  busyOp: null,
  template: 'schema',
  templateReady: true,
  kind: 'NTAG213',
  seqOk: true,
  limitOk: true,
  csv: null,
  rowStart: 0,
  csvColumns: [],
  badRows: null,
  mifareKeys: 0,
  badPassword: false,
  sourceUid: null,
};

const codes = (i: StartCheckInput, level?: 'block' | 'warn' | 'info') =>
  startChecks(i)
    .filter((c) => !level || c.level === level)
    .map((c) => c.code);

describe('startChecks', () => {
  it('a ready reader with nothing on it and a complete template: nothing to say', () => {
    expect(startChecks(BASE)).toEqual([]);
  });

  it('blocks without a reader / service, and when the selected reader is missing', () => {
    expect(codes({ ...BASE, reader: null }, 'block')).toEqual(['service']);
    expect(codes({ ...BASE, reader: rs({ service: 'unavailable' }) }, 'block')).toEqual(['service']);
    expect(codes({ ...BASE, reader: rs({ activeReader: null, activeReason: 'none', cardState: 'no-reader', readers: [] }) }, 'block')).toEqual(['no-reader']);
    const missing = startChecks({ ...BASE, reader: rs({ selectedReader: 'PaSoRi', activeReader: null, activeReason: 'selected-missing', cardState: 'no-reader' }) });
    expect(missing[0]).toMatchObject({ level: 'block', code: 'selected-missing', vars: { name: 'PaSoRi' } });
  });

  it('blocks on what would fail every tag: no template, bad numbers, no MIFARE key, bad password', () => {
    expect(codes({ ...BASE, templateReady: false }, 'block')).toEqual(['no-schema']);
    expect(codes({ ...BASE, template: 'image', templateReady: false }, 'block')).toEqual(['no-image']);
    // a source whose data area could not be read at all would "issue" tags with nothing written
    expect(codes({ ...BASE, template: 'image', imageUnits: 0 }, 'block')).toEqual(['image-empty']);
    expect(codes({ ...BASE, template: 'image', imageUnits: 36 }, 'block')).toEqual([]);
    expect(codes({ ...BASE, seqOk: false, limitOk: false }, 'block')).toEqual(['bad-seq', 'bad-limit']);
    expect(codes({ ...BASE, kind: 'MIFARE_CLASSIC_1K', mifareKeys: 0 }, 'block')).toEqual(['no-keys']);
    expect(codes({ ...BASE, kind: 'MIFARE_CLASSIC_1K', mifareKeys: 1 }, 'block')).toEqual([]);
    expect(codes({ ...BASE, badPassword: true }, 'block')).toEqual(['bad-password']);
    expect(codes({ ...BASE, template: 'ndef', kind: 'FELICA_LITE_S' }, 'block')).toEqual(['ndef-kind']);
  });

  it('CSV: start row, missing columns, rows that cannot be written', () => {
    const csv = { header: ['氏名'], rowCount: 3 };
    expect(codes({ ...BASE, csvColumns: ['氏名'] }, 'block')).toEqual(['csv-needed']);
    expect(codes({ ...BASE, csv, rowStart: null }, 'block')).toEqual(['bad-row-start']);
    expect(codes({ ...BASE, csv, rowStart: 3 }, 'block')).toEqual(['no-rows-left']);
    expect(codes({ ...BASE, csv, csvColumns: ['部署'] }, 'block')).toEqual(['csv-missing-cols']);
    expect(codes({ ...BASE, csv, badRows: { count: 2 } }, 'block')).toEqual(['bad-rows']);
  });

  it('busy single-tag operation blocks; identification does not', () => {
    expect(codes({ ...BASE, busyOp: 'write' }, 'block')).toEqual(['busy']);
    expect(codes({ ...BASE, reader: rs({ busy: { op: 'identify', startedAt: 1 } }) }, 'block')).toEqual([]);
  });

  // Regression ISSUE-5: a tag left on the reader is never written; say so before starting.
  it('a tag already on the reader is announced (it will not be written)', () => {
    const r = startChecks({ ...BASE, reader: rs({ card: card(), cardState: 'ready' }) });
    expect(r).toContainEqual({ level: 'info', code: 'tag-on-reader', vars: { uid: '04AABBCCDDEEFF' } });
    expect(codes({ ...BASE, reader: rs({ cardState: 'error', cardError: 'CARD_UNRESPONSIVE' }) }, 'info')).toEqual(['tag-on-reader']);
    const src = startChecks({ ...BASE, template: 'image', sourceUid: '04aabbccddeeff', reader: rs({ card: card(), cardState: 'ready' }) });
    expect(src.map((c) => c.code)).toContain('source-on-reader');
  });

  it('warns about the virtual reader and a tag kind that differs from the job', () => {
    const virt = rs({
      readers: [{ name: 'Virtual', likelyContactless: true, cardPresent: true, inUse: false, atr: null, virtual: true }],
      activeReader: 'Virtual',
      activeReason: 'auto-virtual',
    });
    expect(codes({ ...BASE, reader: virt }, 'warn')).toEqual(['virtual']);
    const k = startChecks({ ...BASE, reader: rs({ card: card({ kind: 'NTAG215' }), cardState: 'ready' }) });
    expect(k).toContainEqual({ level: 'warn', code: 'kind-differs', vars: { cardKind: 'NTAG215', kind: 'NTAG213' } });
  });

  // Regression R-ISSUE-6: a real tag hidden by the virtual reader used to be a
  // warning only, so the run started on the trial tag ("take the tag off" for a
  // tag the operator could not touch). The operator chooses first.
  it('blocks when the virtual reader hides a tag on a real reader (choose which one first)', () => {
    const virt = rs({
      readers: [
        { name: 'Virtual', likelyContactless: true, cardPresent: true, inUse: false, atr: null, virtual: true },
        { name: 'PaSoRi', likelyContactless: true, cardPresent: true, inUse: false, atr: '3B', virtual: false },
      ],
      activeReader: 'Virtual',
      activeReason: 'auto-virtual',
      ignoredRealReader: 'PaSoRi',
    });
    const r = startChecks({ ...BASE, reader: virt });
    expect(r).toContainEqual({ level: 'block', code: 'virtual-ignored', vars: { name: 'PaSoRi' } });
    expect(codes({ ...BASE, reader: virt }, 'warn')).not.toContain('virtual');
  });

  // Regression R-UX-2: a typo in the (masked) password used to lock every tag with an unknown password.
  it('blocks until the password is typed twice the same (format first)', () => {
    expect(codes({ ...BASE, protect: true, passwordMismatch: true }, 'block')).toEqual(['password-mismatch']);
    // a bad format is reported alone (the mismatch is not computed for it)
    expect(codes({ ...BASE, protect: true, badPassword: true, passwordMismatch: true }, 'block')).toEqual(['bad-password']);
  });

  // Regression R-UX-1 / D11: protecting on a storage reader (PaSoRi) gave no warning at all.
  it('warns when protecting on a storage reader; says it cannot tell yet without a tag', () => {
    expect(codes({ ...BASE, protect: true, readerAuth: 'storage' }, 'warn')).toEqual(['protect-storage']);
    expect(codes({ ...BASE, protect: true, readerAuth: 'raw' })).toEqual([]);
    expect(codes({ ...BASE, protect: true, readerAuth: 'unknown' }, 'info')).toEqual(['protect-reader-unknown']);
    expect(codes({ ...BASE, protect: false, readerAuth: 'storage' })).toEqual([]);
  });

  it('orders blocks before warnings before information', () => {
    const r = startChecks({ ...BASE, seqOk: false, reader: rs({ card: card({ kind: 'NTAG215' }), cardState: 'ready' }) });
    const levels = r.map((c) => c.level);
    expect(levels).toEqual([...levels].sort((a, b) => ['block', 'warn', 'info'].indexOf(a) - ['block', 'warn', 'info'].indexOf(b)));
  });
});

describe('small helpers', () => {
  it('validNtagSecret: 8 hex + 4 hex', () => {
    expect(validNtagSecret('0011AaFf', '12ab')).toBe(true);
    expect(validNtagSecret('0011AaF', '12ab')).toBe(false);
    expect(validNtagSecret('0011AaFg', '12ab')).toBe(false);
    expect(validNtagSecret('0011AaFf', '12a')).toBe(false);
  });
  it('jobStamp: local date + time, minutes', () => {
    expect(jobStamp(new Date(2026, 10, 12, 9, 5, 59))).toBe('2026-11-12 09:05');
  });
  it('dummyUid has the real UID length', () => {
    expect(dummyUid('NTAG213')).toHaveLength(14);
    expect(dummyUid('MIFARE_CLASSIC_1K')).toHaveLength(8);
    expect(dummyUid('FELICA_LITE_S')).toHaveLength(16);
  });
  it('ntagPasswordsMatch: same hex value, case and spaces around do not matter', () => {
    expect(ntagPasswordsMatch('0011aaff', ' 0011AAFF ')).toBe(true);
    expect(ntagPasswordsMatch('0011AAFF', '0011AAFE')).toBe(false);
    expect(ntagPasswordsMatch('0011AAFF', '')).toBe(false);
  });
  it('issueSoundOn: the job option AND Settings (as the store plays them)', () => {
    expect(issueSoundOn(true, true)).toBe(true);
    expect(issueSoundOn(undefined, true)).toBe(true);
    expect(issueSoundOn(false, true)).toBe(false);
    expect(issueSoundOn(true, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reader capability for NTAG passwords (R-UX-1 / D11)
// ---------------------------------------------------------------------------

describe('readerAuth', () => {
  const virtualReaders = [{ name: 'Virtual', likelyContactless: true, cardPresent: false, inUse: false, atr: null, virtual: true }];
  it('the tag on the active reader tells it for sure', () => {
    expect(readerAuth(rs({ card: card({ rawCommands: false, driver: 'storage' }), cardState: 'ready' }))).toBe('storage');
    expect(readerAuth(rs({ card: card({ rawCommands: true, driver: 'acr122' }), cardState: 'ready' }))).toBe('raw');
    // the contract allows a card with kind null on 'error' (UID read): still says the transport
    expect(readerAuth(rs({ card: card({ kind: null, rawCommands: false }), cardState: 'error' }))).toBe('storage');
  });
  it('without a tag: a forced transport, the virtual reader, else unknown', () => {
    expect(readerAuth(rs({ driverMode: 'storage' }))).toBe('storage');
    expect(readerAuth(rs({ driverMode: 'acr122' }))).toBe('raw');
    expect(readerAuth(rs({ driverMode: 'transparent' }))).toBe('raw');
    expect(readerAuth(rs({ readers: virtualReaders, activeReader: 'Virtual', activeReason: 'auto-first' }))).toBe('raw');
    expect(readerAuth(rs())).toBe('unknown');
    expect(readerAuth(null)).toBe('unknown');
    expect(readerAuth(rs({ activeReader: null, activeReason: 'none', cardState: 'no-reader' }))).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// After a failed tag / why a run stopped (R-ISSUE-9/10). The engine's own texts
// (main/issue/messages.ts) are used, so a change there that the view would no
// longer recognise fails here.
// ---------------------------------------------------------------------------

describe('messageErrorCode', () => {
  it('a raw code, or a sentence that starts with the code\'s message (either language)', () => {
    expect(messageErrorCode('ACCESS_DENIED')).toBe('ACCESS_DENIED');
    expect(messageErrorCode(`${errorMessage('ACCESS_DENIED', 'ja')} ${issueText('notWritten', 'ja')}`)).toBe('ACCESS_DENIED');
    expect(messageErrorCode(`${errorMessage('CARD_UNRESPONSIVE', 'en')} ${issueText('notWritten', 'en')}`)).toBe('CARD_UNRESPONSIVE');
    expect(messageErrorCode(issueText('removedBeforeWrite', 'ja'))).toBeNull();
    expect(messageErrorCode(null)).toBeNull();
  });
});

describe('errorAdvice (R-ISSUE-10: the next step matches the reason)', () => {
  const tag = (message: string, partial = false) => ({ message, partial, uid: '04AABBCCDDEEFF' });
  it('the same tag again only for passing failures', () => {
    for (const lang of ['ja', 'en'] as const) {
      expect(errorAdvice(tag(issueText('removedBeforeWrite', lang)))).toBe('retry-same');
      expect(errorAdvice(tag(`${issueText('removedMidWrite', lang)} ${issueText('notWritten', lang)}`))).toBe('retry-same');
      expect(errorAdvice(tag(`${errorMessage('CARD_UNRESPONSIVE', lang)} ${issueText('notWritten', lang)}`))).toBe('retry-same');
      expect(errorAdvice(tag(`${errorMessage('READ_FAILED', lang)} ${issueText('notWritten', lang)}`))).toBe('retry-same');
    }
    expect(errorAdvice(tag('BUSY'))).toBe('retry-same');
  });
  it('another tag when this one fails the same way again', () => {
    for (const lang of ['ja', 'en'] as const) {
      expect(errorAdvice(tag(issueText('tagBuild', lang, { detail: 'x' })))).toBe('use-another');
      expect(errorAdvice(tag(issueText('tagBuildNoDetail', lang)))).toBe('use-another');
      for (const code of ['ACCESS_DENIED', 'AUTH_FAILED', 'UNSUPPORTED_TAG', 'PROTECTED_UNIT', 'FORBIDDEN_UNIT', 'READER_NO_AUTH'] as const) {
        expect(errorAdvice(tag(`${errorMessage(code, lang)} ${issueText('notWritten', lang)}`))).toBe('use-another');
      }
    }
  });
  it('half-written: put the same tag back; no tag involved: nothing about a tag', () => {
    expect(errorAdvice(tag(issueText('partialSeq', 'ja', { seq: 3 }), true))).toBe('partial');
    expect(errorAdvice({ message: issueText('badRow', 'ja', { row: 2, detail: 'x' }), partial: false, uid: null })).toBe('none');
  });
});

describe('stopCauseKind / stopCauseMessage (R-ISSUE-9)', () => {
  it('only a reader problem gets "check the reader"', () => {
    for (const lang of ['ja', 'en'] as const) {
      expect(stopCauseKind(issueText('waitFailed', lang))).toBe('reader');
      expect(stopCauseKind(errorMessage('NO_READER', lang))).toBe('reader');
      expect(stopCauseKind(issueText('badLayout', lang))).toBe('other');
      expect(stopCauseKind(issueText('badRowStreak', lang, { n: 5 }))).toBe('other');
      expect(stopCauseKind(issueText('badTemplateNoDetail', lang))).toBe('other');
      expect(stopCauseKind(issueText('felicaNdef', lang))).toBe('other');
      expect(stopCauseKind(errorMessage('INTERNAL', lang))).toBe('other');
    }
    expect(stopCauseKind(null)).toBe('unknown');
    expect(stopCauseKind('')).toBe('unknown');
  });
  it('the store\'s own message first, else the newest error result; nothing unless it stopped on an error', () => {
    const recent = [
      { outcome: 'error' as const, message: 'newest' },
      { outcome: 'error' as const, message: 'older' },
    ];
    expect(stopCauseMessage({ reason: 'error', message: 'own' }, recent)).toBe('own');
    expect(stopCauseMessage({ reason: 'error' }, recent)).toBe('newest');
    expect(stopCauseMessage({ reason: 'error' }, [{ outcome: 'ok', message: null }])).toBeNull();
    expect(stopCauseMessage({ reason: 'user' }, recent)).toBeNull();
    expect(stopCauseMessage(null, recent)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Render smoke of the issue screen (react-dom/server, no DOM): the running panel
// keeps the result of the tag just handled through remove-card (ISSUE-1), the
// stop button reacts (ISSUE-15), and the settings screen offers "resume" with
// the engine's next value after a stop (ISSUE-3/7).
// ---------------------------------------------------------------------------

describe('IssueView render', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { useAppStore } = await import('../src/renderer/src/store/app');
  const { IssueView } = await import('../src/renderer/src/views/issue/IssueView');
  // zustand's server render reads getInitialState() (the store's initial state
  // object), so the test patches that object in place before each render.
  type St = ReturnType<typeof useAppStore.getState>;
  const init = useAppStore.getInitialState() as St;
  const reset: Partial<St> = {
    reader: null,
    issue: { running: false, job: null, issued: 0, last: null },
    issueRecent: [],
    issueLastRun: null,
    settings: DEFAULT_SETTINGS,
  };

  function render(patch: Partial<St>): string {
    Object.assign(init, reset, patch);
    return renderToStaticMarkup(React.createElement(IssueView));
  }

  it('keeps a success on screen while waiting for the tag to be taken off', () => {
    const html = render({
      reader: rs(),
      issue: {
        running: true,
        job: job(),
        issued: 1,
        last: { type: 'remove-card', uid: '04AABBCCDDEEFF', outcome: 'ok', entry: entry(), message: null },
      },
    });
    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('連番 12 を書き込みました');
    expect(html).toContain('04:AA:BB:CC:DD:EE:FF');
    expect(html).toContain('タグを離して、次のタグを置いてください');
  });

  it('a partly written tag says to put the same tag back', () => {
    const html = render({
      reader: rs(),
      issueRecent: [{ at: 1, outcome: 'error', uid: '04AABBCCDDEEFF', seq: 12, message: 'CARD_REMOVED', partial: true }],
      issue: {
        running: true,
        job: job(),
        issued: 0,
        last: { type: 'remove-card', uid: '04AABBCCDDEEFF', outcome: 'error', entry: null, message: 'CARD_REMOVED' },
      },
    });
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('途中までしか書き込めませんでした');
    expect(html).toContain('同じタグをもう一度置くと、同じ番号で書き直します');
    expect(html).not.toContain('>CARD_REMOVED<');
    expect(html).toContain('書き込みの途中でタグが離れました');
  });

  it('asks to take off a tag left on the reader before the first one', () => {
    const html = render({ reader: rs(), issue: { running: true, job: job(), issued: 0, last: { type: 'clear-reader', uid: '04AABBCCDDEEFF' } } });
    expect(html).toContain('data-phase="clear"');
    expect(html).toContain('リーダーの上のタグを離してください');
  });

  it('after a stop, offers resume at the next value (not 1) and says why it stopped', () => {
    const html = render({
      reader: rs(),
      issue: { running: false, job: null, issued: 0, last: null },
      issueLastRun: { reason: 'limit', issued: 30, endedAt: Date.UTC(2026, 10, 12, 5, 0), job: job({ sequence: { start: 1, step: 1, next: 31 } }) },
    });
    expect(html).toContain('data-testid="issue-resume"');
    expect(html).toContain('上限の枚数に達して止まりました');
    expect(html).toContain('連番 31 から発行します');
    expect(html).toContain('data-testid="issue-restart"');
  });

  it('without a reader the start button is disabled and says why', () => {
    const html = render({ reader: null, issue: { running: false, job: null, issued: 0, last: null }, issueLastRun: null });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="issue-start"|<button[^>]*data-testid="issue-start"[^>]*disabled=""/);
    expect(html).toContain('data-testid="issue-start-reason"');
  });

  // Regression R-ISSUE-13: "（UID ）" when the tag at start was still being identified.
  it('a tag left on the reader without a UID yet: no empty "(UID )"', () => {
    const html = render({ reader: rs(), issue: { running: true, job: job(), issued: 0, last: { type: 'clear-reader', uid: '' } } });
    expect(html).toContain('始める前から置かれていたタグには書き込みません');
    expect(html).not.toContain('（UID ）');
  });

  // Regression R-ISSUE-11: with sounds off the hints said "keep it until the sound plays".
  it('with sounds off, the hints wait for the screen, not for a sound', () => {
    const waiting: IssueEvent = { type: 'waiting', next: NEXT, issued: 0 };
    const off = render({ reader: rs(), settings: { ...DEFAULT_SETTINGS, sound: false }, issue: { running: true, job: job(), issued: 0, last: waiting } });
    expect(off).not.toContain('音が鳴るまで');
    expect(off).not.toContain('音が鳴ったら');
    expect(off).toContain('画面が結果（緑・黄・赤）の表示に変わるまで置いたままにしてください');
    const jobOff = job({ options: { ...job().options, sound: false } });
    const writing: IssueEvent = { type: 'writing', uid: '04AABBCCDDEEFF', next: NEXT };
    const html = render({ reader: rs(), issue: { running: true, job: jobOff, issued: 0, last: writing } });
    expect(html).toContain('画面が結果の表示に変わったら離します');
    expect(html).not.toContain('音が鳴');
    // sounds on: unchanged
    const on = render({ reader: rs(), issue: { running: true, job: job(), issued: 0, last: waiting } });
    expect(on).toContain('音が鳴るまで置いたままにしてください');
  });

  // Regression R-ISSUE-10: "place another tag" above, "place it again, same content" below.
  it('after a failure that repeats on the same tag, says to place ANOTHER tag', () => {
    const message = issueText('tagBuildNoDetail', 'ja');
    const html = render({
      reader: rs(),
      issueRecent: [{ at: 1, outcome: 'error', uid: '04AABBCCDDEEFF', seq: null, message, partial: false }],
      issue: { running: true, job: job(), issued: 0, last: { type: 'remove-card', uid: '04AABBCCDDEEFF', outcome: 'error', entry: null, message } },
    });
    expect(html).toContain('このタグを離して、別のタグを置いてください');
    expect(html).not.toContain('同じ内容でもう一度書き込みます');
    // a passing failure still says to place it again
    const again = issueText('removedBeforeWrite', 'ja');
    const html2 = render({
      reader: rs(),
      issue: { running: true, job: job(), issued: 0, last: { type: 'remove-card', uid: '04AABBCCDDEEFF', outcome: 'error', entry: null, message: again } },
    });
    expect(html2).toContain('同じ内容でもう一度書き込みます');
  });

  // Regression R-ISSUE-9: why the run stopped was not shown, and "check the reader" was said for a template problem.
  it('after an error stop, shows why; "check the reader" only for a reader problem', () => {
    const stop = { reason: 'error' as const, issued: 0, endedAt: Date.UTC(2026, 10, 12, 5, 0), job: job() };
    const tpl = render({
      reader: rs(),
      issueLastRun: stop,
      issueRecent: [{ at: 1, outcome: 'error', uid: null, seq: null, message: issueText('badLayout', 'ja'), partial: false }],
    });
    expect(tpl).toContain('data-testid="issue-last-cause"');
    expect(tpl).toContain('データの配置が、タグの保護された領域');
    expect(tpl).not.toContain('リーダーの接続とタグを確かめてから再開してください');
    const rdr = render({
      reader: rs(),
      issueLastRun: stop,
      issueRecent: [{ at: 1, outcome: 'error', uid: null, seq: null, message: issueText('waitFailed', 'ja'), partial: false }],
    });
    expect(rdr).toContain('リーダーの状態を確かめられなくなったため');
    expect(rdr).toContain('リーダーの接続とタグを確かめてから再開してください');
  });

  // Regression R-ISSUE-6: the running screen had no way to take the trial tag off the virtual reader.
  it('on the virtual reader, the running screen can take the virtual tag off / place a new one', () => {
    const virtualReader = { name: 'Virtual', likelyContactless: true, cardPresent: true, inUse: false, atr: null, virtual: true };
    const sim = { enabled: true, kind: 'NTAG213' as const, present: true, uid: '04AABBCCDDEEFF' };
    const reader = rs({ readers: [virtualReader], activeReader: 'Virtual', activeReason: 'auto-virtual', simulator: sim });
    const html = render({ reader, issue: { running: true, job: job(), issued: 0, last: { type: 'clear-reader', uid: '04AABBCCDDEEFF' } } });
    expect(html).toContain('data-testid="issue-virtual"');
    expect(html).toContain('仮想タグを離す');
    expect(html).toContain('「仮想タグを離す」を押すと、発行が始まります');
    expect(html).toContain('新しい空のタグを置く（NTAG213）');
    expect(html).not.toContain('data-testid="issue-virtual-off"');
    // a real tag hidden by the virtual reader: stop and turn the virtual reader off
    const hidden = render({
      reader: { ...reader, ignoredRealReader: 'PaSoRi' },
      issue: { running: true, job: job(), issued: 0, last: { type: 'waiting', next: NEXT, issued: 0 } },
    });
    expect(hidden).toContain('data-testid="issue-virtual-off"');
    expect(hidden).toContain('PaSoRi の上のタグは使っていません');
    // a real reader without the virtual one: nothing about it
    const real = render({ reader: rs(), issue: { running: true, job: job(), issued: 0, last: { type: 'waiting', next: NEXT, issued: 0 } } });
    expect(real).not.toContain('data-testid="issue-virtual"');
  });
});

describe('readerAuth with no tag uses activeDriver (D11)', () => {
  it('a real reader in automatic mode is known before a tag is placed', () => {
    expect(readerAuth(rs({ card: null, cardState: 'absent', activeDriver: 'storage' }))).toBe('storage');
    expect(readerAuth(rs({ card: null, cardState: 'absent', activeDriver: 'transparent' }))).toBe('raw');
  });
});
