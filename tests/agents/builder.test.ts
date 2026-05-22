import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import { isKanbeiComment } from '../../src/github/comments.js';
import type { AgentContext } from '../../src/orchestrator/index.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { runBuilder, branchName } = await import('../../src/agents/builder.js');

const mockQuery = query as ReturnType<typeof vi.fn>;

const PLAN_MD = `## Implementation Plan

1. [ ] Step 1: Add CSS variable scaffolding
2. [ ] Step 2: Build ThemeProvider component
3. [ ] Step 3: Wire toggle into Settings screen`;

const ISSUE_BODY = `User wants dark mode.

<!-- KANBEI_SPEC_START -->
## Specification
### Goals
- Dark mode
<!-- KANBEI_SPEC_END -->

<!-- KANBEI_ARCH_START -->
## Architecture
### Approach
CSS variables
<!-- KANBEI_ARCH_END -->

<!-- KANBEI_PLAN_START -->
${PLAN_MD}
<!-- KANBEI_PLAN_END -->`;

function makeRepo(body = ISSUE_BODY) {
  const repo = new InMemoryRepoState();
  repo.addIssue({ number: 9, title: 'Add dark mode', body, labels: ['kanbei:building'], author: 'alice' });
  return repo;
}

function makeCtx(repo: InMemoryRepoState, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issue: repo.snapshot(9),
    comments: [],
    config: DEFAULT_KANBEI_CONFIG,
    safety: { remainingIterations: 10, remainingTokens: 100_000 },
    repo,
    ...overrides,
  };
}

async function* successQuery(out: unknown, tokens = 5000) {
  yield {
    type: 'result', subtype: 'success', structured_output: out,
    modelUsage: { m: { inputTokens: tokens - 500, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.05, contextWindow: 200000 } },
    usage: {}, result: '', duration_ms: 3000, duration_api_ms: 2900,
    is_error: false, num_turns: 5, total_cost_usd: 0.05, permission_denials: [], uuid: 'u', session_id: 's',
  };
}

async function* sdkErrorQuery(subtype: string) {
  yield {
    type: 'result', subtype, result: '', duration_ms: 50, duration_api_ms: 40,
    is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {},
    permission_denials: [], uuid: 'u', session_id: 's',
  };
}

describe('branchName', () => {
  it('substitutes <n> and <slug> from the pattern', () => {
    expect(branchName(42, 'Add dark mode', 'kanbei/issue-<n>-<slug>')).toBe(
      'kanbei/issue-42-add-dark-mode',
    );
  });

  it('slugifies special characters and truncates at 50 chars', () => {
    const long = 'This is a very long issue title that should be truncated properly!!';
    const result = branchName(1, long, 'kanbei/issue-<n>-<slug>');
    const slug = result.replace('kanbei/issue-1-', '');
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).not.toMatch(/[^a-z0-9-]/);
  });

  it('strips leading/trailing hyphens from slug', () => {
    expect(branchName(3, '---Fix stuff---', 'kanbei/issue-<n>-<slug>')).toBe(
      'kanbei/issue-3-fix-stuff',
    );
  });
});

describe('runBuilder', () => {
  beforeEach(() => { mockQuery.mockClear(); });

  it('marks PLAN checkboxes done and returns ready_for_next_phase testing on success', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'ready_for_next_phase',
      nextPhase: 'testing',
      summary: 'All steps done.',
      prUrl: 'https://github.com/owner/repo/pull/1',
    }));
    const result = await runBuilder(makeCtx(repo));
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('testing');
    expect(result.summary).toContain('https://github.com/owner/repo/pull/1');
    const plan = repo.snapshot(9).body;
    expect(plan).not.toContain('[ ]');
    expect(plan).toContain('[x]');
  });

  it('returns needs_retry when implementation hits a spec/arch gap', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_retry',
      summary: 'Step 2 failed: ARCH interface is wrong.',
    }));
    const result = await runBuilder(makeCtx(repo));
    expect(result.status).toBe('needs_retry');
    expect(result.summary).toMatch(/ARCH interface/);
    // PLAN checkboxes should NOT be marked done
    expect(repo.snapshot(9).body).toContain('[ ]');
  });

  it('posts a comment and returns needs_human when blocked', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_human',
      summary: 'Blocked.',
      questions: ['Which test framework to use?'],
    }));
    const result = await runBuilder(makeCtx(repo));
    expect(result.status).toBe('needs_human');
    const comments = repo.snapshot(9).comments;
    expect(comments).toHaveLength(1);
    expect(isKanbeiComment(comments[0]!.body)).toBe(true);
    expect(comments[0]!.body).toContain('Which test framework');
  });

  it('returns error when SDK errors', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(sdkErrorQuery('error_max_budget_usd'));
    const result = await runBuilder(makeCtx(repo));
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_budget_usd/);
  });

  it('includes branch name derived from config pattern in the prompt', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'gap' }));
    await runBuilder(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('kanbei/issue-9-add-dark-mode');
  });

  it('uses bypassPermissions mode so git/bash run without prompts', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'gap' }));
    await runBuilder(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.options?.permissionMode).toBe('bypassPermissions');
    expect(callArgs.options?.allowDangerouslySkipPermissions).toBe(true);
  });

  it('uses the claude_code tool preset', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'gap' }));
    await runBuilder(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.options?.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('accumulates token usage', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'gap' }, 8000));
    const result = await runBuilder(makeCtx(repo));
    expect(result.tokensUsed).toBe(8000);
  });
});
