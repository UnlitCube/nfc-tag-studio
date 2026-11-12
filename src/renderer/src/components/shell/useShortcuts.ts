// Global keyboard shortcuts. Owner: agent "shell-ui".
// Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo - only while the binary
// editor (the screen that shows the document's bytes) is on screen - and F1
// opens help. Read/write/save are view-specific and handled in the views.
//
// A key a view already handled (e.preventDefault(), e.g. the binary editor's grid
// does its own undo/redo) is ignored here, otherwise one Ctrl+Z would undo twice
// (2026-11-12 UX audit WRITE-19).
//
// Undo / redo change doc.image. On any other screen (NDEF, backup, home, log...)
// that document is not visible, so a Ctrl+Z pressed there (meant for that screen,
// with focus on a button) silently undid a hidden binary edit - and the NDEF
// editor then re-imported the undone document (2026-11-12 review R-WRITE-6).
import { useEffect } from 'react';
import { useAppStore } from '../../store/app';
import type { ViewId } from '../../store/app';
import { startNavHistory } from './navHistory';

/** Pure decision (exported for tests): what a keydown does globally. */
export type ShortcutAction = 'help' | 'undo' | 'redo' | null;

/** Screens where the global undo / redo applies (the document's bytes are on screen). */
export const UNDO_VIEWS: readonly ViewId[] = ['hex'];

export function shortcutAction(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  typing: boolean;
  hasDoc: boolean;
  /** The screen on view (undo / redo only on UNDO_VIEWS). */
  view: ViewId;
  /** A single-tag read / write is in flight: the document must not change under it. */
  busy?: boolean;
}): ShortcutAction {
  if (e.defaultPrevented) return null;
  if (e.key === 'F1') return 'help';
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.typing || !e.hasDoc || e.busy) return null;
  if (!UNDO_VIEWS.includes(e.view)) return null;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) return 'undo';
  if ((key === 'z' && e.shiftKey) || key === 'y') return 'redo';
  return null;
}

export function useShortcuts(): void {
  useEffect(() => startNavHistory(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useAppStore.getState();
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      // A confirmation / modal is open: leave the keys to it.
      if (st.dialogs.length > 0) return;
      const action = shortcutAction({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        defaultPrevented: e.defaultPrevented,
        typing,
        hasDoc: !!st.doc,
        view: st.view,
        busy: st.busyOp !== null,
      });
      if (!action) return;
      e.preventDefault();
      if (action === 'help') st.setView('help');
      else if (action === 'undo') st.undo();
      else st.redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
