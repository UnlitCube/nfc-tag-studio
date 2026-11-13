import { writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Shared pure-TS modules live in src/shared and are imported by main, preload and
// renderer. They must stay free of Node and DOM APIs (see src/shared/README note).
const shared = resolve(__dirname, 'src/shared');

/**
 * 出力先（out/main・out/preload・out/renderer）ごとに、束ねたモジュールの一覧を書くファイル。
 * tools/third-party-notices.mjs が第三者のライセンスの通知の正として読む。electron-builder.json の files で app.asar から外す。
 * 移植元: c:\dev\usb-kvm の electron.vite.config.ts。
 */
export const BUNDLED_MODULES_FILE = '.bundled-modules.json';

/**
 * モジュールの ID を記録の鍵にする。ビルドした PC の絶対パスは書かない。
 * - node_modules の中は、最初の node_modules/ から後ろのパッケージの場所（入れ子も含む）
 * - rollup・vite が作る仮想のモジュール（\0 で始まる）は virtual: を付ける
 * - それ以外はこのリポジトリからの相対パス
 */
export function bundledModuleKey(id: string, base: string = __dirname): string {
  const virtual = id.startsWith('\0');
  const path = (virtual ? id.slice(1) : id).split('?')[0].replace(/\\/g, '/');
  const at = path.indexOf('node_modules/');
  if (at >= 0) {
    const dir = /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/?)+/.exec(path.slice(at))?.[0].replace(/\/$/, '') ?? path.slice(at);
    return virtual ? `virtual:${dir}` : dir;
  }
  if (virtual) return `virtual:${path}`;
  return relative(base, path).replace(/\\/g, '/');
}

type ModuleRecord = Map<string, number>;

/** 出力の chunk に入ったモジュールを数える（中身が残った長さ） */
function collectModules(record: ModuleRecord): Plugin {
  return {
    name: 'nfcts-collect-modules',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        for (const [id, info] of Object.entries(item.modules)) {
          const key = bundledModuleKey(id);
          record.set(key, (record.get(key) ?? 0) + info.renderedLength);
        }
      }
    },
  };
}

function writeModules(target: string, record: ModuleRecord): Plugin {
  return {
    name: 'nfcts-write-modules',
    writeBundle(options) {
      const modules = Object.fromEntries([...record].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      const text = `${JSON.stringify({ version: 1, target, modules }, null, 2)}\n`;
      writeFileSync(join(options.dir ?? resolve(__dirname, 'out', target), BUNDLED_MODULES_FILE), text);
    },
  };
}

/**
 * ビルド（electron-vite build）は main・preload・renderer の 3 つとも minify し、sourcemap を出さない（元のソースが丸ごと入る）。
 * Vite 8 の minify は oxc（esbuild は入っていない。'esbuild' を指すとビルドが止まる）。関数とクラスの名前は rolldown の
 * output.keepNames で残す（main のログと異常終了のスタックの関数名が読める）。モジュールの一覧もビルドのときだけ書く。
 * 開発の起動（electron-vite dev。command は serve）は minify も記録もしない。
 */
export default defineConfig(({ command }) => {
  const release = command === 'build';
  const minify = release ? ({ minify: 'oxc', sourcemap: false } as const) : { sourcemap: false };
  const output = release ? { output: { keepNames: true } } : {};
  const recorded = (target: string): Plugin[] => {
    if (!release) return [];
    const record: ModuleRecord = new Map();
    return [collectModules(record), writeModules(target, record)];
  };
  return {
    main: {
      plugins: recorded('main'),
      build: {
        ...minify,
        rollupOptions: {
          ...output,
          input: resolve(__dirname, 'src/main/index.ts'),
          // koffi is a native addon resolved at runtime; never bundle it.
          external: ['koffi'],
        },
      },
      resolve: { alias: { '@shared': shared } },
    },
    preload: {
      plugins: recorded('preload'),
      build: {
        ...minify,
        rollupOptions: { ...output, input: resolve(__dirname, 'src/preload/index.ts') },
      },
      resolve: { alias: { '@shared': shared } },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      build: {
        ...minify,
        rollupOptions: { ...output, input: resolve(__dirname, 'src/renderer/index.html') },
      },
      resolve: {
        alias: {
          '@shared': shared,
          '@': resolve(__dirname, 'src/renderer/src'),
        },
      },
      plugins: [react(), ...recorded('renderer')],
    },
  };
});
