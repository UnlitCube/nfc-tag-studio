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

## 実機で分かったこと（2026-11-09、Sony PaSoRi 3.0 + 本物の NTAG215）

- **PaSoRi はストレージ方式のみ**。`FF CA`（UID）・`FF B0`（Read Binary）・`FF D6`（Update Binary）に対応するが、ACR122 の Direct Transmit（`FF 00 00 00 … D4 42`）も PC/SC transparent（`FF C2`）も、生 NTAG コマンド（GET_VERSION 等）には非対応（`6A 81` を返す）。→ `driver.ts` の `TRANSPARENT_NAME` から Sony/PaSoRi/FeliCa を外し、`estimateDriver` で `storage` に落とす。
- **PaSoRi の `FF B0` は 16 バイト単位のみ**。4 バイト読み（`FF B0 00 03 04`）は `6C 10`（正しい Le は 0x10）を返す。→ `ReaderIo.readBinary` に `6C XX` 再試行（リーダー指定の Le で読み直し必要分を slice）を実装。CC 読み（識別）が 4 バイトだったため、これが無いと全カードが `UNSUPPORTED_TAG` になっていた。
- **storage 方式では種別を CC（page 3）から判定**（GET_VERSION が使えない）。`identifyWith` は version→CC→ATR の順でフォールバック。NTAG215 の CC は `E1 10 3E 00`（size 0x3E）。
- **仮想リーダーの自動選択**: 実機リーダーが接続されていると `activeReaderName` が実機を優先し、シミュレータのテストが実機のカードを読んで落ちる（環境依存の flake）。→ 仮想リーダーが「有効 かつ タグ在り」のとき自動選択で優先する（実機を使うときは明示選択）。これでハードの有無に関係なくテストが決定的。
- 実測: PaSoRi 経由で本物の NTAG215 を 135 ページ全て読み取り成功（denied 0）、UID `04:15:91:DA:99:AE:20`。書き込みは実機で未実施（ユーザーの実物タグのため）。
