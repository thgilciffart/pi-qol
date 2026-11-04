import { completions } from '../shared.ts';
import { COLOR_MODES, type ColorMode } from './config.ts';

/** What `/status-line <args>` asks for. */
export type StatusLineAction =
  | { kind: 'editor' }
  | { kind: 'reset' }
  | { kind: 'status' }
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'color'; mode: ColorMode };

const COMMANDS = ['on', 'off', 'reset', 'status', ...COLOR_MODES, 'color', 'colour'];
const COLOR_PREFIXES = new Set(['color', 'colour']);
const COLOR_ALIASES: Record<string, ColorMode> = {
  colorful: 'colorful', colourful: 'colorful', color: 'colorful', colour: 'colorful',
  theme: 'theme', mono: 'mono', monochrome: 'mono', plain: 'mono',
};

function colorAction(word: string): StatusLineAction {
  const mode = COLOR_ALIASES[word];
  if (!mode) throw new Error(`Unknown option "${word}". Use on, off, reset, status, or a colour mode: ${COLOR_MODES.join(', ')}.`);
  return { kind: 'color', mode };
}

/** Parse command arguments. Throws a user-facing message for invalid input. */
export function parseStatusLineArgs(args: string): StatusLineAction {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (first !== undefined && COLOR_PREFIXES.has(first)) {
    if (words.length > 2) throw new Error(`Too many arguments. Use /status-line ${first} <${COLOR_MODES.join('|')}>.`);
    if (second === undefined) throw new Error(`Choose a colour mode. Use /status-line ${first} <${COLOR_MODES.join('|')}>.`);
    return colorAction(second);
  }
  if (words.length > 1) throw new Error('Too many arguments. Use /status-line [on|off|reset|status|colorful|theme|mono].');
  switch (first) {
    case undefined: return { kind: 'editor' };
    case 'reset': return { kind: 'reset' };
    case 'status': return { kind: 'status' };
    case 'on': case 'off': return { kind: 'enabled', enabled: first === 'on' };
    default: return colorAction(first);
  }
}

/** Completions for the whole argument text, including the mode after `color` or `colour`. */
export function statusLineCompletions(prefix: string) {
  const text = prefix.trimStart().toLowerCase();
  const colorMode = /^(colou?r)\s+(\S*)$/.exec(text);
  if (colorMode) return completions(COLOR_MODES.map(mode => `${colorMode[1]} ${mode}`), `${colorMode[1]} ${colorMode[2]}`);
  return completions(COMMANDS, text.trim());
}
