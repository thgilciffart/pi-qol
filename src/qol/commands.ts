import { completions } from '../shared.ts';
import { domainById, featureById, resolveTarget, targetChoices, type QolTarget } from './features.ts';

/** What `/qol <args>` asks for. */
export type QolAction =
  | { kind: 'editor' }
  | { kind: 'status' }
  | { kind: 'reset' }
  | { kind: 'set'; enabled: boolean; target: QolTarget };

const VERBS = ['status', 'on', 'off', 'enable', 'disable', 'reset'] as const;

function usage(): never {
  throw new Error('Usage: /qol [status|on|off <feature|domain:name>|reset]');
}

function describeTarget(target: QolTarget): string {
  return target.kind === 'feature' ? featureById(target.id).label : `${domainById(target.id).label} domain`;
}

export function targetLabel(target: QolTarget): string {
  return describeTarget(target);
}

/** Parse command arguments. Throws a user-facing message for invalid input. */
export function parseQolArgs(args: string): QolAction {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [verb, target, ...rest] = words;
  switch (verb) {
    case undefined: return { kind: 'editor' };
    case 'status':
      if (target) usage();
      return { kind: 'status' };
    case 'reset':
      if (target) usage();
      return { kind: 'reset' };
    case 'on': case 'off': case 'enable': case 'disable': {
      if (!target || rest.length) usage();
      const resolved = resolveTarget(target);
      if (!resolved) {
        throw new Error(`Unknown feature or domain "${target}". Choose one of: ${targetChoices().join(', ')}.`);
      }
      return { kind: 'set', enabled: verb === 'on' || verb === 'enable', target: resolved };
    }
    default: usage();
  }
}

/** Completions for the whole argument text, including targets after on/off/enable/disable. */
export function qolCompletions(prefix: string) {
  const text = prefix.trimStart().toLowerCase();
  const targetMatch = /^(on|off|enable|disable)\s+(\S*)$/.exec(text);
  if (targetMatch) return completions(targetChoices().map(target => `${targetMatch[1]} ${target}`), text);
  return completions([...VERBS], text);
}
