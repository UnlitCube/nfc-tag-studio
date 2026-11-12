// Tag memory-map metadata + small pure helpers for NFC Forum Type 2 (NTAG21x)
// and MIFARE Classic. CONTRACT FILE - frozen (integrator-owned).
//
// IMPORTANT design invariant (also stated in the UI/help):
//   The tag UID / serial number is set at manufacture and is READ-ONLY. This tool
//   edits the writable DATA area (user memory, NDEF, counters) of tags the
//   operator owns/manages. It never claims to change a UID. MIFARE Classic
//   sectors are opened only with keys the operator holds; no key recovery.

export type TagKind = 'NTAG213' | 'NTAG215' | 'NTAG216' | 'MIFARE_CLASSIC_1K' | 'MIFARE_CLASSIC_4K' | 'FELICA_LITE_S';
export type TagFamily = 'NTAG' | 'MIFARE_CLASSIC' | 'FELICA_LITE';

export interface PageRegion {
  /** First page (NTAG) / block (MIFARE/FeliCa) UNIT index, inclusive. */
  start: number;
  /** Last index, inclusive. */
  end: number;
  /** Region id, used by the UI for colour + i18n. */
  id: 'uid' | 'cc' | 'user' | 'dynlock' | 'config' | 'password' | 'manufacturer' | 'data' | 'reg' | 'mc' | 'system';
  label: string;
  /** Operators normally should not overwrite this region by hand. */
  protected: boolean;
  note?: string;
}

export interface TagSpec {
  kind: TagKind;
  family: TagFamily;
  displayName: string;
  /** Logical unit the memory is addressed in. */
  unit: 'page' | 'block';
  /** Bytes per addressable unit (NTAG page = 4, MIFARE/FeliCa block = 16). */
  unitSize: number;
  /** Total number of addressable units (incl. header/config). */
  unitCount: number;
  /** User-writable data capacity in bytes. */
  userBytes: number;
  /** First user-data unit index. */
  userStartUnit: number;
  regions: PageRegion[];
  uidBytes: number;
  summary: string;
  /**
   * FeliCa only: maps a contiguous UNIT index (0..unitCount-1) to the real,
   * non-contiguous FeliCa block number (e.g. unit 15 -> block 0x88 MC). Absent
   * for NTAG/MIFARE, where the block number equals the unit index.
   */
  blockMap?: readonly number[];
}

// --- NTAG21x -----------------------------------------------------------------
// Page = 4 bytes. Pages 0-2: UID + BCC + static lock, page 3: CC (OTP), user data
// from page 4. Directly after user memory, in order:
//   dynamic lock, CFG0, CFG1, PWD, PACK   (PACK is always the last page)
//   NTAG213: 45 pages,  user 4..39  (144 B), dynLock 40,  CFG0 41,  PACK 44
//   NTAG215: 135 pages, user 4..129 (504 B), dynLock 130, CFG0 131, PACK 134
//   NTAG216: 231 pages, user 4..225 (888 B), dynLock 226, CFG0 227, PACK 230
export interface NtagConfigPages {
  userLast: number;
  dynLock: number;
  cfg0: number;
  cfg1: number;
  pwd: number;
  pack: number;
}

export function ntagConfigPagesFor(userBytes: number): NtagConfigPages {
  const userLast = 3 + userBytes / 4;
  const dynLock = userLast + 1;
  return { userLast, dynLock, cfg0: dynLock + 1, cfg1: dynLock + 2, pwd: dynLock + 3, pack: dynLock + 4 };
}

function ntag(kind: 'NTAG213' | 'NTAG215' | 'NTAG216', pages: number, userBytes: number): TagSpec {
  const c = ntagConfigPagesFor(userBytes);
  if (c.pack !== pages - 1) {
    throw new Error(`${kind}: page layout mismatch (PACK=${c.pack}, last=${pages - 1})`);
  }
  return {
    kind,
    family: 'NTAG',
    displayName: kind,
    unit: 'page',
    unitSize: 4,
    unitCount: pages,
    userBytes,
    userStartUnit: 4,
    uidBytes: 7,
    summary:
      kind === 'NTAG213'
        ? '144 バイトのユーザー領域。URL・名刺・小さなデータ向け。'
        : kind === 'NTAG215'
          ? '504 バイトのユーザー領域。'
          : '888 バイトのユーザー領域。NTAG21x で最大。',
    regions: [
      { start: 0, end: 2, id: 'uid', label: 'UID / 製造番号・静的ロック', protected: true, note: 'UID は製造時に固定され、書き換えできません。' },
      { start: 3, end: 3, id: 'cc', label: 'Capability Container (CC)', protected: true, note: '一度だけ書けるビット（OTP）。通常は変更しません。' },
      { start: 4, end: c.userLast, id: 'user', label: 'ユーザーデータ / NDEF', protected: false },
      { start: c.dynLock, end: c.dynLock, id: 'dynlock', label: 'ダイナミックロック', protected: true, note: 'ロックビットは一度立てると戻せません。' },
      { start: c.cfg0, end: c.cfg1, id: 'config', label: 'CFG0 / CFG1（設定）', protected: true, note: 'ミラー・AUTH0・アクセス設定。' },
      { start: c.pwd, end: c.pack, id: 'password', label: 'PWD / PACK（パスワード）', protected: true, note: 'PWD は読み出すと 00 が返ります。' },
    ],
  };
}

// --- MIFARE Classic ----------------------------------------------------------
// Block = 16 bytes. 1K: 16 sectors x 4 blocks. 4K: sectors 0-31 x 4 blocks,
// sectors 32-39 x 16 blocks. The last block of each sector (trailer) holds
// Key A | access bits (4 bytes) | Key B. Block 0 is the manufacturer block.
function mifare(kind: 'MIFARE_CLASSIC_1K' | 'MIFARE_CLASSIC_4K', blocks: number): TagSpec {
  const sectors = kind === 'MIFARE_CLASSIC_1K' ? 16 : 40;
  return {
    kind,
    family: 'MIFARE_CLASSIC',
    displayName: kind === 'MIFARE_CLASSIC_1K' ? 'MIFARE Classic 1K' : 'MIFARE Classic 4K',
    unit: 'block',
    unitSize: 16,
    unitCount: blocks,
    // data blocks = all blocks - trailers - block 0
    userBytes: (blocks - sectors - 1) * 16,
    userStartUnit: 1,
    uidBytes: 4,
    summary:
      kind === 'MIFARE_CLASSIC_1K'
        ? '16 セクタ × 4 ブロック。各セクタは管理者が持つ鍵で開きます。'
        : '40 セクタ。各セクタは管理者が持つ鍵で開きます。',
    regions: [
      { start: 0, end: 0, id: 'manufacturer', label: '製造者ブロック（UID）', protected: true, note: 'UID と製造情報。書き換えできません。' },
      {
        start: 1,
        end: blocks - 1,
        id: 'data',
        label: 'データブロック / セクタトレーラ',
        protected: false,
        note: '各セクタ最後のブロック（トレーラ）は鍵とアクセス条件です。',
      },
    ],
  };
}

// --- FeliCa Lite-S (Sony RC-S966) --------------------------------------------
// Block = 16 bytes, addressed by non-contiguous block numbers. The editable grid
// holds the 14 user blocks (S_PAD0..S_PAD13 = 0x00..0x0D), the REG register block
// (0x0E) and the MC memory-configuration block (0x88); blockMap maps the unit
// index to the real block number. IDm (8 bytes) is the read-only manufacture id.
// Read-only system blocks (ID 0x82, SYS_C 0x85, CKV 0x86 ...) are shown in the
// card info / inspector, not in the editable grid.
export const FELICA_LITE_S_BLOCK_MAP: readonly number[] = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x88,
];
export const FELICA_LITE_S_SYSTEM_CODE = 0x88b4;
/** FeliCa block numbers of read-only system blocks we read for display (not in the grid). */
export const FELICA_LITE_S_INFO_BLOCKS = { id: 0x82, serC: 0x84, sysC: 0x85, ckv: 0x86, wcnt: 0x90, state: 0x92 } as const;

function felicaLiteS(): TagSpec {
  return {
    kind: 'FELICA_LITE_S',
    family: 'FELICA_LITE',
    displayName: 'FeliCa Lite-S',
    unit: 'block',
    unitSize: 16,
    unitCount: FELICA_LITE_S_BLOCK_MAP.length,
    userBytes: 14 * 16,
    userStartUnit: 0,
    uidBytes: 8,
    blockMap: FELICA_LITE_S_BLOCK_MAP,
    summary: '224 バイトのユーザー領域（S_PAD0〜13）。RC-S966。暗号認証（鍵）には非対応。',
    regions: [
      { start: 0, end: 13, id: 'user', label: 'ユーザーデータ（S_PAD0〜13）', protected: false },
      { start: 14, end: 14, id: 'reg', label: 'REG（レジスタ 0x0E）', protected: false, note: '認証・カウンタ運用のレジスタ。通常のデータ用途では未使用。' },
      { start: 15, end: 15, id: 'mc', label: 'MC（メモリ構成・フラグ 0x88）', protected: true, note: '各ブロックの読み書き可否や動作モード。設定を誤るとブロックが恒久的に読み取り専用になります。' },
    ],
  };
}

export const TAG_SPECS: Record<TagKind, TagSpec> = {
  NTAG213: ntag('NTAG213', 45, 144),
  NTAG215: ntag('NTAG215', 135, 504),
  NTAG216: ntag('NTAG216', 231, 888),
  MIFARE_CLASSIC_1K: mifare('MIFARE_CLASSIC_1K', 64),
  MIFARE_CLASSIC_4K: mifare('MIFARE_CLASSIC_4K', 256),
  FELICA_LITE_S: felicaLiteS(),
};

export const TAG_KINDS = Object.keys(TAG_SPECS) as TagKind[];

export function specFor(kind: TagKind): TagSpec {
  return TAG_SPECS[kind];
}

export function isNtag(kind: TagKind): kind is 'NTAG213' | 'NTAG215' | 'NTAG216' {
  return TAG_SPECS[kind].family === 'NTAG';
}

export function isMifare(kind: TagKind): kind is 'MIFARE_CLASSIC_1K' | 'MIFARE_CLASSIC_4K' {
  return TAG_SPECS[kind].family === 'MIFARE_CLASSIC';
}

export function isFelica(kind: TagKind): kind is 'FELICA_LITE_S' {
  return TAG_SPECS[kind].family === 'FELICA_LITE';
}

/** Real FeliCa block number for a grid unit index (identity for non-FeliCa). */
export function felicaBlockOfUnit(kind: TagKind, unit: number): number {
  const map = specFor(kind).blockMap;
  return map ? (map[unit] ?? unit) : unit;
}

/** Total image size (all addressable units) in bytes. */
export function imageSize(kind: TagKind): number {
  const s = specFor(kind);
  return s.unitCount * s.unitSize;
}

/** NTAG config page indices for a kind (throws for MIFARE). */
export function ntagPages(kind: TagKind): NtagConfigPages {
  if (!isNtag(kind)) throw new Error(`${kind} is not an NTAG`);
  return ntagConfigPagesFor(specFor(kind).userBytes);
}

// --- MIFARE sector math --------------------------------------------------------

export function mifareSectorCount(kind: TagKind): number {
  if (kind === 'MIFARE_CLASSIC_1K') return 16;
  if (kind === 'MIFARE_CLASSIC_4K') return 40;
  throw new Error(`${kind} is not MIFARE Classic`);
}

export function mifareSectorFirstBlock(sector: number): number {
  return sector < 32 ? sector * 4 : 128 + (sector - 32) * 16;
}

export function mifareSectorBlockCount(sector: number): number {
  return sector < 32 ? 4 : 16;
}

export function mifareTrailerBlock(sector: number): number {
  return mifareSectorFirstBlock(sector) + mifareSectorBlockCount(sector) - 1;
}

export function mifareSectorOfBlock(block: number): number {
  return block < 128 ? Math.floor(block / 4) : 32 + Math.floor((block - 128) / 16);
}

export function mifareIsTrailer(block: number): boolean {
  return mifareTrailerBlock(mifareSectorOfBlock(block)) === block;
}

/** Data blocks in address order, excluding block 0 and sector trailers. */
export function mifareDataBlocks(kind: TagKind): number[] {
  const out: number[] = [];
  const n = specFor(kind).unitCount;
  for (let b = 1; b < n; b++) if (!mifareIsTrailer(b)) out.push(b);
  return out;
}

/**
 * Decoded access conditions of one sector trailer. c[i] = [C1, C2, C3] for
 * block i of the sector (i = 0..2 data block groups, 3 = trailer).
 * For 16-block sectors (4K, sectors 32+), group i covers 5 blocks (0-4, 5-9, 10-14).
 */
export interface AccessBits {
  c: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
  /** Byte 9 of the trailer (general purpose / user data byte). */
  gpb: number;
}

/**
 * Parse trailer bytes 6..9. Returns null when the inverted copies do not match
 * (an invalid pattern - writing it would permanently lock the sector).
 */
export function parseAccessBits(trailer: Uint8Array): AccessBits | null {
  if (trailer.length < 10) return null;
  const b6 = trailer[6];
  const b7 = trailer[7];
  const b8 = trailer[8];
  const c1 = (b7 >> 4) & 0x0f;
  const c2 = b8 & 0x0f;
  const c3 = (b8 >> 4) & 0x0f;
  const nc1 = b6 & 0x0f;
  const nc2 = (b6 >> 4) & 0x0f;
  const nc3 = b7 & 0x0f;
  if ((c1 ^ nc1) !== 0x0f || (c2 ^ nc2) !== 0x0f || (c3 ^ nc3) !== 0x0f) return null;
  const bit = (v: number, i: number) => (v >> i) & 1;
  const c = [0, 1, 2, 3].map((i) => [bit(c1, i), bit(c2, i), bit(c3, i)]) as AccessBits['c'];
  return { c, gpb: trailer[9] };
}

/** Encode access conditions into trailer bytes 6..9 (4 bytes). */
export function encodeAccessBits(a: AccessBits): Uint8Array {
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  for (let i = 0; i < 4; i++) {
    c1 |= (a.c[i][0] & 1) << i;
    c2 |= (a.c[i][1] & 1) << i;
    c3 |= (a.c[i][2] & 1) << i;
  }
  const b6 = ((~c2 & 0x0f) << 4) | (~c1 & 0x0f);
  const b7 = (c1 << 4) | (~c3 & 0x0f);
  const b8 = (c3 << 4) | c2;
  return Uint8Array.from([b6 & 0xff, b7 & 0xff, b8 & 0xff, a.gpb & 0xff]);
}

/** Transport configuration: access bits FF 07 80, GPB 69. */
export const MIFARE_TRANSPORT_ACCESS = Uint8Array.from([0xff, 0x07, 0x80, 0x69]);

// --- identification ------------------------------------------------------------

/** NTAG GET_VERSION (8 bytes) -> kind. Vendor 04 (NXP), product type 04 (NTAG). */
export function kindFromVersion(v: Uint8Array): TagKind | null {
  if (v.length < 8 || v[1] !== 0x04 || v[2] !== 0x04) return null;
  switch (v[6]) {
    case 0x0f:
      return 'NTAG213';
    case 0x11:
      return 'NTAG215';
    case 0x13:
      return 'NTAG216';
    default:
      return null;
  }
}

/** NTAG Capability Container (page 3) -> kind, by the data-area size byte. */
export function kindFromCc(cc: Uint8Array): TagKind | null {
  if (cc.length < 4 || cc[0] !== 0xe1) return null;
  switch (cc[2]) {
    case 0x12:
      return 'NTAG213';
    case 0x3e:
      return 'NTAG215';
    case 0x6d:
      return 'NTAG216';
    default:
      return null;
  }
}

/**
 * PC/SC Part 3 storage-card ATR: 3B 8F 80 01 80 4F 0C A0 00 00 03 06 SS NN NN ...
 * (RID A0 00 00 03 06, SS = standard, NN NN = card name).
 */
export function parseStorageAtr(atr: Uint8Array): { standard: number; cardName: number } | null {
  for (let i = 0; i + 8 <= atr.length; i++) {
    if (atr[i] === 0xa0 && atr[i + 1] === 0x00 && atr[i + 2] === 0x00 && atr[i + 3] === 0x03 && atr[i + 4] === 0x06) {
      return { standard: atr[i + 5], cardName: (atr[i + 6] << 8) | atr[i + 7] };
    }
  }
  return null;
}

/** Card-family hint from the ATR. 'TYPE2' = Ultralight/NTAG family, 'FELICA' = FeliCa. */
export function kindHintFromAtr(atr: Uint8Array): 'MIFARE_CLASSIC_1K' | 'MIFARE_CLASSIC_4K' | 'TYPE2' | 'FELICA' | null {
  const p = parseStorageAtr(atr);
  if (!p) return null;
  // PC/SC Part 3 "standard" byte 0x11 = FeliCa.
  if (p.standard === 0x11) return 'FELICA';
  switch (p.cardName) {
    case 0x0001:
      return 'MIFARE_CLASSIC_1K';
    case 0x0002:
      return 'MIFARE_CLASSIC_4K';
    case 0x0003:
      return 'TYPE2';
    default:
      return null;
  }
}

/** FeliCa system code -> kind. 0x88B4 is FeliCa Lite / Lite-S. */
export function kindFromFelicaSystemCode(systemCode: number): TagKind | null {
  return systemCode === FELICA_LITE_S_SYSTEM_CODE ? 'FELICA_LITE_S' : null;
}

/**
 * Lite-S vs Lite. NOTE (2026-11-12): MC[2] is the system-block write-enable
 * (0xFF/0x00), NOT a "SYS_OP" bit - the earlier interpretation here was wrong.
 * This app identifies Lite-S by its system code (0x88B4, see
 * kindFromFelicaSystemCode); this helper is unused and kept only for the API
 * surface. A factory card reads MC[2] = 0xFF, so it reports true.
 */
export function felicaIsLiteS(mcBlock: Uint8Array): boolean {
  return mcBlock.length >= 3 && mcBlock[2] === 0xff;
}

// --- factory images (simulator + "new document") --------------------------------

/** NTAG BCC0 / BCC1 per ISO/IEC 14443-3 (cascade tag 0x88 included in BCC0). */
export function ntagBcc(uid: Uint8Array): [number, number] {
  return [0x88 ^ uid[0] ^ uid[1] ^ uid[2], uid[3] ^ uid[4] ^ uid[5] ^ uid[6]];
}

/**
 * Factory-fresh memory image.
 * NTAG21x: UID+BCC, internal 0x48, static lock 00 00, CC E1 10 <size> 00,
 *   empty NDEF TLV 03 00 FE in page 4, dynamic lock 00, CFG0 04 00 00 FF,
 *   CFG1 00 05 00 00, PWD FF FF FF FF (reads as 00), PACK 00 00.
 * MIFARE Classic: block 0 = UID + BCC + SAK + ATQA + manufacturer bytes,
 *   data blocks 00, trailers FFFFFFFFFFFF FF0780 69 FFFFFFFFFFFF.
 */
export function factoryImage(kind: TagKind, uid: Uint8Array): Uint8Array {
  const spec = specFor(kind);
  const data = new Uint8Array(spec.unitCount * spec.unitSize);
  if (isFelica(kind)) {
    // FeliCa Lite-S factory-default MC (block 0x88) = FF FF FF 01 07 00..00.
    // The write/read-protect masks (MC[6:8], MC[8:10], MC[10:12]) are 0 = all
    // user blocks writable; MC[2] = 0xFF = system blocks writable. (See the MC
    // notes in src/shared/felica.ts.) User blocks 0x00-0x0D + REG (0x0E) zeroed.
    const mcOff = 15 * 16; // last unit = MC
    data[mcOff + 0] = 0xff;
    data[mcOff + 1] = 0xff;
    data[mcOff + 2] = 0xff;
    data[mcOff + 3] = 0x01;
    data[mcOff + 4] = 0x07;
    return data;
  }
  if (isNtag(kind)) {
    if (uid.length !== 7) throw new Error('NTAG UID must be 7 bytes');
    const [bcc0, bcc1] = ntagBcc(uid);
    data.set([uid[0], uid[1], uid[2], bcc0, uid[3], uid[4], uid[5], uid[6], bcc1, 0x48, 0x00, 0x00], 0);
    const ccSize = kind === 'NTAG213' ? 0x12 : kind === 'NTAG215' ? 0x3e : 0x6d;
    data.set([0xe1, 0x10, ccSize, 0x00], 12);
    data.set([0x03, 0x00, 0xfe], 16);
    const p = ntagConfigPagesFor(spec.userBytes);
    data.set([0x04, 0x00, 0x00, 0xff], p.cfg0 * 4);
    data.set([0x00, 0x05, 0x00, 0x00], p.cfg1 * 4);
    data.set([0xff, 0xff, 0xff, 0xff], p.pwd * 4);
    return data;
  }
  if (uid.length !== 4) throw new Error('MIFARE Classic UID must be 4 bytes');
  const bcc = uid[0] ^ uid[1] ^ uid[2] ^ uid[3];
  const sak = kind === 'MIFARE_CLASSIC_1K' ? 0x08 : 0x18;
  const atqa = kind === 'MIFARE_CLASSIC_1K' ? [0x04, 0x00] : [0x02, 0x00];
  data.set([uid[0], uid[1], uid[2], uid[3], bcc, sak, atqa[0], atqa[1], 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69], 0);
  const sectors = mifareSectorCount(kind);
  for (let s = 0; s < sectors; s++) {
    const off = mifareTrailerBlock(s) * 16;
    data.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], off);
    data.set(MIFARE_TRANSPORT_ACCESS, off + 6);
    data.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], off + 10);
  }
  return data;
}

/**
 * Units that can never be written by this app: NTAG pages 0-1 (UID) and
 * MIFARE block 0 (manufacturer block). Page 2 is writable only for its lock
 * bytes, which counts as protected (see isProtectedUnit).
 */
export function isForbiddenUnit(kind: TagKind, unit: number): boolean {
  if (isFelica(kind)) return false; // no UID/manufacturer block in the editable grid
  if (isNtag(kind)) return unit <= 1;
  return unit === 0;
}

/**
 * Protected (writable only with explicit confirmation): NTAG page 2 (static
 * lock), CC, dynamic lock, CFG, PWD/PACK; MIFARE sector trailers.
 */
export function isProtectedUnit(kind: TagKind, unit: number): boolean {
  if (isForbiddenUnit(kind, unit)) return true;
  if (isFelica(kind)) return unit === 15; // MC (0x88) only
  if (isNtag(kind)) {
    const p = ntagPages(kind);
    return unit <= 3 || unit > p.userLast;
  }
  return mifareIsTrailer(unit);
}

/** Region of a unit (for colouring). */
export function regionOf(kind: TagKind, unit: number): PageRegion | null {
  const s = specFor(kind);
  return s.regions.find((r) => unit >= r.start && unit <= r.end) ?? null;
}
