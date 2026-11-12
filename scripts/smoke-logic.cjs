// Stopgap logic smoke test, used because vitest cannot start in this environment
// (trivial tests fail with "Cannot read properties of undefined (reading 'config')";
// vite 8 + vitest worker incompatibility, see CLAUDE.md). This is NOT a vitest
// replacement - it compiles src/shared with tsc and asserts the critical / recently
// fixed pure logic (FeliCa MC masks, NTAG lock state) plus core sanity. Run:
//   npm run test:smoke
// When vitest works again, `npm run unit` is the real suite; keep this as a fast guard.
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfc-smoke-'));
try {
  const tsc = require.resolve('typescript/bin/tsc');
  const files = ['src/shared/felica.ts', 'src/shared/tag/ntag.ts', 'src/shared/tags.ts', 'src/shared/hex.ts', 'src/shared/types.ts'];
  execFileSync(
    process.execPath,
    [tsc, '--rootDir', 'src/shared', '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop', ...files],
    { cwd: root, stdio: 'inherit' },
  );

  const { decodeFelicaMc, encodeFelicaMc } = require(path.join(outDir, 'felica.js'));
  const { readNtagLockState, buildNtagLockUserAreaWrites, readNtagConfig } = require(path.join(outDir, 'tag', 'ntag.js'));
  const { factoryImage, specFor, ntagPages, imageSize, kindFromCc, kindFromVersion, kindFromFelicaSystemCode, FELICA_LITE_S_SYSTEM_CODE } = require(path.join(outDir, 'tags.js'));
  const { bytesToHex, hexToBytes } = require(path.join(outDir, 'hex.js'));

  let pass = 0;
  const fails = [];
  const ok = (name, cond) => (cond ? pass++ : fails.push(name));
  const arr = (x) => Array.from(x);
  const eq = (a, b) => arr(a).length === arr(b).length && arr(a).every((v, i) => v === arr(b)[i]);

  // --- hex ---
  ok('hex round-trip', bytesToHex(hexToBytes('04A1B2C3')) === '04A1B2C3');

  // --- identification ---
  ok('kindFromCc NTAG213', kindFromCc(Uint8Array.from([0xe1, 0x10, 0x12, 0x00])) === 'NTAG213');
  ok('kindFromCc NTAG215', kindFromCc(Uint8Array.from([0xe1, 0x10, 0x3e, 0x00])) === 'NTAG215');
  ok('kindFromVersion NTAG216', kindFromVersion(Uint8Array.from([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x13, 0x03])) === 'NTAG216');
  ok('kindFromFelicaSystemCode 0x88B4', kindFromFelicaSystemCode(FELICA_LITE_S_SYSTEM_CODE) === 'FELICA_LITE_S');
  ok('kindFromFelicaSystemCode other null', kindFromFelicaSystemCode(0x0003) === null);

  // --- factory images ---
  ok('NTAG213 image size 180', imageSize('NTAG213') === 180);
  ok('MIFARE 4K image size 4096', imageSize('MIFARE_CLASSIC_4K') === 4096);

  // --- FeliCa MC (fixed: masks at MC[6:12], MC[2]=system write enable) ---
  const IDM = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const mcUnit = specFor('FELICA_LITE_S').unitCount - 1;
  const mcOf = (img) => decodeFelicaMc(img.subarray(mcUnit * 16, mcUnit * 16 + 16));
  {
    const img = factoryImage('FELICA_LITE_S', IDM);
    ok('FeliCa factory MC = FF FF FF 01 07', eq(img.subarray(mcUnit * 16, mcUnit * 16 + 5), [0xff, 0xff, 0xff, 0x01, 0x07]));
    const mc = mcOf(img);
    ok('FeliCa factory all writable', mc.writable.slice(0, 15).every(Boolean));
    ok('FeliCa factory none read-protected', !mc.readProtected.slice(0, 15).some(Boolean));
    ok('FeliCa factory systemBlocksWritable', mc.systemBlocksWritable === true);
  }
  {
    const mc = mcOf(factoryImage('FELICA_LITE_S', IDM));
    mc.writable[5] = false;
    mc.writable[14] = false;
    const out = encodeFelicaMc(mc);
    ok('FeliCa write mask block5 -> MC[8] bit5', (out[8] & (1 << 5)) === (1 << 5));
    ok('FeliCa write mask REG(14) -> MC[9] bit6', (out[9] & (1 << 6)) === (1 << 6));
    ok('FeliCa mask duplicated MC[10]/MC[11]', out[10] === out[8] && out[11] === out[9]);
    ok('FeliCa MC[0]/MC[1] left as factory (not the mask)', out[0] === 0xff && out[1] === 0xff);
    const re = decodeFelicaMc(out);
    ok('FeliCa decode writable[5]=false', re.writable[5] === false);
    ok('FeliCa decode writable[14]=false', re.writable[14] === false);
    ok('FeliCa decode writable[4]=true', re.writable[4] === true);
  }

  // --- NTAG lock state (fixed: byte3=0xBD is not a lock bit, gran=2) ---
  const NUID = Uint8Array.from([0x04, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6]);
  const p213 = ntagPages('NTAG213');
  {
    const data = factoryImage('NTAG213', NUID);
    data.set([0x00, 0x00, 0x00, 0xbd], p213.dynLock * 4);
    const st = readNtagLockState('NTAG213', data);
    ok('NTAG factory byte3=0xBD -> blockLocked false', st.blockLocked === false);
    ok('NTAG factory -> no locked pages', st.lockedPages.length === 0);
  }
  {
    const data = factoryImage('NTAG213', NUID);
    data.set([0x01, 0x00, 0x00, 0xbd], p213.dynLock * 4);
    const st = readNtagLockState('NTAG213', data);
    ok('NTAG213 dyn byte0 bit0 locks page 16', st.lockedPages.includes(16));
    ok('NTAG213 dyn byte0 bit0 locks page 17', st.lockedPages.includes(17));
    ok('NTAG213 dyn byte0 bit0 NOT page 18', !st.lockedPages.includes(18));
    ok('NTAG213 single page-lock bit -> blockLocked false', st.blockLocked === false);
  }
  {
    const img = factoryImage('NTAG213', NUID);
    const writes = buildNtagLockUserAreaWrites('NTAG213', img);
    const locked = new Uint8Array(img);
    for (const w of writes) locked.set(w.data, w.unit * 4);
    const st = readNtagLockState('NTAG213', locked);
    ok('NTAG lock-all ccLocked', st.ccLocked === true);
    ok('NTAG lock-all blockLocked', st.blockLocked === true);
    ok('NTAG lock-all page 16 & 39', st.lockedPages.includes(16) && st.lockedPages.includes(39));
  }

  // --- NTAG config factory sanity ---
  {
    const cfg = readNtagConfig('NTAG213', factoryImage('NTAG213', NUID));
    ok('NTAG config factory AUTH0=0xFF', cfg.auth0 === 0xff);
    ok('NTAG config factory PROT=false CFGLCK=false', cfg.prot === false && cfg.cfgLock === false);
    ok('NTAG config factory strongModulation=true', cfg.strongModulation === true);
  }

  console.log(`\nsmoke-logic: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  FAIL: ' + f);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
