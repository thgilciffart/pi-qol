import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

export const METRICS_ENTRY = 'pi-qol-metrics';
export interface ResponseMetrics {
  input: number;
  output: number;
  ttftMs?: number;
  durationMs: number;
  tps?: number;
  messageEntryId?: string;
}

export function calculateMetrics(input: number, output: number, durationMs: number, ttftMs?: number): ResponseMetrics {
  const generationMs = ttftMs === undefined ? undefined : durationMs - ttftMs;
  return {
    input, output, durationMs, ttftMs,
    tps: generationMs !== undefined && generationMs > 0 && output > 0 ? output * 1000 / generationMs : undefined,
  };
}

export function formatMetrics(stats: ResponseMetrics): string {
  const tps = stats.tps === undefined ? 'n/a' : stats.tps.toFixed(1);
  const ttft = stats.ttftMs === undefined ? 'n/a' : `${(stats.ttftMs / 1000).toFixed(2)}s`;
  return `${stats.input + stats.output} tokens (${stats.input} in / ${stats.output} out) · ${tps} tok/s · TTFT ${ttft}`;
}

export default function metrics(pi: ExtensionAPI): void {
  let started: number | undefined;
  let first: number | undefined;
  let pending: ResponseMetrics | undefined;
  const status = (ctx: ExtensionContext, text?: string) => {
    if (ctx.hasUI) ctx.ui.setStatus(METRICS_ENTRY, text ? ctx.ui.theme.fg('dim', text) : undefined);
  };

  pi.registerEntryRenderer<ResponseMetrics>(METRICS_ENTRY, (entry, _options, theme) =>
    new Text(theme.fg('dim', formatMetrics(entry.data!)), 0, 0));

  pi.on('session_start', (_event, ctx) => {
    started = first = pending = undefined;
    const last = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === METRICS_ENTRY);
    status(ctx, last?.type === 'custom' ? formatMetrics(last.data as ResponseMetrics) : undefined);
  });
  pi.on('before_provider_request', (_event, ctx) => {
    started = performance.now();
    first = undefined;
    status(ctx, 'Waiting for first token…');
  });
  pi.on('message_start', (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    started ??= performance.now();
    first = undefined;
    status(ctx, 'Waiting for first token…');
  });
  pi.on('message_update', (event, ctx) => {
    if (event.message.role !== 'assistant' || started === undefined || first !== undefined) return;
    const update = event.assistantMessageEvent;
    if ((update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta') && update.delta.length > 0) {
      first = performance.now();
      status(ctx, `TTFT ${((first - started) / 1000).toFixed(2)}s · streaming`);
    }
  });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    const message = event.message;
    const end = performance.now();
    const duration = started === undefined ? message.durationMs ?? 0 : end - started;
    const usage = message.usage;
    pending = calculateMetrics(usage.input + usage.cacheRead + usage.cacheWrite, usage.output, duration,
      started !== undefined && first !== undefined ? first - started : undefined);
    status(ctx, formatMetrics(pending));
    started = first = undefined;
  });
  // turn_end runs after the assistant and tool results have entered the session tree.
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
  pi.on('session_shutdown', (_event, ctx) => status(ctx));
}
