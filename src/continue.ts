import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';

export const CONTINUE_MESSAGE = 'pi-qol-continue';
export const CONTINUE_SHORTCUT = Key.ctrlAlt('c');

export default function continueTurn(pi: ExtensionAPI): void {
  function resume(ctx: ExtensionContext): void {
    if (!ctx.isIdle()) {
      ctx.ui.notify('The agent is already working.', 'info');
      return;
    }
    if (ctx.hasPendingMessages()) {
      ctx.ui.notify('There is already a message waiting.', 'info');
      return;
    }
    const hasConversation = ctx.sessionManager.getBranch().some(entry => entry.type === 'message' &&
      (entry.message.role === 'user' || entry.message.role === 'assistant'));
    if (!hasConversation) {
      ctx.ui.notify('No conversation to continue. Send a message first.', 'info');
      return;
    }
    pi.sendMessage({
      customType: CONTINUE_MESSAGE,
      content: 'The user requested continuing the most recent unfinished turn after an interruption. ' +
        'Continue the existing task from the current conversation and work state. Preserve the original instructions and constraints. ' +
        'Check the current state of interrupted tools or processes before repeating operations, and avoid repeating completed work. ' +
        'If the task is already complete, report that rather than inventing new work.',
      display: false,
    }, { triggerTurn: true });
  }

  pi.registerCommand('continue', {
    description: 'Continue an interrupted turn',
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('Usage: /continue', 'error');
        return;
      }
      resume(ctx);
    },
  });
  pi.registerShortcut(CONTINUE_SHORTCUT, {
    description: 'Continue an interrupted turn',
    handler: resume,
  });
}
