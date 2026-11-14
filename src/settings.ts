import type { PluginContext } from "@valethq/sdk";
import { type ClaudeCodeConfig, DEFAULT_UTILITY_MODEL, MODES, type PermissionMode } from "./config";

export interface SettingsPanel {
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  get(): Record<string, unknown> | Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): void | Promise<void>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    settings: SettingsPanel;
  }
}

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

export function registerSettings(ctx: PluginContext<ClaudeCodeConfig>): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Claude Code",
      description:
        "Overrides plugins.valet-claudecode.config; applies when a session's Claude Code child (re)starts.",
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
