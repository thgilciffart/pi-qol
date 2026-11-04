import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { StatusLineConfig } from './config.ts';
import type { StatusApi, StatusData } from './data.ts';
import { renderStatusLine } from './render.ts';

export interface FooterDependencies {
  /** The live session context, or undefined after shutdown. Read on every render. */
  context(): ExtensionContext | undefined;
  /** The current settings. Read on every render so saved changes apply immediately. */
  config(): StatusLineConfig;
  data: StatusData;
  pi: StatusApi;
  /** Called once, when Pi or the extension disposes this footer. */
  onDispose(footer: StatusFooter): void;
}

/** The custom footer Pi mounts through ctx.ui.setFooter. */
export class StatusFooter implements Component {
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly tui: TUI, private readonly theme: Theme,
    readonly footerData: ReadonlyFooterDataProvider, private readonly deps: FooterDependencies) {
    this.unsubscribe = footerData.onBranchChange(() => tui.requestRender());
  }

  requestRender(): void { this.tui.requestRender(); }

  render(width: number): string[] {
    const ctx = this.deps.context();
    if (!ctx || this.disposed) return [];
    try {
      let theme = this.theme;
      try { theme = ctx.ui.theme ?? this.theme; } catch { /* keep the factory theme */ }
      const snapshot = this.deps.data.snapshot(ctx, this.deps.pi, this.footerData);
      return renderStatusLine(snapshot, this.deps.config(), theme, width);
    } catch { return []; }
  }

  invalidate(): void { this.deps.data.invalidate(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.deps.onDispose(this);
  }
}
