import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { readTranscript, ThreadTranscript } from '../src/thread-transcript.ts';

test('transcript includes all message types and strips terminal controls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-'));
  try {
    const path = join(dir, 'session.jsonl');
    await writeFile(path, [
      { type: 'session' },
      { type: 'message', message: { role: 'user', content: 'Hello\x1b[31m' } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Consider this' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: 'Done' },
        { type: 'image', mimeType: 'image/png', data: 'BASE64' },
      ] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'file.ts' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    const text = await readTranscript(path);
    for (const expected of ['Hello', 'Consider this', 'Tool call: bash', '"command": "ls"', 'Done', 'Image: image/png', 'toolResult (bash)', 'file.ts']) expect(text).toContain(expected);
    expect(text).not.toContain('\x1b'); expect(text).not.toContain('BASE64');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('viewer fills the terminal, scrolls to the end, resizes, and closes', () => {
  let height = 10, closed = false;
  const viewer = new ThreadTranscript('Title', Array.from({ length: 60 }, (_, i) => `Line ${i} 界`).join('\n'),
    () => height, () => { closed = true; }, () => {});
  expect(viewer.render(40)).toHaveLength(10);
  expect(viewer.render(40).join('\n')).toContain('Line 0');
  viewer.handleInput('\x1b[F');
  expect(viewer.render(40).join('\n')).toContain('Line 59');
  viewer.handleInput('\x1b[H');
  expect(viewer.render(40).join('\n')).toContain('Line 0');
  height = 6;
  for (const width of [1, 8, 40]) {
    const lines = viewer.render(width);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
  }
  viewer.handleInput('\x1b'); expect(closed).toBe(true);
});
