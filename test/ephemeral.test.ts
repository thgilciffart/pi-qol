import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import plugin from '../src/ephemeral.ts';

const RETURN_ENTRY = 'pi-qol-ephemeral-return';

class FakeSessionManager {
  sessionDir = '/tmp/pi-sessions';
  flushed = false;
  entries: any[] = [];
  constructor(public persist: boolean, public sessionFile: string | undefined) {}
  isPersisted() { return this.persist; }
  getSessionFile() { return this.sessionFile; }
  getSessionDir() { return this.sessionDir; }
  getCwd() { return '/tmp/pi-qol-test'; }
  getSessionId() { return 'fake-session-id'; }
  getHeader() { return { type: 'session', version: 3, id: 'fake-session-id', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/pi-qol-test' }; }
  getEntries() { return this.entries; }
  appendCustomEntry(customType: string, data: unknown) {
    const id = String(this.entries.length + 1);
    this.entries.push({ type: 'custom', customType, data, id });
    return id;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

interface HarnessOptions {
  persistent?: boolean;
  nextManager?: any;
  entries?: any[];
  idle?: boolean;
  pending?: boolean;
  newCancelled?: boolean;
  switchCancelled?: boolean;
  newGate?: Promise<void>;
  switchGate?: Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  const recorded = { notifications: [] as { message: string; type?: string }[], statuses: [] as { key: string; text?: string }[],
    confirmations: 0, newSessions: 0, sentMessages: [] as string[], nextManagers: [] as any[], switched: [] as string[],
    dispatches: [] as Promise<void>[], shortcutPrompts: [] as { text: string; options: unknown }[],
    autocompleteRefreshes: 0, idleWaits: 0 };
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const persistent = options.persistent ?? true;
  let manager: any = new FakeSessionManager(persistent, persistent ? '/tmp/pi-sessions/current.jsonl' : undefined);
  manager.entries = options.entries ?? [];
  const originalManager = manager;
  const managers = new Map<string, any>([[originalManager.getSessionFile() ?? '', originalManager]]);
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, type?: string) => { recorded.notifications.push({ message, type }); },
    setStatus: (key: string, text: string | undefined) => { recorded.statuses.push({ key, text }); },
    confirm: async () => { recorded.confirmations++; throw new Error('Toggling must not ask for confirmation'); },
    addAutocompleteProvider: (factory: any) => { recorded.autocompleteRefreshes++; factory({}); },
  };
  function ctx(current = manager): any {
    return { mode: 'tui', hasUI: true, cwd: '/tmp/pi-qol-test', sessionManager: current, ui,
      isIdle: () => options.idle ?? true, hasPendingMessages: () => options.pending ?? false,
      waitForIdle: async () => { recorded.idleWaits++; },
      newSession: async (callbacks: any) => {
        recorded.newSessions++;
        if (options.newGate) await options.newGate;
        if (options.newCancelled) return { cancelled: true };
        const next = options.nextManager ?? new FakeSessionManager(true, '/tmp/pi-sessions/next.jsonl');
        recorded.nextManagers.push(next);
        await callbacks?.setup?.(next);
        manager = next;
        await callbacks?.withSession?.(ctx(next));
        return { cancelled: false };
      },
      switchSession: async (path: string, callbacks: any) => {
        recorded.switched.push(path);
        if (options.switchGate) await options.switchGate;
        if (options.switchCancelled) return { cancelled: true };
        manager = managers.get(path) ?? new FakeSessionManager(true, path);
        await callbacks?.withSession?.(ctx(manager));
        return { cancelled: false };
      },
      sendUserMessage: async (text: string) => {
        recorded.sentMessages.push(text);
        current.entries?.push({ type: 'message', message: { role: 'user', content: text } });
      },
    };
  }
  const pi = {
    registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (type: string, handler: any) => handlers.set(type, handler),
    sendUserMessage: (text: string, sendOptions: unknown) => {
      recorded.shortcutPrompts.push({ text, options: sendOptions });
      recorded.dispatches.push(commands.get('ephemeral').handler('', ctx()));
    },
  };
  plugin(pi as never);
  return { commands, handlers, shortcuts, recorded, originalManager, manager: () => manager, ctx: () => ctx(),
    run: (args = '') => commands.get('ephemeral').handler(args, ctx()),
    press: async () => { await shortcuts.get('alt+p').handler(ctx()); await Promise.all(recorded.dispatches); } };
}

describe('/ephemeral', () => {
  test('opens a saved chat in private mode immediately without confirmation', async () => {
    const h = createHarness();
    await h.run();
    expect(h.recorded.confirmations).toBe(0);
    expect(h.recorded.newSessions).toBe(1);
    expect(h.manager().isPersisted()).toBe(false);
    expect(h.manager().getSessionFile()).toBeUndefined();
    expect(h.manager().getSessionDir()).toBe('');
    expect(h.manager().getEntries()).toContainEqual(expect.objectContaining({ type: 'custom', customType: RETURN_ENTRY,
      data: { sessionFile: '/tmp/pi-sessions/current.jsonl' } }));
  });

  test('an empty private chat returns to the previous saved thread without a new chat', async () => {
    const h = createHarness();
    await h.run();
    await h.run();
    expect(h.recorded.switched).toEqual(['/tmp/pi-sessions/current.jsonl']);
    expect(h.recorded.newSessions).toBe(1);
    expect(h.manager()).toBe(h.originalManager);
    expect(h.recorded.statuses.at(-1)).toEqual({ key: 'ephemeral', text: undefined });
  });

  test('return metadata survives reloading the extension in the empty private session', async () => {
    const first = createHarness();
    await first.run();
    const reloaded = createHarness({ persistent: false, entries: first.manager().getEntries() });
    await reloaded.handlers.get('session_start')({ type: 'session_start', reason: 'reload' }, reloaded.ctx());
    await reloaded.run();
    expect(reloaded.recorded.switched).toEqual(['/tmp/pi-sessions/current.jsonl']);
    expect(reloaded.manager().isPersisted()).toBe(true);
  });

  test('an old empty private session without return metadata opens a blank saved session', async () => {
    const target = '/tmp/pi-qol-fallback-saved.jsonl';
    const create = spyOn(SessionManager, 'create').mockReturnValue({ getSessionFile: () => target } as SessionManager);
    try {
      const h = createHarness({ persistent: false });
      await h.run();
      expect(create).toHaveBeenCalledWith('/tmp/pi-qol-test');
      expect(h.recorded.switched).toEqual([target]);
      expect(h.manager().isPersisted()).toBe(true);
      expect(h.recorded.newSessions).toBe(0);
    } finally { create.mockRestore(); }
  });

  test('private history is never discarded, including message entries outside the visible branch', async () => {
    for (const role of ['user', 'assistant', 'toolResult', 'custom']) {
      const h = createHarness({ persistent: false, entries: [{ type: 'message', message: { role, content: 'private data' } }] });
      await h.run();
      expect(h.recorded.switched).toHaveLength(0);
      expect(h.recorded.newSessions).toBe(0);
      expect(h.recorded.notifications.at(-1)?.message).toContain('already ephemeral');
    }
  });

  test('busy and queued private sessions stay open even when they have no messages yet', async () => {
    for (const options of [{ idle: false }, { pending: true }]) {
      const h = createHarness({ persistent: false, ...options });
      await h.run();
      expect(h.recorded.switched).toHaveLength(0);
      expect(h.manager().isPersisted()).toBe(false);
      expect(h.recorded.notifications.at(-1)?.message).toContain('already ephemeral');
    }
  });

  test('initial arguments on a saved session go only to the verified in-memory replacement', async () => {
    const h = createHarness();
    await h.run('  explain the build  ');
    expect(h.recorded.sentMessages).toEqual(['explain the build']);
    expect(h.manager().isPersisted()).toBe(false);
    expect(h.originalManager.getEntries()).toHaveLength(0);
    expect(h.recorded.confirmations).toBe(0);
  });

  test('arguments in an existing private chat keep it open without sending another message', async () => {
    const h = createHarness({ persistent: false });
    await h.run('another prompt');
    expect(h.recorded.switched).toHaveLength(0);
    expect(h.recorded.sentMessages).toHaveLength(0);
    expect(h.manager().isPersisted()).toBe(false);
  });

  test('reports a failed in-memory conversion without sending the initial prompt', async () => {
    const stubborn = { persist: undefined, isPersisted: () => true,
      getSessionFile: () => '/tmp/pi-sessions/stubborn.jsonl', getSessionDir: () => '/tmp/pi-sessions' };
    const h = createHarness({ nextManager: stubborn });
    await h.run('private initial prompt');
    expect(h.recorded.notifications.some(notice => notice.type === 'error' && notice.message.includes('will be saved'))).toBe(true);
    expect(h.recorded.sentMessages).toHaveLength(0);
  });

  test('cancelled entering or leaving private mode preserves the current session', async () => {
    const enter = createHarness({ newCancelled: true });
    await enter.run();
    expect(enter.manager()).toBe(enter.originalManager);
    expect(enter.recorded.notifications.at(-1)?.message).toBe('No new chat was created.');
    const leave = createHarness({ persistent: false, switchCancelled: true,
      entries: [{ type: 'custom', customType: RETURN_ENTRY, data: { sessionFile: '/tmp/pi-sessions/original.jsonl' } }] });
    await leave.run();
    expect(leave.manager()).toBe(leave.originalManager);
    expect(leave.recorded.notifications.at(-1)?.message).toContain('Still in private mode');
  });

  test('repeated command or Alt+P while a replacement is pending starts only one switch', async () => {
    const gate = deferred();
    const h = createHarness({ newGate: gate.promise });
    const opening = h.run();
    await h.run();
    const shortcut = h.press();
    expect(h.recorded.newSessions).toBe(1);
    gate.resolve();
    await opening;
    await shortcut;
    expect(h.recorded.newSessions).toBe(1);
    expect(h.manager().isPersisted()).toBe(false);
    expect(h.recorded.shortcutPrompts[0]).toEqual({ text: '/ephemeral', options: { expandPromptTemplates: true } });
  });

  test('repeated toggle while returning to saved mode starts only one return', async () => {
    const gate = deferred();
    const h = createHarness({ persistent: false, switchGate: gate.promise,
      entries: [{ type: 'custom', customType: RETURN_ENTRY, data: { sessionFile: '/tmp/pi-sessions/original.jsonl' } }] });
    const leaving = h.run();
    await h.run();
    expect(h.recorded.switched).toHaveLength(1);
    gate.resolve();
    await leaving;
    expect(h.manager().isPersisted()).toBe(true);
  });

  test('shows the ephemeral badge and clears it for saved sessions', async () => {
    const privateChat = createHarness({ persistent: false });
    await privateChat.handlers.get('session_start')({ type: 'session_start' }, privateChat.ctx());
    expect(privateChat.recorded.statuses.at(-1)).toEqual({ key: 'ephemeral', text: '◌ ephemeral' });
    const saved = createHarness();
    await saved.handlers.get('session_start')({ type: 'session_start' }, saved.ctx());
    expect(saved.recorded.statuses.at(-1)).toEqual({ key: 'ephemeral', text: undefined });
  });
});

describe('/save', () => {
  const userMessage = { type: 'message', message: { role: 'user', content: 'secret plans' } };

  test('is not offered in a saved session or in an empty ephemeral chat', async () => {
    const saved = createHarness();
    await saved.handlers.get('session_start')({ type: 'session_start' }, saved.ctx());
    expect(saved.commands.has('save')).toBe(false);

    const empty = createHarness({ persistent: false });
    await empty.handlers.get('session_start')({ type: 'session_start' }, empty.ctx());
    expect(empty.commands.has('save')).toBe(false);
    expect(empty.recorded.autocompleteRefreshes).toBe(0);
  });

  test('appears at session start when the ephemeral chat already has messages', async () => {
    const h = createHarness({ persistent: false, entries: [userMessage] });
    await h.handlers.get('session_start')({ type: 'session_start' }, h.ctx());
    expect(h.commands.has('save')).toBe(true);
    expect(h.commands.get('save').description).toContain('ephemeral');
  });

  test('appears once a run ends in an ephemeral chat and refreshes the command picker', async () => {
    const h = createHarness({ persistent: false });
    await h.handlers.get('session_start')({ type: 'session_start' }, h.ctx());
    expect(h.commands.has('save')).toBe(false);
    h.manager().entries.push(userMessage);
    await h.handlers.get('agent_end')({ type: 'agent_end' }, h.ctx());
    expect(h.commands.has('save')).toBe(true);
    expect(h.recorded.autocompleteRefreshes).toBe(1);
    // Later runs do not re-register or refresh again.
    await h.handlers.get('turn_end')({ type: 'turn_end' }, h.ctx());
    expect(h.recorded.autocompleteRefreshes).toBe(1);
  });

  test('writes the ephemeral chat to a new session file and turns it into a saved session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-save-'));
    const create = spyOn(SessionManager, 'create').mockReturnValue({ getSessionDir: () => dir } as SessionManager);
    try {
      const h = createHarness({ persistent: false, entries: [userMessage] });
      h.manager().sessionDir = ''; // in-memory managers have no session dir
      await h.handlers.get('session_start')({ type: 'session_start' }, h.ctx());
      await h.commands.get('save').handler('', h.ctx());

      const manager = h.manager();
      expect(manager.isPersisted()).toBe(true);
      const path = manager.getSessionFile();
      expect(path!.startsWith(`${dir}/`)).toBe(true);
      expect(path!.endsWith('_fake-session-id.jsonl')).toBe(true);
      expect(/\d{4}-\d{2}-\d{2}T/.test(path!)).toBe(true);
      expect(manager.getSessionDir()).toBe(dir);
      const lines = (await readFile(path!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(lines[0].type).toBe('session');
      expect(lines.slice(1)).toEqual([userMessage]);
      expect(h.recorded.idleWaits).toBe(1);
      expect(h.recorded.notifications.at(-1)).toEqual({ message: `Saved this chat to ${path}`, type: 'info' });
      expect(h.recorded.statuses.at(-1)).toEqual({ key: 'ephemeral', text: undefined });
    } finally {
      create.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to save again after the chat is already on disk', async () => {
    const h = createHarness({ persistent: false, entries: [userMessage] });
    await h.handlers.get('session_start')({ type: 'session_start' }, h.ctx());
    h.manager().persist = true; // saved by an earlier /save
    h.manager().sessionFile = '/tmp/pi-sessions/saved.jsonl';
    await h.commands.get('save').handler('', h.ctx());
    expect(h.recorded.notifications.at(-1)?.message).toContain('already saved');
    expect(h.recorded.idleWaits).toBe(0);
  });

  test('refuses when the ephemeral chat has no messages yet', async () => {
    const h = createHarness({ persistent: false, entries: [userMessage] });
    await h.handlers.get('session_start')({ type: 'session_start' }, h.ctx());
    h.manager().entries = []; // messages removed since registration
    await h.commands.get('save').handler('', h.ctx());
    expect(h.recorded.notifications.at(-1)?.message).toContain('Nothing to save yet');
    expect(h.manager().isPersisted()).toBe(false);
  });
});

test('real Alt+P opens a memory-only private chat and returns to the saved thread without model calls or confirmation', async () => {
  const { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, getPackageDir, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const { KeybindingsManager } = await import(join(getPackageDir(), 'dist/core/keybindings.js'));
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-ephemeral-runtime-'));
  let runtime: InstanceType<typeof AgentSessionRuntime> | undefined;
  let nextRebind: (() => void) | undefined;
  const notices: string[] = [];
  const errors: string[] = [];
  let confirmations = 0;
  let requests = 0;
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const createRuntime = async (options: any) => {
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: dir, settingsManager, extensionFactories: [plugin],
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await resourceLoader.reload();
      const created = await createAgentSession({ ...options, agentDir: dir, modelRuntime, resourceLoader, settingsManager, noTools: 'all' });
      created.session.agent.streamFunction = async () => { requests++; throw new Error('Toggling private mode must not prompt a model'); };
      return { ...created, services: { cwd: options.cwd, agentDir: dir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, diagnostics: [] };
    };
    const original = SessionManager.create(dir, join(dir, 'sessions'));
    original.appendMessage({ role: 'user', content: 'Existing saved conversation', timestamp: Date.now() });
    const originalPath = original.getSessionFile()!;
    const initial = await createRuntime({ cwd: dir, agentDir: dir, sessionManager: original });
    runtime = new AgentSessionRuntime(initial.session, initial.services, createRuntime);
    const bind = async (session: any) => {
      await session.bindExtensions({ mode: 'tui',
        uiContext: { confirm: async () => { confirmations++; throw new Error('No confirmation expected'); },
          notify: (message: string) => { notices.push(message); }, setStatus: () => {}, theme: { fg: (_color: string, text: string) => text } } as never,
        onError: (error: any) => { errors.push(error.error); },
        commandContextActions: { waitForIdle: () => runtime!.session.waitForIdle(),
          newSession: (options: any) => runtime!.newSession(options), switchSession: (path: string, options: any) => runtime!.switchSession(path, options),
          fork: (entry: string, options: any) => runtime!.fork(entry, options), navigateTree: () => { throw new Error('Unexpected tree navigation'); }, reload: async () => {} },
      });
      nextRebind?.();
      nextRebind = undefined;
    };
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    const savedContents = await readFile(originalPath, 'utf8');
    const press = async () => {
      const session = runtime!.session;
      const extension = session.resourceLoader.getExtensions().extensions.find(extension => extension.shortcuts.has('alt+p'))!;
      const keybindings = new KeybindingsManager({ 'app.model.cycleBackward': 'shift+ctrl+p' });
      expect(session.extensionRunner.getShortcuts(keybindings.getEffectiveConfig()).has('alt+p')).toBe(true);
      const replaced = new Promise<void>(resolve => { nextRebind = resolve; });
      await extension.shortcuts.get('alt+p')!.handler(session.extensionRunner.createContext());
      await replaced;
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    await press();
    const privateManager = runtime.session.sessionManager;
    expect(privateManager.isPersisted()).toBe(false);
    expect(privateManager.getSessionFile()).toBeUndefined();
    expect(privateManager.getEntries()).toContainEqual(expect.objectContaining({ type: 'custom', customType: RETURN_ENTRY, data: { sessionFile: originalPath } }));
    expect(privateManager.getEntries().filter(entry => entry.type === 'message')).toHaveLength(0);
    expect((await readdir(join(dir, 'sessions'))).filter(file => file.endsWith('.jsonl'))).toHaveLength(1);
    await press();
    expect(runtime.session.sessionManager.isPersisted()).toBe(true);
    expect(runtime.session.sessionManager.getSessionFile()).toBe(originalPath);
    expect(runtime.session.sessionManager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user')).toBe(true);
    expect(await readFile(originalPath, 'utf8')).toBe(savedContents);
    expect(confirmations).toBe(0);
    expect(requests).toBe(0);
    expect(errors).toEqual([]);
    expect(notices).toContain('Private mode off.');
    expect(existsSync(originalPath)).toBe(true);
  } finally {
    await runtime?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
