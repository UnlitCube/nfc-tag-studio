/**
 * この .mjs が node から直に起動されたか（ほかの道具や試験から import されたのではないか）。
 * `resolve(process.argv[1]) === fileURLToPath(import.meta.url)` だけで比べると、ジャンクション越しに起動したとき
 * （argv はジャンクションのパス、import.meta.url は実体のパス）に偽になり、道具が何もせずに終了コード 0 で終わる
 * （release:build の検査が走らないまま通る形。2026-11-12 のレビューで、使い捨てのジャンクションで実測）。
 * 両辺を実体のパスにし、Windows ではドライブ文字の大小の違いも無視して比べる。
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 実体のパス（無ければ解決しただけのパス） */
function realPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function normalize(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** metaUrl はその道具の import.meta.url。argv1 は試験のために渡せる（既定は process.argv[1]） */
export function isDirectRun(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  return normalize(realPath(resolve(argv1))) === normalize(realPath(fileURLToPath(metaUrl)))
}
