import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { defaultConfig, type StatusLineConfig } from '../../src/status-line/config.ts';
import { StatusLineEditor } from '../../src/status-line/editor.ts';
import { fakeTheme, snapshot, strip } from './helpers.ts';

const ENTER = '\r';
const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const SHIFT_UP = '\x1b[1;2A';
const SHIFT_DOWN = '\x1b[1;2B';
const CTRL_C = '\x03';
const CTRL_S = '\x13';

function mount(config: StatusLineConfig = defaultConfig(), statuses = new Map<string, string>(), live = true) {
  const { theme } = fakeTheme();
  let result: StatusLineConfig | undefined | 'pending' = 'pending';
  let renders = 0;
  const editor = new StatusLineEditor({ requestRender: () => { renders++; } }, theme, {
    config,
    liveSnapshot: () => live ? snapshot({ extensionStatuses: statuses }) : undefined,
    discoveryAvailable: live,
  }, value => { result = value; });
  const press = (...keys: string[]) => { for (const key of keys) editor.handleInput(key); };
  const text = (width = 100) => editor.render(width).map(strip).join('\n');
  return { editor, press, text, result: () => result, renders: () => renders };
}

/** Cursor index of the first module row (after the three settings rows). */
const FIRST_ITEM = 3;

describe('status line editor', () => {
  test('shows a live preview, settings, module list, and key hints', () => {
    const h = mount();
    const text = h.text();
    expect(text).toContain('Preview (live)');
    expect(text).toContain('● ready · gpt-test');
    expect(text).toContain('Custom footer');
    expect(text).toContain('Row 1');
    expect(text).toContain('[x] Ready / working');
    expect(text).toContain('Space toggle');
    expect(text).toContain('Esc cancel');
    h.press('p');
    expect(h.text()).toContain('Preview (sample)');
  });

  test('falls back to sample data when live data is unavailable', () => {
    const h = mount(defaultConfig(), new Map(), false);
    expect(h.text()).toContain('sample, live data unavailable');
    expect(h.text()).toContain('discovered while the custom footer is on');
  });

  test('toggles modules and settings, then saves with Enter', () => {
    const h = mount();
    h.press(' ');               // custom footer off
    h.press(DOWN, ' ');         // colour -> theme
    h.press('c');               // colour -> mono
    h.press(DOWN, ' ');         // new extension statuses hidden
    h.press(DOWN, ' ');         // first module (state) disabled
    expect(h.text()).toContain('Custom footer off');
    h.press(ENTER);
    const result = h.result() as StatusLineConfig;
    expect(result.enabled).toBe(false);
    expect(result.colorMode).toBe('mono');
    expect(result.showNewExtensionStatuses).toBe(false);
    expect(result.items[0]).toEqual({ id: 'state', enabled: false, row: 1 });
  });

  test('reorders within a row and moves modules between rows', () => {
    const h = mount();
    for (let i = 0; i < FIRST_ITEM + 1; i++) h.press(DOWN); // model
    h.press(SHIFT_UP);
    h.press(CTRL_S);
    let result = h.result() as StatusLineConfig;
    expect(result.items.slice(0, 2).map(item => item.id)).toEqual(['model', 'state']);

    const g = mount();
    for (let i = 0; i < FIRST_ITEM + 5; i++) g.press(DOWN); // session, last in row 1
    g.press(SHIFT_DOWN);                                    // crosses into row 2
    g.press(']');                                           // swaps with context
    g.press(UP, UP, '1');                                   // context... then cwd stays row 1
    g.press(DOWN, DOWN, DOWN, '2');                         // move another module to row 2
    g.press(ENTER);
    result = g.result() as StatusLineConfig;
    const row2 = result.items.filter(item => item.row === 2).map(item => item.id);
    expect(row2.slice(0, 2)).toEqual(['context', 'session']);
    expect(result.items.findIndex(item => item.row === 2)).toBeGreaterThan(result.items.findLastIndex(item => item.row === 1));
  });

  test('lists current and remembered extension statuses individually', () => {
    const config = defaultConfig();
    config.items.push({ id: 'extension:absent', enabled: false, row: 2 });
    const h = mount(config, new Map([['plugin', '\x1b[31mbuild ok\x1b[0m'], ['other', 'x']]));
    for (let i = 0; i < 30; i++) h.press(DOWN);
    const text = h.text();
    expect(text).toContain('extension: plugin');
    expect(text).toContain('build ok');
    expect(text).toContain('extension: absent');
    expect(text).toContain('(not set now)');
    h.press(UP, UP, ' ', ENTER);
    const result = h.result() as StatusLineConfig;
    expect(result.items.map(item => item.id)).toContain('extension:absent');
    expect(result.items.filter(item => item.id.startsWith('extension:'))).toHaveLength(3);
  });

  test('changes side, reorders right-side modules, and keeps the selection when changing rows', () => {
    const config = defaultConfig();
    for (const item of config.items) if (item.id === 'model' || item.id === 'thinking') item.side = 'right';
    const h = mount(config);
    for (let i = 0; i < FIRST_ITEM + 4; i++) h.press(DOWN); // model, first module on the right
    expect(h.text()).toContain('Row 1 · Right');
    expect(h.text()).toContain('❯ [x] Model');
    h.press(']'); // thinking now appears before model on the right
    expect(h.text().split('\n').find(line => line.includes('● ready'))?.trimEnd()).toEndWith('high · gpt-test');
    h.press(LEFT);
    expect(h.text()).toContain('❯ [x] Model');
    h.press(RIGHT, '2');
    expect(h.text()).toContain('Row 2 · Right');
    expect(h.text()).toContain('❯ [x] Model');
    h.press(ENTER);
    const saved = h.result() as StatusLineConfig;
    expect(saved.items.find(item => item.id === 'model')).toEqual({ id: 'model', enabled: true, row: 2, side: 'right' });
    expect(saved.items.find(item => item.id === 'thinking')?.side).toBe('right');
    expect(saved.items.filter(item => item.side !== 'right').map(item => item.id)).toEqual(
      config.items.filter(item => item.side !== 'right').map(item => item.id));
  });

  test('reorders external modules on the right and preserves inactive modules', () => {
    const config = defaultConfig();
    config.items.push({ id: 'extension:absent', row: 2, side: 'right', enabled: false });
    const h = mount(config, new Map([['active', 'build ok']]));
    h.press('\x1b[F', UP, RIGHT); // active moves from the left to the right, before absent
    expect(h.text()).toContain('❯ [x] extension: active');
    h.press(']', ENTER); // put absent before active within the right group
    const saved = h.result() as StatusLineConfig;
    expect(saved.items.filter(item => item.side === 'right')).toEqual([
      { id: 'extension:absent', row: 2, side: 'right', enabled: false },
      { id: 'extension:active', row: 2, side: 'right', enabled: true },
    ]);
  });

  test('Esc cancels immediately when clean and asks for a second Esc when dirty', () => {
    const clean = mount();
    clean.press(ESC);
    expect(clean.result()).toBeUndefined();

    const dirty = mount();
    dirty.press(' ', ESC);
    expect(dirty.result()).toBe('pending');
    expect(dirty.text()).toContain('Press Esc again');
    dirty.press(ESC);
    expect(dirty.result()).toBeUndefined();

    const ctrlC = mount();
    ctrlC.press(' ', CTRL_C);
    expect(ctrlC.result()).toBeUndefined();
  });

  test('discovers statuses while open without losing the selected module or creating an unsaved edit', () => {
    const statuses = new Map([['z-plugin', 'build']]);
    const h = mount(defaultConfig(), statuses);
    h.press('\x1b[F');
    statuses.set('a-plugin', 'lint');
    expect(h.text()).toContain('extension: a-plugin');
    expect(h.text()).toMatch(/❯ \[x\] extension: z-plugin/);
    expect(h.text()).not.toContain('unsaved changes');
    h.press(' ', ENTER);
    const saved = h.result() as StatusLineConfig;
    expect(saved.items.find(item => item.id === 'extension:z-plugin')?.enabled).toBe(false);
    expect(saved.items.find(item => item.id === 'extension:a-plugin')?.enabled).toBe(true);
  });

  test('handles printable shortcuts encoded with the Kitty keyboard protocol', () => {
    const h = mount();
    h.press('\x1b[99u'); // c
    h.press('\x1b[112u'); // p
    expect(h.text()).toContain('Preview (sample)');
    for (let i = 0; i < FIRST_ITEM + 1; i++) h.press('\x1b[106u'); // j, select model
    h.press('\x1b[91u', ENTER); // [ moves model above state
    const saved = h.result() as StatusLineConfig;
    expect(saved.colorMode).toBe('theme');
    expect(saved.items[0].id).toBe('model');
  });

  test('ignores input after finishing or being disposed', () => {
    const saved = mount();
    saved.press(ENTER, CTRL_C);
    expect(saved.result()).toEqual(defaultConfig());
    const disposed = mount();
    disposed.editor.dispose();
    disposed.press(ENTER);
    expect(disposed.result()).toBe('pending');
  });

  test('reset restores defaults in the draft only until saved', () => {
    const config = { ...defaultConfig(), colorMode: 'mono' as const, enabled: false };
    const h = mount(config);
    h.press('r');
    expect(h.result()).toBe('pending');
    expect(h.text()).toContain('Defaults restored');
    h.press(ENTER);
    expect(h.result()).toEqual(defaultConfig());
  });

  test('keeps the list bounded and every line within the width', () => {
    const statuses = new Map(Array.from({ length: 30 }, (_, i) => [`plugin-${i}`, `status ${i} 🚀 ステータス`]));
    const h = mount(defaultConfig(), statuses);
    for (const width of [20, 40, 80]) {
      const lines = h.editor.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(lines.length).toBeLessThan(40);
    }
    expect(h.text()).toMatch(/↓ \d+ more/);
    h.press('\x1b[F'); // End
    expect(h.text()).toMatch(/↑ \d+ more/);
  });

  test('unknown keys are ignored without re-rendering', () => {
    const h = mount();
    h.press('z');
    expect(h.renders()).toBe(0);
    h.press(DOWN);
    expect(h.renders()).toBe(1);
  });

  test('the new-status policy immediately updates unlisted keys already present in the editor', () => {
    const statuses = new Map([['new-plugin', 'NEW STATUS']]);
    const h = mount(defaultConfig(), statuses);
    expect(h.editor.render(200).slice(3, 5).map(strip).join('\n')).toContain('NEW STATUS');
    h.press(DOWN, DOWN, ' ');
    expect(h.editor.render(200).slice(3, 5).map(strip).join('\n')).not.toContain('NEW STATUS');
    statuses.set('later-plugin', 'LATER STATUS');
    h.text();
    h.press(ENTER);
    const saved = h.result() as StatusLineConfig;
    expect(saved.showNewExtensionStatuses).toBe(false);
    expect(saved.items.filter(item => item.id.startsWith('extension:')).map(item => item.enabled)).toEqual([false, false]);
  });

  test('the new-status policy preserves saved visibility choices and explicit toggles during the visit', () => {
    const config = defaultConfig();
    config.items.push({ id: 'extension:shown', row: 2, enabled: true }, { id: 'extension:hidden', row: 2, enabled: false });
    const h = mount(config, new Map([['shown', 'shown'], ['hidden', 'hidden'], ['new', 'new']]));
    h.press(DOWN, DOWN, ' '); // new statuses hidden
    h.press('\x1b[F', ' '); // explicitly show the new key
    h.press('\x1b[H', DOWN, DOWN, ' ', ' ', ENTER); // change the policy twice
    const saved = h.result() as StatusLineConfig;
    expect(saved.showNewExtensionStatuses).toBe(false);
    expect(saved.items.find(item => item.id === 'extension:shown')?.enabled).toBe(true);
    expect(saved.items.find(item => item.id === 'extension:hidden')?.enabled).toBe(false);
    expect(saved.items.find(item => item.id === 'extension:new')?.enabled).toBe(true);
  });

  test('reduces the list height to keep the preview and controls visible on a 24-row terminal', () => {
    const terminal = { rows: 24 };
    const editor = new StatusLineEditor({ requestRender() {}, terminal }, fakeTheme().theme, {
      config: defaultConfig(), discoveryAvailable: true, liveSnapshot: () => snapshot(),
    }, () => {});
    for (const key of ['', '\x1b[F', ' ', '\x1b']) {
      editor.handleInput(key);
      const rows = editor.render(80);
      expect(rows.length).toBeLessThanOrEqual(19);
      const text = rows.map(strip).join('\n');
      expect(text).toContain('Status line');
      expect(text).toContain('Esc cancel');
      expect(text).toContain('❯');
    }
    terminal.rows = 40;
    expect(editor.render(80).length).toBeGreaterThan(19);
  });
});
