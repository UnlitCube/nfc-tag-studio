# ライセンス・第三者のソフト・商標・特許

> **法的な助言ではありません。** 専門家による商標・特許の調査（FTO）はしていません。正式な判断が要るときは、弁理士・弁護士に相談してください。
> 最終確認日: 2026-11-13

## 1. このソフトのライセンス

MIT License（[LICENSE](../LICENSE)）。著作権者は UnlitCube です。配布物には `resources/LICENSE.txt` として同梱します。

## 2. 同梱する第三者のソフト

配布物（portable の exe・zip）に入る第三者のソフトと、そのライセンスの全文は [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) にあります（配布物では `resources/THIRD_PARTY_NOTICES.txt`）。手で書かず、`npm run notices` で作り、CI が `npm run notices:check` で古さと許可の一覧の外のライセンスを落とします（`tools/third-party-notices.mjs`）。

| 部品 | ライセンス | 入る所 |
|---|---|---|
| Electron・Chromium | MIT（Chromium は BSD ほか。`LICENSES.chromium.html`） | 実行の基盤 |
| React・React DOM・scheduler・zustand | MIT | 画面のバンドル |
| lucide-react | ISC | 画面のバンドル（アイコン） |
| koffi・@koromix/koffi-win32-x64 | MIT | PC/SC（winscard.dll）の呼び出し |
| rolldown の実行時の補助 | MIT | 各バンドル |
| NSIS 3 と plug-in（nsis7z・StdUtils は LGPL 2.1 以上）・elevate.exe（MIT） | zlib/libpng・LGPL 2.1・MIT | portable の exe の殻だけ（zip には入りません） |

許可するライセンスは MIT・ISC・BSD-2-Clause・BSD-3-Clause・Apache-2.0・0BSD・CC0-1.0・BlueOak-1.0.0 です。GPL・AGPL のものは同梱しません。portable の exe の殻の LGPL の plug-in は、electron-builder が配る未改変のビルドで、ソースの入手先を通知に書いています。

## 3. リポジトリの中で、MIT でないファイル

| ファイル | 中身 |
|---|---|
| `build/licenses/LGPL-2.1.txt` | GNU LGPL 2.1 の全文（通知のため） |
| `build/licenses/NSIS-COPYING.txt` | NSIS のライセンス |
| `build/licenses/StdUtils-LGPL-CLARIFICATION.txt` | StdUtils の LGPL の補足 |
| `build/licenses/elevate-LICENSE.txt` | elevate.exe の MIT ライセンス |

## 4. 商標

- NFC Tag Studio は、NXP Semiconductors・ソニー・Advanced Card Systems・NFC Forum の製品ではなく、各社から提携・承認を受けたものではありません。
- MIFARE・NTAG は NXP B.V. の商標です。FeliCa・PaSoRi はソニーグループ株式会社の商標です。NFC Forum は NFC Forum, Inc. の商標です。その他の名称は各社の商標または登録商標です。
- 他社の名前は、「どのタグ・リーダーと動くか」を示すためだけに使っています。他社のロゴは使っていません。

### 製品名について（確かめた範囲）

- 2026-11-13 にウェブ検索で「NFC Tag Studio」を調べ、同じ名前の製品は見つかりませんでした。似た名前に、iPhone 向けの「NFC Studio」（App Store）があります。
- **確かめていないこと**: 日本（J-PlatPat）・米国（USPTO）・EU（TMview）の商標のデータベース。公開・配布の前に、本人が確かめる予定です。

## 5. 特許

- 専門の調査（FTO）はしていません。
- このソフトは、NFC Forum の公開された仕様（NDEF・Type 2 Tag）、各社のデータシートに書かれた命令、PC/SC の標準の擬似 APDU だけを使い、タグに書かれた内容を読み書きします。暗号の解析や、認証の回避はしません。

## 6. 問い合わせ

ライセンス・商標についての指摘は [Issues](https://github.com/UnlitCube/nfc-tag-studio/issues) へ。公開の場に書きにくい内容は、[セキュリティポリシー](../SECURITY.md) の非公開の報告の窓口を使ってください。
