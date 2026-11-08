import { describe, expect, it } from 'vitest';
import { createSimulatorBackend } from '../src/main/nfc/simulator';
import type { BackendEvent, CardConnection } from '../src/main/nfc/backend';
import {
  apduAuthenticate,
  apduGetUid,
  apduLoadKey,
  apduReadBinary,
  apduUpdateBinary,
  isSuccessSw,
  splitResponse,
} from '../src/main/nfc/apdu';
import { wrapRawCommand, unwrapRawResponse } from '../src/main/nfc/driver';
import { ntagGetVersion, ntagRead, ntagWrite } from '../src/main/nfc/apdu';
import { encodeAccessBits, kindFromVersion, kindHintFromAtr, mifareTrailerBlock } from '../src/shared/tags';
import { VIRTUAL_READER_NAME } from '../src/shared/reader';
import { hexToBytes } from '../src/shared/hex';

const FF6 = hexToBytes('FFFFFFFFFFFF');

async function connectTo(kind: Parameters<ReturnType<typeof createSimulatorBackend>['newTag']>[0]): Promise<{ conn: CardConnection; events: BackendEvent[] }> {
  const backend = createSimulatorBackend();
  const events: BackendEvent[] = [];
  await backend.start((e) => events.push(e));
  backend.newTag(kind);
  const conn = await backend.connect(VIRTUAL_READER_NAME);
  return { conn, events };
}

describe('simulator backend lifecycle', () => {
  it('advertises the virtual reader only when enabled, and emits card events', async () => {
    const backend = createSimulatorBackend();
    const events: BackendEvent[] = [];
    await backend.start((e) => events.push(e));
    expect(backend.readers()).toHaveLength(0);

    backend.newTag('NTAG215');
    expect(backend.readers()).toHaveLength(1);
    expect(backend.readers()[0].virtual).toBe(true);
    expect(backend.readers()[0].cardPresent).toBe(true);
    expect(events.some((e) => e.type === 'card-inserted')).toBe(true);

    backend.tap(false);
    expect(events.some((e) => e.type === 'card-removed')).toBe(true);
  });

  it('rejects connect when no tag is present', async () => {
    const backend = createSimulatorBackend();
    await backend.start(() => {});
    await expect(backend.connect(VIRTUAL_READER_NAME)).rejects.toMatchObject({ code: 'NO_CARD' });
  });
});

describe('simulator storage APDUs', () => {
  it('returns a 7-byte UID for NTAG via FF CA', async () => {
    const { conn } = await connectTo('NTAG213');
    const { data, sw } = splitResponse(await conn.transmit(apduGetUid()));
    expect(isSuccessSw(sw)).toBe(true);
    expect(data).toHaveLength(7);
    expect(data[0]).toBe(0x04);
  });

  it('presents a Type 2 pseudo-ATR for NTAG and a MIFARE ATR for Classic', async () => {
    const ntag = await connectTo('NTAG216');
    expect(kindHintFromAtr(ntag.conn.atr)).toBe('TYPE2');
    const mfc = await connectTo('MIFARE_CLASSIC_1K');
    expect(kindHintFromAtr(mfc.conn.atr)).toBe('MIFARE_CLASSIC_1K');
  });

  it('refuses writes to NTAG UID pages (0-1)', async () => {
    const { conn } = await connectTo('NTAG215');
    const { sw } = splitResponse(await conn.transmit(apduUpdateBinary(0, hexToBytes('00000000'))));
    expect(isSuccessSw(sw)).toBe(false);
  });

  it('requires MIFARE authentication before read/write', async () => {
    const { conn } = await connectTo('MIFARE_CLASSIC_1K');
    // Reading block 1 without auth fails.
    expect(isSuccessSw(splitResponse(await conn.transmit(apduReadBinary(1, 16))).sw)).toBe(false);
    // Load factory key, authenticate sector 0, then read block 1.
    expect(isSuccessSw(splitResponse(await conn.transmit(apduLoadKey(0, FF6))).sw)).toBe(true);
    expect(isSuccessSw(splitResponse(await conn.transmit(apduAuthenticate(0, 'A', 0))).sw)).toBe(true);
    const read = splitResponse(await conn.transmit(apduReadBinary(1, 16)));
    expect(isSuccessSw(read.sw)).toBe(true);
    expect(read.data).toHaveLength(16);
  });

  it('rejects a wrong MIFARE key', async () => {
    const { conn } = await connectTo('MIFARE_CLASSIC_1K');
    await conn.transmit(apduLoadKey(0, hexToBytes('A0A1A2A3A4A5')));
    expect(isSuccessSw(splitResponse(await conn.transmit(apduAuthenticate(0, 'A', 0))).sw)).toBe(false);
  });

  it('reads the sector-0 trailer after factory auth (factory keys are FF)', async () => {
    const { conn } = await connectTo('MIFARE_CLASSIC_1K');
    await conn.transmit(apduLoadKey(0, FF6));
    await conn.transmit(apduAuthenticate(0, 'A', 0));
    const trailer = splitResponse(await conn.transmit(apduReadBinary(mifareTrailerBlock(0), 16)));
    expect(isSuccessSw(trailer.sw)).toBe(true);
  });

  it('masks the trailer read-back like hardware: Key A always 00, Key B only when readable', async () => {
    const { conn } = await connectTo('MIFARE_CLASSIC_1K');
    await conn.transmit(apduLoadKey(0, FF6));
    await conn.transmit(apduAuthenticate(0, 'A', 0));
    const trailerBlk = mifareTrailerBlock(0);

    // Factory transport config (access FF 07 80, GPB 69): Key A is never readable
    // (00), the access bytes are readable, Key B is readable (reads back FF).
    const transport = splitResponse(await conn.transmit(apduReadBinary(trailerBlk, 16)));
    expect(Array.from(transport.data.subarray(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(transport.data.subarray(6, 10))).toEqual([0xff, 0x07, 0x80, 0x69]);
    expect(Array.from(transport.data.subarray(10, 16))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

    // Rewrite the trailer with an access config that forbids reading Key B
    // (trailer bits 1 0 0), keeping Key A = FF so re-reads still authenticate.
    const access = encodeAccessBits({ c: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0, 0]], gpb: 0x00 });
    const newTrailer = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...access, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6]);
    expect(isSuccessSw(splitResponse(await conn.transmit(apduUpdateBinary(trailerBlk, newTrailer))).sw)).toBe(true);

    const hidden = splitResponse(await conn.transmit(apduReadBinary(trailerBlk, 16)));
    expect(Array.from(hidden.data.subarray(0, 6))).toEqual([0, 0, 0, 0, 0, 0]); // Key A still hidden
    expect(Array.from(hidden.data.subarray(10, 16))).toEqual([0, 0, 0, 0, 0, 0]); // Key B now hidden
  });
});

describe('simulator raw NFC-A (acr122 framing)', () => {
  it('answers GET_VERSION with a model-correct 8-byte version', async () => {
    const { conn } = await connectTo('NTAG215');
    const resp = await conn.transmit(wrapRawCommand('acr122', ntagGetVersion()));
    const version = unwrapRawResponse('acr122', resp);
    expect(version).toHaveLength(8);
    expect(kindFromVersion(version)).toBe('NTAG215');
  });

  it('writes then reads a page back through raw commands', async () => {
    const { conn } = await connectTo('NTAG213');
    const data = hexToBytes('DEADBEEF');
    const ack = unwrapRawResponse('acr122', await conn.transmit(wrapRawCommand('acr122', ntagWrite(4, data))));
    expect(ack[0]).toBe(0x0a); // NTAG ACK
    const read = unwrapRawResponse('acr122', await conn.transmit(wrapRawCommand('acr122', ntagRead(4))));
    expect(Array.from(read.subarray(0, 4))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('reports a transport error for GET_VERSION on a MIFARE tag', async () => {
    const { conn } = await connectTo('MIFARE_CLASSIC_1K');
    const resp = await conn.transmit(wrapRawCommand('acr122', ntagGetVersion()));
    // The MIFARE virtual tag does not answer NTAG native commands -> PN532 error.
    expect(() => unwrapRawResponse('acr122', resp)).toThrow();
  });
});
