// FeliCa Lite-S pure-logic tests: command framing round-trips, MC decode/encode
// (write/read-protect masks at MC[6:12], verified against real hardware
// 2026-11-12), identification. Run with `npm run unit`.
import { describe, it, expect } from 'vitest';
import {
  felicaPolling,
  parsePolling,
  felicaReadWithoutEncryption,
  parseRead,
  felicaWriteWithoutEncryption,
  parseWrite,
  decodeFelicaMc,
  encodeFelicaMc,
  felicaBlockName,
  FELICA_SERVICE_RO,
  FELICA_SERVICE_RW,
} from '../src/shared/felica';
import {
  factoryImage,
  felicaBlockOfUnit,
  isFelica,
  isProtectedUnit,
  kindFromFelicaSystemCode,
  kindHintFromAtr,
  specFor,
  FELICA_LITE_S_BLOCK_MAP,
  FELICA_LITE_S_SYSTEM_CODE,
} from '../src/shared/tags';

const IDM = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

describe('FeliCa framing', () => {
  it('frames Polling with a self-counting length byte', () => {
    const p = felicaPolling(FELICA_LITE_S_SYSTEM_CODE);
    expect(p[0]).toBe(p.length); // len counts itself
    expect(p[1]).toBe(0x00);
    expect(p[2]).toBe(0x88);
    expect(p[3]).toBe(0xb4);
  });

  it('parses a Polling response into IDm/PMm/systemCode', () => {
    const body = [0x01, ...IDM, ...new Array(8).fill(0xff), 0x88, 0xb4];
    const resp = Uint8Array.from([body.length + 1, ...body]);
    const r = parsePolling(resp);
    expect(Array.from(r.idm)).toEqual(Array.from(IDM));
    expect(r.systemCode).toBe(0x88b4);
  });

  it('frames Read Without Encryption with the read-only service + 2-byte block list', () => {
    const cmd = felicaReadWithoutEncryption(IDM, [0, 1], FELICA_SERVICE_RO);
    expect(cmd[0]).toBe(cmd.length);
    expect(cmd[1]).toBe(0x06);
    expect(Array.from(cmd.subarray(2, 10))).toEqual(Array.from(IDM));
    expect(cmd[11]).toBe(FELICA_SERVICE_RO & 0xff); // service LE
    expect(cmd[12]).toBe((FELICA_SERVICE_RO >> 8) & 0xff);
    expect(cmd[13]).toBe(2); // 2 blocks
    expect(cmd[14]).toBe(0x80); // 2-byte element marker
    expect(cmd[15]).toBe(0x00); // block 0
  });

  it('parses a Read response and extracts 16-byte blocks', () => {
    const b0 = new Array(16).fill(0xaa);
    const body = [0x07, ...IDM, 0x00, 0x00, 0x01, ...b0];
    const resp = Uint8Array.from([body.length + 1, ...body]);
    const r = parseRead(resp);
    expect(r.statusFlag1).toBe(0x00);
    expect(r.blocks).toHaveLength(1);
    expect(Array.from(r.blocks[0])).toEqual(b0);
  });

  it('reports a Read error status with no blocks', () => {
    const body = [0x07, ...IDM, 0x01, 0xa8];
    const resp = Uint8Array.from([body.length + 1, ...body]);
    const r = parseRead(resp);
    expect(r.statusFlag1).toBe(0x01);
    expect(r.blocks).toHaveLength(0);
  });

  it('frames + parses Write Without Encryption via the RW service', () => {
    const data = Uint8Array.from(new Array(16).fill(0x5a));
    const cmd = felicaWriteWithoutEncryption(IDM, 3, data, FELICA_SERVICE_RW);
    expect(cmd[1]).toBe(0x08);
    expect(cmd[11]).toBe(FELICA_SERVICE_RW & 0xff);
    expect(cmd[15]).toBe(3); // block number
    expect(Array.from(cmd.subarray(16, 32))).toEqual(Array.from(data));
    const ok = Uint8Array.from([12, 0x09, ...IDM, 0x00, 0x00]);
    expect(parseWrite(ok).statusFlag1).toBe(0x00);
  });
});

describe('FeliCa MC', () => {
  const mcOf = (img: Uint8Array) => {
    const mcUnit = specFor('FELICA_LITE_S').unitCount - 1;
    return decodeFelicaMc(img.subarray(mcUnit * 16, mcUnit * 16 + 16));
  };

  it('decodes a factory MC as all-writable with system blocks writable', () => {
    const mc = mcOf(factoryImage('FELICA_LITE_S', IDM));
    expect(mc.writable.slice(0, 15).every(Boolean)).toBe(true);
    expect(mc.readProtected.slice(0, 15).some(Boolean)).toBe(false);
    expect(mc.systemBlocksWritable).toBe(true);
  });

  it('puts the write-protect mask in MC[8:10] AND MC[10:12] (1 = read-only), not MC[0]/MC[1]', () => {
    // Regression: Lite-S block write protection lives in MC[8:12], polarity 1 =
    // protected. The old model (MC[0]/MC[1], 1 = writable) did nothing on real cards.
    const mc = mcOf(factoryImage('FELICA_LITE_S', IDM));
    mc.writable[5] = false; // S_PAD5 (block 0x05) read-only
    mc.writable[14] = false; // REG (block 0x0E) read-only
    const out = encodeFelicaMc(mc);
    expect(out[8] & (1 << 5)).toBe(1 << 5); // block 5 -> MC[8] bit5
    expect(out[9] & (1 << 6)).toBe(1 << 6); // block 14 (REG) -> MC[9] bit6
    expect(out[10]).toBe(out[8]); // duplicated copy
    expect(out[11]).toBe(out[9]);
    expect(out[0]).toBe(0xff); // MC[0]/MC[1] left as factory raw (NOT the write mask)
    expect(out[1]).toBe(0xff);
    const re = decodeFelicaMc(out);
    expect(re.writable[5]).toBe(false);
    expect(re.writable[14]).toBe(false);
    expect(re.writable[4]).toBe(true);
  });

  it('round-trips read-protect and system-block edits', () => {
    const mc = mcOf(factoryImage('FELICA_LITE_S', IDM));
    mc.readProtected[3] = true;
    mc.systemBlocksWritable = false;
    const re = decodeFelicaMc(encodeFelicaMc(mc));
    expect(re.readProtected[3]).toBe(true);
    expect(re.readProtected[2]).toBe(false);
    expect(re.systemBlocksWritable).toBe(false);
  });
});

describe('FeliCa identification + spec', () => {
  it('maps the FeliCa ATR standard byte 0x11 to the FELICA hint', () => {
    const atr = Uint8Array.from([0x3b, 0x8f, 0x80, 0x01, 0x80, 0x4f, 0x0c, 0xa0, 0x00, 0x00, 0x03, 0x06, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(kindHintFromAtr(atr)).toBe('FELICA');
  });

  it('maps system code 0x88B4 to FELICA_LITE_S', () => {
    expect(kindFromFelicaSystemCode(FELICA_LITE_S_SYSTEM_CODE)).toBe('FELICA_LITE_S');
    expect(kindFromFelicaSystemCode(0x0003)).toBeNull();
  });

  it('exposes a 16-unit block map (user + REG + MC) and marks only MC protected', () => {
    expect(isFelica('FELICA_LITE_S')).toBe(true);
    const spec = specFor('FELICA_LITE_S');
    expect(spec.unitCount).toBe(16);
    expect(felicaBlockOfUnit('FELICA_LITE_S', 15)).toBe(0x88); // MC
    expect(felicaBlockOfUnit('FELICA_LITE_S', 14)).toBe(0x0e); // REG
    expect(FELICA_LITE_S_BLOCK_MAP).toHaveLength(16);
    expect(isProtectedUnit('FELICA_LITE_S', 15)).toBe(true); // MC
    expect(isProtectedUnit('FELICA_LITE_S', 0)).toBe(false); // S_PAD0
    expect(felicaBlockName(0x88)).toBe('MC');
    expect(felicaBlockName(0)).toBe('S_PAD0');
  });
});
