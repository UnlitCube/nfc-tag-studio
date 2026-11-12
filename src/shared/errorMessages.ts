// User-facing error messages by ErrorCode (ja/en). Shared by main (IPC envelopes)
// and the renderer (per-unit write failures, issue results). CONTRACT FILE.
//
// Rule (2026-11-12 UX audit FIRST-9/11): every message says what happened AND
// what to do next, in plain words for a first-time user.

import type { ErrorCode, LanguageSetting } from './types';

export const ERROR_MESSAGES: Record<ErrorCode, { ja: string; en: string }> = {
  NO_SERVICE: {
    ja: 'スマートカード サービス（PC/SC）に接続できません。NFC リーダーが USB に接続されているか確かめてください（Windows はリーダーを接続したときにこのサービスを起動します）。',
    en: 'Cannot reach the smart card service (PC/SC). Check that the NFC reader is connected by USB (Windows starts this service when a reader is connected).',
  },
  NO_READER: {
    ja: 'NFC リーダーが見つかりません。リーダーを USB に接続してください。接続しているのに出ないときは、いったん抜いて挿し直してください。',
    en: 'No NFC reader found. Connect a reader by USB. If it is connected but not listed, unplug it and plug it back in.',
  },
  NO_CARD: {
    ja: 'リーダーの上にタグがありません。タグをリーダーの上に置いたまま、もう一度実行してください。',
    en: 'There is no tag on the reader. Place the tag on the reader, keep it there, and try again.',
  },
  CARD_REMOVED: {
    ja: '処理の途中でタグが離れました。タグをリーダーの上に置いたまま、もう一度実行してください。',
    en: 'The tag left the reader during the operation. Keep the tag on the reader and try again.',
  },
  UID_MISMATCH: {
    ja: '読み取ったタグと別のタグが置かれているため、書き込みを中止しました。読み取ったタグに置き替えるか、いまのタグを読み取り直してください。',
    en: 'A different tag than the one that was read is on the reader, so writing was cancelled. Put the original tag back, or read the current tag first.',
  },
  UNSUPPORTED_TAG: {
    ja: 'このタグの種類には対応していません（対応しているのは NTAG213/215/216・MIFARE Classic 1K/4K・FeliCa Lite-S です）。',
    en: 'This tag type is not supported (supported: NTAG213/215/216, MIFARE Classic 1K/4K, FeliCa Lite-S).',
  },
  AUTH_FAILED: {
    ja: '認証に失敗しました。パスワードまたは鍵が正しいか確かめてください。',
    en: 'Authentication failed. Check that the password or key is correct.',
  },
  ACCESS_DENIED: {
    ja: 'この領域は保護されているため読み書きできません。パスワードまたは鍵が必要です。',
    en: 'This area is protected and cannot be read or written. A password or key is required.',
  },
  PROTECTED_UNIT: {
    ja: '保護された領域（ロック・設定・鍵）は、上級者モードで「保護領域も編集して書き込む」をオンにしたときだけ書き込めます（UID は書き換えられません）。',
    en: 'Protected areas (lock, configuration, keys) can be written only in advanced mode with "Edit and write protected areas too" turned on (the UID can never be changed).',
  },
  INVALID_ACCESS_BITS: {
    ja: 'アクセス条件のビットが不正です。このまま書くとセクタが永久に使えなくなるため中止しました。',
    en: 'Invalid access bits. Writing them would permanently lock the sector, so it was cancelled.',
  },
  READ_FAILED: {
    ja: '読み取りに失敗しました。タグをリーダーの中央に置き直して、もう一度実行してください。',
    en: 'Reading failed. Re-place the tag in the centre of the reader and try again.',
  },
  WRITE_FAILED: {
    ja: '書き込みに失敗しました。タグをリーダーの中央に置き直して、もう一度実行してください。',
    en: 'Writing failed. Re-place the tag in the centre of the reader and try again.',
  },
  VERIFY_FAILED: {
    ja: '書き込んだ後に読み直した内容が一致しませんでした。ロック済みの領域か、タグの置き方が不安定な可能性があります。',
    en: 'The data read back after writing did not match. The area may be locked, or the tag may not be sitting steadily on the reader.',
  },
  BUSY: {
    ja: '別の処理（一括発行など）を実行中です。終わってから、もう一度実行してください。',
    en: 'Another operation (such as batch issuing) is running. Try again when it has finished.',
  },
  INVALID_INPUT: { ja: '入力内容が正しくありません。', en: 'Invalid input.' },
  FILE_ERROR: {
    ja: 'ファイルを読み書きできませんでした。別の場所や名前で試してください。',
    en: 'The file could not be read or written. Try another location or name.',
  },
  CANCELLED: { ja: '中止しました。', en: 'Cancelled.' },
  INTERNAL: {
    ja: '予期しないエラーが発生しました。もう一度実行してください。続くときはアプリを再起動してください。',
    en: 'An unexpected error occurred. Try again; if it keeps happening, restart the app.',
  },
  READER_IN_USE: {
    ja: '別のアプリがリーダーを使用中です。NFC を使うほかのアプリ（スマートカードリーダーの常駐ソフトなど）を閉じてから、もう一度実行してください。',
    en: 'Another application is using the reader. Close other NFC applications (such as card reader utilities) and try again.',
  },
  CARD_UNRESPONSIVE: {
    ja: 'タグが応答しません。タグをリーダーの中央に置き直してください（金属の上や、2 枚重ねでは読めないことがあります）。',
    en: 'The tag does not respond. Re-place it in the centre of the reader (it may not read on metal or when two tags overlap).',
  },
  KIND_MISMATCH: {
    ja: '置かれているタグの種類が、書き込む内容の種類と違います。同じ種類のタグを置いてください。',
    en: 'The tag on the reader is a different type than the data being written. Place a tag of the same type.',
  },
  ADVANCED_REQUIRED: {
    ja: 'この操作は上級者モードでだけ使えます。設定で上級者モードをオンにしてください。',
    en: 'This operation is available only in advanced mode. Turn on advanced mode in Settings.',
  },
  READER_NO_AUTH: {
    ja: 'このリーダー（Sony PaSoRi などのストレージ方式）ではパスワード認証ができません。パスワードで保護したタグの読み書きには、ACR122U などのリーダーが必要です。',
    en: 'This reader (a storage-only reader such as Sony PaSoRi) cannot authenticate with a password. Reading or writing password-protected tags needs a reader such as the ACR122U.',
  },
  FORBIDDEN_UNIT: {
    ja: 'UID と製造ブロックは書き換えられません（タグの製造時に決まる読み取り専用の領域です）。',
    en: 'The UID and the manufacturer block cannot be changed (they are read-only, fixed at manufacture).',
  },
};

export function errorMessage(code: ErrorCode, lang: LanguageSetting): string {
  return (ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL)[lang];
}
