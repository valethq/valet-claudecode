import { randomUUID } from "node:crypto";
import type { AgentProvider, AgentSession, PluginContext } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "./config";
import { modelLister } from "./models";
import { realSdk, type SdkDeps } from "./sdk";
import { ClaudeCodeSession } from "./session";
import { permissionMode } from "./settings";
import { createUtility } from "./utility";

export const PROVIDER_KEY = "claude-code";

export function createProvider(
  ctx: PluginContext<ClaudeCodeConfig>,
  deps: SdkDeps = realSdk,
): { provider: AgentProvider; dispose(): Promise<void> } {
  const sessions = new Set<ClaudeCodeSession>();
  const provider: AgentProvider = {
    kind: "agent",
    id: PROVIDER_KEY,
    label: "Claude Code",
    listModels: modelLister(() => ctx.config),
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
      const claude: ClaudeCodeSession = new ClaudeCodeSession({
        deps,
        id,
        cwd,
        model: opts.model,
        mcpServers: opts.mcpServers,
        reseeded: opts.resumeId !== undefined && id !== opts.resumeId,
        cfg: () => ctx.config ?? {},
        mode: () => permissionMode(ctx),
        log: ctx.log,
        blobPath: (blobId) => ctx.store.blobs.path(blobId),
        onClose: () => sessions.delete(claude),
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
