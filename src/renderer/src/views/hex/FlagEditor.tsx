// Parameter / flag editor with explanations. Owner: agent renderer-hex.
// Lets the operator edit config FLAGS through labelled controls (switches /
// selects / checkboxes) instead of raw hex, each with a plain-language note.
// Edits are applied to a copy of the image via the shared encoders and handed to
// `applyEdit` as pending changes, which the operator reviews and writes.
//
// 2026-11-12 (UX audit WRITE-5 / WALK-11 / WRITE-14): every control here edits a
// PROTECTED unit (NTAG CFG / lock pages, MIFARE trailer, FeliCa MC). They are
// disabled - with the reason and the fix - unless protected areas are editable
// (advanced mode + "edit and write protected areas too"), so a first-time user is
// never shown a change that would then silently not be written. Protection takes
// effect only after the tag is taken off and placed again: said here and in the
// write confirmation.
//
// 2026-11-12 second round (review R-UX-5 / R-UX-10):
// - Turning NTAG password protection ON (AUTH0 into the memory) on a tag that is
//   not protected yet REQUIRES deciding the password (PWD + confirmation + PACK)
//   here, unless the PWD / PACK pages were already edited in the grid. Otherwise
//   the tag would be "protected" by whatever PWD it has (FFFFFFFF from the
//   factory) - and the screen would not say which.
// - Combinations the shared encoder rejects (AUTH0 over the config pages + CFGLCK)
//   are refused BEFORE calling it, with the reason in the UI language (its own
//   error text is Japanese-only).
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { KeyRound, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import type { TagKind } from '@shared/tags';
import { isFelica, isMifare, isNtag, mifareIsTrailer, mifareSectorOfBlock, ntagPages, specFor } from '@shared/tags';
import type { AccessBits } from '@shared/tags';
import { buildNtagConfigWrites, buildNtagLockUserAreaWrites, buildNtagPasswordWrites, buildTrailer, readNtagConfig } from '@shared/tag';
import type { NtagConfig } from '@shared/tag';
import { decodeFelicaMc, encodeFelicaMc, felicaBlockName } from '@shared/felica';
import type { UnitWrite } from '@shared/types';
import { Badge, Button, Callout, Card, Checkbox, Field, HelpTip, Select, Switch, TextInput } from '../../components/ui';
import { useAppStore } from '../../store/app';
import { useT } from '../../i18n';
import type { MsgKey, TFunc } from '../../i18n';
import { newNtagPasswordProblem, ntagCfgLockConflict, ntagPasswordEdited, ntagProtectionOn } from './model';
import type { NewPasswordProblem } from './model';

/** Apply unit writes onto a copy of the image. */
function withWrites(data: Uint8Array, unitSize: number, writes: UnitWrite[]): Uint8Array {
  const next = new Uint8Array(data);
  for (const w of writes) next.set(w.data, w.unit * unitSize);
  return next;
}

export interface FlagEditorProps {
  kind: TagKind;
  /** Current (edited) bytes. */
  data: Uint8Array;
  /** Bytes as read / opened (to tell what is already latched on the tag). */
  original: Uint8Array;
  /** Current cursor unit (used to pick the MIFARE sector). */
  unit: number;
  advanced: boolean;
  /** Protected areas may be edited (advanced mode AND the "edit protected areas" switch). */
  protectedEditable: boolean;
  /** Turns the "edit and write protected areas too" switch on (offered in advanced mode). */
  onEnableProtected: () => void;
  /** The active reader cannot send PWD_AUTH (storage-only, e.g. PaSoRi): protected pages become unusable on it. */
  passwordAuthUnavailable?: boolean;
  /** A read / write is running: no edits. */
  busy: boolean;
  onApply: (next: Uint8Array) => void;
  confirm: (req: { title: string; message: string; details?: string[]; tone?: 'default' | 'warn' | 'danger'; typeToConfirm?: string; confirmLabel?: string }) => Promise<boolean>;
}

type Inner = FlagEditorProps & { t: TFunc };

/**
 * A shared encoder refused the change. Its message is Japanese-only (R-UX-10):
 * the title is always in the UI language, the encoder's text only as a Japanese detail.
 */
function useApplyFailed(t: TFunc): (e: unknown) => void {
  const toast = useAppStore((s) => s.toast);
  const lang = useAppStore((s) => s.settings.language);
  return (e) => toast({ tone: 'danger', title: t('flags.applyError'), detail: lang === 'ja' && e instanceof Error ? e.message : undefined });
}

export function FlagEditor(props: FlagEditorProps) {
  const t = useT();
  if (isNtag(props.kind)) return <NtagFlags {...props} t={t} />;
  if (isMifare(props.kind)) return <MifareFlags {...props} t={t} />;
  if (isFelica(props.kind)) return <FelicaFlags {...props} t={t} />;
  return null;
}

/** Why the protected controls are disabled, with the fix (advanced mode / the switch). */
function ProtectedGate({ advanced, protectedEditable, onEnableProtected, t }: Pick<Inner, 'advanced' | 'protectedEditable' | 'onEnableProtected' | 't'>) {
  if (protectedEditable) return null;
  return (
    <Callout tone="info">
      <div className="stack">
        <span>{advanced ? t('flags.ro.switch') : t('flags.ro.advanced')}</span>
        {advanced ? (
          <span>
            <Button size="sm" icon={ShieldAlert} onClick={onEnableProtected}>
              {t('hex.write.includeProtected')}
            </Button>
          </span>
        ) : null}
      </div>
    </Callout>
  );
}

// --- NTAG --------------------------------------------------------------------

const PW_PROBLEM: Record<NewPasswordProblem, MsgKey> = {
  pwdFormat: 'flags.ntag.pw.errFormat',
  pwdZero: 'flags.ntag.pw.errZero',
  pwdFactory: 'flags.ntag.pw.errFactory',
  mismatch: 'flags.ntag.pw.errMismatch',
  packFormat: 'flags.ntag.pw.errPack',
};

function NtagFlags(props: Inner) {
  const { kind, data, original, advanced, protectedEditable, busy, onApply, confirm, passwordAuthUnavailable, t } = props;
  const p = ntagPages(kind);
  const cfg = useMemo(() => readNtagConfig(kind, data), [kind, data]);
  // As read from the tag: CFGLCK already set = the config pages are frozen for good;
  // AUTH0 within the memory = the tag already has a (working) password.
  const cfgOnTag = useMemo(() => readNtagConfig(kind, original), [kind, original]);
  const cfgLockedOnTag = cfgOnTag.cfgLock;
  const toast = useAppStore((s) => s.toast);
  const applyFailed = useApplyFailed(t);
  const disabled = !protectedEditable || busy || cfgLockedOnTag;

  const protOnTag = ntagProtectionOn(kind, cfgOnTag.auth0);
  const protNow = ntagProtectionOn(kind, cfg.auth0);
  const pwEdited = ntagPasswordEdited(kind, data, original);
  /** AUTH0 the operator asked for while the password is still to be decided (not applied yet). */
  const [arming, setArming] = useState<number | null>(null);
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [pack, setPack] = useState('0000');
  const [tried, setTried] = useState(false);
  // Protection turned on in the document (e.g. CFG0 typed in the grid) with no password decided.
  const unsetPw = protNow && !protOnTag && !pwEdited;
  const panelAuth0 = arming ?? (unsetPw ? cfg.auth0 : null);
  const pwProblem = newNtagPasswordProblem(pwd, pwd2, pack);

  /** Refused combinations, said in the UI language (the encoder's own error is Japanese-only - R-UX-10). */
  function conflict(next: NtagConfig): MsgKey | null {
    return ntagCfgLockConflict(kind, next) ? 'flags.ntag.conflictCfgLock' : null;
  }

  function apply(next: NtagConfig) {
    if (disabled) return;
    const c = conflict(next);
    if (c) {
      toast({ tone: 'warn', title: t(c) });
      return;
    }
    try {
      const writes = buildNtagConfigWrites(kind, data, next);
      onApply(withWrites(data, 4, writes));
    } catch (e) {
      applyFailed(e);
    }
  }

  /** AUTH0 input. Turning protection on for a tag without a password asks for one first (R-UX-5). */
  function onAuth0(v: number) {
    if (disabled) return;
    const a = Math.max(0, Math.min(255, v));
    const on = ntagProtectionOn(kind, a);
    if (on && (arming !== null || (!protNow && !protOnTag && !pwEdited))) {
      const c = conflict({ ...cfg, auth0: a });
      if (c) {
        toast({ tone: 'warn', title: t(c) });
        return;
      }
      setArming(a);
      return;
    }
    setArming(null);
    apply({ ...cfg, auth0: a });
  }

  function cancelArming() {
    setTried(false);
    if (arming !== null) {
      setArming(null);
      return;
    }
    // Protection was turned on in the grid without a password: turn it back off (as on the tag).
    apply({ ...cfg, auth0: cfgOnTag.auth0 });
  }

  function setPasswordAndProtect() {
    if (disabled || panelAuth0 === null) return;
    setTried(true);
    if (pwProblem) return;
    const next = { ...cfg, auth0: panelAuth0 };
    const c = conflict(next);
    if (c) {
      toast({ tone: 'warn', title: t(c) });
      return;
    }
    try {
      // PWD, PACK, CFG1 (PROT / AUTHLIM), CFG0 (AUTH0) - planWrites keeps this order.
      const writes = buildNtagPasswordWrites(kind, data, { password: pwd, pack, auth0: panelAuth0, protectRead: cfg.prot, authLimit: cfg.authLimit });
      onApply(withWrites(data, 4, writes));
      setArming(null);
      setPwd('');
      setPwd2('');
      setTried(false);
    } catch (e) {
      applyFailed(e);
    }
  }

  async function lockUserArea() {
    if (!protectedEditable || busy) return;
    const ok = await confirm({
      title: t('flags.ntag.lockTitle'),
      message: t('flags.ntag.lockBody'),
      details: [t('hex.init.pending')],
      tone: 'danger',
      typeToConfirm: t('hex.write.lockWord'),
      confirmLabel: t('flags.ntag.lockConfirm'),
    });
    if (!ok) return;
    try {
      onApply(withWrites(data, 4, buildNtagLockUserAreaWrites(kind, data)));
    } catch (e) {
      applyFailed(e);
    }
  }

  const AUTHLIM = [0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <Card title={<><SlidersHorizontal size={16} aria-hidden /> {t('flags.title')}</>}>
      <div className="stack">
        <p className="small muted">{t('flags.ntag.hint')}</p>
        {cfgLockedOnTag ? <Callout tone="warn">{t('flags.ro.locked')}</Callout> : <ProtectedGate {...props} />}

        <FlagRow label={t('flags.ntag.counter')} help={t('flags.ntag.counterHelp')}>
          <Switch checked={cfg.counterEnabled} disabled={disabled} onChange={(v) => apply({ ...cfg, counterEnabled: v })} />
        </FlagRow>

        <FlagRow label={t('flags.ntag.prot')} help={t('flags.ntag.protHelp')}>
          <Select<'write' | 'rw'>
            value={cfg.prot ? 'rw' : 'write'}
            disabled={disabled}
            onChange={(v) => apply({ ...cfg, prot: v === 'rw' })}
            options={[
              { value: 'write', label: t('flags.ntag.protWrite') },
              { value: 'rw', label: t('flags.ntag.protRw') },
            ]}
          />
        </FlagRow>

        <FlagRow label={t('flags.ntag.auth0')} help={t('flags.ntag.auth0Help')}>
          <input
            className="input mono flags-num"
            type="number"
            min={0}
            max={255}
            disabled={disabled}
            value={arming ?? cfg.auth0}
            aria-label={t('flags.ntag.auth0')}
            data-testid="flags-auth0"
            onChange={(e) => onAuth0(Number(e.target.value) || 0)}
          />
          <span className="small muted">
            {ntagProtectionOn(kind, arming ?? cfg.auth0) ? t('flags.ntag.protFrom', { n: arming ?? cfg.auth0 }) : t('flags.ntag.protOff')}
          </span>
        </FlagRow>

        {/* Which password protects the tag (R-UX-5). */}
        {panelAuth0 !== null && protectedEditable && !cfgLockedOnTag ? (
          <div className="flags-pw" data-testid="flags-pw-panel">
            <Callout tone="warn" title={t('flags.ntag.pw.title')}>
              <div className="stack">
                <span className="small">
                  {t(cfg.prot ? 'flags.ntag.pw.bodyRw' : 'flags.ntag.pw.bodyWrite', { n: panelAuth0 })}
                </span>
                {passwordAuthUnavailable ? <span className="small flags-danger-text">{t('flags.ntag.pw.noAuth')}</span> : null}
              </div>
            </Callout>
            <div className="flags-pw-fields">
              <Field label={t('flags.ntag.pw.pwd')} htmlFor="flags-pw-pwd" error={tried && (pwProblem === 'pwdFormat' || pwProblem === 'pwdZero' || pwProblem === 'pwdFactory') ? t(PW_PROBLEM[pwProblem]) : undefined}>
                <TextInput id="flags-pw-pwd" type="password" mono autoComplete="off" spellCheck={false} maxLength={8} value={pwd} placeholder={t('flags.ntag.pw.placeholder')} disabled={busy} onChange={(e) => setPwd(e.target.value.trim())} />
              </Field>
              <Field label={t('flags.ntag.pw.pwd2')} htmlFor="flags-pw-pwd2" error={tried && pwProblem === 'mismatch' ? t(PW_PROBLEM.mismatch) : undefined}>
                <TextInput id="flags-pw-pwd2" type="password" mono autoComplete="off" spellCheck={false} maxLength={8} value={pwd2} disabled={busy} onChange={(e) => setPwd2(e.target.value.trim())} />
              </Field>
              <Field label={t('flags.ntag.pw.pack')} htmlFor="flags-pw-pack" help={t('flags.ntag.pw.packHelp')} error={tried && pwProblem === 'packFormat' ? t(PW_PROBLEM.packFormat) : undefined}>
                <TextInput id="flags-pw-pack" mono autoComplete="off" spellCheck={false} maxLength={4} value={pack} disabled={busy} onChange={(e) => setPack(e.target.value.trim())} />
              </Field>
            </div>
            <p className="small muted">{t('flags.ntag.pw.remember')}</p>
            <div className="row">
              <Button size="sm" variant="primary" icon={KeyRound} disabled={busy} data-testid="flags-pw-apply" onClick={setPasswordAndProtect}>
                {t('flags.ntag.pw.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={cancelArming}>
                {t('flags.ntag.pw.cancel')}
              </Button>
            </div>
          </div>
        ) : pwEdited && (protNow || protOnTag) ? (
          <p className="small muted" data-testid="flags-pw-pending">{t('flags.ntag.pw.pending')}</p>
        ) : protOnTag ? (
          <p className="small muted">{t('flags.ntag.pw.kept', { n: cfgOnTag.auth0 })}</p>
        ) : null}

        <FlagRow label={t('flags.ntag.authlim')} help={t('flags.ntag.authlimHelp')}>
          <Select<string>
            value={String(cfg.authLimit)}
            disabled={disabled}
            onChange={(v) => apply({ ...cfg, authLimit: Number(v) })}
            options={AUTHLIM.map((n) => ({ value: String(n), label: n === 0 ? t('flags.ntag.unlimited') : String(2 ** n) }))}
          />
        </FlagRow>
        {cfg.authLimit > 0 && (protNow || panelAuth0 !== null) ? (
          <p className="small flags-danger-text">{t('flags.ntag.authlimWarn', { n: 2 ** cfg.authLimit })}</p>
        ) : null}

        <FlagRow label={t('flags.ntag.mirror')} help={t('flags.ntag.mirrorHelp')}>
          <Select<NtagConfig['mirror']['conf']>
            value={cfg.mirror.conf}
            disabled={disabled}
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
              <Switch
                checked={cfg.cfgLock}
                disabled={disabled || (!cfg.cfgLock && (cfg.auth0 <= p.cfg1 || (panelAuth0 !== null && panelAuth0 <= p.cfg1)))}
                onChange={(v) => apply({ ...cfg, cfgLock: v })}
              />
            </FlagRow>
            {!disabled && !cfg.cfgLock && (cfg.auth0 <= p.cfg1 || (panelAuth0 !== null && panelAuth0 <= p.cfg1)) ? (
              <p className="small muted">{t('flags.ntag.conflictCfgLock')}</p>
            ) : null}
            <Callout tone="danger" title={t('flags.ntag.lockTitle')}>
              <div className="stack">
                <span className="small">{t('flags.ntag.lockBody')}</span>
                <span>
                  <Button size="sm" variant="danger" icon={ShieldAlert} disabled={!protectedEditable || busy} onClick={() => void lockUserArea()}>
                    {t('flags.ntag.lockConfirm')}
                  </Button>
                </span>
              </div>
            </Callout>
          </>
        ) : null}
        {protectedEditable ? <p className="small muted">{t('flags.reactivate')}</p> : null}
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

const PRESET_LABEL: Record<AccessPreset, MsgKey> = {
  transport: 'flags.mifare.preset.transport',
  keyb: 'flags.mifare.preset.keyb',
  readonly: 'flags.mifare.preset.readonly',
};

function MifareFlags(props: Inner) {
  const { data, unit, protectedEditable, busy, onApply, confirm, t } = props;
  const applyFailed = useApplyFailed(t);
  const sector = mifareSectorOfBlock(unit);
  const onTrailer = mifareIsTrailer(unit);
  const disabled = !protectedEditable || busy;

  async function applyPreset(preset: AccessPreset) {
    if (!onTrailer || disabled) return;
    const off = unit * 16;
    const keyA = data.subarray(off, off + 6);
    const keyB = data.subarray(off + 10, off + 16);
    // A real card never returns key A (it reads 00). An all-zero key A in the grid
    // means "unknown": the factory key is used and the confirmation says so.
    const keyAKnown = keyA.some((b) => b);
    const keyBKnown = keyB.some((b) => b);
    const ok = await confirm({
      title: t('flags.mifare.applyTitle'),
      message: t('flags.mifare.applyBody', { sector }),
      details: [
        t(PRESET_LABEL[preset]),
        keyAKnown ? t('flags.mifare.keyAGrid') : t('flags.mifare.keyADefault'),
        keyBKnown ? t('flags.mifare.keyBGrid') : t('flags.mifare.keyBDefault'),
      ],
      tone: preset === 'readonly' ? 'danger' : 'warn',
      confirmLabel: t('flags.mifare.apply'),
    });
    if (!ok) return;
    try {
      const trailer = buildTrailer(keyAKnown ? keyA : new Uint8Array(6).fill(0xff), presetAccess(preset), keyBKnown ? keyB : new Uint8Array(6).fill(0xff));
      const next = new Uint8Array(data);
      next.set(trailer, off);
      onApply(next);
    } catch (e) {
      applyFailed(e);
    }
  }

  return (
    <Card title={<><SlidersHorizontal size={16} aria-hidden /> {t('flags.title')}</>}>
      <div className="stack">
        <p className="small muted">{t('flags.mifare.hint')}</p>
        <ProtectedGate {...props} />
        {!onTrailer ? (
          <Callout tone="info">{t('flags.mifare.selectTrailer')}</Callout>
        ) : (
          <div className="stack">
            <div className="row">
              <Badge tone="warn">{t('flags.mifare.sector', { n: sector })}</Badge>
              <span className="small muted">{t('flags.mifare.trailerUnit', { n: unit })}</span>
            </div>
            <FlagRow label={t('flags.mifare.preset.transport')} help={t('flags.mifare.presetTransportHelp')}>
              <Button size="sm" disabled={disabled} onClick={() => void applyPreset('transport')}>{t('flags.mifare.apply')}</Button>
            </FlagRow>
            <FlagRow label={t('flags.mifare.preset.keyb')} help={t('flags.mifare.presetKeybHelp')}>
              <Button size="sm" disabled={disabled} onClick={() => void applyPreset('keyb')}>{t('flags.mifare.apply')}</Button>
            </FlagRow>
            <FlagRow label={t('flags.mifare.preset.readonly')} help={t('flags.mifare.presetReadonlyHelp')} danger>
              <Button size="sm" variant="danger" disabled={disabled} onClick={() => void applyPreset('readonly')}>{t('flags.mifare.apply')}</Button>
            </FlagRow>
            <p className="small muted">{t('flags.mifare.keysNote')}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

// --- FeliCa Lite-S MC --------------------------------------------------------

function FelicaFlags(props: Inner) {
  const { kind, data, original, protectedEditable, busy, onApply, t } = props;
  const mcUnit = specFor(kind).unitCount - 1; // MC is the last unit (0x88)
  const mc = useMemo(() => decodeFelicaMc(data.subarray(mcUnit * 16, mcUnit * 16 + 16)), [data, mcUnit]);
  // Write protection already latched on the tag is one-way: it cannot be cleared.
  const mcOnTag = useMemo(() => decodeFelicaMc(original.subarray(mcUnit * 16, mcUnit * 16 + 16)), [original, mcUnit]);
  const disabled = !protectedEditable || busy;

  function setWritable(block: number, v: boolean) {
    if (disabled) return;
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
        <ProtectedGate {...props} />
        <Callout tone="warn">{t('flags.felica.warn')}</Callout>
        <div className="flags-felica-grid">
          {mc.writable.map((w, block) => (
            <Checkbox
              key={block}
              checked={w}
              disabled={disabled || !mcOnTag.writable[block]}
              onChange={(v) => setWritable(block, v)}
              label={`${felicaBlockName(block)} ${t('flags.felica.writable')}`}
            />
          ))}
        </div>
        <FlagRow label={t('flags.felica.sysblocks')} help={t('flags.felica.sysblocksHelp')}>
          <Badge tone={mc.systemBlocksWritable ? 'info' : 'warn'}>
            {mc.systemBlocksWritable ? t('flags.felica.rw') : t('flags.felica.readonlyShort')}
          </Badge>
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
