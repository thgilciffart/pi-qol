import { test, expect } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import metrics, { calculateMetrics, formatMetrics, METRICS_ENTRY } from '../src/metrics.ts';

function harness() {
  const handlers = new Map<string, Function>();
  const manager = SessionManager.inMemory();
  const rows: any[] = [];
  const statuses: any[] = [];
  let renderer: Function;
  const ctx = { hasUI: true, sessionManager: manager, ui: {
    setStatus: (_: string, value: string) => statuses.push(value),
  } };
  metrics({ on: (name: string, fn: Function) => handlers.set(name, fn),
    registerEntryRenderer: (_: string, fn: Function) => { renderer = fn; },
    appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); rows.push(data); },
  } as any);
  return { manager, rows, statuses, fire: (name: string, event = {}) => handlers.get(name)!(event, ctx),
    render: (data: any) => renderer({ data }, {}, { fg: (_: string, value: string) => value })?.render(120).map((line: string) => line.trimEnd()) };
}
const message = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }],
  usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, durationMs: 2000 };

test('rate excludes first-token latency and displays separate input and output counts without dot separators', () => {
  expect(calculateMetrics(80, 20, 2500, 500).tps).toBe(10);
  expect(calculateMetrics(80, 20, 0, 0).tps).toBeUndefined();
  expect(calculateMetrics(80, 20, 2500).tps).toBeUndefined();
  expect(formatMetrics(calculateMetrics(80, 20, 2500, 500))).toBe('80 input  20 output  10.0 tok/s  TTFT 0.50s');
});

test('records a final reply once, keeps counts separate and excludes statistics from model context, and never sets a footer', () => {
  const h = harness();
  h.fire('session_start');
  h.fire('before_provider_request');
  h.fire('message_start', { message });
  h.fire('message_update', { message, assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
  h.fire('message_end', { message });
  expect(h.rows.length).toBe(0);
  h.fire('turn_end', { messageEntryId: 'assistant-id' });
  h.fire('agent_end');
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0]).toMatchObject({ output: 20, messageEntryId: 'assistant-id' });
  expect(h.rows[0].input).toBe(80);
  expect(h.rows[0].ttftMs).toBeNumber();
  expect(h.manager.buildSessionContext().messages).toEqual([]);
  expect(h.manager.getEntries()[0]).toMatchObject({ type: 'custom', customType: METRICS_ENTRY });
  h.fire('session_start');
  expect(h.statuses.every(value => value === undefined)).toBe(true);
});

test('tool-call messages and empty replies never produce statistics rows', () => {
  for (const toolMessage of [
    { ...message, stopReason: 'toolUse' },
    { ...message, content: [...message.content, { type: 'toolCall', id: 'tool-id', name: 'bash', arguments: {} }] },
    { ...message, content: [] },
  ]) {
    const h = harness();
    h.fire('message_start', { message: toolMessage });
    h.fire('message_end', { message: toolMessage });
    h.fire('turn_end', { messageEntryId: 'tool-assistant' });
    h.fire('agent_end');
    expect(h.rows).toEqual([]);
  }
});

test('tool turns followed by a final reply produce just one statistics row', () => {
  const h = harness();
  const toolMessage = { ...message, stopReason: 'toolUse' };
  h.fire('message_start', { message: toolMessage });
  h.fire('message_end', { message: toolMessage });
  h.fire('turn_end', { messageEntryId: 'tool-assistant' });
  h.fire('message_start', { message });
  h.fire('message_end', { message });
  h.fire('turn_end', { messageEntryId: 'reply' });
  h.fire('agent_end');
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0].messageEntryId).toBe('reply');
});

test('resumed legacy tool statistics are hidden and final statistics show separate counts', () => {
  const h = harness();
  h.fire('session_start');
  const toolId = h.manager.appendMessage({ ...message, stopReason: 'toolUse' } as any);
  const replyId = h.manager.appendMessage(message as any);
  expect(h.render({ input: 7500, output: 56, messageEntryId: toolId })).toBeUndefined();
  expect(h.render({ input: 7724, output: 164, messageEntryId: replyId })).toEqual(['7724 input  164 output  n/a tok/s  TTFT n/a']);
  expect(h.render({ output: 20, messageEntryId: replyId })).toEqual(['80 input  20 output  n/a tok/s  TTFT n/a']);
});

test('empty deltas do not establish TTFT and aborted text replies still get a row', () => {
  const h = harness();
  h.fire('message_start', { message });
  h.fire('message_update', { message, assistantMessageEvent: { type: 'thinking_delta', delta: '' } });
  h.fire('message_end', { message });
  h.fire('agent_end');
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0].ttftMs).toBeUndefined();
  expect(h.rows[0].tps).toBeUndefined();
});
