// Live preview: encodes the schema with sample values and shows the bytes + table.
// Owner: renderer-schema.
import { useMemo } from 'react';
import type { DataSchema } from '@shared/schema/types';
import { encodeSchema } from '@shared/schema';
import { bytesToHex } from '@shared/hex';
import { Callout } from '../../components/ui';
import type { TFunc } from '../../i18n';
import { formatUid } from '../../lib/format';
import { sampleContext, sampleUidHex } from './helpers';

type PreviewResult =
  | { ok: true; hex: string; values: Record<string, string> }
  | { ok: false; message: string };

function computePreview(schema: DataSchema): PreviewResult {
  try {
    const { bytes, values } = encodeSchema(schema, sampleContext(schema));
    return { ok: true, hex: bytesToHex(bytes, ' '), values };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function SchemaPreview({ schema, t }: { schema: DataSchema; t: TFunc }) {
  const preview = useMemo(() => computePreview(schema), [schema]);

  if (schema.fields.length === 0) {
    return <p className="small muted">{t('schema.preview.noFields')}</p>;
  }

  const sampleUid = formatUid(sampleUidHex(schema.tagKinds[0]));

  return (
    <div className="stack">
      <p className="small muted">{t('schema.preview.sample', { uid: sampleUid })}</p>

      {preview.ok ? (
        <>
          <div>
            <div className="schema-cell-label">{t('schema.preview.bytes')}</div>
            <div className="schema-hex mono">{preview.hex || '—'}</div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('schema.preview.field')}</th>
                <th>{t('schema.preview.value')}</th>
              </tr>
            </thead>
            <tbody>
              {schema.fields.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.label || f.id} <span className="mono small muted">{f.id}</span>
                  </td>
                  <td className="mono">{preview.values[f.id] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <Callout tone="warn" title={t('schema.preview.unavailable')}>
          <span className="small mono">{preview.message}</span>
        </Callout>
      )}
    </div>
  );
}
