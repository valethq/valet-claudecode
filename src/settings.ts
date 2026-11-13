import type { PluginContext } from "@valethq/sdk";
import { type ClaudeCodeConfig, MODES, type PermissionMode } from "./config";

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
          },
        },
      },
      get: () => ({ permissionMode: permissionMode(ctx) }),
      set: (v) => {
        const mode = v.permissionMode;
        if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode))
          throw new Error(`permissionMode must be one of: ${MODES.join(", ")}`);
        ctx.storage.kv.set("permissionMode", mode);
      },
    },
    { key: "valet-claudecode" },
  );
}
