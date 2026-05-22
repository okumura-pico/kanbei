// Architect agent — see docs/02-agents.md §3.
//
// Reads the SPEC section and produces an ARCH (technical design) and
// PLAN (ordered checklist) written into the issue body.
// Uses @anthropic-ai/sdk directly (no Claude Code subprocess).

import { anthropicQuery } from './anthropicQuery.js';
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

interface ArchitectOutput {
  status: AgentResult['status'];
  nextPhase?: string;
  summary: string;
  archMarkdown?: string;
  planMarkdown?: string;
  questions?: string[];
}

export async function runArchitect(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.architect.model || DEFAULT_MODEL;

  let result: { output: ArchitectOutput; tokensUsed: number };

  try {
    result = await anthropicQuery<ArchitectOutput>({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(ctx),
      toolName: 'architect_output',
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
    });
  } catch (err) {
    return {
      status: 'error',
      summary: `Architect API error: ${String(err)}`,
    };
  }

  const { output, tokensUsed } = result;
  const status = output.status ?? 'error';

  if (status === 'needs_human') {
    const questions = output.questions;
    if (questions && questions.length > 0) {
      const commentBody = wrapComment(
        'architect',
        `Architecture blocked — need clarification:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
      await ctx.repo.addComment(ctx.issue.number, commentBody);
    }
    return { status: 'needs_human', summary: output.summary ?? '', questions, tokensUsed };
  }

  if (status === 'needs_retry') {
    return {
      status: 'needs_retry',
      summary: output.summary ?? 'Architect: spec gap detected, retry needed.',
      tokensUsed,
    };
  }

  if (status === 'ready_for_next_phase') {
    if (!output.archMarkdown || !output.planMarkdown) {
      return {
        status: 'error',
        summary: 'Architect: ready_for_next_phase returned without archMarkdown or planMarkdown',
      };
    }
    let body = ctx.issue.body;
    body = upsertSection(body, 'ARCH', output.archMarkdown);
    body = upsertSection(body, 'PLAN', output.planMarkdown);
    await ctx.repo.updateIssue(ctx.issue.number, { body });
    return {
      status: 'ready_for_next_phase',
      nextPhase: 'building',
      summary: output.summary ?? 'Architecture and plan written.',
      tokensUsed,
    };
  }

  return { status, summary: output.summary ?? '', tokensUsed };
}
