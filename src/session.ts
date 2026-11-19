import type {
  HookCallback,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentSession,
  Logger,
  McpServerEntry,
  ModelContent,
  ModelOptions,
  ToolSurface,
} from "@valethq/sdk";
import { cacheStats, claudeEnv } from "./cache";
import { InputQueue } from "./channel";
import type { ClaudeCodeConfig, Effort, PermissionMode } from "./config";
import { mapMessage, mapResult, newTurnState } from "./events";
import { asEffort } from "./models";
import type { SdkDeps } from "./sdk";
import { leakedTools } from "./tools";

/** Tool names of valet's MCP server ("valet", see provider.ts) as Claude Code reports them. */
const VALET_TOOL_PREFIX = "mcp__valet__";

export interface SessionInit {
  deps: SdkDeps;
  id: string;
  cwd: string;
  model: string;
  effort?: string;
  /** Claude Code's fast mode; unset leaves Claude Code's own setting. */
  fast?: boolean;
  mcpServers: McpServerEntry[];
  tools: ToolSurface;
  reseeded: boolean;
  /** valet's persona preamble for this session, kept so every child launch appends the same system prompt. */
  preamble: { get(): string | undefined; set(text: string): void };
  cfg(): ClaudeCodeConfig;
  /** Tool-scope flags, read at each child start so a settings change applies without a restart. */
  flags(): { hideBuiltinTools: boolean; disableClaudeAiConnectors: boolean; strictMcpConfig: boolean };
  mode(): PermissionMode;
  minRateLimitNoticePercent(): number;
  log: Logger;
  blobPath(id: string): string;
  onClose(): void;
}

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** `alwaysLoad` keeps the tools in the prompt from turn one; by default Claude Code defers MCP tools behind ToolSearch. */
export function mcpServerConfig(
  servers: McpServerEntry[],
  alwaysLoad = true,
): NonNullable<Options["mcpServers"]> {
  return Object.fromEntries(
    [...servers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => [
        s.name,
        {
          type: "http" as const,
          url: s.url,
          ...(s.headers && { headers: s.headers }),
          ...(alwaysLoad && { alwaysLoad }),
        },
      ]),
  );
}

export class ClaudeCodeSession implements AgentSession {
  readonly reseeded: boolean;
  private query?: Query;
  private input?: InputQueue;
  private pending = false;
  private model: string;
  private effort?: Effort;
  private fast?: boolean;
  private idle?: ReturnType<typeof setTimeout>;
  private lastContext?: number;
  /** The denyTools the running child was started with, checked against its `system/init` tool list. */
  private deny?: string[];

  constructor(private init: SessionInit) {
    this.reseeded = init.reseeded;
    this.model = init.model;
    this.effort = asEffort(init.effort);
    this.fast = init.fast;
  }

  get resumeId(): string {
    return this.init.id;
  }

  private async options(input: InputQueue): Promise<{ prompt: InputQueue; options: Options }> {
    const { id, cwd, deps, log } = this.init;
    const cfg = this.init.cfg();
    const flags = this.init.flags();
    const mode = this.init.mode();
    const resume = !!(await deps.getSessionInfo(id, { dir: cwd }).catch(() => undefined));
    const mcpServers = mcpServerConfig(this.init.mcpServers, !cfg.deferValetTools);
    this.deny = cfg.denyTools;
    const tools = flags.hideBuiltinTools ? [] : cfg.tools;
    const append = [cfg.appendSystemPrompt, this.init.preamble.get()].filter((t) => !!t).join("\n\n");
    const overlay = {
      ...(flags.disableClaudeAiConnectors && { disableClaudeAiConnectors: true }),
      ...(this.fast !== undefined && { fastMode: this.fast }),
    };
    const settings = Object.keys(overlay).length > 0 ? overlay : undefined;
    return {
      prompt: input,
      options: {
        cwd,
        ...(resume ? { resume: id } : { sessionId: id }),
        model: this.model,
        ...(this.effort && { effort: this.effort }),
        // newer models default to omitting thinking text; "summarized" streams the reasoning summary as thinking_delta
        thinking: { type: "adaptive", display: "summarized" },
        includePartialMessages: true,
        settingSources: cfg.settingSources ?? [],
        permissionMode: mode,
        ...(mode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
        ...(tools && { tools }),
        ...(cfg.denyTools?.length && { disallowedTools: cfg.denyTools }),
        ...(cfg.toolAliases && Object.keys(cfg.toolAliases).length && { toolAliases: cfg.toolAliases }),
        canUseTool: async (_name, toolInput) => ({ behavior: "allow", updatedInput: toolInput }),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(append && { append }),
          excludeDynamicSections: true,
          snapshot: true,
        },
        ...(Object.keys(mcpServers).length && { mcpServers }),
        strictMcpConfig: flags.strictMcpConfig,
        ...(settings && { settings }),
        // onFailure "block": a gate that throws or times out must stop the call (the default lets it run)
        hooks: { PreToolUse: [{ hooks: [this.preToolUse], onFailure: "block" }] },
        env: claudeEnv(cfg),
        ...(cfg.pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable: cfg.pathToClaudeCodeExecutable }),
        stderr: (line) => log.debug("claude stderr", { line: line.trimEnd() }),
      },
    };
  }

  /** Runs valet's `tool.call` gate before each built-in tool. Valet's own MCP tools are gated in ToolSurface.call. */
  private readonly preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name.startsWith(VALET_TOOL_PREFIX)) return {};
    const verdict = await this.init.tools.authorize(input.tool_name, input.tool_input, {
      callId: input.tool_use_id,
    });
    if ("denied" in verdict) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.denied,
        },
      };
    }
    if (JSON.stringify(verdict.input) === JSON.stringify(input.tool_input)) return {};
    if (typeof verdict.input !== "object" || verdict.input === null || Array.isArray(verdict.input)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "a policy hook rewrote the input to a non-object",
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: verdict.input as Record<string, unknown>,
      },
    };
  };

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

  /**
   * Claude Code 2.1.323 sends MCP tools inline once a child has made its first request, and a compaction drops that
   * declaration without re-sending it, so later turns in the same child reach the model with no valet tools. A fresh
   * child resumes the session and declares them again.
   */
  private restartAfterCompaction(): void {
    this.init.log.info("closing claude code child after compaction; the next prompt resumes it", {
      session: this.init.id,
    });
    this.drop();
  }

  async setModel(model: string, options: ModelOptions): Promise<void> {
    const effort = asEffort(options.effort);
    const modelChanged = model !== this.model;
    const flags = {
      ...(effort !== this.effort && { effortLevel: effort ?? null }),
      ...(options.fast !== this.fast && { fastMode: options.fast ?? null }),
    };
    this.model = model;
    this.effort = effort;
    this.fast = options.fast;
    if (!this.query) return;
    if (modelChanged) await this.query.setModel(model);
    if (Object.keys(flags).length > 0) await this.query.applyFlagSettings(flags);
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

  private async blocks(content: ModelContent[]): Promise<Block[]> {
    const blocks = await Promise.all(content.map((c) => this.contentBlock(c)));
    return blocks.filter((b): b is Block => b !== undefined);
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
    // The preamble arrives with a session's first prompt, before its child starts, so it lands in the system prompt.
    if (input.preamble) this.init.preamble.set(input.preamble);
    let content: Block[];
    try {
      content = await this.blocks(input.content);
    } catch (e) {
      this.drop();
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    yield* this.turn(content, signal);
  }

  /** `/compact` runs as a turn; Claude Code reports the compaction in that turn's stream. */
  compact(instructions: string | undefined, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const text = instructions ? `/compact ${instructions}` : "/compact";
    return this.turn([{ type: "text", text }], signal);
  }

  private async *turn(content: Block[], signal: AbortSignal): AsyncIterable<AgentEvent> {
    clearTimeout(this.idle);
    let q: Query;
    try {
      q = await this.ensure();
      await this.settle(q);
      q = await this.ensure();
    } catch (e) {
      this.drop();
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    const state = newTurnState(this.init.log, this.lastContext, this.init.minRateLimitNoticePercent());
    let compacted = false;
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
        if (m.type === "system" && m.subtype === "init") {
          const leaked = leakedTools(m.tools, this.deny);
          if (leaked.length) {
            const error = `denied tools are still available: ${leaked.join(", ")}`;
            this.init.log.error("claude code ignored denyTools, closing the child", {
              session: this.init.id,
              leaked,
            });
            this.drop();
            yield { type: "finish", reason: "error", error };
            return;
          }
        }
        if (m.type === "result") {
          this.pending = false;
          this.lastContext = state.contextTokens;
          this.init.log.info("claude code turn", {
            session: this.init.id,
            model: this.model,
            cache: cacheStats(m.usage),
          });
          yield* mapResult(m, state, signal.aborted);
          if (compacted) this.restartAfterCompaction();
          return;
        }
        if (m.type === "system" && m.subtype === "compact_boundary") compacted = true;
        yield* mapMessage(m, state, () => signal.aborted);
      }
    } finally {
      signal.removeEventListener("abort", interrupt);
      this.armIdle();
    }
  }
}
