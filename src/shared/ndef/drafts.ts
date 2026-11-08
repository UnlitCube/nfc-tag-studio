// Convenience bridges between editor drafts and NDEF message bytes. Pure TS.
// Kept separate from record.ts/message.ts to avoid an import cycle.

import { encodeDraft, decodeRaw } from './record';
import { encodeMessage, decodeMessage } from './message';
import type { NdefRecordDraft } from './types';

/** Convenience: drafts -> message bytes. An empty list yields the empty-record message D0 00 00. */
export function encodeDrafts(drafts: NdefRecordDraft[]): Uint8Array {
  if (drafts.length === 0) return encodeMessage([]);
  return encodeMessage(drafts.map(encodeDraft));
}

/** Convenience: message bytes -> drafts. */
export function decodeToDrafts(bytes: Uint8Array): NdefRecordDraft[] {
  return decodeMessage(bytes).map(decodeRaw);
}
