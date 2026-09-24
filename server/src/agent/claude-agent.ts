import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { createAttachmentMcpServer, SAVE_ATTACHMENT_TOOL_ID } from './attachment-tool.js';
import { buildSystemPrompt, buildUserPrompt, NAMING_PROMPT, sanitizeNodeName } from './prompt.js';
import type { Agent, AgentEvent, AskInput, NameInput } from './types.js';

export const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
export const DENIED_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit'];

/** SDK options shared by every call: isolated from user settings, MCP servers and session files. */
const baseOptions: Options = {
  settingSources: [],
  persistSession: false,
  permissionMode: 'dontAsk',
  mcpServers: {},
  strictMcpConfig: true,
  env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
};

export function buildAskOptions(
  input: Pick<AskInput, 'treeDir' | 'instructions' | 'model' | 'staging'>,
  abortController: AbortController,
): Options {
  return {
    ...baseOptions,
    mcpServers: { otago: createAttachmentMcpServer(input.staging) },
    cwd: input.treeDir,
    model: input.model,
    systemPrompt: buildSystemPrompt(input.instructions),
    tools: ALLOWED_TOOLS,
    allowedTools: [...ALLOWED_TOOLS, SAVE_ATTACHMENT_TOOL_ID],
    disallowedTools: DENIED_TOOLS,
    includePartialMessages: true,
    abortController,
  };
}

/** Agent backed by the Claude Agent SDK; the model is chosen per call. */
export function createClaudeAgent(): Agent {
  return {
    async *ask(input: AskInput): AsyncGenerator<AgentEvent> {
      const abortController = linkedAbortController(input.signal);
      const run = query({
        prompt: buildUserPrompt(input.chain, input.question),
        options: buildAskOptions(input, abortController),
      });
      let text = '';
      let separatorPending = false;
      let finalResult: string | undefined;
      try {
        for await (const message of run) {
          if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
            const event = message.event;
            // Text blocks from separate assistant turns (before/after tool calls) are joined by a blank line.
            if (event.type === 'content_block_start' && event.content_block.type === 'text') {
              separatorPending = text.length > 0;
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              const chunk = (separatorPending ? '\n\n' : '') + event.delta.text;
              separatorPending = false;
              text += chunk;
              yield { type: 'chunk', text: chunk };
            }
          } else if (message.type === 'result') {
            if (message.subtype !== 'success' || message.is_error) {
              const details = 'errors' in message ? message.errors.join('; ') : '';
              throw new Error(`Agent failed (${message.subtype})${details ? `: ${details}` : ''}`);
            }
            finalResult = message.result;
          }
        }
      } finally {
        abortController.abort();
      }
      if (input.signal.aborted) throw new Error('Aborted');
      if (!text.trim() && finalResult) {
        text = finalResult;
        yield { type: 'chunk', text };
      }
      if (!text.trim()) throw new Error('Agent returned an empty answer');
      yield { type: 'done', text: text.trim(), model: input.model };
    },

    async name({ question, model, signal }: NameInput): Promise<string> {
      const abortController = linkedAbortController(signal);
      const run = query({
        prompt: `${NAMING_PROMPT}\n\nQuestion:\n${question.slice(0, 2000)}`,
        options: {
          ...baseOptions,
          model,
          systemPrompt: 'You produce short kebab-case folder names.',
          tools: [],
          maxTurns: 1,
          abortController,
        },
      });
      try {
        for await (const message of run) {
          if (message.type === 'result') {
            if (message.subtype !== 'success' || message.is_error) {
              throw new Error(`Naming failed (${message.subtype})`);
            }
            return sanitizeNodeName(message.result);
          }
        }
      } finally {
        abortController.abort();
      }
      throw new Error('Naming returned no result');
    },
  };
}

function linkedAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
