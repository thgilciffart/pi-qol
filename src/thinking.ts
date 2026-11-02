import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';

export default function thinking(pi: ExtensionAPI): void {
  function cycle(ctx: ExtensionContext, direction: -1 | 1): void {
    if (!ctx.model?.reasoning) {
      ctx.ui.notify('Current model does not support thinking.', 'info');
      return;
    }
    const levels = getSupportedThinkingLevels(ctx.model);
    if (!levels.length) {
      ctx.ui.notify('Current model has no available thinking levels.', 'info');
      return;
    }
    const index = levels.indexOf(pi.getThinkingLevel());
    const next = index < 0 ? (direction === 1 ? 0 : levels.length - 1)
      : (index + direction + levels.length) % levels.length;
    pi.setThinkingLevel(levels[next]!);
    ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, 'info');
  }

  pi.registerShortcut(Key.alt(','), {
    description: 'Previous thinking level',
    handler: ctx => cycle(ctx, -1),
  });
  pi.registerShortcut(Key.alt('.'), {
    description: 'Next thinking level',
    handler: ctx => cycle(ctx, 1),
  });
}
