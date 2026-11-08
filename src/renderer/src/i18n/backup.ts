// Dictionary for feature "backup". Owner: agent renderer-backup (backup/duplicate + MIFARE keys views).
// Keys must start with "backup." or "keys." and be added to BOTH ja and en (compile-checked).
import { defineMessages } from './define';

export default defineMessages({
  ja: {
    // --- Backup / duplicate view ---
    'backup.title': 'バックアップ・複製',
    'backup.subtitle': 'タグをファイルに保存し、別のタグへデータ領域を複製します',

    // The read-only-UID message is shown permanently in the UI (invariant I1/I2).
    'backup.uidReadonlyTitle': 'UID は複製できません',
    'backup.uidReadonlyBody':
      'タグの UID（製造番号）は製造時に固定された読み取り専用の値です。このアプリは UID を書き換えません。複製するのは書き込み可能なデータ領域だけで、複製先のタグは元の UID のままになります。',

    'backup.noDoc.title': 'まだタグを読み込んでいません',
    'backup.noDoc.body': 'リーダーにタグを置いて読み取るか、保存済みのダンプファイルを開いてください。',
    'backup.read': 'タグを読み取る',

    'backup.source.title': '対象',
    'backup.source.origin': '読み込み元',
    'backup.source.fromCard': 'リーダーのタグ',
    'backup.source.fromFile': 'ファイル：{name}',
    'backup.source.fromNew': '新規イメージ',
    'backup.source.reread': '読み直す',

    // --- Save to file ---
    'backup.save.title': 'ファイルに保存（バックアップ）',
    'backup.save.body': '読み取ったタグの内容をファイルに書き出します。鍵やパスワードは保存しません。',
    'backup.save.note': 'メモ（任意）',
    'backup.save.notePlaceholder': '例：総務課 入室カード 原本',
    'backup.save.project': 'ダンプ（.nfcdump）',
    'backup.save.projectDesc': 'このアプリ専用。種類・状態・メモも残せます（推奨）。',
    'backup.save.bin': 'バイナリ（.bin）',
    'backup.save.binDesc': 'メモリ全体をそのまま並べた生データ。他ツールと共有向け。',
    'backup.save.flipper': 'Flipper（.nfc）',
    'backup.save.flipperDesc': 'Flipper Zero 形式のテキスト。',
    'backup.saved': '保存しました',
    'backup.reveal': '保存先を開く',

    // --- Open / restore ---
    'backup.open.title': 'ファイルを開く（復元・複製元）',
    'backup.open.body': 'ダンプファイル（.nfcdump / .bin / .nfc）を読み込み、保存や複製の元にします。',
    'backup.open.button': 'ファイルを開く',
    'backup.opened': 'ファイルを読み込みました',

    // --- Duplicate ---
    'backup.dup.title': '別のタグへ複製（データ領域だけ）',
    'backup.dup.body': '複製先のタグをリーダーに置いて読み取り、元タグのデータ領域だけを書き込みます。',
    'backup.dup.readTarget': '複製先のタグを読み取る',
    'backup.dup.rereadTarget': '複製先を読み直す',
    'backup.dup.target': '複製先',
    'backup.dup.noTarget': '複製先のタグがまだ読み取られていません。',
    'backup.dup.kindMismatch': '複製元（{src}）と複製先（{dst}）の種類が違います。同じ種類のタグを使ってください。',
    'backup.dup.sameUid': '複製元と複製先が同じタグです。別のタグを置いてください。',
    'backup.dup.willWrite': 'データ領域 {units} 単位（{bytes} バイト）を書き込みます。',
    'backup.dup.changed': 'このうち {changed} 単位が複製先と異なります。',
    'backup.dup.unread': '複製元の {count} 単位は読めていないため複製から除外します（鍵・パスワードが必要な領域）。',
    'backup.dup.excludedNote': 'UID・製造ブロック・設定・ロック・セクタトレーラは複製しません。',
    'backup.dup.write': 'データ領域を書き込む',
    'backup.dup.confirmTitle': 'データ領域を複製します',
    'backup.dup.confirmBody': '複製先のタグ（UID {uid}）にデータ領域だけを書き込みます。UID は変わりません。',
    'backup.dup.detailUnits': 'データ {units} 単位を書き込み',
    'backup.dup.detailUid': 'UID は複製されません（{uid} のまま）',
    'backup.dup.done': 'データ領域を複製しました',
    'backup.dup.many': '複数のタグへ連続複製',
    'backup.dup.manyBody': '同じデータを何枚ものタグへ続けて書き込むときは、発行画面の複製テンプレートを使います。',

    // --- MIFARE keys view ---
    'keys.title': 'MIFARE 鍵',
    'keys.subtitle': 'MIFARE Classic のセクタを開くための鍵を登録・管理します',
    'keys.explainTitle': '鍵は運用者が管理します',
    'keys.explainBody':
      'MIFARE Classic のセクタは、運用者が持っている鍵でのみ開きます。本アプリは鍵の解析・総当たり・辞書攻撃をしません。ここに登録できるのは、あなたが管理している鍵と、公開されている標準鍵だけです。',
    'keys.maskedNote': '登録済みの鍵の値は画面に表示しません（伏字）。',

    'keys.list.title': '登録済みの鍵',
    'keys.col.label': '名前',
    'keys.col.value': '鍵（伏字）',
    'keys.col.type': '種別',
    'keys.col.actions': '操作',
    'keys.builtin': '標準鍵',
    'keys.builtinTitle': '公開されている標準鍵（削除できません）',
    'keys.custom': '登録鍵',
    'keys.remove': '削除',
    'keys.removeConfirmTitle': '鍵を削除します',
    'keys.removeConfirmBody': '「{label}」を削除します。よろしいですか？',
    'keys.removed': '鍵を削除しました',

    'keys.add.title': '鍵を追加',
    'keys.add.label': '名前',
    'keys.add.labelPlaceholder': '例：入室カード 共通鍵 A',
    'keys.add.key': '鍵の値（16進数 12 桁）',
    'keys.add.keyPlaceholder': 'FFFFFFFFFFFF',
    'keys.add.keyHint': 'MIFARE Classic の鍵は 6 バイト（16進数 12 桁）です。登録後は値を表示しません。',
    'keys.add.button': '鍵を追加',
    'keys.added': '鍵を追加しました',
    'keys.err.empty': '鍵の値を入力してください。',
    'keys.err.hex': '16進数（0-9・A-F）で入力してください。',
    'keys.err.length': '鍵は 16進数 12 桁（6 バイト）です。',
    'keys.err.label': '名前を入力してください。',
  },
  en: {
    // --- Backup / duplicate view ---
    'backup.title': 'Backup & duplicate',
    'backup.subtitle': 'Save a tag to a file and copy its data area to another tag',

    'backup.uidReadonlyTitle': 'The UID cannot be duplicated',
    'backup.uidReadonlyBody':
      "A tag's UID (serial number) is fixed at manufacture and read-only. This app never changes a UID. Only the writable data area is copied, so the target tag keeps its own UID.",

    'backup.noDoc.title': 'No tag loaded yet',
    'backup.noDoc.body': 'Place a tag on the reader and read it, or open a saved dump file.',
    'backup.read': 'Read tag',

    'backup.source.title': 'Working copy',
    'backup.source.origin': 'Source',
    'backup.source.fromCard': 'Tag on the reader',
    'backup.source.fromFile': 'File: {name}',
    'backup.source.fromNew': 'New image',
    'backup.source.reread': 'Re-read',

    // --- Save to file ---
    'backup.save.title': 'Save to a file (backup)',
    'backup.save.body': 'Write the tag contents to a file. Keys and passwords are never saved.',
    'backup.save.note': 'Note (optional)',
    'backup.save.notePlaceholder': 'e.g. Admin office entry card, master',
    'backup.save.project': 'Dump (.nfcdump)',
    'backup.save.projectDesc': 'This app only. Keeps the kind, status and note (recommended).',
    'backup.save.bin': 'Binary (.bin)',
    'backup.save.binDesc': 'Raw memory image. For sharing with other tools.',
    'backup.save.flipper': 'Flipper (.nfc)',
    'backup.save.flipperDesc': 'Flipper Zero text format.',
    'backup.saved': 'Saved',
    'backup.reveal': 'Show in folder',

    // --- Open / restore ---
    'backup.open.title': 'Open a file (restore / duplicate source)',
    'backup.open.body': 'Load a dump file (.nfcdump / .bin / .nfc) to save again or to duplicate from.',
    'backup.open.button': 'Open file',
    'backup.opened': 'File loaded',

    // --- Duplicate ---
    'backup.dup.title': 'Duplicate to another tag (data area only)',
    'backup.dup.body': 'Place the target tag on the reader, read it, and write only the source data area.',
    'backup.dup.readTarget': 'Read the target tag',
    'backup.dup.rereadTarget': 'Re-read the target',
    'backup.dup.target': 'Target',
    'backup.dup.noTarget': 'No target tag has been read yet.',
    'backup.dup.kindMismatch': 'The source ({src}) and target ({dst}) are different kinds. Use tags of the same kind.',
    'backup.dup.sameUid': 'The source and target are the same tag. Place a different tag.',
    'backup.dup.willWrite': 'Writes {units} data units ({bytes} bytes).',
    'backup.dup.changed': '{changed} of them differ from the target.',
    'backup.dup.unread': '{count} source units could not be read and are excluded (key/password-protected area).',
    'backup.dup.excludedNote': 'The UID, manufacturer block, config, lock and sector trailers are never copied.',
    'backup.dup.write': 'Write the data area',
    'backup.dup.confirmTitle': 'Duplicate the data area',
    'backup.dup.confirmBody': 'Write only the data area to the target tag (UID {uid}). The UID stays the same.',
    'backup.dup.detailUnits': 'Write {units} data units',
    'backup.dup.detailUid': 'The UID is not copied (stays {uid})',
    'backup.dup.done': 'Data area duplicated',
    'backup.dup.many': 'Duplicate to many tags',
    'backup.dup.manyBody': 'To write the same data to many tags in a row, use the duplicate template on the Issue screen.',

    // --- MIFARE keys view ---
    'keys.title': 'MIFARE keys',
    'keys.subtitle': 'Register and manage the keys that open MIFARE Classic sectors',
    'keys.explainTitle': 'Keys are managed by the operator',
    'keys.explainBody':
      'MIFARE Classic sectors open only with keys the operator holds. This app does not recover, brute-force or dictionary-attack keys. You may register only keys you manage, plus the public standard keys.',
    'keys.maskedNote': 'The value of a registered key is never shown (masked).',

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
    'keys.add.labelPlaceholder': 'e.g. Entry card, common key A',
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
