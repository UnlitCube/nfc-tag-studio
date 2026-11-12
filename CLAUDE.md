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
- 純粋ロジックは `src/shared/felica.ts`（Polling/Read/Write Without Encryption の組み立て・MC デコード）。**⚠️ この MC デコード/エンコードは誤り（2026-11-12 実機で判明、要修正）**: 実装は「MC[0]/MC[1]=ブロック別書込ビット（1=writable）、MC[2] bit0=SYS_OP」とするが、実機の Lite-S は **書込保護=MC[8:10]+MC[10:12]（1=保護）・読取保護=MC[6:8]・MC[2]=system ブロック書込可否（0xFF可/0x00読取専用）**。現状の `FlagEditor` の「FeliCa 読み取り専用化」は MC[0]/MC[1] を書くため**実機では無効（『ロックした』と偽表示）**。`simulator.ts` も同じ誤りモデルなので felica.test.ts は緑でも誤った意味を検証している。
- 仮想リーダーが FeliCa をエミュレート（`simulator.ts` の `felicaCommand`）。読み取り・編集・MC フラグ編集を実機なしで検証済み。

## NTAG 保護・認証の実機検証とバグ（2026-11-12、本物の NTAG213 + PaSoRi）

- PaSoRi は NTAG213 も PC/SC で読み書き可（読=`FF B0`、書=`FF D6` で 1 ページ 4 バイト、`90 00`）。UID `04 B0 21 D2 D8 38 80`。NTAG のリーダー層は元々 storage 経路対応なので FeliCa と違い実装は動く（PWD_AUTH・署名・カウンタは raw 専用で PaSoRi では不可）。
- **バグ N1（`readNtagLockState`、`src/shared/tag/ntag.ts`）**: 動的ブロックロック判定が `page0x28 の byte3 & 0x07` を見るが、**NTAG213 の page0x28 byte3 は常に `0xBD` 固定の読み出し値**（ロックビットではない）。→ **どの NTAG213 でも `blockLocked=true` の誤判定**（`0xBD&0x07=0x05`）。実機 factory カードで確認。動的 BL ビットは byte2 側（データシート図。NXP community の `00 00 3F` が BL を有効化）。
- **バグ N2（同ファイル）**: **NTAG213 の動的ロック粒度は 1 ビット=2 ページ**（実機で byte0 bit0 → page 0x10-0x11 の両方をロック確認）。アプリは `gran = NTAG213 ? 1 : 16`（1 ページ）としており、ロック対象ページの対応が 2 倍ずれる。実ロックビットは 12 本（byte0 全 8＋byte1 下位 4 ＝ pages 16-39 を 2 ページ単位）、残りは BL/RFUI。
- **ドライバ非対称（要注意）**: storage 経路では、**ロックビット保護ページへの書込は Sony ドライバが `90 00`（成功）を返す**のに実際は書かれない（＝`writeNtagPages`→`updateBinary` が失敗を検知できず成功と誤報告し得る）。一方**パスワード保護ページは `63 00`（失敗）**で検知可。→ storage 書込後は読み戻し検証が安全。
- 検証できた正しい挙動: パスワード保護（AUTH0 境界＋PROT 読取保護）は PaSoRi で機能（AUTH0 以上は read/write とも `63 00` 拒否、未満は開放）。**発効は再活性化後**（NTAG は `SCardReconnect(UNPOWER)` で発効。FeliCa の保護は物理抜き差し必須で差がある）。動的ロックは OTP（0→1 のみ・不可逆）。`buildNtagPasswordWrites` の順序（PWD→PACK→CFG1→CFG0/AUTH0 最後）と CFG0/CFG1 の factory 復号は妥当。

## パラメータ（フラグ）編集（2026-11-11 追加）

- `src/renderer/src/views/hex/FlagEditor.tsx`。設定を解説付き UI で編集し、共有のエンコーダ（`buildNtagConfigWrites`・`buildTrailer`・`encodeFelicaMc`）で保留中の編集に変換。取り消せない操作（CFGLCK・恒久ロック・MIFARE 読み取り専用・FeliCa 読み取り専用）は上級者モード＋警告。

## 単体テストの罠（この PC では vitest が動かない。2026-11-12 再確認）

- **vitest はこの環境で起動できない**。`describe()` の行で必ず `TypeError: Cannot read properties of undefined (reading 'config')`。真因は vitest 内部チャンクの `initSuite`（`runner.config` 参照）で、モジュール変数 `runner` が未設定（`clearCollectorContext(file, currentRunner)` が設定するはずが呼ばれていない／テスト側が別インスタンスの vitest を読んでいる＝モジュール二重化）。**src を一切 import しないトリビアルテストでも 100% 再現**。並列レースではない（単一ファイル・`--pool=forks`・`--no-isolate` でも同じ）。
- **やったが効かなかったこと（2026-11-12、再調査済み。繰り返さない）**: vitest 版変更（**4.1.12 / 5.0.5 / 5.1.0 すべて fail**）、`rm -rf node_modules && npm install` のクリーン再インストール、pool/isolate 切替、出力のファイル取り。`obug` 等の依存はレジストリと一致（改ざんではない）。vitest 5 の peer は `vite ^6.4||^7||^8`・node は `>=24` 対応＝公式には非対応ではない。**おそらく vite 8 + ワーカー + node24 + Windows の組み合わせ固有**。`@vitejs/plugin-react@6`・`electron-vite@6` が vite ^8 を要求するので vite を下げられず、**アプリの構成を変えない限り vitest は直せない**（別タスク。候補: 上流修正待ち／テスト用に vite を分離／WSL で純粋ロジックだけ回す）。
- **2026-11-12 前半の「lockfile 不整合が真因、整合で 401 件 green」は誤診だった**（後でトリビアルでも落ちると確認）。版・lock をいじっても直らない。
- **検証の代替手段**（vitest が直るまで）: ①`npm run typecheck`（動く）、②**`npm run test:smoke`**（`scripts/smoke-logic.cjs`＝`tsc` で `src/shared` を CJS 出力し `node` で中核ロジックをアサート。FeliCa MC・NTAG ロック等 31 件。vitest の代替ではなく回帰ガード）、③Electron アプリ + 仮想リーダーで実機能確認。
- **リーダーが PnP「Unknown」で PC/SC に出ない**ことがある（スリープ/再開後など）。PaSoRi を USB で抜き差しすると復帰。
