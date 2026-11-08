// App shell: theme, layout, route table. Integrator-owned (hub).
// Views live in views/<feature>/<Name>View.tsx and are owned by feature agents.
import { useEffect } from 'react';
import type { ComponentType } from 'react';
import { useAppStore } from './store/app';
import type { ViewId } from './store/app';
import { Sidebar } from './components/shell/Sidebar';
import { StatusBar } from './components/shell/StatusBar';
import { Onboarding } from './components/shell/Onboarding';
import { useShortcuts } from './components/shell/useShortcuts';
import { Overlays } from './components/Overlays';
import { HomeView } from './views/home/HomeView';
import { IssueView } from './views/issue/IssueView';
import { NdefView } from './views/ndef/NdefView';
import { SchemaView } from './views/schema/SchemaView';
import { HexView } from './views/hex/HexView';
import { BackupView } from './views/backup/BackupView';
import { LogView } from './views/log/LogView';
import { KeysView } from './views/keys/KeysView';
import { HelpView } from './views/help/HelpView';
import { SettingsView } from './views/settings/SettingsView';

const VIEWS: Record<ViewId, ComponentType> = {
  home: HomeView,
  issue: IssueView,
  ndef: NdefView,
  schema: SchemaView,
  hex: HexView,
  backup: BackupView,
  log: LogView,
  keys: KeysView,
  help: HelpView,
  settings: SettingsView,
};

function useTheme() {
  const theme = useAppStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.setAttribute('data-theme', resolved);
      try {
        localStorage.setItem('nfcts-resolved-theme', resolved);
      } catch {
        /* storage unavailable */
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

export function App() {
  const ready = useAppStore((s) => s.ready);
  const initError = useAppStore((s) => s.initError);
  const view = useAppStore((s) => s.view);
  const lang = useAppStore((s) => s.settings.language);
  useTheme();
  useShortcuts();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const View = VIEWS[view];
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main" id="main">
        {!ready ? null : initError ? (
          <div className="page">
            <div className="page-inner">
              <div className="callout callout-danger">
                <div>
                  <div className="callout-title">Failed to start / 起動に失敗しました</div>
                  <div>{initError}</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <View />
        )}
      </main>
      <StatusBar />
      <Onboarding />
      <Overlays />
    </div>
  );
}
