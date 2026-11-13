import type { ModelInfo } from "@valethq/sdk";
import { type ClaudeCodeConfig, DEFAULT_MODELS, EFFORTS, type Effort, type ModelConfig } from "./config";

const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);

/** "claude-opus-5-5-high" -> { model: "claude-opus-5-5", effort: "high" }. Ids without a suffix pass through. */
export function resolveModel(id: string): { model: string; effort?: Effort } {
  const effort = EFFORT_SUFFIX.exec(id)?.[1] as Effort | undefined;
  return effort ? { model: id.replace(EFFORT_SUFFIX, ""), effort } : { model: id };
}

/** One picker entry per declared effort: "<id>-<effort>". Without declared efforts, just the bare model. */
export function toModelInfos(m: ModelConfig): ModelInfo[] {
  const base: ModelInfo = {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? 200_000,
    maxOutputTokens: m.maxOutputTokens ?? 64_000,
    input: ["text", "image"],
    reasoning: true,
  };
  if (!m.efforts?.length) return [base];
  return m.efforts.map((e) => ({ ...base, id: `${m.id}-${e}`, name: `${base.name} (${e})` }));
}

export function modelLister(cfg: () => ClaudeCodeConfig | undefined) {
  return async (): Promise<ModelInfo[]> => (cfg()?.models ?? DEFAULT_MODELS).flatMap(toModelInfos);
}
