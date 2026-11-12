// Help content (bilingual). Owner: agent "shell-ui".
// Each topic id matches a help.topic.<id> label in i18n/shell.ts.
// Terms follow D7 (i18n/shell.ts header); tests/i18n.test.ts checks the ja text
// for the banned words too. Written for a first-time user: what to do, in the
// order the work happens (2026-11-12 UX audit FIRST-16, CARD-15).
import type { LanguageSetting } from '@shared/types';

export type HelpTopicId =
  | 'start'
  | 'read'
  | 'ndef'
  | 'hex'
  | 'backup'
  | 'issue'
  | 'schema'
  | 'log'
  | 'reader'
  | 'felica'
  | 'mifare'
  | 'trial'
  | 'uid'
  | 'authorized'
  | 'faq';

export const HELP_TOPICS: HelpTopicId[] = [
  'start',
  'read',
  'ndef',
  'hex',
  'backup',
  'issue',
  'schema',
  'log',
  'reader',
  'felica',
  'mifare',
  'trial',
  'uid',
  'authorized',
  'faq',
];

/** Other screens pass their own ids to PageHeader helpTopic; map them to a topic here. */
const TOPIC_ALIASES: Record<string, HelpTopicId> = {
  keys: 'mifare',
  home: 'read',
  settings: 'reader',
};

export function resolveHelpTopic(id: string | null | undefined): HelpTopicId | null {
  if (!id) return null;
  if ((HELP_TOPICS as string[]).includes(id)) return id as HelpTopicId;
  return TOPIC_ALIASES[id] ?? null;
}

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
    {
      body: [
        'NFC Tag Studio は、自組織で管理する NFC タグ（NTAG213/215/216・MIFARE Classic 1K/4K・FeliCa Lite-S）を、読み取り・編集・書き込み・バックアップ・一括発行するためのデスクトップアプリです。',
      ],
    },
    {
      heading: '1 枚のタグを編集する流れ',
      list: [
        'NFC リーダー（Sony PaSoRi（RC-S380 など）・ACR122U など）を USB に接続します。リーダーが無いときは、「読み取り」画面の「お試し（実機なし）」で仮想リーダーを使えます。',
        'タグをリーダーの上に置きます。置いたままにすると、自動で読み取ります（設定で自動読み取りをオフにしたときは、［タグを読み取る］を押します）。',
        '「NDEF 編集」（URL・テキストなど）か「バイナリ編集」（メモリを 1 バイトずつ）で内容を編集し、その画面の［タグに書き込む］で書き込みます。',
        'ファイルに残すときは、「バイナリ編集」の［ファイルに保存…］か「バックアップ・複製」の画面で保存します。保存したファイルは、「読み取り」画面の［ファイルを開く…］で開けます。',
        '同じ内容や連番を何枚にも書くときは、「一括発行」を使います。',
      ],
    },
    {
      note: {
        tone: 'warn',
        text: 'タグは、読み取り・書き込みが終わるまでリーダーの上に置いたままにしてください。改札のように一瞬タッチするだけでは読めません。途中で離すと、書き込みが途中で止まることがあります。',
      },
    },
    { note: { tone: 'info', text: 'リーダーが無くても、仮想リーダーで一通り試せます（「お試し（仮想リーダー）」）。' } },
  ],
  read: [
    { body: ['「読み取り」画面は、「リーダーの上のタグ」と「開いている文書」の 2 つの欄に分かれています。'] },
    {
      list: [
        '「リーダーの上のタグ」は、いまリーダーに置かれているタグの状態です（置いてください・確認中・タグを検出しました・対応していない種類・読み取れません）。',
        '「開いている文書」は、読み取ったタグやファイルから開いた内容です。リーダーからタグを離しても残ります。',
        '新しいタグを置くと、自動で読み取ります。ただし、未書き込みの変更がある文書や、ファイルから開いた文書は、自動では置き換えません（「開いている文書とは別のタグです」と出るので、［このタグを読み取る］を押します）。',
        'パスワードや鍵が必要な領域は「鍵かパスワードが必要で読めなかった」、通信が途切れて読めなかった領域は「読み取れなかった」と分けて表示します。読み取れなかったときは、タグを置き直して読み取り直してください。',
        'MIFARE Classic は、自動読み取りでは公開されている標準の鍵だけを試します。登録した鍵で開くセクタは、［タグを読み取る］などを押して読み取るか、「鍵かパスワードが必要で読めなかった」の欄の［登録した鍵で読み取る］で読めます。',
        '自動読み取りは、「設定」の「タグを置いたら自動で読み取る」でオフにできます。',
      ],
    },
  ],
  ndef: [
    {
      body: [
        'NDEF は、スマートフォンや NFC リーダーが読める標準のデータ形式です。URL・テキスト・Wi-Fi の設定・連絡先（vCard）・アプリの起動（AAR）などを書き込めます。',
      ],
    },
    {
      list: [
        '「NDEF 編集」でレコードを足して並べ替え、容量のメーターで収まるか確かめてから、［タグに書き込む］を押します。',
        '書き込み先は、いまリーダーの上に置いてあるタグです。書き込む直前にそのタグを読み取り、そのタグの中身をもとに書き込む内容を決めます（読み取った文書と別のタグなら、確認にそう出ます）。',
        'タグの NDEF を空にするときは、［NDEF を消去］を使います。',
        '一括発行で {{seq}}（連番）や {{uid}} などの差し込みを使うと、タグごとに内容を変えられます。',
        'FeliCa Lite-S は NDEF 編集に対応していません。バイナリ編集を使います。',
      ],
    },
  ],
  hex: [
    {
      body: [
        '「バイナリ編集」では、タグのメモリを、ページ（NTAG）またはブロック（MIFARE Classic・FeliCa Lite-S）ごとに表示し、1 バイトずつ編集できます。領域ごとに色分けし、保護された領域や書き込めない領域を示します。',
      ],
    },
    {
      list: [
        '上の帯で、何を編集するか（読み取ったタグ・ファイル・新規）を選びます: ［タグを読み取る］［ファイルを開く…］［新規作成…］［ファイルに保存…］［閉じる］。下の帯の［タグに書き込む］で、リーダーの上のタグに書き込みます。',
        '［タグに書き込む］は、変更したページ・ブロックだけを書き込みます。書き込む前に、書き込み先のタグ（種類と UID）を確認に出します。',
        '読み取ったタグと別のタグ、ファイル、新規の文書から書き込むと「複製」になります。そのときは書き込み先のタグを先に読み取り、その中身との違いだけを書き込みます。',
        'パスワードで保護した NTAG は、［パスワードを入力］でパスワードを入れてから、読み取り・書き込みをします。パスワードはアプリに保存しません。パスワード認証は ACR122U などのリーダーでだけ使えます（Sony PaSoRi などのストレージ方式のリーダーでは、パスワード欄は使えません）。',
        'ロック済みのページは編集できません。CC・ロック・設定・パスワード・トレーラなどの保護領域は、上級者モードで「保護領域も編集して書き込む」をオンにしたときだけ編集できます。',
        '画面を移っても、未書き込みの変更は残ります。左のメニューの「バイナリ編集」に印が付き、画面の下の状態表示に変更の数が出ます。',
      ],
    },
    {
      heading: '連番・数値を編集',
      body: ['選んだバイトの範囲を数値として +1 / −1 したり、任意の増分を足したり、値を入れたりできます。連番のカウンタを手で調整するときに使います。'],
    },
    { note: { tone: 'warn', text: 'UID のページやロックビットなど、書き換えられない・取り消せない領域は保護されています。' } },
  ],
  backup: [
    { body: ['「バックアップ・複製」では、タグの内容をファイル（.nfcdump / .bin / Flipper の .nfc）に保存し、同じタグや別のタグに書き戻せます。'] },
    {
      list: [
        'バックアップを元のタグに書き戻すときは［このタグに戻す］、別のタグに書くときは複製を使います。',
        '複製で書き込まれるのはデータ領域だけで、UID は複製されません。',
        '保存したファイルは、「読み取り」画面の［ファイルを開く…］でも開けます。',
        '何枚にも続けて複製するときは、「一括発行」を使います。',
      ],
    },
    { note: { tone: 'info', text: 'バックアップのファイルには、鍵とパスワードを入れません（MIFARE の鍵 A・鍵として使う設定の鍵 B と、NTAG のパスワード（PWD・PACK）は 00 にして保存します）。鍵 B を読める設定のセクタでは、鍵 B は鍵として使えないただのデータなので、そのまま残ります。' } },
  ],
  issue: [
    { body: ['「一括発行」では、タグを 1 枚ずつリーダーの上に置き換えながら、同じスキーマや NDEF・連番・CSV の値を書き込みます。'] },
    {
      list: [
        '開始できないときは、その理由が［発行を始める］の横に出ます。CSV を使うときは、「開始する行」で何行目から発行するかを選べます。',
        'タグをリーダーの上に置くと、自動で書き込みます。音が鳴って結果（成功・スキップ・失敗）が出るまで、置いたままにしてください。結果が出たら、タグを離して次のタグを置きます。',
        '開始したときにリーダーの上にあったタグには書き込みません。いったん離してから置き直します。',
        '途中で離したタグは、途中までしか書き込まれていません。同じタグを置き直すと、同じ番号で書き直します。',
        '「発行台帳に記録のある UID のタグはスキップする」をオンにすると、発行済みのタグへの二重の発行を防げます。',
        '「空のタグにだけ書き込む」を選ぶと、すでにデータがあるタグには書きません。',
        '止めた後は、［続きから再開］で前回の続きの番号・行から、［最初からやり直す…］で最初の番号から発行します。',
        '発行後にパスワードで保護する設定（上級者モード）は、ACR122U などのリーダーで使います。Sony PaSoRi などのストレージ方式のリーダーで保護すると、そのタグは、パスワードが分かっていても、このリーダーでは後から読み書きできなくなります。',
        '発行の記録は「発行台帳」に残ります（鍵やパスワードは記録しません）。',
      ],
    },
  ],
  schema: [
    { body: ['データスキーマは、社員 ID などのデータを、タグのどの位置にどの形式で書くかを決めるものです。画面で組み立てて、ファイル（.nfcschema）に保存できます。'] },
    {
      heading: '連番',
      body: ['フィールドの「値の出どころ」を「連番」にすると、一括発行でタグを 1 枚発行するたびに値が増えます。開始値と増分は、「一括発行」の画面で決めます。'],
    },
    { list: ['対応する形式: 符号なし整数・BCD・ASCII・UTF-8・16 進・日付・チェックサム。', '値の出どころ: 固定値・入力・連番・CSV の列・現在の日時・UID の一部。'] },
  ],
  log: [
    { body: ['「発行台帳」には、一括発行で扱ったタグごとの記録（日時・UID・連番・結果）が残ります。CSV に書き出せます。'] },
    { list: ['鍵やパスワードは記録しません。'] },
  ],
  reader: [
    { body: ['このアプリは、PC/SC（Windows の「Smart Card」サービス）を通して NFC リーダーと通信します。'] },
    {
      heading: '対応リーダーとできること',
      list: [
        'Sony PaSoRi（RC-S380 など）: NTAG213/215/216 と FeliCa Lite-S の読み書きができます（ストレージ方式）。パスワード認証・NFC カウンタ・署名の読み取りは使えません（パスワードで保護したページは、パスワードが分かっていても読み書きできません）。MIFARE Classic の読み書きは、まだ確かめていません。',
        'ACR122U など（ACR122U 方式）: 読み書きに加えて、パスワード認証・カウンタ・署名も使えます。',
        'USB セキュリティトークン（YubiKey など）や接触型のスマートカードリーダーは、NFC リーダーと判定できないので、自動選択では使いません。NFC リーダーなのに判定されないときだけ、「設定」の「使用するリーダー」で選んでください（選ぶ前に確認が出ます。選ぶと、その機器にタグを確かめるコマンドを送ります）。',
      ],
    },
    {
      heading: '使うリーダーの選び方',
      body: [
        '「設定」の「使用するリーダー」が「自動選択」のときは、仮想リーダーにタグがあれば仮想リーダー、それ以外はタグが置かれている NFC リーダー（無ければ最初の NFC リーダー）を使います。',
        '特定のリーダーを選んだときは、そのリーダーだけを使います。選んだリーダーが接続されていないと「選んだリーダーが未接続」と出るので、つなぎ直すか［自動選択に戻す］を押します。',
      ],
    },
    {
      heading: '通信方式',
      body: ['ふだんは「自動」のままで使えます。いま使っている通信方式は、「設定」の「通信方式（置いているタグ）」に出ます。'],
    },
    {
      heading: 'リーダーが認識されないとき',
      list: [
        'リーダーの USB をいったん抜いて、挿し直します（スリープから復帰した後などに、認識されなくなることがあります）。',
        '別の USB ポートに挿します。USB ハブを使っているときは、PC に直接挿します。',
        'リーダーのドライバを入れます（Sony PaSoRi は「NFC ポートソフトウェア」）。',
        'それでも出ないときは、Windows の「Smart Card」サービスが動いているか確かめます。',
      ],
    },
  ],
  felica: [
    { body: ['FeliCa Lite-S（RC-S966 など）は、16 バイトのブロックでできた FeliCa のタグです。製造番号は IDm（8 バイト）と呼び、書き換えできません。'] },
    {
      list: [
        '書き込めるのは S_PAD0〜S_PAD13（224 バイト）と REG です。内容は「バイナリ編集」で変更します（NDEF 編集は使えません）。',
        '交通系 IC や FeliCa の社員証など、FeliCa Lite-S 以外の FeliCa には対応していません。',
        'Sony PaSoRi で読み書きできます。',
      ],
    },
    {
      note: {
        tone: 'warn',
        text: '読み取り専用にする設定（書込保護）は、書き込んだ後にタグをリーダーから離して置き直すと有効になります。一度有効になった書込保護は、元に戻せません。',
      },
    },
  ],
  mifare: [
    { body: ['MIFARE Classic は、セクタごとに鍵（Key A / Key B）で保護されたタグです。読み書きには、そのタグに設定された鍵が要ります。'] },
    {
      list: [
        '「MIFARE 鍵」の画面で、運用している鍵を登録します。登録した鍵は伏字で表示し、値は画面に出しません。',
        '公開されている標準の鍵（工場出荷時・NFC Forum の MAD / NDEF 鍵）は、最初から入っています。',
        '自動読み取り（タグを置いたら自動で読み取る）では、公開されている標準の鍵だけを試します。登録した鍵は、［タグを読み取る］［登録した鍵で読み取る］などを押して読み取るときだけ試します（置いただけのタグに、登録した鍵を試させないためです）。',
      ],
    },
    { note: { tone: 'info', text: 'このアプリは鍵の解析・総当たりをしません。鍵が分からないセクタは読み書きできません。' } },
  ],
  trial: [
    { body: ['仮想リーダーは、実機の NFC リーダーが無くても操作を試せる、アプリの中の仮のリーダーです。'] },
    {
      list: [
        '「読み取り」画面の「お試し（実機なし）」を開き、「仮想リーダーを使う」をオンにします。',
        '［タグを置く］［タグを離す］で、仮想のタグを置いたり離したりできます。種類を選んで、新しい空のタグに替えることもできます。',
        '仮想リーダーにタグがある間は、実機のリーダーより仮想リーダーを優先します。実機のタグを使うときは、仮想リーダーをオフにしてください。',
      ],
    },
  ],
  uid: [
    { body: ['UID（製造番号・シリアル番号。FeliCa では IDm）は、タグの製造時に書き込まれ、以後は読み取り専用です。書き換えることはできません。'] },
    { body: ['そのため、タグを「複製」しても UID は複製されません。複製できるのは、書き込みできるデータ領域（ユーザーメモリ・NDEF）だけです。'] },
    {
      note: {
        tone: 'info',
        text: 'UID だけで本人確認する入退室システムは、タグを複製しても別の UID になるため、そのままでは通りません。データ領域の内容（社員 ID など）で判定する運用が、複製・再発行に向いています。',
      },
    },
  ],
  authorized: [
    { body: ['このアプリは、管理・運用する権限を持っているタグにだけ使ってください。'] },
    {
      heading: '想定する使い方',
      list: [
        '自組織の社員証・勤怠タグ・会員証などに、社員 ID や会員番号を採番して発行する',
        '自分のタグのデータ領域をバックアップし、別の空のタグに書き戻す・複製する',
        'NFC タグに URL・Wi-Fi の設定・連絡先などの NDEF を書き込む',
      ],
    },
    {
      heading: 'このアプリがしないこと',
      list: [
        '他人のタグの不正な複製や、認証の回避はできません（技術的にもできない設計です）。',
        'MIFARE Classic の鍵の解析・総当たりはしません。鍵は、運用者が持っているものを登録して使います。',
        'UID を書き換える特殊なタグ（いわゆる magic card）向けのバックドアは実装していません。',
      ],
    },
    { note: { tone: 'warn', text: 'ロックビットやパスワードの設定など、取り消せない操作は、「設定」で上級者モードをオンにしたときだけ使えます。' } },
  ],
  faq: [
    {
      heading: 'タグを置いたのに何も起きません',
      body: [
        '画面の下の状態表示と、「読み取り」画面の「リーダーの上のタグ」を見てください。「タグなし」のままなら、タグをリーダーの中央に置き直してください。金属の上や、2 枚重ねでは読めないことがあります。改札のように一瞬タッチするだけでは読めないので、置いたままにしてください。',
      ],
    },
    {
      heading: '［タグを読み取る］が押せません',
      body: ['ボタンの下に、押せない理由が出ます（タグが置かれていない・確認中・一括発行の実行中など）。理由に合わせて、タグを置く、一括発行を止める、などの対処をしてください。'],
    },
    {
      heading: '「読み取れません（置き直してください）」と出ます',
      body: ['タグが応答していません。置き直すか、「リーダーの上のタグ」の［もう一度確認］を押してください。'],
    },
    {
      heading: 'リーダーが認識されません（一覧に出ません）',
      body: [
        'USB を抜いて挿し直す、別のポートに挿す、ドライバを入れる、Windows の「Smart Card」サービスを確かめる、の順に試してください。Sony PaSoRi は、スリープから復帰した後などに認識されなくなることがあり、USB の抜き差しで戻ります。',
      ],
    },
    {
      heading: '「別のアプリがリーダーを使用中です」と出ます',
      body: ['NFC を使うほかのアプリ（リーダーの常駐ソフト・勤怠ソフトなど）がリーダーを使っています。そのアプリを閉じてから、もう一度実行してください。'],
    },
    {
      heading: '書き込みに失敗した・一部だけ書き込まれた',
      body: [
        'タグが途中で離れたか、保護された領域・ロック済みの領域に書こうとした可能性があります。タグを置いたまま、もう一度書き込んでください。保護された領域やロック済みの領域には書き込めません。',
      ],
    },
    {
      heading: 'Sony PaSoRi でパスワード保護やカウンタが使えません',
      body: [
        'Sony PaSoRi はストレージ方式で動くため、パスワード認証・NFC カウンタ・署名の読み取りは使えません。パスワードで保護したタグは、パスワードが分かっていても PaSoRi では読み書きできません。これらを使うときは、ACR122U などのリーダーを使います。',
      ],
    },
    {
      heading: 'MIFARE Classic のセクタが「鍵かパスワードが必要で読めなかった」になります',
      body: [
        '自動読み取りでは、公開されている標準の鍵だけを試します。［登録した鍵で読み取る］を押すと、登録した鍵も試します。それでも読めないときは、そのセクタを開く鍵を「MIFARE 鍵」で登録してから、もう一度読み取ってください。',
      ],
    },
    {
      heading: '保護（読み取り専用・パスワード）を設定したのに効きません',
      body: ['保護の設定は、タグをリーダーから離して置き直すと有効になります。'],
    },
    {
      heading: '他人の交通系 IC や社員証を複製できますか',
      body: ['できません。それらは鍵で保護されており、UID も固定です。このアプリは、鍵を管理している自組織のタグを発行・編集するためのものです。'],
    },
  ],
};

const EN: Record<HelpTopicId, HelpBlock[]> = {
  start: [
    {
      body: [
        'NFC Tag Studio is a desktop app for reading, editing, writing, backing up and batch-issuing the NFC tags your organisation manages (NTAG213/215/216, MIFARE Classic 1K/4K, FeliCa Lite-S).',
      ],
    },
    {
      heading: 'Editing one tag',
      list: [
        'Connect an NFC reader (Sony PaSoRi (RC-S380 etc.), ACR122U, …) by USB. No reader? Use the virtual reader in "Try it (no hardware)" on the Read screen.',
        'Place the tag on the reader and keep it there: it is read automatically (if automatic reading is off in Settings, press "Read tag").',
        'Edit the contents in the NDEF editor (URL, text, …) or the binary editor (memory, byte by byte), then press "Write to tag" on that screen.',
        'To keep a copy as a file, use "Save to file…" in the binary editor or the Backup & duplicate screen. Saved files can be opened with "Open file…" on the Read screen.',
        'To write the same content or sequence numbers to many tags, use Batch issue.',
      ],
    },
    {
      note: {
        tone: 'warn',
        text: 'Keep the tag on the reader until reading or writing has finished. A quick tap, like at a ticket gate, is not enough. Moving it away during a write can leave it partly written.',
      },
    },
    { note: { tone: 'info', text: 'You can try everything without hardware using the virtual reader (see "Trying it").' } },
  ],
  read: [
    { body: ['The Read screen has two panels: "Tag on the reader" and "Open document".'] },
    {
      list: [
        '"Tag on the reader" is the live state of the tag on the reader (place a tag, checking, tag detected, unsupported type, cannot read).',
        '"Open document" is what was read from a tag or opened from a file. It stays when the tag is taken off the reader.',
        'A newly placed tag is read automatically, except when the open document has unsaved changes or was opened from a file ("This is not the open document\'s tag" is shown; press "Read this tag").',
        'Areas that need a password or key are reported separately from areas that could not be read because communication dropped. For the latter, re-place the tag and read it again.',
        'For MIFARE Classic, automatic reading tries only the public standard keys. Sectors that a registered key opens are read when you press "Read tag" (or similar), or "Read with registered keys" next to "Needs a key or password, not read".',
        'Automatic reading can be turned off in Settings ("Read a tag automatically when it is placed").',
      ],
    },
  ],
  ndef: [
    { body: ['NDEF is the standard data format phones and NFC readers understand. You can write URLs, text, Wi-Fi settings, contacts (vCard), app launch (AAR) and more.'] },
    {
      list: [
        'Add and reorder records in the NDEF editor, check the capacity meter, then press "Write to tag".',
        'It writes to the tag that is on the reader now. Right before writing, that tag is read and the write is planned from its contents (if it is not the tag the document was read from, the confirmation says so).',
        'To empty a tag\'s NDEF, use "Erase NDEF".',
        'In batch issue, placeholders such as {{seq}} (sequence) and {{uid}} make each tag different.',
        'FeliCa Lite-S does not use the NDEF editor; use the binary editor.',
      ],
    },
  ],
  hex: [
    {
      body: [
        'The binary editor shows the tag memory per page (NTAG) or block (MIFARE Classic, FeliCa Lite-S) and lets you edit it byte by byte, colour-coded by region, marking protected and non-writable areas.',
      ],
    },
    {
      list: [
        'The bar at the top chooses what you edit (a tag that was read, a file or a new document): "Read tag", "Open file…", "New…", "Save to file…", "Close". "Write to tag" in the bar at the bottom writes to the tag on the reader.',
        '"Write to tag" writes only the changed pages / blocks. Before writing, the confirmation shows the target tag (type and UID).',
        'Writing a document of another tag, a file or a new document is a "copy": the target tag is read first and only what differs from it is written.',
        'For a password-protected NTAG, enter it with "Enter password" before reading or writing. The password is never stored by the app. Password auth works only with readers such as the ACR122U (a storage-only reader such as a Sony PaSoRi cannot use the password field).',
        'Locked pages cannot be edited. Protected areas (CC, locks, configuration, password, trailers) can be edited only with "Edit and write protected areas too" in advanced mode.',
        'Unsaved changes stay when you switch screens. The "Binary editor" item in the left menu gets a mark and the status bar at the bottom shows how many changes there are.',
      ],
    },
    { heading: 'Edit sequence / number', body: ['Treat a selected byte range as a number and +1 / −1 it, add a custom step, or set a value — handy for adjusting a counter by hand.'] },
    { note: { tone: 'warn', text: 'UID pages, lock bits and other non-writable / irreversible areas are protected.' } },
  ],
  backup: [
    { body: ['Backup & duplicate saves a tag to a file (.nfcdump / .bin / Flipper .nfc) and writes it back to the same or another tag.'] },
    {
      list: [
        'To write a backup back to the tag it came from, use "Restore this tag"; to write it to another tag, duplicate it.',
        'Only the data area is written; the UID is never duplicated.',
        'Saved files can also be opened with "Open file…" on the Read screen.',
        'To duplicate to many tags in a row, use Batch issue.',
      ],
    },
    { note: { tone: 'info', text: 'Backup files never contain keys or passwords: MIFARE key A, key B where it is used as a key, and the NTAG password (PWD, PACK) are saved as 00. In sectors set so that key B can be read, key B cannot be used as a key; it is plain data and is kept.' } },
  ],
  issue: [
    { body: ['Batch issue writes the same schema or NDEF, sequence numbers or CSV values while you place tags on the reader one after another.'] },
    {
      list: [
        'If something prevents starting, the reason is shown next to "Start issuing". With a CSV, "Start at row" chooses the row to begin with.',
        'Place a tag on the reader and it is written automatically. Keep it there until the sound and the result (success / skipped / failed); then take it off and place the next one.',
        'A tag that is already on the reader when you start is not written. Take it off and place it again.',
        'A tag taken off mid-write is only partly written. Place the same tag again and it is rewritten with the same number.',
        'With "Skip tags whose UID is in the issue log", tags that were already issued are not issued twice.',
        '"Only write blank tags" skips tags that already hold data.',
        'After stopping, "Resume" continues with the next number / row, and "Start over…" issues from the first number again.',
        'Password protection after issuing (advanced mode) is meant for readers such as the ACR122U. A tag protected with a storage-only reader such as a Sony PaSoRi can no longer be read or written with that reader, even with the password.',
        'Records are kept in the issue log (keys and passwords are never recorded).',
      ],
    },
  ],
  schema: [
    { body: ['A data schema decides where and in which format data such as an employee ID is written on a tag. Build it on screen and save it as JSON (*.nfcschema).'] },
    { heading: 'Sequence numbers', body: ['Set a field\'s source to "sequence" and the value increases with every tag batch issue writes. Set the start and step on the Batch issue screen.'] },
    { list: ['Formats: unsigned integer, BCD, ASCII, UTF-8, hex, date, checksum.', 'Sources: fixed, input, sequence, CSV column, current date/time, part of the UID.'] },
  ],
  log: [
    { body: ['The issue log keeps a record per tag handled by batch issue (time, UID, sequence number, result). It can be exported to CSV.'] },
    { list: ['Keys and passwords are never recorded.'] },
  ],
  reader: [
    { body: ['The app talks to NFC readers through PC/SC (the Windows "Smart Card" service).'] },
    {
      heading: 'Supported readers and what they can do',
      list: [
        'Sony PaSoRi (RC-S380 etc.): reads and writes NTAG213/215/216 and FeliCa Lite-S (storage transport). Password auth, the NFC counter and the signature are not available (password-protected pages cannot be read or written, even with the password). MIFARE Classic has not been verified yet.',
        'ACR122U and similar (ACR122U transport): password auth, counter and signature as well as read/write.',
        'USB security tokens (YubiKey etc.) and contact smart card readers are not detected as NFC readers, so automatic selection never uses them. Only if an NFC reader is not detected, choose it under "Reader to use" in Settings (you are asked first; the app then sends that device commands to check for a tag).',
      ],
    },
    {
      heading: 'Which reader is used',
      body: [
        'With "Reader to use" set to Automatic, the virtual reader is used while it holds a tag; otherwise the NFC reader with a tag on it (or the first NFC reader).',
        'When you select a reader, only that reader is used. If it is not connected, "Selected reader not connected" is shown: connect it again or press "Back to automatic selection".',
      ],
    },
    { heading: 'Transport', body: ['Automatic works in most cases. The transport in use is shown in Settings ("Transport (current tag)").'] },
    {
      heading: 'If the reader is not detected',
      list: [
        'Unplug the reader\'s USB cable and plug it back in (readers sometimes disappear after the PC wakes from sleep).',
        'Try another USB port. If you use a USB hub, plug the reader directly into the PC.',
        'Install the reader\'s driver (for a Sony PaSoRi: "NFC Port Software").',
        'If it still does not appear, check that the Windows "Smart Card" service is running.',
      ],
    },
  ],
  felica: [
    { body: ['FeliCa Lite-S (RC-S966 etc.) is a FeliCa tag made of 16-byte blocks. Its serial number is called the IDm (8 bytes) and cannot be changed.'] },
    {
      list: [
        'Writable areas are S_PAD0–S_PAD13 (224 bytes) and REG. Edit them in the binary editor (the NDEF editor does not apply).',
        'Other FeliCa cards, such as transit cards or FeliCa staff IDs, are not supported.',
        'A Sony PaSoRi can read and write it.',
      ],
    },
    {
      note: {
        tone: 'warn',
        text: 'Write protection (read-only) takes effect after the tag is taken off the reader and placed again. Once in effect, it cannot be undone.',
      },
    },
  ],
  mifare: [
    { body: ['MIFARE Classic protects each sector with keys (Key A / Key B). Reading and writing needs the keys set on that tag.'] },
    {
      list: [
        'Register the keys you hold on the MIFARE keys screen. Stored keys are shown masked; values never appear.',
        'The public standard keys (factory default, NFC Forum MAD / NDEF) are built in.',
        'Automatic reading (when a tag is placed) tries only the public standard keys. Your registered keys are tried only when you press "Read tag", "Read with registered keys" or similar (so a tag that is merely placed on the reader is never tried with your keys).',
      ],
    },
    { note: { tone: 'info', text: 'This app does not recover or brute-force keys. Sectors whose key is unknown cannot be read or written.' } },
  ],
  trial: [
    { body: ['The virtual reader is a reader inside the app so you can try it without a real NFC reader.'] },
    {
      list: [
        'Open "Try it (no hardware)" on the Read screen and turn on "Use the virtual reader".',
        '"Place tag" / "Take tag off" put the virtual tag on and off the reader. You can also choose a type and replace it with a new blank tag.',
        'While the virtual reader holds a tag, it is used instead of real readers. Turn it off to use real tags.',
      ],
    },
  ],
  uid: [
    { body: ['The UID (serial number; IDm on FeliCa) is written at manufacture and is read-only thereafter. It cannot be changed.'] },
    { body: ['So duplicating a tag never duplicates the UID. Only the writable data area (user memory, NDEF) is copied.'] },
    {
      note: {
        tone: 'info',
        text: 'An access system that checks only the UID will not accept a duplicated tag, because the copy has a different UID. Systems that check the data (e.g. an employee ID) are better suited to re-issuing.',
      },
    },
  ],
  authorized: [
    { body: ['Use this app on tags you are authorised to manage.'] },
    {
      heading: 'Intended use',
      list: [
        'Issue employee IDs / member numbers onto your own ID, attendance or membership tags',
        'Back up your tags and write the data back / duplicate it to blank tags',
        'Write NDEF (URL, Wi-Fi, contact, …) to NFC tags',
      ],
    },
    {
      heading: 'What it does not do',
      list: [
        "It cannot clone someone else's tag or bypass authentication (by design).",
        'It does not recover or brute-force MIFARE Classic keys. Register the keys you hold.',
        'It implements no UID-rewrite backdoors for "magic cards".',
      ],
    },
    { note: { tone: 'warn', text: 'Irreversible operations (lock bits, password setup) are available only with Advanced mode turned on in Settings.' } },
  ],
  faq: [
    {
      heading: 'I placed a tag and nothing happens',
      body: [
        'Look at the status bar at the bottom and "Tag on the reader" on the Read screen. If it still says "No tag", re-place the tag in the centre of the reader. Tags may not read on metal or when two overlap. A quick tap is not enough: keep it on the reader.',
      ],
    },
    {
      heading: '"Read tag" cannot be pressed',
      body: ['The reason is shown under the button (no tag, checking, batch issue running, …). Do what it says: place a tag, stop batch issue, and so on.'],
    },
    {
      heading: 'It says "Cannot read (re-place the tag)"',
      body: ['The tag is not responding. Re-place it, or press "Check again" in "Tag on the reader".'],
    },
    {
      heading: 'The reader is not detected (not listed)',
      body: [
        'Unplug and replug the USB cable, try another port, install the driver, then check the Windows "Smart Card" service, in that order. A Sony PaSoRi sometimes disappears after the PC wakes from sleep; unplugging and replugging it brings it back.',
      ],
    },
    {
      heading: 'It says another application is using the reader',
      body: ['Another NFC application (a reader utility, attendance software, …) holds the reader. Close it and try again.'],
    },
    {
      heading: 'A write failed, or only part was written',
      body: [
        'The tag may have left the reader mid-write, or the write targeted a protected or locked area. Keep the tag on the reader and write again. Protected and locked areas cannot be written.',
      ],
    },
    {
      heading: 'Password protection or the counter does not work with a Sony PaSoRi',
      body: [
        'A Sony PaSoRi runs the storage transport, so password auth, the NFC counter and the signature are not available. A password-protected tag cannot be read or written with a PaSoRi, even with the password. Use a reader such as an ACR122U for those.',
      ],
    },
    {
      heading: 'MIFARE Classic sectors say "Needs a key or password, not read"',
      body: [
        'Automatic reading tries only the public standard keys. Press "Read with registered keys" to try your registered keys too. If they still cannot be read, register the key that opens those sectors under "MIFARE keys" and read again.',
      ],
    },
    {
      heading: 'I set protection (read-only, password) but it has no effect',
      body: ['Protection takes effect after the tag is taken off the reader and placed again.'],
    },
    {
      heading: "Can I clone someone's transit card or ID?",
      body: ["No. Those are key-protected with a fixed UID. This app is for issuing and editing your own organisation's tags, for which you hold the keys."],
    },
  ],
};

export function helpContent(lang: LanguageSetting): Record<HelpTopicId, HelpBlock[]> {
  return lang === 'ja' ? JA : EN;
}
