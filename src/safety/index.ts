// Per-Issue iteration / token budget enforcement and kill switch.
// See docs/01-architecture.md §5. State is held in-memory for one
// orchestrator process; persisting across runs lands in P5 when
// GitHub Actions takes over.

import type { KanbeiPhase, SafetyBudget } from '../types.js';

export interface SafetyLimits {
  maxIterationsPerIssue: number;
  maxIterationsPerPhase: number;
  maxTokensPerIssue: number;
}

export interface SafetyOptions {
  /** L5 kill switch: when true, every gate denies. */
  disabled?: boolean;
}

export type SafetyDenyReason =
  | 'L2_ISSUE_ITERATION_CAP'
  | 'L3_PHASE_ITERATION_CAP'
  | 'L4_TOKEN_BUDGET'
  | 'L5_KILL_SWITCH';

export type SafetyDecision = { ok: true } | { ok: false; reason: SafetyDenyReason };

export class SafetyTracker {
  private iterations = 0;
  private tokens = 0;
  private currentPhase: KanbeiPhase | null = null;
  private phaseIterations = 0;

  constructor(
    private readonly limits: SafetyLimits,
    private readonly options: SafetyOptions = {},
  ) {}

  canStartIteration(nextPhase: KanbeiPhase): SafetyDecision {
    if (this.options.disabled) return { ok: false, reason: 'L5_KILL_SWITCH' };
    if (this.iterations >= this.limits.maxIterationsPerIssue) {
      return { ok: false, reason: 'L2_ISSUE_ITERATION_CAP' };
    }
    if (this.tokens >= this.limits.maxTokensPerIssue) {
      return { ok: false, reason: 'L4_TOKEN_BUDGET' };
    }
    const phaseCount = nextPhase === this.currentPhase ? this.phaseIterations : 0;
    if (phaseCount >= this.limits.maxIterationsPerPhase) {
      return { ok: false, reason: 'L3_PHASE_ITERATION_CAP' };
    }
    return { ok: true };
  }

  recordIteration(phase: KanbeiPhase): void {
    this.iterations += 1;
    if (this.currentPhase === phase) {
      this.phaseIterations += 1;
    } else {
      this.currentPhase = phase;
      this.phaseIterations = 1;
    }
  }

  recordTokens(count: number): void {
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`recordTokens: invalid token count ${count}`);
    }
    this.tokens += count;
  }

  remaining(): SafetyBudget {
    return {
      remainingIterations: Math.max(0, this.limits.maxIterationsPerIssue - this.iterations),
      remainingTokens: Math.max(0, this.limits.maxTokensPerIssue - this.tokens),
    };
  }
}
