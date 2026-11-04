import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createGoalUI } from './ui.ts';
import { validateBudget, validateObjective, type Goal, type GoalStatus } from './model.ts';
import { formatGoal } from './format.ts';
import { CONTINUE_REQUEST, RECOVERY_REQUEST, goalInstructions, CREATE_GOAL_DESCRIPTION, UPDATE_GOAL_DESCRIPTION } from './prompts.ts';
import { parseGoalCommand } from './commands.ts';
import { initialRunState } from './state.ts';
import { completions, errorMessage } from '../shared.ts';

export const GOAL_ENTRY = 'pi-qol-goal';
const CONTINUATION = 'pi-qol-goal-continuation';
const MAX_NO_TOOL_TURNS = 3;
/** Behavioral port of Codex goals. See docs/goals.md for the pinned upstream sources. */
export default function goals(pi: ExtensionAPI): void {
  let goal: Goal | undefined;
  let run = initialRunState();
  const presentation = createGoalUI(() => ({
    goal: goal ? { ...goal, timeUsedMs: goal.timeUsedMs +
      (goal.status === 'active' && run.clock !== undefined ? performance.now() - run.clock : 0) } : undefined,
    running: goal?.status === 'active' && run.clock !== undefined,
  }));

  function refresh(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(GOAL_ENTRY, undefined);
    presentation.update(ctx);
  }

  function cancelContinuation(): void {
    if (run.scheduled) clearImmediate(run.scheduled);
    run.scheduled = undefined;
    run.continuation = undefined;
  }

  function scheduleContinuation(ctx: ExtensionContext): void {
    if (!run.continuation || run.scheduled) return;
    // Yield once so every agent_settled listener can start maintenance, including
    // compaction. This is an event handoff, not an idle polling loop.
    run.scheduled = setImmediate(() => {
      run.scheduled = undefined;
      const next = run.continuation;
      if (!next) return;
      try {
        if (!goal || goal.id !== next.goalId || ctx.sessionManager.getSessionId() !== next.sessionId ||
          goal.status !== (next.budgetSummary ? 'budget_limited' : 'active') || ctx.hasPendingMessages()) {
          run.continuation = undefined;
          return;
        }
        // session_compact schedules another attempt once compaction succeeds.
        if (run.compacting || !ctx.isIdle()) return;
        run.continuation = undefined;
        pi.sendMessage({ customType: CONTINUATION, content: next.content, display: false }, { triggerTurn: true });
      } catch {
        // Direct SDK disposal can invalidate contexts without session_shutdown.
        run.continuation = undefined;
      }
    });
  }

  function queueContinuation(ctx: ExtensionContext, content = CONTINUE_REQUEST, budgetSummary = false): void {
    if (!goal) return;
    run.continuation = { goalId: goal.id, sessionId: ctx.sessionManager.getSessionId(), content, budgetSummary };
  }

  function accountTime(): void {
    if (run.clock === undefined) return;
    const now = performance.now();
    if (goal?.status === 'active') goal.timeUsedMs += now - run.clock;
    run.clock = now;
  }

  function persist(ctx: ExtensionContext): void {
    accountTime();
    pi.appendEntry(GOAL_ENTRY, goal ? { ...goal } : null);
    refresh(ctx);
  }

  function setStatus(status: GoalStatus, ctx: ExtensionContext): void {
    if (!goal) throw new Error('This session has no goal.');
    accountTime();
    goal.status = status;
    if (status !== 'active') {
      cancelContinuation();
      run.userResumeAllowed = false;
      run.clock = undefined;
    }
    persist(ctx);
  }

  function start(objective: string, tokenBudget: number | undefined, ctx: ExtensionContext, turns = 0): void {
    const value = validateObjective(objective);
    if (tokenBudget !== undefined) validateBudget(tokenBudget);
    cancelContinuation();
    goal = { id: randomUUID(), objective: value, status: 'active', tokenBudget, tokensUsed: 0, timeUsedMs: 0, turns };
    run.hasGoalHistory = true;
    run.pursuing = true;
    run.noToolTurns = 0;
    run.userResumeAllowed = false;
    run.budgetReported = false;
    run.clock = ctx.isIdle() ? undefined : performance.now();
    persist(ctx);
  }

  function response() {
    accountTime();
    const details = {
      goal: goal ? { ...goal } : null,
      remainingTokens: goal?.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
  }

  function kick(ctx: ExtensionContext): void {
    if (goal?.status !== 'active' || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    pi.sendMessage({ customType: CONTINUATION, content: CONTINUE_REQUEST, display: false }, { triggerTurn: true });
  }

  function resume(ctx: ExtensionContext, currentTurn = false): void {
    if (!goal) throw new Error('This session has no goal.');
    if (goal.status === 'complete') throw new Error('Goal is complete. Set or edit a goal to start again.');
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      throw new Error('Goal token budget is exhausted. Use /goal budget N to raise it before resuming.');
    }
    cancelContinuation();
    goal.turns = currentTurn ? 1 : 0;
    run.noToolTurns = 0;
    run.budgetReported = run.userResumeAllowed = false;
    run.pursuing = true;
    accountTime();
    run.clock = ctx.isIdle() ? undefined : performance.now();
    setStatus('active', ctx);
  }

  pi.registerCommand('goal', {
    description: 'Set or view the goal for a long-running task',
    getArgumentCompletions: prefix => completions(['pause', 'resume', 'clear', 'edit', 'budget'], prefix),
    handler: async (args, ctx) => {
      try {
        const command = parseGoalCommand(args);
        if (command.action === 'show') {
          ctx.ui.notify(goal ? formatGoal(goal) : 'No goal. Use /goal <objective> or /goal --tokens N <objective>.', 'info');
          return;
        }
        if (command.action === 'clear') {
          cancelContinuation();
          goal = undefined;
          run.userResumeAllowed = false;
          run.clock = run.requestGoalId = undefined;
          persist(ctx);
          ctx.ui.notify('Goal cleared.', 'info');
          return;
        }
        if (command.action === 'pause') {
          if (goal?.status === 'budget_limited' || goal?.status === 'complete') throw new Error(`Goal is ${goal.status}.`);
          setStatus('paused', ctx);
          if (!ctx.isIdle()) ctx.abort();
          ctx.ui.notify('Goal paused.', 'info');
          return;
        }
        if (command.action === 'resume') {
          resume(ctx);
          kick(ctx);
          return;
        }
        if (command.action === 'budget') {
          if (!goal) throw new Error('This session has no goal.');
          const value = validateBudget(command.tokens);
          goal.tokenBudget = value;
          if (goal.status === 'active' && goal.tokensUsed >= value) setStatus('budget_limited', ctx);
          else persist(ctx);
          ctx.ui.notify(formatGoal(goal), 'info');
          return;
        }
        if (command.action === 'edit') {
          if (!goal) throw new Error('This session has no goal.');
          let objective = command.objective;
          if (!objective) {
            if (!ctx.hasUI) throw new Error('Use /goal edit <objective> without an interactive UI.');
            const edited = await ctx.ui.editor('Edit goal', goal.objective);
            if (edited === undefined) return;
            objective = edited;
          }
          goal.objective = validateObjective(objective);
          goal.turns = 0;
          if (goal.status === 'complete') setStatus(goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget ? 'budget_limited' : 'active', ctx);
          else persist(ctx);
          kick(ctx);
          return;
        }
        if (command.action === 'start') {
          if (command.tokenBudget !== undefined) validateBudget(command.tokenBudget);
          start(command.objective, command.tokenBudget, ctx);
          kick(ctx);
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
      }
    },
  });

  pi.registerTool({
    name: 'get_goal', label: 'Get goal',
    description: 'Get this session goal, status, token budget, usage, and remaining tokens.',
    parameters: Type.Object({}),
    execute: async () => response(),
  });
  pi.registerTool({
    name: 'create_goal', label: 'Create goal',
    description: CREATE_GOAL_DESCRIPTION,
    parameters: Type.Object({ objective: Type.String(), token_budget: Type.Optional(Type.Integer({ minimum: 1 })) }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      if (goal && goal.status !== 'complete') throw new Error('An unfinished goal exists. Use update_goal for status; the user can replace it with /goal.');
      start(args.objective, args.token_budget, ctx, 1);
      return response();
    },
  });
  pi.registerTool({
    name: 'update_goal', label: 'Update goal',
    description: UPDATE_GOAL_DESCRIPTION,
    parameters: Type.Object({ status: Type.Union([Type.Literal('active'), Type.Literal('complete'), Type.Literal('blocked'), Type.Literal('paused')]) }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      if (!goal) throw new Error('This session has no goal.');
      if (args.status === 'active') {
        if (goal.status !== 'paused' && goal.status !== 'blocked') throw new Error(`Cannot resume a ${goal.status} goal with this tool.`);
        if (!run.userResumeAllowed) throw new Error('Resuming needs a new user message directing further work or providing guidance for continuing.');
        resume(ctx, true);
        return response();
      }
      if (goal.status !== 'active' && !(goal.status === 'budget_limited' && args.status === 'complete')) {
        throw new Error(`Goal is ${goal.status}. ` + (goal.status === 'paused' || goal.status === 'blocked'
          ? 'Use status active first when new user guidance authorizes continuing.'
          : 'This status does not accept that update.'));
      }
      if (args.status === 'blocked' && goal.turns < 3) throw new Error('Audit the same blocker over at least three goal turns before marking blocked.');
      setStatus(args.status, ctx);
      return response();
    },
  });

  function restore(ctx: ExtensionContext): void {
    cancelContinuation();
    goal = undefined;
    run = initialRunState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === GOAL_ENTRY) {
        run.hasGoalHistory = true;
        goal = entry.data ? { ...entry.data as Goal } : undefined;
      }
    }
    // Restoring history waits for fresh user direction before starting work.
    if (goal?.status === 'active') setStatus('paused', ctx);
    else refresh(ctx);
  }

  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    cancelContinuation();
    run.compacting = false;
    if (goal?.status === 'active') setStatus('paused', ctx);
    presentation.dispose(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(GOAL_ENTRY, undefined);
  });
  pi.on('before_agent_start', (event) => {
    cancelContinuation();
    run.automatic = event.messageType === 'custom' && event.message.customType === CONTINUATION;
    if (!run.automatic) run.noToolTurns = 0;
    run.userResumeAllowed = event.messageType === 'user';
    run.pursuing = goal?.status === 'active';
  });
  pi.on('input', (event) => {
    if (event.source !== 'extension') {
      run.userResumeAllowed = true;
      run.noToolTurns = 0;
    }
  });
  // Context transforms are transient. Supply one stable header on every request
  // so compaction/edits cannot lose the goal, without appending a fresh reminder
  // after each tool result. Normalize legacy full reminders without rewriting history.
  pi.on('context', (event) => {
    if (!run.hasGoalHistory) return;
    const messages = event.messages
      .filter(message => message.role !== 'custom' || message.customType !== GOAL_ENTRY)
      .map(message => message.role === 'custom' && message.customType === CONTINUATION
        ? { ...message, content: message.content === RECOVERY_REQUEST ? RECOVERY_REQUEST : CONTINUE_REQUEST } : message);
    return { messages: [{
      role: 'custom' as const, customType: GOAL_ENTRY, display: false, timestamp: 0,
      content: goal ? goalInstructions(goal) : 'This session has no active goal. Do not infer a goal from ordinary tasks.',
    }, ...messages] };
  });
  pi.on('agent_start', (_event, ctx) => {
    run.hadTool = false;
    if (goal?.status !== 'active') return;
    goal.turns += 1;
    run.clock = performance.now();
    persist(ctx);
  });
  pi.on('before_provider_request', () => {
    run.requestGoalId = goal?.status === 'active' ? goal.id : undefined;
  });
  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant' || !goal || goal.id !== run.requestGoalId) return;
    const usage = event.message.usage;
    // Pi reports uncached input separately from cache reads and cache writes.
    goal.tokensUsed += Math.max(0, usage.input) + Math.max(0, usage.cacheWrite) + Math.max(0, usage.output);
    run.requestGoalId = undefined;
    if ((goal.status === 'active' || goal.status === 'paused') && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      setStatus('budget_limited', ctx);
    } else persist(ctx);
  });
  pi.on('tool_execution_end', () => { run.hadTool = true; run.noToolTurns = 0; });
  pi.on('session_before_compact', () => {
    run.compacting = true;
    accountTime();
    run.clock = run.requestGoalId = undefined;
  });
  pi.on('session_compact', (_event, ctx) => {
    run.compacting = false;
    // This event runs before Pi clears its compaction flag. The one-shot handoff
    // below starts work only after completion and all other listeners return.
    scheduleContinuation(ctx);
    refresh(ctx);
  });
  pi.on('session_compact_failed', (event, ctx) => {
    run.compacting = false;
    cancelContinuation();
    if (goal?.status === 'active') setStatus(event.aborted ? 'paused' : 'blocked', ctx);
  });
  pi.on('tool_call', (event) => {
    if (run.pursuing && goal?.status === 'budget_limited' && event.toolName !== 'get_goal' && event.toolName !== 'update_goal') {
      return { block: true, reason: 'Goal token budget exhausted. Summarize progress and remaining work without starting new substantive work.' };
    }
  });
  pi.on('agent_before_settle', (event, ctx) => {
    cancelContinuation();
    accountTime();
    run.clock = undefined;
    if (!goal) return;
    persist(ctx);
    if (event.outcome === 'aborted') {
      if (goal.status === 'active') setStatus('paused', ctx);
      return;
    }
    if (event.outcome === 'error') {
      if (goal.status === 'active') setStatus('blocked', ctx);
      return;
    }
    if (ctx.hasPendingMessages() || event.context.pendingMessages.length || event.continue) return;
    if (goal.status === 'budget_limited') {
      if (!run.pursuing || run.budgetReported) return;
      run.budgetReported = true;
      ctx.ui.notify(`Goal reached its token budget (${goal.tokensUsed}/${goal.tokenBudget}).`, 'warning');
      queueContinuation(ctx, `The goal reached its token budget (${goal.tokensUsed}/${goal.tokenBudget}). Stop substantive work. Summarize progress, remaining work, blockers, and the next useful step. Do not claim completion without evidence.`, true);
      return;
    }
    if (goal.status !== 'active') return;
    if (run.automatic && !run.hadTool) {
      run.noToolTurns += 1;
      if (run.noToolTurns >= MAX_NO_TOOL_TURNS) {
        setStatus('blocked', ctx);
        ctx.ui.notify(`Goal stalled after ${MAX_NO_TOOL_TURNS} consecutive turns without tool calls. Use /goal resume to retry.`, 'warning');
      } else {
        queueContinuation(ctx, RECOVERY_REQUEST);
      }
      return;
    }
    queueContinuation(ctx);
  });
  pi.on('agent_settled', (event, ctx) => {
    if (event.aborted && goal?.status === 'active') setStatus('paused', ctx);
    accountTime();
    run.clock = run.requestGoalId = undefined;
    refresh(ctx);
    if (event.aborted) cancelContinuation();
    else scheduleContinuation(ctx);
  });
}
