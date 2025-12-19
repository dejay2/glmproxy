/**
 * Request Transformer: Anthropic Messages API -> OpenAI Chat Completions (GLM)
 */

import config from '../config.js';
import { convertMessageToOpenAI } from './messages.js';
import { selectModel } from '../routing/model-router.js';
import { injectReasoningPrompt, REASONING_PROMPT } from '../reasoning/injector.js';
import { getInjectedTools, getTriggeredMcpToolsForInjection } from '../tools/definitions.js';
import { hasWebSearchTrigger } from '../tools/triggers.js';
import logger from '../utils/logger.js';

/**
 * Transform Anthropic Messages API request to OpenAI Chat Completions format
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Promise<Object>} OpenAI/GLM format request
 */
export async function transformRequest(anthropicRequest) {
  const {
    model,
    max_tokens,
    system,
    messages,
    temperature,
    top_p,
    stop_sequences,
    tools: clientTools,
  } = anthropicRequest;

  logger.debug('Transforming request from Anthropic to GLM format');

  // Build OpenAI messages array
  const openaiMessages = [];

  // Add system message if present (Anthropic uses separate field)
  if (system) {
    openaiMessages.push({
      role: 'system',
      content: typeof system === 'string' ? system : extractSystemText(system),
    });
  }

  // Convert each message
  for (const msg of messages || []) {
    const converted = convertMessageToOpenAI(msg);
    // convertMessageToOpenAI may return an array for tool_result messages
    if (Array.isArray(converted)) {
      openaiMessages.push(...converted);
    } else {
      openaiMessages.push(converted);
    }
  }

  // Select model based on content (detect images in CURRENT message only)
  // Previous images in conversation history don't require vision model
  const lastMessage = messages?.length > 0 ? [messages[messages.length - 1]] : [];
  const { model: selectedModel, hasImages } = selectModel(lastMessage);

  // Web search tools - only inject if config enabled AND user triggered by keywords
  // This prevents GLM from spontaneously searching on every request
  // Claude Code's WebSearch/WebFetch calls are intercepted separately in executor.js
  const configEnabled = config.webSearch?.enabled || false;
  const userTriggered = configEnabled && hasWebSearchTrigger(messages);
  const webSearchEnabled = userTriggered;

  // Build tools array - inject web_search/web_reader only if enabled
  // These are available alongside client tools (Glob, Grep, Read, etc.)
  const hasClientTools = clientTools && clientTools.length > 0;
  const tools = buildToolsArray(clientTools, webSearchEnabled);
  const injectedTools = webSearchEnabled ? getInjectedTools() : [];

  // Inject triggered MCP tools (lazy initialization)
  const { tools: mcpTools, mcpIds } = await getTriggeredMcpToolsForInjection(messages);
  tools.push(...mcpTools);

  // Inject reasoning prompt if forceReasoning is enabled
  // BUT skip reasoning when MCP tools are forced - the reasoning prompt
  // conflicts with forced tool_choice and causes infinite thinking loops
  const forceReasoning = config.reasoning?.forceReasoning ?? true;
  const skipReasoningForMcp = mcpTools.length > 0;
  let messagesWithReasoning = (forceReasoning && !skipReasoningForMcp)
    ? injectReasoningPrompt(openaiMessages)
    : [...openaiMessages];

  // Inject MCP tool instructions if MCP tools are triggered
  if (mcpTools.length > 0) {
    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = messagesWithReasoning.length - 1; i >= 0; i--) {
      if (messagesWithReasoning[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      // List all MCP tools - don't limit, the model needs to see all options
      const toolNames = mcpTools.map(t => t.function.name).join(', ');
      // Guide the model to use the tools but let it choose the right one
      const mcpInstruction = {
        role: 'user',
        content: `For this task, you MUST use one of these MCP tools: ${toolNames}. Do NOT use bash, read, or other tools. Call the appropriate MCP tool immediately.`,
      };
      const mcpAck = {
        role: 'assistant',
        content: 'I will use the appropriate MCP tool now.',
      };
      // Insert before the last user message
      messagesWithReasoning.splice(lastUserIdx, 0, mcpInstruction, mcpAck);
      logger.debug('request', 'Injected MCP tool instruction before last user message', {
        insertIndex: lastUserIdx,
        toolCount: mcpTools.length,
        totalMessages: messagesWithReasoning.length,
      });
    }
  }

  logger.info('Model routing decision', {
    hasImages,
    selectedModel,
    originalModel: model,
    reasoningInjected: forceReasoning && !skipReasoningForMcp,
    reasoningSkippedForMcp: skipReasoningForMcp,
    webSearchConfigEnabled: configEnabled,
    webSearchUserTriggered: userTriggered,
    webSearchEnabled,
    injectedToolCount: injectedTools.length,
    mcpToolCount: mcpTools.length,
    mcpIds: mcpIds.length > 0 ? mcpIds : undefined,
    hasClientTools,
    clientToolCount: clientTools?.length || 0,
  });

  // Build GLM request
  const glmRequest = {
    model: selectedModel,
    messages: messagesWithReasoning,
    temperature: temperature ?? config.defaultTemperature,
    stream: false, // Disable streaming for tool execution loop
  };

  // Add tools if we have any
  if (tools.length > 0) {
    glmRequest.tools = tools;
    // Use 'auto' to let model choose the appropriate tool
    // Don't force a specific tool - the model needs to pick based on user intent
    glmRequest.tool_choice = 'auto';
  }

  // Set max_tokens if provided
  if (max_tokens) {
    glmRequest.max_tokens = max_tokens;
  }

  // Add optional parameters if present
  if (top_p !== undefined) {
    glmRequest.top_p = top_p;
  }

  if (stop_sequences && stop_sequences.length > 0) {
    glmRequest.stop = stop_sequences;
  }

  logger.debug('Transformed request', {
    originalModel: model,
    targetModel: glmRequest.model,
    messageCount: messagesWithReasoning.length,
    hasImages,
    maxTokens: glmRequest.max_tokens,
    toolCount: tools.length,
  });

  // Build injection metadata for traffic monitoring
  const injections = [];

  if (forceReasoning && !skipReasoningForMcp) {
    injections.push({
      type: 'reasoning_prompt',
      description: 'Reasoning prompt injected before last user message',
      content: REASONING_PROMPT,
    });
  }

  if (injectedTools.length > 0) {
    injections.push({
      type: 'tools',
      description: `Injected ${injectedTools.length} web search tools`,
      trigger: 'keyword',
      tools: injectedTools.map(t => t.function.name),
    });
  }

  if (mcpTools.length > 0) {
    injections.push({
      type: 'mcp_tools',
      description: `Injected ${mcpTools.length} tools from MCPs: ${mcpIds.join(', ')}`,
      mcpIds,
      tools: mcpTools.map(t => t.function.name),
    });
  }

  return {
    request: glmRequest,
    injections,
  };
}

/**
 * Build the tools array by combining injected tools with client tools.
 * Client tools are converted from Anthropic format to OpenAI format.
 *
 * Note: We keep Claude Code's WebSearch/WebFetch tools in the array - they are
 * intercepted at execution time in executor.js, not filtered here.
 *
 * @param {Array|undefined} clientTools - Client-provided tools in Anthropic format
 * @param {boolean} webSearchEnabled - Whether to inject web search tools
 * @returns {Array} Combined tools array in OpenAI format
 */
function buildToolsArray(clientTools, webSearchEnabled = false) {
  // Start with our injected tools (web_search, web_reader) only if webSearch is enabled
  const tools = webSearchEnabled ? [...getInjectedTools()] : [];

  // Only filter duplicates when we're injecting our tools (avoid having both web_search and WebSearch)
  const duplicateToolNames = webSearchEnabled
    ? ['WebSearch', 'websearch', 'web_search', 'WebFetch', 'webfetch', 'web_reader']
    : [];

  // Convert and add client tools if present
  if (clientTools && Array.isArray(clientTools)) {
    for (const tool of clientTools) {
      // Skip duplicates when we're injecting our own tools
      if (duplicateToolNames.includes(tool.name)) {
        continue;
      }
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      });
    }
  }

  return tools;
}

/**
 * Extract text from Anthropic system content (can be string or array)
 * @param {string|Array} system - Anthropic system content
 * @returns {string} extracted system text
 */
function extractSystemText(system) {
  if (typeof system === 'string') {
    return system;
  }

  if (Array.isArray(system)) {
    return system
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  return '';
}

export default transformRequest;
