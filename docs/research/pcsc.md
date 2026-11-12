# PC/SC backend (koffi -> winscard.dll / libpcsclite / PCSC.framework)

Owner: agent `main-pcsc`. Scope: `src/main/nfc/pcsc/**`. Frozen signature:
`createPcscBackend(log): ReaderBackend` (see `src/main/nfc/backend.ts`).

最終更新: 2026-11-09。実機での検証は統合担当（開発 PC の PC/SC 機器）が行う。
この文書は、採用した呼び出し・構造体・戻り値・設計上の判断を残す。

## 不変条件との関係（I1/I2/I3）

このバックエンドは **APDU を素通しするだけのパイプ**で、UID を書く概念も magic card の
バックドアも持たない。鍵の解析・総当たり・辞書も無い。上位（`service.ts` / `mifare.ts` /
`ntag.ts`）が鍵と APDU を決め、ここはリーダーに届けて応答を返すだけ。

## ファイル構成

| ファイル | 役割 | 検証 |
|---|---|---|
| `pure.ts` | 純粋ロジック（定数・戻り値正規化・エラー→`OpError`・リーダー名パース・ATR 判定・SW 解釈）。koffi/Node/DOM 非依存 | `tests/pcsc.test.ts`（vitest、実機不要） |
| `winscard.ts` | koffi による唯一のネイティブ結合層。各メソッドは戻り値（PC/SC rv）を返し、throw しない | 統合担当が実機で確認（koffi 呼び出し本体） |
| `index.ts` | `createPcscBackend` 本体。監視ループ（ポーリング）と `CardConnection` の配線 | ループの配線は実機で確認 |

## 採用した呼び出し（Windows = 正）

`long __stdcall SCardXxxW(...)`。x64 では呼び出し規約は 1 種類なので `__stdcall` は実質
no-op だが明示している。ハンドル（`SCARDCONTEXT` / `SCARDHANDLE`）は `uintptr_t` で受ける。

- `SCardEstablishContext(SCARD_SCOPE_SYSTEM=2, null, null, &ctx) -> long`。`ctx` は `uintptr_t`。
- `SCardListReadersW(ctx, null, buf(char16), &len)`。`buf` は固定 2048 WCHAR。`len` はワイド文字数。
  応答は UTF-16LE の `\0` 区切り・二重 `\0` 終端。→ `parseReaderNamesW`。
- `SCardGetStatusChangeW(ctx, timeout, SCARD_READERSTATEW[], n)`。`timeout=0` で即時に現在値を読む。
  `dwEventState` の `0x20`=`SCARD_STATE_PRESENT`、`0x100`=`SCARD_STATE_INUSE`、`cbAtr`/`rgbAtr(36)` に ATR。
- `SCardConnectW(ctx, readerW, SCARD_SHARE_SHARED=2, SCARD_PROTOCOL_T0|T1=3, &hCard, &activeProtocol)`。
- `SCardTransmit(hCard, &SCARD_IO_REQUEST(dwProtocol, cbPciLength=8), apdu, apduLen, null, recv, &recvLen)`。
  `dwProtocol` は `activeProtocol`（T0=1 / T1=2）。
- `SCardDisconnect(hCard, SCARD_LEAVE_CARD=0)`。`SCardReleaseContext(ctx)`。`SCardCancel(ctx)` で停止。

### 構造体（koffi.struct、ABI は koffi がパディング計算）

```
SCARD_READERSTATEW { szReader: str16; pvUserData: void*; dwCurrentState: u32;
                     dwEventState: u32; cbAtr: u32; rgbAtr: u8[36] }
SCARD_IO_REQUEST   { dwProtocol: u32; cbPciLength: u32 }   // cbPciLength = 8
```

`_Out_`/`_Inout_` は `koffi.out` / `koffi.inout` と配列（out スカラは `[0]`、
readerstate 配列はオブジェクトの配列を inout で渡して書き戻す）で受ける。

## 戻り値（SCARD_* HRESULT, 符号なし 32bit で比較）

koffi の `long` は Windows では 32bit 符号付きで返るため、`normalizeRv = Number(rv) >>> 0`
で符号なしに直してから比較する（Linux の 64bit `long`/bigint も `Number()` で吸収）。

| rv | 意味 | 扱い |
|---|---|---|
| `0x00000000` SUCCESS | 成功 | - |
| `0x8010001D` NO_SERVICE / `0x8010001E` SERVICE_STOPPED | サービス停止/未起動 | `service: unavailable`、数秒ごと再試行 |
| `0x8010002E` NO_READERS_AVAILABLE | リーダー無し | 空リスト（サービスは ok） |
| `0x80100017` READER_UNAVAILABLE / `0x80100009` UNKNOWN_READER | リーダー不在 | `NO_READER` |
| `0x8010000C` NO_SMARTCARD / `0x80100010` NOT_READY | カード無し | `NO_CARD` |
| `0x80100069` REMOVED_CARD / `0x80100068` RESET / `0x80100067` UNPOWERED | 処理中に離れた | `CARD_REMOVED` |
| `0x8010000B` SHARING_VIOLATION | 他プロセスが占有 | `BUSY` |
| `0x8010001C` CARD_UNSUPPORTED / `0x80100066` UNRESPONSIVE / PROTO_MISMATCH | 非対応/無応答 | `UNSUPPORTED_TAG` |
| `0x8010000A` TIMEOUT / `0x80100013` COMM_ERROR / `0x8010002F` COMM_DATA_LOST | 転送失敗 | `READ_FAILED` |
| `0x80100002` CANCELLED / `0x80100012` SYSTEM_CANCELLED | 中止 | `CANCELLED` |
| その他（INVALID_* / NO_MEMORY / INTERNAL） | - | `INTERNAL` |

`OpError.detail` には **コード名だけ**（例 `SCARD_W_REMOVED_CARD`）を入れる。鍵・パスワードは入れない（I4）。

## 監視ループの方針

- `createPcscBackend` と `start()` は **同期 throw しない**。`start()` は非同期ループを起動するだけ。
- ループは `establishContext → listReaders → getStatusChange(timeout=0)` を `POLL_INTERVAL_MS=600`
  ごとに回す。サービス不在・ライブラリ欠落（`koffi.load` が throw）のときは `service: unavailable`
  を出し、`RETRY_INTERVAL_MS=3000` ごとに再試行して復帰を検出する。
- `BackendEvent`: `service` / `readers`（スナップショットが変わったときだけ）/ `card-inserted`（ATR 付き）
  / `card-removed`。重複は `readerListEqual` と直前状態 Map で抑制。
- `refresh()` は待機を即時起床。`stop()` は running を落とし、開いた接続を `disconnect` し、
  `SCardCancel` → ループ終了を待って `SCardReleaseContext`。
- `isLikelyContactlessReader`（`src/shared/reader.ts`）で USB トークンを NFC と誤認しない（I6）。
  ATR が PC/SC Part3 のストレージ ATR（`parseStorageAtr`）なら非接触と判定。

## カード接続（CardConnection）

- `transmit` は内部プロミス連鎖で**直列化**（同一ハンドルへの同時 `SCardTransmit` を避ける）。
  成功時は SW1 SW2 込みの応答を `Uint8Array` で返す。REMOVED/RESET/UNPOWERED は `OpError('CARD_REMOVED')`、
  koffi 例外は `OpError('READ_FAILED')`、その他 rv は `opErrorForPcsc`。
- `disconnect` は冪等（`SCARD_LEAVE_CARD`）。

## mac / Linux（副次・未検証）

同じ呼び出し形で ANSI（`SCardListReaders` / `SCardGetStatusChange` / `SCardConnect`、`szReader` は
`const char*`）・cdecl・`rgbAtr[33]` に切り替える（`winscard.ts` の `process.platform` 分岐）。
pcsclite の `LONG`/`DWORD` の幅差は `normalizeRv` と `uintptr_t` ハンドルで吸収する想定。
開発 PC は Windows のみのため、非 Windows 経路は実機未検証（統合担当が確認）。

## 開発 PC の既知事項（2026-11-08、`src/shared/reader.ts` より）

唯一見えた PC/SC 機器は Feitian の USB トークン `FS USB Token 0`（接触 ATR `3B 9F 95 81 ...`）。
NFC リーダーではないので、自動で APDU を送らない・NFC と誤認しない。

## 2026-11-12 UX 改修で変えたこと（main-nfc / main-pcsc、統合担当が記録）

- **ポーリングは 300 ms**（`POLL_INTERVAL_MS`）。失敗時の再試行は 3 s。
- **差し替えの検出**: `SCardGetStatusChange` の `dwEventState` の上位 16 ビット（イベントの回数）か ATR が変わったら、`card-changed` を出す。回数の変化は「差し替えの疑い」として出すだけで、service が UID を読み直し、同じなら何もしない（防御的な実装）。**実機（PaSoRi）の差し替えでは未確認**。自分の接続が開いている間の回数の変化は、閉じてから判断する。
- **コンテキストの作り直し**（サービスの再起動・スリープからの復帰・USB のリセット）: 見えていたタグをすべて `card-removed`、リーダー一覧を空にしてから再接続する。戻ったときは同じタグにも `card-inserted` が出る。一括発行はこれを取り外しと見なさない（`src/main/issue/engine.ts` の `REMOVAL_SETTLE_MS`。`tests/issue-engine.test.ts` の「PC/SC context reset」）。
- **Windows の `SCARD_E_NO_SERVICE` / `SERVICE_STOPPED`** は、リーダーが 1 台も無いときにスマートカード サービスが止まる正常な状態なので、`service='no-readers'`（`serviceMessage` に rv 名）として「リーダーを接続してください」と出す。
- **koffi は初回の使用時に dynamic import** で読み込む。koffi が壊れていてもアプリは起動し、「PC/SC 利用不可」になる。
- **長い transmit の途中で 40 ms ごとに `setImmediate` で順番を譲る**（MIFARE 4K などの長い読み取りで窓が固まる件の緩和）。koffi の `.async` や worker への移行（完全な非同期化、監査 CARD-13）は、実機での検証が要るのでしていない。
- 単体テストは実機の PC/SC を起動しない: `createNfcService(deps, { pcsc: false })`。アプリでは開発ビルドに限り `NFCTS_NO_PCSC=1` で同じことができる（パッケージ版は無視）。
