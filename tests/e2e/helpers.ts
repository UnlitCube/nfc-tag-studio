// Shared E2E steps. Specs only use these + launch.ts (selectors live here, once).
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { specFor } from '../../src/shared/tags';
import type { TagKind } from '../../src/shared/tags';
import type { ReaderStatus } from '../../src/shared/types';
import { SHOTS_DIR, assertVirtualOnly } from './launch';
import { t } from './i18n';

export type ViewId = 'home' | 'issue' | 'ndef' | 'schema' | 'hex' | 'backup' | 'log' | 'keys' | 'help' | 'settings';

/** "04A1B2" -> "04:A1:B2" (same as the app's formatUid). */
export function formatUid(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(':').toUpperCase();
}

/** Same as the app's kindLabel. */
export function kindLabel(kind: TagKind): string {
  return specFor(kind).displayName;
}

/** "書き込み先: NTAG215 · UID 04:..." as the write confirmation shows it. */
export function confirmTarget(kind: TagKind, uid: string): string {
  return t('op.write.confirm.target', { kind: kindLabel(kind), idName: kind === 'FELICA_LITE_S' ? 'IDm' : 'UID', uid: formatUid(uid) });
}

// ---------------------------------------------------------------------------
// Bridge (main) calls - used to drive the virtual tag and to read it for checks
// ---------------------------------------------------------------------------

type BridgeMethod = keyof Window['nfcBridge'];

export async function bridge<T = unknown>(page: Page, method: BridgeMethod, ...args: unknown[]): Promise<T> {
  const env = await page.evaluate(
    async ([m, a]) => {
      const fn = (window.nfcBridge as unknown as Record<string, (...x: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>>)[m as string];
      const r = await fn(...(a as unknown[]));
      // Uint8Array -> number[] so it survives the trip back to the test.
      const v = r.ok ? r.value : undefined;
      if (v && typeof v === 'object' && 'data' in (v as Record<string, unknown>) && (v as { data: unknown }).data instanceof Uint8Array) {
        return { ...r, value: { ...(v as object), data: Array.from((v as { data: Uint8Array }).data) } };
      }
      return r;
    },
    [method, args] as const,
  );
  if (!env.ok) throw new Error(`bridge.${String(method)} failed: ${JSON.stringify(env.error)}`);
  return env.value as T;
}

export async function readerStatus(page: Page): Promise<ReaderStatus> {
  return bridge<ReaderStatus>(page, 'getReaderStatus');
}

export interface SimImage {
  uid: string;
  kind: TagKind;
  data: number[];
}

/**
 * Read the virtual tag directly (checks only - does not open a document).
 * Refuses unless the active reader is the virtual one.
 */
export async function readVirtualTag(app: ElectronApplication, page: Page): Promise<SimImage> {
  await assertVirtualOnly(app, page, 'readVirtualTag');
  const s = await readerStatus(page);
  if (s.activeReader !== 'NFC Tag Studio Virtual NFC Reader') throw new Error(`[SAFETY] active reader is ${s.activeReader}`);
  return bridge<SimImage>(page, 'readTag', {});
}

/**
 * Prepare the virtual tag's content directly in main (test set-up, not a UI step).
 * Refuses unless the active reader is the virtual one.
 */
export async function writeDirect(app: ElectronApplication, page: Page, writes: { unit: number; bytes: number[] }[]): Promise<void> {
  await assertVirtualOnly(app, page, 'writeDirect');
  const s = await readerStatus(page);
  if (s.activeReader !== 'NFC Tag Studio Virtual NFC Reader' || !s.card?.kind) throw new Error(`[SAFETY] active reader is ${s.activeReader}`);
  const env = await page.evaluate(
    async ([kind, uid, ws]) =>
      window.nfcBridge.writeTag({
        kind,
        expectedUid: uid,
        writes: ws.map((w) => ({ unit: w.unit, data: new Uint8Array(w.bytes) })),
        allowProtected: false,
        verify: true,
      }),
    [s.card.kind, s.card.uid, writes] as const,
  );
  if (!env.ok) throw new Error(`writeDirect failed: ${JSON.stringify(env.error)}`);
  if (env.value.failed.length || env.value.aborted) throw new Error(`writeDirect incomplete: ${JSON.stringify(env.value)}`);
}

/** Bytes of a string in UTF-8 found anywhere in `data`. */
export function containsUtf8(data: number[], text: string): boolean {
  const needle = Array.from(Buffer.from(text, 'utf8'));
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export async function enableSimulator(page: Page, kind: TagKind = 'NTAG215'): Promise<void> {
  await bridge(page, 'setSimulator', { enabled: true, kind });
  await bridge(page, 'simulatorTap', true);
}

export async function tap(page: Page, present: boolean): Promise<void> {
  await bridge(page, 'simulatorTap', present);
}

/** Replace the virtual tag with a fresh blank one (new UID). */
export async function newTag(page: Page, kind: TagKind = 'NTAG215'): Promise<void> {
  await bridge(page, 'simulatorNewTag', kind);
}

export function pageBytes(data: number[], unit: number, size = 4): number[] {
  return data.slice(unit * size, unit * size + size);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** The view that is on screen (kept-alive views stay in the DOM hidden: D3). */
export function view(page: Page, id: ViewId): Locator {
  return page.locator(`.view-pane[data-view="${id}"]:not([hidden])`);
}

export async function nav(page: Page, id: ViewId): Promise<Locator> {
  await page.getByTestId(`nav-${id}`).click();
  const v = view(page, id);
  await expect(v).toBeVisible();
  return v;
}

/** The tag panel of a view, waiting for the card state. */
export async function expectCardState(scope: Locator, state: string): Promise<void> {
  await expect(scope.getByTestId('tag-on-reader').first()).toHaveAttribute('data-card-state', state, { timeout: 15_000 });
}

export function dialog(page: Page): Locator {
  return page.locator('.modal[role="dialog"]');
}

export async function shot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const p = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

/**
 * Turn the virtual reader on with a tag of `kind`; on the home screen auto-read opens it.
 * Returns the UID of the virtual tag.
 */
export async function startWithReadTag(page: Page, kind: TagKind = 'NTAG215'): Promise<string> {
  const home = view(page, 'home');
  await expect(home).toBeVisible();
  await enableSimulator(page, kind);
  await expectCardState(home, 'ready');
  await expect(home.getByTestId('home-doc-body')).toBeVisible({ timeout: 15_000 });
  const s = await readerStatus(page);
  if (!s.card) throw new Error('no card after enabling the simulator');
  await expect(home.getByTestId('home-doc-body').getByTestId('uid-text')).toHaveText(formatUid(s.card.uid));
  return s.card.uid;
}

/** What is on top at the centre of `target`: 'self', 'toast' or the class of the covering element. */
export async function topAt(target: Locator): Promise<string> {
  return target.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!el) return 'nothing';
    if (b === el || b.contains(el)) return 'self';
    return el.closest('.toast') ? 'toast' : `${el.tagName.toLowerCase()}.${String(el.className)}`;
  });
}

/** Dismiss every toast (they can cover buttons at the bottom right). */
export async function clearToasts(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const b = page.getByTestId('toast').locator('button[aria-label]').first();
    if (!(await b.isVisible().catch(() => false))) break;
    await b.click().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Binary editor
// ---------------------------------------------------------------------------

/** Type one byte (2 hex digits) at byte index `index` of the open document. */
export async function editByte(page: Page, index: number, hex2: string): Promise<void> {
  const hv = view(page, 'hex');
  const cell = hv.getByTestId('hex-grid').locator('.hx-cell').nth(index);
  await cell.click();
  await page.keyboard.type(hex2);
  await expect(cell).toHaveText(hex2.toUpperCase());
}

// ---------------------------------------------------------------------------
// Native dialogs (main) - replaced by fixed answers
// ---------------------------------------------------------------------------

export async function stubSaveDialog(app: ElectronApplication, filePath: string | null): Promise<void> {
  await app.evaluate(({ dialog: d }, p) => {
    (d as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => (p ? { canceled: false, filePath: p } : { canceled: true, filePath: undefined });
  }, filePath);
}

export async function stubOpenDialog(app: ElectronApplication, filePath: string | null): Promise<void> {
  await app.evaluate(({ dialog: d }, p) => {
    (d as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => (p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] });
  }, filePath);
}
