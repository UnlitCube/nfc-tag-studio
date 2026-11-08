// Visualises how the schema's fields occupy the byte range. Owner: renderer-schema.
import { AlertTriangle } from 'lucide-react';
import type { DataSchema } from '@shared/schema/types';
import { specFor } from '@shared/tags';
import type { TFunc } from '../../i18n';
import { buildByteMap, computeSize, fieldColorVar } from './helpers';

const MAX_BYTES = 512;

export function MemoryMap({ schema, t }: { schema: DataSchema; t: TFunc }) {
  const size = Math.max(schema.size, computeSize(schema.fields));
  const primary = schema.tagKinds[0];
  const capacity = schema.area.mode === 'raw' && primary ? specFor(primary).userBytes : null;

  if (size === 0) {
    return <p className="small muted">{t('schema.map.empty')}</p>;
  }

  const { map, overlaps } = buildByteMap(schema.fields, size);

  return (
    <div className="schema-map">
      <div className="row-between">
        <div className="small muted">
          {t('schema.map.size', { n: size })} {capacity !== null ? t('schema.map.capacity', { n: capacity }) : null}
        </div>
        {overlaps.size > 0 ? (
          <span className="schema-map-warn">
            <AlertTriangle size={13} aria-hidden /> {t('schema.map.overlap')}
          </span>
        ) : null}
      </div>

      {size <= MAX_BYTES ? (
        <div className="schema-map-grid" role="img" aria-label={t('schema.map.title')}>
          {Array.from({ length: size }, (_, b) => {
            const fi = map[b];
            const over = overlaps.has(b);
            const field = fi >= 0 ? schema.fields[fi] : null;
            return (
              <span
                key={b}
                className={`schema-byte${fi < 0 ? ' is-gap' : ''}${over ? ' is-overlap' : ''}`}
                style={fi >= 0 ? { background: fieldColorVar(fi) } : undefined}
                title={`${t('schema.map.byte', { offset: b })}${field ? `: ${field.label || field.id}` : ''}`}
              />
            );
          })}
        </div>
      ) : (
        <p className="small muted">{t('schema.map.tooBig')}</p>
      )}

      <ul className="schema-legend">
        {schema.fields.map((f, i) => (
          <li key={f.id + i}>
            <span className="schema-swatch" style={{ background: fieldColorVar(i) }} aria-hidden />
            <span className="grow">{f.label || f.id}</span>
            <span className="mono small muted">
              {f.offset}..{f.offset + f.length - 1}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
