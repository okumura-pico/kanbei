// Spec agent — see docs/02-agents.md §2.
//
// Turns the requirements gathered by the Listener into a structured
// spec written into the KANBEI_SPEC section of the issue body.
// Uses @anthropic-ai/sdk directly (no Claude Code subprocess).

import { anthropicQuery } from './anthropicQuery.js';
import { readSection, upsertSection } from '../github/body.js';
import { wrapComment } from '../github/comments.js';
import type { AgentContext } from '../orchestrator/index.js';
import type { AgentResult } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are Kanbei's Spec agent. Your job is to produce a structured specification from a GitHub Issue and its conversation history.

Write a spec in this exact markdown template — keep every heading, fill in the content:

## Specification

### Goals
- <one bullet per main goal>

### Non-goals
- <explicit things this work will NOT do, or "None" if not applicable>

### Functional requirements
- FR1: <requirement>
- FR2: …

### Non-functional requirements
- NFR1: <performance / security / accessibility / etc., or "None">

### Assumptions
- A1: <assumption made in lieu of explicit clarification, or "None">

### Acceptance criteria
- AC1: <testable acceptance criterion>
- AC2: …

Rules:
- Every section must be present and non-empty (use "None" for truly empty ones).
- Be concrete; avoid vague language like "good performance" — quantify where possible.
- If you discover a high-impact ambiguity that blocks you, do NOT write a partial spec. Return status "needs_human" with your questions.
- Output ONLY the structured JSON, no surrounding prose.`;

function buildPrompt(ctx: AgentContext): string {
  const existingSpec = readSection(ctx.issue.body, 'SPEC');
  const lines: string[] = [
    `# Issue #${ctx.issue.number}: ${ctx.issue.title}`,
    '',
    '## Issue body (human-authored)',
    ctx.issue.body || '(empty)',
    '',
  ];

  if (existingSpec) {
    lines.push('## Existing SPEC section (update / refine this)', existingSpec, '');
  }

  if (ctx.comments.length > 0) {
    lines.push('## Human comments (Kanbei comments already removed)');
    for (const c of ctx.comments) {
      lines.push(`**${c.user.login}**: ${c.body}`, '');
    }
  }

  lines.push(
    '---',
    'Produce the structured spec (or ask clarifying questions) as JSON.',
  );

  return lines.join('\n');
}

interface SpecOutput {
  status: AgentResult['status'];
  nextPhase?: string;
  summary: string;
  specMarkdown?: string;
  questions?: string[];
}

export async function runSpec(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.spec.model || DEFAULT_MODEL;

  let result: { output: SpecOutput; tokensUsed: number };

  try {
    result = await anthropicQuery<SpecOutput>({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(ctx),
      toolName: 'spec_output',
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
          specMarkdown: { type: 'string' },
          questions: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    });
  } catch (err) {
    return {
      status: 'error',
      summary: `Spec API error: ${String(err)}`,
    };
  }

  const { output, tokensUsed } = result;
  const status = output.status ?? 'error';

  if (status === 'needs_human') {
    const questions = output.questions;
    if (questions && questions.length > 0) {
      const commentBody = wrapComment(
        'spec',
        `I need clarification before writing the spec:\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      );
      await ctx.repo.addComment(ctx.issue.number, commentBody);
    }
    return { status: 'needs_human', summary: output.summary ?? '', questions, tokensUsed };
  }

  if (status === 'ready_for_next_phase') {
    if (!output.specMarkdown) {
      return { status: 'error', summary: 'Spec: ready_for_next_phase returned without specMarkdown' };
    }
    const updatedBody = upsertSection(ctx.issue.body, 'SPEC', output.specMarkdown);
    await ctx.repo.updateIssue(ctx.issue.number, { body: updatedBody });
    return {
      status: 'ready_for_next_phase',
      nextPhase: 'arch',
      summary: output.summary ?? 'Spec complete.',
      tokensUsed,
    };
  }

  return { status, summary: output.summary ?? '', tokensUsed };
}
