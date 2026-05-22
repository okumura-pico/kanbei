// Architect agent — see docs/02-agents.md §3.
//
// Reads the SPEC section and produces an ARCH (technical design) and
// PLAN (ordered checklist) written into the issue body.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readSection, upsertSection } from '../github/body.js';
import { wrapComment } from '../github/comments.js';
import type { AgentContext } from '../orchestrator/index.js';
import type { AgentResult } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are Kanbei's Architect agent. Your job is to read a GitHub Issue's SPEC section and produce a technical architecture design plus an ordered implementation plan.

You must produce TWO markdown documents:

**archMarkdown** — the ARCH section. Use this exact template:

## Architecture

### Approach
<high-level approach: patterns, libraries, key decisions>

### Component changes
- <file or module>: <what changes and why>
- …

### Data model
<types, schemas, or database changes — write "N/A" if not applicable>

### Interfaces
<key function signatures, API contracts, or component interfaces>

### Risks & tradeoffs
- R1: <risk or tradeoff>

**planMarkdown** — the PLAN section. Use this exact template:

## Implementation Plan

1. [ ] Step 1: <concrete task>
2. [ ] Step 2: …

Rules:
- Every heading must be present. Write "N/A" for sections that genuinely don't apply.
- Plan steps must be atomic enough for one commit each.
- Output ONLY the JSON — no surrounding prose.
- If the SPEC has a critical gap that blocks architecture design, return status "needs_retry" with a clear explanation in "summary". Do NOT return needs_retry for minor issues.`;

function buildPrompt(ctx: AgentContext): string {
  const spec = readSection(ctx.issue.body, 'SPEC');
  const existingArch = readSection(ctx.issue.body, 'ARCH');
  const existingPlan = readSection(ctx.issue.body, 'PLAN');

  const lines: string[] = [
    `# Issue #${ctx.issue.number}: ${ctx.issue.title}`,
    '',
    '## Issue body (human-authored)',
    ctx.issue.body || '(empty)',
    '',
  ];

  if (spec) {
    lines.push('## SPEC section', spec, '');
  } else {
    lines.push('## SPEC section', '(not yet written — proceed with what is in the issue body)', '');
  }

  if (existingArch) {
    lines.push('## Existing ARCH section (refine if needed)', existingArch, '');
  }

  if (existingPlan) {
    lines.push('## Existing PLAN section (refine if needed)', existingPlan, '');
  }

  if (ctx.comments.length > 0) {
    lines.push('## Human comments');
    for (const c of ctx.comments) {
      lines.push(`**${c.user.login}**: ${c.body}`, '');
    }
  }

  lines.push(
    '---',
    'Produce the ARCH and PLAN sections (or report a blocking issue) as JSON.',
  );

  return lines.join('\n');
}

export async function runArchitect(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.architect.model || DEFAULT_MODEL;

  const q = query({
    prompt: buildPrompt(ctx),
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
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
            archMarkdown: { type: 'string' },
            planMarkdown: { type: 'string' },
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
          summary: `Architect SDK error: ${msg.subtype}`,
          tokensUsed: totalTokens,
        };
      }
    }
  }

  if (!structured || typeof structured !== 'object') {
    return { status: 'error', summary: 'Architect: no structured output returned' };
  }

  const out = structured as Record<string, unknown>;
  const status = (out['status'] as AgentResult['status']) ?? 'error';

  if (status === 'needs_human') {
    const questions = out['questions'] as string[] | undefined;
    if (questions && questions.length > 0) {
      const commentBody = wrapComment(
        'architect',
        `Architecture blocked — need clarification:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
      await ctx.repo.addComment(ctx.issue.number, commentBody);
    }
    return {
      status: 'needs_human',
      summary: (out['summary'] as string) ?? '',
      questions,
      tokensUsed: totalTokens,
    };
  }

  if (status === 'needs_retry') {
    return {
      status: 'needs_retry',
      summary: (out['summary'] as string) ?? 'Architect: spec gap detected, retry needed.',
      tokensUsed: totalTokens,
    };
  }

  if (status === 'ready_for_next_phase') {
    const archMarkdown = out['archMarkdown'] as string | undefined;
    const planMarkdown = out['planMarkdown'] as string | undefined;
    if (!archMarkdown || !planMarkdown) {
      return {
        status: 'error',
        summary: 'Architect: ready_for_next_phase returned without archMarkdown or planMarkdown',
      };
    }
    let body = ctx.issue.body;
    body = upsertSection(body, 'ARCH', archMarkdown);
    body = upsertSection(body, 'PLAN', planMarkdown);
    await ctx.repo.updateIssue(ctx.issue.number, { body });
    return {
      status: 'ready_for_next_phase',
      nextPhase: 'building',
      summary: (out['summary'] as string) ?? 'Architecture and plan written.',
      tokensUsed: totalTokens,
    };
  }

  return {
    status,
    summary: (out['summary'] as string) ?? '',
    tokensUsed: totalTokens,
  };
}
