import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import qol from '../index.ts';
import qolCommand from '../src/qol/index.ts';
import { parseQolArgs, qolCompletions } from '../src/qol/commands.ts';
import {
  defaultQolConfig, expandFeatures, loadQolConfig, loadQolConfigSync, sameFeatures,
  saveQolConfig, storeFeatures, validateQolConfig,
} from '../src/qol/config.ts';
import { FEATURES, resolveTarget, targetChoices } from '../src/qol/features.ts';
import { createCommandRegistry, wrapCommandRegistration } from '../src/qol/registry.ts';
import { fakeTheme, strip } from './status-line/helpers.ts';

const ALL_COMMANDS = ['better-export', 'ephemeral', 'delete', 'delete-threads', 'open', 'goal', 'auto-name', 'continue', 'statusline', 'plugins', 'qol'];
const ALL_TOOLS = ['get_goal', 'create_goal', 'update_goal', 'ask_user'];
const ALL_SHORTCUTS = ['ctrl+alt+c', 'alt+p', 'alt+,', 'alt+.'];

function mockPi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const events = new Map<string, any[]>();
  const pi = new Proxy({}, {
    get(_target, property) {
      switch (property) {
        case 'registerCommand': return (name: string, command: any) => commands.set(name, command);
        case 'registerTool': return (tool: any) => tools.set(tool.name, tool);
        case 'registerShortcut': return (id: string, shortcut: any) => shortcuts.set(String(id), shortcut);
        case 'on': return (event: string, handler: any) => events.set(event, [...(events.get(event) ?? []), handler]);
        case 'getSessionName': return () => undefined;
        case 'getThinkingLevel': return () => 'high';
        case 'events': return { emit: () => undefined, on: () => () => undefined };
        default: return () => undefined;
      }
    },
  });
  const emit = async (event: string, ctx: any, data: any = {}) => {
    for (const handler of events.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  return { pi: pi as never, commands, tools, shortcuts, events, emit };
}

interface MockCtxOptions {
  hasUI?: boolean;
  mode?: string;
  idle?: boolean;
  pending?: boolean;
  reloadError?: string;
}

function mockCtx(dir: string, options: MockCtxOptions = {}) {
  const notifications: { message: string; type?: string }[] = [];
  const customComponents: any[] = [];
  const customActions: ((component: any) => void)[] = [];
  let reloads = 0;
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? 'tui',
    cwd: dir,
    isIdle: () => options.idle ?? true,
    hasPendingMessages: () => options.pending ?? false,
    reload: async () => {
      if (options.reloadError) throw new Error(options.reloadError);
      reloads++;
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      custom: async (factory: any) => new Promise(resolve => {
        let component: any;
        const done = (value: unknown) => { component?.dispose?.(); resolve(value); };
        component = factory({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, fakeTheme().theme, {}, done);
        customComponents.push(component);
        const action = customActions.shift();
        if (action) action(component);
        else component.handleInput('\x1b');
      }),
    },
  };
  return {
    ctx: ctx as any, notifications, customComponents, customActions,
    reloads: () => reloads,
  };
}

async function harness(options: { config?: unknown; raw?: string } & MockCtxOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-'));
  const configPath = join(dir, 'nested', 'qol.json');
  if (options.raw !== undefined) {
    await saveQolConfig(configPath, defaultQolConfig()); // create the directory
    await writeFile(configPath, options.raw);
  } else if (options.config !== undefined) {
    await saveQolConfig(configPath, options.config as never);
  }
  const host = mockPi();
  const session = mockCtx(dir, options);
  qol(host.pi, { configPath });
  const run = (args = '') => host.commands.get('qol').handler(args, session.ctx);
  return {
    dir, configPath, host, session, run,
    readConfig: () => loadQolConfig(configPath),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('qol settings file', () => {
  test('a missing file means every feature on, and settings round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-config-'));
    const path = join(dir, 'qol.json');
    try {
      const missing = await loadQolConfig(path);
      expect(missing.status).toBe('missing');
      expect(expandFeatures(missing.config)).toEqual(Object.fromEntries(FEATURES.map(feature => [feature.id, true])));
      await saveQolConfig(path, { version: 1, features: { 'auto-name': false } });
      const loaded = await loadQolConfig(path);
      expect(loaded.status).toBe('ok');
      expect(loaded.config).toEqual({ version: 1, features: { 'auto-name': false } });
      expect(expandFeatures(loaded.config)['auto-name']).toBe(false);
      expect(expandFeatures(loaded.config)['goal']).toBe(true);
      expect(loadQolConfigSync(path)).toEqual(loaded);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('malformed and invalid files are reported, never rewritten, and backed up on save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-invalid-'));
    const path = join(dir, 'qol.json');
    try {
      for (const raw of ['{broken', 'null', '{"version":2}', '{"features":{"nope":true}}', '{"features":{"goal":"yes"}}', '{"features":[]}']) {
        await writeFile(path, raw);
        const result = await loadQolConfig(path);
        expect(result.status).toBe('invalid');
        expect(expandFeatures(result.config)['goal']).toBe(true);
        expect(await readFile(path, 'utf8')).toBe(raw);
      }
      await writeFile(path, '{broken');
      const backup = await saveQolConfig(path, { version: 1, features: { threads: false } }, { backupExisting: true });
      expect(backup).toMatch(/qol\.json\.invalid-\d+$/);
      expect(await readFile(backup!, 'utf8')).toBe('{broken');
      expect((await loadQolConfig(path)).config).toEqual({ version: 1, features: { threads: false } });
      const backups = (await readdir(dir)).filter(name => name.includes('.invalid-'));
      expect(backups).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('unknown features fail validation with the valid choices', () => {
    expect(() => validateQolConfig({ features: { agent: false } })).toThrow(/not a bundled feature.*auto-name/);
  });

  test('sparse storage only lists disabled features and compares by expanded state', () => {
    const all = Object.fromEntries(FEATURES.map(feature => [feature.id, true])) as never;
    expect(storeFeatures(expandFeaturesAll(all))).toEqual(defaultQolConfig());
    const some = { ...Object.fromEntries(FEATURES.map(feature => [feature.id, true])), goal: false, metrics: false } as never;
    expect(storeFeatures(expandFeaturesAll(some))).toEqual({ version: 1, features: { goal: false, metrics: false } });
    expect(sameFeatures(defaultQolConfig(), { version: 1, features: {} })).toBe(true);
    expect(sameFeatures(defaultQolConfig(), { version: 1, features: { goal: false } })).toBe(false);
  });

  function expandFeaturesAll(map: Record<string, boolean>) {
    return map as ReturnType<typeof expandFeatures>;
  }
});

describe('/qol argument parsing and completions', () => {
  test('parses editor, status, reset, and on/off targets', () => {
    expect(parseQolArgs('')).toEqual({ kind: 'editor' });
    expect(parseQolArgs('  ')).toEqual({ kind: 'editor' });
    expect(parseQolArgs('status')).toEqual({ kind: 'status' });
    expect(parseQolArgs('reset')).toEqual({ kind: 'reset' });
    expect(parseQolArgs('off auto-name')).toEqual({ kind: 'set', enabled: false, target: { kind: 'feature', id: 'auto-name' } });
    expect(parseQolArgs('enable plugins')).toEqual({ kind: 'set', enabled: true, target: { kind: 'feature', id: 'plugins' } });
    expect(parseQolArgs('off domain:display')).toEqual({ kind: 'set', enabled: false, target: { kind: 'domain', id: 'display' } });
    expect(parseQolArgs('on agent')).toEqual({ kind: 'set', enabled: true, target: { kind: 'domain', id: 'agent' } });
  });

  test('a bare word matching a feature wins over the same-named domain', () => {
    expect(resolveTarget('threads')).toEqual({ kind: 'feature', id: 'threads' });
    expect(resolveTarget('domain:threads')).toEqual({ kind: 'domain', id: 'threads' });
    expect(resolveTarget('domain:nope')).toBeUndefined();
    expect(targetChoices()).toContain('domain:tools');
  });

  test('rejects bad usage with a readable message', () => {
    expect(() => parseQolArgs('on')).toThrow(/Usage/);
    expect(() => parseQolArgs('status extra')).toThrow(/Usage/);
    expect(() => parseQolArgs('off auto-name extra')).toThrow(/Usage/);
    expect(() => parseQolArgs('bogus')).toThrow(/Usage/);
    expect(() => parseQolArgs('off unknown-thing')).toThrow(/Unknown feature or domain "unknown-thing".*auto-name/);
  });

  test('completes verbs and targets', () => {
    expect(qolCompletions('st')![0].value).toBe('status');
    expect(qolCompletions('off au')!.map(item => item.value)).toEqual(['off auto-name']);
    expect(qolCompletions('on domain:d')!.map(item => item.value)).toEqual(['on domain:display']);
    expect(qolCompletions('status x')).toBeNull();
  });
});

describe('command handler collection', () => {
  test('wrapping forwards registration and records the handler per feature', () => {
    const registry = createCommandRegistry();
    const registered = new Map<string, any>();
    const pi = {
      registerCommand: (name: string, command: any) => registered.set(name, command),
      on: () => undefined,
      marker: 42,
    };
    const wrapped = wrapCommandRegistration(pi as never, 'auto-name', registry);
    const handler = async () => undefined;
    wrapped.registerCommand('auto-name', { description: 'Configure', handler });
    expect(registered.get('auto-name').handler).toBe(handler);
    expect(registry.command('auto-name', 'auto-name')!.handler).toBe(handler);
    expect(registry.commands('auto-name')).toEqual(['auto-name']);
    expect(registry.command('threads', 'auto-name')).toBeUndefined();
    expect((wrapped as any).marker).toBe(42);
    expect(typeof (wrapped as any).on).toBe('function');
  });
});

describe('selective registration at extension load', () => {
  test('with no settings file every feature and /qol register', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-load-'));
    try {
      const host = mockPi();
      qol(host.pi, { configPath: join(dir, 'qol.json') });
      expect([...host.commands.keys()].sort()).toEqual([...ALL_COMMANDS].sort());
      expect([...host.tools.keys()].sort()).toEqual([...ALL_TOOLS].sort());
      expect([...host.shortcuts.keys()].sort()).toEqual([...ALL_SHORTCUTS].sort());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('disabled features lose their commands, tools, and shortcuts while /qol stays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-load-'));
    try {
      const configPath = join(dir, 'qol.json');
      await saveQolConfig(configPath, { version: 1, features: { threads: false, goal: false, 'ask-questions': false, ephemeral: false, continue: false, thinking: false } });
      const host = mockPi();
      qol(host.pi, { configPath });
      expect([...host.commands.keys()].sort()).toEqual(['auto-name', 'better-export', 'plugins', 'qol', 'statusline']);
      expect(host.tools.size).toBe(0);
      expect(host.shortcuts.size).toBe(0);
      const events = [...host.events.keys()];
      expect(events).toContain('session_start'); // qol's own load-error reporter
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('a malformed settings file keeps every feature on and warns once per session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-load-'));
    try {
      const configPath = join(dir, 'qol.json');
      await writeFile(configPath, '{broken');
      const host = mockPi();
      qol(host.pi, { configPath });
      expect(host.commands.size).toBe(ALL_COMMANDS.length);
      const session = mockCtx(dir);
      // Only qol's own reporter runs; other modules' session handlers need a fuller ctx.
      const reporter = host.events.get('session_start')!.at(-1)!;
      await reporter({ type: 'session_start' }, session.ctx);
      await reporter({ type: 'session_start' }, session.ctx);
      const warnings = session.notifications.filter(item => item.type === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain('invalid JSON');
      expect(warnings[0]!.message).toContain('Every bundled feature is on');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('/qol status and headless use', () => {
  test('status lists every domain with feature states and the settings path', async () => {
    const h = await harness({ config: { version: 1, features: { 'auto-name': false } } });
    try {
      await h.run('status');
      const note = h.session.notifications.at(-1)!;
      expect(note.type).toBe('info');
      expect(note.message).toContain('pi-qol bundled features: 10 of 11 on');
      expect(note.message).toContain('Threads: Thread management on, Automatic naming off, Ephemeral chats on');
      expect(note.message).toContain('Display: Status line on, Response metrics on');
      expect(note.message).toContain(`Settings: ${h.configPath}`);
      expect(note.message).toContain('domain:<name>');
    } finally { await h.cleanup(); }
  });

  test('bare /qol without a UI prints status instead of opening the editor', async () => {
    const h = await harness({ hasUI: false });
    try {
      await h.run();
      const note = h.session.notifications.at(-1)!;
      expect(note.message).toContain('pi-qol bundled features: 11 of 11 on');
      expect(note.message).toContain('needs the terminal UI');
    } finally { await h.cleanup(); }
  });

  test('a malformed file keeps status readable and points at the problem', async () => {
    const h = await harness({ raw: '{broken' });
    try {
      await h.run('status');
      const note = h.session.notifications.at(-1)!;
      expect(note.message).toContain('11 of 11 on');
      expect(note.message).toContain('Settings file problem:');
      expect(note.message).toContain('the file was not changed');
    } finally { await h.cleanup(); }
  });
});

describe('/qol on, off, and reset', () => {
  test('off then on a feature persists sparse settings and reloads each time', async () => {
    const h = await harness();
    try {
      await h.run('off auto-name');
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { 'auto-name': false } });
      expect(h.session.notifications.at(-1)!.message).toBe('Automatic naming off.');
      expect(h.session.reloads()).toBe(1);
      await h.run('on auto-name');
      expect((await h.readConfig()).config).toEqual(defaultQolConfig());
      expect(h.session.notifications.at(-1)!.message).toBe('Automatic naming on.');
      expect(h.session.reloads()).toBe(2);
    } finally { await h.cleanup(); }
  });

  test('domain targets toggle every feature in the domain', async () => {
    const h = await harness();
    try {
      await h.run('off domain:display');
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { 'status-line': false, metrics: false } });
      expect(h.session.notifications.at(-1)!.message).toBe('Display domain off.');
      await h.run('on domain:display');
      expect((await h.readConfig()).config).toEqual(defaultQolConfig());
    } finally { await h.cleanup(); }
  });

  test('no-op toggles skip saving and reloading', async () => {
    const h = await harness({ config: { version: 1, features: { goal: false } } });
    try {
      await h.run('off goal');
      expect(h.session.notifications.at(-1)!.message).toBe('Goals is already off.');
      expect(h.session.reloads()).toBe(0);
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { goal: false } });
      await h.run('reset');
      expect((await h.readConfig()).config).toEqual(defaultQolConfig());
      expect(h.session.reloads()).toBe(1);
      await h.run('reset');
      expect(h.session.notifications.at(-1)!.message).toBe('Every bundled feature is already on.');
      expect(h.session.reloads()).toBe(1);
    } finally { await h.cleanup(); }
  });

  test('unknown targets and bad usage report errors without touching the file', async () => {
    const h = await harness();
    try {
      await h.run('off nope');
      await h.run('on');
      const errors = h.session.notifications.filter(item => item.type === 'error');
      expect(errors).toHaveLength(2);
      expect(errors[0]!.message).toContain('Unknown feature or domain "nope"');
      expect(errors[1]!.message).toContain('Usage');
      expect((await h.readConfig()).status).toBe('missing');
      expect(h.session.reloads()).toBe(0);
    } finally { await h.cleanup(); }
  });

  test('a malformed file is backed up, replaced, and still reloads', async () => {
    const h = await harness({ raw: '{broken' });
    try {
      await h.run('off metrics');
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { metrics: false } });
      const backups = (await readdir(join(h.dir, 'nested'))).filter(name => name.includes('.invalid-'));
      expect(backups).toHaveLength(1);
      expect(await readFile(join(h.dir, 'nested', backups[0]!), 'utf8')).toBe('{broken');
      expect(h.session.notifications.some(item => item.message.includes('Kept a copy of the previous invalid settings'))).toBe(true);
      expect(h.session.reloads()).toBe(1);
    } finally { await h.cleanup(); }
  });

  test('a busy session saves but asks for a manual reload', async () => {
    const h = await harness({ idle: false });
    try {
      await h.run('off goal');
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { goal: false } });
      expect(h.session.reloads()).toBe(0);
      expect(h.session.notifications.at(-1)!.message).toContain('Run /reload when Pi is idle');
    } finally { await h.cleanup(); }
  });

  test('a failed reload keeps the saved settings and says so', async () => {
    const h = await harness({ reloadError: 'runtime busy' });
    try {
      await h.run('off goal');
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { goal: false } });
      const note = h.session.notifications.at(-1)!;
      expect(note.type).toBe('error');
      expect(note.message).toContain('reload failed: runtime busy');
    } finally { await h.cleanup(); }
  });
});

describe('/qol settings editor through the command', () => {
  test('nested settings retain position and unsaved choices and defer reload until the editor closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-nested-'));
    try {
      const host = mockPi();
      const session = mockCtx(dir);
      const registry = createCommandRegistry();
      registry.add('plugins', 'plugins', { name: 'plugins', handler: async (_args, ctx) => { await ctx.reload(); } });
      const configPath = join(dir, 'qol.json');
      qolCommand(host.pi, { configPath, registry });
      session.customActions.push(component => {
        component.handleInput(' '); // Turn off thread management in the draft.
        for (let i = 0; i < 3; i++) component.handleInput('\t');
        component.handleInput('\x1b[B'); // Plugins.
        component.handleInput('\x1b[B'); // Plugin settings.
        component.handleInput('\r');
      });
      session.customActions.push(component => {
        expect(session.reloads()).toBe(0);
        const frame = component.render(120).map(strip).join('\n');
        expect(frame).toContain('Unsaved changes');
        expect(frame.split('\n').find((line: string) => line.includes('❯'))).toContain('Plugin manager settings');
        component.handleInput('s');
      });
      await host.commands.get('qol').handler('', session.ctx);
      expect((await loadQolConfig(configPath)).config.features.threads).toBe(false);
      expect(session.reloads()).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('cancelling feature edits still applies saved nested settings that requested reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-nested-'));
    try {
      const host = mockPi();
      const session = mockCtx(dir);
      const registry = createCommandRegistry();
      registry.add('plugins', 'plugins', { name: 'plugins', handler: async (_args, ctx) => { await ctx.reload(); } });
      const configPath = join(dir, 'qol.json');
      qolCommand(host.pi, { configPath, registry });
      session.customActions.push(component => {
        component.handleInput(' ');
        for (let i = 0; i < 3; i++) component.handleInput('\t');
        component.handleInput('\x1b[B');
        component.handleInput('\x1b[B');
        component.handleInput('\r');
      });
      session.customActions.push(component => {
        component.handleInput('\x1b');
        expect(component.render(120).map(strip).join('\n')).toContain('Press Esc again to discard');
        component.handleInput('\x1b');
      });
      await host.commands.get('qol').handler('', session.ctx);
      expect((await loadQolConfig(configPath)).status).toBe('missing');
      expect(session.reloads()).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('saving the editor persists toggles and reloads; cancelling changes nothing', async () => {
    const h = await harness();
    try {
      h.session.customActions.push(component => { component.handleInput(' '); component.handleInput('s'); });
      await h.run();
      expect((await h.readConfig()).config).toEqual({ version: 1, features: { threads: false } });
      expect(h.session.notifications.some(item => item.message === 'pi-qol settings saved.')).toBe(true);
      expect(h.session.reloads()).toBe(1);
      h.session.customActions.push(component => component.handleInput('\x1b'));
      await h.run();
      expect(h.session.notifications.at(-1)!.message).toBe('pi-qol feature changes discarded.');
      expect(h.session.reloads()).toBe(1);
    } finally { await h.cleanup(); }
  });

  test('saving without changes skips the reload', async () => {
    const h = await harness();
    try {
      h.session.customActions.push(component => component.handleInput('s'));
      await h.run();
      expect(h.session.notifications.at(-1)!.message).toBe('pi-qol settings unchanged.');
      expect(h.session.reloads()).toBe(0);
    } finally { await h.cleanup(); }
  });

  test('the edit action reuses the registered auto-name handler and reopens the editor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-edit-'));
    const configPath = join(dir, 'qol.json');
    try {
      const host = mockPi();
      const session = mockCtx(dir);
      const registry = createCommandRegistry();
      const calls: string[] = [];
      registry.add('auto-name', 'auto-name', { name: 'auto-name', handler: async args => { calls.push(args); } });
      qolCommand(host.pi, { configPath, registry });
      // Threads tab rows: Thread management, Automatic naming, ⚙ settings, Ephemeral chats.
      session.customActions.push(component => {
        component.handleInput('\x1b[B');
        component.handleInput('\x1b[B');
        component.handleInput('\r');
      });
      session.customActions.push(component => component.handleInput('\x1b'));
      await host.commands.get('qol').handler('', session.ctx);
      expect(calls).toEqual(['']);
      expect(session.customComponents).toHaveLength(2);
      expect(session.notifications.at(-1)!.message).toBe('pi-qol feature changes discarded.');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('a disabled feature has no registered handler, so edit explains instead of failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-qol-edit-'));
    const configPath = join(dir, 'qol.json');
    try {
      const host = mockPi();
      const session = mockCtx(dir);
      const rendered: string[] = [];
      qolCommand(host.pi, { configPath, registry: createCommandRegistry() });
      session.customActions.push(component => {
        component.handleInput('\x1b[B');
        component.handleInput('\x1b[B');
        component.handleInput('\r');
        rendered.push(component.render(100).map(strip).join('\n'));
        component.handleInput('\x1b');
      });
      await host.commands.get('qol').handler('', session.ctx);
      expect(rendered[0]).toContain('settings open when the feature is enabled');
      expect(session.notifications.at(-1)!.message).toBe('pi-qol feature changes discarded.');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
