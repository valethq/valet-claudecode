import { expect, test } from "bun:test";
import { realSdk } from "../src/sdk";
import { collect, fakeCtx, input, noTools, open } from "./helpers";

test.skipIf(process.env.VALET_LIVE_CLAUDE !== "1")(
  "live Claude Agent SDK",
  async () => {
    const h = fakeCtx({ idleCloseMs: 0 }, realSdk);
    try {
      const s = await open(h, { cwd: process.cwd(), model: "claude-sonnet-5-5" });
      const ac = new AbortController().signal;
      const one = await collect(s.prompt(input("reply with the word pong"), ac));
      const text = one.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
      expect(text.toLowerCase()).toContain("pong");
      expect(one.at(-1)).toEqual({ type: "finish", reason: "stop" });
      const two = await collect(s.prompt(input("what single word did I ask you to reply with?"), ac));
      expect(
        two
          .flatMap((e) => (e.type === "text-delta" ? [e.text] : []))
          .join("")
          .toLowerCase(),
      ).toContain("pong");
      const turns = h.logs.filter((l) => l.msg === "claude code turn");
      const cache = (turns[1]?.data?.cache ?? { hitRatio: 0 }) as { hitRatio: number };
      expect(cache.hitRatio).toBeGreaterThan(0.5);
      await s.close();
    } finally {
      await h.dispose();
    }
  },
  180_000,
);

test.skipIf(process.env.VALET_LIVE_CLAUDE !== "1")(
  "live: a denied tool is not offered and a gate that throws blocks the call",
  async () => {
    const h = fakeCtx({ idleCloseMs: 0, denyTools: ["Bash"] }, realSdk);
    try {
      const gate = { ...noTools, authorize: async () => Promise.reject(new Error("gate down")) };
      const s = await open(h, { cwd: process.cwd(), model: "claude-haiku-5-5", tools: gate });
      const ac = new AbortController().signal;
      const events = await collect(
        s.prompt(input("Read package.json and tell me its `name` field. Use any tool you have."), ac),
      );
      const started = events.flatMap((e) => (e.type === "tool-start" ? [e.name] : []));
      expect(started).not.toContain("Bash");
      expect(events.some((e) => e.type === "tool-end" && e.status === "done")).toBe(false);
      const text = events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
      expect(text).not.toContain("valet-claudecode");
      await s.close();
    } finally {
      await h.dispose();
    }
  },
  180_000,
);
