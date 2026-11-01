import { readFile } from 'node:fs/promises';
import { colorToHex, parseColor } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

export type ExportColors = { pageBg?: string; cardBg?: string; infoBg?: string };

export async function readExportColors(theme: Theme, fallback: ExportColors): Promise<ExportColors> {
  if (!theme.sourcePath) return fallback;
  const json = JSON.parse((await readFile(theme.sourcePath, 'utf8')).replace(/^\uFEFF/, ''));
  const resolve = (value: string | number | undefined, seen = new Set<string>()): string | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'number') return colorToHex(parseColor(value));
    if (value.startsWith('#') || /^ok(lch|hsl)\(/i.test(value)) {
      return /^okhsl\(/i.test(value) ? colorToHex(parseColor(value)) : value;
    }
    if (seen.has(value) || json.vars?.[value] === undefined) throw new Error(`Invalid export color variable: ${value}`);
    seen.add(value);
    return resolve(json.vars[value], seen);
  };
  return Object.fromEntries(['pageBg', 'cardBg', 'infoBg'].map(key => [key, resolve(json.export?.[key])]));
}

export function applyLiveTheme(html: string, theme: Pick<Theme, 'colors'>, explicit: ExportColors = {}): string {
  const colors = Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [key, colorToHex(value)]));
  const base = colors.userMessageBg || '#343541';
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(base.slice(index, index + 2), 16));
  const luminance = [r, g, b].map(value => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const rgb = (channels: number[]) => `rgb(${channels.join(', ')})`;
  const adjust = (factor: number) => rgb([r, g, b].map(value => Math.min(255, Math.max(0, Math.round(value * factor)))));
  const light = luminance > 0.5;
  const pageBg = explicit.pageBg ?? adjust(light ? 0.96 : 0.7);
  const cardBg = explicit.cardBg ?? (light ? base : adjust(0.85));
  const infoBg = explicit.infoBg ?? rgb(light
    ? [Math.min(255, r + 10), Math.min(255, g + 5), Math.max(0, b - 20)]
    : [Math.min(255, r + 20), Math.min(255, g + 15), b]);
  Object.assign(colors, { exportPageBg: pageBg, exportCardBg: cardBg, exportInfoBg: infoBg, 'body-bg': pageBg, 'container-bg': cardBg, 'info-bg': infoBg });
  if (!/<style>\s*:root\s*\{[^}]*--userMessageBg:/s.test(html)) throw new Error('Unsupported Pi HTML theme block. Update pi-better-export.');
  // Only replace variable declarations. Every native layout rule stays untouched.
  return html.replace(/(<style>\s*:root\s*\{)[^}]*\}/, (_match, start: string) => `${start}\n${Object.entries(colors).map(([key, value]) => `      --${key}: ${value};`).join('\n')}\n    }`);
}
