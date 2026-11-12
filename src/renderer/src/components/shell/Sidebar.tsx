// Left navigation. Owner: agent "shell-ui".
// Grouped by intent, in the order of the work (2026-11-12 UX audit FIRST-15):
//   read & edit one tag (read -> NDEF / binary editor -> backup), batch issue, manage.
// Every item has a short second line and a tooltip that explain the jargon
// (NDEF, binary, schema, MIFARE keys). data-testid="nav-<view>" is used by E2E.
import type { LucideIcon } from 'lucide-react';
import { Archive, BookOpen, Binary, CircleHelp, FileCode2, KeyRound, ListChecks, Nfc, ScanLine, Settings, Stamp } from 'lucide-react';
import { useAppStore, dirtyUnits } from '../../store/app';
import type { ViewId } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';

interface NavItem {
  id: ViewId;
  icon: LucideIcon;
}

type NavGroup = { label: MsgKey; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'shell.nav.group.tag',
    items: [
      { id: 'home', icon: ScanLine },
      { id: 'ndef', icon: FileCode2 },
      { id: 'hex', icon: Binary },
      { id: 'backup', icon: Archive },
    ],
  },
  {
    label: 'shell.nav.group.batch',
    items: [
      { id: 'issue', icon: Stamp },
      { id: 'schema', icon: ListChecks },
      { id: 'log', icon: BookOpen },
    ],
  },
  {
    label: 'shell.nav.group.manage',
    items: [{ id: 'keys', icon: KeyRound }],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { id: 'help', icon: CircleHelp },
  { id: 'settings', icon: Settings },
];

/** Display name of a screen (also used by help's "back to ..."). */
export function navLabelKey(id: ViewId): MsgKey {
  return `shell.nav.${id}` as MsgKey;
}

export function Sidebar() {
  const t = useT();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const issueRunning = useAppStore((s) => s.issue.running);
  const dirty = useAppStore((s) => dirtyUnits(s.doc).length > 0);

  const item = ({ id, icon: Icon }: NavItem) => {
    const showDirty = id === 'hex' && dirty;
    const showLive = id === 'issue' && issueRunning;
    return (
      <button
        key={id}
        type="button"
        className="nav-item"
        aria-current={view === id ? 'page' : undefined}
        onClick={() => setView(id)}
        data-testid={`nav-${id}`}
        title={t(`shell.nav.${id}.tip` as MsgKey)}
      >
        <Icon size={17} aria-hidden />
        <span className="nav-item-text grow">
          <span className="nav-item-label">{t(navLabelKey(id))}</span>
          <span className="nav-item-desc">{t(`shell.nav.${id}.desc` as MsgKey)}</span>
        </span>
        {showDirty ? (
          <span className="nav-dirty" role="img" aria-label={t('shell.nav.dirty')} title={t('shell.nav.dirty')} data-testid="nav-dirty" />
        ) : null}
        {showLive ? <span className="nav-live" role="img" aria-label={t('shell.nav.issueRunning')} title={t('shell.nav.issueRunning')} /> : null}
      </button>
    );
  };

  return (
    <nav className="app-nav" aria-label={t('shell.nav.label')}>
      <div className="nav-brand">
        <span className="nav-logo">
          <Nfc size={18} aria-hidden />
        </span>
        <span className="nav-brand-name">{t('app.name')}</span>
      </div>
      <div className="nav-scroll">
        {NAV_GROUPS.map((g) => (
          <div key={g.label} className="nav-group">
            <div className="nav-group-label">{t(g.label)}</div>
            {g.items.map(item)}
          </div>
        ))}
      </div>
      <div className="nav-footer">{NAV_FOOTER.map(item)}</div>
    </nav>
  );
}
