// Tester agent — see docs/02-agents.md §5.
//
// Reviews the Builder's PR branch, adds or strengthens tests, commits
// them, runs the test suite, and posts a CI-result summary comment.
// Only touches test files — product code is the Builder's domain.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readSection } from '../github/body.js';
import { branchName } from './builder.js';
import { wrapComment } from '../github/comments.js';
import type { AgentContext } from '../orchestrator/index.js';
import type { AgentResult } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are Kanbei's Tester agent. Your job is to review the code changes on a pull-request branch and ensure they are adequately tested.

## Process

1. **Understand the change**: Read the SPEC's Acceptance Criteria and PLAN to understand what was implemented.
2. **Inspect the branch**: Use Read/Grep/Glob to explore the changed files. Do NOT modify product code.
3. **Add/strengthen tests**: Write test files (or update existing ones) to cover the acceptance criteria. Use the existing test framework (check package.json).
4. **Commit**: Commit only test files with message \`test: add tests for #<issue-number>\`.
5. **Run tests**: Execute the test suite (\`npm test\` or \`npx vitest run\` or equivalent). Capture the result.
6. **Comment on PR**: Post a summary of test results as a PR review comment.

## Rules
- Do NOT modify product code — only test files.
- Do NOT modify SPEC / ARCH / PLAN sections in the issue body.
- Tests must cover every Acceptance Criterion from the SPEC.
- If tests pass → return status "ready_for_next_phase" with nextPhase "review".
- If tests fail due to a Builder implementation bug → return "needs_retry" with a clear summary of which test fails and why.
- If tests fail due to a SPEC/ARCH problem → return "needs_retry" with explanation.
- If something is genuinely impossible to test → return "needs_human".

Output ONLY the JSON result — no surrounding prose.`;

function buildPrompt(ctx: AgentContext): string {
  const spec = readSection(ctx.issue.body, 'SPEC');
  const arch = readSection(ctx.issue.body, 'ARCH');
  const plan = readSection(ctx.issue.body, 'PLAN');
  const branch = branchName(
    ctx.issue.number,
    ctx.issue.title,
    ctx.config.branchPattern,
  );

  const lines: string[] = [
    `# Issue #${ctx.issue.number}: ${ctx.issue.title}`,
    '',
    `**PR branch**: \`${branch}\``,
    `**Issue number**: ${ctx.issue.number}`,
    '',
  ];

  if (spec) lines.push('## SPEC (especially Acceptance Criteria)', spec, '');
  if (arch) lines.push('## ARCH', arch, '');
  if (plan) lines.push('## PLAN (what was implemented)', plan, '');

  if (ctx.comments.length > 0) {
    lines.push('## Human comments');
    for (const c of ctx.comments) {
      lines.push(`**${c.user.login}**: ${c.body}`, '');
    }
  }

  lines.push(
    '---',
    'Review the branch, add/strengthen tests, run them, and return your result as JSON.',
  );

  return lines.join('\n');
}

export async function runTester(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.tester.model || DEFAULT_MODEL;

  const q = query({
    prompt: buildPrompt(ctx),
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['status', 'summary'],
          properties: {
            status: {
              type: 'string',
              enum: ['ready_for_next_phase', 'needs_human', 'needs_retry', 'error'],
            },
            nextPhase: { type: 'string' },
            summary: { type: 'string' },
            questions: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
    },
  });

  let totalTokens = 0;
  let structured: unknown = null;

  for await (const msg of q) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        structured = msg.structured_output ?? null;
        totalTokens = Object.values(msg.modelUsage).reduce(
          (sum, mu) => sum + mu.inputTokens + mu.outputTokens,
          0,
        );
      } else {
        return {
          status: 'error',
          summary: `Tester SDK error: ${msg.subtype}`,
          tokensUsed: totalTokens,
        };
      }
    }
  }

  if (!structured || typeof structured !== 'object') {
    return { status: 'error', summary: 'Tester: no structured output returned' };
  }

  const out = structured as Record<string, unknown>;
  const status = (out['status'] as AgentResult['status']) ?? 'error';
  const summary = (out['summary'] as string) ?? '';

  if (status === 'needs_human') {
    const questions = out['questions'] as string[] | undefined;
    if (questions && questions.length > 0) {
      const commentBody = wrapComment(
        'tester',
        `Testing blocked — need clarification:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
      await ctx.repo.addComment(ctx.issue.number, commentBody);
    }
    return { status: 'needs_human', summary, questions, tokensUsed: totalTokens };
  }

  if (status === 'needs_retry') {
    // Post a failure summary comment so humans can see what broke.
    const commentBody = wrapComment('tester', `Test run failed:\n\n${summary}`);
    await ctx.repo.addComment(ctx.issue.number, commentBody);
    return { status: 'needs_retry', summary, tokensUsed: totalTokens };
  }

  if (status === 'ready_for_next_phase') {
    // Post a passing summary comment.
    const commentBody = wrapComment('tester', `Tests passed ✓\n\n${summary}`);
    await ctx.repo.addComment(ctx.issue.number, commentBody);
    return {
      status: 'ready_for_next_phase',
      nextPhase: 'review',
      summary,
      tokensUsed: totalTokens,
    };
  }

  return { status, summary, tokensUsed: totalTokens };
}
