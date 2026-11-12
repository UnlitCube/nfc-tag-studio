// Operation errors raised in main. CONTRACT FILE - frozen (integrator-owned).
// Throw `new OpError(code, detail?)`; the IPC layer turns it into an Envelope with
// a localized message (ja/en per settings). Never put secrets (keys, passwords)
// into `detail`.
//
// Message rule (2026-11-12 UX audit FIRST-9/11): every message says what happened
// AND what to do next, in plain words for a first-time user. `detail` is a
// diagnostic (raw SW, PC/SC rv, block number): the renderer shows it only folded
// under "技術情報 / Technical details", never inline.

import type { AppErrorPayload, ErrorCode, LanguageSetting } from '@shared/types';
import { errorMessage } from '@shared/errorMessages';

export { errorMessage };

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

/** Convert anything thrown into a user-facing payload. */
export function toErrorPayload(err: unknown, lang: LanguageSetting): AppErrorPayload {
  if (err instanceof OpError) {
    return { code: err.code, message: errorMessage(err.code, lang), detail: err.detail };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message: errorMessage('INTERNAL', lang), detail };
}
