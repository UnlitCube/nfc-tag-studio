// Settings. Owner: agent "shell-ui".
import { useEffect, useState } from 'react';
import { CircleHelp, Monitor, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import type { AppInfo } from '@shared/api';
import type { LanguageSetting, ReaderDriverMode, ThemeSetting } from '@shared/types';
import { Button, Card, Field, KeyValue, Page, PageHeader, Segmented, Select, Switch } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { api } from '../../lib/api';

export function SettingsView() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const reader = useAppStore((s) => s.reader);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setView = useAppStore((s) => s.setView);
  const toastError = useAppStore((s) => s.toastError);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    api.getAppInfo().then(setInfo).catch(() => {});
  }, []);

  const readerOptions = [
    { value: '', label: t('settings.reader.auto') },
    ...(reader?.readers.filter((r) => !r.virtual).map((r) => ({ value: r.name, label: r.name })) ?? []),
  ];

  return (
    <Page>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} helpTopic="reader" />

      <Card title={t('settings.appearance')} icon={Monitor}>
        <div className="stack">
          <Field label={t('settings.theme')}>
            <Segmented<ThemeSetting>
              ariaLabel={t('settings.theme')}
              value={settings.theme}
              onChange={(theme) => saveSettings((s) => ({ ...s, theme }))}
              options={[
                { value: 'system', label: t('settings.theme.system') },
                { value: 'light', label: t('settings.theme.light') },
                { value: 'dark', label: t('settings.theme.dark') },
              ]}
            />
          </Field>
          <Field label={t('settings.language')}>
            <Segmented<LanguageSetting>
              ariaLabel={t('settings.language')}
              value={settings.language}
              onChange={(language) => saveSettings((s) => ({ ...s, language }))}
              options={[
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Field>
          <Switch
            checked={settings.sound}
            onChange={(sound) => saveSettings((s) => ({ ...s, sound }))}
            label={t('settings.sound')}
          />
          <p className="field-hint">{t('settings.sound.hint')}</p>
        </div>
      </Card>

      <Card title={t('settings.behavior')} icon={SettingsIcon}>
        <div className="stack">
          <Switch
            checked={settings.confirmBeforeWrite}
            onChange={(confirmBeforeWrite) => saveSettings((s) => ({ ...s, confirmBeforeWrite }))}
            label={t('settings.confirmWrite')}
          />
          <p className="field-hint">{t('settings.confirmWrite.hint')}</p>
          <Switch
            checked={settings.advancedMode}
            onChange={(advancedMode) => saveSettings((s) => ({ ...s, advancedMode }))}
            label={t('settings.advanced')}
          />
          <p className="field-hint">{t('settings.advanced.hint')}</p>
        </div>
      </Card>

      <Card
        title={t('settings.reader')}
        actions={
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={() => api.refreshReaders().catch(toastError)}
          >
            {t('settings.refresh')}
          </Button>
        }
      >
        <div className="stack">
          <Field label={t('settings.selectReader')}>
            <Select<string>
              value={settings.preferredReader ?? ''}
              onChange={(name) => {
                const value = name || null;
                saveSettings((s) => ({ ...s, preferredReader: value }));
                api.selectReader(value).catch(toastError);
              }}
              options={readerOptions}
            />
          </Field>
          <Field label={t('settings.driverMode')} hint={t('settings.driver.hint')}>
            <Select<ReaderDriverMode>
              value={settings.driverMode}
              onChange={(driverMode) => {
                saveSettings((s) => ({ ...s, driverMode }));
                api.setDriverMode(driverMode).catch(toastError);
              }}
              options={[
                { value: 'auto', label: t('settings.driver.auto') },
                { value: 'acr122', label: t('settings.driver.acr122') },
                { value: 'transparent', label: t('settings.driver.transparent') },
                { value: 'storage', label: t('settings.driver.storage') },
              ]}
            />
          </Field>
        </div>
      </Card>

      <Card title={t('settings.about')} icon={CircleHelp}>
        <div className="stack">
          <KeyValue
            items={[
              [t('settings.version'), info?.version ?? '—'],
              ['Electron', info?.electron ?? '—'],
              ['Chromium', info?.chrome ?? '—'],
              ['Node', info?.node ?? '—'],
              [t('settings.license'), 'MIT'],
            ]}
          />
          <div className="row">
            <Button icon={CircleHelp} onClick={() => setView('help', { helpTopic: 'start' })}>
              {t('settings.openHelp')}
            </Button>
          </div>
        </div>
      </Card>
    </Page>
  );
}
