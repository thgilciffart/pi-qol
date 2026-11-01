import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type SessionInfo } from '@earendil-works/pi-coding-agent';

export function matchingSessions(sessions: SessionInfo[], current: string | undefined, query: string): SessionInfo[] {
  const search = query.toLocaleLowerCase();
  return sessions.filter(session => (!current || resolve(session.path) !== resolve(current)) &&
    `${session.name ?? ''}\n${session.firstMessage}\n${session.cwd}\n${session.id}`.toLocaleLowerCase().includes(search));
}

export async function deleteFiles(paths: string[]): Promise<{ deleted: number; failures: string[] }> {
  let deleted = 0;
  const failures: string[] = [];
  for (const path of new Set(paths)) {
    try { await unlink(path); deleted++; }
    catch (error) { failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { deleted, failures };
}

function interactive(ctx: ExtensionCommandContext): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify('Thread deletion requires an interactive UI.', 'error');
  return false;
}

function report(ctx: ExtensionCommandContext, result: Awaited<ReturnType<typeof deleteFiles>>): void {
  ctx.ui.notify(`Deleted ${result.deleted} saved thread${result.deleted === 1 ? '' : 's'}.`, 'info');
  if (result.failures.length) ctx.ui.notify(`Could not delete:\n${result.failures.join('\n')}`, 'error');
}

export default function threads(pi: ExtensionAPI): void {
  pi.registerCommand('delete', {
    description: 'Delete the current thread after confirmation and start a new chat',
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      if (args.trim()) { ctx.ui.notify('Usage: /delete', 'error'); return; }
      await ctx.waitForIdle();
      const path = ctx.sessionManager.getSessionFile();
      if (!await ctx.ui.confirm('Delete current thread?', path
        ? `Permanently delete ${path} and start a new chat? This cannot be undone.`
        : 'Discard this unsaved chat and start a new one?')) return;
      const result = await ctx.newSession({
        withSession: async (next) => {
          if (path) report(next, await deleteFiles([path]));
          else next.ui.notify('Discarded the unsaved chat.', 'info');
        },
      });
      if (result.cancelled) ctx.ui.notify('Thread deletion cancelled.', 'info');
    },
  });
  pi.registerCommand('delete-threads', {
    description: 'Select saved threads to delete: /delete-threads [--all-projects] [search text]',
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      await ctx.waitForIdle();
      const all = /^--all-projects(?:\s|$)/.test(args.trim());
      const query = (all ? args.trim().replace(/^--all-projects\s*/, '') : args).trim();
      try {
        const sessions = matchingSessions(all ? await SessionManager.listAll() :
          await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir() || undefined), ctx.sessionManager.getSessionFile(), query);
        if (!sessions.length) { ctx.ui.notify('No matching saved threads. The current thread is excluded.', 'info'); return; }
        const selected = new Set<string>();
        while (true) {
          const actions = [`Delete selected (${selected.size})`, 'Select all matches', 'Clear selection', 'Cancel'];
          const labels = sessions.map((session, index) => {
            const title = (session.name || session.firstMessage || session.id).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 100);
            return `${selected.has(session.path) ? '[x]' : '[ ]'} ${index + 1}. ${title} · ${session.modified.toISOString().slice(0, 10)} · ${session.cwd}`;
          });
          const choice = await ctx.ui.select(`Saved threads${all ? ' in all projects' : ' in this project'} (${sessions.length})`, [...actions, ...labels]);
          if (!choice || choice === 'Cancel') return;
          if (choice === actions[1]) { for (const session of sessions) selected.add(session.path); continue; }
          if (choice === actions[2]) { selected.clear(); continue; }
          if (choice === actions[0]) {
            if (!selected.size) continue;
            if (!await ctx.ui.confirm(`Delete ${selected.size} saved threads?`,
              `This permanently removes the selected session files and cannot be undone.\n\n${sessions.filter(s => selected.has(s.path)).map(s => s.path).join('\n')}`)) return;
            report(ctx, await deleteFiles([...selected]));
            return;
          }
          const session = sessions[labels.indexOf(choice)];
          if (session) { if (selected.has(session.path)) selected.delete(session.path); else selected.add(session.path); }
        }
      } catch (error) {
        ctx.ui.notify(`Thread deletion failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
