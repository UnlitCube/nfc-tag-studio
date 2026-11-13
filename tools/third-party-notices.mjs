/**
 * 配布物に入る第三者のソフトのライセンスの通知（THIRD_PARTY_NOTICES.txt）を作る。手で書かない。
 * electron-builder.json の extraResources が resources/THIRD_PARTY_NOTICES.txt として同梱する。
 * c:\dev\usb-kvm の tools/third-party-notices.mjs から、アプリの分だけを移した（インストーラーは無い）。
 *
 *   npm run build && node tools/third-party-notices.mjs   書き出す（npm run notices）
 *   node tools/third-party-notices.mjs --check            今のビルドと node_modules から作ったものと一致するか。古ければ終了コード 1（npm run notices:check）
 *
 * 何を載せるか:
 * - 束ねたパッケージ: npm run build（electron-vite build）が out/main・out/preload・out/renderer に書くモジュールの一覧
 *   （.bundled-modules.json。electron.vite.config.ts の collectModules）から取る。rollup が実際に出力へ入れたモジュールなので、
 *   package.json の依存から推すより確か（react・zustand・lucide-react は devDependencies にあり、本番の依存には出ない）
 * - 本番の依存（package.json の dependencies と、その dependencies・optionalDependencies をたどったもの）。app.asar の node_modules に入る。
 *   koffi のプリビルド（@koromix/koffi-<os>-<cpu>）は配布先の win32-x64 の 1 つだけを載せる。CI の Linux では win32-x64 が
 *   node_modules に無いので、版とライセンスは package-lock.json から、ライセンスの文は koffi のものを使う（同じ作者・同じ MIT）
 * - koffi のネイティブのモジュールに組み込まれたヘッダ（koffi/vendor の node-addon-api・node-api-headers）
 * - ビルドの道具が出力に書く補助のコード（vite の commonjs の包みと補助・rollup の interop・esbuild の __name）
 * - Electron と Chromium（electron-builder が LICENSE.electron.txt と LICENSES.chromium.html を入れる）
 * - ポータブル版の exe の殻（NSIS 3 と System・StdUtils・nsis7z の plug-in、elevate.exe）。版は app-builder-lib の取り寄せの定義から読む
 *
 * 止める（終了コード 1）:
 * - 一覧が無い・src や package-lock.json より古い（先に npm run build）
 * - 一覧に、どのパッケージか分からないモジュール（知らない仮想のモジュール・リポジトリと node_modules の外）がある
 * - npm のパッケージのライセンスが許可の一覧（PERMISSIVE）の外。GPL・AGPL（ライセンスの文に GNU General Public License・
 *   GNU Affero General Public License の見出し）も止める。LGPL の plug-in は npm ではないので手で載せる（build/licenses）
 * - --check で、書いてあるものと作ったものが違う（改行の CRLF と LF は区別しない）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectRun } from './run-direct.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'
/** electron.vite.config.ts の BUNDLED_MODULES_FILE と同じ名前 */
export const BUNDLED_MODULES_FILE = '.bundled-modules.json'
export const TARGETS = ['main', 'preload', 'renderer']
/** 載せる手書きのライセンスの文（リポジトリの build/licenses） */
export const LICENSE_DIR = 'build/licenses'
/** 配布する OS と CPU。koffi のプリビルドはこれに合うものだけを載せる */
export const DIST_PLATFORM = { os: 'win32', cpu: 'x64' }

/**
 * npm のパッケージに許すライセンス（許可の一覧）。ここに無いものは止める（禁止の一覧だと MPL・CC-BY-SA・SEE LICENSE IN … が素通りする）。
 * SPDX の式は A OR B なら 1 つでも許せばよく、A AND B なら全部が要る
 */
export const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0', 'BlueOak-1.0.0'])

export function isPermissive(expr) {
  const e = String(expr).trim().replace(/^\((.*)\)$/, '$1').trim()
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some(isPermissive)
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every(isPermissive)
  return PERMISSIVE.has(e)
}

/** ライセンスの文の GPL・AGPL の見出し（LGPL の「GNU LESSER GENERAL …」は当たらない） */
export const COPYLEFT_TEXT = /\bGNU\s+(?:AFFERO\s+)?GENERAL\s+PUBLIC\s+LICENSE\b/i

/** ライセンスの文は 1 つ 200,000 字で打ち切る（集約のファイルで通知が膨らむのを防ぐ） */
const LICENSE_TEXT_MAX = 200_000

/**
 * ビルドの道具。出力に入るのは道具が書く補助のコードだけなので、本体のライセンスの節だけを載せる
 * （vite の LICENSE.md は、道具が中に束ねた依存のライセンスを後ろに並べる。それは出力に入らない）。
 * Vite 8 は rolldown で束ね、oxc で縮める（esbuild・rollup は使わない）。出力に入るのは rolldown の実行時の補助
 * （virtual:rolldown/runtime.js。keepNames の __name など）。vite の仮想のモジュール（virtual:vite/…）が出力に入ったときだけ vite も載せる。
 * when は readBundledModules が返す印の名前
 */
export const BUILD_TOOLS = [
  {
    name: 'rolldown',
    from: '.',
    when: 'rolldownRuntime',
    note: 'bundler; its runtime helpers (virtual:rolldown/runtime.js, including __name for keepNames) are part of the bundles',
    parts: null,
  },
  {
    name: 'vite',
    from: '.',
    when: 'viteHelpers',
    note: 'build tool; its helper modules (virtual:vite/...) are part of the renderer bundle',
    parts: [{ until: '# Licenses of bundled dependencies' }],
  },
]

/** koffi のネイティブのモジュール（koffi.node）に、ビルドのときに組み込まれたもの。配布物には koffi/vendor は入れない（electron-builder.json） */
export const KOFFI_EMBEDDED = [
  { name: 'node-addon-api', dir: 'vendor/node-addon-api', license: 'MIT', source: 'https://github.com/nodejs/node-addon-api' },
  { name: 'node-api-headers', dir: 'vendor/node-api-headers', license: 'MIT', source: 'https://github.com/nodejs/node-api-headers' },
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

const toLf = (text) => text.replace(/\r\n?/g, '\n')

/** パッケージのディレクトリを、それを要求した側のディレクトリから node の規則で探す */
export function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * モジュールの一覧の鍵を分ける（electron.vite.config.ts の bundledModuleKey が作る）。
 * - package: node_modules/<名前>（入れ子なら node_modules/a/node_modules/b）
 * - wrapper: vite が CommonJS のパッケージに付ける包み（virtual:node_modules/…）。パッケージと vite の両方
 * - vite: vite の仮想のモジュール（virtual:commonjsHelpers.js・virtual:vite/…）
 * - rolldown: rolldown の実行時の補助（virtual:rolldown/…）
 * - own: リポジトリのファイル（src/… や package.json）
 * - unknown: どれでもない（知らない仮想のモジュール・リポジトリの外）。止める
 */
export function classifyModule(key) {
  if (/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(key)) return { kind: 'package', dir: key }
  if (key.startsWith('virtual:')) {
    const rest = key.slice('virtual:'.length)
    if (/^node_modules\//.test(rest)) return { kind: 'wrapper', dir: rest }
    if (rest === 'commonjsHelpers.js' || rest.startsWith('vite/')) return { kind: 'vite' }
    if (rest.startsWith('rolldown/')) return { kind: 'rolldown' }
    return { kind: 'unknown' }
  }
  if (key.startsWith('../') || key.startsWith('/') || /^[A-Za-z]:/.test(key) || key.includes('node_modules')) return { kind: 'unknown' }
  return { kind: 'own' }
}

function newestMtime(path) {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let newest = 0
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)))
  return newest
}

/**
 * out/*\/.bundled-modules.json を読み、束ねたパッケージのディレクトリ（リポジトリからの相対）と、どの出力に入ったかを返す
 */
export function readBundledModules(root) {
  const problems = []
  const packages = new Map() // dir → { length, targets: Set }
  let viteHelpers = false
  let rolldownRuntime = false
  let oldest = Infinity
  for (const target of TARGETS) {
    const rel = `out/${target}/${BUNDLED_MODULES_FILE}`
    const path = join(root, rel)
    if (!existsSync(path)) {
      problems.push(`${rel} がありません。先に npm run build を流してください`)
      continue
    }
    let data
    try {
      data = readJson(path)
    } catch {
      problems.push(`${rel} を読めません`)
      continue
    }
    oldest = Math.min(oldest, statSync(path).mtimeMs)
    if (data.version !== 1 || data.target !== target || typeof data.modules !== 'object' || data.modules === null) {
      problems.push(`${rel} の形が違います（version 1・target ${target}・modules）`)
      continue
    }
    for (const [key, length] of Object.entries(data.modules)) {
      const kind = classifyModule(key)
      if (kind.kind === 'unknown') {
        problems.push(`${rel}: どのパッケージか分からないモジュールがあります: ${key}`)
      } else if (kind.kind === 'vite') {
        viteHelpers = true
      } else if (kind.kind === 'rolldown') {
        rolldownRuntime = true
      } else if (kind.kind === 'wrapper' || kind.kind === 'package') {
        if (kind.kind === 'wrapper') viteHelpers = true
        const entry = packages.get(kind.dir) ?? { length: 0, targets: new Set() }
        if (kind.kind === 'package') entry.length += Number(length) || 0
        entry.targets.add(target)
        packages.set(kind.dir, entry)
      }
    }
  }
  const sources = ['src', 'package-lock.json', 'package.json', 'electron.vite.config.ts'].map((p) => newestMtime(join(root, p)))
  if (problems.length === 0 && Math.max(...sources) > oldest) {
    problems.push('out のモジュールの一覧が src・package.json・package-lock.json・electron.vite.config.ts より古いです。先に npm run build を流してください')
  }
  const bundled = [...packages].filter(([, e]) => e.length > 0).map(([dir, e]) => ({ dir, targets: [...e.targets].sort() }))
  return { problems, bundled, viteHelpers, rolldownRuntime }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

function homepageOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return String(repo ?? pkg.homepage ?? '')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
}

/** パッケージのディレクトリのライセンスの文（LICENSE・LICENCE・COPYING・NOTICE）。parts があれば節だけを抜く */
export function licenseText(dir, parts = null) {
  const files = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(f))
    .sort()
  let text = files.map((f) => toLf(readFileSync(join(dir, f), 'utf8')).trim()).join('\n\n')
  if (parts && text) {
    const lines = text.split('\n')
    const picked = []
    for (const part of parts) {
      if (part.until) {
        const end = lines.findIndex((l) => l.trim() === part.until)
        if (end < 0) throw new Error(`${dir} のライセンスの文に「${part.until}」がありません（形が変わった）`)
        picked.push(lines.slice(0, end).join('\n').trim())
      } else if (part.heading) {
        const start = lines.findIndex((l) => /^## /.test(l) && l.slice(3).split(/,\s*/).includes(part.heading))
        if (start < 0) throw new Error(`${dir} のライセンスの文に ${part.heading} の節がありません（形が変わった）`)
        const end = lines.findIndex((l, i) => i > start && /^##? /.test(l))
        picked.push(lines.slice(start, end < 0 ? lines.length : end).join('\n').trim())
      }
    }
    text = picked.join('\n\n')
  }
  return text.length > LICENSE_TEXT_MAX ? `${text.slice(0, LICENSE_TEXT_MAX)}\n[... truncated ...]` : text
}

/** package-lock.json の packages（無ければ空） */
function lockPackages(root) {
  const path = join(root, 'package-lock.json')
  return existsSync(path) ? (readJson(path).packages ?? {}) : {}
}

/** lock の項目が配布先（DIST_PLATFORM）向けか。os・cpu の指定が無いものは、どの OS にも入る */
export function forDistPlatform(entry) {
  if (!entry) return true
  const ok = (list, want) => !Array.isArray(list) || list.length === 0 || list.includes(want)
  return ok(entry.os, DIST_PLATFORM.os) && ok(entry.cpu, DIST_PLATFORM.cpu)
}

/**
 * 本番の依存（package.json の dependencies）を、各パッケージの dependencies・optionalDependencies までたどる。
 * 配布先でない OS・CPU 向けの optional（koffi の他の OS のプリビルド）は載せない。配布先向けなのに node_modules に無い optional
 * （Linux の CI での @koromix/koffi-win32-x64）は、lock から版とライセンスを取り、ライセンスの文は要求した側のものを使う
 */
export function productionPackages(root) {
  const problems = []
  const lock = lockPackages(root)
  const found = new Map() // name@version → { dir | null, pkg, textDir }
  const queue = [{ dir: root, pkg: readJson(join(root, 'package.json')), self: true, textDir: null }]
  while (queue.length > 0) {
    const { dir, pkg, self, textDir } = queue.shift()
    if (!self) {
      const key = `${pkg.name}@${pkg.version}`
      if (found.has(key)) continue
      found.set(key, { dir, pkg, textDir })
    }
    if (!dir) continue
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }
    for (const name of Object.keys(deps).sort()) {
      const optional = Boolean(pkg.optionalDependencies?.[name])
      const lockEntry = lock[`node_modules/${name}`]
      if (optional && !forDistPlatform(lockEntry)) continue
      // optional（プリビルド）は、自分のライセンスの文が無ければ要求した側の文を使う。Windows（入っている）と Linux（入っていない）で同じ通知にする
      const parentText = optional ? dir : null
      const d = resolvePackageDir(name, dir)
      if (d === null) {
        if (optional && lockEntry?.version) {
          const synthetic = { name, version: lockEntry.version, license: lockEntry.license ?? 'UNKNOWN', repository: pkg.repository }
          queue.push({ dir: null, pkg: synthetic, self: false, textDir: parentText })
          continue
        }
        if (optional) continue
        problems.push(`${pkg.name ?? 'package.json'} の依存 ${name} が node_modules にありません`)
        continue
      }
      queue.push({ dir: d, pkg: readJson(join(d, 'package.json')), self: false, textDir: parentText })
    }
  }
  return { problems, items: [...found.values()] }
}

/** app-builder-lib が取り寄せる NSIS の版（ポータブル版の exe の殻）。形が変わったら止める（通知の文が古くなる） */
export function nsisToolset(root) {
  const path = join(root, 'node_modules', 'app-builder-lib', 'out', 'toolsets', 'windows.js')
  if (!existsSync(path)) return { problem: 'node_modules/app-builder-lib/out/toolsets/windows.js がありません（electron-builder の NSIS の版を読めません）' }
  const text = readFileSync(path, 'utf8')
  const nsis = /getBinFromUrl\)\("nsis-(\d+(?:\.\d+)+)"/.exec(text)?.[1]
  const resources = /getBinFromUrl\)\("nsis-resources-(\d+(?:\.\d+)+)"/.exec(text)?.[1]
  if (!nsis || !resources) return { problem: 'app-builder-lib の NSIS の取り寄せの定義の形が変わりました。通知の NSIS の節を確かめてから tools/third-party-notices.mjs を直します' }
  return { nsis, resources }
}

const hasLicenseFile = (dir) => dir !== null && readdirSync(dir).some((f) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(f))

/** dir が null（配布先向けの optional が入っていない）か、ライセンスの文が無いプリビルドなら、要求した側（textDir）の文を読む */
function packageEntry({ dir, pkg, textDir = null }, root, extra = {}) {
  const fromParent = textDir !== null && !hasLicenseFile(dir)
  return {
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    source: homepageOf(pkg),
    dir: fromParent ? textDir : dir,
    textFromParent: fromParent,
    ...extra,
  }
}

/**
 * 載せるものを集める。problems が空でないときは通知を書かない
 */
export function collectNotices(root = ROOT) {
  const problems = []
  const bundledInfo = readBundledModules(root)
  problems.push(...bundledInfo.problems)
  const byKey = new Map()
  const add = (entry, via) => {
    const key = `${entry.name}@${entry.version}`
    const prev = byKey.get(key)
    if (prev) {
      for (const v of via) if (!prev.via.includes(v)) prev.via.push(v)
      prev.via.sort()
      return
    }
    byKey.set(key, { ...entry, via: [...via].sort() })
  }
  for (const { dir, targets } of bundledInfo.bundled) {
    const abs = join(root, dir)
    if (!existsSync(join(abs, 'package.json'))) {
      problems.push(`${dir} がありません（npm ci を先に）`)
      continue
    }
    add(packageEntry({ dir: abs, pkg: readJson(join(abs, 'package.json')) }, root), targets.map((t) => `${t} bundle`))
  }
  const production = productionPackages(root)
  problems.push(...production.problems)
  for (const item of production.items) add(packageEntry(item, root), ['node_modules in app.asar'])
  const packages = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

  const embedded = []
  const koffi = packages.find((p) => p.name === 'koffi')
  if (!koffi) problems.push('koffi が本番の依存に見つかりません（PC/SC の呼び出しに使う）')
  else {
    for (const e of KOFFI_EMBEDDED) {
      const dir = join(koffi.dir, e.dir)
      if (!existsSync(dir)) {
        problems.push(`koffi の ${e.dir} がありません（koffi の形が変わった）`)
        continue
      }
      embedded.push({ ...e, dir, version: existsSync(join(dir, 'package.json')) ? readJson(join(dir, 'package.json')).version : null })
    }
  }

  const tools = collectBuildTools(root, problems, bundledInfo)
  readLicenses([...packages, ...tools], problems)
  for (const e of embedded) {
    e.text = licenseText(e.dir)
    if (!e.text) problems.push(`koffi の ${e.dir} にライセンスの文がありません`)
    if (COPYLEFT_TEXT.test(e.text)) problems.push(`koffi の ${e.dir} のライセンスの文に GPL・AGPL の見出しがあります`)
  }

  const { electron, nsis, fixed } = collectShell(root, problems)
  return { problems, packages, embedded, tools, electron, nsis, fixed }
}

/** ビルドの道具（出力に補助のコードを書いたもの） */
function collectBuildTools(root, problems, flags) {
  const tools = []
  for (const tool of BUILD_TOOLS) {
    if (!flags[tool.when]) continue
    const fromDir = tool.from === '.' ? root : resolvePackageDir(tool.from, root)
    const dir = fromDir && resolvePackageDir(tool.name, fromDir)
    if (!dir) {
      problems.push(`ビルドの道具 ${tool.name} が node_modules にありません`)
      continue
    }
    tools.push({ ...packageEntry({ dir, pkg: readJson(join(dir, 'package.json')) }, root), note: tool.note, parts: tool.parts })
  }
  return tools
}

/** ライセンスが許可の一覧の中か・文に GPL・AGPL の見出しが無いかを見て、文を p.text に読む */
function readLicenses(entries, problems) {
  for (const p of entries) {
    if (!isPermissive(p.license)) problems.push(`${p.name}@${p.version} のライセンス ${p.license} は許可の一覧の外です（配布物の扱いを決めてから PERMISSIVE に足します）`)
    let text = ''
    try {
      text = licenseText(p.dir, p.parts ?? null)
    } catch (e) {
      problems.push(e.message)
    }
    if (COPYLEFT_TEXT.test(text)) problems.push(`${p.name}@${p.version} のライセンスの文に GPL・AGPL の見出しがあります`)
    p.text = text
  }
}

/** Electron の版と、exe の殻（NSIS の版・build/licenses の手書きの文） */
function collectShell(root, problems) {
  const electronDir = resolvePackageDir('electron', root)
  const electron = electronDir ? readJson(join(electronDir, 'package.json')).version : null
  if (!electron) problems.push('electron が node_modules にありません')
  const nsis = nsisToolset(root)
  if (nsis.problem) problems.push(nsis.problem)
  const fixed = {}
  for (const name of ['NSIS-COPYING.txt', 'StdUtils-LGPL-CLARIFICATION.txt', 'elevate-LICENSE.txt', 'LGPL-2.1.txt']) {
    const path = join(root, LICENSE_DIR, name)
    if (!existsSync(path)) problems.push(`${LICENSE_DIR}/${name} がありません`)
    else fixed[name] = toLf(readFileSync(path, 'utf8')).trim()
  }
  return { electron, nsis, fixed }
}

const RULE = '='.repeat(78)
const SUB = '-'.repeat(78)

export function renderNotices({ packages, embedded, tools, electron, nsis, fixed }) {
  const out = []
  const section = (title) => out.push('', RULE, title, RULE, '')
  out.push('NFC Tag Studio - third-party notices')
  out.push(RULE)
  out.push('')
  out.push('NFC Tag Studio distributions include the third-party software listed below.')
  out.push('Generated by tools/third-party-notices.mjs from the modules of the release build')
  out.push('and node_modules - do not edit by hand.')

  section('1. Electron and Chromium')
  out.push(`Electron ${electron} (MIT License) - https://www.electronjs.org/`)
  out.push('  License text: LICENSE.electron.txt (in the application folder).')
  out.push('Chromium and the libraries it contains')
  out.push('  License texts: LICENSES.chromium.html (in the application folder).')

  section('2. npm packages included in the application')
  for (const p of packages) out.push(`  ${p.name} ${p.version}  ${p.license}  (${p.via.join(', ')})`)
  for (const p of packages) {
    out.push('', SUB, `${p.name} ${p.version}`, `License: ${p.license}`)
    if (p.source) out.push(`Source: ${p.source}`)
    out.push(`Included in: ${p.via.join(', ')}`)
    if (p.textFromParent) out.push('Note: prebuilt native module of the package that requires it; the license text is that package\'s')
    out.push(SUB)
    out.push(p.text || `(no license file in the package; license field: ${p.license})`)
  }

  section('3. Code compiled into the koffi native module')
  out.push('koffi.node (from the @koromix/koffi-win32-x64 package above) is built with the following headers:')
  for (const e of embedded) {
    out.push('', SUB, `${e.name}${e.version ? ` ${e.version}` : ''} (vendored in koffi)`, `License: ${e.license}`, `Source: ${e.source}`, SUB)
    out.push(e.text)
  }

  section('4. Build tools whose generated code is part of the bundles')
  for (const t of tools) {
    out.push('', SUB, `${t.name} ${t.version}`, `License: ${t.license}`)
    if (t.source) out.push(`Source: ${t.source}`)
    out.push(`Note: ${t.note}`, SUB)
    out.push(t.text || `(no license file in the package; license field: ${t.license})`)
  }

  section('5. Windows portable executable (NSIS)')
  out.push('The portable executable (NFC-Tag-Studio-<version>-win-x64-portable.exe) is a self-extracting')
  out.push(`archive built by electron-builder with NSIS ${nsis.nsis} and the plug-ins of electron-builder`)
  out.push(`nsis-resources ${nsis.resources}. The zip distribution does not contain them.`)
  out.push('')
  out.push('  - NSIS 3 and its System plug-in - zlib/libpng license (bzip2 parts: BSD-style)')
  out.push('    https://nsis.sourceforge.io/  (license text below)')
  out.push('  - nsis7z plug-in (based on 7-Zip) - GNU LGPL 2.1 or later')
  out.push('    Source: https://nsis.sourceforge.io/Nsis7z_plug-in')
  out.push('  - StdUtils plug-in - Copyright (C) 2004-2019 LoRd_MuldeR - GNU LGPL 2.1 or later,')
  out.push('    with the clarification below. Source: https://github.com/lordmulder/stdutils')
  out.push('  - elevate.exe (packed into the portable executable) - MIT License (text below)')
  out.push('    Source: https://github.com/jpassing/elevate')
  out.push('')
  out.push('The plug-ins are the unmodified builds shipped by electron-builder. Their source code')
  out.push('is available at the URLs above. The LGPL 2.1 text is reproduced in section 6.')
  for (const [title, name] of [
    ['NSIS COPYING', 'NSIS-COPYING.txt'],
    ['StdUtils LGPL clarification', 'StdUtils-LGPL-CLARIFICATION.txt'],
    ['elevate.exe', 'elevate-LICENSE.txt'],
  ]) {
    out.push('', SUB, title, SUB, fixed[name])
  }

  section('6. GNU Lesser General Public License, version 2.1')
  out.push(fixed['LGPL-2.1.txt'])
  out.push('')
  return out.join('\n')
}

/** 通知を作る（problems が空のときだけ text がある） */
export function buildNotices(root = ROOT) {
  const collected = collectNotices(root)
  if (collected.problems.length > 0) return { problems: collected.problems, text: null, collected }
  return { problems: [], text: renderNotices(collected), collected }
}

/** 書いてある通知が今の作り直しと一致するか。改行の形は区別しない */
export function checkNotices(root = ROOT) {
  const built = buildNotices(root)
  if (built.problems.length > 0) return built
  const path = join(root, NOTICES_FILE)
  const current = existsSync(path) ? toLf(readFileSync(path, 'utf8')) : null
  if (current === null) return { ...built, problems: [`${NOTICES_FILE} がありません。npm run notices で作ります`] }
  if (current !== built.text) return { ...built, problems: [`${NOTICES_FILE} が古いです。npm run notices で作り直してコミットします`] }
  return built
}

function main() {
  const args = process.argv.slice(2)
  for (const a of args) {
    if (a !== '--check') {
      console.error(`知らない引数です: ${a}`)
      process.exit(2)
    }
  }
  const check = args.includes('--check')
  const result = check ? checkNotices(ROOT) : buildNotices(ROOT)
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(`notices: ${p}`)
    process.exit(1)
  }
  const { packages } = result.collected
  if (check) {
    console.log(`ok: ${NOTICES_FILE} は最新です（npm のパッケージ ${packages.length} 件）`)
    return
  }
  writeFileSync(join(ROOT, NOTICES_FILE), result.text, 'utf8')
  console.log(`wrote ${NOTICES_FILE}（npm のパッケージ ${packages.length} 件）`)
  for (const p of packages) console.log(`  ${p.name}@${p.version}  ${p.license}  ${p.via.join(', ')}`)
}

if (isDirectRun(import.meta.url)) main()
