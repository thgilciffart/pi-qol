import type { Theme } from '@earendil-works/pi-coding-agent';
import type { StatusSnapshot } from '../../src/status-line/render.ts';

/** A theme that emits real SGR codes and records which tokens were used. */
export function fakeTheme() {
  const used: string[] = [];
  const codes = new Map<string, number>();
  const theme = {
    fg: (color: string, text: string) => {
      used.push(color);
      if (!codes.has(color)) codes.set(color, 16 + codes.size);
      return `\x1b[38;5;${codes.get(color)}m${text}\x1b[39m`;
    },
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as unknown as Theme;
  return { theme, used };
}

export function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    model: { id: 'gpt-test', provider: 'openai', reasoning: true },
    providerCount: 1,
    thinkingLevel: 'high',
    cwd: '/home/me/work/app',
    home: '/home/me',
    gitBranch: 'main',
    sessionName: 'Fix footer',
    idle: true,
    context: { tokens: 50000, contextWindow: 200000, percent: 25 },
    usage: { input: 12000, output: 3400, cacheRead: 50000, cacheWrite: 2000, cost: 0.25, cacheHitRate: 80 },
    subscription: false,
    extensionStatuses: new Map(),
    ...overrides,
  };
}

// eslint-disable-next-line no-control-regex
export const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, '');
