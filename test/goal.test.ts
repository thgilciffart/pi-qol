import { describe, expect, test } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import goals, { GOAL_ENTRY, type Goal } from '../src/goal.ts';

function harness(manager = SessionManager.inMemory()) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const notifications: { text: string; type: string }[] = [];
  const sent: any[] = [];
  const statuses: any[] = [];
  let idle = true;
  let pending = false;
  let aborted = false;
  const ctx = {
    hasUI: true, sessionManager: manager,
    isIdle: () => idle, hasPendingMessages: () => pending,
    abort: () => { aborted = true; },
    ui: {
      notify: (text: string, type: string) => notifications.push({ text, type }),
      setStatus: (key: string, text: string) => statuses.push({ key, text }),
      theme: { fg: (_color: string, text: string) => text },
      editor: async () => undefined,
    },
  };
  goals({
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    registerTool: (spec: any) => tools.set(spec.name, spec),
    on: (event: string, handler: any) => handlers.set(event, handler),
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    sendMessage: (message: any, options: any) => sent.push({ ...message, options }),
  } as never);
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const tool = (name: string, args = {}) => tools.get(name).execute('call', args, undefined, undefined, ctx);
  const state = async (): Promise<Goal | null> => (await tool('get_goal')).details.goal;
  async function begin(automatic = false, prompt = 'continue') {
    idle = false;
    await emit('before_agent_start', automatic ? { messageType: 'custom', message: sent.at(-1) } : { messageType: 'user', prompt });
    await emit('agent_start');
  }
  async function settle(options: any = {}) {
    return emit('agent_before_settle', {
      outcome: 'completed', entries: [], continue: false, context: { pendingMessages: [] }, ...options,
    });
  }
  async function handoff() {
    idle = true;
    await emit('agent_settled', { aborted: false });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function usage(input = 10, output = 5, cacheRead = 100, cacheWrite = 3) {
    await emit('before_provider_request');
    await emit('message_end', { message: { role: 'assistant', usage: { input, output, cacheRead, cacheWrite } } });
  }
  return { manager, ctx, commands, tools, notifications, sent, statuses, emit, tool, state, begin, settle, handoff, usage,
    run: (args = '') => commands.get('goal').handler(args, ctx),
    setIdle: (value: boolean) => { idle = value; },
    setPending: (value: boolean) => { pending = value; },
    wasAborted: () => aborted,
  };
}

describe('/goal', () => {
  test('create_goal persists the complete initial state only once', async () => {
    const h = harness();
    await h.tool('create_goal', { objective: 'Finish the task', token_budget: 1000 });
    const entries = h.manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === GOAL_ENTRY);
    expect(entries).toHaveLength(1);
    expect(entries[0].type === 'custom' && entries[0].data).toMatchObject({ objective: 'Finish the task', tokenBudget: 1000, turns: 1 });
  });

  test('starts work with a durable objective and shows status', async () => {
    const h = harness();
    await h.run('Make the checkout tests pass');
    expect(await h.state()).toMatchObject({ objective: 'Make the checkout tests pass', status: 'active', tokensUsed: 0 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].options).toEqual({ triggerTurn: true });
    await h.run();
    expect(h.notifications.at(-1)?.text).toContain('Make the checkout tests pass');
    expect(h.statuses.at(-1)?.text).toBeUndefined();
  });

  test('invalid objectives and budgets preserve the previous goal', async () => {
    const h = harness();
    await h.run('Original');
    const original = await h.state();
    for (const value of ['--tokens 0 test', '--tokens -1 test', '--tokens 1.5 test', '--tokens nope test', '--tokens 10', 'x'.repeat(4001)]) {
      await h.run(value);
      expect(h.notifications.at(-1)?.type).toBe('error');
      expect(await h.state()).toEqual(original);
    }
  });

  test('pause interrupts running work and resume resets the blocked audit', async () => {
    const h = harness();
    await h.run('Fix it');
    await h.begin();
    await h.run('pause');
    expect(h.wasAborted()).toBe(true);
    expect((await h.state())?.status).toBe('paused');
    expect(await h.settle({ outcome: 'aborted' })).toBeUndefined();
    h.setIdle(true);
    await h.run('resume');
    expect(await h.state()).toMatchObject({ status: 'active', turns: 0 });
    expect(h.sent).toHaveLength(2);
  });

  test('editing a paused goal preserves its pause and does not start work', async () => {
    const h = harness();
    await h.run('First');
    await h.run('pause');
    await h.run('edit Second');
    expect(await h.state()).toMatchObject({ objective: 'Second', status: 'paused' });
    expect(h.sent).toHaveLength(1);
  });

  test('user guidance steers an active goal without pausing or interrupting it', async () => {
    const h = harness();
    await h.run('Fix it');
    await h.begin();
    await h.emit('input', { source: 'interactive', text: 'you can use subagents btw', streamingBehavior: 'steer' });
    expect(await h.state()).toMatchObject({ objective: 'Fix it', status: 'active' });
    expect(h.wasAborted()).toBe(false);
    await h.emit('tool_execution_end');
    expect(await h.settle()).toBeUndefined();
    await h.handoff();
    expect(h.sent).toHaveLength(2);
  });

  test('new user guidance can authorize resuming a paused goal without the word resume', async () => {
    const h = harness();
    await h.run('--tokens 100 Fix it');
    await h.begin();
    await h.usage();
    await h.tool('update_goal', { status: 'paused' });
    await expect(h.tool('update_goal', { status: 'active' })).rejects.toThrow('new user message');
    await h.emit('input', { source: 'extension', text: 'keep going' });
    await expect(h.tool('update_goal', { status: 'active' })).rejects.toThrow('new user message');
    await h.begin(false, 'you can use subagents btw');
    await h.tool('update_goal', { status: 'active' });
    expect(await h.state()).toMatchObject({ status: 'active', objective: 'Fix it', tokenBudget: 100, tokensUsed: 18, turns: 1 });
    await expect(h.tool('update_goal', { status: 'blocked' })).rejects.toThrow('three');
    await h.emit('tool_execution_end');
    expect(await h.settle()).toBeUndefined();
    await h.handoff();
    expect(h.sent).toHaveLength(2);
  });

  test('steering input can authorize resuming within an existing run', async () => {
    const h = harness();
    await h.run('Fix it');
    await h.begin();
    await h.tool('update_goal', { status: 'paused' });
    await h.emit('input', { source: 'interactive', text: 'Try the other approach', streamingBehavior: 'steer' });
    await h.tool('update_goal', { status: 'active' });
    expect((await h.state())?.status).toBe('active');
  });

  test('user-authorized tool resume cannot bypass exhausted budgets or completion', async () => {
    const h = harness();
    await h.run('--tokens 100 Fix it');
    await h.begin();
    await h.usage();
    await h.tool('update_goal', { status: 'paused' });
    await h.run('budget 10');
    await h.begin(false, 'keep going');
    await expect(h.tool('update_goal', { status: 'active' })).rejects.toThrow('exhausted');
    await h.run('budget 100');
    await h.tool('update_goal', { status: 'active' });
    await h.tool('update_goal', { status: 'complete' });
    await h.begin(false, 'keep going');
    await expect(h.tool('update_goal', { status: 'active' })).rejects.toThrow('Cannot resume a complete');
  });

  test('clear removes the goal and cancels continuation', async () => {
    const h = harness();
    await h.run('Fix it');
    await h.begin();
    await h.run('clear');
    expect(await h.state()).toBeNull();
    expect(await h.settle()).toBeUndefined();
    expect(h.statuses.at(-1)?.text).toBeUndefined();
    const restored = harness(h.manager);
    await restored.emit('session_start');
    expect(await restored.state()).toBeNull();
  });

  test('queued user messages take priority over starting or continuing a goal', async () => {
    const h = harness();
    h.setPending(true);
    await h.run('Fix it');
    expect(h.sent).toHaveLength(0);
    await h.begin();
    expect(await h.settle()).toBeUndefined();
    h.setPending(false);
    expect(await h.settle({ context: { pendingMessages: [{}] } })).toBeUndefined();
    expect(await h.settle({ continue: true })).toBeUndefined();
  });

  test('counts fresh input, cache writes, and output, excluding cache reads', async () => {
    const h = harness();
    await h.run('--tokens 100 Fix it');
    await h.begin();
    await h.usage();
    expect(await h.state()).toMatchObject({ tokensUsed: 18, tokenBudget: 100 });
    expect((await h.tool('get_goal')).details.remainingTokens).toBe(82);
  });

  test('does not charge requests started before goal creation or after pause', async () => {
    const h = harness();
    await h.emit('before_provider_request');
    await h.run('Fix it');
    await h.emit('message_end', { message: { role: 'assistant', usage: { input: 10, output: 5, cacheWrite: 0 } } });
    await h.run('pause');
    await h.usage();
    expect((await h.state())?.tokensUsed).toBe(0);
  });

  test('budget exhaustion blocks substantive tools and requests exactly one summary', async () => {
    const h = harness();
    await h.run('--tokens 10 Fix it');
    await h.begin(true);
    await h.usage();
    expect((await h.state())?.status).toBe('budget_limited');
    expect((await h.emit('tool_call', { toolName: 'bash' })).block).toBe(true);
    expect(await h.emit('tool_call', { toolName: 'get_goal' })).toBeUndefined();
    const result = await h.settle();
    expect(result).toBeUndefined();
    await h.handoff();
    expect(h.sent.at(-1).content).toContain('Stop substantive work');
    await h.begin(true);
    expect(await h.settle()).toBeUndefined();
    await h.run('pause');
    expect((await h.state())?.status).toBe('budget_limited');
    h.setIdle(true);
    await h.run('resume');
    expect(h.notifications.at(-1)?.type).toBe('error');
    await h.run('budget 100');
    await h.run('resume');
    expect((await h.state())?.status).toBe('active');
  });

  test('an exhausted goal does not block unrelated later user requests', async () => {
    const h = harness();
    await h.run('--tokens 10 Fix it');
    await h.begin(true);
    await h.usage();
    await h.settle();
    await h.begin();
    expect(await h.emit('tool_call', { toolName: 'bash' })).toBeUndefined();
    expect(await h.settle()).toBeUndefined();
  });

  test('budget exhaustion takes precedence when an in-flight response finishes after pause', async () => {
    const h = harness();
    await h.run('--tokens 10 Fix it');
    await h.begin();
    await h.emit('before_provider_request');
    await h.run('pause');
    await h.emit('message_end', { message: { role: 'assistant', usage: { input: 10, output: 5, cacheWrite: 0 } } });
    expect(await h.state()).toMatchObject({ status: 'budget_limited', tokensUsed: 15 });
  });

  test('fully settles before continuing and preserves other extensions boundary entries', async () => {
    const h = harness();
    await h.run('Fix it');
    await h.begin();
    await h.emit('tool_execution_end');
    const prior = { type: 'custom', customType: 'another-extension', data: 123 };
    const entries = [prior];
    expect(await h.settle({ entries })).toBeUndefined();
    expect(entries).toEqual([prior]);
    expect(h.sent).toHaveLength(1);
    await h.handoff();
    expect(h.sent.at(-1).customType).toBe('pi-qol-goal-continuation');
    expect((await h.emit('context', { messages: [] })).messages[0].content).toContain('Fix it');
    await h.begin(true);
    expect((await h.state())?.turns).toBe(2);
    expect(await h.settle()).toBeUndefined();
    await h.handoff();
    expect(h.sent).toHaveLength(3);
    expect(h.sent.at(-1).content).toContain('previous response ended without tool calls');
    expect((await h.emit('context', { messages: [{ role: 'custom', ...h.sent.at(-1) }] })).messages.at(-1).content).toBe(h.sent.at(-1).content);
    expect((await h.state())?.status).toBe('active');
    expect(h.notifications).toEqual([]);
  });

  test('three consecutive automatic turns without tools stall the goal and explicit resume retries it', async () => {
    const h = harness();
    await h.run('Fix it');
    for (let turn = 1; turn <= 3; turn++) {
      await h.begin(true);
      await h.usage();
      await h.settle();
      await h.handoff();
      expect((await h.state())?.status).toBe(turn === 3 ? 'blocked' : 'active');
      expect(h.sent).toHaveLength(Math.min(turn + 1, 3));
    }
    expect(h.notifications.at(-1)?.text).toContain('3 consecutive turns without tool calls');
    await h.run('resume');
    await h.begin(true);
    await h.settle();
    await h.handoff();
    expect((await h.state())?.status).toBe('active');
    expect(h.sent).toHaveLength(5);
  });

  test('tool execution and user steering each reset the no-tool streak', async () => {
    for (const reset of ['tool', 'user'] as const) {
      const h = harness();
      await h.run('Fix it');
      for (let turn = 0; turn < 2; turn++) {
        await h.begin(true);
        await h.settle();
        await h.handoff();
      }
      await h.begin(true);
      if (reset === 'tool') await h.emit('tool_execution_end');
      else await h.emit('input', { source: 'interactive', text: 'Try another approach' });
      await h.settle();
      await h.handoff();
      await h.begin(true);
      await h.settle();
      await h.handoff();
      expect((await h.state())?.status).toBe('active');
      expect(h.sent).toHaveLength(5);
      expect(h.notifications).toEqual([]);
    }
  });

  test('budget exhaustion, completion, and interruption take priority over no-tool recovery', async () => {
    for (const stop of ['budget', 'complete', 'aborted', 'error'] as const) {
      const h = harness();
      await h.run('--tokens 100 Fix it');
      await h.begin(true);
      await h.settle();
      await h.handoff();
      await h.begin(true);
      if (stop === 'budget') await h.usage(100, 0, 0, 0);
      if (stop === 'complete') await h.tool('update_goal', { status: 'complete' });
      await h.settle({ outcome: stop === 'aborted' || stop === 'error' ? stop : 'completed' });
      await h.handoff();
      expect((await h.state())?.status).toBe({ budget: 'budget_limited', complete: 'complete', aborted: 'paused', error: 'blocked' }[stop]);
      expect(h.sent).toHaveLength(stop === 'budget' ? 3 : 2);
      if (stop === 'budget') expect(h.sent.at(-1).content).toContain('token budget');
    }
  });

  test('Escape pauses and provider failure blocks automatic continuation', async () => {
    for (const outcome of ['aborted', 'error']) {
      const h = harness();
      await h.run('Fix it');
      await h.begin();
      expect(await h.settle({ outcome })).toBeUndefined();
      expect((await h.state())?.status).toBe(outcome === 'aborted' ? 'paused' : 'blocked');
    }
    const h = harness();
    await h.run('Fix it');
    await h.emit('agent_settled', { aborted: true });
    expect((await h.state())?.status).toBe('paused');
  });

  test('restores branch-local state paused, retaining usage and budget', async () => {
    const h = harness();
    await h.run('--tokens 100 Original');
    await h.begin();
    await h.usage();
    const oldLeaf = h.manager.getLeafId()!;
    await h.run('Replacement');
    h.manager.branch(oldLeaf);
    await h.emit('session_tree');
    expect(await h.state()).toMatchObject({ objective: 'Original', status: 'paused', tokenBudget: 100, tokensUsed: 18 });
    expect(h.sent).toHaveLength(1);
    const restored = harness(h.manager);
    await restored.emit('session_start');
    expect(await restored.state()).toMatchObject({ objective: 'Original', status: 'paused', tokensUsed: 18 });
    expect(restored.sent).toHaveLength(0);
  });

  test('reinserts the current objective after compaction and edits', async () => {
    const h = harness();
    expect(await h.emit('context', { messages: [] })).toBeUndefined();
    await h.run('Original');
    await h.run('edit Revised');
    const context = await h.emit('context', { messages: [{ role: 'user', content: 'compacted' }] });
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0].content).toContain('Revised');
    expect(context.messages[0].content).not.toContain('Original');
    await h.run('clear');
    expect((await h.emit('context', { messages: [] })).messages[0].content).toContain('no active goal');
  });

  test('goal context stays stable as usage grows and leaves the latest tool result last', async () => {
    const h = harness();
    await h.run('--tokens 100 Fix it');
    await h.begin();
    const latest = { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: [{ type: 'text', text: 'new evidence' }] };
    const messages = [{ role: 'user', content: 'Fix it' }, latest];
    const before = await h.emit('context', { messages });
    await h.usage();
    const after = await h.emit('context', { messages });
    expect((await h.state())?.tokensUsed).toBe(18);
    expect(after.messages).toEqual(before.messages);
    expect(after.messages.at(-1)).toEqual(latest);
    expect(after.messages[0].content).toContain('Fix it');
    expect(after.messages.filter((message: any) => message.customType === GOAL_ENTRY)).toHaveLength(1);
  });

  test('legacy full reminders are shortened in model context without changing session history', async () => {
    const h = harness();
    await h.run('Revised goal');
    const legacy = { role: 'custom', customType: 'pi-qol-goal-continuation', display: false,
      content: 'The session goal is active. Objective: obsolete goal. Tokens used: 12345.', timestamp: 1 };
    const latest = { role: 'user', content: 'Use the latest evidence' };
    const context = await h.emit('context', { messages: [legacy, latest] });
    expect(JSON.stringify(context.messages)).not.toContain('obsolete goal');
    expect(JSON.stringify(context.messages)).not.toContain('12345');
    expect(context.messages[0].content).toContain('Revised goal');
    expect(context.messages.at(-1)).toEqual(latest);
    expect(legacy.content).toContain('obsolete goal');
  });

  test('model creation refuses unfinished goals and completion stops continuation', async () => {
    const h = harness();
    await h.begin();
    await h.tool('create_goal', { objective: 'Fix it', token_budget: 100 });
    await expect(h.tool('create_goal', { objective: 'Other' })).rejects.toThrow('unfinished');
    await h.usage();
    const completed = await h.tool('update_goal', { status: 'complete' });
    expect(completed.details.goal).toMatchObject({ status: 'complete', tokensUsed: 18 });
    expect(await h.settle()).toBeUndefined();
    await h.tool('create_goal', { objective: 'Next' });
    expect(await h.state()).toMatchObject({ objective: 'Next', tokensUsed: 0 });
  });

  test('blocked status requires at least three goal turns and cannot resume itself', async () => {
    const h = harness();
    await h.run('Fix it');
    await h.begin();
    for (let turn = 1; turn < 3; turn++) {
      await expect(h.tool('update_goal', { status: 'blocked' })).rejects.toThrow('three');
      await h.emit('tool_execution_end');
      await h.settle();
      await h.emit('agent_start');
    }
    await h.tool('update_goal', { status: 'blocked' });
    expect((await h.state())?.status).toBe('blocked');
    await expect(h.tool('update_goal', { status: 'complete' })).rejects.toThrow('status active first');
    expect(await h.settle()).toBeUndefined();
    await h.begin(false, 'Try subagents for the remaining work');
    await h.tool('update_goal', { status: 'active' });
    await expect(h.tool('update_goal', { status: 'blocked' })).rejects.toThrow('three');
  });
});

for (const entrypoint of ['tool', 'command']) {
test(`real Pi runtime starts via ${entrypoint}, continues, and stops on completion`, async () => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-goal-'));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, extensionFactories: [goals],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModels().find(model => model.provider === 'openai')!;
    // All responses are local fixtures. No credentials or network calls are used.
    runtime.getAuth = async () => ({ auth: { apiKey: 'local-test-only' }, env: {} }) as any;
    runtime.hasConfiguredAuth = () => true;
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model,
      resourceLoader, settingsManager, sessionManager: manager, noTools: 'builtin' }));
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => { errors.push(error.error); } });
    let requests = 0;
    const toolStart = entrypoint === 'tool';
    const finalRequest = 6;
    const completionRequest = finalRequest - 1;
    let finished!: () => void;
    const completion = new Promise<void>(resolve => { finished = resolve; });
    session.subscribe(event => {
      if (event.type === 'agent_settled' && requests === finalRequest) finished();
    });
    session.agent.streamFunction = async (_model, context, options) => {
      await options?.onPayload?.({}, model);
      requests++;
      if (requests > finalRequest) throw new Error('Unexpected extra goal continuation');
      const content = requests === 1
        ? [toolStart
          ? { type: 'toolCall', id: 'create', name: 'create_goal', arguments: { objective: 'Finish the fixture task' } }
          : { type: 'toolCall', id: 'inspect', name: 'get_goal', arguments: {} }]
        : requests === completionRequest
          ? [{ type: 'toolCall', id: 'complete', name: 'update_goal', arguments: { status: 'complete' } }]
          : [{ type: 'text', text: requests === finalRequest ? 'Verified and complete.' : 'There is more work.' }];
      if (requests === completionRequest) expect(JSON.stringify(context.messages)).toContain('Finish the fixture task');
      const message: any = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: requests === 1 || requests === completionRequest ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason, message });
      return stream;
    };
    await session.prompt(toolStart ? 'Create a goal to finish the fixture task and pursue it.' : '/goal Finish the fixture task');
    await completion;
    await session.waitForIdle();
    const state = manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === GOAL_ENTRY).at(-1);
    const tokensUsed = toolStart ? 60 : 75;
    expect(state?.type === 'custom' && state.data).toMatchObject({ status: 'complete', turns: 4, tokensUsed });
    expect(manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'pi-qol-goal-continuation' && entry.content.includes('previous response ended without tool calls'))).toHaveLength(2);
    expect(requests).toBe(finalRequest);
    expect(errors).toEqual([]);
    const restored = harness(SessionManager.open(manager.getSessionFile()!));
    await restored.emit('session_start');
    expect(await restored.state()).toMatchObject({ objective: 'Finish the fixture task', status: 'complete', tokensUsed });
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
}
