// Byte/bit inspector + data-structure boundaries for the hex editor.
// Owner: agent renderer-hex. Pure logic; leans on the shared decoders so the
// bit meanings stay correct (readNtagConfig / readNtagLockState / parseAccessBits
// / describeAccess), and on scanType2Tlvs for the NDEF/TLV structure.
import type { LanguageSetting } from '@shared/types';
import type { TagKind } from '@shared/tags';
import {
  felicaBlockOfUnit,
  isFelica,
  isMifare,
  isNtag,
  mifareIsTrailer,
  mifareSectorOfBlock,
  ntagPages,
  parseAccessBits,
  regionOf,
  specFor,
} from '@shared/tags';
import { readNtagConfig, readNtagLockState, describeAccess } from '@shared/tag';
import { scanType2Tlvs } from '@shared/ndef';
import { decodeFelicaMc, felicaBlockName } from '@shared/felica';

export type Tone = 'info' | 'ok' | 'warn' | 'danger' | 'neutral';

export interface BitField {
  /** e.g. "バイト0", "b7", "b2–b0". */
  bits: string;
  name: string;
  /** Decoded value shown in mono (hex/binary/number), or ''. */
  value: string;
  meaning: string;
  tone?: Tone;
}

export interface InspectGroup {
  label: string;
  /** Absolute byte offsets this group covers (for highlighting). */
  from: number;
  to: number;
  fields: BitField[];
}

export interface UnitInspection {
  unit: number;
  unitLabel: string;
  regionLabel: string;
  summary: string;
  editable: boolean;
  isProtected: boolean;
  groups: InspectGroup[];
}

// --- data-structure boundaries (TLV / NDEF) ---------------------------------

export type SpanKind = 'tlv-null' | 'tlv-lock' | 'tlv-mem' | 'tlv-ndef' | 'tlv-prop' | 'terminator' | 'ndef-value' | 'sector';

export interface StructureSpan {
  /** Absolute byte offset (inclusive). */
  start: number;
  /** Absolute byte offset (inclusive). */
  end: number;
  kind: SpanKind;
  label: string;
}

const L = (lang: LanguageSetting, ja: string, en: string) => (lang === 'ja' ? ja : en);
const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const bin8 = (b: number) => b.toString(2).padStart(8, '0');

function tlvLabel(lang: LanguageSetting, tag: number): { kind: SpanKind; label: string } {
  switch (tag) {
    case 0x00:
      return { kind: 'tlv-null', label: L(lang, 'NULL TLV（詰め物）', 'NULL TLV (padding)') };
    case 0x01:
      return { kind: 'tlv-lock', label: L(lang, 'Lock Control TLV', 'Lock Control TLV') };
    case 0x02:
      return { kind: 'tlv-mem', label: L(lang, 'Memory Control TLV', 'Memory Control TLV') };
    case 0x03:
      return { kind: 'tlv-ndef', label: L(lang, 'NDEF メッセージ TLV', 'NDEF message TLV') };
    case 0xfd:
      return { kind: 'tlv-prop', label: L(lang, '独自 TLV', 'Proprietary TLV') };
    case 0xfe:
      return { kind: 'terminator', label: L(lang, '終端 TLV', 'Terminator TLV') };
    default:
      return { kind: 'tlv-prop', label: `TLV 0x${hex2(tag)}` };
  }
}

/**
 * Data-structure spans over the whole image, in absolute byte offsets.
 * NTAG: the Type 2 TLV blocks in the user area (NULL / Lock / Memory / NDEF /
 * Proprietary / Terminator) plus the NDEF message value as its own span.
 * MIFARE: sector boundaries (every trailer starts a visible divider upstream).
 */
export function structureSpans(kind: TagKind, data: Uint8Array, lang: LanguageSetting): StructureSpan[] {
  if (!isNtag(kind)) return [];
  const spec = specFor(kind);
  const userStart = spec.userStartUnit * spec.unitSize;
  const area = data.subarray(userStart, userStart + spec.userBytes);
  let scan;
  try {
    scan = scanType2Tlvs(area);
  } catch {
    return [];
  }
  const spans: StructureSpan[] = [];
  for (const tlv of scan.tlvs) {
    const info = tlvLabel(lang, tlv.tag);
    const headerLen = tlv.valueOffset - tlv.offset; // tag + length byte(s)
    const end = tlv.tag === 0x00 || tlv.tag === 0xfe ? tlv.offset : tlv.valueOffset + tlv.length - 1;
    spans.push({ start: userStart + tlv.offset, end: userStart + end, kind: info.kind, label: info.label });
    // The NDEF message value gets its own inner span (what readers actually parse).
    if (tlv.tag === 0x03 && tlv.length > 0) {
      spans.push({
        start: userStart + tlv.valueOffset,
        end: userStart + tlv.valueOffset + tlv.length - 1,
        kind: 'ndef-value',
        label: L(lang, 'NDEF 本体', 'NDEF payload'),
      });
    }
    void headerLen;
  }
  return spans;
}

/** Per-byte structure flags derived from spans, for the grid. */
export interface ByteStructure {
  /** This byte starts a structure span. */
  boundary: boolean;
  /** Byte lies within the NDEF message value. */
  inNdef: boolean;
  /** Byte is the terminator TLV. */
  terminator: boolean;
  /** Label of the innermost span covering this byte (for the title). */
  label: string | null;
}

export function perByteStructure(kind: TagKind, data: Uint8Array, lang: LanguageSetting): ByteStructure[] {
  const out: ByteStructure[] = Array.from({ length: data.length }, () => ({ boundary: false, inNdef: false, terminator: false, label: null }));
  for (const span of structureSpans(kind, data, lang)) {
    if (out[span.start]) out[span.start].boundary = true;
    for (let i = span.start; i <= span.end && i < out.length; i++) {
      if (span.kind === 'ndef-value') out[i].inNdef = true;
      if (span.kind === 'terminator') out[i].terminator = true;
      if (!out[i].label || span.kind === 'ndef-value') out[i].label = span.label;
    }
  }
  return out;
}

// --- per-unit bit inspection -------------------------------------------------

function accessLabel(lang: LanguageSetting, v: 'never' | 'A' | 'B' | 'AB' | null): string {
  switch (v) {
    case 'never':
      return L(lang, '不可', 'never');
    case 'A':
      return L(lang, '鍵A', 'key A');
    case 'B':
      return L(lang, '鍵B', 'key B');
    case 'AB':
      return L(lang, '鍵A/B', 'key A/B');
    default:
      return '—';
  }
}

function ntagInspection(kind: TagKind, data: Uint8Array, unit: number, lang: LanguageSetting): InspectGroup[] {
  const p = ntagPages(kind);
  const off = unit * 4;
  const groups: InspectGroup[] = [];

  if (unit === 2) {
    const lock0 = data[off + 2];
    const lock1 = data[off + 3];
    const ls = readNtagLockState(kind, data);
    groups.push({
      label: L(lang, '静的ロックバイト', 'Static lock bytes'),
      from: off + 2,
      to: off + 3,
      fields: [
        { bits: L(lang, 'バイト2–3', 'byte 2–3'), name: L(lang, 'ロックビット', 'Lock bits'), value: `${hex2(lock0)} ${hex2(lock1)}`, meaning: L(lang, 'ページ3（CC）〜15 をロックするビット。1 にすると恒久的に書き込み禁止になり、戻せません。', 'Bits that lock pages 3 (CC) to 15. Setting a bit permanently makes that page read-only.'), tone: lock0 || lock1 ? 'warn' : 'neutral' },
        { bits: '', name: L(lang, 'ロック済みページ', 'Locked pages'), value: ls.lockedPages.length ? ls.lockedPages.join(', ') : L(lang, 'なし', 'none'), meaning: L(lang, '現在ロックされているページ。', 'Pages currently locked.'), tone: ls.lockedPages.length ? 'warn' : 'ok' },
      ],
    });
    return groups;
  }

  if (unit === 3) {
    const cc = data.subarray(off, off + 4);
    const sizeBytes = cc[2] * 8;
    const readAcc = (cc[3] >> 4) & 0x0f;
    const writeAcc = cc[3] & 0x0f;
    groups.push({
      label: L(lang, 'Capability Container（CC）', 'Capability Container (CC)'),
      from: off,
      to: off + 3,
      fields: [
        { bits: L(lang, 'バイト0', 'byte 0'), name: L(lang, 'マジックナンバー', 'Magic number'), value: hex2(cc[0]), meaning: cc[0] === 0xe1 ? L(lang, '0xE1 = NFC Forum 準拠タグ。', '0xE1 = NFC Forum formatted tag.') : L(lang, '0xE1 以外。NDEF 未フォーマットの可能性。', 'Not 0xE1: may be unformatted.'), tone: cc[0] === 0xe1 ? 'ok' : 'warn' },
        { bits: L(lang, 'バイト1', 'byte 1'), name: L(lang, 'バージョン', 'Version'), value: hex2(cc[1]), meaning: L(lang, `上位/下位 = NFC Forum マッピングのバージョン（0x10 = 1.0）。`, 'Upper/lower nibble = mapping version (0x10 = 1.0).') },
        { bits: L(lang, 'バイト2', 'byte 2'), name: L(lang, 'データ領域サイズ', 'Data area size'), value: `${hex2(cc[2])} → ${sizeBytes} B`, meaning: L(lang, '×8 バイトで NDEF に使える領域の大きさ。NTAG213=0x12/215=0x3E/216=0x6D。', '×8 bytes = usable NDEF area. NTAG213=0x12, 215=0x3E, 216=0x6D.') },
        { bits: L(lang, 'バイト3', 'byte 3'), name: L(lang, 'アクセス権', 'Access'), value: hex2(cc[3]), meaning: L(lang, `読み出し=${readAcc === 0 ? '自由' : '制限'} / 書き込み=${writeAcc === 0 ? '自由' : '制限'}（0=自由, F=禁止）。`, `read=${readAcc === 0 ? 'free' : 'restricted'}, write=${writeAcc === 0 ? 'free' : 'restricted'} (0=free, F=no access).`), tone: writeAcc === 0 ? 'ok' : 'warn' },
      ],
    });
    return groups;
  }

  if (unit === p.dynLock) {
    const ls = readNtagLockState(kind, data);
    groups.push({
      label: L(lang, 'ダイナミックロック', 'Dynamic lock bytes'),
      from: off,
      to: off + 2,
      fields: [
        { bits: L(lang, 'バイト0–2', 'byte 0–2'), name: L(lang, 'ロックビット', 'Lock bits'), value: `${hex2(data[off])} ${hex2(data[off + 1])} ${hex2(data[off + 2])}`, meaning: L(lang, 'ユーザー領域の上位ページをまとめてロックするビット。1 は戻せません。', 'Bits that lock the upper user pages in blocks. Setting them is irreversible.'), tone: data[off] || data[off + 1] || data[off + 2] ? 'warn' : 'neutral' },
        { bits: '', name: L(lang, 'ロック済みページ', 'Locked pages'), value: ls.lockedPages.length ? ls.lockedPages.join(', ') : L(lang, 'なし', 'none'), meaning: '', tone: ls.lockedPages.length ? 'warn' : 'ok' },
      ],
    });
    return groups;
  }

  if (unit === p.cfg0 || unit === p.cfg1) {
    const cfg = readNtagConfig(kind, data);
    if (unit === p.cfg0) {
      groups.push({
        label: 'CFG0',
        from: p.cfg0 * 4,
        to: p.cfg0 * 4 + 3,
        fields: [
          { bits: 'MIRROR', name: L(lang, 'ミラー', 'ASCII mirror'), value: cfg.mirror.conf, meaning: L(lang, 'UID やカウンタを ASCII 文字として読み出しに差し込む設定。', 'Mirrors the UID/counter as ASCII into the read data.'), tone: cfg.mirror.conf === 'none' ? 'neutral' : 'info' },
          { bits: 'MIRROR_PAGE', name: L(lang, 'ミラー位置', 'Mirror page'), value: String(cfg.mirror.page), meaning: L(lang, 'ミラーを書き込むページ。', 'Page where the mirror is written.') },
          { bits: 'AUTH0', name: L(lang, 'パスワード保護開始ページ', 'AUTH0 (protection start)'), value: cfg.auth0 === 0xff ? L(lang, '0xFF（無効）', '0xFF (off)') : String(cfg.auth0), meaning: L(lang, 'このページ以降がパスワード認証の対象。0xFF で保護無効。', 'Pages from here need PWD_AUTH. 0xFF disables protection.'), tone: cfg.auth0 === 0xff ? 'neutral' : 'info' },
        ],
      });
    } else {
      groups.push({
        label: 'CFG1',
        from: p.cfg1 * 4,
        to: p.cfg1 * 4 + 3,
        fields: [
          { bits: 'PROT', name: L(lang, '保護範囲', 'PROT'), value: cfg.prot ? L(lang, '読み書き', 'read+write') : L(lang, '書き込みのみ', 'write only'), meaning: L(lang, 'パスワード保護が読み出しにも及ぶか、書き込みだけか。', 'Whether the password also protects reading, or only writing.'), tone: cfg.prot ? 'info' : 'neutral' },
          { bits: 'CFGLCK', name: L(lang, '設定ロック', 'CFGLCK'), value: cfg.cfgLock ? L(lang, 'ロック済み', 'locked') : L(lang, '未ロック', 'unlocked'), meaning: L(lang, '1 にすると CFG0/CFG1 を恒久的に書き込み禁止にします（戻せません）。', 'Setting it permanently freezes CFG0/CFG1 (irreversible).'), tone: cfg.cfgLock ? 'danger' : 'neutral' },
          { bits: 'NFC_CNT_EN', name: L(lang, 'カウンタ有効', 'Counter enabled'), value: cfg.counterEnabled ? L(lang, '有効', 'on') : L(lang, '無効', 'off'), meaning: L(lang, '読み取り回数カウンタの有効/無効。', 'Enables the NFC read counter.') },
          { bits: 'AUTHLIM', name: L(lang, '認証試行上限', 'AUTHLIM'), value: cfg.authLimit === 0 ? L(lang, '無制限', 'unlimited') : String(2 ** cfg.authLimit), meaning: L(lang, 'パスワード失敗の許容回数（0=無制限）。', 'Allowed wrong-password attempts (0 = unlimited).') },
        ],
      });
    }
    return groups;
  }

  if (unit === p.pwd || unit === p.pack) {
    groups.push({
      label: L(lang, 'パスワード領域', 'Password area'),
      from: p.pwd * 4,
      to: p.pack * 4 + 3,
      fields: [
        { bits: L(lang, 'PWD（4B）', 'PWD (4B)'), name: L(lang, 'パスワード', 'Password'), value: L(lang, '読み出すと 00', 'reads as 00'), meaning: L(lang, '32bit パスワード。読み出しでは常に 0 が返るため、いまの値は画面に出ません（工場出荷時は FFFFFFFF）。保護を始めるときは「パラメータ（フラグ）編集」で決めます。', '32-bit password. It always reads back as 0, so the current value is never shown (FFFFFFFF from the factory). Decide it under "Parameters / flags" when turning protection on.'), tone: 'info' },
        { bits: L(lang, 'PACK（2B）', 'PACK (2B)'), name: L(lang, '応答コード', 'Password ACK'), value: '', meaning: L(lang, '認証成功時に返る 16bit 応答。', '16-bit value returned on a successful auth.') },
      ],
    });
    return groups;
  }

  return groups;
}

function mifareInspection(data: Uint8Array, unit: number, lang: LanguageSetting): InspectGroup[] {
  const off = unit * 16;
  const groups: InspectGroup[] = [];
  if (unit === 0) {
    const bcc = data[off] ^ data[off + 1] ^ data[off + 2] ^ data[off + 3];
    groups.push({
      label: L(lang, '製造者ブロック', 'Manufacturer block'),
      from: off,
      to: off + 15,
      fields: [
        { bits: L(lang, 'バイト0–3', 'byte 0–3'), name: 'UID', value: `${hex2(data[off])}${hex2(data[off + 1])}${hex2(data[off + 2])}${hex2(data[off + 3])}`, meaning: L(lang, '製造時に固定された読み取り専用の UID。', 'Read-only UID fixed at manufacture.'), tone: 'info' },
        { bits: L(lang, 'バイト4', 'byte 4'), name: 'BCC', value: `${hex2(data[off + 4])}${data[off + 4] === bcc ? '' : ' !'}`, meaning: L(lang, 'UID のチェックバイト（XOR）。', 'UID checksum (XOR of the 4 UID bytes).'), tone: data[off + 4] === bcc ? 'ok' : 'warn' },
        { bits: L(lang, 'バイト5', 'byte 5'), name: 'SAK', value: hex2(data[off + 5]), meaning: L(lang, 'タグの種別応答（08=1K, 18=4K 相当）。', 'Select acknowledge (08=1K, 18=4K).') },
        { bits: L(lang, 'バイト6–7', 'byte 6–7'), name: 'ATQA', value: `${hex2(data[off + 6])}${hex2(data[off + 7])}`, meaning: L(lang, 'Answer To reQuest（種別）。', 'Answer to request type A.') },
      ],
    });
    return groups;
  }
  if (mifareIsTrailer(unit)) {
    const trailer = data.subarray(off, off + 16);
    const bits = parseAccessBits(trailer);
    const fields: BitField[] = [
      { bits: L(lang, 'バイト0–5', 'byte 0–5'), name: L(lang, '鍵A', 'Key A'), value: L(lang, '表示されません', 'not shown'), meaning: L(lang, 'セクタA鍵。読み出すと 00 が返ります。', 'Sector key A. Reads back as 00.'), tone: 'info' },
      { bits: L(lang, 'バイト6–8', 'byte 6–8'), name: L(lang, 'アクセス条件', 'Access bits'), value: `${hex2(trailer[6])} ${hex2(trailer[7])} ${hex2(trailer[8])}`, meaning: bits ? L(lang, '各ブロックの読み書き権を決めます。', 'Define read/write rights per block.') : L(lang, '不正なビット（このまま書くとセクタが使えなくなります）。', 'Invalid pattern — writing it would brick the sector.'), tone: bits ? 'neutral' : 'danger' },
      { bits: L(lang, 'バイト9', 'byte 9'), name: 'GPB', value: hex2(trailer[9]), meaning: L(lang, '汎用バイト（任意用途）。', 'General purpose byte.') },
      { bits: L(lang, 'バイト10–15', 'byte 10–15'), name: L(lang, '鍵B', 'Key B'), value: L(lang, '表示されません', 'not shown'), meaning: L(lang, 'セクタB鍵。', 'Sector key B.'), tone: 'info' },
    ];
    if (bits) {
      for (let g = 0 as 0 | 1 | 2 | 3; g <= 3; g = (g + 1) as 0 | 1 | 2 | 3) {
        const d = describeAccess(bits, g);
        const name = g === 3 ? L(lang, 'トレーラ', 'trailer') : L(lang, `データ群${g}`, `data group ${g}`);
        fields.push({ bits: `C1C2C3[${g}]`, name, value: `R:${accessLabel(lang, d.read)} / W:${accessLabel(lang, d.write)}`, meaning: d.summary, tone: 'neutral' });
      }
    }
    groups.push({ label: L(lang, 'セクタトレーラ', 'Sector trailer'), from: off, to: off + 15, fields });
    return groups;
  }
  return groups;
}

function felicaInspection(data: Uint8Array, unit: number, lang: LanguageSetting): InspectGroup[] {
  const off = unit * 16;
  const block = felicaBlockOfUnit('FELICA_LITE_S', unit);
  const groups: InspectGroup[] = [];
  // MC (0x88) is always the last unit; decode its write-permission bitmap + mode.
  const mcOff = 15 * 16;
  const mc = decodeFelicaMc(data.subarray(mcOff, mcOff + 16));
  if (block === 0x88) {
    const fields: BitField[] = [
      {
        bits: L(lang, 'バイト2', 'byte 2'),
        name: L(lang, 'システムブロック', 'System blocks'),
        value: mc.systemBlocksWritable ? L(lang, '読み書き', 'read/write') : L(lang, '読み取り専用', 'read-only'),
        meaning: L(lang, 'ID・鍵・MC などシステムブロックの書き込み可否（0xFF = 可 / 0x00 = 読み取り専用）。', 'Write permission of the system blocks (ID, keys, MC): 0xFF = writable, 0x00 = read-only.'),
        tone: mc.systemBlocksWritable ? 'info' : 'warn',
      },
    ];
    // Write-protect mask (two copies: MC[8:10] and MC[10:12]); 1 = read-only.
    for (let b = 0; b <= 0x0e; b++) {
      fields.push({
        bits: b < 8 ? `MC[8] b${b}` : `MC[9] b${b - 8}`,
        name: felicaBlockName(b),
        value: mc.writable[b] ? L(lang, '読み書き', 'read/write') : L(lang, '読み取り専用', 'read-only'),
        meaning: mc.writable[b]
          ? L(lang, 'このブロックは書き込み可能。', 'This block is writable.')
          : L(lang, 'このブロックは読み取り専用（保護ビットを立てると戻せません）。', 'This block is read-only (setting the protect bit is irreversible).'),
        tone: mc.writable[b] ? 'ok' : 'warn',
      });
    }
    groups.push({ label: L(lang, 'MC（メモリ構成・0x88）', 'MC (memory configuration, 0x88)'), from: off, to: off + 15, fields });
    return groups;
  }
  // A data / REG block: show its FeliCa block name and current write permission.
  const writable = block <= 0x0e ? mc.writable[block] : true;
  groups.push({
    label: `${felicaBlockName(block)}（0x${block.toString(16).toUpperCase().padStart(2, '0')}）`,
    from: off,
    to: off + 15,
    fields: [
      {
        bits: '',
        name: L(lang, '書き込み可否', 'Write permission'),
        value: writable ? L(lang, '読み書き', 'read/write') : L(lang, '読み取り専用', 'read-only'),
        meaning: L(lang, 'MC（0x88）の設定で決まります。', 'Determined by the MC block (0x88).'),
        tone: writable ? 'ok' : 'warn',
      },
    ],
  });
  return groups;
}

/** Inspect one unit (page/block): region, summary, and decoded bit-fields. */
export function inspectUnit(kind: TagKind, data: Uint8Array, unit: number, lang: LanguageSetting): UnitInspection {
  const spec = specFor(kind);
  const region = regionOf(kind, unit);
  const unitWord = spec.unit === 'page' ? L(lang, 'ページ', 'page') : L(lang, 'ブロック', 'block');
  const editable = !region?.protected;
  let groups: InspectGroup[] = [];
  let summary = region?.note ?? '';
  if (isNtag(kind)) {
    groups = ntagInspection(kind, data, unit, lang);
    if (unit >= spec.userStartUnit && unit <= ntagPages(kind).userLast) {
      summary = L(lang, 'ユーザーデータ領域。NDEF や任意のデータを書けます。', 'User data area. Holds NDEF or arbitrary data.');
    }
  } else if (isMifare(kind)) {
    groups = mifareInspection(data, unit, lang);
    if (unit !== 0 && !mifareIsTrailer(unit)) {
      summary = L(lang, `データブロック（セクタ ${mifareSectorOfBlock(unit)}）。`, `Data block (sector ${mifareSectorOfBlock(unit)}).`);
    }
  } else if (isFelica(kind)) {
    groups = felicaInspection(data, unit, lang);
  }
  const unitLabel = isFelica(kind) ? felicaBlockName(felicaBlockOfUnit(kind, unit)) : `${unitWord} ${unit}`;
  return {
    unit,
    unitLabel,
    regionLabel: region?.label ?? '',
    summary,
    editable,
    isProtected: !!region?.protected,
    groups,
  };
}

export { bin8 };
