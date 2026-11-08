// Pure helpers for the issue log (発行台帳): job filtering + CSV export shaping.
// No DOM imports, so this is unit-testable in Node (tests/log-*.test.ts).
// Owner: renderer-issue.
//
// Invariant I4: the log never carries keys or passwords, so none of these helpers
// can leak them - they only re-arrange the fields the log entries already hold.
import type { IssueLogEntry } from '@shared/types';

/** Distinct jobs present in the log, in first-seen (newest-first) order. */
export function distinctJobs(entries: IssueLogEntry[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const e of entries) if (!seen.has(e.jobId)) seen.set(e.jobId, e.jobName);
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

/** Union of value-column keys across entries, first-seen order. */
export function valueColumns(entries: IssueLogEntry[]): string[] {
  const cols: string[] = [];
  for (const e of entries) {
    for (const k of Object.keys(e.values)) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
}

export interface LogCsvLabels {
  at: string;
  job: string;
  uid: string;
  kind: string;
  seq: string;
  result: string;
  message: string;
}

/**
 * Build the header + row matrix for a CSV of the log. Feed the result to
 * schema.toCsv() and prepend a BOM for Excel. Fixed columns first, then one
 * column per value key (in value-column order), then the message.
 */
export function buildLogCsv(
  entries: IssueLogEntry[],
  labels: LogCsvLabels,
  fmtAt: (ms: number) => string,
): { header: string[]; rows: (string | number | null)[][] } {
  const vcols = valueColumns(entries);
  const header = [labels.at, labels.job, labels.uid, labels.kind, labels.seq, labels.result, ...vcols, labels.message];
  const rows = entries.map((e) => [
    fmtAt(e.at),
    e.jobName,
    e.uid,
    e.kind ?? '',
    e.seq ?? '',
    e.result,
    ...vcols.map((c) => e.values[c] ?? ''),
    e.message ?? '',
  ]);
  return { header, rows };
}
