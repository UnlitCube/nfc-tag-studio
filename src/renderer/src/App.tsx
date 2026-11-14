// App shell: theme, layout, route table. Integrator-owned (hub / renderer-core).
// Views live in views/<feature>/<Name>View.tsx and are owned by feature agents.
//
// Keep-alive (2026-11-12 UX audit FLOW-12 / FIRST-8 / ISSUE-11, D3): a view
// that was opened once stays mounted and is only hidden, so moving to another
// screen (or to help) never throws away work in progress - NDEF records being
// composed, issue settings, the backup target. Views learn whether they are on
// screen from useViewActive() (lib/viewActive.ts) and do "on show" work there.
import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { hasUnsavedWork, useAppStore } from './store/app';
import type { ViewId } from './store/app';
import { Sidebar } from './components/shell/Sidebar';
import { StatusBar } from './components/shell/StatusBar';
import { Onboarding } from './components/shell/Onboarding';
import { useShortcuts } from './components/shell/useShortcuts';
import { Overlays } from './components/Overlays';
import { ViewActiveContext } from './lib/viewActive';
import { useAutoRead } from './lib/autoRead';
import { useT } from './i18n';
import { HomeView } from './views/home/HomeView';
import { IssueView } from './views/issue/IssueView';
import { NdefView } from './views/ndef/NdefView';
import { SchemaView } from './views/schema/SchemaView';
import { HexView } from './views/hex/HexView';
import { BackupView } from './views/backup/BackupView';
import { EraseView } from './views/erase/EraseView';
import { FactoryView } from './views/factory/FactoryView';
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
  erase: EraseView,
  factory: FactoryView,
  log: LogView,
  keys: KeysView,
  help: HelpView,
  settings: SettingsView,
};

/** Stable DOM order of the kept-alive views (does not depend on the order they were opened). */
const VIEW_ORDER = Object.keys(VIEWS) as ViewId[];

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

/**
 * WALK-13: closing the window with unsaved edits must not lose them silently.
 * The renderer only cancels the unload while there is unsaved work; main
 * (webContents 'will-prevent-unload') asks "discard and quit / cancel".
 */
function useUnloadGuard() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(useAppStore.getState())) return;
      e.preventDefault();
      // Electron cancels the close when returnValue is set (no browser prompt).
      e.returnValue = true;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

function InitError({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="page">
      <div className="page-inner">
        <div className="callout callout-danger" role="alert">
          <div className="grow">
            <div className="callout-title">{t('app.initError.title')}</div>
            <div>{t('app.initError.hint')}</div>
            <details className="init-error-technical">
              <summary>{t('common.technical')}</summary>
              <code>{message}</code>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const ready = useAppStore((s) => s.ready);
  const initError = useAppStore((s) => s.initError);
  const view = useAppStore((s) => s.view);
  const lang = useAppStore((s) => s.settings.language);
  useTheme();
  useShortcuts();
  useAutoRead();
  useUnloadGuard();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Views opened so far (kept mounted). Updated during render so the newly
  // selected view appears in the same frame (no blank flash).
  const [opened, setOpened] = useState<ViewId[]>([view]);
  if (!opened.includes(view)) setOpened([...opened, view]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main" id="main">
        {!ready ? null : initError ? (
          <InitError message={initError} />
        ) : (
          VIEW_ORDER.filter((id) => id === view || opened.includes(id)).map((id) => {
            const View = VIEWS[id];
            const active = id === view;
            return (
              <ViewActiveContext.Provider key={id} value={active}>
                <div className="view-pane" data-view={id} hidden={!active}>
                  <View />
                </div>
              </ViewActiveContext.Provider>
            );
          })
        )}
      </main>
      <StatusBar />
      <Onboarding />
      <Overlays />
    </div>
  );
}
