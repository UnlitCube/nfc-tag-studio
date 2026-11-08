// Help content (bilingual). Owner: agent "shell-ui".
// Each topic id matches a help.topic.<id> label in i18n/shell.ts.
import type { LanguageSetting } from '@shared/types';

export type HelpTopicId =
  | 'start'
  | 'authorized'
  | 'uid'
  | 'read'
  | 'ndef'
  | 'schema'
  | 'issue'
  | 'hex'
  | 'backup'
  | 'mifare'
  | 'reader'
  | 'faq';

export const HELP_TOPICS: HelpTopicId[] = [
  'start',
  'authorized',
  'uid',
  'read',
  'ndef',
  'schema',
  'issue',
  'hex',
  'backup',
  'mifare',
  'reader',
  'faq',
];

export interface HelpBlock {
  /** Sub-heading, or omit for a plain paragraph/list. */
  heading?: string;
  /** Paragraphs. */
  body?: string[];
  /** Bullet list. */
  list?: string[];
  /** Callout box with a tone. */
  note?: { tone: 'info' | 'warn' | 'danger' | 'ok'; text: string };
}

const JA: Record<HelpTopicId, HelpBlock[]> = {
  start: [
    { body: ['NFC Tag Studio は、自組織で管理する NFC タグ（NTAG213/215/216、MIFARE Classic）を発行・編集・バックアップするためのデスクトップアプリです。'] },
    {
      heading: '使い始める 3 ステップ',
      list: [
        '1. PC/SC 対応の NFC リーダー（ACR122U など）を USB に接続します。リーダーが無い場合は「読み取り」画面の仮想リーダーで試せます。',
        '2. 「読み取り」画面でタグを置いて内容を読み取ります。',
        '3. 「NDEF 編集」「データスキーマ」「バイナリ編集」で内容を作り、「発行」でタグに書き込みます。',
      ],
    },
    { note: { tone: 'info', text: 'まずは仮想リーダーで一通り触ってみると、実機なしで操作を覚えられます。' } },
  ],
  authorized: [
    { body: ['このアプリは、あなたが管理・運用する権限を持つタグやカードに対して使ってください。'] },
    {
      heading: '想定する使い方',
      list: [
        '自組織の社員証・勤怠タグ・会員証などに、社員 ID や会員番号を採番して発行する',
        '自分のタグのデータ領域をバックアップし、別の空タグに復元・複製する',
        'NFC タグに URL・Wi-Fi 設定・連絡先などの NDEF を書き込む',
      ],
    },
    {
      heading: 'このアプリがしないこと',
      list: [
        '他人のカードの不正な複製や、認証の回避はできません（技術的にもできない設計です）。',
        'MIFARE Classic の鍵の解析・総当たりはしません。鍵はあなたが保有するものを登録して使います。',
        'UID を書き換える特殊なカード（いわゆる magic card）向けのバックドアは実装していません。',
      ],
    },
    { note: { tone: 'warn', text: 'ロックビットやパスワードの設定など、取り消せない操作は「設定」で上級者モードを有効にした場合だけ行えます。' } },
  ],
  uid: [
    { body: ['UID（製造番号・シリアル番号）は、タグの製造時に書き込まれ、以後は読み取り専用です。書き換えることはできません。'] },
    { body: ['そのため、タグを「複製」しても UID は複製されません。複製できるのは、書き込み可能なデータ領域（ユーザーメモリ・NDEF）だけです。'] },
    {
      note: {
        tone: 'info',
        text: 'UID だけで本人確認する入退室システムは、タグを複製しても別の UID になるため、そのままでは通りません。データ領域の内容（社員 ID など）で判定する運用が複製・再発行に向いています。',
      },
    },
  ],
  read: [
    { body: ['「読み取り」画面でタグをリーダーに置き、「タグを読み取る」を押すと、タグの UID・種類・容量・NDEF・カウンタなどを表示します。'] },
    { list: ['読み取った内容は「NDEF 編集」「バイナリ編集」「バックアップ・複製」にそのまま引き継げます。', 'パスワードや鍵が必要な領域は「読めませんでした」と表示され、他の領域の読み取りは続行します。'] },
  ],
  ndef: [
    { body: ['NDEF は、スマートフォンや NFC リーダーが解釈できる標準のデータ形式です。URL・テキスト・Wi-Fi 設定・連絡先（vCard）・アプリ起動（AAR）などを書き込めます。'] },
    { list: ['「NDEF 編集」でレコードを追加・並べ替えし、容量メーターで収まるか確認してから書き込みます。', '発行時に {{seq}}（連番）や {{uid}} などのプレースホルダーを使うと、タグごとに内容を変えられます。'] },
  ],
  schema: [
    { body: ['データスキーマは、社員 ID などのデータをタグのどの位置に・どんな形式で書くかを定義する仕組みです。GUI で組み立てて JSON（*.nfcschema）で保存できます。'] },
    {
      heading: '連番発行',
      body: ['フィールドの「値の元」を「連番」にすると、タグを 1 枚発行するたびに値が自動で増えます。開始値と増分は「発行」画面で指定します。'],
    },
    { list: ['対応する形式: 符号なし整数・BCD・ASCII・UTF-8・16 進・日付・チェックサム。', '値の元: 固定値・入力・連番・CSV の列・現在日時・UID の一部。'] },
  ],
  issue: [
    { body: ['「発行」画面では、タグを次々にかざして同じスキーマや NDEF を書き込み、連番や CSV の内容を 1 枚ずつ発行できます。'] },
    { list: ['タグをかざすと自動で書き込み、外すと次のタグを待ちます。', '発行済みの UID を記録し、重複発行を避けられます。', '空でないタグへの書き込みを防ぐ「空のタグだけに書く」オプションがあります。', '発行の記録は「発行台帳」に残り、CSV で書き出せます（鍵やパスワードは記録しません）。'] },
  ],
  hex: [
    { body: ['「バイナリ編集」では、タグのメモリをページ／ブロック単位で直接表示・編集できます。領域ごとに色分けし、保護領域や書き込めない領域を明示します。'] },
    {
      heading: 'インクリメント',
      body: ['選択したバイト範囲を数値として +1 / −1 したり、任意の増分を足したり、開始値を設定できます。連番のカウンタを手で調整するときに便利です。'],
    },
    { note: { tone: 'warn', text: 'UID のページやロックビットなど、書き換えられない・取り消せない領域は保護されています。' } },
  ],
  backup: [
    { body: ['「バックアップ・複製」では、タグの内容をファイル（.nfcdump / .bin / Flipper .nfc）に保存し、別のタグに復元・複製できます。'] },
    { list: ['複製で書き込まれるのはデータ領域だけで、UID は複製されません。', '複数のタグへ連続して複製するときは「発行」画面を使うと効率的です。'] },
    { note: { tone: 'info', text: 'バックアップファイルには鍵やパスワードは含めません。' } },
  ],
  mifare: [
    { body: ['MIFARE Classic は、セクタごとに鍵（Key A / Key B）で保護されたカードです。読み書きには、そのカードに設定された鍵が必要です。'] },
    { list: ['「MIFARE 鍵」画面で、あなたが保有する鍵を登録します。登録した鍵は伏字で表示され、値は画面に出ません。', '標準の鍵（工場出荷時・NFC Forum の MAD / NDEF 鍵）は最初から用意されています。'] },
    { note: { tone: 'info', text: 'このアプリは鍵の解析・総当たりをしません。鍵が分からないセクタは読み書きできません。' } },
  ],
  reader: [
    { body: ['このアプリは PC/SC（Windows の「Smart Card」サービス）経由で NFC リーダーと通信します。'] },
    { list: ['USB セキュリティトークンや接触型カードリーダーは NFC リーダーではないため、「NFC 非対応の可能性」と表示されます。', 'パスワード認証・カウンタ・署名などの生コマンドを使うには、リーダーに合った通信方式が必要です。不明な場合は「自動」のままにします。'] },
  ],
  faq: [
    { heading: 'リーダーが認識されません', body: ['Windows の「Smart Card (SCardSvr)」サービスが動いているか、リーダーのドライバが入っているかを確認してください。「設定」→「リーダーを再検出」も試せます。'] },
    { heading: '書き込み後に「照合に失敗」と出ます', body: ['タグが途中で離れた可能性があります。タグを置いたまま、もう一度実行してください。保護領域やロック済みの領域には書き込めません。'] },
    { heading: '他人の交通系 IC や社員証を複製できますか', body: ['できません。それらは鍵で保護されており、UID も固定です。このアプリは、あなたが鍵を持つ自組織のタグの発行・編集のためのものです。'] },
  ],
};

const EN: Record<HelpTopicId, HelpBlock[]> = {
  start: [
    { body: ['NFC Tag Studio is a desktop app for issuing, editing and backing up the NFC tags your organisation manages (NTAG213/215/216, MIFARE Classic).'] },
    {
      heading: 'Three steps to start',
      list: [
        '1. Connect a PC/SC NFC reader (e.g. ACR122U) over USB. No reader? Use the virtual reader on the "Read" screen.',
        '2. Place a tag on the "Read" screen and read it.',
        '3. Build content in "NDEF editor", "Data schema" or "Binary editor", then write it with "Issue".',
      ],
    },
    { note: { tone: 'info', text: 'Try everything with the virtual reader first to learn the app without hardware.' } },
  ],
  authorized: [
    { body: ['Use this app on tags and cards you are authorised to manage.'] },
    { heading: 'Intended use', list: ['Issue employee IDs / member numbers onto your own ID, attendance or membership tags', 'Back up your tags and restore / duplicate the data to blank tags', 'Write NDEF (URL, Wi-Fi, contact, …) to NFC tags'] },
    {
      heading: 'What it does not do',
      list: [
        'It cannot clone someone else\'s card or bypass authentication (by design).',
        'It does not recover or brute-force MIFARE Classic keys. Register the keys you hold.',
        'It implements no UID-rewrite backdoors for "magic cards".',
      ],
    },
    { note: { tone: 'warn', text: 'Irreversible operations (lock bits, password setup) require Advanced mode in Settings.' } },
  ],
  uid: [
    { body: ['The UID (serial number) is written at manufacture and is read-only thereafter. It cannot be changed.'] },
    { body: ['So duplicating a tag never duplicates the UID. Only the writable data area (user memory, NDEF) is copied.'] },
    { note: { tone: 'info', text: 'An access system that checks only the UID will not accept a duplicated tag, because the copy has a different UID. Systems that check the data (e.g. an employee ID) are better suited to re-issuing.' } },
  ],
  read: [
    { body: ['On "Read", place a tag and press "Read tag" to see its UID, type, capacity, NDEF and counter.'] },
    { list: ['The result carries over to the NDEF editor, binary editor and backup screens.', 'Areas needing a password or key show as "could not be read"; the rest of the read continues.'] },
  ],
  ndef: [
    { body: ['NDEF is the standard data format phones and NFC readers understand. You can write URLs, text, Wi-Fi, contacts (vCard), app launch (AAR) and more.'] },
    { list: ['Add and reorder records in the NDEF editor, and check the capacity meter before writing.', 'Placeholders like {{seq}} and {{uid}} let each issued tag differ.'] },
  ],
  schema: [
    { body: ['A data schema defines where and how data (such as an employee ID) is written on a tag. Build it in the GUI and save it as JSON (*.nfcschema).'] },
    { heading: 'Sequential issue', body: ['Set a field\'s source to "sequence" and the value increments for every tag issued. Set the start and step on the "Issue" screen.'] },
    { list: ['Formats: unsigned integer, BCD, ASCII, UTF-8, hex, date, checksum.', 'Sources: fixed, input, sequence, CSV column, current date/time, part of the UID.'] },
  ],
  issue: [
    { body: ['On "Issue", tap tags one after another to write the same schema or NDEF, issuing sequential numbers or CSV rows one tag at a time.'] },
    { list: ['Tap a tag to write; remove it to wait for the next.', 'Issued UIDs are recorded to avoid duplicates.', 'An option writes only to blank tags.', 'The issue log can be exported to CSV (keys and passwords are never recorded).'] },
  ],
  hex: [
    { body: ['The binary editor shows and edits the tag memory per page / block, colour-coded by region, marking protected and non-writable areas.'] },
    { heading: 'Increment', body: ['Treat a selected byte range as a number and +1 / −1, add a custom step, or set a start value — handy for adjusting a counter by hand.'] },
    { note: { tone: 'warn', text: 'UID pages, lock bits and other non-writable / irreversible areas are protected.' } },
  ],
  backup: [
    { body: ['"Backup & duplicate" saves a tag to a file (.nfcdump / .bin / Flipper .nfc) and restores or duplicates it to another tag.'] },
    { list: ['Only the data area is written; the UID is never duplicated.', 'To duplicate to many tags, use the "Issue" screen.'] },
    { note: { tone: 'info', text: 'Backup files never contain keys or passwords.' } },
  ],
  mifare: [
    { body: ['MIFARE Classic protects each sector with keys (Key A / Key B). Reading and writing needs the keys set on that card.'] },
    { list: ['Register the keys you hold on the "MIFARE keys" screen. Stored keys are shown masked; values never appear.', 'Standard keys (factory default, NFC Forum MAD / NDEF) are built in.'] },
    { note: { tone: 'info', text: 'This app does not recover or brute-force keys. Sectors whose key is unknown cannot be read or written.' } },
  ],
  reader: [
    { body: ['The app talks to NFC readers through PC/SC (the Windows "Smart Card" service).'] },
    { list: ['USB tokens and contact card readers are not NFC readers and show "may not be an NFC reader".', 'Raw commands (password auth, counter, signature) need a transport matching your reader. Leave on Automatic if unsure.'] },
  ],
  faq: [
    { heading: 'The reader is not detected', body: ['Check that the Windows "Smart Card (SCardSvr)" service is running and the reader driver is installed. Try Settings → Re-detect readers.'] },
    { heading: 'It says "verification failed" after writing', body: ['The tag may have left mid-write. Keep it on the reader and try again. Protected or locked areas cannot be written.'] },
    { heading: 'Can I clone someone\'s transit card or ID?', body: ['No. Those are key-protected with a fixed UID. This app is for issuing and editing your own organisation\'s tags, for which you hold the keys.'] },
  ],
};

export function helpContent(lang: LanguageSetting): Record<HelpTopicId, HelpBlock[]> {
  return lang === 'ja' ? JA : EN;
}
