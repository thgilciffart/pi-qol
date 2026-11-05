import { readFile } from 'node:fs/promises';
import type { Component } from '@earendil-works/pi-tui';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

function safe(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ');
}

/** Read every saved message, including tool calls, results, and thinking. */
export async function readTranscript(path: string): Promise<string> {
  const entries = (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const messages = entries.filter(entry => entry.type === 'message').map(entry => {
    const message = entry.message;
    const content = typeof message.content === 'string' ? message.content : (message.content ?? []).map((block: any) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'thinking') return `[Thinking]\n${block.thinking}`;
      if (block.type === 'toolCall') return `[Tool call: ${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
      if (block.type === 'image') return `[Image: ${block.mimeType ?? 'image'}]`;
      return JSON.stringify(block, null, 2);
    }).join('\n\n');
    return `${message.role}${message.toolName ? ` (${message.toolName})` : ''} · ${entry.timestamp ?? ''}\n${content}`;
  });
  return safe(messages.join('\n\n────────────────────\n\n') || 'No saved messages.');
}

/** An opaque, terminal-sized transcript overlay. */
export class ThreadTranscript implements Component {
  private offset = 0;
  private lines: string[] = [];
  constructor(private title: string, private text: string, private rows: () => number,
    private close: () => void, private requestRender: () => void) {}

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+t') || matchesKey(data, 'ctrl+c')) { this.close(); return; }
    const page = Math.max(1, this.rows() - 3);
    if (matchesKey(data, 'up')) this.offset--;
    else if (matchesKey(data, 'down')) this.offset++;
    else if (matchesKey(data, 'pageUp')) this.offset -= page;
    else if (matchesKey(data, 'pageDown') || matchesKey(data, 'space')) this.offset += page;
    else if (matchesKey(data, 'home')) this.offset = 0;
    else if (matchesKey(data, 'end')) this.offset = this.lines.length;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - page)));
    this.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(1, this.rows());
    const page = Math.max(0, height - 3);
    this.lines = this.text.split('\n').flatMap(line => wrapTextWithAnsi(line, width));
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - page)));
    const content = [safe(`Transcript: ${this.title}`), '↑↓ scroll · pgup/pgdn page · home/end · esc return', '',
      ...this.lines.slice(this.offset, this.offset + page)];
    return Array.from({ length: height }, (_, i) => {
      const line = truncateToWidth(content[i] ?? '', width);
      return line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
    });
  }
  invalidate(): void {}
}
