import { describe, expect, it } from 'vitest';
import { SafetyTracker, type SafetyLimits } from '../../src/safety/index.js';

const LIMITS: SafetyLimits = {
  maxIterationsPerIssue: 3,
  maxIterationsPerPhase: 2,
  maxTokensPerIssue: 1000,
};

describe('SafetyTracker', () => {
  it('allows running up to but not over the per-Issue iteration cap', () => {
    const t = new SafetyTracker(LIMITS);
    expect(t.canStartIteration('spec')).toEqual({ ok: true });
    t.recordIteration('spec');
    expect(t.canStartIteration('spec')).toEqual({ ok: true });
    t.recordIteration('arch'); // phase change resets phase counter
    expect(t.canStartIteration('arch')).toEqual({ ok: true });
    t.recordIteration('arch');
    // 3 iterations recorded → next must be denied by L2.
    expect(t.canStartIteration('arch')).toEqual({
      ok: false,
      reason: 'L2_ISSUE_ITERATION_CAP',
    });
  });

  it('enforces the per-phase cap and trips L3 even with budget remaining', () => {
    const t = new SafetyTracker({ ...LIMITS, maxIterationsPerIssue: 100 });
    t.recordIteration('spec');
    t.recordIteration('spec');
    expect(t.canStartIteration('spec')).toEqual({
      ok: false,
      reason: 'L3_PHASE_ITERATION_CAP',
    });
    // Switching phase resets the phase counter and unblocks.
    expect(t.canStartIteration('arch')).toEqual({ ok: true });
  });

  it('tracks token usage and trips L4 when the budget is exhausted', () => {
    const t = new SafetyTracker(LIMITS);
    t.recordTokens(600);
    expect(t.canStartIteration('spec')).toEqual({ ok: true });
    t.recordTokens(500);
    expect(t.canStartIteration('spec')).toEqual({
      ok: false,
      reason: 'L4_TOKEN_BUDGET',
    });
  });

  it('honours the kill switch (L5) regardless of other state', () => {
    const t = new SafetyTracker(LIMITS, { disabled: true });
    expect(t.canStartIteration('spec')).toEqual({
      ok: false,
      reason: 'L5_KILL_SWITCH',
    });
  });

  it('reports remaining budget for AgentResult / logging', () => {
    const t = new SafetyTracker(LIMITS);
    t.recordIteration('spec');
    t.recordTokens(250);
    expect(t.remaining()).toEqual({
      remainingIterations: 2,
      remainingTokens: 750,
    });
  });

  it('rejects negative or non-finite token counts to catch bugs early', () => {
    const t = new SafetyTracker(LIMITS);
    expect(() => t.recordTokens(-1)).toThrow();
    expect(() => t.recordTokens(Number.NaN)).toThrow();
  });
});
