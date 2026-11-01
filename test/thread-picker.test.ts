import { test, expect } from 'bun:test';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ThreadPicker } from '../src/thread-picker.ts';

const session = (id: string): SessionInfo => ({ path: `/sessions/${id}.jsonl`, id, cwd: '/project',
  created: new Date(), modified: new Date(), messageCount: 2, firstMessage: `Thread ${id}`, allMessagesText: '' });
function fixture(project = [session('a'), session('b'), session('c')], loadAll?: () => Promise<SessionInfo[]>) {
  let exited = false;
  let allLoads = 0;
  const deletions: SessionInfo[][] = [];
  const picker = new ThreadPicker({ project,
    loadAll: async () => { allLoads++; return loadAll ? loadAll() : [...project, session('other')]; },
    theme: { fg: (_: string, value: string) => value, bold: (value: string) => value,
      bg: (_: string, value: string) => value } as any,
    requestRender() {}, done: () => { exited = true; picker.dispose(); },
    deleteThreads: async (sessions) => { deletions.push(sessions); return sessions.map(session => session.path); },
  });
  picker.focused = true;
  return { picker, deletions, text: (width = 120) => picker.render(width).join('\n'),
    get exited() { return exited; }, get allLoads() { return allLoads; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('renders only thread rows and search, without action menu entries', () => {
  const h = fixture();
  expect(h.text()).toContain('Delete threads (Current project)');
  expect(h.text()).toContain('› [ ] Thread a');
  for (const action of ['Delete selected', 'Select all matches', 'Clear selection', 'Cancel']) expect(h.text()).not.toContain(action);
});

test('space and enter toggle the current thread and advance the cursor', () => {
  const h = fixture();
  h.picker.handleInput(' ');
  expect(h.text()).toContain('[x] Thread a'); expect(h.text()).toContain('› [ ] Thread b');
  h.picker.handleInput('\r');
  expect(h.text()).toContain('[x] Thread b'); expect(h.text()).toContain('› [ ] Thread c');
  h.picker.handleInput('\x1b[A'); h.picker.handleInput(' ');
  expect(h.text()).toContain('[ ] Thread b'); expect(h.text()).toContain('› [ ] Thread c');
});

test('ctrl+d asks before deletion, n returns, and enter confirms the selected set', async () => {
  const h = fixture();
  h.picker.handleInput(' '); h.picker.handleInput('\r'); h.picker.handleInput('\x04');
  expect(h.text()).toContain('Permanently delete 2 threads?'); expect(h.deletions).toEqual([]);
  h.picker.handleInput('n'); expect(h.text()).toContain('2 selected');
  h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0].map(s => s.id)).toEqual(['a', 'b']);
  expect(h.text()).not.toContain('Thread a'); expect(h.text()).toContain('Thread c');
});

test('ctrl+d without a selection asks about the focused thread', () => {
  const h = fixture(); h.picker.handleInput('\x1b[B'); h.picker.handleInput('\x04');
  expect(h.text()).toContain('Permanently delete 1 thread?');
  expect(h.text()).toContain('Thread b'); expect(h.deletions).toEqual([]);
});

test('tab cycles project and all, retaining selection and loading all only once', async () => {
  const h = fixture(); h.picker.handleInput(' '); h.picker.handleInput('\t'); await tick();
  expect(h.text()).toContain('Delete threads (All projects)'); expect(h.text()).toContain('[x] Thread a');
  expect(h.text()).toContain('Thread other');
  h.picker.handleInput('\t'); expect(h.text()).not.toContain('Thread other');
  h.picker.handleInput('\t'); expect(h.allLoads).toBe(1);
});

test('ctrl+a selects all matching threads in the current scope', async () => {
  const h = fixture(); h.picker.handleInput('\x01');
  expect(h.text()).toContain('3 selected');
  h.picker.handleInput('\t'); await tick(); h.picker.handleInput('\x01');
  expect(h.text()).toContain('4 selected');
  h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0]).toHaveLength(4);
});

test('escape exits from browsing and confirmation without deleting', () => {
  for (const confirm of [false, true]) {
    const h = fixture(); if (confirm) h.picker.handleInput('\x04');
    h.picker.handleInput('\x1b'); expect(h.exited).toBe(true); expect(h.deletions).toEqual([]);
    h.picker.handleInput('\r'); expect(h.deletions).toEqual([]);
  }
});

test('search filters threads, and ctrl+a selects only matches', async () => {
  const h = fixture(); h.picker.handleInput('b');
  expect(h.text()).toContain('Thread b'); expect(h.text()).not.toContain('Thread a');
  h.picker.handleInput('\x01'); h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0].map(s => s.id)).toEqual(['b']);
});

test('an empty project can switch to all, and loader errors remain visible', async () => {
  const empty = fixture([]); expect(empty.text()).toContain('No matching threads');
  empty.picker.handleInput('\t'); await tick(); expect(empty.text()).toContain('Thread other');
  const error = fixture([], async () => { throw new Error('read failed'); });
  error.picker.handleInput('\t'); await tick(); expect(error.text()).toContain('Could not load threads: read failed');
});

test('scrolling, narrow terminals, and control characters keep rows within terminal width', () => {
  const project = Array.from({ length: 40 }, (_, i) => session(String(i).padStart(2, '0')));
  project[39].firstMessage = 'Unicode 界 '.repeat(20) + '\x1b[31m\nBad';
  const h = fixture(project); h.picker.handleInput('\x1b[F');
  expect(h.text()).toContain('40/40 threads');
  for (const width of [1, 8, 40, 120]) for (const line of h.picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test('a failed deletion preserves selected threads and allows retry', async () => {
  const project = [session('a')]; let calls = 0;
  const picker = new ThreadPicker({ project, loadAll: async () => [], theme: { fg: (_: string, x: string) => x, bold: (x: string) => x, bg: (_: string, x: string) => x } as any,
    requestRender() {}, done() {}, deleteThreads: async () => { calls++; throw new Error('permission denied'); } });
  picker.handleInput(' '); picker.handleInput('\x04'); picker.handleInput('\r'); await tick();
  expect(picker.render(120).join('\n')).toContain('permission denied');
  expect(picker.render(120).join('\n')).toContain('[x] Thread a');
  picker.handleInput('\x04'); picker.handleInput('\r'); await tick(); expect(calls).toBe(2);
});

test('a late All-scope load cannot bring deleted project threads back', async () => {
  let finishLoad!: (sessions: SessionInfo[]) => void;
  const h = fixture([session('a')], () => new Promise(resolve => { finishLoad = resolve; }));
  h.picker.handleInput(' '); h.picker.handleInput('\t');
  h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  finishLoad([session('a'), session('other')]); await tick();
  expect(h.text()).not.toContain('Thread a');
  expect(h.text()).toContain('Thread other');
});

test('partial file failures retain only the failed selections', async () => {
  const picker = new ThreadPicker({ project: [session('a'), session('b')], loadAll: async () => [],
    theme: { fg: (_: string, x: string) => x, bold: (x: string) => x, bg: (_: string, x: string) => x } as any,
    requestRender() {}, done() {}, deleteThreads: async () => [session('a').path] });
  picker.handleInput('\x01'); picker.handleInput('\x04'); picker.handleInput('\r'); await tick();
  const text = picker.render(120).join('\n');
  expect(text).not.toContain('Thread a'); expect(text).toContain('[x] Thread b'); expect(text).toContain('1 selected');
});

function datedSession(id: string, cwd: string, day: number, hour = 12): SessionInfo {
  return { ...session(id), cwd, modified: new Date(2025, 0, day, hour) };
}

test('Ctrl+G groups by local modified date, newest first, then project path', () => {
  const h = fixture([
    datedSession('a', '/zeta', 1),
    datedSession('b', '/alpha', 2),
    datedSession('c', '/alpha', 1),
    datedSession('d', '/zeta', 2, 13),
  ]);
  h.picker.handleInput('\x07');
  let text = h.text();
  expect(text).toContain('ctrl+g group (date)');
  expect(text.indexOf('2025-01-02')).toBeLessThan(text.indexOf('2025-01-01'));
  expect(text.indexOf('Thread d')).toBeLessThan(text.indexOf('Thread b'));
  expect(text.match(/2025-01-01/g)).toHaveLength(1);
  expect(text).toContain('› [ ] Thread a');
  h.picker.handleInput('\x07'); text = h.text();
  expect(text).toContain('ctrl+g group (project)');
  expect(text.indexOf('/alpha')).toBeLessThan(text.indexOf('/zeta'));
  expect(text.indexOf('Thread b')).toBeLessThan(text.indexOf('Thread c'));
  expect(text.indexOf('Thread d')).toBeLessThan(text.indexOf('Thread a'));
  expect(text).toContain('› [ ] Thread a');
  h.picker.handleInput('\x07'); text = h.text();
  expect(text).toContain('ctrl+g group (none)');
  expect(text).not.toContain('/alpha'); expect(text).not.toContain('2025-01-01');
  expect(text.indexOf('Thread a')).toBeLessThan(text.indexOf('Thread b'));
});

test('group headings are skipped during selection, and grouping preserves deletion targets', async () => {
  const h = fixture([datedSession('a', '/alpha', 2), datedSession('b', '/beta', 1)]);
  h.picker.handleInput('\x07'); h.picker.handleInput(' ');
  expect(h.text()).toContain('[x] Thread a'); expect(h.text()).toContain('› [ ] Thread b');
  h.picker.handleInput('\x07');
  expect(h.text()).toContain('› [ ] Thread b');
  h.picker.handleInput('\r'); h.picker.handleInput('\x04');
  expect(h.text()).toContain('Permanently delete 2 threads?');
  h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0].map(s => s.id)).toEqual(['a', 'b']);
});

test('search and scope changes retain grouping and select-all targets only matching threads', async () => {
  const project = [datedSession('a', '/project', 1)];
  const h = fixture(project, async () => [...project, datedSession('other', '/elsewhere', 2)]);
  h.picker.handleInput('\x07'); h.picker.handleInput('\x07');
  h.picker.handleInput('\t'); await tick();
  expect(h.text()).toContain('/elsewhere'); expect(h.text()).toContain('/project');
  h.picker.handleInput('other');
  expect(h.text()).toContain('/elsewhere'); expect(h.text()).not.toContain('/project\n');
  h.picker.handleInput('\x01'); h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0].map(s => s.id)).toEqual(['other']);
});

test('grouped scrolling repeats headings, keeps focus visible, and fits the row budget', () => {
  const project = Array.from({ length: 30 }, (_, i) => datedSession(String(i).padStart(2, '0'), `/project-${Math.floor(i / 3)}`, 1 + Math.floor(i / 4)));
  for (const rowBudget of [1, 2, 4, 12]) {
    const picker = new ThreadPicker({ project, rows: () => rowBudget + 10,
      loadAll: async () => [], theme: { fg: (_: string, x: string) => x, bold: (x: string) => x, bg: (_: string, x: string) => x } as any,
      requestRender() {}, done() {}, deleteThreads: async () => [] });
    for (let mode = 0; mode < 2; mode++) {
      picker.handleInput('\x07'); picker.handleInput('\x1b[H');
      for (let i = 0; i < project.length; i++) {
        const rendered = picker.render(120);
        expect(rendered.filter(line => line.startsWith('› '))).toHaveLength(1);
        const listStart = rendered.findIndex(line => line.startsWith('> ')) + 2;
        const listEnd = rendered.findIndex(line => /\d+\/\d+ threads/.test(line));
        const list = rendered.slice(listStart, listEnd);
        expect(list.length).toBeLessThanOrEqual(rowBudget);
        if (rowBudget > 1) expect(list[0]).toMatch(mode === 0 ? /^2025-01-/ : /^\/project-/);
        picker.handleInput('\x1b[B');
      }
    }
  }
});
