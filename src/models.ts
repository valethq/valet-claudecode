import type { ModelInfo } from "@valethq/sdk";
import {
  type ClaudeCodeConfig,
  type CustomModel,
  DEFAULT_MODELS,
  EFFORTS,
  type Effort,
  type ModelConfig,
} from "./config";

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

/** Custom models are appended; one that shares an id with a listed model is skipped. */
export function modelLister(cfg: () => ClaudeCodeConfig | undefined, custom: () => CustomModel[] = () => []) {
  return async (): Promise<ModelInfo[]> => {
    const listed = (cfg()?.models ?? DEFAULT_MODELS).flatMap(toModelInfos);
    const seen = new Set(listed.map((m) => m.id));
    return [
      ...listed,
      ...custom()
        .filter((m) => !seen.has(m.id))
        .flatMap(toModelInfos),
    ];
  };
}
