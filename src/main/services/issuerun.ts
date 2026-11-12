// The last batch-issue run, kept across app restarts (2026-11-12 review R-ISSUE-4).
// Owner: main-app. Stored at userData/issue-last-run.json - a summary only, with
// no password / CSV rows / NDEF records (see src/main/issue/saved-run.ts, I4).
import { parseSavedRun, type SavedIssueRun } from '../issue/saved-run';
import { readJson, writeJson } from './storage';

const FILE = 'issue-last-run.json';

export interface IssueRunStore {
  /** The last run saved (this session or an earlier one), or null. */
  get(): SavedIssueRun | null;
  /** Save the latest state of a run. Writes are serialised (the last call wins on disk). */
  save(run: SavedIssueRun): Promise<void>;
}

export async function createIssueRunStore(): Promise<IssueRunStore> {
  let current: SavedIssueRun | null = null;
  try {
    current = parseSavedRun(await readJson<unknown>(FILE));
  } catch {
    current = null;
  }
  let chain: Promise<void> = Promise.resolve();
  return {
    get: () => current,
    save(run) {
      current = run;
      const write = chain.then(() => writeJson(FILE, run));
      chain = write.catch(() => {});
      return write;
    },
  };
}
