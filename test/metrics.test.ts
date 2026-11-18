import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import metrics, { calculateMetrics, formatMetrics, METRICS_ENTRY } from '../src/metrics.ts';
import { defaultMetricsConfig, loadMetricsConfig } from '../src/metrics/config.ts';

function harness(configPath = join(tmpdir(), randomUUID(), 'metrics.json')) {
  const handlers = new Map<string, Function>();
  const manager = SessionManager.inMemory();
  const rows: any[] = [];
  const statuses: any[] = [];
  let renderer: Function;
  let command: Function;
  const ctx = { hasUI: true, sessionManager: manager, ui: {
    setStatus: (_: string, value: string) => statuses.push(value),
  } };
  metrics({ on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (_: string, info: { handler: Function }) => { command = info.handler; },
    registerEntryRenderer: (_: string, fn: Function) => { renderer = fn; },
    appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); rows.push(data); },
  } as any, { configPath });
  return { manager, rows, statuses, fire: (name: string, event = {}) => handlers.get(name)!(event, ctx),
    command: (ctx: unknown) => command('', ctx),
    render: (data: any) => renderer({ data }, {}, { fg: (_: string, value: string) => value })?.render(120).map((line: string) => line.trimEnd()) };
}
const message = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }],
  model: 'reply-model', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.012345 } }, durationMs: 2000 };

test('rate excludes first-token latency and displays compact input and output counts', () => {
  expect(calculateMetrics(80, 20, 2500, 500).tps).toBe(10);
  expect(calculateMetrics(80, 20, 0, 0).tps).toBeUndefined();
  expect(calculateMetrics(80, 20, 2500).tps).toBeUndefined();
  expect(formatMetrics(calculateMetrics(80, 20, 2500, 500))).toBe('↑80 ↓20 10.0 tok/s TTFT 0.50s n/a');
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
  expect(h.rows[0]).toMatchObject({ output: 20, model: 'reply-model', messageEntryId: 'assistant-id' });
  expect(h.rows[0].input).toBe(80);
  expect(h.rows[0].cost).toBe(0.012345);
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
  expect(h.render({ input: 7724, output: 164, messageEntryId: replyId })).toEqual(['↑7724 ↓164 n/a tok/s TTFT n/a $0.0123']);
  expect(h.render({ output: 20, messageEntryId: replyId })).toEqual(['↑80 ↓20 n/a tok/s TTFT n/a $0.0123']);
  expect(h.render({ input: 80, output: 20, cost: 0, messageEntryId: replyId })).toEqual(['↑80 ↓20 n/a tok/s TTFT n/a $0.0000']);
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


test('cost displays USD per response, preserving zero and marking missing or invalid values', () => {
  const stats = calculateMetrics(80, 20, 2500, 500);
  expect(formatMetrics({ ...stats, cost: 0.012345 })).toEndWith('$0.0123');
  expect(formatMetrics({ ...stats, cost: 0 })).toEndWith('$0.0000');
  for (const cost of [undefined, NaN, Infinity, -1]) expect(formatMetrics({ ...stats, cost })).toEndWith('n/a');
});

test('metrics editor reorders and toggles stats, sets a separator, and saves the layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-metrics-'));
  try {
    const path = join(dir, 'metrics.json');
    const h = harness(path);
    const notifications: string[] = [];
    let reloaded = false;
    await h.command({
      hasUI: true, mode: 'tui', isIdle: () => true, hasPendingMessages: () => false,
      reload: async () => { reloaded = true; },
      ui: {
        notify: (notice: string) => notifications.push(notice),
        custom: (factory: Function) => new Promise(resolve => {
          const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
          const editor = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, resolve);
          editor.handleInput(' '); // Hide input.
          for (let i = 0; i < 5; i++) editor.handleInput('\x1b[B');
          editor.handleInput(' '); // Show model.
          for (let i = 0; i < 5; i++) editor.handleInput('[');
          for (let i = 0; i < 6; i++) editor.handleInput('\x1b[B');
          editor.handleInput(' '); // Enable separator.
          editor.handleInput('e');
          editor.handleInput('\x04');
          editor.handleInput('·');
          editor.handleInput('\r');
          expect(editor.render(100)[1]).toBe(' example-model · ↓26 · 17.3 tok/s · TTFT 0.50s · $0.0001');
          editor.handleInput('\r');
        }),
      },
    });
    expect(notifications).toEqual(['Response metrics saved.']);
    expect(reloaded).toBe(true);
    expect(loadMetricsConfig(path).separator).toEqual({ enabled: true, text: '·' });

    const resumed = harness(path);
    const reply = resumed.manager.appendMessage(message as any);
    resumed.fire('session_start');
    expect(resumed.render({ output: 20, messageEntryId: reply }))
      .toEqual(['reply-model · ↓20 · n/a tok/s · TTFT n/a · $0.0123']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an all-disabled layout hides the transcript row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-metrics-'));
  try {
    const path = join(dir, 'metrics.json');
    const config = defaultMetricsConfig();
    for (const item of config.items) item.enabled = false;
    await writeFile(path, JSON.stringify(config));
    expect(harness(path).render({ output: 20 })).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
