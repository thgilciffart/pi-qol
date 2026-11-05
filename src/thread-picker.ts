import type { SessionInfo, Theme } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import { errorMessage } from './shared.ts';
import { sessionSearchText } from './threads/search.ts';

type Grouping = 'none' | 'date' | 'project';
type ListRow = { kind: 'heading'; label: string } | { kind: 'thread'; session: SessionInfo; index: number };

export interface ThreadPickerOptions {
  project: SessionInfo[];
  loadAll: () => Promise<SessionInfo[]>;
  theme: Theme;
  requestRender: () => void;
  done: () => void;
  deleteThreads: (sessions: SessionInfo[]) => Promise<string[]>;
  viewTranscript?: (session: SessionInfo) => Promise<void>;
  query?: string;
  rows?: () => number;
}

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/** A searchable thread list with selection and an inline deletion confirmation. */
export class ThreadPicker implements Component, Focusable {
  private input = new Input();
  private dateFormatter = new Intl.DateTimeFormat();
  private project: SessionInfo[];
  private all: SessionInfo[] | undefined;
  private scope: 'project' | 'all' = 'project';
  private groupings: Record<'project' | 'all', Grouping> = { project: 'date', all: 'project' };
  private ascending = false;

  private get grouping(): Grouping { return this.groupings[this.scope]; }
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
    const sessions = (this.scope === 'project' ? this.project : this.all ?? []).filter(session =>
      sessionSearchText(session).includes(query));
    return sessions.sort((a, b) => {
      const left = this.groupLabel(a), right = this.groupLabel(b);
      const groupOrder = this.grouping === 'none' ? 0 : left.localeCompare(right);
      const time = (session: SessionInfo) => Number.isFinite(session.modified.getTime()) ? session.modified.getTime() : 0;
      const order = groupOrder || time(a) - time(b);
      if (!order) return a.path.localeCompare(b.path);
      return this.ascending ? order : -order;
    });
  }

  private threadTitle(session: SessionInfo): string {
    const date = Number.isFinite(session.modified.getTime()) ? this.dateFormatter.format(session.modified) : 'Unknown date';
    return `${date}  ${clean(session.name || session.firstMessage || session.id)}`;
  }

  private threadRow(session: SessionInfo, prefix: string, width: number): string {
    const timestamp = session.modified.getTime();
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    const age = !Number.isFinite(timestamp) ? 'Unknown age'
      : seconds < 60 ? 'just now'
      : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago`
      : `${Math.floor(seconds / 86400)}d ago`;
    const detail = this.grouping === 'date' ? clean(session.cwd || 'Unknown project')
      : Number.isFinite(timestamp) ? this.dateFormatter.format(session.modified) : 'Unknown date';
    const right = truncateToWidth(`${detail} · ${age}`, Math.max(0, width - 10));
    const left = truncateToWidth(`${prefix}${clean(session.name || session.firstMessage || session.id)}`,
      Math.max(0, width - visibleWidth(right) - 2));
    return `${left}${' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
  }

  private groupLabel(session: SessionInfo): string {
    if (this.grouping === 'project') return session.cwd || 'Unknown project';
    const date = session.modified;
    if (!Number.isFinite(date.getTime())) return 'Unknown date';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private listRows(sessions: SessionInfo[]): ListRow[] {
    const rows: ListRow[] = [];
    let previous: string | undefined;
    sessions.forEach((session, index) => {
      const label = this.groupLabel(session);
      if (this.grouping !== 'none' && label !== previous) rows.push({ kind: 'heading', label });
      rows.push({ kind: 'thread', session, index });
      previous = label;
    });
    return rows;
  }

  private visibleRows(rows: ListRow[]): ListRow[] {
    const budget = this.pageSize();
    const active = Math.max(0, rows.findIndex(row => row.kind === 'thread' && row.index === this.index));
    let start = Math.max(0, Math.min(active - Math.floor(budget / 2), rows.length - budget));
    // Repeat a group's heading when its first visible thread is midway through the group.
    if (this.grouping !== 'none' && budget > 1 && rows[start]?.kind === 'thread') {
      start = Math.max(start, active - budget + 2);
      const first = rows[start];
      if (first?.kind === 'thread') {
        return [{ kind: 'heading', label: this.groupLabel(first.session) }, ...rows.slice(start, start + budget - 1)];
      }
    }
    return rows.slice(start, start + budget);
  }

  private async loadAll(): Promise<void> {
    this.loading = true;
    try { this.all = (await this.options.loadAll()).filter(session => !this.deletedPaths.has(session.path)); }
    catch (error) { this.message = `Could not load threads: ${errorMessage(error)}`; }
    finally {
      this.loading = false;
      if (!this.disposed) this.options.requestRender();
    }
  }

  private async deleteConfirmed(): Promise<void> {
    const targets = this.confirmation;
    if (!targets) return;
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
      this.message = `Deletion failed: ${errorMessage(error)}`;
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
    } else if (matchesKey(data, 'ctrl+g')) {
      const focused = this.sessions()[this.index]?.path;
      const modes: Grouping[] = this.scope === 'project' ? ['none', 'date'] : ['none', 'date', 'project'];
      this.groupings[this.scope] = modes[(modes.indexOf(this.grouping) + 1) % modes.length];
      this.index = Math.max(0, this.sessions().findIndex(session => session.path === focused));
    } else if (matchesKey(data, 'shift+up') || matchesKey(data, 'shift+down')) {
      const focused = this.sessions()[this.index]?.path;
      this.ascending = matchesKey(data, 'shift+up');
      this.index = Math.max(0, this.sessions().findIndex(session => session.path === focused));
    } else {
      const sessions = this.sessions();
      if (matchesKey(data, 'ctrl+t')) {
        const session = sessions[this.index];
        if (session && this.options.viewTranscript) void this.options.viewTranscript(session).catch(error => {
          this.message = `Could not open transcript: ${errorMessage(error)}`;
          if (!this.disposed) this.options.requestRender();
        });
      } else if (matchesKey(data, 'ctrl+d')) {
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
        lines.push(`  ${this.threadTitle(session)}`);
      }
      if (this.confirmation.length > this.pageSize()) lines.push(`  … ${this.confirmation.length - this.pageSize()} more selected`);
    } else {
      lines.push(theme.fg('dim', 'tab project/all · ↑↓ navigate · space/enter select · ctrl+a select all · ctrl+t transcript'));
      lines.push(theme.fg('dim', `ctrl+d delete · ctrl+g group (${this.grouping}) · shift+↑↓ sort (${this.ascending ? 'ascending' : 'descending'}) · esc exit · ${this.selected.size} selected`), '');
      lines.push(...this.input.render(width), '');
      const sessions = this.sessions();
      const rows = this.listRows(sessions);
      if (this.deleting) lines.push(theme.fg('muted', 'Deleting threads…'));
      else if (this.scope === 'all' && this.loading) lines.push(theme.fg('muted', 'Loading threads…'));
      else if (!sessions.length) lines.push(theme.fg('muted', 'No matching threads. Tab switches scope.'));
      else for (const row of this.visibleRows(rows)) {
        if (row.kind === 'heading') {
          lines.push(theme.fg('muted', theme.bold(clean(row.label))));
          continue;
        }
        const { session, index } = row;
        const text = this.threadRow(session, `${index === this.index ? '›' : ' '} ${this.selected.has(session.path) ? '[x]' : '[ ]'} `, width);
        lines.push(index === this.index ? theme.bg('selectedBg', theme.fg('accent', text)) : text);
      }
      if (rows.length > this.pageSize()) lines.push(theme.fg('dim', `${this.index + 1}/${sessions.length} threads`));
      if (this.message) lines.push(theme.fg('muted', clean(this.message)));
    }
    lines.push('', rule);
    return lines.map(line => truncateToWidth(line, width));
  }

  invalidate(): void { this.input.invalidate(); }
  dispose(): void { this.disposed = true; }
}
