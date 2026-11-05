import { access, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readTranscript, ThreadTranscript } from './thread-transcript.ts';
import { ThreadPicker } from './thread-picker.ts';
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type SessionInfo } from '@earendil-works/pi-coding-agent';
import { errorMessage } from './shared.ts';
import { sessionSearchText } from './threads/search.ts';

export function matchingSessions(sessions: SessionInfo[], current: string | undefined, query: string): SessionInfo[] {
  const search = query.toLocaleLowerCase();
  return sessions.filter(session => (!current || resolve(session.path) !== resolve(current)) &&
    sessionSearchText(session).includes(search));
}

export async function deleteFiles(paths: string[]): Promise<{ deleted: number; deletedPaths: string[]; failures: string[] }> {
  const deletedPaths: string[] = [];
  const failures: string[] = [];
  for (const path of new Set(paths)) {
    try {
      await unlink(path);
      deletedPaths.push(path);
    } catch (error) {
      failures.push(`${path}: ${errorMessage(error)}`);
    }
  }
  return { deleted: deletedPaths.length, deletedPaths, failures };
}

function interactive(ctx: ExtensionCommandContext): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify('Thread deletion requires an interactive UI.', 'error');
  return false;
}

async function savedSessionFile(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const path = ctx.sessionManager.getSessionFile();
  if (!path) return undefined;
  try {
    await access(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function report(ctx: ExtensionCommandContext, result: Awaited<ReturnType<typeof deleteFiles>>): void {
  ctx.ui.notify(`Deleted ${result.deleted} saved thread${result.deleted === 1 ? '' : 's'}.`, 'info');
  if (result.failures.length) ctx.ui.notify(`Could not delete:\n${result.failures.join('\n')}`, 'error');
}

export default function threads(pi: ExtensionAPI): void {
  pi.registerCommand('delete', {
    description: 'Delete current thread and start a new chat',
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      if (args.trim()) { ctx.ui.notify('Usage: /delete', 'error'); return; }
      await ctx.waitForIdle();
      const path = await savedSessionFile(ctx);
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
    description: 'Delete multiple threads',
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('The thread picker requires the terminal UI.', 'error');
        return;
      }
      await ctx.waitForIdle();
      try {
        const current = ctx.sessionManager.getSessionFile();
        const project = matchingSessions(await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir() || undefined), current, '');
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ThreadPicker({
          project,
          loadAll: async () => {
            const sessions = await SessionManager.listAll();
            // Include the active project's custom session directory in the All scope.
            const combined = new Map([...sessions, ...project].map(session => [resolve(session.path), session]));
            return matchingSessions([...combined.values()], current, '').sort((a, b) => b.modified.getTime() - a.modified.getTime());
          },
          viewTranscript: async (session) => {
            const text = await readTranscript(session.path);
            await ctx.ui.custom<void>((viewerTui, _theme, _keys, close) => new ThreadTranscript(
              session.name || session.firstMessage || session.id, text,
              () => viewerTui.terminal.rows, () => close(), () => viewerTui.requestRender()),
            { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', row: 0, col: 0, margin: 0 } });
          },
          query: args.trim(),
          theme,
          rows: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          done: () => done(),
          deleteThreads: async (sessions) => {
            const result = await deleteFiles(sessions.map(session => session.path));
            report(ctx, result);
            return result.deletedPaths;
          },
        }));
      } catch (error) {
        ctx.ui.notify(`Thread deletion failed: ${errorMessage(error)}`, 'error');
      }
    },
  });
}
