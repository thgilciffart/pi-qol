import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import ephemeral from './src/ephemeral.ts';
import betterExport from './src/export/index.ts';
import metrics from './src/metrics.ts';
import goal from './src/goal.ts';
import threads from './src/threads.ts';
import autoName from './src/auto-name.ts';
import continueTurn from './src/continue.ts';
import thinking from './src/thinking.ts';
import askQuestions from './src/ask-questions/index.ts';
import statusLine from './src/status-line/index.ts';
import plugins from './src/plugins/index.ts';
import qolCommand from './src/qol/index.ts';
import { isFeatureEnabled, loadQolConfigSync } from './src/qol/config.ts';
import { FEATURES, type FeatureId } from './src/qol/features.ts';
import { createCommandRegistry, wrapCommandRegistration } from './src/qol/registry.ts';

const MODULES: Record<FeatureId, (pi: ExtensionAPI) => void> = {
  ephemeral,
  export: betterExport,
  metrics,
  goal,
  threads,
  'auto-name': autoName,
  continue: continueTurn,
  thinking,
  'ask-questions': askQuestions,
  'status-line': statusLine,
  plugins,
};

export interface QolExtensionOptions {
  /** Settings file choosing the enabled features. Defaults to `<agent dir>/pi-qol/qol.json`. */
  configPath?: string;
}

/**
 * Register the enabled bundled features. Features disabled in the settings
 * file are never registered, so their commands, tools, events, and shortcuts
 * genuinely disappear. The /qol command itself is always registered and
 * reports a malformed settings file once per session.
 */
export default function qol(pi: ExtensionAPI, options: QolExtensionOptions = {}): void {
  const configPath = options.configPath ?? join(getAgentDir(), 'pi-qol', 'qol.json');
  const loaded = loadQolConfigSync(configPath);
  const registry = createCommandRegistry();
  for (const feature of FEATURES) {
    if (!isFeatureEnabled(loaded.config, feature.id)) continue;
    MODULES[feature.id](wrapCommandRegistration(pi, feature.id, registry));
  }
  qolCommand(pi, {
    configPath,
    registry,
    loadError: loaded.status === 'invalid' ? loaded.error : undefined,
  });
}
