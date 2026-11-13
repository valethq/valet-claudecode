export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Effort levels offered as picker entries ("<id>-<effort>"). Unset = bare id only. */
  efforts?: Effort[];
}

export interface ClaudeCodeConfig {
  permissionMode?: PermissionMode;
  /** Tools Claude Code may never use (hard deny), e.g. ["Bash"] to steer to valet-exec over MCP. */
  denyTools?: string[];
  /** Appended to the claude_code system prompt. Static per plugin config: it is part of the cached prefix. */
  appendSystemPrompt?: string;
  /** Which Claude Code settings files to load. Default ["project", "local"] keeps the prefix deterministic. */
  settingSources?: ("user" | "project" | "local")[];
  /** CLAUDE_CODE_PROMPT_CACHE_TTL for main-conversation requests. Unset = Anthropic's default (1h on subscription). */
  promptCacheTtl?: "5m" | "1h";
  /** CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL for Claude Code's own subagents. Unset = default (5m). */
  subagentPromptCacheTtl?: "5m" | "1h";
  /** Close the idle `claude` child after this long; the next prompt resumes it. 0 disables. Default 15 min. */
  idleCloseMs?: number;
  pathToClaudeCodeExecutable?: string;
  models?: ModelConfig[];
}

const DEFAULT_EFFORTS: Effort[] = ["medium", "high"];

export const DEFAULT_MODELS: ModelConfig[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: DEFAULT_EFFORTS },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: DEFAULT_EFFORTS },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", efforts: DEFAULT_EFFORTS },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", efforts: DEFAULT_EFFORTS },
];

export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;
