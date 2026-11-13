import { afterEach, expect, test } from "bun:test";
import type { AgentEvent } from "@valethq/sdk";
import { fakeSdk, result, text } from "./fake-sdk";
import { collect, fakeCtx, input, open } from "./helpers";

const ac = () => new AbortController().signal;
const pong = async function* () {
  yield* text("m1", "pong");
  yield result();
};
const types = (events: AgentEvent[]) => events.map((e) => e.type);
let h: ReturnType<typeof fakeCtx> | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

test("open: new session, cache-stable options", async () => {
  const { deps, calls } = fakeSdk(pong);
  h = fakeCtx({ denyTools: ["Bash"], promptCacheTtl: "5m", appendSystemPrompt: "You are Helper." }, deps);
  const s = await open(h, {
    mcpServers: [
      { name: "zeta", url: "http://z", headers: { authorization: "Bearer t" } },
      { name: "alpha", url: "http://a" },
    ],
  });
  expect(s.resumeId).toMatch(/^[0-9a-f-]{36}$/);
  expect(h.state[`s1:claude-code`]).toEqual({ resumeId: s.resumeId });
  await collect(s.prompt(input("hi"), ac()));
  const o = calls[0]?.options as {
    sessionId?: string;
    resume?: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    settingSources?: string[];
    disallowedTools?: string[];
    includePartialMessages?: boolean;
    systemPrompt?: unknown;
    mcpServers: Record<string, unknown>;
    env: Record<string, string>;
  };
  expect(o.sessionId).toBe(s.resumeId);
  expect(o.resume).toBeUndefined();
  expect(o.model).toBe("claude-opus-5-5");
  expect(o.effort).toBe("high");
  expect(o.permissionMode).toBe("acceptEdits");
  expect(o.settingSources).toEqual(["project", "local"]);
  expect(o.disallowedTools).toEqual(["Bash"]);
  expect(o.includePartialMessages).toBe(true);
  expect(o.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: "You are Helper.",
    excludeDynamicSections: true,
    snapshot: true,
  });
  expect(Object.keys(o.mcpServers)).toEqual(["alpha", "zeta"]);
  expect(o.mcpServers.zeta).toEqual({
    type: "http",
    url: "http://z",
    headers: { authorization: "Bearer t" },
  });
  expect(o.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
});

test("one Query serves every turn of a session", async () => {
  const { deps, calls } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  const s = await open(h);
  await collect(s.prompt(input("one"), ac()));
  await collect(s.prompt(input("two"), ac()));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompts).toEqual(["one", "two"]);
});

test("streamed text is not duplicated by the final assistant message", async () => {
  const { deps } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  const s = await open(h);
  const events = await collect(s.prompt(input("hi"), ac()));
  expect(events.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", text: "pong" }]);
  expect(events).toContainEqual({ type: "usage", contextTokens: 1102 });
  expect(events.at(-2)).toEqual({ type: "usage", contextTokens: 1102, inputTokens: 1102, outputTokens: 5 });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
});

test("without partial messages the assistant text is emitted", async () => {
  const { deps } = fakeSdk(async function* () {
    yield* text("m1", "whole", false);
    yield result();
  });
  h = fakeCtx({}, deps);
  const s = await open(h);
  const events = await collect(s.prompt(input("hi"), ac()));
  expect(events.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", text: "whole" }]);
});

test("tool calls map to tool-start and tool-end", async () => {
  const { deps } = fakeSdk(async function* () {
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi", description: "say hi" } },
        ],
        usage: { input_tokens: 1 },
      },
    };
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi", is_error: false }] },
    };
    yield {
      type: "assistant",
      parent_tool_use_id: "sub",
      message: { id: "m2", content: [{ type: "text", text: "ignored" }], usage: {} },
    };
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [{ type: "text", text: "boom" }],
            is_error: true,
          },
        ],
      },
    };
    yield result();
  });
  h = fakeCtx({}, deps);
  const s = await open(h);
  const events = await collect(s.prompt(input("hi"), ac()));
  expect(events).toContainEqual({
    type: "tool-start",
    callId: "t1",
    name: "Bash",
    title: "say hi",
    input: { command: "echo hi", description: "say hi" },
  });
  expect(events).toContainEqual({ type: "tool-end", callId: "t1", status: "done", output: "hi" });
  expect(events).toContainEqual({ type: "tool-end", callId: "t2", status: "error", output: "boom" });
  expect(events.some((e) => e.type === "text-delta")).toBe(false);
});

test("abort interrupts and finishes cancelled; the Query survives", async () => {
  const { deps, calls } = fakeSdk(async function* (t, ctl) {
    if (t === "slow") {
      while (!ctl.aborted()) await Bun.sleep(5);
      yield result({ subtype: "error_during_execution", is_error: true, errors: [] });
      return;
    }
    yield* pong();
  });
  h = fakeCtx({}, deps);
  const s = await open(h);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const events = await collect(s.prompt(input("slow"), controller.signal));
  expect(events.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
  expect(calls[0]?.methods.map((m) => m.name)).toContain("interrupt");
  const next = await collect(s.prompt(input("again"), ac()));
  expect(next.at(-1)).toEqual({ type: "finish", reason: "stop" });
  expect(calls).toHaveLength(1);
});

test("an abandoned turn is drained before the next one", async () => {
  const { deps } = fakeSdk(async function* (t) {
    yield* text("m1", t === "first" ? "stale" : "fresh");
    yield result();
  });
  h = fakeCtx({}, deps);
  const s = await open(h);
  for await (const e of s.prompt(input("first"), ac())) {
    if (e.type === "text-delta") break;
  }
  const events = await collect(s.prompt(input("second"), ac()));
  expect(events.filter((e) => e.type === "text-delta")).toEqual([{ type: "text-delta", text: "fresh" }]);
});

test("resume: known session resumes, unknown session is reseeded", async () => {
  const known = "11111111-1111-4111-8111-111111111111";
  const { deps, calls } = fakeSdk(pong, new Set([known]));
  h = fakeCtx({}, deps);
  const a = await open(h, { resumeId: known });
  expect(a.resumeId).toBe(known);
  expect((a as { reseeded?: boolean }).reseeded).toBe(false);
  await collect(a.prompt(input("hi"), ac()));
  expect(calls[0]?.options.resume).toBe(known);
  expect(calls[0]?.options.sessionId).toBeUndefined();

  const b = await open(h, { resumeId: "22222222-2222-4222-8222-222222222222" });
  expect(b.resumeId).not.toBe("22222222-2222-4222-8222-222222222222");
  expect((b as { reseeded?: boolean }).reseeded).toBe(true);
  expect(h.state["s1:claude-code"]).toEqual({ resumeId: b.resumeId });
});

test("preamble sections go first, as separate text blocks", async () => {
  const { deps, calls } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  const s = await open(h);
  await collect(s.prompt(input("hi", "## Persona\nHelper\n## Rules\nbe nice"), ac()));
  expect(calls[0]?.prompts).toEqual(["## Persona\nHelper|## Rules\nbe nice|hi"]);
});

test("setModel only touches the Query when something changed", async () => {
  const { deps, calls } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  const s = await open(h);
  await collect(s.prompt(input("hi"), ac()));
  await s.setModel?.("claude-opus-5-5-high");
  expect(calls[0]?.methods).toEqual([]);
  await s.setModel?.("claude-opus-5-5-low");
  expect(calls[0]?.methods).toEqual([{ name: "applyFlagSettings", args: [{ effortLevel: "low" }] }]);
  await s.setModel?.("claude-sonnet-5-5");
  expect(calls[0]?.methods.slice(1)).toEqual([
    { name: "setModel", args: ["claude-sonnet-5-5"] },
    { name: "applyFlagSettings", args: [{ effortLevel: null }] },
  ]);
});

test("setModel before the first prompt just changes the start options", async () => {
  const { deps, calls } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  const s = await open(h);
  await s.setModel?.("claude-sonnet-5-5-medium");
  await collect(s.prompt(input("hi"), ac()));
  expect(calls[0]?.options.model).toBe("claude-sonnet-5-5");
  expect(calls[0]?.options.effort).toBe("medium");
});

test("idle child closes and the next prompt resumes the same session", async () => {
  const { deps, calls } = fakeSdk(pong);
  h = fakeCtx({ idleCloseMs: 20 }, deps);
  const s = await open(h);
  await collect(s.prompt(input("one"), ac()));
  await Bun.sleep(80);
  expect(calls[0]?.closed).toBe(true);
  await collect(s.prompt(input("two"), ac()));
  expect(calls).toHaveLength(2);
  expect(calls[1]?.options.resume).toBe(s.resumeId);
});

test("child exiting mid-turn fails the turn, then restarts on next use", async () => {
  let first = true;
  const { deps, calls } = fakeSdk(async function* () {
    if (first) {
      first = false;
      throw new Error("claude exited with code 1");
    }
    yield* pong();
  });
  h = fakeCtx({}, deps);
  const s = await open(h);
  const events = await collect(s.prompt(input("one"), ac()));
  expect(events.at(-1)).toEqual({ type: "finish", reason: "error", error: "claude exited with code 1" });
  const next = await collect(s.prompt(input("two"), ac()));
  expect(types(next).at(-1)).toBe("finish");
  expect(next.at(-1)).toEqual({ type: "finish", reason: "stop" });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.closed).toBe(true);
});

test("error results carry the SDK's message", async () => {
  const { deps } = fakeSdk(async function* () {
    yield result({ subtype: "error_during_execution", is_error: true, errors: ["prompt too long"] });
  });
  h = fakeCtx({}, deps);
  const s = await open(h);
  const events = await collect(s.prompt(input("hi"), ac()));
  expect(events.at(-1)).toEqual({ type: "finish", reason: "error", error: "prompt too long" });
});

test("each turn logs cache statistics", async () => {
  const { deps } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  const s = await open(h);
  await collect(s.prompt(input("hi"), ac()));
  const log = h.logs.find((l) => l.msg === "claude code turn");
  expect(log?.data?.cache).toEqual({
    input: 2,
    output: 5,
    read: 1000,
    write5m: 0,
    write1h: 100,
    hitRatio: 0.907,
  });
});

test("listModels uses config, else the defaults", async () => {
  const { deps } = fakeSdk(pong);
  h = fakeCtx({}, deps);
  expect((await h.provider.listModels()).map((m) => m.id)).not.toContain("claude-opus-5-5");
  expect((await h.provider.listModels()).map((m) => m.id)).toContain("claude-opus-5-5-high");
  h = fakeCtx({ models: [{ id: "x", contextWindow: 1_000_000 }] }, deps);
  expect(await h.provider.listModels()).toMatchObject([{ id: "x", name: "x", contextWindow: 1_000_000 }]);
});

test("/compact runs as a turn and reports the compaction start and end", async () => {
  const script = async function* (userText: string) {
    if (userText !== "/compact keep the todo list") throw new Error(`unexpected prompt: ${userText}`);
    yield { type: "system", subtype: "status", status: "compacting" } as never;
    yield {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 1000, post_tokens: 200 },
    } as never;
    yield result();
  };
  const { deps } = fakeSdk(script);
  h = fakeCtx({}, deps);
  const s = await open(h);
  if (!s.compact) throw new Error("claude code session should support compact");
  const events = await collect(s.compact("keep the todo list", ac()));
  expect(events).toContainEqual({ type: "compaction-start" });
  expect(events).toContainEqual({ type: "compaction-end", status: "completed" });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
});
