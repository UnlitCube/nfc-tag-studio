// Issue log persistence (append-only, bounded). Integrator-owned.
// Stored at userData/issue-log.json. Never stores keys or passwords (I4).
import type { IssueLogEntry } from '@shared/types';
import { readJson, writeJson } from './storage';

const FILE = 'issue-log.json';
const MAX_ENTRIES = 5000;

export interface IssueLog {
  append(entry: IssueLogEntry): Promise<void>;
  list(query: { limit?: number; jobId?: string }): IssueLogEntry[];
  /** UIDs already issued (for duplicate detection), optionally scoped to a job. */
  issuedUids(jobId?: string): Set<string>;
  clear(): Promise<void>;
}

export async function createIssueLog(): Promise<IssueLog> {
  let entries = (await readJson<IssueLogEntry[]>(FILE)) ?? [];
  if (!Array.isArray(entries)) entries = [];

  return {
    async append(entry) {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
      await writeJson(FILE, entries);
    },
    list({ limit = 500, jobId }) {
      let rows = entries;
      if (jobId) rows = rows.filter((e) => e.jobId === jobId);
      return rows.slice(-limit).reverse();
    },
    issuedUids(jobId) {
      const out = new Set<string>();
      for (const e of entries) {
        if (e.result === 'ok' && (!jobId || e.jobId === jobId)) out.add(e.uid);
      }
      return out;
    },
    async clear() {
      entries = [];
      await writeJson(FILE, entries);
    },
  };
}
