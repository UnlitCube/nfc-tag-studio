// Dictionary for the card type shown from the ATR (2026-11-14, shared/cardType.ts).
// Keys start with "cardType.". Add every key to BOTH ja and en (compile-checked).
// D7 terms: 「タグ」は NTAG・MIFARE・FeliCa のメモリのタグ、IC カードは「カード」と呼ぶ。
import { defineMessages } from './define';

export default defineMessages({
  ja: {
    'cardType.label.card': '製品',
    'cardType.label.radio': '規格',
    'cardType.label.form': '種類',
    'cardType.label.atr': 'ATR',

    'cardType.product.type2': 'NTAG・MIFARE Ultralight の仲間',
    'cardType.product.ultralightC': 'MIFARE Ultralight C',
    'cardType.product.mifareClassic1k': 'MIFARE Classic 1K',
    'cardType.product.mifareClassic4k': 'MIFARE Classic 4K',
    'cardType.product.mifareMini': 'MIFARE Mini',
    'cardType.product.topaz': 'Topaz（Jewel）',
    'cardType.product.felica': 'FeliCa',
    'cardType.product.mynumber': 'マイナンバーカード',
    'cardType.product.juki': '住民基本台帳カード',
    'cardType.product.driverLicense': '運転免許証（IC カード）',
    'cardType.byAtr': '{name}（ATR から推定）',
    'cardType.unknown': '分かりません',

    'cardType.radio.iso14443a': 'ISO/IEC 14443 Type A',
    'cardType.radio.iso14443b': 'ISO/IEC 14443 Type B',
    'cardType.radio.felica': 'FeliCa（JIS X 6319-4）',
    'cardType.radio.iso15693': 'ISO/IEC 15693',
    'cardType.radio.guessed': '{radio}（推定）',
    'cardType.radio.nfcType': '{radio}・NFC Forum Type {n}',

    'cardType.form.memory': 'メモリのタグ',
    'cardType.form.smartcard': 'IC カード（ISO/IEC 14443-4）',

    'cardType.state.named': '{name}・未対応',
    'cardType.short.smartcard': 'IC カード',

    'cardType.title.smartcard': 'IC カードには対応していません',
    'cardType.why.smartcard':
      'IC カード（マイナンバーカード・運転免許証・クレジットカード・パスポートなど）は、中身を暗号で守っています。このアプリは IC カードを読み書きしません。置かれたときに読むのは UID だけで、ほかのコマンドは送りません。',
    'cardType.why.felica': 'FeliCa Lite-S 以外の FeliCa（交通系 IC カード・電子マネー・社員証など）には対応していません。',
    'cardType.hint.smartcard': 'IC カードは読み書きしません（UID だけを読みます）。',
    'cardType.atrHint': 'ATR は、タグや IC カードの種類ごとに決まった識別の値です。種類を調べるときに使えます。',
  },
  en: {
    'cardType.label.card': 'Product',
    'cardType.label.radio': 'Standard',
    'cardType.label.form': 'Type',
    'cardType.label.atr': 'ATR',

    'cardType.product.type2': 'NTAG / MIFARE Ultralight family',
    'cardType.product.ultralightC': 'MIFARE Ultralight C',
    'cardType.product.mifareClassic1k': 'MIFARE Classic 1K',
    'cardType.product.mifareClassic4k': 'MIFARE Classic 4K',
    'cardType.product.mifareMini': 'MIFARE Mini',
    'cardType.product.topaz': 'Topaz (Jewel)',
    'cardType.product.felica': 'FeliCa',
    'cardType.product.mynumber': 'My Number Card (Japanese Individual Number Card)',
    'cardType.product.juki': 'Basic Resident Registration Card (Japan)',
    'cardType.product.driverLicense': 'Japanese driving licence (IC card)',
    'cardType.byAtr': '{name} (inferred from the ATR)',
    'cardType.unknown': 'Unknown',

    'cardType.radio.iso14443a': 'ISO/IEC 14443 Type A',
    'cardType.radio.iso14443b': 'ISO/IEC 14443 Type B',
    'cardType.radio.felica': 'FeliCa (JIS X 6319-4)',
    'cardType.radio.iso15693': 'ISO/IEC 15693',
    'cardType.radio.guessed': '{radio} (inferred)',
    'cardType.radio.nfcType': '{radio} · NFC Forum Type {n}',

    'cardType.form.memory': 'Memory tag',
    'cardType.form.smartcard': 'IC card (ISO/IEC 14443-4)',

    'cardType.state.named': '{name} · unsupported',
    'cardType.short.smartcard': 'IC card',

    'cardType.title.smartcard': 'IC cards are not supported',
    'cardType.why.smartcard':
      'IC cards (My Number Card, driving licence, credit cards, passports, …) protect their contents with cryptography. This app does not read or write IC cards. When one is placed, only its UID is read; no other command is sent.',
    'cardType.why.felica': 'FeliCa products other than FeliCa Lite-S (transit cards, e-money, ID cards, …) are not supported.',
    'cardType.hint.smartcard': 'IC cards are not read or written (only the UID is read).',
    'cardType.atrHint': 'The ATR is an identification value fixed for each type of tag or IC card. It can be used to look up the type.',
  },
});
