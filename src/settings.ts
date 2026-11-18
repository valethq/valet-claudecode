import type { PluginContext } from "@valethq/sdk";
import { type ClaudeCodeConfig, DEFAULT_UTILITY_MODEL, MODES, type PermissionMode } from "./config";
import type { SdkDeps } from "./sdk";
import { createUsage } from "./usage";

type Ctx = PluginContext<ClaudeCodeConfig>;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

export function permissionMode(ctx: Ctx): PermissionMode {
  const v = ctx.config?.permissionMode;
  return v !== undefined && MODES.includes(v) ? v : "acceptEdits";
}

/** The Utility model; an empty string turns it off. */
export function utilityModel(ctx: Ctx): string | undefined {
  const v = (ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL).trim();
  return v === "" ? undefined : v;
}

export const hideBuiltinTools = (ctx: Ctx): boolean => ctx.config?.hideBuiltinTools ?? false;

export const disableClaudeAiConnectors = (ctx: Ctx): boolean => ctx.config?.disableClaudeAiConnectors ?? true;

export const strictMcpConfig = (ctx: Ctx): boolean => ctx.config?.strictMcpConfig ?? true;

export const minRateLimitNoticePercent = (ctx: Ctx): number => ctx.config?.minRateLimitNoticePercent ?? 80;

/** The plugin's settings page carries live plan usage above the config form. */
export function registerSettings(ctx: Ctx, deps: SdkDeps): void {
  const usage = createUsage(ctx, deps);
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.onConfigChange(() => {}); // every value is read from ctx.config when it is used
  ctx.scopes.provide(
    "settings",
    {
      title: "Plan usage",
      view: () => usage.view(),
      refreshMs: 15_000,
      actions: { refresh: () => usage.refresh(true) },
    },
    { key: "valet-claudecode" },
  );
}
