import type { Theme } from '@earendil-works/pi-coding-agent';
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { keyHints, pickerHeader } from '../picker-header.ts';
import { DOMAINS, FEATURES, featuresForDomain, type FeatureId, type QolFeatureEntry } from './features.ts';

export interface QolEditorOptions {
  /** Enabled state per feature at open. Edited in place as the user toggles. */
  draft: Record<FeatureId, boolean>;
  initial?: Record<FeatureId, boolean>;
  selection?: { tab: number; cursor: number };
  /** Problem with the stored settings, shown as a warning line. */
  loadError?: string;
  /** Whether the feature's own settings command can be opened right now. */
  settingsAvailable: (feature: QolFeatureEntry) => boolean;
}

export type QolEditorResult =
  | { kind: 'save'; features: Record<FeatureId, boolean> }
  | { kind: 'cancel' }
  | { kind: 'edit'; feature: QolFeatureEntry; selection: { tab: number; cursor: number } };

type Row =
  | { kind: 'feature'; feature: QolFeatureEntry }
  | { kind: 'settings'; feature: QolFeatureEntry };

const MAX_VISIBLE_ROWS = 10;

/**
 * Tabbed settings for the bundled pi-qol features: Tab/Shift+Tab switches the
 * domain, Up/Down moves, Space toggles a feature, Enter opens the feature's
 * own settings UI where one exists, s saves, Esc cancels.
 */
export class QolEditor implements Component {
  private readonly draft: Record<FeatureId, boolean>;
  private readonly initial: string;
  private tab = 0;
  private cursor = 0;
  private notice: { text: string; kind: 'muted' | 'warning' } | undefined;
  private cancelArmed = false;
  private closed = false;
  private pageSize = MAX_VISIBLE_ROWS;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'> & { terminal?: Pick<TUI['terminal'], 'rows'> },
    private readonly theme: Theme,
    private readonly options: QolEditorOptions,
    private readonly done: (result: QolEditorResult) => void,
  ) {
    this.draft = options.draft;
    this.initial = JSON.stringify(options.initial ?? this.draft);
    this.tab = options.selection?.tab ?? 0;
    this.cursor = options.selection?.cursor ?? 0;
  }

  private rows(): Row[] {
    const rows: Row[] = [];
    for (const feature of featuresForDomain(DOMAINS[this.tab]!.id)) {
      rows.push({ kind: 'feature', feature });
      if (feature.settingsCommand) rows.push({ kind: 'settings', feature });
    }
    return rows;
  }

  private get dirty(): boolean { return JSON.stringify(this.draft) !== this.initial; }

  private say(text: string, kind: 'muted' | 'warning' = 'muted'): void { this.notice = { text, kind }; }

  private finish(result: QolEditorResult): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  private switchTab(direction: -1 | 1): void {
    this.tab = (this.tab + direction + DOMAINS.length) % DOMAINS.length;
    this.cursor = 0;
  }

  private toggle(row: Row | undefined): void {
    if (!row) return;
    if (row.kind !== 'feature') {
      this.say(`Press Enter to open the ${row.feature.label} settings, or move up to toggle the feature.`);
      return;
    }
    this.draft[row.feature.id] = !this.draft[row.feature.id];
  }

  private edit(row: Row | undefined): void {
    if (!row) return;
    if (row.kind === 'feature') { this.toggle(row); return; }
    if (!this.options.settingsAvailable(row.feature)) {
      this.say(`The ${row.feature.label} settings open when the feature is enabled and reloaded.`, 'warning');
      return;
    }
    this.finish({ kind: 'edit', feature: row.feature, selection: { tab: this.tab, cursor: this.cursor } });
  }

  private save(): void {
    this.finish({ kind: 'save', features: { ...this.draft } });
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const rows = this.rows();
    const printable = decodeKittyPrintable(data) ?? data;
    const wasArmed = this.cancelArmed;
    this.cancelArmed = false;
    if (matchesKey(data, Key.ctrl('c'))) { this.finish({ kind: 'cancel' }); return; }
    if (matchesKey(data, Key.escape)) {
      if (this.dirty && !wasArmed) {
        this.cancelArmed = true;
        this.say('Unsaved changes. Press Esc again to discard, or s to save.', 'warning');
      } else this.finish({ kind: 'cancel' });
      this.tui.requestRender();
      return;
    }
    this.notice = undefined;
    if (matchesKey(data, Key.tab)) this.switchTab(1);
    else if (matchesKey(data, Key.shift('tab'))) this.switchTab(-1);
    else if (matchesKey(data, Key.left)) this.switchTab(-1);
    else if (matchesKey(data, Key.right)) this.switchTab(1);
    else if (matchesKey(data, Key.up) || printable === 'k') this.cursor = (this.cursor - 1 + rows.length) % rows.length;
    else if (matchesKey(data, Key.down) || printable === 'j') this.cursor = (this.cursor + 1) % rows.length;
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end)) this.cursor = rows.length - 1;
    else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.pageSize);
    else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(rows.length - 1, this.cursor + this.pageSize);
    else if (matchesKey(data, Key.space) || printable === ' ') this.toggle(rows[this.cursor]);
    else if (matchesKey(data, Key.enter)) this.edit(rows[this.cursor]);
    else if (printable === 's' || matchesKey(data, Key.ctrl('s'))) { this.save(); return; }
    else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void { this.closed = true; }

  private tabBar(width: number): string {
    const t = this.theme;
    const tabs = DOMAINS.map((domain, index) => {
      const features = featuresForDomain(domain.id);
      const enabled = features.filter(feature => this.draft[feature.id]).length;
      const text = ` ${domain.label} ${enabled}/${features.length} `;
      return index === this.tab ? t.bold(t.fg('accent', text)) : t.fg('muted', text);
    });
    const bar = tabs.join(t.fg('borderMuted', '│'));
    return visibleWidth(bar) <= width ? bar : `${tabs[this.tab]} ${t.fg('muted', 'Tab / ⇧Tab')}`;
  }

  private rowLine(row: Row, selected: boolean): string {
    const t = this.theme;
    const pointer = selected ? t.fg('accent', '❯ ') : '  ';
    if (row.kind === 'settings') {
      const available = this.options.settingsAvailable(row.feature);
      const label = `  ⚙ ${row.feature.label} settings…`;
      const detail = available ? `Enter opens /${row.feature.settingsCommand}` : 'available when the feature is enabled';
      const text = available ? (selected ? t.bold(label) : label) : t.fg('muted', label);
      return `${pointer}${text}${t.fg('dim', `  ${detail}`)}`;
    }
    const enabled = this.draft[row.feature.id];
    const box = enabled ? t.fg('success', '[x]') : t.fg('muted', '[ ]');
    const name = row.feature.label;
    const nameText = selected ? t.bold(name) : enabled ? name : t.fg('muted', name);
    return `${pointer}${box} ${nameText}${t.fg('dim', `  ${row.feature.provides}`)}`;
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    const add = (text = '') => lines.push(truncateToWidth(` ${text}`, width, '…'));
    const rule = t.fg('borderMuted', '─'.repeat(Math.max(0, width)));

    const rows = this.rows();
    this.cursor = Math.min(this.cursor, rows.length - 1);
    const enabledTotal = FEATURES.filter(feature => this.draft[feature.id]).length;

    lines.push(rule);
    const state = this.dirty ? t.fg('warning', 'Unsaved changes') : t.fg('muted', 'Saved');
    for (const line of pickerHeader(t.bold(t.fg('accent', 'pi-qol')), [state], inner)) add(line);
    add(t.fg('muted', `Bundled features: ${enabledTotal} of ${FEATURES.length} on. Saving reloads Pi to apply changes.`));
    add(this.tabBar(inner));
    add();

    const hint = keyHints(t, [['Tab', 'domain'], ['⇧Tab', 'back'], ['↑↓', 'select'], ['Space', 'toggle'], ['Enter', 'edit'], ['s', 'save'], ['Esc', 'cancel']], inner);
    const height = this.tui.terminal ? Math.max(1, this.tui.terminal.rows - 5) : Infinity;
    const reserved = 4 + Number(Boolean(this.notice)) + Number(Boolean(this.options.loadError));
    this.pageSize = Math.max(1, Math.min(MAX_VISIBLE_ROWS, height - lines.length - reserved));
    const start = Math.max(0, Math.min(rows.length - this.pageSize, this.cursor - Math.floor(this.pageSize / 2)));
    const end = Math.min(rows.length, start + this.pageSize);
    add(t.fg('muted', start > 0 ? `  ↑ ${start} more` : ''));
    for (let index = start; index < end; index++) add(this.rowLine(rows[index]!, index === this.cursor));
    add(t.fg('muted', end < rows.length ? `  ↓ ${rows.length - end} more` : ''));
    if (this.notice) add(t.fg(this.notice.kind, this.notice.text));
    if (this.options.loadError) {
      add(t.fg('warning', `Settings file problem: ${this.options.loadError} Editing defaults; saving keeps a backup of the file.`));
    }
    add(hint);
    lines.push(rule);
    return lines;
  }
}
