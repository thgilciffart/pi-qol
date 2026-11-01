import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import threads, { matchingSessions, deleteFiles } from '../src/threads.ts';

function harness(manager: SessionManager) {
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  let confirmed = true;
  let cancelled = false;
  let hasUI = true;
  let newSessions = 0;
  const choices: (string | undefined)[] = [];
  const ctx: any = { cwd: manager.getCwd(), sessionManager: manager, waitForIdle: async () => {},
    get hasUI() { return hasUI; },
    ui: { notify: (text: string) => notifications.push(text), confirm: async () => confirmed,
      select: async (_: string, labels: string[]) => { const choice = choices.shift(); return choice === 'first' ? labels[4] : choice; } },
    newSession: async (options: any) => {
      newSessions++;
      if (cancelled) return { cancelled: true };
      // The old file must exist until the host has switched sessions.
      if (manager.getSessionFile()) await readFile(manager.getSessionFile()!);
      await options.withSession(ctx);
      return { cancelled: false };
    },
  };
  threads({ registerCommand: (name: string, spec: any) => commands.set(name, spec) } as any);
  return { choices, notifications, run: (name: string, args = '') => commands.get(name).handler(args, ctx),
    decline: () => { confirmed = false; }, cancelSwitch: () => { cancelled = true; },
    noUI: () => { hasUI = false; }, get newSessions() { return newSessions; } };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-delete-'));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: 'user', content: 'current', timestamp: Date.now() });
  return { dir, manager, file: manager.getSessionFile()! };
}

test('current thread is deleted only after a successful session switch', async () => {
  const { dir, manager, file } = await fixture();
  try {
    const declined = harness(manager); declined.decline(); await declined.run('delete');
    expect(declined.newSessions).toBe(0); expect(await readFile(file, 'utf8')).toContain('current');
    const cancelled = harness(manager); cancelled.cancelSwitch(); await cancelled.run('delete');
    expect(await readFile(file, 'utf8')).toContain('current');
    await harness(manager).run('delete');
    await expect(readFile(file)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bulk deletion toggles selection, preserves the current thread, and cancels safely', async () => {
  const { dir, manager, file } = await fixture();
  try {
    const other = SessionManager.create(dir, dir);
    other.appendMessage({ role: 'user', content: 'other', timestamp: Date.now() });
    const cancelled = harness(manager); cancelled.choices.push('Select all matches', undefined);
    await cancelled.run('delete-threads'); expect(await readFile(other.getSessionFile()!, 'utf8')).toContain('other');
    const h = harness(manager); h.choices.push('first', 'Delete selected (1)');
    await h.run('delete-threads', 'other');
    await expect(readFile(other.getSessionFile()!)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toContain('current');
    expect(h.notifications[0]).toBe('Deleted 1 saved thread.');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deletion refuses headless calls', async () => {
  const h = harness(SessionManager.inMemory()); h.noUI();
  await h.run('delete'); await h.run('delete-threads');
  expect(h.newSessions).toBe(0); expect(h.notifications).toHaveLength(2);
});

test('file failures are reported without stopping the batch, and paths are deduplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-files-'));
  try {
    const file = join(dir, 'saved.jsonl'); await writeFile(file, 'saved');
    const result = await deleteFiles([join(dir, 'missing'), file, file]);
    expect(result.deleted).toBe(1); expect(result.failures).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('matching excludes current and searches names, prompts, directories, and IDs', () => {
  const sessions = [{ path: '/a', name: 'Example', firstMessage: '', cwd: '/project', id: '123' }];
  expect(matchingSessions(sessions as any, '/a', '')).toHaveLength(0);
  for (const query of ['EXAMPLE', 'project', '123']) expect(matchingSessions(sessions as any, undefined, query)).toHaveLength(1);
});
