import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

type HeaderTheme = Pick<Theme, 'fg'>;

/**
 * Lay out a picker header like Pi's session selector: the title on the left and the
 * current scope, filter, and sort state on the right. When both do not fit on one line,
 * the title keeps its own line and the state moves to a second, right-aligned line.
 * State segments are listed by priority. The second line drops trailing segments that
 * do not fit, and truncates the first only when it alone is too wide.
 */
export function pickerHeader(title: string, state: string[], width: number): string[] {
  if (width < 1) return [];
  const segments = state.filter(Boolean);
  const join = (parts: string[]) => parts.join('  ');
  const right = join(segments);
  if (!right) return [truncateToWidth(title, width, '…')];
  const gap = width - visibleWidth(title) - visibleWidth(right);
  if (gap >= 2) return [title + ' '.repeat(gap) + right];
  let count = segments.length;
  while (count > 1 && visibleWidth(join(segments.slice(0, count))) > width) count--;
  const fitted = truncateToWidth(join(segments.slice(0, count)), width, '…');
  return [truncateToWidth(title, width, '…'), ' '.repeat(Math.max(0, width - visibleWidth(fitted))) + fitted];
}

/** A muted label with an accented value, such as `Sort: Descending`. */
export function stateField(theme: HeaderTheme, label: string, value: string): string {
  return theme.fg('muted', `${label}: `) + theme.fg('accent', value);
}

/** Radio-style scope state, such as `◉ Current project | ○ All`. */
export function scopeState(theme: HeaderTheme, options: string[], active: number): string {
  return options.map((option, index) => index === active ? theme.fg('accent', `◉ ${option}`) : theme.fg('muted', `○ ${option}`))
    .join(theme.fg('muted', ' | '));
}

/** Key hints in Pi's style: dim keys, muted descriptions, separated by ` · `. */
export function keyHints(theme: HeaderTheme, hints: [key: string, description: string][], width: number): string {
  const text = hints.map(([key, description]) => theme.fg('dim', key) + theme.fg('muted', ` ${description}`))
    .join(theme.fg('muted', ' · '));
  return truncateToWidth(text, width, '…');
}
