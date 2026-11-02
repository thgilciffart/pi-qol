import { describe, expect, test } from 'bun:test';
import thinking from '../src/thinking.ts';

function harness(model: any = { reasoning: true }, initial = 'off') {
  const shortcuts = new Map<string, any>();
  const selected: string[] = [];
  const notices: string[] = [];
  let level = initial;
  const ctx = { model, ui: { notify: (message: string) => notices.push(message) } };
  thinking({
    registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
    getThinkingLevel: () => level,
    setThinkingLevel: (value: string) => { level = value; selected.push(value); },
  } as never);
  return { ctx, selected, notices,
    press: (key: 'alt+,' | 'alt+.') => shortcuts.get(key).handler(ctx),
    level: () => level,
  };
}

describe('thinking shortcuts', () => {
  test('Alt+. advances and Alt+, goes backward, wrapping in both directions', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.press('alt+.');
    expect(h.selected).toEqual(['minimal', 'low', 'medium', 'high', 'off']);
    h.press('alt+,');
    expect(h.level()).toBe('high');
    h.press('alt+,');
    expect(h.level()).toBe('medium');
    expect(h.notices.at(-1)).toBe('Thinking level: medium');
  });

  test('uses the host capability map to skip unsupported levels and include xhigh and max', () => {
    const h = harness({ reasoning: true, thinkingLevelMap: { minimal: null, low: null, xhigh: 'xhigh', max: 'max' } });
    for (let i = 0; i < 5; i++) h.press('alt+.');
    expect(h.selected).toEqual(['medium', 'high', 'xhigh', 'max', 'off']);
    h.press('alt+,');
    expect(h.level()).toBe('max');
  });

  test('models without reasoning and absent models do not change effort', () => {
    for (const model of [null, { reasoning: false }]) {
      const h = harness(model);
      h.press('alt+,');
      h.press('alt+.');
      expect(h.selected).toEqual([]);
      expect(h.notices.at(-1)).toContain('does not support thinking');
    }
  });

  test('uses the latest model and handles a previous effort unsupported by that model', () => {
    const h = harness({ reasoning: true, thinkingLevelMap: { max: 'max' } }, 'max');
    h.ctx.model = { reasoning: true, thinkingLevelMap: { minimal: null } };
    h.press('alt+,');
    expect(h.level()).toBe('high');
    h.press('alt+.');
    expect(h.level()).toBe('off');
    h.press('alt+.');
    expect(h.level()).toBe('low');
  });
});
