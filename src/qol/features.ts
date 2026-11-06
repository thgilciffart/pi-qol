/**
 * Static catalogue of the bundled pi-qol features, grouped into the domains
 * shown as tabs in the /qol settings editor. index.ts uses this list to
 * register only the enabled features, so disabled ones lose their commands,
 * tools, events, and shortcuts entirely.
 *
 * This module is deliberately free of imports from the feature modules so
 * tests and configuration code stay lightweight.
 */

export const DOMAINS = [
  { id: 'threads', label: 'Threads', description: 'Managing, naming, and privately chatting in threads' },
  { id: 'agent', label: 'Agent', description: 'Agent workflow, tools, and shortcuts' },
  { id: 'display', label: 'Display', description: 'What Pi shows in the terminal' },
  { id: 'tools', label: 'Tools', description: 'Files and installed extensions' },
] as const;

export type DomainId = typeof DOMAINS[number]['id'];

export interface QolFeature {
  /** Stable identifier used in the settings file and /qol on|off. */
  readonly id: string;
  readonly domain: DomainId;
  /** Display name in the editor and status output. */
  readonly label: string;
  /** What the feature provides; helps users decide before disabling it. */
  readonly provides: string;
  /**
   * Name of the command the feature registers that opens its own settings UI
   * with no arguments. /qol reuses that registered handler instead of
   * duplicating the feature's configuration.
   */
  readonly settingsCommand?: string;
}

export const FEATURES = [
  { id: 'threads', domain: 'threads', label: 'Thread management', provides: '/open, /delete, /delete-threads pickers' },
  { id: 'auto-name', domain: 'threads', label: 'Automatic naming', provides: '/auto-name, names new threads', settingsCommand: 'auto-name' },
  { id: 'ephemeral', domain: 'threads', label: 'Ephemeral chats', provides: '/ephemeral, Alt+P private chats' },
  { id: 'goal', domain: 'agent', label: 'Goals', provides: '/goal, get_goal/create_goal/update_goal tools' },
  { id: 'continue', domain: 'agent', label: 'Continue turn', provides: '/continue, Ctrl+Alt+C' },
  { id: 'thinking', domain: 'agent', label: 'Thinking shortcuts', provides: 'Alt+, and Alt+. thinking levels' },
  { id: 'ask-questions', domain: 'agent', label: 'Ask questions', provides: 'ask_user tool questionnaires' },
  { id: 'status-line', domain: 'display', label: 'Status line', provides: '/statusline custom footer', settingsCommand: 'statusline' },
  { id: 'metrics', domain: 'display', label: 'Response metrics', provides: 'timing and token stats on replies' },
  { id: 'export', domain: 'tools', label: 'HTML export', provides: '/better-export session exports' },
  { id: 'plugins', domain: 'tools', label: 'Plugin manager', provides: '/plugins extension toggles', settingsCommand: 'plugins' },
] as const satisfies readonly QolFeature[];

export type FeatureId = typeof FEATURES[number]['id'];

/** A catalogue entry: the full feature shape with a literal id type. */
export type QolFeatureEntry = QolFeature & { readonly id: FeatureId };

export function isFeatureId(value: string): value is FeatureId {
  return (FEATURES as readonly QolFeature[]).some(feature => feature.id === value);
}

export function isDomainId(value: string): value is DomainId {
  return (DOMAINS as readonly { id: string }[]).some(domain => domain.id === value);
}

export function featureById(id: FeatureId): QolFeature {
  const feature = (FEATURES as readonly QolFeature[]).find(candidate => candidate.id === id);
  if (!feature) throw new Error(`Unknown pi-qol feature "${id}".`);
  return feature;
}

export function domainById(id: DomainId): typeof DOMAINS[number] {
  const domain = DOMAINS.find(candidate => candidate.id === id);
  if (!domain) throw new Error(`Unknown pi-qol domain "${id}".`);
  return domain;
}

export function featuresForDomain(id: DomainId): QolFeatureEntry[] {
  return FEATURES.filter(feature => feature.domain === id);
}

/** A /qol on|off target: one feature, or a whole domain via `domain:<id>`. */
export type QolTarget =
  | { kind: 'feature'; id: FeatureId }
  | { kind: 'domain'; id: DomainId };

/**
 * Resolve a command-line target. Exact feature ids win over domain ids, so
 * `threads` means the thread management feature; `domain:threads` means the
 * whole Threads tab.
 */
export function resolveTarget(word: string): QolTarget | undefined {
  const text = word.trim().toLowerCase();
  const prefixed = /^domain:(\S+)$/.exec(text);
  if (prefixed) {
    const id = prefixed[1]!;
    return isDomainId(id) ? { kind: 'domain', id } : undefined;
  }
  if (isFeatureId(text)) return { kind: 'feature', id: text };
  if (isDomainId(text)) return { kind: 'domain', id: text };
  return undefined;
}

/** Every target accepted by /qol on|off, for completions and error messages. */
export function targetChoices(): string[] {
  return [
    ...FEATURES.map(feature => feature.id),
    ...DOMAINS.map(domain => `domain:${domain.id}`),
  ];
}
