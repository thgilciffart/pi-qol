import { ModelSelectorComponent, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { findModelRef } from './shared.ts';

export async function pickNamingModel(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
  if (!ctx.hasUI) throw new Error('Usage: /auto-name model <provider/model|current>');
  if (ctx.mode !== 'tui') {
    const followChat = 'current (use the chat model)';
    const models = ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`);
    const selected = await ctx.ui.select('Naming model', [followChat, ...new Set(models)]);
    return selected === followChat ? 'current' : selected;
  }

  const selectedModel = current === 'current' ? ctx.model : findModelRef(ctx.modelRegistry, current);
  // The native selector needs four runtime methods. Forward them through the
  // public extension registry so it uses Pi's existing models and credentials.
  type Runtime = ConstructorParameters<typeof ModelSelectorComponent>[2];
  const runtime: Pick<Runtime, 'getAvailableSnapshot' | 'getModel' | 'refresh' | 'getError'> = {
    getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
    getModel: (provider, id) => ctx.modelRegistry.find(provider, id),
    refresh: options => ctx.modelRegistry.refresh(options),
    getError: () => ctx.modelRegistry.getError(),
  };
  return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
    const select = (model: NonNullable<ExtensionCommandContext['model']>) => done(`${model.provider}/${model.id}`);
    return new ModelSelectorComponent(tui, selectedModel, runtime as Runtime, ctx.scopedModels ?? [],
      select, () => done(undefined), undefined, select);
  });
}
