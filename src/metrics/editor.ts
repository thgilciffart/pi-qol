import type { Theme } from '@earendil-works/pi-coding-agent';
import { decodeKittyPrintable, Input, Key, matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';
import { keyHints } from '../picker-header.ts';
import { sanitizeInline } from '../status-line/sanitize.ts';
import { STAT_LABELS, type MetricsConfig } from './config.ts';

export class MetricsEditor implements Component, Focusable {
  private cursor = 0;
  private separatorInput?: Input;
  private closed = false;
  private hasFocus = false;
  private separatorError = false;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender' | 'terminal'>,
    private readonly theme: Theme,
    private readonly draft: MetricsConfig,
    private readonly preview: (config: MetricsConfig) => string,
    private readonly done: (config?: MetricsConfig) => void,
  ) {}

  get focused(): boolean { return this.separatorInput?.focused ?? this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.separatorInput) this.separatorInput.focused = value;
  }
  private finish(config?: MetricsConfig): void {
    this.closed = true;
    this.done(config);
  }

  private editSeparator(): void {
    this.separatorError = false;
    const input = new Input({ prompt: 'Separator text: ' });
    input.setValue(this.draft.separator.text);
    input.focused = this.focused;
    input.onSubmit = value => {
      const text = sanitizeInline(value, false);
      this.separatorError = !text;
      if (!text) return;
      this.draft.separator.text = text;
      this.separatorInput = undefined;
    };
    input.onEscape = () => { this.separatorInput = undefined; };
    this.separatorInput = input;
  }

  private move(direction: -1 | 1): void {
    const items = this.draft.items;
    const next = this.cursor + direction;
    const item = items[this.cursor];
    const neighbour = items[next];
    if (!item || !neighbour) return;
    items[this.cursor] = neighbour;
    items[next] = item;
    this.cursor = next;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.ctrl('c'))) { this.finish(); return; }
    if (this.separatorInput) {
      this.separatorInput.handleInput(data);
      this.tui.requestRender();
      return;
    }
    const key = decodeKittyPrintable(data) ?? data;
    const lastRow = this.draft.items.length;
    if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down)) this.cursor = Math.min(lastRow, this.cursor + 1);
    else if (matchesKey(data, Key.shift('up')) || key === '[') this.move(-1);
    else if (matchesKey(data, Key.shift('down')) || key === ']') this.move(1);
    else if (matchesKey(data, Key.space) || key === ' ') {
      const selected = this.draft.items[this.cursor] ?? this.draft.separator;
      selected.enabled = !selected.enabled;
    } else if (key === 'e') this.editSeparator();
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl('s'))) { this.finish(this.draft); return; }
    else if (matchesKey(data, Key.escape)) { this.finish(); return; }
    else return;
    this.tui.requestRender();
  }

  invalidate(): void { this.separatorInput?.invalidate(); }

  render(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const title = theme.bold(theme.fg('accent', 'Response metrics'));
    const preview = this.preview(this.draft) || 'No stats enabled';
    const rows = [
      ...this.draft.items.map(item => ({ enabled: item.enabled, label: STAT_LABELS[item.id] })),
      { enabled: this.draft.separator.enabled, label: `Separator (${this.draft.separator.text})` },
    ];
    const visible = Math.max(1, (this.tui.terminal?.rows ?? 24) - 8);
    const start = Math.max(0, Math.min(rows.length - visible, this.cursor - Math.floor(visible / 2)));
    const lines = rows.slice(start, start + visible).map((row, index) => {
      const pointer = index + start === this.cursor ? theme.fg('accent', '❯ ') : '  ';
      const check = row.enabled ? theme.fg('success', '[x]') : theme.fg('muted', '[ ]');
      return `${pointer}${check} ${row.label}`;
    });
    const trim = (line: string) => truncateToWidth(` ${line}`, width, '…');
    return [
      ...[title, theme.fg('dim', preview), ...lines].map(trim),
      ...(this.separatorInput
        ? [...this.separatorInput.render(width), trim(this.separatorError ? theme.fg('warning', 'Enter a nonempty separator.') : 'Enter sets the text · Esc cancels the edit')]
        : [
            trim(keyHints(theme, [['↑↓', 'select'], ['Space', 'toggle'], ['⇧↑↓ or [ ]', 'reorder']], inner)),
            trim(keyHints(theme, [['e', 'separator text'], ['Enter', 'save'], ['Esc', 'cancel']], inner)),
          ]),
    ];
  }
}
