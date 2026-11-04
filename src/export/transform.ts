import { homedir } from 'node:os';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { enhanceHtml } from './enhance.ts';
import type { ExportOptions } from './options.ts';
import { redactSession, reviewRedactions } from './redact.ts';
import { conversationOnly, readSessionData, writeSessionData } from './session.ts';

/**
 * Apply --conversation and --redact to Pi's native HTML, then add math and print support.
 * Returns undefined when the user cancels the redaction preview.
 */
export async function transformHtml(html: string, options: ExportOptions, ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (options.conversation || options.redact) {
    let data = readSessionData(html);
    if (options.conversation) data = conversationOnly(data);
    if (options.redact) {
      const redacted = redactSession(data, { home: homedir(), cwd: ctx.cwd, literals: options.literals });
      if (!await reviewRedactions(ctx, redacted.findings)) return undefined;
      data = redacted.data;
    }
    html = writeSessionData(html, data);
    if (options.conversation) html = html.replace(/<html\b/, '<html data-better-export-conversation="true"');
  }
  return enhanceHtml(html);
}
