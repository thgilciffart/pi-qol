export type GoalCommand =
  | { action: 'show' | 'clear' | 'pause' | 'resume' }
  | { action: 'budget'; tokens: number }
  | { action: 'edit'; objective: string }
  | { action: 'start'; objective: string; tokenBudget?: number };

/** Parse syntax here; validate goals and budgets when applying the command. */
export function parseGoalCommand(args: string): GoalCommand {
  const text = args.trim();
  if (!text) return { action: 'show' };
  if (text === 'clear' || text === 'pause' || text === 'resume') return { action: text };
  if (text === 'budget' || text.startsWith('budget ')) return { action: 'budget', tokens: Number(text.slice(6).trim()) };
  if (text === 'edit' || text.startsWith('edit ')) return { action: 'edit', objective: text.slice(4).trim() };
  if (!text.startsWith('--tokens')) return { action: 'start', objective: text };
  const match = /^--tokens\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!match) throw new Error('Usage: /goal --tokens N <objective>');
  return { action: 'start', tokenBudget: Number(match[1]), objective: match[2] };
}
