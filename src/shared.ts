import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Replace a JSON file only after its complete contents have been written. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function completions(choices: readonly string[], prefix: string) {
  const matches = choices.filter(value => value.startsWith(prefix));
  return matches.length ? matches.map(value => ({ value, label: value })) : null;
}

export function findModelRef(registry: Pick<ExtensionContext['modelRegistry'], 'find'>, reference: string) {
  const separator = reference.indexOf('/');
  if (separator <= 0) return undefined;
  return registry.find(reference.slice(0, separator), reference.slice(separator + 1));
}

export function hasConversation(entries: readonly SessionEntry[]): boolean {
  return entries.some(entry => entry.type === 'message' &&
    (entry.message.role === 'user' || entry.message.role === 'assistant'));
}
