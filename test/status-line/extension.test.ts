import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import statusLine from '../../src/status-line/index.ts';
import { defaultConfig } from '../../src/status-line/config.ts';
import { fakeTheme, strip } from './helpers.ts';

type Handler = (event: any, ctx: any) => unknown;

function footerData() {
  const statuses = new Map<string, string>();
  const listeners = new Set<() => void>();
  let unsubscribed = 0;
  return {
    statuses, listeners, unsubscribed: () => unsubscribed,
    provider: {
      getGitBranch: () => 'main',
      getExtensionStatuses: () => statuses,
      getAvailableProviderCount: () => 1,
      onBranchChange: (callback: () => void) => {
        listeners.add(callback);
        return () => { listeners.delete(callback); unsubscribed++; };
      },
    },
  };
}

function context(options: { mode?: string; hasUI?: boolean; sessionId?: string; name?: string } = {}) {
  const { theme } = fakeTheme();
  const notices: [string, string | undefined][] = [];
  const footers: unknown[] = [];
  let mounted: any;
  let editor: any;
  let entriesCalls = 0;
  const entries: any[] = [{
    type: 'message', message: { role: 'assistant', usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
  }];
  const data = footerData();
  let renders = 0;
  const tui = { requestRender: () => { renders++; } };
  let leaf = 'leaf-1';
  const ctx: any = {
    mode: options.mode ?? 'tui',
    hasUI: options.hasUI ?? true,
    cwd: '/tmp/project',
    model: { id: 'test-model', provider: 'test', reasoning: true },
    modelRegistry: { isUsingOAuth: () => false },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 10000, percent: 10 }),
    sessionManager: {
      getSessionId: () => options.sessionId ?? 'session-1',
      getLeafId: () => leaf,
      getEntries: () => { entriesCalls++; return entries; },
      getCwd: () => '/tmp/project',
      getSessionName: () => options.name,
    },
    ui: {
      theme,
      notify: (message: string, type?: string) => notices.push([message, type]),
      setFooter: (factory: any) => {
        mounted?.dispose?.();
        footers.push(factory);
        mounted = factory ? factory(tui, theme, data.provider) : undefined;
      },
      custom: (factory: any) => new Promise(resolve => {
        editor = factory(tui, theme, {}, (value: unknown) => resolve(value));
      }),
    },
  };
  return {
    ctx, notices, footers, data, entries,
    mounted: () => mounted, editor: () => editor, renders: () => renders,
    entriesCalls: () => entriesCalls,
    moveLeaf: (id: string) => { leaf = id; },
    render: (width = 200) => (mounted ? mounted.render(width) : []).map(strip),
  };
}

async function until<T>(read: () => T): Promise<NonNullable<T>> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value) return value as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the editor.');
}

async function harness(configContent?: string, sharedConfigPath?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-status-ext-'));
  const configPath = sharedConfigPath ?? join(dir, 'pi-qol', 'status-line.json');
  if (configContent !== undefined) {
    await import('node:fs/promises').then(fs => fs.mkdir(join(dir, 'pi-qol'), { recursive: true }));
    await writeFile(configPath, configContent);
  }
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  let thinkingLevel = 'medium';
  const pi: any = {
    on: (event: string, handler: Handler) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getThinkingLevel: () => thinkingLevel,
    getSessionName: () => undefined,
  };
  statusLine(pi, { configPath });
  const emit = async (event: string, ctx: any, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  const run = (args: string, ctx: any) => commands.get('statusline').handler(args, ctx);
  const saved = async () => JSON.parse(await readFile(configPath, 'utf8'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { emit, run, saved, cleanup, configPath, dir, commands,
    setThinking: (level: string) => { thinkingLevel = level; } };
}

describe('status line extension', () => {
  test('mounts a colourful footer in the TUI with live Pi data', async () => {
    const h = await harness();
    try {
      const c = context({ name: 'My session' });
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      expect(c.footers).toHaveLength(1);
      const lines = c.render();
      expect(lines[0]).toBe('● ready  test-model  medium  /tmp/project  ⎇ main  “My session”');
      expect(lines[1]).toBe('ctx 90% left of 10k  ↑1.0k ↓200  $0.010');
      h.setThinking('high');
      expect(c.render()[0]).toContain('high');
      expect(c.mounted().render(200)[0]).toContain('\x1b[');
    } finally { await h.cleanup(); }
  });

  test('does not mount a footer in RPC, JSON, or print modes', async () => {
    const h = await harness();
    try {
      for (const options of [{ mode: 'rpc' }, { mode: 'json', hasUI: false }, { mode: 'print', hasUI: false }]) {
        const c = context(options);
        await h.emit('session_start', c.ctx, { reason: 'startup' });
        expect(c.footers).toEqual([]);
      }
      const rpc = context({ mode: 'rpc' });
      await h.run('', rpc.ctx);
      expect(rpc.editor()).toBeUndefined();
      expect(rpc.notices.at(-1)?.[0]).toContain('needs the terminal UI');
    } finally { await h.cleanup(); }
  });

  test('discovers external statuses as they appear, keeping order and hidden keys after they disappear', async () => {
    const h = await harness();
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      c.data.statuses.set('zz-plugin', '\x1b[35mbuild\nok\x1b[0m');
      c.data.statuses.set('aa-plugin', 'lint');
      expect(c.render().at(-1)).toContain('lint  build ok');

      const opened = h.run('', c.ctx);
      const editor = await until(c.editor);
      editor.handleInput('\x1b[F');                              // End: last item, zz-plugin
      editor.handleInput('[');                                   // move it above aa-plugin
      editor.handleInput('\x1b[B');                              // select aa-plugin, now last
      editor.handleInput(' ');                                   // hide it
      editor.handleInput('\r');
      await opened;
      const ids = (await h.saved()).items.map((item: any) => `${item.id}:${item.enabled}`);
      expect(ids.slice(-2)).toEqual(['extension:zz-plugin:true', 'extension:aa-plugin:false']);
      expect(c.render().at(-1)).not.toContain('lint');

      c.data.statuses.clear();
      c.data.statuses.set('new-plugin', 'fresh');
      expect(c.render().at(-1)).toContain('fresh');
      await h.run('mono', c.ctx);
      const after = (await h.saved()).items.map((item: any) => item.id);
      expect(after).toContain('extension:aa-plugin');
      expect(after).toContain('extension:zz-plugin');
      c.data.statuses.set('aa-plugin', 'lint again');
      expect(c.render().join('\n')).not.toContain('lint again');
      expect(c.mounted().render(200).join('')).not.toContain('\x1b');
    } finally { await h.cleanup(); }
  });

  test('off restores the built-in footer, on and colour commands persist, reset repairs', async () => {
    const h = await harness();
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      await h.run('off', c.ctx);
      expect(c.footers.at(-1)).toBeUndefined();
      expect((await h.saved()).enabled).toBe(false);
      const footersAfterOff = c.footers.length;
      await h.run('off', c.ctx);
      expect(c.footers.length).toBe(footersAfterOff); // never clears someone else's footer
      await h.run('on', c.ctx);
      expect(typeof c.footers.at(-1)).toBe('function');
      await h.run('color theme', c.ctx);
      expect((await h.saved()).colorMode).toBe('theme');
      await h.run('bogus', c.ctx);
      expect(c.notices.at(-1)).toEqual([expect.stringContaining('Unknown option'), 'error']);
      await h.run('reset', c.ctx);
      expect(await h.saved()).toEqual(expect.objectContaining({ enabled: true, colorMode: 'colorful' }));
      expect(h.commands.get('statusline').getArgumentCompletions('o').map((item: any) => item.value)).toEqual(['on', 'off']);
    } finally { await h.cleanup(); }
  });

  test('color without a mode shows usage instead of opening the editor or saving', async () => {
    const h = await harness();
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      for (const args of ['color', 'colour', '  COLOR  ']) {
        await h.run(args, c.ctx);
        expect(c.notices.at(-1)).toEqual([expect.stringMatching(/Choose a colour mode\. Use \/statusline colou?r <colorful\|theme\|mono>/), 'error']);
      }
      expect(c.editor()).toBeUndefined();
      await expect(readFile(h.configPath, 'utf8')).rejects.toThrow();
      await h.run('colour mono', c.ctx);
      expect((await h.saved()).colorMode).toBe('mono');
      await h.run('color on', c.ctx);
      expect(c.notices.at(-1)).toEqual([expect.stringContaining('Unknown option "on"'), 'error']);
      await h.run('color theme extra', c.ctx);
      expect(c.notices.at(-1)).toEqual([expect.stringContaining('Too many arguments'), 'error']);
      expect((await h.saved()).colorMode).toBe('mono');
    } finally { await h.cleanup(); }
  });

  test('argument completions offer direct commands and colour modes after color or colour', async () => {
    const h = await harness();
    try {
      const complete = (prefix: string) => h.commands.get('statusline').getArgumentCompletions(prefix)?.map((item: any) => item.value) ?? null;
      expect(complete('')).toEqual(['on', 'off', 'reset', 'status', 'colorful', 'theme', 'mono', 'color', 'colour']);
      expect(complete('col')).toEqual(['colorful', 'color', 'colour']);
      expect(complete('color ')).toEqual(['color colorful', 'color theme', 'color mono']);
      expect(complete('colour m')).toEqual(['colour mono']);
      expect(complete('Color T')).toEqual(['color theme']);
      expect(complete('color x')).toBeNull();
      expect(complete('zzz')).toBeNull();
    } finally { await h.cleanup(); }
  });

  test('a disabled config keeps the built-in footer on startup', async () => {
    const h = await harness(JSON.stringify({ enabled: false }));
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      expect(c.footers).toEqual([]);
    } finally { await h.cleanup(); }
  });

  test('malformed settings are reported once, left untouched, and backed up before overwriting', async () => {
    const h = await harness('{"colorMode": 42');
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      expect(c.footers).toHaveLength(1);
      expect(c.notices.filter(([, type]) => type === 'warning')).toHaveLength(1);
      expect(c.notices[0]![0]).toContain('invalid JSON');
      await h.emit('session_start', c.ctx, { reason: 'new' });
      expect(c.notices.filter(([, type]) => type === 'warning')).toHaveLength(1);
      expect(await readFile(h.configPath, 'utf8')).toBe('{"colorMode": 42');
      await h.run('mono', c.ctx);
      const files = await readdir(join(h.dir, 'pi-qol'));
      const backup = files.find(name => name.includes('.invalid-'));
      expect(backup).toBeDefined();
      expect(await readFile(join(h.dir, 'pi-qol', backup!), 'utf8')).toBe('{"colorMode": 42');
      expect((await h.saved()).colorMode).toBe('mono');
    } finally { await h.cleanup(); }
  });

  test('reset outside the TUI still backs up a malformed file before repairing it', async () => {
    const h = await harness('[1, 2');
    try {
      const c = context({ mode: 'print', hasUI: false });
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      await h.run('reset', c.ctx);
      const backup = (await readdir(join(h.dir, 'pi-qol'))).find(name => name.includes('.invalid-'));
      expect(await readFile(join(h.dir, 'pi-qol', backup!), 'utf8')).toBe('[1, 2');
      expect((await h.saved()).enabled).toBe(true);
      expect(c.footers).toEqual([]);
    } finally { await h.cleanup(); }
  });

  test('editor cancel leaves settings unchanged', async () => {
    const h = await harness();
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      const opened = h.run('', c.ctx);
      await until(c.editor);
      c.editor().handleInput(' ');
      c.editor().handleInput('\x1b');
      c.editor().handleInput('\x1b');
      await opened;
      expect(c.notices.at(-1)?.[0]).toContain('discarded');
      await expect(readFile(h.configPath, 'utf8')).rejects.toThrow();
    } finally { await h.cleanup(); }
  });

  test('uses repaired settings on the next command and editor visit without backing up a valid file as invalid', async () => {
    const h = await harness('{invalid');
    try {
      const c = context();
      await h.emit('session_start', c.ctx);
      const repaired = defaultConfig();
      repaired.items.find(item => item.id === 'model')!.side = 'right';
      repaired.items.find(item => item.id === 'cost')!.enabled = false;
      await writeFile(h.configPath, JSON.stringify(repaired));
      await h.run('mono', c.ctx);
      expect(await h.saved()).toEqual({ ...repaired, colorMode: 'mono' });
      expect((await readdir(join(h.dir, 'pi-qol'))).some(name => name.includes('.invalid-'))).toBe(false);

      repaired.items.find(item => item.id === 'thinking')!.side = 'right';
      await writeFile(h.configPath, JSON.stringify(repaired));
      const opened = h.run('', c.ctx);
      const editor = await until(c.editor);
      expect(editor.render(200).map(strip).join('\n')).toContain('Row 1 · Right');
      editor.handleInput('\r');
      await opened;
      expect((await h.saved()).items.find((item: any) => item.id === 'thinking').side).toBe('right');
      expect((await h.saved()).items.find((item: any) => item.id === 'cost').enabled).toBe(false);
      await h.emit('session_shutdown', c.ctx);
    } finally { await h.cleanup(); }
  });

  test('commands in separate extension instances preserve each other\'s saved layout and settings', async () => {
    const first = await harness(JSON.stringify(defaultConfig()));
    const second = await harness(undefined, first.configPath);
    try {
      const a = context();
      const b = context();
      await first.emit('session_start', a.ctx);
      await second.emit('session_start', b.ctx);
      const opened = first.run('', a.ctx);
      const editor = await until(a.editor);
      for (let i = 0; i < 4; i++) editor.handleInput('\x1b[B'); // model
      editor.handleInput('\x1b[C'); // right
      editor.handleInput('\x1b[F'); // cost
      editor.handleInput(' '); // hidden
      editor.handleInput('\r');
      await opened;
      await second.run('mono', b.ctx);
      await second.run('off', b.ctx);
      await first.run('on', a.ctx);
      const saved = await first.saved();
      expect(saved.colorMode).toBe('mono');
      expect(saved.enabled).toBe(true);
      expect(saved.items.find((item: any) => item.id === 'model').side).toBe('right');
      expect(saved.items.find((item: any) => item.id === 'cost').enabled).toBe(false);
      await first.emit('session_shutdown', a.ctx);
      await second.emit('session_shutdown', b.ctx);
    } finally { await second.cleanup(); await first.cleanup(); }
  });

  test('refuses a stale editor save when the settings file changed while it was open', async () => {
    const h = await harness(JSON.stringify(defaultConfig()));
    try {
      const c = context();
      await h.emit('session_start', c.ctx);
      const opened = h.run('', c.ctx);
      const editor = await until(c.editor);
      editor.handleInput('c');
      const latest = defaultConfig();
      latest.items.find(item => item.id === 'model')!.side = 'right';
      const contents = JSON.stringify(latest);
      await writeFile(h.configPath, contents);
      editor.handleInput('\r');
      await opened;
      expect(await readFile(h.configPath, 'utf8')).toBe(contents);
      expect(c.notices.at(-1)).toEqual([expect.stringContaining('Settings changed while the editor was open'), 'error']);
      await h.emit('session_shutdown', c.ctx);
    } finally { await h.cleanup(); }
  });

  test('editor placement, ordering and colours of external statuses survive a fresh extension load', async () => {
    const config = defaultConfig();
    config.items = config.items.map(item => ({ ...item, enabled: item.id === 'model' || item.id === 'state',
      ...(item.id === 'model' ? { side: 'right' as const } : {}) }));
    const h = await harness(JSON.stringify(config));
    let reopened: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      const c = context();
      c.data.statuses.set('other-plugin', 'plugin');
      await h.emit('session_start', c.ctx);
      const opened = h.run('', c.ctx);
      const editor = await until(c.editor);
      editor.handleInput('\x1b[F'); // new plugin status on row 2, left
      editor.handleInput('\x1b[C'); // right
      editor.handleInput('1'); // row 1
      editor.handleInput('['); // before the model
      editor.handleInput('t'); // red
      editor.handleInput('\r');
      await opened;
      const first = c.render(80)[0];
      expect(first).toStartWith('● ready');
      expect(first).toEndWith('plugin  test-model');
      expect(first.length).toBe(80);
      expect(c.mounted().render(80)[0]).toContain('\x1b[31mplugin\x1b[0m');
      expect((await h.saved()).items.find((item: any) => item.id === 'extension:other-plugin').color).toBe('red');
      reopened = await harness(JSON.stringify(await h.saved()));
      const next = context();
      next.data.statuses.set('other-plugin', 'plugin');
      await reopened.emit('session_start', next.ctx);
      expect(next.render(80)).toEqual(c.render(80));
      expect(next.mounted().render(80)[0]).toContain('\x1b[31mplugin\x1b[0m');
      next.data.statuses.clear();
      expect(next.render(80)[0]).toEndWith('test-model');
      next.data.statuses.set('other-plugin', 'plugin');
      expect(next.render(80)[0]).toBe(first);
      await reopened.emit('session_shutdown', next.ctx);
      await h.emit('session_shutdown', c.ctx);
    } finally { await h.cleanup(); await reopened?.cleanup(); }
  });

  test('caches usage scans between renders until the leaf or an event changes', async () => {
    const h = await harness();
    try {
      const c = context();
      await h.emit('session_start', c.ctx, { reason: 'startup' });
      c.render(); c.render(); c.render();
      expect(c.entriesCalls()).toBe(1);
      c.entries.push({ type: 'usage', usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } });
      c.moveLeaf('leaf-2');
      expect(c.render()[1]).toContain('↑6.0k');
      expect(c.entriesCalls()).toBe(2);
      await h.emit('turn_end', c.ctx);
      c.render();
      expect(c.entriesCalls()).toBe(3);
      const before = c.renders();
      await h.emit('agent_start', c.ctx);
      expect(c.renders()).toBe(before + 1);
    } finally { await h.cleanup(); }
  });

  test('switching sessions uses the new context and disposes the branch listener', async () => {
    const h = await harness();
    try {
      const first = context({ name: 'First' });
      await h.emit('session_start', first.ctx, { reason: 'startup' });
      expect(first.data.listeners.size).toBe(1);
      first.data.listeners.forEach(listener => listener());
      await h.emit('session_shutdown', first.ctx, { reason: 'new' });
      expect(first.render()).toEqual([]); // stale context is never read after shutdown
      expect(first.data.listeners.size).toBe(0);
      expect(first.data.unsubscribed()).toBe(1);
      first.ctx.ui.setFooter(undefined); // Pi resets extension UI on replacement
      expect(first.data.unsubscribed()).toBe(1);
      expect(first.data.listeners.size).toBe(0);

      const second = context({ sessionId: 'session-2', name: 'Second' });
      await h.emit('session_start', second.ctx, { reason: 'new' });
      expect(second.render()[0]).toContain('“Second”');
    } finally { await h.cleanup(); }
  });

  test('repeated session starts release the old branch subscription', async () => {
    const h = await harness();
    try {
      const c = context();
      await h.emit('session_start', c.ctx);
      await h.emit('session_start', c.ctx);
      expect(c.data.listeners.size).toBe(1);
      expect(c.data.unsubscribed()).toBe(1);
      await h.emit('session_shutdown', c.ctx);
      expect(c.data.listeners.size).toBe(0);
      expect(c.data.unsubscribed()).toBe(2);
    } finally { await h.cleanup(); }
  });
});
