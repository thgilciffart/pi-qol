import { test, expect, setSystemTime } from 'bun:test';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { ThreadPicker } from '../src/thread-picker.ts';

const SHIFT_UP = '\x1b[1;2A', SHIFT_DOWN = '\x1b[1;2B', CTRL_G = '\x07', TAB = '\t', DOWN = '\x1b[B';
const at = (day: number, hour = 12, minute = 0) => new Date(2025, 0, day, hour, minute);
const formatDate = (date: Date) => new Intl.DateTimeFormat().format(date);
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value,
  bg: (_: string, value: string) => value } as any;

const session = (id: string, modified = at(3), cwd = '/project'): SessionInfo => ({ path: `/sessions/${id}.jsonl`, id, cwd,
  created: modified, modified, messageCount: 2, firstMessage: `Thread ${id}`, allMessagesText: '' });
// Newest first, so the default descending sort shows a, b, c under a single date heading.
const defaultProject = () => [session('a', at(3, 12)), session('b', at(3, 11)), session('c', at(3, 10))];

function fixture(project = defaultProject(), loadAll?: () => Promise<SessionInfo[]>) {
  let exited = false;
  let allLoads = 0;
  const deletions: SessionInfo[][] = [];
  const picker = new ThreadPicker({ project,
    loadAll: async () => { allLoads++; return loadAll ? loadAll() : [...project, session('other', at(2))]; },
    theme, requestRender() {}, done: () => { exited = true; picker.dispose(); },
    deleteThreads: async (sessions) => { deletions.push(sessions); return sessions.map(session => session.path); },
  });
  picker.focused = true;
  return { picker, deletions, text: (width = 120) => picker.render(width).join('\n'),
    row: (title: string, width = 120) => picker.render(width).find(line => line.includes(title)),
    get exited() { return exited; }, get allLoads() { return allLoads; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const threadOrder = (text: string) => [...text.matchAll(/Thread (\w+)/g)].map(match => match[1]);
const headings = (text: string) => text.split('\n').filter(line => /^(\/|\d{4}-\d{2}-\d{2}$|Unknown)/.test(line));
async function withNow(now: Date, run: () => void | Promise<void>) {
  setSystemTime(now);
  try { await run(); } finally { setSystemTime(); }
}

test('renders only thread rows and search, without action menu entries', () => {
  const h = fixture();
  expect(h.text()).toContain('Delete threads (Current project)');
  expect(h.text()).toMatch(/› \[ \].*Thread a/);
  expect(threadOrder(h.text())).toEqual(['a', 'b', 'c']);
  for (const action of ['Delete selected', 'Select all matches', 'Clear selection', 'Cancel']) expect(h.text()).not.toContain(action);
});

test('space and enter toggle the current thread and advance the cursor', () => {
  const h = fixture();
  h.picker.handleInput(' ');
  expect(h.text()).toMatch(/\[x\].*Thread a/); expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput('\r');
  expect(h.text()).toMatch(/\[x\].*Thread b/); expect(h.text()).toMatch(/› \[ \].*Thread c/);
  h.picker.handleInput('\x1b[A'); h.picker.handleInput(' ');
  expect(h.text()).toMatch(/\[ \].*Thread b/); expect(h.text()).toMatch(/› \[ \].*Thread c/);
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
  const h = fixture(); h.picker.handleInput(DOWN); h.picker.handleInput('\x04');
  expect(h.text()).toContain('Permanently delete 1 thread?');
  expect(h.text()).toContain('Thread b'); expect(h.deletions).toEqual([]);
});

test('tab cycles project and all, retaining selection and loading all only once', async () => {
  const h = fixture(); h.picker.handleInput(' '); h.picker.handleInput(TAB); await tick();
  expect(h.text()).toContain('Delete threads (All projects)'); expect(h.text()).toMatch(/\[x\].*Thread a/);
  expect(h.text()).toContain('Thread other');
  h.picker.handleInput(TAB); expect(h.text()).not.toContain('Thread other');
  h.picker.handleInput(TAB); expect(h.allLoads).toBe(1);
});

test('ctrl+a selects all matching threads in the current scope', async () => {
  const h = fixture(); h.picker.handleInput('\x01');
  expect(h.text()).toContain('3 selected');
  h.picker.handleInput(TAB); await tick(); h.picker.handleInput('\x01');
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
  empty.picker.handleInput(TAB); await tick(); expect(empty.text()).toContain('Thread other');
  const error = fixture([], async () => { throw new Error('read failed'); });
  error.picker.handleInput(TAB); await tick(); expect(error.text()).toContain('Could not load threads: read failed');
});

test('scrolling, narrow terminals, and control characters keep rows within terminal width', () => {
  const project = Array.from({ length: 40 }, (_, i) => session(String(i).padStart(2, '0'), at(3, 12, i)));
  // The oldest thread sorts last, so End focuses it.
  project[0].firstMessage = 'Unicode 界 '.repeat(20) + '\x1b[31m\nBad';
  const h = fixture(project); h.picker.handleInput('\x1b[F');
  expect(h.text()).toContain('40/40 threads');
  expect(h.text()).toContain('Unicode 界');
  for (const width of [1, 8, 40, 120]) for (const line of h.picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test('a failed deletion preserves selected threads and allows retry', async () => {
  const project = [session('a')]; let calls = 0;
  const picker = new ThreadPicker({ project, loadAll: async () => [], theme,
    requestRender() {}, done() {}, deleteThreads: async () => { calls++; throw new Error('permission denied'); } });
  picker.handleInput(' '); picker.handleInput('\x04'); picker.handleInput('\r'); await tick();
  expect(picker.render(120).join('\n')).toContain('permission denied');
  expect(picker.render(120).join('\n')).toMatch(/\[x\].*Thread a/);
  picker.handleInput('\x04'); picker.handleInput('\r'); await tick(); expect(calls).toBe(2);
});

test('a late All-scope load cannot bring deleted project threads back', async () => {
  let finishLoad!: (sessions: SessionInfo[]) => void;
  const h = fixture([session('a')], () => new Promise(resolve => { finishLoad = resolve; }));
  h.picker.handleInput(' '); h.picker.handleInput(TAB);
  h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  finishLoad([session('a'), session('other')]); await tick();
  expect(h.text()).not.toContain('Thread a');
  expect(h.text()).toContain('Thread other');
});

test('partial file failures retain only the failed selections', async () => {
  const picker = new ThreadPicker({ project: [session('a', at(3, 12)), session('b', at(3, 11))], loadAll: async () => [],
    theme, requestRender() {}, done() {}, deleteThreads: async () => [session('a').path] });
  picker.handleInput('\x01'); picker.handleInput('\x04'); picker.handleInput('\r'); await tick();
  const text = picker.render(120).join('\n');
  expect(text).not.toContain('Thread a'); expect(text).toMatch(/\[x\].*Thread b/); expect(text).toContain('1 selected');
});

// Two days and two projects with distinct times, so every ordering is fully determined.
const mixed = () => [
  session('a', at(1, 10), '/zeta'),
  session('b', at(2, 12), '/alpha'),
  session('c', at(1, 11), '/alpha'),
  session('d', at(2, 13), '/zeta'),
];

test('defaults group the current project by date and all projects by project', async () => {
  const project = mixed();
  const h = fixture(project, async () => project);
  let text = h.text();
  expect(text).toContain('Group: Date'); expect(text).toContain('Sort: Descending');
  expect(headings(text)).toEqual(['2025-01-02', '2025-01-01']);
  h.picker.handleInput(TAB); await tick(); text = h.text();
  expect(text).toContain('Group: Project');
  expect(headings(text)).toEqual(['/zeta', '/alpha']);
});

test('ctrl+g cycles date and none in the current project, and project, none, date in all', async () => {
  const project = mixed();
  const h = fixture(project, async () => project);
  const seen: string[] = [];
  const grouping = () => h.text().match(/Group: (\w+)/)![1].toLowerCase();
  for (let i = 0; i < 3; i++) { seen.push(grouping()); h.picker.handleInput(CTRL_G); }
  expect(seen).toEqual(['date', 'none', 'date']);
  h.picker.handleInput(TAB); await tick(); seen.length = 0;
  for (let i = 0; i < 4; i++) { seen.push(grouping()); h.picker.handleInput(CTRL_G); }
  expect(seen).toEqual(['project', 'none', 'date', 'project']);
});

test('each scope remembers its own grouping across tab switches', async () => {
  const project = mixed();
  const h = fixture(project, async () => project);
  h.picker.handleInput(CTRL_G); expect(h.text()).toContain('Group: None');
  h.picker.handleInput(TAB); await tick();
  expect(h.text()).toContain('Group: Project');
  h.picker.handleInput(CTRL_G); h.picker.handleInput(CTRL_G); expect(h.text()).toContain('Group: Date');
  h.picker.handleInput(TAB);
  expect(h.text()).toContain('Group: None'); expect(headings(h.text())).toEqual([]);
  h.picker.handleInput(TAB);
  expect(h.text()).toContain('Group: Date'); expect(headings(h.text())).toEqual(['2025-01-02', '2025-01-01']);
});

test('shift+up sorts ascending and shift+down sorts descending in every grouping', async () => {
  const project = mixed();
  const h = fixture(project, async () => project);
  const expectOrder = (direction: 'ascending' | 'descending', groups: string[], threads: string[]) => {
    const text = h.text();
    expect(text).toContain(`Sort: ${direction[0].toUpperCase()}${direction.slice(1)}`);
    expect(headings(text)).toEqual(groups); expect(threadOrder(text)).toEqual(threads);
  };
  // All scope starts grouped by project.
  h.picker.handleInput(TAB); await tick();
  expectOrder('descending', ['/zeta', '/alpha'], ['d', 'a', 'b', 'c']);
  h.picker.handleInput(SHIFT_UP);
  expectOrder('ascending', ['/alpha', '/zeta'], ['c', 'b', 'a', 'd']);
  h.picker.handleInput(CTRL_G);
  expectOrder('ascending', [], ['a', 'c', 'b', 'd']);
  h.picker.handleInput(SHIFT_DOWN);
  expectOrder('descending', [], ['d', 'b', 'c', 'a']);
  h.picker.handleInput(CTRL_G);
  expectOrder('descending', ['2025-01-02', '2025-01-01'], ['d', 'b', 'c', 'a']);
  h.picker.handleInput(SHIFT_UP);
  expectOrder('ascending', ['2025-01-01', '2025-01-02'], ['a', 'c', 'b', 'd']);
  h.picker.handleInput(SHIFT_UP);
  expectOrder('ascending', ['2025-01-01', '2025-01-02'], ['a', 'c', 'b', 'd']);
});

test('changing sort direction or grouping keeps focus on the same thread', () => {
  const h = fixture(mixed());
  h.picker.handleInput(DOWN);
  expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput(SHIFT_UP);
  expect(threadOrder(h.text())).toEqual(['a', 'c', 'b', 'd']); expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput(CTRL_G); expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput(SHIFT_DOWN);
  expect(threadOrder(h.text())).toEqual(['d', 'b', 'c', 'a']); expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput(DOWN); expect(h.text()).toMatch(/› \[ \].*Thread c/);
});

test('group headings are skipped during selection, and grouping preserves deletion targets', async () => {
  const h = fixture([session('a', at(2), '/alpha'), session('b', at(1), '/beta')]);
  h.picker.handleInput(' ');
  expect(h.text()).toMatch(/\[x\].*Thread a/); expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput(CTRL_G);
  expect(h.text()).toMatch(/› \[ \].*Thread b/);
  h.picker.handleInput('\r'); h.picker.handleInput('\x04');
  expect(h.text()).toContain('Permanently delete 2 threads?');
  h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0].map(s => s.id)).toEqual(['a', 'b']);
});

test('search in project grouping keeps headings and select-all targets only matching threads', async () => {
  const project = [session('a', at(1), '/project')];
  const h = fixture(project, async () => [...project, session('other', at(2), '/elsewhere')]);
  h.picker.handleInput(TAB); await tick();
  expect(headings(h.text())).toEqual(['/project', '/elsewhere']);
  h.picker.handleInput('other');
  expect(headings(h.text())).toEqual(['/elsewhere']);
  h.picker.handleInput('\x01'); h.picker.handleInput('\x04'); h.picker.handleInput('\r'); await tick();
  expect(h.deletions[0].map(s => s.id)).toEqual(['other']);
});

test('grouped scrolling repeats headings, keeps focus visible, and fits the row budget', async () => {
  const project = Array.from({ length: 30 }, (_, i) =>
    session(String(i).padStart(2, '0'), at(1 + Math.floor(i / 4), i % 4), `/project-${Math.floor(i / 3)}`));
  for (const rowBudget of [1, 2, 4, 12]) {
    const picker = new ThreadPicker({ project, rows: () => rowBudget + 10, loadAll: async () => project,
      theme, requestRender() {}, done() {}, deleteThreads: async () => [] });
    // Current project groups by date, then all projects group by project.
    for (const heading of [/^2025-01-\d{2}$/, /^\/project-\d+$/]) {
      picker.handleInput('\x1b[H');
      for (let i = 0; i < project.length; i++) {
        const rendered = picker.render(120);
        expect(rendered.filter(line => line.startsWith('› '))).toHaveLength(1);
        const listStart = rendered.findIndex(line => line.startsWith('> ')) + 2;
        const listEnd = rendered.findIndex(line => /\d+\/\d+ threads/.test(line));
        const list = rendered.slice(listStart, listEnd);
        expect(list.length).toBeLessThanOrEqual(rowBudget);
        if (rowBudget > 1) expect(list[0]).toMatch(heading);
        picker.handleInput(DOWN);
      }
      picker.handleInput(TAB); await tick();
    }
  }
});

test('rows put the title on the left and right-align date or project with age after the title', async () => {
  const thread = session('dated', at(3), '/project');
  const h = fixture([thread], async () => [thread]);
  await withNow(at(10), async () => {
    const date = formatDate(thread.modified);
    const expectRow = (right: string) => {
      const row = h.row('Thread dated')!;
      expect(row.startsWith('› [ ] Thread dated  7d ago  ')).toBe(true);
      expect(row.endsWith(`  ${right}`)).toBe(true);
      expect(visibleWidth(row)).toBe(120);
      expect(row).not.toContain(`${date}  Thread dated`);
    };
    expectRow('/project');
    h.picker.handleInput(CTRL_G); expectRow(date);
    h.picker.handleInput(TAB); await tick(); expectRow(date);
    h.picker.handleInput(CTRL_G); h.picker.handleInput(CTRL_G); expectRow('/project');
  });
});

test('the deletion confirmation still lists the date before the title', () => {
  const thread = session('dated', at(2));
  const h = fixture([thread]);
  h.picker.handleInput('\x04');
  expect(h.text()).toContain(`  ${formatDate(thread.modified)}  Thread dated`);
});

test('narrow widths truncate the title first and keep the right column aligned', async () => {
  await withNow(at(10), () => {
    const long = { ...session('long', at(3)), firstMessage: 'Long title '.repeat(20) };
    const h = fixture([long]);
    const row = h.row('Long title', 40)!;
    expect(visibleWidth(row)).toBe(40);
    expect(row.startsWith('› [ ] Long title')).toBe(true);
    expect(row).toMatch(/ {2}\/project$/);
    expect(row).not.toContain('Long title '.repeat(20).trim());

    // An oversized right column is truncated so the selection marker and part of the title stay visible.
    const deep = session('deep', at(3), `/${'nested/'.repeat(20)}project`);
    const d = fixture([deep]);
    const deepRow = d.row('› [ ]', 40)!;
    expect(visibleWidth(deepRow)).toBe(40);
    expect(deepRow.startsWith('› [ ]')).toBe(true);
    expect(deepRow).toMatch(/^› \[ \].*\.\.\..* {2}\/nested\/.*\.\.\./);

    for (const width of [1, 4, 12, 20, 40]) {
      for (const line of [...h.picker.render(width), ...d.picker.render(width)]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

test('elapsed age follows the title in minutes, hours, and days', async () => {
  const now = at(10, 12);
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const cases: [string, Date, string][] = [
    ['seconds', ago(30_000), 'just now'],
    ['future', ago(-3_600_000), 'just now'],
    ['minutes', ago(5 * 60_000 + 30_000), '5m ago'],
    ['hours', ago(3 * 3_600_000 + 59 * 60_000), '3h ago'],
    ['days', ago(2 * 86_400_000 + 3_600_000), '2d ago'],
    ['unknown', new Date(NaN), 'Unknown age'],
  ];
  await withNow(now, () => {
    const h = fixture(cases.map(([id, modified]) => session(id, modified)));
    h.picker.handleInput(CTRL_G); // none: the right column shows the date.
    for (const [id, modified, age] of cases) {
      const date = Number.isFinite(modified.getTime()) ? formatDate(modified) : 'Unknown date';
      expect(h.row(`Thread ${id}`)!).toContain(`Thread ${id}  ${age}`);
      expect(h.row(`Thread ${id}`)!.endsWith(`  ${date}`)).toBe(true);
    }
  });
});

test('threads without a valid modified date remain selectable', () => {
  const h = fixture([{ ...session('unknown'), modified: new Date(NaN) }]);
  expect(headings(h.text())).toEqual(['Unknown date']);
  expect(h.row('Thread unknown')).toMatch(/Thread unknown  Unknown age.*\/project$/);
  h.picker.handleInput(CTRL_G);
  expect(h.row('Thread unknown')).toMatch(/Thread unknown  Unknown age.*Unknown date$/);
  h.picker.handleInput(' ');
  expect(h.text()).toMatch(/\[x\].*Thread unknown/);
  h.picker.handleInput('\x04');
  expect(h.text()).toContain('Unknown date  Thread unknown');
});


test('ctrl+t previews the focused thread without selecting or deleting it', async () => {
  const project = [session('a', at(2)), session('b', at(1))];
  const viewed: string[] = [];
  const picker = new ThreadPicker({ project, loadAll: async () => [],
    theme: { fg: (_: string, x: string) => x, bold: (x: string) => x, bg: (_: string, x: string) => x } as any,
    requestRender() {}, done() {}, deleteThreads: async () => { throw new Error('unexpected deletion'); },
    viewTranscript: async thread => { viewed.push(thread.id); } });
  picker.handleInput('\x1b[B');
  picker.handleInput('\x14');
  await tick();
  expect(viewed).toEqual(['b']);
  expect(picker.render(120).join('\n')).toContain('0 selected');
});

test('the header keeps the title left and shows scope, grouping, sort, and selection on the right', async () => {
  let finishLoad!: (sessions: SessionInfo[]) => void;
  const h = fixture(defaultProject(), () => new Promise(resolve => { finishLoad = resolve; }));
  const header = () => h.picker.render(140)[2];
  expect(header().startsWith('Delete threads (Current project)')).toBe(true);
  expect(header().endsWith('◉ Current project | ○ All  Group: Date  Sort: Descending  0 selected')).toBe(true);
  expect(visibleWidth(header())).toBe(140);
  // Key hints describe actions only. State lives in the header.
  const hints = h.picker.render(140).slice(3, 5).join('\n');
  expect(hints).toContain('ctrl+g group'); expect(hints).toContain('shift+↑↓ sort');
  expect(hints).not.toMatch(/\(date\)|descending|selected$/);

  h.picker.handleInput(' '); h.picker.handleInput(SHIFT_UP); h.picker.handleInput(CTRL_G);
  expect(header()).toMatch(/Group: None {2}Sort: Ascending {2}1 selected$/);
  h.picker.handleInput(TAB);
  expect(header()).toMatch(/^Delete threads \(All projects\).*○ Current project \| Loading… {2}Group: Project/);
  finishLoad(defaultProject()); await tick();
  expect(header()).toMatch(/○ Current project \| ◉ All {2}Group: Project {2}Sort: Ascending {2}1 selected$/);
  h.picker.handleInput('\x04');
  expect(header()).toContain('Delete threads (All projects)');
  expect(h.text()).toContain('Permanently delete 1 thread?');
});

test('narrow headers move state to its own line, drop trailing state, and keep the list within the row budget', () => {
  const project = Array.from({ length: 20 }, (_, i) => session(String(i).padStart(2, '0'), at(3, 12, i)));
  const picker = new ThreadPicker({ project, rows: () => 16, loadAll: async () => project,
    theme, requestRender() {}, done() {}, deleteThreads: async () => [] });
  const listLength = (width: number) => {
    const lines = picker.render(width);
    const start = lines.findIndex(line => line.startsWith('> ')) + 2;
    return lines.slice(start, lines.findIndex(line => /\d+\/\d+ threads/.test(line))).length;
  };
  const wide = picker.render(120);
  expect(wide[2]).toContain('Delete threads (Current project)'); expect(wide[2]).toContain('0 selected');
  const mid = picker.render(80);
  expect(mid[2]).toBe('Delete threads (Current project)');
  expect(mid[3].endsWith('◉ Current project | ○ All  Group: Date  Sort: Descending  0 selected')).toBe(true);
  expect(listLength(80)).toBe(listLength(120) - 1);
  const narrow = picker.render(40);
  expect(narrow[2]).toBe('Delete threads (Current project)');
  expect(narrow[3].trim()).toBe('◉ Current project | ○ All  Group: Date');
  const tiny = picker.render(16);
  expect(tiny.slice(2, 4).map(stripTerminalSequences)).toEqual(['Delete threads …', '◉ Current proje…']);
  for (const width of [1, 2, 16, 33, 40, 60, 80, 101, 120]) {
    for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

// Open mode reuses the picker list, header, search, grouping, and sorting without selection or deletion.
function openFixture(project = defaultProject(), loadAll?: () => Promise<SessionInfo[]>) {
  const opened: string[] = [];
  const viewed: string[] = [];
  let exited = false;
  const picker = new ThreadPicker({ project, loadAll: loadAll ?? (async () => [...project, session('other', at(2))]),
    theme, requestRender() {}, done: () => { exited = true; },
    openThread: thread => { opened.push(thread.id); }, viewTranscript: async thread => { viewed.push(thread.id); } });
  picker.focused = true;
  return { picker, opened, viewed, text: (width = 120) => picker.render(width).join('\n'),
    row: (title: string, width = 120) => picker.render(width).find(line => line.includes(title)),
    get exited() { return exited; } };
}

test('open mode shows an open title, no checkboxes or selection count, and open hints only', () => {
  const h = openFixture();
  const lines = h.picker.render(140);
  expect(lines[2].startsWith('Open thread (Current project)')).toBe(true);
  expect(lines[2].endsWith('◉ Current project | ○ All  Group: Date  Sort: Descending')).toBe(true);
  const text = h.text();
  expect(text).not.toMatch(/\[[ x]\]|selected|delete|select all|space/i);
  expect(lines.slice(3, 5).join('\n')).toBe(
    'tab scope · ↑↓ navigate · enter open · ctrl+t transcript\nctrl+g group · shift+↑↓ sort · esc cancel');
  expect(text).toMatch(/› Thread a/);
  expect(threadOrder(text)).toEqual(['a', 'b', 'c']);
});

test('open mode enter opens the highlighted thread once and then ignores input', () => {
  const h = openFixture();
  h.picker.handleInput(DOWN); h.picker.handleInput('\r');
  expect(h.opened).toEqual(['b']);
  h.picker.handleInput('\r'); h.picker.handleInput(DOWN); h.picker.handleInput('\r'); h.picker.handleInput('\x1b');
  expect(h.opened).toEqual(['b']); expect(h.exited).toBe(false);
});

test('open mode escape and ctrl+c cancel without opening, and enter with no match does nothing', () => {
  for (const key of ['\x1b', '\x03']) {
    const h = openFixture(); h.picker.handleInput(key);
    expect(h.exited).toBe(true); expect(h.opened).toEqual([]);
  }
  const h = openFixture(); h.picker.handleInput('zzz'); h.picker.handleInput('\r');
  expect(h.text()).toContain('No matching threads'); expect(h.opened).toEqual([]); expect(h.exited).toBe(false);
});

test('open mode sends space, ctrl+a, and ctrl+d to the search box instead of selecting or deleting', () => {
  const h = openFixture([session('a', at(3, 12)), { ...session('b', at(3, 11)), firstMessage: 'Thread b with spaces' }]);
  const plain = () => stripTerminalSequences(h.text());
  h.picker.handleInput('b'); h.picker.handleInput(' '); h.picker.handleInput('w');
  expect(plain()).toContain('> b w'); expect(threadOrder(h.text())).toEqual(['b']);
  // Ctrl+A moves the search cursor to the start, and Ctrl+D deletes the character after it.
  h.picker.handleInput('\x01'); h.picker.handleInput('\x04');
  expect(plain()).not.toMatch(/Permanently delete|selected|\[x\]/);
  expect(plain()).toContain('>  w');
  expect(h.opened).toEqual([]);
});

test('open mode reuses search, scopes, per-scope grouping, and sort direction', async () => {
  const project = mixed();
  const h = openFixture(project.slice(1), async () => project);
  expect(headings(h.text())).toEqual(['2025-01-02', '2025-01-01']);
  h.picker.handleInput(TAB); await tick();
  expect(h.text()).toContain('Open thread (All projects)');
  expect(h.text()).toContain('Group: Project');
  expect(headings(h.text())).toEqual(['/zeta', '/alpha']); expect(threadOrder(h.text())).toEqual(['d', 'a', 'b', 'c']);
  h.picker.handleInput(SHIFT_UP);
  expect(threadOrder(h.text())).toEqual(['c', 'b', 'a', 'd']);
  h.picker.handleInput(CTRL_G); expect(h.text()).toContain('Group: None');
  h.picker.handleInput(TAB); expect(h.text()).toContain('Group: Date');
  h.picker.handleInput(TAB); h.picker.handleInput('zeta');
  expect(threadOrder(h.text())).toEqual(['a', 'd']);
  h.picker.handleInput(DOWN); h.picker.handleInput('\r');
  expect(h.opened).toEqual(['d']);
});

test('open mode rows keep the title then age on the left and the date or project at the far right', async () => {
  const thread = session('dated', at(3), '/project');
  const h = openFixture([thread], async () => [thread]);
  await withNow(at(10), () => {
    const row = h.row('Thread dated')!;
    expect(row.startsWith('› Thread dated  7d ago  ')).toBe(true);
    expect(row.endsWith('  /project')).toBe(true);
    expect(visibleWidth(row)).toBe(120);
    h.picker.handleInput(CTRL_G);
    expect(h.row('Thread dated')!.endsWith(`  ${formatDate(thread.modified)}`)).toBe(true);
    for (const width of [1, 8, 40]) for (const line of h.picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});

test('open mode ctrl+t previews the highlighted thread without opening it, and preview errors stay visible', async () => {
  const h = openFixture();
  h.picker.handleInput(DOWN); h.picker.handleInput('\x14'); await tick();
  expect(h.viewed).toEqual(['b']); expect(h.opened).toEqual([]);
  const failing = new ThreadPicker({ project: [session('a')], loadAll: async () => [], theme, requestRender() {}, done() {},
    openThread() {}, viewTranscript: async () => { throw new Error('unreadable'); } });
  failing.handleInput('\x14'); await tick();
  expect(failing.render(120).join('\n')).toContain('Could not open transcript: unreadable');
});
