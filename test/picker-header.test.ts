import { expect, test } from 'bun:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { keyHints, pickerHeader, scopeState, stateField } from '../src/picker-header.ts';

const plain = { fg: (_: string, value: string) => value } as any;
const ansi = { fg: (color: string, value: string) => `\x1b[3${color.length % 8}m${value}\x1b[39m` } as any;

test('title and state share one line when both fit', () => {
  const [line] = pickerHeader('Title', ['A: 1', 'B: 2'], 20);
  expect(line).toBe('Title     A: 1  B: 2');
  expect(pickerHeader('Title', ['', ''], 20)).toEqual(['Title']);
});

test('narrow widths keep the title and move state to a second line by priority', () => {
  expect(pickerHeader('Title', ['A: 1', 'B: 2'], 12)).toEqual(['Title', '  A: 1  B: 2']);
  expect(pickerHeader('Title', ['A: 1', 'B: 2'], 8)).toEqual(['Title', '    A: 1']);
  expect(pickerHeader('Long title', ['Scope wide'], 6).map(stripTerminalSequences)).toEqual(['Long …', 'Scope…']);
  expect(pickerHeader('Title', ['A'], 0)).toEqual([]);
});

test('styled and wide characters never exceed the width', () => {
  const state = [scopeState(ansi, ['当前项目', 'All'], 0), stateField(ansi, 'Sort', 'Descending')];
  for (let width = 1; width <= 60; width++) {
    for (const line of pickerHeader(ansi.fg('bold', 'Delete 线程'), state, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(visibleWidth(keyHints(ansi, [['tab', 'scope'], ['ctrl+d', 'delete']], width))).toBeLessThanOrEqual(width);
  }
});

test('helpers format scope, fields, and hints like Pi', () => {
  expect(scopeState(plain, ['Current project', 'All'], 1)).toBe('○ Current project | ◉ All');
  expect(stateField(plain, 'Group', 'Date')).toBe('Group: Date');
  expect(keyHints(plain, [['tab', 'scope'], ['esc', 'exit']], 80)).toBe('tab scope · esc exit');
});
