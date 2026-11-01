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
      content: 'Continue the unfinished task from where you left off.',
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
