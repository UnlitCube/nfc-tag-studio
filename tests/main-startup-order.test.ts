// 起動の順番の番人: IPC の受け口（startServices の中の registerIpc）を用意してから窓を作る。
// 窓を先に作ると、遅い PC（2026-11-13、GitHub Actions の 2 コアの Windows のランナー）で、画面の最初の
// 問い合わせ（settings:get・reader:getStatus）が "No handler registered" で失敗し、ホームが出なかった
// （E2E 13 本中 6 本が落ちた。手元では startServices に 1.5 秒の遅延を入れて再現した）。
// main/index.ts は Electron に依るので読み込まず、app.whenReady の中の順番を文字で見る。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

describe('main の起動の順番', () => {
  it('app.whenReady の中で、startServices を待ってから createWindow する', () => {
    const start = src.indexOf('app.whenReady().then(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    const services = body.indexOf('await startServices(');
    const window = body.indexOf('mainWindow = createWindow()');
    expect(services).toBeGreaterThan(0);
    expect(window).toBeGreaterThan(0);
    expect(services).toBeLessThan(window);
  });
});
