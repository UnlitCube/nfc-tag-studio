// Batch provisioning engine. Integrator-owned.
// Drives the "tap a tag -> write the next value -> wait for removal -> repeat"
// loop used to issue many tags (employee IDs with an incrementing sequence,
// CSV rows, NDEF templates, or a duplicate image). It never touches a UID
// (invariant I1/I2) and never logs keys/passwords (I4).
import type {
  CardInfo,
  IssueEvent,
  IssueJob,
  IssueLogEntry,
  IssuePreview,
  TagImage,
  UnitWrite,
  WriteRequest,
} from '@shared/types';
import type { IssueContext } from '@shared/schema/types';
import { isMifare, isNtag, specFor } from '@shared/tags';
import { encodeSchema, buildSchemaWrites, expandDraft } from '@shared/schema';
import { encodeDrafts, buildType2UserArea, buildMifareNdefWrites } from '@shared/ndef';
import { isBlankDataArea, buildNtagPasswordWrites } from '@shared/tag';
import { bytesToHex, hexToBytes } from '@shared/hex';
import type { NfcService } from '../nfc/contract';
import { OpError } from '../errors';
import type { IssueLog } from '../services/issuelog';

export interface IssueEngineDeps {
  nfc: NfcService;
  log: IssueLog;
  emit: (e: IssueEvent) => void;
  newId: () => string;
  now: () => Date;
}

export interface IssueState {
  running: boolean;
  job: IssueJob | null;
  issued: number;
  last: IssueEvent | null;
}

export interface IssueEngine {
  start(job: IssueJob): void;
  stop(): void;
  getState(): IssueState;
  /** Preview the value that the next tap will write, without a card. */
  preview(job: IssueJob): IssuePreview;
}

export function createIssueEngine(deps: IssueEngineDeps): IssueEngine {
  let job: IssueJob | null = null;
  let abort: AbortController | null = null;
  let issued = 0;
  let last: IssueEvent | null = null;
  let running = false;

  function emit(e: IssueEvent): void {
    last = e;
    deps.emit(e);
  }

  function contextFor(j: IssueJob, uid: string | null): IssueContext {
    const row = j.rows ? (j.rows[j.rowIndex] ?? null) : null;
    const inputs = j.template.type === 'schema' ? j.template.inputs : {};
    return { seq: j.sequence.next, row, inputs, uid, now: deps.now() };
  }

  function previewOf(j: IssueJob): IssuePreview {
    try {
      if (j.template.type === 'schema') {
        const { values } = encodeSchema(j.template.schema, contextFor(j, null));
        return { seq: j.sequence.next, rowIndex: j.rows ? j.rowIndex : null, values };
      }
      if (j.template.type === 'ndef') {
        const ctx = contextFor(j, null);
        const values: Record<string, string> = { seq: String(j.sequence.next) };
        if (ctx.row) Object.assign(values, ctx.row);
        return { seq: j.sequence.next, rowIndex: j.rows ? j.rowIndex : null, values };
      }
      return { seq: null, rowIndex: null, values: { 複製: 'データ領域をそのまま複製' } };
    } catch (err) {
      return { seq: j.sequence.next, rowIndex: null, values: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** Build the unit writes for one tag + the display values for the log. */
  function buildWrites(j: IssueJob, card: CardInfo, image: TagImage): { writes: UnitWrite[]; values: Record<string, string>; seq: number | null } {
    const ctx = contextFor(j, card.uid);
    if (j.template.type === 'schema') {
      const { bytes, values } = encodeSchema(j.template.schema, ctx);
      const writes = buildSchemaWrites(j.template.schema, card.kind!, image.data, bytes);
      return { writes, values, seq: j.sequence.next };
    }
    if (j.template.type === 'ndef') {
      const expanded = j.template.records.map((r) => expandDraft(r, ctx));
      const message = encodeDrafts(expanded);
      let writes: UnitWrite[];
      if (isNtag(card.kind!)) {
        const area = buildType2UserArea(card.kind!, message);
        writes = [];
        const spec = specFor(card.kind!);
        // area starts at page 4; emit one write per changed page
        for (let i = 0; i < area.length; i += 4) {
          const page = 4 + i / 4;
          const cur = image.data.subarray(page * 4, page * 4 + 4);
          const next = area.subarray(i, i + 4);
          if (!cur || cur.length < 4 || !eq(cur, next)) writes.push({ unit: page, data: Uint8Array.from(next) });
          if (page >= spec.unitCount - 1) break;
        }
      } else {
        writes = buildMifareNdefWrites(card.kind!, image.data, message);
      }
      const values: Record<string, string> = { seq: String(j.sequence.next), bytes: bytesToHex(message) };
      if (ctx.row) Object.assign(values, ctx.row);
      return { writes, values, seq: j.sequence.next };
    }
    // image (duplicate): write the given units verbatim.
    const tpl = j.template;
    const unitSize = specFor(card.kind!).unitSize;
    const writes: UnitWrite[] = tpl.units.map((unit) => ({ unit, data: tpl.data.subarray(unit * unitSize, unit * unitSize + unitSize) }));
    return { writes, values: { 複製元: '保存されたイメージ' }, seq: null };
  }

  async function issueOne(j: IssueJob, card: CardInfo, signal: AbortSignal): Promise<'ok' | 'skipped' | 'error'> {
    const logBase = {
      id: deps.newId(),
      jobId: j.id,
      jobName: j.name,
      at: deps.now().getTime(),
      uid: card.uid,
      kind: card.kind,
    };

    // wrong kind
    if (card.kind !== j.kind) {
      const entry: IssueLogEntry = { ...logBase, seq: null, values: {}, result: 'skipped', message: `種別違い (${card.kind ?? '不明'})` };
      emit({ type: 'skipped', entry, reason: 'wrong-kind' });
      return 'skipped';
    }

    // duplicate UID
    if (j.options.skipDuplicateUid) {
      const seen = deps.log.issuedUids(j.id);
      if (seen.has(card.uid)) {
        const entry: IssueLogEntry = { ...logBase, seq: null, values: {}, result: 'skipped', message: '発行済みの UID' };
        emit({ type: 'skipped', entry, reason: 'duplicate' });
        return 'skipped';
      }
    }

    const kind = j.kind; // card.kind === j.kind here (checked above)

    // read current image (needed for schema/ndef/requireBlank; keys/password from options)
    const image = await deps.nfc.readTag({ mifareKeyIds: j.options.mifareKeyIds });
    if (signal.aborted) throw new OpError('CANCELLED');

    if (j.options.requireBlank && !isBlankDataArea(kind, image.data)) {
      const entry: IssueLogEntry = { ...logBase, seq: null, values: {}, result: 'skipped', message: '空でないタグ' };
      emit({ type: 'skipped', entry, reason: 'not-blank' });
      return 'skipped';
    }

    const { writes, values, seq } = buildWrites(j, card, image);

    // optional NTAG password protection (protected pages -> allowProtected for these)
    const protectWrites: UnitWrite[] = [];
    if (j.options.ntagProtect && isNtag(kind)) {
      const p = j.options.ntagProtect;
      protectWrites.push(
        ...buildNtagPasswordWrites(kind, image.data, {
          password: p.password,
          pack: p.pack,
          auth0: firstUserPage(kind),
          protectRead: p.protectRead,
          authLimit: 0,
        }),
      );
    }

    const req: WriteRequest = {
      kind,
      expectedUid: card.uid,
      writes: [...writes, ...protectWrites],
      allowProtected: protectWrites.length > 0,
      verify: j.options.verify,
      mifareKeyIds: j.options.mifareKeyIds,
    };

    emit({ type: 'writing', uid: card.uid, next: previewOf(j) });
    const res = await deps.nfc.writeTag(req);
    if (res.failed.length > 0 || res.verified === false) {
      const entry: IssueLogEntry = {
        ...logBase,
        seq,
        values,
        result: 'error',
        message: res.failed.length ? `書き込み失敗: ${res.failed.map((f) => `#${f.unit}`).join(',')}` : '照合不一致',
      };
      await deps.log.append(entry);
      emit({ type: 'error', entry, message: entry.message ?? '書き込みに失敗しました' });
      return 'error';
    }

    const entry: IssueLogEntry = { ...logBase, seq, values, result: 'ok', message: null };
    await deps.log.append(entry);
    issued += 1;

    // advance sequence + rows
    j.sequence.next += j.sequence.step;
    if (j.rows) j.rowIndex += 1;

    emit({ type: 'success', entry, issued });
    return 'ok';
  }

  async function run(j: IssueJob): Promise<void> {
    const controller = abort!;
    const signal = controller.signal;
    emit({ type: 'started', job: j });
    try {
      while (!signal.aborted) {
        if (j.limit != null && issued >= j.limit) {
          emit({ type: 'stopped', reason: 'limit', issued });
          break;
        }
        if (j.rows && j.rowIndex >= j.rows.length) {
          emit({ type: 'stopped', reason: 'rows-exhausted', issued });
          break;
        }
        emit({ type: 'waiting', next: previewOf(j), issued });
        let card: CardInfo;
        try {
          card = await deps.nfc.waitForCard(signal);
        } catch (err) {
          if (signal.aborted) break;
          throw err;
        }
        try {
          await issueOne(j, card, signal);
        } catch (err) {
          if (signal.aborted) break;
          const message = err instanceof OpError ? err.code : err instanceof Error ? err.message : String(err);
          emit({ type: 'error', entry: null, message });
        }
        // wait for the tag to leave before accepting the next one
        emit({ type: 'remove-card', uid: card.uid });
        try {
          await deps.nfc.waitForRemoval(signal);
        } catch {
          if (signal.aborted) break;
        }
      }
      if (signal.aborted) emit({ type: 'stopped', reason: 'user', issued });
    } catch (err) {
      emit({ type: 'stopped', reason: 'error', issued });
      void err;
    } finally {
      running = false;
      deps.nfc.setBusy(null);
    }
  }

  return {
    start(nextJob) {
      if (running) throw new OpError('BUSY');
      job = structuredClone(nextJob);
      issued = 0;
      running = true;
      abort = new AbortController();
      deps.nfc.setBusy('issue');
      void run(job);
    },
    stop() {
      abort?.abort();
    },
    getState() {
      return { running, job, issued, last };
    },
    preview(j) {
      return previewOf(j);
    },
  };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstUserPage(_kind: 'NTAG213' | 'NTAG215' | 'NTAG216'): number {
  return 4;
}

// touch imports that are only used in some branches so unused-import lint stays quiet
void hexToBytes;
void isMifare;
