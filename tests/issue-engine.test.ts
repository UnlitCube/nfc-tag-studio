// Issue engine tests. Proves the provisioning path the user asked for (an
// incrementing ID written to successive tags, read-only UIDs never touched) and
// the failure paths found by the 2026-11-12 UX audit (ISSUE-1..5, 7..9, 12, 14,
// 15, 17): a tag left on the reader at start, a tag removed mid-write (same
// number reserved for the same tag / retired for another tag), a bad CSV row,
// resume from where it stopped, duplicate UIDs across the whole log, the
// duplicate-mode source tag, and the stop reason + job state.
//
// The fake NfcService below implements only the contract (src/main/nfc/contract.ts)
// the engine uses, as a scripted "reader" the test places / removes tags on.
import { describe, it, expect } from 'vitest';
import type {
  CardInfo,
  CardState,
  IssueEvent,
  IssueJob,
  IssueLogEntry,
  ReadOptions,
  ReaderStatus,
  ResolvedDriver,
  TagImage,
  WriteRequest,
  WriteResult,
} from '../src/shared/types';
import type { DataSchema } from '../src/shared/schema/types';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '../src/shared/schema/types';
import type { NdefRecordDraft } from '../src/shared/ndef/types';
import { decodeToDrafts, scanType2Tlvs } from '../src/shared/ndef';
import { factoryImage, isForbiddenUnit, specFor, type TagKind } from '../src/shared/tags';
import { bytesToUintBE, hexToBytes } from '../src/shared/hex';
import { createIssueEngine, type IssueRunPersistence } from '../src/main/issue/engine';
import type { SavedIssueRun } from '../src/main/issue/saved-run';
import { resumePlan } from '../src/renderer/src/views/issue/model';
import type { NfcService } from '../src/main/nfc/contract';
import { OpError } from '../src/main/errors';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function fakeLog(initial: IssueLogEntry[] = [], appendDelay?: (e: IssueLogEntry) => number) {
  const entries: IssueLogEntry[] = [...initial];
  return {
    entries,
    async append(e: IssueLogEntry) {
      entries.push(e);
      const d = appendDelay?.(e) ?? 0;
      if (d > 0) await sleep(d);
    },
    list() {
      return [...entries].reverse();
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

type WriteBehavior =
  | 'ok'
  /** Write the first n units, then the tag leaves the reader (aborted CARD_REMOVED). */
  | { abortAfter: number }
  /** Write everything, but the read-back does not match (e.g. removed during verify). */
  | 'mismatch'
  /** Take `ms` before finishing (to stop the run mid-write). */
  | { delay: number }
  /** Reject before writing anything (e.g. the tag left before the UID re-check). */
  | { reject: OpError };

interface FakeTag {
  uid: string;
  kind: TagKind;
  data: Uint8Array;
}

/** A scripted reader: the test places / removes tags; the service follows the NfcService contract. */
class FakeReader {
  tags = new Map<string, FakeTag>();
  current: { uid: string; detectedAt: number } | null = null;
  cardState: CardState = 'absent';
  driver: ResolvedDriver = 'acr122';
  writes: { uid: string; req: WriteRequest; at: number }[] = [];
  reads: { uid: string; opts: ReadOptions }[] = [];
  /** How long each readTag takes (ms). */
  readDelayMs = 0;
  /** Per-UID queue of behaviours for the next writes (default 'ok'). */
  writePlan = new Map<string, WriteBehavior[]>();
  /** Per-UID queue of errors for the next reads. */
  readFail = new Map<string, OpError[]>();
  private listeners = new Set<(s: ReaderStatus) => void>();
  private cardWaiters: { resolve: (c: CardInfo) => void; reject: (e: unknown) => void; after: number }[] = [];

  addTag(uid: string, kind: TagKind = 'NTAG215'): FakeTag {
    const tag = { uid, kind, data: factoryImage(kind, hexToBytes(uid)) };
    this.tags.set(uid, tag);
    return tag;
  }

  place(uid: string): void {
    if (!this.tags.has(uid)) this.addTag(uid);
    this.current = { uid, detectedAt: Date.now() };
    this.cardState = 'ready';
    this.push();
  }

  remove(): void {
    this.current = null;
    this.cardState = 'absent';
    this.push();
  }

  /** Replace the tag without an "absent" in between (fast swap within one poll). */
  swap(uid: string): void {
    this.place(uid);
  }

  /** A tag that is on the reader but not identified (yet): 'detecting' / 'error'. */
  unidentified(state: CardState): void {
    this.current = null;
    this.cardState = state;
    this.push();
  }

  cardFor(uid: string, detectedAt: number): CardInfo {
    const tag = this.tags.get(uid)!;
    return {
      readerName: 'Fake Reader 0',
      uid,
      atr: '',
      kind: tag.kind,
      kindSource: 'version',
      version: null,
      rawCommands: this.driver !== 'storage',
      driver: this.driver,
      detectedAt,
    };
  }

  status(): ReaderStatus {
    return {
      service: 'ok',
      serviceMessage: null,
      readers: [],
      selectedReader: null,
      activeReader: 'Fake Reader 0',
      activeReason: 'auto-first',
      driverMode: 'auto',
      card: this.current ? this.cardFor(this.current.uid, this.current.detectedAt) : null,
      cardState: this.cardState,
      cardError: null,
      ignoredRealReader: null,
      busy: null,
      simulator: { enabled: false, kind: 'NTAG215', present: false, uid: '' },
    };
  }

  private push(): void {
    const s = this.status();
    for (const cb of [...this.listeners]) cb(s);
    if (this.current) {
      const cur = this.current;
      const ready = this.cardWaiters.filter((w) => cur.detectedAt > w.after);
      this.cardWaiters = this.cardWaiters.filter((w) => !ready.includes(w));
      for (const w of ready) w.resolve(this.cardFor(cur.uid, cur.detectedAt));
    }
  }

  private requireTag(): FakeTag {
    if (!this.current) throw new OpError('NO_CARD');
    return this.tags.get(this.current.uid)!;
  }

  get svc(): NfcService {
    const self = this;
    const svc: Partial<NfcService> = {
      getStatus: () => self.status(),
      onStatus(cb) {
        self.listeners.add(cb);
        return () => self.listeners.delete(cb);
      },
      waitForCard(signal, opts) {
        const after = opts?.detectedAfter ?? -Infinity;
        if (signal.aborted) return Promise.reject(new OpError('CANCELLED'));
        if (self.current && self.current.detectedAt > after) {
          return Promise.resolve(self.cardFor(self.current.uid, self.current.detectedAt));
        }
        return new Promise<CardInfo>((resolve, reject) => {
          const w = { resolve, reject, after };
          self.cardWaiters.push(w);
          signal.addEventListener(
            'abort',
            () => {
              self.cardWaiters = self.cardWaiters.filter((x) => x !== w);
              reject(new OpError('CANCELLED'));
            },
            { once: true },
          );
        });
      },
      // Kept for an engine that still uses it: resolves when no tag is on the reader.
      waitForRemoval(signal) {
        return new Promise<void>((resolve, reject) => {
          const check = () => {
            if (!self.current) {
              off();
              resolve();
            }
          };
          const off = (): void => {
            self.listeners.delete(onS);
          };
          const onS = () => check();
          self.listeners.add(onS);
          signal.addEventListener(
            'abort',
            () => {
              off();
              reject(new OpError('CANCELLED'));
            },
            { once: true },
          );
          check();
        });
      },
      async readTag(opts: ReadOptions): Promise<TagImage> {
        if (self.readDelayMs > 0) await sleep(self.readDelayMs);
        const tag = self.requireTag();
        self.reads.push({ uid: tag.uid, opts });
        const fail = self.readFail.get(tag.uid)?.shift();
        if (fail) throw fail;
        const spec = specFor(tag.kind);
        return {
          kind: tag.kind,
          uid: tag.uid,
          data: new Uint8Array(tag.data),
          unitStatus: new Array(spec.unitCount).fill('ok'),
          readAt: Date.now(),
        };
      },
      async writeTag(req: WriteRequest): Promise<WriteResult> {
        const tag = self.requireTag();
        if (req.expectedUid && req.expectedUid !== tag.uid) throw new OpError('UID_MISMATCH');
        if (req.kind !== tag.kind) throw new OpError('KIND_MISMATCH');
        self.writes.push({ uid: tag.uid, req, at: Date.now() });
        const spec = specFor(tag.kind);
        const behavior = self.writePlan.get(tag.uid)?.shift() ?? 'ok';
        if (typeof behavior === 'object' && 'reject' in behavior) throw behavior.reject;
        if (typeof behavior === 'object' && 'delay' in behavior) await sleep(behavior.delay);
        const limit = typeof behavior === 'object' && 'abortAfter' in behavior ? behavior.abortAfter : req.writes.length;
        const written: number[] = [];
        for (const w of req.writes.slice(0, limit)) {
          if (isForbiddenUnit(tag.kind, w.unit)) throw new Error(`FORBIDDEN WRITE to unit ${w.unit}`);
          tag.data.set(w.data, w.unit * spec.unitSize);
          written.push(w.unit);
        }
        if (limit < req.writes.length) {
          self.remove(); // the tag left the reader
          return {
            uid: tag.uid,
            written,
            failed: [],
            verified: null,
            mismatched: [],
            aborted: 'CARD_REMOVED',
            notAttempted: req.writes.slice(limit).map((w) => w.unit),
          };
        }
        const mismatch = behavior === 'mismatch';
        return {
          uid: tag.uid,
          written,
          failed: [],
          verified: req.verify ? !mismatch : null,
          mismatched: mismatch ? [written[0]] : [],
          aborted: null,
          notAttempted: [],
        };
      },
      setBusy() {},
    };
    return svc as NfcService;
  }
}

class Recorder {
  events: IssueEvent[] = [];
  private cursor = 0;
  emit = (e: IssueEvent): void => {
    this.events.push(structuredClone(e));
  };
  /** Wait for the next event of `type` after the cursor and move the cursor past it. */
  async next<T extends IssueEvent['type']>(type: T, timeoutMs = 2000): Promise<Extract<IssueEvent, { type: T }>> {
    const start = Date.now();
    for (;;) {
      for (let i = this.cursor; i < this.events.length; i++) {
        if (this.events[i].type === type) {
          this.cursor = i + 1;
          return this.events[i] as Extract<IssueEvent, { type: T }>;
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for "${type}"; events: ${this.events.map((e) => e.type).join(', ')}`);
      }
      await sleep(2);
    }
  }
  of<T extends IssueEvent['type']>(type: T): Extract<IssueEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<IssueEvent, { type: T }>[];
  }
}

function setup(
  opts: { log?: IssueLogEntry[]; fakeLog?: ReturnType<typeof fakeLog>; lang?: 'ja' | 'en'; removalSettleMs?: number; runStore?: IssueRunPersistence } = {},
) {
  const reader = new FakeReader();
  const log = opts.fakeLog ?? fakeLog(opts.log);
  const rec = new Recorder();
  let n = 0;
  const engine = createIssueEngine({
    nfc: reader.svc,
    log,
    emit: rec.emit,
    newId: () => `id${++n}`,
    now: () => new Date('2026-11-09T00:00:00.000Z'),
    lang: () => opts.lang ?? 'ja',
    // Most tests remove a tag for good; the settle window has its own test below.
    removalSettleMs: opts.removalSettleMs ?? 0,
    runStore: opts.runStore,
  });
  return { reader, log, rec, engine };
}

/** Operator: wait for "place a tag", place `uid`, wait for "remove the tag", remove it. */
async function issueTag(reader: FakeReader, rec: Recorder, uid: string) {
  await rec.next('waiting');
  reader.place(uid);
  const removeEvt = await rec.next('remove-card');
  reader.remove();
  return removeEvt;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const uidN = (n: number) => `04A1B2C3D4E5${n.toString(16).toUpperCase().padStart(2, '0')}`;

function seqSchema(length = 4): DataSchema {
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'test-emp',
    name: '社員ID',
    description: '',
    tagKinds: ['NTAG215'],
    area: { mode: 'raw', startUnit: 4 },
    size: length,
    fields: [
      { id: 'emp', label: '社員ID', type: 'uint', offset: 0, length, source: { kind: 'sequence', offset: 0 }, endian: 'be' },
    ],
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
}

const OPTIONS = { verify: true, skipDuplicateUid: true, requireBlank: false, ntagProtect: null, mifareKeyIds: [], sound: false };

function schemaJob(start: number, limit: number | null, id = 'job1'): IssueJob {
  return {
    id,
    name: 'test',
    kind: 'NTAG215',
    template: { type: 'schema', schema: seqSchema(), inputs: {} },
    sequence: { start, step: 1, next: start },
    rows: null,
    rowIndex: 0,
    options: { ...OPTIONS },
    limit,
  };
}

const LONG = ' / 社員証 NFC Tag Studio テスト用の長めのテキスト';

function ndefJob(opts: { kind?: TagKind; text?: string; rows?: Record<string, string>[] | null; start?: number; requireBlank?: boolean } = {}): IssueJob {
  const records: NdefRecordDraft[] = [{ kind: 'text', text: opts.text ?? `ID {{seq}}${LONG}`, lang: 'ja', encoding: 'utf8' }];
  const start = opts.start ?? 100;
  return {
    id: 'job-ndef',
    name: 'ndef',
    kind: opts.kind ?? 'NTAG215',
    template: { type: 'ndef', records },
    sequence: { start, step: 1, next: start },
    rows: opts.rows ?? null,
    rowIndex: 0,
    options: { ...OPTIONS, requireBlank: opts.requireBlank ?? false },
    limit: null,
  };
}

/** Text of the first NDEF text record on an NTAG image. */
function ndefText(data: Uint8Array): string | null {
  const scan = scanType2Tlvs(data.subarray(16));
  if (!scan.ndef) return null;
  const drafts = decodeToDrafts(scan.ndef);
  const t = drafts.find((d) => d.kind === 'text');
  return t && t.kind === 'text' ? t.text : null;
}

const seqOf = (data: Uint8Array) => Number(bytesToUintBE(data.subarray(16, 20)));
const RAW_CODE = /\b[A-Z]{3,}_[A-Z_]+\b/; // e.g. CARD_REMOVED, ACCESS_DENIED
const JAPANESE = /[぀-ヿ一-鿿]/;

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('issue engine: incrementing ID provisioning', () => {
  it('writes an incrementing sequence to successive tags and never touches the UID', async () => {
    const { reader, rec, engine } = setup();
    const uids = [uidN(0), uidN(1), uidN(2)];
    engine.start(schemaJob(1000, 3));
    for (const uid of uids) await issueTag(reader, rec, uid);
    const stopped = await rec.next('stopped');

    expect(rec.of('success').map((e) => e.entry.seq)).toEqual([1000, 1001, 1002]);
    uids.forEach((uid, i) => expect(seqOf(reader.tags.get(uid)!.data)).toBe(1000 + i));
    for (const { req } of reader.writes) for (const w of req.writes) expect(w.unit).toBeGreaterThan(1);
    // UID pages unchanged (read-only)
    uids.forEach((uid) => {
      const u = hexToBytes(uid);
      const d = reader.tags.get(uid)!.data;
      expect(d[0]).toBe(u[0]);
      expect(d[4]).toBe(u[3]);
    });
    // stop reason + job state for "resume"
    expect(stopped.reason).toBe('limit');
    expect(stopped.issued).toBe(3);
    expect(stopped.job?.sequence.next).toBe(1003);
    expect(engine.getState().running).toBe(false);
  });

  it('skips a tag whose UID was already issued in this job', async () => {
    const { reader, rec, engine } = setup();
    engine.start(schemaJob(1, 2));
    await issueTag(reader, rec, uidN(0x10));
    const again = await issueTag(reader, rec, uidN(0x10));
    await issueTag(reader, rec, uidN(0x11));
    await rec.next('stopped');
    expect(again.outcome).toBe('skipped');
    expect(rec.of('success').map((e) => e.entry.uid)).toEqual([uidN(0x10), uidN(0x11)]);
    expect(rec.of('skipped')[0].reason).toBe('duplicate');
  });

  it('keeps the outcome of each tag on the remove-card event (ok / skipped / error) and logs every attempt', async () => {
    const { reader, rec, engine, log } = setup();
    reader.addTag(uidN(0x22), 'NTAG213');
    reader.readFail.set(uidN(0x23), [new OpError('ACCESS_DENIED')]);
    engine.start(schemaJob(7, null));
    const ok = await issueTag(reader, rec, uidN(0x21));
    const skipped = await issueTag(reader, rec, uidN(0x22));
    const err = await issueTag(reader, rec, uidN(0x23));
    engine.stop();
    await rec.next('stopped');

    expect(ok.outcome).toBe('ok');
    expect(ok.entry?.seq).toBe(7);
    expect(ok.message).toBeNull();

    expect(skipped.outcome).toBe('skipped');
    expect(skipped.entry?.result).toBe('skipped');
    expect(skipped.message).toContain('NTAG213');
    expect(skipped.message).toContain('NTAG215');

    expect(err.outcome).toBe('error');
    expect(err.entry?.result).toBe('error');
    expect(err.message).toBeTruthy();
    // reading -> (writing) order and the detected UID
    const firstReading = rec.events.findIndex((e) => e.type === 'reading');
    const firstWriting = rec.events.findIndex((e) => e.type === 'writing');
    expect(firstReading).toBeGreaterThan(-1);
    expect(firstReading).toBeLessThan(firstWriting);
    // every attempt is in the log (ok + skipped + error)
    expect(log.entries.map((e) => `${e.uid}:${e.result}`)).toEqual([`${uidN(0x21)}:ok`, `${uidN(0x22)}:skipped`, `${uidN(0x23)}:error`]);
  });
});

describe('issue engine: a tag left on the reader at start (ISSUE-5)', () => {
  it('asks to clear the reader and never writes the tag that was already there', async () => {
    const { reader, rec, engine } = setup();
    reader.place(uidN(0x30)); // e.g. the sample tag read on the home screen
    engine.start(schemaJob(1, 1));
    const clear = await rec.next('clear-reader');
    expect(clear.uid).toBe(uidN(0x30));
    await sleep(60);
    expect(reader.writes).toHaveLength(0);
    expect(reader.reads).toHaveLength(0);
    expect(rec.of('waiting')).toHaveLength(0);

    reader.remove();
    await issueTag(reader, rec, uidN(0x31));
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0x31)]);
    expect(seqOf(reader.tags.get(uidN(0x30))!.data)).not.toBe(1);
  });

  it('a tag still being identified at start also has to be removed first', async () => {
    const { reader, rec, engine } = setup();
    reader.unidentified('detecting');
    engine.start(schemaJob(1, 1));
    await rec.next('clear-reader');
    reader.addTag(uidN(0x32));
    // identification finishes AFTER start: still the tag that was already there
    reader.place(uidN(0x32));
    await sleep(40);
    expect(reader.writes).toHaveLength(0);
    reader.remove();
    await issueTag(reader, rec, uidN(0x33));
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0x33)]);
  });
});

describe('issue engine: a tag removed mid-write (ISSUE-2)', () => {
  it('reserves the number: the SAME tag placed again is rewritten with the same number (even with "blank only")', async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x40);
    const B = uidN(0x41);
    reader.writePlan.set(A, [{ abortAfter: 2 }]);
    engine.start(ndefJob({ requireBlank: true }));

    await rec.next('waiting');
    reader.place(A);
    const err = await rec.next('error');
    expect(err.partial).toBe(true);
    expect(err.message).toContain('No.100');
    expect(err.message).not.toMatch(RAW_CODE);
    expect(err.message).not.toContain('#');
    const rm = await rec.next('remove-card');
    expect(rm.outcome).toBe('error');
    expect(reader.current).toBeNull(); // the tag already left

    // the same tag again -> same number, not skipped as "not blank"
    const again = await issueTag(reader, rec, A);
    expect(again.outcome).toBe('ok');
    expect(again.entry?.seq).toBe(100);
    expect(ndefText(reader.tags.get(A)!.data)).toBe(`ID 100${LONG}`);

    // the next tag gets the next number
    const next = await issueTag(reader, rec, B);
    expect(next.entry?.seq).toBe(101);
    engine.stop();
    await rec.next('stopped');
    expect(log.entries.map((e) => `${e.uid}:${e.seq}:${e.result}`)).toEqual([`${A}:100:error`, `${A}:100:ok`, `${B}:101:ok`]);
  });

  it('retires the reserved number when ANOTHER tag comes (logged), so no two tags carry the same number', async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x50);
    const B = uidN(0x51);
    reader.writePlan.set(A, [{ abortAfter: 2 }]);
    engine.start(ndefJob({ requireBlank: true }));
    await rec.next('waiting');
    reader.place(A);
    await rec.next('remove-card');

    const b = await issueTag(reader, rec, B);
    expect(b.outcome).toBe('ok');
    expect(b.entry?.seq).toBe(101);
    expect(ndefText(reader.tags.get(B)!.data)).toBe(`ID 101${LONG}`);
    const voided = log.entries.find((e) => e.uid === A && e.result === 'skipped');
    expect(voided?.seq).toBe(100);
    expect(voided?.message).toContain('欠番');

    // A is no longer reserved: with "blank only" it is now skipped
    const a2 = await issueTag(reader, rec, A);
    expect(a2.outcome).toBe('skipped');
    engine.stop();
    const stopped = await rec.next('stopped');
    expect(stopped.job?.sequence.next).toBe(102);
  });

  it('treats a failed read-back (removed during verify) as half-written and reserves the number', async () => {
    const { reader, rec, engine } = setup();
    const A = uidN(0x58);
    reader.writePlan.set(A, ['mismatch']);
    engine.start(schemaJob(500, null));
    await rec.next('waiting');
    reader.place(A);
    const err = await rec.next('error');
    expect(err.partial).toBe(true);
    await rec.next('remove-card');
    reader.remove();
    const again = await issueTag(reader, rec, A);
    expect(again.entry?.seq).toBe(500);
    const next = await issueTag(reader, rec, uidN(0x59));
    expect(next.entry?.seq).toBe(501);
    engine.stop();
    await rec.next('stopped');
  });

  it('a tag removed while being READ is not half-written: nothing reserved, the number goes to the next tag', async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x60);
    reader.readFail.set(A, [new OpError('CARD_REMOVED')]);
    engine.start(schemaJob(10, null));
    await rec.next('waiting');
    reader.place(A);
    const err = await rec.next('error');
    expect(err.partial).toBe(false);
    expect(err.message).toContain('書き込んでいません');
    expect(err.message).not.toMatch(RAW_CODE);
    await rec.next('remove-card');
    reader.remove();
    const b = await issueTag(reader, rec, uidN(0x61));
    expect(b.entry?.seq).toBe(10);
    engine.stop();
    await rec.next('stopped');
    expect(log.entries[0]).toMatchObject({ uid: A, result: 'error', seq: null });
  });

  it('a write rejected with CARD_REMOVED (left before the first write) is not half-written', async () => {
    const { reader, rec, engine } = setup();
    const A = uidN(0x64);
    reader.writePlan.set(A, [{ reject: new OpError('CARD_REMOVED') }]);
    engine.start(schemaJob(20, null));
    await rec.next('waiting');
    reader.place(A);
    const err = await rec.next('error');
    expect(err.partial).toBe(false);
    expect(err.message).toContain('書き込んでいません');
    await rec.next('remove-card');
    reader.remove();
    const b = await issueTag(reader, rec, uidN(0x65));
    expect(b.entry?.seq).toBe(20);
    engine.stop();
    await rec.next('stopped');
  });

  it('retires an outstanding reservation on stop (resume never reuses the half-written number)', async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x68);
    reader.writePlan.set(A, [{ abortAfter: 1 }]);
    engine.start(ndefJob());
    await rec.next('waiting');
    reader.place(A);
    await rec.next('remove-card');
    await rec.next('waiting');
    engine.stop();
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('user');
    expect(stopped.job?.sequence.next).toBe(101);
    expect(log.entries.some((e) => e.uid === A && e.result === 'skipped' && e.seq === 100)).toBe(true);
  });
});

describe('issue engine: CSV rows (ISSUE-4)', () => {
  it('logs a row that does not fit as an error and moves on to the next row (no tag is used for it)', async () => {
    const { reader, rec, engine, log } = setup();
    const rows = [{ name: 'alice' }, { name: 'x'.repeat(300) }, { name: 'carol' }];
    engine.start(ndefJob({ kind: 'NTAG213', text: '{{csv:name}}', rows }));
    reader.addTag(uidN(0x70), 'NTAG213');
    reader.addTag(uidN(0x71), 'NTAG213');
    await issueTag(reader, rec, uidN(0x70));
    const bad = await rec.next('error');
    expect(bad.partial).toBe(false);
    expect(bad.message).toContain('2 行目');
    await issueTag(reader, rec, uidN(0x71));
    const stopped = await rec.next('stopped');

    expect(stopped.reason).toBe('rows-exhausted');
    expect(stopped.job?.rowIndex).toBe(3);
    expect(ndefText(reader.tags.get(uidN(0x70))!.data)).toBe('alice');
    expect(ndefText(reader.tags.get(uidN(0x71))!.data)).toBe('carol');
    expect(log.entries.map((e) => e.result)).toEqual(['ok', 'error', 'ok']);
    expect(log.entries[1].uid).toBe('');
    // the bad row never reached a tag
    expect(reader.writes).toHaveLength(2);
  });

  it('counts only CONSECUTIVE bad rows: a good row in between resets the count', async () => {
    const { reader, rec, engine } = setup();
    const bad = { name: 'z'.repeat(300) };
    const rows = [bad, bad, bad, bad, { name: 'good1' }, bad, bad, bad, bad, { name: 'good2' }];
    engine.start(ndefJob({ kind: 'NTAG213', text: '{{csv:name}}', rows }));
    reader.addTag(uidN(0x78), 'NTAG213');
    reader.addTag(uidN(0x79), 'NTAG213');
    await issueTag(reader, rec, uidN(0x78));
    await issueTag(reader, rec, uidN(0x79));
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('rows-exhausted');
    expect(ndefText(reader.tags.get(uidN(0x78))!.data)).toBe('good1');
    expect(ndefText(reader.tags.get(uidN(0x79))!.data)).toBe('good2');
  });

  it('stops after several bad rows in a row and rewinds to the first of them', async () => {
    const { rec, engine, reader } = setup();
    const rows = Array.from({ length: 8 }, () => ({ name: 'y'.repeat(300) }));
    engine.start(ndefJob({ kind: 'NTAG213', text: '{{csv:name}}', rows }));
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('error');
    expect(stopped.job?.rowIndex).toBe(0);
    expect(rec.of('error').length).toBeGreaterThan(1);
    expect(rec.of('error').at(-1)?.message).toContain('続けて');
    expect(reader.writes).toHaveLength(0);
  });
});

describe('issue engine: stop and resume (ISSUE-3, ISSUE-7)', () => {
  it('stop carries the job; starting the same job id continues the sequence (even from a stale copy)', async () => {
    const { reader, rec, engine } = setup();
    const job = schemaJob(1, null, 'job-r');
    engine.start(job);
    await issueTag(reader, rec, uidN(0x80));
    await issueTag(reader, rec, uidN(0x81));
    await rec.next('waiting');
    engine.stop();
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('user');
    expect(stopped.issued).toBe(2);
    expect(stopped.job?.id).toBe('job-r');
    expect(stopped.job?.sequence.next).toBe(3);

    engine.start(stopped.job!);
    const c = await issueTag(reader, rec, uidN(0x82));
    expect(c.entry?.seq).toBe(3);
    await rec.next('waiting');
    engine.stop();
    await rec.next('stopped');

    // the UI passes the ORIGINAL job again (next = 1): it still continues at 4
    engine.start(job);
    const d = await issueTag(reader, rec, uidN(0x83));
    expect(d.entry?.seq).toBe(4);
    // `issued` counts THIS run (the UI adds the earlier runs: R-ISSUE-3)
    expect(rec.of('success').at(-1)?.issued).toBe(1);
    engine.stop();
    await rec.next('stopped');
  });

  it('a stopped event says why: template error without CSV rows stops with reason "error" and a message', async () => {
    const { rec, engine, reader } = setup();
    const job = schemaJob(300, null);
    job.template = { type: 'schema', schema: seqSchema(1), inputs: {} }; // 300 does not fit in 1 byte
    engine.start(job);
    const err = await rec.next('error');
    expect(err.message).toContain('社員ID');
    expect(err.message).not.toMatch(RAW_CODE);
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('error');
    expect(stopped.job?.sequence.next).toBe(300);
    expect(reader.writes).toHaveLength(0);
  });

  it('stop during a write lets the write finish (never cuts a tag half-way), then stops', async () => {
    const { reader, rec, engine } = setup();
    reader.writePlan.set(uidN(0x90), [{ delay: 80 }]);
    engine.start(schemaJob(1, null));
    await rec.next('waiting');
    reader.place(uidN(0x90));
    await rec.next('writing');
    const done = engine.stopAndWait(2000);
    const stopped = await rec.next('stopped');
    await done;
    expect(stopped.reason).toBe('user');
    expect(rec.of('success')).toHaveLength(1);
    expect(seqOf(reader.tags.get(uidN(0x90))!.data)).toBe(1);
    expect(stopped.job?.sequence.next).toBe(2);
  });
});

describe('issue engine: duplicates, source tag, swaps', () => {
  it('a UID issued by ANOTHER job (anywhere in the log) is skipped as duplicate', async () => {
    const A = uidN(0xa0);
    const old: IssueLogEntry = { id: 'old', jobId: 'other-job', jobName: 'old', at: 0, uid: A, kind: 'NTAG215', seq: 1, values: {}, result: 'ok', message: null };
    const { reader, rec, engine, log } = setup({ log: [old] });
    engine.start(schemaJob(1, 1, 'new-job'));
    const s = await issueTag(reader, rec, A);
    expect(s.outcome).toBe('skipped');
    expect(rec.of('skipped')[0].reason).toBe('duplicate');
    const b = await issueTag(reader, rec, uidN(0xa1));
    expect(b.entry?.seq).toBe(1);
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0xa1)]);
    expect(log.entries.filter((e) => e.jobId === 'new-job').map((e) => e.result)).toEqual(['skipped', 'ok']);
  });

  it('duplicate mode: the source tag is skipped (reason "source"), never written; others get the image without a full read', async () => {
    const { reader, rec, engine } = setup();
    const SRC = uidN(0xb0);
    const img = factoryImage('NTAG215', hexToBytes(SRC));
    img.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
    const job: IssueJob = {
      ...schemaJob(1, 1),
      template: { type: 'image', kind: 'NTAG215', data: img, units: [4, 5], sourceUid: SRC },
    };
    engine.start(job);
    const s = await issueTag(reader, rec, SRC);
    expect(s.outcome).toBe('skipped');
    expect(rec.of('skipped')[0].reason).toBe('source');
    await issueTag(reader, rec, uidN(0xb1));
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0xb1)]);
    expect(Array.from(reader.tags.get(uidN(0xb1))!.data.subarray(16, 24))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(reader.reads).toHaveLength(0);
  });

  it('a reader unplugged and plugged back in with the issued tag still on it does not re-issue that tag', async () => {
    const { reader, rec, engine } = setup();
    const job = schemaJob(1, null);
    job.options.skipDuplicateUid = false; // the dangerous setting: nothing else would stop a re-issue
    engine.start(job);
    await rec.next('waiting');
    reader.place(uidN(0xc8));
    await rec.next('remove-card');
    reader.unidentified('no-reader'); // USB unplugged
    reader.place(uidN(0xc8)); // plugged back in: same tag, new placement time
    await sleep(60);
    expect(reader.writes).toHaveLength(1);
    reader.remove();
    const b = await issueTag(reader, rec, uidN(0xc9));
    expect(b.entry?.seq).toBe(2);
    engine.stop();
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0xc8), uidN(0xc9)]);
  });

  it('a PC/SC context reset (absent for an instant, then no reader, then the same tag again) does not re-issue that tag', async () => {
    // pcsc/index.ts teardownContext(true): card-removed -> readers [] -> service down,
    // then on recovery card-inserted for the SAME tag that never left the reader.
    const { reader, rec, engine } = setup({ removalSettleMs: 150 });
    const job = schemaJob(1, null);
    job.options.skipDuplicateUid = false; // nothing else would stop a re-issue
    engine.start(job);
    await rec.next('waiting');
    reader.place(uidN(0xca));
    await rec.next('remove-card');
    reader.remove(); // "absent" (service still ok) ...
    reader.unidentified('no-reader'); // ... and at once the reader list is empty
    await sleep(20);
    reader.place(uidN(0xca)); // context back: the same tag is "inserted" again
    await sleep(250);
    expect(reader.writes).toHaveLength(1);
    expect(rec.of('waiting')).toHaveLength(1);
    // A real removal (absent for longer than the settle window) does count.
    reader.remove();
    await rec.next('waiting', 1000);
    reader.place(uidN(0xcb));
    const b = await rec.next('success');
    expect(b.entry.seq).toBe(2);
    await rec.next('remove-card');
    reader.remove();
    engine.stop();
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0xca), uidN(0xcb)]);
  });

  it('a tag placed during the removal settle window is still issued (the cutoff is when "absent" was first seen)', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 150 });
    engine.start(schemaJob(1, 2));
    await rec.next('waiting');
    reader.place(uidN(0xcc));
    await rec.next('remove-card');
    reader.remove();
    await sleep(10);
    reader.place(uidN(0xcd)); // the next tag, well within 150 ms
    const second = await rec.next('success', 1000);
    expect(second.entry.uid).toBe(uidN(0xcd));
    expect(second.entry.seq).toBe(2);
    await rec.next('remove-card');
    reader.remove();
    await rec.next('stopped', 1000);
  });

  it('a tag swapped for another without an "absent" in between is still issued (ISSUE-14)', async () => {
    const { reader, rec, engine } = setup();
    engine.start(schemaJob(1, 2));
    await rec.next('waiting');
    reader.place(uidN(0xc0));
    await rec.next('remove-card');
    reader.swap(uidN(0xc1));
    const second = await rec.next('success');
    expect(second.entry.uid).toBe(uidN(0xc1));
    expect(second.entry.seq).toBe(2);
    await rec.next('remove-card');
    reader.remove();
    await rec.next('stopped');
  });
});

describe('issue engine: request shape and wording', () => {
  it('always verifies on a storage reader (PaSoRi acknowledges locked pages it did not write) and lets the service choose MIFARE keys', async () => {
    const { reader, rec, engine } = setup();
    reader.driver = 'storage';
    const job = schemaJob(1, 1);
    job.options.verify = false;
    engine.start(job);
    await issueTag(reader, rec, uidN(0xd0));
    await rec.next('stopped');
    expect(reader.writes[0].req.verify).toBe(true);
    expect(reader.writes[0].req.mifareKeyIds).toBeUndefined();
    expect(reader.reads[0].opts.mifareKeyIds).toBeUndefined();
  });

  it('English UI: results are English sentences, never raw codes', async () => {
    const A = uidN(0xe0);
    const old: IssueLogEntry = { id: 'old', jobId: 'x', jobName: 'x', at: 0, uid: A, kind: 'NTAG215', seq: 1, values: {}, result: 'ok', message: null };
    const { reader, rec, engine } = setup({ log: [old], lang: 'en' });
    reader.readFail.set(uidN(0xe1), [new OpError('CARD_REMOVED')]);
    engine.start(schemaJob(1, null));
    const s = await issueTag(reader, rec, A);
    const e = await issueTag(reader, rec, uidN(0xe1));
    engine.stop();
    await rec.next('stopped');
    for (const m of [s.message, e.message]) {
      expect(m).toBeTruthy();
      expect(m).not.toMatch(JAPANESE);
      expect(m).not.toMatch(RAW_CODE);
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-11-12 adversarial review, round 2 (R-MAIN-1, R-ISSUE-1..5, 7, 8, 13)
// ---------------------------------------------------------------------------

describe('issue engine: a writeTag rejection never makes a tag "half-written" (R-MAIN-1)', () => {
  it('CARD_UNRESPONSIVE / WRITE_FAILED / READ_FAILED / ACCESS_DENIED / INTERNAL / READER_NO_AUTH: nothing reserved, no 欠番, the next tag gets the same number', async () => {
    const { reader, rec, engine, log } = setup();
    const codes = ['CARD_UNRESPONSIVE', 'WRITE_FAILED', 'READ_FAILED', 'ACCESS_DENIED', 'INTERNAL', 'READER_NO_AUTH'] as const;
    engine.start(schemaJob(1000, null));
    for (const [i, code] of codes.entries()) {
      const uid = uidN(0x01 + i);
      reader.writePlan.set(uid, [{ reject: new OpError(code) }]);
      await rec.next('waiting');
      reader.place(uid);
      const err = await rec.next('error');
      expect(err.partial, code).toBe(false);
      expect(err.message, code).toContain('書き込んでいません');
      expect(err.message, code).not.toContain('途中まで');
      expect(err.message, code).not.toMatch(RAW_CODE);
      expect(err.entry?.seq, code).toBeNull();
      await rec.next('remove-card');
      reader.remove();
    }
    const ok = await issueTag(reader, rec, uidN(0x0f));
    expect(ok.entry?.seq).toBe(1000);
    engine.stop();
    const stopped = await rec.next('stopped');
    expect(stopped.job?.sequence.next).toBe(1001);
    expect(log.entries.filter((e) => e.result === 'skipped')).toEqual([]);
  });

  it('a rejection that is not an OpError (a bug, not the contract) is treated as "may have written": the number is reserved', async () => {
    const { reader, rec, engine } = setup();
    const A = uidN(0x10);
    reader.writePlan.set(A, [{ reject: new Error('boom') as unknown as OpError }]);
    engine.start(schemaJob(5, null));
    await rec.next('waiting');
    reader.place(A);
    const err = await rec.next('error');
    expect(err.partial).toBe(true);
    expect(err.message).toContain('No.5');
    await rec.next('remove-card');
    reader.remove();
    const again = await issueTag(reader, rec, A);
    expect(again.entry?.seq).toBe(5);
    engine.stop();
    await rec.next('stopped');
  });

  it('a rejection every tag would hit (UID / protected area in the data) stops the run with the reason', async () => {
    const { reader, rec, engine } = setup();
    reader.writePlan.set(uidN(0x18), [{ reject: new OpError('FORBIDDEN_UNIT') }]);
    engine.start(schemaJob(1, null));
    await rec.next('waiting');
    reader.place(uidN(0x18));
    const err = await rec.next('error');
    expect(err.partial).toBe(false);
    expect(err.message).toContain('発行を止めました');
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('error');
    expect(stopped.job?.sequence.next).toBe(1);
  });
});

describe('issue engine: the tag on the reader at start is never written (R-ISSUE-1, R-ISSUE-13)', () => {
  it('the reader / PC/SC context goes away and comes back with the same tag: still "take it off first"', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 400 });
    const X = uidN(0x30);
    reader.place(X);
    engine.start(schemaJob(1, null));
    await rec.next('clear-reader');
    reader.remove(); // teardown: card-removed ...
    reader.unidentified('no-reader'); // ... readers []
    await sleep(30);
    reader.place(X); // back: the SAME tag that never left
    await sleep(150);
    expect(reader.writes).toHaveLength(0);
    expect(rec.of('waiting')).toHaveLength(0);
    // a real removal (absent for the whole settle window) ends it
    reader.remove();
    await rec.next('waiting', 2000);
    reader.place(uidN(0x31));
    const s = await rec.next('success');
    expect(s.entry.uid).toBe(uidN(0x31));
    await rec.next('remove-card');
    reader.remove();
    engine.stop();
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0x31)]);
  });

  it('a short drop-out of the start tag (one poll) does not count as taking it off', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 400 });
    const X = uidN(0x32);
    reader.place(X);
    engine.start(schemaJob(1, null));
    await rec.next('clear-reader');
    reader.remove();
    await sleep(100);
    reader.unidentified('detecting'); // PC/SC sees a card again, identification running
    await sleep(500); // longer than the settle window in total: the absence itself was short
    reader.place(X);
    await sleep(150);
    expect(reader.writes).toHaveLength(0);
    expect(rec.of('waiting')).toHaveLength(0);
    engine.stop();
    await rec.next('stopped');
  });

  it('a start tag not identified yet: clear-reader is sent again with its UID once known (no empty "UID")', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 400 });
    reader.unidentified('detecting');
    engine.start(schemaJob(1, null));
    const first = await rec.next('clear-reader');
    expect(first.uid).toBe('');
    reader.place(uidN(0x33));
    const second = await rec.next('clear-reader');
    expect(second.uid).toBe(uidN(0x33));
    // a drop-out + the same tag again is still that tag
    reader.remove();
    await sleep(80);
    reader.place(uidN(0x33));
    await sleep(150);
    expect(reader.writes).toHaveLength(0);
    expect(rec.of('waiting')).toHaveLength(0);
    engine.stop();
    await rec.next('stopped');
  });

  it('started while the reader was away: a tag already on it when it comes back is cleared, not written', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 0 });
    reader.unidentified('no-reader');
    engine.start(schemaJob(1, null));
    await sleep(30);
    reader.place(uidN(0x34)); // the reader reappears with a tag on it
    const clear = await rec.next('clear-reader');
    expect(clear.uid).toBe(uidN(0x34));
    await sleep(40);
    expect(reader.writes).toHaveLength(0);
    reader.remove();
    await issueTag(reader, rec, uidN(0x35));
    engine.stop();
    await rec.next('stopped');
    expect(reader.writes.map((w) => w.uid)).toEqual([uidN(0x35)]);
  });
});

describe('issue engine: the removal settle window also holds when the same tag is detected again (R-ISSUE-2)', () => {
  it('a 100 ms drop-out of an issued tag (absent -> detecting -> same UID) gets no new number (skipDuplicateUid off)', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 400 });
    const job = schemaJob(1, null);
    job.options.skipDuplicateUid = false; // nothing else would stop a re-issue
    engine.start(job);
    await rec.next('waiting');
    const T = uidN(0x40);
    reader.place(T);
    await rec.next('remove-card');
    reader.remove();
    await sleep(100);
    reader.unidentified('detecting'); // re-detected within one poll ...
    await sleep(60);
    reader.place(T); // ... and identified: the same tag
    await sleep(500);
    expect(reader.writes.map((w) => w.uid)).toEqual([T]);
    expect(rec.of('waiting')).toHaveLength(1);
    // a different tag after a short drop-out is a new tag (quick swap)
    reader.remove();
    await sleep(50);
    reader.place(uidN(0x41));
    const s = await rec.next('success', 2000);
    expect(s.entry.uid).toBe(uidN(0x41));
    expect(s.entry.seq).toBe(2);
    await rec.next('remove-card');
    reader.remove();
    engine.stop();
    await rec.next('stopped');
  });

  it('with skipDuplicateUid on, the tag that never left is not reported as "already issued"', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 400 });
    engine.start(schemaJob(1, null));
    await rec.next('waiting');
    const T = uidN(0x42);
    reader.place(T);
    await rec.next('remove-card');
    reader.remove();
    await sleep(100);
    reader.unidentified('detecting');
    await sleep(30);
    reader.place(T);
    await sleep(500);
    expect(rec.of('skipped')).toHaveLength(0);
    expect(rec.of('reading')).toHaveLength(1);
    engine.stop();
    await rec.next('stopped');
  });

  it('a short drop-out followed by a tag that stays unidentified is not a removal', async () => {
    const { reader, rec, engine } = setup({ removalSettleMs: 300 });
    engine.start(schemaJob(1, null));
    await rec.next('waiting');
    reader.place(uidN(0x43));
    await rec.next('remove-card');
    reader.remove();
    await sleep(60);
    reader.unidentified('error');
    await sleep(600);
    expect(rec.of('waiting')).toHaveLength(1);
    engine.stop();
    await rec.next('stopped');
  });
});

describe('issue engine: resume counts THIS run against the limit (R-ISSUE-3, engine + resumePlan as IssueView wires them)', () => {
  it('a: "resume" after the run hit its limit issues the next batch (not 0)', async () => {
    const { reader, rec, engine } = setup();
    engine.start(schemaJob(1, 2, 'J'));
    await issueTag(reader, rec, uidN(0x50));
    await issueTag(reader, rec, uidN(0x51));
    const stopped = await rec.next('stopped');
    expect(stopped.reason).toBe('limit');
    expect(stopped.issued).toBe(2);
    const plan = resumePlan({ reason: stopped.reason, issued: stopped.issued, job: stopped.job }, { carried: 0, limit: 2, rowCount: null })!;
    engine.start({ ...stopped.job!, id: plan.id, sequence: { ...stopped.job!.sequence, next: plan.next }, limit: plan.limit });
    const c = await issueTag(reader, rec, uidN(0x52));
    const d = await issueTag(reader, rec, uidN(0x53));
    const again = await rec.next('stopped');
    expect([c.entry?.seq, d.entry?.seq]).toEqual([3, 4]);
    expect(again.reason).toBe('limit');
    expect(again.issued).toBe(2);
    const plan2 = resumePlan({ reason: again.reason, issued: again.issued, job: again.job }, { carried: plan.issuedTotal, limit: 2, rowCount: null })!;
    expect(plan2.issuedTotal).toBe(4);
    expect(reader.writes).toHaveLength(4);
  });

  it('b: stopped after 2 of 5, "resume" issues the remaining 3', async () => {
    const { reader, rec, engine } = setup();
    engine.start(schemaJob(1, 5, 'J'));
    await issueTag(reader, rec, uidN(0x58));
    await issueTag(reader, rec, uidN(0x59));
    await rec.next('waiting');
    engine.stop();
    const stopped = await rec.next('stopped');
    const plan = resumePlan({ reason: stopped.reason, issued: stopped.issued, job: stopped.job }, { carried: 0, limit: 5, rowCount: null })!;
    expect(plan.limit).toBe(3);
    engine.start({ ...stopped.job!, id: plan.id, sequence: { ...stopped.job!.sequence, next: plan.next }, limit: plan.limit });
    for (const n of [0x5a, 0x5b, 0x5c]) await issueTag(reader, rec, uidN(n));
    const second = await rec.next('stopped');
    expect(second.reason).toBe('limit');
    expect(second.issued).toBe(3);
    expect(rec.of('success')).toHaveLength(5);
    expect(rec.of('success').map((e) => e.entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

function memoryRunStore(initial: SavedIssueRun | null = null) {
  const saved: SavedIssueRun[] = [];
  let current = initial;
  const store: IssueRunPersistence = {
    get: () => current,
    save(run) {
      current = JSON.parse(JSON.stringify(run)) as SavedIssueRun; // what reaches the disk
      saved.push(current);
    },
  };
  return {
    store,
    saved,
    get current() {
      return current;
    },
  };
}

describe('issue engine: the last run survives an app restart (R-ISSUE-4)', () => {
  it('a restarted app offers "resume" from where it stopped, and the resumed job never reuses a number', async () => {
    const mem = memoryRunStore();
    const day1 = setup({ runStore: mem.store });
    const job = schemaJob(1, null, 'job-day1');
    day1.engine.start(job);
    await issueTag(day1.reader, day1.rec, uidN(0x60));
    await issueTag(day1.reader, day1.rec, uidN(0x61));
    await day1.rec.next('waiting');
    await day1.engine.stopAndWait();
    expect(mem.current?.job.sequence.next).toBe(3);
    expect(mem.current?.total).toBe(2);

    // day 2: a new engine (new process), the same log and the same saved file
    const day2 = setup({ runStore: mem.store, fakeLog: day1.log });
    const st = day2.engine.getState();
    expect(st.running).toBe(false);
    expect(st.last?.type).toBe('stopped');
    if (st.last?.type !== 'stopped') return;
    expect(st.last.job?.id).toBe('job-day1');
    expect(st.last.job?.sequence.next).toBe(3);
    expect(st.last.issued).toBe(2); // the job's total (the UI remembers no earlier runs after a restart)
    const plan = resumePlan({ reason: st.last.reason, issued: st.last.issued, job: st.last.job }, { carried: 0, limit: null, rowCount: null })!;
    expect(plan.next).toBe(3);
    // the UI sends a stale copy (next 1): the engine still continues at 3
    day2.engine.start({ ...job, id: plan.id });
    const c = await issueTag(day2.reader, day2.rec, uidN(0x62));
    expect(c.entry?.seq).toBe(3);
    day2.engine.stop();
    await day2.rec.next('stopped');
  });

  it('a resumed job id continues after the highest number in the log, even without the saved file', async () => {
    const used: IssueLogEntry[] = [1, 2, 3].map((n) => ({
      id: `o${n}`,
      jobId: 'job-x',
      jobName: 'x',
      at: 0,
      uid: uidN(0x68 + n),
      kind: 'NTAG215',
      seq: n,
      values: {},
      result: 'ok',
      message: null,
    }));
    used.push({ id: 'o4', jobId: 'job-x', jobName: 'x', at: 0, uid: uidN(0x6f), kind: 'NTAG215', seq: 4, values: {}, result: 'error', message: 'half' });
    const { reader, rec, engine } = setup({ log: used });
    engine.start(schemaJob(1, null, 'job-x'));
    const r = await issueTag(reader, rec, uidN(0x70));
    expect(r.entry?.seq).toBe(5);
    engine.stop();
    await rec.next('stopped');
  });

  it('the saved summary holds no password, no CSV rows, no NDEF records (I4)', async () => {
    const mem = memoryRunStore();
    const { reader, rec, engine } = setup({ runStore: mem.store });
    const job = ndefJob({ kind: 'NTAG213', text: '{{csv:name}} {{seq}}', rows: [{ name: 'alice' }, { name: 'bob' }] });
    job.options.ntagProtect = { password: 'A1B2C3D4', pack: 'E5F6', protectRead: false };
    reader.addTag(uidN(0x71), 'NTAG213');
    engine.start(job);
    await issueTag(reader, rec, uidN(0x71));
    await rec.next('waiting');
    await engine.stopAndWait();
    const text = JSON.stringify(mem.saved);
    expect(mem.saved.length).toBeGreaterThan(0);
    for (const secret of ['A1B2C3D4', 'E5F6', 'alice', 'bob', 'csv:name']) expect(text).not.toContain(secret);
    expect(mem.current?.job.rows).toEqual([]); // "this job needs a CSV"
    expect(mem.current?.rowCount).toBe(2);
    expect(mem.current?.job.rowIndex).toBe(1);
    expect(mem.current?.job.options.ntagProtect).toBeNull();
  });
});

describe('issue engine: a retired number is visible and keeps what the tag held (R-ISSUE-5)', () => {
  it("CSV: A half-written, B takes the row -> the 欠番 record keeps A's row values and B's result says A must not be used", async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x78);
    const B = uidN(0x79);
    reader.writePlan.set(A, ['mismatch']);
    engine.start(ndefJob({ text: '{{csv:name}}', rows: [{ name: 'alice' }, { name: 'bob' }] }));
    await rec.next('waiting');
    reader.place(A);
    const errA = await rec.next('error');
    expect(errA.partial).toBe(true);
    await rec.next('remove-card');
    reader.remove();
    const b = await issueTag(reader, rec, B);
    expect(b.outcome).toBe('ok');
    expect(ndefText(reader.tags.get(B)!.data)).toBe('alice'); // the row goes to the usable tag
    const voided = log.entries.find((e) => e.uid === A && e.result === 'skipped');
    expect(voided?.values.name).toBe('alice');
    expect(b.message).toContain('04:A1:B2:C3:D4:E5:78');
    expect(b.message).toContain('使わないでください');
    engine.stop();
    await rec.next('stopped');
  });
});

describe('issue engine: stop and retire timing (R-ISSUE-7, R-ISSUE-8)', () => {
  it('no write starts after stop was pressed, also while a reserved number is being dealt with', async () => {
    const log = fakeLog([], (e) => (e.result === 'skipped' ? 150 : 0)); // a slow "欠番" write
    const { reader, rec, engine } = setup({ fakeLog: log });
    const A = uidN(0x80);
    const B = uidN(0x81);
    reader.writePlan.set(A, ['mismatch']);
    engine.start(schemaJob(10, null));
    await rec.next('waiting');
    reader.place(A);
    await rec.next('remove-card');
    reader.remove();
    await rec.next('waiting');
    reader.place(B);
    await rec.next('reading');
    await sleep(30); // B is being handled (the old engine was writing A's 欠番 record here)
    const stopAt = Date.now();
    engine.stop();
    const stopped = await rec.next('stopped', 3000);
    expect(reader.writes.filter((w) => w.at >= stopAt)).toEqual([]);
    expect(stopped.reason).toBe('user');
  });

  it('stop pressed while the next tag is being read: that tag is not written', async () => {
    const { reader, rec, engine } = setup();
    reader.readDelayMs = 80;
    engine.start(schemaJob(10, null));
    await rec.next('waiting');
    reader.place(uidN(0x82));
    await rec.next('reading');
    await sleep(20);
    engine.stop();
    await rec.next('stopped', 3000);
    expect(reader.writes).toEqual([]);
  });

  it('B fails before writing: A keeps its number (no 欠番), A placed again is rewritten with it, B later gets the next', async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x88);
    const B = uidN(0x89);
    reader.writePlan.set(A, ['mismatch']);
    reader.writePlan.set(B, [{ reject: new OpError('UID_MISMATCH') }]);
    engine.start(schemaJob(10, null));
    await rec.next('waiting');
    reader.place(A);
    await rec.next('remove-card');
    reader.remove();
    const bErr = await issueTag(reader, rec, B); // nothing written to B
    expect(bErr.outcome).toBe('error');
    expect(log.entries.some((e) => e.result === 'skipped')).toBe(false);
    const a2 = await issueTag(reader, rec, A);
    expect(a2.outcome).toBe('ok');
    expect(a2.entry?.seq).toBe(10);
    const b2 = await issueTag(reader, rec, B);
    expect(b2.entry?.seq).toBe(11);
    engine.stop();
    await rec.next('stopped');
    expect(log.entries.map((e) => `${e.uid.slice(-2)}:${e.seq}:${e.result}`)).toEqual(['88:10:error', '89:null:error', '88:10:ok', '89:11:ok']);
  });

  it("B half-written too: A's number is retired then, B keeps the next number for itself", async () => {
    const { reader, rec, engine, log } = setup();
    const A = uidN(0x8a);
    const B = uidN(0x8b);
    reader.writePlan.set(A, ['mismatch']);
    reader.writePlan.set(B, ['mismatch']); // all written, read-back differs = half-written
    engine.start(schemaJob(10, null));
    await rec.next('waiting');
    reader.place(A);
    await rec.next('remove-card');
    reader.remove();
    await rec.next('waiting');
    reader.place(B);
    const errB = await rec.next('error');
    expect(errB.partial).toBe(true);
    expect(errB.message).toContain('No.11');
    const rmB = await rec.next('remove-card');
    expect(rmB.message).toContain('No.10');
    reader.remove();
    const b2 = await issueTag(reader, rec, B);
    expect(b2.entry?.seq).toBe(11);
    engine.stop();
    await rec.next('stopped');
    expect(log.entries.map((e) => `${e.uid.slice(-2)}:${e.seq}:${e.result}`)).toEqual(['8A:10:error', '8A:10:skipped', '8B:11:error', '8B:11:ok']);
  });
});
