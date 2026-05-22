import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import { isKanbeiComment } from '../../src/github/comments.js';
import type { AgentContext } from '../../src/orchestrator/index.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { runReviewer } = await import('../../src/agents/reviewer.js');

const mockQuery = query as ReturnType<typeof vi.fn>;

const ISSUE_BODY = `Implement dark mode.

<!-- KANBEI_SPEC_START -->
## Specification

### Goals
- Dark mode toggle

### Acceptance criteria
- AC1: Toggle persists across restarts
- AC2: All UI elements respect the selected theme
<!-- KANBEI_SPEC_END -->

<!-- KANBEI_ARCH_START -->
## Architecture

### Approach
CSS variables + ThemeProvider
<!-- KANBEI_ARCH_END -->

<!-- KANBEI_PLAN_START -->
## Implementation Plan

1. [x] Step 1: CSS variables
2. [x] Step 2: ThemeProvider
<!-- KANBEI_PLAN_END -->`;

function makeRepo(body = ISSUE_BODY) {
  const repo = new InMemoryRepoState();
  repo.addIssue({ number: 13, title: 'Add dark mode', body, labels: ['kanbei:review'], author: 'alice' });
  return repo;
}

function makeCtx(repo: InMemoryRepoState, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issue: repo.snapshot(13),
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
    modelUsage: { m: { inputTokens: tokens - 400, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.04, contextWindow: 200000 } },
    usage: {}, result: '', duration_ms: 2500, duration_api_ms: 2400,
    is_error: false, num_turns: 5, total_cost_usd: 0.04, permission_denials: [], uuid: 'u', session_id: 's',
  };
}

async function* sdkErrorQuery(subtype: string) {
  yield {
    type: 'result', subtype, result: '', duration_ms: 50, duration_api_ms: 40,
    is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {},
    permission_denials: [], uuid: 'u', session_id: 's',
  };
}

describe('runReviewer', () => {
  beforeEach(() => { mockQuery.mockClear(); });

  it('returns ready_for_next_phase done when all ACs are satisfied', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'ready_for_next_phase',
      nextPhase: 'done',
      summary: 'All ACs met. PR approved.',
      reviewAction: 'approved',
    }));
    const result = await runReviewer(makeCtx(repo));
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('done');
    expect(result.summary).toContain('approved');
  });

  it('returns needs_retry when changes are requested', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_retry',
      summary: 'AC2 not met: Settings screen still uses hardcoded colours.',
      reviewAction: 'changes_requested',
    }));
    const result = await runReviewer(makeCtx(repo));
    expect(result.status).toBe('needs_retry');
    expect(result.summary).toMatch(/AC2/);
  });

  it('posts a comment and returns needs_human when human judgment is required', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_human',
      summary: 'Cannot verify external service integration.',
      questions: ['Can you manually verify the toggle works on iOS?'],
      reviewAction: 'none',
    }));
    const result = await runReviewer(makeCtx(repo));
    expect(result.status).toBe('needs_human');
    const comments = repo.snapshot(13).comments;
    expect(comments).toHaveLength(1);
    expect(isKanbeiComment(comments[0]!.body)).toBe(true);
    expect(comments[0]!.body).toContain('Can you manually verify');
  });

  it('returns error when SDK reports an error subtype', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(sdkErrorQuery('error_max_turns'));
    const result = await runReviewer(makeCtx(repo));
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_turns/);
  });

  it('includes branch name and SPEC acceptance criteria in the prompt', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }));
    await runReviewer(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('kanbei/issue-13-add-dark-mode');
    expect(callArgs.prompt).toContain('AC1: Toggle persists');
    expect(callArgs.prompt).toContain('AC2: All UI elements');
  });

  it('uses bypassPermissions mode so gh CLI runs without prompts', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }));
    await runReviewer(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.options?.permissionMode).toBe('bypassPermissions');
    expect(callArgs.options?.allowDangerouslySkipPermissions).toBe(true);
  });

  it('uses the claude_code tool preset', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }));
    await runReviewer(makeCtx(repo));
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.options?.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('does not post a comment when needs_human has no questions', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({
      status: 'needs_human', summary: 'unclear', questions: [], reviewAction: 'none',
    }));
    await runReviewer(makeCtx(repo));
    expect(repo.snapshot(13).comments).toHaveLength(0);
  });

  it('accumulates token usage', async () => {
    const repo = makeRepo();
    mockQuery.mockReturnValue(successQuery({ status: 'needs_retry', summary: 'fail' }, 7000));
    const result = await runReviewer(makeCtx(repo));
    expect(result.tokensUsed).toBe(7000);
  });
});
