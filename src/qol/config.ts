import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile as readFileAsync } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorMessage, writeJsonAtomic } from '../shared.ts';
import { DOMAINS, FEATURES, featuresForDomain, isFeatureId, type DomainId, type FeatureId } from './features.ts';

/**
 * Persistent pi-qol settings at `<agent dir>/pi-qol/qol.json`.
 * Only features that are off are listed; everything else defaults to on, so a
 * missing or empty file means the full bundle.
 */
export interface QolConfig {
  version: 1;
  features: Partial<Record<FeatureId, boolean>>;
}

export function defaultQolConfig(): QolConfig {
  return { version: 1, features: {} };
}

export function cloneQolConfig(config: QolConfig): QolConfig {
  return { version: 1, features: { ...config.features } };
}

function fail(message: string): never {
  throw new Error(`pi-qol settings: ${message}`);
}

/** Validate parsed JSON. Throws a descriptive error instead of guessing. */
export function validateQolConfig(value: unknown): QolConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('the file must contain a JSON object.');
  const input = value as Record<string, unknown>;
  if (input.version !== undefined && input.version !== 1) fail(`unsupported version ${JSON.stringify(input.version)}; expected 1.`);
  const raw = input.features === undefined ? {} : input.features;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('"features" must be an object mapping feature names to true or false.');
  const features: Partial<Record<FeatureId, boolean>> = {};
  for (const [key, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFeatureId(key)) {
      fail(`"features.${key}" is not a bundled feature. Choose from ${FEATURES.map(feature => feature.id).join(', ')}.`);
    }
    if (typeof enabled !== 'boolean') fail(`"features.${key}" must be true or false.`);
    features[key] = enabled;
  }
  return { version: 1, features };
}

export type QolLoadResult =
  | { status: 'missing'; config: QolConfig }
  | { status: 'ok'; config: QolConfig }
  | { status: 'invalid'; config: QolConfig; error: string };

function parse(content: string): QolLoadResult {
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch (error) { fail(`invalid JSON (${errorMessage(error)}).`); }
    return { status: 'ok', config: validateQolConfig(parsed) };
  } catch (error) {
    return { status: 'invalid', config: defaultQolConfig(), error: errorMessage(error) };
  }
}

/** Read settings. Malformed files are reported and left untouched; defaults are used in memory. */
export async function loadQolConfig(path: string): Promise<QolLoadResult> {
  let content: string;
  try { content = await readFileAsync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', config: defaultQolConfig() };
    return { status: 'invalid', config: defaultQolConfig(), error: `cannot read ${path}: ${errorMessage(error)}` };
  }
  return parse(content);
}

/**
 * Synchronous read for extension load, where enabled features must be known
 * before registration. Same rules as loadQolConfig.
 */
export function loadQolConfigSync(path: string): QolLoadResult {
  let content: string;
  try { content = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', config: defaultQolConfig() };
    return { status: 'invalid', config: defaultQolConfig(), error: `cannot read ${path}: ${errorMessage(error)}` };
  }
  return parse(content);
}

/** Atomically write settings. Returns the backup path when an existing malformed file was preserved. */
export async function saveQolConfig(path: string, config: QolConfig, options: { backupExisting?: boolean } = {}): Promise<string | undefined> {
  const validated = validateQolConfig(config);
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

/** Enabled state for every feature, expanding the defaults-on sparse storage. */
export function expandFeatures(config: QolConfig): Record<FeatureId, boolean> {
  const expanded = {} as Record<FeatureId, boolean>;
  for (const feature of FEATURES) expanded[feature.id] = config.features[feature.id] ?? true;
  return expanded;
}

/** Sparse storage for an editor draft: only disabled features are written. */
export function storeFeatures(expanded: Record<FeatureId, boolean>): QolConfig {
  const features: Partial<Record<FeatureId, boolean>> = {};
  for (const feature of FEATURES) if (!expanded[feature.id]) features[feature.id] = false;
  return { version: 1, features };
}

export function sameFeatures(a: QolConfig, b: QolConfig): boolean {
  const left = expandFeatures(a);
  const right = expandFeatures(b);
  return FEATURES.every(feature => left[feature.id] === right[feature.id]);
}

export function isFeatureEnabled(config: QolConfig, feature: FeatureId): boolean {
  return config.features[feature] ?? true;
}

/** Toggle one feature in place. Returns whether anything changed. */
export function setFeatureEnabled(config: QolConfig, feature: FeatureId, enabled: boolean): boolean {
  if (isFeatureEnabled(config, feature) === enabled) return false;
  if (enabled) delete config.features[feature];
  else config.features[feature] = false;
  return true;
}

/** Toggle every feature of a domain in place. Returns whether anything changed. */
export function setDomainEnabled(config: QolConfig, domain: DomainId, enabled: boolean): boolean {
  let changed = false;
  for (const feature of featuresForDomain(domain)) changed = setFeatureEnabled(config, feature.id, enabled) || changed;
  return changed;
}

export function countEnabled(config: QolConfig): { enabled: number; total: number } {
  const expanded = expandFeatures(config);
  const enabled = FEATURES.filter(feature => expanded[feature.id]).length;
  return { enabled, total: FEATURES.length };
}

export function countEnabledInDomain(config: QolConfig, domain: DomainId): { enabled: number; total: number } {
  const expanded = expandFeatures(config);
  const features = featuresForDomain(domain);
  return { enabled: features.filter(feature => expanded[feature.id]).length, total: features.length };
}

/** Summary used in /qol status: one line per domain with each feature's state. */
export function describeFeatures(config: QolConfig, path: string, loadError?: string): string {
  const expanded = expandFeatures(config);
  const { enabled, total } = countEnabled(config);
  const lines = [`pi-qol bundled features: ${enabled} of ${total} on`];
  for (const domain of DOMAINS) {
    const states = featuresForDomain(domain.id)
      .map(feature => `${feature.label} ${expanded[feature.id] ? 'on' : 'off'}`);
    lines.push(`${domain.label}: ${states.join(', ')}`);
  }
  if (loadError) lines.push(`Settings file problem: ${loadError} Defaults are shown; the file was not changed.`);
  lines.push(`Settings: ${path}`);
  lines.push('Use /qol for the settings editor, /qol on|off <feature>, /qol on|off domain:<name>, or /qol reset.');
  return lines.join('\n');
}
