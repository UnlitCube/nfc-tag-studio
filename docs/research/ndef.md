# NDEF コーデック調査メモ（shared/ndef）

担当: shared-ndef。対象ファイル: `src/shared/ndef/**`（`types.ts` を除く）。純粋 TS（Node/DOM 非依存。TextEncoder/TextDecoder のみ可）。

このメモは実装で使った仕様値の根拠。正典は `docs/DESIGN.md`。不変条件 I1/I2 のとおり **UID は読み取り専用**で、NDEF はデータ領域だけを扱う。MIFARE の書き込みはデータブロックのみで、ブロック0（UID/製造者）とセクタトレーラ（鍵・アクセス条件）には一切触れない。

## レコード（NFC Forum NDEF / RTD）

ヘッダバイト = `MB ME CF SR IL` + TNF(3bit)。続いて 型長(1) / ペイロード長(SR なら 1、でなければ 4 の BE) / ID 長(IL のとき 1) / 型 / ID / ペイロード。

- SR（Short Record）は **ペイロード長 < 256** のとき。境界は 255=SR(1バイト長 0xFF) / 256=非SR(4バイト長 00 00 01 00)。
- IL は ID があるとき。
- CF（Chunk Flag）: 先頭チャンクは実 TNF + CF、継続チャンクは TNF=UNCHANGED(0x06)・型長0・CF、最終チャンクは CF クリア。ペイロードを連結する。
- 空メッセージ = 空レコード `D0 00 00`（MB|ME|SR, TNF=EMPTY）。

### URI RTD（型 'U' = 0x55）
ペイロード = 先頭1バイトの短縮コード + 残り URI(UTF-8)。短縮表は 0x00–0x23 の 36 個（`URI_PREFIXES`）。エンコード時は**最長一致**の非空プレフィックスを選ぶ（例: `https://www.example.com` → 0x02、`https://example.com` → 0x04）。

主な値: 0x00="", 0x01="http://www.", 0x02="https://www.", 0x03="http://", 0x04="https://", 0x05="tel:", 0x06="mailto:", 0x1D="file://", 0x23="urn:nfc:"。

### Text RTD（型 'T' = 0x54）
ペイロード = ステータス(1) + 言語コード(ASCII) + 本文。ステータス bit7 = 文字コード(0=UTF-8,1=UTF-16)、bit0–5 = 言語コード長(最大63)。UTF-16 は BOM(FE FF=BE / FF FE=LE)を見て判定、無ければ BE 既定。本実装は UTF-16 を BOM FE FF + UTF-16BE で書く。

### Wi-Fi（MIME `application/vnd.wfa.wsc`）
WPS(Wi-Fi Simple Config)属性 TLV: 2バイト BE 型 + 2バイト BE 長 + 値。Credential(0x100E)の中に Network Index(0x1026)・SSID(0x1045)・Authentication Type(0x1003,2B)・Encryption Type(0x100F,2B)・Network Key(0x1027)・MAC Address(0x1020,6B)。

- 認証: Open=0x0001 / WPA-PSK=0x0002 / WPA2-PSK=0x0020 / WPA/WPA2 混在=0x0022 / WPA3=0x0040（0x0040 は標準外の便宜値）。
- 暗号: None=0x0001 / TKIP=0x0004 / AES=0x0008 / AES+TKIP=0x000C。
- **注意**: WPS Credential に「ステルス(hidden)SSID」の標準フィールドは無い。draft の `hidden` は書き込まず、デコードは常に false。

### vCard（MIME `text/vcard`）
vCard 3.0。CRLF 区切り。`FN`(必須)・`N`・`ORG`・`TITLE`・`TEL`・`EMAIL`・`URL`・`ADR`(`;;<住所>;;;;`)・`NOTE`。値は `\ , ; 改行` をエスケープ。解析は折り返し(先頭空白の継続行)を結合し、未知プロパティは無視。`text/x-vcard` も受理。

### その他
- AAR: External(TNF=4) 型 `android.com:pkg`、ペイロード = パッケージ名。
- external: External 型 `ドメイン:名前`、ペイロードはテキスト or hex。
- Smart Poster: Well-Known 型 'Sp'(53 70)、ペイロードは URI(U) + 任意のタイトル(T) を入れ子にした NDEF メッセージ。
- raw: TNF/型/ID/ペイロードをそのままバイト往復。
- decodeRaw は認識できないものを全て raw にフォールバック（往復でバイト一致）。

## Type 2（NTAG）TLV と容量

TLV: `03 L V`。L>=255 は `03 FF hi lo`。終端は `FE`。NULL(0x00)はパディング。走査は `00 NULL / 01 Lock / 02 Memory / 03 NDEF / FD Proprietary / FE Terminator` を認識。

- **NDEF 領域は CC 申告値**: NTAG213=144 / 215=496 / 216=872 バイト（ユーザーメモリ 144/504/888 とは別。215 は差がある）。CC = `E1 10 <領域/8> 00`（12/3E/6D）。
- `type2Capacity` = 申告値 − オーバーヘッド。254 以下は 1バイト長で `area−3`、それ超は 3バイト長で `area−5`。結果: 213=141 / 215=491 / 216=867。
- `buildType2UserArea` は `userBytes` ちょうどのバッファ（先頭に TLV、残り 0）。容量超過は NdefError。

## MIFARE Classic NDEF（MAD 方式）

MAD(MIFARE Application Directory)でセクタごとの AID を引き、**AID=0x03E1** のセクタのデータブロックを連結して TLV 走査する。

- MAD1: セクタ0 のブロック1–2（バイト 16–47）。先頭 CRC+Info、続いてセクタ1–15 の 2バイト AID。セクタ s の AID はバイト `16+2s`。
- MAD2(4K): セクタ16 のブロック64–66（バイト 1024–1071）。CRC+Info の後にセクタ17–39 の AID。セクタ s の AID はバイト `1024+2(s−16)`。
- AID は `[アプリケーションコード, 機能クラスタコード]` の順でメモリに並び、NDEF は `03 E1`（本実装は上位バイト先頭で 0x03E1 と比較）。
- データブロック = 各セクタのトレーラ以外（小セクタ3ブロック / 4K の大セクタ 15ブロック）。セクタ0・16（MAD）とトレーラ・ブロック0は読み書き対象外。
- `buildMifareNdefWrites` は NDEF セクタのデータブロックにだけ TLV を並べる（MAD・トレーラは書かない）。未フォーマット（NDEF セクタ無し）や容量超過は NdefError。CRC/GPB は検証しない（実タグでばらつくため AID のみで判定）。

参考: NXP AN10787（MAD）、NFC Forum Type 2 Tag / Type MIFARE Classic Tag、URI/Text/Smart Poster RTD、Wi-Fi Simple Config(WSC)。
