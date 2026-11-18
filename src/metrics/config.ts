import { readFileSync } from 'node:fs';
import { sanitizeInline } from '../status-line/sanitize.ts';

export const STAT_LABELS = {
  input: 'Request input tokens',
  output: 'Output tokens',
  tps: 'Tokens per second',
  ttft: 'Time to first token',
  cost: 'Cost',
  model: 'Model',
} as const;

type StatId = keyof typeof STAT_LABELS;
type MetricItem = { id: StatId; enabled: boolean };
const STAT_IDS = Object.keys(STAT_LABELS) as StatId[];

export interface MetricsConfig {
  items: MetricItem[];
  separator: { enabled: boolean; text: string };
}

export function defaultMetricsConfig(): MetricsConfig {
  return {
    items: STAT_IDS.map(id => ({ id, enabled: id !== 'model' })),
    separator: { enabled: false, text: '|' },
  };
}

export function loadMetricsConfig(path: string): MetricsConfig {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultMetricsConfig();
    throw error;
  }
  const saved = JSON.parse(text) as Partial<MetricsConfig> | null;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Expected a JSON object.');
  const defaults = defaultMetricsConfig();
  const items: MetricItem[] = [];
  if (saved.items !== undefined) {
    if (!Array.isArray(saved.items)) throw new Error('Expected "items" to be an array.');
    for (const item of saved.items) {
      if (!item || !STAT_IDS.includes(item.id) || typeof item.enabled !== 'boolean' || items.some(previous => previous.id === item.id)) {
        throw new Error('Each item must have a unique stat ID and an enabled switch.');
      }
      items.push({ id: item.id, enabled: item.enabled });
    }
  }
  const separator = saved.separator === undefined ? defaults.separator : saved.separator;
  const separatorText = typeof separator?.text === 'string' ? sanitizeInline(separator.text, false) : '';
  if (typeof separator?.enabled !== 'boolean' || !separatorText) {
    throw new Error('The separator needs an enabled switch and nonempty text.');
  }
  return {
    items: [...items, ...defaults.items.filter(item => !items.some(savedItem => savedItem.id === item.id))],
    separator: { enabled: separator.enabled, text: separatorText },
  };
}
