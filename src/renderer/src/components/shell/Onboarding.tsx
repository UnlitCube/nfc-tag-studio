// First-run guide. Owner: agent "shell-ui".
import { CreditCard, Nfc, ShieldCheck } from 'lucide-react';
import { Button, Modal } from '../ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';

export function Onboarding() {
  const t = useT();
  const ready = useAppStore((s) => s.ready);
  const done = useAppStore((s) => s.settings.onboardingDone);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const open = ready && !done;
  const close = () => saveSettings((s) => ({ ...s, onboardingDone: true }));

  const points = [
    { icon: CreditCard, title: t('onboarding.p1.title'), body: t('onboarding.p1.body') },
    { icon: ShieldCheck, title: t('onboarding.p2.title'), body: t('onboarding.p2.body') },
    { icon: Nfc, title: t('onboarding.p3.title'), body: t('onboarding.p3.body') },
  ];

  return (
    <Modal
      open={open}
      title={t('onboarding.title')}
      icon={Nfc}
      onClose={close}
      dismissible={false}
      footer={<Button variant="primary" onClick={close} data-autofocus>{t('onboarding.start')}</Button>}
    >
      <div className="stack-lg">
        <p>{t('onboarding.body')}</p>
        <div className="stack">
          {points.map(({ icon: Icon, title, body }) => (
            <div className="callout callout-info" key={title}>
              <Icon size={18} aria-hidden />
              <div className="grow">
                <div className="callout-title">{title}</div>
                <div className="small">{body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
