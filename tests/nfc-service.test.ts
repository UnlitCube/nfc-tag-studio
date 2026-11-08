import { describe, expect, it } from 'vitest';
import { createNfcService } from '../src/main/nfc/service';
import type { NfcService, NfcServiceDeps, ResolvedKey } from '../src/main/nfc/contract';
import type { UnitWrite, WriteRequest } from '../src/shared/types';
import { hexToBytes } from '../src/shared/hex';
import { mifareTrailerBlock, ntagPages, specFor } from '../src/shared/tags';

const KEYS: Record<string, string> = {
  factory: 'FFFFFFFFFFFF',
  mad: 'A0A1A2A3A4A5',
};

function makeService(): NfcService {
  const deps: NfcServiceDeps = {
    resolveKeys(ids: string[]): ResolvedKey[] {
      return ids.filter((id) => KEYS[id]).map((id) => ({ id, label: id, key: hexToBytes(KEYS[id]) }));
    },
    log() {},
    isAdvancedMode: () => true,
  };
  return createNfcService(deps);
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

  it('refuses forbidden (UID) and protected (CC) pages', async () => {
    const svc = makeService();
    await svc.simulatorNewTag('NTAG213');
    const forbidden: WriteRequest = { kind: 'NTAG213', expectedUid: null, writes: [u(0, '00000000')], allowProtected: true, verify: false };
    await expect(svc.writeTag(forbidden)).rejects.toMatchObject({ code: 'PROTECTED_UNIT' });

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
    await svc.dispose();
  });

  it('refuses transmitApdu outside advanced mode', async () => {
    const deps: NfcServiceDeps = { resolveKeys: () => [], log() {}, isAdvancedMode: () => false };
    const svc = createNfcService(deps);
    await svc.simulatorNewTag('NTAG213');
    await expect(svc.transmitApdu(hexToBytes('FFCA000000'))).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
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
});

describe('spec sanity used by tests', () => {
  it('NTAG215 user memory starts at page 4', () => {
    expect(specFor('NTAG215').userStartUnit).toBe(4);
  });
});
