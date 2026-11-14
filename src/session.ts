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
  ToolSurface,
} from "@valethq/sdk";
import { cacheStats, claudeEnv } from "./cache";
import { InputQueue } from "./channel";
import type { ClaudeCodeConfig, Effort, PermissionMode } from "./config";
import { mapMessage, mapResult, newTurnState } from "./events";
import { resolveModel } from "./models";
import type { SdkDeps } from "./sdk";

/** Tool names of valet's MCP server ("valet", see provider.ts) as Claude Code reports them. */
const VALET_TOOL_PREFIX = "mcp__valet__";

export interface SessionInit {
  deps: SdkDeps;
  id: string;
  cwd: string;
  model: string;
  mcpServers: McpServerEntry[];
  tools: ToolSurface;
  reseeded: boolean;
  cfg(): ClaudeCodeConfig;
  /** Connector and MCP-scope flags, read at each child start so the settings panel applies without a restart. */
  flags(): { disableClaudeAiConnectors: boolean; strictMcpConfig: boolean };
  mode(): PermissionMode;
  log: Logger;
  blobPath(id: string): string;
  onClose(): void;
}

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export function mcpServerConfig(servers: McpServerEntry[]): NonNullable<Options["mcpServers"]> {
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
    const flags = this.init.flags();
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
        // newer models default to omitting thinking text; "summarized" streams the reasoning summary as thinking_delta
        thinking: { type: "adaptive", display: "summarized" },
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
        strictMcpConfig: flags.strictMcpConfig,
        ...(flags.disableClaudeAiConnectors && { settings: { disableClaudeAiConnectors: true } }),
        hooks: { PreToolUse: [{ hooks: [this.preToolUse] }] },
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
    let content: Block[];
    try {
      content = await this.blocks(input);
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
