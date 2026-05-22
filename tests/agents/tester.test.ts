import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import { isKanbeiComment } from '../../src/github/comments.js';
import type { AgentContext } from '../../src/orchestrator/index.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { runTester } = await import('../../src/agents/tester.js');

const mockQuery = query as ReturnType<typeof vi.fn>;

const ISSUE_BODY = `User wants dark mode.

<!-- KANBEI_SPEC_START -->
## Specification
### Acceptance criteria
- AC1: Toggle persists across restarts
<!-- KANBEI_SPEC_END -->

<!-- KANBEI_PLAN_START -->
## Implementation Plan
1. [x] Step 1: Add CSS variables
2. [x] Step 2: Build ThemeProvider
<!-- KANBEI_PLAN_END -->`;

function makeRepo(body = ISSUE_BODY) {
  const repo = new InMemoryRepoState();
  repo.addIssue({ number: 11, title: 'Add dark mode', body, labels: ['kanbei:testing'], author: 'alice' });
  return repo;
}

function makeCtx(repo: InMemoryRepoState, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issue: repo.snapshot(11),
    comments: [],
    config: DEFAULT_KANBEI_CONFIG,
    safety: { remainingIterations: 10, remainingTokens: 100_000 },
    repo,
    ...overrides,
  };
}

async function* successQuery(out: unknown, tokens = 3000) {
  yield {
    type: 'result', subtype: 'success', structured_output: out,
    modelUsage: { m: { inputTokens: tokens - 300, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.03, contextWindow: 200000 } },
    usage: {}, result: '', duration_ms: 2000, duration_api_ms: 1900,
    is_error: false, num_turns: 4, total_cost_usd: 0.03, permission_denials: [], uuid: 'u', session_id: 's',
  };
}

async function* sdkErrorQuery(subtype: string) {
  yield {
    type: 'result', subtype, result: '', duration_ms: 50, duration_api_ms: 40,
    is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {},
    permission_denials: [], uuid: 'u', session_id: 's',
  };
}

describe('runTester', () => {
  beforeEach(() => { mockQuery.mockClear(); });

  it('posts a passing summary comment and returns ready_for_next_phase review', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'ready_for_next_phase',
      nextPhase: 'review',
      summary: '5 tests added, all passing.',
    }));
    const result = await runTester(makeCtx(repo));
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('review');
    const comments = repo.snapshot(11).comments;
    expect(comments).toHaveLength(1);
    expect(isKanbeiComment(comments[0]!.body)).toBe(true);
    expect(comments[0]!.body).toContain('Tests passed');
    expect(comments[0]!.body).toContain('5 tests added');
  });

  it('posts a failure comment and returns needs_retry when tests fail', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_retry',
      summary: 'ThemeProvider test fails: toggle state not persisted.',
    }));
    const result = await runTester(makeCtx(repo));
    expect(result.status).toBe('needs_retry');
    const comments = repo.snapshot(11).comments;
    expect(comments).toHaveLength(1);
    expect(isKanbeiComment(comments[0]!.body)).toBe(true);
    expect(comments[0]!.body).toContain('Test run failed');
    expect(comments[0]!.body).toContain('toggle state not persisted');
  });

  it('posts a comment and returns needs_human when blocked', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_human',
      summary: 'Cannot determine test framework.',
      questions: ['Should I use vitest or jest?'],
    }));
    const result = await runTester(makeCtx(repo));
    expect(result.status).toBe('needs_human');
    expect(result.questions).toHaveLength(1);
    const comments = repo.snapshot(11).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('Should I use vitest or jest?');
  });

  it('returns error when SDK errors', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(sdkErrorQuery('error_max_turns'));
    const result = await runTester(makeCtx(repo));
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_turns/);
  });

  it('includes the branch name and SPEC acceptance criteria in the prompt', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }));
    await runTester(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('kanbei/issue-11-add-dark-mode');
    expect(callArgs.prompt).toContain('AC1: Toggle persists');
  });

  it('uses bypassPermissions mode', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }));
    await runTester(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.options?.permissionMode).toBe('bypassPermissions');
    expect(callArgs.options?.allowDangerouslySkipPermissions).toBe(true);
  });

  it('does not post a comment when needs_human has no questions', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_human', summary: 'blocked', questions: [] }));
    await runTester(makeCtx(repo));
    expect(repo.snapshot(11).comments).toHaveLength(0);
  });

  it('accumulates token usage', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }, 6000));
    const result = await runTester(makeCtx(repo));
    expect(result.tokensUsed).toBe(6000);
  });
});
