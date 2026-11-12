// User-facing texts produced by the issue engine (ja/en). Owner: main-app.
//
// Rule (2026-11-12 UX audit ISSUE-9 / FIRST-9): every message says what happened
// AND what to do next, in plain words. No raw error codes, no English in the
// Japanese UI, no page/block lists ("単位" is never shown). Never include keys or
// passwords (I4).
import type { ErrorCode, LanguageSetting } from '@shared/types';
import { ERROR_MESSAGES, errorMessage } from '@shared/errorMessages';

type Text = { ja: string; en: string };

const T = {
  wrongKind: {
    ja: 'タグの種類が違うため、書き込みませんでした（置かれたタグ: {actual}／この発行: {expected}）。{expected} のタグを置いてください。',
    en: 'Not written: wrong tag type (placed: {actual}; this job: {expected}). Place a {expected} tag.',
  },
  unknownKind: {
    ja: 'このタグは対応していない種類のため、書き込みませんでした。{expected} のタグを置いてください。',
    en: 'Not written: this tag type is not supported. Place a {expected} tag.',
  },
  duplicate: {
    ja: 'このタグは発行台帳に「発行済み」として記録されています。二重発行を防ぐため書き込みませんでした。別のタグを置いてください。',
    en: 'This tag is recorded as already issued in the issue log, so it was not written again (prevents double issuing). Place another tag.',
  },
  notBlank: {
    ja: 'このタグには既にデータがあるため、書き込みませんでした（「空のタグにだけ書き込む」がオンです）。空のタグを置いてください。',
    en: 'Not written: this tag already holds data ("Only write blank tags" is on). Place a blank tag.',
  },
  source: {
    ja: 'これは複製元のタグです。複製元には書き込みません。複製先のタグを置いてください。',
    en: 'This is the source tag of the copy. It is never written. Place a destination tag.',
  },
  removedBeforeWrite: {
    ja: '書き込む前にタグが離れたため、何も書き込んでいません。もう一度リーダーの上に置き、終わるまで置いたままにしてください。',
    en: 'The tag left the reader before writing started, so nothing was written. Place it on the reader again and keep it there until it finishes.',
  },
  removedMidWrite: {
    ja: '書き込みの途中でタグが離れました。',
    en: 'The tag left the reader while it was being written.',
  },
  partialSeq: {
    ja: 'このタグは途中まで書き込まれています。同じタグをもう一度リーダーの上に置くと、同じ番号（No.{seq}）で書き直します。終わるまで置いたままにしてください。',
    en: 'This tag is only partly written. Place the SAME tag on the reader again to rewrite it with the same number (No.{seq}). Keep it there until it finishes.',
  },
  partialNoSeq: {
    ja: 'このタグは途中まで書き込まれています。同じタグをもう一度リーダーの上に置くと書き直します。終わるまで置いたままにしてください。',
    en: 'This tag is only partly written. Place the SAME tag on the reader again to rewrite it. Keep it there until it finishes.',
  },
  notWritten: {
    ja: 'このタグには書き込んでいません。',
    en: 'Nothing was written to this tag.',
  },
  voidedSeq: {
    ja: 'No.{seq} は欠番にしました。この番号は UID {uid} のタグに途中まで書き込まれています。そのタグは使わないでください。',
    en: 'No.{seq} was retired. It is partly written on the tag with UID {uid}. Do not use that tag.',
  },
  voidedNoSeq: {
    ja: 'UID {uid} のタグは途中まで書き込まれたままです。そのタグは使わないでください。',
    en: 'The tag with UID {uid} is left partly written. Do not use that tag.',
  },
  voidedRow: {
    ja: 'UID {uid} のタグには CSV の {row} 行目が途中まで書き込まれています。この行は次のタグに書き込み直します。UID {uid} のタグは使わないでください。',
    en: 'The tag with UID {uid} holds CSV row {row} only partly written. That row is written again to the next tag. Do not use the tag with UID {uid}.',
  },
  protectedArea: {
    ja: '書き込む内容が、タグの保護された領域（ロック・設定・鍵）か UID に重なっています。どのタグでも同じになるため、発行を止めました。データスキーマの開始位置や、複製する範囲を見直してください。',
    en: 'The data to write overlaps a protected area of the tag (lock / configuration / keys) or the UID. Every tag would fail the same way, so issuing was stopped. Review the start position in the data schema or the range being copied.',
  },
  fatalCode: {
    ja: '{detail} どのタグでも同じになるため、発行を止めました。',
    en: '{detail} Every tag would fail the same way, so issuing was stopped.',
  },
  badRow: {
    ja: 'CSV の {row} 行目は、タグに書き込める形にできませんでした（{detail}）。この行を飛ばして次の行へ進みます。',
    en: 'CSV row {row} could not be turned into tag data ({detail}). This row is skipped; continuing with the next row.',
  },
  badRowNoDetail: {
    ja: 'CSV の {row} 行目は、タグに書き込める形にできませんでした。この行を飛ばして次の行へ進みます。',
    en: 'CSV row {row} could not be turned into tag data. This row is skipped; continuing with the next row.',
  },
  badRowStreak: {
    ja: 'CSV の行が {n} 行続けて、タグに書き込める形にできませんでした。テンプレートと CSV の列が合っているか確かめてください。発行を止めました。',
    en: '{n} CSV rows in a row could not be turned into tag data. Check that the template matches the CSV columns. Issuing was stopped.',
  },
  badTemplate: {
    ja: '書き込む内容を作れませんでした（{detail}）。テンプレートの設定を確かめてください。発行を止めました。',
    en: 'The data to write could not be built ({detail}). Check the template settings. Issuing was stopped.',
  },
  badTemplateNoDetail: {
    ja: '書き込む内容を作れませんでした。テンプレートの設定を確かめてください。発行を止めました。',
    en: 'The data to write could not be built. Check the template settings. Issuing was stopped.',
  },
  badLayout: {
    ja: 'データの配置が、タグの保護された領域（ロック・設定）に重なっています。データスキーマの開始位置を見直してください。発行を止めました。',
    en: 'The data layout overlaps a protected area of the tag (lock / configuration). Review the start position in the data schema. Issuing was stopped.',
  },
  felicaNdef: {
    ja: 'FeliCa Lite-S には NDEF テンプレートで一括発行できません。データスキーマか複製を使ってください。発行を止めました。',
    en: 'FeliCa Lite-S cannot be issued with an NDEF template. Use a data schema or duplicate mode. Issuing was stopped.',
  },
  tagBuild: {
    ja: 'このタグには書き込める形にできませんでした（{detail}）。このタグには書き込んでいません。別のタグを置いてください。',
    en: 'The data could not be laid out on this tag ({detail}). Nothing was written. Place another tag.',
  },
  tagBuildNoDetail: {
    ja: 'このタグには書き込める形にできませんでした。このタグには書き込んでいません。別のタグを置いてください。',
    en: 'The data could not be laid out on this tag. Nothing was written. Place another tag.',
  },
  waitFailed: {
    ja: 'リーダーの状態を確かめられなくなったため、発行を止めました。',
    en: 'Issuing was stopped because the reader state could not be checked.',
  },
  previewImageKey: { ja: '複製', en: 'Duplicate' },
  previewImageValue: { ja: 'データ領域をそのまま複製', en: 'Copy the data area as is' },
  previewErrorKey: { ja: 'エラー', en: 'Error' },
} satisfies Record<string, Text>;

export type IssueTextKey = keyof typeof T;

export function issueText(key: IssueTextKey, lang: LanguageSetting, params: Record<string, string | number> = {}): string {
  let s = T[key][lang];
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** True for a known ErrorCode (a service built before the contract change may still send raw text). */
export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, v);
}

/** The ErrorCode message, never the raw code. Unknown values fall back to `fallback`. */
export function codeText(code: unknown, lang: LanguageSetting, fallback: ErrorCode = 'INTERNAL'): string {
  return errorMessage(isErrorCode(code) ? code : fallback, lang);
}

/** "041591DA99AE20" -> "04:15:91:DA:99:AE:20" for messages. */
export function formatUidText(uid: string): string {
  const h = uid.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return h.match(/.{1,2}/g)?.join(':') ?? h;
}

const KIND_LABEL: Record<string, string> = {
  NTAG213: 'NTAG213',
  NTAG215: 'NTAG215',
  NTAG216: 'NTAG216',
  MIFARE_CLASSIC_1K: 'MIFARE Classic 1K',
  MIFARE_CLASSIC_4K: 'MIFARE Classic 4K',
  FELICA_LITE_S: 'FeliCa Lite-S',
};

export function kindText(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/**
 * A detail string from the shared encoders (they are Japanese only) is shown
 * only when it fits the UI language: always in ja, in en only when it is ASCII.
 */
export function detailFor(detail: string | null, lang: LanguageSetting): string | null {
  if (!detail) return null;
  const d = detail.trim();
  if (!d) return null;
  if (lang === 'ja') return d;
  return /^[\x20-\x7e]*$/.test(d) ? d : null;
}
