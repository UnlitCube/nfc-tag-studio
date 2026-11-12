// Help. Owner: agent "shell-ui".
// Keep-alive (App.tsx keeps this view mounted): the "scroll to the requested
// topic" runs whenever help becomes visible, not only on mount. A "back to
// <screen>" button returns to where the operator came from (F1 / "?" / nav),
// which still holds its work (2026-11-12 UX audit FIRST-8).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpenCheck } from 'lucide-react';
import { Button, Callout, Page, PageHeader } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { useViewActive } from '../../lib/viewActive';
import { useReturnView } from '../../components/shell/navHistory';
import { navLabelKey } from '../../components/shell/Sidebar';
import { openOnboarding } from '../../components/shell/Onboarding';
import { HELP_TOPICS, helpContent, resolveHelpTopic } from './helpContent';
import type { HelpTopicId } from './helpContent';
import './help.css';

export function HelpView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const requested = useAppStore((s) => s.helpTopic);
  const setView = useAppStore((s) => s.setView);
  const active = useViewActive();
  const back = useReturnView();
  const content = helpContent(lang);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const [current, setCurrent] = useState<HelpTopicId | null>(null);

  const target = resolveHelpTopic(requested);

  useEffect(() => {
    if (!active) return;
    setCurrent(target);
    if (target && refs.current[target]) {
      refs.current[target]!.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [active, target]);

  const topicLabel = (id: HelpTopicId) => t(`help.topic.${id}` as MsgKey);
  const goto = (id: HelpTopicId) => {
    setCurrent(id);
    refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <Page className="help-page">
      <PageHeader
        title={t('help.title')}
        subtitle={t('help.subtitle')}
        actions={
          <>
            <Button icon={BookOpenCheck} onClick={openOnboarding} data-testid="help-open-guide">
              {t('help.openGuide')}
            </Button>
            {back !== 'help' ? (
              <Button variant="primary" icon={ArrowLeft} onClick={() => setView(back)} data-testid="help-back">
                {t('help.back', { name: t(navLabelKey(back)) })}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="help-layout">
        <nav className="help-toc" aria-label={t('help.contents')}>
          <div className="help-toc-title">{t('help.contents')}</div>
          {HELP_TOPICS.map((id) => (
            <button
              key={id}
              type="button"
              className="help-toc-item"
              aria-current={current === id ? 'true' : undefined}
              onClick={() => goto(id)}
            >
              {topicLabel(id)}
            </button>
          ))}
        </nav>
        <article className="help-content">
          {HELP_TOPICS.map((id) => (
            <section
              key={id}
              className="help-section"
              data-testid={`help-${id}`}
              ref={(el) => {
                refs.current[id] = el;
              }}
            >
              <h2 className="help-h2">{topicLabel(id)}</h2>
              {content[id].map((block, i) => (
                <div key={i} className="help-block">
                  {block.heading ? <h3 className="help-h3">{block.heading}</h3> : null}
                  {block.body?.map((p, j) => (
                    <p key={j}>{p}</p>
                  ))}
                  {block.list ? (
                    <ul className="help-list">
                      {block.list.map((li, j) => (
                        <li key={j}>{li}</li>
                      ))}
                    </ul>
                  ) : null}
                  {block.note ? <Callout tone={block.note.tone}>{block.note.text}</Callout> : null}
                </div>
              ))}
            </section>
          ))}
        </article>
      </div>
    </Page>
  );
}
