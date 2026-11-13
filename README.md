# valet-claudecode

`inference@1` agent provider `claude-code`, built on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).

A [valet](https://github.com/valethq/valet-core) plugin and a sibling of `valet-devin`: Claude Code runs the loop and its own tools, and valet mirrors the stream into messages and parts. It authenticates as whoever is logged in to `claude` on the host (a subscription works), so there is no API key in valet.

Imports `@valethq/sdk` only, plus the Agent SDK. The Agent SDK is the one dependency this repo adds; the rest of the repo's rules are unchanged.

## How it works

- One long-lived `claude` child per valet session, driven through the SDK's streaming-input `query()`. Each valet turn pushes one user message and reads until the `result` message.
- `open()` stores the SDK session id as `resumeId`. If that session is on disk (`getSessionInfo`), the next start uses `resume`. If not, a fresh id is used and the session is marked `reseeded` so the caller sends the preamble.
- Idle children are closed after `idleCloseMs` (default 15 min) and resumed by the next prompt. Resume rebuilds the same prompt prefix, so it doesn't cost cache.
- `setModel("claude-opus-5-5-high")` splits a trailing effort word: model via `Query.setModel`, effort via `applyFlagSettings`. Nothing is sent when the value didn't change.
- Abort calls `Query.interrupt()`; the child stays up for the next turn.

## Prompt cache rules (read before changing the session code)

These come from measuring the SDK on this host and from [t3code#22841](https://github.com/pingdotgg/t3code/pull/22841).

1. **Keep one Query per session.** Agent SDK turns are "main conversation" requests, which get the 1h TTL on a subscription. A new `query()` per turn restarts the process for nothing.
2. **Never `for await` a Query across turns.** Leaving the loop (a `return`, `break` or thrown error) calls the iterator's `return()` and closes the child. The session drives it with `q.next()` instead.
3. **Freeze the prefix.** The system prompt is `claude_code` + the static `appendSystemPrompt`, with `excludeDynamicSections: true` (cwd, date and git status move out of the system prompt, so sessions can share cache) and `snapshot: true` (the prompt is recorded once and reused on every resume). Persona and per-turn context go in the user message as `preamble`, never in `appendSystemPrompt`.
4. **Freeze the tool set.** `mcpServers` are fixed at start and sorted by name. Don't call `setMcpServers` mid-session; the tool list is at the front of the prompt.
5. **Don't flip the model or effort casually.** The cache is per model. `setModel` is a no-op when nothing changed.
6. **Load settings deterministically.** `settingSources` defaults to `["project", "local"]` so user-level hooks and MCP config can't change the prefix between runs.
7. **TTL is opt-in.** `promptCacheTtl` / `subagentPromptCacheTtl` set `CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for the child, and only when set. An explicit variable in valet's own environment wins. Left unset, Anthropic's default applies. The t3code data shows the right TTL depends on the workload (1h wins for chatty long loops; 5m wins when gaps are short and the sessions are one-shot), so measure before forcing either.
8. **Measure.** Every turn logs `claude code turn` with `cache: { input, output, read, write5m, write1h, hitRatio }`.

## Config (`plugins.valet-claudecode.config`)

| Key                                        | Meaning                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `permissionMode`                           | `default` / `acceptEdits` (default) / `plan` / `bypassPermissions`. Also a settings panel (`valet-claudecode`) that overrides it. |
| `denyTools`                                | Hard-denied tools (`disallowedTools`), e.g. `["Bash"]` to steer to `valet-exec` over MCP.                                         |
| `appendSystemPrompt`                       | Static text appended to the system prompt.                                                                                        |
| `settingSources`                           | Default `["project", "local"]`.                                                                                                   |
| `promptCacheTtl`, `subagentPromptCacheTtl` | `"5m"` or `"1h"`; unset means default.                                                                                            |
| `idleCloseMs`                              | Default 900000; `0` never closes.                                                                                                 |
| `pathToClaudeCodeExecutable`               | Default is the SDK's bundled binary.                                                                                              |
| `models`                                   | Override the model list (`id`, `name?`, `contextWindow?`, `maxOutputTokens?`).                                                    |

Config is read when a session's child (re)starts, so changes apply to the next start rather than needing a valet restart.

## Tests

`bun test` runs against a fake SDK (`test/fake-sdk.ts`) and boots the real kernel once. A live test against the real SDK is skipped unless `VALET_LIVE_CLAUDE=1`.
