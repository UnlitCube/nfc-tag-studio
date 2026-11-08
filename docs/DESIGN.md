# NFC Tag Studio 設計書（正典）

最終更新: 2026-11-09（統合担当）

## 1. 目的と範囲

自組織で管理する NFC タグ／カードを、事務員が安全に**発行・編集・バックアップ・一括発行**するための Windows 向け（mac / Linux は副次）デスクトップアプリ。フリー公開予定。

- 対象: NTAG213 / NTAG215 / NTAG216（NFC Forum Type 2）、MIFARE Classic 1K / 4K（鍵は運用者が保有）。
- 読み書き: PC/SC リーダー（ACR122U 系・ACR1252U 系・Identiv・Sony RC-S300 など）。実機が無くても**仮想リーダー（シミュレータ）**で全機能を試せる。
- 主な機能: 読み取り／バイナリ（hex）編集／NDEF 定義と書き込み／データスキーマ（GUI で組み JSON で保存）による ID の採番と連番発行／CSV からの発行／バックアップ・復元・データ複製／発行台帳（CSV 書き出し）／MIFARE 鍵の管理／アプリ内ヘルプと初回ガイド。

### 1.1 不変条件（実装・文言・ヘルプのすべてで守る）

| # | 内容 |
|---|---|
| I1 | **UID は製造時に固定され読み取り専用。** アプリは UID を変更する機能を持たず、そう見せる文言も書かない。複製は「データ領域だけ」をコピーする操作で、UID は複製されないと必ず説明する。 |
| I2 | **UID を書き換えられる特殊カード（いわゆる magic card / Gen1a / Gen2 / CUID 等）のバックドアコマンドは実装しない。** NTAG のページ 0–1、MIFARE のブロック 0 は常に書き込み禁止（`isForbiddenUnit`）。 |
| I3 | **MIFARE Classic は運用者が持つ鍵だけで開く。** 鍵の解析・総当たり・辞書攻撃・既知鍵リストの同梱はしない。同梱する鍵は公開標準の 3 つだけ（工場出荷時 `FFFFFFFFFFFF`、NFC Forum MAD 鍵 `A0A1A2A3A4A5`、NFC Forum NDEF 鍵 `D3F7D3F7D3F7`）。 |
| I4 | 鍵・パスワードはログ・台帳・エラー詳細・ダンプのメタ情報に書かない。鍵は main から出さない（一覧は伏字）。 |
| I5 | 取り消せない操作（ロックビット・CC・CFGLCK・セクタトレーラ・パスワード設定）は上級者モード＋確認ダイアログ（ロック等は語の入力）を経る。不正なアクセスビットは常に拒否する。 |
| I6 | NFC リーダーでない PC/SC 機器（USB セキュリティトークン等）に自動で APDU を送らない。2026-11-08 に開発 PC で見えた唯一の PC/SC 機器は Feitian の USB トークン（`FS USB Token 0`）だった。 |

## 2. 構成

```
renderer (React 19 + zustand)  ──window.nfcBridge (Envelope)──▶  preload (CJS, sandbox)
     │ lib/api.ts が Envelope→AppError                               │ ipcRenderer.invoke
     ▼                                                                ▼
 views/*  components/ui  store/app  i18n/*                main: ipc.ts ─▶ services (settings / keys / log / files)
                                                                │         └▶ issue/engine.ts
                                                                ▼
                                                     nfc/service.ts (NfcService)
                                                       ├─ nfc/pcsc/*   (koffi → winscard.dll 等)
                                                       ├─ nfc/simulator.ts (仮想リーダー・仮想タグ)
                                                       └─ nfc/ntag.ts / mifare.ts / driver.ts / apdu.ts
 src/shared/* … main・renderer・テストが共有する純粋 TS（Node / DOM 非依存）
```

- tsconfig は 2 つ: `tsconfig.json`（renderer + shared、DOM）／`tsconfig.node.json`（main + preload + shared、Node）。
- preload は sandbox のため CJS。`package.json` に `"type": "module"` を足さない。
- koffi 3.3.7 は `@koromix/koffi-<platform>` のプリビルドで動く（npm 11 で install スクリプトが止まっても可）。
- 仮想リーダーは **APDU レベルで実機と同じ経路**を通す（上位の操作・発行エンジンはバックエンドを区別しない）。

## 3. 契約（凍結。変更は統合担当だけ）

| ファイル | 中身 |
|---|---|
| `src/shared/types.ts` | ドメイン型（ReaderStatus・CardInfo・TagImage・WriteRequest・IssueJob・IssueEvent・AppSettings・ErrorCode） |
| `src/shared/api.ts` | `NfcApi`・`BridgeApi`・チャネル名・Envelope・`AppError`・ファイルフィルタ |
| `src/shared/tags.ts` | メモリマップ・NTAG 設定ページ位置・MIFARE セクタ計算・アクセスビット codec・識別（GET_VERSION / CC / ATR）・工場出荷イメージ・禁止/保護単位 |
| `src/shared/reader.ts` | 非接触リーダー判定・仮想リーダー名 |
| `src/shared/hex.ts` | hex / UTF-8 / BCD / 整数 |
| `src/shared/ndef/types.ts`, `src/shared/schema/types.ts` | NDEF・スキーマのモデル |
| `src/shared/ndef/index.ts`, `src/shared/tag/index.ts`, `src/shared/schema/index.ts` | **公開関数のシグネチャ**（実装は各担当。名前・引数・戻り値は変えない） |
| `src/main/errors.ts` | `OpError(code, detail?)` と日英メッセージ |
| `src/main/nfc/backend.ts`, `src/main/nfc/contract.ts` | `ReaderBackend` / `CardConnection` / `NfcService` |
| `src/main/nfc/pcsc/index.ts` の `createPcscBackend(log)` | シグネチャのみ凍結 |
| `src/preload/index.ts` | ブリッジ（機械的） |
| `src/renderer/src/store/app.ts` | 画面横断の状態（設定・リーダー状態・発行状態・現在のドキュメント・トースト・確認ダイアログ・handoff） |
| `src/renderer/src/components/ui.tsx`, `Overlays.tsx` | 共通 UI 部品（props 凍結） |
| `src/renderer/src/i18n/index.ts`, `define.ts`, `common.ts` | i18n の仕組みと共通文言 |
| `src/renderer/src/lib/{api,ops,format,sound}.ts` | API ラッパ・読み取り/書き込みの共通処理・整形・効果音 |
| `src/renderer/src/styles/{tokens,base,ui}.css` | トークン（名前凍結）と共通部品の CSS |
| `src/renderer/src/App.tsx`, `index.html`, `main.tsx` | ルート表・テーマ・CSP |
| `src/renderer/src/views/ndef/NdefRecordsEditor.tsx` の props | `NdefRecordsEditorProps`（実装は renderer-ndef） |

### 3.1 意味の約束

- `WriteRequest.writes` は**配列の順に**書く（NTAG のパスワード設定は PWD → PACK → CFG1 → CFG0）。
- 書き込み直前に main が UID を読み直し、`expectedUid` と違えば `UID_MISMATCH`。
- 保護単位（`isProtectedUnit`）は `allowProtected` が真のときだけ。禁止単位（`isForbiddenUnit`）は常に拒否。MIFARE トレーラは `parseAccessBits` が null なら常に `INVALID_ACCESS_BITS`。
- NTAG の NDEF データ領域の大きさは **CC の申告値**（213: 144 / 215: 496 / 216: 872 バイト）。ユーザーメモリ（144 / 504 / 888）より小さい場合がある。
- 読めなかった単位は 0 埋め + `unitStatus` = `denied` / `unread`。読み取り全体は失敗させない。
- IPC は main で例外を Envelope に変換（`toErrorPayload`）。renderer は `AppError` を受け、`toastError` で出す。
- 発行中（issue 実行中）は UI からの単発の読み書きを `BUSY` で拒否する。
- 設定は main が `userData/settings.json` に原子的に保存し、変更のたびに push する。renderer は `saveSettings(update)` で最新に対して更新する。

## 4. ファイル所有表（並列実装時）

| 担当 | 所有するパス |
|---|---|
| shared-ndef | `src/shared/ndef/**`（`types.ts` を除く）、`tests/ndef*.test.ts`、`docs/research/ndef.md` |
| shared-tag | `src/shared/tag/**`、`tests/tag*.test.ts`、`docs/research/ntag-mifare.md` |
| shared-schema | `src/shared/schema/**`（`types.ts` を除く）、`tests/schema*.test.ts`、`docs/SCHEMA-FORMAT.md` |
| main-pcsc | `src/main/nfc/pcsc/**`、`tests/pcsc*.test.ts`、`docs/research/pcsc.md` |
| main-nfc | `src/main/nfc/**`（`backend.ts`・`contract.ts`・`pcsc/**` を除く）、`tests/nfc*.test.ts`、`docs/research/reader-apdu.md` |
| main-app | `src/main/index.ts`、`src/main/app.ts`、`src/main/ipc.ts`、`src/main/services/**`、`src/main/issue/**`、`tests/main*.test.ts` |
| shell-ui | `src/renderer/src/components/shell/**`、`src/renderer/src/styles/shell.css`、`views/home/**`、`views/settings/**`、`views/help/**`、`i18n/shell.ts`、`tests/contrast.test.ts`、`tests/i18n.test.ts` |
| renderer-hex | `views/hex/**`、`i18n/hex.ts` |
| renderer-ndef | `views/ndef/**`（`NdefRecordsEditor` の props は凍結）、`i18n/ndef.ts` |
| renderer-schema | `views/schema/**`、`i18n/schema.ts` |
| renderer-issue | `views/issue/**`、`views/log/**`、`i18n/issue.ts` |
| renderer-backup | `views/backup/**`、`views/keys/**`、`i18n/backup.ts` |
| 統合担当 | 契約ファイル、`package.json`、`electron-builder.json`、`CLAUDE.md`、`docs/DESIGN.md`、`scripts/**`、`tests/e2e/**` |

（`views/**` と `i18n/*.ts` は `src/renderer/src/` 配下。）

## 5. 決めたこと（覆せる）

| # | 決定 | 理由 / 代案 |
|---|---|---|
| D1 | PC/SC は koffi で OS のライブラリを直接呼ぶ | `nfc-pcsc`（`@pokusew/pcsclite`）は node-gyp でのビルドが要り、Electron の ABI ごとに作り直しが要る。koffi はプリビルドで MIT |
| D2 | 生の NFC-A コマンドはドライバ方式で通す（acr122 / transparent / storage） | リーダーごとに疑似 APDU が違う。不明なリーダーは storage（読み書きのみ）に落とす |
| D3 | 仮想リーダーを本体に同梱 | 実機が無い利用者の試用と E2E。開発 PC に NFC リーダーが無い |
| D4 | 画面は日本語を正、英語を併記（`defineMessages` でキーの過不足を型で検出） | フリー公開の製品 |
| D5 | 見た目は家風 A（明るい本体 + 濃色のナビ）、ブランド色はティール | 兄弟アプリの青と区別。事務員向けの業務ツール |
| D6 | 製品名は仮に「NFC Tag Studio」 | 商標は未確認（公開前に確認する） |
| D7 | 配布は当面 electron-builder の portable と zip | 独自 UI のインストーラーは次の段階 |
