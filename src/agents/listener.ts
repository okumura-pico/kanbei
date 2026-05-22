// Listener agent — see docs/02-agents.md §1.
//
// Reads a GitHub Issue and its human-authored comments, then decides
// whether there is enough information to hand off to the Spec phase.
// Uses @anthropic-ai/sdk directly (no Claude Code subprocess).

import { anthropicQuery } from './anthropicQuery.js';
import type { AgentContext } from '../orchestrator/index.js';
import type { AgentResult } from '../types.js';

const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You are Kanbei's Listener agent. Your sole job is to read a GitHub Issue and its human-authored comments, then decide whether the requirements are clear enough to hand off to the Spec phase.

Decision rules:
- 0 unclear points → status "ready_for_next_phase", nextPhase "spec", concise requirements summary in "summary"
- 1–2 low-impact unclear points → state your assumption in "summary" and proceed (status "ready_for_next_phase", nextPhase "spec")
- 1–2 high-impact unclear points → ask them, status "needs_human", list questions in "questions"
- 3+ unclear points → ask up to 5 (highest priority first), status "needs_human", list in "questions"

Output ONLY the JSON object matching the schema. No prose outside the JSON.`;

function buildPrompt(ctx: AgentContext): string {
  const lines: string[] = [
    `# Issue #${ctx.issue.number}: ${ctx.issue.title}`,
    '',
    '## Body',
    ctx.issue.body || '(empty)',
    '',
  ];

  if (ctx.comments.length > 0) {
    lines.push('## Human comments (Kanbei-authored comments already removed)');
    for (const c of ctx.comments) {
      lines.push(`**${c.user.login}**: ${c.body}`);
      lines.push('');
    }
  }

  lines.push(
    '---',
    'Analyse the issue above and return your decision as structured JSON.',
  );

  return lines.join('\n');
}

interface ListenerOutput {
  status: AgentResult['status'];
  nextPhase?: string;
  summary: string;
  questions?: string[];
}

export async function runListener(ctx: AgentContext): Promise<AgentResult> {
  const model = ctx.config.agents.listener.model || DEFAULT_MODEL;

  let result: { output: ListenerOutput; tokensUsed: number };

  try {
    result = await anthropicQuery<ListenerOutput>({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(ctx),
      toolName: 'listener_output',
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
    });
  } catch (err) {
    return {
      status: 'error',
      summary: `Listener API error: ${String(err)}`,
    };
  }

  const { output, tokensUsed } = result;
  return {
    status: output.status ?? 'error',
    summary: output.summary ?? '',
    nextPhase: output.nextPhase as AgentResult['nextPhase'],
    questions: output.questions,
    tokensUsed,
  };
}
