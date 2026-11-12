// Reader actions shared by the home screen and settings (look for readers again,
// back to automatic selection, start / stop the virtual-reader trial).
// Owner: shell-ui (SHELL-HOME).
import { useCallback, useMemo } from 'react';
import { useAppStore } from '../../store/app';
import { api } from '../../lib/api';
import { tNow } from '../../i18n';

export function useReaderActions() {
  const saveSettings = useAppStore((s) => s.saveSettings);
  const toastError = useAppStore((s) => s.toastError);
  const toast = useAppStore((s) => s.toast);

  /**
   * Re-enumerate the readers AND identify the tag on the active reader again
   * (CARD-3: re-enumerating alone never re-identified a tag that failed once).
   */
  const refresh = useCallback(
    async (opts: { notify?: boolean } = {}) => {
      try {
        await api.refreshReaders();
      } catch (err) {
        toastError(err);
        return;
      }
      try {
        await api.reidentify();
      } catch {
        /* no reader / no tag: nothing to identify, the status shows why */
      }
      if (opts.notify) toast({ tone: 'info', title: tNow('settings.refresh.done'), detail: tNow('settings.refresh.hint') });
    },
    [toast, toastError],
  );

  /** D1: the selected reader is missing -> the operator chooses to go back to automatic. */
  const backToAuto = useCallback(async () => {
    await saveSettings((s) => ({ ...s, preferredReader: null }));
    try {
      await api.selectReader(null);
    } catch (err) {
      toastError(err);
    }
  }, [saveSettings, toastError]);

  const startTrial = useCallback(async () => {
    try {
      const kind = useAppStore.getState().reader?.simulator.kind;
      await api.setSimulator({ enabled: true, kind });
      await api.simulatorTap(true);
    } catch (err) {
      toastError(err);
    }
  }, [toastError]);

  const stopTrial = useCallback(async () => {
    try {
      const kind = useAppStore.getState().reader?.simulator.kind;
      await api.setSimulator({ enabled: false, kind });
    } catch (err) {
      toastError(err);
    }
  }, [toastError]);

  return useMemo(() => ({ refresh, backToAuto, startTrial, stopTrial }), [refresh, backToAuto, startTrial, stopTrial]);
}
