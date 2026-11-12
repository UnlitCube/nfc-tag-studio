// Dictionary for feature "backup". Owner: agent renderer-backup (backup/duplicate + MIFARE keys views).
// Keys must start with "backup." or "keys." and be added to BOTH ja and en (compile-checked).
import { defineMessages } from './define';

export default defineMessages({
  ja: {
    // --- Backup / restore / duplicate view ---
    'backup.title': 'バックアップ・複製',
    'backup.subtitle': 'タグの内容をファイルに保存し、同じタグに戻したり、別のタグへ複製したりします',

    // The read-only-UID message is shown permanently in the UI (invariant I1/I2).
    'backup.uidReadonlyTitle': 'UID は複製できません',
    'backup.uidReadonlyBody':
      'タグの UID（製造番号）は製造時に固定された読み取り専用の値です。このアプリは UID を書き換えません。複製するのは書き込み可能なデータ領域だけで、複製先のタグは元の UID のままになります。',

    'backup.n.pages': '{n} ページ',
    'backup.n.blocks': '{n} ブロック',
    'backup.placeHint': 'タグはリーダーの上に置き、終わるまで置いたままにしてください（改札のように一瞬タッチするだけでは読めません）。',

    'backup.noDoc.title': 'バックアップ元がありません',
    'backup.noDoc.body':
      '保存・復元・複製の元にするタグをリーダーの上に置いて読み取るか、保存したファイル（.nfcdump / .bin / .nfc）を開いてください。',
    'backup.read': 'タグを読み取る',
    'backup.open.button': 'ファイルを開く',

    // --- Source (the open document) ---
    'backup.source.title': 'バックアップ元（複製元）',
    'backup.source.origin': '取得元',
    'backup.source.fromCard': 'タグ {uid}（{when} に読み取り）',
    'backup.source.fromFile': 'ファイル {name}',
    'backup.source.fromNew': '新規の文書',
    'backup.source.note': 'メモ',
    'backup.source.savedAt': '保存日時',
    'backup.source.dirty': '未書き込みの変更',
    'backup.source.dirtyValue': '{count}（タグにもファイルにも、まだ保存していません）',
    'backup.warn.error':
      '{count}は読み取りが途中で途切れたため、内容が 0 になっています。タグをリーダーの上に置いたまま、読み取り直してください。',
    'backup.warn.denied': '{count}は保護されていて読めなかったため、内容が 0 になっています（パスワードまたは鍵が必要です）。',
    'backup.warn.deniedMifare':
      '{count}は鍵が合わず読めなかったため、内容が 0 になっています。自動読み取りでは、公開されている標準の鍵だけを試しました。登録した鍵で開くセクタは、タグを置いたまま「タグを読み取る」を押すと読めます（登録した鍵も試します）。',
    'backup.reread.title': '置かれているタグをバックアップ元にしますか？',
    'backup.reread.body': 'いま置かれているのは、バックアップ元（{src}）とは別のタグ（{uid}）です。読み取ると、バックアップ元が {uid} に置き換わります。',
    'backup.reread.detail': '{uid} に書き込むときは、ここではなく下の「書き込み先のタグを読み取る」を押してください。',
    'backup.reread.ok': 'バックアップ元にする',

    // --- Save to file ---
    'backup.save.title': 'ファイルに保存（バックアップ）',
    'backup.save.body': '開いている文書の内容をファイルに保存します。タグには何も書き込みません。鍵とパスワードはファイルに入れません（00 にして保存します）。',
    'backup.save.keyBNote': 'MIFARE Classic で鍵 B を読める設定のセクタでは、鍵 B は鍵として使われない、ただのデータです。そのため、そのまま保存します。',
    'backup.save.dirtyTitle': '未書き込みの変更があります（{count}）',
    'backup.save.dirtyBody': '開いている文書には、まだタグに書き込んでいない変更があります。どちらの内容を保存するか選んでください。',
    'backup.save.choice': '保存する内容',
    'backup.save.choice.originalCard': '読み取ったときの内容（タグと同じ）',
    'backup.save.choice.originalFile': '開いたときの内容（ファイルと同じ）',
    'backup.save.choice.originalNew': '作ったときの内容',
    'backup.save.choice.image': '編集後の内容（未書き込みの変更を含む）',
    'backup.save.deniedFormats': 'ダンプ（.nfcdump）には「読めなかった」ことも記録されます。.bin と Flipper 形式には記録されません。',
    'backup.save.note': 'メモ（任意）',
    'backup.save.noteHint': 'ダンプ（.nfcdump）に保存されます。.bin と Flipper 形式には残りません。',
    'backup.save.notePlaceholder': '例：総務課 入室用タグ 原本',
    'backup.save.project': 'ダンプ（.nfcdump）',
    'backup.save.projectDesc': 'このアプリ専用。種類・読めなかったページ・メモ・保存日時も残せます（おすすめ）。',
    'backup.save.bin': 'バイナリ（.bin）',
    'backup.save.binDesc': 'メモリ全体をそのまま並べた生データです。ほかのツールで使うときに選びます。',
    'backup.save.flipper': 'Flipper（.nfc）',
    'backup.save.flipperDesc': 'Flipper Zero で読めるテキスト形式です。',
    'backup.save.button': 'この形式で保存',
    'backup.saved': 'ファイルに保存しました',
    'backup.savedAs': '保存先: {name}（{when}）',
    'backup.savedChanged': '保存した後に、開いている文書が変わっています。',
    'backup.savedRedacted': '{count}にあった鍵・パスワードは、00 にして保存しました（開いている文書はそのままです）。',
    'backup.reveal': 'フォルダを開く',

    // --- Open ---
    'backup.opened': 'ファイルを開きました',
    'backup.openedNote': '{name}（メモ: {note}）',
    'backup.openFailed': 'ファイルを開けませんでした',
    'backup.open.busy': 'ほかの読み取り・書き込みが終わるまで、ファイルは開けません。終わってから、もう一度開いてください。',
    'backup.openFailed.format':
      'このアプリのダンプ（.nfcdump）・バイナリ（.bin）・Flipper（.nfc）のどれでもありません。保存したバックアップのファイルを選んでください。',
    'backup.openFailed.broken': 'ファイルが壊れているか、内容がタグの種類と合いません。別のファイルを選んでください。',

    // --- Write to a tag (restore / duplicate) ---
    'backup.write.title': 'タグに書き込む（復元・複製）',
    'backup.write.body':
      'バックアップ元の内容を、リーダーの上のタグに書き込みます。同じタグ（UID が同じ）なら元の内容に戻し（復元）、別のタグならデータ領域を複製します。',
    'backup.write.howto':
      '別のタグへ複製するときは、元のタグをリーダーから離し、書き込むタグを置いてから「書き込み先のタグを読み取る」を押してください。同じタグに戻すときは、そのタグを置いて読み取ります。',
    'backup.dup.excludedNote': 'UID・製造ブロック・設定・ロック・セクタトレーラは書き込みません。',
    'backup.target.read': '書き込み先のタグを読み取る',
    'backup.target.reread': '書き込み先を読み取り直す',
    'backup.target.none': '書き込み先のタグを、まだ読み取っていません。',
    'backup.target.label': '書き込み先',
    'backup.target.readAt': '読み取った時刻',
    'backup.target.mode': '書き込み方',
    'backup.target.readOk': '書き込み先のタグを読み取りました',
    'backup.mode.restore': '復元（同じタグに戻す）',
    'backup.mode.duplicate': '複製（別のタグへ。UID は複製されません）',
    'backup.target.stale': '読み取った書き込み先（{uid}）は、いまリーダーの上にありません。書き込むタグを置いて、読み取り直してください。',
    'backup.target.changed': '書き込み先のタグが替わりました（{uid}）。内容を確かめてから、もう一度押してください。',
    'backup.target.kindMismatch': 'バックアップ元（{src}）と書き込み先（{dst}）の種類が違います。同じ種類のタグを使ってください。',
    'backup.plan.changed': '書き換えるのは {count} です（データ領域 {total} のうち）。',
    'backup.plan.same': '書き込み先は、すでにバックアップ元と同じ内容です。書き込む必要はありません。',
    'backup.plan.sourceUnread': 'バックアップ元の {count} は読めていないため、書き込みません。',
    'backup.plan.targetUnread':
      '書き込み先の {count} は保護されていて読めないため、書き込みません。MIFARE Classic なら「MIFARE 鍵」に鍵を登録してから読み取り直してください。',
    'backup.plan.dirty': '未書き込みの変更（{count}）を含む、開いている文書の内容を書き込みます。',
    'backup.restore.button': 'このタグに戻す',
    'backup.dup.button': 'このタグに複製する',
    'backup.restore.confirmTitle': 'タグをバックアップの内容に戻しますか？',
    'backup.restore.confirmBody': 'タグ {uid} のデータ領域を、{src} の内容に戻します。UID は変わりません。',
    'backup.dup.confirmTitle': 'データ領域を別のタグへ複製しますか？',
    'backup.dup.confirmBody': '{src} のデータ領域を、別のタグ {uid} に書き込みます。UID は複製されません（{uid} のまま）。',
    'backup.restore.done': 'タグをバックアップの内容に戻しました',
    'backup.dup.done': 'データ領域を複製しました',
    'backup.write.detailCount': '書き換える量: {count}',
    'backup.write.detailUnchanged': '同じ内容のため書き込まない: {count}',
    'backup.why.noTarget': '先に「書き込み先のタグを読み取る」を押してください。',
    'backup.why.stale': '読み取った書き込み先が、リーダーの上にありません。',
    'backup.why.kind': '種類の違うタグには書き込めません。',
    'backup.why.same': '書き込む変更はありません。',

    // --- Many tags ---
    'backup.many.title': '複数のタグへ続けて複製',
    'backup.many.body': '同じデータを何枚ものタグへ続けて書き込むときは、一括発行の「複製」を使います。バックアップ元のタグには書き込みません。',
    'backup.many.button': '一括発行で複製する',

    // --- MIFARE keys view ---
    'keys.title': 'MIFARE 鍵',
    'keys.subtitle': 'MIFARE Classic のセクタを開くための鍵を登録・管理します',
    'keys.explainTitle': '鍵は運用者が管理します',
    'keys.explainBody':
      'MIFARE Classic のセクタは、運用者が持っている鍵でのみ開きます。このアプリは、鍵の解析・総当たり・辞書攻撃をしません。登録できるのは、運用者が管理している鍵と、公開されている標準鍵だけです。',
    'keys.maskedNote': '登録済みの鍵の値は画面に表示しません（伏字）。',
    'keys.autoReadNote':
      'タグを置いたときの自動読み取りでは、公開されている標準鍵だけを試します。ここで登録した鍵は、「タグを読み取る」「登録した鍵で読み取る」などのボタンを押して読み取るときに試します。',

    'keys.list.title': '登録済みの鍵',
    'keys.col.label': '名前',
    'keys.col.value': '鍵（伏字）',
    'keys.col.type': '種別',
    'keys.col.actions': '操作',
    'keys.builtin': '標準鍵',
    'keys.builtinTitle': '公開されている標準鍵（削除できません）',
    'keys.custom': '登録鍵',
    'keys.remove': '削除',
    'keys.removeConfirmTitle': '鍵を削除しますか？',
    'keys.removeConfirmBody': '「{label}」を登録から削除します。',
    'keys.removed': '鍵を削除しました',

    'keys.add.title': '鍵を追加',
    'keys.add.label': '名前',
    'keys.add.labelPlaceholder': '例：入室用タグ 共通鍵 A',
    'keys.add.key': '鍵の値（16 進 12 桁）',
    'keys.add.keyPlaceholder': 'FFFFFFFFFFFF',
    'keys.add.keyHint': 'MIFARE Classic の鍵は 6 バイト（16 進 12 桁）です。登録した後は、値を表示しません。',
    'keys.add.button': '鍵を追加',
    'keys.added': '鍵を追加しました',
    'keys.err.empty': '鍵の値を入力してください。',
    'keys.err.hex': '16 進数（0〜9・A〜F）で入力してください。',
    'keys.err.length': '鍵は 16 進 12 桁（6 バイト）で入力してください。',
    'keys.err.label': '名前を入力してください。',
  },
  en: {
    // --- Backup / restore / duplicate view ---
    'backup.title': 'Backup & duplicate',
    'backup.subtitle': 'Save a tag to a file, put it back on the same tag, or copy it to another tag',

    'backup.uidReadonlyTitle': 'The UID cannot be duplicated',
    'backup.uidReadonlyBody':
      "A tag's UID (serial number) is fixed at manufacture and read-only. This app never changes a UID. Only the writable data area is copied, so the target tag keeps its own UID.",

    'backup.n.pages': '{n} page(s)',
    'backup.n.blocks': '{n} block(s)',
    'backup.placeHint': 'Place the tag on the reader and keep it there until it finishes (a quick tap, like at a ticket gate, is not enough).',

    'backup.noDoc.title': 'No backup source yet',
    'backup.noDoc.body':
      'Place the tag to save, restore or copy from on the reader and read it, or open a saved file (.nfcdump / .bin / .nfc).',
    'backup.read': 'Read tag',
    'backup.open.button': 'Open file',

    // --- Source (the open document) ---
    'backup.source.title': 'Backup source (copy from)',
    'backup.source.origin': 'Source',
    'backup.source.fromCard': 'Tag {uid} (read at {when})',
    'backup.source.fromFile': 'File {name}',
    'backup.source.fromNew': 'New document',
    'backup.source.note': 'Note',
    'backup.source.savedAt': 'Saved at',
    'backup.source.dirty': 'Unsaved changes',
    'backup.source.dirtyValue': '{count} (not yet written to a tag or saved to a file)',
    'backup.warn.error': '{count} were cut off while reading and hold zeros. Keep the tag on the reader and read it again.',
    'backup.warn.denied': '{count} are protected and could not be read, so they hold zeros (a password or key is required).',
    'backup.warn.deniedMifare':
      '{count} could not be read with the keys tried, so they hold zeros. The automatic read tried only the public standard keys. Sectors that open with a registered key can be read by keeping the tag on the reader and pressing "Read tag" (it tries the registered keys too).',
    'backup.reread.title': 'Use the tag on the reader as the backup source?',
    'backup.reread.body': 'The tag on the reader ({uid}) is not the backup source ({src}). Reading it replaces the backup source with {uid}.',
    'backup.reread.detail': 'To write to {uid}, press "Read the tag to write" below instead.',
    'backup.reread.ok': 'Use as backup source',

    // --- Save to file ---
    'backup.save.title': 'Save to a file (backup)',
    'backup.save.body': 'Save the open document to a file. Nothing is written to a tag. Keys and passwords are not put in the file (they are saved as 00).',
    'backup.save.keyBNote':
      'MIFARE Classic: in sectors set so that key B can be read, key B cannot be used as a key. It is plain data and is saved as it is.',
    'backup.save.dirtyTitle': 'There are unsaved changes ({count})',
    'backup.save.dirtyBody': 'The open document has changes not yet written to the tag. Choose which contents to save.',
    'backup.save.choice': 'Contents to save',
    'backup.save.choice.originalCard': 'As read (same as the tag)',
    'backup.save.choice.originalFile': 'As opened (same as the file)',
    'backup.save.choice.originalNew': 'As created',
    'backup.save.choice.image': 'As edited (incl. unsaved changes)',
    'backup.save.deniedFormats': 'A dump (.nfcdump) also records what could not be read; .bin and Flipper files do not.',
    'backup.save.note': 'Note (optional)',
    'backup.save.noteHint': 'Stored in a dump (.nfcdump). Not kept in .bin or Flipper files.',
    'backup.save.notePlaceholder': 'e.g. Admin office entry tag, master',
    'backup.save.project': 'Dump (.nfcdump)',
    'backup.save.projectDesc': 'This app only. Keeps the kind, unreadable pages, the note and the save time (suggested).',
    'backup.save.bin': 'Binary (.bin)',
    'backup.save.binDesc': 'Raw memory image. For sharing with other tools.',
    'backup.save.flipper': 'Flipper (.nfc)',
    'backup.save.flipperDesc': 'Flipper Zero text format.',
    'backup.save.button': 'Save in this format',
    'backup.saved': 'Saved to a file',
    'backup.savedAs': 'Saved as: {name} ({when})',
    'backup.savedChanged': 'The open document has changed since it was saved.',
    'backup.savedRedacted': 'The keys and passwords in {count} were saved as 00 (the open document is unchanged).',
    'backup.reveal': 'Show in folder',

    // --- Open ---
    'backup.opened': 'File opened',
    'backup.openedNote': '{name} (note: {note})',
    'backup.openFailed': 'Could not open the file',
    'backup.open.busy': 'A file cannot be opened until the current read or write finishes. Open it again afterwards.',
    'backup.openFailed.format': 'It is not a dump of this app (.nfcdump), a binary (.bin) or a Flipper file (.nfc). Choose a saved backup file.',
    'backup.openFailed.broken': 'The file is damaged or does not match a tag type. Choose another file.',

    // --- Write to a tag (restore / duplicate) ---
    'backup.write.title': 'Write to a tag (restore / duplicate)',
    'backup.write.body':
      'Write the backup source to the tag on the reader. The same tag (same UID) is put back to the backup contents (restore); another tag receives a copy of the data area.',
    'backup.write.howto':
      'To copy to another tag, take the original tag off the reader, place the tag to write, then press "Read the tag to write". To restore the same tag, place that tag and read it.',
    'backup.dup.excludedNote': 'The UID, manufacturer block, config, lock and sector trailers are never written.',
    'backup.target.read': 'Read the tag to write',
    'backup.target.reread': 'Read the tag to write again',
    'backup.target.none': 'The tag to write has not been read yet.',
    'backup.target.label': 'Tag to write',
    'backup.target.readAt': 'Read at',
    'backup.target.mode': 'Mode',
    'backup.target.readOk': 'The tag to write was read',
    'backup.mode.restore': 'Restore (put the same tag back)',
    'backup.mode.duplicate': 'Duplicate (another tag; the UID is not copied)',
    'backup.target.stale': 'The tag read as the target ({uid}) is no longer on the reader. Place the tag to write and read it again.',
    'backup.target.changed': 'The tag to write changed ({uid}). Check the details, then press again.',
    'backup.target.kindMismatch': 'The backup source ({src}) and the tag to write ({dst}) are different kinds. Use tags of the same kind.',
    'backup.plan.changed': '{count} change (of {total} in the data area).',
    'backup.plan.same': 'The tag to write already holds the same contents as the backup source. Nothing needs writing.',
    'backup.plan.sourceUnread': '{count} of the backup source were not read and are not written.',
    'backup.plan.targetUnread':
      '{count} of the tag to write are protected and could not be read, so they are not written. For MIFARE Classic, register the key under "MIFARE keys" and read the tag again.',
    'backup.plan.dirty': 'The open document is written including its unsaved changes ({count}).',
    'backup.restore.button': 'Restore this tag',
    'backup.dup.button': 'Copy to this tag',
    'backup.restore.confirmTitle': 'Restore the tag from the backup',
    'backup.restore.confirmBody': 'The data area of tag {uid} is put back to the contents of {src}. The UID does not change.',
    'backup.dup.confirmTitle': 'Copy the data area to another tag',
    'backup.dup.confirmBody': 'The data area of {src} is written to another tag, {uid}. The UID is not copied ({uid} stays).',
    'backup.restore.done': 'The tag was restored from the backup',
    'backup.dup.done': 'Data area copied',
    'backup.write.detailCount': 'To write: {count}',
    'backup.write.detailUnchanged': 'Already the same (not written): {count}',
    'backup.why.noTarget': 'First press "Read the tag to write".',
    'backup.why.stale': 'The tag read as the target is not on the reader.',
    'backup.why.kind': 'A tag of a different kind cannot be written.',
    'backup.why.same': 'There is nothing to write.',

    // --- Many tags ---
    'backup.many.title': 'Copy to many tags in a row',
    'backup.many.body': 'To write the same data to many tags in a row, use "Duplicate" in batch issue. The backup source tag itself is not written.',
    'backup.many.button': 'Duplicate with batch issue',

    // --- MIFARE keys view ---
    'keys.title': 'MIFARE keys',
    'keys.subtitle': 'Register and manage the keys that open MIFARE Classic sectors',
    'keys.explainTitle': 'Keys are managed by the operator',
    'keys.explainBody':
      'MIFARE Classic sectors open only with keys the operator holds. This app does not recover, brute-force or dictionary-attack keys. You may register only keys you manage, plus the public standard keys.',
    'keys.maskedNote': 'The value of a registered key is never shown (masked).',
    'keys.autoReadNote':
      'Automatic reading (when a tag is placed) tries only the public standard keys. The keys you register here are tried when you read with a button such as "Read tag" or "Read with registered keys".',

    'keys.list.title': 'Registered keys',
    'keys.col.label': 'Name',
    'keys.col.value': 'Key (masked)',
    'keys.col.type': 'Type',
    'keys.col.actions': 'Actions',
    'keys.builtin': 'Standard',
    'keys.builtinTitle': 'Public standard key (cannot be removed)',
    'keys.custom': 'Registered',
    'keys.remove': 'Remove',
    'keys.removeConfirmTitle': 'Remove key',
    'keys.removeConfirmBody': 'Remove "{label}". Are you sure?',
    'keys.removed': 'Key removed',

    'keys.add.title': 'Add a key',
    'keys.add.label': 'Name',
    'keys.add.labelPlaceholder': 'e.g. Entry tags, common key A',
    'keys.add.key': 'Key value (12 hex digits)',
    'keys.add.keyPlaceholder': 'FFFFFFFFFFFF',
    'keys.add.keyHint': 'A MIFARE Classic key is 6 bytes (12 hex digits). The value is not shown after it is added.',
    'keys.add.button': 'Add key',
    'keys.added': 'Key added',
    'keys.err.empty': 'Enter the key value.',
    'keys.err.hex': 'Use hexadecimal (0-9, A-F).',
    'keys.err.length': 'A key is 12 hex digits (6 bytes).',
    'keys.err.label': 'Enter a name.',
  },
});
