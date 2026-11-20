import type { Option, PluginContext } from "@valethq/sdk";
import {
  BUILTIN_TOOLS,
  type ClaudeCodeConfig,
  DEFAULT_UTILITY_MODEL,
  type Effort,
  MODES,
  type PermissionMode,
} from "./config";
import { asEffort, modelLister } from "./models";
import type { SdkDeps } from "./sdk";
import { createUsage } from "./usage";

type Ctx = PluginContext<ClaudeCodeConfig>;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

export function permissionMode(ctx: Ctx): PermissionMode {
  const v = ctx.config?.permissionMode;
  return v !== undefined && MODES.includes(v) ? v : "acceptEdits";
}

/** The Utility model and its effort; no model (or an empty one) turns it off. */
export function utilityModel(ctx: Ctx): { model: string; effort?: Effort } | undefined {
  const v = ctx.config?.utilityModel ?? { model: DEFAULT_UTILITY_MODEL };
  const model = v.model?.trim() ?? "";
  if (model === "") return undefined;
  const effort = asEffort(v.effort);
  return effort ? { model, effort } : { model };
}

export const hideBuiltinTools = (ctx: Ctx): boolean => ctx.config?.hideBuiltinTools ?? false;

export const disableClaudeAiConnectors = (ctx: Ctx): boolean => ctx.config?.disableClaudeAiConnectors ?? true;

export const strictMcpConfig = (ctx: Ctx): boolean => ctx.config?.strictMcpConfig ?? true;

/** The usage-warning threshold as a percent (0-100). */
export const minRateLimitNoticePercent = (ctx: Ctx): number =>
  Math.round((ctx.config?.rateLimitNoticeAt ?? 0.8) * 100);

/** settings@2: option sources for the doc's inputs, and live plan usage as a runtime subsection. */
export function registerSettings(ctx: Ctx, deps: SdkDeps): void {
  const usage = createUsage(ctx, deps);
  const models = modelLister(() => ctx.config);
  ctx.scopes.define({ name: "settings", version: 2, cardinality: "many" });
  ctx.onConfigChange(() => {}); // every value is read from ctx.config when it is used
  ctx.scopes.provide("settings", {
    options: {
      models: async (): Promise<Option[]> => (await models()).map((m) => ({ value: m.id, label: m.name })),
      efforts: async ({ model }): Promise<Option[]> =>
        ((await models()).find((m) => m.id === model)?.efforts ?? []).map((e) => ({ value: e })),
      builtinTools: (): Option[] => BUILTIN_TOOLS.map((t) => ({ value: t })),
    },
    actions: { refresh: () => usage.refresh(true) },
    subsections: async () => [
      { id: "usage", label: "Plan usage", order: -1, refreshMs: 15_000, items: await usage.view() },
    ],
  });
}
