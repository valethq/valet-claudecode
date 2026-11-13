import type { ClaudeCodeConfig } from "./config";

type Env = Record<string, string | undefined>;

/**
 * Agent SDK turns are "main conversation" requests, so Claude Code gives them the 1h TTL on a
 * subscription. Only touch the TTL when configured; an explicit variable in the host env wins.
 */
export function claudeEnv(cfg: ClaudeCodeConfig, base: Env = process.env): Env {
  const env: Env = { ...base };
  if (cfg.promptCacheTtl && env.CLAUDE_CODE_PROMPT_CACHE_TTL === undefined)
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = cfg.promptCacheTtl;
  if (cfg.subagentPromptCacheTtl && env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL === undefined)
    env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = cfg.subagentPromptCacheTtl;
  return env;
}

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}

export interface CacheStats {
  input: number;
  output: number;
  read: number;
  write5m: number;
  write1h: number;
  /** Fraction of prompt tokens served from cache. */
  hitRatio: number;
}

export function cacheStats(u: UsageLike): CacheStats {
  const input = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? (write5m ? 0 : created);
  const prompt = input + read + created;
  return {
    input,
    output: u.output_tokens ?? 0,
    read,
    write5m,
    write1h,
    hitRatio: prompt ? Math.round((read / prompt) * 1000) / 1000 : 0,
  };
}

/** Everything the model saw this request: the context size, as valet shows it. */
export function contextTokens(u: UsageLike): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
