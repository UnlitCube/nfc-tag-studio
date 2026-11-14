# NFC Tag Studio 設計書（正典）

最終更新: 2026-11-12（統合担当。UX 改修の統合: §3・§3.1・§4・§5.1）

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
| I4 | 鍵・パスワードはログ・台帳・エラー詳細・ダンプのメタ情報に書かない。鍵は main から出さない（一覧は伏字）。ダンプを保存するときは、MIFARE の鍵 A・鍵として使う設定の鍵 B・NTAG の PWD/PACK を 00 にする（`views/backup/saveDump.ts` の `encodeDump`。読める設定の鍵 B はただのデータなので残す。2026-11-13）。自動読み取りでは公開の標準鍵だけを試す（運用者の鍵は明示の読み取りのときだけ。D9）。 |
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
| `src/shared/errorMessages.ts` | ErrorCode ごとの ja/en の文（何が起きて・次に何をするか）。main の `errors.ts` と renderer が共有する |
| `src/shared/api.ts` | `NfcApi`・`BridgeApi`・チャネル名・Envelope・`AppError`・ファイルフィルタ |
| `src/shared/tags.ts` | メモリマップ・NTAG 設定ページ位置・MIFARE セクタ計算・アクセスビット codec・識別（GET_VERSION / CC / ATR）・工場出荷イメージ・禁止/保護単位 |
| `src/shared/reader.ts` | 非接触リーダー判定・仮想リーダー名 |
| `src/shared/hex.ts` | hex / UTF-8 / BCD / 整数 |
| `src/shared/ndef/types.ts`, `src/shared/schema/types.ts` | NDEF・スキーマのモデル |
| `src/shared/ndef/index.ts`, `src/shared/tag/index.ts`, `src/shared/schema/index.ts` | **公開関数のシグネチャ**（実装は各担当。名前・引数・戻り値は変えない） |
| `src/main/errors.ts` | `OpError(code, detail?)` と日英メッセージ |
| `src/main/nfc/backend.ts`, `src/main/nfc/contract.ts` | `ReaderBackend` / `CardConnection` / `NfcService`（`createNfcService(deps, init?)`・`deps.allKeyIds()`・`NfcServiceInit`・`reidentify()`・`waitForCard(signal, { detectedAfter })`） |
| `src/main/nfc/pcsc/index.ts` の `createPcscBackend(log)` | シグネチャのみ凍結 |
| `src/preload/index.ts` | ブリッジ（機械的） |
| `src/renderer/src/store/app.ts` | 画面横断の状態（設定・リーダー状態・発行状態・バイナリ編集の文書 `doc` と画面ごとの読み取り結果 `pageDocs`（D15）・トースト・確認ダイアログ・handoff）。`guardDiscard`・`rebaseDoc`・`markWritten`・`busyOp`・`lastWrite`・`issueRecent`・`issueLastRun`・`dirtyUnits`。任意で足したもの: `ConfirmRequest.target / warning`・`Toast.technical`・`applyIssueEvent`・`unsavedDrafts / setUnsavedDraft`・`viewBeforeHelp`・`appStoreApi`・`errorToast`・`issueEventUpdate`・`hasUnsavedWork`・`localizeIssueMessage` |
| `src/renderer/src/components/ui.tsx`, `Overlays.tsx` | 共通 UI 部品（props 凍結） |
| `src/renderer/src/i18n/index.ts`, `define.ts`, `common.ts` | i18n の仕組みと共通文言 |
| `src/renderer/src/lib/{api,ops,format,sound}.ts` | API ラッパ・読み取り/書き込みの共通処理（`readCurrentTag(opts, { guard })`・`readTarget`・`writeWithConfirm` の `WriteUi.target / reactivateAfter / keepUnitsOnFailure / successTitle`）・整形・効果音（`beep('skip')` を含む） |
| `src/renderer/src/lib/{readerState,viewActive,autoRead,fileFilters}.ts`, `components/{TagOnReader,LastWriteCallout}.tsx` | 使用中のリーダーの状態（`tagOpBlock` ほか）・keep-alive の「表示中」・自動読み取り・ダンプのファイルの種類名・リーダーの上のタグ・最後の書き込み結果（props とシグネチャは凍結） |
| `src/renderer/src/styles/{tokens,base,ui}.css` | トークン（名前凍結）と共通部品の CSS |
| `src/renderer/src/App.tsx`, `index.html`, `main.tsx` | ルート表・テーマ・CSP |
| `src/renderer/src/views/ndef/NdefRecordsEditor.tsx` の props | `NdefRecordsEditorProps`（実装は renderer-ndef） |

### 3.1 意味の約束

- `WriteRequest.writes` は**配列の順に**書く（NTAG のパスワード設定は PWD → PACK → CFG1 → CFG0）。
- 書き込み直前に main が UID を読み直し、`expectedUid` と違えば `UID_MISMATCH`。識別した種類が `req.kind` と違えば `KIND_MISMATCH`。
- 書き込みの途中でタグが離れたら、`writeTag` は例外ではなく `aborted: 'CARD_REMOVED'` と未着手の単位（`notAttempted`）で resolve する（書けた単位は `written`）。照合中に離れたときは `aborted=CARD_REMOVED`・`failed=[]`・`notAttempted=[]`・`verified=false`（全部書けたが照合できていない）。書き込み前・書き込み中の `READ_FAILED` は `WRITE_FAILED` に読み替える。`failed[].error` は ErrorCode（生の SW を入れない）。
- 保護単位（`isProtectedUnit`）は `allowProtected` が真のときだけ。禁止単位（`isForbiddenUnit`）は常に拒否。MIFARE トレーラは `parseAccessBits` が null なら常に `INVALID_ACCESS_BITS`。
- NTAG の NDEF データ領域の大きさは **CC の申告値**（213: 144 / 215: 496 / 216: 872 バイト）。ユーザーメモリ（144 / 504 / 888）より小さい場合がある。
- 読めなかった単位は 0 埋め + `unitStatus` = `denied` / `unread`。鍵・パスワードで読めない（denied）だけなら、読み取り全体は失敗させない。**途中でタグが離れた・応答しなくなったときは、全体を `CARD_REMOVED`（または `CARD_UNRESPONSIVE`）で失敗にする**（`error` の単位を含む「成功」を返さない。2026-11-12 監査 CARD-4）。readTag の拒否コード: `NO_READER`・`NO_CARD`・`UNSUPPORTED_TAG`・`CARD_REMOVED`・`BUSY`・`READER_IN_USE`・`CARD_UNRESPONSIVE`・`ACCESS_DENIED`（storage リーダーで CC まで読み取り保護された NTAG など、識別できない保護タグ）・`READ_FAILED`。成功した読み取りは、使用中のリーダーの `card` を更新する。
- `ReaderStatus.card` は**使用中のリーダー（`activeReader`）のタグだけ**。選んだリーダーが未接続なら黙って他へ切り替えず `activeReason='selected-missing'`。`cardState='unsupported'` でも `card` が null のことがある（PC/SC がタグを拒否した場合）。Windows で `SCARD_E_NO_SERVICE` / `SERVICE_STOPPED` のときは「リーダー未接続」として `service='no-readers'` を返し、`serviceMessage` に rv 名を残す。`'unavailable'` はライブラリ不在や Linux / macOS の pcscd 不在。
- `setManualKind` はいま置いてあるタグだけに効く（置いていなければ次に置いたタグ）。そのタグが離れたら解除する。
- バックエンドのイベント（`backend.ts`）: `card-changed`（ポーリングの間にタグが差し替わった疑い。`dwEventState` の上位 16 ビットの回数か ATR の変化。service が UID で確かめ、同じなら何もしない）と、service イベントの `noReaders?`（後方互換で追加）。
- IPC は main で例外を Envelope に変換（`toErrorPayload`）。renderer は `AppError` を受け、`toastError` で出す。
- 発行中（issue 実行中）は UI からの単発の読み書きと `clearIssueLog` を `BUSY` で拒否する（画面は押す前に disabled にして理由を出す）。上級者モードでない `allowProtected` の書き込みと APDU は、ipc が `ADVANCED_REQUIRED` で拒否する。
- 一括発行: 重複 UID（`skipDuplicateUid`）は**発行台帳全体**で判定する。開始時にリーダーの上にあったタグには書かない（`clear-reader` で離されるのを待つ）。途中まで書いたタグには番号を予約し、同じタグが戻れば同じ番号で書き直す。別のタグに回すか停止したら、その番号は欠番として台帳に残す。取り外しは「`absent` が少し（既定 400 ms、1 回のポーリングより長く）続いたこと」で判定し、その間にリーダーやサービスが消えた（PC/SC のコンテキストの作り直し）ときは取り外しと見なさない（同じタグを次の番号で発行し直さない）。
- renderer の文書（`store.doc`）: 文書を置き換える・閉じる経路はすべて先に `guardDiscard()`。`writeWithConfirm` は書き込み後、書いたバイトが文書と一致するとき（保護単位を除く）だけ「文書の書き込み」とみなし、再読み取りで文書を置き換え、書けなかった編集を残す（`rebaseDoc`）。それ以外の内容（NDEF など）は、同じタグなら無関係な編集を残し、別のタグなら文書に手を付けない。`refresh:false` のときは、同じタグへの文書の書き込みに限って `markWritten` する。
- **文書は画面ごと（D15、2026-11-14）**: `store.doc` はバイナリ編集の文書（編集する唯一の文書）。ホーム・NDEF 編集・バックアップの読み取り結果は `store.pageDocs.home / ndef / backup`（編集しない。置き換えに `guardDiscard()` は要らない）。消去・完全初期化は文書を持たず、自分で読んだ像だけを使う。どの画面も、別の画面の文書を読まない・置き換えない。`readCurrentTag(opts, { into })` は `into` の画面の文書にだけ入れる（既定 `hex`。`guardDiscard()` は `hex` のときだけ）。自動読み取りは見ている画面の文書に入れる（`docOwnerOf(view)`）。`writeWithConfirm` の `WriteUi.doc` は書き込みの元の文書（既定 `hex`）: `hex` だけが書き込みの後に読み直して追従し、ほかの画面の文書は確認の文（「タグ X の複製」）にだけ使い、変えない。`null` は文書なし。書き込みの結果は `WriteOutcome.view` の画面にだけ出す。画面の間で渡すのは、ホームの［〜で開く］（`doc.original` の写し）と、［一括発行へ］の handoff（`issue-image` は像を持って行く）だけ。
- 書き込みの計画（`src/shared/tag/plan.ts`）: タグ側でロック済みの単位（`lockedUnitsOf`）・鍵 A が 00（読めない）の MIFARE トレーラは計画から外す（`forbiddenUnits`）。MIFARE の規則（トレーラ・ブロック 0）は MIFARE だけに当てる（FeliCa のブロック 3/7/11 はトレーラではない）。
- 設定は main が `userData/settings.json` に原子的に保存し、変更のたびに push する。renderer は `saveSettings(update)` で最新に対して更新する。

## 4. ファイル所有表（並列実装時）

| 担当 | 所有するパス |
|---|---|
| shared-ndef | `src/shared/ndef/**`（`types.ts` を除く）、`tests/ndef*.test.ts`、`docs/research/ndef.md` |
| shared-tag | `src/shared/tag/**`、`tests/tag*.test.ts`、`docs/research/ntag-mifare.md` |
| shared-schema | `src/shared/schema/**`（`types.ts` を除く）、`tests/schema*.test.ts`、`docs/SCHEMA-FORMAT.md` |
| main-pcsc | `src/main/nfc/pcsc/**`、`tests/pcsc*.test.ts`、`docs/research/pcsc.md` |
| main-nfc | `src/main/nfc/**`（`backend.ts`・`contract.ts`・`pcsc/**` を除く）、`tests/nfc*.test.ts`、`docs/research/reader-apdu.md` |
| main-app | `src/main/index.ts`、`src/main/app.ts`、`src/main/ipc.ts`、`src/main/services/**`（`policy.ts` を含む）、`src/main/issue/**`（`messages.ts` を含む）、`tests/main*.test.ts`、`tests/issue-engine.test.ts` |
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

### 5.1 UX 改修で決めたこと（2026-11-12。詳しくは `docs/UX-REWORK-2026-11.md`）

| # | 決定 |
|---|---|
| U1 | 選んだリーダーが未接続なら、黙って他へ切り替えない（`selected-missing`。画面に「自動選択に戻す」） |
| U2 | 自動読み取り（`settings.autoRead`、既定オン）はホーム・バイナリ編集・NDEF 編集だけ。未書き込みの変更がある文書と、ファイル・新規の文書は自動で置き換えない |
| U3 | 一度開いた画面は描画したまま隠す（keep-alive）。「表示されたとき」の処理は `useViewActive()` で行う |
| U4 | 未書き込みの変更の確認は 2 択（変更を破棄して続ける / キャンセル） |
| U5 | 別のタグ・ファイル・新規の文書を書くときは、書く直前に書き込み先を読み、その内容との差分で計画し、「別のタグへ書き込みます（複製）」と書き込み先を確認に出す |
| U6 | 一括発行の効果音は store が鳴らす（画面は鳴らさない） |
| U7 | 用語: 読み取る（ファイルは「開く」）/ タグに書き込む・ファイルに保存 / タグ / 置く・離す / 未書き込みの変更 / 画面に「単位」を出さない / ボタンは動詞（`tests/i18n.test.ts` が辞書とヘルプを検査） |
| U8 | `NFCTS_NO_PCSC=1`（パッケージ版では無視）で PC/SC を起動しない（E2E が実機のタグに触れない） |
