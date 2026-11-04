import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import {
  extensionKey, isSeparator, resolveItems, type BuiltinModuleId, type ColorMode, type Row, type Side, type StatusLineConfig,
} from './config.ts';
import { sanitizeInline } from './sanitize.ts';

export { sanitizeInline };

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache-read share of the latest assistant prompt, as a percentage. */
  cacheHitRate?: number;
}

/** Everything the footer shows, read from public Pi APIs. */
export interface StatusSnapshot {
  model?: { id: string; provider: string; reasoning: boolean };
  providerCount: number;
  thinkingLevel?: string;
  cwd: string;
  home?: string;
  gitBranch: string | null;
  sessionName?: string;
  idle: boolean;
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  usage: UsageSummary;
  subscription: boolean;
  extensionStatuses: ReadonlyMap<string, string>;
}

export function formatTokens(count: number): string {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === '' ? '~' : `~${sep}${rel}`;
}

/** Keep the end of a long path, which is usually the useful part. */
function shortenPath(path: string, max: number): string {
  if (visibleWidth(path) <= max) return path;
  const chars = [...path];
  let tail = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = chars[i] + tail;
    if (visibleWidth(next) > max - 1) break;
    tail = next;
  }
  return `…${tail}`;
}

type Role = 'label' | 'separator' | 'model' | 'provider' | 'cwd' | 'git' | 'session' | 'ready' | 'working'
  | 'ok' | 'warn' | 'error' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost';

const COLORFUL: Record<Role, ThemeColor> = {
  label: 'muted', separator: 'borderMuted', model: 'accent', provider: 'muted', cwd: 'syntaxString',
  git: 'syntaxFunction', session: 'mdHeading', ready: 'success', working: 'warning', ok: 'success',
  warn: 'warning', error: 'error', input: 'syntaxNumber', output: 'syntaxKeyword', cacheRead: 'syntaxType',
  cacheWrite: 'syntaxVariable', cost: 'mdLink',
};

const THEMED: Record<Role, ThemeColor> = {
  label: 'muted', separator: 'borderMuted', model: 'accent', provider: 'muted', cwd: 'text', git: 'muted',
  session: 'text', ready: 'success', working: 'warning', ok: 'text', warn: 'warning', error: 'error',
  input: 'text', output: 'text', cacheRead: 'muted', cacheWrite: 'muted', cost: 'text',
};

const THINKING_COLORS: Record<string, ThemeColor> = {
  off: 'thinkingOff', minimal: 'thinkingMinimal', low: 'thinkingLow', medium: 'thinkingMedium',
  high: 'thinkingHigh', xhigh: 'thinkingXhigh', max: 'thinkingMax',
};

export interface Painter {
  mode: ColorMode;
  paint(role: Role, text: string): string;
  token(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

export function createPainter(theme: Theme, mode: ColorMode): Painter {
  if (mode === 'mono') {
    return { mode, paint: (_role, text) => text, token: (_color, text) => text, bold: text => text };
  }
  const palette = mode === 'colorful' ? COLORFUL : THEMED;
  const token = (color: ThemeColor, text: string): string => {
    try { return theme.fg(color, text); } catch { return text; }
  };
  return { mode, token, paint: (role, text) => token(palette[role], text), bold: text => theme.bold(text) };
}

type ModuleRenderer = (data: StatusSnapshot, p: Painter) => string | undefined;

const MODULES: Record<BuiltinModuleId, ModuleRenderer> = {
  state: (data, p) => data.idle ? p.paint('ready', '● ready') : p.bold(p.paint('working', '◉ working')),
  model: (data, p) => {
    if (!data.model) return p.paint('label', 'no model');
    const id = p.bold(p.paint('model', sanitizeInline(data.model.id, false)));
    return data.providerCount > 1 ? `${p.paint('provider', sanitizeInline(data.model.provider, false) + '/')}${id}` : id;
  },
  thinking: (data, p) => {
    if (!data.model?.reasoning) return undefined;
    const level = data.thinkingLevel || 'off';
    return p.mode === 'colorful' ? p.token(THINKING_COLORS[level] ?? 'thinkingText', level) : p.paint('ok', level);
  },
  cwd: (data, p) => {
    const path = sanitizeInline(formatCwd(data.cwd, data.home), false);
    return path ? p.paint('cwd', shortenPath(path, 48)) : undefined;
  },
  git: (data, p) => {
    const branch = data.gitBranch ? sanitizeInline(data.gitBranch, false) : '';
    return branch ? `${p.paint('label', '⎇')} ${p.paint('git', branch)}` : undefined;
  },
  session: (data, p) => {
    const name = data.sessionName ? sanitizeInline(data.sessionName, false) : '';
    return name ? p.paint('session', `“${[...name].slice(0, 60).join('')}”`) : undefined;
  },
  context: (data, p) => {
    const context = data.context;
    if (!context || !(context.contextWindow > 0)) return undefined;
    const window = formatTokens(context.contextWindow);
    if (context.percent === null) return `${p.paint('label', 'ctx')} ${p.paint('ok', '?')}${p.paint('label', `/${window}`)}`;
    const used = Math.max(0, Math.min(100, context.percent));
    const role: Role = used > 90 ? 'error' : used > 70 ? 'warn' : 'ok';
    const left = `${Math.round(100 - used)}% left`;
    return `${p.paint('label', 'ctx')} ${p.paint(role, left)} ${p.paint('label', `of ${window}`)}`;
  },
  tokens: (data, p) => {
    const parts: string[] = [];
    if (data.usage.input) parts.push(p.paint('input', `↑${formatTokens(data.usage.input)}`));
    if (data.usage.output) parts.push(p.paint('output', `↓${formatTokens(data.usage.output)}`));
    return parts.length ? parts.join(' ') : undefined;
  },
  cache: (data, p) => {
    const { cacheRead, cacheWrite, cacheHitRate } = data.usage;
    if (!cacheRead && !cacheWrite) return undefined;
    const parts = [p.paint('label', 'cache')];
    if (cacheRead) parts.push(p.paint('cacheRead', `R${formatTokens(cacheRead)}`));
    if (cacheWrite) parts.push(p.paint('cacheWrite', `W${formatTokens(cacheWrite)}`));
    if (cacheHitRate !== undefined) parts.push(p.paint('label', `${cacheHitRate.toFixed(0)}% hit`));
    return parts.join(' ');
  },
  cost: (data, p) => {
    if (!data.usage.cost && !data.subscription) return undefined;
    const cost = p.paint('cost', `$${data.usage.cost.toFixed(3)}`);
    return data.subscription ? `${cost} ${p.paint('label', '(sub)')}` : cost;
  },
};

const ITEM_GAP = '  ';
const MAX_LINES_PER_ROW = 2;

export interface RenderedSegment { id: string; text: string; side: Side }

/** Rendered text of each enabled module, grouped by row, in configured order. */
export function renderSegments(data: StatusSnapshot, config: StatusLineConfig, theme: Theme): Map<Row, RenderedSegment[]> {
  const painter = createPainter(theme, config.colorMode);
  const rows = new Map<Row, RenderedSegment[]>([[1, []], [2, []]]);
  for (const item of resolveItems(config, data.extensionStatuses.keys())) {
    if (!item.enabled) continue;
    const key = extensionKey(item.id);
    let text: string | undefined;
    if (isSeparator(item.id)) {
      text = painter.paint('separator', '·');
    } else if (key !== undefined) {
      const raw = data.extensionStatuses.get(key);
      text = raw === undefined ? undefined : sanitizeInline(raw, config.colorMode !== 'mono');
    } else {
      try { text = MODULES[item.id as BuiltinModuleId](data, painter); } catch { text = undefined; }
    }
    if (text && visibleWidth(text) > 0) rows.get(item.row)!.push({ id: item.id, text, side: item.side ?? 'left' });
  }
  return rows;
}

/** Separators decorate the gap before the next module, never a line boundary. */
function contentSegments(segments: RenderedSegment[], gap: string): { text: string; prefix: string }[] {
  const content: { text: string; prefix: string }[] = [];
  let prefix = '';
  for (const segment of segments) {
    if (isSeparator(segment.id)) {
      if (content.length) prefix += (prefix ? gap : '') + segment.text;
    } else {
      content.push({ text: segment.text, prefix });
      prefix = '';
    }
  }
  return content;
}

function packRow(segments: RenderedSegment[], width: number, separator: string, more: (count: number) => string,
  maxLines = MAX_LINES_PER_ROW, nextLineWidth = width): string[] {
  const lines: string[] = [];
  const content = contentSegments(segments, separator);
  let line = '';
  let lineWidth = 0;
  let lineLimit = width;
  const fit = (text: string) => visibleWidth(text) > lineLimit ? truncateToWidth(text, lineLimit, '…') : text;
  let index = 0;
  for (; index < content.length; index++) {
    const segment = content[index]!;
    const between = separator + (segment.prefix ? segment.prefix + separator : '');
    let text = fit(segment.text);
    let textWidth = visibleWidth(text);
    if (line && lineWidth + visibleWidth(between) + textWidth <= lineLimit) {
      line += between + text;
      lineWidth += visibleWidth(between) + textWidth;
      continue;
    }
    if (line) {
      if (lines.length + 1 >= maxLines) break;
      lines.push(line);
      lineLimit = nextLineWidth;
      text = fit(segment.text);
      textWidth = visibleWidth(text);
    }
    line = text;
    lineWidth = textWidth;
  }
  const remaining = content.length - index;
  if (remaining > 0) {
    const marker = more(remaining);
    const markerWidth = visibleWidth(marker) + 1;
    line = lineWidth + markerWidth <= lineLimit ? `${line} ${marker}` : `${truncateToWidth(line, Math.max(0, lineLimit - markerWidth), '…')} ${marker}`;
  }
  if (line) lines.push(line);
  return lines.map((line, index) => {
    const limit = index === 0 ? width : nextLineWidth;
    return visibleWidth(line) > limit ? truncateToWidth(line, limit, '') : line;
  });
}

/** Keep each side in configured order and anchor the right group to the terminal edge. */
function alignRow(segments: RenderedSegment[], width: number, separator: string, more: (count: number) => string): string[] {
  const populated = (side: Side) => {
    const group = segments.filter(segment => segment.side === side);
    return group.some(segment => !isSeparator(segment.id)) ? group : [];
  };
  const left = populated('left');
  const right = populated('right');
  const alignRight = (line: string) => ' '.repeat(Math.max(0, width - visibleWidth(line))) + line;
  if (!right.length) return packRow(left, width, separator, more);
  if (!left.length) return packRow(right, width, separator, more).map(alignRight);
  // A one-column terminal cannot fit both sides on one line.
  if (width === 1) return [...packRow(left, width, separator, more, 1), ...packRow(right, width, separator, more, 1)];

  const gap = Math.min(2, width - 2);
  const available = width - gap;
  const needed = (group: RenderedSegment[]) => visibleWidth(contentSegments(group, separator)
    .map(segment => (segment.prefix ? segment.prefix + separator : '') + segment.text).join(separator));
  const leftWidth = Math.min(needed(left), Math.max(1, available - Math.min(needed(right), Math.floor(available / 2))));
  const rightWidth = available - leftWidth;
  let leftLines = packRow(left, leftWidth, separator, more);
  let rightLines = packRow(right, rightWidth, separator, more);
  if (rightLines.length === 1 && leftLines.length > 1) {
    leftLines = packRow(left, leftWidth, separator, more, MAX_LINES_PER_ROW, width);
  } else if (leftLines.length === 1 && rightLines.length > 1) {
    rightLines = packRow(right, rightWidth, separator, more, MAX_LINES_PER_ROW, width);
  }
  return Array.from({ length: Math.max(leftLines.length, rightLines.length) }, (_, index) => {
    const l = leftLines[index] ?? '';
    const r = rightLines[index] ?? '';
    return r ? l + ' '.repeat(Math.max(0, width - visibleWidth(l) - visibleWidth(r))) + r : l;
  });
}

/** Render footer lines. Every line fits `width`; each configured row wraps to at most two lines. */
export function renderStatusLine(data: StatusSnapshot, config: StatusLineConfig, theme: Theme, width: number): string[] {
  if (width <= 0) return [];
  const painter = createPainter(theme, config.colorMode);
  const separator = ITEM_GAP;
  const more = (count: number) => painter.paint('label', `+${count}`);
  const lines: string[] = [];
  for (const segments of renderSegments(data, config, theme).values()) {
    if (segments.length) lines.push(...alignRow(segments, width, separator, more));
  }
  return lines.map(line => {
    const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, '') : line;
    return config.colorMode === 'mono' ? stripTerminalSequences(fitted) : fitted;
  });
}

/** Representative data for the editor preview when the live session has little to show. */
export function sampleSnapshot(extensionStatuses: ReadonlyMap<string, string> = new Map()): StatusSnapshot {
  return {
    model: { id: 'claude-sonnet-4-5', provider: 'anthropic', reasoning: true },
    providerCount: 2,
    thinkingLevel: 'high',
    cwd: '/home/you/projects/app',
    home: '/home/you',
    gitBranch: 'main',
    sessionName: 'Refactor footer',
    idle: true,
    context: { tokens: 48000, contextWindow: 200000, percent: 24 },
    usage: { input: 128400, output: 9200, cacheRead: 1250000, cacheWrite: 32000, cost: 0.412, cacheHitRate: 91 },
    subscription: false,
    extensionStatuses,
  };
}
