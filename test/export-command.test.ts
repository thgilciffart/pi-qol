import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { exportCommand } from '../src/export/index.ts';
import { TEMP_EXPORT_ROOT } from '../src/export/target.ts';

const { getThemeByName } = await import(pathToFileURL(join(getPackageDir(), 'dist/modes/interactive/theme/theme.js')).href);
initTheme('dark');

const pi = { getAllTools: () => [] } as any;

function context(dir: string, sessionManager: SessionManager, ui: Record<string, unknown> = {}, hasUI = true) {
  const notices: { message: string; type?: string }[] = [];
  const prompts: string[] = [];
  const ctx = {
    cwd: dir, sessionManager, hasUI, getSystemPrompt: () => '',
    ui: {
      theme: getThemeByName('dark'),
      notify: (message: string, type?: string) => notices.push({ message, type }),
      confirm: async (title: string) => { prompts.push(title); return false; },
      select: async (_title: string, choices: string[]) => choices[0],
      ...ui,
    },
  };
  return { ctx: ctx as any, notices, prompts };
}

async function withSession(run: (dir: string, sm: SessionManager) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-export-command-'));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: 'user', content: 'Hello', timestamp: Date.now() });
    await run(dir, sm);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const noStaging = async (dir: string) => assert.ok(!(await readdir(dir)).some(name => name.startsWith('.pi-better-export-')));

test('in-memory sessions explain that HTML export needs a saved session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-export-memory-'));
  try {
    const sm = SessionManager.inMemory(dir);
    sm.appendMessage({ role: 'user', content: 'Hello', timestamp: Date.now() });
    const { ctx, notices } = context(dir, sm);
    await exportCommand(pi, 'out.html', ctx);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, 'error');
    assert.match(notices[0].message, /needs a saved session/);
    assert.doesNotMatch(notices[0].message, /Start a conversation/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('headless export refuses to replace an existing file or run a redaction preview', async () => {
  await withSession(async (dir, sm) => {
    const file = join(dir, 'existing.html');
    await writeFile(file, 'original');
    const { ctx, notices } = context(dir, sm, {}, false);
    await exportCommand(pi, 'existing.html', ctx);
    assert.match(notices.at(-1)!.message, /^Export failed: File already exists: /);
    await exportCommand(pi, '--redact fresh.html', ctx);
    assert.match(notices.at(-1)!.message, /Redaction preview requires an interactive Pi UI/);
    assert.equal(await readFile(file, 'utf8'), 'original');
    assert.ok(!(await readdir(dir)).includes('fresh.html'));
    await noStaging(dir);
  });
});

test('declining replacement keeps the file and writes nothing', async () => {
  await withSession(async (dir, sm) => {
    const file = join(dir, 'existing.html');
    await writeFile(file, 'original');
    const { ctx, notices, prompts } = context(dir, sm);
    await exportCommand(pi, 'existing.html', ctx);
    assert.deepEqual(prompts, ['Replace existing export?']);
    assert.deepEqual(notices, []);
    assert.equal(await readFile(file, 'utf8'), 'original');
    await noStaging(dir);
  });
});

test('temporary export uses an isolated directory and keeps only the requested basename', async () => {
  await withSession(async (dir, sm) => {
    const { ctx, notices } = context(dir, sm, { select: async (_title: string, choices: string[]) => choices[1] });
    await exportCommand(pi, '"exports/My reply.html"', ctx);
    assert.match(notices[0].message, /^Exported to /);
    const target = notices[0].message.slice('Exported to '.length);
    const temporary = dirname(target);
    try {
      assert.equal(dirname(temporary), TEMP_EXPORT_ROOT);
      assert.equal(target, join(temporary, 'My reply.html'));
      assert.match(await readFile(target, 'utf8'), /id="pi-better-export"/);
      assert.deepEqual(await readdir(temporary), ['My reply.html']);
      assert.ok(!(await readdir(dir)).includes('exports'));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});

test('dismissing the destination picker cancels the export', async () => {
  await withSession(async (dir, sm) => {
    const files = await readdir(dir);
    const { ctx, notices, prompts } = context(dir, sm, { select: async () => undefined });
    await exportCommand(pi, 'out.html', ctx);
    assert.deepEqual(await readdir(dir), files);
    assert.deepEqual(notices, []);
    assert.deepEqual(prompts, []);
  });
});

test('rejects non-HTML filenames with usage and cleans up staging when export fails', async () => {
  await withSession(async (dir, sm) => {
    const { ctx, notices } = context(dir, sm);
    await exportCommand(pi, 'notes.txt', ctx);
    assert.match(notices.at(-1)!.message, /Choose an \.html or \.htm file\. Usage: \/better-export/);

    // Conversation filtering fails after staging when the active branch has no user or assistant prose.
    const empty = SessionManager.create(dir, dir);
    empty.appendMessage({ role: 'user', content: 'Hello', timestamp: Date.now() });
    empty.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Hi' }], api: 'anthropic-messages', provider: 'test', model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now() });
    empty.resetLeaf();
    empty.appendModelChange('test', 'model');
    const failing = context(dir, empty);
    await exportCommand(pi, '--conversation empty.html', failing.ctx);
    assert.match(failing.notices.at(-1)!.message, /^Export failed: No user or assistant conversation/);
    assert.ok(!(await readdir(dir)).includes('empty.html'));
    await noStaging(dir);
  });
});
