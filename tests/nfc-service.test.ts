import { describe, expect, it } from 'vitest';
import { createNfcService } from '../src/main/nfc/service';
import type { NfcService, NfcServiceDeps, ResolvedKey } from '../src/main/nfc/contract';
import type { ReaderStatus, UnitWrite, WriteRequest } from '../src/shared/types';
import { hexToBytes } from '../src/shared/hex';
import { mifareTrailerBlock, ntagPages, specFor } from '../src/shared/tags';
import { buildNtagPasswordWrites } from '../src/shared/tag';
import { VIRTUAL_READER_NAME } from '../src/shared/reader';

const KEYS: Record<string, string> = {
  factory: 'FFFFFFFFFFFF',
  mad: 'A0A1A2A3A4A5',
};

function makeDeps(over: Partial<NfcServiceDeps> = {}): NfcServiceDeps {
  return {
    resolveKeys(ids: string[]): ResolvedKey[] {
      return ids.filter((id) => KEYS[id]).map((id) => ({ id, label: id, key: hexToBytes(KEYS[id]) }));
    },
    // Built-in public keys first (keystore order). Here the MAD key comes first so
    // the factory key is found only by trying more than one key.
    allKeyIds: () => ['mad', 'factory'],
    log() {},
    isAdvancedMode: () => true,
    ...over,
  };
}

// PC/SC is never started in unit tests (init.pcsc = false): the dev PC has a real
// PaSoRi, USB tokens and user tags attached, and the tests must not depend on -
// or send a single APDU to - whatever hardware is plugged in.
function makeService(over: Partial<NfcServiceDeps> = {}): NfcService {
  return createNfcService(makeDeps(over), { pcsc: false });
}

/** Resolve when the status satisfies `pred` (checks the current status first). */
function statusWhere(svc: NfcService, pred: (s: ReaderStatus) => boolean, ms = 2000): Promise<ReaderStatus> {
  return new Promise((resolve, reject) => {
    const now = svc.getStatus();
    if (pred(now)) return resolve(now);
    const t = setTimeout(() => {
      off();
      reject(new Error(`status never matched; last: ${JSON.stringify({ cardState: svc.getStatus().cardState, active: svc.getStatus().activeReader })}`));
    }, ms);
    const off = svc.onStatus((s) => {
      if (!pred(s)) return;
      clearTimeout(t);
      off();
      resolve(s);
    });
  });
}

function u(unit: number, hex: string): UnitWrite {
  return { unit, data: hexToBytes(hex) };
}

describe('NTAG read/write round-trip', () => {
  it('reads a fresh NTAG215, writes a user page, verifies, and reads it back', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG215');

    const first = await svc.readTag({});
    expect(first.kind).toBe('NTAG215');
    expect(first.uid).toHaveLength(14); // 7 bytes
    expect(first.unitStatus[4]).toBe('ok');
    expect(first.ntag?.version).toBeTruthy();

    const req: WriteRequest = {
      kind: 'NTAG215',
      expectedUid: first.uid,
      writes: [u(4, '01020304')],
      allowProtected: false,
      verify: true,
    };
    const res = await svc.writeTag(req);
    expect(res.written).toEqual([4]);
    expect(res.failed).toEqual([]);
    expect(res.verified).toBe(true);
    expect(res.mismatched).toEqual([]);

    const after = await svc.readTag({});
    expect(Array.from(after.data.subarray(16, 20))).toEqual([1, 2, 3, 4]);
    await svc.dispose();
  });

  it('rejects a write when the UID does not match', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    const req: WriteRequest = {
      kind: 'NTAG213',
      expectedUid: 'AABBCCDDEEFF00',
      writes: [u(4, '01020304')],
      allowProtected: false,
      verify: false,
    };
    await expect(svc.writeTag(req)).rejects.toMatchObject({ code: 'UID_MISMATCH' });
    await svc.dispose();
  });

  it('refuses forbidden (UID) and protected (CC) pages, each with its own code (R-UX-11)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    // The UID is never writable, even with protected writes allowed: FORBIDDEN_UNIT,
    // never PROTECTED_UNIT (whose message names the switch that allows protected areas).
    const forbidden: WriteRequest = { kind: 'NTAG213', expectedUid: null, writes: [u(0, '00000000')], allowProtected: true, verify: false };
    await expect(svc.writeTag(forbidden)).rejects.toMatchObject({ code: 'FORBIDDEN_UNIT' });
    const forbiddenToo: WriteRequest = { kind: 'NTAG213', expectedUid: null, writes: [u(1, '00000000')], allowProtected: false, verify: false };
    await expect(svc.writeTag(forbiddenToo)).rejects.toMatchObject({ code: 'FORBIDDEN_UNIT' });

    const protectedCc: WriteRequest = { kind: 'NTAG213', expectedUid: null, writes: [u(3, 'E1103E00')], allowProtected: false, verify: false };
    await expect(svc.writeTag(protectedCc)).rejects.toMatchObject({ code: 'PROTECTED_UNIT' });
    await svc.dispose();
  });

  it('protects pages with a password: denied without it, ok with it', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG215');
    const p = ntagPages('NTAG215');

    // Set PWD, enable read-protection (CFG1 PROT bit), and set AUTH0 = page 4.
    const setup: WriteRequest = {
      kind: 'NTAG215',
      expectedUid: null,
      allowProtected: true,
      verify: false,
      writes: [u(p.pwd, '12345678'), u(p.cfg1, '80050000'), u(p.cfg0, '04000004')],
    };
    const setupRes = await svc.writeTag(setup);
    expect(setupRes.written).toEqual([p.pwd, p.cfg1, p.cfg0]);

    const denied = await svc.readTag({});
    expect(denied.unitStatus[4]).toBe('denied');

    const opened = await svc.readTag({ ntagPassword: '12345678' });
    expect(opened.unitStatus[4]).toBe('ok');
    await svc.dispose();
  });
});

describe('NTAG password setup with verify (2026-11-12 review R-WRITE-2)', () => {
  // Real NTAG21x return 00 for PWD / PACK and latch AUTH0 / PROT only at the next
  // activation; the simulator does the same, so these tests stand for hardware.
  for (const protectRead of [false, true]) {
    it(`a verified password setup is "verified" (PWD/PACK are not compared), protectRead=${protectRead}`, async () => {
      const svc = makeService();
      await svc.simulatorNewTag('NTAG213');
      const img = await svc.readTag({});
      const p = ntagPages('NTAG213');
      const writes = buildNtagPasswordWrites('NTAG213', img.data, { password: '12345678', pack: 'ABCD', auth0: 4, protectRead, authLimit: 0 });
      const res = await svc.writeTag({ kind: 'NTAG213', expectedUid: img.uid, writes, allowProtected: true, verify: true });
      expect(res).toMatchObject({ written: [p.pwd, p.pack, p.cfg1, p.cfg0], failed: [], verified: true, mismatched: [], aborted: null });

      // Protection is in force from the next session on.
      const after = await svc.readTag({});
      expect(after.unitStatus[4]).toBe(protectRead ? 'denied' : 'ok');
      // PWD / PACK never read back, even with the password.
      const opened = await svc.readTag({ ntagPassword: '12345678' });
      expect(opened.unitStatus[4]).toBe('ok');
      expect(Array.from(opened.data.subarray(p.pwd * 4, p.pack * 4 + 4))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      // Writing with the password works; without it the protected pages are refused.
      const withPwd = await svc.writeTag({ kind: 'NTAG213', expectedUid: img.uid, writes: [u(4, '0A0B0C0D')], allowProtected: false, verify: true, ntagPassword: '12345678' });
      expect(withPwd).toMatchObject({ written: [4], verified: true });
      const noPwd = await svc.writeTag({ kind: 'NTAG213', expectedUid: img.uid, writes: [u(5, '0A0B0C0D')], allowProtected: false, verify: false });
      expect(noPwd).toMatchObject({ written: [], failed: [{ unit: 5, error: 'ACCESS_DENIED' }], aborted: null });
      await svc.dispose();
    });
  }
});

describe('MIFARE Classic read/write', () => {
  it('opens every sector with the factory key and round-trips a data block', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');

    const first = await svc.readTag({ mifareKeyIds: ['factory'] });
    expect(first.kind).toBe('MIFARE_CLASSIC_1K');
    expect(first.uid).toHaveLength(8); // 4 bytes
    expect(first.unitStatus.every((s) => s === 'ok')).toBe(true);
    expect(first.mifare?.sectors.every((s) => s.keyType !== null)).toBe(true);

    const payload = '00112233445566778899AABBCCDDEEFF';
    const req: WriteRequest = {
      kind: 'MIFARE_CLASSIC_1K',
      expectedUid: first.uid,
      writes: [u(1, payload)],
      allowProtected: false,
      verify: true,
      mifareKeyIds: ['factory'],
    };
    const res = await svc.writeTag(req);
    expect(res.written).toEqual([1]);
    expect(res.verified).toBe(true);

    const after = await svc.readTag({ mifareKeyIds: ['factory'] });
    expect(Array.from(after.data.subarray(16, 32))).toEqual(Array.from(hexToBytes(payload)));
    await svc.dispose();
  });

  it('marks sectors denied when no provided key opens them', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const img = await svc.readTag({ mifareKeyIds: ['mad'] }); // MAD key != factory FF
    expect(img.unitStatus.every((s) => s === 'denied')).toBe(true);
    expect(img.mifare?.sectors.every((s) => s.keyType === null && s.keyLabel === null)).toBe(true);
    await svc.dispose();
  });

  it('refuses a trailer whose access bits are invalid (INVALID_ACCESS_BITS)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const trailer = mifareTrailerBlock(0); // block 3
    const bad: WriteRequest = {
      kind: 'MIFARE_CLASSIC_1K',
      expectedUid: null,
      writes: [u(trailer, '00000000000000000000000000000000')],
      allowProtected: true,
      verify: false,
      mifareKeyIds: ['factory'],
    };
    await expect(svc.writeTag(bad)).rejects.toMatchObject({ code: 'INVALID_ACCESS_BITS' });
    await svc.dispose();
  });

  it('verifies a trailer write even though Key A always reads back as 00', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const first = await svc.readTag({ mifareKeyIds: ['factory'] });
    const trailer = mifareTrailerBlock(0);
    // Keep Key A = factory FF (so the verify re-auth works) + valid transport
    // access bits (FF 07 80 69) + Key B. On real hardware Key A reads back as 00,
    // so an all-16-byte compare would always mismatch; verify must still pass.
    const data = 'FFFFFFFFFFFF' + 'FF078069' + 'FFFFFFFFFFFF';
    const req: WriteRequest = {
      kind: 'MIFARE_CLASSIC_1K',
      expectedUid: first.uid,
      writes: [u(trailer, data)],
      allowProtected: true,
      verify: true,
      mifareKeyIds: ['factory'],
    };
    const res = await svc.writeTag(req);
    expect(res.written).toEqual([trailer]);
    expect(res.verified).toBe(true);
    expect(res.mismatched).toEqual([]);
    await svc.dispose();
  });

  it('refuses a valid trailer when protected writes are not allowed (PROTECTED_UNIT)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const trailer = mifareTrailerBlock(0);
    // 6 bytes Key A + FF 07 80 69 (valid transport access bits) + 6 bytes Key B.
    const validTrailer = 'FFFFFFFFFFFF' + 'FF078069' + 'FFFFFFFFFFFF';
    const req: WriteRequest = {
      kind: 'MIFARE_CLASSIC_1K',
      expectedUid: null,
      writes: [u(trailer, validTrailer)],
      allowProtected: false,
      verify: false,
      mifareKeyIds: ['factory'],
    };
    await expect(svc.writeTag(req)).rejects.toMatchObject({ code: 'PROTECTED_UNIT' });
    await svc.dispose();
  });
});

describe('status, identification and waiters', () => {
  it('surfaces the simulator reader and identified card in the status', async () => {
    const svc = makeService();
    const ac = new AbortController();
    const cardP = svc.waitForCard(ac.signal);
    await svc.simulatorNewTag('NTAG216');
    const card = await cardP;
    expect(card.kind).toBe('NTAG216');
    expect(card.rawCommands).toBe(true);
    expect(card.driver).toBe('acr122');

    const status = svc.getStatus();
    expect(status.readers.some((r) => r.virtual)).toBe(true);
    expect(status.simulator.enabled).toBe(true);
    expect(status.card?.kind).toBe('NTAG216');
    await svc.dispose();
  });

  it('rejects waitForCard when aborted', async () => {
    const svc = makeService();
    const ac = new AbortController();
    ac.abort();
    await expect(svc.waitForCard(ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await svc.dispose();
  });

  it('reports NO_READER when nothing is connected', async () => {
    const svc = makeService();
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'NO_READER' });
    expect(svc.getStatus()).toMatchObject({ service: 'no-readers', cardState: 'no-reader' });
    await svc.dispose();
  });

  it('refuses transmitApdu outside advanced mode with ADVANCED_REQUIRED (FIRST-9)', async () => {
    const svc = makeService({ isAdvancedMode: () => false });
    await svc.simulatorNewTag('NTAG213');
    await expect(svc.transmitApdu(hexToBytes('FFCA000000'))).rejects.toMatchObject({ code: 'ADVANCED_REQUIRED' });
    await svc.dispose();
  });
});

describe('active reader, card state and the virtual reader', () => {
  it('reports the active reader, why it is active, and the tag state', async () => {
    const svc = makeService();
    expect(svc.getStatus()).toMatchObject({ activeReader: null, activeReason: 'none', cardState: 'no-reader', card: null });

    await svc.setSimulator({ enabled: true, kind: 'NTAG213' });
    expect(svc.getStatus()).toMatchObject({ activeReader: VIRTUAL_READER_NAME, activeReason: 'auto-first', cardState: 'absent' });

    await svc.simulatorTap(true);
    const s = await statusWhere(svc, (x) => x.cardState === 'ready');
    expect(s).toMatchObject({ activeReader: VIRTUAL_READER_NAME, activeReason: 'auto-virtual', cardError: null, ignoredRealReader: null });
    expect(s.card?.kind).toBe('NTAG213');
    await svc.dispose();
  });

  it('turning the virtual reader off removes its tag and ends removal waits (CARD-5)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    await statusWhere(svc, (x) => x.card?.kind === 'NTAG213');
    const removed = svc.waitForRemoval(new AbortController().signal);

    await svc.setSimulator({ enabled: false });
    const outcome = await Promise.race([removed.then(() => 'removed'), new Promise((r) => setTimeout(() => r('still waiting'), 200))]);
    expect(outcome).toBe('removed');
    const s = svc.getStatus();
    expect(s.card).toBeNull();
    expect(s.cardState).toBe('no-reader');
    expect(s.readers.some((r) => r.virtual)).toBe(false);
    // A card waiter must not be satisfied by the stale virtual tag either.
    const ac = new AbortController();
    const waiting = svc.waitForCard(ac.signal);
    let resolved = false;
    void waiting.then(() => (resolved = true), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    ac.abort();
    await svc.dispose();
  });

  it('a selected reader that is not connected is reported, never silently replaced (D1, CARD-14)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG215');
    await statusWhere(svc, (x) => x.cardState === 'ready');
    await svc.selectReader('ACS ACR122U PICC Interface 0');
    expect(svc.getStatus()).toMatchObject({ activeReader: null, activeReason: 'selected-missing', cardState: 'no-reader', card: null });
    await expect(svc.readTag({})).rejects.toMatchObject({ code: 'NO_READER' });
    await svc.selectReader(null);
    expect(svc.getStatus().activeReason).toBe('auto-virtual');
    await svc.dispose();
  });

  it('applies init.preferredReader before the first identification', async () => {
    const svc = createNfcService(makeDeps(), { pcsc: false, preferredReader: VIRTUAL_READER_NAME, driverMode: 'storage' });
    expect(svc.getStatus()).toMatchObject({ selectedReader: VIRTUAL_READER_NAME, driverMode: 'storage', activeReason: 'selected-missing' });
    await svc.simulatorNewTag('NTAG215');
    const s = await statusWhere(svc, (x) => x.cardState === 'ready');
    expect(s.activeReason).toBe('selected');
    // storage driver: identified from the CC, no raw commands
    expect(s.card).toMatchObject({ kind: 'NTAG215', kindSource: 'cc', rawCommands: false, driver: 'storage' });
    await svc.dispose();
  });
});

describe('reads and writes stay honest', () => {
  it('reads a factory MIFARE with every stored key when no keys are named (FLOW-2 / WRITE-3)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const img = await svc.readTag({});
    expect(img.unitStatus.every((s) => s === 'ok')).toBe(true);
    expect(img.mifare?.sectors.every((s) => s.keyLabel === 'factory')).toBe(true);

    const res = await svc.writeTag({
      kind: 'MIFARE_CLASSIC_1K',
      expectedUid: img.uid,
      writes: [u(1, '00112233445566778899AABBCCDDEEFF')],
      allowProtected: false,
      verify: true,
    });
    expect(res).toMatchObject({ written: [1], failed: [], verified: true, aborted: null, notAttempted: [] });
    await svc.dispose();
  });

  it('an explicit empty key list still means "no keys" (sectors denied)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const img = await svc.readTag({ mifareKeyIds: [] });
    expect(img.unitStatus.every((s) => s === 'denied')).toBe(true);
    await svc.dispose();
  });

  it('refuses to write data of another tag kind (KIND_MISMATCH, WRITE-8)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    const img = await svc.readTag({});
    // NTAG215 user page 41 is NTAG213's CFG0: must never be written there.
    const req: WriteRequest = { kind: 'NTAG215', expectedUid: img.uid, writes: [u(41, '01020304')], allowProtected: false, verify: false };
    await expect(svc.writeTag(req)).rejects.toMatchObject({ code: 'KIND_MISMATCH' });
    const after = await svc.readTag({});
    expect(Array.from(after.data.subarray(41 * 4, 41 * 4 + 4))).toEqual(Array.from(img.data.subarray(41 * 4, 41 * 4 + 4)));
    await svc.dispose();
  });

  it('reports failed units with an ErrorCode and the new result fields', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('MIFARE_CLASSIC_1K');
    const res = await svc.writeTag({
      kind: 'MIFARE_CLASSIC_1K',
      expectedUid: null,
      writes: [u(1, '00112233445566778899AABBCCDDEEFF')],
      allowProtected: false,
      verify: false,
      mifareKeyIds: ['mad'],
    });
    expect(res).toMatchObject({ written: [], failed: [{ unit: 1, error: 'ACCESS_DENIED' }], aborted: null, notAttempted: [] });
    await svc.dispose();
  });

  it('a successful read makes the status show the tag that was read (CARD-10)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    await statusWhere(svc, (x) => x.cardState === 'ready');
    const img = await svc.readTag({});
    expect(svc.getStatus().card?.uid).toBe(img.uid);
    await svc.dispose();
  });
});

describe('waitForCard(detectedAfter) (ISSUE-5)', () => {
  it('ignores a tag that was already on the reader and resolves for the next one', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    const first = (await statusWhere(svc, (x) => x.cardState === 'ready')).card!;
    await new Promise((r) => setTimeout(r, 5));
    const start = Date.now();

    const ac = new AbortController();
    let got: string | null = null;
    const p = svc.waitForCard(ac.signal, { detectedAfter: start }).then((c) => (got = c.uid));
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBeNull(); // the tag left on the reader does not count

    await svc.simulatorNewTag('NTAG213');
    await p;
    expect(got).not.toBeNull();
    expect(got).not.toBe(first.uid);
    await svc.dispose();
  });

  it('without detectedAfter resolves immediately for the tag already identified', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG215');
    const ready = await statusWhere(svc, (x) => x.cardState === 'ready');
    const card = await svc.waitForCard(new AbortController().signal);
    expect(card.uid).toBe(ready.card!.uid);
    await svc.dispose();
  });
});

describe('manual kind override', () => {
  it('uses the manually set kind as the identification source', async () => {
    const svc = makeService();
    await svc.setManualKind('NTAG216');
    await svc.simulatorNewTag('NTAG216');
    const ac = new AbortController();
    const card = await svc.waitForCard(ac.signal);
    expect(card.kindSource).toBe('manual');
    await svc.dispose();
  });

  it('applies to the tag on the reader only and ends when that tag leaves (WRITE-8)', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG215');
    await statusWhere(svc, (x) => x.card?.kind === 'NTAG215');
    await svc.setManualKind('NTAG213');
    const forced = await statusWhere(svc, (x) => x.card?.kindSource === 'manual');
    expect(forced.card?.kind).toBe('NTAG213');

    // A different tag must not inherit the forced layout.
    await svc.simulatorNewTag('NTAG216');
    const next = await statusWhere(svc, (x) => x.cardState === 'ready' && x.card?.uid !== forced.card?.uid);
    expect(next.card).toMatchObject({ kind: 'NTAG216', kindSource: 'version' });
    await svc.dispose();
  });
});

describe('spec sanity used by tests', () => {
  it('NTAG215 user memory starts at page 4', () => {
    expect(specFor('NTAG215').userStartUnit).toBe(4);
  });
});
