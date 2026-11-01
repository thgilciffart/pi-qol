import type { SessionInfo, Theme } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui';

export interface ThreadPickerOptions {
  project: SessionInfo[];
  loadAll: () => Promise<SessionInfo[]>;
  theme: Theme;
  requestRender: () => void;
  done: () => void;
  deleteThreads: (sessions: SessionInfo[]) => Promise<string[]>;
  query?: string;
  rows?: () => number;
}

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/** A searchable thread list with selection and an inline deletion confirmation. */
export class ThreadPicker implements Component, Focusable {
  private input = new Input();
  private project: SessionInfo[];
  private all: SessionInfo[] | undefined;
  private scope: 'project' | 'all' = 'project';
  private index = 0;
  private selected = new Map<string, SessionInfo>();
  private deletedPaths = new Set<string>();
  private confirmation: SessionInfo[] | undefined;
  private loading = false;
  private deleting = false;
  private disposed = false;
  private message = '';

  constructor(private options: ThreadPickerOptions) {
    this.project = options.project;
    this.input.setValue(options.query ?? '');
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private sessions(): SessionInfo[] {
    const query = this.input.getValue().toLocaleLowerCase();
    return (this.scope === 'project' ? this.project : this.all ?? []).filter(session =>
      `${session.name ?? ''}\n${session.firstMessage}\n${session.cwd}\n${session.id}`.toLocaleLowerCase().includes(query));
  }

  private async loadAll(): Promise<void> {
    this.loading = true;
    try { this.all = (await this.options.loadAll()).filter(session => !this.deletedPaths.has(session.path)); }
    catch (error) { this.message = `Could not load threads: ${error instanceof Error ? error.message : String(error)}`; }
    finally {
      this.loading = false;
      if (!this.disposed) this.options.requestRender();
    }
  }

  private async deleteConfirmed(): Promise<void> {
    const targets = this.confirmation!;
    this.confirmation = undefined;
    this.deleting = true;
    try {
      const deleted = new Set(await this.options.deleteThreads(targets));
      this.project = this.project.filter(session => !deleted.has(session.path));
      this.all = this.all?.filter(session => !deleted.has(session.path));
      for (const path of deleted) {
        this.selected.delete(path);
        this.deletedPaths.add(path);
      }
      this.message = `Deleted ${deleted.size} thread${deleted.size === 1 ? '' : 's'}.`;
      this.index = Math.min(this.index, Math.max(0, this.sessions().length - 1));
    } catch (error) {
      this.message = `Deletion failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.deleting = false;
      if (!this.disposed) this.options.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.options.done();
      return;
    }
    if (this.deleting) return;
    if (this.confirmation) {
      if (matchesKey(data, 'enter')) void this.deleteConfirmed();
      else if (data === 'n' || data === 'N') this.confirmation = undefined;
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, 'tab')) {
      this.scope = this.scope === 'project' ? 'all' : 'project';
      this.index = 0;
      if (this.scope === 'all' && !this.all && !this.loading) void this.loadAll();
    } else {
      const sessions = this.sessions();
      if (matchesKey(data, 'ctrl+d')) {
        const targets = this.selected.size ? [...this.selected.values()] : sessions[this.index] ? [sessions[this.index]] : [];
        if (targets.length) this.confirmation = targets;
      } else if (matchesKey(data, 'ctrl+a')) {
        for (const session of sessions) this.selected.set(session.path, session);
      } else if (matchesKey(data, 'space') || matchesKey(data, 'enter')) {
        const session = sessions[this.index];
        if (session) {
          if (this.selected.has(session.path)) this.selected.delete(session.path);
          else this.selected.set(session.path, session);
          this.index = Math.min(this.index + 1, sessions.length - 1);
        }
      } else if (matchesKey(data, 'up')) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, 'down')) this.index = Math.min(Math.max(0, sessions.length - 1), this.index + 1);
      else if (matchesKey(data, 'pageUp')) this.index = Math.max(0, this.index - this.pageSize());
      else if (matchesKey(data, 'pageDown')) this.index = Math.min(Math.max(0, sessions.length - 1), this.index + this.pageSize());
      else if (matchesKey(data, 'home')) this.index = 0;
      else if (matchesKey(data, 'end')) this.index = Math.max(0, sessions.length - 1);
      else {
        const previous = this.input.getValue();
        this.input.handleInput(data);
        if (previous !== this.input.getValue()) this.index = 0;
      }
    }
    this.options.requestRender();
  }

  private pageSize(): number {
    return Math.max(1, Math.min(12, (this.options.rows?.() ?? 24) - 10));
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const { theme } = this.options;
    const rule = theme.fg('border', '─'.repeat(width));
    const lines = [rule, '', theme.bold(`Delete threads (${this.scope === 'project' ? 'Current project' : 'All projects'})`)];
    if (this.confirmation) {
      lines.push(theme.fg('warning', `Permanently delete ${this.confirmation.length} thread${this.confirmation.length === 1 ? '' : 's'}? This cannot be undone.`));
      lines.push(theme.fg('dim', 'enter confirm · n back · esc exit'), '');
      for (const session of this.confirmation.slice(0, this.pageSize())) {
        lines.push(`  ${clean(session.name || session.firstMessage || session.id)}`);
      }
      if (this.confirmation.length > this.pageSize()) lines.push(`  … ${this.confirmation.length - this.pageSize()} more selected`);
    } else {
      lines.push(theme.fg('dim', 'tab project/all · ↑↓ navigate · space/enter select · ctrl+a select all'));
      lines.push(theme.fg('dim', `ctrl+d delete · esc exit · ${this.selected.size} selected`), '');
      lines.push(...this.input.render(width), '');
      const sessions = this.sessions();
      const start = Math.max(0, Math.min(this.index - Math.floor(this.pageSize() / 2), sessions.length - this.pageSize()));
      if (this.deleting) lines.push(theme.fg('muted', 'Deleting threads…'));
      else if (this.scope === 'all' && this.loading) lines.push(theme.fg('muted', 'Loading threads…'));
      else if (!sessions.length) lines.push(theme.fg('muted', 'No matching threads. Tab switches scope.'));
      else for (let i = start; i < Math.min(sessions.length, start + this.pageSize()); i++) {
        const session = sessions[i];
        const row = `${i === this.index ? '›' : ' '} ${this.selected.has(session.path) ? '[x]' : '[ ]'} ${clean(session.name || session.firstMessage || session.id)}`;
        const text = truncateToWidth(row, width);
        lines.push(i === this.index ? theme.bg('selectedBg', theme.fg('accent', text)) : text);
      }
      if (sessions.length > this.pageSize()) lines.push(theme.fg('dim', `${this.index + 1}/${sessions.length} threads`));
      if (this.message) lines.push(theme.fg('muted', clean(this.message)));
    }
    lines.push('', rule);
    return lines.map(line => truncateToWidth(line, width));
  }

  invalidate(): void { this.input.invalidate(); }
  dispose(): void { this.disposed = true; }
}
