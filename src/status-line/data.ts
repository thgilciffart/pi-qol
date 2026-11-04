import type { Usage } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { StatusSnapshot, UsageSummary } from './render.ts';

/** Session files come from disk, so numeric fields are still checked at runtime. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function add(totals: UsageSummary, usage: Usage | undefined): void {
  if (!usage) return;
  totals.input += num(usage.input);
  totals.output += num(usage.output);
  totals.cacheRead += num(usage.cacheRead);
  totals.cacheWrite += num(usage.cacheWrite);
  totals.cost += num(usage.cost?.total);
}

/** Cumulative usage across all session entries, matching what Pi's built-in footer counts. */
export function computeUsage(entries: readonly SessionEntry[]): UsageSummary {
  const totals: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    if (entry.type === 'usage' || entry.type === 'branch_summary' || entry.type === 'compaction') {
      add(totals, entry.usage);
    } else if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const usage = entry.message.usage;
      add(totals, usage);
      if (usage) {
        const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
        totals.cacheHitRate = prompt > 0 ? (num(usage.cacheRead) / prompt) * 100 : undefined;
      }
    } else if (entry.type === 'message' && entry.message?.role === 'toolResult') {
      add(totals, entry.message.usage);
    }
  }
  return totals;
}

/** The Pi API methods the footer reads. */
export type StatusApi = Pick<ExtensionAPI, 'getThinkingLevel' | 'getSessionName'>;

/**
 * Builds footer snapshots. Usage totals and context usage scan the session, while the footer renders
 * every frame, so they are cached until the session, leaf, model, or an invalidating event changes.
 */
export class StatusData {
  private version = 0;
  private cache: { key: string; usage: UsageSummary; context: StatusSnapshot['context']; subscription: boolean } | undefined;

  /** Drop cached usage. Call on events that may change usage without moving the leaf. */
  invalidate(): void {
    this.version++;
    this.cache = undefined;
  }

  snapshot(ctx: ExtensionContext, pi: StatusApi, footerData: ReadonlyFooterDataProvider | undefined): StatusSnapshot {
    const sessionManager = ctx.sessionManager;
    const model = ctx.model;
    const key = [this.version, sessionManager.getSessionId(), sessionManager.getLeafId() ?? '',
      model ? `${model.provider}/${model.id}` : ''].join('\0');
    if (this.cache?.key !== key) {
      let subscription = false;
      try { subscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false; } catch { subscription = false; }
      let context: StatusSnapshot['context'];
      try { context = ctx.getContextUsage(); } catch { context = undefined; }
      this.cache = { key, usage: computeUsage(sessionManager.getEntries()), context, subscription };
    }
    let thinkingLevel: string | undefined;
    try { thinkingLevel = pi.getThinkingLevel(); } catch { thinkingLevel = ctx.thinkingLevel; }
    return {
      model: model ? { id: model.id, provider: model.provider, reasoning: Boolean(model.reasoning) } : undefined,
      providerCount: footerData?.getAvailableProviderCount() ?? 1,
      thinkingLevel,
      cwd: sessionManager.getCwd() || ctx.cwd,
      home: process.env.HOME || process.env.USERPROFILE,
      gitBranch: footerData?.getGitBranch() ?? null,
      sessionName: pi.getSessionName() ?? sessionManager.getSessionName(),
      idle: ctx.isIdle(),
      context: this.cache.context,
      usage: this.cache.usage,
      subscription: this.cache.subscription,
      extensionStatuses: footerData?.getExtensionStatuses() ?? new Map(),
    };
  }
}
