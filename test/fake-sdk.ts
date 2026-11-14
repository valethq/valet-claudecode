import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkDeps } from "../src/sdk";

type Script = (userText: string, ctl: { aborted(): boolean }) => AsyncGenerator<unknown>;

export interface FakeCall {
  options: Record<string, unknown>;
  prompts: string[];
  methods: { name: string; args: unknown[] }[];
  closed: boolean;
}

const usage = {
  input_tokens: 2,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 100,
};

export const text = (id: string, t: string, partial = true) => [
  ...(partial
    ? [
        { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } },
        {
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
        },
      ]
    : []),
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, content: [{ type: "text", text: t }], usage },
  },
];

/** The `system/init` message Claude Code sends when a child starts, listing the tools it offers. */
export const init = (tools: string[]) => ({ type: "system", subtype: "init", tools });

export const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  usage: { ...usage, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } },
  ...over,
});

/** A fake Agent SDK. `script` yields the SDK messages for each user turn. */
export function fakeSdk(
  script: Script,
  sessions: Set<string> = new Set(),
  usage: () => unknown | Promise<unknown> = () => ({ rate_limits_available: false, rate_limits: null }),
) {
  const calls: FakeCall[] = [];
  const deps: SdkDeps = {
    getSessionInfo: (async (id: string) => (sessions.has(id) ? { sessionId: id } : undefined)) as never,
    query: (({
      prompt,
      options,
    }: {
      prompt: string | AsyncIterable<{ message: { content: { text?: string }[] } }>;
      options: Record<string, unknown>;
    }) => {
      const call: FakeCall = { options, prompts: [], methods: [], closed: false };
      calls.push(call);
      const messages =
        typeof prompt === "string"
          ? (async function* () {
              yield { message: { content: [{ text: prompt }] } };
            })()
          : prompt;
      const it = messages[Symbol.asyncIterator]();
      let aborted = false;
      let current: AsyncGenerator<unknown> | undefined;
      const q = {
        [Symbol.asyncIterator]() {
          return q;
        },
        async next() {
          for (;;) {
            if (!current) {
              const r = await it.next();
              if (r.done || call.closed) return { value: undefined, done: true };
              aborted = false;
              const t = r.value.message.content.map((b) => b.text ?? "").join("|");
              call.prompts.push(t);
              sessions.add(String(options.sessionId ?? options.resume));
              current = script(t, { aborted: () => aborted });
            }
            const r = await current.next();
            if (r.done) {
              current = undefined;
              continue;
            }
            return { value: r.value as SDKMessage, done: false };
          }
        },
        async interrupt() {
          aborted = true;
          call.methods.push({ name: "interrupt", args: [] });
        },
        async setModel(...args: unknown[]) {
          call.methods.push({ name: "setModel", args });
        },
        async applyFlagSettings(...args: unknown[]) {
          call.methods.push({ name: "applyFlagSettings", args });
        },
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(...args: unknown[]) {
          call.methods.push({ name: "usage", args });
          return usage();
        },
        close() {
          call.closed = true;
        },
      };
      return q as unknown as Query;
    }) as never,
  };
  return { deps, calls };
}
