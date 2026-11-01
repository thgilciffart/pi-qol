import { test, expect } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import metrics, { calculateMetrics, formatMetrics, METRICS_ENTRY } from '../src/metrics.ts';

function harness() {
  const handlers = new Map<string, Function>();
  const manager = SessionManager.inMemory();
  const rows: any[] = [];
  const statuses: any[] = [];
  const ctx = { hasUI: true, sessionManager: manager, ui: {
    theme: { fg: (_: string, value: string) => value },
    setStatus: (_: string, value: string) => statuses.push(value),
  } };
  metrics({ on: (name: string, fn: Function) => handlers.set(name, fn), registerEntryRenderer: () => {},
    appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); rows.push(data); },
  } as any);
  return { manager, rows, statuses, fire: (name: string, event = {}) => handlers.get(name)!(event, ctx) };
}
const message = { role: 'assistant', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, durationMs: 2000 };

test('rate excludes first-token latency and missing timing remains unknown', () => {
  expect(calculateMetrics(10, 20, 2500, 500).tps).toBe(10);
  expect(calculateMetrics(10, 20, 0, 0).tps).toBeUndefined();
  expect(calculateMetrics(10, 20, 2500).tps).toBeUndefined();
  expect(formatMetrics(calculateMetrics(10, 20, 2500, 500))).toBe('30 tokens (10 in / 20 out) · 10.0 tok/s · TTFT 0.50s');
});

test('records each completed turn once and excludes stats from model context', () => {
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
  expect(h.rows[0]).toMatchObject({ input: 80, output: 20, messageEntryId: 'assistant-id' });
  expect(h.rows[0].ttftMs).toBeNumber();
  expect(h.manager.buildSessionContext().messages).toEqual([]);
  expect(h.manager.getEntries()[0]).toMatchObject({ type: 'custom', customType: METRICS_ENTRY });
  h.fire('session_start');
  expect(h.statuses.at(-1)).toContain('100 tokens');
});

test('empty deltas do not establish TTFT and aborted responses still get a row', () => {
  const h = harness();
  h.fire('message_start', { message });
  h.fire('message_update', { message, assistantMessageEvent: { type: 'thinking_delta', delta: '' } });
  h.fire('message_end', { message });
  h.fire('agent_end');
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0].ttftMs).toBeUndefined();
  expect(h.rows[0].tps).toBeUndefined();
});
