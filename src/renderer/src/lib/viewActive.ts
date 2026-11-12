// Keep-alive views (2026-11-12 UX audit FLOW-12 / FIRST-8): App.tsx keeps every
// view that was opened mounted and hides the inactive ones, so switching screens
// (or opening help) no longer throws away in-progress work (NDEF records being
// composed, issue settings, backup target...). A view that reacts to "being
// shown" (take a handoff, focus, window key handlers) must use this instead of
// mount-time effects. Integrator-owned (renderer-core).
import { createContext, useContext } from 'react';

export const ViewActiveContext = createContext<boolean>(true);

/** True while this view is the one on screen. */
export function useViewActive(): boolean {
  return useContext(ViewActiveContext);
}
