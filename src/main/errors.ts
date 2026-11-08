// Operation errors raised in main. CONTRACT FILE - frozen (integrator-owned).
// Throw `new OpError(code, detail?)`; the IPC layer turns it into an Envelope with
// a localized message (ja/en per settings). Never put secrets (keys, passwords)
// into `detail`.

import type { AppErrorPayload, ErrorCode, LanguageSetting } from '@shared/types';

export class OpError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'OpError';
    this.code = code;
    this.detail = detail;
  }
}

const MESSAGES: Record<ErrorCode, { ja: string; en: string }> = {
  NO_SERVICE: {
    ja: 'スマートカードサービス（PC/SC）が利用できません。Windows の「Smart Card」サービスが動いているか確認してください。',
    en: 'The smart card service (PC/SC) is not available. Check that the Windows "Smart Card" service is running.',
  },
  NO_READER: { ja: 'NFC リーダーが見つかりません。リーダーを接続してください。', en: 'No NFC reader found. Connect a reader.' },
  NO_CARD: { ja: 'タグがリーダーに置かれていません。', en: 'No tag on the reader.' },
  CARD_REMOVED: { ja: '処理中にタグが離れました。タグを置いたまま、もう一度実行してください。', en: 'The tag was removed during the operation. Keep it on the reader and try again.' },
  UID_MISMATCH: {
    ja: '読み取ったときと別のタグが置かれています。書き込みを中止しました。',
    en: 'A different tag is on the reader than the one that was read. Writing was cancelled.',
  },
  UNSUPPORTED_TAG: { ja: 'このタグの種類には対応していません。', en: 'This tag type is not supported.' },
  AUTH_FAILED: { ja: '認証に失敗しました。パスワードまたは鍵を確認してください。', en: 'Authentication failed. Check the password or key.' },
  ACCESS_DENIED: { ja: 'この領域へのアクセスは許可されていません。', en: 'Access to this area is not permitted.' },
  PROTECTED_UNIT: {
    ja: '保護された領域（ロック・設定・鍵）への書き込みは、確認のうえ「保護領域の書き込みを許可」した場合だけ行えます。',
    en: 'Protected areas (lock, config, keys) can only be written after explicit confirmation.',
  },
  INVALID_ACCESS_BITS: {
    ja: 'アクセス条件のビットが不正です。このまま書くとセクタが永久に使えなくなるため中止しました。',
    en: 'Invalid access bits. Writing them would permanently lock the sector, so it was cancelled.',
  },
  READ_FAILED: { ja: '読み取りに失敗しました。', en: 'Read failed.' },
  WRITE_FAILED: { ja: '書き込みに失敗しました。', en: 'Write failed.' },
  VERIFY_FAILED: { ja: '書き込み後の照合で内容が一致しませんでした。', en: 'Verification after writing failed (data mismatch).' },
  BUSY: { ja: '別の処理を実行中です。終わるまでお待ちください。', en: 'Another operation is in progress.' },
  INVALID_INPUT: { ja: '入力内容が正しくありません。', en: 'Invalid input.' },
  FILE_ERROR: { ja: 'ファイルの読み書きに失敗しました。', en: 'File operation failed.' },
  CANCELLED: { ja: '中止しました。', en: 'Cancelled.' },
  INTERNAL: { ja: '予期しないエラーが発生しました。', en: 'An unexpected error occurred.' },
};

export function errorMessage(code: ErrorCode, lang: LanguageSetting): string {
  return MESSAGES[code][lang];
}

/** Convert anything thrown into a user-facing payload. */
export function toErrorPayload(err: unknown, lang: LanguageSetting): AppErrorPayload {
  if (err instanceof OpError) {
    return { code: err.code, message: errorMessage(err.code, lang), detail: err.detail };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message: errorMessage('INTERNAL', lang), detail };
}
