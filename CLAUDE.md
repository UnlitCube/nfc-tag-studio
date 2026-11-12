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
| 単体テスト | `npm run unit`（`scripts/run-vitest.cjs` 経由。**`npx vitest` を直接叩かない**＝下の罠） |
| 中核ロジックの回帰ガード | `npm run test:smoke`（tsc→node、vitest 非依存） |
| 全部 | `npm test`（型検査 + 単体 + smoke） |
| ビルド | `npm run build`（`out/`） |
| 起動スモーク（スクショ） | `npm run build && node scripts/smoke-launch.cjs <png>` |
| E2E | `npm run e2e`（Playwright、`out/` を読む） |
| 実機での書き込みの確認（捨ててよいタグだけ） | `NFCTS_HW_WRITE_UID=<そのタグの UID>` を付けて `npm run hw:write`（`tests/hw`。UID が違えば何も書かずに止まる。書くのはユーザー領域だけで、最後に元へ戻す） |
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

## FeliCa Lite-S（2026-11-11 追加）

- `FELICA_LITE_S` を TagKind に追加。非連続ブロック（0x00-0x0E・0x88）を `TagSpec.blockMap` で連続 unit にマップ。編集グリッド = user 0x00-0x0D + REG 0x0E + MC 0x88（16 ユニット）。IDm（8 バイト）は読み取り専用。
- 転送は `ReaderIo.raw`（ACR122 の InCommunicateThru / transparent）経由。**生 FeliCa コマンド（Direct Transmit `FF 00..D4 42` / transparent `FF C2`）は Sony PaSoRi では不可（`6A 81`）**。アプリは raw 経路を使うので、現状 storage リーダー（PaSoRi）では FeliCa が `UNSUPPORTED_TAG`。
- **2026-11-12 実機フル検証（本物の FeliCa Lite-S + PaSoRi）＝ACR122 は Lite-S の読み書きには不要だった**。ストレージ経路で全部できる:
  - **読み**: `FF B0 00 <実ブロック番号> 10`。P1P2 に FeliCa の実ブロック番号を直接指定。S_PAD0-13=0x00-0x0D、REG=0x0E、**MC=0x88**、ID=0x82、WCNT=0x90 等、system ブロックも読めた（前に「MC 読めない」と書いたのはアドレス誤り＝0x0F を見ていた）。Sony ドライバが内部で Read Without Encryption に変換。
  - **書き**: `FF D6 00 <実ブロック番号> 10 <16B>`。user ブロック・REG・**MC も書けた**（読み戻し＋電源跨ぎで確認）。拒否時 SW は `91 00`、成功は `90 00`。
  - **ブロック書込保護（読み取り専用化）も MAC 無しで可能**。Lite-S は **書込保護マスクを MC[8:10] と MC[10:12] の2箇所に書く（極性 1=保護）**。nfcpy `FelicaLiteS._protect` と一致。`00 20 00 20`（block 0x0D のみ）で該当ブロックが読み取り専用化（拒否 `91 00`）、他ブロックは書けたまま。
  - **⚠️ 保護は RF 再活性化（カードの物理抜き差し）でのみラッチする**。`SCardReconnect(UNPOWER)` では切れず発効しない（Sony ドライバはカードを連続活性化）。→ アプリで保護を書いたら「カードをかざし直してください」を促す必要。
  - **一度ラッチした書込保護は不可逆**。MC の保護バイトを 0 に戻す書き込みは `90 00` を返すが実際には変化せず、抜き差し後も読み取り専用のまま（ワンウェイ）。
  - 依然不可: 生 FeliCa チャネル（Direct Transmit `6A 81` / transparent 内側 `6A 81`）。Polling・任意サービス指定・MAC 認証付き R/W が要る用途だけ ACR122 系が必要。
- 純粋ロジックは `src/shared/felica.ts`（Polling/Read/Write Without Encryption の組み立て・MC デコード）。**2026-11-12 のコミット 2d2155f で直した**（書込保護=MC[8:10]+MC[10:12]・読取保護=MC[6:8]・MC[2]=system ブロック書込可否。`FlagEditor` の読み取り専用化も同じエンコーダを使う。回帰: `npm run test:smoke` の FeliCa MC、`tests/felica.test.ts`）。以下は**当時の記録**: **⚠️ この MC デコード/エンコードは誤り（2026-11-12 実機で判明、要修正）**: 実装は「MC[0]/MC[1]=ブロック別書込ビット（1=writable）、MC[2] bit0=SYS_OP」とするが、実機の Lite-S は **書込保護=MC[8:10]+MC[10:12]（1=保護）・読取保護=MC[6:8]・MC[2]=system ブロック書込可否（0xFF可/0x00読取専用）**。現状の `FlagEditor` の「FeliCa 読み取り専用化」は MC[0]/MC[1] を書くため**実機では無効（『ロックした』と偽表示）**。`simulator.ts` も同じ誤りモデルなので felica.test.ts は緑でも誤った意味を検証している。
- 仮想リーダーが FeliCa をエミュレート（`simulator.ts` の `felicaCommand`）。読み取り・編集・MC フラグ編集を実機なしで検証済み。

## NTAG 保護・認証の実機検証とバグ（2026-11-12、本物の NTAG213 + PaSoRi）

- PaSoRi は NTAG213 も PC/SC で読み書き可（読=`FF B0`、書=`FF D6` で 1 ページ 4 バイト、`90 00`）。UID `04 B0 21 D2 D8 38 80`。NTAG のリーダー層は元々 storage 経路対応なので FeliCa と違い実装は動く（PWD_AUTH・署名・カウンタは raw 専用で PaSoRi では不可）。
- **N1・N2 は 2d2155f で直した**（回帰: `npm run test:smoke` の NTAG lock state）。以下は当時の記録。
- **バグ N1（`readNtagLockState`、`src/shared/tag/ntag.ts`）**: 動的ブロックロック判定が `page0x28 の byte3 & 0x07` を見るが、**NTAG213 の page0x28 byte3 は常に `0xBD` 固定の読み出し値**（ロックビットではない）。→ **どの NTAG213 でも `blockLocked=true` の誤判定**（`0xBD&0x07=0x05`）。実機 factory カードで確認。動的 BL ビットは byte2 側（データシート図。NXP community の `00 00 3F` が BL を有効化）。
- **バグ N2（同ファイル）**: **NTAG213 の動的ロック粒度は 1 ビット=2 ページ**（実機で byte0 bit0 → page 0x10-0x11 の両方をロック確認）。アプリは `gran = NTAG213 ? 1 : 16`（1 ページ）としており、ロック対象ページの対応が 2 倍ずれる。実ロックビットは 12 本（byte0 全 8＋byte1 下位 4 ＝ pages 16-39 を 2 ページ単位）、残りは BL/RFUI。
- **ドライバ非対称（要注意）**: storage 経路では、**ロックビット保護ページへの書込は Sony ドライバが `90 00`（成功）を返す**のに実際は書かれない（＝`writeNtagPages`→`updateBinary` が失敗を検知できず成功と誤報告し得る）。一方**パスワード保護ページは `63 00`（失敗）**で検知可。→ storage 書込後は読み戻し検証が安全。**2026-11-12: 一括発行は storage リーダーでは常に照合する**（`engine.ts`、`tests/issue-engine.test.ts` の「always verifies on a storage reader」）。
- 検証できた正しい挙動: パスワード保護（AUTH0 境界＋PROT 読取保護）は PaSoRi で機能（AUTH0 以上は read/write とも `63 00` 拒否、未満は開放）。**発効は再活性化後**（NTAG は `SCardReconnect(UNPOWER)` で発効。FeliCa の保護は物理抜き差し必須で差がある）。動的ロックは OTP（0→1 のみ・不可逆）。`buildNtagPasswordWrites` の順序（PWD→PACK→CFG1→CFG0/AUTH0 最後）と CFG0/CFG1 の factory 復号は妥当。

## パラメータ（フラグ）編集（2026-11-11 追加）

- `src/renderer/src/views/hex/FlagEditor.tsx`。設定を解説付き UI で編集し、共有のエンコーダ（`buildNtagConfigWrites`・`buildTrailer`・`encodeFelicaMc`）で保留中の編集に変換。取り消せない操作（CFGLCK・恒久ロック・MIFARE 読み取り専用・FeliCa 読み取り専用）は上級者モード＋警告。

## 単体テストの罠（vitest。2026-11-12 真因を特定して解決）

- **真因: カレントディレクトリのドライブ文字が小文字（`c:\dev\nfc-editor`）だと vitest が二重化する**。Claude Code のセッション（作業ディレクトリが小文字）から起こしたシェルは cwd が `c:\…` になる。vitest のワーカー（`node_modules/vitest/dist/workers/forks.js`）は CLI の起動パスから `file:///c:/…` で読まれ、テストの `import 'vitest'` は vite が `file:///C:/…` に正規化する。Node の ESM は 2 つを別モジュールにするので `@vitest/runner` が 2 つでき、**どのテストも `describe()` の行で `TypeError: Cannot read properties of undefined (reading 'config')`**。src を読まない 1 行のテストでも 100% 再現した。
  - 確かめ方（2026-11-12）: 同じ木・同じ版で、PowerShell の `Set-Location C:\dev\nfc-editor` から `npx vitest run` は 22 ファイル / 404 件 green、小文字の cwd からは全滅。テストの中で `import.meta.resolve('vitest')` は `file:///C:/…`、ワーカーの `process.argv[1]` は `c:\…\forks.js` だった。
  - 対処: `npm run unit` は `scripts/run-vitest.cjs` を通す。ルートと vitest の CLI を `fs.realpathSync.native` で本当の表記（`C:\…`）に直し、その cwd・パスで起動し直す。小文字の cwd から `npx vitest` を直接叩いたときは、`vitest.config.mts` が原因の分かる文で止める（`/^[a-z]:[\\/]/` を `process.argv[1]` に当てる）。設定の `root` を大文字にしても直らない（ワーカーのパスは CLI の読み込み元で決まる）。
  - 同じ型と思われる罠: Workflow の `isolation: 'worktree'` が `c:` と `C:/` の違いで断られた件（スキル `agent-workflow-orchestration`。向こうの原因は未確認）。小文字のドライブ文字は、Windows の道具の間でパスの同一性を壊すことがある。
- **当時の記録（誤診。繰り返さない）**: 2026-11-12 の前半は「lockfile 不整合」、後半は「vite 8 + ワーカー + node24 + Windows の組み合わせ固有で、構成を変えない限り直らない」と書いていた。vitest 4.1.12 / 5.0.5 / 5.1.0 の入れ替え・`node_modules` のクリーン再インストール・pool/isolate の切替はどれも効かなかったが、それは cwd が小文字のまま試していたため。版・lock・vite は無関係だった。
- `npm run test:smoke`（`scripts/smoke-logic.cjs`＝tsc で `src/shared` を CJS 出力し node でアサート。33 件）は、vitest が動かない間の代わりとして作った。いまは `npm test` に足した追加の回帰ガード。
- **zustand 5 の SSR は `getInitialState()` を描く**: `renderToString` で画面のテストをするとき、`(useAppStore as …).getInitialState = …` の差し替えは効かない（`useStore` は内部の素の api を読む）。→ store が export する `appStoreApi` に `appStoreApi.getInitialState = () => appStoreApi.getState()`。回帰: `tests/renderer-core.test.ts` の「appStoreApi」、`tests/tag-plan-hexview.test.ts`。
- **リーダーが PnP「Unknown」で PC/SC に出ない**ことがある（スリープ/再開後など）。PaSoRi を USB で抜き差しすると復帰。

## UX 改修（2026-11-12）で分かった罠（症状 → 原因 → 対処 → 回帰テスト）

計画と決定は `docs/UX-REWORK-2026-11.md`、意味の約束は `docs/DESIGN.md` §3.1・§5.1。

- **タグを置いても「タグなし」・読み取りボタンが押せない** → 識別がどのリーダーのイベントでも走り、1 つしかない `card` を上書きしていた（開発 PC の並び [FS USB Token 0, PaSoRi, YubiKey] で、YubiKey の識別失敗が PaSoRi のタグ情報を消す。トークンに `FF CA` が飛ぶ＝I6 違反）。識別に 1 回失敗すると再試行もしなかった → `ReaderStatus.card` は使用中のリーダー（`activeReader`）のタグだけ・NFC でない機器は識別しない・再試行と［もう一度確認］（`reidentify`）→ `tests/nfc-service-readers.test.ts`。
- **読み取り中にタグを離すと「成功」で 0 埋めの像が文書になる**（「パスワードが必要」と誤った理由つき）→ 途中で離れた読み取りを成功として返していた → 全体を `CARD_REMOVED` で失敗にする（renderer は `error` の単位があれば開く前に確かめる）→ `tests/nfc-service-readers.test.ts` の「lifting it mid-read」。
- **仮想リーダーが有効だと、画面は実機のタグを出すのに読み書きは仮想タグに行く** → 表示と操作が別のリーダーを見ていた → どちらも `activeReader`。実機のタグが無視されているときは `ignoredRealReader` を出す → `tests/nfc-service-readers.test.ts`・`tests/shell-home.test.ts`。
- **バイナリ編集で別のタグに載せ替えて書くと、混ざった内容を書く／ファイル・新規の文書からは何も書かない** → 「読んだタグとの差分」を「いま載っているタグ」に書いていた → 書く直前に書き込み先を読み（`readTarget`）その中身との差分で計画、確認に「別のタグへ書き込みます（複製）」と種類・UID → `tests/tag-plan-hexview.test.ts`・`tests/renderer-core.test.ts`。
- **未書き込みの編集が、再読み取り・別画面の読み取り・ファイルを開く・窓を閉じる・書き込みの一部失敗で消える** → 文書を置き換える経路が確認していなかった → 置き換える・閉じる経路は必ず `guardDiscard()`、一部失敗は `rebaseDoc` で書けなかった編集を残す、窓は `beforeunload`→main の `will-prevent-unload` で確認（画面の下書きは `setUnsavedDraft`）→ `tests/renderer-core.test.ts`。
- **書き込み・読み取りの確認ダイアログを出している間、状態表示が「読み取り中… タグを離さないでください」になる** → renderer の `busyOp` は二度押し防止のため確認の前から立つ → 状態表示・ホームは確認が開いている間は `busyOp` を無視する（main の `reader.busy` は実際の I/O だけ）。
- **一括発行で、発行したタグが置いたままなのに次の番号でもう一度発行される**（`skipDuplicateUid` がオフのとき）→ PC/SC のコンテキストの作り直し（スリープ復帰・サービス再起動）は、全タグの `card-removed`→リーダー一覧の空→復帰で同じタグの `card-inserted` を出す。engine は一瞬の `absent` を取り外しと見ていた → `absent` が `REMOVAL_SETTLE_MS`（400 ms、1 回のポーリングより長く）続き、その間にリーダー・サービスが消えなかったときだけ取り外し → `tests/issue-engine.test.ts` の「PC/SC context reset」（直す前の形で落ちることを確認済み）。
- **書き込み計画が FeliCa のブロック 3/7/11 を書かない** → `plan.ts` が MIFARE のセクタトレーラの規則（4 ブロックごと）をタグの種類を見ずに当てていた → MIFARE の規則は MIFARE だけ → `tests/tag-plan.test.ts`、`npm run test:smoke` の「FeliCa S_PAD3/7/11」（smoke は直す前の plan.ts で落ちることを確認済み）。
- **MIFARE のトレーラをグリッドのまま書くと、鍵 A が `000000000000` になって開けなくなる** → 鍵 A は読み戻すと 00（読めない） → 鍵 A が 00 のトレーラは計画から外す（`KEY_A_UNKNOWN`、danger）。根本の対策（main がセクタを開けた鍵で差し替える `WriteRequest.keepTrailerKeys`）は契約の変更が要るので未実装 → `tests/tag-plan.test.ts`・`tests/tag-plan-hex.test.ts`。
- **ホームで「NDEF を消去」したタグが「1 件のレコード」と出る** → 空のレコードだけのメッセージ（`D0 00 00`）を 1 件と数えていた → NDEF 編集と同じ `readImageNdef` で数える → `tests/shell-home.test.ts` の「NDEF count」。
- **keep-alive の画面が「表示されたとき」の処理を mount で行うと、2 回目以降に動かない**（handoff の受け取り・フォーカス・再読み込み）→ 一度開いた画面は隠すだけで mount し直さない → `useViewActive()` を見る（`IssueView`・`LogView`・`HexView`・`NdefView`・`HelpView`）。
- **Ctrl+Z が 2 段効く** → グリッドの `onKeyDown` と全体のショートカットが両方 undo していた → グリッドは `preventDefault`、全体（`useShortcuts`）は `e.defaultPrevented` を見て何もしない。React の `onKeyDown` はルートで先に走るので、window のリスナーからは `defaultPrevented` が見える → `tests/shell-home.test.ts` の `shortcutAction`。
- **確認ダイアログが、開いた直後の Enter（キーの押しっぱなし）で確定する** → 開いた操作の Enter が次のボタンに届く → warn / danger の確認は初期フォーカスが「キャンセル」、開いて 350 ms はキーボードでの確定を無視（クリックは効く）。E2E は `confirm-ok` をクリックする。
- **E2E・スモークで実機のタグに触れない・閉じるときに固まらない**: 開発ビルドでは `NFCTS_NO_PCSC=1` で PC/SC を起動しない（パッケージ版は無視）。終了の確認は `NFCTS_DIALOG_AUTO=proceed|cancel`、または `NFCTS_E2E=1` / `NFCTS_SMOKE=1`（`smoke-launch` は設定済み）で自動応答する。設定の `autoRead` は既定オン（タグを置くと読む）。

## 実機での確認（2026-11-13、改修後）

- PaSoRi に本物の NTAG215 を置いたまま、USB トークン・YubiKey にもカードがある並びで起動: 使用中のリーダーは PaSoRi（auto-card）、識別 → ready 約 150 ms、自動読み取りは約 0.3 秒（563〜849 ms）で全ページ読めた。8 秒間 ready のまま、ちらつき無し。改修前はこの並びで、トークン・YubiKey の識別失敗が PaSoRi のタグを消していた。確かめる道具は、PC/SC を有効にして起動し、`window.nfcBridge.onReaderStatus` の通知を全部記録する読み取り専用のスクリプト（書き込み・APDU の呼び出しを持たないこと）。
- **起動中に置く・離す・置き替える（2026-11-13、利用者が手で操作、90 秒の記録）**: NTAG215・FeliCa Lite-S・NTAG213 の 3 枚で 26 回の置く/離す。離すのは約 0.1〜0.3 秒、置いてから識別まで約 0.2 秒、自動読み取りの完了まで約 0.5 秒で表示に出た。違うタグへの置き替えは毎回正しい UID/IDm に切り替わり、文書も追従した。固まった状態・取り違えは 0 回。持ち上げかけたときの読み取りは「処理の途中でタグが離れました」で失敗として出た（正しい）。**一瞬のタッチ**は「確認中…」が約 2.3 秒（識別の再試行 300/600/1200 ms）→「読み取れません」が約 0.15 秒 →「置いてください」に戻った（終わりの状態は正しい）。
- **一瞬のタッチ・読める範囲の端で、「確認中…」が約 2.3 秒続いてから「読み取れません」が一瞬出た** → 記録を見ると、リーダー（PaSoRi）はその間ずっと「タグあり」を返し、識別は UID（`FF CA`）は読めても CC の読み取りで失敗していた。4 回目は `SCARD_W_REMOVED_CARD`（`CARD_REMOVED`）で、「タグなし」が届いたのはその約 0.14 秒後。一瞬のタッチというより、読める範囲の端で揺れていた → 再試行中は `ReaderStatus.cardRetrying` を立て、画面は「うまく読み取れません。タグをリーダーの中央に置き、動かさないでください。」と出す。最後の失敗が `CARD_REMOVED` でリーダーがまだ「タグあり」なら、`REMOVED_GRACE_MS`（500 ms、ポーリング 300 ms より長い）待ってもう一度だけ試す（離れていれば、そのまま「置いてください」になる）→ `tests/nfc-service-readers.test.ts` の「cardRetrying」「without an "error" flash」「one more try」（直し方を外すと落ちることを確認）・`tests/shell-home.test.ts`。
- **読み取るたびにステータスバーへ「他のアプリが使用中」が約 0.3 秒出た（嘘の警告）** → Windows は自分の接続にも `SCARD_STATE_INUSE` を立てる。読み取り中に 40 ms ごとにイベントループへ順番を譲る変更（CARD-13）で、ポーリングが自分の接続中に走るようになって表に出た → `pcsc/pure.ts` の `effectiveInUse`: 自分の接続中と閉じてから 1 秒は無視し、自分のでない INUSE も 2 回続けて見えたときだけ出す → `tests/pcsc-backend.test.ts`「INUSE caused by our own connection」・`tests/pcsc.test.ts`（規則を外すと落ちることを確認）。直した後、実機で 4 回読み取って一度も出ないことを確かめた。
- **実機への書き込み（2026-11-13、捨ててよい NTAG213・UID 04:DA:21:D2:D8:38:80）**: `npm run hw:write` で、画面の操作どおりに、バイナリ編集で 2 バイト変えて書く・NDEF に URL を書く（ホームで 1 件と出る）・バックアップを保存してから、読み取った文書からとファイルから「このタグに戻す」・NDEF の消去、を通した。どれも読み取り直して照合 OK。確認ダイアログの書き込み先の UID も正しかった。確認で押してから結果が出るまで 0.46〜0.57 秒。最後にユーザー領域を元に戻し、全 45 ページが書く前と一致した。2 回流して 2 回とも通った。ロック・CFG・パスワードは書いていない（不可逆、または PaSoRi ではパスワード認証ができず戻せないため）。
- 確かめていない: 書き込みの途中でタグを離す（人の手が要る）、一括発行（タグを入れ替える人の手が要る）、MIFARE Classic（手元に無い）。

## UX 改修 第 2 回（2026-11-13、敵対的レビュー 39 件 + E2E）で分かった罠

- **NTAG の PWD/PACK を書くと実機では必ず「照合に失敗」** → 実機は PWD・PACK を読み出すと 00 を返すのに、照合が書いた値と比べていた。仮想リーダーは格納値を返していたので単体も E2E も緑のまま → 照合で PWD・PACK のページを比べない（`service.ts` の `unverifiable`）、仮想リーダーも 00 を返す → `tests/nfc-service.test.ts`「NTAG password setup with verify」・`tests/nfc-service-readers.test.ts`。**シミュレータが実機より親切だと、嘘の緑になる**（仕様の 00 返し・再活性化での発効を、シミュレータにも入れる）。
- **PaSoRi（ストレージ方式）ではパスワード認証が黙って飛ばされていた** → `ntag.ts` が raw 無しなら PWD_AUTH を送らずに戻っていた。画面は「パスワードを入れれば読める」と案内 → main は `READER_NO_AUTH` を返す。renderer はタグが無くても `ReaderStatus.activeDriver` で方式が分かる → `tests/nfc-service-readers.test.ts`（activeDriver）・`tests/shell-home.test.ts`・`tests/issue-model.test.ts`。
- **バックアップのファイルに、打った鍵 A・PWD が入っていた**（ヘルプは「含めない」と書いていた）→ 保存は `encodeDump` の 1 経路で、保存の前に 00 にする → `tests/backup.test.ts`「R-UX-3」。
- **自動読み取りが、置かれた MIFARE 系のどのカードにも運用者の全部の鍵で認証を試していた**（偽装カードに試行を集められると mfkey32 で鍵を割り出される）→ 自動読み取りは標準鍵だけ（D9）。
- **一括発行の「書き込む前の失敗」を「途中まで書いた」とみなして番号を欠番にしていた** → 書けた単位が 1 つでもあるときだけ partial → `tests/issue-engine.test.ts`。
- **トーストが右下の主ボタン「タグに書き込む」を約 4.5 秒覆い、押しても反応しない**（E2E で 0.5 秒ごとに実測）→ 書き込みの成功トーストをやめ（結果は LastWriteCallout）、トーストを実行バーに重ねない・確認ダイアログの間は奥へ（D13）→ `tests/e2e/e12-toast-cover.spec.ts`（直る前は `test.fail` で置き、直って「expected to fail, but passed」になったので普通の番人にした）。
- **Workflow の担当が週の利用上限で止まると、「中途半端な編集」より「報告だけ未提出」のことが多い**（2026-11-12 は 4 担当とも、実装とテストの追加を終えた後の最終確認で止まった）→ 再開は、担当の記録（`subagents/workflows/<run>/agent-*.jsonl`）の編集の一覧と最後の文、scratchpad の書きかけのテストがリポジトリに入っているかを照らし、型検査・全テストを流してから、残りを統括が直接進める。統合担当は担当より後に動くので、同じ上限で何もせずに止まる。
