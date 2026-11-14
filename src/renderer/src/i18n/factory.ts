// Dictionary for the full reset screen ("完全初期化", 2026-11-14). Keys start with "factory.".
// Add every key to BOTH ja and en (compile-checked). D7 terms (tests/i18n.test.ts).
import { defineMessages } from './define';

export default defineMessages({
  ja: {
    'factory.title': '完全初期化',
    'factory.subtitle': 'タグを工場出荷時の状態に戻します。データだけでなく、設定・パスワード・MIFARE の鍵とアクセス条件も戻します',
    'factory.scope':
      'データ・設定・パスワード・鍵が、工場出荷時の値に書き換わります。運用していたパスワードや鍵では管理できなくなり、元に戻せません。UID は変わりません。ロックビットのように物理的に戻せないものは書き換えず、下に理由を出します。必要なら先に「バックアップ・複製」で保存してください。',
    'factory.advanced': '完全初期化は、設定・パスワード・鍵も書き換えるので、上級者モードのときだけ実行できます。読み取って、戻すものを確かめることはできます。',
    'factory.openSettings': '設定を開く',

    'factory.entry.title': '初期化するタグを読み取ってください',
    'factory.entry.body': '初期化するタグをリーダーの上に置いて、［タグを読み取る］を押します。読み取った中身から、工場出荷時に戻すものと、戻せないものを確かめられます。',
    'factory.read': 'タグを読み取る',
    'factory.reread': '読み取り直す',

    'factory.tag.title': '初期化するタグ',
    'factory.tag.kind': '種類',
    'factory.tag.readAt': '読み取った時刻',

    'factory.restore.title': '工場出荷時に戻すもの',
    'factory.area.data': 'データ領域: {count}',
    'factory.area.cc': '容量情報（CC）',
    'factory.area.config': '設定（CFG0／CFG1）: パスワード保護・NFC カウンタ・ミラーを止めます',
    'factory.area.password': 'パスワード（PWD／PACK）: 工場出荷時の値（FFFFFFFF）に。読み出せない値なので、毎回書き直します',
    'factory.area.trailers': 'MIFARE の鍵とアクセス条件: {n} セクタを、工場出荷時の鍵（FFFFFFFFFFFF）とアクセス条件（FF 07 80）に。鍵 A は読み出せないので、毎回書き直します',
    'factory.area.mc': 'FeliCa の MC（ブロック 0x88）: 工場出荷時の値に（保護の設定はそのまま）',
    'factory.area.reg': 'FeliCa の REG',
    'factory.already': 'データと設定は、すでに工場出荷時の状態です（読み出せないパスワード・鍵だけを書き直します）',
    'factory.writes.pages': '書き換えるページ: {n}',
    'factory.writes.blocks': '書き換えるブロック: {n}',

    'factory.cannot.title': '戻せないもの',
    'factory.cannot.none': '戻せないものはありません',
    'factory.issue.lockBits': 'ロックビットが立っています。ロックビットは一度立てると戻せません',
    'factory.issue.lockedUnits': 'ロックされていて書き換えられない所: {list}',
    'factory.issue.cfgLock': '設定は恒久ロック（CFGLCK）されています。設定のページは戻せません',
    'factory.issue.ccOtp': '容量情報（CC）は一度だけ書ける領域で、工場出荷時の値に戻せない形に変わっています',
    'factory.issue.counter': 'NFC カウンタは止めますが、数えた値は戻せません',
    'factory.issue.unread': '鍵かパスワードが必要で読めなかった所（{count}）は、そのままにします。MIFARE Classic は「MIFARE 鍵」で鍵を登録してから読み取り直してください',
    'factory.issue.felicaWp': 'FeliCa の書込保護（ブロック {list}）は、一度有効になると戻せません',
    'factory.issue.felicaRp': 'FeliCa の読取保護は、このアプリでは外せません（そのままにします）',
    'factory.issue.felicaSys': 'FeliCa のシステムブロックが読み取り専用です。MC は戻せません',

    'factory.block.password':
      'パスワードで保護されています。保護を外さないと初期化できません。ACR122U などのリーダーで、バイナリ編集からパスワードを入力して保護を外してください（Sony PaSoRi などのストレージ方式のリーダーでは、パスワード認証ができません）。',
    'factory.block.interrupted': '読み取りが途中で途切れたページ・ブロックがあります。タグを置き直して、読み取り直してください。',
    'factory.otherTag': 'リーダーの上のタグ（{now}）は、読み取ったタグ（{read}）と違います。このタグを初期化するときは、読み取り直してください。',

    'factory.run': '初期化する',
    'factory.why.advanced': '上級者モードのときだけ実行できます（設定）',
    'factory.why.block': '初期化できません（上の理由）',
    'factory.why.otherTag': '読み取ったタグをリーダーの上に置いてください',
    'factory.why.incomplete': '読み取り直すと初期化できます',

    'factory.cf.title': 'タグを工場出荷時の状態に戻しますか？',
    'factory.cf.message':
      'タグ {uid}（{kind}）のデータ・設定・パスワード・鍵を、工場出荷時の値に書き換えます。運用していたパスワードや鍵では管理できなくなり、元に戻せません。UID は変わりません。',
    'factory.cf.word': '初期化',
    'factory.done': 'タグを工場出荷時の状態に戻しました',
    'factory.changed': '読み取ったあとで、タグの中身が変わっていました。いまの中身を表示したので、もう一度確かめてから初期化してください。',
  },
  en: {
    'factory.title': 'Factory reset',
    'factory.subtitle': 'Put a tag back to the state it was delivered in: not only the data, but also the settings, password and MIFARE keys and access conditions',
    'factory.scope':
      'The data, settings, password and keys are overwritten with the factory values. The password and keys you used no longer manage the tag, and this cannot be undone. The UID does not change. What physically cannot go back (such as lock bits) is not written; the reasons are shown below. Save the tag first under "Backup & duplicate" if you may need it.',
    'factory.advanced': 'A factory reset also rewrites the settings, password and keys, so it runs only in advanced mode. You can still read the tag and check what would be reset.',
    'factory.openSettings': 'Open settings',

    'factory.entry.title': 'Read the tag to reset',
    'factory.entry.body': 'Place the tag on the reader and press "Read tag". From what it holds you see what goes back to the factory state and what cannot.',
    'factory.read': 'Read tag',
    'factory.reread': 'Read again',

    'factory.tag.title': 'Tag to reset',
    'factory.tag.kind': 'Type',
    'factory.tag.readAt': 'Read at',

    'factory.restore.title': 'Goes back to the factory state',
    'factory.area.data': 'Data area: {count}',
    'factory.area.cc': 'Capability container (CC)',
    'factory.area.config': 'Settings (CFG0 / CFG1): password protection, NFC counter and mirror off',
    'factory.area.password': 'Password (PWD / PACK): the factory value (FFFFFFFF). It cannot be read back, so it is written every time',
    'factory.area.trailers': 'MIFARE keys and access conditions: {n} sector(s) to the factory key (FFFFFFFFFFFF) and access bits (FF 07 80). Key A cannot be read back, so it is written every time',
    'factory.area.mc': 'FeliCa MC (block 0x88): the factory value (protection settings kept)',
    'factory.area.reg': 'FeliCa REG',
    'factory.already': 'The data and settings are already in the factory state (only the password / keys, which cannot be read back, are written again)',
    'factory.writes.pages': 'Pages to write: {n}',
    'factory.writes.blocks': 'Blocks to write: {n}',

    'factory.cannot.title': 'Cannot go back',
    'factory.cannot.none': 'Nothing',
    'factory.issue.lockBits': 'Lock bits are set. Lock bits cannot be cleared once set',
    'factory.issue.lockedUnits': 'Locked, cannot be rewritten: {list}',
    'factory.issue.cfgLock': 'The configuration is locked for good (CFGLCK). The settings pages cannot go back',
    'factory.issue.ccOtp': 'The capability container (CC) is one-time programmable and was changed in a way that cannot go back',
    'factory.issue.counter': 'The NFC counter is switched off, but its value cannot be reset',
    'factory.issue.unread': 'Areas not read (key or password needed, {count}) are left as they are. For MIFARE Classic, register the key under "MIFARE keys" and read again',
    'factory.issue.felicaWp': 'FeliCa write protection (block(s) {list}) cannot be undone once active',
    'factory.issue.felicaRp': 'FeliCa read protection cannot be removed by this app (it is left as it is)',
    'factory.issue.felicaSys': 'The FeliCa system blocks are read-only. MC cannot go back',

    'factory.block.password':
      'The tag is password-protected. Remove the protection before resetting: on an ACR122U-type reader, enter the password in the binary editor and turn the protection off (storage-type readers such as the Sony PaSoRi cannot authenticate).',
    'factory.block.interrupted': 'Some pages or blocks were cut off while reading. Place the tag again and read it again.',
    'factory.otherTag': 'The tag on the reader ({now}) is not the tag you read ({read}). To reset this tag, read it first.',

    'factory.run': 'Reset',
    'factory.why.advanced': 'Runs only in advanced mode (Settings)',
    'factory.why.block': 'Cannot reset (see above)',
    'factory.why.otherTag': 'Place the tag you read on the reader',
    'factory.why.incomplete': 'Read the tag again to reset it',

    'factory.cf.title': 'Put the tag back to the factory state?',
    'factory.cf.message':
      'The data, settings, password and keys of tag {uid} ({kind}) are overwritten with the factory values. The password and keys you used no longer manage the tag, and this cannot be undone. The UID does not change.',
    'factory.cf.word': 'reset',
    'factory.done': 'The tag is back in the factory state',
    'factory.changed': 'The tag changed after it was read. Its current content is shown now; check it again before resetting.',
  },
});
