import { CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import type { Goal } from './goal.ts';

type EditorFactory = NonNullable<Parameters<ExtensionContext['ui']['setEditorComponent']>[0]>;

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  const [scale, suffix] = value >= 999_500_000_000 ? [1e12, 'T'] : value >= 999_500_000 ? [1e9, 'B'] :
    value >= 999_500 ? [1e6, 'M'] : [1000, 'K'];
  const scaled = value / scale;
  return `${Number(scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0))}${suffix}`;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${minutes % 60}m`;
  return `${hours}h` + (minutes % 60 ? ` ${minutes % 60}m` : '');
}

/** Codex-style composer labels with compact token consumption in every state. */
export function formatGoalIndicator(goal: Goal): string {
  const tokens = `${compactTokens(goal.tokensUsed)} tokens`;
  const usage = goal.tokenBudget === undefined ? tokens : `${compactTokens(goal.tokensUsed)} / ${compactTokens(goal.tokenBudget)} tokens`;
  switch (goal.status) {
    case 'active': return `Pursuing goal (${goal.tokenBudget === undefined ? `${elapsed(goal.timeUsedMs)}, ${tokens}` : usage})`;
    case 'paused': return `Goal paused (${usage}, /goal resume)`;
    case 'blocked': return `Goal stalled (${usage}, /goal resume)`;
    case 'budget_limited': return goal.tokenBudget === undefined ? `Goal abandoned (${tokens})` : `Goal unmet (${usage})`;
    case 'complete': return `Goal achieved (${goal.tokenBudget === undefined ? `${elapsed(goal.timeUsedMs)}, ${tokens}` : tokens})`;
  }
}

/** Preserve the working/scroll labels on the left and use only empty border space. */
export function renderGoalIndicator(rows: string[], width: number, label: string, color: (text: string) => string,
  borderColor: (text: string) => string): string[] {
  if (width <= 0) return rows;
  const first = rows[0] ?? '';
  const trailingBorder = /─+$/.exec(stripTerminalSequences(first))?.[0].length ?? 0;
  const suffixWidth = visibleWidth(label) + 3;
  if (trailingBorder >= suffixWidth && visibleWidth(first) <= width) {
    return [sliceByColumn(first, 0, visibleWidth(first) - suffixWidth) + borderColor(' ') + color(label) + borderColor(' ─'), ...rows.slice(1)];
  }
  // Narrow terminals and editors without a border get a separate, right-aligned row.
  const text = truncateToWidth(label, width);
  return [' '.repeat(Math.max(0, width - visibleWidth(text))) + color(text), ...rows];
}

export function createGoalUI(read: () => { goal: Goal | undefined; running: boolean }) {
  let factory: EditorFactory | undefined;
  let previousFactory: EditorFactory | undefined;
  let tui: TUI | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function update(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== 'tui') return;
    if (!factory) {
      previousFactory = ctx.ui.getEditorComponent();
      factory = (terminal, theme, keybindings) => {
        tui = terminal;
        const editor = previousFactory?.(terminal, theme, keybindings) ??
          new CustomEditor(terminal, theme, keybindings, { embedWorkingStatus: true });
        const render = editor.render.bind(editor);
        editor.render = (width) => {
          const rows = render(width);
          const { goal } = read();
          return goal ? renderGoalIndicator(rows, width, formatGoalIndicator(goal),
            text => ctx.ui.theme.fg('accent', text), editor.borderColor ?? (text => text)) : rows;
        };
        return editor;
      };
      ctx.ui.setEditorComponent(factory);
    }
    const { goal, running } = read();
    if (goal?.status === 'active' && running && !timer) {
      // This only redraws elapsed time. Goal continuation remains event-driven.
      timer = setInterval(() => { if (read().running) tui?.requestRender(); }, 1000);
      timer.unref();
    } else if ((!running || goal?.status !== 'active') && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    tui?.requestRender();
  }

  function dispose(ctx: ExtensionContext): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (factory && ctx.hasUI && ctx.mode === 'tui' && ctx.ui.getEditorComponent() === factory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    factory = previousFactory = undefined;
    tui = undefined;
  }

  return { update, dispose };
}
