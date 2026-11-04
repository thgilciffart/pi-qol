import type { Goal } from './model.ts';

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  const [scale, suffix] = value >= 999_500_000_000 ? [1e12, 'T'] : value >= 999_500_000 ? [1e9, 'B'] :
    value >= 999_500 ? [1e6, 'M'] : [1000, 'K'];
  const scaled = value / scale;
  return `${Number(scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0))}${suffix}`;
}

export function formatGoal(goal: Goal): string {
  const seconds = Math.max(0, Math.round(goal.timeUsedMs / 1000));
  const duration = [
    [Math.floor(seconds / 86400), 'd'],
    [Math.floor(seconds / 3600) % 24, 'h'],
    [Math.floor(seconds / 60) % 60, 'm'],
    [seconds % 60, 's'],
  ].filter(([value]) => value !== 0).map(([value, unit]) => `${value}${unit}`).join(' ') || '0s';
  return `Goal: ${goal.status}\n${goal.objective}\nTokens used: ${compactTokens(goal.tokensUsed)}` +
    (goal.tokenBudget === undefined ? '' : ` / ${compactTokens(goal.tokenBudget)}`) +
    `\nTime used: ${duration}`;
}
