import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import goals, { GOAL_ENTRY } from '../src/goal.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve));

async function runtimeFixture(cancel = false) {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const dir = await mkdtemp(join(tmpdir(), 'pi-goal-compaction-'));
  const events: string[] = [];
  const gate = deferred();
  const entered = deferred();
  const compacted = deferred();
  const completed = deferred();
  const requests: any[] = [];
  const errors: string[] = [];
  let compactionRequested = false;
  let summaryPending = false;
  let compactFailure: Error | undefined;
  let settledCount = 0;
  const manager = SessionManager.inMemory(dir);
  function state() {
    const entry = manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === GOAL_ENTRY).at(-1);
    return entry?.type === 'custom' ? entry.data as any : undefined;
  }
  const externalCompactor = (pi: any) => {
    pi.on('agent_settled', (_event: any, ctx: any) => {
      settledCount++;
      events.push('external:settled');
      const usage = ctx.getContextUsage();
      if (state()?.status === 'complete') { completed.resolve(); return; }
      if (compactionRequested || !usage || usage.tokens < 100) return;
      compactionRequested = true;
      events.push('external:request-compaction');
      ctx.compact({
        onComplete: () => { events.push('external:compaction-complete'); compacted.resolve(); },
        onError: (error: Error) => { compactFailure = error; events.push('external:compaction-failed'); compacted.resolve(); },
      });
    });
    pi.on('session_before_compact', async (event: any) => {
      events.push('external:summary-start');
      summaryPending = true;
      entered.resolve();
      await gate.promise;
      summaryPending = false;
      if (cancel) return { cancel: true };
      return { compaction: { summary: 'COMPACTION_FIXTURE: Original goal remains unfinished; continue with the verified result.',
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    });
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 10 }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    extensionFactories: [goals, externalCompactor], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(model => model.provider === 'openai')!;
  modelRuntime.getAuth = async () => ({ auth: { apiKey: 'local-fixture-only' }, env: {} }) as any;
  modelRuntime.hasConfiguredAuth = () => true;
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime,
    settingsManager, resourceLoader, sessionManager: manager, noTools: 'builtin' });
  await session.bindExtensions({ onError: error => { errors.push(error.error); } });
  session.agent.streamFunction = async (_model, context, options) => {
    await options?.onPayload?.({}, model);
    requests.push(context);
    const request = requests.length;
    events.push(`provider:${request}`);
    expect(summaryPending).toBe(false);
    if (request > 4) throw new Error('Unexpected continuation after the goal should finish');
    const content = request === 1
      ? [{ type: 'toolCall', id: 'create', name: 'create_goal', arguments: { objective: 'Finish the compaction fixture task' } }]
      : request === 2
        ? [{ type: 'text', text: 'Verified result. More work remains. '.repeat(100) }]
        : request === 3
          ? [{ type: 'toolCall', id: 'complete', name: 'update_goal', arguments: { status: 'complete' } }]
          : [{ type: 'text', text: 'All fixture requirements are now verified.' }];
    const message: any = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: request === 1 || request === 3 ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  };
  const run = session.prompt('Create a goal to finish the compaction fixture task and keep working.');
  return { session, manager, state, events, requests, errors, gate, entered, compacted, completed, run,
    settledCount: () => settledCount, compactFailure: () => compactFailure,
    cleanup: async () => { gate.resolve(); await session.abort(); session.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

describe('goal continuation and external compaction', () => {
  test('settles for the external threshold hook, waits for its summary, and continues with the active goal', async () => {
    const h = await runtimeFixture();
    try {
      await h.entered.promise;
      expect(h.settledCount()).toBe(1);
      expect(h.requests).toHaveLength(2);
      expect(h.state().status).toBe('active');
      // Let the deferred continuation callback run while the summary is still pending.
      await nextImmediate();
      expect(h.requests).toHaveLength(2);
      h.gate.resolve();
      await h.compacted.promise;
      await h.completed.promise;
      await h.session.waitForIdle();
      await h.run;
      expect(h.requests).toHaveLength(4);
      expect(h.manager.getBranch().some(entry => entry.type === 'compaction')).toBe(true);
      expect(JSON.stringify(h.requests[2])).toContain('COMPACTION_FIXTURE');
      expect(JSON.stringify(h.requests[2])).toContain('Finish the compaction fixture task');
      expect(h.events.indexOf('external:summary-start')).toBeLessThan(h.events.indexOf('provider:3'));
      expect(h.events.indexOf('external:compaction-complete')).toBeLessThan(h.events.indexOf('provider:3'));
      expect(h.state().status).toBe('complete');
      expect(h.errors).toEqual([]);
      expect(h.compactFailure()).toBeUndefined();
    } finally { await h.cleanup(); }
  });

  test('cancelled external compaction pauses the goal without starting another provider request', async () => {
    const h = await runtimeFixture(true);
    try {
      await h.entered.promise;
      await nextImmediate();
      expect(h.requests).toHaveLength(2);
      h.gate.resolve();
      await h.compacted.promise;
      await nextImmediate();
      await h.run;
      expect(h.compactFailure()?.message).toMatch(/cancel/i);
      expect(h.state().status).toBe('paused');
      expect(h.requests).toHaveLength(2);
      expect(h.manager.getBranch().some(entry => entry.type === 'compaction')).toBe(false);
      expect(h.errors).toEqual([]);
    } finally { await h.cleanup(); }
  });
});

function harness() {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: any[] = [];
  let manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', content: 'Original task', timestamp: Date.now() });
  let idle = false;
  let pending = false;
  const ctx: any = { hasUI: false, mode: 'print', get sessionManager() { return manager; },
    isIdle: () => idle, hasPendingMessages: () => pending, abort: () => {}, ui: { notify: () => {}, setStatus: () => {} } };
  goals({ on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data),
    sendMessage: (message: any, options: any) => sent.push({ ...message, options }) } as never);
  const emit = async (type: string, event: any = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const command = (args: string) => commands.get('goal').handler(args, ctx);
  async function state() { return (await tools.get('get_goal').execute('get', {}, undefined, undefined, ctx)).details.goal; }
  async function queue() {
    await command('Finish the original task');
    await emit('before_agent_start', { messageType: 'user', prompt: 'Keep going' });
    await emit('agent_start');
    await emit('tool_execution_end');
    const boundary = await emit('agent_before_settle', { outcome: 'completed', entries: [], continue: false, context: { pendingMessages: [] } });
    expect(boundary?.continue).not.toBe(true);
    idle = true;
    await emit('agent_settled', { aborted: false });
  }
  return { emit, command, state, sent, queue,
    idle: (value: boolean) => { idle = value; }, pending: (value: boolean) => { pending = value; },
    replace: () => { manager = SessionManager.inMemory(); } };
}

describe('pending goal continuation guards', () => {
  test('failed compaction blocks and clears the pending continuation', async () => {
    const h = harness();
    await h.queue();
    await h.emit('session_before_compact');
    await h.emit('session_compact_failed', { aborted: false, errorMessage: 'Summary request failed', willRetry: false });
    await nextImmediate();
    expect((await h.state()).status).toBe('blocked');
    expect(h.sent).toHaveLength(0);
  });

  test('pause and clear invalidate a queued continuation', async () => {
    for (const action of ['pause', 'clear']) {
      const h = harness();
      await h.queue();
      await h.command(action);
      await nextImmediate();
      expect(h.sent).toHaveLength(0);
      expect((await h.state())?.status ?? null).toBe(action === 'pause' ? 'paused' : null);
    }
  });

  test('session replacement invalidates a queued continuation', async () => {
    const h = harness();
    await h.queue();
    await h.emit('session_shutdown', { reason: 'new' });
    h.replace();
    await h.emit('session_start');
    await nextImmediate();
    expect(h.sent).toHaveLength(0);
    expect(await h.state()).toBeNull();
  });

  test('queued user input takes precedence after settlement', async () => {
    const h = harness();
    await h.queue();
    h.pending(true);
    await nextImmediate();
    expect(h.sent).toHaveLength(0);
  });
});
