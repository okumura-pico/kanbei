import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import type { AgentContext } from '../../src/orchestrator/index.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

vi.mock('../../src/agents/anthropicQuery.js', () => ({ anthropicQuery: vi.fn() }));

const { anthropicQuery } = await import('../../src/agents/anthropicQuery.js');
const { runListener } = await import('../../src/agents/listener.js');

const mockAnthropicQuery = anthropicQuery as ReturnType<typeof vi.fn>;

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issue: {
      number: 42,
      title: 'Add dark mode',
      body: 'The app should support dark mode.',
      labels: ['kanbei:gathering'],
      author: 'alice',
    },
    comments: [],
    config: DEFAULT_KANBEI_CONFIG,
    safety: { remainingIterations: 10, remainingTokens: 100_000 },
    repo: new InMemoryRepoState(),
    ...overrides,
  };
}

describe('runListener', () => {
  beforeEach(() => {
    mockAnthropicQuery.mockClear();
  });

  it('returns ready_for_next_phase with spec when output says so', async () => {
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', nextPhase: 'spec', summary: 'User wants dark mode toggle in settings.' },
      tokensUsed: 400,
    });
    const result = await runListener(makeCtx());
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('spec');
    expect(result.summary).toBe('User wants dark mode toggle in settings.');
    expect(result.tokensUsed).toBe(400);
  });

  it('returns needs_human with questions when output says so', async () => {
    mockAnthropicQuery.mockResolvedValue({
      output: {
        status: 'needs_human',
        summary: 'Need clarification',
        questions: ['Which platforms?', 'System-level or in-app toggle?'],
      },
      tokensUsed: 300,
    });
    const result = await runListener(makeCtx());
    expect(result.status).toBe('needs_human');
    expect(result.questions).toEqual(['Which platforms?', 'System-level or in-app toggle?']);
  });

  it('returns error when API throws', async () => {
    mockAnthropicQuery.mockRejectedValue(new Error('error_max_turns: limit reached'));
    const result = await runListener(makeCtx());
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_turns/);
  });

  it('includes comments in the prompt sent to the API', async () => {
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'needs info' },
      tokensUsed: 200,
    });
    const ctx = makeCtx({
      comments: [
        { id: 1, body: 'Can you add it to mobile too?', user: { login: 'bob', type: 'User' } },
      ],
    });
    await runListener(ctx);
    const [callArgs] = mockAnthropicQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('Can you add it to mobile too?');
    expect(callArgs.prompt).toContain('bob');
  });

  it('uses model from config when set', async () => {
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'q?' },
      tokensUsed: 100,
    });
    const ctx = makeCtx({
      config: {
        ...DEFAULT_KANBEI_CONFIG,
        agents: {
          ...DEFAULT_KANBEI_CONFIG.agents,
          listener: { model: 'claude-haiku-4-5-20251001' },
        },
      },
    });
    await runListener(ctx);
    const [callArgs] = mockAnthropicQuery.mock.lastCall!;
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
  });
});
