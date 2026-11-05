import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTheme, SessionManager, type Theme } from '@earendil-works/pi-coding-agent';
import { Container, Input, ScrollView, Text, TuiAltScreen, VStack, resetCapabilitiesCache, setCapabilities, stripTerminalSequences,
  visibleWidth, type Component, type OverlayHandle, type Terminal } from '@earendil-works/pi-tui';
import { canTakeOverScreen, cleanText, readTranscript, ThreadTranscript, TranscriptHost, type Transcript } from '../src/thread-transcript.ts';
import threads from '../src/threads.ts';

initTheme('dark', false);
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join('\n');
const regularTui = (rows = 30) => ({ requestRender() {}, terminal: { rows, columns: 100 } }) as any;
const MOUSE_MODE = /\x1b\[\?100[0-6][hl]/;
const wheelUp = '\x1b[<64;10;5M', wheelDown = '\x1b[<65;10;5M';

afterEach(() => resetCapabilitiesCache());

async function sessionFile(entries: unknown[], raw: string[] = []): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, [...entries.map(entry => JSON.stringify(entry)), ...raw].join('\n'));
  return { dir, path };
}

const message = (body: Record<string, unknown>) => ({ type: 'message', timestamp: '2026-01-01T00:00:00.000Z', message: body });
const fullSession = [
  { type: 'session', cwd: '/project' },
  message({ role: 'user', content: [{ type: 'text', text: 'Hello **reader**\x1b]52;c;U1RFQUw=\x07\x1b[31m' },
    { type: 'image', mimeType: 'image/png', data: 'USER_IMAGE_BASE64' }] }),
  message({ role: 'assistant', stopReason: 'toolUse', content: [
    { type: 'thinking', thinking: 'Consider the options' },
    { type: 'text', text: '## Plan\n\n- inspect files' },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls src' } },
    { type: 'toolCall', id: 'call-2', name: 'custom_tool', arguments: { query: 'needle' } },
  ] }),
  message({ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false,
    content: [{ type: 'text', text: 'index.ts' }, { type: 'image', mimeType: 'image/jpeg', data: 'TOOL_IMAGE_BASE64' }] }),
  message({ role: 'toolResult', toolCallId: 'call-2', toolName: 'custom_tool', isError: true, content: [{ type: 'text', text: 'not found' }] }),
  message({ role: 'toolResult', toolCallId: 'orphan', toolName: 'lost_tool', isError: false, content: 'orphan output' }),
  message({ role: 'bashExecution', command: 'pwd', output: '/project', exitCode: 0, cancelled: false, truncated: false }),
  { type: 'compaction', summary: 'Compacted summary', tokensBefore: 1200 },
  { type: 'branch_summary', fromId: 'abc', summary: 'Branch summary text' },
  { type: 'custom_message', customType: 'note', content: 'Extension note', display: false },
  message({ role: 'assistant', stopReason: 'aborted', content: [{ type: 'toolCall', id: 'call-3', name: 'read', arguments: { path: 'a.ts' } }] }),
  message({ role: 'mystery', content: 'Unknown role text' }),
  { type: 'model_change', provider: 'x', modelId: 'y' },
];

test('the reader keeps every saved message and pairs tool calls with results', async () => {
  const { dir, path } = await sessionFile(fullSession, ['{not json', '']);
  try {
    const transcript = await readTranscript(path);
    expect(transcript.skipped).toBe(1);
    expect(transcript.messages).toBe(11);
    expect(transcript.items.map(item => item.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'bash',
      'compaction', 'branch', 'custom', 'assistant', 'tool', 'other']);
    const [user, assistant, bash, custom, orphan] = transcript.items;
    expect(user).toEqual({ kind: 'user', text: 'Hello **reader**\n[Image: image/png]' });
    expect(assistant.kind === 'assistant' && assistant.message.content.map(block => block.type)).toEqual(['thinking', 'text', 'toolCall', 'toolCall']);
    expect(bash).toMatchObject({ kind: 'tool', name: 'bash', args: { command: 'ls src' }, result: { isError: false } });
    expect(custom).toMatchObject({ kind: 'tool', name: 'custom_tool', result: { isError: true } });
    expect(orphan).toMatchObject({ kind: 'tool', name: 'lost_tool', args: {}, result: { content: [{ type: 'text', text: 'orphan output' }] } });
    expect(transcript.items[10]).toMatchObject({ kind: 'tool', name: 'read', interrupted: 'Operation aborted' });
    const json = JSON.stringify(transcript);
    for (const secret of ['USER_IMAGE_BASE64', 'TOOL_IMAGE_BASE64', '\\u001b', 'U1RFQUw=']) expect(json).not.toContain(secret);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the reader reports missing files and survives files without messages', async () => {
  await expect(readTranscript(join(tmpdir(), 'pi-qol-missing-transcript.jsonl'))).rejects.toThrow();
  const { dir, path } = await sessionFile([{ type: 'session' }], ['garbage', '[1,']);
  try {
    const transcript = await readTranscript(path);
    expect(transcript).toEqual({ items: [], messages: 0, skipped: 2 });
    const text = plain(new ThreadTranscript({ title: 'Empty', transcript, theme, tui: regularTui(), cwd: '/', done() {} }).render(60));
    expect(text).toContain('2 unreadable lines skipped');
    expect(text).toContain('No saved messages.');
  } finally { await rm(dir, { recursive: true, force: true }); }
  expect(cleanText('a\x1b[2Jb\x1b]8;;http://x\x07c\x9b31md\re\tf')).toBe('abcd\ne    f');
});

test("messages render with Pi's own components, including Markdown, thinking, tools, and summaries", async () => {
  const { dir, path } = await sessionFile(fullSession);
  try {
    const raw = new ThreadTranscript({ title: 'Saved', transcript: await readTranscript(path), theme, tui: regularTui(200), cwd: '/project', done() {} }).render(100);
    const text = plain(raw);
    for (const expected of ['Transcript · Saved', 'Hello reader', '[Image: image/png]', 'Consider the options', 'Plan', 'inspect files',
      '$ ls src', 'index.ts', 'custom_tool', 'needle', 'not found', 'lost_tool', 'orphan output', '$ pwd', '/project',
      'Compacted summary', 'Branch summary text', 'Extension note', 'Operation aborted', 'mystery', 'Unknown role text']) expect(text).toContain(expected);
    // Markdown is rendered, not shown as source.
    expect(text).not.toContain('**reader**'); expect(text).not.toContain('## Plan');
    // Image data never reaches the terminal, and saved escape sequences cannot run.
    expect(raw.join('')).not.toContain('BASE64'); expect(raw.join('')).not.toContain('\x1b]52');
    expect(raw.some(line => line.includes('\x1b_G') || line.includes('\x1b]1337'))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const longTranscript = (rows = 100): Transcript => ({ messages: 1, skipped: 0, items: [
  { kind: 'user', text: Array.from({ length: rows }, (_, index) => `Message row ${index}`).join('\n\n') }] });
const toolTranscript = (): Transcript => ({ messages: 2, skipped: 0, items: [{ kind: 'tool', id: 'c', name: 'bash', args: { command: 'seq 40' },
  result: { isError: false, content: [{ type: 'text', text: Array.from({ length: 40 }, (_, index) => `out ${index}`).join('\n') }] } }] });

test('keyboard navigation scrolls, pages, jumps, toggles tool output, and returns', () => {
  let rows = 12, closed = 0;
  const tui = { requestRender() {}, terminal: { rows: 99, columns: 80 } } as any;
  const viewer = new ThreadTranscript({ title: 'Keys', transcript: longTranscript(), theme, tui, cwd: '/', done: () => { closed++; }, rows: () => rows });
  const body = () => plain(viewer.render(80).slice(3, -2));
  expect(viewer.render(80)).toHaveLength(12);
  expect(body()).toContain('Message row 0');
  viewer.handleInput('\x1b[B'); viewer.handleInput('\x1b[B');
  expect(body()).not.toContain('Message row 0');
  // Seven body rows: Page Down moves six, keeping one row of overlap.
  viewer.handleInput('\x1b[6~');
  expect(body()).toContain('Message row 4'); expect(body()).not.toContain('Message row 3');
  viewer.handleInput('\x1b[F');
  expect(body()).toContain('Message row 99');
  viewer.handleInput('\x1b[5~');
  expect(body()).not.toContain('Message row 99');
  viewer.handleInput('\x1b[H');
  expect(body()).toContain('Message row 0');
  for (const key of ['\x1b', '\x14', 'q']) viewer.handleInput(key);
  expect(closed).toBe(1);

  const tools = new ThreadTranscript({ title: 'Tools', transcript: toolTranscript(), theme, tui, cwd: '/', done() {}, rows: () => 80 });
  expect(plain(tools.render(80))).toContain('out 39');
  tools.handleInput('\x0f');
  const collapsed = plain(tools.render(80));
  expect(collapsed).not.toContain('out 0\n'); expect(collapsed).toContain('Ctrl+O expand tools');
  tools.handleInput('\x0f');
  expect(plain(tools.render(80))).toContain('out 0');
});

test('every frame fills the available rows and width after a resize', () => {
  let rows = 10;
  const viewer = new ThreadTranscript({ title: 'Wide 界 title', transcript: longTranscript(), theme, tui: regularTui(), cwd: '/', done() {}, rows: () => rows });
  for (const [height, width] of [[10, 80], [4, 20], [1, 8], [2, 1], [30, 120]]) {
    rows = height;
    const lines = viewer.render(width);
    expect(lines).toHaveLength(height);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  viewer.handleInput('\x1b[F');
  rows = 60;
  expect(plain(viewer.render(80))).toContain('Message row 99');
});

test('the regular renderer and partial viewport APIs fall back without taking over the screen', () => {
  const tui = regularTui(24);
  const viewer = new ThreadTranscript({ title: 'Regular', transcript: longTranscript(), theme, tui, cwd: '/', done() {} });
  expect(canTakeOverScreen(tui)).toBe(false);
  expect(viewer.takeOverScreen(tui)).toBe(false);
  expect(viewer.render(80)).toHaveLength(24);
  expect(plain(viewer.render(80))).not.toContain('Wheel/');
  // A viewport renderer without a readable layout root is treated as unsupported.
  const partial = { ...regularTui(), [Symbol.for('@earendil-works/pi-tui/viewport')]: true, setLayoutRoot() {} } as any;
  expect(canTakeOverScreen(partial)).toBe(false);
  expect(viewer.takeOverScreen(partial)).toBe(false);
  // Only focused wheel events scroll. Other mouse events pass through for selection.
  expect(viewer.handleMouse({ type: 'press', button: 'left', x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 24, shift: false, alt: false, ctrl: false })).toBeUndefined();
  const wheel = { type: 'wheel' as const, button: 'none' as const, x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta: 3 };
  expect(viewer.handleMouse(wheel)).toEqual({ handled: true });
  viewer.focused = false;
  expect(viewer.handleMouse(wheel)).toBeUndefined();
  expect(viewer.render(80)).toEqual([]);
});

/** The parts of Pi's fullscreen layout that matter here: a primary transcript and a dialog slot above the footer. */
function fullscreenParent() {
  let send!: (data: string) => void;
  const writes: string[] = [];
  const terminal: Terminal = { rows: 12, columns: 100, kittyProtocolActive: false,
    start: onInput => { send = onInput; }, stop() {}, async drainInput() {}, write: data => { writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const tui = new TuiAltScreen(terminal, true);
  const document = new Text(Array.from({ length: 40 }, (_, index) => `Parent conversation ${index}`).join('\n'), 0, 0);
  const transcript = new ScrollView(document, { follow: 'end', primary: true });
  const slot = new Container(), footer = new Text('Parent footer', 0, 0), draft = new Input();
  draft.setValue('Keep my parent draft');
  const root = new VStack([{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: new VStack([{ component: slot, shrink: 1, minSize: 3 }, { component: footer, shrink: 1, minSize: 0 }]), basis: 'auto', grow: 0, shrink: 1, minSize: 1 }]);
  tui.addChild(document); tui.addChild(slot); tui.addChild(footer); tui.setLayoutRoot(root);
  const show = (component: Component) => { slot.clear(); slot.addChild(component); tui.setFocus(component); };
  show(draft); tui.start();
  const started = writes.length;
  const frame = () => { tui.renderNow(); return tui.getScreenLines().map(stripTerminalSequences).join('\n'); };
  const layoutRoot = () => (tui as unknown as { layoutRoot?: Component }).layoutRoot;
  return { tui, terminal, transcript, draft, root, show, frame, layoutRoot, send: (data: string) => send(data),
    laterWrites: () => writes.slice(started).join('') };
}

test('Pi fullscreen gives the focused transcript the whole screen, then restores the parent layout and draft', () => {
  const parent = fullscreenParent();
  let handle: OverlayHandle | undefined, closed = 0;
  const viewer = new ThreadTranscript({ title: 'Fullscreen', transcript: longTranscript(), theme, tui: parent.tui, cwd: '/',
    done: () => { closed++; handle?.hide(); viewer.dispose(); } });
  try {
    expect(canTakeOverScreen(parent.tui)).toBe(true);
    expect(viewer.takeOverScreen(parent.tui)).toBe(true);
    handle = parent.tui.showOverlay(viewer, { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 });
    expect(viewer.ownsScreen).toBe(true);
    expect(viewer.render(100)).toEqual([]);
    let screen = parent.frame();
    expect(parent.tui.getScreenLines()).toHaveLength(12);
    expect(screen).toContain('Transcript · Fullscreen'); expect(screen).toContain('Wheel/↑↓ scroll'); expect(screen).toContain('Message row 0');
    expect(screen).not.toContain('Parent footer'); expect(screen).not.toContain('Parent conversation');

    // The wheel scrolls the transcript and leaves the parent transcript where it was.
    const parentScroll = parent.transcript.scrollTop;
    for (let i = 0; i < 6; i++) parent.send(wheelDown);
    screen = parent.frame();
    expect(screen).not.toContain('Message row 0'); expect(screen).toContain('Message row 3');
    expect(parent.transcript.scrollTop).toBe(parentScroll);
    parent.send(wheelUp);
    const conversation = () => parent.frame().split('\n').slice(3, -2);
    const scrolled = conversation();

    // Press and drag pass through to Pi, which selects text.
    parent.send('\x1b[<0;3;6M'); parent.send('\x1b[<32;20;6M');
    expect(parent.tui.hasActiveSelection()).toBe(true);
    parent.send('\x1b[<0;20;6m'); parent.tui.resetTextSelection();
    expect(conversation()).toEqual(scrolled);

    // A resize redraws the transcript at the new size.
    parent.terminal.rows = 8; parent.terminal.columns = 60;
    expect(parent.tui.getScreenLines().length).toBeGreaterThan(0);
    parent.frame();
    expect(parent.tui.getScreenLines()).toHaveLength(8);
    for (const line of parent.tui.getScreenLines()) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    parent.terminal.rows = 12; parent.terminal.columns = 100;

    // A parent prompt takes focus. The parent layout returns so the prompt is visible.
    let reply = '';
    const question = new Input({ prompt: 'Approve parent action? ' });
    question.onSubmit = value => { reply = value; parent.show(parent.draft); };
    parent.show(question);
    expect(viewer.focused).toBe(false); expect(viewer.ownsScreen).toBe(false); expect(parent.layoutRoot()).toBe(parent.root);
    screen = parent.frame();
    expect(screen).toContain('Approve parent action?'); expect(screen).toContain('Parent footer'); expect(screen).not.toContain('Transcript · Fullscreen');
    parent.send('No'); parent.send('\r');
    expect(reply).toBe('No');
    // Pi returns focus to the overlay when the prompt leaves; the transcript takes the screen again.
    parent.tui.setFocus(viewer);
    expect(viewer.ownsScreen).toBe(true);
    expect(parent.frame()).toContain('Transcript · Fullscreen');

    parent.send('\x1b');
    expect(closed).toBe(1); expect(parent.layoutRoot()).toBe(parent.root);
    screen = parent.frame();
    expect(screen).toContain('Keep my parent draft'); expect(screen).toContain('Parent footer'); expect(screen).not.toContain('Transcript · Fullscreen');
    expect(parent.tui.getFocusedComponent()).toBe(parent.draft); expect(parent.draft.getValue()).toBe('Keep my parent draft');
    expect(parent.tui.hasOverlay()).toBe(false);
    expect(parent.laterWrites()).not.toMatch(MOUSE_MODE);
  } finally { handle?.hide(); viewer.dispose(); parent.tui.stop(); }
});

test('disposing a fullscreen transcript without focus changes still restores the layout', () => {
  const parent = fullscreenParent();
  const viewer = new ThreadTranscript({ title: 'Dispose', transcript: longTranscript(), theme, tui: parent.tui, cwd: '/', done() {} });
  try {
    viewer.takeOverScreen(parent.tui);
    parent.show(viewer);
    expect(parent.layoutRoot()).not.toBe(parent.root);
    viewer.dispose();
    expect(parent.layoutRoot()).toBe(parent.root);
    viewer.dispose();
    expect(viewer.takeOverScreen(parent.tui)).toBe(false);
  } finally { parent.tui.stop(); }
});

test('the inline host shows the transcript in the picker slot and returns to the same picker state', async () => {
  const base = new Input();
  base.setValue('picker query');
  let renders = 0;
  const host = new TranscriptHost(base, () => { renders++; });
  host.focused = true;
  expect(base.focused).toBe(true); expect(host.capturesViewportInput).toBe(false);
  let viewer!: ThreadTranscript;
  const opened = host.open(close => (viewer = new ThreadTranscript({ title: 'Inline', transcript: longTranscript(), theme, tui: regularTui(), cwd: '/', done: close, rows: () => 10 })));
  expect(host.showingTranscript).toBe(true); expect(host.capturesViewportInput).toBe(true);
  expect(base.focused).toBe(false); expect(viewer.focused).toBe(true);
  expect(plain(host.render(80))).toContain('Transcript · Inline');
  expect(host.handleMouse({ type: 'wheel', button: 'none', x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 10, shift: false, alt: false, ctrl: false, wheelDelta: 2 })).toEqual({ handled: true });
  host.focused = false;
  expect(viewer.focused).toBe(false);
  host.focused = true;
  host.handleInput('\x1b');
  await opened;
  expect(host.showingTranscript).toBe(false); expect(base.focused).toBe(true);
  expect(plain(host.render(80))).toContain('picker query');
  expect(renders).toBeGreaterThan(0);

  // Disposing the host closes an open transcript and settles its promise.
  const again = host.open(close => new ThreadTranscript({ title: 'Again', transcript: longTranscript(), theme, tui: regularTui(), cwd: '/', done: close }));
  host.dispose();
  await again;
  expect(host.showingTranscript).toBe(false);
});

async function pickerHarness() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qol-transcript-wiring-'));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: 'user', content: 'current', timestamp: Date.now() });
  const other = SessionManager.create(dir, dir);
  other.appendMessage({ role: 'user', content: 'saved **thread**', timestamp: Date.now() });
  other.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], stopReason: 'stop', timestamp: Date.now() } as any);
  const calls: { options: any; component: any; close: () => void }[] = [];
  const tui = regularTui(30);
  const ctx: any = { mode: 'tui', hasUI: true, cwd: dir, sessionManager: manager, waitForIdle: async () => {},
    ui: { notify() {}, custom: (factory: any, options: any) => new Promise<void>(resolve => {
      const call = { options, component: undefined as any, close: () => resolve() };
      call.component = factory(tui, theme, {}, () => resolve());
      calls.push(call);
    }) } };
  const commands = new Map<string, any>();
  threads({ registerCommand: (name: string, spec: any) => commands.set(name, spec) } as any);
  const running = commands.get('delete-threads').handler('', ctx);
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  return { dir, calls, running, settle: () => new Promise(resolve => setTimeout(resolve, 30)) };
}

test('Ctrl+T in the picker opens a full-size overlay transcript without image support', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const h = await pickerHarness();
  try {
    const host = h.calls[0].component as TranscriptHost;
    expect(host).toBeInstanceOf(TranscriptHost);
    host.focused = true;
    host.handleInput('\x14');
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].options).toEqual({ overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } });
    const viewer = h.calls[1].component as ThreadTranscript;
    expect(viewer).toBeInstanceOf(ThreadTranscript);
    const text = plain(viewer.render(100).slice(3));
    expect(viewer.render(100)).toHaveLength(30);
    expect(text).toContain('saved thread'); expect(text).toContain('saved answer'); expect(text).not.toContain('**thread**');
    viewer.handleInput('\x1b');
    host.handleInput('\x1b');
    await h.running;
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});

test('Ctrl+T on an image-capable regular terminal swaps the transcript into the picker slot', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
  const h = await pickerHarness();
  try {
    const host = h.calls[0].component as TranscriptHost;
    host.focused = true;
    host.handleInput('\x14');
    await h.settle();
    expect(h.calls).toHaveLength(1);
    expect(host.showingTranscript).toBe(true);
    const lines = host.render(100);
    expect(lines).toHaveLength(24);
    expect(plain(lines)).toContain('saved answer');
    host.handleInput('\x1b');
    expect(host.showingTranscript).toBe(false);
    expect(plain(host.render(100))).toContain('Delete threads');
    host.handleInput('\x1b');
    await h.running;
  } finally { await rm(h.dir, { recursive: true, force: true }); }
});
