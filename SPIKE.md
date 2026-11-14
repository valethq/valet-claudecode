# Spike: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.323, claude 2.1.323)

Measured on this host, logged in with `claude.ai` auth (subscription). Results that shaped the plugin:

- **Streaming input works as a long-lived session.** `query({ prompt: <AsyncIterable of SDKUserMessage>, options })` keeps one child up; each turn ends with a `result` message. A second turn on the same Query recalled the first.
- **Early exit from `for await` kills the Query.** Returning from the loop calls `return()` on the generator and the second turn silently produced nothing. The plugin uses `q.next()`.
- **Streaming events.** With `includePartialMessages`, `stream_event` carries `message_start` (the message id), `content_block_delta` with `text_delta` / `thinking_delta` / `input_json_delta`. The complete `assistant` message follows, one per content block, all with the same `message.id`, so the plugin dedupes text by message id. `tool_use` comes from the `assistant` message (full input); `tool_result` comes from the following `user` message. Subagent messages have `parent_tool_use_id` set and are ignored.
- **Cache fields.** `usage.cache_creation.ephemeral_1h_input_tokens` was non-zero and `ephemeral_5m_input_tokens` zero on every turn: SDK turns get 1h writes with no configuration. A brand-new session already read ~24k tokens from cache (the shared Claude Code prefix, written by other sessions). Context size = `input_tokens + cache_read + cache_creation` of the last assistant message.
- **Resume.** `sessionId` pins a new session's UUID, so `resumeId` is known at `open()`. `getSessionInfo(id, { dir: cwd })` tells whether the transcript exists; if it doesn't, the plugin starts a new session and reports it as reseeded.
- **Permissions.** In `default` mode `canUseTool` was not consulted for `echo hi` (read-only commands are pre-approved), so `denyTools` (`disallowedTools`) is the reliable way to remove a tool. `canUseTool` allows the rest.
- **Compaction.** Reported as a `system` / `compact_boundary` message with `pre_tokens` and `post_tokens`.

## Open items

- **valet MCP tools.** `valet-agent` passes `mcpServers: []` today, and the per-run MCP route is not built. When it is, the endpoint can use a session-scoped credential. A changed tool list no longer forces a restart: `Query.setMcpServers` adds servers mid-session as an append-only `tool_addition` system message (measured on Haiku 5.5, 2.1.323, 0.3.323: cache mostly kept). Removal is unmeasured.
- **Steering off built-in Bash.** Use `denyTools: ["Bash"]` once `valet-exec` is served over MCP, so long jobs survive restarts. `toolAliases: { Bash: "mcp__valet__exec" }` also works (a model that emits `Bash` gets the MCP tool run); the MCP tool must accept Bash's input shape.
- **Measured on 2.1.323.** `tools: []` removes every built-in. A `PreToolUse` hook that throws lets the tool run unless the matcher sets `onFailure: "block"`. Subagent tool calls hit `PreToolUse` with `agent_id` set. `disallowedTools: ["Agent"]` and `["Task"]` both remove the Agent tool. A custom `systemPrompt` is still wrapped by the binary: a billing-header block and "You are a Claude agent, built on Anthropic's Claude Agent SDK." come first, and an Environment block and a user-email reminder are injected into the messages.
- **Subagents.** Claude Code's own subagents are the 5m bucket. `subagentPromptCacheTtl` is available if that matters.
