import type { AgentEvent, AgentProvider, PluginContext } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "../src/config";
import { createProvider } from "../src/provider";
import type { SdkDeps } from "../src/sdk";

export function fakeCtx(config: ClaudeCodeConfig, deps: SdkDeps, blobs: Record<string, string> = {}) {
  const state: Record<string, unknown> = {};
  const kv = new Map<string, unknown>();
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    logs.push({ level, msg, data });
  const ctx = {
    config,
    log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") },
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
      },
    },
    store: {
      sessions: {
        get: () => ({ projectId: "p1" }),
        setProviderState: (id: string, provider: string, s: unknown) => {
          state[`${id}:${provider}`] = s;
        },
      },
      projects: { get: () => ({ workspaceDir: "/tmp" }) },
      blobs: {
        path: (id: string) => {
          const p = blobs[id];
          if (p === undefined) throw new Error(`unknown blob "${id}"`);
          return p;
        },
      },
    },
  } as unknown as PluginContext<ClaudeCodeConfig>;
  const { provider, dispose } = createProvider(ctx, deps);
  return { provider: provider as AgentProvider, state, logs, kv, dispose, ctx };
}

export async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}

export const input = (t: string, preamble?: string) => ({
  content: [{ type: "text" as const, text: t }],
  ...(preamble && { preamble }),
});

export const open = (h: ReturnType<typeof fakeCtx>, extra: Record<string, unknown> = {}) =>
  h.provider.open({
    sessionId: "s1",
    cwd: "/tmp",
    model: "claude-opus-5-5-high",
    mcpServers: [],
    signal: new AbortController().signal,
    ...extra,
  });
