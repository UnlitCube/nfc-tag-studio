// Left navigation. Baseline by the integrator; owner: agent "shell-ui".
import type { LucideIcon } from 'lucide-react';
import { Archive, BookOpen, Binary, CircleHelp, FileCode2, KeyRound, ListChecks, Nfc, ScanLine, Settings, Stamp } from 'lucide-react';
import { useAppStore } from '../../store/app';
import type { ViewId } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';

interface NavItem {
  id: ViewId;
  label: MsgKey;
  icon: LucideIcon;
}

const GROUPS: { label: MsgKey; items: NavItem[] }[] = [
  {
    label: 'nav.group.work',
    items: [
      { id: 'home', label: 'nav.home', icon: ScanLine },
      { id: 'issue', label: 'nav.issue', icon: Stamp },
      { id: 'backup', label: 'nav.backup', icon: Archive },
    ],
  },
  {
    label: 'nav.group.design',
    items: [
      { id: 'ndef', label: 'nav.ndef', icon: FileCode2 },
      { id: 'schema', label: 'nav.schema', icon: ListChecks },
      { id: 'hex', label: 'nav.hex', icon: Binary },
    ],
  },
  {
    label: 'nav.group.manage',
    items: [
      { id: 'log', label: 'nav.log', icon: BookOpen },
      { id: 'keys', label: 'nav.keys', icon: KeyRound },
    ],
  },
];

const FOOTER: NavItem[] = [
  { id: 'help', label: 'nav.help', icon: CircleHelp },
  { id: 'settings', label: 'nav.settings', icon: Settings },
];

export function Sidebar() {
  const t = useT();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const issueRunning = useAppStore((s) => s.issue.running);

  const item = ({ id, label, icon: Icon }: NavItem) => (
    <button
      key={id}
      type="button"
      className="nav-item"
      aria-current={view === id ? 'page' : undefined}
      onClick={() => setView(id)}
      data-testid={`nav-${id}`}
    >
      <Icon size={17} aria-hidden />
      <span className="grow">{t(label)}</span>
      {id === 'issue' && issueRunning ? <span className="nav-live" aria-label="running" /> : null}
    </button>
  );

  return (
    <nav className="app-nav" aria-label="Main">
      <div className="nav-brand">
        <span className="nav-logo">
          <Nfc size={18} aria-hidden />
        </span>
        <span className="nav-brand-name">{t('app.name')}</span>
      </div>
      <div className="nav-scroll">
        {GROUPS.map((g) => (
          <div key={g.label} className="nav-group">
            <div className="nav-group-label">{t(g.label)}</div>
            {g.items.map(item)}
          </div>
        ))}
      </div>
      <div className="nav-footer">{FOOTER.map(item)}</div>
    </nav>
  );
}
