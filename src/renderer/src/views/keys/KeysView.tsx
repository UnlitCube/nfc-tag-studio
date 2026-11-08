// MIFARE key management view. Owner: agent renderer-backup.
// Registers operator-held keys and the public standard keys. The app never
// recovers keys (invariant I3) and never shows a stored key value (I4): the
// list shows masked values only; the raw value appears only in the add input.
import { useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, Callout, Card, Field, Page, PageHeader, TextInput } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { api } from '../../lib/api';
import { useT } from '../../i18n';
import type { MifareKeyEntry } from '@shared/types';
import { validateKeyHex, type KeyErrorReason } from './keyform';

type FormError = KeyErrorReason | 'label';

export function KeysView() {
  const t = useT();
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);

  const [keys, setKeys] = useState<MifareKeyEntry[]>([]);
  const [label, setLabel] = useState('');
  const [keyHex, setKeyHex] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [adding, setAdding] = useState(false);

  async function refresh() {
    try {
      setKeys(await api.listKeys());
    } catch (err) {
      toastError(err);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAdd() {
    const labelTrim = label.trim();
    if (!labelTrim) {
      setError('label');
      return;
    }
    const v = validateKeyHex(keyHex);
    if (!v.ok || !v.value) {
      setError(v.reason ?? 'hex');
      return;
    }
    setError(null);
    setAdding(true);
    try {
      await api.addKey({ label: labelTrim, keyHex: v.value });
      setLabel('');
      setKeyHex('');
      await refresh();
      toast({ tone: 'ok', title: t('keys.added') });
    } catch (err) {
      toastError(err);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(entry: MifareKeyEntry) {
    const ok = await confirm({
      title: t('keys.removeConfirmTitle'),
      message: t('keys.removeConfirmBody', { label: entry.label }),
      tone: 'warn',
      confirmLabel: t('keys.remove'),
    });
    if (!ok) return;
    try {
      await api.removeKey(entry.id);
      await refresh();
      toast({ tone: 'ok', title: t('keys.removed') });
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <Page>
      <PageHeader title={t('keys.title')} subtitle={t('keys.subtitle')} helpTopic="keys" />

      <div className="stack-lg">
        <Callout tone="info" icon={ShieldCheck} title={t('keys.explainTitle')}>
          {t('keys.explainBody')}
        </Callout>

        <Card title={t('keys.list.title')} icon={KeyRound}>
          <p className="muted small">{t('keys.maskedNote')}</p>
          <table className="table">
            <thead>
              <tr>
                <th>{t('keys.col.label')}</th>
                <th>{t('keys.col.value')}</th>
                <th>{t('keys.col.type')}</th>
                <th aria-label={t('keys.col.actions')} />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className="mono">{k.masked}</td>
                  <td>
                    {k.builtin ? (
                      <Badge tone="accent" title={t('keys.builtinTitle')}>
                        {t('keys.builtin')}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('keys.custom')}</Badge>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Button
                      icon={Trash2}
                      variant="ghost"
                      size="sm"
                      disabled={k.builtin}
                      title={k.builtin ? t('keys.builtinTitle') : t('keys.remove')}
                      onClick={() => handleRemove(k)}
                    >
                      {t('keys.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title={t('keys.add.title')} icon={Plus}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void handleAdd();
            }}
          >
            <Field label={t('keys.add.label')} htmlFor="key-label" error={error === 'label' ? t('keys.err.label') : undefined}>
              <TextInput
                id="key-label"
                value={label}
                placeholder={t('keys.add.labelPlaceholder')}
                maxLength={60}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (error === 'label') setError(null);
                }}
              />
            </Field>
            <Field
              label={t('keys.add.key')}
              htmlFor="key-hex"
              hint={t('keys.add.keyHint')}
              error={error && error !== 'label' ? t(`keys.err.${error}`) : undefined}
            >
              <TextInput
                id="key-hex"
                mono
                value={keyHex}
                placeholder={t('keys.add.keyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                maxLength={17}
                invalid={!!error && error !== 'label'}
                onChange={(e) => {
                  setKeyHex(e.target.value);
                  if (error && error !== 'label') setError(null);
                }}
              />
            </Field>
            <div className="row">
              <Button type="submit" variant="primary" icon={Plus} loading={adding}>
                {t('keys.add.button')}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </Page>
  );
}
