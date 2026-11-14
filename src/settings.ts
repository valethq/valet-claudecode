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
        },
      },
      get: () => ({ permissionMode: permissionMode(ctx), utilityModel: utilityModel(ctx) ?? "" }),
      set: (v) => {
        const mode = v.permissionMode;
        if (mode !== undefined && (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)))
          throw new Error(`permissionMode must be one of: ${MODES.join(", ")}`);
        if (v.utilityModel !== undefined && typeof v.utilityModel !== "string")
          throw new Error("utilityModel must be a string");
        if (mode !== undefined) ctx.storage.kv.set("permissionMode", mode);
        if (typeof v.utilityModel === "string") ctx.storage.kv.set("utilityModel", v.utilityModel);
      },
    },
    { key: "valet-claudecode" },
  );
}
