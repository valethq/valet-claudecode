import { expect, test } from "bun:test";
import { realSdk } from "../src/sdk";
import { collect, fakeCtx, input, open } from "./helpers";

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
