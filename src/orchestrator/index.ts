// Orchestrator: drives a single Issue through the phase state machine
// by dispatching the right agent for the current label and applying
// the agent's AgentResult back onto the Issue. See
// docs/01-architecture.md §1, §2, §9.

import type { KanbeiConfig } from '../config/index.js';
import { filterKanbeiComments } from '../github/comments.js';
import { labelForPhase, phaseFromLabels } from '../github/labels.js';
import type { CommentData, IssueData, RepoState } from '../github/repoState.js';
import type { SafetyDenyReason, SafetyTracker } from '../safety/index.js';
import type {
  AgentName,
  AgentResult,
  KanbeiPhase,
  SafetyBudget,
} from '../types.js';

export interface AgentContext {
  issue: IssueData;
  /** Comments with Kanbei-authored ones filtered out. */
  comments: CommentData[];
  config: KanbeiConfig;
  /** Snapshot of remaining safety budget at dispatch time. */
  safety: SafetyBudget;
}

export type AgentRunner = (ctx: AgentContext) => Promise<AgentResult>;

export interface OrchestratorDeps {
  repo: RepoState;
  config: KanbeiConfig;
  safety: SafetyTracker;
  agents: Partial<Record<AgentName, AgentRunner>>;
  logger?: Logger;
}

export type Logger = (event: OrchestratorEvent) => void;

export type OrchestratorEvent =
  | { type: 'no-phase-label' }
  | { type: 'terminal'; phase: KanbeiPhase }
  | { type: 'no-runner'; agent: AgentName; phase: KanbeiPhase }
  | { type: 'safety-deny'; reason: SafetyDenyReason; phase: KanbeiPhase }
  | { type: 'agent-result'; agent: AgentName; phase: KanbeiPhase; result: AgentResult };

export interface RunSummary {
  iterations: number;
  events: OrchestratorEvent[];
  finalPhase: KanbeiPhase | null;
}

const TERMINAL_PHASES = new Set<KanbeiPhase>(['review', 'done', 'awaiting-human', 'error']);

const PHASE_TO_AGENT: Record<KanbeiPhase, AgentName | null> = {
  gathering: 'listener',
  spec: 'spec',
  arch: 'architect',
  building: 'builder',
  testing: 'tester',
  review: null,
  'awaiting-human': null,
  done: null,
  error: null,
};

const LABEL_OPTS = (config: KanbeiConfig) => ({
  prefix: config.labels.prefix,
  map: config.labels.phases,
});

async function setPhaseLabel(
  repo: RepoState,
  config: KanbeiConfig,
  issue: IssueData,
  newPhase: KanbeiPhase,
): Promise<void> {
  const opts = LABEL_OPTS(config);
  const allPhaseLabels = new Set(
    Object.keys(PHASE_TO_AGENT).map((p) => labelForPhase(p as KanbeiPhase, opts)),
  );
  const kept = issue.labels.filter((l) => !allPhaseLabels.has(l));
  const next = [...kept, labelForPhase(newPhase, opts)];
  await repo.updateIssue(issue.number, { labels: next });
}

export async function runIssue(
  deps: OrchestratorDeps,
  issueNumber: number,
): Promise<RunSummary> {
  const { repo, config, safety, agents, logger } = deps;
  const events: OrchestratorEvent[] = [];
  const emit = (e: OrchestratorEvent): void => {
    events.push(e);
    logger?.(e);
  };
  let iterations = 0;
  let finalPhase: KanbeiPhase | null = null;

  while (true) {
    const issue = await repo.getIssue(issueNumber);
    const phase = phaseFromLabels(issue.labels, LABEL_OPTS(config));
    finalPhase = phase;

    if (phase === null) {
      emit({ type: 'no-phase-label' });
      break;
    }
    if (TERMINAL_PHASES.has(phase)) {
      emit({ type: 'terminal', phase });
      break;
    }

    const agentName = PHASE_TO_AGENT[phase];
    if (!agentName) {
      // Defensive: PHASE_TO_AGENT covers terminal phases as null, which we've
      // already handled above. Reaching here means a non-terminal phase is
      // missing a mapping — treat as no-runner.
      emit({ type: 'no-runner', agent: 'listener', phase });
      break;
    }

    const runner = agents[agentName];
    if (!runner) {
      emit({ type: 'no-runner', agent: agentName, phase });
      break;
    }

    const decision = safety.canStartIteration(phase);
    if (!decision.ok) {
      emit({ type: 'safety-deny', reason: decision.reason, phase });
      await setPhaseLabel(repo, config, issue, 'error');
      finalPhase = 'error';
      break;
    }

    const comments = filterKanbeiComments(await repo.getComments(issueNumber));
    safety.recordIteration(phase);
    iterations += 1;

    const result = await runner({
      issue,
      comments,
      config,
      safety: safety.remaining(),
    });
    emit({ type: 'agent-result', agent: agentName, phase, result });
    if (typeof result.tokensUsed === 'number') safety.recordTokens(result.tokensUsed);

    switch (result.status) {
      case 'ready_for_next_phase':
        if (!result.nextPhase) {
          throw new Error(
            `Agent ${agentName} returned ready_for_next_phase without nextPhase`,
          );
        }
        await setPhaseLabel(repo, config, issue, result.nextPhase);
        continue;
      case 'needs_human':
        await setPhaseLabel(repo, config, issue, 'awaiting-human');
        finalPhase = 'awaiting-human';
        return { iterations, events, finalPhase };
      case 'needs_retry':
        // Stay on the same phase; L3 will trip after maxIterationsPerPhase.
        continue;
      case 'error':
        await setPhaseLabel(repo, config, issue, 'error');
        finalPhase = 'error';
        return { iterations, events, finalPhase };
    }
  }

  return { iterations, events, finalPhase };
}
