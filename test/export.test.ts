import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { getPackageDir, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { enhanceHtml } from '../src/export/enhance.ts';
import { exportCommand } from '../src/export/index.ts';
import { readSessionData } from '../src/export/session.ts';

const { exportSessionToHtml } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/export-html/index.js')).href);
const { getThemeByName } = await import(pathToFileURL(join(getPackageDir(), 'dist/modes/interactive/theme/theme.js')).href);
initTheme('dark');

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-better-export-test-'));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: 'user', content: 'Explain the equation', timestamp: Date.now() });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Inline $x^2$ and \\(y_1\\).\n\n$$\n\\frac{a}{b} = \\sqrt{2}\n$$\n\n\\[z^2\\]\n\n`$code$`\n\n```tex\n$x$\n```\n\nCosts $20 and $30.\n\nInvalid $\\frac{$.' }], api: 'anthropic-messages', provider: 'anthropic', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  return { dir, sm };
}

test('native export renders inline/display math offline and preserves Pi viewer and code', async () => {
  const { dir, sm } = await fixture();
  let dom;
  try {
    const path = join(dir, 'native.html');
    await exportSessionToHtml(sm, undefined, { outputPath: path });
    const html = await enhanceHtml(await readFile(path, 'utf8'));
    assert.match(html, /data:font\/woff2;base64,/);
    assert.doesNotMatch(html, /url\(fonts\//);
    assert.equal(await enhanceHtml(html), html);
    const errors: unknown[] = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (error) => errors.push(error));
    dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc, beforeParse(window) { window.matchMedia = () => ({ matches: false, addEventListener() {} }); } });
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('#messages .katex').length, 4);
    assert.equal(doc.querySelectorAll('#messages .katex-display').length, 2);
    assert.equal(doc.querySelectorAll('#messages .katex-error').length, 1);
    assert.equal(doc.querySelectorAll('code .katex').length, 0);
    assert.match(doc.querySelector('#messages')!.textContent!, /Costs \$20 and \$30/);
    assert.ok(doc.querySelector('#tree-search'));
    assert.ok(doc.querySelector('.filter-btn'));
    assert.deepEqual(errors, []);
    const equation = doc.querySelector('#messages .better-export-math')!;
    const range = doc.createRange();
    range.selectNodeContents(equation.querySelector('.katex-html')!);
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    let copied = '';
    const copyEvent = new dom.window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, 'clipboardData', { value: { setData: (_type: string, text: string) => { copied = text; } } });
    doc.dispatchEvent(copyEvent);
    assert.equal(copied, 'x^2');
    assert.equal(copyEvent.defaultPrevented, true);
    range.setStartBefore(equation);
    range.setEndAfter(doc.querySelectorAll('#messages .better-export-math')[1]);
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(copyEvent);
    assert.equal(copied, 'x^2 and y_1');
    selection.removeAllRanges();
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text: string) => { copied = text; } } });
    const display = doc.querySelector('#messages .better-export-math[data-display]')!;
    display.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(copied, String.raw`\frac{a}{b} = \sqrt{2}`);
    assert.equal(doc.querySelector('.better-export-copy-status')!.textContent, 'LaTeX copied');
    display.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(copied, String.raw`\frac{a}{b} = \sqrt{2}`);
    let printed = false;
    dom.window.print = () => { printed = true; };
    doc.querySelector('[data-better-export-print]')!.click();
    assert.equal(printed, true);
  } finally { dom?.window.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rejects unknown template versions', async () => {
  await assert.rejects(enhanceHtml('<html></html>'), /Unsupported Pi HTML template/);
});

test('command writes enhanced native HTML before asking to open and honors decline', async () => {
  const { dir, sm } = await fixture();
  try {
    const target = join(dir, 'with spaces.html');
    const prompts: string[] = [];
    const notifications: string[] = [];
    const ctx = {
      cwd: dir, sessionManager: sm, hasUI: true,
      waitForIdle: async () => {}, getSystemPrompt: () => 'test system prompt',
      ui: { theme: getThemeByName('dark')!, notify: (message: string) => notifications.push(message), confirm: async (title: string) => {
        prompts.push(title);
        assert.match(await readFile(target, 'utf8'), /id="pi-better-export"/);
        return false;
      } },
    };
    await exportCommand({ getAllTools: () => [] } as any, '"with spaces.html"', ctx as any);
    assert.deepEqual(prompts, ['Open exported HTML?']);
    assert.match(notifications[0], /Exported to/);
    const firstExport = await readFile(target, 'utf8');
    await exportCommand({ getAllTools: () => [] } as any, '"with spaces.html"', ctx as any);
    assert.deepEqual(prompts, ['Open exported HTML?', 'Replace existing export?']);
    assert.equal(await readFile(target, 'utf8'), firstExport);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('exports a running turn without waiting or interrupting it', async () => {
  const { dir, sm } = await fixture();
  try {
    sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'pending-call', name: 'bash', arguments: { command: 'long-running-task' } }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: Date.now() });
    const leaf = sm.getLeafId();
    const notifications: { message: string; type: string }[] = [];
    const ctx = {
      cwd: dir, sessionManager: sm, hasUI: false, isIdle: () => false,
      waitForIdle: async () => { throw new Error('The agent is still running'); },
      abort: () => { throw new Error('Export must not interrupt the agent'); },
      getSystemPrompt: () => 'test system prompt',
      ui: { theme: getThemeByName('dark')!, notify: (message: string, type: string) => notifications.push({ message, type }) },
    };
    await exportCommand({ getAllTools: () => [] } as any, 'mid-turn.html', ctx as any);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, 'info');
    const html = await readFile(join(dir, 'mid-turn.html'), 'utf8');
    const data = readSessionData(html);
    assert.equal(data.leafId, leaf);
    assert.equal(data.entries.at(-1)?.message?.role, 'assistant');
    assert.match(JSON.stringify(data.entries.at(-1)), /pending-call/);
    assert.match(html, /id="pi-better-export"/);
    assert.equal(sm.getLeafId(), leaf);
    assert.equal(ctx.isIdle(), false);
    sm.appendMessage({ role: 'toolResult', toolCallId: 'pending-call', toolName: 'bash', content: [{ type: 'text', text: 'Task finished later' }], isError: false, timestamp: Date.now() });
    assert.doesNotMatch(JSON.stringify(data), /Task finished later/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('Pi loads the extension and registers the command', async () => {
  const { loadExtensions } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/extensions/loader.js')).href);
  const result = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  for (const command of ['better-export', 'ephemeral', 'delete', 'delete-threads', 'goal', 'auto-name', 'continue']) assert.ok(result.extensions[0].commands.has(command));
  assert.ok(result.extensions[0].shortcuts.has('ctrl+alt+c'));
  for (const shortcut of ['alt+p', 'alt+,', 'alt+.']) assert.ok(result.extensions[0].shortcuts.has(shortcut));
  assert.ok(!result.extensions[0].shortcuts.has('ctrl+e'));
  for (const tool of ['get_goal', 'create_goal', 'update_goal']) assert.ok(result.extensions[0].tools.has(tool));
});
