# valet-claudecode

`inference@1` agent provider `claude-code`, built on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

A [valet](https://github.com/valethq/valet-core) plugin and a sibling of `valet-devin`: Claude Code runs the loop and its own tools, and valet mirrors the stream into messages and parts. It authenticates as whoever is logged in to `claude` on the host (a subscription works), so there is no API key in valet.

Imports `@valethq/sdk` only, plus the Agent SDK. The Agent SDK is the one dependency this repo adds; the rest of the repo's rules are unchanged.

## How it works

- One long-lived `claude` child per valet session, driven through the SDK's streaming-input `query()`. Each valet turn pushes one user message and reads until the `result` message.
- `open()` stores the SDK session id as `resumeId`. If that session is on disk (`getSessionInfo`), the next start uses `resume`. If not, a fresh id is used and the session is marked `reseeded` so the caller sends the preamble.
- Idle children are closed after `idleCloseMs` (default 15 min) and resumed by the next prompt. Resume rebuilds the same prompt prefix, so it doesn't cost cache.
- `setModel("claude-opus-5-5-high")` splits a trailing effort word: model via `Query.setModel`, effort via `applyFlagSettings`. Nothing is sent when the value didn't change. `listModels` offers those `-<effort>` ids in the picker for each model's `efforts`.
- Abort calls `Query.interrupt()`; the child stays up for the next turn.

## Tool gating

Every built-in tool call goes through a `PreToolUse` hook that runs valet's `tool.call` gate first: a policy plugin can deny it, or rewrite its input. Valet's own MCP tools (`mcp__valet__*`) skip the hook, because `ToolSurface.call` already gates them. Subagent tool calls go through the same hook (the hook input carries `agent_id` and `agent_type`).

What the plugin does with the SDK's tool controls, all checked on Claude Code 2.1.323 with Haiku 5.5:

- **The gate fails closed.** The hook is registered with `onFailure: "block"`. With the SDK default (`"continue"`) a hook that throws or times out lets the tool run anyway.
- **`denyTools` is verified.** `disallowedTools` removes a tool from the model's context. The child's `system/init` message lists the tools it offers, and a session whose init still lists a denied name (`Agent` and `Task` count as the same tool) is closed and the turn fails with `denied tools are still available`. Rule patterns like `Bash(rm *)` can't be checked by name and are skipped.
- **`tools`** sets the base set of built-ins. `[]` removes every built-in, including Agent and ToolSearch, and leaves valet's MCP tools.
- **`hideBuiltinTools`** (also a settings-panel toggle, default off) is the "valet's tools only" switch: it sends `tools: []` and wins over `tools`. `disableClaudeAiConnectors` and `strictMcpConfig` do not do this. They only hide claude.ai connectors and other MCP servers, and Claude Code's built-in tools (Bash, Read, Write, Edit, Agent, Skill, ToolSearch, ...) stay visible with both on. The `claude_code` system prompt still describes those tools, so a model with none may mention them as instructions it can't act on.
- **`toolAliases`** redirects a built-in the model emits to another tool, e.g. `{ "Bash": "mcp__valet__exec" }`. The target must accept the built-in's input shape: Claude Code sends `command`, `description` and so on, and an MCP tool with a stricter schema drops the extras. Aliases don't remove the built-in from the prompt; pair them with `denyTools`.
- **Valet's tools load up front.** The MCP server is passed with `alwaysLoad: true`, so its tools are in the prompt from turn one. Claude Code's default is to defer MCP tools behind ToolSearch, which makes the model search before it can use them. `deferValetTools: true` restores the default.

## Plan usage

The `valet-claudecode` settings panel shows your plan's limits (session, weekly, and per-model weekly) as meters, with a marker for where an even burn-down would be by now and an "On pace / Under pace / Over pace" label. The numbers come from the SDK's `usage()` call, read through a short-lived idle `claude` child (about half a second, no model turn), cached for a minute and re-read at most every 5 minutes after a failure. "Refresh now" forces a read, at most once per 10 seconds. API-key logins have no plan limits and the panel says so.

The SDK method is marked experimental (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`), so `src/usage.ts` parses the reply defensively and falls back to the fixed 5-hour and 7-day windows if the server's `limits[]` rows are missing.

## Prompt cache rules (read before changing the session code)

These come from measuring the SDK on this host and from [t3code#22841](https://github.com/pingdotgg/t3code/pull/22841).

1. **Keep one Query per session.** Agent SDK turns are "main conversation" requests, which get the 1h TTL on a subscription. A new `query()` per turn restarts the process for nothing.
2. **Never `for await` a Query across turns.** Leaving the loop (a `return`, `break` or thrown error) calls the iterator's `return()` and closes the child. The session drives it with `q.next()` instead.
3. **Freeze the prefix.** The system prompt is `claude_code` + the static `appendSystemPrompt`, with `excludeDynamicSections: true` (cwd, date and git status move out of the system prompt, so sessions can share cache) and `snapshot: true` (the prompt is recorded once and reused on every resume). Persona and per-turn context go in the user message as `preamble`, never in `appendSystemPrompt`.
4. **Freeze the tool set.** The MCP server (valet's tools, served by this plugin through the SDK's `toolEndpoint`) is fixed at start and sorted by name. Adding a server mid-session with `Query.setMcpServers` is cheap: Claude Code appends the new tools as a mid-conversation `system` message (`tool_addition` blocks) and leaves the `tools` array alone, so most of the cache is still read (measured on Haiku 5.5: 11.8k of 15.3k tokens read, only the tail rewritten). Removing a server was not measured; treat it as a prefix change.
5. **Don't flip the model or effort casually.** The cache is per model. `setModel` is a no-op when nothing changed.
6. **Load settings deterministically.** `settingSources` defaults to `["project", "local"]` so user-level hooks and MCP config can't change the prefix between runs.
7. **TTL is opt-in.** `promptCacheTtl` / `subagentPromptCacheTtl` set `CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for the child, and only when set. An explicit variable in valet's own environment wins. Left unset, Anthropic's default applies. The t3code data shows the right TTL depends on the workload (1h wins for chatty long loops; 5m wins when gaps are short and the sessions are one-shot), so measure before forcing either.
8. **Measure.** Every turn logs `claude code turn` with `cache: { input, output, read, write5m, write1h, hitRatio }`.

## Config (`plugins.valet-claudecode.config`)

| Key                                        | Meaning                                                                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissionMode`                           | `default` / `acceptEdits` (default) / `plan` / `bypassPermissions`. Also a settings panel (`valet-claudecode`) that overrides it.                                                                         |
| `denyTools`                                | Hard-denied tools (`disallowedTools`), e.g. `["Bash"]` to steer to `valet-exec` over MCP. A child that still lists one is closed (see Tool gating).                                                       |
| `hideBuiltinTools`                         | Default `false`. `true` removes every built-in tool so only valet's MCP tools are offered; also a settings-panel toggle that wins over config.                                                            |
| `tools`                                    | Base set of built-in tools; `[]` removes them all. Unset keeps Claude Code's defaults.                                                                                                                    |
| `toolAliases`                              | Redirect a built-in the model emits to another tool, e.g. `{ "Bash": "mcp__valet__exec" }`.                                                                                                               |
| `deferValetTools`                          | Default `false`: valet's MCP tools are loaded into the prompt. `true` defers them behind ToolSearch.                                                                                                      |
| `disableClaudeAiConnectors`                | Default `true`: hides claude.ai account connectors (Gmail, GitHub, ...) from sessions. Valet's tools only. Also in the settings panel (`GET /plugins/valet-ui/settings`); a panel value wins over config. |
| `strictMcpConfig`                          | Default `true`: loads only the MCP servers valet passes, ignoring project `.mcp.json`, user settings and plugins. Also in the settings panel.                                                             |
| `appendSystemPrompt`                       | Static text appended to the system prompt.                                                                                                                                                                |
| `settingSources`                           | Default `["project", "local"]`.                                                                                                                                                                           |
| `promptCacheTtl`, `subagentPromptCacheTtl` | `"5m"` or `"1h"`; unset means default.                                                                                                                                                                    |
| `idleCloseMs`                              | Default 900000; `0` never closes.                                                                                                                                                                         |
| `pathToClaudeCodeExecutable`               | Default is the SDK's bundled binary.                                                                                                                                                                      |
| `models`                                   | Override the model list (`id`, `name?`, `contextWindow?`, `maxOutputTokens?`, `efforts?`). `efforts` adds picker entries `<id>-<effort>`. Defaults offer `medium` and `high`.                             |

Config is read when a session's child (re)starts, so changes apply to the next start rather than needing a valet restart.

## Tests

`bun test` runs against a fake SDK (`test/fake-sdk.ts`) and boots the real kernel once. A live test against the real SDK is skipped unless `VALET_LIVE_CLAUDE=1`.
