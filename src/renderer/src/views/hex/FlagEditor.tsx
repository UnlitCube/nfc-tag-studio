// Parameter / flag editor with explanations. Owner: agent renderer-hex.
// Lets the operator edit config FLAGS through labelled controls (switches /
// selects / checkboxes) instead of raw hex, each with a plain-language note.
// Edits are applied to a copy of the image via the shared encoders and handed to
// `applyEdit` as pending changes, which the operator reviews and writes.
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { ShieldAlert, SlidersHorizontal } from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { isFelica, isMifare, isNtag, mifareIsTrailer, mifareSectorOfBlock, specFor } from '@shared/tags';
import type { AccessBits } from '@shared/tags';
import { buildNtagConfigWrites, buildNtagLockUserAreaWrites, buildTrailer, readNtagConfig } from '@shared/tag';
import type { NtagConfig } from '@shared/tag';
import { decodeFelicaMc, encodeFelicaMc, felicaBlockName } from '@shared/felica';
import type { UnitWrite } from '@shared/types';
import { Badge, Button, Callout, Card, Checkbox, HelpTip, Select, Switch } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { TFunc } from '../../i18n';

/** Apply unit writes onto a copy of the image. */
function withWrites(data: Uint8Array, unitSize: number, writes: UnitWrite[]): Uint8Array {
  const next = new Uint8Array(data);
  for (const w of writes) next.set(w.data, w.unit * unitSize);
  return next;
}

export interface FlagEditorProps {
  kind: TagKind;
  data: Uint8Array;
  /** Current cursor unit (used to pick the MIFARE sector). */
  unit: number;
  advanced: boolean;
  onApply: (next: Uint8Array) => void;
  confirm: (req: { title: string; message: string; details?: string[]; tone?: 'default' | 'warn' | 'danger'; typeToConfirm?: string; confirmLabel?: string }) => Promise<boolean>;
}

export function FlagEditor(props: FlagEditorProps) {
  const t = useT();
  if (isNtag(props.kind)) return <NtagFlags {...props} t={t} />;
  if (isMifare(props.kind)) return <MifareFlags {...props} t={t} />;
  if (isFelica(props.kind)) return <FelicaFlags {...props} t={t} />;
  return null;
}

// --- NTAG --------------------------------------------------------------------

function NtagFlags({ kind, data, advanced, onApply, confirm, t }: FlagEditorProps & { t: TFunc }) {
  const cfg = useMemo(() => readNtagConfig(kind, data), [kind, data]);
  const toastError = useAppStore((s) => s.toastError);

  function apply(next: NtagConfig, opts?: { dangerous?: boolean }) {
    try {
      const writes = buildNtagConfigWrites(kind, data, next);
      onApply(withWrites(data, 4, writes));
    } catch (e) {
      toastError(e);
    }
    void opts;
  }

  async function lockUserArea() {
    const ok = await confirm({
      title: t('flags.ntag.lockTitle'),
      message: t('flags.ntag.lockBody'),
      tone: 'danger',
      typeToConfirm: 'LOCK',
      confirmLabel: t('flags.ntag.lockConfirm'),
    });
    if (!ok) return;
    try {
      onApply(withWrites(data, 4, buildNtagLockUserAreaWrites(kind, data)));
    } catch (e) {
      toastError(e);
    }
  }

  const AUTHLIM = [0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <Card title={<><SlidersHorizontal size={16} aria-hidden /> {t('flags.title')}</>}>
      <div className="stack">
        <p className="small muted">{t('flags.ntag.hint')}</p>

        <FlagRow label={t('flags.ntag.counter')} help={t('flags.ntag.counterHelp')}>
          <Switch checked={cfg.counterEnabled} onChange={(v) => apply({ ...cfg, counterEnabled: v })} />
        </FlagRow>

        <FlagRow label={t('flags.ntag.prot')} help={t('flags.ntag.protHelp')}>
          <Select<'write' | 'rw'>
            value={cfg.prot ? 'rw' : 'write'}
            onChange={(v) => apply({ ...cfg, prot: v === 'rw' })}
            options={[
              { value: 'write', label: t('flags.ntag.protWrite') },
              { value: 'rw', label: t('flags.ntag.protRw') },
            ]}
          />
        </FlagRow>

        <FlagRow label={t('flags.ntag.auth0')} help={t('flags.ntag.auth0Help')}>
          <input
            className="input mono"
            style={{ width: '7ch' }}
            type="number"
            min={0}
            max={255}
            value={cfg.auth0}
            onChange={(e) => apply({ ...cfg, auth0: Math.max(0, Math.min(255, Number(e.target.value) || 0)) })}
          />
          <span className="small muted">{cfg.auth0 === 0xff ? t('flags.ntag.protOff') : t('flags.ntag.protFrom', { n: cfg.auth0 })}</span>
        </FlagRow>

        <FlagRow label={t('flags.ntag.authlim')} help={t('flags.ntag.authlimHelp')}>
          <Select<string>
            value={String(cfg.authLimit)}
            onChange={(v) => apply({ ...cfg, authLimit: Number(v) })}
            options={AUTHLIM.map((n) => ({ value: String(n), label: n === 0 ? t('flags.ntag.unlimited') : String(2 ** n) }))}
          />
        </FlagRow>

        <FlagRow label={t('flags.ntag.mirror')} help={t('flags.ntag.mirrorHelp')}>
          <Select<NtagConfig['mirror']['conf']>
            value={cfg.mirror.conf}
            onChange={(v) => apply({ ...cfg, mirror: { ...cfg.mirror, conf: v } })}
            options={[
              { value: 'none', label: t('flags.ntag.mirrorNone') },
              { value: 'uid', label: 'UID' },
              { value: 'counter', label: t('flags.ntag.mirrorCounter') },
              { value: 'both', label: t('flags.ntag.mirrorBoth') },
            ]}
          />
        </FlagRow>

        {advanced ? (
          <>
            <FlagRow label={t('flags.ntag.cfglock')} help={t('flags.ntag.cfglockHelp')} danger>
              <Switch checked={cfg.cfgLock} onChange={(v) => apply({ ...cfg, cfgLock: v }, { dangerous: true })} />
            </FlagRow>
            <Callout tone="danger" title={t('flags.ntag.lockTitle')}>
              <div className="stack">
                <span className="small">{t('flags.ntag.lockBody')}</span>
                <Button size="sm" variant="danger" icon={ShieldAlert} onClick={() => void lockUserArea()}>
                  {t('flags.ntag.lockConfirm')}
                </Button>
              </div>
            </Callout>
          </>
        ) : (
          <Callout tone="info">{t('flags.advancedHint')}</Callout>
        )}
      </div>
    </Card>
  );
}

// --- MIFARE sector trailer ---------------------------------------------------

type AccessPreset = 'transport' | 'readonly' | 'keyb';

/** Three safe, well-understood access-condition presets for a data sector. */
function presetAccess(preset: AccessPreset): AccessBits {
  // c[block0..2 data][trailer] = [C1,C2,C3]
  if (preset === 'transport') {
    // FF 07 80: data blocks key A/B r/w; trailer key A writes keys+access.
    return { c: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]], gpb: 0x69 };
  }
  if (preset === 'readonly') {
    // data blocks readable with A/B, never writable; trailer locked.
    return { c: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]], gpb: 0x69 };
  }
  // keyb: read with A/B, write with B only.
  return { c: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [0, 1, 1]], gpb: 0x69 };
}

function MifareFlags({ data, unit, advanced, onApply, confirm, t }: FlagEditorProps & { t: TFunc }) {
  const toastError = useAppStore((s) => s.toastError);
  const sector = mifareSectorOfBlock(unit);
  const onTrailer = mifareIsTrailer(unit);

  async function applyPreset(preset: AccessPreset) {
    if (!onTrailer) return;
    const ok = await confirm({
      title: t('flags.mifare.applyTitle'),
      message: t('flags.mifare.applyBody', { sector }),
      details: [t(`flags.mifare.preset.${preset}` as Parameters<TFunc>[0])],
      tone: preset === 'readonly' ? 'danger' : 'warn',
      confirmLabel: t('common.apply'),
    });
    if (!ok) return;
    try {
      const off = unit * 16;
      const keyA = data.subarray(off, off + 6);
      const keyB = data.subarray(off + 10, off + 16);
      // Keys read back as 00 on a real card; keep whatever the editor holds.
      const trailer = buildTrailer(keyA.some((b) => b) ? keyA : new Uint8Array(6).fill(0xff), presetAccess(preset), keyB.some((b) => b) ? keyB : new Uint8Array(6).fill(0xff));
      const next = new Uint8Array(data);
      next.set(trailer, off);
      onApply(next);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <Card title={<><SlidersHorizontal size={16} aria-hidden /> {t('flags.title')}</>}>
      <div className="stack">
        <p className="small muted">{t('flags.mifare.hint')}</p>
        {!advanced ? (
          <Callout tone="info">{t('flags.advancedHint')}</Callout>
        ) : !onTrailer ? (
          <Callout tone="info">{t('flags.mifare.selectTrailer')}</Callout>
        ) : (
          <div className="stack">
            <div className="row">
              <Badge tone="warn">{t('flags.mifare.sector', { n: sector })}</Badge>
              <span className="small muted">{t('flags.mifare.trailerUnit', { n: unit })}</span>
            </div>
            <FlagRow label={t('flags.mifare.preset.transport')} help={t('flags.mifare.presetTransportHelp')}>
              <Button size="sm" onClick={() => void applyPreset('transport')}>{t('common.apply')}</Button>
            </FlagRow>
            <FlagRow label={t('flags.mifare.preset.keyb')} help={t('flags.mifare.presetKeybHelp')}>
              <Button size="sm" onClick={() => void applyPreset('keyb')}>{t('common.apply')}</Button>
            </FlagRow>
            <FlagRow label={t('flags.mifare.preset.readonly')} help={t('flags.mifare.presetReadonlyHelp')} danger>
              <Button size="sm" variant="danger" onClick={() => void applyPreset('readonly')}>{t('common.apply')}</Button>
            </FlagRow>
            <p className="small muted">{t('flags.mifare.keysNote')}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

// --- FeliCa Lite-S MC --------------------------------------------------------

function FelicaFlags({ kind, data, onApply, t }: FlagEditorProps & { t: TFunc }) {
  const mcUnit = specFor(kind).unitCount - 1; // MC is the last unit (0x88)
  const mc = useMemo(() => decodeFelicaMc(data.subarray(mcUnit * 16, mcUnit * 16 + 16)), [data, mcUnit]);

  function setWritable(block: number, v: boolean) {
    const writable = mc.writable.slice();
    writable[block] = v;
    const next = new Uint8Array(data);
    next.set(encodeFelicaMc({ ...mc, writable }), mcUnit * 16);
    onApply(next);
  }

  return (
    <Card title={<><SlidersHorizontal size={16} aria-hidden /> {t('flags.title')}</>}>
      <div className="stack">
        <p className="small muted">{t('flags.felica.hint')}</p>
        <Callout tone="warn">{t('flags.felica.warn')}</Callout>
        <div className="flags-felica-grid">
          {mc.writable.map((w, block) => (
            <Checkbox key={block} checked={w} onChange={(v) => setWritable(block, v)} label={`${felicaBlockName(block)} ${t('flags.felica.writable')}`} />
          ))}
        </div>
        <FlagRow label="SYS_OP" help={t('flags.felica.sysopHelp')}>
          <Badge tone="info">{mc.liteS ? 'Lite-S' : 'Lite'}</Badge>
        </FlagRow>
      </div>
    </Card>
  );
}

// --- shared row --------------------------------------------------------------

function FlagRow({ label, help, children, danger }: { label: string; help: string; children: ReactNode; danger?: boolean }) {
  return (
    <div className="flags-row">
      <div className={`flags-row-label${danger ? ' flags-danger' : ''}`}>
        <span>{label}</span>
        <HelpTip text={help} />
      </div>
      <div className="flags-row-control">{children}</div>
    </div>
  );
}
