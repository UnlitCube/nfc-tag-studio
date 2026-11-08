# NFC Tag Studio

自組織で管理する NFC タグ（NTAG213/215/216・MIFARE Classic）を、事務員が安全に**発行・編集・バックアップ**するためのデスクトップアプリです。無料・MIT ライセンス。

> **対象と前提**: このアプリは、あなたが管理・運用する権限を持つタグやカードに使うためのものです。
> UID（製造番号）は製造時に固定され、書き換えできません。本アプリが扱うのは書き込み可能なデータ領域（ユーザーメモリ・NDEF）です。
> 他人のカードの不正な複製や認証の回避はできません（技術的にもできない設計です）。MIFARE Classic の鍵は、あなたが保有する鍵を登録して使います（鍵の解析はしません）。

## 主な機能

- **読み取り** — UID・種類・容量・NDEF・カウンタを表示。読めない領域（鍵・パスワードが必要）は明示。
- **バイナリ編集** — ページ／ブロック単位の hex エディタ。領域の色分け、**インクリメント**（連番カウンタの増減・開始値設定）、検索・置換・塗りつぶし・undo/redo。
- **NDEF 編集** — URL・テキスト・Wi-Fi・連絡先(vCard)・アプリ起動(AAR)・MIME・External・スマートポスター。容量メーター付き。
- **データスキーマ** — 社員 ID などの採番レイアウトを GUI で設計し JSON（`*.nfcschema`）で保存。**連番**・CSV・固定値・現在日時・UID の一部を値の元にできる。
- **一括発行** — タグをかざして連番・CSV・NDEF を 1 枚ずつ発行。重複スキップ・空タグのみ・照合・発行台帳（CSV 出力）。
- **バックアップ・複製** — `.nfcdump` / `.bin` / Flipper `.nfc` に保存し、別のタグへ復元・複製（データ領域のみ。UID は複製されない）。
- **MIFARE 鍵の管理** — 運用者の鍵を登録（伏字・OS キーストアで暗号化）。公開標準鍵を同梱。
- **仮想リーダー** — 実機が無くても全機能を試せます。

日本語／英語、ライト／ダークテーマ、効果音、初回ガイド、各画面のヘルプを備えています。

## 必要なもの

- Windows 10/11（macOS・Linux は未検証）
- PC/SC 対応の NFC リーダー（ACR122U・ACR1252U など）。無い場合は仮想リーダーで試用できます。
- Windows の「Smart Card (SCardSvr)」サービスが有効であること。

## 開発

```bash
npm install        # 依存の導入（Electron 本体の取得も自動）
npm run dev        # 開発起動（start-dev.bat をダブルクリックでも可）
npm run typecheck  # 型検査（2 つの tsconfig）
npm run unit       # 単体テスト（vitest）
npm test           # 型検査 + 単体
npm run build      # out/ にビルド
npm run dist:win   # Windows 向け portable/zip を release/ に生成
```

### 構成

- `electron-vite` + React 19 + TypeScript + zustand。
- `src/shared/` — main・renderer・テストが共有する純粋ロジック（タグのメモリマップ・NDEF・データスキーマ）。
- `src/main/` — プロセス本体、PC/SC（koffi → winscard.dll）、仮想リーダー、発行エンジン、IPC。
- `src/renderer/` — 画面。
- 設計書は [`docs/DESIGN.md`](docs/DESIGN.md)、作業メモは [`CLAUDE.md`](CLAUDE.md)。

## ライセンス

MIT License（[LICENSE](LICENSE)）。依存ライブラリ: Electron (MIT)、React (MIT)、zustand (MIT)、koffi (MIT)、lucide-react (ISC)。

## 免責

本ソフトウェアは現状有姿で提供されます。タグやカードへの書き込みは取り消せない場合があります。重要なタグは事前にバックアップし、ご自身の責任でお使いください。
