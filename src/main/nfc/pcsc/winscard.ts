// Native PC/SC binding via koffi.
//
// This is the ONLY file in the backend that touches the native library
// (winscard.dll on Windows, libpcsclite.so.1 on Linux, PCSC.framework on macOS)
// and native memory. It is verified by the integrator on real hardware; the unit
// tests cover ./pure.ts instead. Every method returns a PC/SC return code rather
// than throwing, so the caller (index.ts) can keep the app alive when the card
// service is missing or the card leaves the field.
//
// Windows is the primary target (frozen call list in docs/research/pcsc.md).
// The pcsclite / PCSC.framework paths use the same call shapes with the ANSI
// ("A") entry points and are best-effort (mac / Linux are secondary).

import type KoffiModule from 'koffi';
import {
  SCARD_SCOPE_SYSTEM,
  SCARD_SHARE_SHARED,
  SCARD_PROTOCOL_T0_OR_T1,
  SCARD_LEAVE_CARD,
  SCARD_STATE_UNAWARE,
  SCARD_PROTOCOL_T1,
  normalizeRv,
  extractAtr,
  parseReaderNamesW,
  parseReaderNamesA,
} from './pure';

/** Native handle (SCARDCONTEXT / SCARDHANDLE); koffi returns a number or bigint. */
export type Handle = number | bigint;

export interface ReaderState {
  name: string;
  eventState: number;
  atr: Uint8Array;
}

export interface Winscard {
  establishContext(): { rv: number; ctx: Handle };
  releaseContext(ctx: Handle): number;
  cancel(ctx: Handle): number;
  listReaders(ctx: Handle): { rv: number; names: string[] };
  getStatusChange(ctx: Handle, timeoutMs: number, names: string[]): { rv: number; states: ReaderState[] };
  connect(ctx: Handle, reader: string): { rv: number; hCard: Handle; activeProtocol: number };
  transmit(hCard: Handle, apdu: Uint8Array, activeProtocol: number): { rv: number; resp: Uint8Array };
  disconnect(hCard: Handle, disposition?: number): number;
  unload(): void;
}

const LIST_BUF_WCHARS = 2048;
const LIST_BUF_BYTES = 4096;
const MAX_RECV = 4096;

/** Pick the platform library file. */
function libraryName(): string {
  switch (process.platform) {
    case 'win32':
      return 'winscard.dll';
    case 'darwin':
      return '/System/Library/Frameworks/PCSC.framework/PCSC';
    default:
      return 'libpcsclite.so.1';
  }
}

/**
 * koffi is loaded on first use, not at module load: the app (and the E2E run
 * with PC/SC disabled) still starts when the native addon is missing or broken
 * - that only shows up as "PC/SC unavailable" (npm 11 skips koffi's install
 * script; see CLAUDE.md).
 */
async function loadKoffi(): Promise<typeof KoffiModule> {
  const mod = (await import('koffi')) as unknown as { default?: typeof KoffiModule } & typeof KoffiModule;
  return mod.default ?? mod;
}

/**
 * Load the native library and bind the PC/SC functions. Rejects when the library
 * is missing or cannot be loaded; the caller treats that as "service
 * unavailable" and retries.
 */
export async function loadWinscard(): Promise<Winscard> {
  const koffi = await loadKoffi();
  const win = process.platform === 'win32';
  const lib = koffi.load(libraryName());

  // SCARD_READERSTATE: szReader, pvUserData, dwCurrentState, dwEventState, cbAtr,
  // rgbAtr[36] (Windows) / [33] (pcsclite). Last field, so the length only
  // changes the struct stride; cbAtr bounds the bytes we actually read.
  const ReaderStateStruct = koffi.struct(win ? 'SCARD_READERSTATEW' : 'SCARD_READERSTATE', {
    szReader: win ? 'str16' : 'str',
    pvUserData: 'void *',
    dwCurrentState: 'uint32',
    dwEventState: 'uint32',
    cbAtr: 'uint32',
    rgbAtr: koffi.array('uint8', win ? 36 : 33, 'Typed'),
  });

  const IoRequest = koffi.struct('SCARD_IO_REQUEST', {
    dwProtocol: 'uint32',
    cbPciLength: 'uint32',
  });

  // Windows uses the __stdcall "W" entry points; on x64 the convention is a
  // no-op but we keep it explicit. pcsclite / PCSC.framework use cdecl ANSI.
  // (koffi does not export its TypeSpec / function types, so args is unknown[].)
  type NativeFn = (...a: unknown[]) => number | bigint;
  const bind = (name: string, args: unknown[]): NativeFn =>
    (win
      ? lib.func('__stdcall', name, 'long', args as never)
      : lib.func(name, 'long', args as never)) as unknown as NativeFn;

  const fnEstablish = bind('SCardEstablishContext', [
    'uint32',
    'void *',
    'void *',
    koffi.out(koffi.pointer('uintptr_t')),
  ]);
  const fnRelease = bind('SCardReleaseContext', ['uintptr_t']);
  const fnCancel = bind('SCardCancel', ['uintptr_t']);
  const fnList = bind(win ? 'SCardListReadersW' : 'SCardListReaders', [
    'uintptr_t',
    win ? 'str16' : 'str',
    koffi.out(koffi.pointer(win ? 'uint16' : 'uint8')),
    koffi.inout(koffi.pointer('uint32')),
  ]);
  const fnStatus = bind(win ? 'SCardGetStatusChangeW' : 'SCardGetStatusChange', [
    'uintptr_t',
    'uint32',
    koffi.inout(koffi.pointer(ReaderStateStruct)),
    'uint32',
  ]);
  const fnConnect = bind(win ? 'SCardConnectW' : 'SCardConnect', [
    'uintptr_t',
    win ? 'str16' : 'str',
    'uint32',
    'uint32',
    koffi.out(koffi.pointer('uintptr_t')),
    koffi.out(koffi.pointer('uint32')),
  ]);
  const fnTransmit = bind('SCardTransmit', [
    'uintptr_t',
    koffi.pointer(IoRequest),
    'uint8 *',
    'uint32',
    'void *',
    koffi.out(koffi.pointer('uint8')),
    koffi.inout(koffi.pointer('uint32')),
  ]);
  const fnDisconnect = bind('SCardDisconnect', ['uintptr_t', 'uint32']);

  return {
    establishContext() {
      const ctxOut: Handle[] = [0];
      const rv = normalizeRv(fnEstablish(SCARD_SCOPE_SYSTEM, null, null, ctxOut));
      return { rv, ctx: ctxOut[0] ?? 0 };
    },

    releaseContext(ctx) {
      return normalizeRv(fnRelease(ctx));
    },

    cancel(ctx) {
      return normalizeRv(fnCancel(ctx));
    },

    listReaders(ctx) {
      const lenRef: number[] = [win ? LIST_BUF_WCHARS : LIST_BUF_BYTES];
      if (win) {
        const buf = new Uint16Array(LIST_BUF_WCHARS);
        const rv = normalizeRv(fnList(ctx, null, buf, lenRef));
        return { rv, names: rv === 0 ? parseReaderNamesW(buf, lenRef[0]) : [] };
      }
      const buf = new Uint8Array(LIST_BUF_BYTES);
      const rv = normalizeRv(fnList(ctx, null, buf, lenRef));
      return { rv, names: rv === 0 ? parseReaderNamesA(buf, lenRef[0]) : [] };
    },

    getStatusChange(ctx, timeoutMs, names) {
      if (names.length === 0) return { rv: 0, states: [] };
      const states = names.map((name) => ({
        szReader: name,
        pvUserData: null,
        dwCurrentState: SCARD_STATE_UNAWARE,
        dwEventState: 0,
        cbAtr: 0,
        rgbAtr: new Uint8Array(win ? 36 : 33),
      }));
      const rv = normalizeRv(fnStatus(ctx, timeoutMs, states, states.length));
      const out: ReaderState[] = states.map((s) => ({
        name: s.szReader,
        eventState: s.dwEventState >>> 0,
        atr: extractAtr(s.rgbAtr, s.cbAtr),
      }));
      return { rv, states: out };
    },

    connect(ctx, reader) {
      const hOut: Handle[] = [0];
      const protoOut: number[] = [0];
      const rv = normalizeRv(
        fnConnect(ctx, reader, SCARD_SHARE_SHARED, SCARD_PROTOCOL_T0_OR_T1, hOut, protoOut),
      );
      return { rv, hCard: hOut[0] ?? 0, activeProtocol: (protoOut[0] ?? 0) >>> 0 };
    },

    transmit(hCard, apdu, activeProtocol) {
      const proto = activeProtocol === SCARD_PROTOCOL_T1 ? SCARD_PROTOCOL_T1 : activeProtocol || 1;
      const pci = { dwProtocol: proto, cbPciLength: 8 };
      const recv = new Uint8Array(MAX_RECV);
      const lenRef: number[] = [MAX_RECV];
      const rv = normalizeRv(
        fnTransmit(hCard, pci, apdu, apdu.length, null, recv, lenRef),
      );
      const len = Math.max(0, Math.min(lenRef[0] ?? 0, MAX_RECV));
      return { rv, resp: recv.slice(0, len) };
    },

    disconnect(hCard, disposition = SCARD_LEAVE_CARD) {
      return normalizeRv(fnDisconnect(hCard, disposition));
    },

    unload() {
      try {
        lib.unload();
      } catch {
        // ignore
      }
    },
  };
}
