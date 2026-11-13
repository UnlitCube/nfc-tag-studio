/**
 * CHANGELOG.md から版の節（`## vX.Y.Z (YYYY-MM-DD)`）を切り出す。GitHub Release の本文に使う。
 * CHANGELOG.md そのものは書き換えない（版の節を作るのは人）。
 *
 *   node tools/changelog-section.mjs                  package.json の版の節を標準出力へ（npm run release:notes）
 *   node tools/changelog-section.mjs --version 0.1.0  版を指定する
 *   node tools/changelog-section.mjs --file <path>    CHANGELOG.md の代わりに読む（下書きの確認・試験）
 *   node tools/changelog-section.mjs --out <path>     標準出力の代わりにファイルへ書く（UTF-8・LF）
 *   node tools/changelog-section.mjs --check          切り出せるかだけを見る（本文は出さない）
 *   node tools/changelog-section.mjs --release        リリースの検査と同じく、## vNext に項目が残っていれば止める
 *
 * 止める（終了コード 1。本文は出さない）:
 * - `## vNext` が無い。次の変更を積む場所なので、リリースでも消さずに残し、その下へ版の節を足す
 * - 版の見出しが無い・2 つある・`## vNext` より上にある
 * - 見出しの形が違う。括弧は半角で、日付まで書く（`## v0.1.0（2026-11-12）` や `## v0.1.0` は切り出さない）
 * - 本文が空（見出しの下が空行だけ）か、見出し（### ✨ 新機能 など）だけで項目が無い。Release の本文が空のまま出るのを、ビルドの前に止める
 * - 版の節の `### 🚧 作業中` に項目が残っている（未実装の機能を Release の本文に載せない）
 * - （リリースの検査から呼ぶとき・--release）`## vNext` の下に項目が残っている。版の節へ移し忘れると、Release の本文から抜ける。
 *   見出しだけの `## vNext` はよい。--release を付けない npm run release:notes は止めずに標準エラーへ警告を出す
 * 引数の誤りは終了コード 2。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectRun } from './run-direct.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 版の見出しの形。括弧は半角、日付は YYYY-MM-DD */
export const VERSION_HEADING = /^## v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \((\d{4})-(\d{2})-(\d{2})\)\s*$/
const NEXT_HEADING = /^## vNext\s*$/
const ANY_HEADING = /^## /
const WIP_HEADING = /^### .*作業中/

/** その版を指す見出し（形の正否を問わない）。`## v0.1.0（…）` も `## 0.1.0` も拾い、形の誤りとして知らせる */
function mentionsVersion(line, version) {
  const m = /^##\s+v?([0-9][0-9A-Za-z.+-]*)/.exec(line)
  return m !== null && m[1] === version
}

function validDate(y, m, d) {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
}

const SUB_HEADING = /^#{2,6} /

/** 見出しと空行のほかの行（項目・文） */
const itemLines = (lines) => lines.filter((line) => line.trim() !== '' && !SUB_HEADING.test(line))

/**
 * 版の節を確かめて切り出す。problems が空のときだけ body を使う。
 * body は見出しの下から次の `## ` の前まで。前後の空行を落とし、LF で終わる（空なら ''）。
 * requireEmptyNext が真なら、`## vNext` の下に項目が残っていれば止める（リリースの検査）。偽なら warnings に入れるだけ
 */
export function changelogSection(text, version, { requireEmptyNext = false } = {}) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/)
  const problems = []
  const warnings = []
  const wanted = String(version).replace(/^v/, '')
  const next = lines.findIndex((line) => NEXT_HEADING.test(line))
  if (next < 0) problems.push('## vNext がありません。次の変更を積む場所なので、版の節はその下へ足し、## vNext は残します')
  else {
    const nextEnd = lines.findIndex((line, i) => i > next && ANY_HEADING.test(line))
    const pending = itemLines(lines.slice(next + 1, nextEnd < 0 ? lines.length : nextEnd))
    if (pending.length > 0) {
      const message = `## vNext の下に ${pending.length} 行残っています。この版に入れたものは v${wanted} の節へ移し、## vNext は空にして残します`
      if (requireEmptyNext) problems.push(message)
      else warnings.push(message)
    }
  }
  const found = []
  lines.forEach((line, i) => {
    if (mentionsVersion(line, wanted)) found.push(i)
  })
  if (found.length === 0) {
    problems.push(`## v${wanted} (YYYY-MM-DD) の見出しがありません`)
    return { problems, warnings, body: '', heading: null }
  }
  if (found.length > 1) problems.push(`v${wanted} の見出しが ${found.length} つあります（${found.map((i) => `${i + 1} 行目`).join('・')}）`)
  const at = found[0]
  const m = VERSION_HEADING.exec(lines[at])
  if (!m || m[1] !== wanted) {
    problems.push(`${at + 1} 行目の見出しの形が違います。半角の括弧と日付で ## v${wanted} (YYYY-MM-DD) と書きます`)
  } else if (!validDate(m[2], m[3], m[4])) {
    problems.push(`${at + 1} 行目の見出しの日付がありえない日です`)
  }
  if (next >= 0 && at < next) problems.push(`v${wanted} の節が ## vNext より上にあります。## vNext の下へ置きます`)
  const end = lines.findIndex((line, i) => i > at && ANY_HEADING.test(line))
  const bodyLines = lines.slice(at + 1, end < 0 ? lines.length : end)
  const joined = bodyLines.join('\n').trim()
  const body = joined ? `${joined}\n` : ''
  if (!body) problems.push(`v${wanted} の節の本文が空です`)
  else if (itemLines(bodyLines).length === 0) problems.push(`v${wanted} の節に項目がありません（見出しだけです）`)
  const wip = bodyLines.findIndex((line) => WIP_HEADING.test(line))
  if (wip >= 0) {
    const wipEnd = bodyLines.findIndex((line, i) => i > wip && /^#{2,3} /.test(line))
    const items = bodyLines.slice(wip + 1, wipEnd < 0 ? bodyLines.length : wipEnd).filter((line) => line.trim() !== '')
    if (items.length > 0) problems.push(`v${wanted} の節の「${bodyLines[wip].replace(/^###\s*/, '')}」に ${items.length} 行残っています。実装済みは 3 区分へ移し、未実装は消します`)
  }
  return { problems, warnings, body: problems.length === 0 ? body : '', heading: lines[at] }
}

/** package.json の version（版の正） */
export function packageVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^﻿/, '')).version
}

export function parseArgs(args) {
  const out = { version: null, file: null, out: null, check: false, release: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} の後ろに値がありません`)
      return v
    }
    if (arg === '--version') out.version = value()
    else if (arg === '--file') out.file = value()
    else if (arg === '--out') out.out = value()
    else if (arg === '--check') out.check = true
    else if (arg === '--release') out.release = true
    else throw new Error(`知らない引数です: ${arg}`)
  }
  return out
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  const version = args.version ?? packageVersion()
  const file = resolve(args.file ?? join(ROOT, 'CHANGELOG.md'))
  const { problems, warnings, body } = changelogSection(readFileSync(file, 'utf8'), version, { requireEmptyNext: args.release })
  if (problems.length > 0) {
    for (const p of problems) console.error(`CHANGELOG: ${p}`)
    process.exit(1)
  }
  for (const w of warnings) console.error(`CHANGELOG（警告）: ${w}`)
  if (args.check) {
    console.log(`ok: CHANGELOG の v${version} の節を切り出せます（${body.split('\n').length - 1} 行）`)
  } else if (args.out) {
    writeFileSync(args.out, body, 'utf8')
    console.error(`wrote ${args.out}`)
  } else {
    process.stdout.write(body)
  }
}

if (isDirectRun(import.meta.url)) main()
