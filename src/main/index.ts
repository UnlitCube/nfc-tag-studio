// Main process entry. Baseline written by the integrator; owner after the
// contract phase: agent "main-app" (may extend, must keep the security section).

import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { startServices, stopServices } from './app';

// --- packaged builds refuse remote debugging (must run before ready) ------------
if (app.isPackaged && process.argv.some((a) => a.startsWith('--remote-debugging-port') || a.startsWith('--inspect'))) {
  app.exit(1);
}

// --- single instance -----------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

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
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  stopServices()
    .catch((err) => console.error('[quit] stopServices failed', err))
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
