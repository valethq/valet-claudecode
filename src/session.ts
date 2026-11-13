import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentOpenOptions, AgentSession, Logger, ModelContent } from "@valethq/sdk";
import { cacheStats, claudeEnv } from "./cache";
import { InputQueue } from "./channel";
import type { ClaudeCodeConfig, Effort, PermissionMode } from "./config";
import { mapMessage, mapResult, newTurnState } from "./events";
import { resolveModel } from "./models";
import type { SdkDeps } from "./sdk";

export interface SessionInit {
  deps: SdkDeps;
  id: string;
  cwd: string;
  model: string;
  mcpServers: AgentOpenOptions["mcpServers"];
  reseeded: boolean;
  cfg(): ClaudeCodeConfig;
  mode(): PermissionMode;
  log: Logger;
  blobPath(id: string): string;
  onClose(): void;
}

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export function mcpServerConfig(servers: AgentOpenOptions["mcpServers"]): NonNullable<Options["mcpServers"]> {
  return Object.fromEntries(
    [...servers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => [s.name, { type: "http" as const, url: s.url, ...(s.headers && { headers: s.headers }) }]),
  );
}

export class ClaudeCodeSession implements AgentSession {
  readonly reseeded: boolean;
  private query?: Query;
  private input?: InputQueue;
  private pending = false;
  private model: string;
  private effort?: Effort;
  private idle?: ReturnType<typeof setTimeout>;
  private lastContext?: number;

  constructor(private init: SessionInit) {
    this.reseeded = init.reseeded;
    const { model, effort } = resolveModel(init.model);
    this.model = model;
    this.effort = effort;
  }

  get resumeId(): string {
    return this.init.id;
  }

  private async options(input: InputQueue): Promise<{ prompt: InputQueue; options: Options }> {
    const { id, cwd, deps, log } = this.init;
    const cfg = this.init.cfg();
    const mode = this.init.mode();
    const resume = !!(await deps.getSessionInfo(id, { dir: cwd }).catch(() => undefined));
    const mcpServers = mcpServerConfig(this.init.mcpServers);
    return {
      prompt: input,
      options: {
        cwd,
        ...(resume ? { resume: id } : { sessionId: id }),
        model: this.model,
        ...(this.effort && { effort: this.effort }),
        includePartialMessages: true,
        settingSources: cfg.settingSources ?? ["project", "local"],
        permissionMode: mode,
        ...(mode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
        ...(cfg.denyTools?.length && { disallowedTools: cfg.denyTools }),
        canUseTool: async (_name, toolInput) => ({ behavior: "allow", updatedInput: toolInput }),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(cfg.appendSystemPrompt && { append: cfg.appendSystemPrompt }),
          excludeDynamicSections: true,
          snapshot: true,
        },
        ...(Object.keys(mcpServers).length && { mcpServers }),
        env: claudeEnv(cfg),
        ...(cfg.pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable: cfg.pathToClaudeCodeExecutable }),
        stderr: (line) => log.debug("claude stderr", { line: line.trimEnd() }),
      },
    };
  }

  private async ensure(): Promise<Query> {
    if (this.query) return this.query;
    const input = new InputQueue();
    const params = await this.options(input);
    this.input = input;
    this.query = this.init.deps.query(params);
    return this.query;
  }

  private drop(): void {
    clearTimeout(this.idle);
    this.input?.close();
    try {
      this.query?.close();
    } catch {}
    this.query = undefined;
    this.input = undefined;
    this.pending = false;
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    const ms = this.init.cfg().idleCloseMs ?? 15 * 60_000;
    if (!ms || !this.query) return;
    this.idle = setTimeout(() => {
      this.init.log.info("closing idle claude code child; the next prompt resumes it", {
        session: this.init.id,
      });
      this.drop();
    }, ms);
    this.idle.unref?.();
  }

  async setModel(next: string): Promise<void> {
    const { model, effort } = resolveModel(next);
    const modelChanged = model !== this.model;
    const effortChanged = effort !== this.effort;
    this.model = model;
    this.effort = effort;
    if (!this.query) return;
    if (modelChanged) await this.query.setModel(model);
    if (effortChanged) await this.query.applyFlagSettings({ effortLevel: effort ?? null });
  }

  async close(): Promise<void> {
    this.drop();
    this.init.onClose();
  }

  private async contentBlock(c: ModelContent): Promise<Block | undefined> {
    if (c.type === "text") return { type: "text", text: c.text };
    if (c.type !== "image") return undefined;
    const bytes = await Bun.file(this.init.blobPath(c.blobId)).bytes();
    return {
      type: "image",
      source: { type: "base64", media_type: c.mime, data: Buffer.from(bytes).toString("base64") },
    };
  }

  private async blocks(input: { content: ModelContent[]; preamble?: string }): Promise<Block[]> {
    const head = (input.preamble?.split(/\n(?=## )/) ?? []).filter((t) => !!t);
    const content = await Promise.all(input.content.map((c) => this.contentBlock(c)));
    return [
      ...head.map((text): Block => ({ type: "text", text })),
      ...content.filter((b): b is Block => b !== undefined),
    ];
  }

  /** An abandoned turn leaves its messages in the Query; consume them so they don't bleed into the next turn. */
  private async settle(q: Query): Promise<void> {
    if (!this.pending) return;
    await q.interrupt().catch(() => undefined);
    while (this.pending) {
      const r = await q.next();
      if (r.done) return this.drop();
      if (r.value.type === "result") this.pending = false;
    }
  }

  async *prompt(
    input: { content: ModelContent[]; preamble?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    clearTimeout(this.idle);
    let q: Query;
    let content: Block[];
    try {
      q = await this.ensure();
      await this.settle(q);
      q = await this.ensure();
      content = await this.blocks(input);
    } catch (e) {
      this.drop();
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    const state = newTurnState(this.init.log, this.lastContext);
    const message = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    const interrupt = () => void q.interrupt().catch(() => undefined);
    signal.addEventListener("abort", interrupt);
    this.pending = true;
    this.input?.push(message);
    if (signal.aborted) interrupt();
    try {
      for (;;) {
        let next: IteratorResult<SDKMessage, void>;
        try {
          next = await q.next();
        } catch (e) {
          this.drop();
          yield { type: "finish", reason: "error", error: (e as Error).message };
          return;
        }
        if (next.done) {
          this.drop();
          yield { type: "finish", reason: "error", error: "claude code exited" };
          return;
        }
        const m = next.value;
        if (m.type === "result") {
          this.pending = false;
          this.lastContext = state.contextTokens;
          this.init.log.info("claude code turn", {
            session: this.init.id,
            model: this.model,
            cache: cacheStats(m.usage),
          });
          yield* mapResult(m, state, signal.aborted);
          return;
        }
        yield* mapMessage(m, state, () => signal.aborted);
      }
    } finally {
      signal.removeEventListener("abort", interrupt);
      this.armIdle();
    }
  }
}
