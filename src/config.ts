export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Effort levels the model takes. Unset = none to pick. */
  efforts?: Effort[];
  /** Claude Code's fast mode (`fastMode`) is available for this model. */
  fast?: boolean;
}

export interface ClaudeCodeConfig {
  permissionMode?: PermissionMode;
  /** Tools Claude Code may never use (hard deny), e.g. ["Bash"] to steer to valet-exec over MCP. */
  denyTools?: string[];
  /**
   * Base set of built-in tools Claude Code offers (SDK `tools`). `[]` removes them all, leaving valet's MCP
   * tools. Unset keeps Claude Code's defaults. `denyTools` is still applied on top.
   */
  tools?: string[];
  /**
   * Runs a built-in tool the model emits as another tool, e.g. `{ Bash: "mcp__valet__exec" }` (SDK
   * `toolAliases`). The target must accept the built-in's input shape. It redirects calls to a tool that is
   * still offered or named by a skill; to stop a built-in being offered, use `denyTools` or `tools`.
   */
  toolAliases?: Record<string, string>;
  /** Remove every Claude Code built-in tool, leaving valet's MCP tools (`tools: []`). Wins over `tools`. Default false. */
  hideBuiltinTools?: boolean;
  /** Defer valet's MCP tools behind Claude Code's tool search instead of loading them into the prompt. Default false. */
  deferValetTools?: boolean;
  /** Appended to the claude_code system prompt. Static per plugin config: it is part of the cached prefix. */
  appendSystemPrompt?: string;
  /** Which Claude Code settings files (and CLAUDE.md / AGENTS.md) to load. Default none: valet supplies the persona. */
  settingSources?: ("user" | "project" | "local")[];
  /** CLAUDE_CODE_PROMPT_CACHE_TTL for main-conversation requests. Unset = Anthropic's default (1h on subscription). */
  promptCacheTtl?: "5m" | "1h";
  /** CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL for Claude Code's own subagents. Unset = default (5m). */
  subagentPromptCacheTtl?: "5m" | "1h";
  /** MCP_TOOL_TIMEOUT for valet's MCP tools, in ms. Claude Code's own default is 60s. Default 24h. */
  mcpToolTimeoutMs?: number;
  /** Close the idle `claude` child after this long; the next prompt resumes it. 0 disables. Default 15 min. */
  idleCloseMs?: number;
  /** Hide claude.ai account connectors (Gmail, GitHub, ...) from sessions. Default true: valet's tools only. */
  disableClaudeAiConnectors?: boolean;
  /** Load only the MCP servers valet passes, ignoring project .mcp.json, user settings and plugins. Default true. */
  strictMcpConfig?: boolean;
  /** Hide "approaching limit" warnings below this percent used (0-100). Hard-limit errors always show. Default 80. */
  minRateLimitNoticePercent?: number;
  pathToClaudeCodeExecutable?: string;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: string;
  /** Replaces the built-in model list. */
  models?: ModelConfig[];
}

/** Every level the Claude 5 family reports as supported (SDK supportedModels()); fast mode on Opus and Fable as its pricing table has it. */
const DEFAULT_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Context window and output cap shared by the Claude 5 family (Models API: max_input_tokens / max_tokens). */
const CLAUDE5_LIMITS = { contextWindow: 1_000_000, maxOutputTokens: 128_000 } as const;

export const DEFAULT_MODELS: ModelConfig[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: DEFAULT_EFFORTS, fast: true, ...CLAUDE5_LIMITS },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: DEFAULT_EFFORTS, ...CLAUDE5_LIMITS },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: DEFAULT_EFFORTS, ...CLAUDE5_LIMITS },
  {
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    efforts: DEFAULT_EFFORTS,
    fast: true,
    ...CLAUDE5_LIMITS,
  },
];

export const DEFAULT_UTILITY_MODEL = "claude-haiku-5-5";

export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;
