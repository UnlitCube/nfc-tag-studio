// Issue log (発行台帳) view. Owner: renderer-issue.
// Lists the records the issue engine wrote (api.listIssueLog), filtered by job,
// with CSV export (BOM for Excel) and a confirmed clear. Keys/passwords are never
// in the log (invariant I4), so nothing here can reveal them.
//
// Keep-alive (2026-11-12): the view stays mounted while hidden, so it reloads when
// it is shown again and after each issued tag while it is on screen (ISSUE-1:
// result events arrive in the same tick as "remove the tag", so the reload keys
// on the store's issueRecent list, not only on the latest event's type).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import type { IssueLogEntry, LanguageSetting } from '@shared/types';
import { FILE_FILTERS } from '@shared/api';
import { errorMessage } from '@shared/errorMessages';
import { toCsv } from '@shared/schema';
import { Badge, Button, Card, EmptyState, Field, Page, PageHeader, Select } from '../../components/ui';
import type { SelectOption, Tone } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { useViewActive } from '../../lib/viewActive';
import { formatDateTime, formatUid, kindLabel, fileStamp } from '../../lib/format';
import { issueMessageCode } from '../issue/model';
import { buildLogCsv, distinctJobs } from './csv';
import '../issue/issue.css';

const RESULT_TONE: Record<IssueLogEntry['result'], Tone> = {
  ok: 'ok',
  error: 'danger',
  skipped: 'warn',
};

/** A log message that is an ErrorCode is shown as its plain-language text (ISSUE-9). */
function noteText(message: string | null, lang: LanguageSetting): string {
  if (!message) return '';
  const code = issueMessageCode(message);
  return code ? errorMessage(code, lang) : message;
}

export function LogView() {
  const t = useT();
  const active = useViewActive();
  const lang = useAppStore((s) => s.settings.language);
  const confirm = useAppStore((s) => s.confirm);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const lastIssue = useAppStore((s) => s.issue.last);
  const recentHead = useAppStore((s) => s.issueRecent[0]?.at ?? null);
  const recentCount = useAppStore((s) => s.issueRecent.length);
  // main refuses clearIssueLog with BUSY while issuing: say so up front (never ask, then refuse).
  const issueRunning = useAppStore((s) => s.issue.running);

  const [entries, setEntries] = useState<IssueLogEntry[]>([]);
  const [jobFilter, setJobFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  /** Something changed while the view was hidden: reload when it is shown. */
  const stale = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listIssueLog({});
      setEntries(list);
      stale.current = false;
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  }, [toastError]);

  // Reload when shown (also the first time).
  useEffect(() => {
    if (active && stale.current) void load();
  }, [active, load]);

  // Reload after each issued / skipped / failed tag and when a run stops.
  const lastType = lastIssue?.type ?? null;
  useEffect(() => {
    const relevant =
      recentHead != null ||
      lastType === 'success' ||
      lastType === 'skipped' ||
      lastType === 'error' ||
      lastType === 'remove-card' ||
      lastType === 'stopped';
    if (!relevant) return;
    if (active) void load();
    else stale.current = true;
    // `active` is read but not a dependency: becoming active is handled by the effect above.
  }, [recentHead, recentCount, lastType, load]);

  const jobs = useMemo(() => distinctJobs(entries), [entries]);
  const filtered = useMemo(
    () => (jobFilter ? entries.filter((e) => e.jobId === jobFilter) : entries),
    [entries, jobFilter],
  );

  const jobOptions: SelectOption<string>[] = [
    { value: '', label: t('log.filter.all') },
    ...jobs.map((j) => ({ value: j.id, label: j.name })),
  ];

  async function onExport() {
    if (filtered.length === 0) return;
    const { header, rows } = buildLogCsv(
      filtered.map((e) => ({ ...e, message: e.message ? noteText(e.message, lang) : e.message })),
      {
        at: t('log.col.at'),
        job: t('log.col.job'),
        uid: t('log.col.uid'),
        kind: t('log.col.kind'),
        seq: t('log.col.seq'),
        result: t('log.col.result'),
        message: t('log.col.message'),
      },
      (ms) => formatDateTime(ms, lang),
    );
    try {
      const csv = '﻿' + toCsv(header, rows); // BOM so Excel opens UTF-8
      const bytes = new TextEncoder().encode(csv);
      const res = await api.saveFile({
        title: t('log.export'),
        defaultName: `issue-log-${fileStamp()}.csv`,
        filters: [FILE_FILTERS.csv],
        bytes,
      });
      if (res) toast({ tone: 'ok', title: t('log.exported'), detail: res.name });
    } catch (err) {
      toastError(err);
    }
  }

  async function onClear() {
    if (issueRunning) return;
    const ok = await confirm({
      title: t('log.clear.title'),
      message: t('log.clear.msg'),
      tone: 'danger',
      confirmLabel: t('log.clear.confirm'),
    });
    if (!ok) return;
    try {
      await api.clearIssueLog();
      await load();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <Page>
      <PageHeader
        title={t('log.title')}
        subtitle={t('log.subtitle')}
        helpTopic="log"
        actions={
          <>
            <Button icon={RotateCcw} onClick={() => void load()} loading={loading}>
              {t('log.refresh')}
            </Button>
            <Button icon={Download} onClick={onExport} disabled={filtered.length === 0}>
              {t('log.export')}
            </Button>
            <Button
              icon={Trash2}
              variant="danger"
              onClick={onClear}
              disabled={entries.length === 0 || issueRunning}
              title={issueRunning ? t('log.clear.busy') : undefined}
              data-testid="log-clear"
            >
              {t('log.clear')}
            </Button>
          </>
        }
      />

      <div className="stack-lg">
        {issueRunning && entries.length > 0 ? (
          <p className="small muted" data-testid="log-clear-busy">
            {t('log.clear.busy')}
          </p>
        ) : null}
        <div className="row-between">
          <Field label={t('log.filter.job')}>
            <Select value={jobFilter} options={jobOptions} onChange={setJobFilter} aria-label={t('log.filter.job')} />
          </Field>
          <Badge tone="neutral">{t('log.count', { n: filtered.length })}</Badge>
        </div>

        <Card flush>
          {filtered.length === 0 ? (
            <div className="card-body">
              <EmptyState icon={ScrollText} title={entries.length > 0 && jobFilter ? t('log.empty.filtered') : t('log.empty')} />
            </div>
          ) : (
            <div className="issue-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('log.col.at')}</th>
                    <th>{t('log.col.job')}</th>
                    <th>{t('log.col.uid')}</th>
                    <th>{t('log.col.kind')}</th>
                    <th>{t('log.col.seq')}</th>
                    <th>{t('log.col.values')}</th>
                    <th>{t('log.col.result')}</th>
                    <th>{t('log.col.message')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id} data-result={e.result}>
                      <td className="small">{formatDateTime(e.at, lang)}</td>
                      <td>{e.jobName}</td>
                      <td className="mono small">{e.uid ? formatUid(e.uid) : '—'}</td>
                      <td className="small">{e.kind ? kindLabel(e.kind) : '—'}</td>
                      <td className="issue-seq">{e.seq ?? '—'}</td>
                      <td>
                        <LogValues values={e.values} />
                      </td>
                      <td>
                        <Badge tone={RESULT_TONE[e.result]}>{t(`log.result.${e.result}` as 'log.result.ok')}</Badge>
                      </td>
                      <td className="small muted">{noteText(e.message, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

function LogValues({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return <span className="muted small">—</span>;
  return (
    <span className="issue-values">
      {entries.map(([k, v]) => (
        <span key={k} className="issue-values-pair">
          <span className="issue-values-key">{k}</span>
          <span className="mono">{v}</span>
        </span>
      ))}
    </span>
  );
}
