import type { PluginContext } from "@valethq/sdk";
import {
  type ClaudeCodeConfig,
  type CustomModel,
  DEFAULT_UTILITY_MODEL,
  MODES,
  type PermissionMode,
} from "./config";
import type { SdkDeps } from "./sdk";
import { createUsage } from "./usage";

/** Panel value wins over config.json so the UI can flip it without a restart. */
export function permissionMode(ctx: PluginContext<ClaudeCodeConfig>): PermissionMode {
  const v = ctx.storage.kv.get<string>("permissionMode") ?? ctx.config?.permissionMode;
  return (MODES as readonly string[]).includes(v ?? "") ? (v as PermissionMode) : "acceptEdits";
}

/** The Utility model. Panel value wins over config.json; an empty string turns it off. */
export function utilityModel(ctx: PluginContext<ClaudeCodeConfig>): string | undefined {
  const v = ctx.storage.kv.get<string>("utilityModel") ?? ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL;
  return v.trim() === "" ? undefined : v.trim();
}

/** Panel value wins over config.json. Default false: Claude Code's built-in tools stay available. */
export function hideBuiltinTools(ctx: PluginContext<ClaudeCodeConfig>): boolean {
  return ctx.storage.kv.get<boolean>("hideBuiltinTools") ?? ctx.config?.hideBuiltinTools ?? false;
}

/** Panel value wins over config.json. Default true: no claude.ai account connectors. */
export function disableClaudeAiConnectors(ctx: PluginContext<ClaudeCodeConfig>): boolean {
  return (
    ctx.storage.kv.get<boolean>("disableClaudeAiConnectors") ?? ctx.config?.disableClaudeAiConnectors ?? true
  );
}

/** Panel value wins over config.json. Default true: only the MCP servers valet passes. */
export function strictMcpConfig(ctx: PluginContext<ClaudeCodeConfig>): boolean {
  return ctx.storage.kv.get<boolean>("strictMcpConfig") ?? ctx.config?.strictMcpConfig ?? true;
}

/** Panel value wins over config.json. Default 80: "approaching limit" warnings stay quiet until then. */
export function minRateLimitNoticePercent(ctx: PluginContext<ClaudeCodeConfig>): number {
  const v = ctx.storage.kv.get<number>("minRateLimitNoticePercent") ?? ctx.config?.minRateLimitNoticePercent;
  return typeof v === "number" && v >= 0 && v <= 100 ? v : 80;
}

/** Panel value wins over config.json. Entries without an id are dropped. */
export function customModels(ctx: PluginContext<ClaudeCodeConfig>): CustomModel[] {
  const v = ctx.storage.kv.get<unknown>("customModels") ?? ctx.config?.customModels;
  return Array.isArray(v)
    ? v
        .filter(isCustomModel)
        .map(({ id, name }) => ({ id: id.trim(), ...(name?.trim() && { name: name.trim() }) }))
    : [];
}

const isCustomModel = (m: unknown): m is CustomModel =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as CustomModel).id === "string" &&
  (m as CustomModel).id.trim() !== "";

export function registerSettings(ctx: PluginContext<ClaudeCodeConfig>, deps: SdkDeps): void {
  const usage = createUsage(ctx, deps);
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Claude Code",
      description:
        "Overrides plugins.valet-claudecode.config; applies when a session's Claude Code child (re)starts.",
      view: () => usage.view(),
      refreshMs: 15_000,
      actions: { refresh: () => usage.refresh(true) },
      schema: {
        type: "object",
        properties: {
          permissionMode: {
            type: "string",
            title: "Permission mode",
            description: "Claude Code permission mode for new and resumed sessions.",
            enum: MODES,
            enumNames: ["Default (ask)", "Accept edits", "Plan", "Bypass permissions"],
          },
          utilityModel: {
            type: "string",
            title: "Utility model",
            description: "Model for small side jobs such as naming sessions. Empty turns them off.",
          },
          customModels: {
            type: "array",
            title: "Custom models",
            description: "Extra models for the picker. The model name is sent to Claude Code as is.",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", title: "Model name" },
                name: { type: "string", title: "Friendly name" },
              },
            },
          },
          minRateLimitNoticePercent: {
            type: "number",
            title: "Usage warning threshold (%)",
            description:
              'Only show "approaching limit" warnings once usage is at or above this percent. Hitting a limit is always shown.',
            minimum: 0,
            maximum: 100,
          },
          hideBuiltinTools: {
            type: "boolean",
            title: "Hide built-in tools",
            description:
              "Remove Claude Code's own tools (Bash, Read, Write, Edit, Agent, Skill, ToolSearch, ...) so only valet's MCP tools are offered.",
          },
          disableClaudeAiConnectors: {
            type: "boolean",
            title: "Hide claude.ai connectors",
            description:
              "Hide your claude.ai account connectors (Gmail, GitHub, ...). Does not affect built-in tools.",
          },
          strictMcpConfig: {
            type: "boolean",
            title: "Only valet's MCP servers",
            description:
              "Ignore project .mcp.json, user settings and plugins, so valet's is the only MCP server. Does not affect built-in tools.",
          },
        },
      },
      get: () => ({
        permissionMode: permissionMode(ctx),
        utilityModel: utilityModel(ctx) ?? "",
        customModels: customModels(ctx),
        minRateLimitNoticePercent: minRateLimitNoticePercent(ctx),
        hideBuiltinTools: hideBuiltinTools(ctx),
        disableClaudeAiConnectors: disableClaudeAiConnectors(ctx),
        strictMcpConfig: strictMcpConfig(ctx),
      }),
      set: (v) => {
        const mode = v.permissionMode;
        if (mode !== undefined && (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)))
          throw new Error(`permissionMode must be one of: ${MODES.join(", ")}`);
        if (v.utilityModel !== undefined && typeof v.utilityModel !== "string")
          throw new Error("utilityModel must be a string");
        const min = v.minRateLimitNoticePercent;
        if (min !== undefined && (typeof min !== "number" || !(min >= 0 && min <= 100)))
          throw new Error("minRateLimitNoticePercent must be a number from 0 to 100");
        if (
          v.customModels !== undefined &&
          !(Array.isArray(v.customModels) && v.customModels.every(isCustomModel))
        )
          throw new Error("customModels entries need a model name");
        if (v.customModels !== undefined) ctx.storage.kv.set("customModels", v.customModels);
        if (min !== undefined) ctx.storage.kv.set("minRateLimitNoticePercent", min);
        if (mode !== undefined) ctx.storage.kv.set("permissionMode", mode);
        if (typeof v.utilityModel === "string") ctx.storage.kv.set("utilityModel", v.utilityModel);
        for (const key of ["hideBuiltinTools", "disableClaudeAiConnectors", "strictMcpConfig"] as const) {
          const flag = v[key];
          if (flag === undefined) continue;
          if (typeof flag !== "boolean") throw new Error(`${key} must be true or false`);
          ctx.storage.kv.set(key, flag);
        }
      },
    },
    { key: "valet-claudecode" },
  );
}
