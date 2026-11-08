// Per-kind NDEF record forms. Owner: agent renderer-ndef.
// Each kind is its own component so it can keep local UI state (e.g. the
// text/hex payload toggle) without conditional hooks. Pure presentation:
// all encoding lives in @shared/ndef.
import { useState } from 'react';
import type { ChangeEvent, FocusEvent } from 'react';
import type { NdefRecordDraft, Tnf, VcardFields, WifiAuth, WifiEncryption } from '@shared/ndef/types';
import { Field, TextInput, TextArea, Select, Checkbox, Segmented, Callout } from '../../components/ui';
import type { TFunc } from '../../i18n';

/** Props passed to text inputs so the editor can insert placeholders at the caret. */
export type InsertRegister = (set: (value: string) => void) => {
  onFocus: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
};

type DraftOf<K extends NdefRecordDraft['kind']> = Extract<NdefRecordDraft, { kind: K }>;

interface FormProps<K extends NdefRecordDraft['kind']> {
  draft: DraftOf<K>;
  onChange: (next: NdefRecordDraft) => void;
  readOnly: boolean;
  register: InsertRegister;
  t: TFunc;
}

export function RecordForm(props: {
  draft: NdefRecordDraft;
  onChange: (next: NdefRecordDraft) => void;
  readOnly: boolean;
  register: InsertRegister;
  t: TFunc;
}) {
  const { draft } = props;
  switch (draft.kind) {
    case 'uri':
      return <UriForm {...props} draft={draft} />;
    case 'text':
      return <TextForm {...props} draft={draft} />;
    case 'wifi':
      return <WifiForm {...props} draft={draft} />;
    case 'vcard':
      return <VcardForm {...props} draft={draft} />;
    case 'mime':
      return <MimeForm {...props} draft={draft} />;
    case 'aar':
      return <AarForm {...props} draft={draft} />;
    case 'external':
      return <ExternalForm {...props} draft={draft} />;
    case 'smartposter':
      return <SmartposterForm {...props} draft={draft} />;
    case 'raw':
      return <RawForm {...props} draft={draft} />;
    case 'empty':
      return (
        <div className="span-2">
          <Callout tone="info">{props.t('ndef.emptyRecord')}</Callout>
        </div>
      );
  }
}

function UriForm({ draft, onChange, readOnly, register, t }: FormProps<'uri'>) {
  return (
    <Field className="span-2" label={t('ndef.field.uri')} hint={t('ndef.field.uriHint')}>
      <TextInput
        value={draft.uri}
        disabled={readOnly}
        placeholder="https://example.com/"
        {...register((v) => onChange({ ...draft, uri: v }))}
        onChange={(e) => onChange({ ...draft, uri: e.target.value })}
      />
    </Field>
  );
}

function TextForm({ draft, onChange, readOnly, register, t }: FormProps<'text'>) {
  return (
    <>
      <Field className="span-2" label={t('ndef.field.text')}>
        <TextArea
          value={draft.text}
          disabled={readOnly}
          {...register((v) => onChange({ ...draft, text: v }))}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </Field>
      <Field label={t('ndef.field.lang')} hint={t('ndef.field.langHint')}>
        <TextInput
          value={draft.lang}
          disabled={readOnly}
          placeholder="ja"
          onChange={(e) => onChange({ ...draft, lang: e.target.value })}
        />
      </Field>
      <Field label={t('ndef.field.encoding')}>
        <Select<'utf8' | 'utf16'>
          value={draft.encoding}
          disabled={readOnly}
          onChange={(encoding) => onChange({ ...draft, encoding })}
          options={[
            { value: 'utf8', label: t('ndef.enc.utf8') },
            { value: 'utf16', label: t('ndef.enc.utf16') },
          ]}
        />
      </Field>
    </>
  );
}

function WifiForm({ draft, onChange, readOnly, register, t }: FormProps<'wifi'>) {
  const authOptions: { value: WifiAuth; label: string }[] = [
    { value: 'open', label: t('ndef.wifiAuth.open') },
    { value: 'wpa-personal', label: t('ndef.wifiAuth.wpa-personal') },
    { value: 'wpa2-personal', label: t('ndef.wifiAuth.wpa2-personal') },
    { value: 'wpa-wpa2-personal', label: t('ndef.wifiAuth.wpa-wpa2-personal') },
    { value: 'wpa3-personal', label: t('ndef.wifiAuth.wpa3-personal') },
  ];
  const encOptions: { value: WifiEncryption; label: string }[] = [
    { value: 'none', label: t('ndef.wifiEnc.none') },
    { value: 'tkip', label: t('ndef.wifiEnc.tkip') },
    { value: 'aes', label: t('ndef.wifiEnc.aes') },
    { value: 'aes-tkip', label: t('ndef.wifiEnc.aes-tkip') },
  ];
  return (
    <>
      <Field className="span-2" label={t('ndef.field.ssid')} required>
        <TextInput
          value={draft.ssid}
          disabled={readOnly}
          {...register((v) => onChange({ ...draft, ssid: v }))}
          onChange={(e) => onChange({ ...draft, ssid: e.target.value })}
        />
      </Field>
      <Field label={t('ndef.field.auth')}>
        <Select<WifiAuth>
          value={draft.auth}
          disabled={readOnly}
          onChange={(auth) => onChange({ ...draft, auth })}
          options={authOptions}
        />
      </Field>
      <Field label={t('ndef.field.encryption')}>
        <Select<WifiEncryption>
          value={draft.encryption}
          disabled={readOnly}
          onChange={(encryption) => onChange({ ...draft, encryption })}
          options={encOptions}
        />
      </Field>
      <Field label={t('ndef.field.password')}>
        <TextInput
          value={draft.password}
          disabled={readOnly || draft.auth === 'open'}
          {...register((v) => onChange({ ...draft, password: v }))}
          onChange={(e) => onChange({ ...draft, password: e.target.value })}
        />
      </Field>
      <Field label=" ">
        <Checkbox
          checked={draft.hidden}
          disabled={readOnly}
          onChange={(hidden) => onChange({ ...draft, hidden })}
          label={t('ndef.field.hidden')}
        />
      </Field>
    </>
  );
}

function VcardForm({ draft, onChange, readOnly, register, t }: FormProps<'vcard'>) {
  const f = draft.fields;
  const upd = (key: keyof VcardFields, v: string): void => onChange({ ...draft, fields: { ...f, [key]: v } });
  const text = (key: keyof VcardFields) => ({
    value: f[key] ?? '',
    disabled: readOnly,
    ...register((v) => upd(key, v)),
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => upd(key, e.target.value),
  });
  return (
    <>
      <Field className="span-2" label={t('ndef.vcard.name')} required>
        <TextInput {...text('name')} />
      </Field>
      <Field label={t('ndef.vcard.org')}>
        <TextInput {...text('org')} />
      </Field>
      <Field label={t('ndef.vcard.title')}>
        <TextInput {...text('title')} />
      </Field>
      <Field label={t('ndef.vcard.tel')}>
        <TextInput {...text('tel')} />
      </Field>
      <Field label={t('ndef.vcard.email')}>
        <TextInput {...text('email')} />
      </Field>
      <Field label={t('ndef.vcard.url')}>
        <TextInput {...text('url')} />
      </Field>
      <Field label={t('ndef.vcard.address')}>
        <TextInput {...text('address')} />
      </Field>
      <Field className="span-2" label={t('ndef.vcard.note')}>
        <TextArea {...text('note')} />
      </Field>
    </>
  );
}

function MimeForm({ draft, onChange, readOnly, register, t }: FormProps<'mime'>) {
  const [mode, setMode] = useState<'text' | 'hex'>(draft.payloadHex ? 'hex' : 'text');
  return (
    <>
      <Field className="span-2" label={t('ndef.field.mimeType')} required>
        <TextInput
          value={draft.mimeType}
          disabled={readOnly}
          placeholder="application/json"
          onChange={(e) => onChange({ ...draft, mimeType: e.target.value })}
        />
      </Field>
      <Field className="span-2" label={t('ndef.field.payloadMode')}>
        <Segmented<'text' | 'hex'>
          value={mode}
          ariaLabel={t('ndef.field.payloadMode')}
          onChange={(m) => {
            setMode(m);
            if (m === 'text') onChange({ ...draft, payloadHex: '' });
          }}
          options={[
            { value: 'text', label: t('ndef.payloadMode.text') },
            { value: 'hex', label: t('ndef.payloadMode.hex') },
          ]}
        />
      </Field>
      {mode === 'text' ? (
        <Field className="span-2" label={t('ndef.field.payloadText')}>
          <TextArea
            value={draft.payloadText}
            disabled={readOnly}
            {...register((v) => onChange({ ...draft, payloadText: v }))}
            onChange={(e) => onChange({ ...draft, payloadText: e.target.value })}
          />
        </Field>
      ) : (
        <Field className="span-2" label={t('ndef.field.payloadHex')}>
          <TextArea
            mono
            value={draft.payloadHex}
            disabled={readOnly}
            placeholder="48 65 6C 6C 6F"
            onChange={(e) => onChange({ ...draft, payloadHex: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

function AarForm({ draft, onChange, readOnly, t }: FormProps<'aar'>) {
  return (
    <Field className="span-2" label={t('ndef.field.package')} hint={t('ndef.field.packageHint')} required>
      <TextInput
        value={draft.packageName}
        disabled={readOnly}
        placeholder="com.example.app"
        onChange={(e) => onChange({ ...draft, packageName: e.target.value })}
      />
    </Field>
  );
}

function ExternalForm({ draft, onChange, readOnly, register, t }: FormProps<'external'>) {
  const [mode, setMode] = useState<'text' | 'hex'>(draft.payloadHex ? 'hex' : 'text');
  return (
    <>
      <Field className="span-2" label={t('ndef.field.domainType')} hint={t('ndef.field.domainTypeHint')} required>
        <TextInput
          value={draft.domainType}
          disabled={readOnly}
          placeholder="example.com:employee"
          onChange={(e) => onChange({ ...draft, domainType: e.target.value })}
        />
      </Field>
      <Field className="span-2" label={t('ndef.field.payloadMode')}>
        <Segmented<'text' | 'hex'>
          value={mode}
          ariaLabel={t('ndef.field.payloadMode')}
          onChange={(m) => {
            setMode(m);
            if (m === 'text') onChange({ ...draft, payloadHex: '' });
          }}
          options={[
            { value: 'text', label: t('ndef.payloadMode.text') },
            { value: 'hex', label: t('ndef.payloadMode.hex') },
          ]}
        />
      </Field>
      {mode === 'text' ? (
        <Field className="span-2" label={t('ndef.field.payloadText')}>
          <TextArea
            value={draft.payloadText}
            disabled={readOnly}
            {...register((v) => onChange({ ...draft, payloadText: v }))}
            onChange={(e) => onChange({ ...draft, payloadText: e.target.value })}
          />
        </Field>
      ) : (
        <Field className="span-2" label={t('ndef.field.payloadHex')}>
          <TextArea
            mono
            value={draft.payloadHex}
            disabled={readOnly}
            placeholder="01 02 03"
            onChange={(e) => onChange({ ...draft, payloadHex: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

function SmartposterForm({ draft, onChange, readOnly, register, t }: FormProps<'smartposter'>) {
  return (
    <>
      <Field className="span-2" label={t('ndef.field.posterUri')} required>
        <TextInput
          value={draft.uri}
          disabled={readOnly}
          placeholder="https://example.com/"
          {...register((v) => onChange({ ...draft, uri: v }))}
          onChange={(e) => onChange({ ...draft, uri: e.target.value })}
        />
      </Field>
      <Field label={t('ndef.field.posterTitle')}>
        <TextInput
          value={draft.title}
          disabled={readOnly}
          {...register((v) => onChange({ ...draft, title: v }))}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </Field>
      <Field label={t('ndef.field.lang')} hint={t('ndef.field.langHint')}>
        <TextInput
          value={draft.lang}
          disabled={readOnly}
          placeholder="ja"
          onChange={(e) => onChange({ ...draft, lang: e.target.value })}
        />
      </Field>
    </>
  );
}

function RawForm({ draft, onChange, readOnly, t }: FormProps<'raw'>) {
  const tnfOptions = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
    value: String(n),
    label: t(`ndef.tnf.${n}` as 'ndef.tnf.0'),
  }));
  return (
    <>
      <Field label={t('ndef.field.tnf')}>
        <Select<string>
          value={String(draft.tnf)}
          disabled={readOnly}
          onChange={(v) => onChange({ ...draft, tnf: (Number(v) & 7) as Tnf })}
          options={tnfOptions}
        />
      </Field>
      <Field label={t('ndef.field.typeHex')}>
        <TextInput
          mono
          value={draft.typeHex}
          disabled={readOnly}
          placeholder="55"
          onChange={(e) => onChange({ ...draft, typeHex: e.target.value })}
        />
      </Field>
      <Field label={t('ndef.field.idHex')}>
        <TextInput
          mono
          value={draft.idHex}
          disabled={readOnly}
          onChange={(e) => onChange({ ...draft, idHex: e.target.value })}
        />
      </Field>
      <Field className="span-2" label={t('ndef.field.payloadHex')}>
        <TextArea
          mono
          value={draft.payloadHex}
          disabled={readOnly}
          placeholder="00 11 22 33"
          onChange={(e) => onChange({ ...draft, payloadHex: e.target.value })}
        />
      </Field>
    </>
  );
}
