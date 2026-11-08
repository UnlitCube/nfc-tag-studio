// Contrast gate. Owner: agent "shell-ui".
// Parses the ACTUAL shipped tokens from tokens.css (so the test can't drift from
// the CSS) and checks WCAG contrast for the critical foreground/background pairs
// in both themes. Includes a negative control so we know the check can fail.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/tokens.css'), 'utf8');

function parseBlock(selector: string): Record<string, string> {
  // Find `selector {` ... matching `}` (blocks here are flat, no nested braces).
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`block not found: ${selector}`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);
  const map: Record<string, string> = {};
  for (const line of body.split(';')) {
    const m = line.match(/(--[\w-]+)\s*:\s*([^;]+)/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

const light = parseBlock(':root {');
const darkOverride = parseBlock(":root[data-theme='dark']");
const dark = { ...light, ...darkOverride };

function resolve(map: Record<string, string>, token: string, depth = 0): string {
  const raw = map[token];
  if (!raw) throw new Error(`undefined token ${token}`);
  const varMatch = raw.match(/^var\((--[\w-]+)\)$/);
  if (varMatch && depth < 10) return resolve(map, varMatch[1], depth + 1);
  return raw;
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a solid hex colour: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(map: Record<string, string>, fg: string, bg: string): number {
  const l1 = luminance(toRgb(resolve(map, fg)));
  const l2 = luminance(toRgb(resolve(map, bg)));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, min ratio]. 4.5 = AA text, 3.0 = non-text UI.
const TEXT_PAIRS: [string, string, number][] = [
  ['--text', '--surface', 4.5],
  ['--text', '--bg', 4.5],
  ['--text', '--surface-raised', 4.5],
  ['--text', '--surface-inset', 4.5],
  ['--text-dim', '--surface', 4.5],
  ['--text-dim', '--bg', 4.5],
  ['--accent-text', '--surface', 4.5],
  ['--accent-text', '--accent-soft', 4.5],
  ['--ok', '--ok-soft', 4.5],
  ['--warn', '--warn-soft', 4.5],
  ['--danger', '--danger-soft', 4.5],
  ['--info', '--info-soft', 4.5],
  ['--on-solid', '--accent-solid', 4.5],
  ['--on-solid', '--danger-solid', 4.5],
  ['--on-solid', '--ok-solid', 4.5],
  ['--nav-text', '--nav-bg', 4.5],
  ['--nav-text-active', '--nav-bg', 4.5],
  ['--statusbar-fg', '--statusbar-bg', 4.5],
  // non-text (3:1)
  ['--border-input', '--surface', 3.0],
  ['--accent', '--surface', 3.0],
];

describe('token contrast (light theme)', () => {
  for (const [fg, bg, min] of TEXT_PAIRS) {
    it(`${fg} on ${bg} >= ${min}`, () => {
      expect(contrast(light, fg, bg)).toBeGreaterThanOrEqual(min);
    });
  }
});

describe('token contrast (dark theme)', () => {
  for (const [fg, bg, min] of TEXT_PAIRS) {
    it(`${fg} on ${bg} >= ${min}`, () => {
      expect(contrast(dark, fg, bg)).toBeGreaterThanOrEqual(min);
    });
  }
});

describe('negative control (the check can fail)', () => {
  it('a light border on surface is NOT AA text contrast', () => {
    // --border is a faint divider; it must not accidentally pass a 4.5 text gate.
    expect(contrast(light, '--border', '--surface')).toBeLessThan(4.5);
  });
});

describe('theme completeness', () => {
  it('every token used by a pair is defined in both themes', () => {
    const tokens = new Set(TEXT_PAIRS.flatMap(([a, b]) => [a, b]));
    for (const token of tokens) {
      expect(() => resolve(light, token), `light ${token}`).not.toThrow();
      expect(() => resolve(dark, token), `dark ${token}`).not.toThrow();
    }
  });
});
