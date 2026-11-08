# データスキーマ形式（`*.nfcschema`）

`src/shared/schema/**` が実装するデータスキーマの仕様。スキーマは「事務員が発行するタグのデータ領域に、社員 ID・会員番号・発行日などをどう並べるか」を GUI で組み、JSON で保存・共有するためのもの。モデル型は `src/shared/schema/types.ts`（契約ファイル・凍結）にある。本書は実装（codec / validate / template / csv / checksum / presets）の振る舞いを定める。

最終更新: 2026-11-09（担当: shared-schema）

## 0. 不変条件（最重要）

- **UID は製造時に固定され、読み取り専用。スキーマは UID を一切書き換えない。**
  `uid` ソース（`{ kind: 'uid', part: 'full' | 'last4' }`）は、読み取った UID を**データ領域に参照として控える**だけで、UID を複製・変更しない。別のタグへ UID をコピーする手段は持たない（I1 / I2）。
  複製は「データ領域だけ」をコピーする操作であり、UID は複製されない。文言・ヘルプでもそう説明する。
- MIFARE Classic はブロック 0（製造者ブロック）とセクタトレーラを**決して書かない**。`raw` のバイト列はブロック 0 とトレーラを自動で飛ばして連続する（I2 / I3）。
- 鍵・パスワードはスキーマにもログにも値にも入れない（I4）。

## 1. ファイル

- 文字コードは UTF-8。先頭の BOM（`EF BB BF`）は読み込み時に許容する。
- `serializeSchema` は 2 スペースのインデントで整形し、末尾に改行を 1 つ付ける。
- 拡張子は `*.nfcschema`。中身は `DataSchema` の JSON。
- `parseSchemaFile(bytes)` は BOM を剥がし、JSON を解析し、`validateSchema` に通す。JSON として壊れていれば `FORMAT` エラー 1 件で `schema: null`。

```jsonc
{
  "format": "nfc-tag-studio/schema",
  "version": 1,
  "id": "preset-employee-id",
  "name": "社員証 ID",
  "description": "…",
  "tagKinds": ["NTAG213", "NTAG215", "NTAG216"],
  "area": { "mode": "raw", "startUnit": 4 },
  "size": 9,
  "fields": [ /* SchemaField[] */ ],
  "createdAt": "2026-11-09T…",
  "updatedAt": "2026-11-09T…"
}
```

## 2. 配置（`area`）

| mode | 意味 |
|---|---|
| `{ mode: 'raw', startUnit }` | データ領域の `startUnit`（NTAG はページ、MIFARE はブロック）から**連続したバイト列**として置く。MIFARE はブロック 0 とセクタトレーラを飛ばし、データブロックだけで連続する。 |
| `{ mode: 'ndef', recordType, type }` | 1 つの NDEF レコード（`mime` または `external`、`type` はその型名）のペイロードとして置く。NTAG は Type 2 TLV として、MIFARE は MAD 済みカードの NDEF セクタへ。 |

`size` はレイアウトが占める総バイト数（`>= max(offset + length)`）。

### バイトストリームと単位の対応（raw）

- NTAG: `startUnit` のページから 4 バイトずつ連続。ユーザー領域（ページ 4〜`userLast`）に収める。設定ページ・ロック・CC・UID にかかると `PROTECTED_AREA`。
- MIFARE: `startUnit` のブロックから 16 バイトずつ。ブロック 0 とトレーラは飛ばす。`startUnit` 自体がブロック 0 / トレーラなら `PROTECTED_AREA`。収まらなければ `TOO_LARGE_FOR_TAG`。

部分的にしかかからない末尾の単位は、`buildSchemaWrites` が元イメージのバイトを温存する（変化した単位だけを返す）。

## 3. フィールド（`SchemaField`）

`id` は `[a-z][a-z0-9_]*`。`offset` はスキーマ領域先頭からのバイト位置、`length` はバイト数。`type` と `source` の組で値の由来と符号化が決まる。

### 3.1 型（`type`）

| type | 符号化 | 備考 |
|---|---|---|
| `uint` | 符号なし整数、`length` バイト、`endian`（既定 `be`） | 1〜8 バイト。`digits` は表示の 0 詰めのみ。 |
| `bcd` | パック BCD（1 バイト 2 桁）、右詰め 0 詰め | `length*2` 桁まで。超過で `SchemaValueError`。 |
| `ascii` | ASCII（0x20–0x7E のみ）、`length` に `pad`（既定 `zero`）で詰める | `align: 'right'` で左詰め（数字 ID 向け）。範囲外文字で例外。 |
| `utf8` | UTF-8、`pad` で詰める | 多バイト文字を分割しない（収まらなければ例外）。 |
| `hex` | 16 進テキストを厳密に `length` バイト | 桁数が合わないと例外。固定値向け。 |
| `date` | `dateFormat` + `dateEncoding` で符号化 | 下表。 |
| `checksum` | 他フィールドの符号化バイトから計算 | `source` は `computed` 必須。 |

#### date

`dateEncoding` は既定 `bcd`（`unix32` では無視）。

| dateFormat | 桁 | bcd バイト | ascii バイト |
|---|---|---|---|
| `YYYYMMDD` | 8 | 4 | 8 |
| `YYMMDD` | 6 | 3 | 6 |
| `YYYYMMDDhhmm` | 12 | 6 | 12 |
| `unix32` | — | 4（BE uint 秒） | 4 |

日付の分解・組み立てはローカル時刻の年月日時分秒で行う（`new Date(y, mo-1, d, …)` と同じ）。`fixed` ソースは ISO（`YYYY-MM-DD` / `YYYY-MM-DDThh:mm[:ss]`）または詰めた数字列を受ける。復号は日付のみの形式を `YYYY-MM-DD`、時刻付きを `YYYY-MM-DDThh:mm`、`unix32` を `YYYY-MM-DDThh:mm:ss` に戻す。

### 3.2 由来（`source`）

| kind | 値 | 使える type |
|---|---|---|
| `fixed` | 定数（`value`） | checksum 以外すべて |
| `input` | 発行ジョブごとに 1 回入力（既定 `defaultValue`、キーは field `id`） | checksum 以外すべて |
| `sequence` | 連番カウンタ + `offset`。**連番 ID の核** | `uint` / `bcd` / `ascii` |
| `csv` | 割り当てた CSV 行の `column` | checksum 以外すべて |
| `now` | 書き込み時の日時 | `date` |
| `uid` | 読み取り専用 UID の写し（`full` / `last4`、16 進） | `hex` / `ascii` / `utf8` |
| `computed` | checksum 専用 | `checksum` |

`digits` が設定され値が数字だけのとき、表示と ascii 符号化の前に 0 詰めする（例: `sequence` + `digits: 6` → `000042`）。

## 4. API の振る舞い

| 関数 | 振る舞い |
|---|---|
| `renderValues(schema, ctx)` | field id → 表示文字列。**寛容**（値が不正でも例外を投げず空にする）。プレビュー用。 |
| `encodeSchema(schema, ctx)` | `{ bytes(length=size), values }`。値が収まらないと `SchemaValueError(fieldId, …)` を投げる。 |
| `decodeSchema(schema, bytes)` | `{ values, issues }`。checksum 不一致は `issues`（`VALUE`・warning）。 |
| `schemaAreaFromImage(schema, img)` | raw は該当バイト、ndef は最初に一致する NDEF レコードのペイロード。無ければ `null`。 |
| `buildSchemaWrites(schema, kind, data, area)` | 変化した単位の `UnitWrite[]`。禁止・保護単位は返さない。かかるときは `SchemaValueError('_area', …)`。 |
| `expandTemplate(text, ctx)` / `expandDraft` / `listPlaceholders` | §5。 |
| `parseCsv` / `toCsv` | §6。 |
| `checksum(algo, bytes)` | §7。 |

`IssueContext` = `{ seq, row, inputs, uid, now }`。

## 5. プレースホルダ（NDEF テンプレート）

テキスト中の `{{…}}` を展開する。未対応のものは `SchemaValueError('_template', …)`。

| 記法 | 展開 |
|---|---|
| `{{seq}}` / `{{seq:6}}` | 連番（`:n` で 0 詰め） |
| `{{uid}}` / `{{uid:last4}}` | 読み取り専用 UID（16 進）/ 末尾 4 桁 |
| `{{date}}` / `{{date:YYYY-MM-DD}}` | 書き込み日（既定 `YYYYMMDD`） |
| `{{time:hhmm}}` | 書き込み時刻 |
| `{{csv:列}}` | 割り当て行の値 |
| `{{input:名前}}` | ジョブ入力値 |

日時トークン: `YYYY` `YY` `MM` `DD` `hh` `mm` `ss`（ローカル時刻）。`listPlaceholders` は出現順・重複なしでトークンを返す。

## 6. CSV（RFC 4180）

- `parseCsv(text)`: 先頭行をヘッダとし `{ header, rows }`。引用符フィールドはカンマ・改行・`""` エスケープを含められる。CRLF / LF 両対応。BOM 許容。足りない末尾列は `''`、余る列は捨てる。
- `toCsv(header, rows)`: CRLF 区切り。カンマ・`"`・CR・LF を含む値だけ `"` で囲み `"` を倍にする。数値は文字列化、`null`/`undefined` は空。末尾 CRLF なし。Excel 向け BOM は呼び出し側で付ける。

## 7. チェックサム

| algo | 出力 | 定義 |
|---|---|---|
| `xor8` | 1 バイト | 全バイト XOR |
| `sum8` | 1 バイト | 全バイト加算 mod 256 |
| `crc16-ccitt` | 2 バイト BE | CRC-16/CCITT-FALSE（poly 0x1021, init 0xFFFF, 反転なし）。`"123456789"` = `0x29B1` |
| `crc32` | 4 バイト BE | CRC-32/IEEE（poly 0xEDB88320 反転, init/xorout 0xFFFFFFFF）。`"123456789"` = `0xCBF43926` |
| `luhn` | 1 ASCII 数字 | 入力バイトを ASCII と見なし、数字（0x30–0x39）だけで Luhn チェックディジットを計算。`"7992739871"` → `'3'` |

checksum フィールドの `length` はアルゴリズムの出力幅に一致させる（違えば `LENGTH`）。

## 8. 検証（`validateSchema`）とエラーコード

`validateSchema(value, kind?)` は未知の値（JSON 解析結果や編集中スキーマ）を検証し、`error` が 1 つも無ければ正規化済みスキーマを、あれば `schema: null` を返す。`kind` を渡すとそのタグに収まるか・保護領域にかからないか（raw）も見る。

| code | 例 |
|---|---|
| `FORMAT` | `format`/`version`/`area`/`size`/`fields` や field 構造が不正 |
| `ID_INVALID` | field `id` が `[a-z][a-z0-9_]*` でない |
| `ID_DUPLICATE` | field `id` の重複 |
| `OVERLAP` | フィールドのバイト範囲が重なる |
| `OUT_OF_RANGE` | `offset+length > size` |
| `TOO_LARGE_FOR_TAG` | `kind` 指定時、raw がタグのデータ領域に収まらない（ndef は容量が分かるときのみ） |
| `LENGTH` | `uint` が 1〜8 外、`date` の長さ不一致、checksum 幅不一致 |
| `SOURCE_TYPE` | `source` と `type` の不整合（例: `now` を `uint` に、`computed` を非 checksum に） |
| `CHECKSUM_REF` | checksum の `over` が空・自己参照・存在しない id |
| `PROTECTED_AREA` | `kind` 指定時、raw が保護・禁止単位にかかる |
| `VALUE` | （復号時）checksum 不一致（warning） |

## 9. プリセット（`schemaPresets`）

`社員証 ID`（連番 + Luhn）/ `勤怠タグ`（社員番号 BCD + 発行日 + CRC-16）/ `会員番号`（組織コード + 連番 uint + XOR）/ `資産タグ`（接頭辞 + 連番 + 部門、MIFARE データブロック + CRC-32）。いずれも `validateSchema` を通る実用レイアウト。
