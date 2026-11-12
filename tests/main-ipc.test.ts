// IPC handlers (src/main/ipc.ts) with Electron mocked: envelopes, the
// advanced-mode refusals (ADVANCED_REQUIRED, audit FIRST-9), the MIFARE default
// key set (empty list -> the service's default, audit WRITE-3 / FLOW-2),
// reidentify, and BUSY while issuing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Envelope } from '../src/shared/api';
import { INVOKE_CHANNELS } from '../src/shared/api';
import type { IssueJob, ReadOptions, WriteRequest } from '../src/shared/types';

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>) => handlers.set(ch, fn),
    removeHandler: (ch: string) => handlers.delete(ch),
  },
  app: { getName: () => 'NFC Tag Studio', getVersion: () => '0.0.0' },
  shell: { openExternal: async () => {} },
  BrowserWindow: class {},
}));

const { registerIpc } = await import('../src/main/ipc');

function makeDeps(opts: { advanced?: boolean; issuing?: boolean } = {}) {
  const calls = { read: [] as ReadOptions[], write: [] as WriteRequest[], reidentify: 0, apdu: 0, clear: 0, started: [] as IssueJob[] };
  const nfc = {
    readTag: async (o: ReadOptions) => {
      calls.read.push(o);
      return { kind: 'NTAG215', uid: '04', data: new Uint8Array(0), unitStatus: [], readAt: 0 };
    },
    writeTag: async (r: WriteRequest) => {
      calls.write.push(r);
      return { uid: '04', written: [], failed: [], verified: null, mismatched: [], aborted: null, notAttempted: [] };
    },
    reidentify: async () => {
      calls.reidentify += 1;
    },
    transmitApdu: async () => {
      calls.apdu += 1;
      return Uint8Array.of(0x90, 0x00);
    },
  };
  const deps = {
    getWindow: () => null,
    nfc,
    settings: { get: () => ({ language: 'ja' }) },
    keys: {},
    issueLog: {
      clear: async () => {
        calls.clear += 1;
      },
    },
    files: {},
    issue: {
      getState: () => ({ running: opts.issuing ?? false, job: null, issued: 0, last: null }),
      start: (job: IssueJob) => {
        calls.started.push(job);
      },
    },
    isAdvancedMode: () => opts.advanced ?? false,
  };
  return { deps: deps as never, calls };
}

async function invoke(method: keyof typeof INVOKE_CHANNELS, ...args: unknown[]): Promise<Envelope<unknown>> {
  const h = handlers.get(INVOKE_CHANNELS[method]);
  if (!h) throw new Error(`no handler for ${method}`);
  return h({}, ...args);
}

const writeReq = (over: Partial<WriteRequest> = {}): WriteRequest => ({
  kind: 'MIFARE_CLASSIC_1K',
  expectedUid: '01020304',
  writes: [],
  allowProtected: false,
  verify: true,
  ...over,
});

let unregister: () => void = () => {};
beforeEach(() => {
  unregister();
  handlers.clear();
});

describe('ipc', () => {
  it('registers a handler for every invoke channel (incl. reader:reidentify)', () => {
    const { deps } = makeDeps();
    unregister = registerIpc(deps);
    for (const ch of Object.values(INVOKE_CHANNELS)) expect(handlers.has(ch)).toBe(true);
  });

  it('reidentify is routed to the service, also while issuing', async () => {
    const { deps, calls } = makeDeps({ issuing: true });
    unregister = registerIpc(deps);
    const r = await invoke('reidentify');
    expect(r.ok).toBe(true);
    expect(calls.reidentify).toBe(1);
  });

  it('raw APDUs without advanced mode: ADVANCED_REQUIRED with a plain message (not ACCESS_DENIED / English)', async () => {
    const { deps, calls } = makeDeps({ advanced: false });
    unregister = registerIpc(deps);
    const r = await invoke('transmitApdu', 'FFCA000000');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ADVANCED_REQUIRED');
    expect(r.error.message).toContain('上級者モード');
    expect(calls.apdu).toBe(0);
  });

  it('protected-region writes without advanced mode are refused (I5) before reaching the reader', async () => {
    const { deps, calls } = makeDeps({ advanced: false });
    unregister = registerIpc(deps);
    const r = await invoke('writeTag', writeReq({ allowProtected: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ADVANCED_REQUIRED');
    expect(calls.write).toHaveLength(0);
  });

  it('an empty MIFARE key list means "use the default key set" (undefined) for read and write', async () => {
    const { deps, calls } = makeDeps();
    unregister = registerIpc(deps);
    await invoke('readTag', { mifareKeyIds: [] });
    await invoke('readTag', undefined);
    await invoke('writeTag', writeReq({ mifareKeyIds: [] }));
    await invoke('readTag', { mifareKeyIds: ['key-1'] });
    expect(calls.read[0].mifareKeyIds).toBeUndefined();
    expect(calls.read[1].mifareKeyIds).toBeUndefined();
    expect(calls.write[0].mifareKeyIds).toBeUndefined();
    expect(calls.read[2].mifareKeyIds).toEqual(['key-1']);
  });

  it('single reads / writes / clearing the issue log are BUSY while issuing', async () => {
    const { deps, calls } = makeDeps({ issuing: true, advanced: true });
    unregister = registerIpc(deps);
    for (const r of [await invoke('readTag', {}), await invoke('writeTag', writeReq()), await invoke('clearIssueLog')]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('BUSY');
    }
    expect(calls.read).toHaveLength(0);
    expect(calls.write).toHaveLength(0);
    expect(calls.clear).toBe(0);
  });
  it('batch issuing with NTAG password protection needs advanced mode (same gate as allowProtected, R-UX-6)', async () => {
    const job = {
      id: 'j',
      name: 'j',
      kind: 'NTAG215',
      template: { type: 'ndef', records: [] },
      sequence: { start: 1, step: 1, next: 1 },
      rows: null,
      rowIndex: 0,
      options: { verify: true, skipDuplicateUid: true, requireBlank: false, ntagProtect: { password: '11223344', pack: 'AABB', protectRead: false }, mifareKeyIds: [], sound: true },
      limit: null,
    } as IssueJob;
    const off = makeDeps({ advanced: false });
    unregister = registerIpc(off.deps);
    const r = await invoke('startIssue', job);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ADVANCED_REQUIRED');
      expect(r.error.message).toContain('上級者モード');
    }
    expect(off.calls.started).toHaveLength(0);
    // without protection, or in advanced mode, it starts
    expect((await invoke('startIssue', { ...job, options: { ...job.options, ntagProtect: null } })).ok).toBe(true);
    unregister();
    handlers.clear();
    const on = makeDeps({ advanced: true });
    unregister = registerIpc(on.deps);
    expect((await invoke('startIssue', job)).ok).toBe(true);
    expect(on.calls.started).toHaveLength(1);
  });
});
