import type { ModelInfo } from "@valethq/sdk";
import { type ClaudeCodeConfig, DEFAULT_MODELS } from "./config";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);

/** "claude-opus-5-5-high" -> { model: "claude-opus-5-5", effort: "high" }. Ids without a suffix pass through. */
export function resolveModel(id: string): { model: string; effort?: Effort } {
  const effort = EFFORT_SUFFIX.exec(id)?.[1] as Effort | undefined;
  return effort ? { model: id.replace(EFFORT_SUFFIX, ""), effort } : { model: id };
}

export function toModelInfo(m: NonNullable<ClaudeCodeConfig["models"]>[number]): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 200_000,
    maxOutputTokens: m.maxOutputTokens ?? 64_000,
    input: ["text", "image"],
    reasoning: true,
  };
}

export function modelLister(cfg: () => ClaudeCodeConfig | undefined) {
  return async (): Promise<ModelInfo[]> => (cfg()?.models ?? DEFAULT_MODELS).map(toModelInfo);
}
