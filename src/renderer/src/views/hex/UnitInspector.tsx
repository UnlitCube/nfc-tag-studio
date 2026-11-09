// Byte/bit inspector panel + data-structure map for the hex editor.
// Owner: agent renderer-hex.
import { Info, ListTree } from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { Badge, Card } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import { inspectUnit, structureSpans } from './inspect';
import type { StructureSpan } from './inspect';

const SPAN_CLASS: Record<StructureSpan['kind'], string> = {
  'tlv-null': 'span-null',
  'tlv-lock': 'span-lock',
  'tlv-mem': 'span-mem',
  'tlv-ndef': 'span-ndef',
  'tlv-prop': 'span-prop',
  terminator: 'span-term',
  'ndef-value': 'span-ndefval',
  sector: 'span-sector',
};

export function UnitInspector({
  kind,
  data,
  unit,
  onGoto,
}: {
  kind: TagKind;
  data: Uint8Array;
  unit: number;
  /** Jump the cursor to a byte offset. */
  onGoto: (byte: number) => void;
}) {
  const t = useT();
  const lang = useAppStore((s) => s.settings.language);
  const ins = inspectUnit(kind, data, unit, lang);
  const spans = structureSpans(kind, data, lang).filter((s) => s.kind !== 'ndef-value');

  return (
    <div className="hx-panelgrid">
      <Card
        title={
          <>
            <Info size={16} aria-hidden /> {t('hex.inspect.title')}
          </>
        }
      >
        <div className="stack">
          <div className="hx-ins-head">
            <strong>{ins.unitLabel}</strong>
            <span className="muted small">{ins.regionLabel}</span>
            {ins.isProtected ? <Badge tone="warn">{t('hex.protected')}</Badge> : null}
          </div>
          {ins.summary ? <div className="small muted">{ins.summary}</div> : null}
          {ins.groups.length === 0 ? (
            <div className="small muted">{t('hex.inspect.plain')}</div>
          ) : (
            ins.groups.map((g, gi) => (
              <div key={gi} className="hx-ins-group">
                <button type="button" className="hx-ins-grouphead" onClick={() => onGoto(g.from)} title={t('hex.inspect.goto')}>
                  {g.label}
                  <span className="muted small">
                    {t('hex.inspect.bytes', { a: g.from, b: g.to })}
                  </span>
                </button>
                <table className="hx-ins-table">
                  <tbody>
                    {g.fields.map((f, fi) => (
                      <tr key={fi}>
                        <td className="hx-ins-bits mono">{f.bits}</td>
                        <td className="hx-ins-name">{f.name}</td>
                        <td className="hx-ins-val mono">{f.value}</td>
                        <td className="hx-ins-mean">
                          {f.tone && f.tone !== 'neutral' ? <span className={`hx-dot tone-${f.tone}`} aria-hidden /> : null}
                          {f.meaning}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card
        title={
          <>
            <ListTree size={16} aria-hidden /> {t('hex.struct.title')}
          </>
        }
      >
        <div className="stack">
          <div className="small muted">{t('hex.struct.hint')}</div>
          {spans.length === 0 ? (
            <div className="small muted">{t('hex.struct.none')}</div>
          ) : (
            <ul className="hx-struct-list">
              {spans.map((s, i) => (
                <li key={i}>
                  <button type="button" className={`hx-struct-item ${SPAN_CLASS[s.kind]}`} onClick={() => onGoto(s.start)}>
                    <span className="hx-struct-swatch" />
                    <span className="grow">{s.label}</span>
                    <span className="mono small muted">
                      {t('hex.inspect.bytes', { a: s.start, b: s.end })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
