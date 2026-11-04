import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorMessage, writeJsonAtomic } from '../shared.ts';

export const COLOR_MODES = ['colorful', 'theme', 'mono'] as const;
export type ColorMode = typeof COLOR_MODES[number];

export const BUILTIN_MODULES = [
  'state', 'model', 'thinking', 'cwd', 'git', 'session', 'context', 'tokens', 'cache', 'cost',
] as const;
export type BuiltinModuleId = typeof BUILTIN_MODULES[number];

/** Prefix for status keys set by other extensions through ctx.ui.setStatus(key, text). */
export const EXTENSION_PREFIX = 'extension:';
export const MAX_ROWS = 2;
export const MAX_ITEMS = 200;
const MAX_KEY_LENGTH = 200;

export type ModuleId = BuiltinModuleId | `extension:${string}` | `separator:${number}`;
export type Row = 1 | 2;
export type Side = 'left' | 'right';

export interface StatusLineItem {
  id: ModuleId;
  enabled: boolean;
  row: Row;
  /** Omitted in older settings; defaults to the left. */
  side?: Side;
}

export interface StatusLineConfig {
  version: 1;
  /** When false the built-in Pi footer is used. */
  enabled: boolean;
  colorMode: ColorMode;
  /** Whether extension status keys not yet listed in `items` are shown when they appear. */
  showNewExtensionStatuses: boolean;
  /** Ordered modules. Extension keys stay listed while absent so their order and visibility persist. */
  items: StatusLineItem[];
}

export const BUILTIN_LABELS: Record<BuiltinModuleId, string> = {
  state: 'Ready / working',
  model: 'Model',
  thinking: 'Thinking level',
  cwd: 'Working directory',
  git: 'Git branch',
  session: 'Session name',
  context: 'Context remaining',
  tokens: 'Token usage',
  cache: 'Cache reads/writes',
  cost: 'Cost',
};

const DEFAULT_ITEMS: readonly StatusLineItem[] = [
  { id: 'state', enabled: true, row: 1 },
  { id: 'model', enabled: true, row: 1 },
  { id: 'thinking', enabled: true, row: 1 },
  { id: 'cwd', enabled: true, row: 1 },
  { id: 'git', enabled: true, row: 1 },
  { id: 'session', enabled: true, row: 1 },
  { id: 'context', enabled: true, row: 2 },
  { id: 'tokens', enabled: true, row: 2 },
  { id: 'cache', enabled: true, row: 2 },
  { id: 'cost', enabled: true, row: 2 },
];

export function defaultConfig(): StatusLineConfig {
  return {
    version: 1, enabled: true, colorMode: 'colorful', showNewExtensionStatuses: true,
    items: DEFAULT_ITEMS.map(item => ({ ...item })),
  };
}

export function cloneConfig(config: StatusLineConfig): StatusLineConfig {
  return { ...config, items: config.items.map(item => ({ ...item })) };
}

export function isBuiltinModule(id: string): id is BuiltinModuleId {
  return (BUILTIN_MODULES as readonly string[]).includes(id);
}

export function extensionId(key: string): ModuleId {
  return `${EXTENSION_PREFIX}${key}`;
}

export function extensionKey(id: ModuleId): string | undefined {
  return id.startsWith(EXTENSION_PREFIX) ? id.slice(EXTENSION_PREFIX.length) : undefined;
}

export function isSeparator(id: string): id is `separator:${number}` {
  return /^separator:[1-9]\d*$/.test(id);
}

function fail(message: string): never {
  throw new Error(`Status line settings: ${message}`);
}

/** Validate parsed JSON. Throws a descriptive error instead of guessing. */
export function validateConfig(value: unknown): StatusLineConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('the file must contain a JSON object.');
  const input = value as Record<string, unknown>;
  const defaults = defaultConfig();
  if (input.version !== undefined && input.version !== 1) fail(`unsupported version ${JSON.stringify(input.version)}; expected 1.`);
  const enabled = input.enabled === undefined ? defaults.enabled : input.enabled;
  if (typeof enabled !== 'boolean') fail('"enabled" must be true or false.');
  const colorMode = input.colorMode === undefined ? defaults.colorMode : input.colorMode;
  if (typeof colorMode !== 'string' || !(COLOR_MODES as readonly string[]).includes(colorMode)) {
    fail(`"colorMode" must be one of ${COLOR_MODES.join(', ')}.`);
  }
  const showNew = input.showNewExtensionStatuses === undefined ? defaults.showNewExtensionStatuses : input.showNewExtensionStatuses;
  if (typeof showNew !== 'boolean') fail('"showNewExtensionStatuses" must be true or false.');
  const rawItems = input.items === undefined ? defaults.items : input.items;
  if (!Array.isArray(rawItems)) fail('"items" must be an array.');
  if (rawItems.length > MAX_ITEMS) fail(`"items" may contain at most ${MAX_ITEMS} entries.`);
  const seen = new Set<string>();
  const items: StatusLineItem[] = rawItems.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`items[${index}] must be an object.`);
    const { id, enabled: itemEnabled = true, row = 1, side } = raw as Record<string, unknown>;
    if (typeof id !== 'string') fail(`items[${index}].id must be a string.`);
    if (!isBuiltinModule(id) && !isSeparator(id)) {
      const key = id.startsWith(EXTENSION_PREFIX) ? id.slice(EXTENSION_PREFIX.length) : '';
      if (!key) fail(`items[${index}].id "${id}" is not a built-in module (${BUILTIN_MODULES.join(', ')}), "separator:<positive integer>", or "${EXTENSION_PREFIX}<key>".`);
      if (key.length > MAX_KEY_LENGTH) fail(`items[${index}].id is longer than ${MAX_KEY_LENGTH} characters.`);
    }
    if (seen.has(id)) fail(`items contains "${id}" more than once.`);
    seen.add(id);
    if (typeof itemEnabled !== 'boolean') fail(`items[${index}].enabled must be true or false.`);
    if (row !== 1 && row !== 2) fail(`items[${index}].row must be 1 or 2.`);
    if (side !== undefined && side !== 'left' && side !== 'right') fail(`items[${index}].side must be "left" or "right".`);
    return { id: id as ModuleId, enabled: itemEnabled, row, ...(side === undefined ? {} : { side }) };
  });
  // Built-in modules added in later versions appear with their defaults.
  for (const item of DEFAULT_ITEMS) if (!seen.has(item.id)) items.push({ ...item });
  if (items.length > MAX_ITEMS) fail(`"items" may contain at most ${MAX_ITEMS} entries including built-in modules.`);
  return { version: 1, enabled, colorMode: colorMode as ColorMode, showNewExtensionStatuses: showNew, items };
}

export type LoadResult =
  | { status: 'missing'; config: StatusLineConfig }
  | { status: 'ok'; config: StatusLineConfig }
  | { status: 'invalid'; config: StatusLineConfig; error: string };

/** Read settings. Malformed files are reported and left untouched; defaults are used in memory. */
export async function loadConfig(path: string): Promise<LoadResult> {
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', config: defaultConfig() };
    return { status: 'invalid', config: defaultConfig(), error: `cannot read ${path}: ${errorMessage(error)}` };
  }
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch (error) { fail(`invalid JSON (${errorMessage(error)}).`); }
    return { status: 'ok', config: validateConfig(parsed) };
  } catch (error) {
    return { status: 'invalid', config: defaultConfig(), error: errorMessage(error) };
  }
}

/** Atomically write settings. Returns the backup path when an existing malformed file was preserved. */
export async function saveConfig(path: string, config: StatusLineConfig, options: { backupExisting?: boolean } = {}): Promise<string | undefined> {
  const validated = validateConfig(config);
  await mkdir(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (options.backupExisting) {
    const target = `${path}.invalid-${Date.now()}`;
    try { await copyFile(path, target); backup = target; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await writeJsonAtomic(path, validated);
  return backup;
}

/**
 * Items in display order, including extension keys that are currently set but not yet listed.
 * New keys are appended to row 2 and enabled according to `showNewExtensionStatuses`.
 */
export function resolveItems(config: StatusLineConfig, extensionKeys: Iterable<string>): StatusLineItem[] {
  const items = config.items.map(item => ({ ...item }));
  const known = new Set(items.map(item => item.id));
  const fresh = [...new Set(extensionKeys)]
    .filter(key => key && key.length <= MAX_KEY_LENGTH && !known.has(extensionId(key)))
    .sort((a, b) => a.localeCompare(b));
  for (const key of fresh) {
    if (items.length >= MAX_ITEMS) break;
    items.push({ id: extensionId(key), enabled: config.showNewExtensionStatuses, row: 2 });
  }
  return items;
}
