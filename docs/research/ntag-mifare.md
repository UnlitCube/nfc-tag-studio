# NTAG21x / MIFARE Classic — 実装メモ（shared/tag 調査）

担当: shared-tag。`src/shared/tag/**` の実装根拠。一次情報は NXP NTAG213/215/216 データシート
（CFG0/CFG1・ロックバイト）と MIFARE Classic データシート（アクセス条件表）。
不変条件 I1〜I4 を守る: UID は読み取り専用、magic card のバックドアや鍵解析は実装しない。
このファイルの数値はデータシート由来。実機での全数確認はしていない項目を末尾に明記する。

## メモリマップ（`../../src/shared/tags.ts` の定義に従う）

- NTAG ページ = 4 バイト。UID はページ 0-1（ページ 0 の 0-2 と ページ 1 の 0-3、ページ 0 バイト 3 は BCC0）。
  ページ 2 = BCC1・internal(0x48)・静的ロック 2 バイト。ページ 3 = CC（OTP）。ユーザーは 4..userLast。
  直後に dynLock, CFG0, CFG1, PWD, PACK（PACK が最終ページ）。
  - 213: 45 ページ / user 4..39 / dynLock 40 / CFG0 41 / CFG1 42 / PWD 43 / PACK 44
  - 215: 135 ページ / user 4..129 / dynLock 130 / CFG0 131 / CFG1 132 / PWD 133 / PACK 134
  - 216: 231 ページ / user 4..225 / dynLock 226 / CFG0 227 / CFG1 228 / PWD 229 / PACK 230
- MIFARE ブロック = 16 バイト。1K=16 セクタ×4、4K=セクタ0-31×4 + 32-39×16。
  各セクタ末尾がトレーラ（KeyA 6 | アクセスビット 4 | KeyB 6）。ブロック 0 は製造者ブロック。

## NTAG CFG0 / CFG1 レジスタ（NXP データシート）

CFG0（4 バイト）:
- byte0: `MIRROR_CONF`[7:6]（00 なし / 01 UID / 10 カウンタ / 11 両方）, `MIRROR_BYTE`[5:4],
  `STRG_MOD_EN` = bit2（出荷時 1）, bit3/bit1/bit0 は RFUI。
- byte1: RFUI
- byte2: `MIRROR_PAGE`
- byte3: `AUTH0`（保護開始ページ。0xFF = 保護なし）

CFG1（4 バイト）, byte0 = ACCESS:
- bit7 `PROT`（1 = 読み書き保護 / 0 = 書き込み保護のみ）
- bit6 `CFGLCK`（設定ページの恒久ロック）
- bit5 RFUI
- bit4 `NFC_CNT_EN`
- bit3 `NFC_CNT_PWD_PROT`
- bit2-0 `AUTHLIM`（0 = 無制限、それ以外は 2^AUTHLIM 回で失敗）
- byte1-3: RFUI（出荷時 213 は `05 00 00`）。書き込み時は保持する。

出荷時の既定値（`factoryImage`）: CFG0 = `04 00 00 FF`, CFG1 = `00 05 00 00`。
→ `readNtagConfig` は strongModulation=true, auth0=0xFF, 他は false/0 を返す（テスト済み）。

パスワード設定の書き込み順は **PWD → PACK → CFG1 → CFG0**（AUTH0 を最後に立てる）。
`buildNtagPasswordWrites` と `planWrites` のグループ並べ替えで保証する（DESIGN §3.1）。

## NTAG ロックバイト

静的ロック（ページ 2 の byte2=L0 / byte3=L1、Type 2 標準）:
- L0 bit3 = CC（ページ 3）ロック、bit4-7 = ページ 4-7、L1 bit0-7 = ページ 8-15。
- L0 bit0-2 = ブロックロック（BL。ロックビット自体を凍結）。

動的ロック（dynLock ページ byte0-2、byte3 は BL/RFUI）:
- **213: 1 ビット = 1 ページ**（ページ 16-39 を byte0=16-23, byte1=24-31, byte2=32-39 で覆う）。
- **215/216: 16 ページ単位**でロック（ページ 16 から）。`readNtagLockState` はこの粒度で
  `lockedPages` を展開し、userLast で打ち切る。

`buildNtagLockUserAreaWrites` は静的ロック 2 バイトと動的ロック byte0-2 をすべて 1 にして
ユーザー領域を恒久的に読み取り専用にする（I5: 上級者モード＋確認はビュー側）。UID ページの
BCC1/internal は保持する。

## MIFARE アクセス条件（データシートの条件表、`describeAccess`）

インデックス = (C1<<2)|(C2<<1)|C3。データブロック（グループ 0-2）:

| C1C2C3 | read | write | increment | decrement/transfer/restore |
|---|---|---|---|---|
| 000 | A/B | A/B | A/B | A/B |（transport 既定）
| 010 | A/B | 不可 | 不可 | 不可 |（読み取り専用）
| 100 | A/B | B | 不可 | 不可 |
| 110 | A/B | B | B | A/B |
| 001 | A/B | 不可 | 不可 | A/B |
| 011 | B | B | 不可 | 不可 |
| 101 | B | 不可 | 不可 | 不可 |
| 111 | 不可 | 不可 | 不可 | 不可 |

トレーラ（グループ 3）は KeyA/アクセス/KeyB の読み書き権を定める。本アプリの `AccessDescription`
では `read` = アクセスビットを読める鍵、`write` = トレーラ（鍵・アクセス）を書き換えられる鍵、に要約する。
transport 既定（`FF 07 80`）はデータ 000（A/B 全可）、トレーラ 001（read=A, write=A）。

`parseAccessBits`/`encodeAccessBits`（tags.ts）は反転コピーの整合で不正ビットを弾く。
`planWrites` はトレーラのアクセスビットが `null`（解釈不能）のとき **常に forbidden**（ACCESS_BITS_INVALID）。

## ダンプ形式

- `*.nfcdump`（native, UTF-8 JSON）: `{ format:"nfc-tag-studio/dump", version:1, kind, uid, unitSize,
  units:[hex...], unitStatus, ntag?, mifare?, note, savedAt, app }`。鍵・パスワードはメタに書かない（I4）。
  mifare のセクタ情報はラベルのみ（鍵バイトを持たない）。
- `.bin`（生イメージ）: サイズで種類判定（213=180, 215=540, 216=924, 1K=1024, 4K=4096）。
- `.nfc`（Flipper Zero, Version 4）: `Device type` / `UID` / `NTAG... type` or `Mifare Classic type` /
  `Page N:` `Block N:` を読み書き。往復はメモリイメージ・UID・種類を保つ（per-unit status・署名/カウンタは非可逆）。

## 実機で未確認（データシート由来・要注意）

- NTAG215/216 の**動的ロックの粒度（16 ページ/ビット）とビット→ページの割り当て**は
  データシートの記述に基づく表示用の実装。実タグでの全数確認はしていない。213（1 ページ/ビット）は
  ページ範囲 16-39 と矛盾なく、単体テストで確認済み。
- Flipper `.nfc` の ATQA/SAK/Signature/Counter は既定値で出力している（往復のメモリ内容には影響しない）。
