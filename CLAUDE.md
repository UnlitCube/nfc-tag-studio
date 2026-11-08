# NFC Tag Studio — 作業メモ（罠の台帳）

自組織で管理する NFC タグ（NTAG213/215/216・MIFARE Classic）の発行・編集・バックアップ用 Electron アプリ。正典は `docs/DESIGN.md`（目的・不変条件 I1〜I6・契約・所有表）。

## 必ず守る規約

- **UID は読み取り専用（I1/I2）。** UID 変更・magic card のバックドア・鍵の解析を実装しない。MIFARE は運用者の鍵だけ（I3）。
- 契約ファイル（`docs/DESIGN.md` §3）を変えるときは、型検査と全テストを流してから。
- 画面の文言は `i18n/<feature>.ts` に ja と en を同時に足す（型で過不足が落ちる）。
- 色・寸法はトークン（`src/renderer/src/styles/tokens.css`）経由。生の hex をビューに書かない。
- main の例外は `OpError(code, detail?)`。detail に鍵・パスワードを入れない。

## 開発コマンド

| 目的 | コマンド |
|---|---|
| 開発起動（ダブルクリック可） | `start-dev.bat`（= `npm run dev`） |
| 型検査（2 つの tsconfig） | `npm run typecheck` |
| 単体テスト | `npm run unit` |
| 全部 | `npm test` |
| ビルド | `npm run build`（`out/`） |
| 起動スモーク（スクショ） | `npm run build && node scripts/smoke-launch.cjs <png>` |
| E2E | `npm run e2e`（Playwright、`out/` を読む） |
| 配布物 | `npm run dist:win` |

## 罠（経験済み・繰り返さない）

- **npm 11 は Electron 本体を入れない。** `postinstall` の `scripts/ensure-electron.cjs` が `node_modules/electron/install.js` を流す。`node_modules/electron/dist/version` を確認。
- **koffi の install スクリプトも npm 11 で止まる**が、3.3.7 は `@koromix/koffi-win32-x64` のプリビルドで動く（2026-11-08 確認）。パッケージ時は `node_modules/koffi/**` と `node_modules/@koromix/**` を asarUnpack。
- **`ELECTRON_RUN_AS_NODE`** があると Electron が素の Node で起動する。起動スクリプト・spawn・E2E で必ず消す。
- **preload は sandbox のため CJS 必須。** `"type": "module"` を足すと preload が ESM になり橋が消える。
- **contextBridge を越えた例外は独自フィールドが落ちる。** だからブリッジは Envelope を返し、renderer の `lib/api.ts` で `AppError` にする。
- 開発 PC の PC/SC 機器は USB トークン（`FS USB Token 0`、ATR `3B9F9581...`）だけ。NFC リーダーと誤認しない・APDU を送らない（`isLikelyContactlessReader`）。
- Playwright の `_electron` は `out/` を読む。E2E の前に `npm run build`。
