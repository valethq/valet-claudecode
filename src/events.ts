import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Logger } from "@valethq/sdk";
import { contextTokens } from "./cache";

type Obj = Record<string, unknown>;

export interface TurnState {
  /** Message ids whose text/thinking already went out as stream deltas. */
  streamedText: Set<string>;
  streamedThinking: Set<string>;
  currentMessage?: string;
  contextTokens?: number;
  log?: Logger;
}

export function newTurnState(log?: Logger, contextTokens?: number): TurnState {
  return { streamedText: new Set(), streamedThinking: new Set(), contextTokens, log };
}

function titleOf(input: Obj): string | undefined {
  for (const k of ["description", "command", "file_path", "pattern", "url", "query"]) {
    const v = input[k];
    if (typeof v === "string" && v) return v.length > 120 ? `${v.slice(0, 117)}...` : v;
  }
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Obj[])
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("");
}

/** Time left until a rate-limit window resets; `resetsAt` is unix epoch seconds. */
export function untilReset(resetsAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000));
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const rh = h % 24;
  return rh ? `${Math.floor(h / 24)}d ${rh}h` : `${Math.floor(h / 24)}d`;
}

export function mapMessage(m: SDKMessage, st: TurnState, aborted: () => boolean): AgentEvent[] {
  switch (m.type) {
    case "stream_event": {
      if (m.parent_tool_use_id) return [];
      const e = m.event as unknown as Obj;
      if (e.type === "message_start") {
        st.currentMessage = String(((e.message ?? {}) as Obj).id ?? "");
        return [];
      }
      if (e.type !== "content_block_delta") return [];
      const d = (e.delta ?? {}) as Obj;
      const id = st.currentMessage ?? "";
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        st.streamedText.add(id);
        return [{ type: "text-delta", text: d.text }];
      }
      if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
        st.streamedThinking.add(id);
        return [{ type: "reasoning-delta", text: d.thinking }];
      }
      return [];
    }
    case "assistant": {
      if (m.parent_tool_use_id) return [];
      const events: AgentEvent[] = [];
      const id = m.message.id;
      for (const b of m.message.content as unknown as Obj[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text && !st.streamedText.has(id))
          events.push({ type: "text-delta", text: b.text });
        else if (
          b.type === "thinking" &&
          typeof b.thinking === "string" &&
          b.thinking &&
          !st.streamedThinking.has(id)
        )
          events.push({ type: "reasoning-delta", text: b.thinking });
        else if (b.type === "tool_use") {
          const input = (b.input ?? {}) as Obj;
          events.push({
            type: "tool-start",
            callId: String(b.id),
            name: String(b.name),
            title: titleOf(input),
            input,
          });
        }
      }
      st.contextTokens = contextTokens(m.message.usage);
      events.push({ type: "usage", contextTokens: st.contextTokens });
      return events;
    }
    case "user": {
      if (m.parent_tool_use_id) return [];
      const content = m.message.content;
      if (!Array.isArray(content)) return [];
      return (content as unknown as Obj[])
        .filter((b) => b.type === "tool_result")
        .map((b): AgentEvent => {
          const failed = b.is_error === true;
          return {
            type: "tool-end",
            callId: String(b.tool_use_id),
            status: failed ? (aborted() ? "cancelled" : "error") : "done",
            output: resultText(b.content),
          };
        });
    }
    case "system": {
      if (m.subtype === "status") {
        if (m.status === "compacting") return [{ type: "compaction-start" }];
        if (m.compact_result !== undefined)
          return [
            {
              type: "compaction-end",
              status: m.compact_result === "success" ? "completed" : "failed",
              ...(m.compact_error ? { error: m.compact_error } : {}),
            },
          ];
        return [];
      }
      if (m.subtype === "compact_boundary") {
        const { pre_tokens: from, post_tokens: to } = m.compact_metadata;
        if (to !== undefined) st.contextTokens = to;
        st.log?.info("claude code compacted the context", { from, to, trigger: m.compact_metadata.trigger });
        // start is idempotent, so this also opens the marker when no "compacting" status came first
        return [
          { type: "compaction-start" },
          { type: "compaction-end", status: "completed" },
          ...(to === undefined ? [] : [{ type: "usage" as const, contextTokens: to }]),
        ];
      }
      if (m.subtype === "api_retry")
        return [
          {
            type: "notice",
            level: "warning",
            text: `Anthropic API retry ${m.attempt}/${m.max_retries}${m.error_status ? ` (HTTP ${m.error_status})` : ""}`,
          },
        ];
      return [];
    }
    case "rate_limit_event": {
      const { status, rateLimitType, utilization, resetsAt } = m.rate_limit_info;
      if (status === "allowed") return [];
      const scope =
        rateLimitType === "five_hour"
          ? "session"
          : rateLimitType?.startsWith("seven_day")
            ? "weekly"
            : "usage";
      if (status === "rejected") {
        const reset = resetsAt === undefined ? "" : ` It resets in ${untilReset(resetsAt)}.`;
        return [{ type: "notice", level: "error", text: `Claude hit its ${scope} limit.${reset}` }];
      }
      const pct = utilization === undefined ? "" : ` (${Math.round(utilization * 100)}% used)`;
      return [{ type: "notice", level: "warning", text: `Approaching Claude's ${scope} limit${pct}` }];
    }
    default:
      return [];
  }
}

export function mapResult(m: SDKResultMessage, st: TurnState, aborted: boolean): AgentEvent[] {
  const u = m.usage;
  const events: AgentEvent[] = [
    {
      type: "usage",
      contextTokens: st.contextTokens,
      inputTokens: contextTokens(u),
      outputTokens: u.output_tokens,
    },
  ];
  if (aborted) return [...events, { type: "finish", reason: "cancelled" }];
  if (m.subtype === "success" && !m.is_error) return [...events, { type: "finish", reason: "stop" }];
  if (m.subtype === "error_max_turns" || m.terminal_reason === "max_turns")
    return [...events, { type: "finish", reason: "length" }];
  const detail = "errors" in m && m.errors.length ? m.errors.join("; ") : "result" in m ? m.result : "";
  return [
    ...events,
    {
      type: "finish",
      reason: "error",
      error: detail || `claude code stopped: ${m.terminal_reason ?? m.subtype}`,
    },
  ];
}
