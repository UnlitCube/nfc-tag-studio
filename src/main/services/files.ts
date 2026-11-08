// File open/save dialogs with opaque tokens. Integrator-owned.
// The renderer never sees absolute paths; it gets a token it can pass to
// revealFile(). Paths are kept in a main-side map.
import { BrowserWindow, dialog, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { FileFilter, FileOpenResult, FileSaveResult } from '@shared/api';
import { OpError } from '../errors';

const tokens = new Map<string, string>();
let seq = 0;

function tokenFor(path: string): string {
  const token = `f${++seq}`;
  tokens.set(token, path);
  return token;
}

export interface FileService {
  open(getWindow: () => BrowserWindow | null, opts: { title?: string; filters: FileFilter[] }): Promise<FileOpenResult | null>;
  save(
    getWindow: () => BrowserWindow | null,
    opts: { title?: string; defaultName: string; filters: FileFilter[]; bytes: Uint8Array },
  ): Promise<FileSaveResult | null>;
  reveal(token: string): Promise<void>;
}

export function createFileService(): FileService {
  return {
    async open(getWindow, opts) {
      const win = getWindow();
      const res = await dialog.showOpenDialog(win ?? undefined!, {
        title: opts.title,
        properties: ['openFile'],
        filters: opts.filters,
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const path = res.filePaths[0];
      try {
        const bytes = new Uint8Array(await fs.readFile(path));
        return { token: tokenFor(path), name: basename(path), bytes };
      } catch (err) {
        throw new OpError('FILE_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
    async save(getWindow, opts) {
      const win = getWindow();
      const res = await dialog.showSaveDialog(win ?? undefined!, {
        title: opts.title,
        defaultPath: opts.defaultName,
        filters: opts.filters,
      });
      if (res.canceled || !res.filePath) return null;
      try {
        await fs.writeFile(res.filePath, opts.bytes);
        return { token: tokenFor(res.filePath), name: basename(res.filePath) };
      } catch (err) {
        throw new OpError('FILE_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
    async reveal(token) {
      const path = tokens.get(token);
      if (path) shell.showItemInFolder(path);
    },
  };
}
