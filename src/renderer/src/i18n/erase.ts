// Dictionary for the erase screen ("消去", 2026-11-13). Keys start with "erase.".
// Add every key to BOTH ja and en (compile-checked). D7 terms (tests/i18n.test.ts):
// 「読み取る」「置く」「離す」「タグ」、画面に「単位」を出さない（ページ／ブロック）。
import { defineMessages } from './define';

export default defineMessages({
  ja: {
    'erase.title': '消去',
    'erase.subtitle': 'タグに書き込まれたデータを消します。UID・設定・ロックは変わりません',
    'erase.scope':
      '消すのは、書き込みできるデータ領域だけです。UID（製造番号）・ロック・設定・パスワード・MIFARE の鍵とアクセス条件は変わりません。消した内容は元に戻せないので、必要なら先に「バックアップ・複製」で保存してください。',

    'erase.entry.title': '消去するタグを読み取ってください',
    'erase.entry.body': '消去するタグをリーダーの上に置いて、［タグを読み取る］を押します。消去する前に、いまの中身と消去する範囲を確かめられます。',
    'erase.read': 'タグを読み取る',
    'erase.reread': '読み取り直す',

    'erase.tag.title': '消去するタグ',
    'erase.tag.kind': '種類',
    'erase.tag.readAt': '読み取った時刻',
    'erase.tag.ndef': 'いまの NDEF',
    'erase.tag.denied': '鍵かパスワードが必要で読めなかった所',
    'erase.ndef.records': '{n} 件のレコード',
    'erase.ndef.empty': '空',
    'erase.ndef.none': 'NDEF の形式ではありません',
    'erase.ndef.unreadable': '読めませんでした',
    'erase.ndef.invalid': 'NDEF として読めない内容です',
    'erase.ndef.unsupported': 'このタグには NDEF がありません',
    'erase.deniedNote': '鍵かパスワードが必要で読めなかった所は、消去できません。MIFARE Classic は「MIFARE 鍵」で鍵を登録してから、読み取り直してください。',
    'erase.incomplete': '読み取りが途中で途切れたページ・ブロックがあります。タグを置き直して、読み取り直してください。',
    'erase.otherTag': 'リーダーの上のタグ（{now}）は、読み取ったタグ（{read}）と違います。このタグを消去するときは、読み取り直してください。',

    'erase.mode.title': '消去する範囲',
    'erase.mode.ndef': 'NDEF を空にする',
    'erase.mode.ndefDesc': 'スマートフォンで読める内容（URL・テキストなど）を消します。タグは、NDEF を書き込める状態のまま残ります。',
    'erase.mode.all': 'データ領域をすべて消す',
    'erase.mode.allDescNtag': 'ユーザー領域を空にして、空の NDEF だけを残します（工場出荷時に近い状態です。先頭のロックの情報（Lock Control TLV）があれば残します）。',
    'erase.mode.allDescMifare': '読み取れたセクタのデータブロックを、すべて 00 にします（トレーラと block 0 は変わりません）。NDEF の形式（MAD）も消えます。',
    'erase.mode.allDescFelica': 'S_PAD0〜S_PAD13 を、すべて 00 にします（REG と MC は変わりません）。',
    'erase.mode.pages': '書き換えるページ: {n}',
    'erase.mode.blocks': '書き換えるブロック: {n}',
    'erase.mode.already': 'すでに消去された状態です',
    'erase.mode.locked': 'ロックされていて消せない所: {list}',

    'erase.run': '消去する',
    'erase.why.incomplete': '読み取り直すと消去できます',
    'erase.why.otherTag': '読み取ったタグをリーダーの上に置いてください',
    'erase.why.nothing': 'すでに消去された状態です（書き換える所がありません）',
    'erase.why.plan': 'この範囲は消去できません',

    'erase.cf.title': 'タグのデータを消去しますか？',
    'erase.cf.msgNdef': 'タグ {uid}（{kind}）の NDEF を空にします。UID・設定・ロックは変わりません。消した内容は元に戻せません。',
    'erase.cf.msgAll': 'タグ {uid}（{kind}）のデータ領域をすべて消します。UID・設定・ロックは変わりません。消した内容は元に戻せません。',
    'erase.done': 'タグのデータを消去しました',
    'erase.changed': '読み取ったあとで、タグの中身が変わっていました。いまの中身を表示したので、もう一度確かめてから消去してください。',
  },
  en: {
    'erase.title': 'Erase',
    'erase.subtitle': 'Erase the data written on a tag. The UID, settings and locks do not change',
    'erase.scope':
      'Only the writable data area is erased. The UID (serial number), lock bits, settings, password and MIFARE keys and access conditions do not change. Erased content cannot be restored, so save it first under "Backup & duplicate" if you may need it.',

    'erase.entry.title': 'Read the tag to erase',
    'erase.entry.body': 'Place the tag to erase on the reader and press "Read tag". Before erasing you see what it holds and what will be erased.',
    'erase.read': 'Read tag',
    'erase.reread': 'Read again',

    'erase.tag.title': 'Tag to erase',
    'erase.tag.kind': 'Type',
    'erase.tag.readAt': 'Read at',
    'erase.tag.ndef': 'NDEF now',
    'erase.tag.denied': 'Not read (key or password needed)',
    'erase.ndef.records': '{n} record(s)',
    'erase.ndef.empty': 'Empty',
    'erase.ndef.none': 'Not NDEF-formatted',
    'erase.ndef.unreadable': 'Could not be read',
    'erase.ndef.invalid': 'Not a valid NDEF message',
    'erase.ndef.unsupported': 'This tag has no NDEF',
    'erase.deniedNote': 'Areas that need a key or password and were not read cannot be erased. For MIFARE Classic, register the key under "MIFARE keys" and read the tag again.',
    'erase.incomplete': 'Some pages or blocks were cut off while reading. Place the tag again and read it again.',
    'erase.otherTag': 'The tag on the reader ({now}) is not the tag you read ({read}). To erase this tag, read it first.',

    'erase.mode.title': 'What to erase',
    'erase.mode.ndef': 'Empty the NDEF',
    'erase.mode.ndefDesc': 'Removes what phones read (URLs, text, ...). The tag stays ready for NDEF.',
    'erase.mode.all': 'Erase the whole data area',
    'erase.mode.allDescNtag': 'Clears the user memory and leaves only an empty NDEF (close to the factory state; a Lock Control TLV at the start is kept).',
    'erase.mode.allDescMifare': 'Sets every data block of the sectors that were read to 00 (sector trailers and block 0 do not change). The NDEF format (MAD) is erased too.',
    'erase.mode.allDescFelica': 'Sets S_PAD0 to S_PAD13 to 00 (REG and MC do not change).',
    'erase.mode.pages': 'Pages to write: {n}',
    'erase.mode.blocks': 'Blocks to write: {n}',
    'erase.mode.already': 'Already erased',
    'erase.mode.locked': 'Locked, cannot be erased: {list}',

    'erase.run': 'Erase',
    'erase.why.incomplete': 'Read the tag again to erase it',
    'erase.why.otherTag': 'Place the tag you read on the reader',
    'erase.why.nothing': 'Already erased (nothing to write)',
    'erase.why.plan': 'This range cannot be erased',

    'erase.cf.title': 'Erase the data on the tag?',
    'erase.cf.msgNdef': 'The NDEF of tag {uid} ({kind}) is emptied. The UID, settings and locks do not change. Erased content cannot be restored.',
    'erase.cf.msgAll': 'The whole data area of tag {uid} ({kind}) is erased. The UID, settings and locks do not change. Erased content cannot be restored.',
    'erase.done': 'Erased the data on the tag',
    'erase.changed': 'The tag changed after it was read. Its current content is shown now; check it again before erasing.',
  },
});
