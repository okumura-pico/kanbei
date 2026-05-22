// Direct Anthropic API helper for reasoning-only agents (Listener, Spec, Architect).
//
// Uses tool-use forcing to get structured JSON output without the Claude Code
// subprocess overhead that claude-agent-sdk carries even when tools: [] is passed.
// Estimated 30–50% token savings vs. claude-agent-sdk for these agents.

import Anthropic from '@anthropic-ai/sdk';

export interface AnthropicQueryOptions<T> {
  model: string;
  system: string;
  prompt: string;
  /** Tool name used for tool-use forcing. Must be a valid identifier. */
  toolName: string;
  /** JSON Schema for the tool's input_schema — this becomes the structured output shape. */
  schema: Anthropic.Tool['input_schema'];
}

export interface AnthropicQueryResult<T> {
  output: T;
  tokensUsed: number;
}

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export async function anthropicQuery<T>(
  opts: AnthropicQueryOptions<T>,
): Promise<AnthropicQueryResult<T>> {
  const tool: Anthropic.Tool = {
    name: opts.toolName,
    description: 'Return structured output',
    input_schema: opts.schema,
  };

  const response = await client().messages.create({
    model: opts.model,
    max_tokens: 4096,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
    tools: [tool],
    tool_choice: { type: 'tool', name: opts.toolName },
  });

  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUse) {
    throw new Error(`anthropicQuery: no tool_use block in response for tool "${opts.toolName}"`);
  }

  return { output: toolUse.input as T, tokensUsed };
}
