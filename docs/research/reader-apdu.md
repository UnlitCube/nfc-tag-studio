# リーダー別 APDU / 生コマンドの通し方（main/nfc 調査メモ）

担当: main-nfc。対象ファイル: `src/main/nfc/{apdu,driver,ntag,mifare,simulator,service}.ts`。
最終更新: 2026-11-09。実機は開発 PC に無いため、ここの「実機の枠組み」は一次情報・一般的な実装に基づく best-effort。検証はシミュレータに対してのみ実施（`tests/nfc-*.test.ts`）。

## 1. 2 系統のコマンド

| 系統 | 使うバイト列 | 使う場面 |
|---|---|---|
| PC/SC storage pseudo-APDU | `FF CA` / `FF B0` / `FF D6` / `FF 82` / `FF 86` | MIFARE Classic 全部、NTAG を storage ドライバで読み書きするとき。リーダーのファームが解釈するので、どの非接触リーダーでも通る。 |
| NTAG 生コマンド（NFC-A フレーム） | `READ 0x30` / `FAST_READ 0x3A` / `WRITE 0xA2` / `GET_VERSION 0x60` / `PWD_AUTH 0x1B` / `READ_CNT 0x39` / `READ_SIG 0x3C` | NTAG の版判定・カウンタ・署名・パスワード、ページ読み書き（acr122 / transparent のとき）。 |

storage では生コマンドを送れない（`FF CA/B0/D6/82/86` だけ）。したがって storage ドライバでは NTAG の GET_VERSION・カウンタ・署名・PWD_AUTH が使えず、版判定は CC（ページ3）か ATR に頼る。

## 2. ドライバ推定（`driver.ts` `estimateDriver`）

リーダー名から解決。`auto` のときだけ推定し、明示指定はそのまま使う。

- `acr122`: ACR122U 系・Touchatag・PN53x。生コマンドは PN532 の **Direct Transmit**（InCommunicateThru）で通す。
  `FF 00 00 00 Lc  D4 42 <cmd>`（Lc は `D4 42` + cmd の長さ）。応答は `D5 43 <status> <payload>` + SW。status 0 が正常。
- `transparent`: ACR1252/1255/1281/1552/1555・Identiv/SCM・Sony/PaSoRi・HID OMNIKEY CL 等。PC/SC 2.02 Part 3 の **Transparent Exchange** を試す。
  `FF C2 00 01 Lc  95 <len> <cmd>`（オブジェクト `95` = ICC へ送るデータ）。応答はオブジェクト `C0`（結果ステータス）と `97`（ICC 応答）。
- `storage`: 上記以外（不明なリーダー）。read/write のみ。生コマンド無し。
- 仮想リーダー（`VIRTUAL_READER_NAME`）は PN532 相当として `acr122` にする（生コマンドが使える）。

> 注意: `ACR122` と `ACR1252` を取り違えない。`estimateDriver` は ACR122 系を先に判定し、ACR1252/1255 は transparent 側の名前パターンに入れている（`tests/nfc-driver.test.ts` で固定）。

## 3. 応答（SW）の解釈（`apdu.ts`）

- 成功: `90 00`。`splitResponse` で末尾 2 バイトを SW として剥がす。
- `swMeansDenied`: `69 82`（security status not satisfied）・`69 85`・`69 86`・`63 xx`（ACS の auth/read 失敗）を「権限なし＝denied」と扱う。
  - MIFARE: 認証前の read/write → `69 82`。鍵違い（`FF 86`）→ `63 00`。
  - NTAG storage: パスワード保護ページを認証無しで read → `69 82`（= denied）。
- 生コマンドの NAK（4bit）は 1 バイトの「非 ACK」応答（`0x0A` 以外の 1 バイト）として返る。WRITE / PWD_AUTH 成功の ACK だけが `0x0A`。`driver.ts` の `unwrapRawResponse` が NAK を見つけたら `READ_FAILED` ではなく **`ACCESS_DENIED`** を投げる（保護ページ・認証失敗＝denied）。判定は応答そのもの（短い非 ACK フレーム）で行うので、リーダーが NAK を status 0 で返しても非ゼロ status で返しても同じく denied になる（2026-11-09 修正。以前は「短い payload を返し ntag.ts の長さ判定で denied」にしていたが、実機が非ゼロ status で返すと `error` に落ちていた）。

## 4. 読み取りの方針（`ntag.ts` / `mifare.ts`）

- NTAG: 4 ページずつ READ（生）/ `FF B0`（storage）。読めないページは 0 埋め + `unitStatus = denied`/`error`、読み取り全体は失敗させない。カウンタ・署名・版は生のときだけ取得（display 用）。
- MIFARE: セクタごとに `deps.resolveKeys` の鍵を Key A → Key B の順で load+authenticate。開いたセクタだけ `FF B0` で read。開けないセクタは全ブロック denied、`MifareSectorAccess.keyType = null`。鍵バイトは結果・ログに出さない（ラベルのみ）。I3: 解析・総当たり・辞書・既知鍵同梱は一切しない。

## 5. 書き込みの方針（`service.ts` `validateWrites` → `ntag.ts`/`mifare.ts`）

書き込み前に main 側で再検査（UI が計画済みでも契約どおり main で守る）:

1. 書き込み直前に UID を読み直し、`expectedUid` と違えば `UID_MISMATCH`。
2. `isForbiddenUnit`（NTAG ページ0-1・MIFARE ブロック0 = UID）→ 常に `PROTECTED_UNIT`。I1/I2: UID は変えられない。UID 書き換えカード（magic / Gen1a / CUID）のバックドアは実装しない。
3. MIFARE トレーラで `parseAccessBits` が null（反転コピー不一致）→ 常に `INVALID_ACCESS_BITS`（I5: 不正アクセスビットは `allowProtected` でも拒否。書くとセクタが永久ロック）。
4. 保護単位（`isProtectedUnit`）は `allowProtected` が真のときだけ許可。偽なら `PROTECTED_UNIT`。
5. 検査を全件通ってから配列順に実書き込み。`verify` 時は書いた単位を読み直して照合。

## 6. シミュレータ（`simulator.ts`）

仮想リーダー + 仮想タグを `ReaderBackend`/`CardConnection` として提供し、`transmit` を APDU レベルで解釈（storage / acr122 / transparent の 3 枠組みすべて）。NTAG の READ/WRITE/GET_VERSION/PWD_AUTH、MIFARE の鍵一致検査をエミュレートするので、実機無しで read/write/issue が通る。

ハードウェアとしての不変条件を守る: UID（NTAG 0-1・MIFARE ブロック0）への書き込みは常に拒否、UID を変えるコマンドは存在しない、MIFARE は鍵一致でのみ開く、NTAG は PWD_AUTH が合うまで保護ページを返さない。

ATR は PC/SC Part 3 の storage 擬似 ATR（`A0 00 00 03 06 03 00 <NN NN>`）で、`NN NN` = 0001(1K)/0002(4K)/0003(Type2)。`kindHintFromAtr` が家族を返し、正確な版は GET_VERSION か CC で確定する。

## 7. 未検証（実機が必要）

- transparent（`FF C2`）の実バイト枠組みはリーダーごとに差がある。ここでは ACS/PCSC Part 3 の一般形（オブジェクト `95`/`97`/`C0`）を採用。実機（ACR1252U 等）が手に入ったら要確認。
- acr122 の WRITE 応答（PN532 が 4bit ACK/NAK をどう返すか）は実機差がある。本実装は 1 バイトの `0x0A` を ACK、それ以外の 1 バイト応答を NAK（→`ACCESS_DENIED`）として扱う。status の 0/非ゼロには依らない。
  - 残る想定外: 「非ゼロ status かつ応答ペイロードが空」でしか NAK を返さないリーダーだと、NAK とタイムアウトを区別できず `READ_FAILED`（=「読み取り失敗」表示）に落ちる。保護ページなら本来は `denied`。実機（ACR1252U 等）で要確認。
- 保護 READ → `denied` の判定はシミュレータでも実機の枠組み（NAK を非ゼロ status で返す）で検証している（`tests/nfc-driver.test.ts` の NAK→ACCESS_DENIED、`tests/nfc-service.test.ts` のパスワード保護往復）。
- MIFARE トレーラの読み戻しは実機同様にマスクする: Key A は常に `00`、Key B はアクセス条件が許すときだけ。`writeTag` の verify もこのマスクを通して照合するので、トレーラ書き込みが「鍵は読み戻せない」ために常に mismatch になることはない（`mifareTrailerReadbackMask`、`tests/nfc-simulator.test.ts`・`tests/nfc-service.test.ts`）。
- storage ドライバでの NTAG `FF B0` の最大 Le・末尾ページの折り返しはリーダー依存。実装は 16 バイト単位で読み、必要分だけ採用。

## 8. FeliCa Lite-S の判定（2026-11-12 UX 改修、main-nfc）

- storage 方式（PaSoRi）では Polling が使えないので、`FF B0 00 85 10`（SYS_C、ブロック 0x85）が `88 B4` なら Lite-S。SYS_C が読めなければ、ID ブロック 0x82 が読めるかで判定する（`src/main/nfc/felica.ts`）。
- 0x82 は 2026-11-12 に本物の Lite-S + PaSoRi で読めた（CLAUDE.md）。**0x85 が PaSoRi で読めるかは未確認**。
- 読み取りの途中でタグが離れた・応答しなくなったときは、ページ単位の 0 埋めの「成功」ではなく、読み取り全体を `CARD_REMOVED` / `CARD_UNRESPONSIVE` で失敗にする（タグは `FF CA` に答えるが特定のページが 2 回失敗した場合は、そのページだけ `unitStatus='error'` が残ることがある）。
