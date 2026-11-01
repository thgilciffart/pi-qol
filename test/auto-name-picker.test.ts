import { describe, expect, test } from 'bun:test';
import { initTheme, ModelSelectorComponent } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { pickNamingModel } from '../src/auto-name-picker.ts';

initTheme('dark');

function fixture(options: { current?: string; scoped?: boolean; mode?: string; rpcSelection?: string } = {}) {
  const alpha = { provider: 'anthropic', id: 'alpha-chat', name: 'Alpha Chat', reasoning: true, input: ['text'], maxTokens: 8192, contextWindow: 100000 };
  const beta = { ...alpha, provider: 'openai', id: 'beta-title', name: 'Beta Title' };
  const gamma = { ...alpha, provider: 'openai', id: 'gamma-coder', name: 'Gamma Coder' };
  const models = [alpha, beta, gamma];
  let component: any;
  let customCalls = 0;
  let refreshes = 0;
  const stringSelects: { title: string; values: string[] }[] = [];
  const ctx: any = {
    hasUI: true, mode: options.mode ?? 'tui', model: alpha,
    scopedModels: options.scoped ? [{ model: alpha, thinkingLevel: 'low' }] : [],
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      refresh: async () => { refreshes++; return { errors: new Map(), aborted: false }; },
      getError: () => undefined,
    },
    setModel: () => { throw new Error('The naming picker must not switch the chat model'); },
    ui: {
      custom: (factory: any) => {
        customCalls++;
        return new Promise(resolve => {
          component = factory({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, {}, {}, resolve);
        });
      },
      select: async (title: string, values: string[]) => {
        stringSelects.push({ title, values });
        return options.rpcSelection;
      },
    },
  };
  const result = pickNamingModel(ctx, options.current ?? 'current');
  return { ctx, result, models, stringSelects, component: () => component, refreshes: () => refreshes,
    customCalls: () => customCalls, text: () => stripTerminalSequences(component.render(120).join('\n')),
    key: (key: string) => component.handleInput(key), dispose: () => component?.dispose() };
}

describe('native auto-name model picker', () => {
  test('uses Pi\'s searchable native selector and returns a naming model without switching chat', async () => {
    const h = fixture();
    try {
      expect(h.component()).toBeInstanceOf(ModelSelectorComponent);
      expect(h.customCalls()).toBe(1);
      expect(h.refreshes()).toBe(1);
      h.key('beta');
      expect(h.text()).toContain('beta-title');
      expect(h.text()).not.toContain('gamma-coder');
      h.key('\r');
      expect(await h.result).toBe('openai/beta-title');
      expect(h.ctx.model).toBe(h.models[0]);
      expect(h.stringSelects).toHaveLength(0);
    } finally { h.dispose(); }
  });

  test('Tab switches scoped and all models while preserving the search', async () => {
    const h = fixture({ scoped: true });
    try {
      expect(h.text()).toContain('Scope: all | scoped');
      expect(h.text()).toContain('alpha-chat');
      expect(h.text()).not.toContain('beta-title');
      h.key('beta');
      expect(h.text()).toContain('No matching models');
      h.key('\t');
      expect(h.text()).toContain('beta-title');
      h.key('\t');
      expect(h.text()).toContain('No matching models');
      h.key('\t');
      h.key('\r');
      expect(await h.result).toBe('openai/beta-title');
    } finally { h.dispose(); }
  });

  test('the configured naming model is checked and selected independently of the chat model', async () => {
    const h = fixture({ current: 'openai/beta-title' });
    try {
      const checkedLine = h.text().split('\n').find(line => line.includes('beta-title'));
      expect(checkedLine).toContain('✓');
      h.key('\r');
      expect(await h.result).toBe('openai/beta-title');
      expect(h.ctx.model.id).toBe('alpha-chat');
    } finally { h.dispose(); }
  });

  test('Escape cancels the native selector', async () => {
    const h = fixture();
    try {
      h.key('beta');
      h.key('\x1b');
      expect(await h.result).toBeUndefined();
      expect(h.ctx.model.id).toBe('alpha-chat');
    } finally { h.dispose(); }
  });

  test('RPC uses the supported string picker and retains the current-model option', async () => {
    const h = fixture({ mode: 'rpc', rpcSelection: 'current (use the chat model)' });
    expect(await h.result).toBe('current');
    expect(h.customCalls()).toBe(0);
    expect(h.stringSelects[0].values).toContain('openai/beta-title');
  });
});
