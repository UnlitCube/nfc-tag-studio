// Small atomic JSON/bytes persistence in userData. Integrator-owned.
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

function dir(): string {
  return app.getPath('userData');
}

function pathOf(name: string): string {
  return join(dir(), name);
}

/** Unique per write: two writes of the same file in flight must not share a temp file. */
let tmpSeq = 0;

/** Write bytes atomically (temp file + rename). */
export async function writeBytes(name: string, data: Uint8Array): Promise<void> {
  const target = pathOf(name);
  const tmp = `${target}.tmp-${process.pid}-${++tmpSeq}`;
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

/** Append text to a file (created when missing). For append-only records. */
export async function appendText(name: string, text: string): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.appendFile(pathOf(name), text, 'utf8');
}

export async function readBytes(name: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(pathOf(name)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await writeBytes(name, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

export async function readJson<T>(name: string): Promise<T | null> {
  const bytes = await readBytes(name);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}
