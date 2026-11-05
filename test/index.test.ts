import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from 'bun:test';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

test('Pi loads the bundled extension and registers its commands, tools, and shortcuts', async () => {
  const { loadExtensions } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/extensions/loader.js')).href);
  const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
  const result = await loadExtensions([entry], process.cwd());
  expect(result.errors).toEqual([]);
  expect(result.extensions).toHaveLength(1);
  const extension = result.extensions[0];

  for (const command of ['better-export', 'ephemeral', 'delete', 'delete-threads', 'open', 'goal', 'auto-name', 'continue', 'statusline', 'plugins']) {
    expect(extension.commands.has(command)).toBe(true);
  }
  for (const tool of ['get_goal', 'create_goal', 'update_goal', 'ask_user']) expect(extension.tools.has(tool)).toBe(true);
  for (const shortcut of ['ctrl+alt+c', 'alt+p', 'alt+,', 'alt+.']) expect(extension.shortcuts.has(shortcut)).toBe(true);
  expect(extension.commands.has('status-line')).toBe(false);
  expect(extension.commands.has('status')).toBe(false);
  expect(extension.commands.has('ask-demo')).toBe(false);
  expect(extension.commands.has('agents')).toBe(false);
  expect(extension.tools.has('subagent')).toBe(false);
  expect(extension.shortcuts.has('ctrl+e')).toBe(false);
});
