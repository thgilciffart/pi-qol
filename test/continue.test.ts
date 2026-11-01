import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import continueTurn, { CONTINUE_MESSAGE, CONTINUE_SHORTCUT } from '../src/continue.ts';

function harness(options: { idle?: boolean; pending?: boolean; conversation?: boolean } = {}) {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, any>();
  const sent: { message: any; options: any }[] = [];
  const notices: { message: string; type?: string }[] = [];
  const manager = SessionManager.inMemory();
  if (options.conversation !== false) manager.appendMessage({ role: 'user', content: 'Finish the original task', timestamp: Date.now() });
  const forbidden = () => { throw new Error('Continuing must not mutate the editor, interrupt, wait, or send a new user message'); };
  const ctx = {
    sessionManager: manager, isIdle: () => options.idle ?? true, hasPendingMessages: () => options.pending ?? false,
    abort: forbidden, waitForIdle: forbidden,
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }), setEditorText: forbidden, pasteToEditor: forbidden },
  };
  continueTurn({
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
    sendUserMessage: forbidden, appendEntry: forbidden,
    on: (type: string, handler: any) => handlers.set(type, handler),
  } as never);
  return { commands, shortcuts, handlers, sent, notices, manager,
    command: (args = '') => commands.get('continue').handler(args, ctx),
    shortcut: () => shortcuts.get(CONTINUE_SHORTCUT).handler(ctx),
  };
}

describe('continue an interrupted turn', () => {
  test('registers the command and Ctrl+Alt+C and both send the same hidden continuation', async () => {
    const command = harness();
    const shortcut = harness();
    expect(CONTINUE_SHORTCUT).toBe('ctrl+alt+c');
    expect(command.commands.has('continue')).toBe(true);
    expect(command.shortcuts.has(CONTINUE_SHORTCUT)).toBe(true);
    await command.command();
    await shortcut.shortcut();
    expect(command.sent).toHaveLength(1);
    expect(shortcut.sent).toEqual(command.sent);
    expect(command.sent[0]).toMatchObject({ message: { customType: CONTINUE_MESSAGE, display: false }, options: { triggerTurn: true } });
    expect(command.sent[0].message.content).toMatch(/continu/i);
    expect(command.manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1);
    expect(command.notices).toHaveLength(0);
  });

  test('busy agents receive a notice without being interrupted or queued another turn', async () => {
    for (const invoke of ['command', 'shortcut'] as const) {
      const h = harness({ idle: false });
      await h[invoke]();
      expect(h.sent).toHaveLength(0);
      expect(h.notices.at(-1)?.type).toBe('info');
      expect(h.notices.at(-1)?.message).toMatch(/working|running|busy/i);
    }
  });

  test('pending user input takes priority over both continuation entrypoints', async () => {
    for (const invoke of ['command', 'shortcut'] as const) {
      const h = harness({ pending: true });
      await h[invoke]();
      expect(h.sent).toHaveLength(0);
      expect(h.notices.at(-1)?.type).toBe('info');
      expect(h.notices.at(-1)?.message).toMatch(/waiting|pending|queued/i);
    }
  });

  test('empty conversations are not started by continue', async () => {
    const h = harness({ conversation: false });
    h.manager.appendCustomEntry('metadata', { value: 1 });
    await h.command();
    expect(h.sent).toHaveLength(0);
    expect(h.notices.at(-1)?.type).toBe('info');
    expect(h.notices.at(-1)?.message).toMatch(/conversation|message first/i);
  });

  test('conversation history from another branch does not make the active branch continuable', async () => {
    const h = harness({ conversation: false });
    const root = h.manager.appendCustomEntry('metadata', {});
    h.manager.appendMessage({ role: 'user', content: 'A different branch task', timestamp: Date.now() });
    h.manager.branch(root);
    await h.shortcut();
    expect(h.sent).toHaveLength(0);
    expect(h.notices.at(-1)?.type).toBe('info');
  });

  test('arguments produce a usage error without sending a continuation', async () => {
    const h = harness();
    await h.command('some new task');
    expect(h.sent).toHaveLength(0);
    expect(h.notices.at(-1)).toEqual({ message: 'Usage: /continue', type: 'error' });
  });

  test('does not alter a paused goal or register an automatic continuation loop', async () => {
    const h = harness();
    const state = { objective: 'Keep working', status: 'paused', tokensUsed: 12345 };
    h.manager.appendCustomEntry('pi-qol-goal', state);
    const before = h.manager.getBranch();
    await h.command();
    expect(h.manager.getBranch()).toEqual(before);
    expect(h.handlers.size).toBe(0);
    expect(h.sent).toHaveLength(1);
  });
});

for (const entrypoint of ['command', 'shortcut'] as const) {
  test(`real Pi resumes an aborted reply via ${entrypoint} with one original user message`, async () => {
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-continue-'));
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: [continueTurn],
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await resourceLoader.reload();
      const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      const model = runtime.getModels().find(model => model.provider === 'openai')!;
      runtime.getAuth = async () => ({ auth: { apiKey: 'local-test-only' }, env: {} }) as any;
      runtime.hasConfiguredAuth = () => true;
      const manager = SessionManager.inMemory(dir);
      const created = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader,
        settingsManager, sessionManager: manager, noTools: 'all' });
      session = created.session;
      const errors: string[] = [];
      await session.bindExtensions({ onError: error => { errors.push(error.error); } });
      let requests = 0;
      const contexts: any[] = [];
      session.agent.streamFunction = async (_model, context) => {
        requests++;
        contexts.push(context);
        if (requests > 2) throw new Error('Continue must trigger only one additional request');
        const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: requests === 1 ? 'Partial result before interruption' : 'Original task completed' }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: requests === 1 ? 'aborted' : 'stop', timestamp: Date.now() };
        const stream = createAssistantMessageEventStream();
        if (requests === 1) stream.push({ type: 'error', reason: 'aborted', error: message });
        else stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      };
      await session.prompt('Finish the original task');
      await session.waitForIdle();
      expect(requests).toBe(1);
      const firstAssistant = manager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
      expect(firstAssistant?.type === 'message' && firstAssistant.message.role === 'assistant' && firstAssistant.message.stopReason).toBe('aborted');
      if (entrypoint === 'command') await session.prompt('/continue');
      else {
        const extension = created.extensionsResult.extensions.find(extension => extension.shortcuts.has(CONTINUE_SHORTCUT))!;
        await extension.shortcuts.get(CONTINUE_SHORTCUT)!.handler(session.extensionRunner.createContext());
      }
      await session.waitForIdle();
      expect(requests).toBe(2);
      const branch = manager.getBranch();
      const users = branch.filter(entry => entry.type === 'message' && entry.message.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0].type === 'message' && users[0].message.content).toEqual([{ type: 'text', text: 'Finish the original task' }]);
      const cues = branch.filter(entry => entry.type === 'custom_message' && entry.customType === CONTINUE_MESSAGE);
      expect(cues).toHaveLength(1);
      expect(cues[0].type === 'custom_message' && cues[0].display).toBe(false);
      expect(JSON.stringify(contexts[1])).toContain('Finish the original task');
      expect(JSON.stringify(contexts[1])).toContain('Partial result before interruption');
      expect(JSON.stringify(contexts[1])).toMatch(/continu/i);
      expect(branch.at(-1)?.type === 'message' && (branch.at(-1) as any).message.content[0].text).toBe('Original task completed');
      expect(errors).toEqual([]);
    } finally {
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
