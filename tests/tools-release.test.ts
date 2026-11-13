// 公開・リリースの道具（tools/）と、ワークフロー・版・ビルドの設定の番人。
// - CHANGELOG の切り出し（Release の本文）・ライセンスの通知の判定・文書の検査・Pages の生成
// - ワークフローの版の固定（runs-on・Action の SHA・Node の版）・権限・timeout
// - 版の一致（package.json・lock・CHANGELOG）、配布物の名前、ビルドの minify と keepNames
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs の道具（型の宣言は無い）
import { changelogSection } from '../tools/changelog-section.mjs';
// @ts-expect-error -- .mjs の道具
import { classifyModule, forDistPlatform, isPermissive } from '../tools/third-party-notices.mjs';
// @ts-expect-error -- .mjs の道具
import { checkLink, extractLinks, personalHits } from '../tools/check-docs.mjs';
// @ts-expect-error -- .mjs の道具
import { buildSite, MARKER, relativeRefs } from '../tools/build-site.mjs';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('CHANGELOG の切り出し（tools/changelog-section.mjs）', () => {
  it('いまの CHANGELOG から、package.json の版の節を Release の条件（## vNext が空）で切り出せる', () => {
    const r = changelogSection(read('CHANGELOG.md'), pkg.version, { requireEmptyNext: true });
    expect(r.problems).toEqual([]);
    expect(r.body).toContain('###');
    expect(r.body.length).toBeGreaterThan(200);
  });

  const good = '# t\n\n## vNext\n\n## v1.2.3 (2026-01-02)\n\n### 修正\n\n- a\n';
  it('正しい形は通る', () => {
    expect(changelogSection(good, '1.2.3', { requireEmptyNext: true }).problems).toEqual([]);
  });
  it('全角の括弧の見出しは止める', () => {
    expect(changelogSection(good.replace('(2026-01-02)', '（2026-01-02）'), '1.2.3').problems.length).toBeGreaterThan(0);
  });
  it('## vNext が無いと止める', () => {
    expect(changelogSection(good.replace('## vNext\n', ''), '1.2.3').problems.length).toBeGreaterThan(0);
  });
  it('リリースのとき、## vNext に項目が残っていれば止める', () => {
    const pending = good.replace('## vNext\n', '## vNext\n\n- 移し忘れ\n');
    expect(changelogSection(pending, '1.2.3', { requireEmptyNext: true }).problems.length).toBeGreaterThan(0);
    expect(changelogSection(pending, '1.2.3').problems).toEqual([]);
  });
  it('見出しだけで項目が無い節は止める', () => {
    expect(changelogSection('## vNext\n\n## v1.2.3 (2026-01-02)\n\n### 修正\n', '1.2.3').problems.length).toBeGreaterThan(0);
  });
});

describe('ライセンスの通知の判定（tools/third-party-notices.mjs）', () => {
  it('許可の一覧の SPDX の式を判定する', () => {
    expect(isPermissive('MIT')).toBe(true);
    expect(isPermissive('ISC')).toBe(true);
    expect(isPermissive('(MIT OR GPL-3.0)')).toBe(true);
    expect(isPermissive('GPL-3.0')).toBe(false);
    expect(isPermissive('MIT AND GPL-3.0')).toBe(false);
    expect(isPermissive('SEE LICENSE IN LICENSE')).toBe(false);
  });
  it('koffi のプリビルドは配布先（win32-x64）向けだけを載せる', () => {
    expect(forDistPlatform({ os: ['win32'], cpu: ['x64'] })).toBe(true);
    expect(forDistPlatform({ os: ['linux'], cpu: ['x64'] })).toBe(false);
    expect(forDistPlatform({ os: ['win32'], cpu: ['arm64'] })).toBe(false);
    expect(forDistPlatform({})).toBe(true);
  });
  it('モジュールの一覧の鍵を分ける（rolldown の補助・パッケージ・知らない仮想のモジュール）', () => {
    expect(classifyModule('virtual:rolldown/runtime.js').kind).toBe('rolldown');
    expect(classifyModule('node_modules/react')).toEqual({ kind: 'package', dir: 'node_modules/react' });
    expect(classifyModule('node_modules/@scope/pkg/node_modules/inner').kind).toBe('package');
    expect(classifyModule('src/main/index.ts').kind).toBe('own');
    expect(classifyModule('virtual:something-else').kind).toBe('unknown');
    expect(classifyModule('../outside/file.ts').kind).toBe('unknown');
  });
});

describe('文書の検査（tools/check-docs.mjs）', () => {
  it('個人の環境の値の形を見つける', () => {
    // 値を連結で作る（このファイル自身が docs:check の個人の環境の値の検査に当たらないように）
    const bad = [
      'C:\\' + 'Users\\taro\\Desktop',
      'c:/' + 'Users/hanako/x',
      '/c/' + 'Users/taro/dev',
      'mail me: someone@' + 'gmail.com',
      'AppData\\Local\\Temp\\' + 'claude\\abc',
      '/home/' + 'taro/work/',
    ];
    for (const line of bad) expect(personalHits(line), line).toHaveLength(1);
  });
  it('置き場所の書き方（<名前>・%APPDATA%・Public・例のドメイン）は通す', () => {
    const ok = ['C:\\Users\\<ユーザー名>\\Desktop', '%APPDATA%\\NFC Tag Studio', 'C:\\Users\\Public', 'support@example.com', '/home/runner/work/x'];
    for (const line of ok) expect(personalHits(line), line).toEqual([]);
  });
  it('リンクを取り出す（コードの中は除く）', () => {
    const links = extractLinks('[a](x.md) ![b](img/y.png) [[ページ]] [[表示|別のページ]] `[c](not-a-link.md)`\n<img src="z.png">');
    expect(links.map((l: { target: string }) => l.target)).toEqual(['x.md', 'img/y.png', 'ページ', '別のページ', 'z.png']);
  });
  it('無いファイル・無い Wiki のページ・リポジトリに無いパスを見つけ、あるものは通す', () => {
    const readme = path.join(ROOT, 'README.md');
    const wikiHome = path.join(ROOT, 'wiki', 'Home.md');
    expect(checkLink(ROOT, readme, { target: 'LICENSE', kind: 'md' })).toBeNull();
    expect(checkLink(ROOT, readme, { target: 'NO-SUCH-FILE.md', kind: 'md' })).not.toBeNull();
    expect(checkLink(ROOT, wikiHome, { target: 'インストール', kind: 'wiki' })).toBeNull();
    expect(checkLink(ROOT, wikiHome, { target: '無いページ', kind: 'wiki' })).not.toBeNull();
    expect(checkLink(ROOT, readme, { target: 'https://raw.githubusercontent.com/UnlitCube/nfc-tag-studio/master/docs/images/ja/home.png', kind: 'md' })).toBeNull();
    expect(checkLink(ROOT, readme, { target: 'https://raw.githubusercontent.com/UnlitCube/nfc-tag-studio/master/docs/images/ja/none.png', kind: 'md' })).not.toBeNull();
    expect(checkLink(ROOT, readme, { target: 'https://github.com/UnlitCube/nfc-tag-studio/wiki/%E3%82%A4%E3%83%B3%E3%82%B9%E3%83%88%E3%83%BC%E3%83%AB', kind: 'md' })).toBeNull();
    expect(checkLink(ROOT, readme, { target: 'https://example.com/anything', kind: 'md' })).toBeNull();
  });
});

describe('Pages のサイト（tools/build-site.mjs）', () => {
  it('相対の参照だけを取り出す', () => {
    expect(relativeRefs('<a href="https://x">x</a><img src="images/a.png"><a href="#top">t</a><link href="assets/s.css">')).toEqual(['images/a.png', 'assets/s.css']);
  });
  it('一時フォルダに作れ、版が入り、参照が切れていない', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nfcts-site-'));
    try {
      const r = buildSite(ROOT, path.join(out, 'site'));
      expect(r.problems).toEqual([]);
      expect(r.pages).toBeGreaterThanOrEqual(2);
      const html = fs.readFileSync(path.join(out, 'site', 'index.html'), 'utf8');
      expect(html).toContain(`v${pkg.version}`);
      expect(html).not.toContain('{{VERSION}}');
      expect(fs.existsSync(path.join(out, 'site', MARKER))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
  it('この道具が作ったのでない、空でないフォルダは消さずに止める', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nfcts-site-'));
    try {
      fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
      const r = buildSite(ROOT, out);
      expect(r.problems.length).toBe(1);
      expect(fs.existsSync(path.join(out, 'keep.txt'))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ワークフロー（YAML は読み込まず行で見る。# vX.Y.Z のコメントは YAML の読み込みで消えるため）
// ---------------------------------------------------------------------------

const WF_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

/** jobs: の直下（2 つの空白）の名前ごとの行 */
function jobBlocks(text: string): Map<string, string[]> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      current = m[1];
      jobs.set(current, []);
    } else if (/^\S/.test(line)) break;
    else if (current) jobs.get(current)!.push(line);
  }
  return jobs;
}

describe('ワークフローの番人（.github/workflows）', () => {
  it('ワークフローがある（ci・release・pages・wiki）', () => {
    expect(workflows.sort()).toEqual(['ci.yml', 'pages.yml', 'release.yml', 'wiki.yml']);
  });

  for (const file of workflows) {
    const text = fs.readFileSync(path.join(WF_DIR, file), 'utf8');
    describe(file, () => {
      it('既定の権限は空（permissions: {}）', () => {
        expect(text).toMatch(/^permissions: \{\}\s*$/m);
      });
      it('runs-on は版を固定する（-latest を使わない）', () => {
        const runsOn = [...text.matchAll(/runs-on:\s*(\S+)/g)].map((m) => m[1]);
        expect(runsOn.length).toBeGreaterThan(0);
        for (const r of runsOn) expect(r).toMatch(/^(ubuntu-24\.04|windows-2025)$/);
      });
      it('Action はコミットの SHA で固定し、行末に # vX.Y.Z を書く', () => {
        const uses = text.split(/\r?\n/).filter((l) => /^\s*-?\s*uses:/.test(l));
        expect(uses.length).toBeGreaterThan(0);
        for (const l of uses) expect(l.trim()).toMatch(/^-?\s*uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      });
      it('Node の版は .node-version から読む（浮動の node-version を書かない）', () => {
        expect(text).not.toMatch(/^\s*node-version:/m);
        if (/setup-node@/.test(text)) expect(text).toMatch(/node-version-file: \.node-version/);
      });
      it('すべてのジョブに timeout-minutes がある', () => {
        const jobs = jobBlocks(text);
        expect(jobs.size).toBeGreaterThan(0);
        for (const [name, body] of jobs) expect(body.join('\n'), `${file} の ${name}`).toMatch(/timeout-minutes: \d+/);
      });
      it('checkout は資格情報を残さない（persist-credentials: false）', () => {
        const n = (text.match(/actions\/checkout@/g) ?? []).length;
        expect((text.match(/persist-credentials: false/g) ?? []).length).toBe(n);
      });
    });
  }

  it('Release を作る手順はタグの push のときだけ（手動実行で本物の Release を出さない）', () => {
    const text = fs.readFileSync(path.join(WF_DIR, 'release.yml'), 'utf8');
    const i = text.indexOf('gh release create');
    expect(i).toBeGreaterThan(0);
    const step = text.slice(text.lastIndexOf('- name:', i), i);
    expect(step).toContain("if: github.event_name == 'push' && github.ref_type == 'tag'");
  });

  it('Dependabot が Action の SHA を更新する', () => {
    expect(read('.github/dependabot.yml')).toMatch(/package-ecosystem: github-actions/);
  });
});

// ---------------------------------------------------------------------------
// 版・配布物・ビルド
// ---------------------------------------------------------------------------

describe('版と配布物', () => {
  it('package.json と package-lock.json の版が一致する', () => {
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
  it('.node-version は engines の下限を満たす', () => {
    const v = read('.node-version').trim().split('.').map(Number);
    const min = /(\d+)\.(\d+)\.(\d+)/.exec(pkg.engines.node)!.slice(1).map(Number);
    const cmp = v[0] - min[0] || v[1] - min[1] || v[2] - min[2];
    expect(cmp).toBeGreaterThanOrEqual(0);
  });
  it('配布物の名前に空白が無く、LICENSE と通知を同梱する', () => {
    const eb = JSON.parse(read('electron-builder.json'));
    for (const name of [eb.win.artifactName, eb.portable.artifactName]) expect(name).toMatch(/^[0-9A-Za-z._${}-]+$/);
    const extra = eb.extraResources.map((e: { to: string }) => e.to);
    expect(extra).toEqual(expect.arrayContaining(['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']));
    expect(eb.files).toEqual(expect.arrayContaining(['!out/**/.bundled-modules.json', '!**/*.map']));
  });
  it('release.yml が待つ名前は electron-builder.json の名前と同じ', () => {
    const eb = JSON.parse(read('electron-builder.json'));
    const expand = (t: string) => t.replace('${version}', '$V').replace('${arch}', 'x64').replace('${ext}', '');
    const text = fs.readFileSync(path.join(WF_DIR, 'release.yml'), 'utf8');
    expect(text).toContain(`"${expand(eb.portable.artifactName)}exe"`);
    expect(text).toContain(`"${expand(eb.win.artifactName)}zip"`);
  });
});

describe('ビルドの設定（electron.vite.config.ts）', () => {
  it('ビルドでは 3 つとも minify（oxc）・sourcemap なし・名前を残す。開発の起動では minify しない', async () => {
    const mod = await import('../electron.vite.config');
    const factory = mod.default as unknown as (env: { command: string; mode: string }) => Record<string, { build: { minify?: unknown; sourcemap?: unknown; rollupOptions?: { output?: { keepNames?: boolean } } } }>;
    const built = factory({ command: 'build', mode: 'production' });
    for (const target of ['main', 'preload', 'renderer']) {
      expect(built[target].build.minify, target).toBe('oxc');
      expect(built[target].build.sourcemap, target).toBe(false);
      expect(built[target].build.rollupOptions?.output?.keepNames, target).toBe(true);
    }
    const dev = factory({ command: 'serve', mode: 'development' });
    for (const target of ['main', 'preload', 'renderer']) expect(dev[target].build.minify, target).toBeUndefined();
  });
});
