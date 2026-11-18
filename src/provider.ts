import { randomUUID } from "node:crypto";
import { type AgentProvider, type AgentSession, type PluginContext, toolEndpoint } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "./config";
import { modelLister } from "./models";
import { realSdk, type SdkDeps } from "./sdk";
import { ClaudeCodeSession } from "./session";
import {
  customModels,
  disableClaudeAiConnectors,
  hideBuiltinTools,
  minRateLimitNoticePercent,
  permissionMode,
  strictMcpConfig,
} from "./settings";
import { createUtility } from "./utility";

export const PROVIDER_KEY = "claude-code";

export function createProvider(
  ctx: PluginContext<ClaudeCodeConfig>,
  deps: SdkDeps = realSdk,
): { provider: AgentProvider; dispose(): Promise<void> } {
  const sessions = new Set<ClaudeCodeSession>();
  const tools = toolEndpoint(ctx.http, {
    serverName: "valet",
    version: ctx.plugin.version,
    readBlob: (blobId) => Bun.file(ctx.store.blobs.path(blobId)).bytes(),
  });
  // `& { icon }` until @valethq/sdk 0.3.0 (ProviderBase.icon) is published.
  const provider: AgentProvider & { readonly icon: string } = {
    kind: "agent",
    id: PROVIDER_KEY,
    label: "Claude Code",
    icon: "claude",
    listModels: modelLister(
      () => ctx.config,
      () => customModels(ctx),
    ),
    utility: createUtility(ctx, deps),
    async open(opts): Promise<AgentSession> {
      const session = ctx.store.sessions.get(opts.sessionId);
      const project = session && ctx.store.projects.get(session.projectId);
      const cwd = project?.workspaceDir ?? opts.cwd;
      const known = opts.resumeId
        ? await deps.getSessionInfo(opts.resumeId, { dir: cwd }).catch(() => undefined)
        : undefined;
      if (opts.resumeId && !known)
        ctx.log.warn("claude code session not found, reseeding", { resumeId: opts.resumeId });
      const id = opts.resumeId && known ? opts.resumeId : randomUUID();
      const mcp = tools.expose(opts.sessionId, opts.tools);
      const claude: ClaudeCodeSession = new ClaudeCodeSession({
        deps,
        id,
        cwd,
        model: opts.model,
        mcpServers: [mcp],
        tools: opts.tools,
        reseeded: opts.resumeId !== undefined && id !== opts.resumeId,
        preamble: {
          get: () => ctx.storage.kv.get<string>(`preamble:${id}`),
          set: (text) => ctx.storage.kv.set(`preamble:${id}`, text),
        },
        cfg: () => ctx.config ?? {},
        flags: () => ({
          hideBuiltinTools: hideBuiltinTools(ctx),
          disableClaudeAiConnectors: disableClaudeAiConnectors(ctx),
          strictMcpConfig: strictMcpConfig(ctx),
        }),
        mode: () => permissionMode(ctx),
        minRateLimitNoticePercent: () => minRateLimitNoticePercent(ctx),
        log: ctx.log,
        blobPath: (blobId) => ctx.store.blobs.path(blobId),
        onClose: () => {
          sessions.delete(claude);
          tools.revoke(opts.sessionId);
        },
      });
      sessions.add(claude);
      ctx.store.sessions.setProviderState(opts.sessionId, PROVIDER_KEY, { resumeId: id });
      return claude;
    },
  };
  return {
    provider,
    dispose: async () => {
      await Promise.all([...sessions].map((s) => s.close()));
    },
  };
}
