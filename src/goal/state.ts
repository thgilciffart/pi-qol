interface Continuation {
  goalId: string;
  sessionId: string;
  content: string;
  budgetSummary: boolean;
}

/** Transient execution state; the Goal itself is persisted separately. */
export interface GoalRunState {
  clock?: number;
  requestGoalId?: string;
  hadTool: boolean;
  noToolTurns: number;
  automatic: boolean;
  budgetReported: boolean;
  pursuing: boolean;
  hasGoalHistory: boolean;
  userResumeAllowed: boolean;
  compacting: boolean;
  continuation?: Continuation;
  scheduled?: ReturnType<typeof setImmediate>;
}

export function initialRunState(): GoalRunState {
  return {
    hadTool: false,
    noToolTurns: 0,
    automatic: false,
    budgetReported: false,
    pursuing: false,
    hasGoalHistory: false,
    userResumeAllowed: false,
    compacting: false,
  };
}
