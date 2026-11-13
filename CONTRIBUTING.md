# 参加のしかた

不具合の報告・要望・Pull Request を歓迎します。やりとりは日本語でも英語でもかまいません。

## 不具合の報告・要望

[Issues](https://github.com/UnlitCube/nfc-tag-studio/issues) の雛形を使ってください。アプリの版・Windows の版・リーダーの機種・タグの種類があると、早く直せます。

- **UID・鍵・パスワード・タグのダンプは貼らないでください。** 架空の値（例: `04:A1:B2:C3:D4:E5:F6`）に置き換えてください。
- 脆弱性は Issue に書かず、[SECURITY.md](SECURITY.md) の手順で知らせてください。

## 受け付けないもの

このアプリは、管理・運用する権限を持っているタグのための道具です。次の機能を足す提案・Pull Request は受け付けません（[docs/DESIGN.md](docs/DESIGN.md) の不変条件 I1〜I6）。

- UID の書き換え・magic card（UID を書き換えられるタグ）向けのバックドア
- MIFARE Classic の鍵の解析・総当たり・辞書攻撃（公開されている標準の鍵の同梱は除く）
- 鍵・パスワードをログ・台帳・ファイルに残す変更

## 開発の始め方

[Wiki の「開発者向け」](https://github.com/UnlitCube/nfc-tag-studio/wiki/開発者向け) に、ビルド・テスト・CI の説明があります。

```bash
npm ci
npm run dev       # 開発起動
npm test          # 型検査 + 単体テスト + ロジックのスモーク
npm run e2e       # 画面の流れ（仮想リーダーだけ）
```

## Pull Request の前に

- `npm test` と `npm run e2e` が通ること。CI（`ci.yml`）は、ほかに通知・CHANGELOG・文書・サイトも見ます。
- 画面の文言は `src/renderer/src/i18n/` に日本語と英語を同時に足します（型で過不足が落ちます）。用語は既存の画面にそろえます（「読み取る」「タグに書き込む」「置く」「離す」など）。
- 利用者に見える変更は、[CHANGELOG.md](CHANGELOG.md) の `## vNext` に 1 行足します。
- 本番の依存を変えたら `npm run build && npm run notices` で `THIRD_PARTY_NOTICES.txt` を作り直します。GPL・AGPL の依存は入れません。
- 新しいロジックには単体テストを足します。実機のリーダーやタグが要る確認は、何で確かめたかを Pull Request に書いてください。

## 行動規範

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) に従ってください。
