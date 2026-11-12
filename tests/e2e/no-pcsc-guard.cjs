// E2E safety guard, loaded into the Electron MAIN process with `-r` before the app.
//
// The E2E must never reach a real reader or a real tag on the PC it runs on (this
// development PC has a Sony PaSoRi, a USB security token and a YubiKey). The app
// already skips PC/SC when NFCTS_NO_PCSC=1 (D8); this guard is the second, structural
// layer: the native PC/SC binding (koffi -> winscard.dll) cannot even be loaded.
//
// out/main loads koffi with a dynamic `import('koffi')` (ESM loader), which a
// Module._load hook alone does NOT see (probed 2026-11-12, Electron 44 / Node 24:
// the import went through). So the resolve step is hooked with module.registerHooks
// (in-thread, covers import() and require()), plus Module._load for old-style require.
//
// The guard tests itself at start (`selfTest`: it imports koffi and expects the
// import to be refused). launch.ts aborts the test unless selfTest === 'blocked' and
// the app itself never tried to load koffi (appAttempts === 0).
'use strict';
const Module = require('node:module');

const state = { installed: false, hooks: [], appAttempts: 0, selfTest: null };
globalThis.__NFCTS_E2E_GUARD = state;

function isKoffi(s) {
  const v = String(s);
  return (
    v === 'koffi' ||
    /^koffi[\\/]/.test(v) ||
    /[\\/]node_modules[\\/]koffi([\\/]|$)/.test(v) ||
    /[\\/]node_modules[\\/]@koromix[\\/]/.test(v) ||
    /^@koromix[\\/]/.test(v)
  );
}
function refuse(what, from) {
  // The self-test below imports from this file; everything else is the app.
  if (!/no-pcsc-guard\.cjs/.test(String(from || ''))) state.appAttempts++;
  return new Error(`[E2E guard] koffi (PC/SC) is blocked in E2E runs: ${what}`);
}

if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isKoffi(specifier)) throw refuse(specifier, context && context.parentURL);
      const r = nextResolve(specifier, context);
      if (r && r.url && isKoffi(decodeURIComponent(r.url))) throw refuse(r.url, context && context.parentURL);
      return r;
    },
  });
  state.hooks.push('registerHooks');
}

const originalLoad = Module._load;
Module._load = function guardedLoad(request, parent, isMain) {
  if (isKoffi(request)) throw refuse(request, parent && parent.filename);
  return originalLoad.call(this, request, parent, isMain);
};
state.hooks.push('Module._load');
state.installed = true;

// Self-test: the same kind of import out/main uses must be refused.
const probe = import('koffi').then(
  () => 'loaded',
  (e) => (/\[E2E guard\]/.test(String(e && e.message)) ? 'blocked' : `error: ${e && e.message}`),
);
state.selfTest = probe;
probe.then((v) => {
  state.selfTest = v;
});
