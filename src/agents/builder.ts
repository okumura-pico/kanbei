// Builder agent — see docs/02-agents.md §4.
//
// Works in the current repo (self-hosting mode): creates a branch,
// implements all PLAN steps commit-by-commit, then opens a PR.
// Uses the full Claude Code tool preset so it can read/edit/run code.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readSection, upsertSection } from '../github/body.js';
import { wrapComment } from '../github/comments.js';
import type { AgentContext } from '../orchestrator/index.js';
import type { AgentResult } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4-7';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export function branchName(issueNumber: number, title: string, pattern: string): string {
  return pattern
    .replace('<n>', String(issueNumber))
    .replace('<slug>', slugify(title));
}

const SYSTEM_PROMPT = `You are Kanbei's Builder agent. Your job is to implement a GitHub Issue by following its PLAN checklist, working entirely through the shell and filesystem tools available to you.

## Process

1. **Branch**: Create or switch to the branch named in the prompt. If it already exists, reuse it.
2. **Implement**: Work through the PLAN steps in order. For each step:
   - Write or modify the necessary files.
   - Run tests if a test command is available (\`npm test\`, \`npx vitest run\`, etc.).
   - Commit with a conventional commit message in English (feat:/fix:/refactor:/test: prefix). Do NOT skip hooks with --no-verify.
3. **PR**: After all steps are complete, open a PR with \`gh pr create\`. The PR body must contain \`Closes #<issue-number>\`.
4. **Update PLAN**: After the PR is open, report the result as JSON.

## Rules
- Never commit secrets, .env files, or private keys.
- Follow existing code style and conventions (check CLAUDE.md if present).
- Do not modify files outside the scope of the PLAN.
- If you discover that the SPEC or ARCH is wrong or incomplete mid-implementation, stop and return status "needs_retry" explaining which step failed and why.
- If you are genuinely blocked by something outside your control, return "needs_human".
- On success, return "ready_for_next_phase" with nextPhase "testing" and include the PR URL in "summary".

Output ONLY the JSON result at the end — no surrounding prose.`;

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
    `**Branch to use**: \`${branch}\``,
    `**Issue number for PR**: ${ctx.issue.number}`,
    '',
  ];

  if (spec) lines.push('## SPEC', spec, '');
  if (arch) lines.push('## ARCH', arch, '');
  if (plan) {
    lines.push('## PLAN (implement these steps in order)', plan, '');
  } else {
    lines.push('## PLAN', '(not yet written — infer from SPEC and ARCH)', '');
  }

  if (ctx.comments.length > 0) {
    lines.push('## Human comments');
    for (const c of ctx.comments) {
      lines.push(`**${c.user.login}**: ${c.body}`, '');
    }
  }

  lines.push('---', 'Implement the plan, open the PR, then return your result as JSON.');

  return lines.join('\n');
}

function markPlanDone(planMarkdown: string): string {
  return planMarkdown.replace(/\[ \]/g, '[x]');
}

export async function runBuilder(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.builder.model || DEFAULT_MODEL;

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
            prUrl: { type: 'string' },
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
          summary: `Builder SDK error: ${msg.subtype}`,
          tokensUsed: totalTokens,
        };
      }
    }
  }

  if (!structured || typeof structured !== 'object') {
    return { status: 'error', summary: 'Builder: no structured output returned' };
  }

  const out = structured as Record<string, unknown>;
  const status = (out['status'] as AgentResult['status']) ?? 'error';
  const summary = (out['summary'] as string) ?? '';

  if (status === 'needs_human') {
    const questions = out['questions'] as string[] | undefined;
    if (questions && questions.length > 0) {
      const commentBody = wrapComment(
        'builder',
        `Implementation blocked — need clarification:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
      await ctx.repo.addComment(ctx.issue.number, commentBody);
    }
    return { status: 'needs_human', summary, questions, tokensUsed: totalTokens };
  }

  if (status === 'needs_retry') {
    return { status: 'needs_retry', summary, tokensUsed: totalTokens };
  }

  if (status === 'ready_for_next_phase') {
    // Mark the PLAN checkboxes as done.
    const plan = readSection(ctx.issue.body, 'PLAN');
    if (plan) {
      const updatedBody = upsertSection(ctx.issue.body, 'PLAN', markPlanDone(plan));
      await ctx.repo.updateIssue(ctx.issue.number, { body: updatedBody });
    }
    const prUrl = out['prUrl'] as string | undefined;
    const fullSummary = prUrl ? `${summary}\nPR: ${prUrl}` : summary;
    return {
      status: 'ready_for_next_phase',
      nextPhase: 'testing',
      summary: fullSummary,
      tokensUsed: totalTokens,
    };
  }

  return { status, summary, tokensUsed: totalTokens };
}
