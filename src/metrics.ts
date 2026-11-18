import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TruncatedText } from '@earendil-works/pi-tui';
import { defaultMetricsConfig, loadMetricsConfig, type MetricsConfig } from './metrics/config.ts';
import { MetricsEditor } from './metrics/editor.ts';
import { errorMessage, writeJsonAtomic } from './shared.ts';
import { sanitizeInline } from './status-line/sanitize.ts';

export const METRICS_ENTRY = 'pi-qol-metrics';
export interface ResponseMetrics {
  input?: number;
  cost?: number;
  output: number;
  ttftMs?: number;
  durationMs: number;
  tps?: number;
  model?: string;
  messageEntryId?: string;
}

export function calculateMetrics(input: number, output: number, durationMs: number, ttftMs?: number): ResponseMetrics {
  const generationMs = ttftMs === undefined ? undefined : durationMs - ttftMs;
  return {
    input, output, durationMs, ttftMs,
    tps: generationMs !== undefined && generationMs > 0 && output > 0 ? output * 1000 / generationMs : undefined,
  };
}

const DEFAULT_CONFIG = defaultMetricsConfig();

export function formatMetrics(stats: ResponseMetrics, config: MetricsConfig = DEFAULT_CONFIG): string {
  const tps = stats.tps === undefined ? 'n/a' : stats.tps.toFixed(1);
  const ttft = stats.ttftMs === undefined ? 'n/a' : `${(stats.ttftMs / 1000).toFixed(2)}s`;
  const cost = stats.cost !== undefined && Number.isFinite(stats.cost) && stats.cost >= 0 ? `$${stats.cost.toFixed(4)}` : 'n/a';
  const model = typeof stats.model === 'string' ? sanitizeInline(stats.model, false) : '';
  const values = {
    input: `↑${stats.input ?? 'n/a'}`,
    output: `↓${stats.output}`,
    tps: `${tps} tok/s`,
    ttft: `TTFT ${ttft}`,
    cost,
    model: model || 'n/a',
  };
  return config.items.filter(item => item.enabled).map(item => values[item.id])
    .join(config.separator.enabled ? ` ${config.separator.text} ` : ' ');
}

function isReply(message: { role: string; content?: unknown; stopReason?: string }): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.stopReason !== 'toolUse' && !message.content.some(block => block.type === 'toolCall') &&
    message.content.some(block => block.type === 'text' && block.text.trim().length > 0);
}

export default function metrics(pi: ExtensionAPI, options: { configPath?: string } = {}): void {
  const configPath = options.configPath ?? join(getAgentDir(), 'pi-qol', 'metrics.json');
  let config = DEFAULT_CONFIG;
  let loadError: string | undefined;
  // Pi can build transcript components before it emits session_start on reload.
  try { config = loadMetricsConfig(configPath); }
  catch (error) { loadError = errorMessage(error); }
  let started: number | undefined;
  let first: number | undefined;
  let pending: ResponseMetrics | undefined;
  let session: ExtensionContext['sessionManager'] | undefined;

  function resolveStats(stats: ResponseMetrics): ResponseMetrics | undefined {
    // Hide old statistics attached to tool-call messages when sessions are resumed.
    if (stats.messageEntryId && session) {
      const source = session.getEntry(stats.messageEntryId);
      if (source?.type !== 'message' || !isReply(source.message)) return undefined;
      if (source.message.role === 'assistant') {
        const usage = source.message.usage;
        return {
          ...stats,
          input: stats.input ?? usage.input + usage.cacheRead + usage.cacheWrite,
          cost: stats.cost ?? usage.cost?.total,
          model: stats.model ?? source.message.model,
        };
      }
    }
    return stats;
  }

  pi.registerEntryRenderer<ResponseMetrics>(METRICS_ENTRY, (entry, _options, theme) => {
    if (!entry.data || !config.items.some(item => item.enabled)) return undefined;
    const data = entry.data;
    const text = () => {
      const stats = resolveStats(data);
      return stats && new TruncatedText(theme.fg('dim', formatMetrics(stats, config)));
    };
    if (session || !data.messageEntryId) return text();
    // Wait for the session context when the host creates the row before session_start.
    return { invalidate() {}, render: width => text()?.render(width) ?? [] };
  });

  pi.registerCommand('metrics', {
    description: 'Configure response metrics, their order, and the separator',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify(`The response metrics editor needs the terminal UI. Settings file: ${configPath}`, 'info');
        return;
      }
      try {
        const draft = loadMetricsConfig(configPath);
        const initial = JSON.stringify(draft);
        const sample = { ...calculateMetrics(6080, 26, 2000, 500), cost: 0.0001, model: 'example-model' };
        const next = await ctx.ui.custom<MetricsConfig | undefined>((tui, theme, _keys, done) =>
          new MetricsEditor(tui, theme, draft, settings => formatMetrics(sample, settings), done));
        if (!next || JSON.stringify(next) === initial) return;
        if (JSON.stringify(loadMetricsConfig(configPath)) !== initial) {
          throw new Error('Settings changed while the editor was open. Open /metrics again to edit the latest settings.');
        }
        await writeJsonAtomic(configPath, next);
        config = next;
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify('Response metrics saved. Run /reload when Pi is idle to update the transcript.', 'info');
          return;
        }
        ctx.ui.notify('Response metrics saved.', 'info');
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(`Response metrics: ${errorMessage(error)}`, 'error');
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    session = ctx.sessionManager;
    started = first = pending = undefined;
    if (ctx.hasUI) {
      ctx.ui.setStatus(METRICS_ENTRY, undefined);
      if (loadError) ctx.ui.notify(`Response metrics settings at ${configPath}: ${loadError} Using defaults.`, 'warning');
    }
  });
  pi.on('before_provider_request', () => {
    started = performance.now();
    first = undefined;
  });
  pi.on('message_start', (event) => {
    if (event.message.role !== 'assistant') return;
    started ??= performance.now();
    first = undefined;
    pending = undefined;
  });
  pi.on('message_update', (event) => {
    if (event.message.role !== 'assistant' || started === undefined || first !== undefined) return;
    const update = event.assistantMessageEvent;
    if ((update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta') && update.delta.length > 0) {
      first = performance.now();
    }
  });
  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return;
    const message = event.message;
    const duration = started === undefined ? message.durationMs ?? 0 : performance.now() - started;
    pending = isReply(message) ? calculateMetrics(message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, message.usage.output, duration,
      started !== undefined && first !== undefined ? first - started : undefined) : undefined;
    if (pending) {
      pending.cost = message.usage.cost?.total;
      pending.model = message.model;
    }
    started = first = undefined;
  });
  // Final replies have no tool results. Append after Pi persists the assistant message.
  pi.on('turn_end', (event) => {
    if (!pending) return;
    pi.appendEntry(METRICS_ENTRY, { ...pending, messageEntryId: event.messageEntryId });
    pending = undefined;
  });
  pi.on('agent_end', () => {
    if (pending) pi.appendEntry(METRICS_ENTRY, pending);
    pending = undefined;
    started = first = undefined;
  });
}
