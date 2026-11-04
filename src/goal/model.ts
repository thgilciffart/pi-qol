export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete';

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedMs: number;
  turns: number;
}

export function validateObjective(objective: string): string {
  const value = objective.trim();
  if (!value || [...value].length > 4000) throw new Error('Goal objective must contain 1 to 4000 characters.');
  return value;
}

export function validateBudget(budget: number): number {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Token budget must be a positive safe integer.');
  return budget;
}
