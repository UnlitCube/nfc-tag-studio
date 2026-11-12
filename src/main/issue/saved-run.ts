// The last batch-issue run, kept across app restarts (2026-11-12 review R-ISSUE-4).
// Owner: main-app. Pure (no Electron): the store that writes it to userData is
// src/main/services/issuerun.ts.
//
// What is kept is a SUMMARY, never the job as the operator entered it:
//  - no NTAG password / PACK (I4: secrets never reach a log or a file),
//  - no CSV rows (personal data) - only that the job used a CSV and how many rows,
//  - no NDEF records (a Wi-Fi record can hold a password) and no template inputs,
//  - no duplicate image bytes.
// The renderer rebuilds the job from its own form on "resume"; the summary only
// tells it where to continue (job id / name, sequence.next, rowIndex, limit, counts).
import type { IssueEvent, IssueJob, IssueOptions, IssueTemplate } from '@shared/types';
import { TAG_KINDS, type TagKind } from '@shared/tags';

export type IssueStopReason = Extract<IssueEvent, { type: 'stopped' }>['reason'];

export interface SavedIssueRun {
  version: 1;
  /** When the run ended (or, for a run still going when the app ended, its last success). epoch ms. */
  endedAt: number;
  reason: IssueStopReason;
  /** Tags issued in that run. */
  issued: number;
  /** Tags issued by this job id over all its runs (also earlier sessions). */
  total: number;
  /** Rows of the CSV the job used (null = no CSV). The rows themselves are not kept. */
  rowCount: number | null;
  /** Summary of the job (see summarizeJob). */
  job: IssueJob;
}

const REASONS: readonly IssueStopReason[] = ['user', 'limit', 'rows-exhausted', 'error'];

/** The job without secrets, personal data or large data (safe to write to userData). */
export function summarizeJob(j: IssueJob): IssueJob {
  return {
    id: j.id,
    name: j.name,
    kind: j.kind,
    template: summarizeTemplate(j.template),
    sequence: { start: j.sequence.start, step: j.sequence.step, next: j.sequence.next },
    // [] (not null) keeps "this job needs a CSV": the renderer offers "resume"
    // only once the same CSV is open again (resumePlan returns null until then).
    rows: j.rows ? [] : null,
    rowIndex: j.rowIndex,
    options: summarizeOptions(j.options),
    limit: j.limit,
  };
}

function summarizeTemplate(t: IssueTemplate): IssueTemplate {
  if (t.type === 'schema') return { type: 'schema', schema: t.schema, inputs: {} };
  if (t.type === 'ndef') return { type: 'ndef', records: [] };
  return { type: 'image', kind: t.kind, data: new Uint8Array(0), units: [], sourceUid: t.sourceUid ?? null };
}

function summarizeOptions(o: IssueOptions): IssueOptions {
  return {
    verify: o.verify,
    skipDuplicateUid: o.skipDuplicateUid,
    requireBlank: o.requireBlank,
    ntagProtect: null, // never the password (I4)
    mifareKeyIds: Array.isArray(o.mifareKeyIds) ? [...o.mifareKeyIds] : [],
    sound: o.sound,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A saved run read back from disk (any version / corrupt file) -> a valid summary, or null. */
export function parseSavedRun(v: unknown): SavedIssueRun | null {
  if (!isObj(v) || v.version !== 1) return null;
  if (!isNum(v.endedAt) || !REASONS.includes(v.reason as IssueStopReason)) return null;
  if (!isCount(v.issued) || !isCount(v.total)) return null;
  if (!(v.rowCount === null || isCount(v.rowCount))) return null;
  const j = v.job;
  if (!isObj(j) || typeof j.id !== 'string' || !j.id || typeof j.name !== 'string') return null;
  if (!TAG_KINDS.includes(j.kind as TagKind)) return null;
  const seq = j.sequence;
  if (!isObj(seq) || !isNum(seq.start) || !isNum(seq.step) || !isNum(seq.next)) return null;
  if (!isCount(j.rowIndex)) return null;
  if (!(j.rows === null || Array.isArray(j.rows))) return null;
  if (!(j.limit === null || isCount(j.limit))) return null;
  const t = j.template;
  if (!isObj(t)) return null;
  let template: IssueTemplate;
  if (t.type === 'schema' && isObj(t.schema)) template = { type: 'schema', schema: t.schema as never, inputs: {} };
  else if (t.type === 'ndef') template = { type: 'ndef', records: [] };
  else if (t.type === 'image' && TAG_KINDS.includes(t.kind as TagKind)) {
    template = { type: 'image', kind: t.kind as TagKind, data: new Uint8Array(0), units: [], sourceUid: typeof t.sourceUid === 'string' ? t.sourceUid : null };
  } else return null;
  const o = isObj(j.options) ? j.options : {};
  const job: IssueJob = {
    id: j.id,
    name: j.name,
    kind: j.kind as TagKind,
    template,
    sequence: { start: seq.start, step: seq.step, next: seq.next },
    rows: j.rows === null ? null : [],
    rowIndex: j.rowIndex,
    options: {
      verify: o.verify !== false,
      skipDuplicateUid: o.skipDuplicateUid !== false,
      requireBlank: o.requireBlank === true,
      ntagProtect: null,
      mifareKeyIds: Array.isArray(o.mifareKeyIds) ? o.mifareKeyIds.filter((x): x is string => typeof x === 'string') : [],
      sound: o.sound !== false,
    },
    limit: j.limit,
  };
  return {
    version: 1,
    endedAt: v.endedAt,
    reason: v.reason as IssueStopReason,
    issued: v.issued,
    total: Math.max(v.total, v.issued),
    rowCount: v.rowCount,
    job,
  };
}
