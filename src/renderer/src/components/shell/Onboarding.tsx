// First-run guide. Owner: agent "shell-ui".
// Shows "first things to do" (connect -> keep the tag on the reader -> edit and
// write) plus the safety notes. It opens on the first start and again from Help /
// Settings ("show the first-run guide again", 2026-11-12 UX audit FIRST-23).
import { useSyncExternalStore } from 'react';
import { CreditCard, Nfc, PenLine, ScanLine, ShieldCheck, Usb } from 'lucide-react';
import { Button, Modal } from '../ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';

// "Open again" without touching settings.onboardingDone (the first-run flag stays set).
let reopened = false;
const listeners = new Set<() => void>();
function setReopened(v: boolean): void {
  reopened = v;
  for (const l of listeners) l();
}

/** Open the first-run guide again (Help / Settings). */
export function openOnboarding(): void {
  setReopened(true);
}

function useReopened(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => reopened,
  );
}

export function Onboarding() {
  const t = useT();
  const ready = useAppStore((s) => s.ready);
  const done = useAppStore((s) => s.settings.onboardingDone);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setView = useAppStore((s) => s.setView);
  const again = useReopened();

  const open = ready && (!done || again);
  const close = () => {
    setReopened(false);
    if (!done) void saveSettings((s) => ({ ...s, onboardingDone: true }));
  };
  const openHelp = () => {
    close();
    setView('help', { helpTopic: 'start' });
  };

  const first = [
    { icon: Usb, title: t('onboarding.first.connect.title'), body: t('onboarding.first.connect.body') },
    { icon: ScanLine, title: t('onboarding.first.place.title'), body: t('onboarding.first.place.body') },
    { icon: PenLine, title: t('onboarding.first.edit.title'), body: t('onboarding.first.edit.body') },
  ];
  const notes = [
    { icon: CreditCard, title: t('onboarding.p1.title'), body: t('onboarding.p1.body') },
    { icon: ShieldCheck, title: t('onboarding.p2.title'), body: t('onboarding.p2.body') },
  ];

  return (
    <Modal
      open={open}
      title={t('onboarding.title')}
      icon={Nfc}
      onClose={close}
      dismissible={!!done}
      size="lg"
      footer={
        <>
          <Button onClick={openHelp}>{t('onboarding.openHelp')}</Button>
          <Button variant="primary" onClick={close} data-autofocus>
            {t('onboarding.start')}
          </Button>
        </>
      }
    >
      <div className="stack-lg" data-testid="onboarding">
        <p>{t('onboarding.body')}</p>
        <section className="stack">
          <h3 className="onb-heading">{t('onboarding.first.title')}</h3>
          <ul className="onb-steps">
            {first.map(({ icon: Icon, title, body }) => (
              <li className="onb-step" key={title}>
                <span className="onb-step-icon">
                  <Icon size={18} aria-hidden />
                </span>
                <div className="grow">
                  <div className="onb-step-title">{title}</div>
                  <div className="small">{body}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="stack">
          <h3 className="onb-heading">{t('onboarding.notes.title')}</h3>
          {notes.map(({ icon: Icon, title, body }) => (
            <div className="callout callout-info" key={title}>
              <Icon size={18} aria-hidden />
              <div className="grow">
                <div className="callout-title">{title}</div>
                <div className="small">{body}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
    </Modal>
  );
}
