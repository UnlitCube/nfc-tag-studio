// パッケージした本体（release/win-unpacked/NFC Tag Studio.exe）が起動して画面を出し、
// preload の橋と koffi（PC/SC）の読み込みが通るかを見る。release.yml の Windows のジョブと手元で使う。
//
//   node scripts/smoke-packaged.cjs [exe のパス] [--shot <png>] [--timeout <秒>]
//
// - パッケージ版はリモートデバッグを拒む（src/main/index.ts）。Playwright が繋げるよう NFCTS_E2E=1 を付ける
//   （配布物の利用者の環境には無い変数）。
// - パッケージ版は NFCTS_NO_PCSC を無視して PC/SC を使う（D8）。CI のランナーにはリーダーが無いので
//   「リーダーなし」で起動する。手元で流すと、つながっているリーダーの上のタグを自動で読み取る（読み取りだけ。書き込みはしない）。
// - 終了コード: 0 = 画面が出た / 1 = 失敗（理由を出す）
const { _electron: electron } = require('@playwright/test');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const os = require('node:os');

function parseArgs(argv) {
  const out = { exe: resolve(__dirname, '..', 'release', 'win-unpacked', 'NFC Tag Studio.exe'), shot: null, timeout: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shot') out.shot = resolve(argv[++i]);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`知らない引数です: ${a}`);
    else out.exe = resolve(a);
  }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout は正の秒数');
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.exe)) throw new Error(`本体がありません: ${args.exe}（先に npm run dist:win か npm run dist:dir）`);
  const userData = mkdtempSync(join(os.tmpdir(), 'nfcts-packaged-'));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const u = k.toUpperCase();
    if (v === undefined || u === 'ELECTRON_RUN_AS_NODE' || u.startsWith('NFCTS_')) continue;
    env[k] = v;
  }
  env.NFCTS_E2E = '1';
  const errors = [];
  const app = await electron.launch({ executablePath: args.exe, args: [`--user-data-dir=${userData}`], env, timeout: args.timeout * 1000 });
  try {
    const page = await app.firstWindow({ timeout: args.timeout * 1000 });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
    });
    await page.waitForSelector('.app-shell', { timeout: args.timeout * 1000 });
    const info = await page.evaluate(async () => ({
      title: document.title,
      bridge: typeof window.nfcBridge,
      navItems: document.querySelectorAll('.nav-item').length,
      app: await window.nfcBridge.getAppInfo().catch((e) => ({ error: String(e) })),
      reader: await window.nfcBridge.getReaderStatus().catch((e) => ({ error: String(e) })),
    }));
    const packaged = await app.evaluate(({ app: a }) => ({ isPackaged: a.isPackaged, version: a.getVersion(), name: a.getName() }));
    console.log('[packaged] main:', JSON.stringify(packaged));
    console.log('[packaged] page:', JSON.stringify({ title: info.title, bridge: info.bridge, navItems: info.navItems }));
    // 中身（リーダー名・UID）は出さない。PC/SC が読み込めたか（service）だけを出す
    const r = info.reader && info.reader.ok ? info.reader.value : null;
    console.log('[packaged] reader service:', r ? `${r.service}${r.serviceMessage ? ` (${r.serviceMessage})` : ''}` : JSON.stringify(info.reader));
    if (args.shot) {
      await page.screenshot({ path: args.shot });
      console.log('[packaged] screenshot:', args.shot);
    }
    const problems = [];
    if (!packaged.isPackaged) problems.push('app.isPackaged が偽（パッケージ版ではない）');
    if (info.bridge !== 'object') problems.push('preload の橋（window.nfcBridge）が無い');
    if (info.navItems < 5) problems.push(`メニューの項目が少ない（${info.navItems}）`);
    if (!r) problems.push(`リーダーの状態を取れない: ${JSON.stringify(info.reader)}`);
    // 'unavailable' は PC/SC のライブラリ（koffi → winscard.dll）を読み込めなかったとき。リーダーが無いランナーは 'no-readers' か 'ok'
    if (r && r.service === 'unavailable') problems.push(`PC/SC を読み込めない（koffi か winscard.dll）: ${r.serviceMessage ?? ''}`);
    if (errors.length) problems.push(`画面のエラー:\n  ${errors.join('\n  ')}`);
    if (problems.length) {
      for (const p of problems) console.error(`[packaged] NG: ${p}`);
      process.exitCode = 1;
    } else {
      console.log('[packaged] ok');
    }
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
    try {
      app.process().kill();
    } catch {}
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {}
  }
})().catch((e) => {
  console.error('[packaged] FAILED', e && e.message ? e.message : e);
  process.exit(1);
});
