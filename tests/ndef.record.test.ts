import { describe, expect, it } from 'vitest';
import {
  URI_PREFIXES,
  decodeRaw,
  describeDraft,
  emptyDraft,
  encodeDraft,
  encodeDrafts,
  decodeToDrafts,
  TNF,
  NdefError,
  type NdefRecordDraft,
} from '@shared/ndef';
import { bytesToHex } from '@shared/hex';

const hex = (b: Uint8Array): string => bytesToHex(b);

describe('URI_PREFIXES table', () => {
  it('covers codes 0x00-0x23 with the standard values', () => {
    expect(URI_PREFIXES.length).toBe(0x24);
    expect(URI_PREFIXES[0x00]).toBe('');
    expect(URI_PREFIXES[0x01]).toBe('http://www.');
    expect(URI_PREFIXES[0x02]).toBe('https://www.');
    expect(URI_PREFIXES[0x03]).toBe('http://');
    expect(URI_PREFIXES[0x04]).toBe('https://');
    expect(URI_PREFIXES[0x05]).toBe('tel:');
    expect(URI_PREFIXES[0x06]).toBe('mailto:');
    expect(URI_PREFIXES[0x1d]).toBe('file://');
    expect(URI_PREFIXES[0x23]).toBe('urn:nfc:');
  });
});

describe('URI record', () => {
  it('abbreviates https://www. (0x02) and keeps the exact bytes', () => {
    const raw = encodeDraft({ kind: 'uri', uri: 'https://www.example.com' });
    expect(raw.tnf).toBe(TNF.WELL_KNOWN);
    expect(hex(raw.type)).toBe('55'); // 'U'
    expect(hex(raw.payload)).toBe('02' + hex(Uint8Array.from([...'example.com'].map((c) => c.charCodeAt(0)))));
    // full single-record message
    expect(hex(encodeDrafts([{ kind: 'uri', uri: 'https://www.example.com' }]))).toBe(
      'D1010C550265' + '78616D706C652E636F6D',
    );
  });

  it('picks the longest matching prefix: https:// (0x04) vs https://www. (0x02)', () => {
    expect(encodeDraft({ kind: 'uri', uri: 'https://example.com' }).payload[0]).toBe(0x04);
    expect(encodeDraft({ kind: 'uri', uri: 'https://www.a.test' }).payload[0]).toBe(0x02);
    expect(encodeDraft({ kind: 'uri', uri: 'ftp://ftp.example.org' }).payload[0]).toBe(0x08);
  });

  it('uses code 0x00 for an unknown scheme', () => {
    const raw = encodeDraft({ kind: 'uri', uri: 'customscheme:foo' });
    expect(raw.payload[0]).toBe(0x00);
  });

  it('round-trips', () => {
    for (const uri of ['https://www.example.com', 'tel:+81312345678', 'mailto:a@b.jp', 'customscheme:xyz', '']) {
      const d = decodeRaw(encodeDraft({ kind: 'uri', uri }));
      expect(d).toEqual({ kind: 'uri', uri });
    }
  });
});

describe('Text record', () => {
  it('encodes language code + UTF-8 (known bytes)', () => {
    const raw = encodeDraft({ kind: 'text', text: 'hello', lang: 'en', encoding: 'utf8' });
    expect(hex(raw.type)).toBe('54'); // 'T'
    expect(hex(raw.payload)).toBe('02656E68656C6C6F'); // status 0x02, 'en', 'hello'
  });

  it('round-trips UTF-8 and UTF-16 incl. multibyte', () => {
    const cases: NdefRecordDraft[] = [
      { kind: 'text', text: 'hello', lang: 'en', encoding: 'utf8' },
      { kind: 'text', text: 'こんにちは', lang: 'ja', encoding: 'utf8' },
      { kind: 'text', text: 'かな漢字', lang: 'ja', encoding: 'utf16' },
      { kind: 'text', text: '😀 emoji', lang: 'en', encoding: 'utf16' },
    ];
    for (const d of cases) expect(decodeRaw(encodeDraft(d))).toEqual(d);
  });

  it('sets the UTF-16 status bit', () => {
    const raw = encodeDraft({ kind: 'text', text: 'x', lang: 'en', encoding: 'utf16' });
    expect(raw.payload[0] & 0x80).toBe(0x80);
  });

  it('rejects an over-long language code', () => {
    expect(() => encodeDraft({ kind: 'text', text: 'x', lang: 'a'.repeat(64), encoding: 'utf8' })).toThrow(NdefError);
  });
});

describe('Wi-Fi record (WPS Credential)', () => {
  it('builds application/vnd.wfa.wsc with a Credential attribute', () => {
    const raw = encodeDraft({
      kind: 'wifi',
      ssid: 'MyNet',
      auth: 'wpa2-personal',
      encryption: 'aes',
      password: 'secret123',
      hidden: false,
    });
    expect(raw.tnf).toBe(TNF.MIME);
    expect([...raw.type].map((c) => String.fromCharCode(c)).join('')).toBe('application/vnd.wfa.wsc');
    expect(hex(raw.payload).startsWith('100E')).toBe(true); // Credential (0x100E)
    // SSID attribute 0x1045, length 5, "MyNet"
    expect(hex(raw.payload).includes('104500054D794E6574')).toBe(true);
    // Auth type 0x1003 len2 val 0x0020, Encryption 0x100F len2 val 0x0008
    expect(hex(raw.payload).includes('100300020020')).toBe(true);
    expect(hex(raw.payload).includes('100F00020008')).toBe(true);
  });

  it('round-trips all auth/encryption combinations', () => {
    const auths = ['open', 'wpa-personal', 'wpa2-personal', 'wpa-wpa2-personal', 'wpa3-personal'] as const;
    const encs = ['none', 'tkip', 'aes', 'aes-tkip'] as const;
    for (const auth of auths) {
      for (const encryption of encs) {
        const d: NdefRecordDraft = { kind: 'wifi', ssid: 'Net-漢字', auth, encryption, password: 'pw!', hidden: false };
        expect(decodeRaw(encodeDraft(d))).toEqual(d);
      }
    }
  });

  it('rejects an empty SSID', () => {
    expect(() =>
      encodeDraft({ kind: 'wifi', ssid: '', auth: 'open', encryption: 'none', password: '', hidden: false }),
    ).toThrow(NdefError);
  });
});

describe('vCard record', () => {
  it('encodes text/vcard and round-trips the exposed fields', () => {
    const d: NdefRecordDraft = {
      kind: 'vcard',
      fields: {
        name: '山田 太郎',
        org: 'UnlitCube',
        title: '事務',
        tel: '+81-3-1234-5678',
        email: 'taro@example.jp',
        url: 'https://example.jp',
        address: '東京都千代田区1-2-3',
        note: 'メモ; など, 色々',
      },
    };
    const raw = encodeDraft(d);
    expect(raw.tnf).toBe(TNF.MIME);
    expect([...raw.type].map((c) => String.fromCharCode(c)).join('')).toBe('text/vcard');
    expect(decodeRaw(raw)).toEqual(d);
  });

  it('round-trips a name-only card', () => {
    const d: NdefRecordDraft = { kind: 'vcard', fields: { name: 'Alice' } };
    expect(decodeRaw(encodeDraft(d))).toEqual(d);
  });

  it('rejects a card with no name', () => {
    expect(() => encodeDraft({ kind: 'vcard', fields: { name: '' } })).toThrow(NdefError);
  });
});

describe('MIME / AAR / external / smartposter / raw / empty', () => {
  it('mime with text payload round-trips as text', () => {
    const d: NdefRecordDraft = { kind: 'mime', mimeType: 'application/json', payloadText: '{"a":1}', payloadHex: '' };
    expect(decodeRaw(encodeDraft(d))).toEqual(d);
  });

  it('mime with binary payload round-trips as hex', () => {
    const d: NdefRecordDraft = { kind: 'mime', mimeType: 'application/octet-stream', payloadText: '', payloadHex: '00FF10' };
    const back = decodeRaw(encodeDraft(d));
    expect(back).toEqual({ kind: 'mime', mimeType: 'application/octet-stream', payloadText: '', payloadHex: '00FF10' });
  });

  it('AAR encodes android.com:pkg as External and round-trips', () => {
    const raw = encodeDraft({ kind: 'aar', packageName: 'com.example.app' });
    expect(raw.tnf).toBe(TNF.EXTERNAL);
    expect([...raw.type].map((c) => String.fromCharCode(c)).join('')).toBe('android.com:pkg');
    expect([...raw.payload].map((c) => String.fromCharCode(c)).join('')).toBe('com.example.app');
    expect(decodeRaw(raw)).toEqual({ kind: 'aar', packageName: 'com.example.app' });
  });

  it('external type round-trips (text and hex payloads)', () => {
    const t: NdefRecordDraft = { kind: 'external', domainType: 'example.com:employee', payloadText: 'E-42', payloadHex: '' };
    const b: NdefRecordDraft = { kind: 'external', domainType: 'example.com:bin', payloadText: '', payloadHex: 'DEADBEEF' };
    expect(decodeRaw(encodeDraft(t))).toEqual(t);
    expect(decodeRaw(encodeDraft(b))).toEqual(b);
  });

  it('rejects an external type without a colon', () => {
    expect(() => encodeDraft({ kind: 'external', domainType: 'nocolon', payloadText: 'x', payloadHex: '' })).toThrow(
      NdefError,
    );
  });

  it('smartposter nests a URI + title (Sp) and round-trips', () => {
    const d: NdefRecordDraft = { kind: 'smartposter', uri: 'https://example.com', title: 'Example', lang: 'en' };
    const raw = encodeDraft(d);
    expect(raw.tnf).toBe(TNF.WELL_KNOWN);
    expect(hex(raw.type)).toBe('5370'); // 'Sp'
    expect(decodeRaw(raw)).toEqual(d);
  });

  it('raw round-trips byte-exact for an unrecognised record', () => {
    const d: NdefRecordDraft = { kind: 'raw', tnf: TNF.UNKNOWN, typeHex: '', idHex: 'A1B2', payloadHex: '0102030405' };
    const raw = encodeDraft(d);
    expect(hex(raw.id)).toBe('A1B2');
    expect(decodeRaw(raw)).toEqual(d);
  });

  it('empty record round-trips', () => {
    const raw = encodeDraft({ kind: 'empty' });
    expect(raw.tnf).toBe(TNF.EMPTY);
    expect(raw.payload.length).toBe(0);
    expect(decodeRaw(raw)).toEqual({ kind: 'empty' });
  });

  it('invalid raw hex (odd digit count) throws NdefError', () => {
    expect(() => encodeDraft({ kind: 'raw', tnf: 1, typeHex: 'ABC', idHex: '', payloadHex: '' })).toThrow(NdefError);
  });
});

describe('describeDraft / emptyDraft', () => {
  it('summarises each kind in ja and en', () => {
    expect(describeDraft({ kind: 'uri', uri: 'https://x' }, 'ja')).toContain('https://x');
    expect(describeDraft({ kind: 'empty' }, 'ja')).toBe('空レコード');
    expect(describeDraft({ kind: 'empty' }, 'en')).toBe('Empty record');
    expect(describeDraft({ kind: 'aar', packageName: 'p' }, 'en')).toContain('p');
  });

  it('emptyDraft returns an encodable-shaped draft for every kind', () => {
    const kinds: NdefRecordDraft['kind'][] = [
      'uri',
      'text',
      'wifi',
      'vcard',
      'mime',
      'aar',
      'external',
      'smartposter',
      'raw',
      'empty',
    ];
    for (const k of kinds) {
      const d = emptyDraft(k);
      expect(d.kind).toBe(k);
    }
  });
});

describe('encodeDrafts / decodeToDrafts', () => {
  it('empty draft list yields the empty-record message D0 00 00', () => {
    expect(hex(encodeDrafts([]))).toBe('D00000');
  });

  it('round-trips a multi-record document', () => {
    const drafts: NdefRecordDraft[] = [
      { kind: 'text', text: 'Title', lang: 'en', encoding: 'utf8' },
      { kind: 'uri', uri: 'https://example.com' },
    ];
    expect(decodeToDrafts(encodeDrafts(drafts))).toEqual(drafts);
  });
});
