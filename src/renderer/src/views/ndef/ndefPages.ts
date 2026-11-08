// Pure helpers for the NDEF view (no React / DOM). Owner: agent "renderer-ndef".
// Kept separate from the view so the write-planning logic can be unit tested.
import type { UnitWrite } from '@shared/types';
import type { TagKind } from '@shared/tags';

export interface WriteKindResolution {
  /** Kind to plan the write (and size the capacity meter) for. */
  kind: TagKind;
  /**
   * Set when the operator's selected kind disagrees with the kind detected from
   * the card physically on the reader. When present, the view refuses the write
   * and warns the operator instead of planning against the wrong layout.
   */
  mismatch: { selected: TagKind; detected: TagKind } | null;
}

/**
 * Resolve the tag kind an NDEF write must be planned for.
 *
 * `selectedKind` is what the operator is composing for (the loaded document's
 * kind, or the kind picked in "new" / "file" mode). `detectedKind` is the kind
 * of the card physically on the reader that the write would target
 * (reader.card.kind for the matching UID), or null when no such card is present
 * or its kind could not be detected.
 *
 * The real chip owns its own memory layout, so which pages/blocks are forbidden
 * or protected is a property of the physical kind - not of the operator's pick.
 * main re-reads only the UID right before writing (DESIGN §3.1) and trusts
 * req.kind for the layout. If we planned, say, a 400-byte NDEF as NTAG216 while
 * the card on the reader is an NTAG213, main would map "user" pages onto the
 * 213's dynamic-lock / config pages and could permanently lock the tag
 * (bypassing I5) and corrupt the NDEF.
 *
 * Therefore the detected kind is authoritative when it is known:
 *   - equal to selectedKind -> use it, no mismatch.
 *   - different             -> report a mismatch so the caller refuses the write.
 * When the detected kind is unknown, fall back to the operator's selection.
 */
export function resolveWriteKind(selectedKind: TagKind, detectedKind: TagKind | null): WriteKindResolution {
  if (detectedKind && detectedKind !== selectedKind) {
    return { kind: detectedKind, mismatch: { selected: selectedKind, detected: detectedKind } };
  }
  return { kind: detectedKind ?? selectedKind, mismatch: null };
}

/** Format bytes as grouped uppercase hex: [0x03, 0xAB] -> "03 AB". */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Split the first `byteLen` bytes of a Type 2 user `area` into 4-byte page
 * writes starting at page `startUnit`. The final page is taken whole from
 * `area` (the caller passes a zero-filled full user area, so bytes past the
 * NDEF data are zero). This writes the NDEF TLV + terminator without disturbing
 * pages beyond it. Never emits a write for the UID/CC pages because `startUnit`
 * is the first user page (I1/I2: those pages are never written here).
 */
export function userAreaToPages(area: Uint8Array, startUnit: number, byteLen: number): UnitWrite[] {
  const pages = Math.ceil(Math.max(0, byteLen) / 4);
  const writes: UnitWrite[] = [];
  for (let i = 0; i < pages; i++) {
    writes.push({ unit: startUnit + i, data: area.slice(i * 4, i * 4 + 4) });
  }
  return writes;
}
