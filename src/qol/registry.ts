import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent';
import type { FeatureId } from './features.ts';

export type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** A command a bundled feature registered, without Pi's source metadata. */
export interface CollectedCommand {
  readonly name: string;
  readonly description?: string;
  readonly handler: CommandHandler;
}

/**
 * Commands collected while the bundle registered. Disabled features never
 * register, so their commands are absent here — which is exactly how the /qol
 * editor learns whether a feature's own settings UI can be opened.
 */
export interface CommandRegistry {
  add(feature: FeatureId, name: string, command: CollectedCommand): void;
  /** The command a feature registered under `name`, if the feature is enabled. */
  command(feature: FeatureId, name: string): CollectedCommand | undefined;
  /** Names of every command the feature registered, in registration order. */
  commands(feature: FeatureId): string[];
}

export function createCommandRegistry(): CommandRegistry {
  const collected = new Map<FeatureId, Map<string, CollectedCommand>>();
  return {
    add(feature, name, command) {
      let owned = collected.get(feature);
      if (!owned) collected.set(feature, owned = new Map());
      owned.set(name, command);
    },
    command(feature, name) {
      return collected.get(feature)?.get(name);
    },
    commands(feature) {
      return [...(collected.get(feature)?.keys() ?? [])];
    },
  };
}

/**
 * Wrap the ExtensionAPI given to one feature so its registerCommand calls are
 * recorded before being forwarded. Everything else passes through untouched.
 */
export function wrapCommandRegistration(pi: ExtensionAPI, feature: FeatureId, registry: CommandRegistry): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === 'registerCommand') {
        return (name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
          registry.add(feature, name, { name, description: options.description, handler: options.handler });
          return target.registerCommand(name, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
