// Settings. Owner: agent "shell-ui".
// The reader card says which reader is ACTUALLY used, why (activeReason) and its
// transport, and never hides a selected-but-missing reader behind "Automatic"
// (2026-11-12 UX audit CARD-14, FIRST-24).
//
// D10 (2026-11-12 review R-UX-7): a device that is not detected as an NFC reader
// (USB token, YubiKey...) can still be chosen - the detection is a guess from the
// name - but only after a warn confirmation, because the app then sends it
// identification commands. While such a device is selected, a note says so.
// R-UX-9: when home sent the operator here to choose the reader, the reader card
// offers "back to Read" (ResolveReturn).
import { useEffect, useState } from 'react';
import { BookOpenCheck, CircleHelp, Monitor, RefreshCw, Settings as SettingsIcon, Usb } from 'lucide-react';
import type { AppInfo } from '@shared/api';
import type { ActiveReaderReason, LanguageSetting, ReaderDriverMode, ThemeSetting } from '@shared/types';
import { Button, Callout, Card, Field, KeyValue, Page, PageHeader, Segmented, Select, Switch } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { api } from '../../lib/api';
import { activeReaderInfo } from '../../lib/readerState';
import { useReaderActions } from '../../components/shell/readerActions';
import { openOnboarding } from '../../components/shell/Onboarding';
import { ResolveReturn } from '../../components/shell/ResolveReturn';
import { isNotNfcDevice, needsNotNfcConfirm, readerOptions } from './readerOptions';

const REASON_KEY: Record<ActiveReaderReason, MsgKey> = {
  selected: 'settings.reason.selected',
  'selected-missing': 'settings.reason.selectedMissing',
  'auto-virtual': 'settings.reason.autoVirtual',
  'auto-card': 'settings.reason.autoCard',
  'auto-first': 'settings.reason.autoFirst',
  none: 'settings.reason.none',
};

export function SettingsView() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const reader = useAppStore((s) => s.reader);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setView = useAppStore((s) => s.setView);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);
  const actions = useReaderActions();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api.getAppInfo().then(setInfo).catch(() => {});
  }, []);

  const selected = reader?.selectedReader ?? settings.preferredReader ?? null;
  const active = activeReaderInfo(reader);
  const reason = reader?.activeReason ?? 'none';
  const card = reader?.card ?? null;

  const activeText = active ? (active.virtual ? t('settings.reader.virtual') : active.name) : t('settings.reader.activeNone');
  // The tag's transport when a tag is on the reader, else what main resolved for the active reader (D11).
  const drv = card?.driver ?? reader?.activeDriver ?? null;
  const driverText = drv
    ? t(drv === 'acr122' ? 'settings.resolved.acr122' : drv === 'transparent' ? 'settings.resolved.transparent' : 'settings.resolved.storage')
    : t('settings.reader.driverNoTag');

  async function chooseReader(name: string) {
    const value = name || null;
    if (needsNotNfcConfirm(reader, value, selected)) {
      const ok = await confirm({
        title: t('settings.reader.notNfcConfirm.title'),
        message: t('settings.reader.notNfcConfirm.body', { name: value ?? '' }),
        confirmLabel: t('settings.reader.notNfcConfirm.ok'),
        tone: 'warn',
      });
      // Cancelled: the <select> is controlled, so it stays on the current choice.
      if (!ok) return;
    }
    void saveSettings((s) => ({ ...s, preferredReader: value }));
    api.selectReader(value).catch(toastError);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await actions.refresh({ notify: true });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Page>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} helpTopic="reader" />

      <Card
        title={t('settings.reader')}
        icon={Usb}
        actions={
          <Button size="sm" icon={RefreshCw} onClick={refresh} loading={refreshing} data-testid="settings-refresh">
            {t('settings.refresh')}
          </Button>
        }
      >
        <div className="stack" data-testid="settings-reader">
          {reason === 'selected-missing' && selected ? (
            <Callout tone="warn" title={t('settings.reader.missingTitle')}>
              <div className="stack">
                <span>{t('settings.reader.missingBody', { name: selected })}</span>
                <div className="row">
                  <Button size="sm" variant="primary" onClick={() => void actions.backToAuto()} data-testid="settings-back-to-auto">
                    {t('settings.reader.backToAuto')}
                  </Button>
                </div>
              </div>
            </Callout>
          ) : null}
          <KeyValue
            items={[
              [t('settings.reader.active'), <span key="a" data-testid="settings-active-reader">{activeText}</span>],
              [t('settings.reader.reason'), <span key="r" data-testid="settings-active-reason" data-reason={reason}>{t(REASON_KEY[reason])}</span>],
              [t('settings.reader.driver'), driverText],
            ]}
          />
          <Field label={t('settings.selectReader')} hint={t('settings.reader.autoHint')}>
            <Select<string>
              value={selected ?? ''}
              onChange={(name) => void chooseReader(name)}
              options={readerOptions(t, reader, selected)}
              data-testid="settings-select-reader"
            />
          </Field>
          {selected && isNotNfcDevice(reader, selected) ? (
            <Callout tone="warn" title={t('settings.reader.notNfcSelectedTitle')}>
              <div className="stack" data-testid="settings-not-nfc-selected">
                <span>{t('settings.reader.notNfcSelectedBody', { name: selected })}</span>
                <div className="row">
                  <Button size="sm" onClick={() => void actions.backToAuto()}>
                    {t('settings.reader.backToAuto')}
                  </Button>
                </div>
              </div>
            </Callout>
          ) : null}
          <Field label={t('settings.driverMode')} hint={t('settings.driver.hint')}>
            <Select<ReaderDriverMode>
              value={settings.driverMode}
              onChange={(driverMode) => {
                void saveSettings((s) => ({ ...s, driverMode }));
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
          <p className="field-hint">{t('settings.refresh.hint')}</p>
          <ResolveReturn view="settings" />
        </div>
      </Card>

      <Card title={t('settings.behavior')} icon={SettingsIcon}>
        <div className="stack">
          <Switch
            checked={settings.autoRead}
            onChange={(autoRead) => void saveSettings((s) => ({ ...s, autoRead }))}
            label={t('settings.autoRead')}
          />
          <p className="field-hint">{t('settings.autoRead.hint')}</p>
          <Switch
            checked={settings.confirmBeforeWrite}
            onChange={(confirmBeforeWrite) => void saveSettings((s) => ({ ...s, confirmBeforeWrite }))}
            label={t('settings.confirmWrite')}
          />
          <p className="field-hint">{t('settings.confirmWrite.hint')}</p>
          <Switch
            checked={settings.advancedMode}
            onChange={(advancedMode) => void saveSettings((s) => ({ ...s, advancedMode }))}
            label={t('settings.advanced')}
          />
          <p className="field-hint">{t('settings.advanced.hint')}</p>
        </div>
      </Card>

      <Card title={t('settings.appearance')} icon={Monitor}>
        <div className="stack">
          <Field label={t('settings.theme')}>
            <Segmented<ThemeSetting>
              ariaLabel={t('settings.theme')}
              value={settings.theme}
              onChange={(theme) => void saveSettings((s) => ({ ...s, theme }))}
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
              onChange={(language) => void saveSettings((s) => ({ ...s, language }))}
              options={[
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Field>
          <Switch checked={settings.sound} onChange={(sound) => void saveSettings((s) => ({ ...s, sound }))} label={t('settings.sound')} />
          <p className="field-hint">{t('settings.sound.hint')}</p>
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
            <Button icon={BookOpenCheck} onClick={openOnboarding} data-testid="settings-open-guide">
              {t('settings.openGuide')}
            </Button>
          </div>
        </div>
      </Card>
    </Page>
  );
}
