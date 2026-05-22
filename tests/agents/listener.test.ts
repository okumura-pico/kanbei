import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import type { AgentContext } from '../../src/orchestrator/index.js';

// Mock the SDK before importing the agent under test.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Import after the mock is in place.
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { runListener } = await import('../../src/agents/listener.js');

const mockQuery = query as ReturnType<typeof vi.fn>;

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
    ...overrides,
  };
}

async function* makeSuccessQuery(structuredOutput: unknown, modelUsage = { 'claude-opus-4-7': { inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01, contextWindow: 200000 } }) {
  yield {
    type: 'result',
    subtype: 'success',
    structured_output: structuredOutput,
    modelUsage,
    usage: { input_tokens: 300, output_tokens: 100 },
    result: '',
    duration_ms: 500,
    duration_api_ms: 480,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.01,
    permission_denials: [],
    uuid: 'test-uuid',
    session_id: 'test-session',
  };
}

async function* makeErrorQuery(subtype: string) {
  yield {
    type: 'result',
    subtype,
    result: '',
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'test-uuid',
    session_id: 'test-session',
  };
}

describe('runListener', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it('returns ready_for_next_phase with spec when output says so', async () => {
    mockQuery.mockReturnValue(
      makeSuccessQuery({ status: 'ready_for_next_phase', nextPhase: 'spec', summary: 'User wants dark mode toggle in settings.' }),
    );
    const result = await runListener(makeCtx());
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('spec');
    expect(result.summary).toBe('User wants dark mode toggle in settings.');
    expect(result.tokensUsed).toBe(400);
  });

  it('returns needs_human with questions when output says so', async () => {
    mockQuery.mockReturnValue(
      makeSuccessQuery({
        status: 'needs_human',
        summary: 'Need clarification',
        questions: ['Which platforms?', 'System-level or in-app toggle?'],
      }),
    );
    const result = await runListener(makeCtx());
    expect(result.status).toBe('needs_human');
    expect(result.questions).toEqual(['Which platforms?', 'System-level or in-app toggle?']);
  });

  it('returns error when SDK reports an error subtype', async () => {
    mockQuery.mockReturnValue(makeErrorQuery('error_max_turns'));
    const result = await runListener(makeCtx());
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_turns/);
  });

  it('returns error when structured output is missing', async () => {
    mockQuery.mockReturnValue(makeSuccessQuery(null));
    const result = await runListener(makeCtx());
    expect(result.status).toBe('error');
  });

  it('includes comments in the prompt sent to the SDK', async () => {
    mockQuery.mockReturnValue(
      makeSuccessQuery({ status: 'needs_human', summary: 'needs info' }),
    );
    const ctx = makeCtx({
      comments: [
        { id: 1, body: 'Can you add it to mobile too?', user: { login: 'bob', type: 'User' } },
      ],
    });
    await runListener(ctx);
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('Can you add it to mobile too?');
    expect(callArgs.prompt).toContain('bob');
  });

  it('uses model from config when set', async () => {
    mockQuery.mockReturnValue(
      makeSuccessQuery({ status: 'needs_human', summary: 'q?' }),
    );
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
    const [callArgs] = mockQuery.mock.lastCall!;
    expect(callArgs.options?.model).toBe('claude-haiku-4-5-20251001');
  });
});
