import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import open from 'open';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { errorMessage } from '../shared.ts';
import { nativeExport } from './native-export.ts';
import { parseOptions } from './options.ts';
import { resolveTarget } from './target.ts';
import { transformHtml } from './transform.ts';

const IN_MEMORY_SESSION = 'HTML export needs a saved session. This session is in memory only ' +
  '(for example, Pi was started with --no-session or the session is ephemeral), so there is no session file to export.';

async function offerToOpen(target: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || !await ctx.ui.confirm('Open exported HTML?', 'Open this export in your default browser?')) return;
  try {
    await open(pathToFileURL(target).href, { wait: false });
  } catch (error) {
    ctx.ui.notify(`Export saved, but the browser could not be opened: ${errorMessage(error)}`, 'warning');
  }
}

export async function exportCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  let staging: string | undefined;
  try {
    // The native exporter snapshots recorded entries without interrupting a running turn.
    if (!ctx.sessionManager.getSessionFile()) throw new Error(IN_MEMORY_SESSION);
    const options = parseOptions(args);
    if (options.redact && !ctx.hasUI) throw new Error('Redaction preview requires an interactive Pi UI.');
    const target = await resolveTarget(options, ctx);
    if (!target) return;

    // Stage next to the target so the final rename is atomic and the destination is untouched until then.
    await mkdir(dirname(target), { recursive: true });
    staging = await mkdtemp(join(dirname(target), '.pi-better-export-'));
    const temporary = join(staging, 'session.html');
    await nativeExport(pi, ctx, temporary);
    const html = await transformHtml(await readFile(temporary, 'utf8'), options, ctx);
    if (html === undefined) return;
    await writeFile(temporary, html, 'utf8');
    await rename(temporary, target);

    ctx.ui.notify(`Exported to ${target}`, 'info');
    await offerToOpen(target, ctx);
  } catch (error) {
    ctx.ui.notify(`Export failed: ${errorMessage(error)}`, 'error');
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

export default function betterExport(pi: ExtensionAPI): void {
  pi.registerCommand('better-export', {
    description: 'Export Pi HTML, including during a turn, with LaTeX, print/PDF, --conversation, --redact, or --share',
    handler: (args, ctx) => exportCommand(pi, args, ctx),
  });
}
