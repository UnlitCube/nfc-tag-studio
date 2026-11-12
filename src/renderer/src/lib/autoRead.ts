// Auto-read (D2, 2026-11-12 UX audit CARD-9 / FIRST-2 / WALK-12): when a NEW tag
// becomes ready on the active reader while the home, binary or NDEF screen is on
// screen, read it - first-time users place a tag and expect to see it.
// Never replaces unsaved edits or a document opened from a file / created new:
// then <TagOnReader /> shows "a different tag is on the reader [Read this tag]".
// App calls useAutoRead() once. Owner: renderer-core.
import { useEffect } from 'react';
import type { ReaderStatus } from '@shared/types';
import { isDocDirty, useAppStore } from '../store/app';
import type { TagDoc, ViewId, WriteOutcome } from '../store/app';
import { isCardReady } from './readerState';
import { readCurrentTag } from './ops';

/** Screens on which placing a tag reads it. */
export const AUTO_READ_VIEWS: readonly ViewId[] = ['home', 'hex', 'ndef'];

/**
 * Identity of the tag on the active reader ("reader|UID"), or null when no
 * identified tag is there. Deliberately NOT the detection time: main refreshes
 * `card` after every read, and that must not look like a new placement (it would
 * read again and again). A new placement is recognised by the reader going
 * through 'absent' in between (see autoReadDecision).
 */
export function placementKey(reader: ReaderStatus | null): string | null {
  if (!reader || !isCardReady(reader) || !reader.card) return null;
  return `${reader.activeReader ?? ''}|${reader.card.uid.toUpperCase()}`;
}

export interface AutoReadInput {
  enabled: boolean;
  view: ViewId;
  reader: ReaderStatus | null;
  issueRunning: boolean;
  busyOp: string | null;
  dialogsOpen: boolean;
  doc: TagDoc | null;
  /** The placement already handled (read or deliberately not read); null after the tag left. */
  handled: string | null;
}

export interface AutoReadDecision {
  /** Read the tag now. */
  read: boolean;
  /** The new value of `handled`. */
  handled: string | null;
  /** Why (for tests / debugging). */
  reason: 'read' | 'left' | 'not-ready' | 'handled' | 'disabled' | 'view' | 'busy' | 'dialog' | 'dirty' | 'file-doc';
}

/**
 * Pure decision. A placement is considered once: if the screen / state does not
 * allow reading at that moment, it is still marked handled and not read later
 * (moving to the home screen afterwards does not suddenly replace the document).
 * The mark is cleared when the reader reports no tag (the tag was taken off).
 */
export function autoReadDecision(i: AutoReadInput): AutoReadDecision {
  const state = i.reader?.cardState ?? 'no-reader';
  if (state === 'absent' || state === 'no-reader') return { read: false, handled: null, reason: 'left' };
  const key = placementKey(i.reader);
  // detecting / unsupported / error: wait, keep the mark (a re-check of the same tag is not a new placement).
  if (!key) return { read: false, handled: i.handled, reason: 'not-ready' };
  if (key === i.handled) return { read: false, handled: i.handled, reason: 'handled' };
  const no = (reason: AutoReadDecision['reason']): AutoReadDecision => ({ read: false, handled: key, reason });
  if (!i.enabled) return no('disabled');
  if (!AUTO_READ_VIEWS.includes(i.view)) return no('view');
  if (i.issueRunning || i.busyOp || (i.reader?.busy && i.reader.busy.op !== 'identify')) return no('busy');
  if (i.dialogsOpen) return no('dialog');
  const doc = i.doc;
  if (doc) {
    if (isDocDirty(doc)) return no('dirty');
    if (doc.source.type !== 'card') return no('file-doc');
  }
  return { read: true, handled: key, reason: 'read' };
}

/**
 * Pure: the last write result is a success for a tag other than the one that is
 * now on the reader - it has been seen and only gets in the way of the next tag
 * (review R-WRITE-5). Failures stay until closed (they say what to do).
 */
export function isStaleWriteResult(last: WriteOutcome | null, reader: ReaderStatus | null): boolean {
  if (!last || last.tone !== 'ok' || !last.uid) return false;
  if (!isCardReady(reader) || !reader?.card) return false;
  return reader.card.uid.toUpperCase() !== last.uid.toUpperCase();
}

/**
 * One look at the store after a reader-status change: clear a stale success
 * result, decide, and start the read (standard keys only). Returns the new
 * `handled` mark. (useAutoRead calls it; exported for tests.)
 */
export function autoReadStep(handled: string | null): string | null {
  const s = useAppStore.getState();
  if (isStaleWriteResult(s.lastWrite, s.reader)) s.setLastWrite(null);
  const d = autoReadDecision({
    enabled: s.settings.autoRead !== false,
    view: s.view,
    reader: s.reader,
    issueRunning: s.issue.running,
    busyOp: s.busyOp,
    dialogsOpen: s.dialogs.length > 0,
    doc: s.doc,
    handled,
  });
  if (d.read) void readCurrentTag({}, { standardKeysOnly: true });
  return d.handled;
}

/**
 * Call once (App). Watches every reader-status push directly on the store (not
 * through a render, so a quick off / on is never coalesced away).
 * The auto-read tries the public standard MIFARE keys only (D9 / review R-UX-4):
 * a card that is merely placed never gets authentication attempts with the
 * operator's own keys. A manual read ("Read tag") tries every key.
 */
export function useAutoRead(): void {
  useEffect(() => {
    let handled: string | null = null;
    const check = () => {
      handled = autoReadStep(handled);
    };
    check();
    return useAppStore.subscribe((s, prev) => {
      if (s.reader !== prev.reader) check();
    });
  }, []);
}
