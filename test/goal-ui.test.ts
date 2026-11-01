import { describe, expect, test } from 'bun:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { Goal } from '../src/goal.ts';
import { createGoalUI, formatGoalIndicator, renderGoalIndicator } from '../src/goal-ui.ts';

const plain = (text: string) => text;
const goal: Goal = { id: 'test', objective: 'Finish it', status: 'active', tokensUsed: 12500, timeUsedMs: 120000, turns: 1 };

describe('Codex-style goal indicator', () => {
  test('matches active, paused, stalled, budget, and achieved labels', () => {
    expect(formatGoalIndicator(goal)).toBe('Pursuing goal (2m)');
    expect(formatGoalIndicator({ ...goal, tokenBudget: 50000 })).toBe('Pursuing goal (12.5K / 50K)');
    expect(formatGoalIndicator({ ...goal, status: 'paused' })).toBe('Goal paused (/goal resume)');
    expect(formatGoalIndicator({ ...goal, status: 'blocked' })).toBe('Goal stalled (/goal resume)');
    expect(formatGoalIndicator({ ...goal, status: 'budget_limited', tokensUsed: 63876, tokenBudget: 50000 }))
      .toBe('Goal unmet (63.9K / 50K tokens)');
    expect(formatGoalIndicator({ ...goal, status: 'complete' })).toBe('Goal achieved (2m)');
    expect(formatGoalIndicator({ ...goal, status: 'complete', tokenBudget: 50000 })).toBe('Goal achieved (12.5K tokens)');
  });

  test('compacts large token counts and elapsed times', () => {
    expect(formatGoalIndicator({ ...goal, tokensUsed: 8082943, tokenBudget: 10000000 })).toBe('Pursuing goal (8.08M / 10M)');
    expect(formatGoalIndicator({ ...goal, tokensUsed: 999500, tokenBudget: 1000000 })).toBe('Pursuing goal (1M / 1M)');
    expect(formatGoalIndicator({ ...goal, timeUsedMs: 59000 })).toBe('Pursuing goal (59s)');
    expect(formatGoalIndicator({ ...goal, timeUsedMs: 36720000 })).toBe('Pursuing goal (10h 12m)');
    expect(formatGoalIndicator({ ...goal, timeUsedMs: 86400000 })).toBe('Pursuing goal (1d 0h 0m)');
  });

  test('right-aligns inside the top border and preserves Working, input, and other rows', () => {
    const rows = ['── Working ' + '─'.repeat(89), 'draft prompt', '─'.repeat(100)];
    const rendered = renderGoalIndicator(rows, 100, 'Pursuing goal (2m)', plain, plain);
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toStartWith('── Working ');
    expect(rendered[0]).toEndWith(' Pursuing goal (2m) ─');
    expect(visibleWidth(rendered[0])).toBe(100);
    expect(rendered.slice(1)).toEqual(rows.slice(1));
    expect(rows[0]).not.toContain('Pursuing goal');
  });

  test('preserves colored working and scroll indicators', () => {
    const prefix = '── Working ── ↑ 10 more ';
    const rows = ['\x1b[31m' + prefix + '─'.repeat(100 - visibleWidth(prefix)) + '\x1b[0m', 'input'];
    const rendered = renderGoalIndicator(rows, 100, 'Pursuing goal (2m)', text => `\x1b[35m${text}\x1b[0m`, plain);
    expect(stripTerminalSequences(rendered[0])).toContain('Working ── ↑ 10 more');
    expect(stripTerminalSequences(rendered[0])).toEndWith(' Pursuing goal (2m) ─');
    expect(visibleWidth(rendered[0])).toBe(100);
  });

  test('uses a right-aligned row on narrow screens or editors without border space', () => {
    for (const width of [1, 12, 30]) {
      const rows = ['Working and other editor controls', 'draft'];
      const rendered = renderGoalIndicator(rows, width, 'Pursuing goal (2m)', plain, plain);
      expect(visibleWidth(rendered[0])).toBe(width);
      expect(rendered.slice(1)).toEqual(rows);
    }
    expect(renderGoalIndicator(['draft'], 0, 'Pursuing goal', plain, plain)).toEqual(['draft']);
  });

  test('wraps an existing editor factory, follows state changes, and restores it on shutdown', () => {
    let current: Goal | undefined = { ...goal };
    const editor = { render: (width: number) => ['─'.repeat(width), 'draft'], handleInput: plain, getText: () => 'draft', setText: () => {} };
    const originalFactory = () => editor;
    let installed: any = originalFactory;
    let renders = 0;
    const ctx: any = {
      hasUI: true, mode: 'tui',
      ui: { getEditorComponent: () => installed, setEditorComponent: (factory: any) => {
        installed = factory;
        if (factory) factory({ requestRender: () => { renders++; } }, {}, {});
      }, theme: { fg: (_color: string, text: string) => text } },
    };
    const presentation = createGoalUI(() => ({ goal: current, running: false }));
    presentation.update(ctx);
    expect(installed).not.toBe(originalFactory);
    expect(editor.render(80)[0]).toEndWith(' Pursuing goal (2m) ─');
    current = { ...goal, status: 'paused' };
    presentation.update(ctx);
    expect(editor.render(80)[0]).toEndWith(' Goal paused (/goal resume) ─');
    current = undefined;
    presentation.update(ctx);
    expect(editor.render(80)).toEqual(['─'.repeat(80), 'draft']);
    expect(renders).toBe(3);
    presentation.dispose(ctx);
    expect(installed).toBe(originalFactory);
  });

  test('does not replace an editor installed by another extension during cleanup', () => {
    let installed: any;
    const ctx: any = { hasUI: true, mode: 'tui', ui: {
      getEditorComponent: () => installed, setEditorComponent: (factory: any) => { installed = factory; },
    } };
    const presentation = createGoalUI(() => ({ goal, running: false }));
    presentation.update(ctx);
    const otherFactory = () => {};
    installed = otherFactory;
    presentation.dispose(ctx);
    expect(installed).toBe(otherFactory);
  });

  test('uses the real Pi editor with working status and Escape handlers intact', () => {
    let editor: any;
    let installed: any;
    const tui = { terminal: { rows: 24, columns: 100 }, requestRender: () => {} };
    const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain,
      scrollInfo: plain, noMatch: plain } };
    const ctx: any = { hasUI: true, mode: 'tui', ui: {
      theme: { fg: (_color: string, text: string) => text }, getEditorComponent: () => installed,
      setEditorComponent: (factory: any) => { installed = factory; if (factory) editor = factory(tui, theme, {
        matches: (data: string, action: string) => data === '\x1b' && action === 'app.interrupt',
      }); },
    } };
    const presentation = createGoalUI(() => ({ goal, running: false }));
    presentation.update(ctx);
    editor.setText('keep this draft');
    editor.setWorkingStatusIndicator({ renderInBorder: () => 'Working', renderSpinnerInBorder: () => '*' });
    const rendered = editor.render(100).map(stripTerminalSequences);
    expect(rendered[0]).toStartWith('── Working ');
    expect(rendered[0]).toEndWith(' Pursuing goal (2m) ─');
    expect(rendered.join('\n')).toContain('keep this draft');
    let interrupted = false;
    editor.onEscape = () => { interrupted = true; };
    editor.handleInput('\x1b');
    expect(interrupted).toBe(true);
    expect(editor.getText()).toBe('keep this draft');
    presentation.dispose(ctx);
  });
});
