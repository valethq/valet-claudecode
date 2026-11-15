import { expect, test } from "bun:test";
import { cacheStats, claudeEnv, contextTokens } from "../src/cache";
import { mapMessage, newTurnState } from "../src/events";
import { DEFAULT_MODELS } from "../src/config";
import { resolveModel, toModelInfos } from "../src/models";
import { mcpServerConfig } from "../src/session";
import { leakedTools } from "../src/tools";

test("claudeEnv sets TTLs only when configured, and an explicit variable wins", () => {
  const base = { PATH: "/bin", MCP_TOOL_TIMEOUT: "1000" };
  expect(claudeEnv({}, base)).toEqual(base);
  expect(claudeEnv({ promptCacheTtl: "5m", subagentPromptCacheTtl: "1h" }, base)).toEqual({
    PATH: "/bin",
    MCP_TOOL_TIMEOUT: "1000",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h",
  });
  expect(
    claudeEnv({ promptCacheTtl: "5m" }, { ...base, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" })
      .CLAUDE_CODE_PROMPT_CACHE_TTL,
  ).toBe("1h");
});

test("claudeEnv lifts Claude Code's 60s MCP tool timeout", () => {
  expect(claudeEnv({}, {}).MCP_TOOL_TIMEOUT).toBe(String(24 * 3_600_000));
  expect(claudeEnv({ mcpToolTimeoutMs: 5000 }, {}).MCP_TOOL_TIMEOUT).toBe("5000");
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

test("toModelInfos offers one picker entry per declared effort and no bare entry", () => {
  expect(
    toModelInfos({ id: "claude-opus-5-5", name: "Opus", efforts: ["low", "max"] }).map((m) => [m.id, m.name]),
  ).toEqual([
    ["claude-opus-5-5-low", "Opus (low)"],
    ["claude-opus-5-5-max", "Opus (max)"],
  ]);
  expect(toModelInfos({ id: "claude-haiku-5-5" }).map((m) => m.id)).toEqual(["claude-haiku-5-5"]);
});

test("built-in Claude 5 models advertise the 1M window and 128k output cap", () => {
  for (const m of DEFAULT_MODELS) {
    expect(toModelInfos(m)[0]).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
  }
});

test("mcpServerConfig is sorted by name", () => {
  expect(
    Object.keys(
      mcpServerConfig([
        { name: "b", url: "u", headers: {} },
        { name: "a", url: "u", headers: {} },
      ]),
    ),
  ).toEqual(["a", "b"]);
});

test("mcpServerConfig loads tools up front unless told to defer", () => {
  const entry = [{ name: "valet", url: "u", headers: {} }];
  expect(mcpServerConfig(entry).valet).toMatchObject({ alwaysLoad: true });
  expect(mcpServerConfig(entry, false).valet).not.toHaveProperty("alwaysLoad");
});

test("leakedTools finds denied names the child still lists, skips rule patterns, and treats Task as Agent", () => {
  expect(leakedTools(["Read", "Bash"], ["Bash"])).toEqual(["Bash"]);
  expect(leakedTools(["Read"], ["Bash"])).toEqual([]);
  expect(leakedTools(["Bash"], ["Bash(rm *)"])).toEqual([]);
  expect(leakedTools(["Task"], ["Agent"])).toEqual(["Task"]);
  expect(leakedTools(["Bash"], undefined)).toEqual([]);
});

const sys = (m: Record<string, unknown>) => m as never;

test("a compacting status opens the marker; a failed compact_result closes it with the error", () => {
  const st = newTurnState();
  expect(
    mapMessage(sys({ type: "system", subtype: "status", status: "compacting" }), st, () => false),
  ).toEqual([{ type: "compaction-start" }]);
  expect(
    mapMessage(
      sys({
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "boom",
      }),
      st,
      () => false,
    ),
  ).toEqual([{ type: "compaction-end", status: "failed", error: "boom" }]);
});

test("compaction becomes a marker event; retries and rate limits become notices", () => {
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
    { type: "compaction-start" },
    { type: "compaction-end", status: "completed" },
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
  ).toEqual([{ type: "notice", level: "error", text: "Claude hit its session limit." }]);
  const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;
  const rejected = (rateLimitType: string, resetsAt: number) =>
    mapMessage(
      sys({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType, resetsAt } }),
      st,
      () => false,
    );
  expect(rejected("five_hour", inSeconds(8040))).toEqual([
    { type: "notice", level: "error", text: "Claude hit its session limit. It resets in 2h 14m." },
  ]);
  expect(rejected("seven_day", inSeconds(3 * 86_400 + 2 * 3600))).toEqual([
    { type: "notice", level: "error", text: "Claude hit its weekly limit. It resets in 3d 2h." },
  ]);
  expect(rejected("five_hour", inSeconds(1500))).toEqual([
    { type: "notice", level: "error", text: "Claude hit its session limit. It resets in 25 min." },
  ]);
  expect(
    mapMessage(
      sys({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.92 },
      }),
      st,
      () => false,
    ),
  ).toEqual([{ type: "notice", level: "warning", text: "Approaching Claude's session limit (92% used)" }]);
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
