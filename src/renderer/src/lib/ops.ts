// Tag operations shared by several views (read into the current document, write
// with confirmation + refresh). Integrator-owned.
import type { ReadOptions, TagImage, WriteRequest, WriteResult } from '@shared/types';
import { specFor } from '@shared/tags';
import { api } from './api';
import { beep } from './sound';
import { useAppStore } from '../store/app';
import { tNow } from '../i18n';

/** Read the tag on the reader into the current document. Returns null on failure (toast shown). */
export async function readCurrentTag(opts: ReadOptions = {}): Promise<TagImage | null> {
  const st = useAppStore.getState();
  try {
    const img = await api.readTag(opts);
    st.openImage(img, { type: 'card', uid: img.uid });
    const denied = img.unitStatus.filter((s) => s !== 'ok').length;
    st.toast({
      tone: denied ? 'warn' : 'ok',
      title: tNow('toast.read'),
      detail: denied
        ? st.settings.language === 'ja'
          ? `${denied} 個の${specFor(img.kind).unit === 'page' ? 'ページ' : 'ブロック'}は読めませんでした（パスワード・鍵が必要な領域）`
          : `${denied} ${specFor(img.kind).unit}s could not be read (password/key required)`
        : undefined,
    });
    beep('tap');
    return img;
  } catch (err) {
    st.toastError(err);
    beep('error');
    return null;
  }
}

export interface WriteUi {
  /** Confirmation title, e.g. "NDEF を書き込みます". */
  title: string;
  /** One-paragraph explanation. */
  message: string;
  details?: string[];
  /** Irreversible / protected: always confirm, danger styling. */
  dangerous?: boolean;
  /** Require typing this word (irreversible operations). */
  typeToConfirm?: string;
  /** Skip the confirmation even if settings.confirmBeforeWrite (e.g. confirmed elsewhere). */
  skipConfirm?: boolean;
  /** Re-read the tag after writing and make it the current document (default true). */
  refresh?: boolean;
  /** ReadOptions for the refresh read. */
  readOptions?: ReadOptions;
}

/**
 * Write units to the tag with the standard confirmation, sound and toasts.
 * Returns the result, or null when cancelled / failed (toast shown).
 */
export async function writeWithConfirm(req: WriteRequest, ui: WriteUi): Promise<WriteResult | null> {
  const st = useAppStore.getState();
  if (req.writes.length === 0) {
    st.toast({ tone: 'info', title: st.settings.language === 'ja' ? '書き込む変更はありません' : 'Nothing to write' });
    return null;
  }
  const mustConfirm = ui.dangerous || !!ui.typeToConfirm || (!ui.skipConfirm && st.settings.confirmBeforeWrite);
  if (mustConfirm) {
    const ok = await st.confirm({
      title: ui.title,
      message: ui.message,
      details: ui.details,
      tone: ui.dangerous ? 'danger' : 'default',
      typeToConfirm: ui.typeToConfirm,
      confirmLabel: tNow('common.write'),
    });
    if (!ok) return null;
  }
  try {
    const res = await api.writeTag(req);
    if (res.failed.length > 0 || res.verified === false) {
      beep('error');
      st.toast({
        tone: 'danger',
        title: st.settings.language === 'ja' ? '一部の書き込みに失敗しました' : 'Some writes failed',
        detail: [
          ...res.failed.map((f) => `#${f.unit}: ${f.error}`),
          ...(res.mismatched.length ? [`verify mismatch: ${res.mismatched.join(', ')}`] : []),
        ].join('\n'),
      });
    } else {
      beep('success');
      st.toast({
        tone: 'ok',
        title: tNow('toast.written'),
        detail:
          st.settings.language === 'ja'
            ? `${res.written.length} 単位を書き込みました${res.verified ? '（照合 OK）' : ''}`
            : `${res.written.length} units written${res.verified ? ' (verified)' : ''}`,
      });
    }
    if (ui.refresh !== false) {
      try {
        const img = await api.readTag(ui.readOptions ?? { ntagPassword: req.ntagPassword, mifareKeyIds: req.mifareKeyIds });
        useAppStore.getState().commitDoc(img);
      } catch {
        /* the write result already informed the operator */
      }
    }
    return res;
  } catch (err) {
    beep('error');
    st.toastError(err);
    return null;
  }
}
