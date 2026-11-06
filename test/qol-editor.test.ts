import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { QolEditor, type QolEditorResult } from '../src/qol/editor.ts';
import { DOMAINS, FEATURES, featuresForDomain, type FeatureId } from '../src/qol/features.ts';
import { fakeTheme, strip } from './status-line/helpers.ts';

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const CTRL_C = '\x03';
const CTRL_S = '\x13';

function allOn(): Record<FeatureId, boolean> {
  return Object.fromEntries(FEATURES.map(feature => [feature.id, true])) as Record<FeatureId, boolean>;
}

function mount(options: {
  draft?: Record<FeatureId, boolean>;
  loadError?: string;
  settingsAvailable?: (id: string) => boolean;
  rows?: number;
} = {}) {
  const { theme } = fakeTheme();
  let result: QolEditorResult | 'pending' = 'pending';
  let renders = 0;
  const editor = new QolEditor(
    { requestRender: () => { renders++; }, terminal: { rows: options.rows ?? 40 } },
    theme,
    {
      draft: options.draft ?? allOn(),
      loadError: options.loadError,
      settingsAvailable: feature => options.settingsAvailable?.(feature.id) ?? true,
    },
    value => { result = value; },
  );
  const press = (...keys: string[]) => { for (const key of keys) editor.handleInput(key); };
  const text = (width = 100) => editor.render(width).map(strip).join('\n');
  return { editor, press, text, result: () => result, renders: () => renders };
}

describe('qol editor layout', () => {
  test('shows the title, tabs, feature rows, settings rows, and key hints', () => {
    const h = mount();
    const text = h.text();
    expect(text).toContain('pi-qol');
    expect(text).toContain('Saved');
    expect(text).toContain('Bundled features: 11 of 11 on');
    for (const domain of DOMAINS) expect(text).toContain(domain.label);
    expect(text).toContain('[x] Thread management');
    expect(text).toContain('/open, /delete, /delete-threads pickers');
    expect(text).toContain('⚙ Automatic naming settings…');
    expect(text).toContain('Enter opens /auto-name');
    expect(text).toContain('Tab');
    expect(text).toContain('Space');
    expect(text).toContain('toggle');
    expect(text).toContain('Esc');
    expect(text).toContain('cancel');
  });

  test('marks the active tab and its enabled count', () => {
    const h = mount({ draft: { ...allOn(), ephemeral: false } });
    const bar = h.editor.render(100).map(strip).find(line => line.includes('Threads'))!;
    expect(bar).toContain('Threads 2/3');
    expect(bar).toContain('Agent 4/4');
    expect(h.text()).toContain('Bundled features: 10 of 11 on');
  });

  test('shows the load error warning when the stored file is malformed', () => {
    const h = mount({ loadError: 'pi-qol settings: invalid JSON (Unexpected token).' });
    expect(h.text(140)).toContain('Settings file problem:');
    expect(h.text(140)).toContain('Editing defaults; saving keeps a backup');
  });

  test('every line fits the width at narrow and wide sizes', () => {
    const h = mount();
    for (const width of [1, 5, 20, 40, 100]) {
      for (const line of h.editor.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test('narrow tabs keep the active domain visible', () => {
    const h = mount();
    h.press(TAB, TAB, TAB);
    expect(h.text(30)).toContain('Tools 2/2');
  });

  test('windows long row lists with more indicators on short terminals', () => {
    const h = mount({ rows: 12 });
    expect(h.text()).toContain('↓ ');
    expect(h.text()).toContain('more');
    h.press(END());
    expect(h.text()).toContain('↑ ');
  });
  function END() { return '\x1b[F'; }
});

describe('qol editor tab and cursor keys', () => {
  test('Tab and Shift+Tab cycle the domain tabs', () => {
    const h = mount();
    expect(h.text()).toContain('Thread management');
    h.press(TAB);
    expect(h.text()).toContain('[x] Goals');
    expect(h.text()).not.toContain('Thread management');
    h.press(TAB);
    expect(h.text()).toContain('[x] Status line');
    h.press(TAB);
    expect(h.text()).toContain('[x] HTML export');
    h.press(TAB);
    expect(h.text()).toContain('Thread management');
    h.press(SHIFT_TAB);
    expect(h.text()).toContain('[x] HTML export');
  });

  test('Left and Right switch tabs too', () => {
    const h = mount();
    h.press(RIGHT);
    expect(h.text()).toContain('[x] Goals');
    h.press(LEFT, LEFT);
    expect(h.text()).toContain('[x] HTML export');
  });

  test('Up and Down move within the tab and wrap around', () => {
    const h = mount();
    const selected = () => h.editor.render(100).map(strip).find(line => line.includes('❯'))!;
    expect(selected()).toContain('Thread management');
    h.press(DOWN);
    expect(selected()).toContain('Automatic naming');
    h.press(UP);
    expect(selected()).toContain('Thread management');
    h.press(UP);
    expect(selected()).toContain('Ephemeral chats');
    h.press(DOWN);
    expect(selected()).toContain('Thread management');
  });
});

describe('qol editor toggles, edits, saves, and cancels', () => {
  test('Space and Enter toggle a feature and mark the draft dirty', () => {
    const h = mount();
    h.press(' ');
    expect(h.text()).toContain('[ ] Thread management');
    expect(h.text()).toContain('Unsaved changes');
    h.press(' ');
    expect(h.text()).toContain('[x] Thread management');
    expect(h.text()).not.toContain('Unsaved changes');
    h.press(DOWN, ENTER);
    expect(h.text()).toContain('[ ] Automatic naming');
    expect(h.renders()).toBe(4);
  });

  test('s saves the draft and Ctrl+S does the same', () => {
    const h = mount();
    h.press(DOWN, ' ', 's');
    const result = h.result() as Extract<QolEditorResult, { kind: 'save' }>;
    expect(result.kind).toBe('save');
    expect(result.features['auto-name']).toBe(false);
    expect(result.features['threads']).toBe(true);

    const other = mount();
    other.press(' ', CTRL_S);
    expect((other.result() as { kind: string }).kind).toBe('save');
  });

  test('Esc cancels immediately when clean and asks once when dirty', () => {
    const clean = mount();
    clean.press(ESC);
    expect((clean.result() as { kind: string }).kind).toBe('cancel');

    const dirty = mount();
    dirty.press(' ', ESC);
    expect(dirty.result()).toBe('pending');
    expect(dirty.text()).toContain('Unsaved changes. Press Esc again to discard');
    dirty.press(ESC);
    expect((dirty.result() as { kind: string }).kind).toBe('cancel');
  });

  test('Ctrl+C cancels even with unsaved changes', () => {
    const h = mount();
    h.press(' ', CTRL_C);
    expect((h.result() as { kind: string }).kind).toBe('cancel');
  });

  test('Enter on a settings row asks to edit through the feature handler', () => {
    const h = mount();
    h.press(DOWN, DOWN, ENTER);
    const result = h.result() as Extract<QolEditorResult, { kind: 'edit' }>;
    expect(result.kind).toBe('edit');
    expect(result.feature.id).toBe('auto-name');
    h.press(' ');
    expect(h.result()).toBe(result);
  });

  test('settings rows for disabled features explain instead of editing', () => {
    const h = mount({ settingsAvailable: () => false });
    expect(h.text()).toContain('available when the feature is enabled');
    h.press(DOWN, DOWN, ENTER);
    expect(h.result()).toBe('pending');
    expect(h.renders()).toBe(3);
    expect(h.text()).toContain('settings open when the feature is enabled and reloaded');
  });

  test('Space on a settings row points at Enter and the toggle row', () => {
    const h = mount();
    h.press(DOWN, DOWN, ' ');
    expect(h.result()).toBe('pending');
    expect(h.text()).toContain('Press Enter to open the Automatic naming settings');
  });

  test('toggles stay with their domain when switching tabs', () => {
    const h = mount();
    h.press(' ', TAB, ' ');
    const text = h.text();
    expect(text).toContain('[ ] Goals');
    expect(text).toContain('Agent 3/4');
    h.press(LEFT);
    expect(h.text()).toContain('[ ] Thread management');
    expect(h.text()).toContain('Threads 2/3');
    h.press(RIGHT, 's');
    const result = h.result() as Extract<QolEditorResult, { kind: 'save' }>;
    expect(result.features['threads']).toBe(false);
    expect(result.features['goal']).toBe(false);
    expect(result.features['auto-name']).toBe(true);
  });

  test('every tab renders its own features and settings rows', () => {
    const expected: [label: string, settings?: string][] = [];
    for (const domain of DOMAINS) {
      for (const feature of featuresForDomain(domain.id)) {
        expected.push([feature.label, feature.settingsCommand]);
      }
    }
    const h = mount();
    const texts: string[] = [h.text()];
    h.press(TAB); texts.push(h.text());
    h.press(TAB); texts.push(h.text());
    h.press(TAB); texts.push(h.text());
    const all = texts.join('\n');
    for (const [label, settings] of expected) {
      expect(all).toContain(label);
      if (settings) expect(all).toContain(`Enter opens /${settings}`);
    }
  });
});
