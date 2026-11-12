// Issue log persistence (append-only, bounded). Owner: main-app.
// Stored at userData/issue-log.json. Never stores keys or passwords (I4).
//
// Duplicate check (skipDuplicateUid) is "the whole issue log" (DESIGN §3.1), but
// the log itself is bounded (MAX_ENTRIES, oldest first), and skipped / error /
// "欠番" records fill it too. So the UIDs that were issued ('ok') are also kept
// in a separate, unbounded, append-only index (userData/issued-uids.tsv: one
// "jobId<TAB>uid" line per issued tag), and issuedUids() reads that index: an old
// issued tag is never forgotten when the log rolls over (2026-11-12 review R-ISSUE-12).
// clear() empties both (the UI says so before clearing).
import type { IssueLogEntry } from '@shared/types';
import { appendText, readBytes, readJson, writeBytes, writeJson } from './storage';

const FILE = 'issue-log.json';
const INDEX_FILE = 'issued-uids.tsv';
const MAX_ENTRIES = 5000;

export interface IssueLog {
  append(entry: IssueLogEntry): Promise<void>;
  list(query: { limit?: number; jobId?: string }): IssueLogEntry[];
  /** UIDs already issued (for duplicate detection), optionally scoped to a job. Not limited by the log's size. */
  issuedUids(jobId?: string): Set<string>;
  /** Clears the log AND the issued-UID index (duplicate detection starts from scratch). */
  clear(): Promise<void>;
}

/** One index line. Tabs / newlines cannot appear in a field (job ids are generated, UIDs are hex). */
function indexLine(jobId: string, uid: string): string {
  const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ');
  return `${clean(jobId)}\t${clean(uid)}\n`;
}

/** uid -> job ids that issued it. */
export type IssuedIndex = Map<string, Set<string>>;

/** Parse the index file (lines "jobId<TAB>uid"; malformed lines are ignored). Pure. */
export function parseIssuedIndex(text: string): IssuedIndex {
  const out: IssuedIndex = new Map();
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const jobId = line.slice(0, tab);
    const uid = line.slice(tab + 1).trim();
    if (!uid) continue;
    addTo(out, jobId, uid);
  }
  return out;
}

function addTo(index: IssuedIndex, jobId: string, uid: string): boolean {
  let jobs = index.get(uid);
  if (!jobs) {
    jobs = new Set();
    index.set(uid, jobs);
  }
  if (jobs.has(jobId)) return false;
  jobs.add(jobId);
  return true;
}

/** `maxEntries`: the log's bound (tests use a small one; the issued index is never bounded). */
export async function createIssueLog(opts: { maxEntries?: number } = {}): Promise<IssueLog> {
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? MAX_ENTRIES));
  let entries = (await readJson<IssueLogEntry[]>(FILE)) ?? [];
  if (!Array.isArray(entries)) entries = [];

  let index: IssuedIndex;
  let indexBytes: Uint8Array | null = null;
  try {
    indexBytes = await readBytes(INDEX_FILE);
  } catch {
    indexBytes = null;
  }
  index = indexBytes ? parseIssuedIndex(new TextDecoder().decode(indexBytes)) : new Map();
  // Union with the log (covers a lost index append, and builds the index the first
  // time from a log written before the index existed).
  let missing = '';
  for (const e of entries) {
    if (e && e.result === 'ok' && typeof e.uid === 'string' && e.uid && addTo(index, String(e.jobId ?? ''), e.uid)) {
      missing += indexLine(String(e.jobId ?? ''), e.uid);
    }
  }
  if (missing) {
    try {
      if (indexBytes) await appendText(INDEX_FILE, missing);
      else await writeBytes(INDEX_FILE, new TextEncoder().encode(missing));
    } catch {
      // best effort: the in-memory index is complete for this session
    }
  }

  return {
    async append(entry) {
      entries.push(entry);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      const newIssued = entry.result === 'ok' && !!entry.uid && addTo(index, entry.jobId, entry.uid);
      await writeJson(FILE, entries);
      if (newIssued) await appendText(INDEX_FILE, indexLine(entry.jobId, entry.uid));
    },
    list({ limit = 500, jobId }) {
      let rows = entries;
      if (jobId) rows = rows.filter((e) => e.jobId === jobId);
      return rows.slice(-limit).reverse();
    },
    issuedUids(jobId) {
      const out = new Set<string>();
      for (const [uid, jobs] of index) {
        if (!jobId || jobs.has(jobId)) out.add(uid);
      }
      return out;
    },
    async clear() {
      entries = [];
      index = new Map();
      await writeJson(FILE, entries);
      await writeBytes(INDEX_FILE, new Uint8Array(0));
    },
  };
}
