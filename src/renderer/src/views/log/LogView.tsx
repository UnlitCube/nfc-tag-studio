// Issue log (発行台帳) view. Owner: renderer-issue.
// Lists the records the issue engine wrote (api.listIssueLog), filtered by job,
// with CSV export (BOM for Excel) and a confirmed clear. Keys/passwords are never
// in the log (invariant I4), so nothing here can reveal them.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import type { IssueLogEntry } from '@shared/types';
import { FILE_FILTERS } from '@shared/api';
import { toCsv } from '@shared/schema';
import { Badge, Button, Card, EmptyState, Field, Page, PageHeader, Select } from '../../components/ui';
import type { SelectOption, Tone } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { formatDateTime, formatUid, kindLabel, fileStamp } from '../../lib/format';
import { buildLogCsv, distinctJobs } from './csv';
import '../issue/issue.css';

const RESULT_TONE: Record<IssueLogEntry['result'], Tone> = {
  ok: 'ok',
  error: 'danger',
  skipped: 'warn',
};

export function LogView() {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const confirm = useAppStore((s) => s.confirm);
  const toast = useAppStore((s) => s.toast);
  const toastError = useAppStore((s) => s.toastError);
  const lastIssue = useAppStore((s) => s.issue.last);

  const [entries, setEntries] = useState<IssueLogEntry[]>([]);
  const [jobFilter, setJobFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listIssueLog({});
      setEntries(list);
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
    }
  }, [toastError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh when a tag is issued while this view is open.
  useEffect(() => {
    if (lastIssue && (lastIssue.type === 'success' || lastIssue.type === 'skipped' || lastIssue.type === 'error')) {
      void load();
    }
  }, [lastIssue, load]);

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
      filtered,
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
      const csv = '﻿' + toCsv(header, rows);
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
    const ok = await confirm({
      title: t('log.clear.title'),
      message: t('log.clear.msg'),
      tone: 'danger',
      confirmLabel: t('log.clear'),
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
            <Button icon={Trash2} variant="danger" onClick={onClear} disabled={entries.length === 0}>
              {t('log.clear')}
            </Button>
          </>
        }
      />

      <div className="stack-lg">
        <div className="row-between">
          <Field label={t('log.filter.job')}>
            <Select value={jobFilter} options={jobOptions} onChange={setJobFilter} />
          </Field>
          <Badge tone="neutral">{t('log.count', { n: filtered.length })}</Badge>
        </div>

        <Card flush>
          {filtered.length === 0 ? (
            <div className="card-body">
              <EmptyState icon={ScrollText} title={t('log.empty')} />
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
                    <tr key={e.id}>
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
                      <td className="small muted">{e.message ?? ''}</td>
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
