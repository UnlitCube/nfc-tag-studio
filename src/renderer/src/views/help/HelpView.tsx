// Help. Owner: agent "shell-ui".
import { useEffect, useRef } from 'react';
import { Callout, Page, PageHeader } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey } from '../../i18n';
import { HELP_TOPICS, helpContent } from './helpContent';
import type { HelpTopicId } from './helpContent';
import './help.css';

export function HelpView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const helpTopic = useAppStore((s) => s.helpTopic);
  const content = helpContent(lang);
  const refs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (helpTopic && refs.current[helpTopic]) {
      refs.current[helpTopic]!.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [helpTopic]);

  const topicLabel = (id: HelpTopicId) => t(`help.topic.${id}` as MsgKey);

  return (
    <Page className="help-page">
      <PageHeader title={t('help.title')} subtitle={t('help.subtitle')} />
      <div className="help-layout">
        <nav className="help-toc" aria-label={t('help.contents')}>
          <div className="help-toc-title">{t('help.contents')}</div>
          {HELP_TOPICS.map((id) => (
            <button
              key={id}
              type="button"
              className="help-toc-item"
              aria-current={helpTopic === id ? 'true' : undefined}
              onClick={() => refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
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
