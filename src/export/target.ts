import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { ExportOptions } from './options.ts';

const USAGE = 'Usage: /better-export [--conversation] [--redact] [file.html]';

export const TEMP_EXPORT_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp';

export function exportFilename(options: ExportOptions): string {
  const filename = options.filename || `pi-session-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
  if (!/\.html?$/i.test(filename)) throw new Error(`Choose an .html or .htm file. ${USAGE}`);
  return filename;
}

/**
 * Absolute destination for the export, or undefined when the user declines to replace an existing file.
 * Without a UI an existing file is never replaced.
 */
export async function resolveTarget(filename: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (filename.startsWith('~/')) filename = join(homedir(), filename.slice(2));
  const target = resolve(ctx.cwd, filename);
  try {
    await access(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw error;
  }
  if (!ctx.hasUI) throw new Error(`File already exists: ${target}`);
  return await ctx.ui.confirm('Replace existing export?', target) ? target : undefined;
}
