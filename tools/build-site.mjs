/**
 * GitHub Pages のサイトを site-dist/ に作る（pages.yml が公開する）。Node の標準ライブラリだけで動く（npm ci 不要）。
 *
 *   node tools/build-site.mjs            （npm run site:build）
 *   node tools/build-site.mjs --out <dir>
 *
 * - site/ を写し、HTML の {{VERSION}} を package.json の版に置き換える。
 * - 画面のキャプチャ（docs/images。npm run shots で撮る）と、アプリのアイコン（build/icon.svg）を写す。正は 1 か所だけ。
 * - HTML の src・href の相対の参照が、できたサイトの中に実在するかを確かめる。無ければ止める（終了コード 1）。
 * - 出力先は「無い」か「前回この道具が作った（目印 .nfcts-site がある）」ときだけ消して作り直す（別のフォルダを消さない）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectRun } from './run-direct.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MARKER = '.nfcts-site'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** HTML の相対の参照（src・href）。外の URL・#・mailto は除く */
export function relativeRefs(html) {
  const refs = []
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const v = m[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(v)) continue
    refs.push(v)
  }
  return refs
}

export function buildSite(root = ROOT, out = join(root, 'site-dist')) {
  const problems = []
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (!/^\d+\.\d+\.\d+/.test(String(version))) problems.push(`package.json の版が読めません: ${version}`)
  if (existsSync(out)) {
    if (!existsSync(join(out, MARKER)) && readdirSync(out).length > 0) {
      return { problems: [`${out} は空でなく、この道具が作ったものでもありません（消さずに止めます）`], out, pages: 0 }
    }
    rmSync(out, { recursive: true, force: true })
  }
  mkdirSync(out, { recursive: true })
  cpSync(join(root, 'site'), out, { recursive: true })
  cpSync(join(root, 'docs', 'images'), join(out, 'images'), { recursive: true })
  mkdirSync(join(out, 'assets'), { recursive: true })
  cpSync(join(root, 'build', 'icon.svg'), join(out, 'assets', 'icon.svg'))
  writeFileSync(join(out, '.nojekyll'), '')
  writeFileSync(join(out, MARKER), 'tools/build-site.mjs\n')

  let pages = 0
  for (const file of walk(out).filter((f) => extname(f) === '.html')) {
    pages++
    let html = readFileSync(file, 'utf8')
    html = html.replaceAll('{{VERSION}}', version)
    if (/\{\{[A-Z_]+\}\}/.test(html)) problems.push(`${relative(out, file)}: 置き換えていない {{…}} があります`)
    writeFileSync(file, html)
    for (const ref of relativeRefs(html)) {
      const path = decodeURIComponent(ref.replace(/[?#].*$/, ''))
      let target = resolve(dirname(file), path)
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
      if (!existsSync(target)) problems.push(`${relative(out, file).replace(/\\/g, '/')}: ${ref} がサイトの中にありません`)
    }
  }
  if (pages === 0) problems.push('site/ に HTML がありません')
  return { problems, out, pages, version }
}

function main() {
  const args = process.argv.slice(2)
  let out = join(ROOT, 'site-dist')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = resolve(args[++i])
    else {
      console.error(`知らない引数です: ${args[i]}`)
      process.exit(2)
    }
  }
  const { problems, pages, version } = buildSite(ROOT, out)
  if (problems.length) {
    for (const p of problems) console.error(`site: ${p}`)
    process.exit(1)
  }
  console.log(`ok: ${relative(ROOT, out) || out} に ${pages} ページを作りました（v${version}）`)
}

if (isDirectRun(import.meta.url)) main()
