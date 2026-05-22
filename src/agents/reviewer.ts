// Reviewer agent — see docs/02-agents.md §6.
//
// Reads the PR diff for the issue's branch, checks it against the SPEC
// acceptance criteria, and either approves the PR (→ done) or requests
// changes (→ back to building via needs_retry).

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readSection } from '../github/body.js';
import { wrapComment } from '../github/comments.js';
import { branchName } from './builder.js';
import type { AgentContext } from '../orchestrator/index.js';
import type { AgentResult } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are Kanbei's Reviewer agent. Your job is to review a pull request and decide whether it satisfies the issue's SPEC acceptance criteria well enough to merge.

## Process

1. **Find the PR**: Run \`gh pr list --head <branch> --json number,url,title\` to find the open PR for this branch. If no open PR exists, run \`gh pr list --head <branch> --state merged\` — if it's merged, return ready_for_next_phase immediately.
2. **Read the diff**: Run \`gh pr diff <PR-number>\` to read all changed files.
3. **Check each Acceptance Criterion**: For each AC in the SPEC, verify the implementation satisfies it. Also check for:
   - Security issues (injection, secrets in code, unsafe operations)
   - Obvious bugs or logic errors
   - Missing error handling at system boundaries
   - Code style consistency with the existing codebase
4. **Post a review**:
   - All ACs satisfied and no blocking issues → \`gh pr review <PR-number> --approve --body "<summary>"\`
   - Blocking issues found → \`gh pr review <PR-number> --request-changes --body "<detailed feedback>"\`
5. **Return JSON result.**

## Rules
- Do NOT approve unless ALL Acceptance Criteria are met.
- Be constructive but decisive — do not leave a "commented" review without a clear approve or request-changes.
- Minor style nits do not block approval; flag them in the review body but still approve if ACs are met.
- If no open or merged PR exists for the branch, return needs_human.
- If you cannot determine correctness (e.g., external service integration with no way to test), return needs_human.
- Do NOT modify any files — read only, plus gh CLI for the review.

Output ONLY the JSON result — no surrounding prose.`;

function buildPrompt(ctx: AgentContext): string {
  const spec = readSection(ctx.issue.body, 'SPEC');
  const arch = readSection(ctx.issue.body, 'ARCH');
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

  if (spec) lines.push('## SPEC (review against every Acceptance Criterion)', spec, '');
  if (arch) lines.push('## ARCH (for architectural context)', arch, '');

  if (ctx.comments.length > 0) {
    lines.push('## Human comments');
    for (const c of ctx.comments) {
      lines.push(`**${c.user.login}**: ${c.body}`, '');
    }
  }

  lines.push(
    '---',
    'Find the PR, review the diff, post your review via gh CLI, then return your result as JSON.',
  );

  return lines.join('\n');
}

export async function runReviewer(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.reviewer.model || DEFAULT_MODEL;

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
            /** The gh review action taken: 'approved', 'changes_requested', or none. */
            reviewAction: { type: 'string', enum: ['approved', 'changes_requested', 'none'] },
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
          summary: `Reviewer SDK error: ${msg.subtype}`,
          tokensUsed: totalTokens,
        };
      }
    }
  }

  if (!structured || typeof structured !== 'object') {
    return { status: 'error', summary: 'Reviewer: no structured output returned' };
  }

  const out = structured as Record<string, unknown>;
  const status = (out['status'] as AgentResult['status']) ?? 'error';
  const summary = (out['summary'] as string) ?? '';

  if (status === 'needs_human') {
    const questions = out['questions'] as string[] | undefined;
    if (questions && questions.length > 0) {
      const commentBody = wrapComment(
        'reviewer',
        `Review blocked — need human judgment:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
      await ctx.repo.addComment(ctx.issue.number, commentBody);
    }
    return { status: 'needs_human', summary, questions, tokensUsed: totalTokens };
  }

  if (status === 'needs_retry') {
    return { status: 'needs_retry', summary, tokensUsed: totalTokens };
  }

  if (status === 'ready_for_next_phase') {
    return {
      status: 'ready_for_next_phase',
      nextPhase: 'done',
      summary,
      tokensUsed: totalTokens,
    };
  }

  return { status, summary, tokensUsed: totalTokens };
}
