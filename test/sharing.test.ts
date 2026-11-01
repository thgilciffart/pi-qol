import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { parseColor } from '@earendil-works/pi-tui';
import { parseOptions } from '../src/export/options.ts';
import { applyLiveTheme, readExportColors } from '../src/export/theme.ts';
import { conversationOnly, readSessionData, writeSessionData, type SessionData } from '../src/export/session.ts';
import { redactSession } from '../src/export/redact.ts';
import { exportCommand } from '../src/export/index.ts';

const themeModule = await import(pathToFileURL(join(getPackageDir(), 'dist/modes/interactive/theme/theme.js')).href);
const { exportSessionToHtml } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/export-html/index.js')).href);
initTheme('dark');

const sample: SessionData = {
  header: { type: 'session', version: 3, id: 'session-id', timestamp: '2026-01-01T00:00:00Z', cwd: '/home/alice/project', parentSession: '/home/alice/secret.jsonl' },
  systemPrompt: 'INTERNAL_SYSTEM', tools: [{ name: 'tool', description: 'PRIVATE_TOOL' }], renderedTools: { tool: 'PRIVATE_RENDER' },
  entries: [
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Contact alice@example.com in /home/alice/project/report.md.' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'Here is $x^2$' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'PRIVATE_PATH' } }], provider: 'test', model: 'test', privateMetadata: 'PRIVATE_METADATA' } },
    { type: 'message', id: 't', parentId: 'a', message: { role: 'toolResult', content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }] } },
    { type: 'message', id: 'other', parentId: 't', message: { role: 'user', content: 'PRIVATE_OTHER_BRANCH' } },
    { type: 'message', id: 'last', parentId: 't', message: { role: 'user', content: 'Project code: confidential-company' } },
  ], leafId: 'last',
};

test('conversation exports contain only the active branch prose, without hidden payloads', () => {
  const clean = conversationOnly(sample);
  assert.deepEqual(clean.entries.map(entry => [entry.id, entry.parentId]), [['u', null], ['a', 'u'], ['last', 'a']]);
  assert.equal(clean.leafId, 'last');
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE_|INTERNAL_|parentSession|\/home\/alice\/secret/);
  assert.equal(clean.systemPrompt, undefined);
  assert.equal(clean.tools, undefined);
  assert.equal(clean.header!.cwd, undefined);
  assert.equal(sample.entries.length, 5);
});

test('redaction transforms embedded data, including prompts, metadata, and nested tools', () => {
  const secret = 'sk-proj-' + 'a'.repeat(30);
  const full = structuredClone(sample);
  full.systemPrompt = `Use ${secret} for password="letmein". Bearer abc.def.ghi`;
  full.extra = { apiKey: 'short-but-secret', private: '-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----' };
  const result = redactSession(full, { home: '/home/alice', cwd: '/home/alice/project', literals: ['confidential-company'] });
  const text = JSON.stringify(result.data);
  for (const value of [secret, 'letmein', 'abc.def.ghi', 'short-but-secret', 'secret material', 'alice@example.com', '/home/alice', 'confidential-company']) assert.ok(!text.includes(value), value);
  assert.ok(result.findings.length >= 7);
  assert.deepEqual(result.data.entries.map(entry => entry.id), full.entries.map(entry => entry.id));
  assert.match(String(result.data.systemPrompt), /REDACTED/);
  assert.match(String(full.systemPrompt), /letmein/);
  const html = '<script id="session-data" type="application/json">' + Buffer.from(JSON.stringify(full)).toString('base64') + '</script>';
  assert.deepEqual(readSessionData(writeSessionData(html, result.data)), result.data);
});

test('option parsing supports sharing, custom redactions, paths, and errors', () => {
  assert.deepEqual(parseOptions('--share --redact-text "Acme Corp" "reports/My session.html"'), { filename: 'reports/My session.html', conversation: true, redact: true, literals: ['Acme Corp'] });
  assert.equal(parseOptions('report with spaces.html').filename, 'report with spaces.html');
  assert.equal(parseOptions('-- --share.html').filename, '--share.html');
  assert.throws(() => parseOptions('--unknown'), /Unknown/);
  assert.throws(() => parseOptions('--redact-text'), /needs/);
  assert.throws(() => parseOptions('"missing quote'), /Unclosed/);
});

test('live theme snapshot restores native colors when exporter loses terminal state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-export-theme-test-'));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: 'user', content: 'Test', timestamp: Date.now() });
    const file = join(dir, 'export.html');
    themeModule.setTerminalColors({ foreground: { r: 196, g: 200, b: 197 }, background: { r: 34, g: 43, b: 51 } });
    const liveTheme = themeModule.getThemeByName('system');
    const snapshot = { colors: { ...liveTheme.colors } };
    await exportSessionToHtml(sm, undefined, { outputPath: file, themeName: 'system' });
    const native = await readFile(file, 'utf8');
    themeModule.setTerminalColors({});
    await exportSessionToHtml(sm, undefined, { outputPath: file, themeName: 'system' });
    const broken = await readFile(file, 'utf8');
    assert.notEqual(native, broken);
    const fixed = applyLiveTheme(broken, snapshot);
    const variables = (html: string) => Object.fromEntries([...html.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]));
    assert.deepEqual(variables(fixed), variables(native));
    const strip = (html: string) => html.replace(/(<style>\s*:root\s*\{)[^}]*\}/, '$1}');
    assert.equal(strip(fixed), strip(native));
    // Values from the supplied reference export must produce the same derived backgrounds.
    const reference = applyLiveTheme(broken, { colors: { userMessageBg: parseColor('#28333c'), text: parseColor('#c4c8c5') } } as any);
    assert.match(reference, /--body-bg: rgb\(28, 36, 42\)/);
    assert.match(reference, /--container-bg: rgb\(34, 43, 51\)/);
    assert.match(reference, /--info-bg: rgb\(60, 66, 60\)/);
  } finally { themeModule.setTerminalColors({}); await rm(dir, { recursive: true, force: true }); }
});

test('custom export colors resolve theme variables and override derived backgrounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-export-custom-theme-'));
  try {
    const sourcePath = join(dir, 'theme.json');
    await writeFile(sourcePath, JSON.stringify({ vars: { bg: '#123456', alias: 'bg' }, export: { pageBg: 'alias', cardBg: 7 } }));
    const colors = await readExportColors({ sourcePath } as any, {});
    assert.equal(colors.pageBg, '#123456');
    const html = applyLiveTheme('<style>:root { --userMessageBg: #000; }</style>', { colors: { userMessageBg: parseColor('#000000') } } as any, colors);
    assert.match(html, /--body-bg: #123456/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('redaction cancellation leaves the destination unchanged and removes staging data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-export-preview-test-'));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: 'user', content: 'alice@example.com', timestamp: Date.now() });
    const file = join(dir, 'report.html');
    await writeFile(file, 'original file');
    const messages: string[] = [];
    const ctx = { cwd: dir, sessionManager: sm, hasUI: true, waitForIdle: async () => {}, getSystemPrompt: () => '', ui: {
      theme: themeModule.getThemeByName('dark'), confirm: async () => true,
      select: async () => 'Cancel export', notify: (message: string) => messages.push(message),
    } };
    await exportCommand({ getAllTools: () => [] } as any, '--share report.html', ctx as any);
    assert.equal(await readFile(file, 'utf8'), 'original file');
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('.pi-better-export-')));
    assert.deepEqual(messages, []);
    ctx.ui.select = async () => 'Save export with 1 redaction';
    ctx.ui.confirm = async (title?: string) => title !== 'Open exported HTML?';
    await exportCommand({ getAllTools: () => [] } as any, '--share report.html', ctx as any);
    const html = await readFile(file, 'utf8');
    assert.match(html, /data-better-export-conversation="true"/);
    const exported = readSessionData(html);
    assert.doesNotMatch(JSON.stringify(exported), /alice@example.com/);
    assert.equal(exported.systemPrompt, undefined);
    assert.match(messages[0], /Exported to/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
