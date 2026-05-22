// Shared type definitions for Kanbei.
// See docs/01-architecture.md and docs/02-agents.md for the conceptual model.

export const KANBEI_PHASES = [
  'gathering',
  'spec',
  'arch',
  'building',
  'testing',
  'review',
  'awaiting-human',
  'done',
  'error',
] as const;

export type KanbeiPhase = (typeof KANBEI_PHASES)[number];

export const KANBEI_LABEL_PREFIX = 'kanbei:';

export type AgentName = 'listener' | 'spec' | 'architect' | 'builder' | 'tester' | 'reviewer';

export type AgentStatus =
  | 'ready_for_next_phase'
  | 'needs_human'
  | 'needs_retry'
  | 'error';

export interface AgentResult {
  status: AgentStatus;
  nextPhase?: KanbeiPhase;
  summary: string;
  questions?: string[];
  /** Tokens consumed during this agent run. Orchestrator feeds this into SafetyTracker. */
  tokensUsed?: number;
}

export interface SafetyBudget {
  remainingIterations: number;
  remainingTokens: number;
}
