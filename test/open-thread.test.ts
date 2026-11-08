import { test, expect } from 'bun:test';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import threads from '../src/threads.ts';
import { ThreadTranscript } from '../src/thread-transcript.ts';

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text,
  italic: (text: string) => text, strikethrough: (text: string) => text, underline: (text: string) => text } as any;
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

type Step = string | ((state: { picker: any; overlays: any[] }) => void | Promise<void>);

/** A command context whose `ui.custom` behaves like Pi's: the promise settles when the component calls `done`. */
function harness(manager: SessionManager, options: { mode?: string; hasUI?: boolean } = {}) {
  const commands = new Map<string, any>();
  const notifications: { text: string; level?: string }[] = [];
  const events: string[] = [];
  const steps: Step[] = [];
  const overlays: any[] = [];
  const switched: string[] = [];
  let switchResult: () => Promise<{ cancelled: boolean }> = async () => ({ cancelled: false });
  let idleWaits = 0;
  let picker: any;
  const tui = { requestRender() {}, terminal: { rows: 30, columns: 120 } };
  const ctx: any = { mode: options.mode ?? 'tui', hasUI: options.hasUI ?? true, cwd: manager.getCwd(), sessionManager: manager,
    waitForIdle: async () => { idleWaits++; events.push('idle'); },
    ui: {
      notify: (text: string, level?: string) => notifications.push({ text, level }),
      custom: (factory: any, customOptions?: any) => new Promise(resolve => {
        if (customOptions?.overlay) {
          // The transcript viewer opens as a nested overlay in the regular renderer.
          let closed = false;
          const component = factory(tui, theme, {}, () => { closed = true; resolve(undefined); });
          overlays.push({ component, options: customOptions, get closed() { return closed; } });
          return;
        }
        events.push('picker-open');
        picker = factory(tui, theme, {}, (value: unknown) => { events.push('picker-closed'); picker.dispose(); resolve(value); });
        void (async () => {
          for (const step of steps) {
            if (typeof step === 'string') picker.handleInput(step);
            else await step({ picker, overlays });
            await tick();
          }
        })();
      }),
    },
    switchSession: async (path: string) => {
      events.push('switch'); switched.push(path);
      return switchResult();
    },
  };
  threads({ registerCommand: (name: string, spec: any) => commands.set(name, spec) } as any);
  return { commands, steps, notifications, events, overlays, switched,
    get idleWaits() { return idleWaits; },
    text: () => stripTerminalSequences(picker.render(120).join('\n')),
    onSwitch: (result: () => Promise<{ cancelled: boolean }>) => { switchResult = result; },
    run: (args = '') => commands.get('open').handler(args, ctx) as Promise<void> };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-open-'));
  const thread = (text: string) => {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `${text} reply` }], api: 'test', provider: 'test',
      model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as any);
    return manager;
  };
  const other = thread('other thread');
  await tick(10);
  const current = thread('current thread');
  return { dir, current, other, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('/open is registered beside /delete-threads and does not replace /resume', () => {
  const h = harness(SessionManager.inMemory());
  expect([...h.commands.keys()].sort()).toEqual(['delete', 'delete-threads', 'open']);
  expect(h.commands.get('open').description).toMatch(/resume an existing thread/i);
});

test('enter closes the picker before switching to the highlighted thread, and the current thread is not listed', async () => {
  const f = await fixture();
  try {
    const h = harness(f.current);
    h.steps.push(({ picker }) => {
      const text = stripTerminalSequences(picker.render(120).join('\n'));
      expect(text).toContain('Open thread (Current project)');
      expect(text).toContain('other thread');
      expect(text).not.toContain('current thread');
      expect(text).not.toMatch(/\[[ x]\]|selected/);
    }, '\r');
    await h.run();
    expect(h.switched).toEqual([f.other.getSessionFile()!]);
    expect(h.events).toEqual(['idle', 'picker-open', 'picker-closed', 'idle', 'switch']);
    expect(h.notifications).toEqual([]);
  } finally { await f.cleanup(); }
});

test('the search argument prefills the picker and escape cancels without switching', async () => {
  const f = await fixture();
  try {
    const h = harness(f.current);
    h.steps.push(({ picker }) => {
      const text = stripTerminalSequences(picker.render(120).join('\n'));
      expect(text).toContain('> nothing matches');
      expect(text).toContain('No matching threads');
    }, '\r', '\x1b');
    await h.run('nothing matches');
    expect(h.switched).toEqual([]);
    expect(h.events).toEqual(['idle', 'picker-open', 'picker-closed']);
    expect(h.notifications).toEqual([]);
  } finally { await f.cleanup(); }
});

test('open mode has no deletion or selection keys, so no files are removed', async () => {
  const f = await fixture();
  try {
    const h = harness(f.current);
    // Ctrl+A moves the search cursor to the start, and Ctrl+D deletes the space after it.
    h.steps.push(' ', 'z', '\x01', '\x04', ({ picker }) => {
      const text = stripTerminalSequences(picker.render(120).join('\n'));
      expect(text).not.toContain('Permanently delete');
      expect(text).toContain('> z');
      expect(text).toContain('No matching threads');
    }, '\r', '\x1b');
    await h.run();
    // The keys edited the search, so Enter found no match and did not switch.
    expect(h.switched).toEqual([]);
    expect(await Bun.file(f.other.getSessionFile()!).exists()).toBe(true);
    expect(await Bun.file(f.current.getSessionFile()!).exists()).toBe(true);
  } finally { await f.cleanup(); }
});

test('a cancelled switch is reported, and switch errors are reported without throwing', async () => {
  const f = await fixture();
  try {
    const cancelled = harness(f.current);
    cancelled.onSwitch(async () => ({ cancelled: true }));
    cancelled.steps.push('\r');
    await cancelled.run();
    expect(cancelled.notifications).toEqual([{ text: 'Opening the thread was cancelled.', level: 'info' }]);

    const failed = harness(f.current);
    failed.onSwitch(async () => { throw new Error('session is locked'); });
    failed.steps.push('\r');
    await failed.run();
    expect(failed.notifications).toEqual([{ text: 'Could not open thread: session is locked', level: 'error' }]);
  } finally { await f.cleanup(); }
});

test('a thread deleted while the picker is open is reported instead of switching', async () => {
  const f = await fixture();
  try {
    const h = harness(f.current);
    h.steps.push(async () => { await unlink(f.other.getSessionFile()!); }, '\r');
    await h.run();
    expect(h.switched).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].level).toBe('error');
    expect(h.notifications[0].text).toContain(`Could not open thread ${f.other.getSessionFile()}`);
  } finally { await f.cleanup(); }
});

test('ctrl+t shows the highlighted transcript, and enter after closing it still opens the thread', async () => {
  const f = await fixture();
  try {
    const h = harness(f.current);
    h.steps.push('\x14', async ({ overlays }) => {
      await tick(20);
      expect(overlays).toHaveLength(1);
      expect(overlays[0].options.overlay).toBe(true);
      expect(overlays[0].component).toBeInstanceOf(ThreadTranscript);
      expect(stripTerminalSequences(overlays[0].component.render(100).join('\n'))).toContain('other thread reply');
      expect(h.switched).toEqual([]);
      overlays[0].component.handleInput('\x1b');
      expect(overlays[0].closed).toBe(true);
    }, '\r');
    await h.run();
    expect(h.switched).toEqual([f.other.getSessionFile()!]);
  } finally { await f.cleanup(); }
});

test('/open refuses headless and non-terminal UI modes', async () => {
  const headless = harness(SessionManager.inMemory(), { hasUI: false });
  await headless.run();
  expect(headless.notifications).toEqual([{ text: 'Opening a thread requires an interactive UI. Use /resume instead.', level: 'error' }]);
  const rpc = harness(SessionManager.inMemory(), { mode: 'rpc' });
  await rpc.run();
  expect(rpc.notifications).toEqual([{ text: 'The thread picker requires the terminal UI.', level: 'error' }]);
  expect(headless.idleWaits + rpc.idleWaits).toBe(0);
});

test('a session listing failure is reported and no picker opens', async () => {
  const manager = SessionManager.inMemory();
  const h = harness(manager);
  const original = SessionManager.list;
  (SessionManager as any).list = async () => { throw new Error('disk unavailable'); };
  try { await h.run(); } finally { (SessionManager as any).list = original; }
  expect(h.events).toEqual(['idle']);
  expect(h.notifications).toEqual([{ text: 'Could not show threads: disk unavailable', level: 'error' }]);
});
