/**
 * 公開する文書（README・CONTRIBUTING・SECURITY・CHANGELOG・docs/・wiki/・.github/ の .md）を検査する。
 *
 *   node tools/check-docs.mjs     （npm run docs:check。ci.yml・release.yml・wiki.yml が流す）
 *
 * 1. リンク: 相対のリンク・画像が実在するか。このリポジトリを指す絶対 URL（blob・raw・tree・raw.githubusercontent）は
 *    リポジトリの中のパスとして、Wiki の URL（/wiki/<ページ>）と wiki/ の中の [[ページ]]・拡張子の無い相対リンクは
 *    wiki/<ページ>.md として確かめる。外のサイトの URL は見に行かない（ネットワークに依らない）。
 * 2. 個人の環境の値: 追跡している（と、追跡する予定の未追跡の）テキストのファイルに、利用者のホームのパス
 *    （C:\Users\<名前>・/c/Users/<名前>・/home/<名前>）、作業用の一時フォルダのパス、個人のメールアドレス
 *    （gmail.com など）が無いか。<名前>・%USERPROFILE% のような書き方は通す。当たった行は「どのファイルの何行目」だけを出す。
 *
 * 終了コード: 0 = 問題なし / 1 = 問題あり
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectRun } from './run-direct.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = 'UnlitCube/nfc-tag-studio'
export const BRANCH = 'master'

const DOC_ROOTS = ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'docs', 'wiki', '.github']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export function docFiles(root = ROOT) {
  const files = []
  for (const r of DOC_ROOTS) {
    const p = join(root, r)
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) files.push(...walk(p).filter((f) => extname(f) === '.md'))
    else files.push(p)
  }
  return files.sort()
}

/** コードのブロック（``` … ```）と行内のコード（`…`）を空白に置き換える（行番号は保つ） */
export function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

/** Markdown・HTML のリンク先（行番号つき） */
export function extractLinks(text) {
  const links = []
  const lines = stripCode(text).split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push({ target: m[1], line: i + 1, kind: 'md' })
    for (const m of line.matchAll(/\b(?:src|href)="([^"]+)"/g)) links.push({ target: m[1], line: i + 1, kind: 'html' })
    for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const inner = m[1]
      const page = inner.includes('|') ? inner.split('|').pop() : inner
      links.push({ target: page.trim(), line: i + 1, kind: 'wiki' })
    }
  })
  return links
}

const wikiPagePath = (root, page) => join(root, 'wiki', `${decodeURIComponent(page).replace(/#.*$/, '')}.md`)

/** 1 つのリンクを確かめる。問題があれば理由の文、無ければ null */
export function checkLink(root, file, link) {
  const { target, kind } = link
  const inWiki = relative(join(root, 'wiki'), file).split(/[\\/]/)[0] !== '..'
  if (kind === 'wiki') return existsSync(wikiPagePath(root, target)) ? null : `Wiki のページ ${target} が wiki/ にありません`
  if (/^(mailto:|tel:|#)/.test(target)) return null
  const own = new RegExp(`^https://(?:github\\.com/${REPO}/(?:blob|raw|tree)/${BRANCH}/|raw\\.githubusercontent\\.com/${REPO}/${BRANCH}/)([^?#]+)`).exec(target)
  if (own) return existsSync(join(root, decodeURIComponent(own[1]))) ? null : `リポジトリに ${decodeURIComponent(own[1])} がありません`
  const wiki = new RegExp(`^https://github\\.com/${REPO}/wiki/([^?#]+)`).exec(target)
  if (wiki) return existsSync(wikiPagePath(root, wiki[1])) ? null : `Wiki のページ ${decodeURIComponent(wiki[1])} が wiki/ にありません`
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null // 外のサイト
  const path = target.replace(/[?#].*$/, '')
  if (path === '') return null
  if (inWiki && !path.includes('/') && extname(path) === '') {
    return existsSync(wikiPagePath(root, path)) ? null : `Wiki のページ ${decodeURIComponent(path)} が wiki/ にありません`
  }
  const abs = resolve(dirname(file), decodeURIComponent(path))
  return existsSync(abs) ? null : `${relative(root, abs).replace(/\\/g, '/')} がありません`
}

/** 個人の環境の値の形（値そのものの一覧は持たない）。<名前>・%VAR%・$VAR・{…} のような書き方は通す */
export const PERSONAL_PATTERNS = [
  { name: 'Windows のユーザーのフォルダ', re: /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?![<%${]|Public\b|Default\b)[^\\/\s"'`<>]+/i },
  { name: 'Git Bash のユーザーのフォルダ', re: /\/[a-z]\/Users\/(?![<%${])[^/\s"'`<>]+/i },
  { name: 'Linux のホームのフォルダ', re: /\/home\/(?![<%${]|runner\b|user\b|node\b)[a-z0-9_-]+\//i },
  { name: '作業用の一時フォルダ', re: /AppData[\\/]{1,2}Local[\\/]{1,2}Temp[\\/]{1,2}claude/i },
  { name: '個人のメールアドレス', re: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|me|proton|protonmail)\.[a-z.]+/i },
]

/** 検査から外すファイル（第三者のライセンスの文・lock） */
const PERSONAL_SKIP = [/^package-lock\.json$/, /^THIRD_PARTY_NOTICES\.txt$/, /^build\/licenses\//, /\.(png|jpe?g|gif|ico|webp|bin|nfcdump|zip|exe)$/i]

export function trackedFiles(root = ROOT) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

export function personalHits(text, patterns = PERSONAL_PATTERNS) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    for (const p of patterns) if (p.re.test(line)) hits.push({ line: i + 1, name: p.name })
  })
  return hits
}

export function checkDocs(root = ROOT) {
  const problems = []
  const files = docFiles(root)
  let linkCount = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const link of extractLinks(text)) {
      linkCount++
      const why = checkLink(root, file, link)
      if (why) problems.push(`${relative(root, file).replace(/\\/g, '/')}:${link.line}: ${link.target} → ${why}`)
    }
  }
  const tracked = trackedFiles(root)
  if (tracked === null) problems.push('git ls-files を実行できません（個人の環境の値を検査できない）')
  let scanned = 0
  for (const rel of tracked ?? []) {
    if (PERSONAL_SKIP.some((re) => re.test(rel))) continue
    const abs = join(root, rel)
    if (!existsSync(abs) || statSync(abs).size > 2_000_000) continue
    const buf = readFileSync(abs)
    if (buf.includes(0)) continue // バイナリ
    scanned++
    for (const h of personalHits(buf.toString('utf8'))) problems.push(`${rel}:${h.line}: ${h.name}の形の値があります（値は出しません）`)
  }
  return { problems, files: files.length, links: linkCount, scanned }
}

function main() {
  const { problems, files, links, scanned } = checkDocs(ROOT)
  if (problems.length) {
    for (const p of problems) console.error(`docs: ${p}`)
    process.exit(1)
  }
  console.log(`ok: 文書 ${files} 本・リンク ${links} 件・個人の環境の値の検査 ${scanned} ファイル`)
}

if (isDirectRun(import.meta.url)) main()
