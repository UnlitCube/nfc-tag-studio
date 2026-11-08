// Issue engine functional test (integrator-owned code). Proves the provisioning
// path the user asked for: an incrementing ID written to successive tags, with
// distinct read-only UIDs and NO write ever touching a forbidden unit (UID /
// block 0), plus duplicate-UID skipping.
import { describe, it, expect } from 'vitest';
import type { CardInfo, IssueEvent, IssueJob, ReadOptions, TagImage, WriteRequest, WriteResult } from '../src/shared/types';
import type { DataSchema } from '../src/shared/schema/types';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '../src/shared/schema/types';
import { factoryImage, isForbiddenUnit, specFor } from '../src/shared/tags';
import { bytesToHex, bytesToUintBE } from '../src/shared/hex';
import { createIssueEngine } from '../src/main/issue/engine';
import type { NfcService } from '../src/main/nfc/contract';
import type { IssueLogEntry } from '../src/shared/types';

// In-memory IssueLog (the real one persists to Electron userData, unavailable in node).
function fakeLog() {
  const entries: IssueLogEntry[] = [];
  return {
    async append(e: IssueLogEntry) {
      entries.push(e);
    },
    list() {
      return entries;
    },
    issuedUids(jobId?: string) {
      const out = new Set<string>();
      for (const e of entries) if (e.result === 'ok' && (!jobId || e.jobId === jobId)) out.add(e.uid);
      return out;
    },
    async clear() {
      entries.length = 0;
    },
  };
}

// A fake NfcService that presents a queue of virtual NTAG215 tags. It enforces
// the write contract: a write to a forbidden unit throws (as real hardware/main
// would refuse it), so the test fails loudly if the engine ever plans one.
function fakeService(uids: string[]): { svc: NfcService; tags: Map<string, Uint8Array>; writesSeen: WriteRequest[] } {
  const kind = 'NTAG215' as const;
  const spec = specFor(kind);
  const tags = new Map<string, Uint8Array>();
  for (const uid of uids) {
    const u = Uint8Array.from(uid.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    tags.set(uid, factoryImage(kind, u));
  }
  let idx = 0;
  const writesSeen: WriteRequest[] = [];

  const cardFor = (uid: string): CardInfo => ({
    readerName: 'fake',
    uid,
    atr: '',
    kind,
    kindSource: 'simulator',
    version: null,
    rawCommands: true,
    driver: 'acr122',
    detectedAt: 0,
  });

  const svc: Partial<NfcService> = {
    async waitForCard() {
      if (idx >= uids.length) {
        // no more tags: block forever until aborted (engine stops on limit first)
        await new Promise(() => {});
      }
      return cardFor(uids[idx]);
    },
    async waitForRemoval() {
      idx += 1;
    },
    async readTag(_opts: ReadOptions): Promise<TagImage> {
      const uid = uids[idx];
      const data = tags.get(uid)!;
      return {
        kind,
        uid,
        data: new Uint8Array(data),
        unitStatus: new Array(spec.unitCount).fill('ok'),
        readAt: 0,
      };
    },
    async writeTag(req: WriteRequest): Promise<WriteResult> {
      writesSeen.push(req);
      const uid = uids[idx];
      const data = tags.get(uid)!;
      const written: number[] = [];
      for (const w of req.writes) {
        if (isForbiddenUnit(kind, w.unit)) {
          throw new Error(`FORBIDDEN WRITE to unit ${w.unit}`);
        }
        data.set(w.data, w.unit * spec.unitSize);
        written.push(w.unit);
      }
      return { uid, written, failed: [], verified: req.verify ? true : null, mismatched: [] };
    },
    setBusy() {},
  };
  return { svc: svc as NfcService, tags, writesSeen };
}

function seqSchema(): DataSchema {
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'test-emp',
    name: '社員ID',
    description: '',
    tagKinds: ['NTAG215'],
    area: { mode: 'raw', startUnit: 4 },
    size: 4,
    fields: [
      { id: 'emp', label: '社員ID', type: 'uint', offset: 0, length: 4, source: { kind: 'sequence', offset: 0 }, endian: 'be' },
    ],
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
}

function jobFor(schema: DataSchema, start: number, step: number, limit: number): IssueJob {
  return {
    id: 'job1',
    name: 'test',
    kind: 'NTAG215',
    template: { type: 'schema', schema, inputs: {} },
    sequence: { start, step, next: start },
    rows: null,
    rowIndex: 0,
    options: { verify: true, skipDuplicateUid: true, requireBlank: false, ntagProtect: null, mifareKeyIds: [], sound: false },
    limit,
  };
}

async function runJob(uids: string[], job: IssueJob) {
  const { svc, tags, writesSeen } = fakeService(uids);
  const log = fakeLog();
  const events: IssueEvent[] = [];
  let ticks = 0;
  const engine = createIssueEngine({
    nfc: svc,
    log,
    emit: (e) => events.push(e),
    newId: () => `id${++ticks}`,
    now: () => new Date('2026-11-09T00:00:00.000Z'),
  });
  engine.start(job);
  // wait until a 'stopped' event (limit reached) or timeout
  await waitFor(() => events.some((e) => e.type === 'stopped'), 3000);
  return { tags, writesSeen, events, log };
}

function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = () => {
      if (cond()) return resolve();
      if (performance.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('issue engine: incrementing ID provisioning', () => {
  it('writes an incrementing sequence to successive tags and never touches the UID', async () => {
    const uids = ['04A1B2C3D4E5F0', '04A1B2C3D4E5F1', '04A1B2C3D4E5F2'];
    const { tags, writesSeen, events } = await runJob(uids, jobFor(seqSchema(), 1000, 1, 3));

    const successes = events.filter((e) => e.type === 'success');
    expect(successes.length).toBe(3);

    // Each tag got its sequence value at page 4 (offset 16), big-endian uint32.
    const expected = [1000, 1001, 1002];
    uids.forEach((uid, i) => {
      const data = tags.get(uid)!;
      const page4 = data.subarray(16, 20);
      expect(Number(bytesToUintBE(page4))).toBe(expected[i]);
    });

    // No write ever targeted a forbidden unit (UID pages 0-1).
    for (const req of writesSeen) {
      for (const w of req.writes) expect(w.unit).toBeGreaterThan(1);
    }

    // The three UIDs are distinct and unchanged (read-only).
    expect(new Set(uids).size).toBe(3);
    uids.forEach((uid) => {
      const data = tags.get(uid)!;
      // page 0-1 still hold the factory UID bytes (unchanged)
      const u = Uint8Array.from(uid.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
      expect(data[0]).toBe(u[0]);
      expect(data[4]).toBe(u[3]); // NTAG UID byte layout: page1 byte0 = uid[3]
    });
  });

  it('skips a tag whose UID was already issued', async () => {
    const uids = ['04AA00000000F0', '04AA00000000F0', '04AA00000000F1']; // first two identical
    const { events } = await runJob(uids, jobFor(seqSchema(), 1, 1, 2));
    const successes = events.filter((e) => e.type === 'success');
    const skips = events.filter((e) => e.type === 'skipped');
    expect(successes.length).toBe(2); // two distinct UIDs issued
    expect(skips.length).toBeGreaterThanOrEqual(1); // the duplicate was skipped
    expect(bytesToHex(Uint8Array.of(1))).toBe('01'); // sanity
  });
});
