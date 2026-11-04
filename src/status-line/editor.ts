import type { Theme } from '@earendil-works/pi-coding-agent';
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from '@earendil-works/pi-tui';
import {
  BUILTIN_LABELS, COLOR_MODES, cloneConfig, defaultConfig, extensionKey, resolveItems,
  type BuiltinModuleId, type Side, type StatusLineConfig, type StatusLineItem,
} from './config.ts';
import { renderStatusLine, sampleSnapshot, sanitizeInline, type StatusSnapshot } from './render.ts';

export interface StatusLineEditorOptions {
  config: StatusLineConfig;
  /** Live data, or undefined when unavailable. Called on every render. */
  liveSnapshot: () => StatusSnapshot | undefined;
  /** Whether extension statuses can be discovered right now (the custom footer is mounted). */
  discoveryAvailable: boolean;
}

const SETTINGS = ['enabled', 'colorMode', 'showNew'] as const;
const MAX_VISIBLE_ITEMS = 8;
const COLOR_LABELS: Record<StatusLineConfig['colorMode'], string> = {
  colorful: 'colourful (varied theme colours)',
  theme: 'theme (accent + warnings only)',
  mono: 'monochrome (no colour)',
};

export const EDITOR_HINTS = [
  '↑↓ select', 'Space toggle', 'Shift+↑↓ or [ ] reorder', '←→ side', '1/2 row', 'c colour', 'p preview',
  'r reset', 'Enter/Ctrl+S save', 'Esc cancel',
];

function sortByPlacement(items: StatusLineItem[]): StatusLineItem[] {
  return [1, 2].flatMap(row => (['left', 'right'] as const).flatMap(side =>
    items.filter(item => item.row === row && (item.side ?? 'left') === side)));
}

export class StatusLineEditor implements Component {
  private draft: StatusLineConfig;
  private initial: string;
  private cursor = 0;
  private preview: 'live' | 'sample' = 'live';
  private notice: { text: string; kind: 'muted' | 'warning' | 'success' } | undefined;
  private cancelArmed = false;
  private closed = false;
  private pageSize = MAX_VISIBLE_ITEMS;
  private knownIds: Set<string>;
  private readonly visibilityOverrides = new Set<string>();

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'> & { terminal?: Pick<TUI['terminal'], 'rows'> },
    private readonly theme: Theme,
    private readonly options: StatusLineEditorOptions,
    private readonly done: (result: StatusLineConfig | undefined) => void,
  ) {
    this.knownIds = new Set(options.config.items.map(item => item.id));
    this.draft = this.withPresentKeys(cloneConfig(options.config));
    this.initial = JSON.stringify(this.draft);
  }

  private presentStatuses(): ReadonlyMap<string, string> {
    try { return this.options.liveSnapshot()?.extensionStatuses ?? new Map(); } catch { return new Map(); }
  }

  private withPresentKeys(config: StatusLineConfig): StatusLineConfig {
    const items = resolveItems(config, this.presentStatuses().keys());
    for (const item of items) {
      if (extensionKey(item.id) !== undefined && !this.knownIds.has(item.id) && !this.visibilityOverrides.has(item.id)) {
        item.enabled = config.showNewExtensionStatuses;
      }
    }
    return { ...config, items: sortByPlacement(items) };
  }

  private refreshPresentKeys(): void {
    const clean = !this.dirty;
    const selected = this.draft.items[this.cursor - SETTINGS.length]?.id;
    this.draft = this.withPresentKeys(this.draft);
    if (selected) this.cursor = SETTINGS.length + this.draft.items.findIndex(item => item.id === selected);
    if (clean) this.initial = JSON.stringify(this.draft);
  }

  private finish(result: StatusLineConfig | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  private get rowCount(): number { return SETTINGS.length + this.draft.items.length; }
  private get dirty(): boolean { return JSON.stringify(this.draft) !== this.initial; }

  private say(text: string, kind: 'muted' | 'warning' | 'success' = 'muted'): void { this.notice = { text, kind }; }

  private toggle(): void {
    if (this.cursor < SETTINGS.length) {
      const setting = SETTINGS[this.cursor]!;
      if (setting === 'enabled') this.draft.enabled = !this.draft.enabled;
      else if (setting === 'colorMode') this.cycleColor();
      else {
        this.draft.showNewExtensionStatuses = !this.draft.showNewExtensionStatuses;
        this.draft = this.withPresentKeys(this.draft);
      }
      return;
    }
    const item = this.draft.items[this.cursor - SETTINGS.length]!;
    item.enabled = !item.enabled;
    this.visibilityOverrides.add(item.id);
  }

  private cycleColor(): void {
    const index = COLOR_MODES.indexOf(this.draft.colorMode);
    this.draft.colorMode = COLOR_MODES[(index + 1) % COLOR_MODES.length]!;
  }

  private move(direction: -1 | 1): void {
    const index = this.cursor - SETTINGS.length;
    if (index < 0) { this.say('Select a module to reorder it.'); return; }
    const items = this.draft.items;
    const item = items[index]!;
    const neighbour = items[index + direction];
    if (neighbour && neighbour.row === item.row && (neighbour.side ?? 'left') === (item.side ?? 'left')) {
      items[index] = neighbour;
      items[index + direction] = item;
      this.cursor += direction;
    } else if (direction === -1 && item.row === 2) item.row = 1;
    else if (direction === 1 && item.row === 1) item.row = 2;
    this.draft.items = sortByPlacement(items);
    this.cursor = SETTINGS.length + this.draft.items.indexOf(item);
  }

  private setRow(row: 1 | 2): void {
    const index = this.cursor - SETTINGS.length;
    if (index < 0) return;
    const item = this.draft.items[index]!;
    if (item.row === row) return;
    item.row = row;
    this.draft.items = sortByPlacement(this.draft.items);
    this.cursor = SETTINGS.length + this.draft.items.indexOf(item);
  }

  private setSide(side: Side): void {
    const item = this.draft.items[this.cursor - SETTINGS.length];
    if (!item || (item.side ?? 'left') === side) return;
    item.side = side;
    this.draft.items = sortByPlacement(this.draft.items);
    this.cursor = SETTINGS.length + this.draft.items.indexOf(item);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.refreshPresentKeys();
    const printable = decodeKittyPrintable(data) ?? data;
    const wasArmed = this.cancelArmed;
    this.cancelArmed = false;
    if (matchesKey(data, Key.ctrl('c'))) { this.finish(undefined); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.dirty && !wasArmed) {
        this.cancelArmed = true;
        this.say('Unsaved changes. Press Esc again to discard, or Enter to save.', 'warning');
      } else this.finish(undefined);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl('s'))) { this.finish(cloneConfig(this.draft)); return; }
    this.notice = undefined;
    if (matchesKey(data, Key.shift('up')) || matchesKey(data, Key.alt('up')) || printable === '[' || printable === 'K') this.move(-1);
    else if (matchesKey(data, Key.shift('down')) || matchesKey(data, Key.alt('down')) || printable === ']' || printable === 'J') this.move(1);
    else if (matchesKey(data, Key.up) || printable === 'k') this.cursor = (this.cursor - 1 + this.rowCount) % this.rowCount;
    else if (matchesKey(data, Key.down) || printable === 'j') this.cursor = (this.cursor + 1) % this.rowCount;
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = this.rowCount - 1;
    else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.pageSize);
    else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(this.rowCount - 1, this.cursor + this.pageSize);
    else if (matchesKey(data, Key.left)) this.setSide('left');
    else if (matchesKey(data, Key.right)) this.setSide('right');
    else if (printable === '1') this.setRow(1);
    else if (printable === '2') this.setRow(2);
    else if (matchesKey(data, Key.space) || data === ' ') this.toggle();
    else if (printable === 'c') this.cycleColor();
    else if (printable === 'p') this.preview = this.preview === 'live' ? 'sample' : 'live';
    else if (printable === 'r') {
      this.knownIds = new Set(defaultConfig().items.map(item => item.id));
      this.visibilityOverrides.clear();
      this.draft = this.withPresentKeys(defaultConfig());
      this.cursor = Math.min(this.cursor, this.rowCount - 1);
      this.say('Defaults restored in the editor. Enter saves, Esc discards.');
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void { this.closed = true; }

  private previewData(): { data: StatusSnapshot; label: string } {
    const statuses = this.presentStatuses();
    if (this.preview === 'live') {
      try {
        const live = this.options.liveSnapshot();
        if (live) return { data: live, label: 'live' };
      } catch { /* fall through to the sample */ }
    }
    return { data: sampleSnapshot(statuses), label: this.preview === 'live' ? 'sample, live data unavailable' : 'sample' };
  }

  private itemLabel(item: StatusLineItem, statuses: ReadonlyMap<string, string>): { label: string; detail: string } {
    const key = extensionKey(item.id);
    if (key === undefined) return { label: BUILTIN_LABELS[item.id as BuiltinModuleId], detail: '' };
    const text = statuses.get(key);
    return {
      label: `extension: ${sanitizeInline(key, false)}`,
      detail: text === undefined ? '(not set now)' : sanitizeInline(text, false),
    };
  }

  render(width: number): string[] {
    this.refreshPresentKeys();
    const t = this.theme;
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    const add = (text = '') => lines.push(truncateToWidth(` ${text}`, width, '…'));
    const rule = t.fg('borderMuted', '─'.repeat(Math.max(0, width)));

    lines.push(rule);
    add(t.bold(t.fg('accent', 'Status line')) + t.fg('muted', `  ${this.dirty ? '• unsaved changes' : 'saved'}`));
    const { data, label } = this.previewData();
    add(t.fg('muted', `Preview (${label}) · p toggles live/sample`));
    if (this.draft.enabled) {
      const preview = renderStatusLine(data, this.draft, t, inner);
      for (const line of preview.length ? preview : [t.fg('muted', '(no modules have data to show)')]) add(line);
    } else add(t.fg('warning', 'Custom footer off. Pi\'s built-in footer is used.'));
    add();

    const statuses = this.presentStatuses();
    const settingRows = [
      ['Custom footer', this.draft.enabled ? t.fg('success', 'on') : t.fg('warning', 'off')],
      ['Colour', COLOR_LABELS[this.draft.colorMode]],
      ['New extension statuses', this.draft.showNewExtensionStatuses ? 'shown' : 'hidden'],
    ] as const;
    settingRows.forEach(([name, value], index) => {
      const selected = this.cursor === index;
      const pointer = selected ? t.fg('accent', '❯ ') : '  ';
      const nameText = selected ? t.bold(name) : name;
      add(`${pointer}${nameText}${' '.repeat(Math.max(1, 24 - visibleWidth(name)))}${value}`);
    });

    const itemIndex = this.cursor - SETTINGS.length;
    const total = this.draft.items.length;
    const hints = wrapTextWithAnsi(t.fg('dim', EDITOR_HINTS.join(' • ')), inner);
    // Leave room for Pi's footer and space around the custom editor on short terminals.
    const height = this.tui.terminal ? Math.max(1, this.tui.terminal.rows - 5) : Infinity;
    const groups = new Set(this.draft.items.map(item => `${item.row}:${item.side ?? 'left'}`)).size;
    const reserved = hints.length + 3 + groups + Number(Boolean(this.notice)) + Number(!this.options.discoveryAvailable);
    this.pageSize = Math.max(1, Math.min(MAX_VISIBLE_ITEMS, height - lines.length - reserved));
    const start = Math.max(0, Math.min(total - this.pageSize, itemIndex - Math.floor(this.pageSize / 2)));
    const end = Math.min(total, start + this.pageSize);
    add(t.fg('muted', start > 0 ? `  ↑ ${start} more` : ''));
    let lastGroup: string | undefined;
    for (let i = start; i < end; i++) {
      const item = this.draft.items[i]!;
      const group = `Row ${item.row} · ${item.side === 'right' ? 'Right' : 'Left'}`;
      if (group !== lastGroup) { add(t.fg('mdHeading', group)); lastGroup = group; }
      const selected = i === itemIndex;
      const pointer = selected ? t.fg('accent', '❯ ') : '  ';
      const box = item.enabled ? t.fg('success', '[x]') : t.fg('muted', '[ ]');
      const { label: name, detail } = this.itemLabel(item, statuses);
      const nameText = selected ? t.bold(name) : item.enabled ? name : t.fg('muted', name);
      add(`${pointer}${box} ${nameText}${detail ? t.fg('dim', `  ${detail}`) : ''}`);
    }
    add(t.fg('muted', end < total ? `  ↓ ${total - end} more` : ''));
    if (!this.options.discoveryAvailable) {
      add(t.fg('muted', 'Extension statuses are discovered while the custom footer is on.'));
    }
    if (this.notice) add(t.fg(this.notice.kind, this.notice.text));
    for (const line of hints) add(line);
    lines.push(rule);
    return lines;
  }
}
