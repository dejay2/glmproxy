/**
 * Anthropic Request Preparer
 *
 * Prepares requests for Z.ai's native Anthropic-compatible endpoint.
 * This is a lightweight transformer that does NOT convert formats (already Anthropic format),
 * only:
 * - Injects reasoning prompt to force step-by-step thinking
 * - Injects internal tools in Anthropic format
 * - Selects model based on image content
 */

import config from '../config.js';
import { selectModel } from '../routing/model-router.js';
import { getInjectedToolsAnthropic, getTriggeredMcpToolsForInjectionAnthropic } from '../tools/definitions.js';
import { hasWebSearchTrigger } from '../tools/triggers.js';
import logger from '../utils/logger.js';

/**
 * The reasoning prompt to inject before the last user message
 * Short and punchy to cut through large system prompts
 */
const REASONING_PROMPT = `ultrathink really hard

Think step-by-step in <reasoning_content> tags before answering.`;

/**
 * Inject reasoning prompt into Anthropic format messages.
 * Inserts a user message with the reasoning prompt before the last user message.
 *
 * @param {Array} messages - Anthropic format messages array
 * @returns {Array} Messages with reasoning prompt injected
 */
function injectReasoningPromptAnthropic(messages) {
  if (!messages || messages.length === 0) {
    return messages;
  }

  const result = [...messages];

  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx >= 0) {
    // Create a reasoning prompt message in Anthropic format
    const reasoningMessage = {
      role: 'user',
      content: [{ type: 'text', text: REASONING_PROMPT }],
    };

    // We need to add a fake assistant response after the reasoning prompt
    // to maintain the alternating user/assistant pattern required by Anthropic API
    const assistantAck = {
      role: 'assistant',
      content: [{ type: 'text', text: 'I understand. I will think step by step and show my reasoning in <reasoning_content> tags before providing my final answer.' }],
    };

    // Insert before last user message
    result.splice(lastUserIdx, 0, reasoningMessage, assistantAck);
    logger.debug('anthropic-request', 'Injected reasoning prompt before last user message', {
      insertIndex: lastUserIdx,
      totalMessages: result.length,
    });
  }

  return result;
}

/**
 * Prepare an Anthropic request for Z.ai's Anthropic-compatible endpoint.
 * Does NOT transform the format, just prepares it with reasoning prompt and tools.
 *
 * @param {Object} anthropicRequest - Original Anthropic format request
 * @returns {Promise<Object>} Prepared request for Z.ai Anthropic endpoint
 */
export async function prepareAnthropicRequest(anthropicRequest) {
  const {
    model,
    max_tokens,
    system,
    messages,
    temperature,
    top_p,
    stop_sequences,
    tools: clientTools,
    stream,
  } = anthropicRequest;

  logger.debug('anthropic-request', 'Preparing request for Anthropic endpoint');

  // Log the last message content for debugging media detection
  const lastMessage = messages?.length > 0 ? [messages[messages.length - 1]] : [];
  if (lastMessage.length > 0) {
    const lastContent = lastMessage[0].content;
    const contentTypes = Array.isArray(lastContent)
      ? lastContent.map(b => b.type)
      : [typeof lastContent];
    logger.debug('anthropic-request', 'Last message content types', { contentTypes });
  }

  // Detect if CURRENT message contains images/videos for model selection
  // Previous media in conversation history don't require vision model
  const { model: selectedModel, hasImages } = selectModel(lastMessage);

  // Web search tools - only inject if config enabled AND user triggered by keywords
  // This prevents GLM from spontaneously searching on every request
  // Claude Code's WebSearch/WebFetch calls are intercepted separately in anthropic-executor.js
  const configEnabled = config.webSearch?.enabled || false;
  const userTriggered = configEnabled && hasWebSearchTrigger(messages);
  const webSearchEnabled = userTriggered;

  // Build tools array - combine injected tools with client tools (only if user triggered)
  const injectedTools = webSearchEnabled ? getInjectedToolsAnthropic() : [];
  const tools = [...injectedTools];

  // Add client tools (already in Anthropic format)
  // Only filter duplicates when we're injecting our tools (avoid having both web_search and WebSearch)
  // Note: Claude's WebSearch/WebFetch are intercepted at execution time, not filtered here
  const duplicateToolNames = webSearchEnabled
    ? ['WebSearch', 'websearch', 'web_search', 'WebFetch', 'webfetch', 'web_reader']
    : [];
  if (clientTools && Array.isArray(clientTools)) {
    for (const tool of clientTools) {
      // Skip duplicates when we're injecting our own tools
      if (duplicateToolNames.includes(tool.name)) {
        logger.debug('anthropic-request', `Filtering duplicate tool ${tool.name} (using injected web_search)`);
        continue;
      }
      tools.push(tool);
    }
  }

  const actualClientCount = tools.length - injectedTools.length;

  // Inject triggered MCP tools (lazy initialization)
  const { tools: mcpTools, mcpIds } = await getTriggeredMcpToolsForInjectionAnthropic(messages);
  tools.push(...mcpTools);

  // Inject reasoning prompt if forceReasoning is enabled
  const forceReasoning = config.reasoning?.forceReasoning ?? true;
  let preparedMessages = forceReasoning
    ? injectReasoningPromptAnthropic(messages || [])
    : [...(messages || [])];

  // Inject MCP tool instructions if MCP tools are triggered
  if (mcpTools.length > 0) {
    // Find the last user message index in prepared messages
    let lastUserIdx = -1;
    for (let i = preparedMessages.length - 1; i >= 0; i--) {
      if (preparedMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      const toolNames = mcpTools.map(t => t.name).slice(0, 10).join(', ');
      const mcpInstruction = {
        role: 'user',
        content: [{ type: 'text', text: `You have access to MCP tools including: ${toolNames}. Use them to complete the task - call the appropriate tool using tool_use blocks.` }],
      };
      const mcpAck = {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will use the available MCP tools to complete this task.' }],
      };
      // Insert before the last user message (similar to reasoning injection)
      preparedMessages.splice(lastUserIdx, 0, mcpInstruction, mcpAck);
      logger.debug('anthropic-request', 'Injected MCP tool instruction before last user message', {
        insertIndex: lastUserIdx,
        toolNames,
        totalMessages: preparedMessages.length,
      });
    }
  }

  logger.info('anthropic-request', 'Request preparation summary', {
    selectedModel,
    hasImages,
    reasoningInjected: forceReasoning,
    webSearchConfigEnabled: configEnabled,
    webSearchUserTriggered: userTriggered,
    webSearchEnabled,
    injectedToolCount: injectedTools.length,
    mcpToolCount: mcpTools.length,
    mcpIds: mcpIds.length > 0 ? mcpIds : undefined,
    clientToolCount: actualClientCount,
    totalTools: tools.length,
  });

  // Build the prepared request
  const preparedRequest = {
    model: selectedModel,
    messages: preparedMessages,
    max_tokens: max_tokens || 8192,
  };

  // Add system prompt if present
  if (system) {
    preparedRequest.system = system;
  }

  // Add tools if any
  if (tools.length > 0) {
    preparedRequest.tools = tools;

    // Force tool usage when MCP tools are injected
    if (mcpTools.length > 0) {
      preparedRequest.tool_choice = { type: 'any' };
    }
  }

  // Add optional parameters
  if (temperature !== undefined) {
    preparedRequest.temperature = temperature;
  }

  if (top_p !== undefined) {
    preparedRequest.top_p = top_p;
  }

  if (stop_sequences && stop_sequences.length > 0) {
    preparedRequest.stop_sequences = stop_sequences;
  }

  // Preserve stream flag
  if (stream !== undefined) {
    preparedRequest.stream = stream;
  }

  logger.debug('anthropic-request', 'Prepared request', {
    model: preparedRequest.model,
    messageCount: preparedRequest.messages.length,
    toolCount: preparedRequest.tools?.length || 0,
    maxTokens: preparedRequest.max_tokens,
  });

  // Build injection metadata for traffic monitoring
  const injections = [];

  if (forceReasoning) {
    injections.push({
      type: 'reasoning_prompt',
      description: 'Reasoning prompt injected before last user message',
      content: REASONING_PROMPT,
    });
    injections.push({
      type: 'assistant_acknowledgment',
      description: 'Fake assistant acknowledgment to maintain alternating pattern',
      content: 'I understand. I will think step by step and show my reasoning in <reasoning_content> tags before providing my final answer.',
    });
  }

  if (injectedTools.length > 0) {
    injections.push({
      type: 'tools',
      description: `Injected ${injectedTools.length} web search tools`,
      trigger: 'keyword',
      tools: injectedTools.map(t => t.name),
    });
  }

  if (mcpTools.length > 0) {
    injections.push({
      type: 'mcp_tools',
      description: `Injected ${mcpTools.length} tools from MCPs: ${mcpIds.join(', ')}`,
      mcpIds,
      tools: mcpTools.map(t => t.name),
    });
  }

  return {
    request: preparedRequest,
    injections,
  };
}

export default prepareAnthropicRequest;
