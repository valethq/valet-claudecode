import type { ModelInfo } from "@valethq/sdk";
import { type ClaudeCodeConfig, DEFAULT_MODELS, EFFORTS, type Effort, type ModelConfig } from "./config";

const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);

/** For the utility model setting, which may name an effort: "claude-haiku-5-5-low" -> { model, effort: "low" }. */
export function resolveModel(id: string): { model: string; effort?: Effort } {
  const effort = EFFORT_SUFFIX.exec(id)?.[1] as Effort | undefined;
  return effort ? { model: id.replace(EFFORT_SUFFIX, ""), effort } : { model: id };
}

/** An effort Claude Code takes, or undefined for anything else. */
export const asEffort = (v: string | undefined): Effort | undefined =>
  v !== undefined && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined;

export function toModelInfo(m: ModelConfig): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 200_000,
    maxOutputTokens: m.maxOutputTokens ?? 64_000,
    input: ["text", "image"],
    reasoning: true,
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    ...(m.fast ? { fast: true } : {}),
  };
}

export function modelLister(cfg: () => ClaudeCodeConfig | undefined) {
  return async (): Promise<ModelInfo[]> => (cfg()?.models ?? DEFAULT_MODELS).map(toModelInfo);
}
