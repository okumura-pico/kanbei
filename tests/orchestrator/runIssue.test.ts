import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import { wrapComment } from '../../src/github/comments.js';
import { labelForPhase } from '../../src/github/labels.js';
import {
  type AgentRunner,
  type OrchestratorDeps,
  runIssue,
} from '../../src/orchestrator/index.js';
import { SafetyTracker } from '../../src/safety/index.js';
import type { AgentName, AgentResult, KanbeiPhase } from '../../src/types.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

function buildDeps(
  repo: InMemoryRepoState,
  agents: Partial<Record<AgentName, AgentRunner>>,
  overrides: Partial<OrchestratorDeps> = {},
): OrchestratorDeps {
  return {
    repo,
    config: DEFAULT_KANBEI_CONFIG,
    safety: new SafetyTracker({
      maxIterationsPerIssue: 20,
      maxIterationsPerPhase: 3,
      maxTokensPerIssue: 1_000_000,
    }),
    agents,
    ...overrides,
  };
}

function makeIssue(number: number, labels: string[], body = '') {
  return {
    number,
    title: `Issue #${number}`,
    body,
    labels,
    author: 'human-user',
  };
}

function cannedResult(result: AgentResult): AgentRunner {
  return vi.fn(async () => result);
}

describe('runIssue', () => {
  it('stops when the Issue has no Kanbei phase label', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, ['bug']));
    const result = await runIssue(buildDeps(repo, {}), 1);
    expect(result.events.at(-1)?.type).toBe('no-phase-label');
    expect(result.iterations).toBe(0);
  });

  it('stops immediately when the Issue is already in a terminal phase', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('done')]));
    const listener = cannedResult({ status: 'error', summary: 'should not run' });
    const result = await runIssue(buildDeps(repo, { listener }), 1);
    expect(listener).not.toHaveBeenCalled();
    expect(result.events.some((e) => e.type === 'terminal')).toBe(true);
  });

  it('dispatches the correct agent for the current phase', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('spec')]));
    const spec = cannedResult({ status: 'needs_human', summary: 'q?' });
    await runIssue(buildDeps(repo, { spec }), 1);
    expect(spec).toHaveBeenCalledOnce();
  });

  it('transitions to the next phase and re-dispatches the next agent', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('spec')]));
    const spec = cannedResult({
      status: 'ready_for_next_phase',
      nextPhase: 'arch',
      summary: 'spec done',
    });
    const architect = cannedResult({ status: 'needs_human', summary: 'q?' });
    await runIssue(buildDeps(repo, { spec, architect }), 1);
    expect(spec).toHaveBeenCalledOnce();
    expect(architect).toHaveBeenCalledOnce();
    // Final label should be awaiting-human (set by needs_human branch)
    expect(repo.snapshot(1).labels).toContain(labelForPhase('awaiting-human'));
  });

  it('transitions to awaiting-human and exits when the agent reports needs_human', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('gathering')]));
    const listener = cannedResult({
      status: 'needs_human',
      summary: 'need clarification',
      questions: ['Q1?'],
    });
    await runIssue(buildDeps(repo, { listener }), 1);
    const labels = repo.snapshot(1).labels;
    expect(labels).toContain(labelForPhase('awaiting-human'));
    expect(labels).not.toContain(labelForPhase('gathering'));
  });

  it('moves to kanbei:error when the agent returns error', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('building')]));
    const builder = cannedResult({ status: 'error', summary: 'gave up' });
    await runIssue(buildDeps(repo, { builder }), 1);
    expect(repo.snapshot(1).labels).toContain(labelForPhase('error'));
  });

  it('stops with phase-cap and moves to error when an agent keeps returning needs_retry', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('spec')]));
    const spec = cannedResult({ status: 'needs_retry', summary: 'try again' });
    const deps = buildDeps(repo, { spec });
    const result = await runIssue(deps, 1);
    expect(spec).toHaveBeenCalledTimes(3); // maxIterationsPerPhase
    expect(result.events.some((e) => e.type === 'safety-deny')).toBe(true);
    expect(repo.snapshot(1).labels).toContain(labelForPhase('error'));
  });

  it('feeds the agent comments with Kanbei-authored ones filtered out', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('gathering')]), [
      { id: 1, body: 'human msg', user: { login: 'alice', type: 'User' } },
      {
        id: 2,
        body: wrapComment('listener', 'previous bot question'),
        user: { login: 'kanbei-bot[bot]', type: 'Bot' },
      },
      { id: 3, body: 'second human msg', user: { login: 'bob', type: 'User' } },
    ]);
    const listener: AgentRunner = vi.fn(async ({ comments }: Parameters<AgentRunner>[0]) => {
      expect(comments.map((c) => c.id)).toEqual([1, 3]);
      return { status: 'needs_human' as const, summary: 'ok' };
    });
    await runIssue(buildDeps(repo, { listener }), 1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('records token usage from agent runs against the safety budget', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('spec')]));
    const safety = new SafetyTracker({
      maxIterationsPerIssue: 20,
      maxIterationsPerPhase: 3,
      maxTokensPerIssue: 1000,
    });
    const spec = cannedResult({
      status: 'needs_human',
      summary: 'q',
      tokensUsed: 600,
    });
    await runIssue(buildDeps(repo, { spec }, { safety }), 1);
    expect(safety.remaining().remainingTokens).toBe(400);
  });

  it('throws when an agent returns ready_for_next_phase without nextPhase', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('spec')]));
    const spec = cannedResult({
      status: 'ready_for_next_phase',
      summary: 'oops, no nextPhase',
    });
    await expect(runIssue(buildDeps(repo, { spec }), 1)).rejects.toThrow(/nextPhase/);
  });

  it('preserves non-Kanbei labels when transitioning phases', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, ['enhancement', labelForPhase('spec')]));
    const spec = cannedResult({
      status: 'ready_for_next_phase',
      nextPhase: 'arch' as KanbeiPhase,
      summary: 'done',
    });
    const architect = cannedResult({ status: 'needs_human', summary: 'q' });
    await runIssue(buildDeps(repo, { spec, architect }), 1);
    const labels = repo.snapshot(1).labels;
    expect(labels).toContain('enhancement'); // unrelated label preserved
    expect(labels).toContain(labelForPhase('awaiting-human'));
    expect(labels).not.toContain(labelForPhase('spec'));
    expect(labels).not.toContain(labelForPhase('arch'));
  });

  it('stops cleanly when there is no runner registered for the current phase', async () => {
    const repo = new InMemoryRepoState();
    repo.addIssue(makeIssue(1, [labelForPhase('spec')]));
    const result = await runIssue(buildDeps(repo, {}), 1); // no spec runner
    expect(result.events.some((e) => e.type === 'no-runner')).toBe(true);
  });
});
