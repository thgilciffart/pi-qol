import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import autoName, {
  DEFAULT_AUTO_NAME_SETTINGS,
  DEFAULT_TITLE_PROMPT,
  cleanTitle,
  readAutoNameSettings,
  writeAutoNameSettings,
} from '../src/auto-name.ts';

initTheme('dark');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reply(title = 'Fix checkout retry handling') {
  return { role: 'assistant', content: [{ type: 'text', text: title }], stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}

async function harness(options: { existing?: string; name?: string; settings?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-auto-name-'));
  const configPath = join(dir, 'settings.json');
  if (options.settings) await writeFile(configPath, JSON.stringify({ ...DEFAULT_AUTO_NAME_SETTINGS, ...options.settings }));
  let manager = SessionManager.inMemory(dir);
  if (options.existing) manager.appendMessage({ role: 'user', content: options.existing, timestamp: Date.now() });
  if (options.name) manager.appendSessionInfo(options.name);
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const requests: { model: any; context: any; options: any }[] = [];
  const names: string[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const selections: { title: string; choices: string[] }[] = [];
  const choices: ((choices: string[]) => string | undefined)[] = [];
  const editors: string[] = [];
  const editorResults: (string | undefined)[] = [];
  const customActions: ((component: any) => void)[] = [];
  const customComponents: any[] = [];
  let generate = async () => reply();
  const current = { provider: 'test', id: 'chat', name: 'Chat model', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 8192 };
  const other = { ...current, provider: 'other', id: 'vendor/title-model', name: 'Title model' };
  const modelRegistry = {
    getAll: () => [current, other], getAvailable: () => [current, other],
    find: (provider: string, id: string) => [current, other].find(model => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
    getError: () => undefined,
    refresh: async () => ({ errors: new Map(), aborted: false }),
    getProviderDisplayName: (provider: string) => provider,
    streamSimple: (model: any, context: any, requestOptions: any) => {
      requests.push({ model, context, options: requestOptions });
      return { result: () => generate() };
    },
  };
  const ui = {
    notify: (message: string, type?: string) => notifications.push({ message, type }),
    select: async (title: string, entries: string[]) => {
      selections.push({ title, choices: entries });
      return choices.shift()?.(entries);
    },
    editor: async (_title: string, initial: string) => { editors.push(initial); return editorResults.shift(); },
    input: async () => undefined,
    custom: async (factory: any) => new Promise(resolve => {
      let component: any;
      const done = (value: unknown) => { component?.dispose?.(); resolve(value); };
      component = factory({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, {}, {}, done);
      customComponents.push(component);
      const action = customActions.shift();
      if (action) action(component);
      else component.handleInput('\x1b');
    }),
  };
  function ctx() {
    return { mode: 'tui', hasUI: true, cwd: dir, sessionManager: manager,
      model: current, thinkingLevel: 'high', scopedModels: [{ model: current }, { model: other }], modelRegistry, ui, isIdle: () => false,
      hasPendingMessages: () => false };
  }
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler),
    getSessionName: () => manager.getSessionName(),
    setSessionName: (name: string) => {
      names.push(name);
      manager.appendSessionInfo(name);
      void handlers.get('session_info_changed')?.({ type: 'session_info_changed', name }, ctx());
    },
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
  };
  autoName(pi as never, { configPath });
  const emit = (type: string, event: any = {}) => handlers.get(type)?.({ type, ...event }, ctx());
  await emit('session_start');
  async function flush() {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  async function user(text = 'Fix the checkout retry bug') {
    const message = { role: 'user' as const, content: text, timestamp: Date.now() };
    await emit('message_start', { message });
    manager.appendMessage(message);
    await flush();
  }
  return { dir, configPath, commands, requests, names, notifications, selections, choices, editors, editorResults, customActions, customComponents,
    current, other, emit, flush, user,
    manager: () => manager,
    setGenerator: (fn: typeof generate) => { generate = fn; },
    command: async (args = '', hasUI = true) => commands.get('auto-name').handler(args, { ...ctx(), hasUI }),
    renameManually: async (name: string) => {
      manager.appendSessionInfo(name);
      await emit('session_info_changed', { name });
    },
    replaceSession: async () => {
      await emit('session_shutdown', { reason: 'new' });
      manager = SessionManager.inMemory(dir);
      await emit('session_start');
    },
    cleanup: async () => { await emit('session_shutdown', { reason: 'quit' }); await rm(dir, { recursive: true, force: true }); },
  };
}

describe('automatic thread naming', () => {
  test('names a fresh thread from its first user message with the current model', async () => {
    const h = await harness();
    try {
      await h.user('Fix the checkout retry bug');
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].model).toBe(h.current);
      expect(h.requests[0].context.systemPrompt).toContain(DEFAULT_TITLE_PROMPT);
      expect(JSON.stringify(h.requests[0].context.messages)).toContain('Fix the checkout retry bug');
      expect(h.requests[0].options.reasoning).toBeUndefined();
      expect(h.names).toEqual(['Fix checkout retry handling']);
      expect(h.manager().getSessionName()).toBe('Fix checkout retry handling');
      await h.user('Now fix another bug');
      expect(h.requests).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  test('does not hold up the first message while the naming request is pending', async () => {
    const h = await harness();
    const pending = deferred<ReturnType<typeof reply>>();
    h.setGenerator(() => pending.promise);
    try {
      await h.user();
      expect(h.requests).toHaveLength(1);
      expect(h.names).toHaveLength(0);
      pending.resolve(reply('Generated later'));
      await h.flush();
      expect(h.names).toEqual(['Generated later']);
    } finally { await h.cleanup(); }
  });

  test('existing conversations and manually named threads are left alone', async () => {
    for (const options of [{ existing: 'Earlier question' }, { name: 'My chosen name' }]) {
      const h = await harness(options);
      try {
        await h.user();
        expect(h.requests).toHaveLength(0);
        expect(h.names).toHaveLength(0);
      } finally { await h.cleanup(); }
    }
  });

  test('reloading a conversation does not generate a second title', async () => {
    const h = await harness();
    try {
      await h.user();
      await h.emit('session_start', { reason: 'reload' });
      await h.user('A follow-up');
      expect(h.requests).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  test('a manual name wins over a pending generated name', async () => {
    const h = await harness();
    const pending = deferred<ReturnType<typeof reply>>();
    h.setGenerator(() => pending.promise);
    try {
      await h.user();
      await h.renameManually('My manual title');
      pending.resolve(reply('Late generated title'));
      await h.flush();
      expect(h.manager().getSessionName()).toBe('My manual title');
      expect(h.names).toHaveLength(0);
    } finally { await h.cleanup(); }
  });

  test('a stale result cannot name a replacement session even when cancellation is ignored', async () => {
    const h = await harness();
    const pending = deferred<ReturnType<typeof reply>>();
    h.setGenerator(() => pending.promise);
    try {
      await h.user();
      const signal = h.requests[0].options.signal;
      await h.replaceSession();
      expect(signal.aborted).toBe(true);
      pending.resolve(reply('Wrong thread title'));
      await h.flush();
      expect(h.names).toHaveLength(0);
      expect(h.manager().getSessionName()).toBeUndefined();
    } finally { await h.cleanup(); }
  });

  test('switching branches cancels a pending title', async () => {
    const h = await harness();
    const pending = deferred<ReturnType<typeof reply>>();
    h.setGenerator(() => pending.promise);
    try {
      await h.user();
      await h.emit('session_tree');
      pending.resolve(reply('Outdated title'));
      await h.flush();
      expect(h.names).toHaveLength(0);
    } finally { await h.cleanup(); }
  });

  test('turning naming off cancels pending generation and does not retry on follow-ups', async () => {
    const h = await harness();
    const pending = deferred<ReturnType<typeof reply>>();
    h.setGenerator(() => pending.promise);
    try {
      await h.user();
      await h.command('off');
      pending.resolve(reply('Cancelled title'));
      await h.flush();
      await h.user('A second prompt');
      expect(h.names).toHaveLength(0);
      expect(h.requests).toHaveLength(1);
      expect((await readAutoNameSettings(h.configPath)).enabled).toBe(false);
    } finally { await h.cleanup(); }
  });

  test('a naming failure warns once without breaking the conversation or retrying', async () => {
    const h = await harness();
    h.setGenerator(async () => { throw new Error('Provider unavailable'); });
    try {
      await h.user();
      await h.user('A follow-up still works');
      expect(h.names).toHaveLength(0);
      expect(h.requests).toHaveLength(1);
      expect(h.notifications.some(item => item.type === 'warning' || item.type === 'error')).toBe(true);
    } finally { await h.cleanup(); }
  });

  test('honors configured model, effort, and prompt without changing the chat model', async () => {
    const h = await harness({ settings: { model: 'other/vendor/title-model', effort: 'high', prompt: 'Use a short verb phrase.' } });
    try {
      await h.user();
      expect(h.requests[0].model).toBe(h.other);
      expect(h.requests[0].options.reasoning).toBe('high');
      expect(h.requests[0].context.systemPrompt).toContain('Use a short verb phrase.');
      expect(h.current.provider).toBe('test');
    } finally { await h.cleanup(); }
  });

  test('disabled naming stays off and now explicitly names an existing conversation', async () => {
    const h = await harness({ settings: { enabled: false } });
    try {
      await h.user('The original task');
      expect(h.requests).toHaveLength(0);
      await h.command('now');
      expect(h.requests).toHaveLength(1);
      expect(JSON.stringify(h.requests[0].context.messages)).toContain('The original task');
      expect(h.names).toEqual(['Fix checkout retry handling']);
    } finally { await h.cleanup(); }
  });
});

describe('/auto-name configuration', () => {
  test('persists direct model, effort, prompt, and enabled settings', async () => {
    const h = await harness();
    try {
      await h.command('model other/vendor/title-model');
      await h.command('effort low');
      await h.command('prompt Name the concrete implementation task.');
      await h.command('off');
      expect(await readAutoNameSettings(h.configPath)).toMatchObject({ model: 'other/vendor/title-model', effort: 'low',
        prompt: 'Name the concrete implementation task.', enabled: false });
      await h.command('on');
      expect((await readAutoNameSettings(h.configPath)).enabled).toBe(true);
      await h.command('reset');
      expect(await readAutoNameSettings(h.configPath)).toEqual(DEFAULT_AUTO_NAME_SETTINGS);
    } finally { await h.cleanup(); }
  });

  test('invalid model and effort leave prior settings intact', async () => {
    const h = await harness();
    try {
      await h.command('effort low');
      const previous = await readAutoNameSettings(h.configPath);
      await h.command('effort impossible');
      expect(await readAutoNameSettings(h.configPath)).toEqual(previous);
      await h.command('model unknown/model');
      expect(await readAutoNameSettings(h.configPath)).toEqual(previous);
      expect(h.notifications.filter(item => item.type === 'error').length).toBeGreaterThanOrEqual(2);
    } finally { await h.cleanup(); }
  });

  test('model and effort pickers and the prompt editor save their selections', async () => {
    const h = await harness();
    try {
      h.customActions.push(component => { component.handleInput('title-model'); component.handleInput('\r'); });
      await h.command('model');
      h.choices.push(entries => entries.find(value => value === 'medium' || value.startsWith('medium ')));
      await h.command('effort');
      h.editorResults.push('Create a concise topic title.');
      await h.command('prompt');
      expect(h.editors[0]).toBe(DEFAULT_TITLE_PROMPT);
      expect(await readAutoNameSettings(h.configPath)).toMatchObject({ model: 'other/vendor/title-model', effort: 'medium',
        prompt: 'Create a concise topic title.' });
      await h.command('prompt default');
      expect((await readAutoNameSettings(h.configPath)).prompt).toBe(DEFAULT_TITLE_PROMPT);
    } finally { await h.cleanup(); }
  });

  test('bare command opens the interactive configuration menu and headless status is readable', async () => {
    const h = await harness();
    try {
      await h.command();
      expect(h.selections.length).toBeGreaterThan(0);
      expect(h.selections[0].choices).not.toContain('Show settings');
      await h.command('', false);
      expect(h.notifications.at(-1)?.message).toMatch(/model|effort|enabled|automatic/i);
    } finally { await h.cleanup(); }
  });

  test('cancelling a picker or prompt editor preserves settings', async () => {
    const h = await harness();
    try {
      await h.command('effort low');
      const previous = await readAutoNameSettings(h.configPath);
      await h.command('model');
      h.editorResults.push(undefined);
      await h.command('prompt');
      expect(await readAutoNameSettings(h.configPath)).toEqual(previous);
    } finally { await h.cleanup(); }
  });

  test('Escape in model, effort, and prompt subviews returns to the main settings menu', async () => {
    const h = await harness();
    try {
      h.choices.push(
        entries => entries.find(value => value.startsWith('Model:')),
        entries => entries.find(value => value.startsWith('Effort:')),
        () => undefined,
        entries => entries.find(value => /prompt/i.test(value)),
        () => undefined,
      );
      h.customActions.push(component => component.handleInput('\x1b'));
      h.editorResults.push(undefined);
      await h.command();
      expect(h.selections.filter(selection => selection.title === 'Automatic thread naming')).toHaveLength(4);
      expect(h.selections.some(selection => selection.title === 'Naming effort')).toBe(true);
      expect(h.editors).toHaveLength(1);
      expect(h.customComponents).toHaveLength(1);
      expect(h.notifications).toHaveLength(0);
    } finally { await h.cleanup(); }
  });

  test('one menu visit can save several changes without full settings notifications', async () => {
    const h = await harness();
    try {
      h.choices.push(
        entries => entries.find(value => value.startsWith('Effort:')),
        entries => entries.find(value => value === 'low'),
        entries => entries.find(value => /prompt/i.test(value)),
        entries => entries.find(value => value.startsWith('Automatic naming:')),
        () => undefined,
      );
      h.editorResults.push('Prefer a short action title.');
      await h.command();
      expect(await readAutoNameSettings(h.configPath)).toMatchObject({ enabled: false, effort: 'low', prompt: 'Prefer a short action title.' });
      const menus = h.selections.filter(selection => selection.title === 'Automatic thread naming');
      expect(menus).toHaveLength(4);
      expect(menus.at(-1)?.choices).toContain('Automatic naming: off');
      expect(menus.at(-1)?.choices).toContain('Effort: low');
      expect(menus.every(menu => !menu.choices.includes('Show settings'))).toBe(true);
      expect(h.notifications).toHaveLength(0);
      await h.command('status');
      expect(h.notifications.at(-1)?.message).toContain('Effort: low');
    } finally { await h.cleanup(); }
  });
});

describe('auto-name settings and output', () => {
  test('missing settings use the bundled defaults and custom settings round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-auto-name-config-'));
    try {
      const path = join(dir, 'nested', 'settings.json');
      expect(await readAutoNameSettings(path)).toEqual(DEFAULT_AUTO_NAME_SETTINGS);
      const settings = { ...DEFAULT_AUTO_NAME_SETTINGS, model: 'test/model', effort: 'low' as const, prompt: 'Write a title.' };
      await writeAutoNameSettings(path, settings);
      expect(await readAutoNameSettings(path)).toEqual(settings);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(settings);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('corrupt or invalid settings are rejected rather than silently accepted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-auto-name-invalid-'));
    const path = join(dir, 'settings.json');
    try {
      for (const value of ['{broken', 'null', JSON.stringify({ ...DEFAULT_AUTO_NAME_SETTINGS, effort: 'impossible' }),
        JSON.stringify({ ...DEFAULT_AUTO_NAME_SETTINGS, prompt: '' })]) {
        await writeFile(path, value);
        await expect(readAutoNameSettings(path)).rejects.toThrow();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('cleans title decoration, avoids multiline titles, and limits long output', () => {
    expect(cleanTitle('  "Fix checkout retries"  ')).toBe('Fix checkout retries');
    expect(cleanTitle('```text\nFix checkout retries\n```')).toBe('Fix checkout retries');
    expect(cleanTitle('Fix checkout retries\nUnwanted explanation')).toBe('Fix checkout retries');
    expect(cleanTitle('\x1b[31mFix checkout retries\x1b[0m')).toBe('Fix checkout retries');
    expect([...cleanTitle('x'.repeat(200))].length).toBeLessThanOrEqual(80);
    expect(() => cleanTitle(' \n\t ')).toThrow();
  });
});
