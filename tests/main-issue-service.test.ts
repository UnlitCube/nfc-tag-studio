// The issue engine on the REAL NfcService with the virtual reader (no PC/SC is
// started: the dev PC's real readers / tokens never get an APDU). The reader
// timing is the app's: identification settle, PC/SC-like card-removed /
// card-inserted on a drop-out, and the default 400 ms removal settle window.
// 2026-11-12 adversarial review, round 2: R-MAIN-1, R-ISSUE-1, R-ISSUE-2,
// R-WRITE-2 (the engine side of the NTAG password verify).
import { afterEach, describe, expect, it } from 'vitest';
import type { IssueEvent, IssueJob, IssueLogEntry, ReaderStatus } from '../src/shared/types';
import { SCHEMA_FORMAT, SCHEMA_VERSION } from '../src/shared/schema/types';
import type { DataSchema } from '../src/shared/schema/types';
import { ntagPages, type TagKind } from '../src/shared/tags';
import { bytesToHex, bytesToUintBE } from '../src/shared/hex';
import { VIRTUAL_READER_NAME } from '../src/shared/reader';
import { createIssueEngine, type IssueEngine } from '../src/main/issue/engine';
import { createNfcService } from '../src/main/nfc/service';
import { createSimulatorBackend, SimulatorBackend } from '../src/main/nfc/simulator';
import type { CardConnection } from '../src/main/nfc/backend';
import type { NfcService, NfcServiceDeps } from '../src/main/nfc/contract';
import { OpError } from '../src/main/errors';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deps(): NfcServiceDeps {
  return { resolveKeys: () => [], allKeyIds: () => [], log() {}, isAdvancedMode: () => true };
}

function memLog() {
  const entries: IssueLogEntry[] = [];
  return {
    entries,
    async append(e: IssueLogEntry) {
      entries.push(e);
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

class Events {
  list: IssueEvent[] = [];
  private cursor = 0;
  onEmit: ((e: IssueEvent) => void) | null = null;
  emit = (e: IssueEvent): void => {
    this.list.push(structuredClone(e));
    this.onEmit?.(e);
  };
  async next<T extends IssueEvent['type']>(type: T, ms = 5000): Promise<Extract<IssueEvent, { type: T }>> {
    const t0 = Date.now();
    for (;;) {
      for (let i = this.cursor; i < this.list.length; i++) {
        if (this.list[i].type === type) {
          this.cursor = i + 1;
          return this.list[i] as Extract<IssueEvent, { type: T }>;
        }
      }
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for "${type}"; events: ${this.list.map((e) => e.type).join(', ')}`);
      await sleep(5);
    }
  }
  of<T extends IssueEvent['type']>(type: T): Extract<IssueEvent, { type: T }>[] {
    return this.list.filter((e) => e.type === type) as Extract<IssueEvent, { type: T }>[];
  }
}

function statusWhere(svc: NfcService, pred: (s: ReaderStatus) => boolean, ms = 3000): Promise<ReaderStatus> {
  return new Promise((resolve, reject) => {
    const now = svc.getStatus();
    if (pred(now)) return resolve(now);
    const t = setTimeout(() => {
      off();
      reject(new Error(`status never matched (cardState ${svc.getStatus().cardState})`));
    }, ms);
    const off = svc.onStatus((s) => {
      if (!pred(s)) return;
      clearTimeout(t);
      off();
      resolve(s);
    });
  });
}

function seqSchema(kind: TagKind): DataSchema {
  return {
    format: SCHEMA_FORMAT,
    version: SCHEMA_VERSION,
    id: 'emp',
    name: '社員ID',
    description: '',
    tagKinds: [kind],
    area: { mode: 'raw', startUnit: 4 },
    size: 4,
    fields: [{ id: 'emp', label: '社員ID', type: 'uint', offset: 0, length: 4, source: { kind: 'sequence', offset: 0 }, endian: 'be' }],
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  };
}

function job(start: number, opts: { kind?: TagKind; skipDuplicateUid?: boolean; ntagProtect?: IssueJob['options']['ntagProtect'] } = {}): IssueJob {
  const kind = opts.kind ?? 'NTAG215';
  return {
    id: 'job-svc',
    name: 'svc',
    kind,
    template: { type: 'schema', schema: seqSchema(kind), inputs: {} },
    sequence: { start, step: 1, next: start },
    rows: null,
    rowIndex: 0,
    options: {
      verify: true,
      skipDuplicateUid: opts.skipDuplicateUid ?? true,
      requireBlank: false,
      ntagProtect: opts.ntagProtect ?? null,
      mifareKeyIds: [],
      sound: false,
    },
    limit: null,
  };
}

let svc: NfcService | null = null;
let engine: IssueEngine | null = null;
const restore: (() => void)[] = [];

function makeEngine(s: NfcService, ev: Events, log = memLog()): IssueEngine {
  let n = 0;
  // Default removal settle window (400 ms): exactly what the app uses.
  engine = createIssueEngine({ nfc: s, log, emit: ev.emit, newId: () => `id${++n}`, now: () => new Date(), lang: () => 'ja' });
  return engine;
}

afterEach(async () => {
  await engine?.stopAndWait(3000);
  engine = null;
  await svc?.dispose();
  svc = null;
  while (restore.length) restore.pop()!();
});

describe('real service: the tag on the reader at start is never written (R-ISSUE-1)', () => {
  it('a 10 ms drop-out of the start tag does not end "take it off first"', async () => {
    svc = createNfcService(deps(), { pcsc: false });
    await svc.simulatorNewTag('NTAG215');
    const X = (await statusWhere(svc, (s) => s.cardState === 'ready')).card!.uid;
    const ev = new Events();
    makeEngine(svc, ev).start(job(1));
    const clear = await ev.next('clear-reader');
    expect(clear.uid).toBe(X);
    await svc.simulatorTap(false);
    await sleep(10);
    await svc.simulatorTap(true);
    await sleep(1200); // identification + well past the settle window
    expect(ev.of('waiting')).toHaveLength(0);
    expect(ev.of('success')).toHaveLength(0);
    // Taking it off for real starts the run; a new tag is issued.
    await svc.simulatorTap(false);
    await ev.next('waiting', 3000);
    await svc.simulatorNewTag('NTAG215');
    const s = await ev.next('success', 5000);
    expect(s.entry.uid).not.toBe(X);
    expect(s.entry.seq).toBe(1);
  }, 20_000);

  it('the virtual reader switched off and on again (reader gone in between) with the same tag: not written', async () => {
    svc = createNfcService(deps(), { pcsc: false });
    await svc.simulatorNewTag('NTAG215');
    const X = (await statusWhere(svc, (s) => s.cardState === 'ready')).card!.uid;
    const ev = new Events();
    makeEngine(svc, ev).start(job(1));
    await ev.next('clear-reader');
    await svc.setSimulator({ enabled: false });
    await sleep(30);
    await svc.setSimulator({ enabled: true, kind: 'NTAG215' });
    if (!svc.getStatus().simulator.present) await svc.simulatorTap(true);
    await statusWhere(svc, (s) => s.cardState === 'ready' && s.card?.uid === X);
    await sleep(800);
    expect(ev.of('success')).toHaveLength(0);
    expect(ev.of('waiting')).toHaveLength(0);
  }, 20_000);
});

describe('real service: a drop-out of an issued tag shorter than the settle window (R-ISSUE-2)', () => {
  it('skipDuplicateUid off: the same tag back after 100 ms gets no second number', async () => {
    svc = createNfcService(deps(), { pcsc: false });
    await svc.setSimulator({ enabled: true, kind: 'NTAG215' });
    const ev = new Events();
    makeEngine(svc, ev).start(job(1, { skipDuplicateUid: false }));
    await ev.next('waiting');
    await svc.simulatorTap(true);
    const first = await ev.next('success', 5000);
    await ev.next('remove-card');
    await svc.simulatorTap(false);
    await sleep(100);
    await svc.simulatorTap(true);
    await sleep(1200);
    expect(ev.of('success')).toHaveLength(1);
    expect(ev.of('waiting')).toHaveLength(1);
    // A real removal, then the next tag: No.2.
    await svc.simulatorTap(false);
    await ev.next('waiting', 3000);
    await svc.simulatorNewTag('NTAG215');
    const second = await ev.next('success', 5000);
    expect(second.entry.uid).not.toBe(first.entry.uid);
    expect(second.entry.seq).toBe(2);
  }, 20_000);

  it('skipDuplicateUid on: the tag that never left is not reported as "already issued"', async () => {
    svc = createNfcService(deps(), { pcsc: false });
    await svc.setSimulator({ enabled: true, kind: 'NTAG215' });
    const ev = new Events();
    makeEngine(svc, ev).start(job(1));
    await ev.next('waiting');
    await svc.simulatorTap(true);
    await ev.next('success', 5000);
    await ev.next('remove-card');
    await svc.simulatorTap(false);
    await sleep(100);
    await svc.simulatorTap(true);
    await sleep(1200);
    expect(ev.of('skipped')).toHaveLength(0);
  }, 20_000);
});

/** Make the virtual reader's connect() fail ONCE (armed by the test), like SCardConnect on a badly placed tag. */
function failNextConnect(code: 'CARD_UNRESPONSIVE'): { arm(): void } {
  let armed = false;
  const orig = SimulatorBackend.prototype.connect;
  SimulatorBackend.prototype.connect = async function (this: SimulatorBackend, name: string): Promise<CardConnection> {
    if (armed) {
      armed = false;
      throw new OpError(code, 'SCARD_W_UNRESPONSIVE_CARD');
    }
    return orig.call(this, name);
  };
  restore.push(() => {
    SimulatorBackend.prototype.connect = orig;
  });
  return {
    arm() {
      armed = true;
    },
  };
}

describe('real service: writeTag rejects only before writing; the engine does not call that "half-written" (R-MAIN-1)', () => {
  it('the service: a connect failure rejects and the tag is untouched', async () => {
    svc = createNfcService(deps(), { pcsc: false });
    await svc.simulatorNewTag('NTAG215');
    await statusWhere(svc, (s) => s.cardState === 'ready');
    const before = await svc.readTag({});
    const ctl = failNextConnect('CARD_UNRESPONSIVE');
    ctl.arm();
    await expect(
      svc.writeTag({ kind: 'NTAG215', expectedUid: before.uid, writes: [{ unit: 4, data: Uint8Array.of(1, 2, 3, 4) }], allowProtected: false, verify: true }),
    ).rejects.toBeInstanceOf(OpError);
    const after = await svc.readTag({});
    expect(bytesToHex(after.data)).toBe(bytesToHex(before.data));
  }, 20_000);

  it('the engine on the service: an untouched tag is "not written" (no number reserved / retired); the same tag again gets the same number', async () => {
    svc = createNfcService(deps(), { pcsc: false });
    await svc.setSimulator({ enabled: true, kind: 'NTAG215' });
    const ctl = failNextConnect('CARD_UNRESPONSIVE');
    const ev = new Events();
    const log = memLog();
    let armedOnce = false;
    ev.onEmit = (e) => {
      if (e.type === 'writing' && !armedOnce) {
        armedOnce = true;
        ctl.arm(); // the write's own connect fails
      }
    };
    makeEngine(svc, ev, log).start(job(1000));
    await ev.next('waiting');
    await svc.simulatorTap(true);
    const err = await ev.next('error', 5000);
    expect(err.partial).toBe(false);
    expect(err.message).toContain('書き込んでいません');
    await ev.next('remove-card');
    await svc.simulatorTap(false);
    await ev.next('waiting', 3000);
    await svc.simulatorTap(true); // the same tag, placed again
    const ok = await ev.next('success', 5000);
    expect(ok.entry.seq).toBe(1000);
    expect(log.entries.filter((e) => e.result === 'skipped')).toEqual([]);
  }, 20_000);
});

/**
 * Real NTAG21x always read PWD and PACK back as 00 (NXP datasheet; tags.ts says so
 * too). Make the virtual tag do the same when it does not already, so the verify
 * after a password setup is checked the way the hardware answers.
 */
async function hardwareLikePwdPack(): Promise<void> {
  const sim = createSimulatorBackend();
  sim.setEnabled(true, 'NTAG213');
  sim.tap(true);
  const conn = await sim.connect(VIRTUAL_READER_NAME);
  const p = ntagPages('NTAG213');
  await conn.transmit(Uint8Array.of(0xff, 0xd6, 0x00, p.pwd, 0x04, 0x12, 0x34, 0x56, 0x78));
  const back = await conn.transmit(Uint8Array.of(0xff, 0xb0, 0x00, p.pwd, 0x10));
  const proto = Object.getPrototypeOf(conn) as Record<string, unknown>;
  await conn.disconnect();
  const sw = back.length >= 2 ? (back[back.length - 2] << 8) | back[back.length - 1] : 0;
  if (sw === 0x9000 && back[0] === 0 && back[1] === 0 && back[2] === 0 && back[3] === 0) return; // already like the hardware
  const readWrap = proto.readWrap as ((tag: { kind: TagKind; image: Uint8Array }, off: number, len: number) => Uint8Array) | undefined;
  if (typeof readWrap !== 'function') throw new Error('test hook: the simulator returns PWD as written and has no readWrap to mask - update hardwareLikePwdPack()');
  proto.readWrap = function (this: unknown, tag: { kind: TagKind; image: Uint8Array }, off: number, len: number): Uint8Array {
    const out = readWrap.call(this, tag, off, len);
    if (tag.kind.startsWith('NTAG')) {
      const pages = ntagPages(tag.kind);
      for (let i = 0; i < len; i++) {
        const page = Math.floor(((off + i) % tag.image.length) / 4);
        if (page === pages.pwd || page === pages.pack) out[i] = 0;
      }
    }
    return out;
  };
  restore.push(() => {
    proto.readWrap = readWrap;
  });
}

describe('real service: issuing with NTAG password protection succeeds on a tag that reads PWD/PACK as 00 (R-WRITE-2)', () => {
  it('the protected tag is issued (not "half-written / verify failed"), and the password pages were written', async () => {
    await hardwareLikePwdPack();
    svc = createNfcService(deps(), { pcsc: false });
    await svc.setSimulator({ enabled: true, kind: 'NTAG213' });
    const ev = new Events();
    makeEngine(svc, ev).start(job(42, { kind: 'NTAG213', ntagProtect: { password: '12345678', pack: 'ABCD', protectRead: false } }));
    await ev.next('waiting');
    await svc.simulatorTap(true);
    const outcome = await ev.next('remove-card', 5000);
    expect(outcome.message).toBeNull();
    expect(outcome.outcome).toBe('ok');
    expect(outcome.entry?.seq).toBe(42);
    expect(ev.of('error')).toEqual([]);
    await engine!.stopAndWait(3000);
    // Write protection only (protectRead false): still readable; the data and AUTH0 = 4 are on the tag.
    const img = await svc.readTag({});
    expect(Number(bytesToUintBE(img.data.subarray(16, 20)))).toBe(42);
    expect(img.data[ntagPages('NTAG213').cfg0 * 4 + 3]).toBe(4);
  }, 20_000);
});
