export const meta = {
  name: 'nfc-studio-impl',
  description: 'Implement NFC Tag Studio features in parallel from frozen contracts, with adversarial review and fixes',
  phases: [
    { title: 'Implement', detail: 'one agent per owned area (shared logic, pcsc, nfc service, views, main)' },
    { title: 'Review', detail: 'adversarial review of each area against DESIGN.md + contracts' },
    { title: 'Fix', detail: 'apply blocker/major fixes' },
  ],
};

const ROOT = 'C:/dev/nfc-editor';

const COMMON = `あなたは「NFC Tag Studio」（自組織で管理する NFC タグ NTAG213/215/216・MIFARE Classic を事務員が発行・編集・バックアップする Electron アプリ。フリー公開予定）の実装担当です。

■ 最初に読む（Grep で必要箇所だけ。通読しない）
- ${ROOT}/docs/DESIGN.md … 正典。§1.1 不変条件 I1〜I6、§3 契約、§4 ファイル所有表、§3.1 意味の約束。
- ${ROOT}/CLAUDE.md … 罠の台帳・開発コマンド。
- 自分が使う契約ファイル（DESIGN.md §3 の表）と、参照する src/shared の型。

■ 絶対に守る不変条件（最重要）
- I1/I2: UID は製造時固定の読み取り専用。UID 変更・magic card のバックドア（Gen1a/CUID 等）・UID 複製を実装しない。NTAG ページ0-1・MIFARE ブロック0 は常に書き込み禁止。
- I3: MIFARE は運用者が持つ鍵だけで開く。鍵の解析・総当たり・辞書・既知鍵リストの同梱をしない。同梱鍵は公開標準の3つだけ（FFFFFFFFFFFF / A0A1A2A3A4A5 / D3F7D3F7D3F7）。
- I4: 鍵・パスワードをログ・台帳・エラー detail・ダンプのメタに書かない。
- 文言・ヘルプでも「UID は複製できない。複製するのはデータ領域だけ」と説明する。

■ 規約
- 純粋ロジック（src/shared/**）は Node/DOM 非依存（TextEncoder/TextDecoder は可）。
- 画面文言は i18n/<feature>.ts に ja と en を同時に追加（defineMessages で型チェック）。キーは自分の feature 接頭辞。
- 色・寸法は src/renderer/src/styles/tokens.css のトークン経由。ビューに生の hex を書かない。lucide-react のアイコンを使う。
- main の例外は OpError(code, detail?)。detail に秘密を入れない。
- 契約ファイル（DESIGN.md §3）の関数シグネチャ・型・props・チャネル名・トークン名を変更しない。足りなければ報告に書く（統合担当が判断）。
- テストは tests/<area>*.test.ts（vitest、純粋ロジック）。実機なしで通ること。境界値と実フレームで検証。

■ 安全
- 作業ディレクトリは自分の worktree。他の担当のファイルに触らない（DESIGN.md §4 の所有表）。
- git checkout <file> / git restore / git stash を使わない。戻すときは逆編集か cp で。
- 一時ファイルは worktree 内の scratch/<自分のID>/ に置く。%TEMP% に作らない。外部 API・フォームにリクエストを送らない。
- git のコミットはしてよいが push・リモート作成はしない。トレーラ（Co-Authored-By 等）を付けない。
- 報告は日本語。実際に npm run typecheck と npm run unit を worktree で流して、通った範囲だけ verified に書く。通ったふりをしない。

今日は 2026-11-09。`;

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    typecheck: { type: 'string', enum: ['pass', 'fail', 'not_run'] },
    unit: { type: 'string', enum: ['pass', 'fail', 'not_run'] },
    tests_added: { type: 'array', items: { type: 'string' } },
    verified: { type: 'array', items: { type: 'string' } },
    not_verified: { type: 'array', items: { type: 'string' } },
    design_feedback: { type: 'array', items: { type: 'string' } },
    pitfalls: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files_changed', 'typecheck', 'unit'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          issue: { type: 'string' },
          scenario: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'issue', 'scenario', 'fix'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['issues', 'summary'],
};

// Areas. Each is implemented in its own worktree so they don't collide on the
// few shared files (they only touch their own paths per DESIGN.md §4).
const AREAS = [
  {
    key: 'shared-tag',
    label: 'shared/tag (image, write planning, NTAG config, MIFARE trailer, dump formats)',
    prompt: `担当: src/shared/tag/**（index.ts の公開シグネチャは凍結。実装を複数ファイルに分けて index.ts から re-export）。tests/tag*.test.ts。docs/research/ntag-mifare.md に調査を残す。
実装するもの（src/shared/tag/index.ts の NI スタブを本実装に）:
- blankImage/cloneImage/unitBytes/diffUnits/isBlankDataArea
- planWrites（最重要。base と edited を比較し最小の書き込み計画。禁止単位は除外し forbiddenUnits へ、保護単位は includeProtected のときだけ writes に入れ warning を付ける、MIFARE トレーラでアクセスビットが parseAccessBits===null なら forbidden + ACCESS_BITS_INVALID、未読単位に UNREAD_UNIT、NTAG のロック/CC の OTP ビットのクリアを警告）。パスワード関連は PWD→PACK→CFG1→CFG0 の順。
- readNtagConfig/buildNtagConfigWrites/readNtagLockState/buildNtagPasswordWrites/buildNtagRemovePasswordWrites/buildNtagCounterWrites/buildNtagLockUserAreaWrites（CFG0/CFG1 のビット定義は NXP NTAG21x データシートに従う。AUTH0・PROT・CFGLCK・NFC_CNT_EN・MIRROR）。
- describeAccess/buildTrailer（MIFARE アクセス条件の平易な説明と 16 バイトトレーラ生成）。
- serializeProject/parseProject（*.nfcdump JSON）、exportBin/importBin（生イメージ、サイズからkind推定: NTAG213=180/215=540/216=924, MIFARE 1K=1024/4K=4096）、exportFlipper/importFlipper（Flipper Zero .nfc テキスト）、detectDumpFormat/importDump。
テスト: planWrites の禁止/保護/未読/無効アクセスビット、round-trip（factoryImage→exportBin→importBin, serializeProject→parseProject, Flipper 往復）、NTAG config のビット、buildTrailer と parseAccessBits の往復、transport config。`,
  },
  {
    key: 'shared-ndef',
    label: 'shared/ndef (records, message, TLV, wifi, vcard, mifare NDEF)',
    prompt: `担当: src/shared/ndef/**（types.ts 以外。index.ts の公開シグネチャは凍結）。tests/ndef*.test.ts。docs/research/ndef.md。
実装: encodeDraft/decodeRaw（uri=URI RTD の 0x00-0x23 プレフィックス表、text=言語コード+UTF8/16、wifi=WPS Credential TLV、vcard=text/vcard、mime、aar=android.com:pkg の External、external、smartposter=Sp の入れ子、raw、empty）、encodeMessage/decodeMessage（MB/ME/SR/IL/CF チャンク対応、オフセット付き NdefError）、encodeDrafts/decodeToDrafts、wrapNdefTlv（03 L V、L>=255 は FF hi lo）、scanType2Tlvs（00/01/02/03/FD/FE）、type2Capacity（CC 申告: 213=144,215=496,216=872、TLV+ターミネータのオーバーヘッド控除）、buildType2UserArea、defaultCc、describeDraft、emptyDraft、extractMifareNdef/buildMifareNdefWrites（MAD の AID 0x03E1 のセクタのデータブロックを連結して TLV 走査。トレーラ・MAD は書かない）。URI_PREFIXES も実データで埋める。
テスト: 各種 draft の encode→decode 往復、既知の実バイト列（例 https://の短縮 0x02/0x04、Wi-Fi Credential、vCard）、SR/非SR 境界（payload 255/256）、チャンク、TLV の 1バイト/3バイト長、capacity の境界。`,
  },
  {
    key: 'shared-schema',
    label: 'shared/schema (id schema codec, validate, templates, csv, checksum)',
    prompt: `担当: src/shared/schema/**（types.ts 以外。index.ts の公開シグネチャは凍結）。tests/schema*.test.ts。docs/SCHEMA-FORMAT.md にフォーマット仕様を書く。
実装: newSchema/validateSchema（重複id・重なり・範囲外・タグに収まるか・保護領域・checksum 参照・source と type の整合を SchemaIssue で返す）、serializeSchema/parseSchemaFile（*.nfcschema JSON, BOM 許容）、schemaPresets（社員証ID・勤怠タグ・会員番号・資産タグ の実用プリセット）、renderValues/encodeSchema/decodeSchema（fixed/input/sequence/csv/now/uid/computed の各 source、uint/bcd/ascii/utf8/hex/date/checksum の各 type、endian/pad/align/digits/dateFormat/dateEncoding）、schemaAreaFromImage/buildSchemaWrites（raw: startUnit から、MIFARE はブロック0とトレーラを飛ばす連続バイト。ndef: 1つの NDEF レコードとして Type2/MIFARE に。禁止・保護単位は返さない）、expandTemplate/expandDraft/listPlaceholders（{{seq}} {{seq:6}} {{uid}} {{uid:last4}} {{date}} {{date:YYYY-MM-DD}} {{time:hhmm}} {{csv:col}} {{input:name}}）、parseCsv/toCsv（RFC4180）、checksum（xor8/sum8/crc16-ccitt init0xFFFF/crc32 IEEE/luhn）。
最重要: sequence source で連番発行の ID が可変になること。encodeSchema は SchemaValueError を投げる。
テスト: 各 type の encode→decode 往復、sequence の連番、bcd/uint のオーバーフロー、checksum の既知ベクトル（crc16-ccitt of "123456789"=0x29B1）、csv の引用符・CRLF、placeholder 展開、MIFARE raw のブロック跨ぎ、validateSchema の各エラー。`,
  },
  {
    key: 'main-pcsc',
    label: 'main/nfc/pcsc (koffi -> winscard.dll backend)',
    prompt: `担当: src/main/nfc/pcsc/**。docs/research/pcsc.md。createPcscBackend(log): ReaderBackend のシグネチャは凍結。
koffi で winscard.dll（Windows）/ libpcsclite.so.1（Linux）/ PCSC.framework（mac）を読み、ReaderBackend を実装する。開発 PC で確認済みの呼び出し（${ROOT}/docs/research がまだ無ければ下記を正とする）:
- SCardEstablishContext(SCARD_SCOPE_SYSTEM=2, null, null, &ctx) -> long。ctx は uintptr_t。
- SCardListReadersW(ctx, null(groups), buf(char16), &len) -> リーダー名（UTF-16LE, \\0 区切り, 二重\\0終端）。len は文字数ではなくワイド文字数。
- SCardGetStatusChangeW(ctx, timeout, SCARD_READERSTATEW[], n)。dwEventState の bit 0x20 = SCARD_STATE_PRESENT, 0x100=INUSE, cbAtr/rgbAtr(36) に ATR。特別リーダー名 "\\\\?PnP?\\Notification" で接続/切断を監視。
- SCardConnectW(ctx, readerW, SCARD_SHARE_SHARED=2, SCARD_PROTOCOL_T0|T1=3, &hCard, &activeProtocol)。
- SCardTransmit(hCard, &SCARD_IO_REQUEST(dwProtocol,8), apdu, apduLen, null, recv, &recvLen)。SCARD_PCI_T1 は dwProtocol=2。
- SCardDisconnect(hCard, SCARD_LEAVE_CARD=0)。SCardReleaseContext(ctx)。
要件:
- 絶対に synchronous に throw しない。winscard が無い/サービス停止（SCardEstablishContext が 0x8010001D SCARD_E_NO_SERVICE 等）のときは BackendEvent {type:'service', state:'unavailable', message} を出し、数秒ごとに再試行して復帰を検出。
- リーダー一覧は src/shared/reader.ts の isLikelyContactlessReader で likelyContactless を付ける。ATR は parseStorageAtr で非接触を判定。
- CardConnection.transmit は応答（SW 込み）を Uint8Array で返す。カードが抜けたら（0x80100069 SCARD_W_REMOVED_CARD 等）OpError('CARD_REMOVED')。
- SCardGetStatusChange を使った監視ループ（別途ポーリングでも可）で card-inserted/card-removed/readers イベントを出す。stop() で確実に解放。
koffi の関数シグネチャは 'long __stdcall SCardXxx(...)'（Windows）形式。uintptr_t でハンドル、_Out_/_Inout_ ポインタは [outParam] 配列 or koffi.out で受ける。koffi は ${ROOT}/node_modules/koffi。
テスト（tests/pcsc*.test.ts）は実機非依存の部分（リーダー名パース・ATR 判定・SW 解釈・エラーコード→OpError 変換）だけ純粋関数に切り出してテスト。koffi 呼び出し自体は統合担当が実機で確認するので not_verified に明記。`,
  },
  {
    key: 'main-nfc',
    label: 'main/nfc (service, simulator, ntag/mifare APDU, driver)',
    prompt: `担当: src/main/nfc/**（backend.ts・contract.ts・pcsc/** 以外）。tests/nfc*.test.ts。docs/research/reader-apdu.md。
createNfcService(deps): NfcService（contract.ts）を実装。構成:
- driver.ts: ReaderDriverMode を解決（リーダー名から acr122/transparent/storage を推定。ACR122U系=acr122, ACR1252/1255/Identiv/Sony=transparent 試行可、不明=storage）。生コマンドの APDU 化（acr122: FF00 00 00 Lc D4 42 <cmd>、transparent: FF C2 00 01 ... のセッション、storage: 生コマンド不可）。
- apdu.ts: 保存用の PC/SC storage APDU（UID取得 FF CA 00 00 00、read binary FF B0 00 <blk> <le>、update binary FF D6 00 <blk> Lc <data>、MIFARE load key FF 82、authenticate FF 86）。NTAG 生コマンド（READ 0x30、FAST_READ 0x3A、WRITE 0xA2、GET_VERSION 0x60、PWD_AUTH 0x1B、READ_CNT 0x39、READ_SIG 0x3C）。
- ntag.ts: NTAG の読み取り（GET_VERSION→kind、FAST_READ/READ でページ列、CC、カウンタ、署名。パスワードは PWD_AUTH）と書き込み（WRITE 1ページ4バイト、UnitWrite 順守）。
- mifare.ts: MIFARE の読み取り（セクタごとに load key+authenticate、read binary。鍵は deps.resolveKeys、Key A→B 順に試す。開けないセクタは denied）と書き込み（authenticate 後 update binary。トレーラは allowProtected 時のみ、無効アクセスビットは INVALID_ACCESS_BITS）。
- simulator.ts: 仮想リーダー（shared/reader.ts VIRTUAL_READER_NAME）と仮想タグ。factoryImage でイメージを持ち、transmit を APDU レベルで解釈して実機と同じ ReaderBackend/CardConnection を提供（NTAG/MIFARE の READ/WRITE/AUTH をエミュレート、MIFARE は鍵一致を検査、NTAG パスワードを検査）。これで実機なしで read/write/issue が通る。
- service.ts: backend（pcsc+simulator）を束ね、ReaderStatus を管理、読み書きを直列化（mutex）、UID 再読込で UID_MISMATCH、waitForCard/waitForRemoval、onStatus push、setManualKind、setBusy。writeTag は shared/tag の planWrites を使わず req.writes をそのまま検証して書く（UI 側が計画済み）が、禁止/保護/無効アクセスビットは contract.ts の約束どおり main でも再検査する。
テスト: simulator に対する read→write→read の往復（NTAG と MIFARE）、UID_MISMATCH、PROTECTED_UNIT、INVALID_ACCESS_BITS、denied セクタ、driver 推定、apdu ビルダのバイト列、SW 解釈。shared/tag と shared/schema を使ってよい。`,
  },
  {
    key: 'renderer-hex',
    label: 'views/hex (binary editor with increment, regions, diff)',
    prompt: `担当: src/renderer/src/views/hex/**、src/renderer/src/i18n/hex.ts。
HexView（export 名を維持、App.tsx が import）。機能:
- 現在のドキュメント（store の doc）のバイナリを、ページ/ブロック単位の hex グリッドで表示・編集。領域（regionOf）ごとに tokens.css の --region-* で色分け。保護/禁止単位はバッジと色で明示、禁止単位は編集不可。
- 変更セル（doc.image.data vs doc.original.data）を --hex-changed-* でハイライト。ASCII 併記。選択範囲。カーソル移動（矢印・Tab）。16進直接入力と ASCII 入力の両モード。
- インクリメント機能（現場で重要）: 選択したバイト範囲を uint として、+1 / -1 / 任意の増分 / 開始値セット。BE/LE 切替。エンディアンと桁。これを目立つツールバーに。
- バイト列の検索・一括置換、範囲の塗りつぶし（00/FF/任意）、範囲のコピー&ペースト、undo/redo（store の undo/redo）。
- タグが無い/ドキュメントが無いときは、新規ブランク作成（kind 選択→blankImage）かファイルを開く導線。
- 「タグに書き込む」は lib/ops.ts の writeWithConfirm を使い、shared/tag の planWrites で計画→保護単位があれば確認、禁止単位は除外。read は lib/ops.ts の readCurrentTag。
文言は hex. 接頭辞で i18n/hex.ts に ja/en。UID は読み取り専用である旨を領域ラベルで示す。`,
  },
  {
    key: 'renderer-ndef',
    label: 'views/ndef (NDEF editor + reusable records editor)',
    prompt: `担当: src/renderer/src/views/ndef/**、src/renderer/src/i18n/ndef.ts。NdefRecordsEditor の props（NdefRecordsEditorProps）は凍結。
- NdefRecordsEditor（NdefRecordsEditor.tsx の本実装）: NDEF レコードのリスト編集。追加メニュー（URL/テキスト/Wi-Fi/連絡先 vCard/MIME/アプリ起動 AAR/External/スマートポスター/生）。各種別の専用フォーム（shared/ndef の emptyDraft/describeDraft を使う）。並べ替え・削除。capacityKind が与えられたら shared/ndef の type2Capacity と encodeDrafts のバイト長で容量メーター。allowPlaceholders のとき {{seq}} 等の挿入ヘルプ。
- NdefView: 上の editor を使い、現在のタグ（またはファイル/新規）に NDEF を定義して書き込む。既存タグの NDEF を読み込んで編集（shared/ndef の scanType2Tlvs/decodeToDrafts、MIFARE は extractMifareNdef）。プレビュー（エンコードされた生バイト hex）。「タグに書き込む」は shared/ndef で Type2 ユーザー領域（buildType2UserArea）or MIFARE NDEF writes を作り、lib/ops.ts の writeWithConfirm。発行へ渡す導線（store.handoffTo('issue', {kind:'issue-ndef', records})）。
文言は ndef. 接頭辞。`,
  },
  {
    key: 'renderer-schema',
    label: 'views/schema (schema designer GUI, save JSON)',
    prompt: `担当: src/renderer/src/views/schema/**、src/renderer/src/i18n/schema.ts。
SchemaView: データスキーマを GUI で設計し JSON（*.nfcschema）で保存/読込。機能:
- スキーマ一覧（settings.schemas と、ファイルから開いたもの）。新規（schemaPresets から選ぶ or 空）。
- フィールド編集: 行ごとに label/id/type(uint/bcd/ascii/utf8/hex/date/checksum)/offset/length/source(fixed/input/sequence/csv/now/uid/computed)/endian/pad/align/digits/dateFormat/checksum。ドラッグ順・追加・削除。
- 配置（SchemaArea）: raw（startUnit）か ndef（mime/external type）。対象タグ種別（tagKinds）。
- バリデーション: shared/schema の validateSchema を使い SchemaIssue を各フィールドと全体に表示（重なり・範囲外・タグに収まらない・保護領域）。メモリマップ上にフィールドの占有を視覚化。
- プレビュー: サンプル IssueContext（seq=1 等）で encodeSchema→バイト列 hex と renderValues の表。
- 保存（settings.schemas に追加 or ファイル）・JSON 書き出し/読み込み（api.saveFile/openFile, serializeSchema/parseSchemaFile）・「発行へ」（store.handoffTo('issue',{kind:'issue-schema',schemaId})）。
最重要: sequence source で社員ID等を連番に。GUI で組んで JSON 保存できること。文言は schema. 接頭辞。`,
  },
  {
    key: 'renderer-issue',
    label: 'views/issue + views/log (batch provisioning + issue log)',
    prompt: `担当: src/renderer/src/views/issue/**、src/renderer/src/views/log/**、src/renderer/src/i18n/issue.ts。IssueView と LogView の export 名を維持。
- IssueView: 一括発行（量産）画面。テンプレート選択（schema / ndef / image=複製）。schema は settings.schemas から、handoff も受ける（takeHandoff）。sequence（開始・増分・次の値）。CSV 読み込み（parseCsv）して行ごとに発行。input source の値入力。options（verify / skipDuplicateUid / requireBlank / ntagProtect / mifareKeyIds / sound）。
- 「タグをかざすと発行」の運用フロー: api.startIssue(job) → onIssueEvent で waiting/writing/success/skipped/error/remove-card/stopped を大きなステータス表示（.big-status）で見せ、成功で効果音。次に発行する内容（IssuePreview の values と seq）を事前表示。停止ボタン。発行済み数のカウンタ。
- 発行前プレビュー（最初の数タグ分の seq と値）。
- LogView: 発行台帳（api.listIssueLog）。ジョブで絞り込み、UID・seq・値・結果・時刻の表。CSV 書き出し（toCsv + BOM、api.saveFile）。台帳クリア（確認）。
注意: 鍵・パスワードは表示/台帳に出さない。文言は issue. と log. 接頭辞。`,
  },
  {
    key: 'renderer-backup',
    label: 'views/backup + views/keys (backup/duplicate + MIFARE keys)',
    prompt: `担当: src/renderer/src/views/backup/**、src/renderer/src/views/keys/**、src/renderer/src/i18n/backup.ts。BackupView と KeysView の export 名を維持。
- BackupView: タグの読み取り→ファイル保存（.nfcdump/.bin/.flipper。shared/tag の serializeProject/exportBin/exportFlipper、api.saveFile）。ファイル→復元/複製（importDump→別のタグに書き込み）。複製フロー: 元タグを読む→空タグ/別タグに「データ領域だけ」書き込む（UID は複製されないことを明示する Callout を常設）。差分表示（diffUnits）。複数タグへの連続複製は発行（issue image テンプレート）へ誘導（handoffTo('issue',{kind:'issue-image'})）。
- KeysView: MIFARE 鍵の管理（api.listKeys/addKey/removeKey）。鍵は伏字表示（builtin の3つは削除不可・標準鍵と明示）。鍵の追加フォーム（label + 12hex）。「鍵は運用者が管理するものを登録します。本アプリは鍵の解析をしません」と明記。
最重要の文言: UID は読み取り専用で複製できない、複製するのはデータ領域だけ、という説明を UI に常設。鍵の値は画面に出さない（追加時の入力のみ）。文言は backup. と keys. 接頭辞。`,
  },
];

phase('Implement');
log(`実装フェーズ: ${AREAS.length} 領域を並列実装`);

const results = await pipeline(
  AREAS,
  (area) =>
    agent(`${COMMON}\n\n== あなたの担当: ${area.label} ==\n${area.prompt}\n\n完了条件: 自分の担当範囲の全スタブを本実装にし、worktree で \`npm run typecheck\` と \`npm run unit\`（自分のテストを含む）を流して通す。通った範囲だけ verified に書く。`, {
      label: `impl:${area.key}`,
      phase: 'Implement',
      isolation: 'worktree',
      schema: IMPL_SCHEMA,
    }).then((r) => ({ area, impl: r })),
  ({ area, impl }) => {
    if (!impl) return { area, impl: null, review: null };
    return agent(`${COMMON}\n\nあなたはレビュー担当です。実装担当 ${area.label} の変更を批判的にレビューしてください。worktree でコードを読み、必要ならテストやコマンドを実行して確かめる。観点:
1) 不変条件 I1〜I6 の違反（UID 変更・magic card・鍵解析・既知鍵の同梱・秘密のログ出力）。最優先。
2) 契約（DESIGN.md §3/§3.1）との不一致（シグネチャ・意味・書き込み順・禁止/保護単位・CC 申告サイズ）。
3) 正しさ（バイト列・エンディアン・境界・round-trip・チェックサム・アクセスビット・UID 再読込）。
4) テストが本質を検査しているか（常に通る/モックで本質を外していないか）。実フレーム・境界値があるか。
5) 文言の ja/en 同時・トークン経由の色・OpError の detail に秘密が無いか。
実装の要約: ${JSON.stringify(impl.summary)}。files: ${JSON.stringify(impl.files_changed).slice(0, 800)}。
再現できる問題だけ、最大15件。各 issue に severity(blocker/major/minor)・file・line・issue・scenario(再現)・fix。`, {
      label: `review:${area.key}`,
      phase: 'Review',
      schema: REVIEW_SCHEMA,
    }).then((review) => ({ area, impl, review }));
  },
  ({ area, impl, review }) => {
    if (!impl || !review) return { area, impl, review, fixed: null };
    const must = (review.issues || []).filter((i) => i.severity === 'blocker' || i.severity === 'major');
    if (must.length === 0) return { area, impl, review, fixed: { summary: 'no blocker/major', applied: [] } };
    return agent(`${COMMON}\n\nあなたは修正担当です。担当 ${area.label} の worktree で、以下の blocker/major の指摘を直してください。各修正に再発防止のテストを足す。誤った指摘は not_verified に「不採用: 理由」。直したら worktree で npm run typecheck と npm run unit を流し、通ったことを確認。
指摘:\n${JSON.stringify(must, null, 1).slice(0, 4000)}`, {
      label: `fix:${area.key}`,
      phase: 'Fix',
      schema: IMPL_SCHEMA,
    }).then((fixed) => ({ area, impl, review, fixed }));
  },
);

const report = results.filter(Boolean).map((r) => ({
  area: r.area.key,
  worktree_impl: r.impl ? { typecheck: r.impl.typecheck, unit: r.impl.unit, files: (r.impl.files_changed || []).length } : null,
  blocker_major: r.review ? (r.review.issues || []).filter((i) => i.severity !== 'minor').length : null,
  minor: r.review ? (r.review.issues || []).filter((i) => i.severity === 'minor').length : null,
  fixed: r.fixed ? r.fixed.typecheck ?? r.fixed.summary : null,
  design_feedback: r.impl ? r.impl.design_feedback || [] : [],
}));

return { areas: report };
