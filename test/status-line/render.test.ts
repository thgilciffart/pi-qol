import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { defaultConfig, type StatusLineConfig } from '../../src/status-line/config.ts';
import { formatCwd, renderStatusLine, sanitizeInline } from '../../src/status-line/render.ts';
import { fakeTheme, snapshot, strip } from './helpers.ts';

function config(overrides: Partial<StatusLineConfig> = {}): StatusLineConfig {
  return { ...defaultConfig(), ...overrides };
}

describe('sanitizeInline', () => {
  test('turns line breaks into spaces and removes non-SGR controls', () => {
    const evil = 'a\nb\r\nc\td\x1b[2J\x1b[1;1H\x1b]0;title\x07\x1b]8;;http://x\x1b\\link\x1bPdcs\x1b\\\x07\x00\x7f\x9b2J\x9d0;t\x9c\u202eend';
    const clean = sanitizeInline(evil, true);
    expect(clean).toBe('a b c dlinkend');
    expect(clean).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  test('keeps SGR styling only when asked and closes it', () => {
    const styled = '\x1b[31mred\x1b[0m \x1b[1;38;2;1;2;3mrgb';
    expect(sanitizeInline(styled, true)).toBe('\x1b[31mred\x1b[0m \x1b[1;38;2;1;2;3mrgb\x1b[0m');
    expect(sanitizeInline(styled, false)).toBe('red rgb');
  });

  test('drops unterminated escape sequences instead of leaking them', () => {
    expect(sanitizeInline('ok\x1b]0;never ends', true)).toBe('ok');
    expect(sanitizeInline('ok\x1b[12', true)).toBe('ok');
    expect(sanitizeInline('ok\x1b', true)).toBe('ok');
  });
});

describe('renderStatusLine', () => {
  test('default layout shows two rows with real data and no fake information', () => {
    const { theme } = fakeTheme();
    const lines = renderStatusLine(snapshot(), config(), theme, 200).map(strip);
    expect(lines).toEqual([
      '● ready · gpt-test · think high · ~/work/app · ⎇ main · “Fix footer”',
      'ctx 75% left of 200k · ↑12k ↓3.4k · cache R50k W2.0k 80% hit · $0.250',
    ]);
  });

  test('colourful mode uses varied theme tokens per module; theme mode is restrained', () => {
    const colorful = fakeTheme();
    renderStatusLine(snapshot(), config({ colorMode: 'colorful' }), colorful.theme, 200);
    const themed = fakeTheme();
    renderStatusLine(snapshot(), config({ colorMode: 'theme' }), themed.theme, 200);
    expect(new Set(colorful.used).size).toBeGreaterThanOrEqual(10);
    expect(colorful.used).toContain('thinkingHigh');
    expect(new Set(themed.used).size).toBeLessThan(new Set(colorful.used).size);
  });

  test('mono mode emits no escape codes, including from external statuses', () => {
    const { theme, used } = fakeTheme();
    const data = snapshot({ extensionStatuses: new Map([['plugin', '\x1b[32mgreen\x1b[0m']]) });
    const lines = renderStatusLine(data, config({ colorMode: 'mono' }), theme, 200);
    expect(lines.join('')).not.toContain('\x1b');
    expect(lines.at(-1)).toContain('green');
    expect(used).toEqual([]);
  });

  test('colour modes keep external SGR styling and reset it afterwards', () => {
    const { theme } = fakeTheme();
    const data = snapshot({ extensionStatuses: new Map([['plugin', '\x1b[32mgreen']]) });
    const line = renderStatusLine(data, config(), theme, 200).at(-1)!;
    expect(line).toContain('\x1b[32mgreen\x1b[0m');
  });

  test('styles each segment explicitly instead of wrapping lines in dim', () => {
    const { theme, used } = fakeTheme();
    renderStatusLine(snapshot(), config(), theme, 200);
    expect(used).not.toContain('dim');
  });

  test('malicious external statuses cannot add rows or terminal controls', () => {
    const { theme } = fakeTheme();
    const data = snapshot({
      extensionStatuses: new Map([['evil', 'one\ntwo\r\nthree\x1b[2J\x1b]52;c;Zm9v\x07\u2028four']]),
      cwd: '/home/me/\x1b]0;pwn\x07dir\nx', sessionName: 'name\x1b[H\nrow',
    });
    for (const width of [10, 40, 200]) {
      const lines = renderStatusLine(data, config(), theme, width);
      expect(lines.length).toBeLessThanOrEqual(4);
      for (const line of lines) {
        expect(line).not.toMatch(/[\n\r\x07]/);
        expect(line.replace(/\x1b\[[0-9;:]*m/g, '')).not.toContain('\x1b');
      }
    }
    expect(strip(renderStatusLine(data, config(), theme, 300).join(' '))).toContain('one two three four');
  });

  test('every line fits the width, including wide Unicode and ANSI content', () => {
    const { theme } = fakeTheme();
    const data = snapshot({
      sessionName: '日本語のセッション名前テスト 🚀🚀🚀',
      gitBranch: 'feature/超長いブランチ名-with-emoji-🎉',
      cwd: '/home/me/' + 'very-long-directory-name/'.repeat(5),
      extensionStatuses: new Map([['a', '\x1b[35m紫色ステータス\x1b[0m'], ['b', '👩‍💻 coding'], ['c', 'x'.repeat(300)]]),
    });
    for (const mode of ['colorful', 'theme', 'mono'] as const) {
      for (let width = 1; width <= 120; width++) {
        const lines = renderStatusLine(data, config({ colorMode: mode }), theme, width);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(lines.length).toBeLessThanOrEqual(4);
      }
    }
    expect(renderStatusLine(data, config(), theme, 0)).toEqual([]);
  });

  test('wraps a row at module boundaries and marks overflow', () => {
    const { theme } = fakeTheme();
    const lines = renderStatusLine(snapshot(), config(), theme, 30).map(strip);
    expect(lines.length).toBe(4);
    expect(lines.some(line => /\+\d+$/.test(line))).toBe(true);
  });

  test('omits modules without data and respects disabled items', () => {
    const { theme } = fakeTheme();
    const empty = snapshot({
      model: { id: 'plain', provider: 'x', reasoning: false }, gitBranch: null, sessionName: undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, context: undefined,
    });
    expect(renderStatusLine(empty, config(), theme, 200).map(strip)).toEqual(['● ready · plain · ~/work/app']);
    const cfg = config();
    cfg.items = cfg.items.map(item => ({ ...item, enabled: item.id === 'model' }));
    expect(renderStatusLine(snapshot(), cfg, theme, 200).map(strip)).toEqual(['gpt-test']);
  });

  test('shows working state, provider prefix, unknown context, warnings, and subscriptions', () => {
    const colored = fakeTheme();
    const data = snapshot({ idle: false, providerCount: 2, subscription: true,
      context: { tokens: null, contextWindow: 128000, percent: null } });
    const text = renderStatusLine(data, config(), colored.theme, 200).map(strip).join('\n');
    expect(text).toContain('◉ working');
    expect(text).toContain('openai/gpt-test');
    expect(text).toContain('ctx ?/128k');
    expect(text).toContain('$0.250 (sub)');
    const full = fakeTheme();
    renderStatusLine(snapshot({ context: { tokens: 190000, contextWindow: 200000, percent: 95 } }), config(), full.theme, 200);
    expect(full.used).toContain('error');
  });

  test('formats cwd relative to home only inside home', () => {
    expect(formatCwd('/home/me', '/home/me')).toBe('~');
    expect(formatCwd('/home/me/a', '/home/me')).toBe('~/a');
    expect(formatCwd('/home/meow', '/home/me')).toBe('/home/meow');
  });
});
