// Pure validation for the MIFARE key add form. No React, no DOM.
// Owner: agent renderer-backup. Tested by tests/backup.test.ts.
//
// Invariant I4: this module never logs or stores the key value - it only
// normalises and validates the operator's input before it is handed to main.

export type KeyErrorReason = 'empty' | 'hex' | 'length';

export interface KeyValidation {
  ok: boolean;
  /** Normalised 12-char uppercase hex, present only when ok. */
  value?: string;
  reason?: KeyErrorReason;
}

/** Strip common separators and upper-case. Leaves invalid characters in place. */
export function normalizeKeyHex(input: string): string {
  return input.replace(/[\s:-]/g, '').toUpperCase();
}

/** A MIFARE Classic key is 6 bytes = exactly 12 hex digits. */
export function validateKeyHex(input: string): KeyValidation {
  const value = normalizeKeyHex(input);
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (!/^[0-9A-F]*$/.test(value)) return { ok: false, reason: 'hex' };
  if (value.length !== 12) return { ok: false, reason: 'length' };
  return { ok: true, value };
}
