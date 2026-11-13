# リリースと公開の手順

配布物は Windows（x64）の portable の exe と zip。`release.yml` がタグ（`v*`）で作り、GitHub Release に載せます。

## 版の正と、版を書く場所

| 何 | 正 | 書く場所 |
|---|---|---|
| アプリの版 | `package.json` の `version` | `package-lock.json`（`npm version` が一緒に直す）・タグ `v<版>`・CHANGELOG の `## v<版> (YYYY-MM-DD)` |
| Node の版 | `.node-version`（配布物を作る版） | `package.json` の `engines.node`（下限）・ワークフロー（`node-version-file`）・README と Wiki の「開発者向け」 |

`release.yml` は、タグと `package.json` の版・CHANGELOG の節が合わなければ、ビルドの前に止まります。

## 毎回のリリース

1. **版を上げる**: `npm version <X.Y.Z> --no-git-tag-version`（`package.json` と `package-lock.json`）。
2. **CHANGELOG を整える**: `## vNext` の項目を、その下に足した `## v<X.Y.Z> (YYYY-MM-DD)`（括弧は半角）へ移し、`## vNext` は見出しだけ残します。確かめ方: `node tools/changelog-section.mjs --release --check`。
3. **手元で検査する**:
   - `npm test` と `npm run e2e`
   - `npm run build && npm run notices:check`（依存を変えたら `npm run notices` で作り直してコミット）
   - `npm run docs:check` と `npm run site:build`
   - 画面を変えたら `npm run shots` でキャプチャを撮り直す
   - `npm run dist:win` のあと `npm run smoke:packaged`（パッケージ版が起動するか）
4. **コミットして master に push** し、`ci.yml` が緑なのを確かめます。
5. **手動で `release.yml` を 1 回流す**（作る物や名前を変えたときは必ず）: Actions → release → Run workflow（master）。Release は作らず、検査・E2E・パッケージ・照合までを通します。
6. **タグを push する**: `git tag v<X.Y.Z>` → `git push origin v<X.Y.Z>`。`release.yml` が Release（0.x はプレリリース）を作り、`SHA256SUMS.txt` を添えます。公開済みなら Pages も作り直します。
7. **確かめる**: Release の添付が 3 つ（portable の exe・zip・SHA256SUMS.txt）あること、本文が CHANGELOG の節であること。

課金の見込み（リポジトリが Private の間）: `ci.yml` は 1 回 約 4〜6 分（Linux）、`release.yml` は Linux 約 6 分 + Windows 約 15 分（Windows は 2 倍で数える）。どちらも未計測で、初回の実行で直します。

## 初めて公開するとき（1 回だけ）

いまはリポジトリが **Private** です。Org（UnlitCube）は Free プランなので、**Pages と Wiki は Public にしてからでないと使えません**（`pages.yml`・`wiki.yml` は Private の間は何もしません）。

### 公開の前に確かめること（本人の判断）

- コミットの作者のメールアドレスが、全履歴に残り、Public にすると誰でも見られます（履歴の 15 コミット）。
- 製品名の商標の確認（J-PlatPat ほか）が済んでいません（[LEGAL.md](LEGAL.md) §4）。
- Public にすると、以後の push はすべて公開の push になります。Actions の標準のランナーは無料になります。

### 手順

```bash
# 1. Public にする（本人の明示の指示があったときだけ）
gh repo edit UnlitCube/nfc-tag-studio --visibility public --accept-visibility-change-consequences

# 2. リポジトリの説明・ホームページ・トピック
gh repo edit UnlitCube/nfc-tag-studio \
  --description "自組織の NFC タグ（NTAG・MIFARE Classic・FeliCa Lite-S）を読み取り・編集・一括発行する Windows アプリ" \
  --homepage https://unlitcube.github.io/nfc-tag-studio/ \
  --add-topic nfc --add-topic ntag --add-topic mifare --add-topic felica --add-topic pcsc --add-topic electron

# 3. 脆弱性の非公開の報告・秘密のスキャン（push の保護も）
gh api -X PUT repos/UnlitCube/nfc-tag-studio/private-vulnerability-reporting
gh api -X PATCH repos/UnlitCube/nfc-tag-studio \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'

# 4. Pages（公開元を GitHub Actions に）→ pages.yml を流す
gh api -X POST repos/UnlitCube/nfc-tag-studio/pages -f build_type=workflow
gh workflow run pages.yml --repo UnlitCube/nfc-tag-studio --ref master

# 5. Wiki をオンにする
gh repo edit UnlitCube/nfc-tag-studio --enable-wiki
```

6. ブラウザーで https://github.com/UnlitCube/nfc-tag-studio/wiki を開き、［Create the first page］で仮の Home を 1 枚保存します（Wiki のリポジトリは、最初のページを作るまで存在しません）。
7. `gh workflow run wiki.yml --repo UnlitCube/nfc-tag-studio --ref master` で、`wiki/` を Wiki に写します。Wiki への push が拒まれたら、Wiki に書ける fine-grained token を Secrets の `WIKI_TOKEN` に置いて流し直します。
8. 上の「毎回のリリース」の 5〜7 で v0.1.0 を出します。
9. 確かめる場所:
   - サイト: https://unlitcube.github.io/nfc-tag-studio/
   - Wiki: https://github.com/UnlitCube/nfc-tag-studio/wiki
   - Release: https://github.com/UnlitCube/nfc-tag-studio/releases

## 署名について

コード署名はしていません（SmartScreen の確認が出る。README・Wiki の「インストール」に手順）。署名するなら、`electron-builder.json` の `win` に署名の設定を足し、証明書は Secrets（`CSC_LINK`・`CSC_KEY_PASSWORD`）で渡します。
