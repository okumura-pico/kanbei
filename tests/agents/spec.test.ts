import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import { isKanbeiComment } from '../../src/github/comments.js';
import type { AgentContext } from '../../src/orchestrator/index.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

vi.mock('../../src/agents/anthropicQuery.js', () => ({ anthropicQuery: vi.fn() }));

const { anthropicQuery } = await import('../../src/agents/anthropicQuery.js');
const { runSpec } = await import('../../src/agents/spec.js');

const mockAnthropicQuery = anthropicQuery as ReturnType<typeof vi.fn>;

const SPEC_MD = `## Specification

### Goals
- Add dark mode toggle

### Non-goals
- None

### Functional requirements
- FR1: Toggle in settings screen

### Non-functional requirements
- None

### Assumptions
- None

### Acceptance criteria
- AC1: Toggle persists across restarts`;

function makeRepo(issueBody = '') {
  const repo = new InMemoryRepoState();
  repo.addIssue({ number: 5, title: 'Dark mode', body: issueBody, labels: ['kanbei:spec'], author: 'alice' });
  return repo;
}

function makeCtx(repo: InMemoryRepoState, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issue: repo.snapshot(5),
    comments: [],
    config: DEFAULT_KANBEI_CONFIG,
    safety: { remainingIterations: 10, remainingTokens: 100_000 },
    repo,
    ...overrides,
  };
}

describe('runSpec', () => {
  beforeEach(() => { mockAnthropicQuery.mockClear(); });

  it('writes the spec to the issue body and returns ready_for_next_phase arch', async () => {
    const repo = makeRepo('User wants dark mode.');
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', nextPhase: 'arch', summary: 'Spec written.', specMarkdown: SPEC_MD },
      tokensUsed: 280,
    });
    const result = await runSpec(makeCtx(repo));
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('arch');
    expect(repo.snapshot(5).body).toContain('<!-- KANBEI_SPEC_START -->');
    expect(repo.snapshot(5).body).toContain('### Goals');
    expect(repo.snapshot(5).body).toContain('AC1:');
  });

  it('posts a clarification comment and returns needs_human when questions remain', async () => {
    const repo = makeRepo('User wants dark mode.');
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'Need more info.', questions: ['Which platforms?', 'System or in-app?'] },
      tokensUsed: 150,
    });
    const result = await runSpec(makeCtx(repo));
    expect(result.status).toBe('needs_human');
    expect(result.questions).toHaveLength(2);
    const comments = repo.snapshot(5).comments;
    expect(comments).toHaveLength(1);
    expect(isKanbeiComment(comments[0]!.body)).toBe(true);
    expect(comments[0]!.body).toContain('Which platforms?');
  });

  it('returns error when API throws', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockRejectedValue(new Error('error_max_turns'));
    const result = await runSpec(makeCtx(repo));
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_turns/);
  });

  it('returns error when ready_for_next_phase but specMarkdown is missing', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', summary: 'oops' },
      tokensUsed: 100,
    });
    const result = await runSpec(makeCtx(repo));
    expect(result.status).toBe('error');
  });

  it('idempotently updates an existing SPEC section on a second run', async () => {
    const existingBody = `User wants dark mode.\n\n<!-- KANBEI_SPEC_START -->\n## Specification\n\n### Goals\n- Old goal\n<!-- KANBEI_SPEC_END -->\n`;
    const repo = makeRepo(existingBody);
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', nextPhase: 'arch', summary: 'Updated spec.', specMarkdown: SPEC_MD },
      tokensUsed: 300,
    });
    await runSpec(makeCtx(repo));
    const body = repo.snapshot(5).body;
    expect((body.match(/KANBEI_SPEC_START/g) ?? []).length).toBe(1);
    expect(body).not.toContain('Old goal');
    expect(body).toContain('### Goals');
  });

  it('includes existing spec in the prompt for refinement', async () => {
    const existingBody = `User wants dark mode.\n\n<!-- KANBEI_SPEC_START -->\n## Specification\n\n### Goals\n- Prior draft\n<!-- KANBEI_SPEC_END -->\n`;
    const repo = makeRepo(existingBody);
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'q?' },
      tokensUsed: 100,
    });
    await runSpec(makeCtx(repo));
    const [callArgs] = mockAnthropicQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('Prior draft');
  });

  it('does not post a comment when needs_human has no questions', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'paused', questions: [] },
      tokensUsed: 80,
    });
    await runSpec(makeCtx(repo));
    expect(repo.snapshot(5).comments).toHaveLength(0);
  });

  it('accumulates token usage', async () => {
    const repo = makeRepo('body');
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'q?' },
      tokensUsed: 650,
    });
    const result = await runSpec(makeCtx(repo));
    expect(result.tokensUsed).toBe(650);
  });
});
