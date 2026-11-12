// Batch provisioning (量産) view. Owner: renderer-issue.
// Place tags one after another; the issue engine (main) writes sequence numbers /
// CSV rows / a duplicated data area to each. The UID is read-only and is never
// duplicated - only the data area is written (invariant I1).
//
// 2026-11-12 UX audit (ISSUE-1..17, screen side):
//  - the running panel shows each step (take off / place / checking / writing)
//    and KEEPS the result of the tag just handled (colour + number + reason)
//    until the next tag, with a list of the recent results;
//  - the settings screen shows the last run (why it stopped, how many, where to
//    continue) and resumes the same job instead of restarting at 1;
//  - everything that would make the run fail or skip every tag is checked
//    BEFORE starting (disabled button + the reason), not after;
//  - sounds are played by the store (D6), not here;
//  - keep-alive: the form survives screen changes; handoffs are taken when the
//    view becomes active (useViewActive), not on mount.
//
// 2026-11-12 review, round 2:
//  - R-ISSUE-6: the running screen can take the virtual tag off / place it /
//    place a new blank one; a real tag hidden by the virtual reader blocks the
//    start, and while running there is "stop and turn the virtual reader off";
//  - R-ISSUE-9/10: why the run stopped stays on the settings screen; after a
//    failed tag, "place it again" only for passing failures, else "another tag";
//  - R-ISSUE-11: with sounds off, the hints say "until the screen shows the result";
//  - R-ISSUE-13: no "(UID )" when the tag at start was not identified;
//  - R-UX-1 / D11: protecting on a storage reader (PaSoRi) warns and needs the word;
//  - R-UX-2: the password is typed twice (must match), can be shown, and the
//    confirmation shows the values to write down and needs the word.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  CircleX,
  Copy,
  Database,
  FileText,
  FileUp,
  Hand,
  Hash,
  History,
  Key,
  Nfc,
  Play,
  Plus,
  PowerOff,
  Radio,
  RotateCcw,
  ScanLine,
  SkipForward,
  Square,
  Wand2,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ErrorCode,
  IssueEvent,
  IssueJob,
  IssueOptions,
  IssuePreview,
  IssueTemplate,
  LanguageSetting,
  MifareKeyEntry,
  UnitStatus,
} from '@shared/types';
import type { DataSchema, IssueContext } from '@shared/schema/types';
import type { NdefRecordDraft } from '@shared/ndef/types';
import type { TagKind } from '@shared/tags';
import { TAG_KINDS, isMifare, isNtag, specFor } from '@shared/tags';
import { FILE_FILTERS } from '@shared/api';
import { errorMessage } from '@shared/errorMessages';
import { expandDraft, parseCsv, renderValues } from '@shared/schema';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Tabs,
  TextInput,
} from '../../components/ui';
import type { SelectOption } from '../../components/ui';
import { useAppStore } from '../../store/app';
import type { IssueResultItem } from '../../store/app';
import { translate, useT } from '../../i18n';
import type { MsgKey, TFunc } from '../../i18n';
import { api } from '../../lib/api';
import { useViewActive } from '../../lib/viewActive';
import { formatDateTime, formatUid, kindLabel, newId } from '../../lib/format';
import {
  duplicatePlan,
  errorAdvice,
  findBadRows,
  issueMessageCode,
  issuePhase,
  issueResult,
  issueSoundOn,
  jobStamp,
  ntagPasswordsMatch,
  parseIntInput,
  phaseTone,
  previewSlots,
  readerAuth,
  resumePlan,
  schemaCsvColumns,
  schemaInputFields,
  schemaUsesSequence,
  startChecks,
  stopCauseKind,
  stopCauseMessage,
  summarizeDraft,
  validNtagSecret,
} from './model';
import type { ErrorAdvice, IssuePhase, IssueShownResult, RowProblem, StartCheck, StartCheckCode } from './model';
import './issue.css';

type TemplateType = 'schema' | 'ndef' | 'image';
interface ImageSource {
  kind: TagKind;
  data: Uint8Array;
  uid: string;
  unitStatus: UnitStatus[];
}

const PHASE_ICON: Record<IssuePhase, LucideIcon> = {
  idle: Nfc,
  clear: Hand,
  waiting: Radio,
  reading: ScanLine,
  writing: Zap,
  success: BadgeCheck,
  skipped: SkipForward,
  error: CircleX,
  remove: Hand,
  stopped: Square,
};

/** Title per phase when there is no result to show (results set their own title). */
const PHASE_TITLE: Record<IssuePhase, MsgKey> = {
  idle: 'issue.status.idle',
  clear: 'issue.status.clear',
  waiting: 'issue.status.waiting',
  reading: 'issue.status.reading',
  writing: 'issue.status.writing',
  success: 'issue.result.ok',
  skipped: 'issue.result.skipped',
  error: 'issue.result.error',
  remove: 'issue.after.ok',
  stopped: 'issue.status.stopped',
};

const OUTCOME_ICON: Record<IssueShownResult['outcome'], LucideIcon> = {
  ok: BadgeCheck,
  skipped: SkipForward,
  error: CircleX,
};

const CHECK_KEY: Record<StartCheckCode, MsgKey> = {
  service: 'issue.check.service',
  'no-reader': 'issue.check.no-reader',
  'selected-missing': 'issue.check.selected-missing',
  busy: 'issue.check.busy',
  'no-schema': 'issue.check.no-schema',
  'no-ndef': 'issue.check.no-ndef',
  'no-image': 'issue.check.no-image',
  'image-empty': 'issue.check.image-empty',
  'ndef-kind': 'issue.check.ndef-kind',
  'bad-seq': 'issue.check.bad-seq',
  'bad-limit': 'issue.check.bad-limit',
  'bad-row-start': 'issue.check.bad-row-start',
  'no-rows-left': 'issue.check.no-rows-left',
  'csv-needed': 'issue.check.csv-needed',
  'csv-missing-cols': 'issue.check.csv-missing-cols',
  'bad-rows': 'issue.check.bad-rows',
  'no-keys': 'issue.check.no-keys',
  'bad-password': 'issue.check.bad-password',
  'password-mismatch': 'issue.check.password-mismatch',
  'protect-storage': 'issue.check.protect-storage',
  'protect-reader-unknown': 'issue.check.protect-reader-unknown',
  'ndef-mifare': 'issue.check.ndef-mifare',
  virtual: 'issue.check.virtual',
  'virtual-ignored': 'issue.check.virtual-ignored',
  'kind-differs': 'issue.check.kind-differs',
  'tag-on-reader': 'issue.check.tag-on-reader',
  'source-on-reader': 'issue.check.source-on-reader',
};

/** Short, issue-specific reasons for the common failures (the next step is shown separately). */
const WHY_KEY: Partial<Record<ErrorCode, MsgKey>> = {
  CARD_REMOVED: 'issue.why.CARD_REMOVED',
  CARD_UNRESPONSIVE: 'issue.why.CARD_UNRESPONSIVE',
  VERIFY_FAILED: 'issue.why.VERIFY_FAILED',
  WRITE_FAILED: 'issue.why.WRITE_FAILED',
  READ_FAILED: 'issue.why.READ_FAILED',
  ACCESS_DENIED: 'issue.why.ACCESS_DENIED',
  AUTH_FAILED: 'issue.why.AUTH_FAILED',
  UID_MISMATCH: 'issue.why.UID_MISMATCH',
  KIND_MISMATCH: 'issue.why.KIND_MISMATCH',
  UNSUPPORTED_TAG: 'issue.why.UNSUPPORTED_TAG',
};

/**
 * Localize an engine message: an ErrorCode becomes a short reason in the issue's
 * own words (or the plain-language errorMessage), never the raw code (ISSUE-9).
 */
function localizeMessage(message: string | null | undefined, lang: LanguageSetting): string | null {
  if (!message) return null;
  const code = issueMessageCode(message);
  if (!code) return message;
  const key = WHY_KEY[code];
  return key ? translate(lang, key) : errorMessage(code, lang);
}

function checkText(t: TFunc, c: StartCheck, noSchemas = false): string {
  if (c.code === 'tag-on-reader' && !c.vars?.uid) return t('issue.check.tag-on-reader-unknown');
  if (c.code === 'no-schema' && noSchemas) return t('issue.check.no-schema-none');
  const vars: Record<string, string | number> = { ...(c.vars ?? {}) };
  if (typeof vars.uid === 'string' && vars.uid) vars.uid = formatUid(vars.uid);
  if (typeof vars.cardKind === 'string') vars.cardKind = kindLabel(vars.cardKind as TagKind);
  if (typeof vars.kind === 'string') vars.kind = kindLabel(vars.kind as TagKind);
  return t(CHECK_KEY[c.code], vars);
}

function rowProblemText(t: TFunc, p: RowProblem, schema: DataSchema | null): string {
  if (p.type === 'too-big') {
    return p.row == null
      ? t('issue.check.badRow.tooBigTemplate', { bytes: p.bytes, cap: p.cap })
      : t('issue.check.badRow.tooBig', { row: p.row, bytes: p.bytes, cap: p.cap });
  }
  const field = p.fieldId && schema ? (schema.fields.find((f) => f.id === p.fieldId)?.label ?? p.fieldId) : p.fieldId;
  if (p.row == null) {
    return field ? t('issue.check.badRow.templateField', { field, message: p.message }) : t('issue.check.badRow.template', { message: p.message });
  }
  return field
    ? t('issue.check.badRow.valueField', { row: p.row, field, message: p.message })
    : t('issue.check.badRow.value', { row: p.row, message: p.message });
}

export function IssueView() {
  const t = useT();
  const active = useViewActive();
  const lang = useAppStore((s) => s.settings.language);
  const schemas = useAppStore((s) => s.settings.schemas);
  const globalSound = useAppStore((s) => s.settings.sound);
  const advanced = useAppStore((s) => s.settings.advancedMode);
  const issue = useAppStore((s) => s.issue);
  const reader = useAppStore((s) => s.reader);
  const busyOp = useAppStore((s) => s.busyOp);
  const storeLastRun = useAppStore((s) => s.issueLastRun);
  const recent = useAppStore((s) => s.issueRecent);
  const handoff = useAppStore((s) => s.handoff);
  const docKind = useAppStore((s) => s.doc?.image.kind ?? null);
  const takeHandoff = useAppStore((s) => s.takeHandoff);
  const setView = useAppStore((s) => s.setView);
  const toastError = useAppStore((s) => s.toastError);
  const confirm = useAppStore((s) => s.confirm);

  const [template, setTemplate] = useState<TemplateType>('schema');
  const [schemaId, setSchemaId] = useState<string>('');
  const [ndefRecords, setNdefRecords] = useState<NdefRecordDraft[] | null>(null);
  const [imageSource, setImageSource] = useState<ImageSource | null>(null);
  const [kind, setKindState] = useState<TagKind>('NTAG213');
  const kindTouched = useRef(false);
  const [name, setName] = useState('');

  const [startStr, setStartStr] = useState('1');
  const [stepStr, setStepStr] = useState('1');
  const [limitStr, setLimitStr] = useState('');

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [csv, setCsv] = useState<{ name: string; header: string[]; rows: Record<string, string>[] } | null>(null);
  const [rowStartStr, setRowStartStr] = useState('1');

  const [verify, setVerify] = useState(true);
  const [skipDup, setSkipDup] = useState(true);
  const [requireBlank, setRequireBlank] = useState(false);
  const [sound, setSound] = useState(globalSound);
  const [protectOn, setProtectOn] = useState(false);
  const [ntagPwd, setNtagPwd] = useState('');
  const [ntagPwdConfirm, setNtagPwdConfirm] = useState('');
  const [ntagPack, setNtagPack] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [protectRead, setProtectRead] = useState(false);
  const [keys, setKeys] = useState<MifareKeyEntry[]>([]);
  const [selectedKeyIds, setSelectedKeyIds] = useState<string[]>([]);
  const keysTouched = useRef(false);

  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Tags issued by earlier runs of a job (job id -> count), for "resume" totals and the remaining limit. */
  const carried = useRef<Record<string, number>>({});

  const schema = useMemo(() => schemas.find((s) => s.id === schemaId) ?? null, [schemas, schemaId]);

  // The last finished run: the store keeps it (issueLastRun). Until the store has
  // one, fall back to the engine's 'stopped' event itself, so the reason, the
  // count and "resume" never silently disappear (ISSUE-7).
  const stoppedSeen = useRef<{ ev: IssueEvent; at: number } | null>(null);
  const lastEv = issue.last;
  if (lastEv?.type === 'stopped' && stoppedSeen.current?.ev !== lastEv) stoppedSeen.current = { ev: lastEv, at: Date.now() };
  const lastRun =
    storeLastRun ??
    (!issue.running && lastEv?.type === 'stopped' && stoppedSeen.current?.ev === lastEv
      ? { reason: lastEv.reason, issued: lastEv.issued, endedAt: stoppedSeen.current.at, job: lastEv.job ?? null }
      : null);

  // Load the operator's MIFARE keys (labels + masked bytes only) whenever the view
  // is shown (keys may have been added on the Keys screen). The public built-in
  // keys (factory default etc., I3) are selected by default until the operator
  // changes the selection, so a factory MIFARE tag does not fail every block.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    api
      .listKeys()
      .then((k) => {
        if (!alive) return;
        setKeys(k);
        setSelectedKeyIds((ids) =>
          keysTouched.current ? ids.filter((id) => k.some((x) => x.id === id)) : k.filter((x) => x.builtin).map((x) => x.id),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active]);

  // Pick up a handoff from another view (NDEF editor, schema designer, backup)
  // when this view is shown (keep-alive: not on mount).
  useEffect(() => {
    if (!active || !handoff) return;
    if (handoff.kind === 'issue-schema') {
      const hs = takeHandoff('issue-schema');
      if (hs) {
        setTemplate('schema');
        setSchemaId(hs.schemaId);
      }
    } else if (handoff.kind === 'issue-ndef') {
      const hn = takeHandoff('issue-ndef');
      if (hn) {
        setTemplate('ndef');
        setNdefRecords(hn.records);
      }
    } else if (handoff.kind === 'issue-image') {
      if (takeHandoff('issue-image')) {
        setTemplate('image');
        const doc = useAppStore.getState().doc;
        if (doc) {
          setImageSource({
            kind: doc.image.kind,
            data: new Uint8Array(doc.image.data),
            uid: doc.image.uid,
            unitStatus: [...doc.image.unitStatus],
          });
        }
      }
    }
  }, [active, handoff, takeHandoff]);

  // Default the schema selection to the first available one.
  useEffect(() => {
    if (template === 'schema' && !schemaId && schemas.length > 0) setSchemaId(schemas[0].id);
  }, [template, schemaId, schemas]);

  // Reset the stop button once the run has ended. "Stop and turn the virtual
  // reader off" (R-ISSUE-6) turns it off only after the run has really ended,
  // so a tag being written is never pulled off mid-write.
  const virtualOffAfterStop = useRef(false);
  useEffect(() => {
    if (issue.running) return;
    setStopping(false);
    if (virtualOffAfterStop.current) {
      virtualOffAfterStop.current = false;
      api.setSimulator({ enabled: false }).catch((err) => toastError(err));
    }
  }, [issue.running, toastError]);

  // Keep `kind` consistent with the template, and default it to the tag on the
  // reader / the open document until the operator picks one (ISSUE-10).
  const allowedKinds: TagKind[] =
    template === 'schema' && schema && schema.tagKinds.length > 0 ? schema.tagKinds : TAG_KINDS;
  const cardKind = reader?.cardState === 'ready' ? (reader.card?.kind ?? null) : null;
  useEffect(() => {
    if (issue.running) return;
    if (template === 'image') {
      if (imageSource && kind !== imageSource.kind) setKindState(imageSource.kind);
      return;
    }
    const preferred = [cardKind, docKind].find((k): k is TagKind => !!k && allowedKinds.includes(k)) ?? null;
    if (!allowedKinds.includes(kind)) {
      setKindState(preferred ?? allowedKinds[0]);
      return;
    }
    if (!kindTouched.current && active && preferred && preferred !== kind) setKindState(preferred);
  }, [template, imageSource, kind, cardKind, docKind, allowedKinds, active, issue.running]);

  function chooseKind(k: TagKind) {
    kindTouched.current = true;
    setKindState(k);
  }

  const effKind: TagKind = template === 'image' && imageSource ? imageSource.kind : kind;
  const inputFields = schema ? schemaInputFields(schema) : [];
  const csvColumns = template === 'schema' && schema ? schemaCsvColumns(schema) : [];

  // ---- parsed form values ----
  const start = parseIntInput(startStr);
  const step = parseIntInput(stepStr);
  const seqOk = start !== null && step !== null;
  const limitBlank = limitStr.trim() === '';
  const limitParsed = limitBlank ? null : parseIntInput(limitStr);
  const limitOk = limitBlank || (limitParsed !== null && limitParsed > 0);
  const rowStartNum = parseIntInput(rowStartStr);
  const freshRowStart = csv ? (rowStartNum !== null && rowStartNum >= 1 ? rowStartNum - 1 : null) : 0;

  const dup = useMemo(() => (imageSource ? duplicatePlan(imageSource.kind, imageSource.unitStatus) : null), [imageSource]);

  const tpl: IssueTemplate | null = useMemo(() => {
    if (template === 'schema') return schema ? { type: 'schema', schema, inputs } : null;
    if (template === 'ndef') return ndefRecords && ndefRecords.length > 0 ? { type: 'ndef', records: ndefRecords } : null;
    if (!imageSource || !dup) return null;
    return { type: 'image', kind: imageSource.kind, data: imageSource.data, units: dup.units, sourceUid: imageSource.uid };
  }, [template, schema, inputs, ndefRecords, imageSource, dup]);

  // ---- resume (ISSUE-3/7) ----
  const plan = resumePlan(lastRun, {
    carried: lastRun?.job ? (carried.current[lastRun.job.id] ?? 0) : 0,
    limit: limitOk ? limitParsed : null,
    rowCount: csv ? csv.rows.length : null,
    rowStart: freshRowStart ?? 0,
  });

  // ---- checks before starting (ISSUE-4/5/10) ----
  const effectiveProtect = advanced && protectOn && isNtag(effKind);
  const badPassword = effectiveProtect && !validNtagSecret(ntagPwd, ntagPack);
  // R-UX-2: a typo would lock every issued tag with an unknown password.
  const passwordMismatch = effectiveProtect && !badPassword && !ntagPasswordsMatch(ntagPwd, ntagPwdConfirm);
  // R-UX-1 / D11: a storage reader (PaSoRi) cannot authenticate with the password later.
  const auth = readerAuth(reader);

  const badRowsFresh = useMemo(
    () =>
      tpl && start !== null && step !== null && freshRowStart !== null
        ? findBadRows({ template: tpl, kind: effKind, rows: csv?.rows ?? null, rowStart: freshRowStart, next: start, step, now: new Date() })
        : null,
    [tpl, effKind, csv, freshRowStart, start, step],
  );
  const planNext = plan?.next ?? null;
  const planRow = plan?.rowIndex ?? null;
  const badRowsResume = useMemo(
    () =>
      tpl && planNext !== null && planRow !== null && step !== null
        ? findBadRows({ template: tpl, kind: effKind, rows: csv?.rows ?? null, rowStart: planRow, next: planNext, step, now: new Date() })
        : null,
    [tpl, effKind, csv, planRow, planNext, step],
  );

  function checksFor(rowStart: number | null, badRows: { count: number } | null): StartCheck[] {
    return startChecks({
      reader,
      busyOp,
      template,
      templateReady: !!tpl,
      imageUnits: template === 'image' && dup ? dup.units.length : null,
      kind: effKind,
      seqOk,
      limitOk,
      csv: csv ? { header: csv.header, rowCount: csv.rows.length } : null,
      rowStart,
      csvColumns,
      badRows,
      mifareKeys: selectedKeyIds.length,
      badPassword,
      protect: effectiveProtect,
      passwordMismatch,
      readerAuth: auth,
      sourceUid: template === 'image' ? (imageSource?.uid ?? null) : null,
    });
  }
  const checksFresh = checksFor(freshRowStart, badRowsFresh);
  const checksResume = plan ? checksFor(plan.rowIndex, badRowsResume) : null;
  const checks = checksResume ?? checksFresh;
  const blocks = checks.filter((c) => c.level === 'block');
  const notices = checks.filter((c) => c.level !== 'block');
  const freshBlocked = checksFresh.some((c) => c.level === 'block');
  const shownBadRows = plan ? badRowsResume : badRowsFresh;

  async function loadCsv() {
    try {
      const file = await api.openFile({ title: t('issue.csv.load'), filters: [FILE_FILTERS.csv] });
      if (!file) return;
      const text = new TextDecoder().decode(file.bytes);
      const parsed = parseCsv(text);
      setCsv({ name: file.name, header: parsed.header, rows: parsed.rows });
      setRowStartStr('1');
    } catch (err) {
      toastError(err);
    }
  }

  function options(): IssueOptions {
    return {
      verify,
      skipDuplicateUid: skipDup,
      requireBlank,
      ntagProtect: effectiveProtect ? { password: ntagPwd.trim(), pack: ntagPack.trim(), protectRead } : null,
      mifareKeyIds: isMifare(effKind) ? selectedKeyIds : [],
      sound,
    };
  }

  /**
   * Password protection is hard to undo: confirm it once per start (I5), with
   * the values to write down (R-UX-2: shown on screen only - never in the log or
   * a dump, I4) and a typed word. On a storage reader (D11) the box says this
   * reader can never rewrite (or read) the protected tags.
   */
  async function confirmProtect(): Promise<boolean> {
    if (!effectiveProtect) return true;
    const pwd = ntagPwd.trim().toUpperCase();
    const pack = ntagPack.trim().toUpperCase();
    return confirm({
      title: t('issue.protect.title'),
      message: t('issue.protect.msg'),
      warning: auth === 'storage' ? t(protectRead ? 'issue.protect.storageRead' : 'issue.protect.storage') : undefined,
      details: [
        t('issue.protect.secret', { pwd, pack }),
        ...(protectRead ? [t('issue.protect.readToo')] : []),
        ...(auth === 'unknown' ? [t('issue.protect.readerUnknown')] : []),
        t('issue.protect.reactivate'),
      ],
      tone: 'danger',
      typeToConfirm: t('issue.protect.word'),
      confirmLabel: t('issue.protect.confirm'),
    });
  }

  async function launch(job: IssueJob, issuedBefore: number) {
    if (!(await confirmProtect())) return;
    setStarting(true);
    try {
      carried.current[job.id] = issuedBefore;
      await api.startIssue(job);
    } catch (err) {
      toastError(err);
    } finally {
      setStarting(false);
    }
  }

  async function onStartFresh(opts: { askRestart: boolean }) {
    if (!tpl || start === null || step === null || freshRowStart === null || freshBlocked) return;
    if (opts.askRestart) {
      const ok = await confirm({
        title: t('issue.restart.title'),
        message: t('issue.restart.msg'),
        details: [
          t('issue.restart.detail.seq', { seq: start }),
          ...(csv ? [t('issue.restart.detail.row', { row: freshRowStart + 1 })] : []),
          t('issue.restart.detail.dup'),
        ],
        tone: 'warn',
        confirmLabel: t('issue.restart.confirm'),
      });
      if (!ok) return;
    }
    await launch(
      {
        id: newId('job'),
        name: name.trim() || t('issue.name.default', { stamp: jobStamp(new Date()) }),
        kind: effKind,
        template: tpl,
        sequence: { start, step, next: start },
        rows: csv ? csv.rows : null,
        rowIndex: csv ? freshRowStart : 0,
        options: options(),
        limit: limitOk ? limitParsed : null,
      },
      0,
    );
  }

  async function onResume() {
    if (!plan || !tpl || step === null || blocks.length > 0) return;
    await launch(
      {
        id: plan.id,
        name: plan.name,
        kind: effKind,
        template: tpl,
        sequence: { start: start ?? plan.next, step, next: plan.next },
        rows: csv ? csv.rows : null,
        rowIndex: csv ? plan.rowIndex : 0,
        options: options(),
        limit: plan.limit,
      },
      plan.issuedTotal,
    );
  }

  function onStop() {
    setStopping(true);
    api.stopIssue().catch((err) => {
      setStopping(false);
      virtualOffAfterStop.current = false;
      toastError(err);
    });
  }

  /** R-ISSUE-6: a real tag is hidden by the virtual reader - stop, then turn the virtual reader off. */
  function onStopAndVirtualOff() {
    virtualOffAfterStop.current = true;
    onStop();
  }

  // ======================= running =======================
  if (issue.running) {
    return (
      <RunningPanel
        last={issue.last}
        issued={issue.issued}
        jobKind={issue.job?.kind ?? null}
        recent={recent}
        stopping={stopping}
        onStop={onStop}
        onStopAndVirtualOff={onStopAndVirtualOff}
        soundOn={issueSoundOn(issue.job?.options.sound, globalSound)}
        lang={lang}
      />
    );
  }

  // ======================= configuration =======================
  const kindOptions: SelectOption<TagKind>[] = allowedKinds.map((k) => ({ value: k, label: kindLabel(k) }));
  const templateItems = [
    { id: 'schema' as const, label: t('issue.template.schema'), icon: Database },
    { id: 'ndef' as const, label: t('issue.template.ndef'), icon: FileText },
    { id: 'image' as const, label: t('issue.template.image'), icon: Copy },
  ];

  const previewNext = plan ? plan.next : (start ?? 0);
  const previewRow = plan ? plan.rowIndex : (freshRowStart ?? 0);
  const slots = previewSlots({
    sequence: { start: start ?? 0, step: step ?? 1, next: previewNext },
    rowCount: csv ? csv.rows.length : null,
    rowStart: previewRow,
    limit: plan ? plan.limit : limitOk ? limitParsed : null,
    count: 5,
  });

  function previewValuesFor(seq: number, rowIndex: number | null): { values: Record<string, string> | null; ok: boolean } {
    const ctx: IssueContext = {
      seq,
      row: csv && rowIndex != null ? (csv.rows[rowIndex] ?? null) : null,
      inputs,
      uid: null,
      now: new Date(),
    };
    try {
      if (template === 'schema' && schema) return { values: renderValues(schema, ctx), ok: true };
      if (template === 'ndef' && ndefRecords) {
        const out: Record<string, string> = {};
        ndefRecords.forEach((r, i) => {
          let summary: string;
          try {
            summary = summarizeDraft(expandDraft(r, ctx));
          } catch {
            summary = summarizeDraft(r);
          }
          out[`#${i + 1}`] = summary;
        });
        return { values: out, ok: true };
      }
    } catch {
      return { values: null, ok: false };
    }
    return { values: {}, ok: true };
  }

  const usesSeq = template === 'schema' ? (schema ? schemaUsesSequence(schema) : false) : template === 'ndef';
  const defaultName = t('issue.name.default', { stamp: jobStamp(new Date()) });
  const primaryBlocked = blocks.length > 0 || starting;

  const headerActions = (
    <>
      {primaryBlocked && blocks.length > 0 ? (
        <span className="issue-block-reason" data-testid="issue-start-reason">
          {checkText(t, blocks[0], schemas.length === 0)}
        </span>
      ) : null}
      {plan ? (
        <Button
          icon={RotateCcw}
          onClick={() => void onStartFresh({ askRestart: true })}
          disabled={freshBlocked || starting}
          title={freshBlocked ? checkText(t, checksFresh.find((c) => c.level === 'block')!) : undefined}
          data-testid="issue-restart"
        >
          {t('issue.restart')}
        </Button>
      ) : null}
      {plan ? (
        <Button variant="primary" icon={Play} onClick={() => void onResume()} disabled={primaryBlocked} loading={starting} data-testid="issue-resume">
          {t('issue.resume')}
        </Button>
      ) : (
        <Button
          variant="primary"
          icon={Zap}
          onClick={() => void onStartFresh({ askRestart: false })}
          disabled={primaryBlocked}
          loading={starting}
          data-testid="issue-start"
        >
          {t('issue.start')}
        </Button>
      )}
    </>
  );

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader title={t('issue.title')} subtitle={t('issue.subtitle')} helpTopic="issue" actions={headerActions} />

        <div className="stack-lg">
          {lastRun ? <LastRunCallout lastRun={lastRun} plan={plan} cause={stopCauseMessage(lastRun, recent)} lang={lang} /> : null}

          <IssueReaderLine running={false} />

          {blocks.length > 0 ? (
            <div data-testid="issue-blocks">
              <Callout tone="danger" title={t('issue.check.blockTitle')}>
                <ul className="issue-check-list">
                  {blocks.map((c) => (
                    <li key={c.code}>
                      {checkText(t, c, schemas.length === 0)}
                      {c.code === 'bad-rows' && shownBadRows ? (
                        <ul className="issue-check-sublist">
                          {shownBadRows.first.map((p, i) => (
                            <li key={i}>{rowProblemText(t, p, schema)}</li>
                          ))}
                          {shownBadRows.count > shownBadRows.first.length ? (
                            <li className="muted">{t('issue.check.badRow.more', { n: shownBadRows.count - shownBadRows.first.length })}</li>
                          ) : null}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}
          {notices.length > 0 ? (
            <div data-testid="issue-notices">
              <Callout tone={notices.some((c) => c.level === 'warn') ? 'warn' : 'info'} title={t('issue.check.noticeTitle')}>
                <ul className="issue-check-list">
                  {notices.map((c) => (
                    <li key={c.code}>{checkText(t, c)}</li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}

          <Callout tone="info" title={t('issue.uidNotice')} />

          <Card title={t('issue.template')} icon={Wand2}>
            <div className="stack">
              <Tabs items={templateItems} value={template} onChange={(v) => setTemplate(v)} />
              {template === 'schema' ? (
                <SchemaConfig
                  schemas={schemas}
                  schema={schema}
                  schemaId={schemaId}
                  onSelect={setSchemaId}
                  inputFields={inputFields}
                  csvColumns={csvColumns}
                  inputs={inputs}
                  setInputs={setInputs}
                  onCreate={() => setView('schema')}
                />
              ) : template === 'ndef' ? (
                <NdefConfig records={ndefRecords} onClear={() => setNdefRecords(null)} onOpen={() => setView('ndef')} />
              ) : (
                <ImageConfig source={imageSource} plan={dup} onOpen={() => setView('backup')} />
              )}
            </div>
          </Card>

          <div className="grid-2">
            <Card title={t('issue.sequence')} icon={Hash}>
              <div className="stack">
                {!usesSeq && (template !== 'schema' || schema) ? <div className="muted small">{t('issue.sequence.unused')}</div> : null}
                <div className="row">
                  <Field label={t('issue.sequence.start')} className="grow">
                    <TextInput
                      value={startStr}
                      mono
                      inputMode="numeric"
                      invalid={start === null}
                      aria-label={t('issue.sequence.start')}
                      onChange={(e) => setStartStr(e.target.value)}
                    />
                  </Field>
                  <Field label={t('issue.sequence.step')} className="grow">
                    <TextInput
                      value={stepStr}
                      mono
                      inputMode="numeric"
                      invalid={step === null}
                      aria-label={t('issue.sequence.step')}
                      onChange={(e) => setStepStr(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="field-hint">{t('issue.sequence.help')}</div>
                {plan && usesSeq ? <div className="field-hint">{t('issue.sequence.resume', { seq: plan.next })}</div> : null}
              </div>
            </Card>

            <Card title={t('issue.csv')} icon={FileUp}>
              <div className="stack">
                {csv ? (
                  <>
                    <div className="row-between">
                      <div>{t('issue.csv.loaded', { name: csv.name, rows: csv.rows.length, cols: csv.header.length })}</div>
                      <Button size="sm" variant="ghost" onClick={() => setCsv(null)}>
                        {t('issue.csv.clear')}
                      </Button>
                    </div>
                    <div className="muted small">{t('issue.csv.columns', { cols: csv.header.join(', ') })}</div>
                    <Field label={t('issue.csv.startRow')} hint={t('issue.csv.startRow.hint', { rows: csv.rows.length })}>
                      <TextInput
                        value={rowStartStr}
                        mono
                        inputMode="numeric"
                        invalid={freshRowStart === null}
                        aria-label={t('issue.csv.startRow')}
                        onChange={(e) => setRowStartStr(e.target.value)}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Button icon={FileUp} onClick={loadCsv}>
                      {t('issue.csv.load')}
                    </Button>
                    <div className="field-hint">{t('issue.csv.hint')}</div>
                  </>
                )}
              </div>
            </Card>
          </div>

          <Card title={t('issue.options')}>
            <div className="stack">
              <Field label={t('issue.name')} hint={t('issue.name.hint', { name: defaultName })}>
                <TextInput
                  value={name}
                  placeholder={t('issue.name.placeholder')}
                  aria-label={t('issue.name')}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <div className="grid-2">
                <Field label={t('issue.kind')} hint={template === 'image' ? t('issue.kind.fixed') : t('issue.kind.hint')}>
                  <Select
                    value={effKind}
                    options={template === 'image' && imageSource ? [{ value: imageSource.kind, label: kindLabel(imageSource.kind) }] : kindOptions}
                    onChange={chooseKind}
                    disabled={template === 'image'}
                    aria-label={t('issue.kind')}
                  />
                </Field>
                <Field label={t('issue.limit')} hint={t('issue.limit.help')}>
                  <TextInput
                    value={limitStr}
                    mono
                    inputMode="numeric"
                    invalid={!limitOk}
                    placeholder={t('issue.limit.placeholder')}
                    aria-label={t('issue.limit')}
                    onChange={(e) => setLimitStr(e.target.value)}
                  />
                </Field>
              </div>
              <Checkbox checked={verify} onChange={setVerify} label={t('issue.opt.verify')} />
              <Checkbox checked={skipDup} onChange={setSkipDup} label={t('issue.opt.skipDup')} />
              <Checkbox checked={requireBlank} onChange={setRequireBlank} label={t('issue.opt.requireBlank')} />
              <div className="issue-stack-sm">
                <Checkbox checked={sound} onChange={setSound} label={t('issue.opt.sound')} />
                {sound && !globalSound ? <div className="field-hint">{t('issue.opt.sound.off')}</div> : null}
              </div>

              {isNtag(effKind) ? (
                <div className="stack">
                  <Checkbox
                    checked={advanced && protectOn}
                    onChange={setProtectOn}
                    disabled={!advanced}
                    label={t('issue.opt.ntagProtect')}
                  />
                  <div className="field-hint">{advanced ? t('issue.opt.ntagProtect.hint') : t('issue.opt.ntagProtect.advanced')}</div>
                  {effectiveProtect ? (
                    <div className="stack" data-testid="issue-protect">
                      <div className="grid-2">
                        <Field label={t('issue.opt.ntagPwd')}>
                          <TextInput
                            type={showSecret ? 'text' : 'password'}
                            mono
                            autoComplete="off"
                            spellCheck={false}
                            value={ntagPwd}
                            invalid={badPassword && !/^[0-9a-fA-F]{8}$/.test(ntagPwd.trim())}
                            aria-label={t('issue.opt.ntagPwd')}
                            data-testid="issue-ntag-pwd"
                            onChange={(e) => setNtagPwd(e.target.value)}
                          />
                        </Field>
                        <Field
                          label={t('issue.opt.ntagPwdConfirm')}
                          error={passwordMismatch && ntagPwdConfirm.trim() !== '' ? t('issue.opt.ntagPwdMismatch') : undefined}
                        >
                          <TextInput
                            type={showSecret ? 'text' : 'password'}
                            mono
                            autoComplete="off"
                            spellCheck={false}
                            value={ntagPwdConfirm}
                            invalid={passwordMismatch && ntagPwdConfirm.trim() !== ''}
                            aria-label={t('issue.opt.ntagPwdConfirm')}
                            data-testid="issue-ntag-pwd-confirm"
                            onChange={(e) => setNtagPwdConfirm(e.target.value)}
                          />
                        </Field>
                        <Field label={t('issue.opt.ntagPack')}>
                          <TextInput
                            type={showSecret ? 'text' : 'password'}
                            mono
                            autoComplete="off"
                            spellCheck={false}
                            value={ntagPack}
                            invalid={badPassword && !/^[0-9a-fA-F]{4}$/.test(ntagPack.trim())}
                            aria-label={t('issue.opt.ntagPack')}
                            data-testid="issue-ntag-pack"
                            onChange={(e) => setNtagPack(e.target.value)}
                          />
                        </Field>
                      </div>
                      <Checkbox checked={showSecret} onChange={setShowSecret} label={t('issue.opt.ntagShow')} />
                      <Checkbox checked={protectRead} onChange={setProtectRead} label={t('issue.opt.protectRead')} />
                      {auth === 'storage' ? (
                        <Callout tone="warn">{t('issue.check.protect-storage')}</Callout>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {isMifare(effKind) ? (
                <Field label={t('issue.opt.keys')} hint={t('issue.opt.keys.hint')}>
                  {keys.length === 0 ? (
                    <div className="muted small">{t('issue.opt.keys.none')}</div>
                  ) : (
                    <div className="issue-keylist">
                      {keys.map((k) => (
                        <Checkbox
                          key={k.id}
                          checked={selectedKeyIds.includes(k.id)}
                          onChange={(on) => {
                            keysTouched.current = true;
                            setSelectedKeyIds((ids) => (on ? [...ids, k.id] : ids.filter((x) => x !== k.id)));
                          }}
                          label={
                            <span className="row">
                              <Key size={14} aria-hidden />
                              {k.label}
                              <span className="muted mono small">{k.masked}</span>
                            </span>
                          }
                        />
                      ))}
                    </div>
                  )}
                </Field>
              ) : null}
            </div>
          </Card>

          <Card title={t('issue.preview')} icon={BadgeCheck} flush>
            {template === 'image' ? (
              <div className="card-body muted">{t('issue.template.image.hint')}</div>
            ) : slots.length === 0 ? (
              <div className="card-body muted">{t('issue.preview.none')}</div>
            ) : (
              <div className="issue-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {usesSeq ? <th>{t('issue.preview.seq')}</th> : null}
                      {csv ? <th>{t('issue.preview.row')}</th> : null}
                      <th>{t('log.col.values')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((slot) => {
                      const { values, ok } = previewValuesFor(slot.seq, slot.rowIndex);
                      return (
                        <tr key={slot.index}>
                          <td className="muted">{slot.index + 1}</td>
                          {usesSeq ? <td className="issue-seq">{slot.seq}</td> : null}
                          {csv ? <td className="issue-seq">{slot.rowIndex != null ? slot.rowIndex + 1 : '—'}</td> : null}
                          <td>
                            {!ok ? (
                              <span className="muted small">{t('issue.preview.unavailable')}</span>
                            ) : (
                              <ValuesInline values={values ?? {}} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function LastRunCallout({
  lastRun,
  plan,
  cause,
  lang,
}: {
  lastRun: { reason: 'user' | 'limit' | 'rows-exhausted' | 'error'; issued: number; endedAt: number; job: IssueJob | null };
  plan: ReturnType<typeof resumePlan>;
  /** The message of the error that stopped the run (R-ISSUE-9), or null. */
  cause: string | null;
  lang: LanguageSetting;
}) {
  const t = useT();
  const tone = lastRun.reason === 'error' ? 'danger' : lastRun.reason === 'user' ? 'info' : 'ok';
  const causeText = lastRun.reason === 'error' ? localizeMessage(cause, lang) : null;
  // "Check the reader and the tag" only when the reader is the cause (or unknown):
  // a template / CSV problem says what to fix in its own words (R-ISSUE-9).
  const readerHint = lastRun.reason === 'error' && stopCauseKind(cause) !== 'other';
  const hasRows = !!lastRun.job?.rows;
  let resumeLine: string | null = null;
  if (plan) {
    const usesSeq = lastRun.job?.template.type !== 'image';
    if (usesSeq && hasRows) resumeLine = t('issue.last.resume.seqRow', { seq: plan.next, row: plan.rowIndex + 1 });
    else if (usesSeq) resumeLine = t('issue.last.resume.seq', { seq: plan.next });
    else if (hasRows) resumeLine = t('issue.last.resume.row', { row: plan.rowIndex + 1 });
    else resumeLine = t('issue.last.resume.plain');
  }
  return (
    <div data-testid="issue-last-run" data-reason={lastRun.reason}>
      <Callout tone={tone} icon={History} title={t(`issue.last.${lastRun.reason}` as MsgKey)}>
        <div className="issue-stack-sm">
          <div>{t('issue.last.issued', { at: formatDateTime(lastRun.endedAt, lang), n: lastRun.issued })}</div>
          {plan && plan.issuedTotal !== lastRun.issued ? <div>{t('issue.last.total', { n: plan.issuedTotal })}</div> : null}
          {lastRun.job ? <div className="muted small">{t('issue.last.job', { name: lastRun.job.name })}</div> : null}
          {causeText ? <div data-testid="issue-last-cause">{t('issue.last.cause', { reason: causeText })}</div> : null}
          {readerHint ? <div>{t('issue.last.errorHint')}</div> : null}
          {resumeLine ? <div className="issue-strong">{resumeLine}</div> : <div>{t('issue.last.noResume')}</div>}
          {plan && plan.limit != null ? <div className="muted small">{t('issue.last.resume.limit', { n: plan.limit })}</div> : null}
        </div>
      </Callout>
    </div>
  );
}

function ValuesInline({ values }: { values: Record<string, string> }) {
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

function SchemaConfig({
  schemas,
  schema,
  schemaId,
  onSelect,
  inputFields,
  csvColumns,
  inputs,
  setInputs,
  onCreate,
}: {
  schemas: DataSchema[];
  schema: DataSchema | null;
  schemaId: string;
  onSelect: (id: string) => void;
  inputFields: ReturnType<typeof schemaInputFields>;
  csvColumns: string[];
  inputs: Record<string, string>;
  setInputs: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  onCreate: () => void;
}) {
  const t = useT();
  if (schemas.length === 0) {
    return (
      <EmptyState icon={Database} title={t('issue.schema.none')} action={<Button icon={Wand2} onClick={onCreate}>{t('issue.schema.create')}</Button>} />
    );
  }
  const options: SelectOption<string>[] = schemas.map((s) => ({ value: s.id, label: s.name }));
  return (
    <div className="stack">
      <div className="muted small">{t('issue.template.schema.hint')}</div>
      <Field label={t('issue.schema.select')}>
        <Select value={schemaId} options={options} onChange={onSelect} aria-label={t('issue.schema.select')} />
      </Field>
      {csvColumns.length > 0 ? <Callout tone="info">{t('issue.schema.csvNeeded', { cols: csvColumns.join(', ') })}</Callout> : null}
      {schema && inputFields.length > 0 ? (
        <Field label={t('issue.schema.inputs')}>
          <div className="stack">
            {inputFields.map((f) => (
              <Field key={f.id} label={f.label}>
                <TextInput
                  value={inputs[f.id] ?? (f.source.kind === 'input' ? f.source.defaultValue : '')}
                  aria-label={f.label}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [f.id]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        </Field>
      ) : null}
    </div>
  );
}

function NdefConfig({ records, onClear, onOpen }: { records: NdefRecordDraft[] | null; onClear: () => void; onOpen: () => void }) {
  const t = useT();
  if (!records || records.length === 0) {
    return (
      <EmptyState icon={FileText} title={t('issue.ndef.fromEditor')} action={<Button icon={FileText} onClick={onOpen}>{t('issue.ndef.open')}</Button>} />
    );
  }
  return (
    <div className="stack">
      <div className="muted small">{t('issue.template.ndef.hint')}</div>
      <div className="row-between">
        <Badge tone="accent" icon={FileText}>
          {t('issue.ndef.records', { n: records.length })}
        </Badge>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t('issue.ndef.clear')}
        </Button>
      </div>
      <ul className="stack">
        {records.map((r, i) => (
          <li key={i} className="small">
            <span className="muted mono">#{i + 1}</span> {summarizeDraft(r)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImageConfig({
  source,
  plan,
  onOpen,
}: {
  source: ImageSource | null;
  plan: { units: number[]; unread: number[] } | null;
  onOpen: () => void;
}) {
  const t = useT();
  if (!source || !plan) {
    return <EmptyState icon={Copy} title={t('issue.image.none')} action={<Button icon={Database} onClick={onOpen}>{t('issue.image.open')}</Button>} />;
  }
  const spec = specFor(source.kind);
  const isPage = spec.unit === 'page';
  // Only the data units that were actually read are copied (ISSUE-12); never the
  // UID / CC / config / trailers (I1). The byte count is what is written.
  const n = plan.units.length;
  const bytes = n * spec.unitSize;
  return (
    <div className="stack">
      <div className="muted small">{t('issue.template.image.hint')}</div>
      <Callout tone="ok" icon={Copy} title={t('issue.image.source')}>
        {t(isPage ? 'issue.image.summary.page' : 'issue.image.summary.block', {
          kind: kindLabel(source.kind),
          uid: formatUid(source.uid),
          n,
          bytes,
        })}
      </Callout>
      {plan.unread.length > 0 ? (
        <Callout tone="warn">
          {t(isPage ? 'issue.image.unread.page' : 'issue.image.unread.block', { n: plan.unread.length })}
        </Callout>
      ) : null}
      <div className="field-hint">{t('issue.image.sourceSkip', { uid: formatUid(source.uid) })}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reader line (both screens). The issue screen shows the ACTIVE reader and the
// tag on it like the shared TagOnReader, but without its "this tag differs from
// the open document - read it" note, which does not apply to issuing (every tag
// placed here is a different tag). ISSUE-6/10: which reader, and red when the
// reader is gone or the tag cannot be read.
// ---------------------------------------------------------------------------

function IssueReaderLine({ running }: { running: boolean }) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const lang = useAppStore((s) => s.settings.language);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const toastError = useAppStore((s) => s.toastError);
  const [working, setWorking] = useState(false);

  const state = reader?.cardState ?? 'no-reader';
  const active = reader?.activeReader ? reader.readers.find((r) => r.name === reader.activeReader) : undefined;
  const selectedMissing = reader?.activeReason === 'selected-missing';
  const card = reader?.card ?? null;

  const tone = state === 'ready' ? 'ok' : state === 'error' || state === 'unsupported' || state === 'no-reader' ? 'danger' : state === 'detecting' ? 'info' : 'neutral';
  const label =
    state === 'ready' && card
      ? t('issue.reader.state.ready', { kind: kindLabel(card.kind), uid: formatUid(card.uid) })
      : state === 'error' && card?.uid
        ? t('issue.reader.state.errorUid', { uid: formatUid(card.uid) })
        : t(`issue.reader.state.${state}` as MsgKey);

  let problem: string | null = null;
  if (state === 'no-reader') {
    problem = selectedMissing
      ? t('issue.check.selected-missing', { name: reader?.selectedReader ?? '' })
      : running
        ? t('issue.reader.lost')
        : null; // the start checks already explain it on the settings screen
  } else if (state === 'error' || state === 'unsupported') {
    problem = reader?.cardError && reader.cardError !== 'UNSUPPORTED_TAG' ? errorMessage(reader.cardError, lang) : t(`issue.reader.hint.${state}`);
  }

  function act(fn: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    fn()
      .catch((err) => toastError(err))
      .finally(() => setWorking(false));
  }

  return (
    <div className="issue-reader-line" data-testid="issue-reader" data-card-state={state} data-tone={tone}>
      <div className="issue-reader-row">
        <Badge tone={tone}>{label}</Badge>
        <span className="small muted">
          {active ? t('issue.reader.using', { name: active.virtual ? t('issue.reader.virtual') : active.name }) : t('issue.reader.none')}
        </span>
        {!running && (state === 'error' || state === 'unsupported') ? (
          <Button size="sm" icon={RotateCcw} loading={working} onClick={() => act(() => api.reidentify())}>
            {t('issue.reader.retry')}
          </Button>
        ) : null}
        {selectedMissing ? (
          <Button
            size="sm"
            loading={working}
            onClick={() =>
              act(async () => {
                await saveSettings((s) => ({ ...s, preferredReader: null }));
                await api.selectReader(null);
              })
            }
          >
            {t('issue.reader.useAuto')}
          </Button>
        ) : null}
        {reader?.ignoredRealReader && !running ? (
          <Button size="sm" loading={working} onClick={() => act(() => api.setSimulator({ enabled: false }))}>
            {t('issue.reader.virtualOff')}
          </Button>
        ) : null}
      </div>
      {problem ? <div className="issue-reader-problem">{problem}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running panel
// ---------------------------------------------------------------------------

/** After a failed tag: the next step, matching the reason shown above it (R-ISSUE-10). */
const AFTER_ERROR: Record<ErrorAdvice, MsgKey | null> = {
  'retry-same': 'issue.after.error',
  'use-another': 'issue.after.errorAnother',
  partial: 'issue.after.partial',
  none: null,
};

function RunningPanel({
  last,
  issued,
  jobKind,
  recent,
  stopping,
  onStop,
  onStopAndVirtualOff,
  soundOn,
  lang,
}: {
  last: IssueEvent | null;
  issued: number;
  jobKind: TagKind | null;
  recent: IssueResultItem[];
  stopping: boolean;
  onStop: () => void;
  onStopAndVirtualOff: () => void;
  /** A sound plays for each result (job option AND Settings). Off: the hints wait for the screen instead (R-ISSUE-11). */
  soundOn: boolean;
  lang: LanguageSetting;
}) {
  const t = useT();
  const phase = issuePhase(last);
  const result = issueResult(last, recent[0] ?? null);
  const tone = phaseTone(phase, result?.outcome ?? null);
  const Icon = result ? OUTCOME_ICON[result.outcome] : PHASE_ICON[phase];

  let title = t(PHASE_TITLE[phase]);
  let tagLine: string | null = null;
  let reasonLine: string | null = null;
  let hint: string | null = null;
  let after: string | null = null;
  let values: { title: string; values: Record<string, string> } | null = null;
  let previous: string | null = null;

  if (result) {
    if (result.outcome === 'ok') {
      title = result.seq != null ? t('issue.result.okSeq', { seq: result.seq }) : t('issue.result.ok');
      after = t('issue.after.ok');
      if (Object.keys(result.values).length > 0) values = { title: t('issue.result.written'), values: result.values };
    } else if (result.outcome === 'skipped') {
      title = t('issue.result.skipped');
      after = t('issue.after.skipped');
      reasonLine = skipText(t, result, jobKind, lang);
    } else {
      title = result.partial ? t('issue.result.partial') : t('issue.result.error');
      const afterKey = AFTER_ERROR[errorAdvice(result)];
      after = afterKey ? t(afterKey) : null;
      reasonLine = localizeMessage(result.message, lang);
    }
    if (result.uid) {
      tagLine = result.kind
        ? t('issue.result.tag', { kind: kindLabel(result.kind), uid: formatUid(result.uid) })
        : t('issue.result.uid', { uid: formatUid(result.uid) });
    }
  } else if (last) {
    if (last.type === 'clear-reader') {
      // R-ISSUE-13: a tag still being identified at start has no UID yet - never "(UID )".
      hint = last.uid ? t('issue.status.clear.hint', { uid: formatUid(last.uid) }) : t('issue.status.clear.hintUnknown');
    } else if (last.type === 'waiting' || last.type === 'started') {
      hint = t(soundOn ? 'issue.status.waiting.hint' : 'issue.status.waiting.hint.silent');
      if (last.type === 'waiting') values = { title: t('issue.next'), values: last.next.values };
      const prev = recent[0];
      if (prev) previous = t('issue.previous', { text: recentText(t, prev, lang) });
    } else if (last.type === 'reading' || last.type === 'writing') {
      hint = t(last.type === 'reading' ? 'issue.status.reading.hint' : soundOn ? 'issue.status.writing.hint' : 'issue.status.writing.hint.silent');
      tagLine = t('issue.result.uid', { uid: formatUid(last.uid) });
      values = { title: t('issue.current'), values: last.next.values };
    }
  }
  const next: IssuePreview | null = last && (last.type === 'waiting' || last.type === 'reading' || last.type === 'writing') ? last.next : null;
  const busyPhase = phase === 'reading' || phase === 'writing';

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          title={t('issue.running')}
          subtitle={t(soundOn ? 'issue.running.subtitle' : 'issue.running.subtitle.silent')}
          helpTopic="issue"
          actions={
            <>
              <span className="issue-counter" title={t('issue.counter', { n: issued })} data-testid="issue-counter">
                <span className="issue-counter-num">{issued}</span>
                <span className="muted">{t('issue.issuedLabel')}</span>
              </span>
              <Button variant="danger" icon={Square} onClick={onStop} loading={stopping} data-testid="issue-stop">
                {stopping ? t('issue.stopping') : t('issue.stop')}
              </Button>
            </>
          }
        />

        <div className="stack-lg">
          <IssueReaderLine running />

          {stopping ? (
            <Callout tone="warn" title={t('issue.stopping')}>
              {t(soundOn ? 'issue.stopping.hint' : 'issue.stopping.hint.silent')}
            </Callout>
          ) : null}

          <div
            className="big-status issue-big-status"
            data-tone={tone}
            data-phase={phase}
            data-outcome={result?.outcome ?? undefined}
            data-testid="issue-status"
            role="status"
            aria-live="polite"
          >
            <Icon size={56} className={busyPhase ? 'issue-big-icon issue-pulse' : 'issue-big-icon'} aria-hidden />
            <div className="big-status-title">{title}</div>
            {tagLine ? <div className="issue-status-tag mono">{tagLine}</div> : null}
            {reasonLine ? <div className="issue-status-reason">{reasonLine}</div> : null}
            {hint ? <div className="issue-status-sub">{hint}</div> : null}
            {after ? <div className="issue-status-after">{after}</div> : null}
            {previous ? <div className="issue-status-prev muted small">{previous}</div> : null}
          </div>

          <VirtualTagControls phase={phase} jobKind={jobKind} stopping={stopping} onStopAndVirtualOff={onStopAndVirtualOff} />

          {values && Object.keys(values.values).length > 0 ? (
            <Card title={values.title} icon={Nfc}>
              <dl className="issue-next-values">
                {next?.seq != null && !('seq' in values.values) ? (
                  <>
                    <dt>{t('issue.preview.seq')}</dt>
                    <dd>{next.seq}</dd>
                  </>
                ) : null}
                {next?.rowIndex != null ? (
                  <>
                    <dt>{t('issue.preview.row')}</dt>
                    <dd>{next.rowIndex + 1}</dd>
                  </>
                ) : null}
                {Object.entries(values.values)
                  .filter(([k]) => k !== 'bytes')
                  .map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k === 'seq' ? t('issue.preview.seq') : k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
              </dl>
            </Card>
          ) : null}

          <RecentResults recent={recent} lang={lang} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Virtual reader controls while running (R-ISSUE-6). The home screen's
// simulator card is out of reach here: a first-time user who started with the
// trial tag still on the virtual reader had no way to take it off from this
// screen, and no way to place the next tag.
// ---------------------------------------------------------------------------

function VirtualTagControls({
  phase,
  jobKind,
  stopping,
  onStopAndVirtualOff,
}: {
  phase: IssuePhase;
  jobKind: TagKind | null;
  stopping: boolean;
  onStopAndVirtualOff: () => void;
}) {
  const t = useT();
  const reader = useAppStore((s) => s.reader);
  const toastError = useAppStore((s) => s.toastError);
  const [working, setWorking] = useState(false);
  if (!reader?.simulator.enabled) return null;

  const sim = reader.simulator;
  const active = reader.activeReader ? reader.readers.find((r) => r.name === reader.activeReader) : undefined;
  const clearingVirtual = phase === 'clear' && !!active?.virtual && sim.present;
  // Moving the tag while it is checked / written would leave it half-written.
  const busy = phase === 'reading' || phase === 'writing';
  const newKind = jobKind ?? sim.kind;

  function act(fn: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    fn()
      .catch((err) => toastError(err))
      .finally(() => setWorking(false));
  }

  return (
    <Card title={t('issue.virtual.title')} icon={Nfc}>
      <div className="stack" data-testid="issue-virtual">
        <div className="muted small">{clearingVirtual ? t('issue.virtual.clearHint') : t('issue.virtual.hint')}</div>
        <div className="issue-reader-row">
          <Badge tone={sim.present ? 'ok' : 'neutral'}>{sim.present ? t('issue.virtual.present') : t('issue.virtual.absent')}</Badge>
          <Button
            size="sm"
            variant={clearingVirtual ? 'primary' : undefined}
            icon={Hand}
            disabled={busy || working}
            onClick={() => act(() => api.simulatorTap(!sim.present))}
            data-testid="issue-virtual-tap"
          >
            {sim.present ? t('issue.virtual.takeOff') : t('issue.virtual.place')}
          </Button>
          <Button
            size="sm"
            icon={Plus}
            // The tag left from before the start is taken off first (it is never written).
            disabled={busy || working || clearingVirtual}
            onClick={() => act(() => api.simulatorNewTag(newKind))}
            data-testid="issue-virtual-new"
          >
            {t('issue.virtual.newTag', { kind: kindLabel(newKind) })}
          </Button>
        </div>
        {reader.ignoredRealReader ? (
          <Callout tone="warn">
            <div className="issue-stack-sm">
              <div>{t('issue.virtual.ignored', { name: reader.ignoredRealReader })}</div>
              <div>
                <Button size="sm" icon={PowerOff} loading={stopping} onClick={onStopAndVirtualOff} data-testid="issue-virtual-off">
                  {t('issue.virtual.stopAndOff')}
                </Button>
              </div>
            </div>
          </Callout>
        ) : null}
      </div>
    </Card>
  );
}

function skipText(t: TFunc, r: IssueShownResult, jobKind: TagKind | null, lang: LanguageSetting): string | null {
  if (r.reason === 'wrong-kind' && r.kind && jobKind) {
    return t('issue.skip.wrong-kind.detail', { cardKind: kindLabel(r.kind), kind: kindLabel(jobKind) });
  }
  if (r.reason) return t(`issue.skip.${r.reason}` as MsgKey);
  return localizeMessage(r.message, lang);
}

function recentText(t: TFunc, item: IssueResultItem, lang: LanguageSetting): string {
  if (item.outcome === 'ok') return item.seq != null ? t('issue.result.okSeq', { seq: item.seq }) : t('issue.result.ok');
  const head = item.outcome === 'skipped' ? t('issue.result.skipped') : item.partial ? t('issue.result.partial') : t('issue.result.error');
  const why = localizeMessage(item.message, lang);
  return why ? t('issue.recent.withReason', { result: head, reason: why }) : head;
}

const RECENT_TONE = { ok: 'ok', skipped: 'warn', error: 'danger' } as const;

function RecentResults({ recent, lang }: { recent: IssueResultItem[]; lang: LanguageSetting }) {
  const t = useT();
  return (
    <Card title={t('issue.recent')} icon={History} flush>
      {recent.length === 0 ? (
        <div className="card-body muted">{t('issue.recent.empty')}</div>
      ) : (
        <div className="issue-table-wrap" data-testid="issue-recent">
          <table className="table">
            <thead>
              <tr>
                <th>{t('log.col.at')}</th>
                <th>{t('log.col.seq')}</th>
                <th>{t('log.col.uid')}</th>
                <th>{t('log.col.result')}</th>
                <th>{t('log.col.message')}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.at}-${i}`} data-outcome={r.outcome}>
                  <td className="small">{new Date(r.at).toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US')}</td>
                  <td className="issue-seq">{r.seq ?? '—'}</td>
                  <td className="mono small">{r.uid ? formatUid(r.uid) : '—'}</td>
                  <td>
                    <span className="row">
                      <Badge tone={RECENT_TONE[r.outcome]}>{t(`log.result.${r.outcome}` as MsgKey)}</Badge>
                      {r.partial ? <Badge tone="danger">{t('issue.recent.partial')}</Badge> : null}
                    </span>
                  </td>
                  <td className="small">{localizeMessage(r.message, lang) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
