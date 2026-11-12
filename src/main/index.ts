// Main process entry. Baseline written by the integrator; owner after the
// contract phase: agent "main-app" (may extend, must keep the security section).

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { join } from 'node:path';
import { isIssuing, startServices, stopServices, uiLanguage } from './app';
import { issuingQuitText, quitDialogAutoAnswer, unsavedQuitText, type QuitDialogText } from './services/policy';

// --- packaged builds refuse remote debugging (must run before ready) ------------
// A distributed build never exposes a debugging port. The only exception is the
// packaged-app E2E canary, which must set NFCTS_E2E=1 explicitly (never set in a
// real distribution), so we can confirm a packaged build renders and loads koffi.
if (
  app.isPackaged &&
  process.env.NFCTS_E2E !== '1' &&
  process.argv.some((a) => a.startsWith('--remote-debugging-port') || a.startsWith('--inspect'))
) {
  app.exit(1);
}

// --- single instance -----------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
/** app.quit() was asked while the window was open: quit once the window has closed. */
let quitRequested = false;

/** Ask [proceed, cancel] on the window; true = proceed. Cancel is the default (Esc / Enter). */
function confirmOnWindow(win: BrowserWindow, text: QuitDialogText): boolean {
  const auto = quitDialogAutoAnswer(process.env, app.isPackaged);
  if (auto) {
    console.log(`[quit] "${text.message}" answered automatically: ${auto}`);
    return auto === 'proceed';
  }
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: text.title,
    message: text.message,
    detail: text.detail,
    buttons: text.buttons,
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'NFC Tag Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  // --- security: navigation / new windows -------------------------------------
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      console.warn('[security] blocked navigation to', url);
    }
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    else console.warn('[security] blocked window.open', url);
    return { action: 'deny' };
  });

  // --- quit guards (audit WALK-13 / WRITE-2) ------------------------------------
  // 1) Batch issuing is running: closing would stop it - ask first.
  win.on('close', (e) => {
    if (!isIssuing()) return;
    if (confirmOnWindow(win, issuingQuitText(uiLanguage()))) {
      quitRequested = true; // also quit on macOS once the window is gone
      return; // stopServices() stops the run after the tag being written is finished
    }
    e.preventDefault();
    quitRequested = false;
  });
  // 2) The renderer holds unwritten changes: its beforeunload handler cancels the
  //    unload, Electron emits will-prevent-unload, and we ask. preventDefault()
  //    here = ignore beforeunload and close anyway.
  win.webContents.on('will-prevent-unload', (e) => {
    if (confirmOnWindow(win, unsavedQuitText(uiLanguage()))) {
      e.preventDefault();
      return;
    }
    quitRequested = false; // the user chose to stay: a pending app.quit() is abandoned
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (quitRequested) app.quit();
  });

  win.once('ready-to-show', () => win.show());

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Deny every permission request (camera, mic, notifications, HID ...). The app
  // talks to readers from main via PC/SC, not from the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  mainWindow = createWindow();
  await startServices(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  // Always prevent: we exit ourselves with app.exit() once the services stopped.
  e.preventDefault();
  if (quitting) return;
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    // Close the window first (menu "Quit", Ctrl+Q, OS shutdown ...) so the quit
    // guards above run. When it actually closes, 'closed' calls app.quit() again.
    quitRequested = true;
    win.close();
    return;
  }
  quitting = true;
  stopServices()
    .catch((err) => console.error('[quit] stopServices failed', err))
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
