import { expect, test } from "bun:test";
import { cacheStats, claudeEnv, contextTokens } from "../src/cache";
import { mapMessage, newTurnState } from "../src/events";
import { resolveModel } from "../src/models";
import { mcpServerConfig } from "../src/session";

test("claudeEnv sets TTLs only when configured, and an explicit variable wins", () => {
  const base = { PATH: "/bin" };
  expect(claudeEnv({}, base)).toEqual(base);
  expect(claudeEnv({ promptCacheTtl: "5m", subagentPromptCacheTtl: "1h" }, base)).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h",
  });
  expect(
    claudeEnv({ promptCacheTtl: "5m" }, { ...base, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" })
      .CLAUDE_CODE_PROMPT_CACHE_TTL,
  ).toBe("1h");
});

test("cacheStats and contextTokens", () => {
  const u = {
    input_tokens: 4,
    output_tokens: 9,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 6,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 },
  };
  expect(cacheStats(u)).toEqual({ input: 4, output: 9, read: 90, write5m: 2, write1h: 4, hitRatio: 0.9 });
  expect(contextTokens(u)).toBe(100);
  expect(cacheStats({ input_tokens: 1, cache_creation_input_tokens: 5 }).write1h).toBe(5);
  expect(cacheStats({})).toMatchObject({ hitRatio: 0 });
});

test("resolveModel splits an effort suffix", () => {
  expect(resolveModel("claude-opus-5-5-high")).toEqual({ model: "claude-opus-5-5", effort: "high" });
  expect(resolveModel("claude-opus-5-5-xhigh")).toEqual({ model: "claude-opus-5-5", effort: "xhigh" });
  expect(resolveModel("claude-sonnet-5-5")).toEqual({ model: "claude-sonnet-5-5" });
});

test("mcpServerConfig is sorted by name", () => {
  expect(
    Object.keys(
      mcpServerConfig([
        { name: "b", url: "u" },
        { name: "a", url: "u" },
      ]),
    ),
  ).toEqual(["a", "b"]);
});

const sys = (m: Record<string, unknown>) => m as never;

test("compaction, retries and rate limits become notices", () => {
  const st = newTurnState();
  const compact = mapMessage(
    sys({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 30_000 },
    }),
    st,
    () => false,
  );
  expect(compact).toEqual([
    { type: "notice", level: "info", text: "Context compacted by Claude Code: 150.0k → 30.0k tokens" },
    { type: "usage", contextTokens: 30_000 },
  ]);
  expect(
    mapMessage(
      sys({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, error_status: 529 }),
      st,
      () => false,
    ),
  ).toEqual([{ type: "notice", level: "warning", text: "Anthropic API retry 2/5 (HTTP 529)" }]);
  expect(
    mapMessage(sys({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), st, () => false),
  ).toEqual([]);
  expect(
    mapMessage(
      sys({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }),
      st,
      () => false,
    ),
  ).toEqual([{ type: "notice", level: "error", text: "Claude five_hour limit reached" }]);
});

test("interrupted tool results map to cancelled when the turn was aborted", () => {
  const m = sys({
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_result", tool_use_id: "t", content: "[interrupted]", is_error: true }],
    },
  });
  expect(mapMessage(m, newTurnState(), () => true)).toEqual([
    { type: "tool-end", callId: "t", status: "cancelled", output: "[interrupted]" },
  ]);
});
