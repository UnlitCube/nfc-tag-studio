// Pure helpers for the batch-issue (量産) view. No React / DOM imports, so the
// logic is unit-testable in a Node environment (tests/issue-*.test.ts).
// Owner: renderer-issue.
import type { DataSchema, SchemaField } from '@shared/schema/types';
import type { IssueEvent } from '@shared/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import type { TagKind } from '@shared/tags';
import { isProtectedUnit, specFor } from '@shared/tags';

export interface Sequence {
  start: number;
  step: number;
  next: number;
}

export interface PreviewSlot {
  index: number;
  seq: number;
  rowIndex: number | null;
}

/**
 * The first `count` tags a job would issue: each tag's sequence value and (when a
 * CSV is loaded) the row index it draws from. Stops early when the CSV rows are
 * exhausted or the job's success limit is reached. Pure.
 */
export function previewSlots(args: {
  sequence: Sequence;
  /** Number of CSV rows, or null when no CSV is loaded. */
  rowCount: number | null;
  /** The job's starting rowIndex (normally 0). */
  rowStart: number;
  /** Stop after this many successful tags, or null for unlimited. */
  limit: number | null;
  /** How many preview slots to produce. */
  count: number;
}): PreviewSlot[] {
  const { sequence, rowCount, rowStart, limit, count } = args;
  const cap = limit != null ? Math.min(count, Math.max(0, limit)) : count;
  const out: PreviewSlot[] = [];
  for (let i = 0; i < cap; i++) {
    let rowIndex: number | null = null;
    if (rowCount != null) {
      rowIndex = rowStart + i;
      if (rowIndex >= rowCount) break; // rows exhausted
    }
    out.push({ index: i, seq: sequence.next + i * sequence.step, rowIndex });
  }
  return out;
}

/** Schema fields whose value is typed once per job (source "input"). */
export function schemaInputFields(schema: DataSchema): SchemaField[] {
  return schema.fields.filter((f) => f.source.kind === 'input');
}

/** CSV column names a schema references (source "csv"), first-seen order, deduped. */
export function schemaCsvColumns(schema: DataSchema): string[] {
  const cols: string[] = [];
  for (const f of schema.fields) {
    if (f.source.kind === 'csv' && !cols.includes(f.source.column)) cols.push(f.source.column);
  }
  return cols;
}

/** True when any field draws from the job's incrementing sequence counter. */
export function schemaUsesSequence(schema: DataSchema): boolean {
  return schema.fields.some((f) => f.source.kind === 'sequence');
}

/**
 * Writable data units of a tag kind, for duplicate (image) mode. Never includes
 * the UID, CC, lock/config, MIFARE block 0 or sector trailers — invariant I1:
 * the UID is never copied, only the data area.
 */
export function duplicateUnits(kind: TagKind): number[] {
  const out: number[] = [];
  const n = specFor(kind).unitCount;
  for (let u = 0; u < n; u++) if (!isProtectedUnit(kind, u)) out.push(u);
  return out;
}

/**
 * Bytes actually written when duplicating a source tag's data area: the number of
 * writable (non-protected) units times the unit size. This is strictly less than
 * imageSize(kind), which counts the whole tag including the UID / CC / config /
 * trailers that are never copied (invariant I1). Pure.
 */
export function duplicateSize(kind: TagKind): number {
  return duplicateUnits(kind).length * specFor(kind).unitSize;
}

/** Parse a user-typed integer. Returns null for anything that is not a whole number. */
export function parseIntInput(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** A short one-line summary of an NDEF record draft (no secrets: Wi-Fi password is not shown). */
export function summarizeDraft(r: NdefRecordDraft): string {
  switch (r.kind) {
    case 'uri':
      return r.uri;
    case 'text':
      return r.text;
    case 'wifi':
      return `Wi-Fi: ${r.ssid}`;
    case 'vcard':
      return r.fields.name;
    case 'mime':
      return r.mimeType;
    case 'aar':
      return r.packageName;
    case 'external':
      return r.domainType;
    case 'smartposter':
      return r.uri;
    case 'raw':
      return `raw (TNF ${r.tnf})`;
    case 'empty':
      return 'empty';
  }
}

// ---------------------------------------------------------------------------
// Live status (big-status panel while issuing)
// ---------------------------------------------------------------------------

export type IssuePhase = 'idle' | 'waiting' | 'writing' | 'success' | 'skipped' | 'error' | 'remove' | 'stopped';
export type BigStatusTone = 'ok' | 'danger' | 'warn' | 'accent' | 'neutral';

/** Map the latest issue event to the phase the big-status panel shows. Pure. */
export function issuePhase(last: IssueEvent | null): IssuePhase {
  if (!last) return 'idle';
  switch (last.type) {
    case 'started':
    case 'waiting':
      return 'waiting';
    case 'writing':
      return 'writing';
    case 'success':
      return 'success';
    case 'skipped':
      return 'skipped';
    case 'error':
      return 'error';
    case 'remove-card':
      return 'remove';
    case 'stopped':
      return 'stopped';
  }
}

/** The big-status colour tone for a phase. Pure. */
export function phaseTone(phase: IssuePhase): BigStatusTone {
  switch (phase) {
    case 'success':
      return 'ok';
    case 'error':
      return 'danger';
    case 'skipped':
    case 'remove':
      return 'warn';
    case 'writing':
    case 'waiting':
      return 'accent';
    case 'stopped':
    case 'idle':
      return 'neutral';
  }
}
