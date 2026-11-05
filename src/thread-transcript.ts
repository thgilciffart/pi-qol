import { readFile } from 'node:fs/promises';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import * as PiAgent from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme, type Theme, type ToolRenderers } from '@earendil-works/pi-coding-agent';
import * as PiTui from '@earendil-works/pi-tui';
import { Container, Markdown, matchesKey, Text, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';

// Optional Pi APIs are read from the module namespace. A missing export is `undefined` there,
// so another Pi version disables the feature instead of failing to load the extension.
const agent: Partial<typeof PiAgent> = PiAgent;
const tuiApi: Partial<typeof PiTui> = PiTui;

type ImageBlock = { type: 'image'; mimeType: string; data: string };
type ResultBlock = { type: string; text?: string; data?: string; mimeType?: string };
export type ToolResultView = { content: ResultBlock[]; details?: unknown; isError: boolean; durationMs?: number };

/** One saved message, prepared for display. Strings are free of terminal controls and images carry no data. */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; message: AssistantMessage }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; result?: ToolResultView; interrupted?: string }
  | { kind: 'bash'; command: string; output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean;
      fullOutputPath?: string; excludeFromContext: boolean }
  | { kind: 'custom'; customType: string; content: string | (ResultBlock & { type: 'text' | 'image' })[]; display: boolean;
      details?: unknown; timestamp: number }
  | { kind: 'compaction'; summary: string; tokensBefore: number; timestamp: number }
  | { kind: 'branch'; summary: string; fromId: string | null; timestamp: number }
  | { kind: 'other'; label: string; text: string };

export interface Transcript {
  items: TranscriptItem[];
  /** Saved message entries, counted before tool calls are paired with results. */
  messages: number;
  /** Lines that were not valid JSON. */
  skipped: number;
}

const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P^_X][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;

/** Remove terminal escape sequences and control characters other than newlines. */
export function cleanText(value: string): string {
  return value.replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

const oneLine = (value: string) => cleanText(value).replace(/\s+/g, ' ').trim();

/** Deep-copy saved JSON with clean strings and keys. Image blocks keep their MIME type and lose their data. */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return cleanText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.type === 'image') {
    return { type: 'image', mimeType: typeof record.mimeType === 'string' ? oneLine(record.mimeType) : 'image', data: '' } satisfies ImageBlock;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [cleanText(key), scrub(item, depth + 1)]));
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const blocks = (content: unknown): Record<string, unknown>[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.map(record) : [];

function contentText(content: unknown): string {
  return blocks(content).map(block => block.type === 'text' ? text(block.text)
    : block.type === 'image' ? `[Image: ${text(block.mimeType, 'image')}]`
    : JSON.stringify(block, null, 2)).filter(Boolean).join('\n');
}

function resultBlocks(content: unknown): ResultBlock[] {
  return blocks(content).map(block => block.type === 'text' || block.type === 'image'
    ? block as ResultBlock : { type: 'text', text: JSON.stringify(block, null, 2) });
}

const ASSISTANT_BLOCKS = new Set(['text', 'thinking', 'toolCall']);

/**
 * Read a saved session file. Every message entry is kept, in file order: user and assistant
 * messages, thinking, tool calls with their results, shell commands, extension messages, and
 * summaries. Invalid JSON lines are counted and skipped. Session metadata entries are not messages.
 */
export async function readTranscript(path: string): Promise<Transcript> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  let skipped = 0, messages = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = record(scrub(JSON.parse(line))); } catch { skipped++; continue; }
    const timestamp = Date.parse(text(entry.timestamp)) || 0;
    if (entry.type === 'custom_message') {
      messages++;
      items.push({ kind: 'custom', customType: text(entry.customType, 'custom'), content: entry.content as never ?? '',
        display: entry.display !== false, details: entry.details, timestamp });
      continue;
    }
    if (entry.type === 'compaction') {
      messages++;
      items.push({ kind: 'compaction', summary: text(entry.summary), tokensBefore: number(entry.tokensBefore, 0), timestamp });
      continue;
    }
    if (entry.type === 'branch_summary') {
      messages++;
      items.push({ kind: 'branch', summary: text(entry.summary), fromId: text(entry.fromId) || null, timestamp });
      continue;
    }
    if (entry.type !== 'message') continue;
    messages++;
    const message = record(entry.message);
    const role = text(message.role, 'unknown');
    if (role === 'user') {
      items.push({ kind: 'user', text: contentText(message.content) });
    } else if (role === 'assistant') {
      const content = blocks(message.content);
      items.push({ kind: 'assistant', message: { ...message, content } as unknown as AssistantMessage });
      const interrupted = message.stopReason === 'aborted' ? 'Operation aborted'
        : message.stopReason === 'error' ? text(message.errorMessage, 'Error') : undefined;
      for (const block of content) {
        if (block.type === 'toolCall') {
          const item = { kind: 'tool' as const, id: text(block.id), name: text(block.name, 'tool'), args: record(block.arguments), interrupted };
          items.push(item);
          tools.set(item.id, item);
        } else if (!ASSISTANT_BLOCKS.has(text(block.type))) {
          items.push({ kind: 'other', label: `Assistant ${text(block.type, 'content')}`, text: contentText([block]) });
        }
      }
    } else if (role === 'toolResult') {
      const result: ToolResultView = { content: resultBlocks(message.content), details: message.details, isError: message.isError === true,
        ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {}) };
      const id = text(message.toolCallId);
      const call = tools.get(id);
      if (call && !call.result) call.result = result;
      else items.push({ kind: 'tool', id, name: text(message.toolName, 'tool'), args: {}, result });
    } else if (role === 'bashExecution') {
      items.push({ kind: 'bash', command: text(message.command), output: text(message.output),
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined, cancelled: message.cancelled === true,
        truncated: message.truncated === true, fullOutputPath: text(message.fullOutputPath) || undefined,
        excludeFromContext: message.excludeFromContext === true });
    } else if (role === 'custom') {
      items.push({ kind: 'custom', customType: text(message.customType, 'custom'), content: message.content as never ?? '',
        display: message.display !== false, details: message.details, timestamp: number(message.timestamp, timestamp) });
    } else if (role === 'compactionSummary') {
      items.push({ kind: 'compaction', summary: text(message.summary), tokensBefore: number(message.tokensBefore, 0), timestamp });
    } else if (role === 'branchSummary') {
      items.push({ kind: 'branch', summary: text(message.summary), fromId: text(message.fromId) || null, timestamp });
    } else {
      items.push({ kind: 'other', label: role, text: contentText(message.content) || JSON.stringify(message, null, 2) });
    }
  }
  return { items, messages, skipped };
}

/** Pi's fullscreen renderer has no public getter for its layout root. Accept the field only when it is a component. */
function layoutRoot(tui: TUI): Component | undefined {
  if (typeof tuiApi.isViewportTUI !== 'function' || !tuiApi.isViewportTUI(tui) || typeof tui.setLayoutRoot !== 'function') return undefined;
  const root = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
  return root && typeof (root as Component).render === 'function' ? root as Component : undefined;
}

/** Whether this renderer lets the transcript replace the whole screen while it has focus. */
export function canTakeOverScreen(tui: TUI): boolean { return !!layoutRoot(tui); }

/** Layout root that draws the transcript across the fullscreen viewport. It contains the viewer so Pi's focus checks still find it. */
class TranscriptScreen extends Container {
  constructor(private viewer: ThreadTranscript, private draw: (width: number) => string[]) { super(); this.children.push(viewer); }
  override render(width: number): string[] { return this.draw(width); }
  override handleMouse(event: TuiMouseEvent): ReturnType<Container['handleMouse']> {
    const result = this.viewer.handleMouse(event);
    return result?.handled ? { ...result, handled: true, target: { component: this.viewer, originX: event.screenX - event.x,
      originY: event.screenY - event.y, width: event.width, height: event.height } } : undefined;
  }
}

type Expandable = Component & { setExpanded?(expanded: boolean): void };
type Body = { component?: Expandable; native: boolean; width: number; expanded: boolean; rows: string[] };
type ScreenViewport = TUI & { setLayoutRoot(component: Component | undefined): void };

/** Built-in tool definitions supply Pi's own call and result renderers. Only the renderers are passed on. */
const BUILT_IN_TOOLS: Record<string, keyof typeof PiAgent> = {
  read: 'createReadToolDefinition', bash: 'createBashToolDefinition', edit: 'createEditToolDefinition',
  write: 'createWriteToolDefinition', grep: 'createGrepToolDefinition', find: 'createFindToolDefinition',
  ls: 'createLsToolDefinition', powershell: 'createPowerShellToolDefinition',
};

export interface ThreadTranscriptOptions {
  title: string;
  transcript: Transcript;
  theme: Theme;
  tui: TUI;
  /** Working directory of the saved thread, used by tool renderers to shorten paths. */
  cwd: string;
  done: () => void;
  /** Rows available outside fullscreen takeover. */
  rows?: () => number;
}

/** A read-only transcript of a saved thread, drawn with Pi's own message components. */
export class ThreadTranscript implements Component, Focusable {
  /** Pi 1.5 and later send Page Up, Page Down, and other viewport keys to this component instead of the parent transcript. */
  readonly capturesViewportInput = true;
  private hasFocus = true;
  private screen?: { tui: ScreenViewport; root: TranscriptScreen; previous?: Component };
  private offset = 0;
  private maxOffset = 0;
  private viewportHeight = 1;
  private expanded = true;
  private disposed = false;
  private closed = false;
  private bodies: (Body | undefined)[] = [];
  private renderers = new Map<string, ToolRenderers | undefined>();

  constructor(private options: ThreadTranscriptOptions) {}

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    if (this.hasFocus === value) return;
    this.hasFocus = value;
    this.syncScreen();
    if (!this.disposed) this.options.tui.requestRender();
  }

  /**
   * On Pi's fullscreen renderer, show the transcript as the whole screen while it has keyboard focus.
   * Pi keeps the dialog stack, focus, and the parent draft. When another dialog takes focus, or the
   * transcript closes, the parent layout returns. Returns false when the renderer cannot do this.
   */
  takeOverScreen(tui: TUI): boolean {
    if (this.disposed || !layoutRoot(tui)) return false;
    this.screen = { tui: tui as ScreenViewport, root: new TranscriptScreen(this, width => this.renderView(width, tui.terminal.rows)) };
    this.syncScreen();
    return true;
  }

  get ownsScreen(): boolean { return !!this.screen && layoutRoot(this.screen.tui) === this.screen.root; }

  private syncScreen(): void {
    const screen = this.screen;
    if (!screen) return;
    const current = layoutRoot(screen.tui);
    if (this.hasFocus && !this.disposed) {
      if (current && current !== screen.root) { screen.previous = current; screen.tui.setLayoutRoot(screen.root); }
    } else if (current === screen.root && screen.previous) {
      screen.tui.setLayoutRoot(screen.previous);
      screen.previous = undefined;
    }
  }

  /** The wheel scrolls the transcript. Other mouse events stay with Pi for text selection and copying. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || !this.hasFocus || event.type !== 'wheel' || !event.wheelDelta) return undefined;
    this.scroll(event.wheelDelta);
    return { handled: true };
  }

  private scroll(lines: number): void { this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + lines)); }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+t') || matchesKey(data, 'ctrl+c') || data === 'q') { this.close(); return; }
    const page = Math.max(1, this.viewportHeight - 1);
    if (matchesKey(data, 'up')) this.scroll(-1);
    else if (matchesKey(data, 'down')) this.scroll(1);
    else if (matchesKey(data, 'pageUp')) this.scroll(-page);
    else if (matchesKey(data, 'pageDown') || matchesKey(data, 'space')) this.scroll(page);
    else if (matchesKey(data, 'home')) this.offset = 0;
    else if (matchesKey(data, 'end')) this.offset = this.maxOffset;
    else if (matchesKey(data, 'ctrl+o')) this.expanded = !this.expanded;
    else return;
    this.options.tui.requestRender();
  }

  private toolRenderers(name: string): ToolRenderers | undefined {
    if (this.renderers.has(name)) return this.renderers.get(name);
    let renderers: ToolRenderers | undefined;
    const factory = BUILT_IN_TOOLS[name] && agent[BUILT_IN_TOOLS[name]];
    if (typeof factory === 'function') {
      try {
        const definition = (factory as (cwd: string) => ToolRenderers)(this.options.cwd);
        renderers = { renderShell: definition.renderShell, renderCall: definition.renderCall, renderResult: definition.renderResult };
      } catch { renderers = undefined; }
    }
    this.renderers.set(name, renderers);
    return renderers;
  }

  /** Build Pi's component for a saved message, as Pi does when it reloads a session. */
  private nativeComponent(item: TranscriptItem): Expandable | undefined {
    const markdown = getMarkdownTheme();
    switch (item.kind) {
      case 'user': return agent.UserMessageComponent && new agent.UserMessageComponent(item.text, markdown);
      case 'assistant': return agent.AssistantMessageComponent && new agent.AssistantMessageComponent(item.message, false, markdown);
      case 'tool': {
        if (!agent.ToolExecutionComponent) return undefined;
        const component = new agent.ToolExecutionComponent(item.name, item.id, item.args, { showImages: false },
          this.toolRenderers(item.name), this.options.tui, this.options.cwd);
        if (item.result) component.updateResult(item.result);
        else if (item.interrupted) component.updateResult({ content: [{ type: 'text', text: item.interrupted }], isError: true });
        return component;
      }
      case 'bash': {
        if (!agent.BashExecutionComponent) return undefined;
        const component = new agent.BashExecutionComponent(item.command, this.options.tui, item.excludeFromContext);
        if (item.output) component.appendOutput(item.output);
        component.setComplete(item.exitCode, item.cancelled, item.truncated ? { truncated: true } as never : undefined, item.fullOutputPath);
        return component;
      }
      case 'custom': return agent.CustomMessageComponent && new agent.CustomMessageComponent({ role: 'custom', customType: item.customType,
        content: item.content as never, display: item.display, details: item.details, timestamp: item.timestamp }, undefined, markdown);
      case 'compaction': return agent.CompactionSummaryMessageComponent && new agent.CompactionSummaryMessageComponent({ role: 'compactionSummary',
        summary: item.summary, tokensBefore: item.tokensBefore, timestamp: item.timestamp }, markdown);
      case 'branch': return agent.BranchSummaryMessageComponent && new agent.BranchSummaryMessageComponent({ role: 'branchSummary',
        summary: item.summary, fromId: item.fromId, timestamp: item.timestamp }, markdown);
      case 'other': return undefined;
    }
  }

  /** Plain rendering for messages without a Pi component, or when a component fails on this Pi version. */
  private fallback(item: TranscriptItem, width: number): string[] {
    const { theme } = this.options;
    const inner = Math.max(1, width - 4);
    let label: string, body: string, markdown = true, color: 'accent' | 'userMessageText' | 'success' | 'error' | 'muted' = 'muted';
    switch (item.kind) {
      case 'user': label = 'User'; body = item.text; color = 'userMessageText'; break;
      case 'assistant': {
        label = 'Assistant'; color = 'accent';
        body = item.message.content.map(block => block.type === 'text' ? block.text
          : block.type === 'thinking' ? `_Thinking_\n\n${block.thinking}` : '').filter(Boolean).join('\n\n');
        if (item.message.errorMessage) body += `\n\n${item.message.errorMessage}`;
        break;
      }
      case 'tool': {
        const failed = item.result?.isError || (!item.result && item.interrupted);
        label = `${failed ? '✗' : '✓'} ${item.name}`; color = failed ? 'error' : 'success'; markdown = false;
        body = [JSON.stringify(item.args, null, 2), item.result ? contentText(item.result.content) : item.interrupted ?? ''].filter(Boolean).join('\n\n');
        break;
      }
      case 'bash': label = `$ ${item.command}`; body = item.output; markdown = false; break;
      case 'custom': label = item.customType; body = contentText(item.content); break;
      case 'compaction': label = 'Compaction summary'; body = item.summary; break;
      case 'branch': label = 'Branch summary'; body = item.summary; break;
      case 'other': label = item.label; body = item.text; markdown = false; break;
    }
    const rows = [this.options.theme.fg(color, theme.bold(truncateToWidth(`  ${oneLine(label)}`, width)))];
    if (body) {
      const component = markdown ? new Markdown(body, 0, 0, getMarkdownTheme(), { color: value => theme.fg('text', value) }) : new Text(body, 0, 0);
      rows.push(...component.render(inner).map(line => `  ${line}`));
    }
    return rows;
  }

  private itemRows(index: number, width: number): string[] {
    const item = this.options.transcript.items[index];
    let body = this.bodies[index];
    if (body && body.width === width && body.expanded === this.expanded) return body.rows;
    if (body?.native !== false) {
      try {
        const component = body?.component ?? this.nativeComponent(item);
        if (component) {
          component.setExpanded?.(item.kind === 'compaction' || item.kind === 'branch' || this.expanded);
          body = { component, native: true, width, expanded: this.expanded, rows: component.render(width) };
          this.bodies[index] = body;
          return body.rows;
        }
      } catch { /* Fall back to plain rendering below. */ }
    }
    body = { native: false, width, expanded: this.expanded, rows: this.fallback(item, width) };
    this.bodies[index] = body;
    return body.rows;
  }

  private conversation(width: number): string[] {
    const { items, skipped } = this.options.transcript;
    const lines: string[] = [];
    if (skipped) lines.push(this.options.theme.fg('warning', `  ${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped`), '');
    items.forEach((item, index) => {
      // Pi separates user messages and summaries from the preceding message with one blank row.
      if (index && ['user', 'compaction', 'branch', 'other'].includes(item.kind)) lines.push('');
      lines.push(...this.itemRows(index, width));
    });
    if (!items.length) lines.push(this.options.theme.fg('muted', '  No saved messages.'));
    return lines;
  }

  render(width: number): string[] {
    // While unfocused, render no rows so a dialog above can show. While the transcript owns the
    // fullscreen layout, the layout root draws it instead of the dialog slot.
    if (width < 1 || !this.hasFocus || this.ownsScreen) return [];
    return this.renderView(width, this.options.rows?.() ?? this.options.tui.terminal.rows);
  }

  private renderView(width: number, terminalRows: number): string[] {
    if (width < 1) return [];
    const { theme, transcript } = this.options;
    const rows = Math.max(1, terminalRows);
    const border = theme.fg('borderAccent', '─'.repeat(width));
    const header = theme.bold(theme.fg('text', truncateToWidth(` Transcript · ${oneLine(this.options.title)}`, width)));
    const meta = theme.fg('muted', truncateToWidth(` ${transcript.messages} saved message${transcript.messages === 1 ? '' : 's'} · read-only`, width));
    const hints = theme.fg('muted', truncateToWidth(` ${this.screen ? 'Wheel/' : ''}↑↓ scroll · PgUp/PgDn page · Home/End · Ctrl+O ${this.expanded ? 'collapse' : 'expand'} tools · Esc back`, width));
    const footer = [border, hints].slice(-Math.max(1, rows - 1));
    const top = [header, meta, border].slice(0, Math.max(0, rows - footer.length - 1));
    const height = Math.max(0, rows - top.length - footer.length);
    const body = this.conversation(width);
    this.viewportHeight = height;
    this.maxOffset = Math.max(0, body.length - height);
    this.offset = Math.min(this.offset, this.maxOffset);
    const content = body.slice(this.offset, this.offset + height);
    while (content.length < height) content.push('');
    return [...top, ...content, ...footer].slice(0, rows).map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
  }

  invalidate(): void {
    for (const body of this.bodies) body?.component?.invalidate?.();
    this.bodies = this.bodies.map(body => body && { ...body, width: -1 });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncScreen();
  }
}

type Hosted = Component & Partial<Focusable> & { dispose?(): void };

/**
 * Shows the transcript in place of the picker in the same dialog slot. Pi 1.3 restores the editor,
 * not the picker, when a nested inline dialog closes, so the inline fallback swaps components here.
 */
export class TranscriptHost implements Component, Focusable {
  private view?: ThreadTranscript;
  private closeView?: () => void;
  private hasFocus = false;
  private disposed = false;
  constructor(readonly base: Hosted, private requestRender: () => void) {}

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    const active: Hosted = this.view ?? this.base;
    if ('focused' in active) active.focused = value;
  }
  get capturesViewportInput(): boolean { return !!this.view; }
  get showingTranscript(): boolean { return !!this.view; }

  /** Show a transcript until it closes. The picker keeps its state underneath. */
  open(create: (close: () => void) => ThreadTranscript): Promise<void> {
    if (this.view || this.disposed) return Promise.resolve();
    return new Promise(resolve => {
      let view: ThreadTranscript | undefined;
      const close = () => {
        if (!view || this.view !== view) return;
        this.view = undefined;
        this.closeView = undefined;
        view.dispose();
        if (!this.disposed) {
          if ('focused' in this.base) this.base.focused = this.hasFocus;
          this.requestRender();
        }
        resolve();
      };
      view = create(close);
      this.view = view;
      this.closeView = close;
      if ('focused' in this.base) this.base.focused = false;
      view.focused = this.hasFocus;
      this.requestRender();
    });
  }

  handleInput(data: string): void { (this.view ?? this.base).handleInput?.(data); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.view ? this.view.handleMouse(event) : this.base.handleMouse?.(event);
  }
  render(width: number): string[] { return (this.view ?? this.base).render(width); }
  invalidate(): void { this.base.invalidate?.(); this.view?.invalidate(); }
  dispose(): void {
    this.disposed = true;
    this.closeView?.();
    this.base.dispose?.();
  }
}
