# GLM Enhanced Proxy

HTTP proxy server that transforms [Anthropic Messages API](https://docs.anthropic.com/claude/reference/messages) requests to [Z.ai GLM-4.7 API](https://api.z.ai) format, enabling Claude-compatible tools and applications to use GLM models.

## Why GLMProxy?

### The Problem with GLM-4.7

GLM-4.7 is a powerful model, but it has limitations when used directly:

| Limitation | Impact |
|------------|--------|
| **No web search** | Can't access current information or search the web |
| **No reasoning mode** | Lacks step-by-step thinking like Claude's extended thinking |
| **Manual model switching** | Developers must manually route between text/vision models |
| **Limited tool ecosystem** | Official docs state "does not support custom tools" |
| **Complex integration** | Each AI tool needs custom GLM API integration |

### How GLMProxy Solves These

| Problem | Solution |
|---------|----------|
| No web search | MCP `web_search`/`web_reader` injection; intercepts Claude Code's native WebSearch/WebFetch |
| No reasoning | Automatic reasoning prompt injection with `<reasoning_content>` parsing to thinking blocks |
| Manual model switching | Auto-detects images/video in current message → routes to glm-4.6v, switches back to glm-4.7 for text |
| Limited tools | Dynamic MCP registry - add Playwright, Context7, or any MCP server via dashboard |
| Complex integration | Drop-in Anthropic API compatibility - works with any tool that supports custom base URLs |

### Real Benefits

- **Claude Code users**: Get web search without an Anthropic subscription
- **Vision tasks**: Automatic model switching - no manual configuration
- **Reasoning**: Step-by-step thinking blocks for complex problems
- **Extensible**: Add your own MCP servers for specialized tools
- **Zero code changes**: Point your tools at `http://127.0.0.1:4567` and go

## Features

- **Web Dashboard**: Settings panel and MCP management (vanilla JS, no dependencies)
- **Smart Backend Routing**: Automatically routes text requests via Anthropic endpoint and vision requests via OpenAI endpoint for optimal results
- **API Translation**: Transparent conversion between Anthropic Messages API and OpenAI-compatible GLM API
- **Intelligent Model Selection**: Automatic selection of text (glm-4.7) or vision (glm-4.6v) models based on current message content
- **Video Analysis**: Full video support with automatic file path detection - just mention a video file and it's analyzed
- **Reasoning Injection**: Automatic reasoning prompt injection for step-by-step thinking with `<reasoning_content>` tag parsing
- **Tool Execution**: Internal tool loop for web_search and web_reader via Z.ai MCP servers, plus automatic interception of Claude Code's native WebSearch/WebFetch tools
- **Client Tools**: Pass-through support for client-defined tools
- **Streaming**: Full SSE streaming support for both backend paths
- **Production Ready**: Structured logging, error handling, graceful shutdown

## Quick Start

### Prerequisites

- Node.js 18.0.0 or later
- Z.ai API key (get one at https://z.ai)
- Claude Code CLI (optional, for `ccglm` command)

### Installation

```bash
# Clone and install
git clone <repository-url>
cd glmproxy
npm install

# Install globally for ccglm command
npm install -g .
```

### Configuration

#### Setting Up API Keys

API keys are configured via a `.env` file in the project root. This file is automatically loaded on startup.

**Create your .env file:**

```bash
# Copy the example file
cp .env.example .env

# Edit with your API key
nano .env  # or use your preferred editor
```

**Required keys:**

| Variable | Description |
|----------|-------------|
| `ZAI_API_KEY` | Your Z.ai API key (required) - get one at https://z.ai |

**Optional keys for MCP servers:**

| Variable | Description |
|----------|-------------|
| `REF_API_KEY` | API key for Ref Tools MCP (documentation search) |
| `CONTEXT7_API_KEY` | API key for Context7 MCP (library docs lookup) |

**Security best practices:**

1. **Never commit `.env` to git** - It is already in `.gitignore`
2. **Never share API keys** - Treat them like passwords
3. **Use environment variables in CI/CD** - Don't store keys in code or config files
4. **Rotate keys periodically** - Regenerate if you suspect exposure
5. **Dashboard API key entry** - Keys entered via the web UI are saved to `.env` automatically

If you don't have a `.env.example` file, create `.env` manually:

```bash
# .env
ZAI_API_KEY=your_api_key_here

# Optional: Server configuration
# PORT=4567
# HOST=127.0.0.1
# LOG_LEVEL=info
```

Alternatively, set the environment variable directly in your shell:

```bash
export ZAI_API_KEY="your-api-key-here"
```

### Running with CLI (Recommended)

The easiest way to use the proxy:

```bash
# Start proxy and launch Claude Code in one command
ccglm

# Skip permission prompts (use with caution)
ccglm yolo

# Open the web dashboard to configure settings
ccglm ui

# Check proxy status
ccglm status
```

### Running Manually

```bash
# Start proxy server
npm start

# Development (with auto-reload)
npm run dev
```

The proxy will start on `http://127.0.0.1:4567` by default.

### Access the Dashboard

Open your browser and navigate to:

```
http://127.0.0.1:4567/
```

You'll see the settings dashboard where you can:
1. Configure your Z.ai API key in the Settings panel
2. Select endpoint mode (Anthropic, OpenAI, BigModel)
3. Toggle features like web search, reasoning, and streaming
4. Manage custom MCP servers

### Test the connection

```bash
# Health check
curl http://127.0.0.1:4567/health

# Simple request
curl -X POST http://127.0.0.1:4567/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, what model are you?"}
    ]
  }'
```

## Configuration Options

All configuration is done via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ZAI_API_KEY` | (required) | Your Z.ai API key |
| `PORT` | `4567` | Server port |
| `HOST` | `127.0.0.1` | Server host |
| `LOG_LEVEL` | `info` | Logging level: debug, info, warn, error |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4/chat/completions` | GLM API endpoint (OpenAI path) |
| `ZAI_ANTHROPIC_URL` | `https://api.z.ai/api/anthropic/v1/messages` | GLM API endpoint (Anthropic path) |
| `STREAMING_ENABLED` | `false` | Enable SSE streaming for responses |
| `STREAMING_CHUNK_SIZE` | `20` | Characters per streaming chunk |
| `STREAMING_CHUNK_DELAY` | `0` | Delay between chunks (ms) |
| `USE_ANTHROPIC_ENDPOINT` | `true` | Use native Anthropic-compatible endpoint for text requests |
| `WEB_SEARCH_ENABLED` | `true` | Enable web_search/web_reader tools and Claude Code tool interception |

## CLI Reference

The `ccglm` command provides a convenient way to use the proxy:

| Command | Description |
|---------|-------------|
| `ccglm` | Start proxy and launch Claude Code |
| `ccglm yolo` | Same as above, with `--dangerously-skip-permissions` |
| `ccglm ui` | Open the web dashboard in browser |
| `ccglm start` | Start proxy server in foreground |
| `ccglm stop` | Stop background proxy server |
| `ccglm status` | Check if proxy is running |
| `ccglm activate` | Print shell exports for manual use |
| `ccglm help` | Show help message |

### What ccglm does

When you run `ccglm`, it:
1. Starts the proxy server in the background (if not already running)
2. Sets environment variables to route Claude Code through the proxy:
   - `ANTHROPIC_BASE_URL` → proxy URL
   - `ANTHROPIC_AUTH_TOKEN` → dummy token (proxy uses your ZAI_API_KEY)
   - `ANTHROPIC_DEFAULT_*_MODEL` → `glm-4.7` for all model tiers
3. Launches Claude Code

Use `ccglm yolo` to skip permission prompts.

### Examples

```bash
# Start proxy + Claude Code
ccglm

# Skip permission prompts (use with caution)
ccglm yolo

# Open settings UI to configure API key and features
ccglm ui

# Use with shell activation (for advanced users)
eval $(ccglm activate)
claude
```

## Usage with AI Tools

### Claude Code

The easiest way (using ccglm):

```bash
ccglm
```

Or configure manually:

```bash
# In your shell config (.bashrc, .zshrc, etc.)
export ANTHROPIC_BASE_URL="http://127.0.0.1:4567"
```

Or in the Claude Code settings, set the API base URL to `http://127.0.0.1:4567`.

### Other AI Coding Tools

Any tool that supports the Anthropic Messages API with a custom base URL can use this proxy. Simply configure:

- **Base URL**: `http://127.0.0.1:4567`
- **API Key**: Any value (the proxy uses your configured ZAI_API_KEY)

## API Reference

### POST /v1/messages

Anthropic Messages API compatible endpoint.

**Request:**
```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "system": "You are a helpful assistant.",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "tools": [...],
  "stream": false
}
```

**Response:**
```json
{
  "id": "msg_1245677890_abc123",
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help you?"}
  ],
  "model": "glm-4.7",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 8
  }
}
```

### GET /health

Health check endpoint with status and configuration.

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 12345,
  "config": {
    "toolsEnabled": true,
    "streamingEnabled": false,
    "models": ["glm-4.7", "glm-4.6v"]
  },
  "validation": {
    "isValid": true,
    "errors": []
  }
}
```

### GET /config

Detailed configuration endpoint (for debugging).

**Response:**
```json
{
  "port": 4567,
  "host": "127.0.0.1",
  "apiKeyConfigured": true,
  "models": {
    "text": "glm-4.7",
    "vision": "glm-4.6v"
  },
  "toolExecution": {
    "maxIterations": 5,
    "timeout": 30000
  }
}
```

### POST /config

Update runtime configuration. Changes apply to all clients (Claude Code, Cline, dashboard, etc.).

**Request:**
```json
{
  "streaming": false,
  "webSearch": true,
  "apiKey": "your-api-key",
  "endpoint": "anthropic"
}
```

**Response:**
```json
{
  "success": true,
  "config": {
    "streaming": false,
    "webSearch": true,
    "apiKeyConfigured": true,
    "endpoint": "anthropic"
  }
}
```

## Backend Endpoints

The proxy supports two backend paths to Z.ai with intelligent routing:

### Automatic Routing (Default)

The proxy automatically selects the best endpoint based on content:

- **Text-only requests** → Anthropic endpoint (glm-4.7) - faster, native format
- **Vision requests** → OpenAI endpoint (glm-4.6v) - full image analysis

This avoids Z.ai's `server_tool_use` interception on the Anthropic endpoint which truncates image analysis results.

### OpenAI-Compatible Path

- Transforms Anthropic Messages API to OpenAI Chat Completions format
- Routes to `https://api.z.ai/api/paas/v4/chat/completions`
- Used automatically for vision requests (glm-4.6v)
- Provides complete, untruncated image analysis

### Anthropic-Compatible Path

- Native passthrough to Z.ai's Anthropic-compatible endpoint
- Routes to `https://api.z.ai/api/anthropic/v1/messages`
- Used for text-only requests when enabled (default)
- Faster with no format conversion overhead

Toggle the Anthropic endpoint:
- Set `USE_ANTHROPIC_ENDPOINT=true/false` environment variable, or
- Use the dashboard Settings panel toggle, or
- POST to `/config` with `{"endpoint": "anthropic"}` or `{"endpoint": "openai"}`

## Features in Detail

### Model Routing

The proxy automatically selects the appropriate GLM model based on the **current message**:

- **glm-4.7**: Used for text-only messages (via Anthropic endpoint)
- **glm-4.6v**: Used when the current message contains images or videos (via OpenAI endpoint)

After processing an image or video, subsequent text-only messages automatically switch back to glm-4.7 for faster responses. Previous media in conversation history don't force the vision model.

Media detection scans for:
- Direct image/video content blocks
- Base64-encoded images and videos
- Tool results containing images (e.g., screenshots)

### Video Analysis

GLM-4.6v supports video analysis with up to ~1 hour of video content (128K context). The proxy makes video analysis seamless:

#### Automatic File Path Detection (Claude Code)

When using Claude Code, simply mention a video file path in your message and the proxy will automatically:
1. Detect the video file reference
2. Read the file from your working directory
3. Convert it to a video content block
4. Route to the vision model for analysis

**Supported patterns:**
```
@video.mp4                    # File in current directory
./path/to/video.mp4           # Relative path
../downloads/clip.webm        # Parent directory
/home/user/videos/movie.mov   # Absolute path
~/Videos/recording.mp4        # Home directory
```

**Example usage in Claude Code:**
```
User: What's happening in @meeting-recording.mp4?
User: Analyze the video at ~/Downloads/demo.mp4
User: Describe /tmp/screen-capture.webm
```

#### Dashboard Upload

In the web dashboard, you can:
- Drag and drop video files directly into the chat
- Use the file picker to select videos
- Paste video file paths

#### Supported Formats

- **MP4** (video/mp4)
- **WebM** (video/webm)
- **MOV** (video/quicktime)
- **MPEG** (video/mpeg)

**Body size limit:** 50MB (supports most short-to-medium videos)

#### API Format

For programmatic use, send videos in Anthropic-like format:

```json
{
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this video?"},
      {
        "type": "video",
        "source": {
          "type": "url",
          "url": "https://example.com/video.mp4"
        }
      }
    ]
  }]
}
```

Or with base64:
```json
{
  "type": "video",
  "source": {
    "type": "base64",
    "media_type": "video/mp4",
    "data": "AAAAIGZ0eXBpc29t..."
  }
}
```

### Reasoning

The proxy automatically injects a reasoning prompt before the last user message to encourage step-by-step thinking. The model's reasoning output is:

1. Captured from `<reasoning_content>` tags in the response
2. Transformed to Anthropic `thinking` blocks

Example response with reasoning:
```json
{
  "content": [
    {"type": "thinking", "thinking": "Let me think about this..."},
    {"type": "text", "text": "The answer is 42."}
  ]
}
```

### Tool Execution

The proxy provides web search capabilities via Z.ai's MCP servers, with two internal tools:

- **web_search**: Search the web using Z.ai's search MCP
- **web_reader**: Read web page content using Z.ai's reader MCP

#### Claude Code Integration

When `WEB_SEARCH_ENABLED=true` (the default), the proxy **automatically intercepts** Claude Code's native `WebSearch` and `WebFetch` tools. This is useful because:

- Claude Code's native web tools require an Anthropic API subscription
- The proxy routes these calls through Z.ai's MCP servers instead
- No changes needed to Claude Code - it works transparently

When Claude Code calls `WebSearch` or `WebFetch`, the proxy:
1. Intercepts the tool call before it reaches the API
2. Executes the equivalent MCP tool (`web_search` or `web_reader`)
3. Returns the result to Claude Code as if the native tool worked

#### Smart Tool Injection

The proxy uses keyword-based triggers to inject `web_search`/`web_reader` tools only when the user explicitly requests web functionality. Trigger phrases include:

- "search the web", "search online", "look up online"
- "latest news", "current news", "recent news"
- "latest docs", "official documentation"
- "what is the latest", "what are the latest"

This prevents unwanted web searches on every request (e.g., during Claude Code startup).

#### Configuration

Toggle in the dashboard settings, or via environment:

```bash
# Disable web search interception (tools passed through to client)
WEB_SEARCH_ENABLED=false ccglm start
```

Client-defined tools are always passed through to the response for client handling.

### Streaming

Both backend paths support full SSE streaming with proper Anthropic event format:

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_stop
data: {"type":"message_stop"}
```

Streaming properly handles:
- Text content blocks
- Reasoning/thinking blocks
- Tool use blocks
- Recursive tool execution loops

## Error Handling

All errors are returned in Anthropic error format:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "messages is required"
  }
}
```

Error types:
- `invalid_request_error` (400): Malformed request
- `authentication_error` (401): Invalid API key
- `rate_limit_error` (429): Rate limit exceeded
- `api_error` (500): Internal server error
- `overloaded_error` (529): API overloaded

## Logging

Structured logging with configurable levels:

```bash
# Enable debug logging
LOG_LEVEL=debug node src/index.js
```

Log format:
```
[2024-01-15T10:30:00.000Z] [INFO] [server] Listening on http://127.0.0.1:4567
[2024-01-15T10:30:05.000Z] [INFO] [request] POST /v1/messages {"messages":3}
[2024-01-15T10:30:05.000Z] [INFO] [routing] Vision request detected in current message, using OpenAI endpoint
[2024-01-15T10:30:06.000Z] [INFO] [tool] web_search completed {"duration":"1234ms","success":true}
[2024-01-15T10:30:07.000Z] [INFO] [response] 200 end_turn {"duration":"2345ms"}
```

## Troubleshooting

### "ZAI_API_KEY environment variable is required"

Set your Z.ai API key:
```bash
export ZAI_API_KEY="your-key-here"
```

### "GLM API error: 401 Unauthorized"

Your API key is invalid or expired. Get a new key from https://z.ai.

### "GLM API error: 429 Too Many Requests"

You've hit the rate limit. Wait and retry, or upgrade your Z.ai plan.

### Requests are slow

GLM-4.7 can take 10-30 seconds for complex requests. For faster responses:
- Use shorter prompts
- Reduce `max_tokens`

### Vision requests show truncated analysis

This should be fixed automatically - the proxy routes vision requests through the OpenAI endpoint which provides complete image analysis. If you still see truncated results, ensure you're using the latest version.

### Model stays on glm-4.6v after image

The proxy now only checks the current message for images. After an image request, subsequent text-only messages will automatically use glm-4.7. You don't need to start a new conversation.

### Debug logging

Enable debug logs to see full request/response details:
```bash
LOG_LEVEL=debug node src/index.js
```

## Security Considerations

**GLM Proxy is designed for localhost development use only.** It is not intended for production deployment or multi-user environments.

### Intended Use

- **Development tool**: For local development and testing with AI coding assistants
- **Single-user localhost**: Runs on `127.0.0.1` by default for local-only access
- **Trusted environment**: Assumes the localhost environment is trusted

### Security Model

This proxy operates under a localhost trust model:

- **No authentication**: The proxy itself has no authentication layer
- **API key storage**: Z.ai API keys are stored in memory (server) and localStorage (browser dashboard)
- **No encryption**: HTTP traffic on localhost is unencrypted (acceptable for local development)
- **No rate limiting**: Relies on upstream Z.ai rate limits

### What NOT to Do

**Do not expose this proxy to the public internet.** Specifically:

- Do not bind to `0.0.0.0` or your public IP in production
- Do not expose port 4567 (or your configured port) through your firewall
- Do not use in shared hosting or multi-tenant environments
- Do not run in production or as a public service

### API Key Handling

The proxy handles API keys as follows:

- **Environment variables**: `ZAI_API_KEY` is read from the environment (recommended for CLI use)
- **Dashboard configuration**: API keys entered in the web UI are stored in browser localStorage
- **Runtime updates**: API keys can be updated via POST `/config` (stored in memory only)
- **Upstream only**: Keys are only sent to Z.ai's API endpoints (never logged or exposed)
- **Not persisted**: Runtime API keys are lost on server restart (use environment variables for persistence)

### Recommended Practices

For safe localhost development:

- Use the default `HOST=127.0.0.1` binding
- Store your `ZAI_API_KEY` in your shell profile or `.env` file (not in version control)
- Use the `ccglm` command which starts the proxy with safe defaults
- Keep your development environment secure (encrypted disk, screen lock, etc.)

### If You Need Production Deployment

If you must deploy this proxy in a production or shared environment, you will need to add:

- Authentication and authorization (e.g., API keys, OAuth)
- HTTPS/TLS encryption
- Rate limiting and DoS protection
- Input validation and sanitization hardening
- Security headers (CSP, HSTS, etc.)
- Audit logging
- Network isolation and firewall rules

**We do not recommend production deployment** as this is a development tool, but if you proceed, you assume full responsibility for security hardening.

## Project Structure

```
glmproxy/
├── src/
│   ├── index.js           # Entry point
│   ├── cli.js             # CLI entry point (ccglm command)
│   ├── server.js          # HTTP server with smart routing
│   ├── config.js          # Configuration with runtime state
│   ├── middleware/
│   │   └── validate.js    # Request validation
│   ├── transformers/
│   │   ├── request.js     # Anthropic -> GLM (with reasoning injection)
│   │   ├── response.js    # GLM -> Anthropic
│   │   ├── messages.js    # Message conversion
│   │   ├── anthropic-request.js  # Request preparer for Anthropic endpoint
│   │   └── anthropic-response.js # Response cleaner for Anthropic endpoint
│   ├── reasoning/
│   │   └── injector.js    # Reasoning prompt injection
│   ├── routing/
│   │   └── model-router.js # Model selection (current message only)
│   ├── tools/
│   │   ├── definitions.js # Tool schemas (web_search, web_reader)
│   │   ├── executor.js    # Tool loop with MCP integration (OpenAI path)
│   │   ├── anthropic-executor.js  # Tool loop for Anthropic path
│   │   └── mcp-client.js  # MCP client
│   ├── streaming/
│   │   ├── sse.js         # SSE streaming support
│   │   ├── glm-stream.js  # Real-time GLM API streaming
│   │   └── anthropic-stream.js  # Anthropic endpoint streaming
│   └── utils/
│       ├── logger.js      # Structured logging
│       ├── errors.js      # Error classes (Anthropic format)
│       └── video-detector.js  # Auto-detect video paths in messages
├── public/
│   ├── index.html         # Dashboard entry point
│   ├── css/
│   │   └── styles.css     # Styles with theme variables
│   └── js/
│       ├── app.js         # Main application orchestrator
│       ├── api.js         # API client
│       ├── settings.js    # Settings panel
│       ├── mcp-manager.js # MCP server management
│       ├── theme.js       # Theme switching
│       └── utils.js       # Utility functions
├── package.json
└── README.md
```

## License

MIT
