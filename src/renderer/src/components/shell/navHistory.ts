// Where "back" goes. Owner: shell-ui (SHELL-HOME).
//
// 1. Help: remembers the screen the operator was on before opening help (F1, the
//    "?" button, the nav), so help can offer "back to <screen>" (2026-11-12 UX
//    audit FIRST-8). With keep-alive views (App.tsx) that screen still holds its work.
// 2. Resolve trips (2026-11-12 review R-UX-9, business-app-ux §5.3): a button that
//    moves to another screen to fix a prerequisite ("register a MIFARE key",
//    "enter the password in the binary editor", "choose the reader in Settings")
//    starts a trip with goResolve(target, { returnTo }). The target screen shows
//    <ResolveReturn view="..."/> ("back to <screen>", optionally "back and read
//    again") while the trip lasts. The trip ends as soon as the operator moves
//    anywhere other than the target (or help, which is a side visit).
import { useSyncExternalStore } from 'react';
import { useAppStore } from '../../store/app';
import type { ViewId } from '../../store/app';

/** Why the operator was sent to the target screen (selects the hint text there). */
export type ResolveReason = 'mifare-keys' | 'ntag-password' | 'reader-select';

export interface ResolveTrip {
  /** The screen the operator was sent to. */
  target: ViewId;
  /** The screen to go back to. */
  returnTo: ViewId;
  /** Offer "back and read the tag again" (e.g. after registering a key). */
  reread: boolean;
  reason: ResolveReason;
}

let lastWorkView: ViewId = 'home';
let trip: ResolveTrip | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Pure transition rule (exported for tests): the view help should return to. */
export function nextReturnView(prevReturn: ViewId, view: ViewId): ViewId {
  return view === 'help' ? prevReturn : view;
}

/**
 * Pure transition rule (exported for tests): the resolve trip after moving to
 * `view`. Staying on the target or visiting help keeps it; going back (or
 * anywhere else) ends it, so a stale "back to Read" never shows up later.
 */
export function nextResolveTrip(current: ResolveTrip | null, view: ViewId): ResolveTrip | null {
  if (!current) return null;
  if (view === current.target || view === 'help') return current;
  return null;
}

let started = false;

/** Start tracking (idempotent). Called once by useShortcuts at app start. */
export function startNavHistory(): () => void {
  if (started) return () => {};
  started = true;
  lastWorkView = nextReturnView(lastWorkView, useAppStore.getState().view);
  const unsub = useAppStore.subscribe((s, prev) => {
    if (s.view === prev.view) return;
    let changed = false;
    const next = nextReturnView(lastWorkView, s.view);
    if (next !== lastWorkView) {
      lastWorkView = next;
      changed = true;
    }
    const nextTrip = nextResolveTrip(trip, s.view);
    if (nextTrip !== trip) {
      trip = nextTrip;
      changed = true;
    }
    if (changed) emit();
  });
  return () => {
    unsub();
    started = false;
  };
}

/** The last screen that is not help (where help's "back" goes). */
export function useReturnView(): ViewId {
  const get = () => lastWorkView;
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * Move to `target` to resolve a prerequisite, remembering where to come back to
 * (business-app-ux: a resolve button always comes with a way back).
 */
export function goResolve(target: ViewId, opts: { returnTo: ViewId; reason: ResolveReason; reread?: boolean }): void {
  trip = { target, returnTo: opts.returnTo, reread: !!opts.reread, reason: opts.reason };
  emit();
  useAppStore.getState().setView(target);
}

/** End the current trip without moving (e.g. the target screen's own "back"). */
export function endResolveTrip(): void {
  if (!trip) return;
  trip = null;
  emit();
}

/** The active resolve trip whose target is `view` (null otherwise). */
export function useResolveTrip(view: ViewId): ResolveTrip | null {
  const get = () => trip;
  // getServerSnapshot too: the server-side render tests (tests/shell-home.test.ts) need it.
  const current = useSyncExternalStore(subscribe, get, get);
  return current && current.target === view ? current : null;
}
