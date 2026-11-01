import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import open from 'open';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { enhanceHtml } from './enhance.ts';
import { nativeExport } from './native-export.ts';
import { parseOptions } from './options.ts';
import { conversationOnly, readSessionData, writeSessionData } from './session.ts';
import { redactSession, reviewRedactions } from './redact.ts';

export async function exportCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  let staging: string | undefined;
  try {
    await ctx.waitForIdle();
    if (!ctx.sessionManager.getSessionFile()) throw new Error('Nothing to export yet. Start a conversation first.');
    const options = parseOptions(args);
    if (options.redact && !ctx.hasUI) throw new Error('Redaction preview requires an interactive Pi UI.');
    let filename = options.filename;
    filename ||= `pi-session-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
    if (!/\.html?$/i.test(filename)) throw new Error('Choose an .html or .htm file. Usage: /better-export [--conversation] [--redact] [file.html]');
    if (filename.startsWith('~/')) filename = join(homedir(), filename.slice(2));
    const target = resolve(ctx.cwd, filename);
    try {
      await access(target);
      if (!ctx.hasUI) throw new Error(`File already exists: ${target}`);
      if (!await ctx.ui.confirm('Replace existing export?', target)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    staging = await mkdtemp(join(dirname(target), '.pi-better-export-'));
    const temporary = join(staging, 'session.html');
    await nativeExport(pi, ctx, temporary);
    let html = await readFile(temporary, 'utf8');
    if (options.conversation || options.redact) {
      let data = readSessionData(html);
      if (options.conversation) data = conversationOnly(data);
      if (options.redact) {
        const redacted = redactSession(data, { home: homedir(), cwd: ctx.cwd, literals: options.literals });
        if (!await reviewRedactions(ctx, redacted.findings)) return;
        data = redacted.data;
      }
      html = writeSessionData(html, data);
      if (options.conversation) html = html.replace(/<html\b/, '<html data-better-export-conversation="true"');
    }
    await writeFile(temporary, await enhanceHtml(html), 'utf8');
    await rename(temporary, target);
    ctx.ui.notify(`Exported to ${target}`, 'info');
    if (ctx.hasUI && await ctx.ui.confirm('Open exported HTML?', 'Open this export in your default browser?')) {
      try {
        await open(pathToFileURL(target).href, { wait: false });
      } catch (error) {
        ctx.ui.notify(`Export saved, but the browser could not be opened: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    }
  } catch (error) {
    ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

export default function betterExport(pi: ExtensionAPI): void {
  pi.registerCommand('better-export', {
    description: 'Export Pi HTML with LaTeX, print/PDF, --conversation, --redact, or --share',
    handler: (args, ctx) => exportCommand(pi, args, ctx),
  });
}
