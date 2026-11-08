// NDEF codec - PUBLIC API (signatures frozen by the integrator).
// Owner: agent "shared-ndef". Implemented across this directory
// (record.ts / message.ts / drafts.ts / tlv.ts / wifi.ts / vcard.ts / mifare.ts)
// and re-exported from here. Names/parameters/return types are NOT changed.
//
// Pure TypeScript: no Node, no DOM APIs (TextEncoder/TextDecoder are allowed).

export * from './types';

// URI RTD abbreviation table (0x00-0x23) and editor draft <-> wire record codec.
export { URI_PREFIXES, encodeDraft, decodeRaw, describeDraft, emptyDraft } from './record';

// NDEF message (record list) <-> wire bytes, with MB/ME/SR/IL/CF handling.
export { encodeMessage, decodeMessage } from './message';

// Draft-list convenience wrappers.
export { encodeDrafts, decodeToDrafts } from './drafts';

// Type 2 (NTAG) TLV wrapping, scanning, capacity, user area and CC.
export { wrapNdefTlv, scanType2Tlvs, type2Capacity, buildType2UserArea, defaultCc } from './tlv';

// MIFARE Classic NDEF (MAD-directed) read and write planning.
export { extractMifareNdef, buildMifareNdefWrites } from './mifare';
