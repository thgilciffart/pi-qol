import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

export const METRICS_ENTRY = 'pi-qol-metrics';
export interface ResponseMetrics {
  output: number;
  ttftMs?: number;
  durationMs: number;
  tps?: number;
  messageEntryId?: string;
}

export function calculateMetrics(output: number, durationMs: number, ttftMs?: number): ResponseMetrics {
  const generationMs = ttftMs === undefined ? undefined : durationMs - ttftMs;
  return {
    output, durationMs, ttftMs,
    tps: generationMs !== undefined && generationMs > 0 && output > 0 ? output * 1000 / generationMs : undefined,
  };
}

export function formatMetrics(stats: ResponseMetrics): string {
  const tps = stats.tps === undefined ? 'n/a' : stats.tps.toFixed(1);
  const ttft = stats.ttftMs === undefined ? 'n/a' : `${(stats.ttftMs / 1000).toFixed(2)}s`;
  return `${stats.output} tokens · ${tps} tok/s · TTFT ${ttft}`;
}

function isReply(message: { role: string; content?: unknown; stopReason?: string }): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.stopReason !== 'toolUse' && !message.content.some(block => block.type === 'toolCall') &&
    message.content.some(block => block.type === 'text' && block.text.trim().length > 0);
}

export default function metrics(pi: ExtensionAPI): void {
  let started: number | undefined;
  let first: number | undefined;
  let pending: ResponseMetrics | undefined;
  let session: ExtensionContext['sessionManager'] | undefined;

  pi.registerEntryRenderer<ResponseMetrics>(METRICS_ENTRY, (entry, _options, theme) => {
    const stats = entry.data;
    if (!stats) return undefined;
    // Hide old statistics attached to tool-call messages when sessions are resumed.
    if (stats.messageEntryId && session) {
      const source = session.getEntry(stats.messageEntryId);
      if (source?.type !== 'message' || !isReply(source.message)) return undefined;
    }
    return new Text(theme.fg('dim', formatMetrics(stats)), 0, 0);
  });

  pi.on('session_start', (_event, ctx) => {
    session = ctx.sessionManager;
    started = first = pending = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(METRICS_ENTRY, undefined);
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
    pending = isReply(message) ? calculateMetrics(message.usage.output, duration,
      started !== undefined && first !== undefined ? first - started : undefined) : undefined;
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
