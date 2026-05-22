import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';
import { isKanbeiComment } from '../../src/github/comments.js';
import type { AgentContext } from '../../src/orchestrator/index.js';
import { InMemoryRepoState } from '../_helpers/inMemoryRepoState.js';

vi.mock('../../src/agents/anthropicQuery.js', () => ({ anthropicQuery: vi.fn() }));

const { anthropicQuery } = await import('../../src/agents/anthropicQuery.js');
const { runArchitect } = await import('../../src/agents/architect.js');

const mockAnthropicQuery = anthropicQuery as ReturnType<typeof vi.fn>;

const ARCH_MD = `## Architecture

### Approach
Add a CSS variable for color scheme and a toggle component.

### Component changes
- src/theme.ts: new ThemeProvider

### Data model
N/A

### Interfaces
\`toggleTheme(): void\`

### Risks & tradeoffs
- R1: Safari < 15 doesn't support CSS variables`;

const PLAN_MD = `## Implementation Plan

1. [ ] Step 1: Add CSS variable scaffolding
2. [ ] Step 2: Build ThemeProvider component
3. [ ] Step 3: Wire toggle into Settings screen`;

const SPEC_BODY = `User wants dark mode.

<!-- KANBEI_SPEC_START -->
## Specification

### Goals
- Dark mode support

### Acceptance criteria
- AC1: Toggle persists
<!-- KANBEI_SPEC_END -->`;

function makeRepo(body = SPEC_BODY) {
  const repo = new InMemoryRepoState();
  repo.addIssue({ number: 7, title: 'Dark mode', body, labels: ['kanbei:arch'], author: 'alice' });
  return repo;
}

function makeCtx(repo: InMemoryRepoState, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issue: repo.snapshot(7),
    comments: [],
    config: DEFAULT_KANBEI_CONFIG,
    safety: { remainingIterations: 10, remainingTokens: 100_000 },
    repo,
    ...overrides,
  };
}

describe('runArchitect', () => {
  beforeEach(() => { mockAnthropicQuery.mockClear(); });

  it('writes ARCH and PLAN sections and returns ready_for_next_phase building', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', nextPhase: 'building', summary: 'Design ready.', archMarkdown: ARCH_MD, planMarkdown: PLAN_MD },
      tokensUsed: 400,
    });
    const result = await runArchitect(makeCtx(repo));
    expect(result.status).toBe('ready_for_next_phase');
    expect(result.nextPhase).toBe('building');
    const body = repo.snapshot(7).body;
    expect(body).toContain('<!-- KANBEI_ARCH_START -->');
    expect(body).toContain('### Approach');
    expect(body).toContain('<!-- KANBEI_PLAN_START -->');
    expect(body).toContain('Step 1:');
  });

  it('preserves the existing SPEC section when writing ARCH and PLAN', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', nextPhase: 'building', summary: 'Done.', archMarkdown: ARCH_MD, planMarkdown: PLAN_MD },
      tokensUsed: 400,
    });
    await runArchitect(makeCtx(repo));
    const body = repo.snapshot(7).body;
    expect(body).toContain('KANBEI_SPEC_START');
    expect(body).toContain('KANBEI_ARCH_START');
    expect(body).toContain('KANBEI_PLAN_START');
  });

  it('returns needs_retry when spec has a critical gap', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_retry', summary: 'SPEC missing acceptance criteria — cannot proceed.' },
      tokensUsed: 200,
    });
    const result = await runArchitect(makeCtx(repo));
    expect(result.status).toBe('needs_retry');
    expect(result.summary).toMatch(/SPEC missing/);
    expect(repo.snapshot(7).body).not.toContain('KANBEI_ARCH_START');
  });

  it('posts a comment and returns needs_human when blocked on a question', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_human', summary: 'Need info.', questions: ['Which state management library?'] },
      tokensUsed: 200,
    });
    const result = await runArchitect(makeCtx(repo));
    expect(result.status).toBe('needs_human');
    const comments = repo.snapshot(7).comments;
    expect(comments).toHaveLength(1);
    expect(isKanbeiComment(comments[0]!.body)).toBe(true);
    expect(comments[0]!.body).toContain('Which state management library?');
  });

  it('returns error when API throws', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockRejectedValue(new Error('error_max_turns'));
    const result = await runArchitect(makeCtx(repo));
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/error_max_turns/);
  });

  it('returns error when ready_for_next_phase but archMarkdown is missing', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', summary: 'done', planMarkdown: PLAN_MD },
      tokensUsed: 300,
    });
    const result = await runArchitect(makeCtx(repo));
    expect(result.status).toBe('error');
  });

  it('returns error when ready_for_next_phase but planMarkdown is missing', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', summary: 'done', archMarkdown: ARCH_MD },
      tokensUsed: 300,
    });
    const result = await runArchitect(makeCtx(repo));
    expect(result.status).toBe('error');
  });

  it('idempotently updates ARCH and PLAN on a second run', async () => {
    const bodyWithOldSections = `${SPEC_BODY}

<!-- KANBEI_ARCH_START -->
## Architecture

### Approach
Old approach
<!-- KANBEI_ARCH_END -->

<!-- KANBEI_PLAN_START -->
## Implementation Plan

1. [ ] Old step
<!-- KANBEI_PLAN_END -->`;

    const repo = makeRepo(bodyWithOldSections);
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'ready_for_next_phase', nextPhase: 'building', summary: 'Revised.', archMarkdown: ARCH_MD, planMarkdown: PLAN_MD },
      tokensUsed: 500,
    });
    await runArchitect(makeCtx(repo));
    const body = repo.snapshot(7).body;
    expect((body.match(/KANBEI_ARCH_START/g) ?? []).length).toBe(1);
    expect((body.match(/KANBEI_PLAN_START/g) ?? []).length).toBe(1);
    expect(body).not.toContain('Old approach');
    expect(body).not.toContain('Old step');
    expect(body).toContain('ThemeProvider');
  });

  it('includes SPEC content in the prompt', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_retry', summary: 'gap' },
      tokensUsed: 200,
    });
    await runArchitect(makeCtx(repo));
    const [callArgs] = mockAnthropicQuery.mock.lastCall!;
    expect(callArgs.prompt).toContain('Dark mode support');
    expect(callArgs.prompt).toContain('AC1: Toggle persists');
  });

  it('accumulates token usage correctly', async () => {
    const repo = makeRepo();
    mockAnthropicQuery.mockResolvedValue({
      output: { status: 'needs_retry', summary: 'gap' },
      tokensUsed: 700,
    });
    const result = await runArchitect(makeCtx(repo));
    expect(result.tokensUsed).toBe(700);
  });
});
